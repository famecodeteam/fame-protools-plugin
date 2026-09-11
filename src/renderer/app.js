// Fame Pro Tools / Cubase Plugin - the app's own logic (one renderer,
// two adapters behind window.fame.hands).
//
// Ported from the Fame Premiere Plugin's js/main.js almost line for line:
// auth (Supabase password grant), episode load/search, comment feed,
// cleanup pass, changelog, upload session/complete, comment precheck,
// update banner. Every evalScript("fame...") call became a call on the
// hands (window.fame.hands - see hands/interface.js), and the AE-only
// pieces come from the Reaper plugin: Fix levels, bounce + measure +
// preflight, audio assembly, music balance, apply-comment.
//
// Never a modal dialog in here - confirmInPanel() renders a yes/no block.
//
// A file-based DAW (Cubase) cannot be moved from here: its hands resolve
// with { pending, next } and the UI shows that line, with an Open-folder
// button, wherever a result would go. DAW_LABEL / FILE_BASED come from the
// adapter's status(), so no copy below hard-codes a DAW name.

"use strict";

var SUPABASE_URL = "https://xttbrfynxdbcymzxysxf.supabase.co";
// The PUBLIC browser key - the same one review.fame.so ships to every visitor.
var SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0dGJyZnlueGRiY3ltenh5c3hmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwNjQ3NzYsImV4cCI6MjA5NDY0MDc3Nn0.-HBXvIWtv1a3kdIbup6udsAdW0RCkQDKqkBixJXbQco";
var API = "https://review.fame.so/api/panel";
var VERSION_URL = "https://review.fame.so/protools/version.json";
var INSTALL_URL = "https://review.fame.so/protools";
var APP_VERSION = "0.0.0"; // filled from package.json by the main process
var DAW = "protools";
var DAW_LABEL = "Pro Tools";
var FILE_BASED = false;
var DAW_NAMES = { protools: "Pro Tools", cubase: "Cubase" };
var FADE_MS = 10;
var MAX_LEVEL_FIX_DB = FameCore.MAX_LEVEL_FIX_DB;

var hands = window.fame.hands;

// ---------- tiny helpers ----------

function $(id) { return document.getElementById(id); }

function setStatus(msg, kind, spinning) {
  var el = $("status");
  el.innerHTML = "";
  if (spinning) {
    var s = document.createElement("span");
    s.className = "spinner";
    el.appendChild(s);
  }
  el.appendChild(document.createTextNode(msg || ""));
  el.className = kind || "";
}

function apiFetch(path, opts) {
  opts = opts || {};
  return getToken().then(function (token) {
    var headers = Object.assign({ authorization: "Bearer " + token }, opts.headers || {});
    if (opts.body && typeof opts.body !== "string") {
      opts.body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    return fetch(API + path, { method: opts.method || "GET", headers: headers, body: opts.body });
  });
}

// Usage ping - fire and forget; a telemetry failure never surfaces.
function track(event) {
  try {
    apiFetch("/telemetry", { method: "POST", body: { event: event, slug: currentData ? currentData.slug : null, version: APP_VERSION, client: DAW } }).catch(function () {});
  } catch (e) {}
}

// "What changed" log - handed up with the next upload so the PM sees a
// changelog on the new version instead of re-listening to find out.
function changeLogKey() { return "fame_changelog:" + (currentData ? currentData.slug : ""); }
function readChangeLog() {
  try { return JSON.parse(localStorage.getItem(changeLogKey()) || "[]"); } catch (e) { return []; }
}
function logChange(line) {
  try {
    var l = readChangeLog();
    l.push(line);
    localStorage.setItem(changeLogKey(), JSON.stringify(l.slice(-30)));
  } catch (e) {}
}
function clearChangeLog() { try { localStorage.removeItem(changeLogKey()); } catch (e) {} }

function playDone() {
  try {
    var ac = new (window.AudioContext || window.webkitAudioContext)();
    [[660, 0], [880, 0.18]].forEach(function (t) {
      var o = ac.createOscillator();
      var g = ac.createGain();
      o.frequency.value = t[0];
      o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.0001, ac.currentTime + t[1]);
      g.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + t[1] + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t[1] + 0.35);
      o.start(ac.currentTime + t[1]);
      o.stop(ac.currentTime + t[1] + 0.4);
    });
    setTimeout(function () { try { ac.close(); } catch (e) {} }, 1200);
  } catch (e) {}
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  var mm = (h > 0 && m < 10 ? "0" : "") + m;
  var ss = (s < 10 ? "0" : "") + s;
  return h > 0 ? h + ":" + mm + ":" + ss : m + ":" + ss;
}

function fmtWhen(iso) {
  var then = Date.parse(iso);
  if (!isFinite(then)) return "";
  var mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  var days = Math.floor(hours / 24);
  return days < 14 ? days + "d ago" : new Date(then).toLocaleDateString();
}

function basename(p) { return FameCore.basename(p); }

// ---------- auth (Supabase password grant + refresh) ----------

function saveSession(s) {
  localStorage.setItem("fame_session", JSON.stringify({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
    email: s.user && s.user.email ? s.user.email : (readSession() || {}).email,
  }));
}
function readSession() {
  try { return JSON.parse(localStorage.getItem("fame_session") || "null"); } catch (e) { return null; }
}
function clearSession() { localStorage.removeItem("fame_session"); }

function authRequest(body) {
  var grant = body.refresh_token ? "refresh_token" : "password";
  return fetch(SUPABASE_URL + "/auth/v1/token?grant_type=" + grant, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SUPABASE_ANON },
    body: JSON.stringify(body),
  }).then(function (r) {
    return r.json().then(function (j) {
      if (!r.ok) throw new Error(j.error_description || j.msg || "Sign-in failed");
      return j;
    });
  });
}

function getToken() {
  var s = readSession();
  if (!s) return Promise.reject(new Error("signed-out"));
  if (s.expires_at - Math.floor(Date.now() / 1000) > 60) return Promise.resolve(s.access_token);
  return authRequest({ refresh_token: s.refresh_token }).then(function (j) {
    saveSession(j);
    return j.access_token;
  }).catch(function (e) { clearSession(); throw e; });
}

// ---------- DAW connection ----------

var dawStatus = { connected: false, capabilities: {}, dawVersion: "", reason: "" };

function can(cap) { return !!(dawStatus.capabilities && dawStatus.capabilities[cap]); }

function refreshDaw() {
  return hands.status().then(function (st) {
    dawStatus = st;
    FILE_BASED = !!st.fileBased;
    DAW_LABEL = st.dawLabel || DAW_NAMES[DAW] || DAW;
    var bar = $("daw-bar");
    bar.innerHTML = "";
    bar.className = st.connected ? "on" : "off";
    var dot = document.createElement("span");
    dot.className = "dot";
    bar.appendChild(dot);
    var txt = document.createElement("span");
    txt.className = "txt";
    if (FILE_BASED) {
      txt.textContent = st.connected
        ? (DAW_LABEL + " - file-based: exports in, archives out" + (st.reason ? " - " + st.reason : ""))
        : (DAW_LABEL + " - " + st.reason);
    } else {
      txt.textContent = st.connected
        ? (DAW_LABEL + " " + st.dawVersion + " connected" + (st.reason ? " - " + st.reason : ""))
        : (DAW_LABEL + " not connected - " + st.reason);
    }
    bar.appendChild(txt);
    var re = document.createElement("button");
    re.className = "btn-ghost";
    re.textContent = FILE_BASED ? "Refresh" : "Retry";
    re.onclick = function () { refreshDaw(); };
    bar.appendChild(re);
    renderDawSetup(st);
    return st;
  });
}

// The Cubase setup card: the exchange folder Cubase exports into, the MIDI
// port MMC goes out on, and what the folder holds right now. A file-based
// flow looks broken while it waits - this card always says what is next.
function renderDawSetup(st) {
  var host = $("daw-setup");
  if (!st.fileBased || !st.setup) { host.className = "hidden"; host.innerHTML = ""; return; }
  host.className = "";
  host.innerHTML = "";
  var su = st.setup;
  var head = document.createElement("div");
  head.className = "eyebrow";
  head.textContent = DAW_LABEL + " setup";
  host.appendChild(head);

  var r1 = document.createElement("div");
  r1.className = "row";
  var lbl = document.createElement("span");
  lbl.textContent = "Exchange folder:";
  r1.appendChild(lbl);
  var pth = document.createElement("span");
  pth.className = "path";
  pth.textContent = su.exchangeDir || "not set";
  pth.title = su.exchangeDir || "";
  r1.appendChild(pth);
  var pick = document.createElement("button");
  pick.className = su.exchangeDirOk ? "btn-ghost" : "btn-primary";
  pick.textContent = su.exchangeDirOk ? "Change" : "Pick folder";
  pick.onclick = function () {
    window.fame.pickFolder({ title: "Pick the Fame exchange folder - Cubase exports into it, the Plugin reads from it" }).then(function (d) {
      if (!d) return;
      return window.fame.configure({ exchangeDir: d }).then(function () { return refreshDaw(); }).then(function () { if (currentData) renderCleanup(); });
    }).catch(function (e) { setStatus(e.message, "error"); });
  };
  r1.appendChild(pick);
  if (su.exchangeDirOk) {
    var open = document.createElement("button");
    open.className = "btn-ghost";
    open.textContent = "Open";
    open.onclick = function () { window.fame.openPath(su.exchangeDir); };
    r1.appendChild(open);
  }
  host.appendChild(r1);

  var r2 = document.createElement("div");
  r2.className = "row";
  var ml = document.createElement("span");
  ml.textContent = "MIDI to " + DAW_LABEL + ":";
  r2.appendChild(ml);
  var sel = document.createElement("select");
  var opts = [];
  if (su.midi.virtual) opts.push({ v: "", t: "Fame Plugin (built-in port)" });
  (su.midi.ports || []).forEach(function (p) { opts.push({ v: p, t: p }); });
  if (!su.midi.virtual && !opts.length) opts.push({ v: "", t: "no MIDI ports - install loopMIDI" });
  opts.forEach(function (o) {
    var el = document.createElement("option");
    el.value = o.v; el.textContent = o.t;
    if (o.v === (su.midi.chosen || "")) el.selected = true;
    sel.appendChild(el);
  });
  sel.onchange = function () { window.fame.configure({ midiPort: sel.value }).then(function () { return refreshDaw(); }).catch(function (e) { setStatus(e.message, "error"); }); };
  r2.appendChild(sel);
  var ms = document.createElement("span");
  ms.className = su.midi.ok ? "ok" : "warn";
  ms.textContent = su.midi.ok ? "sending on \"" + su.midi.sendingOn + "\"" : su.midi.reason;
  r2.appendChild(ms);
  host.appendChild(r2);

  var r3 = document.createElement("div");
  r3.className = "row";
  if (!su.exchangeDirOk) {
    r3.textContent = "Next: pick the folder above. In Cubase you will export tracks and mixdowns into it; the Plugin reads them from there.";
  } else if (!su.latestArchive) {
    r3.textContent = "Next: in Cubase select the speaker tracks, File > Export > Selected Tracks, save the .xml into the folder, then Refresh.";
  } else {
    r3.textContent = "Latest archive: " + su.latestArchive.name + " (" + fmtWhen(new Date(su.latestArchive.mtimeMs).toISOString()) + ")" +
      (su.latestArchive.ours ? " - written by the Plugin; import it in Cubase, or export again to continue from Cubase's state." : "");
  }
  host.appendChild(r3);
  var r4 = document.createElement("div");
  r4.className = "row";
  r4.style.color = "var(--muted)";
  r4.textContent = "One-time: Transport > Project Synchronization Setup > Machine Control > MMC Slave Active, MMC Input = \"" + (su.midi.sendingOn || "Fame Plugin") + "\". Then timestamps jump and play.";
  host.appendChild(r4);
}

// Show a pending step (the DAW has not done it yet) where a result would
// go. `file` gets an Open button that reveals it.
function showPending(host, text, file) {
  host = host || $("cl-body");
  var old = document.getElementById("fame-pending");
  if (old) old.parentNode.removeChild(old);
  var box = document.createElement("div");
  box.id = "fame-pending";
  box.className = "pending";
  var b = document.createElement("b");
  b.textContent = "Next: ";
  box.appendChild(b);
  box.appendChild(document.createTextNode(text));
  if (file) {
    var btn = document.createElement("button");
    btn.className = "btn-ghost";
    btn.textContent = "Show file";
    btn.onclick = function () { window.fame.showInFolder(file); };
    box.appendChild(btn);
  }
  host.insertBefore(box, host.firstChild);
  return box;
}

// Wrap a hands result: a pending one is shown as the next step, a done one
// as the status line. Returns true when it was pending.
function afterHands(r, okMsg, host) {
  if (r && r.pending) {
    showPending(host, r.next, r.file);
    setStatus(String(okMsg).replace(/\.\s*$/, "") + " - written for " + DAW_LABEL + ", see the next step.", "ok");
    return true;
  }
  setStatus(okMsg, "ok");
  return false;
}

// ---------- recent episodes ----------

function readRecents() {
  try { return JSON.parse(localStorage.getItem("fame_recents") || "[]"); } catch (e) { return []; }
}
function pushRecent(slug, name) {
  var r = readRecents().filter(function (x) { return x.slug !== slug; });
  r.unshift({ slug: slug, name: name || slug });
  localStorage.setItem("fame_recents", JSON.stringify(r.slice(0, 6)));
}
function removeRecent(slug) {
  localStorage.setItem("fame_recents", JSON.stringify(readRecents().filter(function (x) { return x.slug !== slug; })));
  renderRecents();
}
function renderRecents() {
  var host = $("recent");
  host.innerHTML = "";
  readRecents().forEach(function (r) {
    var b = document.createElement("button");
    b.className = "chip";
    b.textContent = r.name;
    b.title = r.slug;
    b.onclick = function () { $("slug").value = r.slug; loadEpisode(); };
    var x = document.createElement("span");
    x.className = "chip-x";
    x.textContent = "×";
    x.title = "Remove from recent episodes";
    x.onclick = function (ev) { ev.stopPropagation(); removeRecent(r.slug); };
    b.appendChild(x);
    host.appendChild(b);
  });
}

// ---------- episode search ----------

var searchSeq = 0;
var searchTimer = null;

function runEpisodeSearch() {
  var q = $("ep-search").value.trim();
  var host = $("ep-results");
  if (q.length < 2) { host.innerHTML = ""; return; }
  var mySeq = ++searchSeq;
  apiFetch("/episodes?q=" + encodeURIComponent(q))
    .then(function (r) { return r.ok ? r.json() : { episodes: [] }; })
    .then(function (j) {
      if (mySeq !== searchSeq) return;
      host.innerHTML = "";
      var eps = j.episodes || [];
      if (!eps.length) {
        var note = document.createElement("div");
        note.className = "ep-note";
        note.textContent = "No episodes match \"" + q + "\". Episodes appear here once their Trello card exists - ask your PM if yours is missing.";
        host.appendChild(note);
        return;
      }
      eps.forEach(function (e) {
        var b = document.createElement("button");
        b.className = "ep-row";
        b.appendChild(document.createTextNode(e.name + " "));
        var c = document.createElement("span");
        c.className = "ep-client";
        c.textContent = "· " + (e.clientName || e.clientCode);
        b.appendChild(c);
        b.onclick = function () {
          track("episode_search");
          $("slug").value = e.slug;
          $("ep-search").value = "";
          host.innerHTML = "";
          loadEpisode();
        };
        host.appendChild(b);
      });
    })
    .catch(function () {});
}
$("ep-search").oninput = function () {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(runEpisodeSearch, 350);
};

// ---------- episode loading + rendering ----------

var currentData = null;
var filterMode = "all";
var hideResolved = false;
var loadSeq = 0;

function parseSlug(input) {
  var s = (input || "").trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\/[^/]+\//i, "");
  s = s.replace(/^review\//i, "");
  s = s.split(/[?#]/)[0];
  s = s.replace(/\/(ve|upload|audit)\/?$/i, "");
  s = s.replace(/\/+$/, "");
  return s;
}

function loadEpisode() {
  var slug = parseSlug($("slug").value);
  if (!slug) {
    setStatus(currentData
      ? "You're on \"" + (currentData.name || currentData.slug) + "\" - paste a different episode's link, or search below."
      : "Paste an episode link, or search below by client or guest name.", "error");
    return;
  }
  var mySeq = ++loadSeq;
  setStatus("Loading comments…", "", true);
  apiFetch("/comments?slug=" + encodeURIComponent(slug)).then(function (r) {
    if (r.status === 401) throw new Error("signed-out");
    if (r.status === 404) throw new Error("Episode not found - check the link.");
    if (!r.ok) throw new Error("Load failed (" + r.status + ")");
    return r.json();
  }).then(function (data) {
    if (mySeq !== loadSeq) return;
    currentData = data;
    track("load_episode");
    pushRecent(data.slug, data.name);
    renderRecents();
    $("filters").className = "";
    renderComments();
    $("cleanup").className = "";
    $("deliver").className = "hidden";
    resetCleanup();
    pollCleanupLoop();
    briefData = null;
    loadBrief();
    var total = countComments(function () { return true; });
    setStatus(total === 0 ? "Loaded - no comments yet." : total + " comment" + (total === 1 ? "" : "s") + " loaded.", "ok");
  }).catch(function (e) {
    if (mySeq !== loadSeq) return;
    if (e.message === "signed-out") {
      clearSession();
      showView("login");
      setStatus("Session expired - sign in again.", "error");
    } else {
      setStatus(e.message, "error");
    }
  });
}

function countComments(pred) {
  var n = 0;
  if (!currentData) return 0;
  (currentData.assets || []).forEach(function (a) {
    (a.versions || []).forEach(function (v) { v.comments.forEach(function (c) { if (pred(c)) n++; }); });
  });
  return n;
}

function visible(c) {
  if (hideResolved && c.resolved) return false;
  if (filterMode === "client" && c.internal) return false;
  if (filterMode === "internal" && !c.internal) return false;
  return true;
}

function kindLabel(kind) {
  return { longform_video: "Longform", hook: "Hook", audio: "Audio", snippet: "Snippet" }[kind] || kind;
}

function jump(sec, label) {
  if (!can("jump")) { setStatus(FILE_BASED ? (fmtTime(sec) + " - " + (dawStatus.reason || "set the MIDI port in " + DAW_LABEL + " setup and MMC Slave in " + DAW_LABEL + ", then timestamps jump")) : (DAW_LABEL + " is not connected - " + dawStatus.reason), "error"); return; }
  hands.jumpTo(Number(sec), true).then(function () {
    track("jump");
    setStatus("Jumped to " + fmtTime(sec) + " and playing" + (label ? " - " + label : "") + ".", "ok");
  }).catch(function (e) { setStatus(e.message, "error"); });
}

function renderComments() {
  var data = currentData;
  $("ep-name").textContent = data ? (data.name || data.slug) : (DAW_LABEL + " Plugin");
  var host = $("comments");
  host.innerHTML = "";
  if (!data) return;
  var shown = 0;
  // The audio asset first: that is the AE's own deliverable.
  var assets = (data.assets || []).slice().sort(function (a, b) {
    var ka = a.kind === "audio" ? 0 : a.kind === "longform_video" ? 1 : 2;
    var kb = b.kind === "audio" ? 0 : b.kind === "longform_video" ? 1 : 2;
    return ka - kb || String(a.name).localeCompare(String(b.name));
  });
  assets.forEach(function (asset) {
    var versionBlocks = [];
    (asset.versions || []).forEach(function (v) {
      var vis = v.comments.filter(visible);
      if (vis.length) versionBlocks.push({ v: v, comments: vis });
    });
    if (!versionBlocks.length) return;
    var box = document.createElement("div");
    box.className = "asset";
    var head = document.createElement("div");
    head.className = "asset-head";
    var nm = document.createElement("span");
    nm.className = "asset-name";
    nm.textContent = asset.name;
    var kd = document.createElement("span");
    kd.className = "asset-kind";
    kd.textContent = kindLabel(asset.kind);
    var ct = document.createElement("span");
    ct.className = "asset-count";
    ct.textContent = versionBlocks.reduce(function (a, b) { return a + b.comments.length; }, 0);
    head.appendChild(nm); head.appendChild(kd); head.appendChild(ct);
    box.appendChild(head);
    versionBlocks.forEach(function (blk) {
      var vl = document.createElement("div");
      vl.className = "version-label";
      vl.textContent = "v" + blk.v.n + (blk.v.clientN ? " (client v" + blk.v.clientN + ")" : " (internal cut)");
      box.appendChild(vl);
      blk.comments.forEach(function (c) { box.appendChild(renderComment(c)); shown++; });
    });
    host.appendChild(box);
  });
  (data.studioMarkers || []).forEach(function (entry) {
    if (!entry.markers || !entry.markers.length) return;
    var box = document.createElement("div");
    box.className = "asset";
    var head = document.createElement("div");
    head.className = "asset-head";
    var nm = document.createElement("span");
    nm.className = "asset-name";
    nm.textContent = "⚑ " + (entry.sessionTitle || "Studio session");
    var kd = document.createElement("span");
    kd.className = "asset-kind";
    kd.textContent = "Studio markers";
    head.appendChild(nm); head.appendChild(kd);
    box.appendChild(head);
    var vl = document.createElement("div");
    vl.className = "version-label";
    vl.textContent = "Recorded " + (entry.sessionDate || "") + " - offsets into the raw session masters";
    box.appendChild(vl);
    entry.markers.forEach(function (m) {
      var row = document.createElement("div");
      row.className = "comment";
      var t = document.createElement("button");
      t.className = "tstamp";
      t.textContent = fmtTime(m.timestampSeconds);
      t.onclick = function () { jump(m.timestampSeconds); };
      row.appendChild(t);
      var body = document.createElement("div");
      body.className = "c-body";
      var meta = document.createElement("div");
      meta.className = "c-meta";
      var author = document.createElement("span");
      author.className = "c-author";
      author.textContent = m.by || "Unknown";
      meta.appendChild(author);
      var badge = document.createElement("span");
      badge.className = "badge internal";
      badge.textContent = m.role === "producer" ? "Producer" : "Host";
      meta.appendChild(badge);
      body.appendChild(meta);
      var text = document.createElement("div");
      text.className = "c-text";
      text.textContent = m.label || "Marked moment (no note)";
      body.appendChild(text);
      row.appendChild(body);
      box.appendChild(row);
      shown++;
    });
    host.appendChild(box);
  });
  if (shown === 0) {
    var d = document.createElement("div");
    d.className = "empty";
    var any = countComments(function () { return true; });
    d.innerHTML = '<span class="big">🎉</span>';
    d.appendChild(document.createTextNode(any === 0 ? "No comments on this episode yet." : "Nothing matching the current filter."));
    host.appendChild(d);
  }
}

function renderComment(c) {
  var row = document.createElement("div");
  row.className = "comment" + (c.resolved ? " resolved" : "");
  var t = document.createElement("button");
  t.className = "tstamp";
  t.textContent = fmtTime(c.timestampSeconds);
  t.title = "Jump there and play";
  if (!c.timestampSeconds && c.timestampSeconds !== 0) t.disabled = true;
  t.onclick = function () { jump(c.timestampSeconds); };
  row.appendChild(t);
  var body = document.createElement("div");
  body.className = "c-body";
  var meta = document.createElement("div");
  meta.className = "c-meta";
  var author = document.createElement("span");
  author.className = "c-author";
  author.textContent = c.authorName || "Unknown";
  meta.appendChild(author);
  var badge = document.createElement("span");
  badge.className = "badge " + (c.internal ? "internal" : "client");
  badge.textContent = c.internal ? "QA" : "Client";
  meta.appendChild(badge);
  if (c.action && c.action !== "manual" && c.actionConfidence >= 0.7) {
    var act = document.createElement("span");
    act.className = "badge done";
    act.textContent = c.action === "trim" ? "cuttable" : c.action;
    act.title = c.actionReason || "";
    meta.appendChild(act);
    if (c.action === "trim" && !c.resolved && can("rippleCut")) {
      var applyBtn = document.createElement("button");
      applyBtn.className = "cl-t";
      applyBtn.textContent = "Apply";
      applyBtn.title = "Make this cut on your timeline - refuses rather than guessing";
      applyBtn.onclick = function () { applyComment(c, applyBtn); };
      meta.appendChild(applyBtn);
    }
  }
  if (c.resolved) {
    var done = document.createElement("span");
    done.className = "badge done";
    done.textContent = "Resolved";
    meta.appendChild(done);
  }
  var when = document.createElement("span");
  when.className = "c-when";
  when.textContent = fmtWhen(c.createdAt);
  meta.appendChild(when);
  body.appendChild(meta);
  var text = document.createElement("div");
  text.className = "c-text";
  text.textContent = c.text;
  body.appendChild(text);
  row.appendChild(body);
  return row;
}

// ---------- in-panel confirm (never window.confirm) ----------

function confirmInPanel(title, lines, okLabel, onOk, host) {
  host = host || $("cl-body") || $("view-main");
  var old = document.getElementById("fame-confirm");
  if (old) old.parentNode.removeChild(old);
  var box = document.createElement("div");
  box.id = "fame-confirm";
  box.className = "cl-group";
  var h = document.createElement("div");
  h.className = "cl-group-head";
  h.textContent = title;
  box.appendChild(h);
  lines.forEach(function (l) {
    var d = document.createElement("div");
    d.className = "cl-notes";
    d.textContent = l;
    box.appendChild(d);
  });
  var row = document.createElement("div");
  row.style.marginTop = "8px";
  var go = document.createElement("button");
  go.className = "btn-primary";
  go.textContent = okLabel;
  go.onclick = function () { box.parentNode.removeChild(box); onOk(); };
  var no = document.createElement("button");
  no.className = "btn-ghost";
  no.style.marginLeft = "6px";
  no.textContent = "Cancel";
  no.onclick = function () { box.parentNode.removeChild(box); };
  row.appendChild(go);
  row.appendChild(no);
  box.appendChild(row);
  host.insertBefore(box, host.firstChild);
  box.scrollIntoView({ block: "nearest" });
}

// ---------- Cleanup pass ----------

var cleanupState = null;
var cleanupPollTimer = null;
var cleanupChecks = {};
var clipsInfo = null;     // last timeline read
var levelsApplied = {};   // speaker -> dB applied this session

function stopCleanupPoll() {
  if (cleanupPollTimer) { clearTimeout(cleanupPollTimer); cleanupPollTimer = null; }
}

function resetCleanup() {
  stopCleanupPoll();
  cleanupState = null;
  cleanupChecks = {};
  clipsInfo = null;
  levelsApplied = {};
  $("cl-body").innerHTML = "";
  $("cl-sub").textContent = "Finds filler words, stumbles, dead air, breaths and clicks in this episode's raw recordings, then cuts or silences the ones you tick.";
  $("btn-analyze").disabled = false;
  $("btn-analyze").textContent = "Analyze audio";
}

function cleanupRequest(method) {
  var fresh = method === "POST" && cleanupState && cleanupState.status === "ready" ? "&fresh=1" : "";
  return apiFetch("/cleanup?slug=" + encodeURIComponent(currentData.slug) + fresh, { method: method })
    .then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ("Cleanup request failed (" + r.status + ")"));
        return j;
      });
    });
}

function startCleanupAnalysis(note) {
  if (!currentData) return;
  $("btn-analyze").disabled = true;
  $("btn-analyze").textContent = "Analyzing…";
  $("cl-sub").textContent = note || "Uploading and transcribing the raw recordings - a full episode takes a few minutes. You can keep editing.";
  cleanupRequest("POST").then(function (j) {
    cleanupState = j.state;
    pollCleanupLoop();
  }).catch(function (e) {
    $("btn-analyze").disabled = false;
    $("btn-analyze").textContent = "Analyze audio";
    $("cl-sub").textContent = e.message;
  });
}

// ---------- Analyze what's on my timeline ----------
//
// The cleanup pass reads the episode's Raw Assets from Drive. Those are the
// untouched Riverside recordings, and an AE's first job is often to rescue
// them - the first Pro Tools AE put it plainly: "sometimes the raw assets
// are very quiet so the transcripts turned out to be not accurate with the
// words". A transcript of quiet audio mishears words and misses fillers,
// and no amount of mapping fixes that.
//
// So: send the audio the editor is actually working with. Each speaker's
// file goes from their own disk straight to the episode's Raw Masters
// folder on Drive (never through a Fame server), named "<speaker>__<file>"
// so the analysis knows who is who whatever the track is called, and the
// analysis then prefers that folder. The AE never opens Drive.

var AUDIO_MIME = {
  wav: "audio/wav", mp3: "audio/mpeg", aif: "audio/aiff", aiff: "audio/aiff",
  flac: "audio/flac", m4a: "audio/mp4", ogg: "audio/ogg",
};
function mimeForPath(p) {
  var ext = String(p || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return ext ? AUDIO_MIME[ext[1]] : null;
}
function slugifySpeaker(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Who this episode has: the analysis's own list when there is one, else the
// brief's raw-media speakers.
function knownSpeakers() {
  var out = [], seen = {};
  ((cleanupState && cleanupState.files) || []).forEach(function (f) {
    if (f.speaker && !seen[f.speaker]) { seen[f.speaker] = true; out.push(f.speaker); }
  });
  ((briefData && briefData.rawMedia && briefData.rawMedia.speakers) || []).forEach(function (n) {
    var sl = slugifySpeaker(n);
    if (sl && !seen[sl]) { seen[sl] = true; out.push(sl); }
  });
  return out;
}

// One local file per speaker: the longest source on that speaker's tracks.
function timelinePlan(info) {
  var plan = [], missing = [];
  knownSpeakers().forEach(function (sp) {
    var tracks = FameCore.tracksForSpeaker(info, sp);
    var best = null;
    info.clips.forEach(function (cl) {
      if (tracks.indexOf(cl.track) < 0) return;
      if (cl.type !== "audio" || !cl.path || !mimeForPath(cl.path)) return;
      var len = cl.outPoint - cl.inPoint;
      if (!best || len > best.len) best = { path: cl.path, len: len };
    });
    if (best) {
      plan.push({ speaker: sp, path: best.path, name: sp + "__" + basename(best.path), mime: mimeForPath(best.path) });
    } else missing.push(sp);
  });
  return { plan: plan, missing: missing };
}

function analyzeTimeline() {
  if (!currentData) return;
  if (!can("readTimeline")) { setStatus(DAW_LABEL + " is not connected - " + dawStatus.reason, "error"); return; }
  setStatus("Reading your session…", "", true);
  hands.getClips().then(function (info) {
    clipsInfo = info;
    var r = timelinePlan(info);
    if (!r.plan.length) {
      setStatus(r.missing.length
        ? "Could not find a track for " + r.missing.join(", ") + " - name each speaker's track after them, then try again."
        : "No speakers known for this episode yet - press Analyze audio first.", "error");
      return;
    }
    var miss = r.missing.length ? " No track found for " + r.missing.join(", ") + ", so they will still come from the raw recordings." : "";
    confirmInPanel(
      "Analyse the audio on your timeline?",
      ["Sends " + r.plan.length + " file(s) from your session to this episode's Raw Masters folder on Drive, then re-runs the analysis on them.",
       "Use this when the raw recordings are quiet or noisy and the transcript came back inaccurate - your own cleaned audio transcribes far better.",
       r.plan.map(function (f) { return f.speaker + ": " + basename(f.path); }).join("   ") + miss],
      "Send and re-analyse",
      function () { runTimelineUpload(r.plan); },
    );
  }).catch(function (e) { setStatus(e.message, "error"); });
}

function runTimelineUpload(plan) {
  var slug = currentData.slug;
  $("btn-analyze").disabled = true;
  var i = 0;
  function next() {
    if (i >= plan.length) {
      logChange("Uploaded " + plan.length + " speaker master(s) from the timeline to Raw Masters and re-analysed on them");
      track("analyze");
      setStatus("", "");
      startCleanupAnalysis("Your own audio is uploaded. Transcribing it now - a few minutes, keep working.");
      return;
    }
    var f = plan[i];
    window.fame.fileSize(f.path).then(function (size) {
      if (!size) throw new Error("Could not read " + basename(f.path) + " - is the file still where " + DAW_LABEL + " expects it?");
      $("cl-sub").textContent = "Uploading " + basename(f.path) + " (" + (i + 1) + " of " + plan.length + ", " + (size / 1048576).toFixed(0) + " MB) to the episode's Raw Masters folder…";
      return apiFetch("/raw-master-session", { method: "POST", body: { slug: slug, filename: f.name, size: size, mimeType: f.mime } })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "Could not prepare the upload"); return j; }); })
        .then(function (sess) {
          // Bytes go from this machine straight to Drive, never through a
          // Fame server - the same path every upload in here takes.
          return window.fame.uploadFile({ filePath: f.path, sessionUri: sess.sessionUri, mimeType: f.mime });
        });
    }).then(function () { i++; next(); })
      .catch(function (e) {
        $("btn-analyze").disabled = false;
        $("cl-sub").textContent = "Upload failed: " + e.message;
      });
  }
  next();
}

function pollCleanupLoop() {
  stopCleanupPoll();
  if (!currentData) return;
  cleanupRequest("GET").then(function (j) {
    cleanupState = j.state;
    if (!cleanupState) { resetCleanup(); return; }
    if (cleanupState.status === "transcribing") {
      var done = 0;
      cleanupState.files.forEach(function (f) { if (f.transcriptStatus === "completed") done++; });
      $("cl-sub").textContent = "Transcribing " + cleanupState.files.length + " recording(s)… " + done + " done.";
      cleanupPollTimer = setTimeout(pollCleanupLoop, 6000);
    } else if (cleanupState.status === "error") {
      $("btn-analyze").disabled = false;
      $("btn-analyze").textContent = "Retry analysis";
      $("cl-sub").textContent = "Analysis failed: " + (cleanupState.error || "unknown error");
    } else if (cleanupState.status === "ready") {
      $("btn-analyze").disabled = false;
      $("btn-analyze").textContent = "Re-analyze";
      renderCleanup();
    }
  }).catch(function (e) {
    $("cl-sub").textContent = e.message;
    $("btn-analyze").disabled = false;
    $("btn-analyze").textContent = "Analyze audio";
  });
}

// Read the timeline (when Pro Tools can), then draw.
function renderCleanup() {
  if (!can("readTimeline")) { clipsInfo = null; renderCleanupWith(null, dawStatus.reason || (DAW_LABEL + " not connected")); return; }
  hands.getClips().then(function (info) {
    clipsInfo = info;
    renderCleanupWith(info, null);
  }).catch(function (e) {
    clipsInfo = null;
    renderCleanupWith(null, e.message);
  });
}

function renderCleanupWith(info, rawErr) {
  var body = $("cl-body");
  body.innerHTML = "";
  var cands = (cleanupState && cleanupState.candidates) || [];
  var clips = info ? info.clips : [];
  var mapped = 0;
  cands.forEach(function (c, i) {
    c._idx = i;
    c._seq = clips.length ? FameCore.mapCandidate(c, clips) : null;
    if (c._seq) mapped++;
    if (!(i in cleanupChecks)) cleanupChecks[i] = !!c.defaultOn && !!c._seq;
    if (!c._seq || c.overlapsSpeaker) cleanupChecks[i] = false;
  });
  var note;
  if (!info) note = DAW_LABEL + " timeline not readable" + (rawErr ? " - " + String(rawErr).replace(/\.$/, "") : "") + ".";
  else if (info.pending) note = "Waiting for " + DAW_LABEL + ".";
  else if (!clips.length && !(info.readErrors || []).length) note = "No clips in this session yet - import the raw recordings (or press Build audio assembly), then Refresh.";
  else if (cands.length && !mapped) {
    // Nothing landed. Say what was actually read - the first real AE saw
    // every row reading "not on timeline" with nothing explaining why.
    note = FameCore.unmappedReason(info, cands, DAW_LABEL);
  } else {
    note = mapped + " of " + cands.length + " found on your timeline.";
    if (cands.length > 20 && mapped > 0 && mapped < cands.length * 0.25) note += " Most sit outside what is on the timeline - if you are on a short section, that is expected.";
    if ((info.readErrors || []).length) note += " " + info.readErrors.length + " track(s) could not be read: " + info.readErrors[0] + ".";
  }
  var pol = cleanupState && cleanupState.policy;
  if (pol) {
    var styleWord = { standard: "standard", all: "heavy", none: "leave fillers in" }[pol.fillerStyle] || pol.fillerStyle;
    note += " Client style: " + styleWord + (pol.removeRepeats ? ", repeats on" : ", repeats off") +
      (pol.deadAirSeconds ? ", pauses over " + pol.deadAirSeconds + "s" : ", pauses kept") + ".";
  }
  $("cl-sub").textContent = (cands.length ? "Analysis done. " : "Analysis done - nothing to cut. Clean recording! ") + note;
  if (info && info.pending) showPending(body, info.next, info.file || info.sessionPath);
  else if (info && info.archive) {
    var arc = document.createElement("div");
    arc.className = "cl-notes";
    arc.textContent = "Timeline read from " + info.archive + " - export again after you re-arrange, then Refresh.";
    body.appendChild(arc);
  }
  if (pol && pol.cleanupNotes) {
    var n2 = document.createElement("div");
    n2.className = "cl-notes";
    n2.textContent = "Note from the AM: " + pol.cleanupNotes;
    body.appendChild(n2);
  }
  // When the analysis read the untouched Riverside recordings, point at the
  // better source - the editor's own audio - rather than waiting for them to
  // wonder why a filler was misheard.
  var readRaw = ((cleanupState && cleanupState.files) || []).some(function (f) { return /^riverside[_-]/i.test(f.name || ""); });
  if (readRaw && cands.length && can("readTimeline")) {
    var tip = document.createElement("div");
    tip.className = "cl-notes";
    tip.textContent = "This analysis read the untouched Riverside recordings. If your tracks hold cleaned or levelled audio, press \u201cAnalyze what's on my timeline\u201d - a transcript of processed audio mishears far fewer words, so fewer fillers are missed.";
    body.appendChild(tip);
  }
  if (cleanupState && cleanupState.audioFromVideo) {
    var afv = document.createElement("div");
    afv.className = "cl-notes";
    afv.textContent = "No separate audio files were in Raw Assets, so the speech was read from the camera files. Breath and click detection is less precise on camera audio.";
    body.appendChild(afv);
  }
  if (cleanupState && cleanupState.audioScanPartial && cleanupState.audioScanPartial.length) {
    var warn = document.createElement("div");
    warn.className = "cl-notes";
    warn.textContent = "Heads up: the audio scan ran out of time on " + cleanupState.audioScanPartial.join(", ") + " - their breath list is incomplete. Re-analyze to try again.";
    body.appendChild(warn);
  }
  renderAudioIssues(body);
  if (!cands.length) { renderDeliverCard(); return; }

  var groups = [
    { title: "Filler words (longest first)", pred: function (c) { return c.kind === "filler" && c.defaultOn && !c.overlapsSpeaker; }, sortByLength: true },
    { title: "Repeated words", pred: function (c) { return c.kind === "repeat" && !c.overlapsSpeaker; } },
    { title: "Dead air", pred: function (c) { return c.kind === "dead_air"; } },
    { title: "Breaths (longest first - your call)", pred: function (c) { return c.kind === "breath" && !c.overlapsSpeaker; }, sortByLength: true, mutable: "breaths" },
    { title: "Mouth clicks", pred: function (c) { return c.kind === "click" && !c.overlapsSpeaker; }, mutable: "clicks" },
    { title: "Maybe fillers (hmm, ah - long ones are pre-ticked)", pred: function (c) { return c.kind === "filler" && !c.defaultOn && !c.overlapsSpeaker; } },
    { title: "Like / you know (your call)", pred: function (c) { return c.kind === "lexical" && !c.overlapsSpeaker; } },
    // A ripple cut removes that moment from EVERY track - cutting one of
    // these would clip the words the other person was saying over it.
    { title: "Spoken over - cutting would clip the other person", pred: function (c) { return !!c.overlapsSpeaker; }, mutable: "spoken-over fillers", muteOnly: true },
  ];
  groups.forEach(function (g) {
    var items = cands.filter(g.pred);
    if (!items.length) return;
    if (g.sortByLength) items = items.slice().sort(function (a, b) { return (b.endSec - b.startSec) - (a.endSec - a.startSec); });
    var box = document.createElement("div");
    box.className = "cl-group";
    var head = document.createElement("div");
    head.className = "cl-group-head";
    if (!g.muteOnly) {
      var master = document.createElement("input");
      master.type = "checkbox";
      master.checked = items.every(function (c) { return cleanupChecks[c._idx] || !c._seq; }) && items.some(function (c) { return cleanupChecks[c._idx]; });
      master.onchange = function () {
        items.forEach(function (c) { if (c._seq) cleanupChecks[c._idx] = master.checked; });
        renderCleanupWith(info, rawErr);
      };
      head.appendChild(master);
    }
    head.appendChild(document.createTextNode(g.title + " "));
    var n = document.createElement("span");
    n.className = "n";
    n.textContent = "(" + items.length + ")";
    head.appendChild(n);
    if (g.mutable && can("silence")) {
      var muteBtn = document.createElement("button");
      muteBtn.className = "btn-ghost";
      muteBtn.style.marginLeft = "8px";
      muteBtn.textContent = "Silence instead";
      muteBtn.title = "Clear these from the speaker's own track(s) only - no ripple, the session length does not change." + (FILE_BASED ? " Written as an archive you import." : " One Undo step each in " + DAW_LABEL + ".");
      muteBtn.onclick = (function (its, label) {
        return function () { silenceCandidates(its.filter(function (c) { return c._seq; }), label); };
      })(items, g.mutable);
      head.appendChild(muteBtn);
    }
    box.appendChild(head);

    var byWord = {};
    items.forEach(function (c) {
      var w = (c.text || "").toLowerCase();
      (byWord[w] = byWord[w] || []).push(c);
    });
    var words = Object.keys(byWord);
    if (words.length > 1 && items.length > 6 && !g.muteOnly) {
      var chipRow = document.createElement("div");
      chipRow.className = "chips cl-chips";
      words.sort(function (a, b) { return byWord[b].length - byWord[a].length; });
      words.forEach(function (w) {
        var group = byWord[w];
        var on = group.every(function (c) { return cleanupChecks[c._idx] || !c._seq; }) && group.some(function (c) { return cleanupChecks[c._idx]; });
        var chip = document.createElement("button");
        chip.className = "chip cl-chip" + (on ? " active" : "");
        chip.textContent = w + " ×" + group.length;
        chip.title = on ? "Untick all" : "Tick all";
        chip.onclick = function () {
          group.forEach(function (c) { if (c._seq) cleanupChecks[c._idx] = !on; });
          renderCleanupWith(info, rawErr);
        };
        chipRow.appendChild(chip);
      });
      box.appendChild(chipRow);
    }

    items.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "cl-row" + (c._seq ? "" : " unmapped");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!cleanupChecks[c._idx] && !c.overlapsSpeaker;
      cb.disabled = !c._seq || !!c.overlapsSpeaker;
      if (c.overlapsSpeaker) cb.title = "Cutting this would also clip " + c.overlapsSpeaker + "'s words - use Silence instead.";
      cb.onchange = function () { cleanupChecks[c._idx] = cb.checked; updateApplyCount(); };
      row.appendChild(cb);
      var what = document.createElement("span");
      what.className = "cl-what";
      if (c.kind === "dead_air") what.textContent = (c.endSec - c.startSec).toFixed(1) + "s silence";
      else if (c.kind === "breath" || c.kind === "click") what.textContent = c.text + " (" + Math.round((c.endSec - c.startSec) * 1000) + "ms)" + (c.speaker ? " · " + c.speaker : "");
      else what.textContent = (c.kind === "repeat" ? 'repeat: "' : '"') + c.text + '"' + (c.speaker ? " · " + c.speaker : "");
      row.appendChild(what);
      if (c.severe) {
        var sv = document.createElement("span");
        sv.className = "badge client";
        sv.textContent = "long";
        sv.title = "A drawn-out filler - the kind most worth removing.";
        row.appendChild(sv);
      }
      if (c.overlapsSpeaker) {
        var ob = document.createElement("span");
        ob.className = "badge internal";
        ob.textContent = "over " + c.overlapsSpeaker;
        row.appendChild(ob);
      }
      var t = document.createElement("button");
      t.className = "cl-t";
      t.textContent = c._seq ? fmtTime(c._seq.s) : "not on timeline";
      if (c._seq) {
        t.title = "Jump there and play";
        t.onclick = function () { jump(c._seq.s); };
      } else t.disabled = true;
      row.appendChild(t);
      box.appendChild(row);
    });
    body.appendChild(box);
  });

  var actions = document.createElement("div");
  actions.className = "cl-actions";
  var apply = document.createElement("button");
  apply.className = "btn-primary";
  apply.id = "btn-apply-cuts";
  apply.disabled = !can("rippleCut");
  apply.onclick = function () { confirmApplyCuts(); };
  actions.appendChild(apply);
  var note2 = document.createElement("span");
  note2.className = "cl-note";
  note2.textContent = can("rippleCut")
    ? (FILE_BASED ? "Writes a cut copy of the exported tracks (ripple, " + FADE_MS + "ms fades) for you to import - the originals stay as your undo." : "Ripple, every track, " + FADE_MS + "ms fades on each seam. Undo in " + DAW_LABEL + " puts each cut back.")
    : (FILE_BASED ? "Pick the exchange folder and export the tracks first." : "Needs " + DAW_LABEL + " 2025.10+ connected.");
  actions.appendChild(note2);
  body.appendChild(actions);
  updateApplyCount();
  renderDeliverCard();
}

function renderAudioIssues(body) {
  var issues = (cleanupState && cleanupState.audioIssues) || [];
  if (!issues.length) return;
  var box = document.createElement("div");
  box.className = "cl-group";
  var head = document.createElement("div");
  head.className = "cl-group-head";
  head.appendChild(document.createTextNode("Audio issues "));
  var n = document.createElement("span");
  n.className = "n";
  n.textContent = "(" + issues.length + ")";
  head.appendChild(n);
  box.appendChild(head);
  issues.forEach(function (is) {
    var row = document.createElement("div");
    row.className = "ai-row";
    var b = document.createElement("span");
    b.className = "badge internal";
    b.textContent = String(is.kind || "").replace(/_/g, " ");
    row.appendChild(b);
    var what = document.createElement("span");
    what.className = "cl-what";
    what.textContent = is.message || "";
    row.appendChild(what);
    var dB = Number(is.deltaDb) || 0;
    // Fix levels: the #1 client audio complaint. Refused at 30 dB and
    // over - that is a broken or bleeding mic, not a fader problem.
    if (is.kind === "speaker_imbalance" && is.speaker && dB !== 0 && Math.abs(dB) < MAX_LEVEL_FIX_DB) {
      if (levelsApplied[is.speaker] != null) {
        var ap = document.createElement("span");
        ap.className = "applied";
        ap.textContent = (levelsApplied[is.speaker] > 0 ? "+" : "") + levelsApplied[is.speaker].toFixed(1) + " dB applied";
        row.appendChild(ap);
      } else if (can("trackGain")) {
        var fix = document.createElement("button");
        fix.className = "fix-btn";
        var val = -dB;
        fix.textContent = "Fix levels: " + (val > 0 ? "+" : "") + val.toFixed(1) + " dB on " + is.speaker;
        fix.title = FILE_BASED ? "Writes the difference into the exported tracks' event volume, or tells you the fader value if the export carries none." : "Writes the difference as volume automation on this speaker's own track(s). Undo in " + DAW_LABEL + " reverts it.";
        fix.onclick = function () { applyLevelFix(is.speaker, val, fix); };
        row.appendChild(fix);
      }
    } else if (is.startSec != null) {
      var t = document.createElement("button");
      t.className = "cl-t";
      var m = clipsInfo ? FameCore.mapCandidate({ speaker: is.speaker, file: "", startSec: is.startSec, endSec: Math.max(is.endSec || 0, is.startSec + 0.1) }, clipsInfo.clips) : null;
      t.textContent = fmtTime(m ? m.s : is.startSec);
      t.onclick = function () { jump(m ? m.s : is.startSec); };
      row.appendChild(t);
    }
    box.appendChild(row);
  });
  body.appendChild(box);
}

function applyLevelFix(speaker, dB, btn) {
  if (!clipsInfo) { setStatus("Read the timeline first - press Refresh.", "error"); return; }
  var tracks = FameCore.tracksForSpeaker(clipsInfo, speaker);
  if (!tracks.length) { setStatus("Could not find " + speaker + "'s track - name the track or its clips after the speaker, then Refresh.", "error"); return; }
  btn.disabled = true;
  setStatus("Applying " + dB.toFixed(1) + " dB to " + speaker + "'s track" + (tracks.length > 1 ? "s" : "") + "…", "", true);
  hands.setTrackGainDb(tracks, dB).then(function (r) {
    levelsApplied[speaker] = dB;
    track("fix_levels");
    logChange("Fix levels: " + (dB > 0 ? "+" : "") + dB.toFixed(1) + " dB on " + speaker + " to match the other speaker");
    renderCleanupWith(clipsInfo, null);
    afterHands(r, (dB > 0 ? "+" : "") + dB.toFixed(1) + " dB for " + speaker + " on " + r.tracks + " track(s)." + (r.note ? " " + r.note : ""));
  }).catch(function (e) { btn.disabled = false; setStatus(e.message, "error"); });
}

function updateApplyCount() {
  var btn = $("btn-apply-cuts");
  if (!btn) return;
  var n = 0;
  Object.keys(cleanupChecks).forEach(function (k) { if (cleanupChecks[k]) n++; });
  btn.textContent = "Apply " + n + " cut" + (n === 1 ? "" : "s");
  btn.disabled = n === 0 || !can("rippleCut");
}

function confirmApplyCuts() {
  var merged = FameCore.selectedRanges((cleanupState && cleanupState.candidates) || [], cleanupChecks);
  if (!merged.length) return;
  confirmInPanel(
    "Ripple-cut " + merged.length + " range" + (merged.length === 1 ? "" : "s") + " from every track?",
    FILE_BASED
      ? ["Later material moves up to close each gap, with a " + FADE_MS + "ms fade on every seam.", "A cut copy of the exported tracks is written to the exchange folder for you to import - your original tracks stay as the undo."]
      : ["Later material moves up to close each gap, with a " + FADE_MS + "ms fade on every seam (needs a fade preset named \"Fame 10ms\" - see the working procedure).", DAW_LABEL + "' Undo puts each cut back."],
    "Apply cuts",
    function () { applyCleanupCuts(merged); },
  );
}

function applyCleanupCuts(merged) {
  setStatus("Applying " + merged.length + " cut(s)…", "", true);
  track("apply_cuts");
  hands.applyRippleCuts(merged).then(function (r) {
    logChange("Cleanup pass: applied " + r.applied + " ripple cut(s) with " + FADE_MS + "ms fades");
    $("cl-sub").textContent = "Cuts applied. Press Refresh to re-map what is left; if you re-edit heavily, Re-analyze before applying more.";
    cleanupChecks = {};
    var pend = r.pending ? r : null;
    renderCleanup();
    var msg = r.applied + " cut(s) applied" + (r.fadesSkipped ? " - " + r.fadesSkipped : " with fades on every seam") + ".";
    if (pend) setTimeout(function () { afterHands(pend, msg); }, 0);
    else setStatus(msg, r.fadesSkipped ? "error" : "ok");
  }).catch(function (e) { setStatus("Applying cuts failed: " + e.message, "error"); });
}

// Silence on the speaker's OWN tracks (no ripple) - breaths, clicks and
// the spoken-over fillers a ripple cut would clip.
function silenceCandidates(items, label) {
  if (!clipsInfo) { setStatus("Read the timeline first - press Refresh.", "error"); return; }
  var bySpeaker = {};
  items.forEach(function (c) {
    if (!c._seq || !c.speaker) return;
    (bySpeaker[c.speaker] = bySpeaker[c.speaker] || []).push({ s: c._seq.s, e: c._seq.e });
  });
  var specs = [], unmatched = [];
  Object.keys(bySpeaker).forEach(function (sp) {
    var tracks = FameCore.tracksForSpeaker(clipsInfo, sp);
    if (!tracks.length) unmatched.push(sp); else specs.push({ tracks: tracks, ranges: bySpeaker[sp] });
  });
  if (!specs.length) { setStatus("Could not match any speaker to a track - name the track or its clips after the speaker (e.g. \"Denis\").", "error"); return; }
  var total = specs.reduce(function (a, s) { return a + s.ranges.length; }, 0);
  confirmInPanel(
    "Silence " + total + " " + label + " on the speakers' own tracks?",
    ["Each range is cleared from that speaker's track(s) only - a gap, no ripple, session length unchanged, fades on both edges.", FILE_BASED ? "Written as a silenced copy of the exported tracks for you to import." : "One Undo step per range in " + DAW_LABEL + "."],
    "Silence them",
    function () {
      setStatus("Silencing " + label + "…", "", true);
      hands.silenceRanges(specs).then(function (r) {
        track("mute");
        logChange("Silenced " + r.silenced + " " + label + " on the speakers' own tracks (no ripple)");
        var msg = r.silenced + " range(s) silenced on " + r.tracks + " track(s) - session length unchanged.";
        if (unmatched.length) msg += " No track found for: " + unmatched.join(", ") + ".";
        if (r.fadesSkipped) msg += " " + r.fadesSkipped + ".";
        renderCleanup();
        if (r.pending) setTimeout(function () { afterHands(r, msg); }, 0);
        else setStatus(msg, unmatched.length || r.fadesSkipped ? "error" : "ok");
      }).catch(function (e) { setStatus("Silencing failed: " + e.message, "error"); });
    },
  );
}

function muteOffMic() {
  var quiet = (cleanupState && cleanupState.speakerQuietRanges) || [];
  if (!quiet.length || !clipsInfo) return;
  var specs = [], total = 0;
  quiet.forEach(function (q) {
    var tracks = FameCore.tracksForSpeaker(clipsInfo, q.speaker);
    if (!tracks.length) return;
    var ranges = [];
    (q.ranges || []).forEach(function (r) {
      var m = FameCore.mapCandidate({ speaker: q.speaker, file: "", startSec: r.startSec, endSec: r.endSec }, clipsInfo.clips);
      if (m && m.e - m.s >= 0.8) ranges.push({ s: m.s, e: m.e });
    });
    if (ranges.length) { specs.push({ tracks: tracks, ranges: ranges }); total += ranges.length; }
  });
  if (!total) { setStatus("No off-mic stretch landed on a matching track.", "error"); return; }
  confirmInPanel("Silence " + total + " off-mic stretch(es)?",
    ["Each speaker's track is cleared wherever they are NOT talking - mic bleed, chair creaks, off-mic breaths. No ripple."],
    "Silence them",
    function () {
      setStatus("Silencing off-mic stretches…", "", true);
      hands.silenceRanges(specs).then(function (r) {
        track("mute");
        logChange("Silenced " + r.silenced + " off-mic stretch(es) on the speakers' own tracks");
        renderCleanup();
        var m2 = r.silenced + " off-mic range(s) silenced on " + r.tracks + " track(s)." + (r.fadesSkipped ? " " + r.fadesSkipped + "." : "");
        if (r.pending) setTimeout(function () { afterHands(r, m2); }, 0); else setStatus(m2, "ok");
      }).catch(function (e) { setStatus(e.message, "error"); });
    });
}

$("btn-analyze").onclick = function () { track("analyze"); startCleanupAnalysis(); };
$("btn-analyze-timeline").onclick = analyzeTimeline;

// ---------- Build audio assembly ----------
// One track per speaker from the raw masters the ANALYSIS picked (so
// Raw Masters hand-naming and VO exclusion are already solved), then the
// pre-ticked cuts and the level fix. Files come from the AE's own disk.

function assemblyPlan() {
  return ((cleanupState && cleanupState.files) || []).filter(function (f) { return f.role !== "sync"; })
    .map(function (f) { return { name: f.name, speaker: f.speaker }; });
}

function findRawFolder(wanted) {
  var dirs = [];
  ((clipsInfo && clipsInfo.clips) || []).forEach(function (cl) {
    var d = String(cl.path || "").replace(/[\\/][^\\/]*$/, "");
    if (d && dirs.indexOf(d) < 0) dirs.push(d);
  });
  var chain = Promise.resolve(null);
  dirs.forEach(function (d) {
    chain = chain.then(function (found) {
      if (found) return found;
      return window.fame.listDir(d).then(function (names) {
        var lower = names.map(function (n) { return n.toLowerCase(); });
        return wanted.some(function (w) { return lower.indexOf(w.toLowerCase()) >= 0; }) ? d : null;
      });
    });
  });
  return chain;
}

function buildAssembly() {
  if (!cleanupState || cleanupState.status !== "ready") { setStatus("Run Analyze first - the assembly uses the recordings the analysis picked.", "error"); return; }
  if (!can("assembly")) { setStatus(FILE_BASED ? "Pick the exchange folder first (" + DAW_LABEL + " setup)." : DAW_LABEL + " 2025.10+ must be connected.", "error"); return; }
  var plan = assemblyPlan();
  if (!plan.length) { setStatus("The analysis found no recordings to lay out.", "error"); return; }
  confirmInPanel(
    "Lay out " + plan.length + " raw recording(s) as new tracks?",
    ["One track per speaker, added to the session at 0 - nothing existing is touched.",
     FILE_BASED ? "The pre-ticked cleanup cuts and the level fix are baked into clean copies of the files, and a track archive is written for you to import." : "Then the pre-ticked cleanup cuts and the level fix are applied to it.",
     plan.map(function (f) { return f.name + (f.speaker ? "  (" + f.speaker + ")" : ""); }).join("   ")],
    "Build it",
    function () { runAssembly(plan); },
  );
}

function runAssembly(plan) {
  var wanted = plan.map(function (f) { return f.name; });
  setStatus("Looking for the raw recordings…", "", true);
  findRawFolder(wanted).then(function (dir) {
    if (dir) return dir;
    setStatus("Pick the folder that holds the episode's raw recordings.", "");
    return window.fame.pickFolder({ title: "Pick the episode's raw recordings folder" });
  }).then(function (dir) {
    if (!dir) { setStatus("", ""); return; }
    return window.fame.listDir(dir).then(function (names) {
      var byLower = {};
      names.forEach(function (n) { byLower[n.toLowerCase()] = n; });
      var present = [], missing = [];
      plan.forEach(function (f) {
        var actual = byLower[f.name.toLowerCase()];
        if (actual) present.push({ path: dir + (dir.indexOf("\\") >= 0 ? "\\" : "/") + actual, name: f.speaker || actual.replace(/\.[^.]+$/, "") });
        else missing.push(f.name);
      });
      if (!present.length) {
        setStatus("None of the episode's recordings are in " + dir + ". Download them from the episode's Raw Assets folder on Drive first (" + wanted.join(", ") + ").", "error");
        return;
      }
      setStatus("Laying out " + present.length + " track(s)…", "", true);
      track("assembly");
      if (FILE_BASED) return runAssemblyFileBased(present, missing, dir);
      return hands.buildAssembly(present).then(function (r) {
        logChange("Built the audio assembly: " + r.added + " speaker track(s) from the raw masters");
        cleanupChecks = {};
        return hands.getClips().then(function (info) {
          clipsInfo = info;
          renderCleanupWith(info, null);
          var merged = FameCore.selectedRanges(cleanupState.candidates || [], cleanupChecks);
          var next = merged.length ? hands.applyRippleCuts(merged).then(function (rc) {
            logChange("Assembly: applied " + rc.applied + " pre-ticked cleanup cut(s)");
            cleanupChecks = {};
            return " " + rc.applied + " pre-ticked cut(s) applied" + (rc.fadesSkipped ? " (" + rc.fadesSkipped + ")" : "") + ".";
          }) : Promise.resolve("");
          return next.then(function (cutMsg) {
            var issues = (cleanupState.audioIssues || []).filter(function (is) {
              var dB = Number(is.deltaDb) || 0;
              return is.kind === "speaker_imbalance" && is.speaker && dB !== 0 && Math.abs(dB) < MAX_LEVEL_FIX_DB && levelsApplied[is.speaker] == null;
            });
            var lvl = Promise.resolve("");
            issues.forEach(function (is) {
              lvl = lvl.then(function (acc) {
                return hands.getClips().then(function (info2) {
                  clipsInfo = info2;
                  var tracks = FameCore.tracksForSpeaker(info2, is.speaker);
                  if (!tracks.length) return acc;
                  var dB = -Number(is.deltaDb);
                  return hands.setTrackGainDb(tracks, dB).then(function () {
                    levelsApplied[is.speaker] = dB;
                    logChange("Fix levels: " + (dB > 0 ? "+" : "") + dB.toFixed(1) + " dB on " + is.speaker);
                    return acc + " Levels matched (" + (dB > 0 ? "+" : "") + dB.toFixed(1) + " dB on " + is.speaker + ").";
                  });
                });
              });
            });
            return lvl.then(function (lvlMsg) {
              var miss = missing.length ? " Missing from that folder: " + missing.join(", ") + "." : "";
              setStatus(r.added + " speaker track(s) laid out from " + dir + "." + cutMsg + lvlMsg + miss, missing.length ? "error" : "ok");
              renderCleanup();
            });
          });
        });
      });
    });
  }).catch(function (e) { setStatus("Assembly failed: " + e.message, "error"); });
}

// File-based DAW: the timeline is the files laid out 1:1 from 0, so the
// pre-ticked cuts (raw-file seconds already) and the level fix go INTO
// clean copies of the files with ffmpeg, and the editor imports one
// generated archive. No second round trip.
function runAssemblyFileBased(present, missing, dir) {
  var cands = (cleanupState && cleanupState.candidates) || [];
  var issues = (cleanupState && cleanupState.audioIssues) || [];
  var files = present.map(function (f) {
    var base = basename(f.path).toLowerCase();
    var cuts = [];
    cands.forEach(function (c) {
      if (!c.defaultOn || c.overlapsSpeaker) return;
      var mine = (c.file && String(c.file).toLowerCase() === base) || (!c.file && c.speaker && f.name && String(f.name).toLowerCase() === String(c.speaker).toLowerCase());
      if (mine && c.endSec > c.startSec) cuts.push({ s: c.startSec, e: c.endSec });
    });
    var gainDb = 0;
    issues.forEach(function (is) {
      var dB = Number(is.deltaDb) || 0;
      if (is.kind === "speaker_imbalance" && is.speaker && f.name && String(is.speaker).toLowerCase() === String(f.name).toLowerCase() && dB !== 0 && Math.abs(dB) < MAX_LEVEL_FIX_DB) gainDb = -dB;
    });
    return { path: f.path, name: f.name, cuts: cuts, gainDb: gainDb };
  });
  // dead-air candidates are cross-speaker: the same range must leave every file so sync holds
  var shared = [];
  cands.forEach(function (c) { if (c.defaultOn && c.kind === "dead_air" && c.endSec > c.startSec) shared.push({ s: c.startSec, e: c.endSec }); });
  if (shared.length) files.forEach(function (f) { f.cuts = f.cuts.filter(function (r) { return !shared.some(function (x) { return x.s === r.s && x.e === r.e; }); }).concat(shared); });
  var nCuts = files.reduce(function (a, f) { return a + f.cuts.length; }, 0);
  setStatus("Cutting " + nCuts + " range(s) into clean copies and writing the archive…", "", true);
  return hands.buildAssembly(files).then(function (r) {
    logChange("Built the audio assembly for " + DAW_LABEL + ": " + r.added + " speaker track(s)" + (nCuts ? ", " + nCuts + " pre-ticked cut(s) baked into the files" : ""));
    files.forEach(function (f) { if (f.gainDb) { levelsApplied[f.name] = f.gainDb; logChange("Fix levels: " + (f.gainDb > 0 ? "+" : "") + f.gainDb.toFixed(1) + " dB baked into " + f.name); } });
    cleanupChecks = {};
    cands.forEach(function (c) { cleanupChecks[c._idx != null ? c._idx : cands.indexOf(c)] = false; });
    renderCleanup();
    var miss = missing.length ? " Missing from that folder: " + missing.join(", ") + "." : "";
    setTimeout(function () {
      afterHands(r, r.added + " speaker track(s) laid out" + (nCuts ? ", " + nCuts + " cut(s) and the level fix baked into the files" : "") + "." + miss);
      $("cl-sub").textContent = "Assembly written. The pre-ticked cuts are already in the clean files, so the list above is unticked - import the archive, then export again if you want more.";
    }, 0);
  });
}

$("btn-assembly").onclick = buildAssembly;

// ---------- episode brief ----------

var briefData = null;

function loadBrief() {
  if (!currentData) return;
  apiFetch("/brief?slug=" + encodeURIComponent(currentData.slug))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (b) { briefData = b; renderBrief(); renderDeliverCard(); })
    .catch(function () {});
}

function renderBrief() {
  var host = $("brief");
  if (!briefData) { host.className = "hidden"; return; }
  host.innerHTML = "";
  host.className = "";
  var title = document.createElement("div");
  title.className = "b-title";
  title.textContent = (briefData.showName || briefData.clientCode || "") + (briefData.guestName ? " · guest: " + briefData.guestName : "");
  host.appendChild(title);
  function row(label, value) {
    if (!value) return;
    var d = document.createElement("div");
    d.className = "b-row";
    var b = document.createElement("b");
    b.textContent = label + ": ";
    d.appendChild(b);
    d.appendChild(document.createTextNode(value));
    host.appendChild(d);
  }
  row("Team", (briefData.people || []).map(function (p) { return p.name + " (" + p.role + ")"; }).join(", "));
  if (briefData.houseStyle && briefData.houseStyle.notes) row("House notes", briefData.houseStyle.notes);
  // Shot rules are video framing conventions - deliberately not shown to AEs.
  if (briefData.watchouts && briefData.watchouts.length) {
    var w = document.createElement("div");
    w.className = "b-row";
    var wb = document.createElement("b");
    wb.textContent = "This client's watch-outs: ";
    w.appendChild(wb);
    host.appendChild(w);
    briefData.watchouts.forEach(function (line) {
      var li = document.createElement("div");
      li.className = "b-watchout";
      li.textContent = "• " + line;
      host.appendChild(li);
    });
  }
  if (briefData.rawMedia && briefData.rawMedia.fileCount) {
    row("Raw files", briefData.rawMedia.fileCount + " (" +
      (briefData.rawMedia.perSpeakerAudio === "yes" ? "per-speaker audio present" : briefData.rawMedia.perSpeakerAudio === "no" ? "NO per-speaker audio" : "audio layout unknown") + ")");
  }
}

// ---------- Deliver: bounce, measure, preflight, upload ----------

var upload = { stage: "idle", assetId: null, file: null, measured: null, preflight: null, worst: null, msg: "", version: null };
var precheck = null;
var music = null;

function audioAssets() {
  var all = (briefData && briefData.assets) || [];
  var list = all.filter(function (a) { return a.kind === "audio"; });
  return list.length ? list : all.filter(function (a) { return a.kind !== "design"; });
}

function renderDeliverCard() {
  var host = $("deliver");
  if (!currentData || !briefData) { host.className = "hidden"; return; }
  host.className = "";
  host.innerHTML = "";
  var eb = document.createElement("div");
  eb.className = "eyebrow";
  eb.textContent = "Deliver";
  host.appendChild(eb);
  var assets = audioAssets();
  if (!assets.length) {
    var none = document.createElement("div");
    none.className = "cl-sub";
    none.textContent = "This episode has no audio asset yet - the PM creates it in the review tool.";
    host.appendChild(none);
    return;
  }
  if (!upload.assetId || !assets.some(function (a) { return a.id === upload.assetId; })) upload.assetId = assets[0].id;
  var sel = document.createElement("select");
  assets.forEach(function (a) {
    var o = document.createElement("option");
    o.value = a.id;
    o.textContent = a.name + " (" + a.kind + ", v" + ((a.versions || 0) + 1) + " next)";
    if (a.id === upload.assetId) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = function () { upload.assetId = sel.value; };
  host.appendChild(sel);

  var busy = upload.stage === "rendering" || upload.stage === "measuring" || upload.stage === "preflight" || upload.stage === "uploading";
  var row = document.createElement("div");
  row.className = "d-row";
  var render = document.createElement("button");
  render.className = "btn-primary";
  render.textContent = FILE_BASED ? "Export mixdown + check" : "Bounce + check";
  render.disabled = busy || !can("render");
  render.title = can("render")
    ? (FILE_BASED ? "You run File > Export > Audio Mixdown into the exchange folder; the Plugin picks the file up and runs loudness, true peak and preflight." : "Offline bounce of the mix to MP3 320 into a 'Fame renders' folder beside your session, then loudness, true peak and preflight.")
    : (FILE_BASED ? "Pick the exchange folder first." : "Needs " + DAW_LABEL + " connected.");
  render.onclick = function () {
    if (FILE_BASED) {
      confirmInPanel("Wait for your mixdown and run the checks?",
        ["In " + DAW_LABEL + ": File > Export > Audio Mixdown, MP3 320 kbps (or WAV), saved into the exchange folder.", "The Plugin picks it up when the file finishes writing. Nothing is uploaded until you press Upload."],
        "I'll export now", function () { prepareUpload(null); }, host);
      return;
    }
    confirmInPanel("Bounce the whole session to MP3 320 and run the checks?",
      ["Offline bounce of the main mix, saved next to your session in 'Fame renders'.", "Nothing is uploaded until you press Upload."],
      "Bounce", function () { prepareUpload(null); }, host);
  };
  row.appendChild(render);
  var choose = document.createElement("button");
  choose.className = "btn-ghost";
  choose.textContent = "Choose a bounced file…";
  choose.disabled = busy;
  choose.title = FILE_BASED ? "Exported somewhere else? Pick the file and it gets the same checks." : "Already bounced with your own chain? Pick the file and it gets the same checks.";
  choose.textContent = FILE_BASED ? "Choose an exported file…" : "Choose a bounced file…";
  choose.onclick = function () {
    window.fame.pickFile({ title: "Choose the bounced audio master" }).then(function (p) { if (p) prepareUpload(p); });
  };
  row.appendChild(choose);
  var pc = document.createElement("button");
  pc.className = "btn-ghost";
  pc.textContent = "Check comments";
  pc.title = "Which open comments still look unaddressed on this timeline. Advisory only.";
  pc.onclick = runCommentPrecheck;
  row.appendChild(pc);
  var mb = document.createElement("button");
  mb.className = "btn-ghost";
  mb.textContent = "Check music balance";
  mb.disabled = !can("readTimeline");
  mb.title = "Compares music and effects against the conversation, both measured the same way - the 'music is too loud' complaint, caught before you bounce.";
  mb.onclick = checkMusicBalance;
  row.appendChild(mb);
  host.appendChild(row);

  if (upload.msg) {
    var m = document.createElement("div");
    m.className = "d-msg " + (upload.stage === "done" ? "ok" : (upload.stage === "ready" && upload.worst === "fail") ? "error" : "");
    m.textContent = upload.msg;
    host.appendChild(m);
  }
  if (upload.stage === "uploading") {
    var pr = document.createElement("div");
    pr.className = "progress";
    var bar = document.createElement("div");
    bar.id = "upload-progress";
    pr.appendChild(bar);
    host.appendChild(pr);
  }
  if (upload.file && upload.measured && (upload.stage === "ready" || upload.stage === "uploading" || upload.stage === "done")) {
    var me = upload.measured;
    var meas = document.createElement("div");
    meas.className = "d-meas";
    meas.textContent = basename(upload.file) + " - " + fmtTime(me.durationSec || 0) + ", " +
      (me.lufs != null ? me.lufs.toFixed(1) + " LUFS" : "loudness n/a") + ", " +
      (me.truePeakDb != null ? me.truePeakDb.toFixed(1) + " dBTP" : "true peak n/a") +
      (me.channels ? ", " + (me.channels === 1 ? "mono" : me.channels === 2 ? "stereo" : me.channels + " ch") : "");
    host.appendChild(meas);
    (upload.preflight || []).forEach(function (r) {
      var v = r.verdict || r.status || "pass";
      if (v === "skip") return;
      var d = document.createElement("div");
      d.className = "pf-row";
      var icon = document.createElement("span");
      icon.className = "pf-icon";
      icon.textContent = v === "fail" ? "❌" : v === "warn" ? "⚠️" : "✅";
      d.appendChild(icon);
      d.appendChild(document.createTextNode(r.message || r.label || ""));
      host.appendChild(d);
    });
    if (upload.stage === "ready") {
      var go = document.createElement("button");
      go.className = "btn-primary";
      go.style.marginTop = "8px";
      go.textContent = upload.worst === "fail" ? "Upload anyway" : "Upload as v" + nextVersionLabel(upload.assetId);
      go.onclick = doUpload;
      host.appendChild(go);
    }
  }
  if (music) {
    (music.rows || []).forEach(function (r) {
      var d = document.createElement("div");
      d.className = "d-meas";
      d.textContent = r;
      host.appendChild(d);
    });
    var mm = document.createElement("div");
    mm.className = "d-msg " + (music.verdict === "warn" ? "error" : "");
    mm.textContent = music.note || "";
    host.appendChild(mm);
  }
  if (precheck) {
    var pn = document.createElement("div");
    pn.className = "d-msg";
    pn.textContent = precheck.running ? "Checking open comments against your timeline…" : precheck.note;
    host.appendChild(pn);
    (precheck.unaddressed || []).forEach(function (x) {
      var r = document.createElement("div");
      r.className = "cl-row";
      var t = document.createElement("button");
      t.className = "cl-t";
      t.textContent = fmtTime(x.at);
      t.onclick = function () { jump(x.at); };
      r.appendChild(t);
      var w = document.createElement("span");
      w.className = "cl-what";
      w.textContent = (x.comment.authorName || "") + ": " + (x.comment.text || "");
      w.title = x.comment.text || "";
      r.appendChild(w);
      host.appendChild(r);
    });
  }
}

function nextVersionLabel(assetId) {
  var a = audioAssets().filter(function (x) { return x.id === assetId; })[0];
  return a ? (a.versions || 0) + 1 : "?";
}

function uploadStage(stage, msg) {
  upload.stage = stage;
  upload.msg = msg || "";
  renderDeliverCard();
}

function prepareUpload(filePath) {
  if (!currentData || !upload.assetId) return;
  var start = filePath ? Promise.resolve(filePath) : (function () {
    uploadStage("rendering", FILE_BASED ? "Waiting for your mixdown in the exchange folder…" : "Bouncing the mix to MP3 320… this runs offline, faster than real time.");
    track("render");
    return hands.render({ slug: currentData.slug }).then(function (r) {
      logChange(FILE_BASED ? "Exported the mixdown from " + DAW_LABEL : "Bounced the mix from " + DAW_LABEL + " (MP3 320 kbps)");
      return r.path;
    });
  })();
  start.then(function (p) {
    upload.file = p;
    uploadStage("measuring", "Measuring loudness and true peak…");
    return hands.measure(p);
  }).then(function (m) {
    upload.measured = m;
    uploadStage("preflight", "Running preflight…");
    track("preflight");
    return apiFetch("/preflight", { method: "POST", body: {
      slug: currentData.slug, assetId: upload.assetId, filename: basename(upload.file),
      durationSec: m.durationSec, lufs: m.lufs, truePeakDb: m.truePeakDb, channels: m.channels,
    } }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "Preflight failed (" + r.status + ")"); return j; }); });
  }).then(function (j) {
    var rows = (j.report && (j.report.results || j.report.checks)) || [];
    upload.preflight = rows;
    var worst = "pass";
    rows.forEach(function (r) {
      var v = r.verdict || r.status;
      if (v === "fail") worst = "fail"; else if (v === "warn" && worst !== "fail") worst = "warn";
    });
    upload.worst = worst;
    uploadStage("ready", worst === "fail" ? "This bounce has problems - fix them, or upload anyway and QA will hold it."
      : worst === "warn" ? "Checks passed with warnings." : "Checks passed.");
  }).catch(function (e) {
    if (upload.measured && upload.file) {
      upload.preflight = [];
      upload.worst = null;
      uploadStage("ready", "Preflight unavailable (" + e.message + ") - you can still upload; QA measures everything after.");
    } else {
      uploadStage("idle", e.message);
    }
  });
}

function doUpload() {
  if (!upload.file) return;
  var slug = currentData.slug, assetId = upload.assetId;
  uploadStage("uploading", "Preparing the upload…");
  track("upload");
  var mime = /\.wav$/i.test(upload.file) ? "audio/wav" : "audio/mpeg";
  var size = 0;
  window.fame.fileSize(upload.file).then(function (sz) {
    size = sz;
    if (!size) throw new Error("The file is empty or unreadable.");
    return apiFetch("/upload", { method: "POST", body: { slug: slug, assetId: assetId, step: "session", mimeType: mime, size: size } });
  }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "session failed"); return j; }); })
    .then(function (session) {
      uploadStage("uploading", "Uploading " + basename(upload.file) + " (" + (size / 1048576).toFixed(1) + " MB) straight to Drive - keep the app open…");
      // Bytes go from this machine to Drive's session URI, never through a Fame server.
      return window.fame.uploadFile({ filePath: upload.file, sessionUri: session.sessionUri, mimeType: mime })
        .then(function (meta) { return { session: session, driveFileId: meta.id }; });
    })
    .then(function (up) {
      return apiFetch("/upload", { method: "POST", body: {
        slug: slug, assetId: assetId, step: "complete", driveFileId: up.driveFileId, version: up.session.version,
        filename: basename(upload.file), sizeBytes: size, mimeType: mime, changeLog: readChangeLog(),
      } }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "complete failed"); return up.session.version; }); });
    })
    .then(function (v) {
      clearChangeLog();
      upload.version = v;
      playDone();
      uploadStage("done", "v" + v + " uploaded with a what-changed note for the PM - it lands internal-only and QA is already running.");
      loadBrief();
    })
    .catch(function (e) { uploadStage("ready", "Upload failed: " + e.message); });
}

// The adapter's own progress lines (Cubase: "export the mixdown into…",
// "cutting file…") land in the Deliver card while it waits.
window.fame.onNote(function (text) {
  if (upload.stage === "rendering") uploadStage("rendering", text);
  else setStatus(text, "", true);
});

window.fame.onUploadProgress(function (d) {
  var bar = document.getElementById("upload-progress");
  if (bar && d.size) bar.style.width = Math.round(100 * d.sent / d.size) + "%";
});

// Pre-upload comment check: cuttable comments are resolved to source
// ranges and checked against the timeline; judgement ones are counted.
function runCommentPrecheck() {
  if (!currentData) return;
  var open = [];
  (currentData.assets || []).forEach(function (a) {
    (a.versions || []).forEach(function (v) { v.comments.forEach(function (c) { if (!c.resolved) open.push(c); }); });
  });
  precheck = { running: true, unaddressed: [], judgement: 0, checked: 0, note: "" };
  renderDeliverCard();
  if (!open.length) { precheck.running = false; precheck.note = "No open comments on this episode."; renderDeliverCard(); return; }
  track("comment_precheck");
  var clipsP = can("readTimeline") ? hands.getClips().then(function (i) { clipsInfo = i; return i.clips; }).catch(function () { return []; }) : Promise.resolve([]);
  Promise.all([
    apiFetch("/comment-check", { method: "POST", body: { slug: currentData.slug, comments: open.slice(0, 40).map(function (c) { return { id: c.id, text: c.text, timestampSeconds: c.timestampSeconds }; }) } })
      .then(function (r) { return r.ok ? r.json() : null; }),
    clipsP,
  ]).then(function (res) {
    var j = res[0], clips = res[1];
    precheck.running = false;
    if (!j) { precheck.note = "Comment check unavailable - give the open comments a last look yourself."; renderDeliverCard(); return; }
    var byId = {};
    open.forEach(function (c) { byId[c.id] = c; });
    (j.results || []).forEach(function (r) {
      var c = byId[r.id];
      if (!c) return;
      if (r.kind === "trim" && r.ranges && r.ranges.length) {
        precheck.checked++;
        var still = null;
        r.ranges.forEach(function (rg) {
          if (still) return;
          var m = clips.length ? FameCore.mapCandidate({ speaker: rg.speaker, file: rg.file || "", startSec: rg.startSec, endSec: rg.endSec }, clips) : null;
          if (m) still = m;
        });
        if (still) precheck.unaddressed.push({ comment: c, at: still.s });
      } else precheck.judgement++;
    });
    precheck.note = precheck.checked + " cuttable comment(s) checked against the timeline, " + precheck.unaddressed.length + " still there. " + precheck.judgement + " need your own judgement.";
    if (!j.transcriptsAvailable) precheck.note = "Run Analyze first for the mechanical check; " + open.length + " open comment(s) to eyeball.";
    if (!clips.length) precheck.note += " (Timeline not readable, so nothing could be confirmed as done.)";
    renderDeliverCard();
  }).catch(function () { precheck = null; renderDeliverCard(); });
}

// Music balance: speech tracks are the ones the speakers map to; anything
// else carrying material is a bed or a sting. Both sides measured with the
// same ffmpeg call over each clip's own source range.
var MUSIC_OVER_DB = 4, MUSIC_MIN_MATERIAL = 12, MUSIC_MAX_MEASURE = 24;

function checkMusicBalance() {
  music = { running: true, rows: [], note: "Measuring clips…" };
  renderDeliverCard();
  hands.getClips().then(function (info) {
    clipsInfo = info;
    var speakerTracks = {};
    ((cleanupState && cleanupState.files) || []).forEach(function (f) {
      if (f.speaker) FameCore.tracksForSpeaker(info, f.speaker).forEach(function (t) { speakerTracks[t] = true; });
    });
    var speech = [], beds = [], bedSecs = 0;
    info.clips.forEach(function (cl) {
      if (cl.muted || !cl.path) return;
      if (speakerTracks[cl.track]) speech.push(cl);
      else { beds.push(cl); bedSecs += cl.end - cl.start; }
    });
    if (!Object.keys(speakerTracks).length) { music = { note: "Could not tell which tracks are the speakers - run Analyze and name the tracks after them, then check again." }; renderDeliverCard(); return; }
    if (!beds.length) { music = { note: "No music or bed tracks on this timeline - nothing to balance." }; renderDeliverCard(); return; }
    if (bedSecs < MUSIC_MIN_MATERIAL) { music = { note: "Only " + Math.round(bedSecs) + "s of music or effects here - too little to judge, so no verdict." }; renderDeliverCard(); return; }
    track("music_balance");
    var half = MUSIC_MAX_MEASURE / 2;
    function side(list) {
      var picked = list.slice().sort(function (a, b) { return (b.end - b.start) - (a.end - a.start); }).filter(function (c) { return c.end - c.start >= 1; }).slice(0, half);
      var vals = [];
      var chain = Promise.resolve();
      picked.forEach(function (cl) {
        chain = chain.then(function () {
          return hands.measure(cl.path, { inSec: cl.inPoint, outSec: cl.outPoint }).then(function (m) { if (m && m.lufs != null && m.lufs > -60) vals.push(m.lufs); }).catch(function () {});
        });
      });
      return chain.then(function () { return vals; });
    }
    return side(speech).then(function (sv) {
      return side(beds).then(function (mv) {
        var sMed = FameCore.median(sv), mMed = FameCore.median(mv);
        if (sMed == null || mMed == null) { music = { note: "Could not measure the levels on this timeline (are the files still where " + DAW_LABEL + " expects them?)." }; renderDeliverCard(); return; }
        var delta = mMed - sMed;
        music = {
          rows: ["Speech: " + sMed.toFixed(1) + " LUFS (median of " + sv.length + " clip(s))", "Music and effects: " + mMed.toFixed(1) + " LUFS (median of " + mv.length + " clip(s), " + Math.round(bedSecs) + "s total)"],
          verdict: delta >= MUSIC_OVER_DB ? "warn" : "pass",
          note: delta >= MUSIC_OVER_DB
            ? "The music sits " + delta.toFixed(1) + " dB LOUDER than the conversation. That is the \"music is too loud\" complaint - pull the bed down before you bounce."
            : "Music is " + Math.abs(delta).toFixed(1) + " dB " + (delta < 0 ? "under" : "over") + " the conversation - that reads fine.",
        };
        renderDeliverCard();
      });
    });
  }).catch(function (e) { music = { note: "Music check failed: " + e.message }; renderDeliverCard(); });
}

$("btn-upload").onclick = function () {
  if (!currentData || !briefData) { setStatus("Load an episode first.", "error"); return; }
  $("deliver").className = "";
  renderDeliverCard();
  $("deliver").scrollIntoView({ block: "start" });
};

// ---------- one-click apply for cuttable comments ----------
// A client comment's timestamp is where THEY paused the delivered audio =
// this timeline's time. Transcripts are raw-source time, so: timeline ->
// source through the clip under the moment, resolve there, map back, cut.

function applyComment(c, btn) {
  btn.disabled = true;
  setStatus("Working out the exact cut…", "", true);
  hands.getClips().then(function (info) {
    clipsInfo = info;
    var t = Number(c.timestampSeconds) || 0;
    var anchor = FameCore.sourceAnchor(t, info.clips);
    return apiFetch("/resolve-comment", { method: "POST", body: { slug: currentData.slug, text: c.text, timestampSeconds: anchor != null ? anchor : t } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        btn.disabled = false;
        var ranges = j.ranges || [];
        if (!ranges.length) { setStatus("Couldn't place that cut safely - jumped you there instead.", "error"); return hands.jumpTo(t, true); }
        if (ranges.length > 3) { setStatus("That comment maps to " + ranges.length + " places - too many to apply blind. Use the cleanup list instead.", "error"); return; }
        var seq = [];
        ranges.forEach(function (rg) {
          var m = FameCore.mapCandidate({ file: "", speaker: null, startSec: rg.startSec, endSec: rg.endSec }, info.clips);
          if (m) seq.push({ s: m.s, e: m.e });
        });
        if (!seq.length) { setStatus("Those words aren't on this timeline any more (already cut?). Jumped you to the comment.", "error"); return hands.jumpTo(t, true); }
        seq.sort(function (a, b) { return b.s - a.s; });
        return hands.applyRippleCuts(seq).then(function (r) {
          track("apply_comment");
          logChange("Applied a client comment: cut \"" + String(ranges[0].text || c.text).slice(0, 60) + "\" (" + (c.authorName || "client") + ")");
          renderCleanup();
          var msg = "Cut applied for " + (c.authorName || "the client") + "'s comment - " + r.applied + " range(s)" + (r.fadesSkipped ? ", " + r.fadesSkipped : "") + (r.pending ? "." : ". Undo puts it back.");
          if (r.pending) setTimeout(function () { afterHands(r, msg); }, 0); else setStatus(msg, "ok");
        });
      });
  }).catch(function (e) { btn.disabled = false; setStatus(e.message, "error"); });
}

// ---------- diagnostics ----------

$("btn-diag").onclick = function () {
  setStatus("Reading everything " + DAW_LABEL + " answers…", "", true);
  hands.diagnostics().then(function (d) {
    var host = $("cl-body");
    var old = document.getElementById("diag-box");
    if (old) old.parentNode.removeChild(old);
    var box = document.createElement("div");
    box.id = "diag-box";
    box.className = "cl-group";
    var h = document.createElement("div");
    h.className = "cl-group-head";
    h.textContent = "Diagnostics - " + DAW_LABEL + " " + (d.status.dawVersion || (d.status.connected ? "" : "not connected")) + ", app " + APP_VERSION;
    box.appendChild(h);
    var summary = d.clips ? (d.clips.clips.length + " clip(s) on " + d.clips.tracks + " track(s), " + d.clips.sampleRate + " Hz, session \"" + d.clips.sessionName + "\"") : (d.error || d.status.reason || "");
    var s = document.createElement("div");
    s.className = "cl-notes";
    s.textContent = summary;
    box.appendChild(s);
    var pre = document.createElement("pre");
    pre.className = "diag";
    var text = JSON.stringify({ app: APP_VERSION, status: d.status, clips: d.clips && d.clips.clips.slice(0, 40), error: d.error, raw: d.raw }, null, 1);
    pre.textContent = text.slice(0, 20000);
    box.appendChild(pre);
    var copy = document.createElement("button");
    copy.className = "btn-ghost";
    copy.textContent = "Copy for Tom";
    copy.onclick = function () { navigator.clipboard.writeText(text).then(function () { copy.textContent = "Copied"; }); };
    box.appendChild(copy);
    (host.firstChild ? host.insertBefore(box, host.firstChild) : host.appendChild(box));
    $("cleanup").className = "";
    setStatus("", "");
  }).catch(function (e) { setStatus(e.message, "error"); });
};

// ---------- views + wiring ----------

function showView(which) {
  $("view-login").className = which === "login" ? "view stack" : "view stack hidden";
  $("view-main").className = which === "main" ? "view" : "view hidden";
  $("footer").className = which === "main" ? "" : "hidden";
  $("btn-signout").className = which === "main" ? "linklike" : "linklike hidden";
  $("daw-bar").className = which === "main" ? $("daw-bar").className.replace("hidden", "") : "hidden";
  if (which !== "main") $("daw-setup").className = "hidden";
  if (which === "main") {
    renderRecents();
    refreshDaw();
    var recents = readRecents();
    if (!currentData && recents.length > 0) { $("slug").value = recents[0].slug; loadEpisode(); }
  }
}

$("btn-signin").onclick = function () {
  var email = $("email").value.trim();
  var pw = $("password").value;
  if (!email || !pw) { setStatus("Enter your email and password.", "error"); return; }
  setStatus("Signing in…", "", true);
  authRequest({ email: email, password: pw }).then(function (j) {
    saveSession(j);
    $("password").value = "";
    setStatus("", "");
    showView("main");
  }).catch(function (e) { setStatus(e.message, "error"); });
};
$("password").addEventListener("keydown", function (e) { if (e.key === "Enter") $("btn-signin").onclick(); });

$("btn-signout").onclick = function () {
  clearSession();
  currentData = null;
  $("comments").innerHTML = "";
  $("ep-name").textContent = DAW_LABEL + " Plugin";
  $("filters").className = "hidden";
  $("cleanup").className = "hidden";
  $("deliver").className = "hidden";
  $("brief").className = "hidden";
  resetCleanup();
  showView("login");
};

$("btn-load").onclick = loadEpisode;
$("slug").addEventListener("keydown", function (e) { if (e.key === "Enter") loadEpisode(); });
$("btn-refresh").onclick = function () {
  refreshDaw().then(function () {
    if (currentData) { cleanupChecks = cleanupChecks; loadEpisode(); }
  });
};

Array.prototype.forEach.call(document.querySelectorAll(".filter"), function (b) {
  b.onclick = function () {
    var f = b.getAttribute("data-filter");
    if (f === "open") {
      hideResolved = !hideResolved;
      b.className = "filter" + (hideResolved ? " active" : "");
    } else {
      filterMode = f;
      Array.prototype.forEach.call(document.querySelectorAll(".filter"), function (x) {
        if (x.getAttribute("data-filter") !== "open") x.className = "filter" + (x.getAttribute("data-filter") === f ? " active" : "");
      });
    }
    renderComments();
  };
});

// ---------- updates ----------
// The app updates itself (electron-updater); the banner tells the editor
// and offers the restart. version.json on review.fame.so is the fallback
// signal for a build that could not check its feed.

function showUpdateBar(version, ready) {
  var bar = $("update-bar");
  bar.innerHTML = "";
  var head = document.createElement("div");
  head.innerHTML = "<strong>Update " + (ready ? "ready" : "available") + "</strong> - you're on " + APP_VERSION + ", latest is " + version + ".";
  bar.appendChild(head);
  var b = document.createElement("button");
  if (ready) {
    b.textContent = "Restart to update";
    b.onclick = function () { window.fame.installUpdate(); };
  } else {
    b.textContent = "Get it at " + INSTALL_URL.replace("https://", "");
    b.onclick = function () { window.fame.openExternal(INSTALL_URL); };
  }
  bar.appendChild(b);
  bar.className = "";
}

window.fame.onUpdate(function (kind, d) { showUpdateBar(d.version, kind === "ready"); });

function checkForUpdate() {
  // Fetched by the main process: a static file on review.fame.so carries
  // no CORS header, and the renderer's origin is not review.fame.so.
  window.fame.latestVersion(VERSION_URL)
    .then(function (j) {
      if (!j || !j.version || !FameCore.versionNewer(j.version, APP_VERSION)) return;
      if ($("update-bar").className !== "hidden") return;
      showUpdateBar(j.version, false);
      if (j.notes) {
        var notes = document.createElement("div");
        notes.textContent = j.notes;
        $("update-bar").insertBefore(notes, $("update-bar").lastChild);
      }
    })
    .catch(function () {});
}

// ---------- Which DAW? ----------
// Chosen at sign-in, remembered by the main process (and mirrored in
// localStorage so the picker shows it before the bridge answers).

function setDaw(daw) {
  DAW = daw;
  DAW_LABEL = DAW_NAMES[daw] || daw;
  INSTALL_URL = daw === "cubase" ? "https://review.fame.so/cubase" : "https://review.fame.so/protools";
  try { localStorage.setItem("fame_daw", daw); } catch (e) {}
  Array.prototype.forEach.call(document.querySelectorAll(".daw-opt"), function (b) {
    b.className = "daw-opt" + (b.getAttribute("data-daw") === daw ? " active" : "");
  });
  $("ep-name").textContent = currentData ? (currentData.name || currentData.slug) : (DAW_LABEL + " Plugin");
  document.title = "Fame " + DAW_LABEL + " Plugin";
}
Array.prototype.forEach.call(document.querySelectorAll(".daw-opt"), function (b) {
  b.onclick = function () {
    var d = b.getAttribute("data-daw");
    window.fame.selectDaw(d).then(function (chosen) { setDaw(chosen || d); track("select_daw"); }).catch(function () { setDaw(d); });
  };
});

// boot
window.fame.info().then(function (info) {
  APP_VERSION = info.version;
  $("ver").textContent = "v" + APP_VERSION;
  return window.fame.daw();
}).then(function (daw) {
  setDaw(daw || "protools");
  showView(readSession() ? "main" : "login");
  setTimeout(checkForUpdate, 2500);
});
