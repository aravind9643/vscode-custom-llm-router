// Runs inside a real VS Code extension host (see .vscode-test.mjs).
const assert = require("assert");
const vscode = require("vscode");
const { startMockServer } = require("../helpers");

const EXT_ID = "AravindMerugu.vscode-custom-llm-router";
const CMD = "vscode-custom-llm-router";

async function waitFor(fn, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

suite("LLM Router in VS Code", function () {
  let mock;
  const cfg = () => vscode.workspace.getConfiguration("customLlmRouter");

  suiteSetup(async () => {
    mock = await startMockServer();
    await vscode.extensions.getExtension(EXT_ID).activate();
  });

  suiteTeardown(async () => {
    await cfg().update("providers", undefined, vscode.ConfigurationTarget.Global);
    await cfg().update("copilotModels", undefined, vscode.ConfigurationTarget.Global);
    mock?.stop();
  });

  test("activates and registers every contributed command", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext.isActive);
    const all = new Set(await vscode.commands.getCommands(true));
    const declared = ext.packageJSON.contributes.commands.map((c) => c.command);
    const missing = declared.filter((c) => !all.has(c));
    assert.deepStrictEqual(missing, [], "every command in package.json is registered");
  });

  test("manifest strings are localized from package.nls.json", () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    const title = ext.packageJSON.contributes.commands.find((c) => c.command === `${CMD}.openDashboard`).title;
    assert.ok(!title.startsWith("%"), `title resolved (got ${title})`);
  });

  test("a provider added in settings is discovered, verified and served through vscode.lm", async () => {
    await cfg().update("providers", [{ name: "Mock", endpointUrl: `${mock.url}/v1` }], vscode.ConfigurationTarget.Global);
    await cfg().update("copilotModels", ["Mock::mock-gpt-4o"], vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand(`${CMD}.syncModels`);
    await vscode.commands.executeCommand(`${CMD}.testAllModels`, { keys: ["Mock::mock-gpt-4o"], force: true });

    const models = await waitFor(async () => {
      const list = await vscode.lm.selectChatModels({ vendor: "custom-llm-router" });
      return list.length ? list : undefined;
    }, "the verified model to reach vscode.lm");
    assert.deepStrictEqual(models.map((m) => m.id), ["mock/mock-gpt-4o"]);
    assert.ok(models[0].maxInputTokens > 0);

    const cts = new vscode.CancellationTokenSource();
    const response = await models[0].sendRequest([vscode.LanguageModelChatMessage.User("hello from the integration test")], {}, cts.token);
    let text = "";
    for await (const chunk of response.text) text += chunk;
    assert.ok(text.includes("mock-gpt-4o"), `streamed answer came from the mock (got: ${text.slice(0, 120)})`);

    const count = await models[0].countTokens("x".repeat(400));
    assert.ok(count > 0 && count <= 400);
  });

  test("Ollama native and Anthropic transports work from the bundled extension", async () => {
    await cfg().update(
      "providers",
      [
        { name: "Ollama Mock", endpointUrl: `${mock.url}/v1`, contextLength: 8192 },
        // A credential header in settings (not the secret store) keeps the test non-interactive.
        { name: "Claude", endpointUrl: mock.url, api: "anthropic", headers: { "x-api-key": "sk-ant-test" } },
      ],
      vscode.ConfigurationTarget.Global
    );
    await cfg().update("copilotModels", ["Ollama Mock::mock-coder-32b", "Claude::claude-opus-5-5"], vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand(`${CMD}.syncModels`);
    await vscode.commands.executeCommand(`${CMD}.testAllModels`, { keys: ["Ollama Mock::mock-coder-32b", "Claude::claude-opus-5-5"], force: true, skipConfirm: true });

    const models = await waitFor(async () => {
      const list = await vscode.lm.selectChatModels({ vendor: "custom-llm-router" });
      return list.length === 2 ? list : undefined;
    }, "both models to reach vscode.lm");
    const read = async (m) => {
      const res = await m.sendRequest([vscode.LanguageModelChatMessage.User("hi")], {}, new vscode.CancellationTokenSource().token);
      let text = "";
      for await (const chunk of res.text) text += chunk;
      return text;
    };
    const ollama = models.find((m) => m.id === "ollama-mock/mock-coder-32b");
    assert.strictEqual(await read(ollama), "Hello from native mock-coder-32b");
    // LanguageModelChat exposes maxInputTokens only; it must fit inside the provider's context length.
    assert.ok(ollama.maxInputTokens > 0 && ollama.maxInputTokens < 8192, `limits follow the provider context length (got ${ollama.maxInputTokens})`);
    const claude = models.find((m) => m.id === "claude/claude-opus-5-5");
    assert.ok((await read(claude)).endsWith("Hello from claude-opus-5-5"));
  });

  test("dashboard opens as an editor tab and the sidebar view can be focused", async () => {
    await vscode.commands.executeCommand(`${CMD}.openDashboard`);
    await waitFor(
      () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.label === "LLM Router"),
      "the dashboard tab"
    );
    await vscode.commands.executeCommand("llmRouter.providers.focus");
  });
});
