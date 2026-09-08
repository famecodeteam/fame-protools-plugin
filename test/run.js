// `npm test` - the mapping rules against the real server fixtures, the
// Pro Tools adapter against the mock PTSL server over real gRPC, and the
// Cubase adapter against real track-archive exports + a folder + CoreMIDI
// (test/cubase-cases.js). No DAW, no network. Lives in the repo on purpose (two harnesses were lost
// to /tmp cleanup on the Premiere build).
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const core = require("../src/core/mapping");
const { MockSession, startMockServer } = require("./mock-ptsl-server");
const { ProToolsHands } = require("../hands/protools");
const { assertHands } = require("../hands/interface");

const FIX = path.join(__dirname, "fixtures");
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), "utf8"));

let passed = 0, failed = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); });
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0.002);

async function main() {
  console.log("mapping rules");
  const dms = fixture("cleanup-dms-27-denis-vozian-b1fd7.json").state;
  const cands = dms.candidates;
  const denisFile = dms.files[0].name, nathanFile = dms.files[1].name;
  // A realistic AE layout: each speaker's WAV on its own track, Denis's
  // clip trimmed by 10 s at the head and moved to 2 s, a second Denis
  // track (processed dub) and a music bed nobody should ever match.
  const clips = [
    { id: "a", track: 0, trackName: "Denis", name: "riverside_denis_vozian_raw-audio-01", path: "/raw/" + denisFile, type: "audio", start: 2, end: 1500, inPoint: 10, outPoint: 1508, rate: 1, muted: false },
    { id: "b", track: 1, trackName: "Denis dub", name: "denis_master_v2", path: "/raw/denis_master_v2.wav", type: "audio", start: 2, end: 1500, inPoint: 10, outPoint: 1508, rate: 1, muted: false },
    { id: "c", track: 2, trackName: "Nathan", name: "riverside_nathan_taylor_raw-audio-01", path: "/raw/" + nathanFile, type: "audio", start: 0, end: 1510, inPoint: 0, outPoint: 1510, rate: 1, muted: false },
    { id: "d", track: 3, trackName: "Music", name: "bed", path: "/music/bed.wav", type: "audio", start: 0, end: 60, inPoint: 0, outPoint: 60, rate: 1, muted: false },
  ];
  await check("exact file match maps through the trim + offset", () => {
    const c = cands.find((x) => x.speaker === "nathan_taylor" && x.kind === "filler");
    const m = core.mapCandidate(c, clips);
    assert(m && near(m.s, c.startSec) && m.track === 2, JSON.stringify(m));
  });
  await check("a candidate before the trimmed head is not on the timeline", () => {
    const c = cands.find((x) => x.speaker === "denis_vozian" && x.startSec < 9.9);
    assert(c, "fixture has an early Denis candidate");
    assert.strictEqual(core.mapCandidate(c, clips), null);
  });
  await check("whole-inside rule: a 50 ms click maps (Reaper rule, not the Premiere 30 ms cut-off)", () => {
    const m = core.mapCandidate({ speaker: "denis_vozian", file: denisFile, startSec: 100, endSec: 100.03 }, clips);
    assert(m && near(m.s, 92) && near(m.e, 92.03), JSON.stringify(m));
  });
  await check("a sliver at a clip edge is refused", () => {
    assert.strictEqual(core.mapCandidate({ speaker: "denis_vozian", file: denisFile, startSec: 9.99, endSec: 10.01 }, clips), null);
  });
  await check("speaker-name fallback finds a renamed master", () => {
    const m = core.mapCandidate({ speaker: "denis_vozian", file: "gone.wav", startSec: 100, endSec: 101 }, [clips[1], clips[3]]);
    assert(m && m.track === 1, JSON.stringify(m));
  });
  await check("a music bed never matches a nameless candidate", () => {
    assert.strictEqual(core.mapCandidate({ speaker: null, file: "", startSec: 10, endSec: 11 }, [clips[3]]), null);
  });
  await check("nameless candidate falls back to a long clip whose source holds the moment", () => {
    const m = core.mapCandidate({ speaker: null, file: "", startSec: 500, endSec: 501 }, [clips[3], clips[2]]);
    assert(m && m.track === 2 && near(m.s, 500), JSON.stringify(m));
  });
  await check("selectedRanges merges within 120 ms and returns back-to-front", () => {
    const list = [
      { _idx: 0, _seq: { s: 10, e: 10.5 } }, { _idx: 1, _seq: { s: 10.6, e: 11 } },
      { _idx: 2, _seq: { s: 30, e: 31 } }, { _idx: 3, _seq: { s: 20, e: 21 } }, { _idx: 4, _seq: null },
    ];
    const r = core.selectedRanges(list, { 0: true, 1: true, 2: true, 3: true, 4: true });
    assert.deepStrictEqual(r, [{ s: 30, e: 31 }, { s: 20, e: 21 }, { s: 10, e: 11 }]);
  });
  await check("tracksForSpeaker returns ALL of a speaker's tracks, never the bed", () => {
    assert.deepStrictEqual(core.tracksForSpeaker({ clips }, "denis_vozian"), [0, 1]);
    assert.deepStrictEqual(core.tracksForSpeaker({ clips }, "nathan_taylor"), [2]);
  });
  await check("real fixture: most DMS candidates land on this layout", () => {
    let mapped = 0;
    cands.forEach((c) => { if (core.mapCandidate(c, clips)) mapped++; });
    assert(mapped > cands.length * 0.9, mapped + "/" + cands.length);
  });
  await check("sourceAnchor inverts a timeline moment through the clip under it", () => {
    assert(near(core.sourceAnchor(100, clips), 108));
    assert.strictEqual(core.sourceAnchor(5000, clips), null);
  });
  await check("RAN 480 fixture: hand-named masters map by speaker name", () => {
    const st = fixture("cleanup-ran-480-kelley-simoneaux-5bdf0.json").state;
    const ranClips = st.files.map((f, i) => ({ id: String(i), track: i, trackName: f.speaker || f.name, name: f.name.replace(/\.[^.]+$/, ""), path: "/raw/" + f.name, type: "audio", start: 0, end: 4000, inPoint: 0, outPoint: 4000, rate: 1, muted: false }));
    let mapped = 0;
    st.candidates.forEach((c) => { if (core.mapCandidate(c, ranClips)) mapped++; });
    assert(mapped > st.candidates.length * 0.9, mapped + "/" + st.candidates.length);
  });
  await check("RAN 479 solocast fixture (audio from video) still maps", () => {
    const st = fixture("cleanup-ran-479-solocast-chris-answers-reddit-57491.json").state;
    const c = st.candidates[0];
    const clip = { id: "v", track: 0, trackName: "Chris", name: st.files[0].name, path: "/raw/" + st.files[0].name, type: "audio", start: 0, end: 4000, inPoint: 0, outPoint: 4000, rate: 1, muted: false };
    assert(core.mapCandidate(c, [clip]));
  });

  await check("track name maps a speaker when the clip carries no usable name", () => {
    // Pro Tools names a consolidated clip "Audio 1_01"; the AE names the
    // TRACK after the person. That was the first field report's layout.
    const ptClips = [
      { id: "1", track: 0, trackName: "Joshua Spanier", name: "Audio 1_01", path: "", type: "audio", start: 0, end: 1500, inPoint: 0, outPoint: 1500, rate: 1, muted: false },
      { id: "2", track: 1, trackName: "Jason Hemingway", name: "Audio 2_01", path: "", type: "audio", start: 0, end: 1500, inPoint: 0, outPoint: 1500, rate: 1, muted: false },
    ];
    const m = core.mapCandidate({ speaker: "joshua_spanier", file: "joshua.wav", startSec: 500, endSec: 500.4 }, ptClips);
    assert(m && m.track === 0 && near(m.s, 500), JSON.stringify(m));
    const m2 = core.mapCandidate({ speaker: "jason_hemingway", file: "jason.wav", startSec: 500, endSec: 500.4 }, ptClips);
    assert(m2 && m2.track === 1, JSON.stringify(m2));
  });
  await check("unmappedReason says what was read, not just 'not on timeline'", () => {
    const info = { clips: [{ track: 0, trackName: "Music", name: "sting", path: "/m/sting.wav", start: 0, end: 5, inPoint: 0, outPoint: 5 }], trackNames: ["Music"], readErrors: [], noDefinition: 0 };
    const why = core.unmappedReason(info, [{ speaker: "joshua_spanier" }], "Pro Tools");
    assert(/Read 1 clip/.test(why) && /Music/.test(why) && /joshua_spanier/.test(why) && /Diagnostics/.test(why), why);
  });
  await check("unmappedReason names the read failure when no clips came back", () => {
    const why = core.unmappedReason({ clips: [], readErrors: ["V1: Pro Tools refused GetPlaylistElements."], trackNames: ["V1"] }, [], "Pro Tools");
    assert(/would not report the clips/.test(why) && /GetPlaylistElements/.test(why), why);
  });

  console.log("pro tools adapter against the mock PTSL server");
  const raw = path.join(OUT, "raw");
  fs.mkdirSync(raw, { recursive: true });
  const session = new MockSession({ folder: path.join(OUT, "session") });
  const fDenis = session.addFile(path.join(raw, denisFile));
  const fNathan = session.addFile(path.join(raw, nathanFile));
  const fBed = session.addFile(path.join(raw, "bed.wav"));
  session.addTrack("Denis", [{ start: 2, end: 1500, fileId: fDenis, srcStart: 10 }]);
  session.addTrack("Nathan", [{ start: 0, end: 1510, fileId: fNathan, srcStart: 0 }]);
  session.addTrack("Music", [{ start: 0, end: 60, fileId: fBed, srcStart: 0 }, { start: 1400, end: 1510, fileId: fBed, srcStart: 0 }]);
  const srv = await startMockServer(session);
  const hands = assertHands(new ProToolsHands({ address: "127.0.0.1:" + srv.port, timeoutMs: 5000 }));

  await check("status: connects, registers, reads the version, all capabilities on", async () => {
    const st = await hands.status();
    assert(st.connected && st.dawVersion === "2025.10", JSON.stringify(st));
    assert(st.capabilities.readTimeline && st.capabilities.rippleCut && st.capabilities.trackGain);
    assert(session.log.indexOf("RegisterConnection") >= 0 && session.log.indexOf("GetPTSLVersion") >= 0);
  });
  await check("the mock refuses two selectors exactly as Pro Tools 2026.0 does", async () => {
    // Proof the guard below is real, not decoration: this is the verbatim
    // refusal that made every cleanup row read "not on timeline".
    await assert.rejects(
      () => hands.client.send("GetTrackPlaylists", { track_id: session.tracks[0].id, track_name: session.tracks[0].name }),
      /Only one of 'track_id' and 'track_name' must be defined/,
    );
  });
  await check("a track that reports no clips costs neither a round trip nor an error line", async () => {
    const empty = session.addTrack("Prev Eps", []);
    empty.hasNoClips = true;
    const before = session.log.filter((c) => c === "GetTrackPlaylists").length;
    const info = await hands.getClips();
    const after = session.log.filter((c) => c === "GetTrackPlaylists").length;
    assert.deepStrictEqual(info.readErrors, [], JSON.stringify(info.readErrors));
    assert(after - before <= session.tracks.length - 1, "asked about the empty track anyway");
    session.tracks.pop();
  });

  await check("getClips joins playlist elements, clip definitions and file paths", async () => {
    const info = await hands.getClips();
    assert.strictEqual(info.sampleRate, 48000);
    assert.strictEqual(info.sessionPath, path.join(OUT, "session"));
    assert.strictEqual(info.clips.length, 4);
    const d = info.clips.find((c) => c.trackName === "Denis");
    assert(near(d.start, 2) && near(d.end, 1500) && near(d.inPoint, 10) && near(d.outPoint, 1508), JSON.stringify(d));
    assert.strictEqual(path.basename(d.path), denisFile);
    assert(d.name.indexOf("riverside_denis_vozian") === 0);
  });
  await check("reads the timeline through the public text export when the private API is refused", async () => {
    // Karthik's real install: GetTrackPlaylists answers "Private API has
    // not been enabled in this session." Every other test in this file
    // runs through this same fallback, because the mock refuses by
    // default - which is how an editor's Pro Tools actually behaves.
    const info = await hands.getClips();
    assert.strictEqual(info.raw.readVia, "session text export", info.raw.readVia);
    assert.deepStrictEqual(info.readErrors, [], JSON.stringify(info.readErrors));
    assert(info.clips.length >= 4, info.clips.length + " clips");
    assert(info.raw.sessionTextBytes > 200, "no session text came back");
  });
  await check("uses the playlist route instead when the private API is granted", async () => {
    const granted = new MockSession({ folder: path.join(OUT, "granted"), privateApi: true });
    const f1 = granted.addFile(path.join(raw, denisFile));
    granted.addTrack("Denis", [{ start: 2, end: 1500, fileId: f1, srcStart: 10 }]);
    const s2 = await startMockServer(granted);
    const h2 = new ProToolsHands({ address: "127.0.0.1:" + s2.port, timeoutMs: 5000 });
    const info = await h2.getClips();
    assert.strictEqual(info.raw.readVia, "playlist elements", info.raw.readVia);
    const c = info.clips[0];
    assert(near(c.start, 2) && near(c.inPoint, 10), JSON.stringify(c));
    s2.close();
  });
  await check("both routes describe the same clip", async () => {
    // The fallback must not quietly disagree with the private route about
    // where a clip sits or which part of the file it plays.
    const granted = new MockSession({ folder: path.join(OUT, "cmp"), privateApi: true });
    const refused = new MockSession({ folder: path.join(OUT, "cmp") });
    for (const sess of [granted, refused]) {
      const fid = sess.addFile(path.join(raw, denisFile));
      sess.addTrack("Denis", [{ start: 2, end: 1500, fileId: fid, srcStart: 10 }, { start: 1600, end: 1700, fileId: fid, srcStart: 2000, muted: true }]);
    }
    const sa = await startMockServer(granted), sb = await startMockServer(refused);
    const via = async (srv) => {
      const h = new ProToolsHands({ address: "127.0.0.1:" + srv.port, timeoutMs: 5000 });
      const i = await h.getClips();
      return i.clips.map((c) => [c.trackName, c.name, c.start.toFixed(3), c.end.toFixed(3), c.inPoint.toFixed(3), c.outPoint.toFixed(3), c.muted, path.basename(c.path)]);
    };
    assert.deepStrictEqual(await via(sb), await via(sa));
    sa.close(); sb.close();
  });

  await check("mapCandidate over the adapter's clips lands the Nathan filler", async () => {
    const info = await hands.getClips();
    const c = cands.find((x) => x.speaker === "nathan_taylor" && x.kind === "filler");
    const m = core.mapCandidate(c, info.clips);
    assert(m && near(m.s, c.startSec), JSON.stringify(m));
  });
  await check("jumpTo sets the selection at the moment and starts playing", async () => {
    await hands.jumpTo(123.5, true);
    assert.strictEqual(session.selection.in, Math.round(123.5 * 48000));
    assert.strictEqual(session.playing, true);
    await hands.jumpTo(10, true); // playing already: stop, move, play
    assert.strictEqual(session.playing, true);
    assert.strictEqual(session.selection.in, 480000);
  });
  await check("applyRippleCuts: back-to-front, every track, later clips move up, fades on seams, state restored", async () => {
    session.editMode = "EMode_Slip";
    session.tracks[1].selected = true; // the editor had Nathan selected
    session.selection = { in: 48000, out: 96000 };
    const r = await hands.applyRippleCuts([{ s: 1000, e: 1001 }, { s: 100, e: 100.5 }]);
    assert.strictEqual(r.applied, 2);
    assert.strictEqual(r.fades, 2, JSON.stringify(r));
    const v = session.view();
    const denis = v[0].elements;
    // Denis: [2,1500) src 10 -> cut 100-100.5 and 1000-1001 -> three pieces, total 1.5 s shorter
    assert.strictEqual(denis.length, 3, JSON.stringify(denis));
    assert(near(denis[1].start, 100) && near(denis[1].srcStart, 108.5), JSON.stringify(denis[1]));
    assert(near(denis[2].start, 999.5) && near(denis[2].srcStart, 1009), JSON.stringify(denis[2]));
    assert(near(denis[2].end, 1498.5));
    // Music bed at 1400 moved up by 1.5 s too (ripple touches every track)
    const bed2 = v[2].elements[1];
    assert(near(bed2.start, 1398.5), JSON.stringify(bed2));
    assert.strictEqual(session.editMode, "EMode_Slip");
    assert.strictEqual(session.options.link_timeline_and_edit_selection, false);
    assert.deepStrictEqual(v.map((t) => t.selected), [false, true, false]);
    assert.deepStrictEqual(session.selection, { in: 48000, out: 96000 });
    assert(session.log.indexOf("SetEditMode") >= 0);
    // Shuffle was set before the first Clear and restored after
    const first = session.log.indexOf("Clear");
    assert(session.log.slice(0, first).indexOf("SetEditMode") >= 0);
  });
  await check("silenceRanges: only the speaker's tracks get a gap, timeline length unchanged", async () => {
    const before = session.view();
    const r = await hands.silenceRanges([{ tracks: [1], ranges: [{ s: 200, e: 200.4 }] }]);
    assert.strictEqual(r.silenced, 1);
    assert.strictEqual(r.tracks, 1);
    const v = session.view();
    assert.strictEqual(v[1].elements.length, before[1].elements.length + 1);
    const left = v[1].elements.find((e) => near(e.end, 200));
    const right = v[1].elements.find((e) => near(e.start, 200.4));
    assert(left && right && near(right.srcStart, left.srcStart + (left.end - left.start) + 0.4), JSON.stringify(v[1].elements));
    assert(near(v[1].elements[v[1].elements.length - 1].end, before[1].elements[before[1].elements.length - 1].end)); // no ripple
    assert.deepStrictEqual(v[0].elements, before[0].elements); // Denis untouched
    assert(session.fades.some((f) => f.track === "Nathan" && near(f.at, 200)) && session.fades.some((f) => f.track === "Nathan" && near(f.at, 200.4)));
  });
  await check("fades missing preset: cut still lands and the result says why", async () => {
    session.fadePresets = [];
    const r = await hands.applyRippleCuts([{ s: 50, e: 50.2 }]);
    assert.strictEqual(r.applied, 1);
    assert.strictEqual(r.fades, 0);
    assert(/Fame 10ms/.test(r.fadesSkipped), r.fadesSkipped);
    session.fadePresets = ["Fame 10ms"];
  });
  await check("setTrackGainDb shifts existing breakpoints and writes a flat line otherwise", async () => {
    session.tracks[1].breakpoints = [{ time: { location: "0", time_type: "TLType_Samples" }, value: -3 }, { time: { location: "480000", time_type: "TLType_Samples" }, value: 0 }];
    const r = await hands.setTrackGainDb([0, 1], 4.5);
    assert.strictEqual(r.tracks, 2);
    assert(/0 dB position on 1 track/.test(r.note), r.note);
    const v = session.view();
    assert.deepStrictEqual(v[1].breakpoints.map((b) => b.v), [1.5, 4.5]);
    assert.strictEqual(v[0].breakpoints.length, 2);
    assert.strictEqual(v[0].breakpoints[0].v, 4.5);
  });
  await check("buildAssembly imports one track per file at 0 and names it after the speaker", async () => {
    const r = await hands.buildAssembly([{ path: path.join(raw, denisFile), name: "denis_vozian" }, { path: path.join(raw, nathanFile), name: "nathan_taylor" }]);
    assert.strictEqual(r.added, 2);
    assert.deepStrictEqual(r.tracks, ["denis_vozian", "nathan_taylor"]);
    const v = session.view();
    assert(v.some((t) => t.name === "denis_vozian" && near(t.elements[0].start, 0)));
  });
  await check("render bounces MP3 320 into 'Fame renders' beside the session; measure reads LUFS + true peak", async () => {
    const r = await hands.render({ slug: "dms-27-denis-vozian-b1fd7" });
    assert(fs.existsSync(r.path), r.path);
    assert(r.path.indexOf(path.join(OUT, "session", "Fame renders")) === 0, r.path);
    const body = session.exports[0].body;
    assert.strictEqual(body.file_type, "EMFType_MP3");
    assert.strictEqual(body.audio_encoding_options.encoding_options_mp3.bit_rate, "MP3EOCBRate_320kbps");
    assert.strictEqual(body.offline_bounce, "TB_True");
    const m = await hands.measure(r.path);
    assert(m.durationSec > 2.5 && m.durationSec < 3.5, JSON.stringify(m));
    assert.strictEqual(m.channels, 2);
    // A steady 1 kHz sine: integrated loudness sits within a few dB of its true peak.
    assert(isFinite(m.lufs) && m.lufs < 0 && m.lufs > -60, "lufs " + m.lufs);
    assert(isFinite(m.truePeakDb) && Math.abs(m.truePeakDb - m.lufs) < 6, "tp " + m.truePeakDb + " vs " + m.lufs);
  });
  await check("diagnostics carries the raw answers", async () => {
    const d = await hands.diagnostics();
    assert(d.status.connected && d.clips && d.raw.trackList && d.raw.clipList);
  });
  srv.close();

  await check("an older Pro Tools keeps comments + jump but hides the timeline features", async () => {
    const old = new MockSession({ version: { major: 2024, minor: 10, revision: 0 } });
    old.addTrack("A", []);
    const s2 = await startMockServer(old);
    const h2 = new ProToolsHands({ address: "127.0.0.1:" + s2.port, timeoutMs: 5000 });
    const st = await h2.status();
    assert(st.connected && st.capabilities.jump && !st.capabilities.readTimeline && /2025\.10/.test(st.reason), JSON.stringify(st));
    await h2.jumpTo(5, false);
    await assert.rejects(() => h2.getClips(), /2025\.10/);
    s2.close();
  });
  await check("no Pro Tools: status says so and never throws", async () => {
    const h3 = new ProToolsHands({ address: "127.0.0.1:1", timeoutMs: 2000 });
    const st = await h3.status();
    assert(!st.connected && /not running/.test(st.reason), JSON.stringify(st));
  });

  await require("./cubase-cases")(check, OUT, fixture);

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
