// A mock Pro Tools: a gRPC server speaking the PTSL envelope with an
// in-memory session, so the adapter is exercised end to end (real gRPC,
// real JSON bodies, real command ids) with no Pro Tools installed.
//
// It models what the adapter relies on: tracks with main playlists of
// elements (samples), clip definitions with source ranges, file paths,
// timeline selection, edit modes, link options, Clear in Shuffle (ripple)
// and Slip (gap), fades by named preset, volume breakpoints, Import to new
// tracks, ExportMix (writes a real MP3 through ffmpeg so measure() runs
// for real). Behaviour follows the SDK docs as read for Phase 0; the first
// real-session run is what validates the assumptions marked VERIFY.

const path = require("path");
const fs = require("fs");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const { spawnSync } = require("child_process");
const COMMAND = require("../hands/protools/command-ids.json");

const BY_ID = {};
Object.keys(COMMAND).forEach((k) => { if (BY_ID[COMMAND[k]] === undefined) BY_ID[COMMAND[k]] = k; });

function fail(type, message) {
  const e = new Error(message);
  e.ptsl = { command_error_type: type, command_error_message: message, is_warning: false };
  return e;
}

class MockSession {
  constructor(opts) {
    opts = opts || {};
    this.sampleRate = opts.sampleRate || 48000;
    this.name = opts.name || "Fame Test Session";
    this.folder = opts.folder || path.join(__dirname, "out", "session");
    this.version = opts.version || { major: 2025, minor: 10, revision: 0 };
    this.fadePresets = opts.fadePresets || ["Fame 10ms"];
    this.tracks = [];
    this.files = {};
    this.nextId = 1;
    this.editMode = "EMode_Slip";
    this.options = { tab_to_transients: false, link_timeline_and_edit_selection: false, link_track_and_edit_selection: false, insertion_follows_playback: false, automation_follows_edit: true, markers_follow_edit: false, mirrored_midi_editing: false, layered_editing: false };
    this.selection = { in: 0, out: 0 };
    this.playing = false;
    this.fades = [];       // { track, at }
    this.log = [];         // every command name in order
    this.registered = false;
    this.exports = [];
  }
  id(prefix) { return prefix + "-" + (this.nextId++); }
  addFile(p) {
    const fid = this.id("file");
    this.files[fid] = p;
    return fid;
  }
  // el: { start, end, fileId, srcStart } in SECONDS; stored in samples.
  addTrack(name, elements, extra) {
    const sr = this.sampleRate;
    const t = Object.assign({
      id: this.id("track"), name, type: "TType_Audio", index: this.tracks.length, selected: false, muted: false,
      playlistId: this.id("pl"), breakpoints: null,
      elements: (elements || []).map((e) => ({
        id: this.id("clip"), start: Math.round(e.start * sr), end: Math.round(e.end * sr),
        fileId: e.fileId, srcStart: Math.round((e.srcStart || 0) * sr), muted: !!e.muted,
      })),
    }, extra || {});
    this.tracks.push(t);
    return t;
  }
  // Seconds view for assertions.
  view() {
    const sr = this.sampleRate;
    return this.tracks.map((t) => ({
      name: t.name, selected: t.selected,
      elements: t.elements.map((e) => ({ start: e.start / sr, end: e.end / sr, srcStart: e.srcStart / sr, file: path.basename(this.files[e.fileId] || "") })),
      breakpoints: t.breakpoints ? t.breakpoints.map((b) => ({ t: Number(b.time.location) / sr, v: b.value })) : null,
    }));
  }

  handle(cmd, body) {
    this.log.push(cmd);
    if (!this.registered && cmd !== "HostReadyCheck" && cmd !== "RegisterConnection") throw fail("PT_UnknownError", "not registered");
    const sr = this.sampleRate;
    const loc = (samples) => ({ location: String(samples), time_type: "TLType_Samples" });
    const toSamples = (s) => Number(s);
    const needFloor = (minor) => {
      if (this.version.major < 2025 || (this.version.major === 2025 && this.version.minor < minor)) throw fail("PT_UnknownError", "Unknown command for this version");
    };
    switch (cmd) {
      case "HostReadyCheck": return {};
      case "RegisterConnection": this.registered = true; return { session_id: "mock-session-1" };
      case "GetPTSLVersion": return { version: this.version.major, version_minor: this.version.minor, version_revision: this.version.revision };
      case "GetSessionSampleRate": return { sample_rate: "SR_" + sr };
      case "GetSessionName": return { session_name: this.name };
      case "GetSessionPath": return { session_path: { path: path.join(this.folder, this.name + ".ptx"), info: { is_online: true }, file_id: "" } };
      case "GetSessionLength": return { session_length: String(Math.max(0, ...this.tracks.flatMap((t) => t.elements.map((e) => e.end)))) };
      case "GetTrackList":
        return { track_list: this.tracks.map((t) => ({ name: t.name, type: t.type, id: t.id, index: t.index, color: "", track_attributes: { is_selected: t.selected ? "TAState_SetExplicitly" : "TAState_None", contains_clips: t.elements.length > 0, is_muted: t.muted } })), stats: { total: this.tracks.length, limit: 2000, offset: 0 } };
      case "GetTrackPlaylists": {
        needFloor(10);
        const t = this.tracks.find((x) => x.id === body.track_id || x.name === body.track_name);
        if (!t) throw fail("PT_NoTrackFound", "no such track");
        return { playlists: [{ playlist_id: t.playlistId, playlist_name: t.name + ".01", is_target: true, is_solo_comp_lane_on: false, playlist_type: "PType_Main" }] };
      }
      case "GetPlaylistElements": {
        needFloor(10);
        const t = this.tracks.find((x) => x.playlistId === body.playlist_id);
        if (!t) throw fail("PT_NoTrackFound", "no such playlist");
        return { elements_list: t.elements.map((e) => ({
          element_location: loc(e.start), start_time: loc(e.start), play_time: loc(e.start), stop_time: loc(e.end), end_time: loc(e.end),
          channel_clips: [{ is_null: false, clip_id: e.id, fade_info: {} }],
          clip_instance_attributes: { color_index: 0, is_muted: e.muted, locked_states: [] },
        })) };
      }
      case "GetClipList": {
        needFloor(6);
        const clips = [];
        this.tracks.forEach((t) => t.elements.forEach((e) => clips.push({
          file_id: e.fileId, clip_id: e.id, clip_full_name: path.basename(this.files[e.fileId] || "clip").replace(/\.[^.]+$/, "") + "-" + e.id.split("-")[1],
          clip_root_name: path.basename(this.files[e.fileId] || ""), clip_type: "ClipType_Audio",
          start_point: { position: 0, time_type: "BTType_Samples" }, end_point: { position: e.end - e.start, time_type: "BTType_Samples" },
          src_start_point: { position: e.srcStart, time_type: "BTType_Samples" }, src_end_point: { position: e.srcStart + (e.end - e.start), time_type: "BTType_Samples" },
        })));
        return { clips, pagination_response: { total: clips.length, limit: 2000, offset: 0 } };
      }
      case "GetFileLocation":
        return { file_locations: Object.keys(this.files).map((fid) => ({ path: this.files[fid], info: { is_online: true }, file_id: fid })) };
      case "GetTransportState": return { current_setting: this.playing ? "TS_TransportPlaying" : "TS_TransportStopped", possible_settings: [] };
      case "TogglePlayState": this.playing = !this.playing; return {};
      case "SetTimelineSelection": this.selection = { in: toSamples(body.in_time), out: toSamples(body.out_time) }; return {};
      case "GetTimelineSelection": return { play_start_marker_time: String(this.selection.in), in_time: String(this.selection.in), out_time: String(this.selection.out), pre_roll_enabled: false, post_roll_enabled: false };
      case "GetEditMode": return { current_setting: this.editMode, possible_settings: ["EMode_Shuffle", "EMode_Slip", "EMode_Spot"] };
      case "SetEditMode": this.editMode = body.edit_mode; return {};
      case "GetEditModeOptions": return { edit_mode_options: Object.assign({}, this.options) };
      case "SetEditModeOptions": this.options = Object.assign({}, this.options, body.edit_mode_options || {}); return {};
      case "SelectTracksByName": {
        const names = body.track_names || [];
        const mode = String(body.selection_mode || "SM_Replace");
        this.tracks.forEach((t) => {
          if (/Replace/i.test(mode)) t.selected = names.indexOf(t.name) >= 0;
          else if (/Add/i.test(mode) && names.indexOf(t.name) >= 0) t.selected = true;
          else if (/Subtract/i.test(mode) && names.indexOf(t.name) >= 0) t.selected = false;
        });
        return { track_list: this.tracks.filter((t) => t.selected).map((t) => ({ name: t.name, id: t.id })) };
      }
      case "Clear": return this._clear();
      case "CreateFadesBasedOnPreset": {
        if (this.fadePresets.indexOf(body.fade_preset_name) < 0) throw fail("PT_NoPresetFound", "No fade preset named " + body.fade_preset_name);
        const { in: a, out: b } = this.selection;
        let n = 0;
        this.tracks.filter((t) => t.selected).forEach((t) => t.elements.forEach((e) => {
          if (e.start > a && e.start < b) { this.fades.push({ track: t.name, at: e.start / sr, kind: "in" }); n++; }
          if (e.end > a && e.end < b) { this.fades.push({ track: t.name, at: e.end / sr, kind: "out" }); n++; }
        }));
        if (!n) throw fail("PT_NoSelection", "No clip boundary in the selection");
        return {};
      }
      case "GetTrackControlInfo": needFloor(10); return { control_info: [{ control_id: body.control_id, max_value: 12, min_value: -144, steps: 0 }] };
      case "GetTrackControlBreakpoints": {
        needFloor(10);
        const t = this.tracks.find((x) => x.id === body.track_id || x.name === body.track_name);
        if (!t) throw fail("PT_NoTrackFound", "no such track");
        return { breakpoints: t.breakpoints || [] };
      }
      case "SetTrackControlBreakpoints": {
        needFloor(10);
        const t = this.tracks.find((x) => x.id === body.track_id || x.name === body.track_name);
        if (!t) throw fail("PT_NoTrackFound", "no such track");
        t.breakpoints = (body.breakpoints || []).map((b) => ({ time: b.time, value: b.value }));
        return {};
      }
      case "GetExportMixSourceList": return { source_list: ["Out 1-2", "Bus 1-2"] };
      case "ExportMix": {
        const dir = body.location_info.directory;
        fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, body.file_name + ".mp3");
        const ff = process.env.FAME_FFMPEG || (function () { try { return require("ffmpeg-static"); } catch (e) { return "ffmpeg"; } })();
        // 3 s of 1 kHz tone: loudness and true peak are then known values.
        const r = spawnSync(ff, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=3", "-ac", "2", "-b:a", "320k", out], { encoding: "utf8" });
        if (r.status !== 0) throw fail("OS_WritePermissions", "mock ffmpeg failed: " + (r.stderr || r.error));
        this.exports.push({ out, body });
        return {};
      }
      case "GetTaskStatus": return { task_id: body.task_id, status: "Completed", progress: 100 };
      case "Import": {
        const files = (body.audio_data && body.audio_data.file_list) || [];
        files.forEach((p) => {
          const fid = this.addFile(p);
          const dur = 30;
          this.addTrack(path.basename(p).replace(/\.[^.]+$/, ""), [{ start: 0, end: dur, fileId: fid, srcStart: 0 }]);
        });
        return { file_list: files };
      }
      case "RenameTargetTrack": {
        const t = this.tracks.find((x) => x.id === body.track_id || x.name === body.current_name);
        if (!t) throw fail("PT_NoTrackFound", "no such track");
        t.name = body.new_name;
        return {};
      }
      case "Undo": return {};
      default:
        throw fail("PT_UnknownError", "mock does not implement " + cmd);
    }
  }

  // Clear the timeline selection on the selected tracks. Shuffle ripples
  // later material up; Slip leaves a gap. VERIFY on a real session that
  // Clear honours the edit mode this way (Pro Tools manual: yes).
  _clear() {
    const { in: a, out: b } = this.selection;
    if (b <= a) throw fail("PT_NoSelection", "empty selection");
    const shuffle = /Shuffle/i.test(this.editMode);
    const len = b - a;
    this.tracks.filter((t) => t.selected).forEach((t) => {
      const next = [];
      t.elements.forEach((e) => {
        if (e.end <= a || e.start >= b) {
          if (shuffle && e.start >= b) { e.start -= len; e.end -= len; }
          next.push(e);
          return;
        }
        if (e.start < a) next.push({ id: this.id("clip"), start: e.start, end: a, fileId: e.fileId, srcStart: e.srcStart, muted: e.muted });
        if (e.end > b) {
          const right = { id: this.id("clip"), start: shuffle ? a : b, end: shuffle ? e.end - len : e.end, fileId: e.fileId, srcStart: e.srcStart + (b - e.start), muted: e.muted };
          next.push(right);
        }
      });
      t.elements = next.sort((x, y) => x.start - y.start);
    });
    return {};
  }
}

function startMockServer(session, port) {
  const def = protoLoader.loadSync(path.join(__dirname, "..", "proto", "ptsl.proto"), { keepCase: true, longs: Number, enums: String, defaults: true });
  const pkg = grpc.loadPackageDefinition(def).ptsl;
  const server = new grpc.Server();
  server.addService(pkg.PTSL.service, {
    SendGrpcRequest(call, cb) {
      const h = call.request.header || {};
      const name = BY_ID[h.command] || String(h.command);
      let body = {};
      try { body = call.request.request_body_json ? JSON.parse(call.request.request_body_json) : {}; } catch (e) { body = {}; }
      const header = { task_id: h.task_id || "", command: h.command, status: 3, progress: 100, version: session.version.major, version_minor: session.version.minor, version_revision: session.version.revision };
      try {
        const res = session.handle(name, body, h);
        cb(null, { header, response_body_json: res && Object.keys(res).length ? JSON.stringify(res) : "", response_error_json: "" });
      } catch (e) {
        header.status = 4;
        const err = e.ptsl || { command_error_type: "PT_UnknownError", command_error_message: e.message, is_warning: false };
        cb(null, { header, response_body_json: "", response_error_json: JSON.stringify({ errors: [err] }) });
      }
    },
    SendGrpcStreamingRequest(call) { call.end(); },
  });
  return new Promise((resolve, reject) => {
    server.bindAsync("127.0.0.1:" + (port || 0), grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) return reject(err);
      resolve({ server, port: boundPort, close: () => server.forceShutdown() });
    });
  });
}

module.exports = { MockSession, startMockServer };
