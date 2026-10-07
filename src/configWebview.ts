import * as vscode from "vscode";
import { ModelEngine, CustomProviderConfig, VSCodeModel } from "./modelEngine";

export class ConfigWebviewPanel {
  public static currentPanel: ConfigWebviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _engine: ModelEngine;

  public static createOrShow(engine: ModelEngine) {
    if (ConfigWebviewPanel.currentPanel) {
      ConfigWebviewPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      ConfigWebviewPanel.currentPanel._sendState();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "customLlmRouterDashboard",
      "Custom LLM Router Dashboard",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    ConfigWebviewPanel.currentPanel = new ConfigWebviewPanel(panel, engine);
  }

  private constructor(panel: vscode.WebviewPanel, engine: ModelEngine) {
    this._panel = panel;
    this._engine = engine;

    this._panel.webview.html = this._getHtml();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.cmd === "init") {
          await this._sendState();
        } else if (msg.cmd === "saveProviders") {
          const config = vscode.workspace.getConfiguration("customLlmRouter");
          await config.update("providers", msg.providers, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage("Providers updated successfully!");
          vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
          await this._sendState();
        } else if (msg.cmd === "saveFilters") {
          const config = vscode.workspace.getConfiguration("customLlmRouter");
          await config.update("blacklistPatterns", msg.blacklist, vscode.ConfigurationTarget.Global);
          await config.update("whitelistExactIds", msg.whitelist, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage("Filters saved successfully!");
          vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
          await this._sendState();
        } else if (msg.cmd === "testProv") {
          const res = await this._testProvider(msg.prov);
          this._panel.webview.postMessage({ cmd: "testResult", idx: msg.idx, ...res });
        } else if (msg.cmd === "pingModel") {
          const res = await this._pingModel(msg.provName, msg.modelId);
          this._panel.webview.postMessage({ cmd: "pingResult", id: msg.safe, ...res });
        } else if (msg.cmd === "syncNow") {
          vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
          await this._sendState();
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
    const provs = await this._engine.generateProviders({ profile: "all" });

    const models: (VSCodeModel & { provider: string })[] = [];
    for (const p of provs) {
      for (const m of p.models || []) {
        models.push({ ...m, provider: p.name });
      }
    }

    this._panel.webview.postMessage({
      cmd: "state",
      providers,
      blacklist,
      whitelist,
      models,
    });
  }

  private async _testProvider(p: CustomProviderConfig) {
    const clean = (p.endpointUrl || "").replace(/\/+$/, "");
    const url =
      p.modelsEndpoint ||
      (p.name === "FreeLLMAPI"
        ? clean + "/v1/models?execution_status=ready"
        : clean + "/v1/models");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (p.apiKey) headers["Authorization"] = "Bearer " + p.apiKey;
    const start = Date.now();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      const latency = Date.now() - start;
      if (res.ok) {
        const d: any = await res.json();
        const list = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
        return { ok: true, latency, count: list.length };
      }
      return { ok: false, latency, error: "HTTP " + res.status };
    } catch (e: any) {
      return { ok: false, latency: Date.now() - start, error: e.message };
    }
  }

  private async _pingModel(provName: string, modelId: string) {
    const config = vscode.workspace.getConfiguration("customLlmRouter");
    const providers = config.get<CustomProviderConfig[]>("providers") || [];
    const p = providers.find((cp) => cp.name === provName) || {
      endpointUrl: "",
      apiKey: "",
    };
    const clean = (p.endpointUrl || "").replace(/\/+$/, "");
    const chatUrl = clean + "/v1/chat/completions";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (p.apiKey) headers["Authorization"] = "Bearer " + p.apiKey;
    const start = Date.now();
    try {
      const res = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "Reply OK" }],
          max_tokens: 3,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const latency = Date.now() - start;
      return { ok: res.ok, latency };
    } catch {
      return { ok: false, latency: Date.now() - start };
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

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Custom LLM Router Dashboard</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --card: var(--vscode-sideBar-background, #252526);
      --border: var(--vscode-widget-border, #3c3c3c);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --success: #73c991;
      --error: #f14c4c;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); padding: 20px; margin: 0; }
    .top-bar { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 16px; }
    .title { font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .badge { font-size: 11px; background: var(--btn-bg); color: var(--btn-fg); padding: 2px 8px; border-radius: 10px; }
    .tabs { display: flex; gap: 16px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
    .tab { padding: 8px 12px; cursor: pointer; border-bottom: 2px solid transparent; font-size: 13px; font-weight: 500; }
    .tab.active { border-bottom-color: var(--btn-bg); color: #fff; }
    .panel { display: none; }
    .panel.active { display: block; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 14px; margin-bottom: 12px; }
    .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .row { display: flex; gap: 10px; margin-bottom: 8px; }
    .col { flex: 1; }
    label { display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; }
    input[type=text], input[type=password], textarea { width: 100%; box-sizing: border-box; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); padding: 6px 8px; border-radius: 4px; font-size: 13px; }
    button { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500; }
    button:hover { background: var(--btn-hover); }
    button.sec { background: transparent; border: 1px solid var(--border); color: var(--fg); }
    button.sec:hover { background: rgba(255,255,255,0.06); }
    button.danger { background: var(--error); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); }
    th { background: rgba(255,255,255,0.02); }
    .tag { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.08); margin-right: 4px; }
    .tag.green { background: rgba(115,201,145,0.2); color: var(--success); }
    .msg { font-size: 11px; margin-top: 6px; padding: 4px 8px; border-radius: 4px; display: none; }
  </style>
</head>
<body>
  <div class="top-bar">
    <div class="title">Custom LLM Router <span class="badge">Providers & Models Manager</span></div>
    <div>
      <button class="sec" onclick="syncNow()">Refresh Models</button>
      <button onclick="addProvider()">+ Add Provider</button>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="setTab('providers', this)">Providers (<span id="pCount">0</span>)</div>
    <div class="tab" onclick="setTab('models', this)">Active Copilot Models (<span id="mCount">0</span>)</div>
    <div class="tab" onclick="setTab('filters', this)">Rules & Filters</div>
  </div>

  <div id="tab-providers" class="panel active">
    <div id="provList"></div>
    <button style="margin-top: 8px;" onclick="saveProviders()">Save All Providers</button>
  </div>

  <div id="tab-models" class="panel">
    <div style="margin-bottom: 10px;">
      <input type="text" id="mSearch" placeholder="Search model ID or name..." oninput="filterModels()" style="max-width: 320px;">
    </div>
    <table>
      <thead>
        <tr>
          <th>Model ID</th>
          <th>Display Name</th>
          <th>Provider</th>
          <th>Capabilities</th>
          <th>Limits</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="modelsBody"></tbody>
    </table>
  </div>

  <div id="tab-filters" class="panel">
    <div class="card">
      <label>Blacklist Patterns (one per line):</label>
      <textarea id="blackList" rows="5"></textarea>
      <label style="margin-top: 10px;">Whitelist Exact IDs (one per line):</label>
      <textarea id="whiteList" rows="5"></textarea>
      <button style="margin-top: 10px;" onclick="saveFilters()">Save Filters</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let providers = [];
    let activeModels = [];

    window.addEventListener('message', ev => {
      const msg = ev.data;
      if (msg.cmd === 'state') {
        providers = msg.providers || [];
        activeModels = msg.models || [];
        renderProviders();
        renderModels();
        document.getElementById('blackList').value = (msg.blacklist || []).join('\\n');
        document.getElementById('whiteList').value = (msg.whitelist || []).join('\\n');
      } else if (msg.cmd === 'testResult') {
        const el = document.getElementById('res-' + msg.idx);
        if (el) {
          el.style.display = 'block';
          el.style.color = msg.ok ? 'var(--success)' : 'var(--error)';
          el.innerText = msg.ok ? 'Connected in ' + msg.latency + 'ms! Found ' + msg.count + ' models.' : 'Failed: ' + msg.error;
        }
      } else if (msg.cmd === 'pingResult') {
        const span = document.getElementById('ping-' + msg.id);
        if (span) {
          span.innerText = msg.ok ? msg.latency + 'ms' : 'Failed';
          span.style.color = msg.ok ? 'var(--success)' : 'var(--error)';
        }
      }
    });

    vscode.postMessage({ cmd: 'init' });

    function setTab(name, el) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('tab-' + name).classList.add('active');
    }

    function renderProviders() {
      document.getElementById('pCount').innerText = providers.length;
      const c = document.getElementById('provList');
      if (providers.length === 0) {
        c.innerHTML = '<div style="padding: 20px; opacity: 0.6;">No providers configured yet. Click "+ Add Provider" above.</div>';
        return;
      }
      c.innerHTML = providers.map((p, idx) => {
        return '<div class="card">' +
          '<div class="card-head">' +
            '<label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;">' +
              '<input type="checkbox" ' + (p.enabled !== false ? 'checked' : '') + ' onchange="providers[' + idx + '].enabled = this.checked">' +
              (p.name || 'Provider') +
            '</label>' +
            '<div>' +
              '<button class="sec" onclick="testProv(' + idx + ')">Test</button> ' +
              '<button class="danger" onclick="delProv(' + idx + ')">Remove</button>' +
            '</div>' +
          '</div>' +
          '<div class="row">' +
            '<div class="col">' +
              '<label>Name</label>' +
              '<input type="text" value="' + (p.name || '') + '" oninput="providers[' + idx + '].name = this.value">' +
            '</div>' +
            '<div class="col">' +
              '<label>Endpoint URL (OpenAI-compatible)</label>' +
              '<input type="text" value="' + (p.endpointUrl || '') + '" oninput="providers[' + idx + '].endpointUrl = this.value">' +
            '</div>' +
          '</div>' +
          '<div class="row">' +
            '<div class="col">' +
              '<label>API Key / Token (optional)</label>' +
              '<input type="password" value="' + (p.apiKey || '') + '" oninput="providers[' + idx + '].apiKey = this.value">' +
            '</div>' +
            '<div class="col" style="display:flex;align-items:flex-end;padding-bottom:6px;">' +
              '<label style="display:flex;align-items:center;gap:6px;">' +
                '<input type="checkbox" ' + (p.autoDiscover !== false ? 'checked' : '') + ' onchange="providers[' + idx + '].autoDiscover = this.checked">' +
                'Auto-discover (/v1/models)' +
              '</label>' +
            '</div>' +
          '</div>' +
          '<div class="msg" id="res-' + idx + '"></div>' +
        '</div>';
      }).join('');
    }

    function renderModels() {
      document.getElementById('mCount').innerText = activeModels.length;
      const b = document.getElementById('modelsBody');
      if (activeModels.length === 0) {
        b.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:16px;">No active models found.</td></tr>';
        return;
      }
      b.innerHTML = activeModels.map(m => {
        const safe = m.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        const inK = Math.round((m.maxInputTokens || 128000) / 1000);
        const outK = Math.round((m.maxOutputTokens || 16000) / 1000);
        return '<tr class="m-row" data-s="' + (m.id + ' ' + (m.name || '')).toLowerCase() + '">' +
          '<td><code>' + m.id + '</code></td>' +
          '<td><strong>' + (m.name || m.id) + '</strong></td>' +
          '<td><span class="tag">' + m.provider + '</span></td>' +
          '<td>' +
            (m.toolCalling ? '<span class="tag green">Tools</span>' : '') +
            (m.vision ? '<span class="tag green">Vision</span>' : '') +
            (m.thinking ? '<span class="tag green">Reasoning</span>' : '') +
          '</td>' +
          '<td>' + inK + 'k / ' + outK + 'k</td>' +
          '<td>' +
            '<button class="sec" style="padding:2px 8px;" onclick="pingModel(\\'' + m.provider + '\\', \\'' + m.id + '\\', \\'' + safe + '\\')">Ping</button>' +
            '<span id="ping-' + safe + '" style="margin-left:6px;font-size:11px;"></span>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    function filterModels() {
      const q = document.getElementById('mSearch').value.toLowerCase();
      document.querySelectorAll('.m-row').forEach(r => {
        r.style.display = (!q || r.getAttribute('data-s').includes(q)) ? '' : 'none';
      });
    }

    function addProvider() {
      providers.push({
        name: 'Ollama / Local',
        endpointUrl: 'http://localhost:11434',
        apiKey: '',
        autoDiscover: true,
        enabled: true
      });
      renderProviders();
    }

    function delProv(idx) {
      if (confirm('Delete provider ' + providers[idx].name + '?')) {
        providers.splice(idx, 1);
        renderProviders();
      }
    }

    function testProv(idx) {
      const el = document.getElementById('res-' + idx);
      if (el) { el.style.display = 'block'; el.style.color = 'var(--fg)'; el.innerText = 'Connecting...'; }
      vscode.postMessage({ cmd: 'testProv', idx: idx, prov: providers[idx] });
    }

    function pingModel(provName, modelId, safe) {
      const span = document.getElementById('ping-' + safe);
      if (span) { span.innerText = '...'; span.style.color = 'var(--fg)'; }
      vscode.postMessage({ cmd: 'pingModel', provName: provName, modelId: modelId, safe: safe });
    }

    function saveProviders() {
      vscode.postMessage({ cmd: 'saveProviders', providers: providers });
    }

    function saveFilters() {
      const bl = document.getElementById('blackList').value.split('\\n').map(s => s.trim()).filter(Boolean);
      const wl = document.getElementById('whiteList').value.split('\\n').map(s => s.trim()).filter(Boolean);
      vscode.postMessage({ cmd: 'saveFilters', blacklist: bl, whitelist: wl });
    }

    function syncNow() {
      vscode.postMessage({ cmd: 'syncNow' });
    }
  </script>
</body>
</html>`;
  }
}
