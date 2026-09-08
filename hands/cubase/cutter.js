// The fresh-assembly shortcut: when the timeline IS the raw files laid out
// 1:1 from 0, a ripple cut list is the same on every speaker, so the cuts
// can go into the files themselves with ffmpeg and Cubase imports clean
// audio - no archive round trip. Each kept segment gets a 10 ms fade at
// its seams (afade) before the pieces are concatenated. Output is WAV at
// the source rate so nothing is re-encoded twice.

"use strict";

const fs = require("fs");
const path = require("path");
const { ffmpegPath, run } = require("../common");

const FADE = 0.010;

// ranges: {s,e} in FILE seconds, any order. Returns the kept segments.
function keptSegments(durationSec, ranges) {
  const cuts = ranges.filter(function (r) { return r.e > r.s; }).slice().sort(function (a, b) { return a.s - b.s; });
  const kept = [];
  let at = 0;
  cuts.forEach(function (c) {
    if (c.s > at) kept.push({ s: at, e: Math.min(c.s, durationSec) });
    at = Math.max(at, c.e);
  });
  if (at < durationSec) kept.push({ s: at, e: durationSec });
  return kept.filter(function (k) { return k.e - k.s > 0.001; });
}

async function cutFile(input, output, durationSec, ranges, opts) {
  opts = opts || {};
  const gainDb = opts.gainDb || 0;
  const segs = keptSegments(durationSec, ranges);
  if (!segs.length) throw new Error("Every second of " + path.basename(input) + " would be cut - refusing.");
  // One filter graph: trim each segment, fade its edges, concat, optional gain.
  const parts = [], labels = [];
  segs.forEach(function (k, i) {
    const len = k.e - k.s;
    const fade = Math.min(FADE, len / 2);
    parts.push("[0:a]atrim=start=" + k.s.toFixed(6) + ":end=" + k.e.toFixed(6) + ",asetpts=PTS-STARTPTS" +
      (i > 0 ? ",afade=t=in:st=0:d=" + fade.toFixed(4) : "") +
      (i < segs.length - 1 ? ",afade=t=out:st=" + Math.max(0, len - fade).toFixed(6) + ":d=" + fade.toFixed(4) : "") +
      "[s" + i + "]");
    labels.push("[s" + i + "]");
  });
  let graph = parts.join(";") + ";" + labels.join("") + "concat=n=" + segs.length + ":v=0:a=1[cat]";
  let outLabel = "[cat]";
  if (gainDb) { graph += ";[cat]volume=" + gainDb.toFixed(2) + "dB[g]"; outLabel = "[g]"; }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run(ffmpegPath(), ["-hide_banner", "-nostats", "-y", "-i", input, "-filter_complex", graph, "-map", outLabel, "-c:a", "pcm_s24le", output]);
  return { output, kept: segs.length, removedSec: ranges.reduce(function (a, r) { return a + Math.max(0, r.e - r.s); }, 0) };
}

async function gainFile(input, output, gainDb) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run(ffmpegPath(), ["-hide_banner", "-nostats", "-y", "-i", input, "-af", "volume=" + gainDb.toFixed(2) + "dB", "-c:a", "pcm_s24le", output]);
  return { output };
}

module.exports = { keptSegments, cutFile, gainFile, FADE };
