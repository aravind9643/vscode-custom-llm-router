import * as vscode from "vscode";
import { ModelEngine, CustomProviderConfig, VSCodeModel } from "./modelEngine";

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
      padding: 7px 10px;
      border-radius: 4px;
      font-size: 12px;
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
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: background 0.15s ease;
    }
    button:hover { background: var(--btn-hover); }
    button.sec {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }
    button.sec:hover { background: rgba(255, 255, 255, 0.08); }
    button.danger { background: var(--error); }

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

    /* Filter Chips */
    .filter-chips {
      display: flex;
      gap: 6px;
      margin: 4px 0 8px 0;
      flex-wrap: wrap;
      align-items: center;
    }
    .chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: rgba(255, 255, 255, 0.8);
      padding: 4px 11px;
      border-radius: 14px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
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

    /* Selection Bar */
    .selection-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 7px 12px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 12px;
    }
    .selection-badge {
      font-size: 11px;
      background: rgba(115, 201, 145, 0.15);
      color: var(--success);
      border: 1px solid rgba(115, 201, 145, 0.3);
      padding: 2px 10px;
      border-radius: 12px;
      font-weight: 500;
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
    }
    /* Fixed Sticky Table Header: Stays locked at top of table container */
    th {
      position: sticky;
      top: 0;
      z-index: 25;
      background: #252526;
      padding: 10px 12px;
      border-bottom: 2px solid var(--border);
      box-shadow: 0 2px 4px rgba(0,0,0,0.25);
      font-weight: 600;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.7);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      white-space: nowrap;
    }
    td {
      padding: 9px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      vertical-align: middle;
    }
    tr.m-row { transition: background 0.12s ease; }
    tr.m-row:hover { background: rgba(255, 255, 255, 0.035); }
    tr.m-row.is-active { background: rgba(14, 99, 156, 0.04); }

    /* Badges & Tags */
    .tag {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      margin-right: 4px;
      font-weight: 500;
      display: inline-block;
      white-space: nowrap;
    }
    .tag.green { background: rgba(115, 201, 145, 0.18); color: var(--success); }
    .tag.red { background: rgba(241, 76, 76, 0.18); color: var(--error); }
    .model-cat { font-size: 10px; padding: 2px 7px; border-radius: 10px; font-weight: 500; margin-right: 4px; display: inline-block; white-space: nowrap; }
    .model-cat.code { background: rgba(55, 148, 255, 0.15); color: #4fc1ff; border: 1px solid rgba(55, 148, 255, 0.3); }
    .model-cat.reasoning { background: rgba(191, 122, 240, 0.15); color: #d2a8ff; border: 1px solid rgba(191, 122, 240, 0.3); }
    .model-cat.vision { background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); }

    /* Action Cell & Truncated Status */
    .action-cell { display: flex; align-items: center; gap: 8px; }
    .ping-status {
      font-size: 11px;
      max-width: 170px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: inline-block;
    }

    /* Presets Bar */
    .presets-bar { display: flex; gap: 6px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
    .preset-btn { background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border); font-size: 11px; padding: 4px 8px; border-radius: 4px; color: var(--fg); cursor: pointer; }
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
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

@font-face {
	font-family: "codicon";
	font-display: block;
	src: url("./codicon.ttf?9aab6318a6710999273bab9c78a9fd71") format("truetype");
}

.codicon[class*='codicon-'] {
	font: normal normal normal 16px/1 codicon;
	display: inline-block;
	text-decoration: none;
	text-rendering: auto;
	text-align: center;
	-webkit-font-smoothing: antialiased;
	-moz-osx-font-smoothing: grayscale;
	user-select: none;
	-webkit-user-select: none;
	-ms-user-select: none;
}

/*---------------------
 *  Modifiers
 *-------------------*/

@keyframes codicon-spin {
	100% {
		transform:rotate(360deg);
	}
}

.codicon-sync.codicon-modifier-spin,
.codicon-loading.codicon-modifier-spin,
.codicon-gear.codicon-modifier-spin {
	/* Use steps to throttle FPS to reduce CPU usage */
	animation: codicon-spin 1.5s steps(30) infinite;
}

.codicon-modifier-disabled {
	opacity: 0.5;
}

.codicon-modifier-hidden {
	opacity: 0;
}

/* custom speed & easing for loading icon */
.codicon-loading {
	animation-duration: 1s !important;
	animation-timing-function: cubic-bezier(0.53, 0.21, 0.29, 0.67) !important;
}

/*---------------------
 *  Icons
 *-------------------*/

.codicon-add:before { content: "\ea60" }
.codicon-plus:before { content: "\ea60" }
.codicon-gist-new:before { content: "\ea60" }
.codicon-repo-create:before { content: "\ea60" }
.codicon-lightbulb:before { content: "\ea61" }
.codicon-light-bulb:before { content: "\ea61" }
.codicon-repo:before { content: "\ea62" }
.codicon-repo-delete:before { content: "\ea62" }
.codicon-gist-fork:before { content: "\ea63" }
.codicon-repo-forked:before { content: "\ea63" }
.codicon-git-pull-request:before { content: "\ea64" }
.codicon-git-pull-request-abandoned:before { content: "\ea64" }
.codicon-record-keys:before { content: "\ea65" }
.codicon-keyboard:before { content: "\ea65" }
.codicon-tag:before { content: "\ea66" }
.codicon-git-pull-request-label:before { content: "\ea66" }
.codicon-tag-add:before { content: "\ea66" }
.codicon-tag-remove:before { content: "\ea66" }
.codicon-person:before { content: "\ea67" }
.codicon-person-follow:before { content: "\ea67" }
.codicon-person-outline:before { content: "\ea67" }
.codicon-person-filled:before { content: "\ea67" }
.codicon-source-control:before { content: "\ea68" }
.codicon-mirror:before { content: "\ea69" }
.codicon-mirror-public:before { content: "\ea69" }
.codicon-star:before { content: "\ea6a" }
.codicon-star-add:before { content: "\ea6a" }
.codicon-star-delete:before { content: "\ea6a" }
.codicon-star-empty:before { content: "\ea6a" }
.codicon-comment:before { content: "\ea6b" }
.codicon-comment-add:before { content: "\ea6b" }
.codicon-alert:before { content: "\ea6c" }
.codicon-warning:before { content: "\ea6c" }
.codicon-search:before { content: "\ea6d" }
.codicon-search-save:before { content: "\ea6d" }
.codicon-log-out:before { content: "\ea6e" }
.codicon-sign-out:before { content: "\ea6e" }
.codicon-log-in:before { content: "\ea6f" }
.codicon-sign-in:before { content: "\ea6f" }
.codicon-eye:before { content: "\ea70" }
.codicon-eye-unwatch:before { content: "\ea70" }
.codicon-eye-watch:before { content: "\ea70" }
.codicon-circle-filled:before { content: "\ea71" }
.codicon-primitive-dot:before { content: "\ea71" }
.codicon-close-dirty:before { content: "\ea71" }
.codicon-debug-breakpoint:before { content: "\ea71" }
.codicon-debug-breakpoint-disabled:before { content: "\ea71" }
.codicon-debug-hint:before { content: "\ea71" }
.codicon-terminal-decoration-success:before { content: "\ea71" }
.codicon-primitive-square:before { content: "\ea72" }
.codicon-edit:before { content: "\ea73" }
.codicon-pencil:before { content: "\ea73" }
.codicon-info:before { content: "\ea74" }
.codicon-issue-opened:before { content: "\ea74" }
.codicon-gist-private:before { content: "\ea75" }
.codicon-git-fork-private:before { content: "\ea75" }
.codicon-lock:before { content: "\ea75" }
.codicon-mirror-private:before { content: "\ea75" }
.codicon-close:before { content: "\ea76" }
.codicon-remove-close:before { content: "\ea76" }
.codicon-x:before { content: "\ea76" }
.codicon-repo-sync:before { content: "\ea77" }
.codicon-sync:before { content: "\ea77" }
.codicon-clone:before { content: "\ea78" }
.codicon-desktop-download:before { content: "\ea78" }
.codicon-beaker:before { content: "\ea79" }
.codicon-microscope:before { content: "\ea79" }
.codicon-vm:before { content: "\ea7a" }
.codicon-device-desktop:before { content: "\ea7a" }
.codicon-file:before { content: "\ea7b" }
.codicon-more:before { content: "\ea7c" }
.codicon-ellipsis:before { content: "\ea7c" }
.codicon-kebab-horizontal:before { content: "\ea7c" }
.codicon-mail-reply:before { content: "\ea7d" }
.codicon-reply:before { content: "\ea7d" }
.codicon-organization:before { content: "\ea7e" }
.codicon-organization-filled:before { content: "\ea7e" }
.codicon-organization-outline:before { content: "\ea7e" }
.codicon-new-file:before { content: "\ea7f" }
.codicon-file-add:before { content: "\ea7f" }
.codicon-new-folder:before { content: "\ea80" }
.codicon-file-directory-create:before { content: "\ea80" }
.codicon-trash:before { content: "\ea81" }
.codicon-trashcan:before { content: "\ea81" }
.codicon-history:before { content: "\ea82" }
.codicon-clock:before { content: "\ea82" }
.codicon-folder:before { content: "\ea83" }
.codicon-file-directory:before { content: "\ea83" }
.codicon-symbol-folder:before { content: "\ea83" }
.codicon-logo-github:before { content: "\ea84" }
.codicon-mark-github:before { content: "\ea84" }
.codicon-github:before { content: "\ea84" }
.codicon-terminal:before { content: "\ea85" }
.codicon-console:before { content: "\ea85" }
.codicon-repl:before { content: "\ea85" }
.codicon-zap:before { content: "\ea86" }
.codicon-symbol-event:before { content: "\ea86" }
.codicon-error:before { content: "\ea87" }
.codicon-stop:before { content: "\ea87" }
.codicon-variable:before { content: "\ea88" }
.codicon-symbol-variable:before { content: "\ea88" }
.codicon-array:before { content: "\ea8a" }
.codicon-symbol-array:before { content: "\ea8a" }
.codicon-symbol-module:before { content: "\ea8b" }
.codicon-symbol-package:before { content: "\ea8b" }
.codicon-symbol-namespace:before { content: "\ea8b" }
.codicon-symbol-object:before { content: "\ea8b" }
.codicon-symbol-method:before { content: "\ea8c" }
.codicon-symbol-function:before { content: "\ea8c" }
.codicon-symbol-constructor:before { content: "\ea8c" }
.codicon-symbol-boolean:before { content: "\ea8f" }
.codicon-symbol-null:before { content: "\ea8f" }
.codicon-symbol-numeric:before { content: "\ea90" }
.codicon-symbol-number:before { content: "\ea90" }
.codicon-symbol-structure:before { content: "\ea91" }
.codicon-symbol-struct:before { content: "\ea91" }
.codicon-symbol-parameter:before { content: "\ea92" }
.codicon-symbol-type-parameter:before { content: "\ea92" }
.codicon-symbol-key:before { content: "\ea93" }
.codicon-symbol-text:before { content: "\ea93" }
.codicon-symbol-reference:before { content: "\ea94" }
.codicon-go-to-file:before { content: "\ea94" }
.codicon-symbol-enum:before { content: "\ea95" }
.codicon-symbol-value:before { content: "\ea95" }
.codicon-symbol-ruler:before { content: "\ea96" }
.codicon-symbol-unit:before { content: "\ea96" }
.codicon-activate-breakpoints:before { content: "\ea97" }
.codicon-archive:before { content: "\ea98" }
.codicon-arrow-both:before { content: "\ea99" }
.codicon-arrow-down:before { content: "\ea9a" }
.codicon-arrow-left:before { content: "\ea9b" }
.codicon-arrow-right:before { content: "\ea9c" }
.codicon-arrow-small-down:before { content: "\ea9d" }
.codicon-arrow-small-left:before { content: "\ea9e" }
.codicon-arrow-small-right:before { content: "\ea9f" }
.codicon-arrow-small-up:before { content: "\eaa0" }
.codicon-arrow-up:before { content: "\eaa1" }
.codicon-bell:before { content: "\eaa2" }
.codicon-bold:before { content: "\eaa3" }
.codicon-book:before { content: "\eaa4" }
.codicon-bookmark:before { content: "\eaa5" }
.codicon-debug-breakpoint-conditional-unverified:before { content: "\eaa6" }
.codicon-debug-breakpoint-conditional:before { content: "\eaa7" }
.codicon-debug-breakpoint-conditional-disabled:before { content: "\eaa7" }
.codicon-debug-breakpoint-data-unverified:before { content: "\eaa8" }
.codicon-debug-breakpoint-data:before { content: "\eaa9" }
.codicon-debug-breakpoint-data-disabled:before { content: "\eaa9" }
.codicon-debug-breakpoint-log-unverified:before { content: "\eaaa" }
.codicon-debug-breakpoint-log:before { content: "\eaab" }
.codicon-debug-breakpoint-log-disabled:before { content: "\eaab" }
.codicon-briefcase:before { content: "\eaac" }
.codicon-broadcast:before { content: "\eaad" }
.codicon-browser:before { content: "\eaae" }
.codicon-bug:before { content: "\eaaf" }
.codicon-calendar:before { content: "\eab0" }
.codicon-case-sensitive:before { content: "\eab1" }
.codicon-check:before { content: "\eab2" }
.codicon-checklist:before { content: "\eab3" }
.codicon-chevron-down:before { content: "\eab4" }
.codicon-chevron-left:before { content: "\eab5" }
.codicon-chevron-right:before { content: "\eab6" }
.codicon-chevron-up:before { content: "\eab7" }
.codicon-chrome-close:before { content: "\eab8" }
.codicon-chrome-maximize:before { content: "\eab9" }
.codicon-chrome-minimize:before { content: "\eaba" }
.codicon-chrome-restore:before { content: "\eabb" }
.codicon-circle-outline:before { content: "\eabc" }
.codicon-circle:before { content: "\eabc" }
.codicon-debug-breakpoint-unverified:before { content: "\eabc" }
.codicon-terminal-decoration-incomplete:before { content: "\eabc" }
.codicon-circle-slash:before { content: "\eabd" }
.codicon-circuit-board:before { content: "\eabe" }
.codicon-clear-all:before { content: "\eabf" }
.codicon-clippy:before { content: "\eac0" }
.codicon-close-all:before { content: "\eac1" }
.codicon-cloud-download:before { content: "\eac2" }
.codicon-cloud-upload:before { content: "\eac3" }
.codicon-code:before { content: "\eac4" }
.codicon-collapse-all:before { content: "\eac5" }
.codicon-color-mode:before { content: "\eac6" }
.codicon-comment-discussion:before { content: "\eac7" }
.codicon-credit-card:before { content: "\eac9" }
.codicon-dash:before { content: "\eacc" }
.codicon-dashboard:before { content: "\eacd" }
.codicon-database:before { content: "\eace" }
.codicon-debug-continue:before { content: "\eacf" }
.codicon-debug-disconnect:before { content: "\ead0" }
.codicon-debug-pause:before { content: "\ead1" }
.codicon-debug-restart:before { content: "\ead2" }
.codicon-debug-start:before { content: "\ead3" }
.codicon-debug-step-into:before { content: "\ead4" }
.codicon-debug-step-out:before { content: "\ead5" }
.codicon-debug-step-over:before { content: "\ead6" }
.codicon-debug-stop:before { content: "\ead7" }
.codicon-debug:before { content: "\ead8" }
.codicon-device-camera-video:before { content: "\ead9" }
.codicon-device-camera:before { content: "\eada" }
.codicon-device-mobile:before { content: "\eadb" }
.codicon-diff-added:before { content: "\eadc" }
.codicon-diff-ignored:before { content: "\eadd" }
.codicon-diff-modified:before { content: "\eade" }
.codicon-diff-removed:before { content: "\eadf" }
.codicon-diff-renamed:before { content: "\eae0" }
.codicon-diff:before { content: "\eae1" }
.codicon-diff-sidebyside:before { content: "\eae1" }
.codicon-discard:before { content: "\eae2" }
.codicon-editor-layout:before { content: "\eae3" }
.codicon-empty-window:before { content: "\eae4" }
.codicon-exclude:before { content: "\eae5" }
.codicon-extensions:before { content: "\eae6" }
.codicon-eye-closed:before { content: "\eae7" }
.codicon-file-binary:before { content: "\eae8" }
.codicon-file-code:before { content: "\eae9" }
.codicon-file-media:before { content: "\eaea" }
.codicon-file-pdf:before { content: "\eaeb" }
.codicon-file-submodule:before { content: "\eaec" }
.codicon-file-symlink-directory:before { content: "\eaed" }
.codicon-file-symlink-file:before { content: "\eaee" }
.codicon-file-zip:before { content: "\eaef" }
.codicon-files:before { content: "\eaf0" }
.codicon-filter:before { content: "\eaf1" }
.codicon-flame:before { content: "\eaf2" }
.codicon-fold-down:before { content: "\eaf3" }
.codicon-fold-up:before { content: "\eaf4" }
.codicon-fold:before { content: "\eaf5" }
.codicon-folder-active:before { content: "\eaf6" }
.codicon-folder-opened:before { content: "\eaf7" }
.codicon-gear:before { content: "\eaf8" }
.codicon-gift:before { content: "\eaf9" }
.codicon-gist-secret:before { content: "\eafa" }
.codicon-gist:before { content: "\eafb" }
.codicon-git-commit:before { content: "\eafc" }
.codicon-git-compare:before { content: "\eafd" }
.codicon-compare-changes:before { content: "\eafd" }
.codicon-git-merge:before { content: "\eafe" }
.codicon-github-action:before { content: "\eaff" }
.codicon-github-alt:before { content: "\eb00" }
.codicon-globe:before { content: "\eb01" }
.codicon-grabber:before { content: "\eb02" }
.codicon-graph:before { content: "\eb03" }
.codicon-gripper:before { content: "\eb04" }
.codicon-heart:before { content: "\eb05" }
.codicon-home:before { content: "\eb06" }
.codicon-horizontal-rule:before { content: "\eb07" }
.codicon-hubot:before { content: "\eb08" }
.codicon-inbox:before { content: "\eb09" }
.codicon-issue-reopened:before { content: "\eb0b" }
.codicon-issues:before { content: "\eb0c" }
.codicon-italic:before { content: "\eb0d" }
.codicon-jersey:before { content: "\eb0e" }
.codicon-json:before { content: "\eb0f" }
.codicon-bracket:before { content: "\eb0f" }
.codicon-kebab-vertical:before { content: "\eb10" }
.codicon-key:before { content: "\eb11" }
.codicon-law:before { content: "\eb12" }
.codicon-lightbulb-autofix:before { content: "\eb13" }
.codicon-link-external:before { content: "\eb14" }
.codicon-link:before { content: "\eb15" }
.codicon-list-ordered:before { content: "\eb16" }
.codicon-list-unordered:before { content: "\eb17" }
.codicon-live-share:before { content: "\eb18" }
.codicon-loading:before { content: "\eb19" }
.codicon-location:before { content: "\eb1a" }
.codicon-mail-read:before { content: "\eb1b" }
.codicon-mail:before { content: "\eb1c" }
.codicon-markdown:before { content: "\eb1d" }
.codicon-megaphone:before { content: "\eb1e" }
.codicon-mention:before { content: "\eb1f" }
.codicon-milestone:before { content: "\eb20" }
.codicon-git-pull-request-milestone:before { content: "\eb20" }
.codicon-mortar-board:before { content: "\eb21" }
.codicon-move:before { content: "\eb22" }
.codicon-multiple-windows:before { content: "\eb23" }
.codicon-mute:before { content: "\eb24" }
.codicon-no-newline:before { content: "\eb25" }
.codicon-note:before { content: "\eb26" }
.codicon-octoface:before { content: "\eb27" }
.codicon-open-preview:before { content: "\eb28" }
.codicon-package:before { content: "\eb29" }
.codicon-paintcan:before { content: "\eb2a" }
.codicon-pin:before { content: "\eb2b" }
.codicon-play:before { content: "\eb2c" }
.codicon-run:before { content: "\eb2c" }
.codicon-plug:before { content: "\eb2d" }
.codicon-preserve-case:before { content: "\eb2e" }
.codicon-preview:before { content: "\eb2f" }
.codicon-project:before { content: "\eb30" }
.codicon-pulse:before { content: "\eb31" }
.codicon-question:before { content: "\eb32" }
.codicon-quote:before { content: "\eb33" }
.codicon-radio-tower:before { content: "\eb34" }
.codicon-reactions:before { content: "\eb35" }
.codicon-references:before { content: "\eb36" }
.codicon-refresh:before { content: "\eb37" }
.codicon-regex:before { content: "\eb38" }
.codicon-remote-explorer:before { content: "\eb39" }
.codicon-remote:before { content: "\eb3a" }
.codicon-remove:before { content: "\eb3b" }
.codicon-replace-all:before { content: "\eb3c" }
.codicon-replace:before { content: "\eb3d" }
.codicon-repo-clone:before { content: "\eb3e" }
.codicon-repo-force-push:before { content: "\eb3f" }
.codicon-repo-pull:before { content: "\eb40" }
.codicon-repo-push:before { content: "\eb41" }
.codicon-report:before { content: "\eb42" }
.codicon-request-changes:before { content: "\eb43" }
.codicon-rocket:before { content: "\eb44" }
.codicon-root-folder-opened:before { content: "\eb45" }
.codicon-root-folder:before { content: "\eb46" }
.codicon-rss:before { content: "\eb47" }
.codicon-ruby:before { content: "\eb48" }
.codicon-save-all:before { content: "\eb49" }
.codicon-save-as:before { content: "\eb4a" }
.codicon-save:before { content: "\eb4b" }
.codicon-screen-full:before { content: "\eb4c" }
.codicon-screen-normal:before { content: "\eb4d" }
.codicon-search-stop:before { content: "\eb4e" }
.codicon-server:before { content: "\eb50" }
.codicon-settings-gear:before { content: "\eb51" }
.codicon-settings:before { content: "\eb52" }
.codicon-shield:before { content: "\eb53" }
.codicon-smiley:before { content: "\eb54" }
.codicon-sort-precedence:before { content: "\eb55" }
.codicon-split-horizontal:before { content: "\eb56" }
.codicon-split-vertical:before { content: "\eb57" }
.codicon-squirrel:before { content: "\eb58" }
.codicon-star-full:before { content: "\eb59" }
.codicon-star-half:before { content: "\eb5a" }
.codicon-symbol-class:before { content: "\eb5b" }
.codicon-symbol-color:before { content: "\eb5c" }
.codicon-symbol-constant:before { content: "\eb5d" }
.codicon-symbol-enum-member:before { content: "\eb5e" }
.codicon-symbol-field:before { content: "\eb5f" }
.codicon-symbol-file:before { content: "\eb60" }
.codicon-symbol-interface:before { content: "\eb61" }
.codicon-symbol-keyword:before { content: "\eb62" }
.codicon-symbol-misc:before { content: "\eb63" }
.codicon-symbol-operator:before { content: "\eb64" }
.codicon-symbol-property:before { content: "\eb65" }
.codicon-wrench:before { content: "\eb65" }
.codicon-wrench-subaction:before { content: "\eb65" }
.codicon-symbol-snippet:before { content: "\eb66" }
.codicon-tasklist:before { content: "\eb67" }
.codicon-telescope:before { content: "\eb68" }
.codicon-text-size:before { content: "\eb69" }
.codicon-three-bars:before { content: "\eb6a" }
.codicon-thumbsdown:before { content: "\eb6b" }
.codicon-thumbsup:before { content: "\eb6c" }
.codicon-tools:before { content: "\eb6d" }
.codicon-triangle-down:before { content: "\eb6e" }
.codicon-triangle-left:before { content: "\eb6f" }
.codicon-triangle-right:before { content: "\eb70" }
.codicon-triangle-up:before { content: "\eb71" }
.codicon-twitter:before { content: "\eb72" }
.codicon-unfold:before { content: "\eb73" }
.codicon-unlock:before { content: "\eb74" }
.codicon-unmute:before { content: "\eb75" }
.codicon-unverified:before { content: "\eb76" }
.codicon-verified:before { content: "\eb77" }
.codicon-versions:before { content: "\eb78" }
.codicon-vm-active:before { content: "\eb79" }
.codicon-vm-outline:before { content: "\eb7a" }
.codicon-vm-running:before { content: "\eb7b" }
.codicon-watch:before { content: "\eb7c" }
.codicon-whitespace:before { content: "\eb7d" }
.codicon-whole-word:before { content: "\eb7e" }
.codicon-window:before { content: "\eb7f" }
.codicon-word-wrap:before { content: "\eb80" }
.codicon-zoom-in:before { content: "\eb81" }
.codicon-zoom-out:before { content: "\eb82" }
.codicon-list-filter:before { content: "\eb83" }
.codicon-list-flat:before { content: "\eb84" }
.codicon-list-selection:before { content: "\eb85" }
.codicon-selection:before { content: "\eb85" }
.codicon-list-tree:before { content: "\eb86" }
.codicon-debug-breakpoint-function-unverified:before { content: "\eb87" }
.codicon-debug-breakpoint-function:before { content: "\eb88" }
.codicon-debug-breakpoint-function-disabled:before { content: "\eb88" }
.codicon-debug-stackframe-active:before { content: "\eb89" }
.codicon-circle-small-filled:before { content: "\eb8a" }
.codicon-debug-stackframe-dot:before { content: "\eb8a" }
.codicon-terminal-decoration-mark:before { content: "\eb8a" }
.codicon-debug-stackframe:before { content: "\eb8b" }
.codicon-debug-stackframe-focused:before { content: "\eb8b" }
.codicon-debug-breakpoint-unsupported:before { content: "\eb8c" }
.codicon-symbol-string:before { content: "\eb8d" }
.codicon-debug-reverse-continue:before { content: "\eb8e" }
.codicon-debug-step-back:before { content: "\eb8f" }
.codicon-debug-restart-frame:before { content: "\eb90" }
.codicon-debug-alt:before { content: "\eb91" }
.codicon-call-incoming:before { content: "\eb92" }
.codicon-call-outgoing:before { content: "\eb93" }
.codicon-menu:before { content: "\eb94" }
.codicon-expand-all:before { content: "\eb95" }
.codicon-feedback:before { content: "\eb96" }
.codicon-git-pull-request-reviewer:before { content: "\eb96" }
.codicon-group-by-ref-type:before { content: "\eb97" }
.codicon-ungroup-by-ref-type:before { content: "\eb98" }
.codicon-account:before { content: "\eb99" }
.codicon-git-pull-request-assignee:before { content: "\eb99" }
.codicon-bell-dot:before { content: "\eb9a" }
.codicon-debug-console:before { content: "\eb9b" }
.codicon-library:before { content: "\eb9c" }
.codicon-output:before { content: "\eb9d" }
.codicon-run-all:before { content: "\eb9e" }
.codicon-sync-ignored:before { content: "\eb9f" }
.codicon-pinned:before { content: "\eba0" }
.codicon-github-inverted:before { content: "\eba1" }
.codicon-server-process:before { content: "\eba2" }
.codicon-server-environment:before { content: "\eba3" }
.codicon-pass:before { content: "\eba4" }
.codicon-issue-closed:before { content: "\eba4" }
.codicon-stop-circle:before { content: "\eba5" }
.codicon-play-circle:before { content: "\eba6" }
.codicon-record:before { content: "\eba7" }
.codicon-debug-alt-small:before { content: "\eba8" }
.codicon-vm-connect:before { content: "\eba9" }
.codicon-cloud:before { content: "\ebaa" }
.codicon-merge:before { content: "\ebab" }
.codicon-export:before { content: "\ebac" }
.codicon-graph-left:before { content: "\ebad" }
.codicon-magnet:before { content: "\ebae" }
.codicon-notebook:before { content: "\ebaf" }
.codicon-redo:before { content: "\ebb0" }
.codicon-check-all:before { content: "\ebb1" }
.codicon-pinned-dirty:before { content: "\ebb2" }
.codicon-pass-filled:before { content: "\ebb3" }
.codicon-circle-large-filled:before { content: "\ebb4" }
.codicon-circle-large:before { content: "\ebb5" }
.codicon-circle-large-outline:before { content: "\ebb5" }
.codicon-combine:before { content: "\ebb6" }
.codicon-gather:before { content: "\ebb6" }
.codicon-table:before { content: "\ebb7" }
.codicon-variable-group:before { content: "\ebb8" }
.codicon-type-hierarchy:before { content: "\ebb9" }
.codicon-type-hierarchy-sub:before { content: "\ebba" }
.codicon-type-hierarchy-super:before { content: "\ebbb" }
.codicon-git-pull-request-create:before { content: "\ebbc" }
.codicon-run-above:before { content: "\ebbd" }
.codicon-run-below:before { content: "\ebbe" }
.codicon-notebook-template:before { content: "\ebbf" }
.codicon-debug-rerun:before { content: "\ebc0" }
.codicon-workspace-trusted:before { content: "\ebc1" }
.codicon-workspace-untrusted:before { content: "\ebc2" }
.codicon-workspace-unknown:before { content: "\ebc3" }
.codicon-terminal-cmd:before { content: "\ebc4" }
.codicon-terminal-debian:before { content: "\ebc5" }
.codicon-terminal-linux:before { content: "\ebc6" }
.codicon-terminal-powershell:before { content: "\ebc7" }
.codicon-terminal-tmux:before { content: "\ebc8" }
.codicon-terminal-ubuntu:before { content: "\ebc9" }
.codicon-terminal-bash:before { content: "\ebca" }
.codicon-arrow-swap:before { content: "\ebcb" }
.codicon-copy:before { content: "\ebcc" }
.codicon-person-add:before { content: "\ebcd" }
.codicon-filter-filled:before { content: "\ebce" }
.codicon-wand:before { content: "\ebcf" }
.codicon-debug-line-by-line:before { content: "\ebd0" }
.codicon-inspect:before { content: "\ebd1" }
.codicon-layers:before { content: "\ebd2" }
.codicon-layers-dot:before { content: "\ebd3" }
.codicon-layers-active:before { content: "\ebd4" }
.codicon-compass:before { content: "\ebd5" }
.codicon-compass-dot:before { content: "\ebd6" }
.codicon-compass-active:before { content: "\ebd7" }
.codicon-azure:before { content: "\ebd8" }
.codicon-issue-draft:before { content: "\ebd9" }
.codicon-git-pull-request-closed:before { content: "\ebda" }
.codicon-git-pull-request-draft:before { content: "\ebdb" }
.codicon-debug-all:before { content: "\ebdc" }
.codicon-debug-coverage:before { content: "\ebdd" }
.codicon-run-errors:before { content: "\ebde" }
.codicon-folder-library:before { content: "\ebdf" }
.codicon-debug-continue-small:before { content: "\ebe0" }
.codicon-beaker-stop:before { content: "\ebe1" }
.codicon-graph-line:before { content: "\ebe2" }
.codicon-graph-scatter:before { content: "\ebe3" }
.codicon-pie-chart:before { content: "\ebe4" }
.codicon-bracket-dot:before { content: "\ebe5" }
.codicon-bracket-error:before { content: "\ebe6" }
.codicon-lock-small:before { content: "\ebe7" }
.codicon-azure-devops:before { content: "\ebe8" }
.codicon-verified-filled:before { content: "\ebe9" }
.codicon-newline:before { content: "\ebea" }
.codicon-layout:before { content: "\ebeb" }
.codicon-layout-activitybar-left:before { content: "\ebec" }
.codicon-layout-activitybar-right:before { content: "\ebed" }
.codicon-layout-panel-left:before { content: "\ebee" }
.codicon-layout-panel-center:before { content: "\ebef" }
.codicon-layout-panel-justify:before { content: "\ebf0" }
.codicon-layout-panel-right:before { content: "\ebf1" }
.codicon-layout-panel:before { content: "\ebf2" }
.codicon-layout-sidebar-left:before { content: "\ebf3" }
.codicon-layout-sidebar-right:before { content: "\ebf4" }
.codicon-layout-statusbar:before { content: "\ebf5" }
.codicon-layout-menubar:before { content: "\ebf6" }
.codicon-layout-centered:before { content: "\ebf7" }
.codicon-target:before { content: "\ebf8" }
.codicon-indent:before { content: "\ebf9" }
.codicon-record-small:before { content: "\ebfa" }
.codicon-error-small:before { content: "\ebfb" }
.codicon-terminal-decoration-error:before { content: "\ebfb" }
.codicon-arrow-circle-down:before { content: "\ebfc" }
.codicon-arrow-circle-left:before { content: "\ebfd" }
.codicon-arrow-circle-right:before { content: "\ebfe" }
.codicon-arrow-circle-up:before { content: "\ebff" }
.codicon-layout-sidebar-right-off:before { content: "\ec00" }
.codicon-layout-panel-off:before { content: "\ec01" }
.codicon-layout-sidebar-left-off:before { content: "\ec02" }
.codicon-blank:before { content: "\ec03" }
.codicon-heart-filled:before { content: "\ec04" }
.codicon-map:before { content: "\ec05" }
.codicon-map-horizontal:before { content: "\ec05" }
.codicon-fold-horizontal:before { content: "\ec05" }
.codicon-map-filled:before { content: "\ec06" }
.codicon-map-horizontal-filled:before { content: "\ec06" }
.codicon-fold-horizontal-filled:before { content: "\ec06" }
.codicon-circle-small:before { content: "\ec07" }
.codicon-bell-slash:before { content: "\ec08" }
.codicon-bell-slash-dot:before { content: "\ec09" }
.codicon-comment-unresolved:before { content: "\ec0a" }
.codicon-git-pull-request-go-to-changes:before { content: "\ec0b" }
.codicon-git-pull-request-new-changes:before { content: "\ec0c" }
.codicon-search-fuzzy:before { content: "\ec0d" }
.codicon-comment-draft:before { content: "\ec0e" }
.codicon-send:before { content: "\ec0f" }
.codicon-sparkle:before { content: "\ec10" }
.codicon-insert:before { content: "\ec11" }
.codicon-mic:before { content: "\ec12" }
.codicon-thumbsdown-filled:before { content: "\ec13" }
.codicon-thumbsup-filled:before { content: "\ec14" }
.codicon-coffee:before { content: "\ec15" }
.codicon-snake:before { content: "\ec16" }
.codicon-game:before { content: "\ec17" }
.codicon-vr:before { content: "\ec18" }
.codicon-chip:before { content: "\ec19" }
.codicon-piano:before { content: "\ec1a" }
.codicon-music:before { content: "\ec1b" }
.codicon-mic-filled:before { content: "\ec1c" }
.codicon-repo-fetch:before { content: "\ec1d" }
.codicon-copilot:before { content: "\ec1e" }
.codicon-lightbulb-sparkle:before { content: "\ec1f" }
.codicon-robot:before { content: "\ec20" }
.codicon-sparkle-filled:before { content: "\ec21" }
.codicon-diff-single:before { content: "\ec22" }
.codicon-diff-multiple:before { content: "\ec23" }
.codicon-surround-with:before { content: "\ec24" }
.codicon-share:before { content: "\ec25" }
.codicon-git-stash:before { content: "\ec26" }
.codicon-git-stash-apply:before { content: "\ec27" }
.codicon-git-stash-pop:before { content: "\ec28" }
.codicon-vscode:before { content: "\ec29" }
.codicon-vscode-insiders:before { content: "\ec2a" }
.codicon-code-oss:before { content: "\ec2b" }
.codicon-run-coverage:before { content: "\ec2c" }
.codicon-run-all-coverage:before { content: "\ec2d" }
.codicon-coverage:before { content: "\ec2e" }
.codicon-github-project:before { content: "\ec2f" }
.codicon-map-vertical:before { content: "\ec30" }
.codicon-fold-vertical:before { content: "\ec30" }
.codicon-map-vertical-filled:before { content: "\ec31" }
.codicon-fold-vertical-filled:before { content: "\ec31" }
.codicon-go-to-search:before { content: "\ec32" }
.codicon-percentage:before { content: "\ec33" }
.codicon-sort-percentage:before { content: "\ec33" }
.codicon-attach:before { content: "\ec34" }
.codicon-go-to-editing-session:before { content: "\ec35" }
.codicon-edit-session:before { content: "\ec36" }
.codicon-code-review:before { content: "\ec37" }
.codicon-copilot-warning:before { content: "\ec38" }
.codicon-python:before { content: "\ec39" }
.codicon-copilot-large:before { content: "\ec3a" }
.codicon-copilot-warning-large:before { content: "\ec3b" }
.codicon-keyboard-tab:before { content: "\ec3c" }
.codicon-copilot-blocked:before { content: "\ec3d" }
.codicon-copilot-not-connected:before { content: "\ec3e" }
.codicon-flag:before { content: "\ec3f" }
.codicon-lightbulb-empty:before { content: "\ec40" }
.codicon-symbol-method-arrow:before { content: "\ec41" }
.codicon-copilot-unavailable:before { content: "\ec42" }
.codicon-repo-pinned:before { content: "\ec43" }
.codicon-keyboard-tab-above:before { content: "\ec44" }
.codicon-keyboard-tab-below:before { content: "\ec45" }
.codicon-git-pull-request-done:before { content: "\ec46" }
.codicon-mcp:before { content: "\ec47" }
.codicon-extensions-large:before { content: "\ec48" }
.codicon-layout-panel-dock:before { content: "\ec49" }
.codicon-layout-sidebar-left-dock:before { content: "\ec4a" }
.codicon-layout-sidebar-right-dock:before { content: "\ec4b" }
.codicon-copilot-in-progress:before { content: "\ec4c" }
.codicon-copilot-error:before { content: "\ec4d" }
.codicon-copilot-success:before { content: "\ec4e" }
.codicon-chat-sparkle:before { content: "\ec4f" }
.codicon-search-sparkle:before { content: "\ec50" }
.codicon-edit-sparkle:before { content: "\ec51" }
.codicon-copilot-snooze:before { content: "\ec52" }
.codicon-send-to-remote-agent:before { content: "\ec53" }
.codicon-comment-discussion-sparkle:before { content: "\ec54" }
.codicon-chat-sparkle-warning:before { content: "\ec55" }
.codicon-chat-sparkle-error:before { content: "\ec56" }
.codicon-collection:before { content: "\ec57" }
.codicon-new-collection:before { content: "\ec58" }
.codicon-thinking:before { content: "\ec59" }
.codicon-build:before { content: "\ec5a" }
.codicon-comment-discussion-quote:before { content: "\ec5b" }
.codicon-cursor:before { content: "\ec5c" }
.codicon-eraser:before { content: "\ec5d" }
.codicon-file-text:before { content: "\ec5e" }
.codicon-quotes:before { content: "\ec60" }
.codicon-rename:before { content: "\ec61" }
.codicon-run-with-deps:before { content: "\ec62" }
.codicon-debug-connected:before { content: "\ec63" }
.codicon-strikethrough:before { content: "\ec64" }
.codicon-open-in-product:before { content: "\ec65" }
.codicon-index-zero:before { content: "\ec66" }
.codicon-agent:before { content: "\ec67" }
.codicon-edit-code:before { content: "\ec68" }
.codicon-repo-selected:before { content: "\ec69" }
.codicon-skip:before { content: "\ec6a" }
.codicon-merge-into:before { content: "\ec6b" }
.codicon-git-branch-changes:before { content: "\ec6c" }
.codicon-git-branch-staged-changes:before { content: "\ec6d" }
.codicon-git-branch-conflicts:before { content: "\ec6e" }
.codicon-git-branch:before { content: "\ec6f" }
.codicon-git-branch-create:before { content: "\ec6f" }
.codicon-git-branch-delete:before { content: "\ec6f" }
.codicon-search-large:before { content: "\ec70" }
.codicon-terminal-git-bash:before { content: "\ec71" }
.codicon-window-active:before { content: "\ec72" }
.codicon-forward:before { content: "\ec73" }
.codicon-download:before { content: "\ec74" }
.codicon-clockface:before { content: "\ec75" }
.codicon-unarchive:before { content: "\ec76" }
.codicon-session-in-progress:before { content: "\ec77" }
.codicon-collection-small:before { content: "\ec78" }
.codicon-vm-small:before { content: "\ec79" }
.codicon-cloud-small:before { content: "\ec7a" }
.codicon-add-small:before { content: "\ec7b" }
.codicon-remove-small:before { content: "\ec7c" }
.codicon-worktree-small:before { content: "\ec7d" }
.codicon-worktree:before { content: "\ec7e" }
.codicon-screen-cut:before { content: "\ec7f" }
.codicon-ask:before { content: "\ec80" }
.codicon-openai:before { content: "\ec81" }
.codicon-claude:before { content: "\ec82" }
.codicon-open-in-window:before { content: "\ec83" }
.codicon-new-session:before { content: "\ec84" }
.codicon-terminal-secure:before { content: "\ec85" }
.codicon-chat-import:before { content: "\ec86" }
.codicon-chat-export:before { content: "\ec87" }
.codicon-share-window:before { content: "\ec88" }
.codicon-circle-slash-compact:before { content: "\ec89" }
.codicon-copilot-compact:before { content: "\ec8a" }
.codicon-folder-opened-compact:before { content: "\ec8b" }
.codicon-folder-compact:before { content: "\ec8c" }
.codicon-gear-compact:before { content: "\ec8d" }
.codicon-git-branch-compact:before { content: "\ec8e" }
.codicon-library-compact:before { content: "\ec8f" }
.codicon-record-keys-compact:before { content: "\ec90" }
.codicon-remote-compact:before { content: "\ec91" }
.codicon-repo-forked-compact:before { content: "\ec92" }
.codicon-repo-compact:before { content: "\ec93" }
.codicon-shield-compact:before { content: "\ec94" }
.codicon-sparkle-compact:before { content: "\ec95" }
.codicon-symbol-color-compact:before { content: "\ec96" }
.codicon-window-compact:before { content: "\ec97" }
.codicon-error-compact:before { content: "\ec98" }
.codicon-warning-compact:before { content: "\ec99" }
.codicon-pass-compact:before { content: "\ec9a" }
.codicon-important:before { content: "\ec9b" }
.codicon-important-compact:before { content: "\ec9c" }
.codicon-rocket-compact:before { content: "\ec9d" }
.codicon-unpin:before { content: "\ec9e" }
.codicon-add-compact:before { content: "\ec9f" }
.codicon-attach-compact:before { content: "\eca0" }
.codicon-beaker-compact:before { content: "\eca1" }
.codicon-check-compact:before { content: "\eca2" }
.codicon-checklist-compact:before { content: "\eca3" }
.codicon-chevron-down-compact:before { content: "\eca4" }
.codicon-chevron-left-compact:before { content: "\eca5" }
.codicon-chevron-right-compact:before { content: "\eca6" }
.codicon-chevron-up-compact:before { content: "\eca7" }
.codicon-circle-filled-compact:before { content: "\eca8" }
.codicon-circle-small-filled-compact:before { content: "\eca9" }
.codicon-close-compact:before { content: "\ecaa" }
.codicon-collapse-all-compact:before { content: "\ecab" }
.codicon-comment-compact:before { content: "\ecac" }
.codicon-comment-unresolved-compact:before { content: "\ecad" }
.codicon-debug-connected-compact:before { content: "\ecae" }
.codicon-debug-disconnect-compact:before { content: "\ecaf" }
.codicon-edit-compact:before { content: "\ecb0" }
.codicon-file-media-compact:before { content: "\ecb1" }
.codicon-git-fetch:before { content: "\ecb2" }
.codicon-lightbulb-compact:before { content: "\ecb3" }
.codicon-loading-compact:before { content: "\ecb4" }
.codicon-pass-filled-compact:before { content: "\ecb5" }
.codicon-project-compact:before { content: "\ecb6" }
.codicon-refresh-compact:before { content: "\ecb7" }
.codicon-search-compact:before { content: "\ecb8" }
.codicon-session-in-progress-compact:before { content: "\ecb9" }
.codicon-sync-compact:before { content: "\ecba" }
.codicon-terminal-compact:before { content: "\ecbb" }
.codicon-vm-pending:before { content: "\ecbc" }
.codicon-worktree-compact:before { content: "\ecbd" }
.codicon-developer-tools:before { content: "\ecbe" }
.codicon-cloud-compact:before { content: "\ecbf" }
.codicon-agent-compact:before { content: "\ecc0" }
.codicon-ask-compact:before { content: "\ecc1" }
.codicon-settings-compact:before { content: "\ecc2" }
.codicon-vm-compact:before { content: "\ecc3" }
.codicon-run-compact:before { content: "\ecc4" }
.codicon-git-pull-request-comment:before { content: "\ecc5" }
.codicon-git-pull-request-error:before { content: "\ecc6" }
.codicon-right-panel-hide:before { content: "\ecc7" }
.codicon-right-panel-show:before { content: "\ecc8" }
.codicon-vscode-insiders-outline:before { content: "\ecc9" }
.codicon-vscode-outline:before { content: "\ecca" }
.codicon-voice-mode:before { content: "\eccb" }
.codicon-voice-mode-compact:before { content: "\eccc" }
.codicon-mic-download:before { content: "\eccd" }
.codicon-mic-download-compact:before { content: "\ecce" }
.codicon-voice-mode-download:before { content: "\eccf" }
.codicon-voice-mode-download-compact:before { content: "\ecd0" }
.codicon-google-gemini:before { content: "\ecd1" }
.codicon-kimi:before { content: "\ecd2" }
.codicon-microsoft:before { content: "\ecd3" }
.codicon-fish1-happy:before { content: "\ecd4" }
.codicon-fish1-neutral:before { content: "\ecd5" }
.codicon-fish1-sad:before { content: "\ecd6" }
.codicon-fish1-very-sad:before { content: "\ecd7" }
.codicon-fish2-happy:before { content: "\ecd8" }
.codicon-fish2-neutral:before { content: "\ecd9" }
.codicon-fish2-sad:before { content: "\ecda" }
.codicon-fish2-very-sad:before { content: "\ecdb" }
.codicon-fish3-happy:before { content: "\ecdc" }
.codicon-fish3-neutral:before { content: "\ecdd" }
.codicon-fish3-sad:before { content: "\ecde" }
.codicon-fish3-very-sad:before { content: "\ecdf" }
.codicon-fish4-happy:before { content: "\ece0" }
.codicon-fish4-neutral:before { content: "\ece1" }
.codicon-fish4-sad:before { content: "\ece2" }
.codicon-fish4-very-sad:before { content: "\ece3" }
.codicon-person-voice:before { content: "\ece4" }
.codicon-person-voice-compact:before { content: "\ece5" }
.codicon-person-voice-filled:before { content: "\ece6" }
.codicon-person-voice-filled-compact:before { content: "\ece7" }

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
      <div class="tab active" onclick="setTab('providers', this)"><i class="codicon codicon-server"></i> Providers <span class="tab-badge" id="pCount">0</span></div>
      <div class="tab" onclick="setTab('models', this)"><i class="codicon codicon-symbol-misc"></i> Models Catalog & Tests <span class="tab-badge" id="mCount">0</span></div>
      <div class="tab" onclick="setTab('cache', this)"><i class="codicon codicon-database"></i> Verified Cache <span class="tab-badge" id="cacheCount">0</span></div>
    </div>
  </header>

  <main class="app-body">
    <!-- TAB: PROVIDERS -->
    <div id="tab-providers" class="panel active">
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
    <div id="tab-models" class="panel">
      <div class="models-sticky-toolbar">
        <div class="actions-bar">
          <input type="text" id="mSearch" placeholder="🔍 Search model ID or name..." oninput="filterModels()" style="max-width: 280px;">
          <div style="display: flex; gap: 8px;">
            <button onclick="runBatchTest(false)"><i class="codicon codicon-zap"></i> Test All Models (Concurrent)</button>
            <button class="sec" onclick="runBatchTest(true)"><i class="codicon codicon-sync"></i> Force Retest All</button>
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
          <span style="font-size: 11px; opacity: 0.7; margin-right: 4px;">Filters:</span>
          <button class="chip active" id="chip-all" onclick="setFilterCategory('all')"><i class="codicon codicon-sparkle"></i> All (<span id="cAll">0</span>)</button>
          <button class="chip" id="chip-coding" onclick="setFilterCategory('coding')"><i class="codicon codicon-code" style="color:#4fc1ff;"></i> Coding (<span id="cCoding">0</span>)</button>
          <button class="chip" id="chip-reasoning" onclick="setFilterCategory('reasoning')"><i class="codicon codicon-lightbulb" style="color:#d2a8ff;"></i> Reasoning (<span id="cReasoning">0</span>)</button>
          <button class="chip" id="chip-vision" onclick="setFilterCategory('vision')"><i class="codicon codicon-eye" style="color:#f59e0b;"></i> Vision (<span id="cVision">0</span>)</button>
          <button class="chip" id="chip-working" onclick="setFilterCategory('working')"><i class="codicon codicon-check" style="color:var(--success);"></i> Working (<span id="cWorking">0</span>)</button>
          <button class="chip" id="chip-failed" onclick="setFilterCategory('failed')"><i class="codicon codicon-error" style="color:var(--error);"></i> Failed (<span id="cFailed">0</span>)</button>
          <button class="chip" id="chip-selected" onclick="setFilterCategory('selected')"><i class="codicon codicon-pin" style="color:#4fc1ff;"></i> In Copilot (<span id="cSelected">0</span>)</button>
        </div>

        <!-- Selection Management Bar -->
        <div class="selection-bar">
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <span style="font-weight: 500;"><i class="codicon codicon-copilot" style="font-size:14px; color:#4fc1ff;"></i> Copilot Model Selection:</span>
            <button class="sec" style="padding: 2px 8px; font-size: 11px;" onclick="enableAllWorking()"><i class="codicon codicon-pass-filled" style="color:var(--success);"></i> Enable All Working</button>
            <button class="sec" style="padding: 2px 8px; font-size: 11px;" onclick="selectVisible(true)"><i class="codicon codicon-check"></i> Select Visible</button>
            <button class="sec" style="padding: 2px 8px; font-size: 11px;" onclick="selectVisible(false)"><i class="codicon codicon-circle-slash"></i> Deselect Visible</button>
          </div>
          <span class="selection-badge" id="selectionSummary">0 models active in Copilot</span>
        </div>
      </div>

      <div class="table-container">
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
            '<div class="action-cell">' +
              '<button class="sec" style="padding:2px 8px; flex-shrink:0;" onclick="pingModelByIdx(' + mIdx + ')"><i class="codicon codicon-pulse"></i> Ping & Tools</button>' +
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
