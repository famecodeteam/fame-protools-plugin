// hands/cubase - the Cubase adapter. Implements ../interface.js as a
// FILE-BASED integration, because Cubase has no scripting door to the
// arrangement (the MIDI Remote API is for controllers, the .cpr is binary,
// a VST cannot touch clips):
//
//   read timeline  = newest track archive (File > Export > Selected Tracks)
//                    in the exchange folder
//   jump + play    = MMC over a MIDI port (Cubase set to MMC Slave)
//   cut / silence  = the archive edited and written back as a new file the
//                    editor imports (File > Import > Track Archive); the
//                    original tracks are the undo
//   gain           = event volume in the archive, or into the file on a
//                    fresh assembly
//   render         = the editor runs Export Audio Mixdown into the exchange
//                    folder; the adapter waits for the file to settle
//   assembly       = a generated archive, one track per speaker, files
//                    optionally pre-cut and levelled with ffmpeg
//
// Every method that needs the editor to do something resolves with
// { pending: true, next: "one line" } - never a silent no-op.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");
const { CAPABILITIES } = require("../interface");
const { measure } = require("../common");
const A = require("./archive");
const X = require("./xml");
const W = require("./watcher");
const C = require("./cutter");
const { MmcSender, VIRTUAL_NAME } = require("./mmc");

const OUR_MARK = " - Fame ";      // files this adapter wrote carry it in the name
const DEFAULT_FPS = 25;

function stem(p) { return path.basename(p).replace(/\.[^.]+$/, ""); }
function stamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-"); }

class CubaseHands extends EventEmitter {
  // opts.settings: { exchangeDir, midiPort } ; opts.save(settings) persists
  constructor(opts) {
    super();
    opts = opts || {};
    this.daw = "cubase";
    this.settings = Object.assign({ exchangeDir: "", midiPort: "" }, opts.settings || {});
    this.save = opts.save || function () {};
    this.mmc = new MmcSender({ portName: this.settings.midiPort, midi: opts.midi });
    this.lastArchive = null;      // { file, archive, mtimeMs }
    this.raw = {};
    this.assemblyBase = 0;        // last assembly's mtime, so render ignores older audio
  }

  note(text) { this.emit("note", text); }

  // ----- setup -----

  async configure(patch) {
    if (patch && typeof patch.exchangeDir === "string") this.settings.exchangeDir = patch.exchangeDir;
    if (patch && typeof patch.midiPort === "string") {
      this.settings.midiPort = patch.midiPort;
      this.mmc.close();
      this.mmc.portName = patch.midiPort;
    }
    this.save(this.settings);
    return this.status();
  }

  _dir() { return this.settings.exchangeDir; }
  _needDir() {
    if (!this._dir()) throw new Error("Pick the Fame exchange folder first (Cubase setup, top of the app) - Cubase exports into it and the Plugin reads from it.");
    if (!fs.existsSync(this._dir())) throw new Error("The exchange folder is gone: " + this._dir() + " - pick it again in Cubase setup.");
    return this._dir();
  }

  _midiState() {
    let ports = [];
    try { ports = this.mmc.listPorts(); } catch (e) {}
    const virtual = this.mmc.canVirtual();
    const chosen = this.settings.midiPort;
    let ok, reason = "";
    if (chosen) { ok = ports.some(function (p) { return p === chosen || p.toLowerCase().indexOf(chosen.toLowerCase()) >= 0; }); if (!ok) reason = "MIDI port \"" + chosen + "\" is not there right now."; }
    else if (virtual) ok = !!this.mmc.midi;
    else { ok = false; reason = "Windows needs loopMIDI: install it, add a port, pick it here."; }
    if (!this.mmc.midi) { ok = false; reason = "The MIDI module did not load - reinstall the app."; }
    return { ports, virtual, chosen, ok, reason, sendingOn: chosen || (virtual ? VIRTUAL_NAME : "") };
  }

  async status() {
    const dir = this._dir();
    const dirOk = !!dir && fs.existsSync(dir);
    const midi = this._midiState();
    const latest = dirOk ? W.newest(dir, W.ARCHIVE_EXT) : null;
    const caps = {};
    CAPABILITIES.forEach(function (c) { caps[c] = true; });
    caps.jump = midi.ok;
    if (!dirOk) ["readTimeline", "rippleCut", "silence", "fades", "trackGain", "render", "assembly"].forEach(function (c) { caps[c] = false; });
    let reason = "";
    if (!dirOk) reason = "pick the Fame exchange folder";
    else if (!midi.ok) reason = midi.reason;
    return {
      connected: dirOk,
      fileBased: true,
      dawLabel: "Cubase",
      dawVersion: "",
      capabilities: caps,
      reason,
      setup: {
        exchangeDir: dir, exchangeDirOk: dirOk,
        midi,
        latestArchive: latest ? { name: latest.name, mtimeMs: latest.mtimeMs, ours: latest.name.indexOf(OUR_MARK) >= 0 } : null,
        schema: this._schemaStatus(),
      },
    };
  }

  _schemaStatus() {
    const s = A.SCHEMA;
    return { event: s.event.status, clip: s.clip.status, trackClasses: s.trackClasses.status };
  }

  // ----- reading -----

  _load(force) {
    const dir = this._needDir();
    const f = W.newest(dir, W.ARCHIVE_EXT);
    if (!f) return null;
    if (!force && this.lastArchive && this.lastArchive.file === f.path && this.lastArchive.mtimeMs === f.mtimeMs) return this.lastArchive;
    const archive = A.readFile(f.path);
    this.lastArchive = { file: f.path, archive, mtimeMs: f.mtimeMs, name: f.name };
    this.raw.archive = {
      file: f.name, setup: archive.setup, tempo: archive.tempo,
      tracks: archive.tracks.map(function (t) { return { name: t.name, cls: t.cls, kind: t.kind, domain: t.domain, events: t.events.length, eventClasses: t.eventClasses, partCount: t.partCount }; }),
      unknownClasses: archive.unknownClasses,
    };
    return this.lastArchive;
  }

  _pendingExport(dir) {
    return { pending: true, next: "In Cubase, select the speaker tracks, then File > Export > Selected Tracks and save the .xml into " + dir + " - then press Refresh.", file: dir };
  }

  async getClips() {
    const dir = this._needDir();
    const la = this._load();
    if (!la) return Object.assign(this._pendingExport(dir), { clips: [], tracks: 0, sampleRate: 48000, sessionName: "", sessionPath: dir, raw: this.raw });
    const a = la.archive;
    const clips = A.toClips(a);
    const audioTracks = a.tracks.filter(function (t) { return t.kind === "audio"; });
    const info = {
      clips, tracks: a.tracks.length, sampleRate: a.setup.sampleRate,
      sessionName: la.name.replace(/\.xml$/i, ""), sessionPath: dir, raw: this.raw,
      archive: la.name, archiveAt: la.mtimeMs, fps: a.setup.fps,
    };
    if (!audioTracks.length) {
      info.pending = true;
      info.next = "\"" + la.name + "\" holds no audio tracks (" + a.tracks.map(function (t) { return t.kind; }).join(", ") + "). Select the speaker tracks in Cubase and export again.";
    } else if (!clips.length) {
      info.pending = true;
      info.next = "\"" + la.name + "\" has audio tracks but no events the Plugin recognises (" + JSON.stringify(audioTracks[0].eventClasses) + ") - press Diagnostics and send it to Tom.";
    }
    return info;
  }

  // ----- transport -----

  _fps() {
    const la = this.lastArchive;
    return la ? { fps: la.archive.setup.fps, drop: la.archive.setup.dropFrame } : { fps: DEFAULT_FPS, drop: false };
  }

  async jumpTo(sec, play) {
    const m = this._midiState();
    if (!m.ok) throw new Error(m.reason || "No MIDI port for Cubase - see Cubase setup at the top of the app.");
    const { fps, drop } = this._fps();
    this.mmc.jump(sec, play, fps, drop);
  }

  // ----- editing: the archive round trip -----

  _writeArchive(la, suffix) {
    const dir = this._needDir();
    const base = stem(la.file).replace(/ - Fame .*$/, "");
    const name = base + OUR_MARK + suffix + " " + stamp() + ".xml";
    const out = path.join(dir, name);
    fs.writeFileSync(out, A.serialize(la.archive));
    return out;
  }
  _importNext(file, what) {
    return "In Cubase: File > Import > Track Archive, choose \"" + path.basename(file) + "\". The " + what + " tracks land under your originals - mute or delete the originals when you are happy. Undo = keep the originals.";
  }

  async applyRippleCuts(ranges) {
    if (!ranges.length) return { applied: 0, fades: 0 };
    const la = this._load(true);
    if (!la) throw new Error(this._pendingExport(this._needDir()).next);
    const a = la.archive;
    const r = A.rippleCut(a, ranges);
    const audioIdx = a.tracks.filter(function (t) { return t.kind === "audio"; }).map(function (t) { return t.index; });
    A.keepTracks(a, audioIdx);
    a.tracks.forEach(function (t) { A.renameTrack(t, t.name.replace(/ - Fame .*$/, "") + " - Fame cut"); });
    const file = this._writeArchive(la, "cut");
    this.lastArchive = null;
    const out = { applied: r.applied, fades: r.fades, pending: true, file, next: this._importNext(file, "cut") };
    if (r.fadesSkipped) out.fadesSkipped = r.fadesSkipped;
    return out;
  }

  async silenceRanges(specs) {
    const la = this._load(true);
    if (!la) throw new Error(this._pendingExport(this._needDir()).next);
    const a = la.archive;
    const r = A.silence(a, specs);
    const audioIdx = a.tracks.filter(function (t) { return t.kind === "audio"; }).map(function (t) { return t.index; });
    A.keepTracks(a, audioIdx);
    a.tracks.forEach(function (t) { A.renameTrack(t, t.name.replace(/ - Fame .*$/, "") + " - Fame silenced"); });
    const file = this._writeArchive(la, "silenced");
    this.lastArchive = null;
    const out = { silenced: r.silenced, tracks: r.tracks, pending: true, file, next: this._importNext(file, "silenced") };
    if (r.fadesSkipped) out.fadesSkipped = r.fadesSkipped;
    return out;
  }

  // Gain: the archive's per-event Volume (a linear factor) when the export
  // carries one; otherwise the fader instruction with the exact number.
  async setTrackGainDb(trackIdx, dB) {
    const la = this._load(true);
    if (!la) throw new Error(this._pendingExport(this._needDir()).next);
    const a = la.archive;
    const tracks = a.tracks.filter(function (t) { return t.kind === "audio" && trackIdx.indexOf(t.index) >= 0; });
    if (!tracks.length) throw new Error("Could not find those tracks in the latest export - export again and Refresh.");
    const factor = Math.pow(10, dB / 20);
    let written = 0;
    tracks.forEach(function (t) {
      t.events.forEach(function (ev) {
        const cur = X.num(ev.node, A.SCHEMA.event.volume, null);
        if (cur == null) return;
        X.setValue(ev.node, A.SCHEMA.event.volume, A.fmt(cur * factor));
        written++;
      });
    });
    const names = tracks.map(function (t) { return t.name; }).join(", ");
    const label = (dB > 0 ? "+" : "") + dB.toFixed(1) + " dB";
    if (!written) {
      return { tracks: tracks.length, pending: true, next: "This export carries no event volume the Plugin can set. In Cubase, set the fader on " + names + " to " + label + " (MixConsole), or use Build audio assembly, which bakes the level into the file." };
    }
    A.keepTracks(a, tracks.map(function (t) { return t.index; }));
    a.tracks.forEach(function (t) { A.renameTrack(t, t.name.replace(/ - Fame .*$/, "") + " - Fame levelled"); });
    const file = this._writeArchive(la, "levelled");
    this.lastArchive = null;
    return { tracks: tracks.length, pending: true, file, next: this._importNext(file, "levelled") + " (" + label + " written as event volume on " + written + " event(s).)" };
  }

  // ----- assembly -----

  _audioTrackTemplate() {
    // A real audio track from the newest export beats the shipped template.
    const dir = this._dir();
    if (dir && fs.existsSync(dir)) {
      const files = W.listFiles(dir, W.ARCHIVE_EXT).filter(function (f) { return f.name.indexOf(OUR_MARK) < 0; });
      for (const f of files) {
        try {
          const a = A.readFile(f.path);
          const t = a.tracks.find(function (x) { return x.kind === "audio" && x.events.some(function (e) { return e.kind === "audio"; }); });
          if (t) return { archive: a, track: t, source: f.name };
        } catch (e) { /* not an archive */ }
      }
    }
    const a = A.parseArchive(fs.readFileSync(path.join(__dirname, "templates", "audio-track.xml"), "utf8"));
    return { archive: a, track: a.tracks[0], source: "built-in template (unverified shape - the first real export replaces it)" };
  }

  // files: [{path, name, cuts?: [{s,e}] (file seconds), gainDb?}]
  async buildAssembly(files, opts) {
    opts = opts || {};
    const dir = this._needDir();
    if (!files.length) return { added: 0, tracks: [] };
    const tpl = this._audioTrackTemplate();
    const base = tpl.archive;
    // Keep the setup block, drop every track, then add one clone per file.
    A.keepTracks(base, []);
    const nextId = A.idAllocator(base.root);
    const made = [], prepared = [], sources = [];
    const outDir = path.join(dir, "Fame assembly " + stamp());
    // 1. prepare the files (cuts / gain baked in with ffmpeg when asked)
    for (const f of files) {
      let src = f.path;
      const m = await measure(src).catch(function () { return null; });
      const durationSec = m && m.durationSec ? m.durationSec : 0;
      if ((f.cuts && f.cuts.length) || f.gainDb) {
        if (!durationSec) throw new Error("Could not read the length of " + path.basename(src) + " - is it an audio file?");
        // named after the speaker too - two speakers may share one source file
        const out = path.join(outDir, stem(src) + (f.name ? " (" + String(f.name).replace(/[\\/:*?"<>|]/g, "-") + ")" : "") + " - Fame clean.wav");
        this.note("Cutting " + path.basename(src) + "…");
        if (f.cuts && f.cuts.length) await C.cutFile(src, out, durationSec, f.cuts, { gainDb: f.gainDb || 0 });
        else await C.gainFile(src, out, f.gainDb);
        src = out;
        prepared.push(out);
      }
      const m2 = src !== f.path ? await measure(src).catch(function () { return m; }) : m;
      sources.push({ src, len: (m2 && m2.durationSec) || durationSec || 1, name: f.name || stem(f.path) });
    }
    // 2. one cloned track node per file, then re-read the whole document
    //    once so the edit helpers see the new tracks
    sources.forEach(function () {
      const node = X.clone(tpl.track.node);
      A.reassignIds(node, nextId);
      const last = X.elems(base.list).slice(-1)[0];
      if (last) X.insertAfter(base.list, last, node);
      else { base.list.children.push({ type: "text", raw: "\n        " }); base.list.children.push(node); base.list.children.push({ type: "text", raw: "\n    " }); }
    });
    const doc = A.parseArchive(A.serialize(base));
    doc.tracks.forEach(function (t, i) {
      const s = sources[i];
      A.renameTrack(t, s.name);
      const ev = t.events.find(function (e) { return e.kind === "audio"; });
      t.events.filter(function (e) { return e !== ev; }).forEach(function (e) { X.remove(t.eventsList, e.node); });
      t.events = ev ? [ev] : [];
      if (!ev) return;
      X.walk(ev.node, function (el) {
        if (el.tag !== "string") return;
        const n = X.attr(el, "name");
        if (n === A.SCHEMA.event.name) X.setAttr(el, "value", stem(s.src));
        if (A.SCHEMA.clip.pathKeys.indexOf(n) >= 0 || /\.(wav|aif|aiff|flac|mp3|m4a)$/i.test(X.attr(el, "value") || "")) X.setAttr(el, "value", s.src);
      });
      const fo = X.byName(ev.node, A.SCHEMA.event.fadeOut, "member"); if (fo) X.setValue(fo, A.SCHEMA.event.fadeLength, "0");
      const fi = X.byName(ev.node, A.SCHEMA.event.fadeIn, "member"); if (fi) X.setValue(fi, A.SCHEMA.event.fadeLength, "0");
      X.setValue(ev.node, A.SCHEMA.event.start, "0");
      X.setValue(ev.node, A.SCHEMA.event.length, A.fmt(s.len));
      X.setValue(ev.node, A.SCHEMA.event.offset, "0");
      X.setValue(t.node, A.SCHEMA.event.length, A.fmt(s.len));
      X.setValue(t.node, A.SCHEMA.event.start, "0");
      made.push(s.name);
    });
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, "Fame assembly" + OUR_MARK + "layout " + stamp() + ".xml");
    fs.writeFileSync(out, A.serialize(doc));
    this.lastArchive = null;
    this.assemblyBase = Date.now();
    return {
      added: made.length, tracks: made, pending: true, file: out, templateSource: tpl.source, preparedFiles: prepared,
      next: "In Cubase: File > Import > Track Archive, choose \"" + path.basename(out) + "\" - one track per speaker, files from " + (prepared.length ? outDir : path.dirname(files[0].path)) + ".",
    };
  }

  // ----- render + measure -----

  // The editor exports; we wait for the file to land and settle.
  async render(opts) {
    opts = opts || {};
    const dir = this._needDir();
    const since = Date.now();
    this.note("In Cubase: File > Export > Audio Mixdown - MP3 320 kbps (or WAV), save into " + dir + ". The Plugin picks it up the moment the file finishes writing.");
    const f = await W.waitForNewFile(dir, W.AUDIO_EXT, { sinceMs: since, timeoutMs: opts.timeoutMs || 45 * 60 * 1000, filter: function (x) { return x.name.indexOf(" - Fame clean") < 0; } });
    return { path: f.path };
  }

  measure(file, opts) { return measure(file, opts); }

  async diagnostics() {
    const st = await this.status();
    let clips = null, error = null;
    if (st.connected) {
      try { clips = await this.getClips(); } catch (e) { error = e.message; }
    }
    return { status: st, clips, error, raw: Object.assign({}, this.raw, { mmcSent: this.mmc.sent, mmcPort: this.mmc.opened, platform: process.platform, settings: this.settings }) };
  }
}

module.exports = { CubaseHands, OUR_MARK };
