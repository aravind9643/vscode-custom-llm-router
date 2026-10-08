// Drives media/dashboard.js in jsdom with a fake extension host: rendering, escaping and the message protocol.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { ROOT, run } = require("./helpers");

const script = fs.readFileSync(path.join(ROOT, "media", "dashboard.js"), "utf8");

function boot() {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => {} });
  window.eval(script);
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];
  return {
    window, sent, $, $$,
    deliver: (data) => window.dispatchEvent(new window.MessageEvent("message", { data })),
    click: (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    change: (el) => el.dispatchEvent(new window.Event("change", { bubbles: true })),
    input: (el, v) => {
      el.value = v;
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    key: (el, key) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })),
  };
}

const settings = { testConcurrency: 8, providerConcurrency: 3, cacheTtlHours: 48, showReasoning: true, toolCheck: "full" };
const evil = '<img src=x onerror="window.pwned=1">';
const mk = (id, status, extra = {}) => ({
  key: "Groq::" + id, providerName: "Groq", id, name: id === "evil" ? evil : id.toUpperCase(), contextWindow: 131072, maxInputTokens: 120000,
  maxOutputTokens: 8192, contextSource: "server", hasOverride: false,
  caps: { tools: true, vision: false, reasoning: id.includes("r1"), coding: true }, status, selected: false, isStatic: false, ...extra,
});
const baseState = () => ({
  providers: [
    { name: "Groq", endpointUrl: "https://api.groq.com/openai/v1", enabled: true, online: true, latencyMs: 80, modelCount: 3, keySource: "secret", kind: "openai" },
    { name: "Lab <x>", endpointUrl: "http://10.0.0.5:8000", enabled: true, online: false, error: "Timed out", modelCount: 0, keySource: "settings", kind: "openai" },
    { name: "Ollama", endpointUrl: "http://localhost:11434", enabled: true, online: true, latencyMs: 5, modelCount: 0, keySource: "none", kind: "ollama", api: "ollama" },
    { name: "Claude", endpointUrl: "https://api.anthropic.com", enabled: true, online: false, needsKey: true, error: "HTTP 401", modelCount: 0, keySource: "none", kind: "openai", api: "anthropic", plaintextSecretHeaders: ["X-Api-Key"] },
  ],
  models: [
    mk("llama-70b", "working", { latencyMs: 420, toolSupport: "called", pricing: { inputPerM: 0.59, outputPerM: 0.79, source: "server" }, stats: { requests: 3, failures: 0, ttftMs: 310, tokensPerSec: 55.5, costUsd: 0.0042 } }),
    mk("deepseek-r1", "untested", { contextSource: "guess" }),
    mk("evil", "failed", { error: "<b>404</b>" }),
    mk("mixtral", "working", { latencyMs: 900, toolSupport: "accepted" }),
  ],
  routes: [], overrides: {}, discovered: true, verifying: null, spend: 0.0042, settings,
});

const t = boot();
const failed = (async () => run([
  ["announces ready and starts on providers when empty", () => {
    assert.deepStrictEqual(t.sent[0], { type: "ready" });
    t.deliver({ type: "state", state: { ...baseState(), providers: [], models: [] } });
    assert.ok(t.$("#panel-providers").classList.contains("active"));
    assert.ok(t.$$(".preset").length >= 10);
  }],

  ["preset → editor → validation → saveProvider payload (with keep-alive)", () => {
    t.click(t.$('[data-preset="groq"]'));
    assert.strictEqual(t.$("#f-name").value, "Groq");
    assert.ok(t.$("#urlPreview").textContent.includes("https://api.groq.com/openai/v1/chat/completions"));
    t.input(t.$("#f-apiKey"), "gsk_secret");
    t.input(t.$("#f-endpointUrl"), "not a url");
    t.click(t.$('[data-action="save-draft"]'));
    assert.ok(t.$("#err-endpointUrl").textContent.length > 0);
    assert.ok(!t.sent.some((m) => m.type === "saveProvider"));
    t.input(t.$("#f-endpointUrl"), "https://api.groq.com/openai/v1");
    t.input(t.$("#f-headersText"), "X-Title: VS Code\nbadline");
    t.click(t.$('[data-action="save-draft"]'));
    assert.ok(t.$("#err-headersText").textContent.includes("Line 2"));
    t.input(t.$("#f-headersText"), "X-Title: VS Code");
    t.input(t.$("#f-keepAlive"), "30m");
    t.click(t.$('[data-action="save-draft"]'));
    const save = t.sent.find((m) => m.type === "saveProvider");
    assert.deepStrictEqual(save.provider.headers, { "X-Title": "VS Code" });
    assert.strictEqual(save.provider.keepAlive, "30m");
    assert.strictEqual(save.apiKey, "gsk_secret");
    t.deliver({ type: "saveResult", ok: true, name: "Groq" });
    assert.ok(t.$("#toast").textContent.includes("Added Groq"));
  }],

  ["hostile model and provider names are escaped", () => {
    t.deliver({ type: "state", state: baseState() });
    assert.strictEqual(t.window.pwned, undefined);
    assert.strictEqual(t.$$("img").length, 0);
    assert.ok(t.$("#panel-providers").innerHTML.includes("Lab &lt;x&gt;"));
    assert.ok(t.$("#panel-providers").textContent.includes("Key in plain-text settings"));
  }],

  ["Ollama providers get a Pull model action", () => {
    const pull = t.$$('[data-action="pull-ollama"]');
    assert.strictEqual(pull.length, 1);
    t.click(pull[0]);
    assert.deepStrictEqual(t.sent.at(-1), { type: "pullOllama", name: "Ollama" });
  }],

  ["models table: banners, filters, sorting, selection", () => {
    t.click(t.$('[data-tab="models"]'));
    assert.strictEqual(t.$$("#tbody tr").length, 4);
    assert.ok(t.$("#banners").textContent.includes("Lab <x> is unreachable"));
    t.click(t.$('[data-action="add-all-working"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "setSelected", keys: ["Groq::llama-70b", "Groq::mixtral"], selected: true });
    assert.ok(t.$('[data-key="Groq::evil"][data-action="toggle-model"]').disabled);
    t.click(t.$('[data-status="working"]'));
    assert.strictEqual(t.$$("#tbody tr").length, 2);
    t.click(t.$('[data-status="all"]'));
    t.click(t.$('[data-cap="reasoning"]'));
    assert.strictEqual(t.$$("#tbody tr").length, 1);
    t.click(t.$('[data-action="reset-filters"]'));
    t.input(t.$("#q"), "LLAMA");
    assert.strictEqual(t.$$("#tbody tr").length, 1);
    t.input(t.$("#q"), "");
    t.click(t.$('[data-col="name"]'));
    assert.strictEqual(t.$$("#tbody .model-name")[2].textContent, "LLAMA-70B");
    t.click(t.$('[data-action="curate-top"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "curateTop", limit: 10 });
  }],

  ["tool support, estimated context and speed stats are shown", () => {
    const html = t.$("#tbody").innerHTML;
    assert.ok(html.includes("cap tools weak"), "accepted-but-not-called tools are flagged");
    assert.ok(t.$("#tbody").textContent.includes("310ms first token · 55.5 tok/s · ~$0.0042"), t.$("#tbody").textContent);
    assert.ok(t.$("#tbody .price").textContent === "$0.59 · $0.79", "prices keep their dollar signs");
    assert.ok(t.$("#stats").textContent.includes("~$0.0042 spent"));
    assert.ok(t.$$(".col-ctx.guess").some((td) => td.textContent.startsWith("~")), "guessed context marked with ~");
  }],

  ["limits editor saves an override and survives live updates", () => {
    t.click(t.$('[data-action="edit-limits"][data-key="Groq::deepseek-r1"]'));
    assert.ok(t.$("#limitsRow"));
    t.$('#limitsRow [data-lim="contextWindow"]').value = "32768";
    t.$('#limitsRow [data-lim="toolCalling"]').value = "off";
    t.$('#limitsRow [data-lim="contextWindow"]').focus();
    t.deliver({ type: "state", state: baseState() });
    assert.strictEqual(t.$('#limitsRow [data-lim="contextWindow"]').value, "32768", "typing not wiped by state push");
    t.key(t.$('#limitsRow [data-lim="contextWindow"]'), "Enter");
    assert.deepStrictEqual(t.sent.at(-1), { type: "setOverride", key: "Groq::deepseek-r1", override: { contextWindow: 32768, toolCalling: false } });
    t.click(t.$('[data-action="edit-limits"][data-key="Groq::llama-70b"]'));
    t.$('#limitsRow [data-lim="inputPerM"]').value = "0";
    t.$('#limitsRow [data-lim="outputPerM"]').value = "1.5";
    t.click(t.$('[data-action="save-limits"]'));
    assert.deepStrictEqual(t.sent.at(-1).override, { inputPerM: 0, outputPerM: 1.5 }, "free (0) prices are kept");
    assert.strictEqual(t.$("#limitsRow"), null);
  }],

  ["focus message opens a model's limits editor", () => {
    t.deliver({ type: "focus", tab: "models", editModel: "Groq::mixtral" });
    assert.strictEqual(t.$("#q").value, "mixtral");
    assert.ok(t.$("#limitsRow"));
    t.click(t.$('[data-action="close-limits"]'));
  }],

  ["routes: create, add members, reorder, delete", () => {
    t.click(t.$('[data-tab="routes"]'));
    assert.ok(t.$("#panel-routes").classList.contains("active"));
    t.$("#newRouteName").value = "Coding (auto)";
    t.click(t.$('[data-action="route-create"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "saveRoutes", routes: [{ name: "Coding (auto)", models: [] }] });
    const add = (key) => {
      const sel = t.$('[data-route-add="Coding (auto)"]');
      sel.value = key;
      t.change(sel);
    };
    add("Groq::mixtral");
    add("Groq::llama-70b");
    assert.ok(!t.$('[data-route-add="Coding (auto)"]').innerHTML.includes("Groq::evil"), "failed models are not offered");
    t.click(t.$('[data-action="route-move"][data-index="1"][data-dir="-1"]'));
    assert.deepStrictEqual(t.sent.at(-1).routes[0].models, ["Groq::llama-70b", "Groq::mixtral"]);
    assert.ok(t.$("#panel-routes").textContent.includes("2/2 working"));
    const pol = t.$('[data-action="route-policy"]');
    pol.value = "round-robin";
    t.change(pol);
    assert.strictEqual(t.sent.at(-1).routes[0].policy, "round-robin");
    t.click(t.$('[data-action="route-delete"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "saveRoutes", routes: [] });
    t.click(t.$('[data-action="auto-routes"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "autoRoutes" });
  }],

  ["long model lists render in a scroll window", () => {
    const many = Array.from({ length: 1500 }, (_, i) => mk(`m-${String(i).padStart(4, "0")}`, "working", { latencyMs: 100 + i }));
    t.deliver({ type: "state", state: { ...baseState(), models: many } });
    t.click(t.$('[data-tab="models"]'));
    t.click(t.$('[data-action="reset-filters"]')); // the focus test left a search filter behind
    const rendered = t.$$("#tbody tr:not(.spacer)").length;
    assert.ok(rendered > 0 && rendered < 200, `only a window is rendered (got ${rendered})`);
    assert.strictEqual(t.$$("#tbody tr.spacer").length, 1, "bottom spacer keeps the scroll height");
    assert.ok(t.$("#bulk").textContent.includes("Showing 1500 of 1500"));
  }],

  ["missing keys get a banner and an Enter API key action", () => {
    t.deliver({ type: "state", state: baseState() });
    t.click(t.$('[data-tab="models"]'));
    assert.ok(t.$("#banners").textContent.includes("Claude needs an API key on this machine"));
    assert.ok(!t.$("#banners").textContent.includes("Claude is unreachable"), "no duplicate unreachable banner");
    t.click(t.$('#banners [data-action="set-key"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "setApiKey", name: "Claude" });
    t.click(t.$('[data-tab="providers"]'));
    const card = t.$$(".card").find((x) => x.textContent.includes("Claude"));
    assert.ok(card.textContent.includes("API key needed on this machine") && card.textContent.includes("X-Api-Key in plain text") && card.textContent.includes("Anthropic API"));
  }],

  ["editor: API type, auth header, Ollama context length and the Azure preset", () => {
    t.click(t.$('[data-action="add-provider"]'));
    t.click(t.$('[data-preset="azure"]'));
    assert.strictEqual(t.$("#f-authHeader").value, "api-key");
    t.input(t.$("#f-endpointUrl"), "https://contoso.openai.azure.com/openai/v1");
    t.input(t.$("#f-staticText"), "gpt-4o-deploy");
    t.$("#f-api").value = "openai";
    t.change(t.$("#f-api"));
    t.click(t.$('[data-action="save-draft"]'));
    const az = t.sent.filter((m) => m.type === "saveProvider").at(-1).provider;
    assert.deepStrictEqual([az.name, az.authHeader, az.api, az.autoDiscover, az.staticModels], ["Azure OpenAI", "api-key", "openai", false, [{ id: "gpt-4o-deploy" }]]);
    t.deliver({ type: "saveResult", ok: true, name: "Azure OpenAI" });
    t.click(t.$('[data-action="add-provider"]'));
    t.click(t.$('[data-preset="ollama"]'));
    t.input(t.$("#f-contextLength"), "65536");
    t.click(t.$('[data-action="save-draft"]'));
    assert.strictEqual(t.sent.filter((m) => m.type === "saveProvider").at(-1).provider.contextLength, 65536);
    t.deliver({ type: "saveResult", ok: true, name: "Ollama 2" });
  }],

  ["progress bar and stop button", () => {
    t.deliver({ type: "state", state: { ...baseState(), verifying: { done: 1, total: 4, working: 1, failed: 0 } } });
    assert.ok(!t.$("#progress").classList.contains("hidden"));
    t.click(t.$("#verifyBtn"));
    assert.deepStrictEqual(t.sent.at(-1), { type: "cancelVerify" });
  }],

  ["edit flow keeps stored key; typing survives live updates", () => {
    t.deliver({ type: "focus", tab: "providers", editProvider: "Groq" });
    assert.ok(t.$("#f-apiKey").placeholder.includes("stored securely"));
    t.input(t.$("#f-name"), "Groq Cloud");
    t.deliver({ type: "state", state: baseState() });
    assert.strictEqual(t.$("#f-name").value, "Groq Cloud");
    t.click(t.$('[data-action="save-draft"]'));
    const edit = t.sent.filter((m) => m.type === "saveProvider").at(-1);
    assert.deepStrictEqual([edit.originalName, edit.apiKey, edit.provider.name], ["Groq", undefined, "Groq Cloud"]);
  }],

  ["settings clamp numbers and post selects", () => {
    t.deliver({ type: "saveResult", ok: true, name: "Groq Cloud" });
    t.click(t.$('[data-tab="settings"]'));
    const conc = t.$('[data-setting="testConcurrency"]');
    conc.value = "99";
    t.change(conc);
    assert.deepStrictEqual(t.sent.at(-1), { type: "updateSetting", key: "testConcurrency", value: 25 });
    const tc = t.$('[data-setting="toolCheck"]');
    tc.value = "basic";
    t.change(tc);
    assert.deepStrictEqual(t.sent.at(-1), { type: "updateSetting", key: "toolCheck", value: "basic" });
    const pc = t.$('[data-setting="providerConcurrency"]');
    pc.value = "0";
    t.change(pc);
    assert.deepStrictEqual(t.sent.at(-1), { type: "updateSetting", key: "providerConcurrency", value: 1 });
    t.click(t.$('[data-action="reset-stats"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "resetStats" });
    t.click(t.$('[data-action="export-stats"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "exportStats" });
  }],
]))();

failed.then((n) => process.exit(n ? 1 : 0));
