/**
 * downloader.js
 * --------------
 * Downloads discovered pages and assets to a temporary directory on disk,
 * preserving the original folder structure of the remote site.
 *
 * Rewrites all URLs inside downloaded HTML pages so they point to the
 * corresponding local files.
 */

const axios = require('axios');
const fse = require('fs-extra');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const cheerio = require('cheerio');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert a full URL into a local file-system path relative to the
 * download root.  e.g.
 *   https://example.com/about        → about/index.html
 *   https://example.com/css/main.css → css/main.css
 *   https://example.com/             → index.html
 */
function urlToLocalPath(urlStr, isPage = false) {
  try {
    const u = new URL(urlStr);
    let p = decodeURIComponent(u.pathname);

    // Remove leading slash
    p = p.replace(/^\/+/, '');

    if (isPage) {
      // If it already ends with .html/.htm keep it, otherwise treat as directory
      if (/\.html?$/i.test(p)) {
        return p || 'index.html';
      }
      // Treat as directory → append index.html
      p = p.replace(/\/+$/, '');
      return p ? `${p}/index.html` : 'index.html';
    }

    // Asset – keep the path as-is
    return p || 'index.html';
  } catch {
    return 'unknown_asset';
  }
}

/**
 * Calculate a relative path from one file to another inside the download
 * directory, for URL rewriting.
 */
function relativeBetween(fromFile, toFile) {
  const fromDir = path.posix.dirname(fromFile);
  let rel = path.posix.relative(fromDir, toFile);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

/* ------------------------------------------------------------------ */
/*  Download assets                                                    */
/* ------------------------------------------------------------------ */

/**
 * Download all assets (CSS, JS, images, fonts, etc.) into `destDir`.
 *
 * @param {Set<string>} assetUrls
 * @param {string}      destDir   – Absolute path to temp directory
 * @param {Function}    onProgress
 * @returns {Promise<Map<string, string>>}  Map<absolute-url, local-relative-path>
 */
async function downloadAssets(assetUrls, destDir, onProgress, pageUrls = []) {
  const urlToLocal = new Map();
  let downloaded = 0;

  const axiosInstance = axios.create({
    timeout: 30000,
    responseType: 'arraybuffer',
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Clonix/1.0 (Website Archiver)',
    },
    validateStatus: () => true,
  });

  const urls = [...assetUrls];

  // Compute all directories required by pages (so we can detect conflicts)
  const pageDirPaths = new Set();
  for (const pageUrl of pageUrls) {
    const pagePath = urlToLocalPath(pageUrl, true); // e.g. "projects/index.html"
    // Collect every ancestor dir: "projects", "projects/sub", etc.
    let dir = path.dirname(path.join(destDir, pagePath));
    while (dir.length > destDir.length) {
      pageDirPaths.add(dir);
      dir = path.dirname(dir);
    }
  }

  // Pre-compute asset paths, skipping any that conflict with page directories
  const urlPathPairs = [];
  for (const url of urls) {
    const localPath = urlToLocalPath(url, false);
    const fullPath = path.join(destDir, localPath);

    // Skip if this asset's file path clashes with a needed directory
    if (pageDirPaths.has(fullPath)) {
      console.warn(`[downloader] Skipping asset (conflicts with page dir): ${url}`);
      continue;
    }

    urlPathPairs.push({ url, localPath, fullPath });
  }

  // Also detect conflicts among assets themselves:
  // collect all dirs needed by assets, skip any asset that IS a needed dir
  const assetDirPaths = new Set(urlPathPairs.map((p) => path.dirname(p.fullPath)));
  const filteredPairs = urlPathPairs.filter((p) => {
    if (assetDirPaths.has(p.fullPath)) {
      console.warn(`[downloader] Skipping asset (conflicts with asset dir): ${p.url}`);
      return false;
    }
    return true;
  });

  const total = filteredPairs.length;

  // Collect all unique directories and create them before downloading
  const uniqueDirs = new Set(filteredPairs.map((p) => path.dirname(p.fullPath)));
  for (const dir of uniqueDirs) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  // Now download in parallel batches - directories already exist
  const batchSize = 10;

  for (let i = 0; i < filteredPairs.length; i += batchSize) {
    const batch = filteredPairs.slice(i, i + batchSize);

    await Promise.all(batch.map(async ({ url, localPath, fullPath }) => {
      try {
        // Determine current action label
        const ext = path.extname(localPath).toLowerCase();
        let actionLabel = 'Downloading Assets';
        if (['.css'].includes(ext)) actionLabel = 'Downloading CSS';
        else if (['.js'].includes(ext)) actionLabel = 'Downloading JavaScript';
        else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) actionLabel = 'Downloading Images';
        else if (['.woff', '.woff2', '.ttf', '.eot', '.otf'].includes(ext)) actionLabel = 'Downloading Fonts';
        else if (['.pdf'].includes(ext)) actionLabel = 'Downloading PDFs';

        onProgress({
          currentAction: actionLabel,
          assetsDownloaded: downloaded,
          totalAssets: total,
        });

        const res = await axiosInstance.get(url);
        if (res.status >= 400) return;

        await fse.writeFile(fullPath, Buffer.from(res.data));

        urlToLocal.set(url, localPath);
        downloaded++;
      } catch (err) {
        console.warn(`[downloader] Failed to download asset: ${url} – ${err.message}`);
      }
    }));
  }

  return urlToLocal;
}

/* ------------------------------------------------------------------ */
/*  Save pages & rewrite URLs                                          */
/* ------------------------------------------------------------------ */

/**
 * Save all crawled HTML pages to `destDir` and rewrite internal URLs
 * so they point to local files.
 *
 * @param {Map<string, string>}  pages       – Map<url, html>
 * @param {Map<string, string>}  assetMap    – Map<absolute-url, local-path>
 * @param {string}               destDir
 * @param {string}               rootUrl
 * @param {Function}             onProgress
 */
async function savePages(pages, assetMap, destDir, rootUrl, onProgress) {
  let processed = 0;
  const total = pages.size;

  // Build a lookup: page-url → local-path
  const pageLocalPaths = new Map();
  for (const [url] of pages) {
    pageLocalPaths.set(url, urlToLocalPath(url, true));
  }

  // Pre-create all directories needed by pages.
  // If a file exists at a path where we need a directory, remove it first.
  const allPageDirs = new Set();
  for (const [, localPath] of pageLocalPaths) {
    const dir = path.dirname(path.join(destDir, localPath));
    allPageDirs.add(dir);
  }

  for (const dir of allPageDirs) {
    // Check each segment of the path for file-vs-directory conflicts
    const relative = path.relative(destDir, dir);
    const segments = relative.split(path.sep).filter(Boolean);
    let current = destDir;
    for (const seg of segments) {
      current = path.join(current, seg);
      try {
        const stat = await fs.promises.stat(current);
        if (!stat.isDirectory()) {
          // A file exists where we need a directory - remove it
          await fs.promises.unlink(current);
          await fs.promises.mkdir(current, { recursive: true });
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          // Doesn't exist yet, create it
          await fs.promises.mkdir(current, { recursive: true });
        } else {
          throw e;
        }
      }
    }
  }

  for (const [pageUrl, html] of pages) {
    onProgress({
      currentAction: 'Rewriting URLs',
      filesProcessed: processed,
      totalFiles: total,
    });

    const $ = cheerio.load(html);
    const thisLocalPath = pageLocalPaths.get(pageUrl);

    // Helper: rewrite a single attribute value
    const rewrite = (absUrl) => {
      // Check asset map first
      if (assetMap.has(absUrl)) {
        return relativeBetween(thisLocalPath, assetMap.get(absUrl));
      }
      // Check page map
      // Normalise to match
      for (const [pUrl, pLocal] of pageLocalPaths) {
        if (absUrl === pUrl || absUrl === pUrl + '/' || absUrl + '/' === pUrl) {
          return relativeBetween(thisLocalPath, pLocal);
        }
      }
      return null; // leave unchanged
    };

    // Rewrite <a href>
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
      try {
        const abs = new URL(href, pageUrl).href;
        const local = rewrite(abs);
        if (local) $(el).attr('href', local);
      } catch { /* skip */ }
    });

    // Rewrite <link href>
    $('link[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      try {
        const abs = new URL(href, pageUrl).href;
        const local = rewrite(abs);
        if (local) $(el).attr('href', local);
      } catch { /* skip */ }
    });

    // Rewrite <script src>
    $('script[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      try {
        const abs = new URL(src, pageUrl).href;
        const local = rewrite(abs);
        if (local) $(el).attr('src', local);
      } catch { /* skip */ }
    });

    // Rewrite <img src>
    $('img[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src || src.startsWith('data:')) return;
      try {
        const abs = new URL(src, pageUrl).href;
        const local = rewrite(abs);
        if (local) $(el).attr('src', local);
      } catch { /* skip */ }
    });

    // Write the file (directories already exist from pre-creation above)
    const fullPath = path.join(destDir, thisLocalPath);
    await fse.writeFile(fullPath, $.html(), 'utf-8');
    processed++;
  }
}

module.exports = { downloadAssets, savePages, urlToLocalPath };
