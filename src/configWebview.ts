import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ModelEngine, CustomProviderConfig, VSCodeModel } from "./modelEngine";

let _codiconCssCache: string | undefined;

function getCodiconCss(): string {
  if (_codiconCssCache) return _codiconCssCache;
  try {
    const candidates = [
      path.join(__dirname, "../media"),
      path.join(__dirname, "media"),
      path.join(__dirname, "../../media"),
    ];
    const mediaDir = candidates.find(
      (d) =>
        fs.existsSync(path.join(d, "codicon.css")) &&
        fs.existsSync(path.join(d, "codicon.ttf"))
    );
    if (mediaDir) {
      const cssPath = path.join(mediaDir, "codicon.css");
      const ttfPath = path.join(mediaDir, "codicon.ttf");
      const ttfB64 = fs.readFileSync(ttfPath).toString("base64");
      let css = fs.readFileSync(cssPath, "utf8");
      css = css.replace(
        /src:\s*url\([^)]+\)/,
        `src: url("data:font/truetype;charset=utf-8;base64,${ttfB64}")`
      );
      _codiconCssCache = css;
      return css;
    }
  } catch (err) {
    console.error("[Custom LLM Router] Failed to load Codicon font:", err);
  }
  return "";
}

export class ConfigWebviewPanel {
  public static currentPanel: ConfigWebviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _engine: ModelEngine;

  public static postMessageToActivePanel(msg: any) {
    if (ConfigWebviewPanel.currentPanel) {
      ConfigWebviewPanel.currentPanel._panel.webview.postMessage(msg);
    }
  }

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
        } else if (msg.cmd === "testSpecificModels") {
          await vscode.commands.executeCommand("vscode-custom-llm-router.testSpecificModels", msg.models, msg.force);
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
        } else if (msg.cmd === "exportConfig") {
          const config = vscode.workspace.getConfiguration("customLlmRouter");
          const providers = config.get<CustomProviderConfig[]>("providers") || [];
          const disabledModels = config.get<string[]>("disabledModelIds") || [];
          const exportJson = JSON.stringify({ providers, disabledModelIds: disabledModels }, null, 2);
          await vscode.env.clipboard.writeText(exportJson);
          vscode.window.showInformationMessage("Custom LLM Router configuration copied to clipboard!");
        } else if (msg.cmd === "importConfig") {
          const input = await vscode.window.showInputBox({
            placeHolder: "Paste configuration JSON here...",
            prompt: "Import Providers and Model Configuration",
            ignoreFocusOut: true,
          });
          if (input && input.trim()) {
            try {
              const parsed = JSON.parse(input.trim());
              if (Array.isArray(parsed.providers)) {
                const config = vscode.workspace.getConfiguration("customLlmRouter");
                await config.update("providers", parsed.providers, vscode.ConfigurationTarget.Global);
                if (Array.isArray(parsed.disabledModelIds)) {
                  await config.update("disabledModelIds", parsed.disabledModelIds, vscode.ConfigurationTarget.Global);
                  this._engine.setDisabledModelIds(parsed.disabledModelIds);
                }
                vscode.window.showInformationMessage(`Successfully imported ${parsed.providers.length} provider(s)!`);
                vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
                await this._sendState();
              } else {
                vscode.window.showErrorMessage("Invalid configuration: missing providers array.");
              }
            } catch (err: any) {
              vscode.window.showErrorMessage("Failed to parse JSON: " + err.message);
            }
          }
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
        const isCoding = Boolean(idLower.match(/(coder|coding|code|dev|claude|gpt-4|deepseek|qwen|starcoder|codellama)/));
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
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      height: 100vh;
      margin: 0;
      padding: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    /* Fixed App Header */
    .app-header {
      flex-shrink: 0;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      z-index: 50;
    }
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 24px 8px 24px;
    }
    .title {
      font-size: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 10px;
      letter-spacing: -0.2px;
    }
    .badge {
      font-size: 10px;
      background: rgba(14, 99, 156, 0.25);
      color: #4fc1ff;
      border: 1px solid rgba(14, 99, 156, 0.6);
      padding: 2px 8px;
      border-radius: 12px;
      font-weight: 500;
    }
    .tabs {
      display: flex;
      gap: 8px;
      padding: 0 24px;
      margin: 0;
    }
    .tab {
      padding: 8px 14px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      font-size: 13px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.65);
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      gap: 6px;
      user-select: none;
    }
    .tab:hover { color: #fff; }
    .tab.active {
      border-bottom-color: var(--btn-bg);
      color: #fff;
      font-weight: 600;
    }
    .tab-badge {
      font-size: 11px;
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 7px;
      border-radius: 10px;
      font-weight: 500;
    }
    .tab.active .tab-badge {
      background: var(--btn-bg);
      color: #fff;
    }

    /* Fixed Viewport Body: No whole-page scroll */
    .app-body {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 12px 24px 14px 24px;
    }
    .panel { display: none; }
    .panel.active {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    #tab-providers.active {
      overflow-y: auto;
      display: block;
      padding-right: 4px;
    }

    /* Cards & Panels */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 12px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.15);
    }
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .row { display: flex; gap: 10px; margin-bottom: 8px; }
    .col { flex: 1; }
    label { display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; }
    input[type=text], input[type=password], textarea {
      width: 100%;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 12px;
      outline: none;
      box-sizing: border-box;
    }
    input[type=text]:focus, input[type=password]:focus, textarea:focus, select:focus {
      border-color: #0e639c;
    }
    input[type=checkbox] {
      accent-color: #0e639c;
      width: 15px;
      height: 15px;
      cursor: pointer;
      vertical-align: middle;
      margin: 0;
    }
    button {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 0 12px;
      height: 30px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: background 0.15s ease, border-color 0.15s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      box-sizing: border-box;
      white-space: nowrap;
    }
    button:hover { background: var(--btn-hover); }
    button.sec {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      color: var(--fg);
    }
    button.sec:hover { background: rgba(255, 255, 255, 0.09); border-color: rgba(255, 255, 255, 0.25); }
    button.danger { background: var(--error); color: #fff; }

    /* Fixed Controls Toolbar: Sticks at top of models panel */
    .models-sticky-toolbar {
      flex-shrink: 0;
      background: var(--bg);
      padding: 0 0 8px 0;
      margin-bottom: 6px;
    }
    .actions-bar {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .search-wrap {
      position: relative;
      flex: 1;
    }
    .search-wrap input {
      width: 100%;
      height: 30px;
      padding-left: 28px;
      padding-right: 24px;
      box-sizing: border-box;
    }
    .search-wrap .search-icon {
      position: absolute;
      left: 8px;
      top: 50%;
      transform: translateY(-50%);
      opacity: 0.5;
      font-size: 13px;
      pointer-events: none;
    }
    .search-wrap .clear-btn {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      cursor: pointer;
      opacity: 0.6;
      font-size: 11px;
    }
    .search-wrap .clear-btn:hover {
      opacity: 1;
    }
    .prov-select {
      height: 30px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      padding: 0 10px;
      cursor: pointer;
      outline: none;
      box-sizing: border-box;
    }

    /* Filter Chips */
    .filter-chips {
      display: flex;
      gap: 6px;
      margin: 4px 0 8px 0;
      flex-wrap: wrap;
      align-items: center;
    }
    .filter-label {
      font-size: 11px;
      opacity: 0.75;
      margin-right: 4px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-weight: 500;
    }
    .chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: rgba(255, 255, 255, 0.85);
      height: 26px;
      padding: 0 10px;
      border-radius: 13px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      box-sizing: border-box;
    }
    .chip:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      border-color: rgba(255, 255, 255, 0.25);
    }
    .chip.active {
      background: #0e639c;
      color: #fff;
      border-color: #1177bb;
      font-weight: 600;
      box-shadow: 0 0 10px rgba(14, 99, 156, 0.35);
    }
    .chip-count {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.12);
      margin-left: 3px;
    }
    .chip.active .chip-count {
      background: rgba(255, 255, 255, 0.24);
    }

    /* Selection Bar */
    .selection-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 12px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 12px;
      gap: 10px;
      flex-wrap: wrap;
    }
    .tool-btn {
      height: 24px !important;
      padding: 0 8px !important;
      font-size: 11px !important;
      border-radius: 4px;
      gap: 4px !important;
    }
    .v-sep {
      width: 1px;
      height: 16px;
      background: var(--border);
      margin: 0 3px;
      flex-shrink: 0;
    }
    .selection-badge {
      font-size: 11px;
      background: rgba(115, 201, 145, 0.14);
      color: var(--success);
      border: 1px solid rgba(115, 201, 145, 0.3);
      padding: 2px 10px;
      border-radius: 12px;
      font-weight: 500;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
    }

    /* Table Container: This is the ONLY element that scrolls! */
    .table-container {
      flex: 1;
      min-height: 0;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      overflow-y: auto;
      overflow-x: auto;
      position: relative;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 12px;
      table-layout: fixed;
    }
    /* Fixed Sticky Table Header: Stays locked at top of table container */
    th {
      position: sticky;
      top: 0;
      z-index: 25;
      background: #252526;
      padding: 9px 10px;
      border-bottom: 2px solid var(--border);
      box-shadow: 0 2px 4px rgba(0,0,0,0.25);
      font-weight: 600;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.75);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      white-space: nowrap;
      text-align: left;
      user-select: none;
    }
    td {
      padding: 7px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      vertical-align: middle;
      text-align: left;
    }
    tr.m-row { transition: background 0.1s ease; }
    tr.m-row:hover { background: rgba(255, 255, 255, 0.035); }
    tr.m-row[data-selected="true"] { background: rgba(14, 99, 156, 0.04); }
    tr.m-row[data-selected="true"]:hover { background: rgba(14, 99, 156, 0.08); }

    /* Model cell styles */
    .model-id {
      font-family: var(--vscode-editor-font-family, "Consolas", monospace);
      font-size: 11px;
      background: rgba(255, 255, 255, 0.05);
      padding: 2px 6px;
      border-radius: 4px;
      color: #9cdcfe;
      display: inline-block;
      max-width: 175px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      vertical-align: middle;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .model-name {
      font-weight: 500;
      font-size: 12px;
      color: var(--fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .model-err {
      font-size: 10.5px;
      color: var(--error);
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .provider-badge {
      font-size: 10.5px;
      padding: 2px 7px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.85);
      font-weight: 500;
      display: inline-block;
      white-space: nowrap;
    }

    /* Capabilities Badges */
    .caps-container {
      display: flex;
      gap: 4px;
      align-items: center;
      flex-wrap: wrap;
    }
    .cap-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      white-space: nowrap;
      line-height: 1.2;
    }
    .cap-badge.code { background: rgba(55, 148, 255, 0.12); color: #4fc1ff; border: 1px solid rgba(55, 148, 255, 0.28); }
    .cap-badge.reasoning { background: rgba(191, 122, 240, 0.12); color: #d2a8ff; border: 1px solid rgba(191, 122, 240, 0.28); }
    .cap-badge.vision { background: rgba(245, 158, 11, 0.12); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.28); }
    .cap-badge.tools { background: rgba(115, 201, 145, 0.12); color: var(--success); border: 1px solid rgba(115, 201, 145, 0.28); }

    /* Limits */
    .limits-text {
      font-size: 11px;
      opacity: 0.85;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .limits-sep {
      opacity: 0.35;
      margin: 0 1px;
    }

    /* Verification Status Badges */
    .status-badge {
      font-size: 10.5px;
      padding: 2px 7px;
      border-radius: 4px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    .status-badge.ok {
      background: rgba(115, 201, 145, 0.14);
      color: var(--success);
      border: 1px solid rgba(115, 201, 145, 0.3);
    }
    .status-badge.err {
      background: rgba(241, 76, 76, 0.14);
      color: var(--error);
      border: 1px solid rgba(241, 76, 76, 0.3);
    }
    .status-badge.untested {
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    /* Action Cell */
    .action-cell {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ping-btn {
      height: 24px !important;
      padding: 0 8px !important;
      font-size: 11px !important;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .ping-status {
      font-size: 10.5px;
      max-width: 65px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: inline-block;
    }

    /* Presets Bar */
    .presets-bar { display: flex; gap: 6px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
    .preset-btn { background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border); font-size: 11px; height: 26px; padding: 0 8px; border-radius: 4px; color: var(--fg); cursor: pointer; }
    .preset-btn:hover { background: rgba(255, 255, 255, 0.12); }
    .msg { font-size: 11px; margin-top: 6px; padding: 4px 8px; border-radius: 4px; display: none; }

    /* Custom Scrollbar */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.28); }
  

    /* VS Code Codicon Integration */
    .codicon {
      font-family: "codicon";
      display: inline-block;
      text-decoration: none;
      text-rendering: auto;
      text-align: center;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      user-select: none;
      vertical-align: middle;
      font-size: 13px;
      line-height: 1;
    }
    button .codicon {
      margin-right: 4px;
      font-size: 13px;
      vertical-align: -1px;
    }
    .chip .codicon {
      margin-right: 3px;
      font-size: 12px;
      vertical-align: -1px;
    }
    .tag .codicon, .model-cat .codicon {
      margin-right: 3px;
      font-size: 11px;
      vertical-align: -1px;
    }
    .tab .codicon {
      margin-right: 4px;
      font-size: 14px;
      vertical-align: -1px;
    }
    /* Embedded Codicon Font and Icons */
    ${getCodiconCss()}


  </style>
</head>
<body>
  <header class="app-header">
    <div class="top-bar">
      <div class="title"><i class="codicon codicon-hubot" style="color:#4fc1ff; font-size:18px;"></i> Custom LLM Router <span class="badge">Model Engine & Verification</span></div>
      <div style="display: flex; gap: 8px;">
        <button class="sec" onclick="syncNow()"><i class="codicon codicon-refresh"></i> Refresh Models</button>
        <button onclick="addProvider()"><i class="codicon codicon-add"></i> Add Provider</button>
      </div>
    </div>
    <div class="tabs">
      <div class="tab" id="tab-btn-providers" onclick="setTab('providers', this)"><i class="codicon codicon-server"></i> Providers <span class="tab-badge" id="pCount">0</span></div>
      <div class="tab active" id="tab-btn-models" onclick="setTab('models', this)"><i class="codicon codicon-symbol-misc"></i> Models Catalog & Tests <span class="tab-badge" id="mCount">0</span></div>
      <div class="tab" id="tab-btn-cache" onclick="setTab('cache', this)"><i class="codicon codicon-database"></i> Verified Cache <span class="tab-badge" id="cacheCount">0</span></div>
    </div>
  </header>

  <main class="app-body">
    <!-- TAB: PROVIDERS -->
    <div id="tab-providers" class="panel">
      <div class="presets-bar">
        <span style="font-size:12px; opacity:0.8;"><i class="codicon codicon-zap" style="color:#cca700;"></i> Presets:</span>
        <button class="preset-btn" onclick="applyPreset('Ollama Local', 'http://localhost:11434')">Ollama</button>
        <button class="preset-btn" onclick="applyPreset('LM Studio', 'http://localhost:1234')">LM Studio</button>
        <button class="preset-btn" onclick="applyPreset('vLLM Local', 'http://localhost:8000')">vLLM</button>
        <button class="preset-btn" onclick="applyPreset('FreeLLMAPI', 'http://127.0.0.1:31415')">FreeLLMAPI</button>
        <button class="preset-btn" onclick="applyPreset('OmniRoute', 'http://localhost:20128')">OmniRoute</button>
        <button class="preset-btn" onclick="applyPreset('OpenRouter', 'https://openrouter.ai/api')">OpenRouter</button>
        <button class="preset-btn" onclick="applyPreset('DeepSeek', 'https://api.deepseek.com')">DeepSeek</button>
        <button class="preset-btn" onclick="applyPreset('Groq', 'https://api.groq.com/openai/v1')">Groq</button>
        <button class="preset-btn" onclick="applyPreset('Together', 'https://api.together.xyz/v1')">Together AI</button>
        <button class="preset-btn" onclick="applyPreset('Mistral', 'https://api.mistral.ai/v1')">Mistral AI</button>
        <button class="preset-btn" onclick="applyPreset('GitHub Models', 'https://models.inference.ai.azure.com')">GitHub Models</button>
        <button class="preset-btn" onclick="applyPreset('LocalAI', 'http://localhost:8080/v1')">LocalAI</button>
      </div>
      <div id="provList"></div>
      <div style="display: flex; gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap;">
        <button onclick="saveProviders()"><i class="codicon codicon-save"></i> Save All Provider Changes</button>
        <button class="sec" onclick="exportConfig()"><i class="codicon codicon-export"></i> Export Config</button>
        <button class="sec" onclick="importConfig()"><i class="codicon codicon-cloud-upload"></i> Import Config</button>
      </div>
    </div>

    <!-- TAB: MODELS -->
    <div id="tab-models" class="panel active">
      <div class="models-sticky-toolbar">
        <div class="actions-bar">
          <div style="display: flex; gap: 8px; align-items: center; flex: 1; max-width: 650px;">
            <div class="search-wrap">
              <i class="codicon codicon-search search-icon"></i>
              <input type="text" id="mSearch" placeholder="Search model ID or name..." oninput="filterModels()">
              <span id="clearSearchBtn" class="clear-btn" onclick="clearSearch()" style="display: none;" title="Clear search">✕</span>
            </div>
            <select id="provFilter" class="prov-select" onchange="filterModels()" title="Filter by provider">
              <option value="">All Providers</option>
            </select>
            <select id="statusFilter" class="prov-select" onchange="onStatusFilterChange()" title="Filter by health / verification status">
              <option value="working" id="opt-status-working" selected>✓ Verified Working</option>
              <option value="all" id="opt-status-all">All Statuses</option>
              <option value="failed" id="opt-status-failed">✕ Offline / Failed</option>
            </select>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button class="sec" onclick="runVisibleBatchTest()"><i class="codicon codicon-filter"></i> Test Filtered (<span id="btnVisibleCount">0</span>)</button>
            <button onclick="runBatchTest(false)"><i class="codicon codicon-zap"></i> Test All (Concurrent)</button>
            <button class="sec" onclick="runBatchTest(true)"><i class="codicon codicon-sync"></i> Force Retest</button>
          </div>
        </div>

        <!-- Live Test Progress Banner -->
        <div id="liveProgressBar" style="display:none; margin: 6px 0 10px 0; background: var(--card); border: 1px solid var(--border); padding: 10px 14px; border-radius: 6px;">
          <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:6px;">
            <span id="liveProgressText" style="font-weight:500;">Running model benchmarks...</span>
            <span id="liveProgressPercent" style="opacity:0.8;">0%</span>
          </div>
          <div style="background:rgba(255,255,255,0.08); border-radius:4px; height:6px; overflow:hidden;">
            <div id="liveProgressFill" style="background:var(--btn-bg); height:100%; width:0%; transition:width 0.2s;"></div>
          </div>
        </div>

        <!-- Filter Chips -->
        <div class="filter-chips">
          <span class="filter-label"><i class="codicon codicon-tag"></i> Capability:</span>
          <button class="chip active" id="chip-cat-all" onclick="setCapabilityFilter('all')"><i class="codicon codicon-sparkle"></i> All <span class="chip-count" id="cAll">0</span></button>
          <button class="chip" id="chip-cat-coding" onclick="setCapabilityFilter('coding')"><i class="codicon codicon-code" style="color:#4fc1ff;"></i> Coding <span class="chip-count" id="cCoding">0</span></button>
          <button class="chip" id="chip-cat-reasoning" onclick="setCapabilityFilter('reasoning')"><i class="codicon codicon-lightbulb" style="color:#d2a8ff;"></i> Reasoning <span class="chip-count" id="cReasoning">0</span></button>
          <button class="chip" id="chip-cat-vision" onclick="setCapabilityFilter('vision')"><i class="codicon codicon-eye" style="color:#f59e0b;"></i> Vision <span class="chip-count" id="cVision">0</span></button>

          <div class="v-sep"></div>

          <span class="filter-label"><i class="codicon codicon-filter"></i> Filters:</span>
          <button class="chip" id="chip-fast" onclick="toggleFastFilter()" title="Show models with latency < 500ms"><i class="codicon codicon-zap" style="color:#eab308;"></i> Fast &lt;500ms <span class="chip-count" id="cFast">0</span></button>
          <button class="chip" id="chip-selected" onclick="toggleCopilotFilter()" title="Show models currently enabled for Copilot"><i class="codicon codicon-copilot" style="color:#4fc1ff;"></i> In Copilot <span class="chip-count" id="cSelected">0</span></button>
          <button class="chip sec" id="clearFiltersBtn" onclick="clearAllFilters()" style="display: none; border-color: rgba(255,255,255,0.2);" title="Reset all search and filter options"><i class="codicon codicon-clear-all"></i> Reset Filters</button>
        </div>

        <!-- Copilot Setup & Action Bar -->
        <div class="selection-bar">
          <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
            <span style="font-weight: 500; font-size: 11px; margin-right: 4px; display: inline-flex; align-items: center; gap: 4px;">
              <i class="codicon codicon-copilot" style="font-size:13px; color:#4fc1ff;"></i> Copilot Setup:
            </span>
            <button class="sec tool-btn" onclick="enableAllWorking()" title="Enable all verified working models for Copilot"><i class="codicon codicon-pass-filled" style="color:var(--success);"></i> Enable All Working</button>
            <button class="sec tool-btn" onclick="enableOnlyWorkingCoding()" title="Enable only verified coding models for Copilot"><i class="codicon codicon-code" style="color:#4fc1ff;"></i> Enable Only Coding</button>
            <div class="v-sep"></div>
            <button class="sec tool-btn" onclick="selectOnlyVisible()" title="Enable only models currently shown in the table above and disable the rest"><i class="codicon codicon-check-all" style="color:#4fc1ff;"></i> Enable Only Filtered</button>
            <button class="sec tool-btn" onclick="selectVisible(true)" title="Add all currently visible models to Copilot"><i class="codicon codicon-check"></i> Enable Filtered</button>
            <button class="sec tool-btn" onclick="selectVisible(false)" title="Remove all currently visible models from Copilot"><i class="codicon codicon-circle-slash"></i> Disable Filtered</button>
            <button class="sec tool-btn" onclick="disableAll()" title="Disable all models from Copilot"><i class="codicon codicon-clear-all"></i> Disable All</button>
          </div>
          <span class="selection-badge" id="selectionSummary">0 models active in Copilot</span>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 38px; text-align: center;">
                <input type="checkbox" id="selectAllBox" onchange="toggleSelectAllBox(this.checked)" title="Toggle Selection for Visible Models">
              </th>
              <th style="width: 190px;" onclick="sortBy('id')" title="Click to sort by Model ID">
                Model ID <span id="sort-id" class="sort-icon"></span>
              </th>
              <th onclick="sortBy('name')" title="Click to sort by Display Name">
                Display Name <span id="sort-name" class="sort-icon"></span>
              </th>
              <th style="width: 105px;" onclick="sortBy('provider')" title="Click to sort by Provider">
                Provider <span id="sort-provider" class="sort-icon"></span>
              </th>
              <th style="width: 145px;">Capabilities</th>
              <th style="width: 95px;" onclick="sortBy('contextWindow')" title="Click to sort by Context Window">
                Limits <span id="sort-contextWindow" class="sort-icon"></span>
              </th>
              <th style="width: 130px;" onclick="sortBy('latency')" title="Click to sort by Latency / Speed">
                Verification <span id="sort-latency" class="sort-icon"></span>
              </th>
              <th style="width: 125px;">Action</th>
            </tr>
          </thead>
          <tbody id="modelsBody"></tbody>
        </table>
      </div>
    </div>

    <!-- TAB: CACHE -->
    <div id="tab-cache" class="panel">
      <div class="card" style="display: flex; flex-direction: column; flex: 1; min-height: 0; margin-bottom: 0;">
        <div class="card-head" style="flex-shrink: 0;">
          <div>
            <strong>Verified Working Models Cache (48h TTL)</strong>
            <div style="font-size:11px; opacity:0.8; margin-top:2px;">Keeps test results and latencies in cache so VS Code doesn't re-test models repeatedly.</div>
          </div>
          <div>
            <button class="danger" onclick="clearCache()"><i class="codicon codicon-trash"></i> Clear Cache</button>
          </div>
        </div>
        <div class="table-container" style="margin-top: 6px;">
          <table>
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
    </div>
  </main>

  <script>
    const vscode = acquireVsCodeApi();
    let providers = [];
    let activeModels = [];
    let cacheEntries = [];
    let disabledSet = new Set();
    let activeFilterCategory = "all";
    let currentSortCol = null;
    let currentSortAsc = true;

    let activeTabName = 'models';

    window.addEventListener('message', ev => {
      const msg = ev.data;
      if (msg.cmd === 'state') {
        providers = msg.providers || [];
        activeModels = msg.models || [];
        cacheEntries = msg.cacheEntries || [];
        disabledSet = new Set(msg.disabledModels || []);
        renderProviders();
        populateProviderFilter();
        applySort();
        renderModels();
        renderCache();
        setTab(activeTabName);
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
      activeTabName = name;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      const tabEl = el || document.getElementById('tab-btn-' + name);
      if (tabEl) tabEl.classList.add('active');
      const panelEl = document.getElementById('tab-' + name);
      if (panelEl) panelEl.classList.add('active');
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

    let activeCapability = 'all';
    let activeFastOnly = false;
    let activeCopilotOnly = false;

    function setCapabilityFilter(cat) {
      activeCapability = cat;
      ['all', 'coding', 'reasoning', 'vision'].forEach(c => {
        const chip = document.getElementById('chip-cat-' + c);
        if (chip) chip.classList.toggle('active', c === cat);
      });
      filterModels();
    }
    const setFilterCategory = setCapabilityFilter;

    function toggleFastFilter() {
      activeFastOnly = !activeFastOnly;
      const chip = document.getElementById('chip-fast');
      if (chip) chip.classList.toggle('active', activeFastOnly);
      filterModels();
    }

    function toggleCopilotFilter() {
      activeCopilotOnly = !activeCopilotOnly;
      const chip = document.getElementById('chip-selected');
      if (chip) chip.classList.toggle('active', activeCopilotOnly);
      filterModels();
    }

    function onStatusFilterChange() {
      filterModels();
    }

    function clearAllFilters() {
      activeCapability = 'all';
      activeFastOnly = false;
      activeCopilotOnly = false;
      const search = document.getElementById('mSearch');
      if (search) search.value = '';
      const prov = document.getElementById('provFilter');
      if (prov) prov.value = '';
      const status = document.getElementById('statusFilter');
      if (status) status.value = 'working';

      ['all', 'coding', 'reasoning', 'vision'].forEach(c => {
        const chip = document.getElementById('chip-cat-' + c);
        if (chip) chip.classList.toggle('active', c === 'all');
      });
      const chipFast = document.getElementById('chip-fast');
      if (chipFast) chipFast.classList.remove('active');
      const chipCopilot = document.getElementById('chip-selected');
      if (chipCopilot) chipCopilot.classList.remove('active');

      filterModels();
    }

    function disableAll() {
      activeModels.forEach(m => {
        const key = m.provider + '::' + m.id;
        disabledSet.add(key);
        disabledSet.add(m.id);
        m.disabled = true;
      });
      saveDisabled();
      renderModels();
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
      const row = document.querySelector('.m-row[data-idx="' + idx + '"]');
      if (row) {
        row.setAttribute('data-selected', (!m.disabled && m._verifiedWorking === true) ? 'true' : 'false');
      }
      saveDisabled();
      updateCounts();
      updateSelectAllBox();
    }

    function enableAllWorking() {
      activeModels.forEach(m => {
        const key = m.provider + '::' + m.id;
        if (m._verifiedWorking === true) {
          disabledSet.delete(key);
          disabledSet.delete(m.id);
          m.disabled = false;
        } else {
          disabledSet.add(key);
          m.disabled = true;
        }
      });
      saveDisabled();
      renderModels();
    }

    function enableOnlyWorkingCoding() {
      activeModels.forEach(m => {
        const key = m.provider + '::' + m.id;
        if (m._verifiedWorking === true && m.isCoding) {
          disabledSet.delete(key);
          disabledSet.delete(m.id);
          m.disabled = false;
        } else {
          disabledSet.add(key);
          m.disabled = true;
        }
      });
      saveDisabled();
      renderModels();
    }

    function enableOnlyFastWorking() {
      activeModels.forEach(m => {
        const key = m.provider + '::' + m.id;
        if (m._verifiedWorking === true && (m._latency || 9999) < 500) {
          disabledSet.delete(key);
          disabledSet.delete(m.id);
          m.disabled = false;
        } else {
          disabledSet.add(key);
          m.disabled = true;
        }
      });
      saveDisabled();
      renderModels();
    }

    function selectOnlyVisible() {
      const visibleWorkingKeys = new Set();
      document.querySelectorAll('.m-row').forEach(row => {
        if (row.style.display !== 'none') {
          const idx = parseInt(row.getAttribute('data-idx'), 10);
          const m = activeModels[idx];
          if (m && m._verifiedWorking !== false) {
            visibleWorkingKeys.add(m.provider + '::' + m.id);
            visibleWorkingKeys.add(m.id);
          }
        }
      });
      activeModels.forEach(m => {
        const key = m.provider + '::' + m.id;
        if (visibleWorkingKeys.has(key) || visibleWorkingKeys.has(m.id)) {
          disabledSet.delete(key);
          disabledSet.delete(m.id);
          m.disabled = false;
        } else {
          disabledSet.add(key);
          m.disabled = true;
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
              if (m._verifiedWorking !== false) {
                disabledSet.delete(key);
                disabledSet.delete(m.id);
                m.disabled = false;
              }
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

    function updateSelectAllBox() {
      const box = document.getElementById('selectAllBox');
      if (!box) return;
      const visibleRows = Array.from(document.querySelectorAll('.m-row')).filter(r => r.style.display !== 'none');
      if (visibleRows.length === 0) {
        box.checked = false;
        box.indeterminate = false;
        return;
      }
      let eligibleCount = 0;
      let enabledCount = 0;
      visibleRows.forEach(r => {
        const idx = parseInt(r.getAttribute('data-idx'), 10);
        const m = activeModels[idx];
        if (m) {
          if (m._verifiedWorking !== false) eligibleCount++;
          if (!m.disabled && m._verifiedWorking !== false) enabledCount++;
        }
      });
      if (enabledCount === 0) {
        box.checked = false;
        box.indeterminate = false;
      } else if (eligibleCount > 0 && enabledCount === eligibleCount) {
        box.checked = true;
        box.indeterminate = false;
      } else {
        box.checked = false;
        box.indeterminate = true;
      }
    }

    function saveDisabled() {
      vscode.postMessage({ cmd: 'saveDisabledModels', disabledModels: Array.from(disabledSet) });
    }

    function updateCounts() {
      const allCount = activeModels.length;
      const statusVal = document.getElementById('statusFilter')?.value || 'working';

      const eligibleForCounts = activeModels.filter(m => {
        if (statusVal === 'working') return m._verifiedWorking === true;
        if (statusVal === 'failed') return m._verifiedWorking === false;
        return true;
      });

      const codingCount = eligibleForCounts.filter(m => m.isCoding).length;
      const reasoningCount = eligibleForCounts.filter(m => m.isReasoning).length;
      const visionCount = eligibleForCounts.filter(m => m.vision).length;
      const fastCount = eligibleForCounts.filter(m => (m._latency || 9999) < 500).length;
      const workingCount = activeModels.filter(m => m._verifiedWorking === true).length;
      const failedCount = activeModels.filter(m => m._verifiedWorking === false).length;
      const selectedCount = activeModels.filter(m => !m.disabled && m._verifiedWorking === true).length;
      const eligibleSelectedCount = eligibleForCounts.filter(m => !m.disabled).length;

      const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
      setTxt('mCount', allCount);
      setTxt('cAll', eligibleForCounts.length);
      setTxt('cCoding', codingCount);
      setTxt('cFast', fastCount);
      setTxt('cReasoning', reasoningCount);
      setTxt('cVision', visionCount);
      setTxt('cSelected', eligibleSelectedCount);

      // Status dropdown text update
      const statusOptWorking = document.getElementById('opt-status-working');
      if (statusOptWorking) statusOptWorking.innerText = '✓ Verified Working (' + workingCount + ')';
      const statusOptAll = document.getElementById('opt-status-all');
      if (statusOptAll) statusOptAll.innerText = 'All Statuses (' + allCount + ')';
      const statusOptFailed = document.getElementById('opt-status-failed');
      if (statusOptFailed) statusOptFailed.innerText = '✕ Offline / Failed (' + failedCount + ')';

      const visibleRows = Array.from(document.querySelectorAll('.m-row')).filter(r => r.style.display !== 'none');
      let visibleSelected = 0;
      let visibleWorking = 0;
      visibleRows.forEach(r => {
        const idx = parseInt(r.getAttribute('data-idx'), 10);
        const m = activeModels[idx];
        if (m && m._verifiedWorking === true) {
          visibleWorking++;
          if (!m.disabled) visibleSelected++;
        }
      });

      const summary = document.getElementById('selectionSummary');
      if (summary) {
        if (visibleRows.length < activeModels.length) {
          summary.innerText = visibleSelected + ' of ' + visibleWorking + ' visible selected • ' + selectedCount + ' of ' + workingCount + ' active in Copilot';
        } else {
          summary.innerText = selectedCount + ' of ' + workingCount + ' working models active in Copilot';
        }
      }
      updateSelectAllBox();
    }

    function sortBy(col) {
      if (currentSortCol === col) {
        currentSortAsc = !currentSortAsc;
      } else {
        currentSortCol = col;
        currentSortAsc = true;
      }
      applySort();
      renderModels();
    }

    function applySort() {
      if (!currentSortCol) return;
      activeModels.sort((a, b) => {
        let valA, valB;
        if (currentSortCol === 'id') {
          valA = a.id.toLowerCase();
          valB = b.id.toLowerCase();
        } else if (currentSortCol === 'name') {
          valA = (a.name || a.id).toLowerCase();
          valB = (b.name || b.id).toLowerCase();
        } else if (currentSortCol === 'provider') {
          valA = (a.provider || '').toLowerCase();
          valB = (b.provider || '').toLowerCase();
        } else if (currentSortCol === 'contextWindow') {
          valA = a.contextWindow || a.maxInputTokens || 0;
          valB = b.contextWindow || b.maxInputTokens || 0;
        } else if (currentSortCol === 'latency') {
          valA = a._verifiedWorking === true ? (a._latency || 0) : 9999999;
          valB = b._verifiedWorking === true ? (b._latency || 0) : 9999999;
        }
        if (valA < valB) return currentSortAsc ? -1 : 1;
        if (valA > valB) return currentSortAsc ? 1 : -1;
        return 0;
      });
      updateSortIcons();
    }

    function updateSortIcons() {
      ['id', 'name', 'provider', 'contextWindow', 'latency'].forEach(col => {
        const el = document.getElementById('sort-' + col);
        if (el) {
          if (currentSortCol === col) {
            el.innerHTML = currentSortAsc
              ? '<i class="codicon codicon-arrow-up" style="font-size:10px; margin-left:2px;"></i>'
              : '<i class="codicon codicon-arrow-down" style="font-size:10px; margin-left:2px;"></i>';
          } else {
            el.innerHTML = '';
          }
        }
      });
    }

    function clearSearch() {
      const inp = document.getElementById('mSearch');
      if (inp) inp.value = '';
      filterModels();
    }

    function populateProviderFilter() {
      const sel = document.getElementById('provFilter');
      if (!sel) return;
      const cur = sel.value;
      const provs = Array.from(new Set(activeModels.map(m => m.provider).filter(Boolean))).sort();
      sel.innerHTML = '<option value="">All Providers (' + provs.length + ')</option>' +
        provs.map(p => '<option value="' + p + '" ' + (cur === p ? 'selected' : '') + '>' + p + '</option>').join('');
    }

    function runVisibleBatchTest() {
      const visible = [];
      document.querySelectorAll('.m-row').forEach(row => {
        if (row.style.display !== 'none') {
          const idx = parseInt(row.getAttribute('data-idx'), 10);
          const m = activeModels[idx];
          if (m) {
            visible.push({ providerName: m.provider, modelId: m.id });
          }
        }
      });
      if (visible.length === 0) return;
      vscode.postMessage({ cmd: 'testSpecificModels', models: visible, force: true });
    }

    function renderModels() {
      updateCounts();
      updateSortIcons();
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

        let verifyBadge = '<span class="status-badge untested"><i class="codicon codicon-circle-outline"></i> Untested</span>';
        if (m._verifiedWorking === true) {
          verifyBadge = '<span class="status-badge ok"><i class="codicon codicon-check"></i> ' + (m._latency || 0) + 'ms</span>';
        } else if (m._verifiedWorking === false) {
          const errHint = m._error ? ' - ' + m._error.replace(/"/g, '&quot;') : '';
          verifyBadge = '<span class="status-badge err" title="Failed' + errHint + '"><i class="codicon codicon-close"></i> Offline</span>';
        }

        const caps = [
          m.isCoding ? '<span class="cap-badge code"><i class="codicon codicon-code"></i>Coding</span>' : '',
          m.isReasoning ? '<span class="cap-badge reasoning"><i class="codicon codicon-lightbulb"></i>Reasoning</span>' : '',
          m.vision ? '<span class="cap-badge vision"><i class="codicon codicon-eye"></i>Vision</span>' : '',
          m.toolCalling ? '<span class="cap-badge tools"><i class="codicon codicon-tools"></i>Tools</span>' : '',
        ].filter(Boolean).join('');

        const isFailed = m._verifiedWorking === false;
        const isFast = m._verifiedWorking === true && (m._latency || 9999) < 500;
        const errDisplay = isFailed && m._error ? '<div class="model-err" title="' + m._error.replace(/"/g, '&quot;') + '">' + m._error.slice(0, 85) + '</div>' : '';

        return '<tr class="m-row" data-idx="' + mIdx + '" data-s="' + (m.id + ' ' + (m.name || '')).toLowerCase() + '" ' +
          'data-prov="' + (m.provider || '').toLowerCase() + '" ' +
          'data-coding="' + (m.isCoding ? 'true' : 'false') + '" ' +
          'data-reasoning="' + (m.isReasoning ? 'true' : 'false') + '" ' +
          'data-vision="' + (m.vision ? 'true' : 'false') + '" ' +
          'data-working="' + (m._verifiedWorking === true ? 'true' : 'false') + '" ' +
          'data-failed="' + (isFailed ? 'true' : 'false') + '" ' +
          'data-fast="' + (isFast ? 'true' : 'false') + '" ' +
          'data-selected="' + (isChecked && m._verifiedWorking === true ? 'true' : 'false') + '">' +
          '<td style="text-align: center;"><input type="checkbox" ' + (isChecked ? 'checked' : '') + ' onchange="toggleModelSelection(' + mIdx + ', this.checked)" title="' + (isChecked ? 'Active in Copilot' : 'Disabled from Copilot') + '"></td>' +
          '<td><code class="model-id" title="' + m.id + '">' + m.id + '</code></td>' +
          '<td><div class="model-name" title="' + (m.name || m.id) + '">' + (m.name || m.id) + '</div>' + errDisplay + '</td>' +
          '<td><span class="provider-badge">' + m.provider + '</span></td>' +
          '<td><div class="caps-container">' + (caps || '<span style="opacity:0.35;">—</span>') + '</div></td>' +
          '<td><span class="limits-text" title="Input: ' + inK + 'k / Max Output: ' + outK + 'k">' + inK + 'k <span class="limits-sep">/</span> ' + outK + 'k</span></td>' +
          '<td>' + verifyBadge + '</td>' +
          '<td>' +
            '<div class="action-cell">' +
              '<button class="sec ping-btn" onclick="pingModelByIdx(' + mIdx + ')" title="Ping model and test tool calling"><i class="codicon codicon-pulse"></i> Ping</button>' +
              '<span id="ping-' + safe + '" class="ping-status"></span>' +
            '</div>' +
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
      const q = (document.getElementById('mSearch')?.value || '').toLowerCase().trim();
      const selProv = (document.getElementById('provFilter')?.value || '').toLowerCase();
      const statusVal = document.getElementById('statusFilter')?.value || 'working';
      const clearBtn = document.getElementById('clearSearchBtn');
      if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';

      // Show reset button if any non-default filters are active
      const hasCustom = Boolean(
        q || selProv || statusVal !== 'working' || activeCapability !== 'all' || activeFastOnly || activeCopilotOnly
      );
      const clearFiltersBtn = document.getElementById('clearFiltersBtn');
      if (clearFiltersBtn) clearFiltersBtn.style.display = hasCustom ? 'inline-flex' : 'none';

      let visibleCount = 0;
      document.querySelectorAll('.m-row').forEach(r => {
        const s = r.getAttribute('data-s') || '';
        const prov = r.getAttribute('data-prov') || '';
        const isCoding = r.getAttribute('data-coding') === 'true';
        const isReasoning = r.getAttribute('data-reasoning') === 'true';
        const isVision = r.getAttribute('data-vision') === 'true';
        const isWorking = r.getAttribute('data-working') === 'true';
        const isFailed = r.getAttribute('data-failed') === 'true';
        const isFast = r.getAttribute('data-fast') === 'true';
        const isSelected = r.getAttribute('data-selected') === 'true';

        // 1. Text Search (ID or Name)
        const matchSearch = !q || s.includes(q);

        // 2. Provider dropdown
        const matchProv = !selProv || prov === selProv;

        // 3. Status filter ('working' | 'all' | 'failed')
        let matchStatus = true;
        if (statusVal === 'working') matchStatus = isWorking;
        else if (statusVal === 'failed') matchStatus = isFailed;

        // 4. Capability ('all' | 'coding' | 'reasoning' | 'vision')
        let matchCap = true;
        if (activeCapability === 'coding') matchCap = isCoding;
        else if (activeCapability === 'reasoning') matchCap = isReasoning;
        else if (activeCapability === 'vision') matchCap = isVision;

        // 5. Fast modifier
        const matchFast = !activeFastOnly || isFast;

        // 6. Copilot modifier
        const matchCopilot = !activeCopilotOnly || isSelected;

        const isVisible = matchSearch && matchProv && matchStatus && matchCap && matchFast && matchCopilot;
        r.style.display = isVisible ? '' : 'none';
        if (isVisible) visibleCount++;
      });

      const btnVisibleCount = document.getElementById('btnVisibleCount');
      if (btnVisibleCount) btnVisibleCount.innerText = visibleCount;
      updateCounts();
      updateSelectAllBox();
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

    function exportConfig() {
      vscode.postMessage({ cmd: 'exportConfig' });
    }

    function importConfig() {
      vscode.postMessage({ cmd: 'importConfig' });
    }

    function syncNow() {
      vscode.postMessage({ cmd: 'syncNow' });
    }
  </script>
</body>
</html>`;
  }
}
