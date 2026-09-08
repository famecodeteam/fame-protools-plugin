// The exchange folder: Cubase writes into it (track archives, audio
// mixdowns), the Plugin reads from it. fs.watch is unreliable on network
// drives and misses files that are still being written, so "newest" is a
// directory scan and "wait for a new file" polls and only accepts a file
// whose size has stopped changing.

"use strict";

const fs = require("fs");
const path = require("path");

const ARCHIVE_EXT = [".xml"];
const AUDIO_EXT = [".wav", ".mp3", ".aif", ".aiff", ".flac", ".m4a"];

function listFiles(dir, exts) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  names.forEach(function (n) {
    if (n.startsWith(".")) return;
    if (exts.indexOf(path.extname(n).toLowerCase()) < 0) return;
    const p = path.join(dir, n);
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (!st.isFile()) return;
    out.push({ path: p, name: n, mtimeMs: st.mtimeMs, size: st.size });
  });
  out.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });
  return out;
}

function newest(dir, exts, filter) {
  const list = listFiles(dir, exts).filter(filter || function () { return true; });
  return list[0] || null;
}

// Resolve with the first file (matching exts) that appears or changes
// after `sinceMs` and then keeps a stable size for `settleMs`.
function waitForNewFile(dir, exts, opts) {
  opts = opts || {};
  const sinceMs = opts.sinceMs || Date.now();
  const timeoutMs = opts.timeoutMs || 45 * 60 * 1000;
  const settleMs = opts.settleMs || 3000;
  const pollMs = opts.pollMs || 1500;
  const filter = opts.filter || function () { return true; };
  return new Promise(function (resolve, reject) {
    const started = Date.now();
    let candidate = null, lastSize = -1, stableSince = 0;
    let stopped = false;
    if (opts.signal) opts.signal.onabort = function () { stopped = true; reject(new Error("cancelled")); };
    (function tick() {
      if (stopped) return;
      if (Date.now() - started > timeoutMs) return reject(new Error("No new file appeared in " + dir + " - export again, or pick the file yourself."));
      const fresh = listFiles(dir, exts).filter(function (f) { return f.mtimeMs >= sinceMs - 2000 && filter(f); });
      if (fresh.length) {
        const f = fresh[0];
        if (!candidate || candidate.path !== f.path) { candidate = f; lastSize = f.size; stableSince = Date.now(); }
        else if (f.size !== lastSize) { lastSize = f.size; stableSince = Date.now(); }
        else if (Date.now() - stableSince >= settleMs && f.size > 0) return resolve(f);
      }
      setTimeout(tick, pollMs);
    })();
  });
}

module.exports = { listFiles, newest, waitForNewFile, ARCHIVE_EXT, AUDIO_EXT };
