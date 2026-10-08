// Shared test helpers: a minimal `vscode` stub for running the compiled modules in plain Node,
// and a launcher for mock_llm_server.py on a free port.
const Module = require("module");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

/** In-memory `customLlmRouter.*` configuration used by the stubbed workspace API. */
const config = {};

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== fn)) };
    };
  }
  fire(v) {
    this.listeners.forEach((l) => l(v));
  }
  dispose() {}
}
class CancellationTokenSource {
  constructor() {
    this.emitter = new EventEmitter();
    this.token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose() {}
}
class LanguageModelTextPart { constructor(value) { this.value = value; } }
class LanguageModelToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class LanguageModelToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class LanguageModelDataPart { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }

class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString {
  constructor(value = "", supportThemeIcons) { this.value = value; this.supportThemeIcons = supportThemeIcons; }
  appendMarkdown(s) { this.value += s; return this; }
}
/** Tree views created through the stub, so tests can fire checkbox events. */
const treeViews = [];

const vscodeStub = {
  TreeItem,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  window: {
    createTreeView: (id, options) => {
      const checkbox = new EventEmitter();
      const view = { id, options, onDidChangeCheckboxState: checkbox.event, fireCheckbox: (e) => checkbox.fire(e), dispose() {} };
      treeViews.push(view);
      return view;
    },
  },
  EventEmitter,
  CancellationTokenSource,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({
      get: (k) => config[k],
      update: async (k, v) => {
        config[k] = v;
      },
      inspect: (k) => ({ globalValue: config[k] }),
    }),
  },
};

function installVscodeStub() {
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return request === "vscode" ? "vscode" : original.call(this, request, ...rest);
  };
  require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };
  return vscodeStub;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Starts mock_llm_server.py and resolves once it answers /health. */
async function startMockServer() {
  const port = await freePort();
  const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const proc = spawn(python, ["-I", path.join(ROOT, "mock_llm_server.py"), String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return { port, url: `http://127.0.0.1:${port}`, stop: () => proc.kill() };
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) throw new Error(`mock server exited: ${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill();
  throw new Error(`mock server did not start: ${stderr}`);
}

function memento() {
  const data = new Map();
  return { get: (k, d) => (data.has(k) ? data.get(k) : d), update: async (k, v) => void data.set(k, v), data };
}

function secretStorage() {
  const data = new Map();
  return { get: async (k) => data.get(k), store: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k), data };
}

const silentLog = { info() {}, warn() {}, error() {} };

/** Tiny test runner: runs named async tests in order and reports. */
async function run(tests) {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n    ${(err && err.stack) || err}`);
    }
  }
  console.log(failed ? `\n${failed} test(s) failed` : `\nall ${tests.length} tests passed`);
  return failed;
}

module.exports = { ROOT, config, treeViews, EventEmitter, installVscodeStub, startMockServer, memento, secretStorage, silentLog, run };
