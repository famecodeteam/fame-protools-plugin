// Everything this app has put on the machine, so it can take all of it off
// again from a button.
//
// Asked for by the second Pro Tools AE before he would install it at all:
// "I dont see an option when i install to completely uninstall the plugin
// if its buggy... Not having a uninstall option means finding hidden files
// buried in terminals." Fair, and the honest answer is that the list is
// short - this is a normal desktop app, not an AAX plug-in: it installs
// nothing into Pro Tools, adds no login item, no launch agent, no system
// extension, and the Cubase virtual MIDI port exists only while it runs.
//
// The paths are built as pure data so the panel can show the editor the
// real list, with sizes, before anything is touched.

const path = require("path");

// The .app bundle from the running executable:
//   /Applications/Fame Pro Tools Plugin.app/Contents/MacOS/Fame Pro Tools Plugin
function macAppBundle(exePath) {
  const i = exePath.indexOf(".app" + path.sep);
  return i === -1 ? null : exePath.slice(0, i + 4);
}

/**
 * @param {object} env
 * @param {"darwin"|"win32"|"linux"} env.platform
 * @param {string} env.home
 * @param {string} env.userData   Electron app.getPath("userData")
 * @param {string} env.logs       Electron app.getPath("logs")
 * @param {string} env.exePath    Electron app.getPath("exe")
 * @param {string} env.appName    productName, e.g. "Fame Pro Tools Plugin"
 * @param {string} env.bundleId   appId, e.g. "so.fame.protools-plugin"
 * @param {boolean} [env.packaged] false in a dev run, where exePath points at
 *   Electron's own bundle inside node_modules - trashing THAT would take out
 *   the developer's toolchain, so the app itself is never listed.
 * @returns {Array<{path:string,label:string,kind:string}>}
 */
// What this app was called before, and the id it used. The rename from
// "Companion" to "Plugin" on day one left the old folders behind on any
// machine that ran the first build - precisely the orphan an editor would
// otherwise have to go hunting for, which is the whole reason this exists.
const LEGACY = [
  { appName: "Fame Pro Tools Companion", bundleId: "so.fame.protools-companion" },
];

function uninstallTargets(env) {
  const { platform, home, userData, logs, exePath, appName, bundleId } = env;
  const packaged = env.packaged !== false;
  const out = [];
  const add = (p, label, kind) => { if (p) out.push({ path: p, label, kind }); };

  // Sign-in, recent episodes, the what-changed notes not yet uploaded, the
  // DAW choice and any Cubase setup.
  add(userData, "Your sign-in, recent episodes and settings", "data");
  add(logs, "Log files", "data");

  if (platform === "darwin") {
    const L = path.join(home, "Library");
    add(path.join(L, "Caches", bundleId), "Cache", "cache");
    add(path.join(L, "Caches", appName), "Cache", "cache");
    add(path.join(L, "Caches", bundleId + ".ShipIt"), "Updater cache", "cache");
    add(path.join(L, "Caches", bundleId + "-updater"), "Updater cache", "cache");
    add(path.join(L, "Preferences", bundleId + ".plist"), "Preferences", "prefs");
    add(path.join(L, "Saved Application State", bundleId + ".savedState"), "Saved window state", "prefs");
    if (packaged) add(macAppBundle(exePath), "The app itself", "app");
  } else if (platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    add(path.join(local, appName + "-updater"), "Updater cache", "cache");
    // The app itself is removed by the installer's own uninstaller, which
    // is what Add or remove programs runs - so it is listed, not trashed.
    if (packaged) add(path.join(local, "Programs", appName), "The app itself", "app");
  }
  // The same places again under every name this app has used.
  for (const old of LEGACY) {
    if (old.appName === appName) continue;
    if (platform === "darwin") {
      const L = path.join(home, "Library");
      add(path.join(L, "Application Support", old.appName), "Left over from when it was called the " + old.appName.replace(/^Fame /, "Fame "), "data");
      add(path.join(L, "Logs", old.appName), "Old log files", "data");
      add(path.join(L, "Caches", old.bundleId), "Old cache", "cache");
      add(path.join(L, "Caches", old.appName), "Old cache", "cache");
      add(path.join(L, "Preferences", old.bundleId + ".plist"), "Old preferences", "prefs");
      add(path.join(L, "Saved Application State", old.bundleId + ".savedState"), "Old saved window state", "prefs");
      if (packaged) add(path.join("/Applications", old.appName + ".app"), "The old app, if it is still there", "app");
    } else if (platform === "win32") {
      const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      add(path.join(roaming, old.appName), "Left over from when it was called the " + old.appName, "data");
      add(path.join(local, old.appName + "-updater"), "Old updater cache", "cache");
    }
  }

  // De-duplicate: userData and a cache path can be the same folder.
  const seen = new Set();
  return out.filter((t) => {
    const key = t.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The Windows uninstaller electron-builder's NSIS target writes next to the
// app. Running it is the supported way to remove a Windows install.
function windowsUninstaller(env) {
  const local = process.env.LOCALAPPDATA || path.join(env.home, "AppData", "Local");
  return path.join(local, "Programs", env.appName, "Uninstall " + env.appName + ".exe");
}

// Said in the confirmation, because the thing an editor actually fears is
// losing work rather than losing an app.
const KEPT = [
  "Your Pro Tools or Cubase sessions, and every file in them",
  "Anything the Plugin bounced for you, including the \"Fame renders\" folders beside your sessions",
  "Everything already uploaded to the review tool or Drive",
];

module.exports = { uninstallTargets, windowsUninstaller, macAppBundle, KEPT, LEGACY };
