// Thin PTSL transport: one gRPC rpc, JSON bodies, Pro Tools' own version
// echoed in every header.
//
// Facts baked in (from Avid's PTSL.proto as shipped in SDK 2025.10):
// - Pro Tools listens on localhost:31416, service ptsl.PTSL.
// - Every command is SendGrpcRequest({header, request_body_json}); the
//   body is JSON with snake_case names and enum NAMES as strings.
// - HostReadyCheck works unregistered; RegisterConnection returns the
//   session_id every later header must carry.
// - Header status 3 = Completed, 4 = Failed (errors in response_error_json).
//
// The version triple in the header is read from the server first
// (GetPTSLVersion) and echoed back - py-ptsl hard-codes "5" and works, but
// echoing can never be too new for the server it is talking to.

const path = require("path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const COMMAND = require("./command-ids.json");

const STATUS = { Queued: 0, Pending: 1, InProgress: 2, Completed: 3, Failed: 4, WaitingForUserInput: 5 };

let pkg = null;
function loadPackage() {
  if (pkg) return pkg;
  const def = protoLoader.loadSync(path.join(__dirname, "..", "..", "proto", "ptsl.proto"), {
    keepCase: true, longs: Number, enums: String, defaults: true,
  });
  pkg = grpc.loadPackageDefinition(def).ptsl;
  return pkg;
}

class PtslError extends Error {
  constructor(message, errors, command) {
    super(message);
    this.name = "PtslError";
    this.errors = errors || [];
    this.command = command;
  }
}

class PtslClient {
  constructor(opts) {
    opts = opts || {};
    this.address = opts.address || "localhost:31416";
    this.company = opts.company || "Fame";
    this.application = opts.application || "Fame Pro Tools Plugin";
    this.timeoutMs = opts.timeoutMs || 20000;
    this.sessionId = "";
    this.version = { major: 1, minor: 0, revision: 0 };
    this.stub = null;
  }

  _stub() {
    if (!this.stub) {
      const P = loadPackage();
      this.stub = new P.PTSL(this.address, grpc.credentials.createInsecure());
    }
    return this.stub;
  }

  close() {
    if (this.stub) { try { this.stub.close(); } catch (e) { /* already closed */ } }
    this.stub = null;
    this.sessionId = "";
  }

  // Low-level: send one command. Resolves the parsed response body ({} when
  // empty). Rejects PtslError with the server's error list, or a plain
  // Error when Pro Tools is not reachable.
  send(command, body, opts) {
    return this.sendFull(command, body, opts).then((r) => r.body);
  }

  // Same, but resolves { header, body } - long jobs (ExportMix) answer with
  // an InProgress header and a task_id to poll.
  sendFull(command, body, opts) {
    opts = opts || {};
    const id = COMMAND[command];
    if (id === undefined) return Promise.reject(new Error("Unknown PTSL command " + command));
    const request = {
      header: {
        task_id: "",
        command: id,
        version: this.version.major,
        version_minor: this.version.minor,
        version_revision: this.version.revision,
        session_id: this.sessionId,
        versioned_request_header_json: "",
      },
      request_body_json: body ? JSON.stringify(body) : "",
    };
    const deadline = new Date(Date.now() + (opts.timeoutMs || this.timeoutMs));
    return new Promise((resolve, reject) => {
      this._stub().SendGrpcRequest(request, { deadline }, (err, res) => {
        if (err) {
          if (err.code === grpc.status.UNAVAILABLE) {
            return reject(new Error("Pro Tools is not running, or its scripting service is off (Setup > Preferences > Scripting)."));
          }
          if (err.code === grpc.status.DEADLINE_EXCEEDED) {
            return reject(new Error("Pro Tools did not answer " + command + " in time - is a dialog open in Pro Tools?"));
          }
          return reject(new Error("Pro Tools connection error on " + command + ": " + err.message));
        }
        const status = res.header ? res.header.status : STATUS.Failed;
        if (status === STATUS.Failed || res.response_error_json) {
          let errors = [];
          try { errors = (JSON.parse(res.response_error_json || "{}").errors) || []; } catch (e) { /* unparseable */ }
          const warningsOnly = errors.length > 0 && errors.every((e) => e.is_warning);
          if (!warningsOnly) {
            const msg = errors.map((e) => e.command_error_message).filter(Boolean).join("; ")
              || ("Pro Tools refused " + command + ".");
            return reject(new PtslError(msg, errors, command));
          }
        }
        let parsed = {};
        if (res.response_body_json) {
          try { parsed = JSON.parse(res.response_body_json); } catch (e) {
            return reject(new Error("Pro Tools sent an unreadable answer to " + command + "."));
          }
        }
        resolve({ header: res.header || {}, body: parsed });
      });
    });
  }

  // Ready check -> register -> learn the server's version. Idempotent.
  async connect() {
    if (this.sessionId) return this;
    await this.send("HostReadyCheck", null, { timeoutMs: 4000 });
    const reg = await this.send("RegisterConnection", { company_name: this.company, application_name: this.application });
    this.sessionId = reg.session_id || "";
    try {
      const v = await this.send("GetPTSLVersion", null);
      this.version = {
        major: Number(v.version) || 1,
        minor: Number(v.version_minor) || 0,
        revision: Number(v.version_revision) || 0,
      };
    } catch (e) {
      // Very old builds answer nothing here; stay on version 1.
    }
    return this;
  }

  // "2025.10" style label; pre-2025 builds report their PTSL integer (1-5).
  versionLabel() {
    const v = this.version;
    return v.major >= 2022 ? v.major + "." + v.minor : "PTSL v" + v.major;
  }

  // The commands the plugin's timeline features need arrived in
  // Pro Tools 2025.10 (GetPlaylistElements, track control breakpoints).
  meetsFloor() {
    const v = this.version;
    return v.major > 2025 || (v.major === 2025 && v.minor >= 10);
  }
}

module.exports = { PtslClient, PtslError, STATUS, COMMAND };
