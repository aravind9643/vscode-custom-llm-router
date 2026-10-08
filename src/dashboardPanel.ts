import * as vscode from "vscode";
import { ModelEngine } from "./modelEngine";
import { ProviderConfig } from "./types";
import { SECRET_SENTINEL } from "./providerStore";
import type { Auth } from "./transports/types";
import type { DashboardState, DashboardTab, HostMessage, ProviderView, WebviewMessage } from "./protocol";

export type DashboardFocus = {
  tab?: DashboardTab;
  editProvider?: string;
  addProvider?: boolean;
  editModel?: string;
};

/**
 * Webview host for the dashboard. All UI lives in media/dashboard.{js,css}; this class only
 * serializes engine state and executes the actions the page asks for.
 */
export class DashboardPanel implements vscode.Disposable {
  private static _current: DashboardPanel | undefined;
  private readonly _disposables: vscode.Disposable[] = [];
  private _pendingFocus?: DashboardFocus;
  private _ready = false;

  public static show(extensionUri: vscode.Uri, engine: ModelEngine, focus?: DashboardFocus) {
    if (DashboardPanel._current) {
      DashboardPanel._current._panel.reveal();
      if (focus) DashboardPanel._current._focus(focus);
      return;
    }
    const panel = vscode.window.createWebviewPanel("customLlmRouterDashboard", "LLM Router", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "sidebar-icon.svg");
    DashboardPanel._current = new DashboardPanel(panel, extensionUri, engine, focus);
  }

  private constructor(
    private readonly _panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private readonly _engine: ModelEngine,
    focus?: DashboardFocus
  ) {
    this._pendingFocus = focus;
    this._panel.webview.html = this._html();
    this._disposables.push(
      this._panel.onDidDispose(() => this.dispose()),
      this._panel.webview.onDidReceiveMessage((msg) => this._handle(msg).catch((err) => this._error(err))),
      this._engine.onDidChange(() => this._postState()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("customLlmRouter")) this._postState();
      })
    );
  }

  private _focus(focus: DashboardFocus) {
    if (this._ready) this._post({ type: "focus", ...focus });
    else this._pendingFocus = focus;
  }

  private _post(msg: HostMessage) {
    void this._panel.webview.postMessage(msg);
  }

  private _postState() {
    if (!this._ready) return;
    const store = this._engine.store;
    const statuses = new Map(this._engine.getProviderStatuses().map((s) => [s.name, s]));
    const providers: ProviderView[] = store.getProviders().map((p) => {
      const { apiKey: _omit, ...config } = p;
      const status = statuses.get(p.name);
      // Secret header values never reach the webview; it edits them through a placeholder.
      const headers = { ...(p.headers || {}) };
      for (const name of status?.secretHeaderNames || []) headers[name] = SECRET_SENTINEL;
      return { ...config, headers, ...status!, enabled: p.enabled !== false };
    });
    const state: DashboardState = {
      providers,
      models: this._engine.getModels(),
      routes: this._engine.getRoutes(),
      overrides: store.getOverrides(),
      discovered: this._engine.isDiscovered,
      verifying: this._engine.verifyProgress ?? null,
      spend: this._engine.totalSpend(),
      settings: {
        testConcurrency: store.concurrency,
        providerConcurrency: store.providerConcurrency,
        cacheTtlHours: Math.round(store.cacheTtlMs / 3600000),
        showReasoning: store.showReasoning,
        toolCheck: store.toolCheck,
        budgetLimitUsd: store.budgetLimitUsd,
      },
    };
    this._post({ type: "state", state });
  }

  private async _handle(msg: WebviewMessage) {
    const store = this._engine.store;
    switch (msg?.type) {
      case "ready":
        this._ready = true;
        this._postState();
        if (this._pendingFocus) {
          this._focus(this._pendingFocus);
          this._pendingFocus = undefined;
        }
        if (!this._engine.isDiscovered) void this._engine.refresh();
        break;
      case "refresh":
        await this._engine.refresh();
        break;
      case "verify":
        void vscode.commands.executeCommand("vscode-custom-llm-router.testAllModels", { keys: msg.keys, force: !!msg.force });
        break;
      case "cancelVerify":
        this._engine.cancelVerification();
        break;
      case "setSelected": {
        const keys: string[] = Array.isArray(msg.keys) ? msg.keys : [];
        await store.setSelected(keys, !!msg.selected);
        if (msg.selected) {
          const untested = keys.map((k) => this._engine.getModel(k)).filter((m) => m?.status === "untested");
          if (untested.length) void this._engine.verify(untested as any);
        }
        break;
      }
      case "setSelectionExactly":
        await store.setSelection(Array.isArray(msg.keys) ? msg.keys : []);
        break;
      case "testConnection": {
        const p = sanitizeProvider(msg.provider);
        const saved = msg.originalName ? store.findProvider(msg.originalName) : undefined;
        const savedAuth: Auth = saved ? await store.getAuth(saved) : { secretHeaders: {} };
        const auth: Auth = { apiKey: typeof msg.apiKey === "string" ? msg.apiKey || undefined : savedAuth.apiKey, secretHeaders: savedAuth.secretHeaders };
        // Placeholders stand for stored secret values, which savedAuth supplies.
        for (const [k, v] of Object.entries(p.headers || {})) {
          if (v === SECRET_SENTINEL) delete p.headers![k];
          else if (k in auth.secretHeaders) auth.secretHeaders = { ...auth.secretHeaders, [k]: v };
        }
        const res = await this._engine.testConnection(p, auth, p.timeoutMs || 10000);
        this._post({ type: "connectionResult", reqId: msg.reqId, ...res });
        break;
      }
      case "saveProvider": {
        const p = sanitizeProvider(msg.provider);
        try {
          if (msg.originalName && msg.originalName !== p.name && !store.findProvider(p.name)) {
            this._engine.renameProvider(msg.originalName, p.name);
          }
          await store.saveProvider(msg.originalName || undefined, p, typeof msg.apiKey === "string" ? msg.apiKey : undefined);
        } catch (err: any) {
          this._post({ type: "saveResult", ok: false, error: err.message });
          return;
        }
        this._post({ type: "saveResult", ok: true, name: p.name });
        // A key-only change leaves settings untouched, so no configuration event would trigger this.
        void this._engine.refresh();
        break;
      }
      case "toggleProvider":
        await store.setProviderEnabled(msg.name, !!msg.enabled);
        break;
      case "deleteProvider":
        await vscode.commands.executeCommand("vscode-custom-llm-router.deleteProvider", { kind: "provider", name: msg.name });
        break;
      case "updateSetting":
        if (["testConcurrency", "providerConcurrency", "cacheTtlHours", "showReasoning", "toolCheck"].includes(msg.key)) await store.updateSetting(msg.key, msg.value);
        break;
      case "setApiKey":
        void vscode.commands.executeCommand("vscode-custom-llm-router.setApiKey", { kind: "provider", name: String(msg.name || "") });
        break;
      case "resetStats": {
        const reset = vscode.l10n.t("Reset");
        const ok = await vscode.window.showWarningMessage(vscode.l10n.t("Reset usage stats and spend estimates for all models?"), { modal: true }, reset);
        if (ok === reset) this._engine.resetStats();
        break;
      }
      case "setOverride":
        if (typeof msg.key === "string") await store.setOverride(msg.key, msg.override || undefined);
        break;
      case "saveRoutes":
        if (Array.isArray(msg.routes)) await store.saveRoutes(msg.routes);
        break;
      case "pullOllama":
        void vscode.commands.executeCommand("vscode-custom-llm-router.pullOllamaModel", String(msg.name || ""));
        break;
      case "clearCache":
        await vscode.commands.executeCommand("vscode-custom-llm-router.clearCache");
        break;
      case "exportConfig":
        await vscode.commands.executeCommand("vscode-custom-llm-router.exportConfig");
        break;
      case "importConfig":
        await vscode.commands.executeCommand("vscode-custom-llm-router.importConfig");
        break;
      case "exportStats":
        await vscode.commands.executeCommand("vscode-custom-llm-router.exportStats");
        break;
      case "scanLocalServers": {
        const candidates = [
          { name: "Ollama", url: "http://localhost:11434", probe: "http://localhost:11434/api/tags", api: "ollama" },
          { name: "LM Studio", url: "http://localhost:1234", probe: "http://localhost:1234/v1/models", api: "openai" },
          { name: "vLLM", url: "http://localhost:8000", probe: "http://localhost:8000/v1/models", api: "openai" },
          { name: "LocalAI", url: "http://localhost:8080", probe: "http://localhost:8080/v1/models", api: "openai" },
        ];
        const found: { name: string; url: string; api: string }[] = [];
        await Promise.all(
          candidates.map(async (c) => {
            try {
              const res = await fetch(c.probe, { signal: AbortSignal.timeout(1500) });
              if (res.ok) found.push({ name: c.name, url: c.url, api: c.api });
            } catch {
              // offline
            }
          })
        );
        this._post({ type: "localScanResult", found });
        break;
      }
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "customLlmRouter");
        break;
      case "showLogs":
        await vscode.commands.executeCommand("vscode-custom-llm-router.showLogs");
        break;
    }
  }

  private _error(err: any) {
    void vscode.window.showErrorMessage(`LLM Router: ${err?.message || err}`);
  }

  private _html(): string {
    const webview = this._panel.webview;
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", f));
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join("");
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${media("codicon.css")}">
  <link rel="stylesheet" href="${media("dashboard.css")}">
  <title>LLM Router</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${media("dashboard.js")}"></script>
</body>
</html>`;
  }

  dispose() {
    DashboardPanel._current = undefined;
    this._panel.dispose();
    while (this._disposables.length) this._disposables.pop()?.dispose();
  }
}

/** Whitelists fields coming from the webview so arbitrary keys never reach settings.json. */
function sanitizeProvider(raw: any): ProviderConfig {
  const p: ProviderConfig = {
    name: String(raw?.name || "").trim(),
    endpointUrl: String(raw?.endpointUrl || "").trim(),
    enabled: raw?.enabled !== false,
    autoDiscover: raw?.autoDiscover !== false,
  };
  if (raw?.modelsEndpoint) p.modelsEndpoint = String(raw.modelsEndpoint).trim();
  if (raw?.chatEndpoint) p.chatEndpoint = String(raw.chatEndpoint).trim();
  if (Number(raw?.timeoutMs) > 0) p.timeoutMs = Math.round(Number(raw.timeoutMs));
  if (typeof raw?.keepAlive === "string" && raw.keepAlive.trim()) p.keepAlive = raw.keepAlive.trim();
  if (["openai", "ollama", "anthropic"].includes(raw?.api)) p.api = raw.api;
  if (["bearer", "api-key", "x-api-key"].includes(raw?.authHeader) && raw.authHeader !== "bearer") p.authHeader = raw.authHeader;
  if (Number(raw?.contextLength) >= 1024) p.contextLength = Math.round(Number(raw.contextLength));
  if (raw?.headers && typeof raw.headers === "object") {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.headers)) if (k.trim() && typeof v === "string") h[k.trim()] = v;
    if (Object.keys(h).length) p.headers = h;
  }
  if (Array.isArray(raw?.staticModels)) {
    const list = raw.staticModels
      .filter((m: any) => m && typeof m.id === "string" && m.id.trim())
      .map((m: any) => {
        const sm: Record<string, unknown> = { id: m.id.trim() };
        if (m.name) sm.name = String(m.name);
        for (const k of ["contextWindow", "maxInputTokens", "maxOutputTokens"]) if (Number(m[k]) > 0) sm[k] = Number(m[k]);
        for (const k of ["toolCalling", "vision"]) if (typeof m[k] === "boolean") sm[k] = m[k];
        return sm;
      });
    if (list.length) p.staticModels = list;
  }
  return p;
}
