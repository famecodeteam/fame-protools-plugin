// Shared by every adapter: the bundled ffmpeg, a promise wrapper around
// spawn, and the EBU R128 measurement. Moved out of the Pro Tools adapter
// when Cubase arrived so neither forks the other.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function ffmpegPath() {
  let p;
  try { p = require("ffmpeg-static"); } catch (e) { p = null; }
  if (p && p.indexOf("app.asar") >= 0) p = p.replace("app.asar", "app.asar.unpacked");
  if (p && fs.existsSync(p)) return p;
  return process.env.FAME_FFMPEG || "ffmpeg";
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    let out = "", err = "";
    const child = spawn(cmd, args, { windowsHide: true });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(new Error("Could not start " + cmd + ": " + e.message)));
    child.on("close", (code) => {
      if (code !== 0 && !(opts && opts.ignoreExit)) return reject(new Error(cmd + " exited " + code + ": " + err.slice(-400)));
      resolve({ out, err });
    });
  });
}

// ffmpeg ebur128 - integrated loudness + true peak, on this machine only.
// opts.inSec/outSec measure one slice of the file (music balance uses a
// clip's own source range).
async function measure(file, opts) {
  opts = opts || {};
  const args = ["-hide_banner", "-nostats"];
  if (opts.inSec != null) args.push("-ss", String(Math.max(0, opts.inSec)));
  if (opts.outSec != null && opts.inSec != null) args.push("-t", String(Math.max(0.1, opts.outSec - opts.inSec)));
  args.push("-i", file, "-filter_complex", "ebur128=peak=true", "-f", "null", "-");
  const { err } = await run(ffmpegPath(), args, { ignoreExit: true });
  // ebur128 prints a running block first and the real summary LAST.
  const last = (re) => { const all = err.match(new RegExp(re.source, "g")) || []; const m = all.length ? all[all.length - 1].match(re) : null; return m ? m[1] : undefined; };
  const lufs = last(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+)\s*LUFS/);
  const tp = last(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+)\s*dBFS/);
  const dur = (err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/) || []);
  const ch = (err.match(/Audio:.*?,\s*(\d+)\s*Hz,\s*([^,]+)/) || [])[2] || "";
  const channels = /mono/.test(ch) ? 1 : /stereo/.test(ch) ? 2 : (Number((ch.match(/(\d+)\s*channels?/) || [])[1]) || 0);
  if (!lufs && !dur.length) throw new Error("ffmpeg could not read " + path.basename(file) + ".");
  return {
    durationSec: dur.length ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null,
    channels: channels || null,
    lufs: lufs != null ? Number(lufs) : null,
    truePeakDb: tp != null ? Number(tp) : null,
  };
}

module.exports = { ffmpegPath, run, measure };
