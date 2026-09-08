// Browser-test shim for the renderer: stands in for preload.js when the
// page is served by test/serve.js instead of Electron. window.fame gets a
// fake Pro Tools built from the DMS fixture layout, and every request to
// review.fame.so carries the admin key so the real production APIs answer
// without a Supabase login. Never shipped - test/ only.
(function () {
  var ADMIN = window.__FAME_ADMIN_KEY__ || "";
  var origFetch = window.fetch;
  window.fetch = function (url, opts) {
    if (typeof url === "string" && url.indexOf("https://review.fame.so/") === 0 && ADMIN) {
      opts = opts || {};
      var h = Object.assign({}, opts.headers || {});
      h["x-admin-key"] = ADMIN;
      delete h.authorization;
      opts = Object.assign({}, opts, { headers: h });
    }
    return origFetch(url, opts);
  };
  try {
    localStorage.setItem("fame_session", JSON.stringify({ access_token: "stub", refresh_token: "stub", expires_at: Math.floor(Date.now() / 1000) + 86400 * 365, email: "stub@fame.so" }));
  } catch (e) {}

  var denis = "riverside_denis_vozian_raw-audio_sourcepass_mcoe stu_0165.wav";
  var nathan = "riverside_nathan_taylor_raw-audio_sourcepass_mcoe stu_0164.wav";
  var clips = [
    { id: "a", track: 0, trackName: "Denis", name: "riverside_denis_vozian_raw-audio-01", path: "/raw/" + denis, type: "audio", start: 2, end: 1500, inPoint: 10, outPoint: 1508, rate: 1, muted: false },
    { id: "c", track: 1, trackName: "Nathan", name: "riverside_nathan_taylor_raw-audio-01", path: "/raw/" + nathan, type: "audio", start: 0, end: 1510, inPoint: 0, outPoint: 1510, rate: 1, muted: false },
    { id: "d", track: 2, trackName: "Music", name: "bed", path: "/music/bed.wav", type: "audio", start: 0, end: 60, inPoint: 0, outPoint: 60, rate: 1, muted: false },
  ];
  var calls = [];
  window.__fameCalls = calls;
  var connected = window.__FAME_DISCONNECTED__ ? false : true;
  var DAW = (new URLSearchParams(location.search).get("daw")) || localStorage.getItem("fame_daw") || "protools";
  var cubaseSetup = { exchangeDir: "/Users/anton/Fame exchange", exchangeDirOk: true, midi: { ports: ["loopMIDI Port"], virtual: true, chosen: "", ok: true, reason: "", sendingOn: "Fame Plugin" }, latestArchive: { name: "DMS27 speakers.xml", mtimeMs: Date.now() - 60000, ours: false }, schema: { event: "assumed" } };
  function pend(next, extra) { return Object.assign({ pending: true, next: next, file: "/Users/anton/Fame exchange/DMS27 speakers - Fame cut.xml" }, extra || {}); }
  var caps = {};
  ["connect", "readTimeline", "jump", "rippleCut", "silence", "fades", "trackGain", "render", "assembly"].forEach(function (c) { caps[c] = connected; });
  function rec(name, args, value) { calls.push({ name: name, args: args }); return Promise.resolve(value); }
  window.fame = {
    hands: {
      status: function () {
        if (DAW === "cubase") return rec("status", [], { connected: connected, fileBased: true, dawLabel: "Cubase", dawVersion: "", capabilities: caps, reason: connected ? "" : "pick the Fame exchange folder", setup: cubaseSetup });
        return rec("status", [], { connected: connected, dawVersion: "2025.10", capabilities: caps, reason: connected ? "" : "Pro Tools is not running, or its scripting service is off (Setup > Preferences > Scripting)." });
      },
      getClips: function () { return rec("getClips", [], { clips: clips, tracks: 3, sampleRate: 48000, sessionName: "DMS 27", sessionPath: "/sessions/dms27", raw: {} }); },
      jumpTo: function (sec, play) { return rec("jumpTo", [sec, play]); },
      applyRippleCuts: function (r) { return rec("applyRippleCuts", [r], DAW === "cubase" ? pend("In Cubase: File > Import > Track Archive, choose \"DMS27 speakers - Fame cut.xml\". The cut tracks land under your originals - mute or delete the originals when you are happy.", { applied: r.length, fades: r.length * 2 }) : { applied: r.length, fades: r.length }); },
      silenceRanges: function (s) { var v = { silenced: s.reduce(function (a, x) { return a + x.ranges.length; }, 0), tracks: s.length }; return rec("silenceRanges", [s], DAW === "cubase" ? pend("In Cubase: File > Import > Track Archive, choose \"DMS27 speakers - Fame silenced.xml\".", v) : v); },
      setTrackGainDb: function (t, dB) { return rec("setTrackGainDb", [t, dB], DAW === "cubase" ? pend("This export carries no event volume the Plugin can set. In Cubase, set the fader on Denis to " + (dB > 0 ? "+" : "") + dB.toFixed(1) + " dB (MixConsole).", { tracks: t.length }) : { tracks: t.length, note: "Written as volume automation from the fader's 0 dB position on 1 track(s) - if that fader was not at 0 dB, Undo and set it by hand." }); },
      buildAssembly: function (f) { var v = { added: f.length, tracks: f.map(function (x) { return x.name; }) }; return rec("buildAssembly", [f], DAW === "cubase" ? pend("In Cubase: File > Import > Track Archive, choose \"Fame assembly - Fame layout.xml\" - one track per speaker.", v) : v); },
      render: function (o) { if (DAW === "cubase" && window.__fameNote) setTimeout(function () { window.__fameNote("In Cubase: File > Export > Audio Mixdown - MP3 320 kbps, save into /Users/anton/Fame exchange. The Plugin picks it up the moment the file finishes writing."); }, 50); return new Promise(function (res) { setTimeout(function () { res({ path: DAW === "cubase" ? "/Users/anton/Fame exchange/DMS27 mixdown.mp3" : "/sessions/dms27/Fame renders/" + o.slug + ".mp3" }); calls.push({ name: "render", args: [o] }); }, DAW === "cubase" ? 1500 : 10); }); },
      measure: function (p, o) { return rec("measure", [p, o], { durationSec: 1498, channels: 2, lufs: o ? (/bed/.test(p) ? -14.2 : -19.1) : -18.6, truePeakDb: -1.2 }); },
      diagnostics: function () { return rec("diagnostics", [], { status: { connected: connected, dawVersion: "2025.10", capabilities: caps }, clips: { clips: clips, tracks: 3, sampleRate: 48000, sessionName: "DMS 27" }, error: null, raw: { trackList: { track_list: [{ name: "Denis" }] } } }); },
    },
    daw: function () { return Promise.resolve(DAW); },
    selectDaw: function (d) { DAW = d; localStorage.setItem("fame_daw", d); calls.push({ name: "selectDaw", args: [d] }); return Promise.resolve(d); },
    configure: function (p) { calls.push({ name: "configure", args: [p] }); if (p.exchangeDir != null) { cubaseSetup.exchangeDir = p.exchangeDir; cubaseSetup.exchangeDirOk = !!p.exchangeDir; } if (p.midiPort != null) { cubaseSetup.midi.chosen = p.midiPort; cubaseSetup.midi.sendingOn = p.midiPort || "Fame Plugin"; } return window.fame.hands.status(); },
    onNote: function (cb) { window.__fameNote = cb; },
    openPath: function (p) { calls.push({ name: "openPath", args: [p] }); return Promise.resolve(""); },
    info: function () { return Promise.resolve({ version: "1.0.0", platform: "darwin", arch: "arm64" }); },
    pickFile: function () { return Promise.resolve("/sessions/dms27/bounce.mp3"); },
    pickFolder: function (o) { return Promise.resolve(o && /exchange/i.test(o.title || "") ? "/Users/anton/Fame exchange" : "/raw"); },
    listDir: function (d) { return Promise.resolve(d === "/raw" ? [denis, nathan] : []); },
    fileSize: function () { return Promise.resolve(12345678); },
    openExternal: function () { return Promise.resolve(); },
    showInFolder: function () { return Promise.resolve(); },
    uploadFile: function (a) { calls.push({ name: "uploadFile", args: [a] }); return Promise.reject(new Error("stub: no bytes sent in the browser test")); },
    installUpdate: function () { return Promise.resolve(); },
    latestVersion: function () { return Promise.resolve({ version: "1.0.0", notes: "" }); },
    onUploadProgress: function () {},
    onUpdate: function () {},
  };
})();
