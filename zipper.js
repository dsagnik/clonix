/**
 * zipper.js
 * ----------
 * Creates a ZIP archive from a directory of downloaded website files
 * using the `archiver` library.
 */

const archiver = require('archiver');
const fse = require('fs-extra');
const path = require('path');
const fs = require('fs');

/**
 * Create a ZIP file from the contents of `sourceDir`.
 *
 * @param {string} sourceDir  – Directory containing the downloaded website
 * @param {string} outputPath – Full path for the resulting .zip file
 * @param {Function} onProgress – Callback receiving { currentAction }
 * @returns {Promise<{ zipSize: number }>}
 */
async function createZip(sourceDir, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    onProgress({ currentAction: 'Creating ZIP Archive' });

    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => {
      const zipSize = archive.pointer();
      resolve({ zipSize });
    });

    archive.on('error', (err) => reject(err));
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

module.exports = { createZip, formatBytes };
