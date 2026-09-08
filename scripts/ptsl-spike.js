// Phase 0 probe against a REAL Pro Tools: node scripts/ptsl-spike.js
// With Pro Tools open on a session, prints the PTSL version, every track,
// every playlist element with its clip definition and source offset, and
// the getClips() table the app would build - the raw material for the
// "VERIFY" notes in the spec. Read-only: nothing is edited.
const { ProToolsHands } = require("../hands/protools");

(async () => {
  const hands = new ProToolsHands({ timeoutMs: 15000 });
  const st = await hands.status();
  console.log("status:", JSON.stringify(st, null, 1));
  if (!st.connected) process.exit(1);
  const d = await hands.diagnostics();
  console.log("\n--- raw track list ---");
  console.log(JSON.stringify(d.raw.trackList, null, 1));
  console.log("\n--- raw playlist elements (per track) ---");
  console.log(JSON.stringify(d.raw.playlists, null, 1));
  console.log("\n--- raw clip list ---");
  console.log(JSON.stringify(d.raw.clipList, null, 1));
  console.log("\n--- raw file locations ---");
  console.log(JSON.stringify(d.raw.fileLocations, null, 1));
  console.log("\n--- getClips() ---");
  if (d.error) console.log("ERROR:", d.error);
  else {
    console.log("session", d.clips.sessionName, "in", d.clips.sessionPath, "@", d.clips.sampleRate, "Hz");
    d.clips.clips.forEach((c) => console.log(
      [c.track, c.trackName, c.name, c.path.split(/[\\/]/).pop(), c.start.toFixed(3), c.end.toFixed(3), "src", c.inPoint.toFixed(3), c.outPoint.toFixed(3), c.muted ? "muted" : ""].join("\t")));
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
