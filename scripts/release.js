// Release: bump the version in ONE place (package.json - Electron, the
// installers and the auto-update feed all read it), then write the
// review-tool repo's public/companion/version.json so the in-app banner
// and the install page agree. Commit + PR the VRT side after; publish the
// installers with `npm run dist -- --publish always` (GH_TOKEN set).
//
//   node scripts/release.js <version> "Banner notes for this version"
const fs = require("fs");
const path = require("path");

const here = path.resolve(__dirname, "..");
const version = process.argv[2];
const notes = process.argv[3] || "";
if (!/^\d+\.\d+\.\d+$/.test(version || "") || !notes) {
  console.error('usage: node scripts/release.js 1.2.3 "notes"');
  process.exit(1);
}
const pkgPath = path.join(here, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const vrt = process.env.VRT_DIR || path.resolve(here, "..", "Video Review Tool");
const out = path.join(vrt, "public", "companion");
fs.mkdirSync(out, { recursive: true });
const repo = pkg.build.publish[0].owner + "/" + pkg.build.publish[0].repo;
const base = "https://github.com/" + repo + "/releases/download/v" + version + "/";
const feed = {
  version,
  notes,
  releasedAt: new Date().toISOString(),
  downloads: {
    mac: base + "Fame-Pro-Tools-Companion-" + version + "-mac-universal.dmg",
    win: base + "Fame-Pro-Tools-Companion-" + version + "-win-x64.exe",
  },
  releasePage: "https://github.com/" + repo + "/releases/tag/v" + version,
};
fs.writeFileSync(path.join(out, "version.json"), JSON.stringify(feed, null, 2) + "\n");
console.log("package.json -> " + version);
console.log("wrote " + path.join(out, "version.json"));
