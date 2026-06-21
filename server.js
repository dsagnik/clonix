/**
 * server.js
 * ----------
 * Express server that exposes the Clonix REST API and serves the
 * static frontend.  Endpoints:
 *
 *   POST /api/clone         – Start a new cloning job
 *   GET  /api/progress/:id  – Poll job progress
 *   GET  /api/download/:id  – Download the finished ZIP
 */

const express = require('express');
const path = require('path');
const fse = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { crawl } = require('./crawler');
const { downloadAssets, savePages } = require('./downloader');
const { createZip, formatBytes } = require('./zipper');

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ */
/*  Middleware                                                         */
/* ------------------------------------------------------------------ */

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*  In-memory job store                                                */
/* ------------------------------------------------------------------ */

const jobs = new Map();

/**
 * Job object shape:
 * {
 *   id: string,
 *   url: string,
 *   status: 'crawling' | 'downloading' | 'zipping' | 'done' | 'error',
 *   progress: 0-100,
 *   currentAction: string,
 *   pagesFound: number,
 *   assetsDownloaded: number,
 *   filesProcessed: number,
 *   zipSize: string,
 *   elapsedTime: string,
 *   startTime: number,
 *   error: string | null,
 *   zipPath: string | null,
 *   tempDir: string | null,
 * }
 */

function createJob(url) {
  const id = uuidv4().split('-')[0]; // short ID
  const job = {
    id,
    url,
    status: 'crawling',
    progress: 0,
    currentAction: 'Initializing...',
    pagesFound: 0,
    assetsDownloaded: 0,
    filesProcessed: 0,
    zipSize: '0 B',
    elapsedTime: '00:00:00',
    startTime: Date.now(),
    error: null,
    zipPath: null,
    tempDir: null,
  };
  jobs.set(id, job);
  return job;
}

function updateElapsed(job) {
  const elapsed = Date.now() - job.startTime;
  const s = Math.floor(elapsed / 1000) % 60;
  const m = Math.floor(elapsed / 60000) % 60;
  const h = Math.floor(elapsed / 3600000);
  job.elapsedTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/*  API Routes                                                         */
/* ------------------------------------------------------------------ */

/**
 * POST /api/clone
 * Body: { "url": "https://example.com" }
 */
app.post('/api/clone', (req, res) => {
  let { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A valid URL is required.' });
  }

  url = url.trim();

  // Auto-prepend https:// for bare domains (e.g. example.com, www.example.com)
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  // Basic URL validation
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'URL must start with http:// or https://' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  const job = createJob(url);
  res.json({ jobId: job.id });

  // Run the pipeline asynchronously (fire-and-forget)
  runPipeline(job).catch((err) => {
    job.status = 'error';
    job.error = err.message || 'An unexpected error occurred.';
    job.progress = 0;
    console.error(`[server] Job ${job.id} failed:`, err);
  });
});

/**
 * GET /api/progress/:id
 */
app.get('/api/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  updateElapsed(job);

  res.json({
    status: job.status,
    progress: job.progress,
    currentAction: job.currentAction,
    pagesFound: job.pagesFound,
    assetsDownloaded: job.assetsDownloaded,
    filesProcessed: job.filesProcessed,
    zipSize: job.zipSize,
    elapsedTime: job.elapsedTime,
    error: job.error,
    url: job.url,
  });
});

/**
 * GET /api/download/:id
 */
app.get('/api/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'done' || !job.zipPath) {
    return res.status(400).json({ error: 'ZIP not ready yet.' });
  }

  // Extract domain for filename
  let filename = 'website.zip';
  try {
    const u = new URL(job.url);
    filename = `${u.hostname.replace(/\./g, '_')}.zip`;
  } catch { /* use default */ }

  res.download(job.zipPath, filename, (err) => {
    if (err) console.error('[server] Download error:', err);
  });
});

/* ------------------------------------------------------------------ */
/*  Cloning Pipeline                                                   */
/* ------------------------------------------------------------------ */

async function runPipeline(job) {
  const TEMP_ROOT = path.join(__dirname, '.tmp');
  const tempDir = path.join(TEMP_ROOT, job.id);
  const siteDir = path.join(tempDir, 'site');
  const zipPath = path.join(tempDir, 'site.zip');

  job.tempDir = tempDir;

  await fse.ensureDir(siteDir);

  /* ---- Phase 1: Crawl ---- */
  job.status = 'crawling';
  job.currentAction = 'Scanning Pages...';
  job.progress = 5;

  const { pages, assets } = await crawl(job.url, (info) => {
    job.pagesFound = info.pagesFound;
    job.currentAction = info.currentAction;
    // Crawling is 0-40%
    job.progress = Math.min(40, 5 + Math.floor((info.pagesFound / 20) * 35));
  });

  job.pagesFound = pages.size;
  job.progress = 40;

  if (pages.size === 0) {
    throw new Error('No pages could be crawled from this URL. The site may be dynamic or blocked.');
  }

  /* ---- Phase 2: Download assets ---- */
  job.status = 'downloading';
  job.currentAction = 'Downloading Assets...';

  const assetMap = await downloadAssets(assets, siteDir, (info) => {
    job.currentAction = info.currentAction;
    job.assetsDownloaded = info.assetsDownloaded;
    // Downloading is 40-75%
    const pct = info.totalAssets > 0
      ? Math.floor((info.assetsDownloaded / info.totalAssets) * 35)
      : 35;
    job.progress = 40 + pct;
  }, [...pages.keys()]);

  job.assetsDownloaded = assetMap.size;
  job.progress = 75;

  /* ---- Phase 3: Save pages & rewrite URLs ---- */
  job.currentAction = 'Processing Pages...';

  await savePages(pages, assetMap, siteDir, job.url, (info) => {
    job.currentAction = info.currentAction;
    job.filesProcessed = info.filesProcessed;
    // Rewriting is 75-90%
    const pct = info.totalFiles > 0
      ? Math.floor((info.filesProcessed / info.totalFiles) * 15)
      : 15;
    job.progress = 75 + pct;
  });

  job.filesProcessed = pages.size;
  job.progress = 90;

  /* ---- Phase 4: Create ZIP ---- */
  job.status = 'zipping';
  job.currentAction = 'Creating ZIP Archive...';

  const { zipSize } = await createZip(siteDir, zipPath, (info) => {
    job.currentAction = info.currentAction;
  });

  job.zipPath = zipPath;
  job.zipSize = formatBytes(zipSize);
  job.progress = 100;
  job.status = 'done';
  job.currentAction = 'Complete';
  updateElapsed(job);

  // Clean up the site directory (keep the ZIP)
  await fse.remove(siteDir);

  // Schedule ZIP cleanup after 30 minutes
  setTimeout(async () => {
    try {
      await fse.remove(tempDir);
      jobs.delete(job.id);
    } catch { /* ignore */ }
  }, 30 * 60 * 1000);
}

/* ------------------------------------------------------------------ */
/*  SPA fallback – serve index.html for any unmatched route            */
/* ------------------------------------------------------------------ */

app.get('*', (req, res) => {
  // Only serve HTML pages for navigation, not API or asset requests
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const file = path.join(__dirname, 'public', req.path);
  if (fse.existsSync(file) && fse.statSync(file).isFile()) {
    return res.sendFile(file);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

app.listen(PORT, () => {
  console.log(`\n  🚀 Clonix server running at http://localhost:${PORT}\n`);
});
