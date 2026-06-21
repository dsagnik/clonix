/**
 * crawler.js
 * -----------
 * Recursive website crawler that discovers internal pages and collects
 * asset URLs (CSS, JS, images, fonts, PDFs) from an HTML website.
 *
 * Exports a single `crawl` function that accepts a root URL and a
 * progress-reporting callback, then returns a structured manifest of
 * all discovered pages and assets.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Normalise a URL by stripping the hash fragment and trailing slash
 * so that duplicates are detected reliably.
 */
function normaliseUrl(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    let pathname = u.pathname.replace(/\/+$/, '') || '/';
    u.pathname = pathname;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Resolve a potentially-relative href against a base URL.
 */
function resolveUrl(base, href) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * Determine whether a URL belongs to the same origin as the root URL.
 */
function isSameOrigin(rootUrl, candidateUrl) {
  try {
    const a = new URL(rootUrl);
    const b = new URL(candidateUrl);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

/**
 * Check whether a URL points to an asset we want to download
 * (based on file extension).
 */
const ASSET_EXTENSIONS = /\.(css|js|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|otf|pdf)(\?.*)?$/i;

function isAssetUrl(href) {
  try {
    const u = new URL(href);
    return ASSET_EXTENSIONS.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Decide whether a URL is likely an HTML page we should crawl.
 */
const SKIP_EXTENSIONS = /\.(css|js|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|otf|pdf|zip|tar|gz|mp4|mp3|avi|mov|xml|json|txt|csv)(\?.*)?$/i;

function isLikelyPage(href) {
  try {
    const u = new URL(href);
    return !SKIP_EXTENSIONS.test(u.pathname);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Main crawl function                                                */
/* ------------------------------------------------------------------ */

/**
 * Crawl a website starting from `rootUrl`.
 *
 * @param {string}   rootUrl   – The starting URL (e.g. https://example.com)
 * @param {Function} onProgress – Callback receiving { pagesFound, assetsFound, currentAction }
 * @param {object}   [options]
 * @param {number}   [options.maxPages=100]    – Cap on pages to crawl
 * @param {number}   [options.concurrency=5]   – Parallel fetch limit
 * @param {number}   [options.timeout=15000]   – Per-request timeout in ms
 *
 * @returns {Promise<{ pages: Map<string, string>, assets: Set<string> }>}
 *          pages: Map of normalised-URL → HTML body
 *          assets: Set of absolute asset URLs
 */
async function crawl(rootUrl, onProgress, options = {}) {
  const {
    maxPages = 100,
    timeout = 15000,
  } = options;

  const visited = new Set();        // normalised URLs already fetched
  const queue = [];                 // URLs still to visit
  const pages = new Map();          // url → html
  const assets = new Set();         // absolute asset URLs

  const normRoot = normaliseUrl(rootUrl);
  if (!normRoot) throw new Error('Invalid root URL');

  queue.push(normRoot);

  const axiosInstance = axios.create({
    timeout,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Clonix/1.0 (Website Archiver)',
      'Accept': 'text/html,application/xhtml+xml,*/*',
    },
    // Accept all status codes so we can handle errors ourselves
    validateStatus: () => true,
  });

  while (queue.length > 0 && visited.size < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    onProgress({
      pagesFound: pages.size,
      assetsFound: assets.size,
      currentAction: `Scanning: ${url}`,
    });

    try {
      const res = await axiosInstance.get(url);
      if (res.status >= 400) continue;

      const contentType = (res.headers['content-type'] || '');
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        continue;
      }

      const html = res.data;
      if (typeof html !== 'string') continue;

      pages.set(url, html);

      // Parse and extract links & assets
      const $ = cheerio.load(html);

      // Internal links (<a href>)
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
        const abs = resolveUrl(url, href);
        if (!abs) return;
        const norm = normaliseUrl(abs);
        if (!norm) return;
        if (isSameOrigin(normRoot, norm) && !visited.has(norm) && isLikelyPage(norm)) {
          queue.push(norm);
        }
      });

      // CSS & asset links (only stylesheets, preloaded assets, and icons)
      $('link[href]').each((_, el) => {
        const rel = ($(el).attr('rel') || '').toLowerCase();
        const href = $(el).attr('href');
        if (!href) return;

        // Only collect actual asset links, skip canonical/alternate/preconnect/etc.
        const isAssetLink = rel.includes('stylesheet')
          || rel.includes('icon')
          || rel.includes('preload')
          || rel.includes('prefetch')
          || isAssetUrl(href);

        if (!isAssetLink) return;

        const abs = resolveUrl(url, href);
        if (abs) assets.add(abs);
      });

      // Scripts (<script src>)
      $('script[src]').each((_, el) => {
        const src = $(el).attr('src');
        const abs = resolveUrl(url, src);
        if (abs) assets.add(abs);
      });

      // Images (<img src>, <img srcset>, <source srcset>)
      $('img[src]').each((_, el) => {
        const src = $(el).attr('src');
        if (src && !src.startsWith('data:')) {
          const abs = resolveUrl(url, src);
          if (abs) assets.add(abs);
        }
      });
      $('img[srcset], source[srcset]').each((_, el) => {
        const srcset = $(el).attr('srcset') || '';
        srcset.split(',').forEach((entry) => {
          const parts = entry.trim().split(/\s+/);
          if (parts[0] && !parts[0].startsWith('data:')) {
            const abs = resolveUrl(url, parts[0]);
            if (abs) assets.add(abs);
          }
        });
      });

      // Inline style background images
      $('[style]').each((_, el) => {
        const style = $(el).attr('style') || '';
        const urlMatches = style.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g);
        if (urlMatches) {
          urlMatches.forEach((match) => {
            const inner = match.replace(/url\(\s*['"]?/, '').replace(/['"]?\s*\)/, '');
            if (inner && !inner.startsWith('data:')) {
              const abs = resolveUrl(url, inner);
              if (abs) assets.add(abs);
            }
          });
        }
      });

      // Favicons / icons
      $('link[rel*="icon"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) {
          const abs = resolveUrl(url, href);
          if (abs) assets.add(abs);
        }
      });

    } catch (err) {
      // Network / parse errors – skip silently
      console.warn(`[crawler] Failed to fetch ${url}: ${err.message}`);
    }
  }

  return { pages, assets };
}

module.exports = { crawl };
