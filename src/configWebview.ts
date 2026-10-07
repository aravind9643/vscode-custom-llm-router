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
          const config = vscode.workspace.getConfiguration("customLlmRouter");
          const providers = config.get<CustomProviderConfig[]>("providers") || [];
          const prov = providers.find((cp) => cp.name === msg.provName) || {
            name: msg.provName,
            endpointUrl: "",
            apiKey: "",
          };
          const res = await this._engine.testSingleModel(prov, msg.modelId, true);
          this._panel.webview.postMessage({
            cmd: "pingResult",
            id: msg.safe,
            ok: res.working,
            latency: res.latency,
            verifiedTools: res.verifiedTools,
            error: res.error,
          });
        } else if (msg.cmd === "runAllTests") {
          await vscode.commands.executeCommand("vscode-custom-llm-router.testAllModels", msg.force);
          await this._sendState();
        } else if (msg.cmd === "clearCache") {
          await this._engine.clearCache();
          vscode.window.showInformationMessage("Verified models cache cleared.");
          await this._sendState();
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

    const cacheEntries = this._engine.getAllCacheEntries();

    this._panel.webview.postMessage({
      cmd: "state",
      providers,
      blacklist,
      whitelist,
      models,
      cacheEntries,
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
      --warning: #cca700;
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
    .tag.red { background: rgba(241,76,76,0.2); color: var(--error); }
    .msg { font-size: 11px; margin-top: 6px; padding: 4px 8px; border-radius: 4px; display: none; }
    .actions-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; justify-content: space-between; }
    .presets-bar { display: flex; gap: 6px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
    .preset-btn { background: rgba(255,255,255,0.05); border: 1px solid var(--border); font-size: 11px; padding: 4px 8px; border-radius: 4px; color: var(--fg); cursor: pointer; }
    .preset-btn:hover { background: rgba(255,255,255,0.12); }
  </style>
</head>
<body>
  <div class="top-bar">
    <div class="title">Custom LLM Router <span class="badge">Model Engine & Verification</span></div>
    <div>
      <button class="sec" onclick="syncNow()">Refresh Models</button>
      <button onclick="addProvider()">+ Add Provider</button>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="setTab('providers', this)">Providers (<span id="pCount">0</span>)</div>
    <div class="tab" onclick="setTab('models', this)">Models Catalog & Tests (<span id="mCount">0</span>)</div>
    <div class="tab" onclick="setTab('cache', this)">Verified Cache (<span id="cacheCount">0</span>)</div>
    <div class="tab" onclick="setTab('filters', this)">Rules & Filters</div>
  </div>

  <!-- TAB: PROVIDERS -->
  <div id="tab-providers" class="panel active">
    <div class="presets-bar">
      <span style="font-size:12px; opacity:0.8;">Quick-Add Presets:</span>
      <button class="preset-btn" onclick="applyPreset('Ollama Local', 'http://localhost:11434')">Ollama</button>
      <button class="preset-btn" onclick="applyPreset('LM Studio', 'http://localhost:1234')">LM Studio</button>
      <button class="preset-btn" onclick="applyPreset('vLLM Local', 'http://localhost:8000')">vLLM</button>
      <button class="preset-btn" onclick="applyPreset('FreeLLMAPI', 'http://127.0.0.1:31415')">FreeLLMAPI</button>
      <button class="preset-btn" onclick="applyPreset('OmniRoute', 'http://localhost:20128')">OmniRoute</button>
      <button class="preset-btn" onclick="applyPreset('OpenRouter', 'https://openrouter.ai/api')">OpenRouter</button>
      <button class="preset-btn" onclick="applyPreset('DeepSeek', 'https://api.deepseek.com')">DeepSeek</button>
    </div>
    <div id="provList"></div>
    <button style="margin-top: 8px;" onclick="saveProviders()">Save All Provider Changes</button>
  </div>

  <!-- TAB: MODELS -->
  <div id="tab-models" class="panel">
    <div class="actions-bar">
      <input type="text" id="mSearch" placeholder="Search model ID or name..." oninput="filterModels()" style="max-width: 300px;">
      <div style="display: flex; gap: 8px;">
        <button onclick="runBatchTest(false)">⚡ Test All Models (Concurrent)</button>
        <button class="sec" onclick="runBatchTest(true)">Force Retest All</button>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Model ID</th>
          <th>Display Name</th>
          <th>Provider</th>
          <th>Capabilities</th>
          <th>Limits</th>
          <th>Verification</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="modelsBody"></tbody>
    </table>
  </div>

  <!-- TAB: CACHE -->
  <div id="tab-cache" class="panel">
    <div class="card">
      <div class="card-head">
        <div>
          <strong>Verified Working Models Cache (48h TTL)</strong>
          <div style="font-size:11px; opacity:0.8; margin-top:2px;">Keeps test results and latencies in cache so VS Code doesn't re-test models repeatedly.</div>
        </div>
        <div>
          <button class="danger" onclick="clearCache()">Clear Cache</button>
        </div>
      </div>
      <table style="margin-top: 10px;">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Model ID</th>
            <th>Status</th>
            <th>Latency</th>
            <th>Tool Calling</th>
            <th>Tested</th>
          </tr>
        </thead>
        <tbody id="cacheBody"></tbody>
      </table>
    </div>
  </div>

  <!-- TAB: FILTERS -->
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
    let cacheEntries = [];

    window.addEventListener('message', ev => {
      const msg = ev.data;
      if (msg.cmd === 'state') {
        providers = msg.providers || [];
        activeModels = msg.models || [];
        cacheEntries = msg.cacheEntries || [];
        renderProviders();
        renderModels();
        renderCache();
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
          const toolTag = msg.verifiedTools !== undefined ? (msg.verifiedTools ? ' [tools:ok]' : ' [tools:no]') : '';
          span.innerText = msg.ok ? msg.latency + 'ms' + toolTag : '❌ ' + (msg.error || 'Failed');
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
        c.innerHTML = '<div style="padding: 20px; opacity: 0.6;">No providers configured yet. Click "+ Add Provider" or a preset above.</div>';
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
        b.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:16px;">No active models found.</td></tr>';
        return;
      }
      b.innerHTML = activeModels.map(m => {
        const safe = m.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        const inK = Math.round((m.maxInputTokens || 128000) / 1000);
        const outK = Math.round((m.maxOutputTokens || 16000) / 1000);
        
        let verifyBadge = '<span class="tag" style="opacity:0.6;">Untested</span>';
        if (m._verifiedWorking === true) {
          verifyBadge = '<span class="tag green">Verified (' + (m._latency || 0) + 'ms)</span>';
        } else if (m._verifiedWorking === false) {
          verifyBadge = '<span class="tag red">Offline/Failed</span>';
        }

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
          '<td>' + verifyBadge + '</td>' +
          '<td>' +
            '<button class="sec" style="padding:2px 8px;" onclick="pingModel(\\'' + m.provider + '\\', \\'' + m.id + '\\', \\'' + safe + '\\')">Ping & Tools</button>' +
            '<span id="ping-' + safe + '" style="margin-left:6px;font-size:11px;"></span>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    function renderCache() {
      document.getElementById('cacheCount').innerText = cacheEntries.length;
      const b = document.getElementById('cacheBody');
      if (cacheEntries.length === 0) {
        b.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:16px;">Cache is empty. Run a batch test to populate.</td></tr>';
        return;
      }
      b.innerHTML = cacheEntries.map(e => {
        const hoursAgo = Math.round((Date.now() - e.testedAt) / (1000 * 60 * 60));
        return '<tr>' +
          '<td><span class="tag">' + e.providerName + '</span></td>' +
          '<td><code>' + e.modelId + '</code></td>' +
          '<td>' + (e.working ? '<span class="tag green">Working</span>' : '<span class="tag red">Failed</span>') + '</td>' +
          '<td>' + e.latency + 'ms</td>' +
          '<td>' + (e.verifiedTools === true ? '✅ Yes' : e.verifiedTools === false ? '❌ No' : '—') + '</td>' +
          '<td>' + (hoursAgo === 0 ? 'Just now' : hoursAgo + 'h ago') + '</td>' +
        '</tr>';
      }).join('');
    }

    function filterModels() {
      const q = document.getElementById('mSearch').value.toLowerCase();
      document.querySelectorAll('.m-row').forEach(r => {
        r.style.display = (!q || r.getAttribute('data-s').includes(q)) ? '' : 'none';
      });
    }

    function applyPreset(name, url) {
      providers.push({
        name: name,
        endpointUrl: url,
        apiKey: '',
        autoDiscover: true,
        enabled: true
      });
      renderProviders();
    }

    function addProvider() {
      providers.push({
        name: 'Custom Provider ' + (providers.length + 1),
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
      if (span) { span.innerText = 'Testing...'; span.style.color = 'var(--fg)'; }
      vscode.postMessage({ cmd: 'pingModel', provName: provName, modelId: modelId, safe: safe });
    }

    function runBatchTest(force) {
      vscode.postMessage({ cmd: 'runAllTests', force: force });
    }

    function clearCache() {
      if (confirm('Clear verified model cache?')) {
        vscode.postMessage({ cmd: 'clearCache' });
      }
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
