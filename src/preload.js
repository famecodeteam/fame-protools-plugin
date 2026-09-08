// The bridge the renderer sees as window.fame. Every hands call resolves
// the value or throws an Error carrying Pro Tools' own message.
const { contextBridge, ipcRenderer } = require("electron");

function unwrap(p) {
  return p.then((r) => {
    if (r && r.ok === false) throw new Error(r.error);
    return r && r.ok === true ? r.value : r;
  });
}

const hands = {};
["status", "getClips", "jumpTo", "applyRippleCuts", "silenceRanges", "setTrackGainDb", "buildAssembly", "render", "measure", "diagnostics"].forEach((m) => {
  hands[m] = (...args) => unwrap(ipcRenderer.invoke("hands:" + m, ...args));
});

contextBridge.exposeInMainWorld("fame", {
  hands,
  daw: () => ipcRenderer.invoke("hands:daw"),
  info: () => ipcRenderer.invoke("app:info"),
  pickFile: (opts) => ipcRenderer.invoke("app:pickFile", opts),
  pickFolder: (opts) => ipcRenderer.invoke("app:pickFolder", opts),
  listDir: (dir) => ipcRenderer.invoke("app:listDir", dir),
  fileSize: (p) => ipcRenderer.invoke("app:fileSize", p),
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  showInFolder: (p) => ipcRenderer.invoke("app:showInFolder", p),
  uploadFile: (args) => unwrap(ipcRenderer.invoke("app:uploadFile", args)),
  installUpdate: () => ipcRenderer.invoke("app:installUpdate"),
  latestVersion: (url) => ipcRenderer.invoke("app:latestVersion", url),
  onUploadProgress: (cb) => { ipcRenderer.on("upload:progress", (ev, d) => cb(d)); },
  onUpdate: (cb) => {
    ipcRenderer.on("update:available", (ev, d) => cb("available", d));
    ipcRenderer.on("update:ready", (ev, d) => cb("ready", d));
  },
});
