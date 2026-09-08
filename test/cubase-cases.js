// Cubase adapter cases, run by test/run.js. Real Cubase exports (three
// from DAWFileKit, marker tracks at 48 kHz) prove the byte-identical
// round trip and the musical/linear time maths; the synthetic two-speaker
// archive (the ASSUMED audio-event shape, see hands/cubase/schema.json)
// exercises the edit arithmetic; MMC goes over real CoreMIDI when the
// module loads.

"use strict";

const path = require("path");
const fs = require("fs");
const assert = require("assert");
const core = require("../src/core/mapping");
const A = require("../hands/cubase/archive");
const X = require("../hands/cubase/xml");
const M = require("../hands/cubase/mmc");
const W = require("../hands/cubase/watcher");
const C = require("../hands/cubase/cutter");
const { CubaseHands } = require("../hands/cubase");
const { assertHands } = require("../hands/interface");
const { ffmpegPath, run } = require("../hands/common");

const FIX = path.join(__dirname, "fixtures", "cubase");
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0.002);
const hex = (m) => m.map((b) => b.toString(16).padStart(2, "0")).join(" ");
const synth = () => A.parseArchive(fs.readFileSync(path.join(FIX, "synthetic-two-speakers.xml"), "utf8"));

module.exports = async function cubaseCases(check, OUT, fixture) {
  console.log("cubase: track archive on REAL exports");
  ["BasicMarkers.xml", "MusicalAndLinearTest.xml", "RoundingTest.xml"].forEach((f) => {
    check("real export " + f + " round-trips byte-identical", () => {
      const t = fs.readFileSync(path.join(FIX, f), "utf8");
      const a = A.parseArchive(t);
      assert.strictEqual(A.serialize(a), t);
      assert(a.tracks.length >= 2 && a.setup.sampleRate === 48000, JSON.stringify(a.setup));
      assert(a.tracks.every((tr) => tr.name), a.tracks.map((tr) => tr.name).join(","));
    });
  });
  await check("musical (PPQ) positions agree with the linear twin track before the tempo ramp", () => {
    const a = A.parseArchive(fs.readFileSync(path.join(FIX, "MusicalAndLinearTest.xml"), "utf8"));
    const mus = a.tracks.find((t) => t.domain === "musical"), lin = a.tracks.find((t) => t.domain === "linear");
    for (let i = 0; i < 6; i++) assert(near(mus.events[i].start, lin.events[i].start, 0.005), i + ": " + mus.events[i].start + " vs " + lin.events[i].start);
    assert.strictEqual(a.setup.fps, 30);
  });
  await check("an untouched attribute keeps its raw tag; a changed one is re-emitted with the same attribute order", () => {
    const a = synth();
    const ev = a.tracks[0].events[0];
    const before = X.serialize(ev.node);
    X.setValue(ev.node, "Start", "3");
    const after = X.serialize(ev.node);
    assert(before.indexOf('<float name="Start" value="2"/>') >= 0 && after.indexOf('<float name="Start" value="3"/>') >= 0);
    assert.strictEqual(after.replace('value="3"', 'value="2"'), before);
  });

  console.log("cubase: edits on the synthetic two-speaker archive");
  await check("rippleCut: back-to-front, every audio track, offsets carried, later events pulled up, track lengths refreshed", () => {
    const a = synth();
    const r = A.rippleCut(a, [{ s: 1000, e: 1001 }, { s: 100, e: 100.5 }]);
    assert.strictEqual(r.applied, 2);
    assert.strictEqual(r.fades, 8, JSON.stringify(r)); // Denis 3 pieces -> 4 seam fades, Nathan 4, Music none at 100/1000 (bed ends at 60)
    const b = A.parseArchive(A.serialize(a));
    const d = b.tracks[0].events, n = b.tracks[1].events, m = b.tracks[2].events;
    assert.strictEqual(d.length, 3);
    assert(near(d[1].start, 100) && near(d[1].offset, 108.5) && near(d[2].start, 999.5) && near(d[2].offset, 1009) && near(d[2].end, 1498.5), JSON.stringify(d.map((e) => [e.start, e.end, e.offset])));
    assert(near(n[2].start, 999.5) && near(n[2].offset, 1001) && near(n[2].end, 1508.5));
    assert(near(m[1].start, 1398.5) && near(m[1].offset, 0));
    assert(near(Number(X.value(b.tracks[0].node, "Length")), 1498.5));
    assert.strictEqual(d[1].fadeIn, 0.01);
    assert.strictEqual(d[0].fadeOut, 0.01);
  });
  await check("every ID stays unique after splits and the plugin blob survives untouched", () => {
    const a = synth();
    A.rippleCut(a, [{ s: 30, e: 31 }]);
    const out = A.serialize(a);
    const ids = out.match(/ID="(\d+)"/g);
    assert.strictEqual(new Set(ids).size, ids.length, "duplicate IDs");
    assert(out.indexOf("<bin name=\"audioComponent\">46616246") >= 0);
  });
  await check("silence: gap on the named track only, no ripple, fades on both edges", () => {
    const a = synth();
    const r = A.silence(a, [{ tracks: [1], ranges: [{ s: 200, e: 200.4 }] }]);
    assert.strictEqual(r.silenced, 1);
    assert.strictEqual(r.tracks, 1);
    const b = A.parseArchive(A.serialize(a));
    const n = b.tracks[1].events;
    assert.strictEqual(n.length, 2, JSON.stringify(n.map((e) => [e.start, e.end])));
    assert(near(n[0].end, 200) && near(n[1].start, 200.4) && near(n[1].offset, 200.4) && near(n[1].end, 1510));
    assert.strictEqual(b.tracks[0].events.length, 1);
    assert(near(b.tracks[0].events[0].end, 1500));
    assert.strictEqual(n[0].fadeOut, 0.01);
    assert.strictEqual(n[1].fadeIn, 0.01);
  });
  await check("no fade data in the export: the cut lands and the result says what to do", () => {
    const text = fs.readFileSync(path.join(FIX, "synthetic-two-speakers.xml"), "utf8").replace(/ {24}<member name="Fade(In|Out)">[\s\S]*?<\/member>\n/g, "");
    const a = A.parseArchive(text);
    assert.strictEqual(a.tracks[0].events[0].fadeIn, 0);
    const r = A.rippleCut(a, [{ s: 50, e: 50.2 }]);
    assert.strictEqual(r.applied, 1);
    assert.strictEqual(r.fades, 0);
    assert(/short fade on one event/.test(r.fadesSkipped), r.fadesSkipped);
  });
  await check("audio parts and tempo ramps are refused with the one-click fix", () => {
    const a = synth();
    a.tracks[0].partCount = 1;
    assert.throws(() => A.rippleCut(a, [{ s: 1, e: 2 }]), /Dissolve Part/);
    const b = synth();
    b.tracks[1].domain = "musical"; b.tempo = [{ bpm: 120, ppq: 0, ramp: false }, { bpm: 90, ppq: 960, ramp: true }];
    assert.throws(() => A.silence(b, [{ tracks: [1], ranges: [{ s: 1, e: 2 }] }]), /Linear/);
  });
  await check("toClips feeds mapCandidate: DMS candidates land on the synthetic layout", () => {
    const clips = A.toClips(synth());
    assert.strictEqual(clips.length, 4);
    const dms = fixture("cleanup-dms-27-denis-vozian-b1fd7.json").state;
    let mapped = 0;
    dms.candidates.forEach((c) => { if (core.mapCandidate(c, clips)) mapped++; });
    assert(mapped > dms.candidates.length * 0.9, mapped + "/" + dms.candidates.length);
    assert.deepStrictEqual(core.tracksForSpeaker({ clips }, "nathan_taylor"), [1]);
  });

  console.log("cubase: MMC");
  await check("LOCATE carries the frame-rate code and h:m:s:f; PLAY/STOP are the universal bytes", () => {
    assert.strictEqual(hex(M.locateMessage(3723.48, 25, false)), "f0 7f 7f 06 44 06 01 21 02 03 0c 00 f7");
    assert.strictEqual(hex(M.locateMessage(0, 24, false)), "f0 7f 7f 06 44 06 01 00 00 00 00 00 f7");
    assert.strictEqual(M.locateMessage(1, 29.97, true)[7] >> 5, 2);
    assert.strictEqual(M.locateMessage(1, 30, false)[7] >> 5, 3);
    assert.strictEqual(hex(M.commandMessage(M.CMD.DEFERRED_PLAY)), "f0 7f 7f 06 03 f7");
    assert.strictEqual(hex(M.commandMessage(M.CMD.STOP)), "f0 7f 7f 06 01 f7");
  });
  const midi = M.loadMidi();
  if (midi && process.platform !== "win32") {
    await check("MMC crosses CoreMIDI: a stand-in Cubase input receives STOP, LOCATE, DEFERRED PLAY", async () => {
      const inp = new midi.Input();
      inp.ignoreTypes(false, false, false);
      const got = [];
      inp.on("message", (dt, m) => got.push(m));
      inp.openVirtualPort("Fame test Cubase");
      const s = new M.MmcSender({ portName: "Fame test Cubase" });
      s.jump(60, true, 25, false);
      await new Promise((r) => setTimeout(r, 250));
      s.close(); inp.closePort();
      assert.strictEqual(got.length, 3, JSON.stringify(got));
      assert.strictEqual(hex(got[1]), "f0 7f 7f 06 44 06 01 20 01 00 00 00 f7");
      assert.strictEqual(hex(got[2]), "f0 7f 7f 06 03 f7");
    });
    await check("the app's own virtual port 'Fame Plugin' is visible to other apps as a MIDI input", async () => {
      const s = new M.MmcSender({});
      assert(/virtual/.test(s.open()));
      const inp = new midi.Input();
      let idx = -1;
      for (let i = 0; i < inp.getPortCount(); i++) if (inp.getPortName(i) === M.VIRTUAL_NAME) idx = i;
      assert(idx >= 0, "not listed");
      inp.ignoreTypes(false, false, false);
      const got = [];
      inp.on("message", (dt, m) => got.push(m));
      inp.openPort(idx);
      s.locate(10, 30, false);
      await new Promise((r) => setTimeout(r, 250));
      s.close(); inp.closePort();
      assert.strictEqual(got.length, 1);
    });
  } else console.log("  skip MIDI transport cases (module missing or Windows)");

  console.log("cubase: files - watcher, cutter, adapter");
  const dir = path.join(OUT, "cubase-exchange");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tone = path.join(OUT, "cubase-tone.wav");
  await run(ffmpegPath(), ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=4", "-ac", "2", tone]);
  await check("cutter: kept segments and a cut file that is shorter by exactly the cuts", async () => {
    assert.deepStrictEqual(C.keptSegments(10, [{ s: 2, e: 3 }, { s: 1, e: 1.5 }, { s: 9.5, e: 12 }]), [{ s: 0, e: 1 }, { s: 1.5, e: 2 }, { s: 3, e: 9.5 }]);
    const out = path.join(OUT, "cubase-tone-cut.wav");
    const r = await C.cutFile(tone, out, 4, [{ s: 1, e: 1.5 }, { s: 3, e: 3.25 }]);
    assert.strictEqual(r.kept, 3);
    const m = await require("../hands/common").measure(out);
    assert(near(m.durationSec, 3.25, 0.05), "duration " + m.durationSec);
  });
  await check("watcher: resolves once a new file stops growing", async () => {
    const p = W.waitForNewFile(dir, W.AUDIO_EXT, { settleMs: 300, pollMs: 100, timeoutMs: 5000 });
    setTimeout(() => { fs.copyFileSync(tone, path.join(dir, "mixdown.wav")); }, 200);
    const f = await p;
    assert.strictEqual(f.name, "mixdown.wav");
    fs.unlinkSync(f.path);
  });
  await check("adapter: no folder = not connected, everything says to pick it", async () => {
    const h = assertHands(new CubaseHands({ settings: { exchangeDir: "" } }));
    const st = await h.status();
    assert(!st.connected && st.fileBased && st.dawLabel === "Cubase" && /exchange folder/.test(st.reason), JSON.stringify(st));
    await assert.rejects(() => h.getClips(), /exchange folder/);
  });
  const saved = [];
  const h = assertHands(new CubaseHands({ settings: { exchangeDir: dir }, save: (s) => saved.push(s) }));
  await check("adapter: empty folder = pending with the export instruction, never a throw", async () => {
    const info = await h.getClips();
    assert(info.pending && /Export > Selected Tracks/.test(info.next) && info.clips.length === 0, JSON.stringify(info));
    const st = await h.status();
    assert(st.connected && st.capabilities.readTimeline && st.setup.latestArchive === null);
  });
  await check("adapter: reads the newest archive, cut writes a '- Fame cut' file that is then the newest", async () => {
    fs.copyFileSync(path.join(FIX, "synthetic-two-speakers.xml"), path.join(dir, "DMS27 speakers.xml"));
    const info = await h.getClips();
    assert.strictEqual(info.clips.length, 4);
    assert.strictEqual(info.fps, 25);
    const r = await h.applyRippleCuts([{ s: 1000, e: 1001 }, { s: 100, e: 100.5 }]);
    assert(r.pending && r.applied === 2 && /Import > Track Archive/.test(r.next) && fs.existsSync(r.file), JSON.stringify(r));
    const after = await h.getClips();
    assert(/ - Fame cut /.test(after.archive), after.archive);
    const d = after.clips.filter((c) => /Denis/.test(c.trackName));
    assert.strictEqual(d.length, 3);
    assert(near(d[2].start, 999.5) && near(d[2].inPoint, 1009));
    assert.strictEqual(after.clips.filter((c) => /Music/.test(c.trackName)).length, 2); // marker/other tracks dropped, audio kept
  });
  await check("adapter: silence and gain each write their own archive; gain without a Volume field says 'set the fader'", async () => {
    const s = await h.silenceRanges([{ tracks: [1], ranges: [{ s: 200, e: 200.4 }] }]);
    assert(s.pending && s.silenced === 1 && /silenced/.test(path.basename(s.file)));
    const g = await h.setTrackGainDb([0], 4.5);
    assert(g.pending && /\+4\.5 dB/.test(g.next), g.next);
    const text = fs.readFileSync(path.join(FIX, "synthetic-two-speakers.xml"), "utf8").replace(/ {24}<float name="Volume" value="1"\/>\n/g, "");
    fs.writeFileSync(path.join(dir, "zz no volume.xml"), text);
    await new Promise((r) => setTimeout(r, 20));
    const g2 = await h.setTrackGainDb([0], -2);
    assert(g2.pending && /fader on Denis to -2\.0 dB/.test(g2.next), g2.next);
  });
  await check("adapter: jumpTo sends MMC at the archive's frame rate; configure persists", async () => {
    if (!midi || process.platform === "win32") return;
    await h.jumpTo(12, true);
    assert(h.mmc.sent.length >= 3 && /^f0 7f 7f 06 44 06 01 20 00 0c 00 00 f7$/.test(h.mmc.sent[h.mmc.sent.length - 2]), JSON.stringify(h.mmc.sent));
    await h.configure({ midiPort: "Nope" });
    assert.strictEqual(saved[saved.length - 1].midiPort, "Nope");
    await assert.rejects(() => h.jumpTo(1, false), /not there/);
    await h.configure({ midiPort: "" });
  });
  await check("adapter: render waits for the mixdown to land; measure reads it", async () => {
    const notes = [];
    h.on("note", (n) => notes.push(n));
    const p = h.render({ slug: "dms-27", timeoutMs: 5000 });
    setTimeout(() => { fs.copyFileSync(tone, path.join(dir, "DMS27 mixdown.wav")); }, 300);
    const r = await p;
    assert.strictEqual(path.basename(r.path), "DMS27 mixdown.wav");
    assert(notes.some((n) => /Audio Mixdown/.test(n)), JSON.stringify(notes));
    const m = await h.measure(r.path);
    assert(m.durationSec > 3.9 && m.lufs < 0 && m.channels === 2, JSON.stringify(m));
  });
  await check("adapter: assembly = one track per file, cuts baked into a clean file, template taken from the real export", async () => {
    const r = await h.buildAssembly([{ path: tone, name: "denis_vozian", cuts: [{ s: 1, e: 1.5 }] }, { path: tone, name: "nathan_taylor", gainDb: 3 }]);
    assert.strictEqual(r.added, 2);
    assert.deepStrictEqual(r.tracks, ["denis_vozian", "nathan_taylor"]);
    assert(r.pending && /\.xml$/.test(r.templateSource) && r.preparedFiles.length === 2 && r.preparedFiles[0] !== r.preparedFiles[1], JSON.stringify(r));
    const info = await h.getClips();
    assert.strictEqual(info.clips.length, 2);
    assert(near(info.clips[0].end, 3.5, 0.05) && /Fame clean/.test(info.clips[0].path), JSON.stringify(info.clips[0]));
    assert.strictEqual(info.clips[1].trackName, "nathan_taylor");
    const ids = fs.readFileSync(r.file, "utf8").match(/ID="(\d+)"/g);
    assert.strictEqual(new Set(ids).size, ids.length);
  });
  await check("adapter: diagnostics carries the archive summary, MMC bytes and the schema status", async () => {
    const d = await h.diagnostics();
    assert(d.status.connected && d.raw.archive && d.raw.mmcSent && /assumed/.test(d.status.setup.schema.event));
  });
  h.mmc.close();
};
