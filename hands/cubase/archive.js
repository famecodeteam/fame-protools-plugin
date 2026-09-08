// Cubase track archive (File > Export > Selected Tracks) - read the
// timeline out of it and write edits back into it.
//
// The archive is Cubase's own object dump: <tracklist2> holding a list of
// track objects; each track has an MListNode "Node" with the track name,
// a Domain (Type 1 = linear, values in SECONDS; Type 0 = musical, values
// in 480-PPQ ticks) and an Events list. A global PArrangeSetup carries the
// sample rate and timecode frame type. All of that is confirmed on real
// exports. The audio-event fields (Offset into the file, fades, mute) are
// the part only a real audio export settles - schema.json says which is
// which, and everything here reads defensively and reports what it found.
//
// Edits never rebuild the file: they change attribute values, clone
// existing nodes for splits, and drop nodes for removals, so everything
// we do not understand (plugin blobs, routing, IDs) survives untouched.

"use strict";

const fs = require("fs");
const path = require("path");
const X = require("./xml");
const SCHEMA = require("./schema.json");

const PPQ = SCHEMA.tempo.ppqPerQuarter;

class ArchiveError extends Error {}

function trackKind(cls) {
  const t = SCHEMA.trackClasses;
  if (t.audio.indexOf(cls) >= 0) return "audio";
  if (t.marker.indexOf(cls) >= 0) return "marker";
  if (t.folder.indexOf(cls) >= 0) return "folder";
  if (t.midi.indexOf(cls) >= 0) return "midi";
  return "other";
}
function eventKind(cls) {
  if (SCHEMA.eventClasses.audio.indexOf(cls) >= 0) return "audio";
  if (SCHEMA.eventClasses.part.indexOf(cls) >= 0) return "part";
  return "other";
}

// ----- tempo (musical-domain tracks need it) -----

function readTempo(root) {
  const events = [];
  X.walk(root, function (el) {
    if (X.attr(el, "class") !== SCHEMA.tempo.class) return;
    const list = X.byName(el, SCHEMA.tempo.list, "list");
    if (!list) return;
    X.elems(list).forEach(function (ev) {
      if (X.attr(ev, "class") !== SCHEMA.tempo.eventClass) return;
      events.push({ bpm: X.num(ev, SCHEMA.tempo.bpm, 120), ppq: X.num(ev, SCHEMA.tempo.ppq, 0), ramp: X.num(ev, "Func", 0) === 1 });
    });
  });
  events.sort(function (a, b) { return a.ppq - b.ppq; });
  return events;
}

// PPQ ticks -> seconds through a jump-only tempo map. A ramp makes the
// maths tempo-curve dependent; refuse and tell the editor the one-click fix.
function ppqToSec(ppq, tempo) {
  if (!tempo.length) return ppq / PPQ * 60 / 120;
  // A ramp makes the maths tempo-curve dependent: approximate with jumps
  // for READING (positions are only used to map candidates) and refuse to
  // WRITE such a track (assertEditable) with the one-click fix.
  let sec = 0, at = 0, bpm = tempo[0].bpm;
  for (let i = 0; i < tempo.length; i++) {
    const t = tempo[i];
    if (t.ppq >= ppq) break;
    if (t.ppq > at) { sec += (t.ppq - at) / PPQ * 60 / bpm; at = t.ppq; }
    bpm = t.bpm;
  }
  return sec + (ppq - at) / PPQ * 60 / bpm;
}
function secToPpq(sec, tempo) {
  if (!tempo.length) return sec * 120 / 60 * PPQ;
  let s = 0, at = 0, bpm = tempo[0].bpm;
  for (let i = 0; i < tempo.length; i++) {
    const t = tempo[i];
    const segSec = (t.ppq - at) / PPQ * 60 / bpm;
    if (t.ppq <= at) { bpm = t.bpm; continue; }
    if (s + segSec >= sec) break;
    s += segSec; at = t.ppq; bpm = t.bpm;
  }
  return at + (sec - s) * bpm / 60 * PPQ;
}

// ----- reading -----

function looksLikePath(v) { return /\.(wav|aif|aiff|flac|mp3|m4a|ogg|wma|caf|w64)$/i.test(String(v || "")); }

function readEvent(ev, track, ctx) {
  const cls = X.attr(ev, "class") || "";
  const kind = eventKind(cls);
  const u = ctx.toSec[track.domain];
  const start = u(X.num(ev, SCHEMA.event.start, 0));
  const length = u(X.num(ev, SCHEMA.event.length, 0));
  const offRaw = X.num(ev, SCHEMA.event.offset, null);
  const offset = offRaw != null ? u(offRaw) : 0;
  // Name and file path: walk the event's subtree for the first Name string
  // and the first string that ends in an audio extension (the clip object
  // and the media file live somewhere below the event).
  let name = "", filePath = "";
  X.walk(ev, function (el) {
    if (el.tag !== "string") return;
    const n = X.attr(el, "name"), v = X.attr(el, "value") || "";
    if (!name && n === SCHEMA.event.name) name = v;
    if (!filePath && (SCHEMA.clip.pathKeys.indexOf(n) >= 0 || looksLikePath(v)) && looksLikePath(v)) filePath = v;
  });
  if (!name) name = X.value(ev, SCHEMA.event.name) || "";
  const fadeIn = X.byName(ev, SCHEMA.event.fadeIn, "member");
  const fadeOut = X.byName(ev, SCHEMA.event.fadeOut, "member");
  const flags = X.num(ev, SCHEMA.event.flags, 0);
  const muted = SCHEMA.event.muteFlagBit != null ? !!(flags & (1 << SCHEMA.event.muteFlagBit)) : false;
  return {
    node: ev, cls, kind, start, end: start + length, length, offset, name, path: filePath, muted,
    fadeIn: fadeIn ? u(X.num(fadeIn, SCHEMA.event.fadeLength, 0)) : 0,
    fadeOut: fadeOut ? u(X.num(fadeOut, SCHEMA.event.fadeLength, 0)) : 0,
    hasOffset: offRaw != null,
  };
}

function parseArchive(text, opts) {
  opts = opts || {};
  const root = X.parse(text);
  const top = X.child(root, function (c) { return c.tag === SCHEMA.root.tag; });
  if (!top) throw new ArchiveError("That file is not a Cubase track archive (no <tracklist2>). Use File > Export > Selected Tracks in Cubase.");
  const setupEl = X.child(top, function (c) { return X.attr(c, "class") === SCHEMA.setup.class; });
  const setup = { sampleRate: 48000, frameType: 3, fps: 25, dropFrame: false, startSec: 0, lengthSec: 0 };
  if (setupEl) {
    setup.sampleRate = X.num(setupEl, SCHEMA.setup.sampleRate, 48000);
    setup.frameType = X.num(setupEl, SCHEMA.setup.frameType, 3);
    setup.fps = Number(SCHEMA.frameTypes[String(setup.frameType)]) || 25;
    setup.dropFrame = SCHEMA.dropFrameTypes.indexOf(setup.frameType) >= 0;
    const st = X.byName(setupEl, SCHEMA.setup.start, "member");
    const ln = X.byName(setupEl, SCHEMA.setup.length, "member");
    if (st) setup.startSec = X.num(st, SCHEMA.setup.time, 0);
    if (ln) setup.lengthSec = X.num(ln, SCHEMA.setup.time, 0);
  }
  const tempo = readTempo(top);
  const ctx = {
    tempo,
    toSec: { linear: function (v) { return v; }, musical: function (v) { return ppqToSec(v, tempo); } },
    fromSec: { linear: function (s) { return s; }, musical: function (s) { return secToPpq(s, tempo); } },
  };
  const list = X.byName(top, SCHEMA.trackList.name, "list");
  const tracks = [];
  const unknownClasses = {};
  X.elems(list).forEach(function (tr, i) {
    const cls = X.attr(tr, "class") || "";
    const kind = trackKind(cls);
    if (kind === "other") unknownClasses[cls] = (unknownClasses[cls] || 0) + 1;
    const node = X.child(tr, function (c) { return X.attr(c, "class") === SCHEMA.node.class && X.attr(c, "name") === SCHEMA.node.name; });
    const name = node ? (X.value(node, SCHEMA.trackName.name) || "") : "";
    const dom = node ? X.byName(node, SCHEMA.domain.member, "member") : null;
    const domType = dom ? X.num(dom, SCHEMA.domain.type, 1) : 1;
    const domain = domType === SCHEMA.domain.musical ? "musical" : "linear";
    const eventsList = node ? X.byName(node, SCHEMA.events.list, "list") : null;
    const track = { index: i, node: tr, listNode: node, eventsList, cls, kind, name, domain, events: [], partCount: 0, eventClasses: {} };
    if (eventsList) {
      X.elems(eventsList).forEach(function (ev) {
        const ecls = X.attr(ev, "class") || "";
        track.eventClasses[ecls] = (track.eventClasses[ecls] || 0) + 1;
        const e = readEvent(ev, track, ctx);
        if (e.kind === "part") track.partCount++;
        track.events.push(e);
      });
    }
    track.events.sort(function (a, b) { return a.start - b.start; });
    tracks.push(track);
  });
  return { root, top, setup, tempo, ctx, tracks, unknownClasses, list };
}

function readFile(file) { return parseArchive(fs.readFileSync(file, "utf8")); }
function serialize(archive) { return X.serialize(archive.root); }

// ----- ids -----

function allIds(root) {
  const ids = [];
  X.walk(root, function (el) { const v = X.attr(el, "ID"); if (v != null && /^\d+$/.test(v)) ids.push(v); });
  return ids;
}
function idAllocator(root) {
  let max = 0n;
  allIds(root).forEach(function (v) { const b = BigInt(v); if (b > max) max = b; });
  return function () { max += 1n; return max.toString(); };
}
function reassignIds(node, next) {
  X.walk(node, function (el) { if (X.attr(el, "ID") != null) X.setAttr(el, "ID", next()); });
  if (X.attr(node, "ID") != null) X.setAttr(node, "ID", next());
}

// ----- writing helpers -----

function fmt(n) {
  // Cubase writes plain decimals (no exponent); 9 places is well under a
  // sample at 48 kHz and keeps the file readable.
  if (Math.abs(n - Math.round(n)) < 1e-12) return String(Math.round(n));
  return n.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

function setEventTimes(archive, track, ev, startSec, lengthSec, offsetSec) {
  const f = archive.ctx.fromSec[track.domain];
  X.setValue(ev.node, SCHEMA.event.start, fmt(f(startSec)));
  X.setValue(ev.node, SCHEMA.event.length, fmt(f(lengthSec)));
  if (offsetSec != null) {
    if (!X.setValue(ev.node, SCHEMA.event.offset, fmt(f(offsetSec))) && offsetSec !== 0) {
      // No Offset field in this export: add one after Length, the way
      // Cubase orders the keys, so the trimmed head is honoured on import.
      const lenEl = X.byName(ev.node, SCHEMA.event.length);
      if (lenEl) X.insertAfter(ev.node, lenEl, X.make("float", [["name", SCHEMA.event.offset], ["value", fmt(f(offsetSec))]]));
    }
  }
  ev.start = startSec; ev.length = lengthSec; ev.end = startSec + lengthSec;
  if (offsetSec != null) ev.offset = offsetSec;
}

// Fades: copy the shape of a fade Cubase itself wrote somewhere in this
// file and set its length. When the export carries no fade at all, say
// so once - the cut still lands.
function fadeTemplate(archive, which) {
  let found = null;
  X.walk(archive.top, function (el) { if (!found && el.tag === "member" && X.attr(el, "name") === which && X.byName(el, SCHEMA.event.fadeLength)) found = el; });
  return found;
}
function setFade(archive, track, ev, which, sec, state) {
  const existing = X.byName(ev.node, which, "member");
  const f = archive.ctx.fromSec[track.domain];
  if (existing) {
    if (X.setValue(existing, SCHEMA.event.fadeLength, fmt(f(sec)))) { state.fades++; return; }
  }
  const tpl = fadeTemplate(archive, which);
  if (!tpl) {
    state.fadesSkipped = "the export carries no fade data yet - put any short fade on one event in Cubase before exporting and the Plugin copies its shape onto every seam";
    return;
  }
  const c = X.clone(tpl);
  X.setValue(c, SCHEMA.event.fadeLength, fmt(f(sec)));
  const last = X.elems(ev.node).slice(-1)[0];
  if (last) X.insertAfter(ev.node, last, c); else ev.node.children.push(c);
  state.fades++;
}

function splitEvent(archive, track, ev, atSec, nextId) {
  // left keeps the node; right is a clone starting at the split.
  const rightLen = ev.end - atSec, leftLen = atSec - ev.start;
  const rnode = X.clone(ev.node);
  reassignIds(rnode, nextId);
  X.insertAfter(track.eventsList, ev.node, rnode);
  const right = Object.assign({}, ev, { node: rnode });
  setEventTimes(archive, track, ev, ev.start, leftLen, ev.offset);
  setEventTimes(archive, track, right, atSec, rightLen, ev.offset + leftLen);
  // fades belong to the outer edges; a fresh split edge starts clean
  const fo = X.byName(ev.node, SCHEMA.event.fadeOut, "member"); if (fo) X.setValue(fo, SCHEMA.event.fadeLength, "0");
  const fi = X.byName(rnode, SCHEMA.event.fadeIn, "member"); if (fi) X.setValue(fi, SCHEMA.event.fadeLength, "0");
  const i = track.events.indexOf(ev);
  track.events.splice(i + 1, 0, right);
  return right;
}

function removeEvent(track, ev) {
  X.remove(track.eventsList, ev.node);
  track.events.splice(track.events.indexOf(ev), 1);
}

function assertEditable(archive, t) {
  if (t.partCount) throw new ArchiveError("Track \"" + t.name + "\" holds audio parts. In Cubase select them and use Audio > Dissolve Part, then export again.");
  if (t.domain === "musical" && archive.tempo.some(function (x) { return x.ramp; })) throw new ArchiveError("Track \"" + t.name + "\" is on the musical time base under a tempo ramp - switch it to Linear (the clock icon on the track) and export again.");
}

function refreshTrackLength(archive, track) {
  const end = track.events.reduce(function (m, e) { return Math.max(m, e.end); }, 0);
  const f = archive.ctx.fromSec[track.domain];
  X.setValue(track.node, SCHEMA.event.length, fmt(f(end)));
}

// Ripple cut: remove [s,e) from every audio track and pull everything
// later up by (e-s). Ranges MUST arrive back-to-front (the interface
// guarantees it) so earlier seams are still where the caller measured.
function rippleCut(archive, ranges, opts) {
  opts = opts || {};
  const fadeSec = opts.fadeSec == null ? 0.010 : opts.fadeSec;
  const nextId = idAllocator(archive.root);
  const state = { applied: 0, fades: 0, fadesSkipped: null, seams: [] };
  const sorted = ranges.slice().sort(function (a, b) { return b.s - a.s; });
  const audio = archive.tracks.filter(function (t) { return t.kind === "audio"; });
  if (!audio.length) throw new ArchiveError("No audio tracks in that archive - select the speaker tracks before File > Export > Selected Tracks.");
  audio.forEach(function (t) { assertEditable(archive, t); });
  sorted.forEach(function (r) {
    if (r.e <= r.s + 0.0005) return;
    const len = r.e - r.s;
    audio.forEach(function (t) {
      const seamEvents = { left: null, right: null };
      t.events.slice().forEach(function (ev) {
        if (ev.end <= r.s) { if (Math.abs(ev.end - r.s) < 1e-6) seamEvents.left = ev; return; }
        if (ev.start >= r.e) { setEventTimes(archive, t, ev, ev.start - len, ev.length, ev.offset); if (Math.abs(ev.start - r.s) < 1e-6) seamEvents.right = ev; return; }
        if (ev.start >= r.s && ev.end <= r.e) { removeEvent(t, ev); return; }
        if (ev.start < r.s && ev.end > r.e) {
          const right = splitEvent(archive, t, ev, r.s, nextId);
          // right now covers [r.s, end) - trim its head by len and pull it up
          setEventTimes(archive, t, right, r.s, right.length - len, right.offset + len);
          seamEvents.left = ev; seamEvents.right = right;
          return;
        }
        if (ev.start < r.s) { setEventTimes(archive, t, ev, ev.start, r.s - ev.start, ev.offset); seamEvents.left = ev; return; }
        // starts inside the range, ends after it
        const trim = r.e - ev.start;
        setEventTimes(archive, t, ev, r.s, ev.length - trim, ev.offset + trim);
        seamEvents.right = ev;
      });
      if (fadeSec > 0) {
        if (seamEvents.left) setFade(archive, t, seamEvents.left, SCHEMA.event.fadeOut, fadeSec, state);
        if (seamEvents.right) setFade(archive, t, seamEvents.right, SCHEMA.event.fadeIn, fadeSec, state);
      }
    });
    state.applied++;
    state.seams.push(r.s);
  });
  audio.forEach(function (t) { refreshTrackLength(archive, t); });
  return state;
}

// Silence [s,e) on the given tracks only: split at both edges and drop
// the middle piece (a gap - the same treatment the Pro Tools adapter
// gives, and it needs no knowledge of Cubase's mute flag). Timeline
// length unchanged.
function silence(archive, specs, opts) {
  opts = opts || {};
  const fadeSec = opts.fadeSec == null ? 0.010 : opts.fadeSec;
  const nextId = idAllocator(archive.root);
  const state = { silenced: 0, tracks: 0, fades: 0, fadesSkipped: null };
  const touched = {};
  specs.forEach(function (spec) {
    const tracks = archive.tracks.filter(function (t) { return t.kind === "audio" && spec.tracks.indexOf(t.index) >= 0; });
    tracks.forEach(function (t) {
      assertEditable(archive, t);
      spec.ranges.slice().sort(function (a, b) { return b.s - a.s; }).forEach(function (r) {
        if (r.e <= r.s + 0.0005) return;
        let did = false;
        t.events.slice().forEach(function (ev) {
          if (ev.end <= r.s || ev.start >= r.e) return;
          did = true;
          let left = null, right = null;
          if (ev.start < r.s && ev.end > r.e) {
            right = splitEvent(archive, t, ev, r.s, nextId);
            const after = splitEvent(archive, t, right, r.e, nextId);
            removeEvent(t, right);
            left = ev; right = after;
          } else if (ev.start < r.s) { setEventTimes(archive, t, ev, ev.start, r.s - ev.start, ev.offset); left = ev; }
          else if (ev.end > r.e) { const trim = r.e - ev.start; setEventTimes(archive, t, ev, r.e, ev.length - trim, ev.offset + trim); right = ev; }
          else removeEvent(t, ev);
          if (fadeSec > 0) {
            if (left) setFade(archive, t, left, SCHEMA.event.fadeOut, fadeSec, state);
            if (right) setFade(archive, t, right, SCHEMA.event.fadeIn, fadeSec, state);
          }
        });
        if (did) { state.silenced++; touched[t.index] = true; }
      });
    });
  });
  state.tracks = Object.keys(touched).length;
  return state;
}

function renameTrack(track, name) {
  if (track.listNode) X.setValue(track.listNode, SCHEMA.trackName.name, name);
  track.name = name;
}

// Drop every track that is not in `keep` (by index) - the output archive
// carries only what the editor asked to re-import.
function keepTracks(archive, keep) {
  archive.tracks.slice().forEach(function (t) {
    if (keep.indexOf(t.index) >= 0) return;
    X.remove(archive.list, t.node);
    archive.tracks.splice(archive.tracks.indexOf(t), 1);
  });
}

// Plain clips for the hands interface.
function toClips(archive, opts) {
  opts = opts || {};
  const clips = [];
  archive.tracks.forEach(function (t) {
    if (t.kind !== "audio") return;
    t.events.forEach(function (ev, i) {
      if (ev.kind !== "audio") return;
      clips.push({
        id: X.attr(ev.node, "ID") || (t.index + ":" + i),
        track: t.index, trackName: t.name, name: ev.name || path.basename(ev.path || "") || "",
        path: ev.path || "", type: "audio",
        start: ev.start, end: ev.end, inPoint: ev.offset, outPoint: ev.offset + ev.length, rate: 1, muted: ev.muted,
      });
    });
  });
  return clips;
}

module.exports = { parseArchive, readFile, serialize, rippleCut, silence, renameTrack, keepTracks, toClips, idAllocator, reassignIds, fmt, ArchiveError, SCHEMA, ppqToSec, secToPpq };
