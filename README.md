# Fame Pro Tools Plugin (with the Cubase adapter)

The audio-editor client for Fame's Asset Review Tool, beside Pro Tools or
Cubase. Third and fourth clients for the same brain (after the Premiere
plugin and the Reaper plugin): every feature lives behind
`review.fame.so/api/panel/*`; this app only adds the **hands** - reading
the timeline, jumping, cutting, silencing, setting gain, laying out
tracks, rendering. Pro Tools gets them through Avid's Scripting SDK (PTSL,
gRPC on `localhost:31416`); Cubase, which has no arrangement API, gets a
**file-based** adapter: track-archive XML round trips, MMC over a virtual
MIDI port, and a watched exchange folder. The DAW is chosen at sign-in.

Install page: https://review.fame.so/protools (Cubase steps: https://review.fame.so/cubase)

## Layout

| Path | What |
|---|---|
| `src/main.js` | Electron main: owns the hands adapter, ffmpeg, dialogs, the Drive upload stream, auto-update |
| `src/preload.js` | the `window.fame` bridge |
| `src/renderer/` | the panel (ported from the Premiere plugin's `main.js`) |
| `src/core/mapping.js` | pure mapping rules shared by renderer and tests (`mapCandidate`, `selectedRanges`, `tracksForSpeaker`) |
| `hands/interface.js` | the DAW-neutral hands contract - the Cubase adapter implements this same file |
| `hands/protools/` | the PTSL adapter (`index.js`), transport (`ptsl-client.js`), command ids from Avid's proto |
| `hands/cubase/` | the file-based adapter: `archive.js` (track-archive read/edit), `xml.js` (byte-preserving XML), `mmc.js` (MIDI Machine Control), `watcher.js`, `cutter.js` (ffmpeg file cuts), `schema.json` (which XML keys are confirmed vs assumed), `templates/` |
| `hands/common.js` | ffmpeg + EBU R128 measurement shared by both adapters |
| `proto/ptsl.proto` | the PTSL envelope (bodies are JSON strings) |
| `test/` | `npm test` - mapping rules on real server fixtures + the adapter over real gRPC against `mock-ptsl-server.js`; `node test/serve.js <adminKey>` browser-tests the panel against production |
| `scripts/ptsl-spike.js` | read-only probe against a real Pro Tools - prints what PTSL answers |
| `scripts/cubase-spike.js` | Phase 0 probe: `<export.xml>` prints every track/event's raw keys + proves the round trip and one edit; `--midi [port]` sends an MMC locate |
| `scripts/release.js` | bumps `package.json` and writes the review tool's `public/protools/version.json` |
| `docs/working-procedure.html` | source of the working-procedure Google Doc (updated IN PLACE via `/api/admin/replace-doc`) |

## Run / test

```bash
npm install
npm test          # 50 checks, no DAW needed (mock PTSL over gRPC; real Cubase exports; CoreMIDI loopback)
npm start         # the app, against whatever Pro Tools is running
npm run spike     # print the real Pro Tools' answers (Phase 0 probe)
node scripts/cubase-spike.js path/to/export.xml   # the Cubase probe
node test/serve.js <adminKey>                      # then http://localhost:5052/?daw=cubase
```

## Release

1. `node scripts/release.js 1.2.3 "banner notes"` - bumps `package.json`
   and writes `../Video Review Tool/public/protools/version.json`.
2. Build and publish the installers to a GitHub release
   (`famecodeteam/fame-protools-plugin`, also the auto-update feed). Run
   electron-builder directly - `npm run dist -- --publish always` does NOT
   upload, because the `dist` script already passes `--publish never`:
   ```
   export GH_TOKEN=$(gh auth token)
   npx electron-builder --mac --publish always          # dmg + zip + latest-mac.yml
   npx electron-builder --win --x64 --publish always    # exe + latest.yml (separate step)
   ```
   Then check the release has all 8 assets and is not a draft:
   `gh release view v1.2.3 -R famecodeteam/fame-protools-plugin`
   (if it is a draft: `gh release edit v1.2.3 --draft=false -R famecodeteam/fame-protools-plugin`).
3. Commit + PR the review-tool side (version.json), merge - the install
   page reads it.
4. Push this repo's version bump to `main`.
5. Confirm `https://review.fame.so/protools/version.json` shows the new
   version once the review-tool deploy finishes.
6. Update the working-procedure doc in place (never a new doc).

Requires Pro Tools 2025.10+ on the editor's machine (see the spec's Phase 0
findings for why). Mac builds are unsigned until an Apple Developer ID
certificate is set (`CSC_LINK` / `CSC_KEY_PASSWORD` for electron-builder).
