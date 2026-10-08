// Tests the sidebar tree (out/sidebarTree.js) against a fake engine with the stubbed `vscode` API.
const assert = require("assert");
const path = require("path");
const { ROOT, treeViews, EventEmitter, installVscodeStub, run } = require("./helpers");

const vscode = installVscodeStub();
const { RouterTreeProvider } = require(path.join(ROOT, "out", "sidebarTree.js"));

const model = (id, status, extra = {}) => ({
  key: `Lab::${id}`, providerName: "Lab", id, name: id.toUpperCase(), contextWindow: 32768, maxInputTokens: 30000, maxOutputTokens: 4096,
  contextSource: "server", caps: { tools: true, vision: false, reasoning: false, coding: true }, status, selected: false, isStatic: false, hasOverride: false, ...extra,
});
const models = [
  model("failed-one", "failed", { error: "HTTP 404" }),
  model("slow", "working", { latencyMs: 900 }),
  model("untested", "untested"),
  model("fast", "working", { latencyMs: 100, toolSupport: "called", pricing: { inputPerM: 2, outputPerM: 8, source: "server" }, stats: { requests: 4, failures: 1, ttftMs: 250, tokensPerSec: 40, costUsd: 0.0123 } }),
  model("chosen", "working", { latencyMs: 500, selected: true }),
];
const statuses = [
  { name: "Lab", endpointUrl: "http://lab:8000", enabled: true, online: true, latencyMs: 12, modelCount: 5, kind: "openai", api: "openai", keySource: "none", remote: false, secretHeaderNames: [], plaintextSecretHeaders: [] },
  { name: "Cloud", endpointUrl: "https://api.example.com", enabled: true, online: false, needsKey: true, error: "HTTP 401", modelCount: 0, kind: "openai", api: "openai", keySource: "none", remote: true, secretHeaderNames: [], plaintextSecretHeaders: ["X-Api-Key"] },
  { name: "Ollama", endpointUrl: "http://localhost:11434", enabled: true, online: true, modelCount: 0, kind: "ollama", api: "ollama", keySource: "none", remote: false, secretHeaderNames: [], plaintextSecretHeaders: [] },
  { name: "Off", endpointUrl: "http://x", enabled: false, modelCount: 0, kind: "openai", api: "openai", keySource: "none", remote: false, secretHeaderNames: [], plaintextSecretHeaders: [] },
];

const changed = new EventEmitter();
const calls = { setSelected: [], verify: [] };
const engine = {
  onDidChange: changed.event,
  verifyProgress: undefined,
  isDiscovered: true,
  ensureDiscovered: async () => undefined,
  getProviderStatuses: () => statuses,
  getModels: (name) => (name ? models.filter((m) => m.providerName === name) : models),
  getModel: (key) => models.find((m) => m.key === key),
  getCopilotModels: () => models.filter((m) => m.selected && m.status === "working"),
  verify: async (list) => void calls.verify.push(list.map((m) => m.key)),
  store: { getProviders: () => statuses, setSelected: async (keys, selected) => void calls.setSelected.push([keys, selected]) },
};

const tree = new RouterTreeProvider(engine);
const view = treeViews.at(-1);
const item = (node) => tree.getTreeItem(node);

run([
  ["registers the providers view with manual checkbox handling", () => {
    assert.strictEqual(view.id, "llmRouter.providers");
    assert.strictEqual(view.options.manageCheckboxStateManually, true);
  }],

  ["provider items show health, Copilot count, missing keys and Ollama context", () => {
    const [lab, cloud, ollama, off] = tree.getChildren().map(item);
    assert.deepStrictEqual([lab.description, lab.iconPath.id, lab.contextValue], ["1 of 5 in Copilot", "circle-filled", "provider.enabled"]);
    assert.deepStrictEqual([cloud.description, cloud.iconPath.id, cloud.contextValue], ["API key needed", "key", "provider.enabled.needskey"]);
    assert.ok(cloud.tooltip.value.includes("X-Api-Key stored in plain text"));
    assert.strictEqual(ollama.contextValue, "provider.enabled.ollama");
    assert.deepStrictEqual([off.description, off.contextValue, off.collapsibleState], ["disabled", "provider.disabled", 0]);
  }],

  ["models sort selected first, then working by latency, then untested, then failed", () => {
    const order = tree.getChildren({ kind: "provider", name: "Lab" }).map((n) => n.key.split("::")[1]);
    assert.deepStrictEqual(order, ["chosen", "fast", "slow", "untested", "failed-one"]);
  }],

  ["model items carry checkbox, status, tools, price, speed and spend", () => {
    const fast = item({ kind: "model", key: "Lab::fast" });
    assert.strictEqual(fast.checkboxState.state, vscode.TreeItemCheckboxState.Unchecked);
    assert.strictEqual(fast.description, "100ms · tools");
    assert.strictEqual(fast.contextValue, "model.working");
    const tip = fast.tooltip.value;
    for (const s of ["calls tools", "$2/M in · $8/M out", "4 chat requests, 1 failed", "first token 250ms", "40 tok/s", "~$0.0123"]) assert.ok(tip.includes(s), `tooltip has "${s}"`);
    assert.strictEqual(item({ kind: "model", key: "Lab::chosen" }).checkboxState.state, vscode.TreeItemCheckboxState.Checked);
    assert.strictEqual(item({ kind: "model", key: "Lab::failed-one" }).description, "failed");
    assert.strictEqual(tree.getParent({ kind: "model", key: "Lab::fast" }).name, "Lab");
  }],

  ["ticking an untested model selects and verifies it; unticking deselects", async () => {
    view.fireCheckbox({ items: [[{ kind: "model", key: "Lab::untested" }, 1], [{ kind: "model", key: "Lab::chosen" }, 0]] });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(calls.setSelected, [[["Lab::untested"], true], [["Lab::chosen"], false]]);
    assert.deepStrictEqual(calls.verify, [["Lab::untested"]]);
  }],

  ["view shows verification progress and the Copilot count", () => {
    engine.verifyProgress = { done: 2, total: 5, working: 2, failed: 0 };
    changed.fire();
    assert.strictEqual(view.message, "Verifying models… 2/5");
    assert.strictEqual(view.description, "1 in Copilot");
    engine.verifyProgress = undefined;
    changed.fire();
    assert.strictEqual(view.message, undefined);
  }],
]).then((n) => process.exit(n ? 1 : 0));
