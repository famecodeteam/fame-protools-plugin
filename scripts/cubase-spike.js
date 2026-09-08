// Phase 0 probe for the Cubase adapter - run it on a REAL track archive:
//
//   node scripts/cubase-spike.js path/to/export.xml      what is in it + round trip
//   node scripts/cubase-spike.js --midi [portName]       list MIDI ports, send LOCATE 0:01:00 + PLAY
//
// The archive probe prints every track and event with the raw values so a
// human can confirm the units and field names in schema.json, proves the
// byte-identical round trip, then makes one edit (trims the first audio
// event by 100 ms), writes <name>.fame-roundtrip.xml, re-reads it and
// checks nothing else moved. That file is what the editor imports back
// into Cubase to prove the lossless loop end to end.

"use strict";

const fs = require("fs");
const path = require("path");
const A = require("../hands/cubase/archive");
const X = require("../hands/cubase/xml");

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--midi") return midiProbe(args[1] || "");
  const file = args[0];
  if (!file) { console.error("usage: node scripts/cubase-spike.js <archive.xml> | --midi [port]"); process.exit(1); }
  const text = fs.readFileSync(file, "utf8");
  const a = A.parseArchive(text);
  console.log("file:      " + file + " (" + text.length + " bytes)");
  console.log("setup:     " + a.setup.sampleRate + " Hz, frame type " + a.setup.frameType + " = " + a.setup.fps + " fps" + (a.setup.dropFrame ? " drop" : "") + ", project start " + a.setup.startSec + " s, length " + a.setup.lengthSec.toFixed(2) + " s");
  console.log("tempo:     " + (a.tempo.length ? a.tempo.map(function (t) { return t.bpm + " bpm @" + t.ppq + (t.ramp ? " ramp" : ""); }).join(", ") : "none"));
  const unknown = Object.keys(a.unknownClasses);
  if (unknown.length) console.log("unknown track classes (add to schema.json if audio): " + unknown.join(", "));
  a.tracks.forEach(function (t) {
    console.log("\ntrack " + t.index + ": \"" + t.name + "\"  class " + t.cls + " (" + t.kind + ")  domain " + t.domain + "  events " + t.events.length + "  classes " + JSON.stringify(t.eventClasses));
    t.events.slice(0, 12).forEach(function (e) {
      const raw = { Start: X.value(e.node, "Start"), Length: X.value(e.node, "Length"), Offset: X.value(e.node, "Offset"), Flags: X.value(e.node, "Flags") };
      console.log("   " + e.cls + "  start " + e.start.toFixed(3) + "  end " + e.end.toFixed(3) + "  offset " + e.offset.toFixed(3) + (e.hasOffset ? "" : " (no Offset key)") + "  fadeIn " + e.fadeIn + "  fadeOut " + e.fadeOut + "  name \"" + e.name + "\"  path \"" + e.path + "\"  raw " + JSON.stringify(raw));
      // every string below the event, so the clip/file shape is visible
      const strings = [];
      X.walk(e.node, function (el) { if (el.tag === "string") strings.push(X.attr(el, "name") + "=" + JSON.stringify(X.attr(el, "value"))); });
      if (strings.length) console.log("      strings: " + strings.slice(0, 12).join("  "));
      const classes = [];
      X.walk(e.node, function (el) { const c = X.attr(el, "class"); if (c && classes.indexOf(c) < 0) classes.push(c); });
      if (classes.length) console.log("      nested classes: " + classes.join(", "));
    });
    if (t.events.length > 12) console.log("   ... " + (t.events.length - 12) + " more");
  });

  const out = A.serialize(a);
  console.log("\nround trip byte-identical: " + (out === text ? "YES" : "NO - first difference at " + firstDiff(out, text)));

  const audio = a.tracks.filter(function (t) { return t.kind === "audio" && t.events.some(function (e) { return e.kind === "audio"; }); });
  if (!audio.length) { console.log("no audio events to edit - export an audio track for the edit half of the spike."); return; }
  const t = audio[0];
  const ev = t.events.find(function (e) { return e.kind === "audio"; });
  const before = snapshot(a);
  const cut = { s: ev.start, e: ev.start + 0.1 };
  const res = A.rippleCut(a, [cut]);
  const outFile = file.replace(/\.xml$/i, "") + ".fame-roundtrip.xml";
  fs.writeFileSync(outFile, A.serialize(a));
  const b = A.parseArchive(fs.readFileSync(outFile, "utf8"));
  const after = snapshot(b);
  const diffs = [];
  Object.keys(before).forEach(function (k) { if (before[k] !== after[k]) diffs.push(k + ": " + before[k] + " -> " + after[k]); });
  console.log("edit: trimmed 100 ms off the head of \"" + ev.name + "\" on \"" + t.name + "\" (ripple) - " + res.applied + " cut, " + res.fades + " fade(s)" + (res.fadesSkipped ? ", " + res.fadesSkipped : ""));
  console.log("wrote " + outFile + " - import it in Cubase (File > Import > Track Archive) and compare with the original track.");
  console.log("fields that changed on re-read (expect only Start/Length/Offset on that track):");
  diffs.slice(0, 40).forEach(function (d) { console.log("   " + d); });
  if (diffs.length > 40) console.log("   ... " + (diffs.length - 40) + " more");
}

function snapshot(a) {
  const o = {};
  a.tracks.forEach(function (t) {
    o["track" + t.index + ".name"] = t.name;
    o["track" + t.index + ".events"] = t.events.length;
    t.events.forEach(function (e, i) {
      o["track" + t.index + ".ev" + i] = [e.cls, e.start.toFixed(6), e.length.toFixed(6), e.offset.toFixed(6), e.name, e.path].join("|");
    });
  });
  o.ids = A.idAllocator(a.root)();
  return o;
}

function firstDiff(x, y) {
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return "byte " + i + ": " + JSON.stringify(x.slice(Math.max(0, i - 30), i + 30)) + " vs " + JSON.stringify(y.slice(Math.max(0, i - 30), i + 30));
  return "?";
}

function midiProbe(portName) {
  const { MmcSender, locateMessage } = require("../hands/cubase/mmc");
  const s = new MmcSender({ portName });
  const ports = s.listPorts();
  console.log("MIDI outputs on this machine: " + (ports.length ? ports.join(", ") : "none"));
  const opened = s.open();
  console.log("sending on: " + opened);
  console.log("In Cubase: Transport > Project Synchronization Setup > Machine Control > MMC Slave Active, MMC Input = \"" + opened.replace(" (virtual)", "") + "\".");
  s.jump(60, true, 25, false);
  console.log("sent STOP, LOCATE 00:01:00:00 (" + locateMessage(60, 25, false).map(function (b) { return b.toString(16).padStart(2, "0"); }).join(" ") + "), DEFERRED PLAY - Cubase's cursor should sit at 1:00 and be playing.");
  setTimeout(function () { s.close(); }, 500);
}

main();
