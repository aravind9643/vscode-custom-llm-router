import * as vscode from "vscode";
import { ModelEngine, CustomProviderConfig } from "./modelEngine";

export class ConfigWebviewPanel {
  public static currentPanel: ConfigWebviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _engine: ModelEngine;

  public static createOrShow(extensionUri: vscode.Uri, engine: ModelEngine) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ConfigWebviewPanel.currentPanel) {
      ConfigWebviewPanel.currentPanel._panel.reveal(column);
      ConfigWebviewPanel.currentPanel._update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "customLlmRouterConfig",
      "Custom LLM Router Dashboard",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    ConfigWebviewPanel.currentPanel = new ConfigWebviewPanel(panel, extensionUri, engine);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, engine: ModelEngine) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._engine = engine;

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "getInitialData": {
            this._sendState();
            break;
          }
          case "saveProviders": {
            const config = vscode.workspace.getConfiguration("customLlmRouter");
            await config.update("providers", message.providers, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage("Providers updated successfully!");
            vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
            this._sendState();
            break;
          }
          case "testProvider": {
            const result = await this._testProvider(message.provider);
            this._panel.webview.postMessage({
              command: "testResult",
              providerName: message.provider.name,
              result,
            });
            break;
          }
          case "testModel": {
            const res = await this._testSingleModel(message.provider, message.modelId);
            this._panel.webview.postMessage({
              command: "modelTestResult",
              modelId: message.modelId,
              res,
            });
            break;
          }
          case "saveFilters": {
            const config = vscode.workspace.getConfiguration("customLlmRouter");
            await config.update("blacklistPatterns", message.blacklist, vscode.ConfigurationTarget.Global);
            await config.update("whitelistExactIds", message.whitelist, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage("Filters saved successfully!");
            vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
            this._sendState();
            break;
          }
          case "syncNow": {
            vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
            this._sendState();
            break;
          }
        }
      },
      null,
      this._disposables
    );
  }

  private async _sendState() {
    const config = vscode.workspace.getConfiguration("customLlmRouter");
    const providers = config.get<CustomProviderConfig[]>("providers") || [];
    const blacklist = config.get<string[]>("blacklistPatterns") || [];
    const whitelist = config.get<string[]>("whitelistExactIds") || [];
    
    // Discover active models from engine
    const activeData = await this._engine.generateProviders({ profile: "all" });

    this._panel.webview.postMessage({
      command: "state",
      providers,
      blacklist,
      whitelist,
      activeData,
    });
  }

  private async _testProvider(provider: CustomProviderConfig) {
    const cleanEndpoint = provider.endpointUrl.replace(/\/+$/, "");
    const modelsUrl = provider.modelsEndpoint || (provider.name === "FreeLLMAPI" ? ${cleanEndpoint}/v1/models?execution_status=ready : ${cleanEndpoint}/v1/models);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (provider.apiKey) headers["Authorization"] = Bearer ;

    const start = Date.now();
    try {
      const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(6000) });
      const latency = Date.now() - start;
      if (res.ok) {
        const d: any = await res.json();
        const models = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
        return {
          ok: true,
          status: res.status,
          latency,
          modelCount: models.length + (provider.staticModels?.length || 0),
          models: models.map((m: any) => m.id || m.model || m.name),
        };
      }
      return { ok: false, status: res.status, latency, error: HTTP  };
    } catch (e: any) {
      return { ok: false, status: 0, latency: Date.now() - start, error: e.message };
    }
  }

  private async _testSingleModel(provider: CustomProviderConfig, modelId: string) {
    const cleanEndpoint = provider.endpointUrl.replace(/\/+$/, "");
    const chatUrl = provider.chatEndpoint || ${cleanEndpoint}/v1/chat/completions;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (provider.apiKey) headers["Authorization"] = Bearer ;

    const start = Date.now();
    try {
      const res = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "Reply with 'OK'" }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const latency = Date.now() - start;
      if (res.ok) {
        const d: any = await res.json();
        return {
          ok: true,
          latency,
          reply: d.choices?.[0]?.message?.content || "OK",
        };
      }
      return { ok: false, latency, error: HTTP  };
    } catch (e: any) {
      return { ok: false, latency: Date.now() - start, error: e.message };
    }
  }

  public dispose() {
    ConfigWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  private _update() {
    this._panel.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview(): string {
    return <!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Custom LLM Router - Providers & Models Manager</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-sideBar-background, #1e1e1e);
      --border: var(--vscode-widget-border, #333);
      --input-bg: var(--vscode-input-background, #252526);
      --input-fg: var(--vscode-input-foreground, #ccc);
      --btn-bg: var(--vscode-button-background, #007acc);
      --btn-fg: var(--vscode-button-foreground, #fff);
      --btn-hover: var(--vscode-button-hoverBackground, #0062a3);
      --accent: var(--vscode-focusBorder, #007fd4);
      --danger: #f14c4c;
      --success: #73c991;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: var(--bg);
      color: var(--fg);
      padding: 24px;
      margin: 0;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    h1 { margin: 0; font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      background: var(--btn-bg);
      color: var(--btn-fg);
    }
    .actions { display: flex; gap: 8px; }
    button {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 6px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.15s;
    }
    button:hover { background: var(--btn-hover); }
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }
    button.secondary:hover { background: rgba(255,255,255,0.06); }
    button.danger { background: var(--danger); }
    button.danger:hover { background: #d73a3a; }

    .nav-tabs {
      display: flex;
      gap: 16px;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .nav-tab {
      padding: 8px 12px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      font-weight: 500;
      font-size: 14px;
    }
    .nav-tab.active {
      border-bottom: 2px solid var(--accent);
      color: var(--accent);
    }

    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .provider-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      transition: border-color 0.15s;
    }
    .provider-card:hover { border-color: var(--accent); }
    .card-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .card-top-left { display: flex; align-items: center; gap: 10px; }
    .provider-name { font-weight: 600; font-size: 15px; }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 12px;
    }
    .grid-1 { margin-bottom: 12px; }

    label { display: block; font-size: 12px; margin-bottom: 4px; opacity: 0.85; }
    input[type="text"], input[type="password"] {
      width: 100%;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 13px;
    }
    input:focus { border-color: var(--accent); outline: none; }

    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      cursor: pointer;
    }

    .test-status {
      font-size: 12px;
      margin-top: 8px;
      padding: 6px 10px;
      border-radius: 4px;
      background: rgba(255,255,255,0.04);
      display: none;
    }
    .test-status.show { display: block; }
    .test-status.success { color: var(--success); border-left: 3px solid var(--success); }
    .test-status.error { color: var(--danger); border-left: 3px solid var(--danger); }

    .model-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      margin-top: 12px;
    }
    .model-table th, .model-table td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .model-table th { background: rgba(255,255,255,0.03); font-weight: 600; }
    .tag {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255,255,255,0.08);
      margin-right: 4px;
    }
    .tag.green { background: rgba(115, 201, 145, 0.2); color: var(--success); }

    .empty-state {
      text-align: center;
      padding: 40px;
      opacity: 0.7;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Custom LLM Router <span class="badge">Configuration Dashboard</span></h1>
      <p style="margin: 4px 0 0; font-size: 12px; opacity: 0.75;">Configure OpenAI-compatible providers, test endpoints, and view registered Copilot models.</p>
    </div>
    <div class="actions">
      <button class="secondary" onclick="syncNow()">↻ Sync Copilot Models</button>
      <button onclick="addProviderModal()">+ Add Provider</button>
    </div>
  </div>

  <div class="nav-tabs">
    <div class="nav-tab active" onclick="switchTab('tab-providers')">Providers (<span id="providerCount">0</span>)</div>
    <div class="nav-tab" onclick="switchTab('tab-models')">Active Copilot Models (<span id="modelCount">0</span>)</div>
    <div class="nav-tab" onclick="switchTab('tab-filters')">Rules & Filters</div>
  </div>

  <!-- TAB: PROVIDERS -->
  <div id="tab-providers" class="tab-content active">
    <div id="providersList"></div>
    <button style="margin-top: 12px;" onclick="saveAllProviders()">Save All Provider Changes</button>
  </div>

  <!-- TAB: MODELS -->
  <div id="tab-models" class="tab-content">
    <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
      <input type="text" id="modelSearch" placeholder="Search models by name or id..." oninput="filterModelsTable()" style="max-width: 350px;">
      <div id="modelsSummary" style="font-size: 13px; align-self: center; opacity: 0.8;"></div>
    </div>
    <table class="model-table">
      <thead>
        <tr>
          <th>Model ID</th>
          <th>Display Name</th>
          <th>Provider</th>
          <th>Capabilities</th>
          <th>Context Bounds</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="modelsTableBody"></tbody>
    </table>
  </div>

  <!-- TAB: FILTERS -->
  <div id="tab-filters" class="tab-content">
    <div class="provider-card">
      <div class="grid-1">
        <label><strong>Blacklist Patterns</strong> (one per line - exclude audio, image, whisper, etc.)</label>
        <textarea id="blacklistText" rows="6" style="width: 100%; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); padding: 8px; border-radius: 4px; font-family: monospace;"></textarea>
      </div>
      <div class="grid-1">
        <label><strong>Whitelist Exact IDs</strong> (one per line - always included)</label>
        <textarea id="whitelistText" rows="6" style="width: 100%; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); padding: 8px; border-radius: 4px; font-family: monospace;"></textarea>
      </div>
      <button onclick="saveFilters()">Save Filters & Rules</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentProviders = [];
    let currentActiveData = [];

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.command === "state") {
        currentProviders = msg.providers || [];
        currentActiveData = msg.activeData || [];
        renderProviders();
        renderActiveModels();
        renderFilters(msg.blacklist, msg.whitelist);
      } else if (msg.command === "testResult") {
        handleTestResult(msg.providerName, msg.result);
      } else if (msg.command === "modelTestResult") {
        handleModelTestResult(msg.modelId, msg.res);
      }
    });

    vscode.postMessage({ command: "getInitialData" });

    function switchTab(tabId) {
      document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      event.target.classList.add("active");
      document.getElementById(tabId).classList.add("active");
    }

    function renderProviders() {
      document.getElementById("providerCount").innerText = currentProviders.length;
      const container = document.getElementById("providersList");
      if (currentProviders.length === 0) {
        container.innerHTML = '<div class="empty-state">No providers configured yet. Click "+ Add Provider" to start!</div>';
        return;
      }

      container.innerHTML = currentProviders.map((p, idx) => \
        <div class="provider-card" id="card-\">
          <div class="card-top">
            <div class="card-top-left">
              <input type="checkbox" id="prov-enabled-\" \ onchange="updateProviderField(\, 'enabled', this.checked)">
              <span class="provider-name">\</span>
            </div>
            <div class="actions">
              <button class="secondary" onclick="testProvider(\)">⚡ Test Connection</button>
              <button class="danger" onclick="deleteProvider(\)">Remove</button>
            </div>
          </div>
          <div class="grid-2">
            <div>
              <label>Provider Name</label>
              <input type="text" value="\" onchange="updateProviderField(\, 'name', this.value)">
            </div>
            <div>
              <label>OpenAI-Compatible Endpoint URL</label>
              <input type="text" value="\" onchange="updateProviderField(\, 'endpointUrl', this.value)">
            </div>
          </div>
          <div class="grid-2">
            <div>
              <label>API Key / Bearer Token (optional for local Ollama/LM Studio)</label>
              <input type="password" value="\" placeholder="sk-... or leave empty" onchange="updateProviderField(\, 'apiKey', this.value)">
            </div>
            <div style="display: flex; align-items: flex-end; padding-bottom: 6px;">
              <label class="checkbox-row">
                <input type="checkbox" \ onchange="updateProviderField(\, 'autoDiscover', this.checked)">
                Auto-discover models from /v1/models
              </label>
            </div>
          </div>
          <div class="test-status" id="test-status-\"></div>
        </div>
      \).join("");
    }

    function renderActiveModels() {
      const allModels = [];
      currentActiveData.forEach(p => {
        (p.models || []).forEach(m => {
          allModels.push({ ...m, provider: p.name });
        });
      });

      document.getElementById("modelCount").innerText = allModels.length;
      document.getElementById("modelsSummary").innerText = \Total \ models ready in Copilot\;

      const tbody = document.getElementById("modelsTableBody");
      if (allModels.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px;">No models active. Make sure your endpoints are running and enabled.</td></tr>';
        return;
      }

      tbody.innerHTML = allModels.map(m => \
        <tr class="model-row" data-id="\" data-name="\">
          <td><code>\</code></td>
          <td><strong>\</strong></td>
          <td><span class="tag">\</span></td>
          <td>
            \
            \
            \
          </td>
          <td>\k in / \k out</td>
          <td>
            <button class="secondary" style="padding: 2px 8px; font-size: 11px;" id="btn-test-\" onclick="testModel('\', '\')">Test Ping</button>
            <span id="res-\" style="font-size: 11px; margin-left: 6px;"></span>
          </td>
        </tr>
      \).join("");
    }

    function renderFilters(blacklist, whitelist) {
      document.getElementById("blacklistText").value = (blacklist || []).join("\\n");
      document.getElementById("whitelistText").value = (whitelist || []).join("\\n");
    }

    function filterModelsTable() {
      const q = document.getElementById("modelSearch").value.toLowerCase();
      document.querySelectorAll(".model-row").forEach(row => {
        const id = row.getAttribute("data-id");
        const name = row.getAttribute("data-name");
        row.style.display = (!q || id.includes(q) || name.includes(q)) ? "" : "none";
      });
    }

    function updateProviderField(idx, field, val) {
      currentProviders[idx][field] = val;
    }

    function addProviderModal() {
      currentProviders.push({
        name: "New Provider",
        endpointUrl: "http://localhost:11434",
        apiKey: "",
        autoDiscover: true,
        enabled: true,
      });
      renderProviders();
      document.getElementById(\card-\\).scrollIntoView({ behavior: 'smooth' });
    }

    function deleteProvider(idx) {
      if (confirm(\Remove provider "\"?\)) {
        currentProviders.splice(idx, 1);
        renderProviders();
      }
    }

    function testProvider(idx) {
      const p = currentProviders[idx];
      const statusEl = document.getElementById(\	est-status-\\);
      statusEl.className = "test-status show";
      statusEl.innerText = "Connecting to " + p.endpointUrl + "...";
      vscode.postMessage({ command: "testProvider", provider: p });
    }

    function handleTestResult(name, res) {
      const idx = currentProviders.findIndex(p => p.name === name);
      if (idx === -1) return;
      const statusEl = document.getElementById(\	est-status-\\);
      if (res.ok) {
        statusEl.className = "test-status show success";
        statusEl.innerText = \✅ Connected successfully in \ms! Discovered \ model(s).\;
      } else {
        statusEl.className = "test-status show error";
        statusEl.innerText = \❌ Connection failed: \ (\ms)\;
      }
    }

    function testModel(providerName, modelId) {
      const p = currentProviders.find(cp => cp.name === providerName) || { name: providerName, endpointUrl: "" };
      const span = document.getElementById(\es-\\);
      if (span) span.innerText = "⏳...";
      vscode.postMessage({ command: "testModel", provider: p, modelId });
    }

    function handleModelTestResult(modelId, res) {
      const span = document.getElementById(\es-\\);
      if (!span) return;
      if (res.ok) {
        span.innerText = \✅ \ms ("\")\;
        span.style.color = "var(--success)";
      } else {
        span.innerText = \❌ \ (\ms)\;
        span.style.color = "var(--danger)";
      }
    }

    function saveAllProviders() {
      vscode.postMessage({ command: "saveProviders", providers: currentProviders });
    }

    function saveFilters() {
      const bl = document.getElementById("blacklistText").value.split("\\n").map(s => s.trim()).filter(Boolean);
      const wl = document.getElementById("whitelistText").value.split("\\n").map(s => s.trim()).filter(Boolean);
      vscode.postMessage({ command: "saveFilters", blacklist: bl, whitelist: wl });
    }

    function syncNow() {
      vscode.postMessage({ command: "syncNow" });
    }
  </script>
</body>
</html>;
  }
}
