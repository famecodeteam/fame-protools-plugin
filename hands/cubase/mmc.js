// MIDI Machine Control out of the app and into Cubase.
//
// Cubase has no scripting door to its transport, but it has followed MMC
// since the SX days: Transport > Project Synchronization Setup > Machine
// Control > "MMC Slave Active", pick the MIDI input. So the Plugin sends
// LOCATE (a SysEx with an hours:minutes:seconds:frames target) and then
// DEFERRED PLAY / STOP - the same bytes a hardware controller sends.
//
// Ports: on macOS the app publishes its OWN virtual port ("Fame Plugin"),
// so Cubase sees it directly and nobody has to enable the IAC bus. Windows
// cannot create virtual ports from user code, so the editor installs
// loopMIDI once and the app opens that port by name.
//
// Bytes (MMC spec, universal real-time SysEx):
//   F0 7F <dev> 06 <cmd> ... F7   cmd 01 STOP, 02 PLAY, 03 DEFERRED PLAY,
//                                 44 06 01 hh mm ss ff sf = LOCATE target
//   hh carries the frame-rate code in bits 5-6 (0=24, 1=25, 2=30 drop, 3=30).

"use strict";

const VIRTUAL_NAME = "Fame Plugin";
const ALL_DEVICES = 0x7f;

function rateCode(fps, drop) {
  if (fps === 24 || fps === 23.976) return 0;
  if (fps === 25) return 1;
  if (drop) return 2;
  return 3; // 30 / 29.97 non-drop, and Cubase's 50/60 which MMC has no code for
}

// Timecode frames for a moment in seconds at the project frame rate.
// 29.97 and 23.976 count frames at the nominal rate (30/24) - Cubase's
// own timecode ruler does the same for the frame number.
function toTimecode(sec, fps, drop) {
  const nominal = fps === 29.97 ? 30 : fps === 23.976 ? 24 : fps === 59.94 ? 60 : fps;
  const totalFrames = Math.round(Math.max(0, sec) * nominal);
  const perHour = nominal * 3600, perMin = nominal * 60;
  const hh = Math.floor(totalFrames / perHour);
  const mm = Math.floor((totalFrames % perHour) / perMin);
  const ss = Math.floor((totalFrames % perMin) / nominal);
  const ff = totalFrames % nominal;
  return { hh, mm, ss, ff: Math.min(ff, 29), sub: 0 };
}

function locateMessage(sec, fps, drop, device) {
  const tc = toTimecode(sec, fps, drop);
  const hhByte = ((rateCode(fps, drop) & 3) << 5) | (tc.hh & 0x1f);
  return [0xf0, 0x7f, device == null ? ALL_DEVICES : device, 0x06, 0x44, 0x06, 0x01, hhByte, tc.mm, tc.ss, tc.ff, tc.sub, 0xf7];
}
function commandMessage(cmd, device) { return [0xf0, 0x7f, device == null ? ALL_DEVICES : device, 0x06, cmd, 0xf7]; }
const CMD = { STOP: 0x01, PLAY: 0x02, DEFERRED_PLAY: 0x03 };

function loadMidi() {
  try { return require("@julusian/midi"); } catch (e) { return null; }
}

class MmcSender {
  constructor(opts) {
    opts = opts || {};
    this.portName = opts.portName || "";    // "" = the app's own virtual port (macOS)
    this.device = opts.device == null ? ALL_DEVICES : opts.device;
    this.out = null;
    this.opened = "";
    this.sent = [];                          // last few messages, for Diagnostics
    this.midi = opts.midi || loadMidi();
  }

  listPorts() {
    if (!this.midi) return [];
    const o = new this.midi.Output();
    const names = [];
    for (let i = 0; i < o.getPortCount(); i++) names.push(o.getPortName(i));
    o.closePort();
    return names;
  }

  canVirtual() { return process.platform !== "win32"; }

  open() {
    if (this.out) return this.opened;
    if (!this.midi) throw new Error("The MIDI module did not load on this machine - reinstall the app.");
    const out = new this.midi.Output();
    if (!this.portName && this.canVirtual()) {
      out.openVirtualPort(VIRTUAL_NAME);
      this.opened = VIRTUAL_NAME + " (virtual)";
    } else {
      let idx = -1;
      for (let i = 0; i < out.getPortCount(); i++) if (out.getPortName(i) === this.portName) idx = i;
      if (idx < 0 && this.portName) {
        for (let i = 0; i < out.getPortCount(); i++) if (out.getPortName(i).toLowerCase().indexOf(this.portName.toLowerCase()) >= 0) idx = i;
      }
      if (idx < 0) {
        const names = [];
        for (let i = 0; i < out.getPortCount(); i++) names.push(out.getPortName(i));
        throw new Error(this.portName
          ? "MIDI port \"" + this.portName + "\" is not there" + (names.length ? " (found: " + names.join(", ") + ")" : "") + " - pick another in Cubase setup."
          : "No MIDI port to send on. Install loopMIDI, add a port, then pick it in Cubase setup.");
      }
      out.openPort(idx);
      this.opened = out.getPortName(idx);
    }
    this.out = out;
    return this.opened;
  }

  close() { if (this.out) { try { this.out.closePort(); } catch (e) {} this.out = null; this.opened = ""; } }

  _send(bytes) {
    this.open();
    this.out.sendMessage(bytes);
    this.sent.push(bytes.map(function (b) { return b.toString(16).padStart(2, "0"); }).join(" "));
    if (this.sent.length > 8) this.sent.shift();
  }

  locate(sec, fps, drop) { this._send(locateMessage(sec, fps, drop, this.device)); }
  play() { this._send(commandMessage(CMD.DEFERRED_PLAY, this.device)); }
  stop() { this._send(commandMessage(CMD.STOP, this.device)); }

  // Locate then (optionally) play. STOP first so a running transport does
  // not ignore the locate - Cubase honours LOCATE while stopped.
  jump(sec, play, fps, drop) {
    this.stop();
    this.locate(sec, fps, drop);
    if (play) this.play();
  }
}

module.exports = { MmcSender, locateMessage, commandMessage, toTimecode, rateCode, CMD, VIRTUAL_NAME, loadMidi };
