// Pure timeline mapping - shared by the renderer (as window.FameCore) and
// the Node test harness. Ported from the Premiere plugin's main.js and the
// Reaper plugin's Lua, rule for rule:
//
// - Candidates arrive in RAW-recording seconds and are mapped through the
//   clip that uses that recording (exact file name, Riverside speaker slug,
//   the speaker's name anywhere in the clip name, then a long clip whose
//   source range contains the moment).
// - A candidate wholly inside a clip maps even when shorter than 30 ms
//   (mouth clicks); only a sliver at a clip edge is refused.
// - Ranges are merged when within 120 ms and applied back-to-front.
// - A speaker owns EVERY track where most clips (or the track name) mention
//   them - an AE keeps a speaker on more than one track.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.FameCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function basename(p) { return String(p || "").split(/[\\/]/).pop(); }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function clipMentionsSpeaker(clipName, speaker) {
    if (!speaker) return false;
    var parts = String(speaker).split(/[\s_-]+/).filter(function (p) { return p.length > 2; });
    if (!parts.length) return false;
    var hay = String(clipName || "").toLowerCase();
    for (var i = 0; i < parts.length; i++) {
      if (hay.indexOf(parts[i].toLowerCase()) >= 0) return true;
    }
    return false;
  }

  function riversideMatch(name, speaker) {
    var re = new RegExp("^riverside[_-]" + escapeRe(speaker).replace(/[ _-]+/g, "[ _-]") + "[_-]", "i");
    return re.test(name || "");
  }

  function mapCandidate(c, clips) {
    var matches = clips.filter(function (cl) {
      var b = basename(cl.path) || cl.name;
      if (c.file && (b === c.file || cl.name === c.file)) return true;
      if (c.speaker && (riversideMatch(b, c.speaker) || riversideMatch(cl.name, c.speaker))) return true;
      if (!c.file && !c.speaker) return /^riverside[_-]/i.test(b) || /^riverside[_-]/i.test(cl.name);
      return false;
    });
    if (!matches.length && c.speaker) {
      matches = clips.filter(function (cl) {
        return clipMentionsSpeaker(basename(cl.path) || cl.name, c.speaker) || clipMentionsSpeaker(cl.name, c.speaker);
      });
    }
    if (!matches.length) {
      matches = clips.filter(function (cl) {
        return (cl.outPoint - cl.inPoint) > 120 && c.startSec >= cl.inPoint - 0.5 && c.startSec <= cl.outPoint + 0.5;
      });
    }
    matches = matches.slice().sort(function (a, b) {
      var ka = a.type === "audio" ? 0 : 1, kb = b.type === "audio" ? 0 : 1;
      return ka - kb || a.start - b.start;
    });
    for (var i = 0; i < matches.length; i++) {
      var cl = matches[i];
      var s = Math.max(c.startSec, cl.inPoint);
      var e = Math.min(c.endSec, cl.outPoint);
      var whole = (e - s) >= (c.endSec - c.startSec) - 1e-6;
      if (e > s && (e - s > 0.03 || whole)) {
        var rate = cl.rate || 1;
        return { s: cl.start + (s - cl.inPoint) / rate, e: cl.start + (e - cl.inPoint) / rate, track: cl.track };
      }
    }
    return null;
  }

  // Ticked candidates -> merged ranges, back-to-front. `checks` is keyed by
  // candidate index; a candidate needs a mapped `_seq`.
  function selectedRanges(cands, checks) {
    var ranges = [];
    cands.forEach(function (c, i) {
      var idx = c._idx != null ? c._idx : i;
      if (checks[idx] && c._seq) ranges.push({ s: c._seq.s, e: c._seq.e });
    });
    ranges.sort(function (a, b) { return a.s - b.s; });
    var merged = [];
    ranges.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && r.s - last.e <= 0.12) last.e = Math.max(last.e, r.e);
      else merged.push({ s: r.s, e: r.e });
    });
    merged.sort(function (a, b) { return b.s - a.s; });
    return merged;
  }

  // ALL tracks a speaker owns, by majority of clip names (or the track name).
  function tracksForSpeaker(clipsInfo, speaker) {
    var votes = {}, totals = {}, seen = {};
    (clipsInfo.clips || []).forEach(function (cl) {
      totals[cl.track] = (totals[cl.track] || 0) + 1;
      seen[cl.track] = cl.trackName;
      if (clipMentionsSpeaker(cl.name, speaker) || clipMentionsSpeaker(basename(cl.path), speaker) || clipMentionsSpeaker(cl.trackName, speaker)) {
        votes[cl.track] = (votes[cl.track] || 0) + 1;
      }
    });
    return Object.keys(totals).map(Number).filter(function (t) { return (votes[t] || 0) * 2 > totals[t]; }).sort(function (a, b) { return a - b; });
  }

  // Timeline seconds -> raw-source seconds through the clip under that moment.
  function sourceAnchor(t, clips) {
    for (var i = 0; i < clips.length; i++) {
      var cl = clips[i];
      if (t >= cl.start - 0.25 && t <= cl.end + 0.25) return cl.inPoint + (t - cl.start) * (cl.rate || 1);
    }
    return null;
  }

  function versionNewer(a, b) {
    var pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  function median(list) {
    if (!list.length) return null;
    var c = list.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(c.length / 2);
    return c.length % 2 ? c[mid] : (c[mid - 1] + c[mid]) / 2;
  }

  return {
    basename: basename, clipMentionsSpeaker: clipMentionsSpeaker, mapCandidate: mapCandidate,
    selectedRanges: selectedRanges, tracksForSpeaker: tracksForSpeaker, sourceAnchor: sourceAnchor,
    versionNewer: versionNewer, median: median,
    MAX_LEVEL_FIX_DB: 30, FADE_SEC: 0.010,
  };
});
