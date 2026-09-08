// Electron main process - the only place with Node access. Owns the hands
// adapter (gRPC to Pro Tools), ffmpeg, file dialogs, the Drive upload
// stream and the auto-updater. The renderer talks to it through the small
// API in preload.js and never sees a path it did not pick itself.
//
// Electron over Tauri: no Rust toolchain on the build machine, gRPC and
// ffmpeg both come as Node packages, and the client logic is already
// browser JavaScript from the Premiere plugin.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { URL } = require("url");
const { ProToolsHands } = require("../hands/protools");
const { assertHands } = require("../hands/interface");

let win = null;
const hands = assertHands(new ProToolsHands());

function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 860, minWidth: 380, minHeight: 600,
    title: "Fame Pro Tools Plugin",
    backgroundColor: "#f8f1eb",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.on("closed", () => { win = null; });
}

// Hands calls, one channel per method - errors travel as { error } so the
// renderer can show the message verbatim.
const HANDS_METHODS = ["status", "getClips", "jumpTo", "applyRippleCuts", "silenceRanges", "setTrackGainDb", "buildAssembly", "render", "measure", "diagnostics"];
HANDS_METHODS.forEach((m) => {
  ipcMain.handle("hands:" + m, async (ev, ...args) => {
    try { return { ok: true, value: await hands[m](...args) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
});
ipcMain.handle("hands:daw", () => hands.daw);

ipcMain.handle("app:info", () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch }));

ipcMain.handle("app:pickFile", async (ev, opts) => {
  const r = await dialog.showOpenDialog(win, {
    title: (opts && opts.title) || "Choose a file",
    properties: ["openFile"],
    filters: (opts && opts.filters) || [{ name: "Audio", extensions: ["mp3", "wav", "aif", "aiff", "m4a", "flac"] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("app:pickFolder", async (ev, opts) => {
  const r = await dialog.showOpenDialog(win, { title: (opts && opts.title) || "Choose a folder", properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("app:listDir", (ev, dir) => {
  try { return fs.readdirSync(dir).filter((n) => !n.startsWith(".")); } catch (e) { return []; }
});
ipcMain.handle("app:fileSize", (ev, p) => { try { return fs.statSync(p).size; } catch (e) { return 0; } });
ipcMain.handle("app:openExternal", (ev, url) => shell.openExternal(url));
ipcMain.handle("app:showInFolder", (ev, p) => shell.showItemInFolder(p));

// version.json on review.fame.so - fetched here because a static file
// carries no CORS header and the renderer is not on that origin.
ipcMain.handle("app:latestVersion", (ev, url) => new Promise((resolve) => {
  try {
    https.get(url, { headers: { "cache-control": "no-cache" } }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch (e) { resolve(null); } });
    }).on("error", () => resolve(null));
  } catch (e) { resolve(null); }
}));

// Stream a local file straight to Drive's resumable session URI - the
// same path the /ve page and the Reaper plugin use; no Fame server in the
// byte path. Resolves Drive's file metadata.
ipcMain.handle("app:uploadFile", (ev, { filePath, sessionUri, mimeType }) => new Promise((resolve) => {
  let size;
  try { size = fs.statSync(filePath).size; } catch (e) { return resolve({ ok: false, error: "The file is missing: " + filePath }); }
  const u = new URL(sessionUri);
  const req = https.request({
    method: "PUT", hostname: u.hostname, path: u.pathname + u.search,
    headers: { "content-type": mimeType || "audio/mpeg", "content-length": size },
  }, (res) => {
    let body = "";
    res.on("data", (d) => { body += d; });
    res.on("end", () => {
      if (res.statusCode !== 200 && res.statusCode !== 201) return resolve({ ok: false, error: "Drive upload failed (" + res.statusCode + ")" });
      try { resolve({ ok: true, value: JSON.parse(body) }); } catch (e) { resolve({ ok: false, error: "Drive sent an unreadable answer." }); }
    });
  });
  req.on("error", (e) => resolve({ ok: false, error: "Drive upload failed: " + e.message }));
  let sent = 0;
  const stream = fs.createReadStream(filePath);
  stream.on("data", (chunk) => {
    sent += chunk.length;
    if (win) win.webContents.send("upload:progress", { sent, size });
  });
  stream.pipe(req);
}));

// Auto-update: GitHub Releases feed (electron-updater). Quiet on failure -
// a version check must never block the editor.
function setupUpdates() {
  let autoUpdater;
  try { ({ autoUpdater } = require("electron-updater")); } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => { if (win) win.webContents.send("update:available", { version: info.version }); });
  autoUpdater.on("update-downloaded", (info) => { if (win) win.webContents.send("update:ready", { version: info.version }); });
  autoUpdater.on("error", () => { /* offline or unsigned dev build */ });
  ipcMain.handle("app:installUpdate", () => { try { autoUpdater.quitAndInstall(); } catch (e) { /* nothing to install */ } });
  if (app.isPackaged) {
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4000);
    setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 6 * 3600 * 1000);
  }
}

app.whenReady().then(() => {
  createWindow();
  setupUpdates();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { app.quit(); });
