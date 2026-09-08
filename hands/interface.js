// The hands interface - everything the app asks a DAW to do, DAW-neutral.
//
// The brain is review.fame.so (episodes, comments, cleanup analysis,
// preflight, upload); the Premiere and Reaper clients proved every endpoint
// is client-agnostic. What differs per DAW is only these hands. Pro Tools
// implements them in ./protools; the Cubase build adds ./cubase against
// this same file. Keep it small and keep every method's contract here, so
// a second adapter never has to read the first one.
//
// Times are SECONDS on the DAW's timeline unless a name says otherwise.
// `clips[].inPoint/outPoint` are seconds into the SOURCE file - that is
// the raw recording time the server's cleanup candidates are expressed in.
//
// Every method returns a Promise. Failures reject with an Error whose
// message is written for the editor (it is shown verbatim in the app).

/**
 * @typedef {Object} Clip
 * @property {string} id         DAW clip/element id (opaque)
 * @property {number} track      0-based track index in the DAW's own order
 * @property {string} trackName
 * @property {string} name       clip name as the editor sees it
 * @property {string} path       absolute path of the source file ("" when unknown)
 * @property {"audio"|"video"} type
 * @property {number} start      timeline seconds
 * @property {number} end        timeline seconds
 * @property {number} inPoint    source seconds at `start`
 * @property {number} outPoint   source seconds at `end`
 * @property {number} rate       playback rate (1 = normal)
 * @property {boolean} muted
 */

/**
 * @typedef {Object} ClipsInfo
 * @property {Clip[]} clips
 * @property {number} tracks       number of tracks read
 * @property {number} sampleRate
 * @property {string} sessionName
 * @property {string} sessionPath  folder that holds the session file
 * @property {Object} raw          the DAW's own answers, for the Diagnostics panel
 */

/**
 * @typedef {Object} Measurement
 * @property {number} durationSec
 * @property {number} channels
 * @property {number} lufs        integrated loudness (EBU R128)
 * @property {number} truePeakDb
 */

/** Capability flags - the UI hides a button rather than showing one that does nothing. */
const CAPABILITIES = [
  "connect",        // status(): can tell whether the DAW is running and which version
  "readTimeline",   // getClips()
  "jump",           // jumpTo()
  "rippleCut",      // applyRippleCuts()
  "silence",        // silenceRanges() - the per-track "mute" treatment
  "fades",          // fades on cut edges (may need a preset in the DAW)
  "trackGain",      // setTrackGainDb()
  "render",         // render()
  "assembly",       // buildAssembly()
];

/**
 * @typedef {Object} Hands
 * @property {string} daw                              "protools" | "cubase" - also the telemetry client name
 * @property {() => Promise<Status>} status            never rejects; { connected, appVersion, dawVersion, capabilities: {name: bool}, reason }
 * @property {() => Promise<ClipsInfo>} getClips
 * @property {(sec: number, play: boolean) => Promise<void>} jumpTo
 * @property {(ranges: {s:number,e:number}[]) => Promise<{applied:number, fades:number, fadesSkipped?:string}>} applyRippleCuts
 *   Ranges arrive MERGED and DESCENDING (back-to-front). Removes each range
 *   from EVERY track, closing the gap (ripple), then fades every seam.
 * @property {(specs: {tracks:number[], ranges:{s:number,e:number}[]}[]) => Promise<{silenced:number, tracks:number, fadesSkipped?:string}>} silenceRanges
 *   Silence each range on ONLY the given tracks - no ripple, timeline length unchanged.
 * @property {(tracks: number[], dB: number) => Promise<{tracks:number}>} setTrackGainDb
 *   Relative gain change on those tracks. The caller enforces the 30 dB refusal.
 * @property {(files: {path:string, name:string}[]) => Promise<{added:number, tracks:string[]}>} buildAssembly
 *   One new track per file, named `name`, file placed at 0. Never reads from Drive.
 * @property {(opts: {slug:string, outDir?:string}) => Promise<{path:string}>} render
 *   Full mix to MP3 320 in "<session folder>/Fame renders/". Resolves when the file exists.
 * @property {(path: string, opts?: {inSec:number, outSec:number}) => Promise<Measurement>} measure
 *   Whole file, or one source-time slice of it (music balance measures each clip's own range).
 * @property {() => Promise<Object>} diagnostics   raw DAW answers for a support screenshot
 */

/** Which fixed interface version an adapter targets - bump when a method's contract changes. */
const HANDS_VERSION = 1;

function assertHands(h) {
  const required = ["daw", "status", "getClips", "jumpTo", "applyRippleCuts", "silenceRanges", "setTrackGainDb", "buildAssembly", "render", "measure", "diagnostics"];
  for (const k of required) {
    if (k === "daw" ? typeof h[k] !== "string" : typeof h[k] !== "function") {
      throw new Error("hands adapter is missing " + k);
    }
  }
  return h;
}

module.exports = { CAPABILITIES, HANDS_VERSION, assertHands };
