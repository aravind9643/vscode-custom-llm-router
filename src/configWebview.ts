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
          vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
          await this._sendState();
        } else if (msg.cmd === "saveDisabledModels") {
          const config = vscode.workspace.getConfiguration("customLlmRouter");
          await config.update("disabledModelIds", msg.disabledModels, vscode.ConfigurationTarget.Global);
          this._engine.setDisabledModelIds(msg.disabledModels);
          vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
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
    const disabledModels = config.get<string[]>("disabledModelIds") || [];
    
    // In dashboard catalog: includeFailed: true so failed/offline models are visible for inspection & re-testing
    const provs = await this._engine.generateProviders({ profile: "all", includeFailed: true });

    const models: (VSCodeModel & { provider: string; disabled: boolean; isCoding: boolean; isReasoning: boolean })[] = [];
    for (const p of provs) {
      for (const m of p.models || []) {
        const fullKey = `${p.name}::${m.id}`;
        const isDisabled = disabledModels.includes(fullKey) || disabledModels.includes(m.id);
        const idLower = m.id.toLowerCase();
        const isCoding = Boolean(idLower.match(/(coder|coding|code|dev|claude|gpt-4|deepseek|qwen)/) || m.toolCalling);
        const isReasoning = Boolean(idLower.match(/(reasoning|r1|o1|o3|thinking|thought)/) || m.thinking);
        models.push({
          ...m,
          provider: p.name,
          disabled: isDisabled,
          isCoding,
          isReasoning,
        });
      }
    }

    const cacheEntries = this._engine.getAllCacheEntries();

    this._panel.webview.postMessage({
      cmd: "state",
      providers,
      models,
      cacheEntries,
      disabledModels,
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
    .chip { background: rgba(255,255,255,0.06); border: 1px solid var(--border); color: var(--fg); padding: 4px 10px; border-radius: 14px; font-size: 11px; cursor: pointer; transition: all 0.2s; user-select: none; }
    .chip:hover { background: rgba(255,255,255,0.12); }
    .chip.active { background: var(--btn-bg); color: #fff; border-color: var(--btn-bg); font-weight: 600; }
    .selection-bar { display: flex; justify-content: space-between; align-items: center; margin: 10px 0; padding: 8px 12px; background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
    .model-cat { font-size: 10px; padding: 2px 5px; border-radius: 3px; font-weight: 500; margin-right: 4px; display: inline-block; }
    .model-cat.code { background: rgba(86,156,214,0.2); color: #569cd6; border: 1px solid rgba(86,156,214,0.4); }
    .model-cat.reasoning { background: rgba(197,134,192,0.2); color: #c586c0; border: 1px solid rgba(197,134,192,0.4); }
    .model-cat.vision { background: rgba(206,145,120,0.2); color: #ce9178; border: 1px solid rgba(206,145,120,0.4); }
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
      <input type="text" id="mSearch" placeholder="Search model ID or name..." oninput="filterModels()" style="max-width: 280px;">
      <div style="display: flex; gap: 8px;">
        <button onclick="runBatchTest(false)">⚡ Test All Models (Concurrent)</button>
        <button class="sec" onclick="runBatchTest(true)">Force Retest All</button>
      </div>
    </div>

    <!-- Filter Chips -->
    <div style="display: flex; gap: 6px; margin: 8px 0 10px 0; flex-wrap: wrap; align-items: center;">
      <span style="font-size: 11px; opacity: 0.7; margin-right: 4px;">Filters:</span>
      <button class="chip active" id="chip-all" onclick="setFilterCategory('all')">🌟 All (<span id="cAll">0</span>)</button>
      <button class="chip" id="chip-coding" onclick="setFilterCategory('coding')">💻 Coding (<span id="cCoding">0</span>)</button>
      <button class="chip" id="chip-reasoning" onclick="setFilterCategory('reasoning')">🧠 Reasoning (<span id="cReasoning">0</span>)</button>
      <button class="chip" id="chip-vision" onclick="setFilterCategory('vision')">👁️ Vision (<span id="cVision">0</span>)</button>
      <button class="chip" id="chip-working" onclick="setFilterCategory('working')">✅ Working (<span id="cWorking">0</span>)</button>
      <button class="chip" id="chip-failed" onclick="setFilterCategory('failed')">❌ Failed (<span id="cFailed">0</span>)</button>
      <button class="chip" id="chip-selected" onclick="setFilterCategory('selected')">📌 In Copilot (<span id="cSelected">0</span>)</button>
    </div>

    <!-- Selection Management Bar -->
    <div class="selection-bar">
      <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <span style="font-weight: 500;">Copilot Model Selection:</span>
        <button class="sec" style="padding: 2px 8px; font-size: 11px;" onclick="enableAllWorking()">Enable All Working</button>
        <button class="sec" style="padding: 2px 8px; font-size: 11px;" onclick="selectVisible(true)">Select Visible</button>
        <button class="sec" style="padding: 2px 8px; font-size: 11px;" onclick="selectVisible(false)">Deselect Visible</button>
      </div>
      <div id="selectionSummary" style="font-size: 11px; opacity: 0.85;">0 models active in Copilot</div>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width: 34px; text-align: center;">
            <input type="checkbox" id="selectAllBox" onchange="toggleSelectAllBox(this.checked)" title="Toggle Selection for Visible Models">
          </th>
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

  <script>
    const vscode = acquireVsCodeApi();
    let providers = [];
    let activeModels = [];
    let cacheEntries = [];
    let disabledSet = new Set();
    let activeFilterCategory = "all";

    window.addEventListener('message', ev => {
      const msg = ev.data;
      if (msg.cmd === 'state') {
        providers = msg.providers || [];
        activeModels = msg.models || [];
        cacheEntries = msg.cacheEntries || [];
        renderProviders();
        renderModels();
        renderCache();
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

    function setFilterCategory(cat) {
      activeFilterCategory = cat;
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      const chip = document.getElementById('chip-' + cat);
      if (chip) chip.classList.add('active');
      filterModels();
    }

    function toggleModelSelection(idx, isChecked) {
      const m = activeModels[idx];
      if (!m) return;
      const key = m.provider + '::' + m.id;
      if (isChecked) {
        disabledSet.delete(key);
        disabledSet.delete(m.id);
        m.disabled = false;
      } else {
        disabledSet.add(key);
        m.disabled = true;
      }
      saveDisabled();
      updateCounts();
    }

    function enableAllWorking() {
      activeModels.forEach(m => {
        if (m._verifiedWorking === true) {
          const key = m.provider + '::' + m.id;
          disabledSet.delete(key);
          disabledSet.delete(m.id);
          m.disabled = false;
        }
      });
      saveDisabled();
      renderModels();
    }

    function selectVisible(check) {
      document.querySelectorAll('.m-row').forEach(row => {
        if (row.style.display !== 'none') {
          const idx = parseInt(row.getAttribute('data-idx'), 10);
          const m = activeModels[idx];
          if (m) {
            const key = m.provider + '::' + m.id;
            if (check) {
              disabledSet.delete(key);
              disabledSet.delete(m.id);
              m.disabled = false;
            } else {
              disabledSet.add(key);
              m.disabled = true;
            }
          }
        }
      });
      saveDisabled();
      renderModels();
    }

    function toggleSelectAllBox(checked) {
      selectVisible(checked);
    }

    function saveDisabled() {
      vscode.postMessage({ cmd: 'saveDisabledModels', disabledModels: Array.from(disabledSet) });
    }

    function updateCounts() {
      const allCount = activeModels.length;
      const codingCount = activeModels.filter(m => m.isCoding).length;
      const reasoningCount = activeModels.filter(m => m.isReasoning).length;
      const visionCount = activeModels.filter(m => m.vision).length;
      const workingCount = activeModels.filter(m => m._verifiedWorking === true).length;
      const failedCount = activeModels.filter(m => m._verifiedWorking === false).length;
      const selectedCount = activeModels.filter(m => !m.disabled && m._verifiedWorking === true).length;

      const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
      setTxt('mCount', allCount);
      setTxt('cAll', allCount);
      setTxt('cCoding', codingCount);
      setTxt('cReasoning', reasoningCount);
      setTxt('cVision', visionCount);
      setTxt('cWorking', workingCount);
      setTxt('cFailed', failedCount);
      setTxt('cSelected', selectedCount);

      const summary = document.getElementById('selectionSummary');
      if (summary) {
        summary.innerText = selectedCount + ' of ' + workingCount + ' working models active in Copilot';
      }
    }

    function renderModels() {
      updateCounts();
      const b = document.getElementById('modelsBody');
      if (activeModels.length === 0) {
        b.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:16px;">No models discovered yet. Click Refresh Models or add an endpoint.</td></tr>';
        return;
      }
      b.innerHTML = activeModels.map((m, mIdx) => {
        const safe = m.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        const inK = Math.round((m.maxInputTokens || 128000) / 1000);
        const outK = Math.round((m.maxOutputTokens || 16000) / 1000);
        const isChecked = !m.disabled;

        let verifyBadge = '<span class="tag" style="opacity:0.6;">Untested</span>';
        if (m._verifiedWorking === true) {
          verifyBadge = '<span class="tag green">Verified (' + (m._latency || 0) + 'ms)</span>';
        } else if (m._verifiedWorking === false) {
          const errHint = m._error ? ' - ' + m._error.replace(/"/g, '&quot;') : '';
          verifyBadge = '<span class="tag red" title="Failed' + errHint + '">Offline / Failed</span>';
        }

        const caps = [
          m.isCoding ? '<span class="model-cat code">Coding</span>' : '',
          m.isReasoning ? '<span class="model-cat reasoning">Reasoning</span>' : '',
          m.vision ? '<span class="model-cat vision">Vision</span>' : '',
          m.toolCalling ? '<span class="tag green">Tools</span>' : '',
        ].filter(Boolean).join('');

        const isFailed = m._verifiedWorking === false;
        const errDisplay = isFailed && m._error ? '<div style="font-size:10px; color:var(--error); margin-top:2px;">' + m._error.slice(0, 90) + '</div>' : '';

        return '<tr class="m-row" data-idx="' + mIdx + '" data-s="' + (m.id + ' ' + (m.name || '')).toLowerCase() + '" ' +
          'data-coding="' + (m.isCoding ? 'true' : 'false') + '" ' +
          'data-reasoning="' + (m.isReasoning ? 'true' : 'false') + '" ' +
          'data-vision="' + (m.vision ? 'true' : 'false') + '" ' +
          'data-working="' + (m._verifiedWorking === true ? 'true' : 'false') + '" ' +
          'data-failed="' + (isFailed ? 'true' : 'false') + '" ' +
          'data-selected="' + (isChecked && m._verifiedWorking === true ? 'true' : 'false') + '">' +
          '<td style="text-align: center;"><input type="checkbox" ' + (isChecked ? 'checked' : '') + ' onchange="toggleModelSelection(' + mIdx + ', this.checked)" title="' + (isChecked ? 'Active in Copilot' : 'Disabled from Copilot') + '"></td>' +
          '<td><code>' + m.id + '</code></td>' +
          '<td><strong>' + (m.name || m.id) + '</strong>' + errDisplay + '</td>' +
          '<td><span class="tag">' + m.provider + '</span></td>' +
          '<td>' + caps + '</td>' +
          '<td>' + inK + 'k / ' + outK + 'k</td>' +
          '<td>' + verifyBadge + '</td>' +
          '<td>' +
            '<button class="sec" style="padding:2px 8px;" onclick="pingModelByIdx(' + mIdx + ')">Ping & Tools</button>' +
            '<span id="ping-' + safe + '" style="margin-left:6px;font-size:11px;"></span>' +
          '</td>' +
        '</tr>';
      }).join('');
      filterModels();
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
      const q = (document.getElementById('mSearch').value || '').toLowerCase().trim();
      document.querySelectorAll('.m-row').forEach(r => {
        const s = r.getAttribute('data-s') || '';
        const isCoding = r.getAttribute('data-coding') === 'true';
        const isReasoning = r.getAttribute('data-reasoning') === 'true';
        const isVision = r.getAttribute('data-vision') === 'true';
        const isWorking = r.getAttribute('data-working') === 'true';
        const isFailed = r.getAttribute('data-failed') === 'true';
        const isSelected = r.getAttribute('data-selected') === 'true';

        let matchCat = true;
        if (activeFilterCategory === 'coding') matchCat = isCoding;
        else if (activeFilterCategory === 'reasoning') matchCat = isReasoning;
        else if (activeFilterCategory === 'vision') matchCat = isVision;
        else if (activeFilterCategory === 'working') matchCat = isWorking;
        else if (activeFilterCategory === 'failed') matchCat = isFailed;
        else if (activeFilterCategory === 'selected') matchCat = isSelected;

        const matchSearch = !q || s.includes(q);
        r.style.display = (matchCat && matchSearch) ? '' : 'none';
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
      providers.splice(idx, 1);
      renderProviders();
    }

    function testProv(idx) {
      const el = document.getElementById('res-' + idx);
      if (el) { el.style.display = 'block'; el.style.color = 'var(--fg)'; el.innerText = 'Connecting...'; }
      vscode.postMessage({ cmd: 'testProv', idx: idx, prov: providers[idx] });
    }

    function pingModelByIdx(idx) {
      const m = activeModels[idx];
      if (!m) return;
      const safe = m.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      pingModel(m.provider, m.id, safe);
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
      vscode.postMessage({ cmd: 'clearCache' });
    }

    function saveProviders() {
      vscode.postMessage({ cmd: 'saveProviders', providers: providers });
    }

    function syncNow() {
      vscode.postMessage({ cmd: 'syncNow' });
    }
  </script>
</body>
</html>`;
  }
}
