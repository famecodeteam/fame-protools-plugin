// hands/protools - the Pro Tools adapter, driving Pro Tools through the
// Scripting SDK (PTSL). Implements ../interface.js.
//
// Timeline model (Pro Tools 2025.10+): GetTrackList -> per audio track
// GetTrackPlaylists (main playlist) -> GetPlaylistElements (placement in
// samples) -> GetClipList (clip definitions: file + source range) ->
// GetFileLocation (file_id -> path). Everything is samples at the session
// rate on the wire and seconds in the interface.
//
// Editing model: Pro Tools has no "separate/mute this clip" command, so
// - ripple cut  = Shuffle mode, every track selected, timeline selection,
//                 Clear (later material moves up), fades on the seam;
// - silence     = Slip mode, only the speaker's tracks selected, Clear
//                 (leaves a gap, timeline length unchanged), fades on both
//                 edges.
// Fades come from a NAMED fade preset (the SDK takes no length), so the AE
// saves one preset called "Fame 10ms" once; when it is missing the cut still
// lands and the result says fades were skipped.
//
// The editor's own state - edit mode, link options, timeline selection,
// track selection - is read first and put back after every action.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { PtslClient, PtslError, STATUS } = require("./ptsl-client");
const { CAPABILITIES } = require("../interface");

const FADE_PRESET = "Fame 10ms";
const FADE_SEC = 0.010;
const PAGE = { limit: 2000, offset: 0 };

// Enum names on the wire may carry any of Avid's aliases (TT_Audio,
// TType_Audio, AudioTrack ...) or arrive as a number - compare loosely.
function enumIs(value, wanted, numeric) {
  if (value == null) return false;
  if (typeof value === "number") return numeric != null && value === numeric;
  const v = String(value).toLowerCase().replace(/^[a-z0-9]+_/, "");
  return wanted.some((w) => v === w.toLowerCase());
}
function enumNumber(value, fallback) {
  if (typeof value === "number") return value;
  const m = String(value || "").match(/\d+/);
  return m ? Number(m[0]) : fallback;
}

const { measure } = require("../common");

class ProToolsHands {
  constructor(opts) {
    this.daw = "protools";
    this.client = new PtslClient(opts);
    this.raw = {}; // last answers, for diagnostics
    this.sampleRate = 0;
  }

  // ----- connection -----

  async _connect() {
    await this.client.connect();
    return this.client;
  }

  async status() {
    try {
      await this._connect();
      const floor = this.client.meetsFloor();
      const caps = {};
      CAPABILITIES.forEach((c) => { caps[c] = c === "connect" || c === "jump" || floor; });
      return {
        connected: true,
        dawVersion: this.client.versionLabel(),
        capabilities: caps,
        reason: floor ? "" : "Pro Tools " + this.client.versionLabel() + " is older than 2025.10 - the timeline features need the newer scripting commands. Update Pro Tools (Avid Link) and the buttons appear.",
      };
    } catch (e) {
      this.client.close();
      const caps = {};
      CAPABILITIES.forEach((c) => { caps[c] = false; });
      return { connected: false, dawVersion: "", capabilities: caps, reason: e.message };
    }
  }

  // ----- time helpers -----

  async _rate() {
    if (this.sampleRate) return this.sampleRate;
    const r = await this.client.send("GetSessionSampleRate", null);
    this.raw.sampleRate = r;
    this.sampleRate = enumNumber(r.sample_rate, 48000) || 48000;
    return this.sampleRate;
  }
  _loc(sec, sr) { return { location: String(Math.max(0, Math.round(sec * sr))), time_type: "TLType_Samples" }; }
  _secOf(loc, sr) {
    if (loc == null) return null;
    const v = typeof loc === "object" ? loc.location : loc;
    const n = Number(v);
    return isFinite(n) ? n / sr : null;
  }
  _posSec(p, sr) {
    if (!p) return null;
    const n = Number(typeof p === "object" ? p.position : p);
    return isFinite(n) ? n / sr : null;
  }

  // ----- reading the timeline -----

  async _tracks() {
    const r = await this.client.send("GetTrackList", {
      page_limit: PAGE.limit,
      track_filter_list: [{ filter: "All", is_inverted: false }],
      is_filter_list_additive: true,
      pagination_request: PAGE,
    });
    this.raw.trackList = r;
    return (r.track_list || []).map((t, i) => ({
      id: t.id, name: t.name || "", index: typeof t.index === "number" ? t.index : i,
      isAudio: enumIs(t.type, ["audio", "audiotrack"], 2),
      isVideo: enumIs(t.type, ["video", "videotrack"], 4),
      selected: !!(t.track_attributes && t.track_attributes.is_selected && !enumIs(t.track_attributes.is_selected, ["none"], 1) && t.track_attributes.is_selected !== 0 && t.track_attributes.is_selected !== false),
      hasClips: !!(t.track_attributes && t.track_attributes.contains_clips),
      muted: !!(t.track_attributes && t.track_attributes.is_muted),
    }));
  }

  async getClips() {
    await this._connect();
    if (!this.client.meetsFloor()) {
      throw new Error("Reading the timeline needs Pro Tools 2025.10 or newer (you have " + this.client.versionLabel() + ").");
    }
    const sr = await this._rate();
    const [nameR, pathR] = await Promise.all([
      this.client.send("GetSessionName", null).catch(() => ({})),
      this.client.send("GetSessionPath", null).catch(() => ({})),
    ]);
    const tracks = await this._tracks();
    const clipR = await this.client.send("GetClipList", { pagination_request: PAGE });
    this.raw.clipList = clipR;
    const defs = {};
    (clipR.clips || []).forEach((c) => { defs[c.clip_id] = c; });
    const fileR = await this.client.send("GetFileLocation", {
      page_limit: PAGE.limit, file_filters: ["All_Files"], pagination_request: PAGE,
    }).catch(() => ({ file_locations: [] }));
    this.raw.fileLocations = fileR;
    const paths = {};
    (fileR.file_locations || []).forEach((f) => { if (f.file_id) paths[f.file_id] = f.path || ""; });

    const clips = [];
    this.raw.playlists = {};
    for (const t of tracks) {
      if (!(t.isAudio || t.isVideo)) continue;
      let pl;
      try {
        pl = await this.client.send("GetTrackPlaylists", { track_id: t.id, track_name: t.name, pagination_request: PAGE });
      } catch (e) { continue; }
      const main = (pl.playlists || []).find((p) => p.is_target) || (pl.playlists || []).find((p) => enumIs(p.playlist_type, ["main"], 1)) || (pl.playlists || [])[0];
      if (!main) continue;
      let el;
      try {
        el = await this.client.send("GetPlaylistElements", {
          playlist_id: main.playlist_id, playlist_name: main.playlist_name || "",
          time_format: "TLType_Samples", pagination_request: PAGE,
        });
      } catch (e) { continue; }
      this.raw.playlists[t.name] = el;
      (el.elements_list || []).forEach((e, i) => {
        const cc = (e.channel_clips || []).find((c) => c && !c.is_null && c.clip_id) || (e.channel_clips || [])[0];
        const def = cc && defs[cc.clip_id];
        const start = this._secOf(e.start_time, sr) != null ? this._secOf(e.start_time, sr) : this._secOf(e.element_location, sr);
        const end = this._secOf(e.end_time, sr);
        if (start == null || end == null || end <= start) return;
        const play = this._secOf(e.play_time, sr);
        // A trimmed instance may report play_time inside start/end; the
        // offset is added to the definition's own source start.
        const trimIn = play != null && play > start ? play - start : 0;
        const srcStart = def ? this._posSec(def.src_start_point, sr) : null;
        const inPoint = srcStart != null ? srcStart + trimIn : start;
        clips.push({
          id: cc ? cc.clip_id : t.id + ":" + i,
          track: t.index, trackName: t.name,
          name: def ? (def.clip_full_name || def.clip_root_name || "") : "",
          path: def && def.file_id ? (paths[def.file_id] || "") : "",
          type: t.isVideo || (def && enumIs(def.clip_type, ["video"], 3)) ? "video" : "audio",
          start, end, inPoint, outPoint: inPoint + (end - start), rate: 1,
          muted: !!(e.clip_instance_attributes && e.clip_instance_attributes.is_muted) || t.muted,
        });
      });
    }
    clips.sort((a, b) => a.track - b.track || a.start - b.start);
    const sessionFile = (pathR.session_path && pathR.session_path.path) || "";
    return {
      clips, tracks: tracks.length, sampleRate: sr,
      sessionName: nameR.session_name || "",
      sessionPath: sessionFile ? (/\.(ptx|ptf)$/i.test(sessionFile) ? path.dirname(sessionFile) : sessionFile) : "",
      raw: this.raw,
    };
  }

  // ----- transport -----

  async _isPlaying() {
    const r = await this.client.send("GetTransportState", null);
    return enumIs(r.current_setting, ["transportplaying", "transportplayinghalfspeed", "transportrecording"], 1);
  }

  async _select(sec0, sec1, sr) {
    await this.client.send("SetTimelineSelection", {
      play_start_marker_time: this._loc(sec0, sr).location,
      in_time: this._loc(sec0, sr).location,
      out_time: this._loc(sec1, sr).location,
      pre_roll_start_time: "", post_roll_stop_time: "",
      pre_roll_enabled: "TB_None", post_roll_enabled: "TB_None",
      update_video_to: "TUV_None", propagate_to_satellites: "TB_None",
      location_type: "TLType_Samples",
    });
  }

  async jumpTo(sec, play) {
    await this._connect();
    const sr = await this._rate();
    const playing = await this._isPlaying().catch(() => false);
    if (playing) await this.client.send("TogglePlayState", null);
    await this._select(sec, sec, sr);
    if (play) await this.client.send("TogglePlayState", null);
  }

  // ----- editing -----

  // Snapshot of what the editor had, restored by _restore().
  async _snapshot() {
    const snap = {};
    snap.mode = await this.client.send("GetEditMode", null).then((r) => r.current_setting).catch(() => null);
    snap.options = await this.client.send("GetEditModeOptions", null).then((r) => r.edit_mode_options).catch(() => null);
    snap.selection = await this.client.send("GetTimelineSelection", { time_type: "TLType_Samples" }).catch(() => null);
    snap.tracks = await this._tracks().catch(() => []);
    return snap;
  }
  async _restore(snap) {
    if (snap.mode) await this.client.send("SetEditMode", { edit_mode: snap.mode }).catch(() => {});
    if (snap.options) await this.client.send("SetEditModeOptions", { edit_mode_options: snap.options }).catch(() => {});
    const sel = snap.tracks.filter((t) => t.selected).map((t) => t.name);
    if (sel.length) await this._selectTracks(sel).catch(() => {});
    if (snap.selection && snap.selection.in_time != null) {
      await this.client.send("SetTimelineSelection", {
        play_start_marker_time: snap.selection.play_start_marker_time || snap.selection.in_time,
        in_time: snap.selection.in_time, out_time: snap.selection.out_time || snap.selection.in_time,
        pre_roll_start_time: "", post_roll_stop_time: "",
        pre_roll_enabled: "TB_None", post_roll_enabled: "TB_None",
        update_video_to: "TUV_None", propagate_to_satellites: "TB_None",
        location_type: "TLType_Samples",
      }).catch(() => {});
    }
  }
  async _selectTracks(names) {
    if (!names.length) return;
    await this.client.send("SelectTracksByName", { track_names: names, selection_mode: "SM_Replace", pagination_request: PAGE });
  }
  async _linkSelections(snapOptions) {
    const o = Object.assign({}, snapOptions || {}, { link_timeline_and_edit_selection: true, link_track_and_edit_selection: true });
    await this.client.send("SetEditModeOptions", { edit_mode_options: o });
  }

  // Fade the clip edges around `sec` on the selected tracks. Returns 1 when
  // a fade landed, 0 when skipped; sets this._fadeProblem once so the
  // caller can report it and stop trying.
  async _fadeAt(sec, sr) {
    if (this._fadeProblem) return 0;
    try {
      await this._select(Math.max(0, sec - FADE_SEC), sec + FADE_SEC, sr);
      await this.client.send("CreateFadesBasedOnPreset", { fade_preset_name: FADE_PRESET, auto_adjust_bounds: true });
      return 1;
    } catch (e) {
      const noPreset = e instanceof PtslError && (e.errors || []).some((x) => enumIs(x.command_error_type, ["pt_nopresetfound", "nopresetfound"], 111));
      this._fadeProblem = noPreset
        ? "no fade preset called \"" + FADE_PRESET + "\" - save one in Pro Tools (Fades window > Save preset, 10 ms) and fades apply from the next cut"
        : "fades skipped: " + e.message;
      return 0;
    }
  }

  async applyRippleCuts(ranges) {
    await this._connect();
    if (!ranges.length) return { applied: 0, fades: 0 };
    const sr = await this._rate();
    const snap = await this._snapshot();
    this._fadeProblem = null;
    let applied = 0, fades = 0;
    try {
      await this._linkSelections(snap.options);
      const names = snap.tracks.filter((t) => t.isAudio || t.isVideo).map((t) => t.name);
      if (!names.length) throw new Error("No audio tracks in this session.");
      await this._selectTracks(names);
      const sorted = ranges.slice().sort((a, b) => b.s - a.s);
      await this.client.send("SetEditMode", { edit_mode: "EMO_Shuffle" });
      for (const r of sorted) {
        if (r.e <= r.s + 0.001) continue;
        await this._select(r.s, r.e, sr);
        await this.client.send("Clear", null);
        applied++;
      }
      // Fades in Slip mode so nothing shuffles while a selection straddles a
      // seam. Every seam sits EARLIER by the total length of the cuts before
      // it - the ripple already moved it - so the fade positions are shifted.
      await this.client.send("SetEditMode", { edit_mode: "EMO_Slip" });
      let shift = 0;
      for (const r of sorted.slice().reverse()) {
        if (r.e <= r.s + 0.001) continue;
        fades += await this._fadeAt(r.s - shift, sr);
        shift += r.e - r.s;
      }
    } finally {
      await this._restore(snap);
    }
    const out = { applied, fades };
    if (this._fadeProblem) out.fadesSkipped = this._fadeProblem;
    return out;
  }

  async silenceRanges(specs) {
    await this._connect();
    const sr = await this._rate();
    const snap = await this._snapshot();
    this._fadeProblem = null;
    let silenced = 0;
    const touched = {};
    try {
      await this._linkSelections(snap.options);
      await this.client.send("SetEditMode", { edit_mode: "EMO_Slip" });
      for (const spec of specs) {
        const names = snap.tracks.filter((t) => spec.tracks.indexOf(t.index) >= 0).map((t) => t.name);
        if (!names.length) continue;
        await this._selectTracks(names);
        const sorted = spec.ranges.slice().sort((a, b) => b.s - a.s);
        for (const r of sorted) {
          if (r.e <= r.s + 0.001) continue;
          await this._select(r.s, r.e, sr);
          await this.client.send("Clear", null);
          silenced++;
          names.forEach((n) => { touched[n] = true; });
          await this._fadeAt(r.s, sr);
          await this._fadeAt(r.e, sr);
        }
      }
    } finally {
      await this._restore(snap);
    }
    const out = { silenced, tracks: Object.keys(touched).length };
    if (this._fadeProblem) out.fadesSkipped = this._fadeProblem;
    return out;
  }

  // Relative gain as volume automation on the main output of each track.
  // Existing breakpoints are shifted by dB; a track without any gets a flat
  // line at dB, which assumes the fader sits at 0 dB (said in the result).
  async setTrackGainDb(trackIdx, dB) {
    await this._connect();
    if (!this.client.meetsFloor()) throw new Error("Fix levels needs Pro Tools 2025.10 or newer.");
    const sr = await this._rate();
    const tracks = (await this._tracks()).filter((t) => trackIdx.indexOf(t.index) >= 0);
    if (!tracks.length) throw new Error("Could not find those tracks in the session any more - press Refresh.");
    const lenR = await this.client.send("GetSessionLength", null).catch(() => ({}));
    const endSec = this._secOf(lenR.session_length, sr) || 4 * 3600;
    const control = { section: "TSId_MainOut", control_type: "TCType_Volume" };
    let assumed = 0;
    for (const t of tracks) {
      const info = await this.client.send("GetTrackControlInfo", { track_ids: [t.id], track_names: [t.name], control_id: control });
      const ci = (info.control_info || [])[0] || {};
      const min = typeof ci.min_value === "number" ? ci.min_value : -144;
      const max = typeof ci.max_value === "number" ? ci.max_value : 12;
      const cur = await this.client.send("GetTrackControlBreakpoints", { track_id: t.id, track_name: t.name, control_id: control }).catch(() => ({ breakpoints: [] }));
      let bps = (cur.breakpoints || []).map((b) => ({ time: b.time, value: Math.min(max, Math.max(min, Number(b.value) + dB)) }));
      if (!bps.length) {
        assumed++;
        bps = [
          { time: this._loc(0, sr), value: Math.min(max, Math.max(min, dB)) },
          { time: this._loc(endSec, sr), value: Math.min(max, Math.max(min, dB)) },
        ];
      }
      await this.client.send("SetTrackControlBreakpoints", { track_id: t.id, track_name: t.name, control_id: control, breakpoints: bps });
    }
    const out = { tracks: tracks.length };
    if (assumed) out.note = "Written as volume automation from the fader's 0 dB position on " + assumed + " track(s) - if that fader was not at 0 dB, Undo and set it by hand.";
    return out;
  }

  // ----- assembly -----

  async buildAssembly(files) {
    await this._connect();
    if (!files.length) return { added: 0, tracks: [] };
    const before = (await this._tracks()).map((t) => t.name);
    await this.client.send("Import", {
      session_path: "", import_type: "Audio",
      audio_data: {
        file_list: files.map((f) => f.path), audio_operations: "AddAudio", destination_path: "",
        destination: "MD_NewTrack", location: "ML_SessionStart",
        audio_destination: "MD_NewTrack", audio_location: "ML_SessionStart",
      },
    }, { timeoutMs: 600000 });
    const after = await this._tracks();
    const created = after.filter((t) => before.indexOf(t.name) < 0);
    const named = [];
    // Pro Tools names the new track after the file; rename to the speaker.
    for (const f of files) {
      const stem = path.basename(f.path).replace(/\.[^.]+$/, "").toLowerCase();
      const t = created.find((x) => x.name.toLowerCase() === stem || x.name.toLowerCase().indexOf(stem.slice(0, 24)) === 0);
      if (t && f.name && f.name !== t.name) {
        try {
          await this.client.send("RenameTargetTrack", { track_id: t.id, current_name: t.name, new_name: f.name });
          named.push(f.name);
        } catch (e) { named.push(t.name); }
      } else if (t) named.push(t.name);
    }
    return { added: created.length, tracks: named };
  }

  // ----- render + measure -----

  async _pollTask(taskId, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await this.client.send("GetTaskStatus", { task_id: taskId });
      const st = enumNumber(s.status, -1);
      if (st === STATUS.Completed) return;
      if (st === STATUS.Failed || st === 6 || st === 7) throw new Error("Pro Tools reported the bounce failed.");
    }
    throw new Error("The bounce did not finish in time.");
  }

  async render(opts) {
    await this._connect();
    const pathR = await this.client.send("GetSessionPath", null).catch(() => ({}));
    const sessionFile = (pathR.session_path && pathR.session_path.path) || "";
    const base = opts.outDir || (sessionFile ? (/\.(ptx|ptf)$/i.test(sessionFile) ? path.dirname(sessionFile) : sessionFile) : os.tmpdir());
    const dir = path.join(base, "Fame renders");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const name = String(opts.slug || "fame").toLowerCase().replace(/[^a-z0-9-]/g, "") + "-" + stamp;
    const srcR = await this.client.send("GetExportMixSourceList", null).catch(() => ({ source_list: [] }));
    const sources = srcR.source_list || [];
    const source = sources.find((s) => /out/i.test(s)) || sources[0];
    const startedAt = Date.now();
    const res = await this.client.sendFull("ExportMix", {
      preset_path: "", file_name: name, file_type: "EMFType_MP3", files_list: [],
      audio_info: {
        compression_type: "CT_None", export_format: "EF_Interleaved", bit_depth: "Bit24",
        sample_rate: "SR_None", pad_to_frame_boundary: "TB_False", delivery_format: "EM_DF_SingleFile", sample_rate_custom: 0,
      },
      video_info: { include_video: "TB_False", export_option: "EMVideoExportOptions_Unknown", replace_timecode_track: "TB_False", codec_info: { codec_name: "", property_list: [] } },
      location_info: { import_after_bounce: "TB_False", file_destination: "EM_FD_Directory", directory: dir, import_options: { import_destination: "MD_None", import_location: "ML_None", gaps_between_clips: 0, import_audio_from_file: "TB_False", remove_existing_video_tracks: "TB_False", remove_existing_video_clips: "TB_False", clear_destination_video_track_playlist: "TB_False" } },
      dolby_atmos_info: { add_first_frame_of_action: "TB_False", timecode_value: "", frame_rate: 0, property_list: [] },
      offline_bounce: "TB_True",
      mix_source_list: source ? [{ source_type: "EMSType_Output", name: source }] : [],
      audio_encoding_options: { encoding_options_mp3: { bit_rate: "MP3EOCBRate_320kbps", quality: "MP3EOQuality_Highest" } },
    }, { timeoutMs: 3600000 });
    const st = enumNumber(res.header.status, STATUS.Completed);
    if (st !== STATUS.Completed && res.header.task_id) await this._pollTask(res.header.task_id, 3600000);
    // Pro Tools may suffix the name; take the newest mp3 written since we started.
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      const files = fs.readdirSync(dir).filter((f) => /\.mp3$/i.test(f))
        .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .filter((x) => x.m >= startedAt - 5000).sort((a, b) => b.m - a.m);
      if (files.length) return { path: path.join(dir, files[0].f) };
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("The bounce finished but no MP3 appeared in " + dir + ".");
  }

  measure(file, opts) { return measure(file, opts); }

  async diagnostics() {
    const st = await this.status();
    let clips = null, error = null;
    if (st.connected && st.capabilities.readTimeline) {
      try { clips = await this.getClips(); } catch (e) { error = e.message; }
    }
    return { status: st, clips, error, raw: this.raw };
  }
}

module.exports = { ProToolsHands, FADE_PRESET, FADE_SEC };
