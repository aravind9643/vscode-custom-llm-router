// Runs the compiled modules (out/) against mock_llm_server.py with a stubbed `vscode` API.
// Usage: npm test   (requires Python 3 on PATH, or set PYTHON)
const assert = require("assert");
const path = require("path");
const { ROOT, config, installVscodeStub, startMockServer, memento, secretStorage, silentLog, run } = require("./helpers");

const vscode = installVscodeStub();
const out = (m) => require(path.join(ROOT, "out", m));
const { resolveChatUrl, resolveModelsUrl, nativeRoot, isLocalUrl, resolveApi } = out("endpoints.js");
const { ProviderStore, SECRET_SENTINEL } = out("providerStore.js");
const { ModelEngine } = out("modelEngine.js");
const { CustomLLMChatProvider, ThinkTagSplitter, stripReasoning } = out("customChatProvider.js");
const { pullOllamaModel } = out("ollama.js");
const { runPool } = out("pool.js");
const { toAnthropicMessages } = out("transports/anthropic.js");
const { toOllamaMessages } = out("transports/ollama.js");

const { LanguageModelTextPart: TextPart, LanguageModelDataPart: DataPart, LanguageModelToolCallPart: ToolCallPart } = vscode;
const token = () => new vscode.CancellationTokenSource().token;

(async () => {
  const mock = await startMockServer();
  const mockState = async () => (await fetch(`${mock.url}/_mock/state`)).json();
  const secrets = secretStorage();
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, {
    providers: [
      { name: "Mock", endpointUrl: `${mock.url}/v1`, apiKey: "legacy-plain" },
      { name: "Dead", endpointUrl: "http://127.0.0.1:1" },
    ],
    testConcurrency: 4,
  });
  const store = new ProviderStore(secrets);
  await store.init();
  const engine = new ModelEngine(memento(), store, silentLog);
  const chat = new CustomLLMChatProvider(engine, silentLog);
  const addProvider = async (p) => {
    config.providers = [...config.providers.filter((x) => x.name !== p.name), p];
    await store.init();
    await engine.refresh();
  };

  /** Sends one chat request through the provider and returns the reported parts. */
  const send = async (infoId, text, opts = {}) => {
    const infos = await chat.provideLanguageModelChatInformation({ silent: true }, token());
    const info = infos.find((i) => i.id === infoId) || infos.find((i) => i.id.endsWith("/" + infoId));
    assert.ok(info, `model ${infoId} registered (have: ${infos.map((i) => i.id).join(", ")})`);
    const parts = [];
    await chat.provideLanguageModelChatResponse(
      info,
      [
        { role: 3, content: [new TextPart("You are helpful.")] },
        { role: 1, content: [new TextPart(text), new DataPart(new Uint8Array([1]), "cache_control")] },
      ],
      { toolMode: 1, ...opts },
      { report: (p) => parts.push(p) },
      token()
    );
    return parts;
  };
  const textOf = (parts) => parts.map((p) => p.value || "").join("");
  const select = async (...keys) => {
    await store.setSelected(keys, true);
    const untested = keys.map((k) => engine.getModel(k)).filter((m) => m && m.status !== "working");
    if (untested.length) await engine.verify(untested);
    engine.onSelectionChanged();
  };

  const failed = await run([
    ["URL resolution handles /v1, /openai and pasted endpoints", () => {
      const u = (endpointUrl, extra = {}) => ({ name: "x", endpointUrl, ...extra });
      assert.strictEqual(resolveChatUrl(u("http://localhost:11434")), "http://localhost:11434/v1/chat/completions");
      assert.strictEqual(resolveChatUrl(u("https://api.groq.com/openai/v1")), "https://api.groq.com/openai/v1/chat/completions");
      assert.strictEqual(resolveChatUrl(u("https://openrouter.ai/api")), "https://openrouter.ai/api/v1/chat/completions");
      assert.strictEqual(resolveChatUrl(u("https://openrouter.ai/api/v1/chat/completions")), "https://openrouter.ai/api/v1/chat/completions");
      assert.strictEqual(resolveChatUrl(u("https://generativelanguage.googleapis.com/v1beta/openai")), "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
      assert.strictEqual(resolveChatUrl(u("https://res.openai.azure.com/openai/v1")), "https://res.openai.azure.com/openai/v1/chat/completions");
      assert.strictEqual(resolveModelsUrl({ name: "FreeLLMAPI", endpointUrl: "http://h" }), "http://h/v1/models?execution_status=ready");
      assert.strictEqual(nativeRoot(u("http://localhost:11434/v1/")), "http://localhost:11434");
      assert.ok(isLocalUrl("http://192.168.1.4:8000") && isLocalUrl("http://[::1]:1") && !isLocalUrl("https://api.openai.com/v1"));
      assert.strictEqual(resolveApi(u("https://api.anthropic.com"), "openai"), "anthropic");
      assert.strictEqual(resolveApi(u("http://localhost:11434"), "ollama"), "ollama");
      assert.strictEqual(resolveApi(u("http://localhost:11434", { api: "openai" }), "ollama"), "openai");
    }],

    ["<think> tags split across chunks; reasoning stripped from history", () => {
      const sp = new ThinkTagSplitter();
      const segs = ["<thi", "nk>a", "b</th", "ink>c<", "x"].flatMap((c) => sp.push(c)).concat(sp.flush());
      assert.strictEqual(segs.filter((s) => s.think).map((s) => s.text).join(""), "ab");
      assert.strictEqual(segs.filter((s) => !s.think).map((s) => s.text).join(""), "c<x");
      assert.strictEqual(stripReasoning("> \u{1F4AD} *Thinking…*\n> step 1\n\nAnswer here"), "Answer here");
    }],

    ["message conversion for Anthropic and Ollama", () => {
      const wire = [
        { role: "system", content: "sys" },
        { role: "assistant", content: "hi" },
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }] },
        { role: "tool", tool_call_id: "c1", content: "result" },
        { role: "user", content: "next" },
      ];
      const a = toAnthropicMessages(wire);
      assert.strictEqual(a.system, "sys");
      assert.strictEqual(a.messages[0].role, "user", "starts with a user turn");
      assert.deepStrictEqual(a.messages[2].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
      assert.deepStrictEqual(a.messages[3].content[0], { type: "tool_use", id: "c1", name: "f", input: { a: 1 } });
      assert.deepStrictEqual(a.messages[4].content.map((b) => b.type), ["tool_result", "text"], "tool result and next user text share one turn");
      const o = toOllamaMessages(wire);
      assert.deepStrictEqual(o[2].images, ["QUJD"]);
      assert.deepStrictEqual(o[3].tool_calls[0].function.arguments, { a: 1 });
      assert.strictEqual(o[4].tool_name, "f");
    }],

    ["worker pool respects global and per-provider limits", async () => {
      const active = {};
      const peak = {};
      let peakAll = 0;
      let all = 0;
      const items = [...Array(12)].map((_, i) => ({ g: i % 3 === 0 ? "remote" : "local" }));
      await runPool(items, { limit: 5, groupOf: (x) => x.g, groupLimit: (g) => (g === "remote" ? 2 : 5) }, async (x) => {
        active[x.g] = (active[x.g] || 0) + 1;
        all++;
        peak[x.g] = Math.max(peak[x.g] || 0, active[x.g]);
        peakAll = Math.max(peakAll, all);
        await new Promise((r) => setTimeout(r, 20));
        active[x.g]--;
        all--;
      });
      assert.ok(peak.remote <= 2 && peakAll <= 5, JSON.stringify({ peak, peakAll }));
      assert.ok(peak.local >= 3, "local work still runs in parallel");
    }],

    ["cold start: a local model that loads slowly gets a second, longer attempt", async () => {
      await addProvider({ name: "Cold", endpointUrl: `${mock.url}/v1`, timeoutMs: 1000, autoDiscover: false, staticModels: [{ id: "mock-slow" }] });
      const res = await engine.verify([engine.getModel("Cold::mock-slow")]);
      assert.strictEqual(res.working, 1, engine.getModel("Cold::mock-slow").error);
    }],

    ["discovery lists models, prices, and reports offline providers", async () => {
      await engine.refresh();
      const st = engine.getProviderStatuses();
      assert.strictEqual(st.find((s) => s.name === "Mock").online, true);
      assert.strictEqual(st.find((s) => s.name === "Dead").online, false);
      assert.strictEqual(st.find((s) => s.name === "Mock").keySource, "settings");
      assert.strictEqual(engine.getModels("Mock").length, 7);
      assert.deepStrictEqual(engine.getModel("Mock::mock-gpt-4o").pricing, { inputPerM: 2, outputPerM: 8, source: "server" });
      assert.strictEqual(engine.getModel("Mock::mock-flaky").contextSource, "guess");
    }],

    ["verification estimate counts requests and remote providers", () => {
      const est = engine.estimateVerification(engine.getModels("Mock"), false);
      assert.deepStrictEqual([est.models, est.requests, est.remote.length], [7, 14, 0], "localhost is not remote");
      config.toolCheck = "basic";
      assert.strictEqual(engine.estimateVerification(engine.getModels("Mock"), false).requests, 7);
      delete config.toolCheck;
    }],

    ["tool check distinguishes called / accepted / unsupported", async () => {
      const res = await engine.verify(engine.getModels("Mock"));
      assert.deepStrictEqual([res.working, res.failed], [7, 0]);
      assert.strictEqual(engine.getModel("Mock::mock-gpt-4o").toolSupport, "called");
      assert.strictEqual(engine.getModel("Mock::mock-coder-32b").toolSupport, "accepted");
      assert.strictEqual(engine.getModel("Mock::mock-qwq-think").toolSupport, "unsupported");
      assert.strictEqual(engine.getModel("Mock::mock-qwq-think").caps.tools, false);
      assert.strictEqual(engine.getCopilotModels().length, 0, "nothing exposed until selected");
    }],

    ["legacy opt-out list migrates to opt-in selection", async () => {
      config.disabledModelIds = ["Mock::mock-coder-32b", "mock-flaky", "mock-strict", "mock-qwq-think", "mock-slow", "Cold::mock-slow"];
      await engine.migrateLegacySelection();
      engine.onSelectionChanged();
      assert.deepStrictEqual(engine.getCopilotModels().map((m) => m.id).sort(), ["mock-deepseek-r1", "mock-gpt-4o"]);
    }],

    ["saving moves the key to secret storage; rename keeps selection and results", async () => {
      engine.renameProvider("Mock", "Mock2");
      await store.saveProvider("Mock", { ...store.findProvider("Mock"), name: "Mock2" }, undefined);
      assert.strictEqual(store.findProvider("Mock2").apiKey, undefined);
      assert.strictEqual(secrets.data.get("customLlmRouter.apiKey.Mock2"), "legacy-plain");
      assert.ok([...store.getSelection()].every((k) => k.startsWith("Mock2::")));
      await engine.refresh();
      assert.strictEqual(engine.getProviderStatuses().find((s) => s.name === "Mock2").keySource, "secret");
      assert.strictEqual(engine.getModel("Mock2::mock-gpt-4o").status, "working", "test results survived the rename");
    }],

    ["secret headers live in SecretStorage; the placeholder keeps them", async () => {
      await store.saveProvider(undefined, { name: "Secure", endpointUrl: `${mock.url}/secure/v1`, headers: { "X-Secret-Token": "tok", "X-Title": "VS Code" } });
      assert.deepStrictEqual(store.findProvider("Secure").headers, { "X-Title": "VS Code" }, "only non-secret headers in settings");
      assert.deepStrictEqual(JSON.parse(secrets.data.get("customLlmRouter.headers.Secure")), { "X-Secret-Token": "tok" });
      await store.saveProvider("Secure", { name: "Secure", endpointUrl: `${mock.url}/secure/v1`, headers: { "X-Secret-Token": SECRET_SENTINEL } });
      await store.init();
      await engine.refresh();
      const s = engine.getProviderStatuses().find((x) => x.name === "Secure");
      assert.strictEqual(s.online, true, s.error);
      assert.deepStrictEqual(s.secretHeaderNames, ["X-Secret-Token"]);
      config.providers = [...config.providers, { name: "Plain", endpointUrl: "http://127.0.0.1:1", headers: { "X-Api-Key": "abc" }, enabled: false }];
      assert.deepStrictEqual(engine.getProviderStatuses().find((x) => x.name === "Plain").plaintextSecretHeaders, ["X-Api-Key"]);
    }],

    ["a rejected key is reported as missing on this machine, and setting it fixes it", async () => {
      await addProvider({ name: "Locked", endpointUrl: `${mock.url}/secure/v1` });
      let s = engine.getProviderStatuses().find((x) => x.name === "Locked");
      assert.deepStrictEqual([s.online, s.needsKey], [false, true]);
      await store.setApiKey("Locked", "sk-good");
      await engine.refresh();
      s = engine.getProviderStatuses().find((x) => x.name === "Locked");
      assert.deepStrictEqual([s.online, !!s.needsKey], [true, false]);
    }],

    ["per-model override sets limits, name, capabilities and price", async () => {
      await store.setOverride("Mock2::mock-gpt-4o", { name: "GPT Mock", contextWindow: 32000, maxOutputTokens: 4000, vision: false, inputPerM: 1, outputPerM: 1 });
      await engine.refresh();
      const m = engine.getModel("Mock2::mock-gpt-4o");
      assert.deepStrictEqual([m.name, m.contextWindow, m.maxOutputTokens, m.maxInputTokens, m.contextSource, m.caps.vision, m.pricing.source], ["GPT Mock", 32000, 4000, 28000, "override", false, "override"]);
      await store.setOverride("Mock2::mock-gpt-4o", undefined);
      await engine.refresh();
      assert.strictEqual(engine.getModel("Mock2::mock-gpt-4o").contextSource, "server");
    }],

    ["chat streams text, reasoning, split <think> tags and tool calls", async () => {
      assert.ok(textOf(await send("mock2/mock-gpt-4o", "hi")).includes("mock-gpt-4o"));
      assert.ok(textOf(await send("mock2/mock-deepseek-r1", "hi")).startsWith("> \u{1F4AD} *Thinking…*\n> Thinking process:"));
      await select("Mock2::mock-qwq-think");
      assert.strictEqual(textOf(await send("mock2/mock-qwq-think", "hi")), "> \u{1F4AD} *Thinking…*\n> Let me consider this.\n\nThe answer is 42.");
      const parts = await send("mock2/mock-gpt-4o", "What is the weather?", { tools: [{ name: "get_weather", description: "w", inputSchema: { type: "object" } }] });
      const call = parts.find((p) => p instanceof ToolCallPart);
      assert.deepStrictEqual([call.callId, call.name, call.input], ["call_mock_1", "get_weather", { city: "Hyderabad" }]);
    }],

    ["usage calibrates token counts and tracks speed and spend", async () => {
      const key = "Mock2::mock-gpt-4o";
      const before = engine.getModel(key).stats?.costUsd || 0;
      await send("mock2/mock-gpt-4o", "x".repeat(900));
      const after = engine.charsPerToken(key);
      assert.ok(after < 4 && after >= 3, `ratio moved toward the mock's 3 chars/token (got ${after})`);
      const infos = await chat.provideLanguageModelChatInformation({ silent: true }, token());
      const n = await chat.provideTokenCount(infos.find((i) => i.id === "mock2/mock-gpt-4o"), "y".repeat(300), token());
      assert.strictEqual(n, Math.ceil(300 / after));
      const stats = engine.getModel(key).stats;
      assert.ok(stats.requests >= 3 && stats.ttftMs >= 0 && stats.failures === 0);
      // 900+16 chars → 305 prompt tokens at $2/M, 20 completion tokens at $8/M
      const expected = (Math.floor(916 / 3) * 2 + 20 * 8) / 1e6;
      assert.ok(Math.abs(stats.costUsd - before - expected) < 1e-9, `spend ${stats.costUsd - before} vs ${expected}`);
      assert.ok(engine.totalSpend() >= stats.costUsd);
    }],

    ["servers that reject stream_options are retried without it", async () => {
      await select("Mock2::mock-strict");
      assert.ok(textOf(await send("mock2/mock-strict", "hello")).includes("mock-strict"));
      assert.ok(textOf(await send("mock2/mock-strict", "again")).includes("mock-strict"));
    }],

    ["routes fall back immediately (no retry delay) when a member fails before answering", async () => {
      await store.saveRoutes([{ name: "Coding (auto)", models: ["Mock2::mock-flaky", "Mock2::mock-gpt-4o"] }]);
      engine.onSelectionChanged();
      const infos = await chat.provideLanguageModelChatInformation({ silent: true }, token());
      assert.ok(infos.find((i) => i.id === "route/coding-auto"), "route registered");
      const t0 = Date.now();
      assert.ok(textOf(await send("route/coding-auto", "hi")).includes("mock-gpt-4o"), "answered by the second member");
      assert.ok(Date.now() - t0 < 1200, `fallback took ${Date.now() - t0}ms`);
      assert.strictEqual(engine.getModel("Mock2::mock-flaky").stats.failures, 1);
      await store.saveRoutes([{ name: "Broken", models: ["Mock2::mock-flaky"] }]);
      engine.onSelectionChanged();
      await assert.rejects(send("route/broken", "hi"), /All models in route "Broken" failed/);
    }],

    ["Ollama native chat sends num_ctx, keep_alive and think", async () => {
      await addProvider({ name: "Ollama Mock", endpointUrl: `${mock.url}/v1`, keepAlive: "30m", contextLength: 16384 });
      const st = engine.getProviderStatuses().find((s) => s.name === "Ollama Mock");
      assert.deepStrictEqual([st.kind, st.api], ["ollama", "ollama"]);
      const m = engine.getModel("Ollama Mock::mock-coder-32b");
      assert.deepStrictEqual([m.contextWindow, m.contextSource], [16384, "server"], "capped at the provider's context length");
      assert.strictEqual(engine.getModel("Ollama Mock::mock-qwq-think").caps.tools, false, "capabilities from /api/show");
      await select("Ollama Mock::mock-coder-32b", "Ollama Mock::mock-qwq-think");
      assert.strictEqual(textOf(await send("ollama-mock/mock-coder-32b", "hi")), "Hello from native mock-coder-32b");
      const last = (await mockState()).lastOllamaChat;
      assert.deepStrictEqual([last.options.num_ctx, last.keep_alive, last.think], [16384, "30m", undefined]);
      assert.ok(textOf(await send("ollama-mock/mock-qwq-think", "hi")).startsWith("> \u{1F4AD} *Thinking…*\n> Native thinking."));
      assert.strictEqual((await mockState()).lastOllamaChat.think, true);
    }],

    ["Ollama via the OpenAI-compatible API re-arms keep-alive after a chat", async () => {
      await addProvider({ name: "Ollama Compat", endpointUrl: `${mock.url}/v1`, keepAlive: "45m", api: "openai" });
      await select("Ollama Compat::mock-gpt-4o");
      await send("ollama-compat/mock-gpt-4o", "hi");
      await new Promise((r) => setTimeout(r, 300));
      assert.deepStrictEqual((await mockState()).keepAlive.at(-1), { model: "mock-gpt-4o", keep_alive: "45m" });
    }],

    ["Anthropic: discovery, health check, streaming, thinking, tools, refusal and spend", async () => {
      await addProvider({ name: "Claude", endpointUrl: mock.url, api: "anthropic" });
      assert.strictEqual(engine.getProviderStatuses().find((s) => s.name === "Claude").needsKey, true, "no key → needs key");
      await store.setApiKey("Claude", "sk-ant-test");
      await engine.refresh();
      const opus = engine.getModel("Claude::claude-opus-5-5");
      assert.deepStrictEqual([opus.name, opus.contextWindow, opus.caps.vision, opus.thinkingSupported], ["Claude Opus 5.5", 1000000, true, true]);
      assert.deepStrictEqual(opus.pricing, { inputPerM: 4, outputPerM: 20, source: "list" });
      assert.strictEqual(engine.getModel("Claude::claude-haiku-4-5").thinkingSupported, false);
      await select("Claude::claude-opus-5-5", "Claude::claude-haiku-4-5");
      assert.strictEqual(engine.getModel("Claude::claude-opus-5-5").toolSupport, "called");

      const parts = await send("claude/claude-opus-5-5", "hello", { modelOptions: { temperature: 0.2 } });
      assert.strictEqual(textOf(parts), "> \u{1F4AD} *Thinking…*\n> Considering the request.\n\nHello from claude-opus-5-5");
      const last = (await mockState()).lastAnthropic;
      assert.strictEqual(last.headers["x-api-key"], "sk-ant-test");
      assert.strictEqual(last.body.system, "You are helpful.");
      assert.strictEqual(last.body.temperature, undefined, "sampling params are not sent");
      assert.deepStrictEqual(last.body.thinking, { type: "adaptive", display: "summarized" });
      assert.strictEqual(last.body.max_tokens, 64000);
      assert.strictEqual(last.body.fallbacks, undefined, "fallbacks only on api.anthropic.com");

      await send("claude/claude-haiku-4-5", "hello");
      assert.strictEqual((await mockState()).lastAnthropic.body.thinking, undefined, "no adaptive thinking where unsupported");

      const tool = (await send("claude/claude-opus-5-5", "weather?", { tools: [{ name: "get_weather", description: "w", inputSchema: { type: "object" } }] })).find((p) => p instanceof ToolCallPart);
      assert.deepStrictEqual([tool.callId, tool.name, tool.input], ["toolu_mock", "get_weather", { city: "Hyderabad" }]);
      const lastTools = (await mockState()).lastAnthropic.body;
      assert.deepStrictEqual([lastTools.tool_choice, lastTools.tools[0].eager_input_streaming], [{ type: "auto" }, true]);

      await assert.rejects(send("claude/claude-opus-5-5", "refuse-me"), /declined this request \(cyber\)/);
      // 30 input + 10 cache-read tokens at $4/M, 15 output at $20/M per answered request
      assert.ok(engine.getModel("Claude::claude-opus-5-5").stats.costUsd > 0);
    }],

    ["Ollama pull streams progress", async () => {
      const reports = [];
      const err = await pullOllamaModel({ name: "o", endpointUrl: mock.url }, { secretHeaders: {} }, "tiny:1b", { report: (r) => reports.push(r) }, token());
      assert.strictEqual(err, undefined);
      assert.ok(reports.some((r) => /100%/.test(r.message || "")) && reports.some((r) => r.message === "success"));
    }],

    ["HTTP errors are thrown to Copilot and 404 evicts the model", async () => {
      config.providers = config.providers.map((p) => (p.name === "Mock2" ? { ...p, endpointUrl: `${mock.url}/nope` } : p));
      await assert.rejects(send("mock2/mock-gpt-4o", "hi"), /rejected the request \(HTTP 404/);
      assert.strictEqual(engine.getModel("Mock2::mock-gpt-4o").status, "failed");
    }],
  ]);

  engine.dispose();
  chat.dispose();
  mock.stop();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
