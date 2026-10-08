import * as vscode from "vscode";
import * as fs from "fs";
import { ModelEngine } from "./modelEngine";
import { ProviderStore } from "./providerStore";
import { CustomLLMChatProvider } from "./customChatProvider";
import { DashboardPanel, DashboardFocus } from "./dashboardPanel";
import { RouterNode, RouterTreeProvider } from "./sidebarTree";
import { pullOllamaModel } from "./ollama";
import { CatalogModel } from "./types";
import { appendOrSyncChatLanguageModels, getChatLanguageModelsPath } from "./chatLanguageModels";

const CMD = "vscode-custom-llm-router";
/** Bulk checks touching more remote models than this ask for confirmation first. */
const REMOTE_CONFIRM_THRESHOLD = 20;

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("LLM Router", { log: true });
  const store = new ProviderStore(context.secrets);
  await store.init();
  const engine = new ModelEngine(context.globalState, store, log);
  const chatProvider = new CustomLLMChatProvider(engine, log);
  const tree = new RouterTreeProvider(engine);
  const statusBar = vscode.window.createStatusBarItem("llmRouter.status", vscode.StatusBarAlignment.Right, 100);
  statusBar.name = "LLM Router";
  statusBar.command = `${CMD}.showMenu`;
  statusBar.show();

  context.subscriptions.push(log, engine, chatProvider, tree, statusBar);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("custom-llm-router", chatProvider));

  const updateStatusBar = () => renderStatusBar(statusBar, engine);
  updateStatusBar();
  context.subscriptions.push(engine.onDidChange(updateStatusBar));

  let autoSyncTimer: NodeJS.Timeout | undefined;
  const triggerAutoSync = () => {
    if (!store.autoSyncChatLanguageModels) return;
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => {
      void appendOrSyncChatLanguageModels(context, engine, store).catch((err) => {
        log.error("[chatLanguageModels] auto-sync failed", err);
      });
    }, 1500);
  };
  context.subscriptions.push(engine.onDidChange(triggerAutoSync));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("customLlmRouter.providers")) {
        void store.init().then(() => engine.refresh());
      } else if (e.affectsConfiguration("customLlmRouter.modelOverrides")) {
        void engine.refresh(); // limits are computed at discovery time
      } else if (
        e.affectsConfiguration("customLlmRouter.copilotModels") ||
        e.affectsConfiguration("customLlmRouter.routes") ||
        e.affectsConfiguration("customLlmRouter.cacheTtlHours") ||
        e.affectsConfiguration("customLlmRouter.registerChatProvider") ||
        e.affectsConfiguration("customLlmRouter.autoSyncChatLanguageModels")
      ) {
        engine.onSelectionChanged();
        if (store.autoSyncChatLanguageModels) triggerAutoSync();
      }
    })
  );

  const showDashboard = (focus?: DashboardFocus) => DashboardPanel.show(context.extensionUri, engine, focus);
  const nodeModel = (node?: RouterNode): CatalogModel | undefined => (node?.kind === "model" ? engine.getModel(node.key) : undefined);
  const nodeProvider = (node?: RouterNode) => (node?.kind === "provider" ? node.name : undefined);

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`${CMD}.${id}`, fn));

  register("openDashboard", (focus?: DashboardFocus) => showDashboard(focus));
  register("addProvider", () => showDashboard({ tab: "providers", addProvider: true }));
  register("manageProviders", () => vscode.commands.executeCommand("llmRouter.providers.focus"));
  register("showLogs", () => log.show());

  register("syncModels", () =>
    vscode.window.withProgress({ location: { viewId: "llmRouter.providers" }, title: vscode.l10n.t("Refreshing models") }, async () => {
      await engine.refresh();
      const offline = engine.getProviderStatuses().filter((s) => s.enabled && s.online === false);
      if (offline.length) {
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("Unreachable: {0}", offline.map((s) => s.name).join(", ")),
          vscode.l10n.t("Show Logs")
        );
        if (pick) log.show();
      }
    })
  );

  register("testAllModels", async (arg?: { keys?: string[]; providerName?: string; force?: boolean; skipConfirm?: boolean }) => {
    if (engine.isVerifying) {
      void vscode.window.showInformationMessage(vscode.l10n.t("A verification run is already in progress."));
      return;
    }
    await engine.ensureDiscovered();
    let targets = engine.getModels();
    if (arg?.keys) {
      const keys = new Set(arg.keys);
      targets = targets.filter((m) => keys.has(m.key));
    } else if (arg?.providerName) {
      targets = engine.getModels(arg.providerName);
    }
    const force = !!arg?.force;
    // Single-model re-tests (row buttons) report inline in the tree and dashboard, not via notifications.
    if (targets.length === 1) {
      await engine.verify(targets, { force });
      return;
    }

    const estimate = engine.estimateVerification(targets, force);
    if (!estimate.models) {
      void vscode.window.showInformationMessage(vscode.l10n.t("All models already have fresh results. Use “Re-test shown” in the dashboard to force a new run."));
      return;
    }
    const remoteModels = estimate.remote.reduce((n, r) => n + r.models, 0);
    if (!arg?.skipConfirm && remoteModels > REMOTE_CONFIRM_THRESHOLD) {
      const routed = new Set(store.getRoutes().flatMap((r) => r.models));
      const chosen = targets.filter((m) => (m.selected || routed.has(m.key)) && (force || m.status === "untested"));
      const all = vscode.l10n.t("Check all {0}", estimate.models);
      const onlyChosen = vscode.l10n.t("Only selected ({0})", chosen.length);
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          "This sends about {0} requests to {1}. On paid or rate-limited APIs that can cost money or trigger limits.",
          estimate.requests,
          estimate.remote.map((r) => `${r.name} (${r.models})`).join(", ")
        ),
        { modal: true, detail: vscode.l10n.t("Tip: set “LLM Router › Tool Check” to “basic” to halve the number of requests.") },
        ...(chosen.length ? [onlyChosen, all] : [all])
      );
      if (!pick) return;
      if (pick === onlyChosen) targets = chosen;
    }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Verifying models"), cancellable: true },
      (progress, token) =>
        engine.verify(targets, {
          force,
          token,
          onProgress: (done, total, m) =>
            progress.report({ increment: 100 / total, message: `${done}/${total} · ${m.providerName}: ${m.name}` }),
        })
    );

    const openDashboard = vscode.l10n.t("Open Dashboard");
    const actions = [openDashboard];
    const unselectedWorking = engine.getModels().filter((m) => m.status === "working" && !m.selected);
    const addAll = vscode.l10n.t("Add {0} to Copilot", unselectedWorking.length);
    if (engine.getCopilotModels().length === 0 && unselectedWorking.length) actions.unshift(addAll);
    // Don't await the notification: the command (and anyone awaiting it) finishes when verification does.
    void vscode.window
      .showInformationMessage(vscode.l10n.t("Verification finished: {0} working, {1} failed.", result.working, result.failed), ...actions)
      .then((pick) => {
        if (pick === openDashboard) showDashboard({ tab: "models" });
        else if (pick === addAll) void store.setSelected(unselectedWorking.map((m) => m.key), true);
      });
    return result;
  });

  register("clearCache", async () => {
    const clear = vscode.l10n.t("Clear");
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t("Clear all verification results? Selected models are re-tested right away and stay hidden from Copilot until they pass."),
      { modal: true },
      clear
    );
    if (ok !== clear) return;
    await engine.clearCache();
    void engine.reverifyExpiredSelection();
  });

  register("testProvider", async (node?: RouterNode) => {
    const p = store.findProvider(nodeProvider(node) || "");
    if (!p) return;
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Connecting to {0}…", p.name) },
      async () => engine.testConnection(p, await store.getAuth(p))
    );
    if (res.ok) void vscode.window.showInformationMessage(vscode.l10n.t("{0}: connected in {1}ms, {2} models listed.", p.name, res.latencyMs, res.modelCount ?? 0));
    else void vscode.window.showErrorMessage(`${p.name}: ${res.error}`);
    void engine.refresh();
  });
  register("verifyProvider", (node?: RouterNode) =>
    vscode.commands.executeCommand(`${CMD}.testAllModels`, { providerName: nodeProvider(node), force: true })
  );
  register("editProvider", (node?: RouterNode) => showDashboard({ tab: "providers", editProvider: nodeProvider(node) }));
  register("enableProvider", (node?: RouterNode) => nodeProvider(node) && store.setProviderEnabled(nodeProvider(node)!, true));
  register("disableProvider", (node?: RouterNode) => nodeProvider(node) && store.setProviderEnabled(nodeProvider(node)!, false));
  register("deleteProvider", async (node?: RouterNode) => {
    const name = nodeProvider(node);
    if (!name) return;
    const remove = vscode.l10n.t("Remove");
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t("Remove provider “{0}”? Its API key and Copilot selections are removed too.", name),
      { modal: true },
      remove
    );
    if (ok === remove) await store.deleteProvider(name);
  });
  register("setApiKey", async (node?: RouterNode) => {
    const p = store.findProvider(nodeProvider(node) || "");
    if (!p) return;
    const key = await vscode.window.showInputBox({
      title: vscode.l10n.t("API key for {0}", p.name),
      prompt: vscode.l10n.t("Stored in VS Code's encrypted secret storage on this machine. Leave empty to remove it."),
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    await store.setApiKey(p.name, key);
    await engine.refresh();
    const status = engine.getProviderStatuses().find((s) => s.name === p.name);
    if (status?.online) void vscode.window.showInformationMessage(vscode.l10n.t("{0} is connected.", p.name));
    else if (status?.error) void vscode.window.showWarningMessage(`${p.name}: ${status.error}`);
  });
  register("pingModel", async (node?: RouterNode) => {
    const m = nodeModel(node);
    if (!m) return;
    await engine.verify([m], { force: true });
    const after = engine.getModel(m.key);
    if (after?.status === "failed") void vscode.window.showErrorMessage(`${m.name}: ${after.error || "failed"}`);
  });
  register("editModel", (node?: RouterNode) => {
    const m = nodeModel(node);
    if (m) showDashboard({ tab: "models", editModel: m.key });
  });

  register("pullOllamaModel", async (node?: RouterNode | string) => {
    const name = typeof node === "string" ? node : nodeProvider(node);
    const p = store.findProvider(name || "");
    if (!p) return;
    const model = (
      await vscode.window.showInputBox({
        title: vscode.l10n.t("Pull a model into {0}", p.name),
        prompt: vscode.l10n.t("Model name from the Ollama library, e.g. qwen2.5-coder:7b"),
        placeHolder: "qwen2.5-coder:7b",
        ignoreFocusOut: true,
        validateInput: (v) => (/^[\w.\-\/:]+$/.test(v.trim()) ? undefined : vscode.l10n.t("Enter a model name such as llama3.1:8b")),
      })
    )?.trim();
    if (!model) return;
    const error = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Pulling {0}", model), cancellable: true },
      async (progress, token) => pullOllamaModel(p, await store.getAuth(p), model, progress, token)
    );
    if (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Could not pull {0}: {1}", model, error));
      return;
    }
    await engine.refresh();
    const key = engine.getModels(p.name).find((m) => m.id === model || m.id === `${model}:latest`)?.key;
    const add = vscode.l10n.t("Add to Copilot");
    const pick = await vscode.window.showInformationMessage(vscode.l10n.t("{0} is ready.", model), ...(key ? [add] : []));
    if (pick === add && key) {
      await store.setSelected([key], true);
      const m = engine.getModel(key);
      if (m) void engine.verify([m]);
    }
  });

  register("exportConfig", async () => {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("llm-router-config.json"),
      filters: { JSON: ["json"] },
      title: vscode.l10n.t("Export LLM Router configuration (API keys are not included)"),
    });
    if (!uri) return;
    const payload = {
      version: 3,
      providers: store.getProviders().map(({ apiKey: _omit, ...p }) => p),
      copilotModels: [...store.getSelection()],
      routes: store.getRoutes(),
      modelOverrides: store.getOverrides(),
    };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), "utf8"));
    void vscode.window.showInformationMessage(vscode.l10n.t("Exported {0} provider(s). API keys were not included.", payload.providers.length));
  });

  register("exportStats", async () => {
    const stats = engine.getAllStats();
    if (!stats.length) {
      void vscode.window.showInformationMessage(vscode.l10n.t("No chat telemetry has been recorded yet."));
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("llm-router-stats.csv"),
      filters: { "CSV (Comma delimited)": ["csv"], JSON: ["json"] },
      title: vscode.l10n.t("Export LLM Router usage and spend statistics"),
    });
    if (!uri) return;
    const isJson = uri.path.endsWith(".json");
    let content: string;
    if (isJson) {
      content = JSON.stringify(stats, null, 2);
    } else {
      const headers = "Key,Provider,Model,Requests,Failures,TTFT_ms,Tokens_Per_Sec,Prompt_Tokens,Output_Tokens,Spend_USD,Last_Used";
      const rows = stats.map((s) =>
        [
          `"${s.key}"`,
          `"${s.providerName}"`,
          `"${s.modelId}"`,
          s.requests,
          s.failures,
          s.ttftMs ? Math.round(s.ttftMs) : "",
          s.tokensPerSec ? s.tokensPerSec.toFixed(1) : "",
          s.promptTokens ?? "",
          s.completionTokens ?? "",
          s.costUsd !== undefined ? s.costUsd.toFixed(4) : "",
          s.lastUsedAt ? new Date(s.lastUsedAt).toISOString() : "",
        ].join(",")
      );
      content = [headers, ...rows].join("\n");
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    void vscode.window.showInformationMessage(vscode.l10n.t("Exported usage statistics for {0} model(s).", stats.length));
  });

  register("importConfig", async () => {
    const [uri] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ["json"] }, title: vscode.l10n.t("Import LLM Router configuration") })) || [];
    if (!uri) return;
    let parsed: any;
    try {
      parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"));
    } catch (err: any) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Not a valid JSON file: {0}", err.message));
      return;
    }
    if (!Array.isArray(parsed?.providers)) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Invalid configuration: missing a “providers” array."));
      return;
    }
    const replace = vscode.l10n.t("Replace");
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t("Replace your {0} provider(s) with {1} from {2}?", store.getProviders().length, parsed.providers.length, uri.path.split("/").pop() || ""),
      { modal: true },
      replace
    );
    if (ok !== replace) return;
    await store.replaceProviders(parsed.providers);
    if (Array.isArray(parsed.copilotModels)) await store.setSelection(parsed.copilotModels.filter((k: unknown) => typeof k === "string"));
    if (Array.isArray(parsed.routes)) await store.saveRoutes(parsed.routes);
    if (parsed.modelOverrides && typeof parsed.modelOverrides === "object") {
      for (const [k, v] of Object.entries(parsed.modelOverrides)) await store.setOverride(k, v as any);
    }
  });

  register("curateTop", async () => {
    const count = (await engine.curateTopSelection(10)).length;
    void vscode.window.showInformationMessage(vscode.l10n.t("Curated top {0} model(s) for Copilot.", count));
  });

  register("deselectAll", async () => {
    await engine.deselectAll();
    void vscode.window.showInformationMessage(vscode.l10n.t("Deselected all models from Copilot."));
  });

  register("autoRoutes", async () => {
    const routes = await engine.autoGenerateRoutes();
    void vscode.window.showInformationMessage(vscode.l10n.t("Configured {0} recommended route(s).", routes.length));
  });

  register("toggleTreeFilter", () => {
    const active = tree.toggleFilter();
    void vscode.window.showInformationMessage(
      active
        ? vscode.l10n.t("Sidebar tree: showing working and Copilot models only.")
        : vscode.l10n.t("Sidebar tree: showing all models.")
    );
  });

  register("pruneCache", async () => {
    const count = await engine.pruneCache();
    void vscode.window.showInformationMessage(vscode.l10n.t("Pruned {0} stale verification cache entry(ies).", count));
  });

  register("appendToChatLanguageModels", async () => {
    try {
      await engine.ensureDiscovered();
      const res = await appendOrSyncChatLanguageModels(context, engine, store);
      const msg = vscode.l10n.t(
        "Appended/updated {0} models across {1} provider(s) in chatLanguageModels.json.",
        res.totalModels,
        res.addedProviders + res.updatedProviders
      );
      const openBtn = vscode.l10n.t("Open File");
      const disableBtn = vscode.l10n.t("Disable Extension Provider");
      const actions = store.registerChatProvider ? [openBtn, disableBtn] : [openBtn];
      void vscode.window.showInformationMessage(msg, ...actions).then(async (pick) => {
        if (pick === openBtn) {
          const doc = await vscode.workspace.openTextDocument(res.filePath);
          await vscode.window.showTextDocument(doc);
        } else if (pick === disableBtn) {
          await store.updateSetting("registerChatProvider", false);
          void vscode.window.showInformationMessage(
            vscode.l10n.t("Extension provider disabled. Models will only appear via VS Code native Custom Endpoints.")
          );
        }
      });
    } catch (err: any) {
      log.error("[chatLanguageModels] export failed", err);
      void vscode.window.showErrorMessage(vscode.l10n.t("Failed to update chatLanguageModels.json: {0}", err.message || String(err)));
    }
  });

  register("openChatLanguageModels", async () => {
    try {
      const p = getChatLanguageModelsPath(context);
      if (!fs.existsSync(p)) {
        await appendOrSyncChatLanguageModels(context, engine, store);
      }
      const doc = await vscode.workspace.openTextDocument(p);
      await vscode.window.showTextDocument(doc);
    } catch (err: any) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Could not open chatLanguageModels.json: {0}", err.message || String(err)));
    }
  });

  register("showMenu", async () => {
    const items: (vscode.QuickPickItem & { run?: () => unknown })[] = [
      { label: `$(dashboard) ${vscode.l10n.t("Open Dashboard")}`, detail: vscode.l10n.t("Manage providers, verify models and choose what Copilot shows"), run: () => showDashboard() },
      { label: `$(file-code) ${vscode.l10n.t("Append to chatLanguageModels.json")}`, detail: vscode.l10n.t("Export providers and models to VS Code native Custom Endpoints"), run: () => vscode.commands.executeCommand(`${CMD}.appendToChatLanguageModels`) },
      { label: `$(go-to-file) ${vscode.l10n.t("Open chatLanguageModels.json")}`, detail: vscode.l10n.t("View or edit the native custom endpoints configuration file"), run: () => vscode.commands.executeCommand(`${CMD}.openChatLanguageModels`) },
      { label: `$(star) ${vscode.l10n.t("Curate Top 10 Models for Copilot")}`, detail: vscode.l10n.t("Keep Copilot's dropdown clean: pick top 10 fastest coding/reasoning models"), run: () => vscode.commands.executeCommand(`${CMD}.curateTop`) },
      { label: `$(clear-all) ${vscode.l10n.t("Deselect All Copilot Models")}`, detail: vscode.l10n.t("Clear all models from GitHub Copilot Chat dropdown"), run: () => vscode.commands.executeCommand(`${CMD}.deselectAll`) },
      { label: `$(split-horizontal) ${vscode.l10n.t("Auto-generate Recommended Routes")}`, detail: vscode.l10n.t("Create Fast Coding, Deep Reasoning, and Balanced routes"), run: () => vscode.commands.executeCommand(`${CMD}.autoRoutes`) },
      { label: `$(add) ${vscode.l10n.t("Add Provider")}`, run: () => showDashboard({ tab: "providers", addProvider: true }) },
      { label: `$(refresh) ${vscode.l10n.t("Refresh Models")}`, detail: vscode.l10n.t("Re-fetch the model list from every provider"), run: () => vscode.commands.executeCommand(`${CMD}.syncModels`) },
      { label: `$(beaker) ${vscode.l10n.t("Verify Untested Models")}`, run: () => vscode.commands.executeCommand(`${CMD}.testAllModels`) },
      { label: `$(list-tree) ${vscode.l10n.t("Show in Sidebar")}`, run: () => vscode.commands.executeCommand("llmRouter.providers.focus") },
      { label: `$(output) ${vscode.l10n.t("Show Logs")}`, run: () => log.show() },
    ];
    if (engine.isVerifying) items.splice(1, 0, { label: `$(debug-stop) ${vscode.l10n.t("Cancel Verification")}`, run: () => engine.cancelVerification() });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "LLM Router" });
    await pick?.run?.();
  });

  checkProxyConfiguration(log);

  // Providers whose key is missing on this machine (SecretStorage does not sync): ask once per session.
  const askedForKey = new Set<string>();
  context.subscriptions.push(
    engine.onDidChange(() => {
      for (const s of engine.getProviderStatuses()) {
        if (!s.needsKey || s.keySource !== "none" || askedForKey.has(s.name)) continue;
        askedForKey.add(s.name);
        const enter = vscode.l10n.t("Enter API Key");
        void vscode.window
          .showWarningMessage(vscode.l10n.t("{0} needs an API key on this machine. Keys are stored per machine and are not synced.", s.name), enter)
          .then((pick) => pick && vscode.commands.executeCommand(`${CMD}.setApiKey`, { kind: "provider", name: s.name }));
      }
    })
  );

  // Startup: never block activation on the network.
  void (async () => {
    await engine.migrateLegacySelection();
    await engine.refresh();
    await engine.pruneCache();
    await engine.reverifyExpiredSelection();
  })().catch((err) => log.error("[startup]", err));
}

/**
 * Requests go through Node's fetch, which only honours `http.proxy` while VS Code's
 * `http.fetchAdditionalSupport` is on (the default). Warn when a proxy is set but that is off.
 */
function checkProxyConfiguration(log: vscode.LogOutputChannel) {
  const http = vscode.workspace.getConfiguration("http");
  const proxy = http.get<string>("proxy") || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) return;
  if (http.get<boolean>("fetchAdditionalSupport") === false) {
    log.warn("[network] A proxy is configured but http.fetchAdditionalSupport is off, so model requests bypass the proxy.");
    const open = vscode.l10n.t("Open Setting");
    void vscode.window.showWarningMessage(vscode.l10n.t("LLM Router: a proxy is configured, but “http.fetchAdditionalSupport” is off, so model requests will not use it."), open).then((pick) => {
      if (pick) void vscode.commands.executeCommand("workbench.action.openSettings", "http.fetchAdditionalSupport");
    });
  } else {
    log.info("[network] Using VS Code proxy settings for model requests.");
  }
}

function renderStatusBar(item: vscode.StatusBarItem, engine: ModelEngine) {
  const statuses = engine.getProviderStatuses().filter((s) => s.enabled);
  const active = engine.getCopilotModels().length + engine.getRoutes().filter((r) => r.available).length;
  const offline = statuses.filter((s) => s.online === false);
  const progress = engine.verifyProgress;

  if (progress) item.text = `$(sync~spin) ${progress.done}/${progress.total}`;
  else if (!statuses.length) item.text = "$(hubot) LLM Router";
  else item.text = `$(hubot) ${active}${offline.length ? " $(warning)" : ""}`;

  item.backgroundColor = statuses.length && offline.length === statuses.length ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: [`${CMD}.openDashboard`, `${CMD}.addProvider`] };
  if (!statuses.length) {
    md.appendMarkdown(`${vscode.l10n.t("No providers configured.")}\n\n[$(add) ${vscode.l10n.t("Add a provider")}](command:${CMD}.addProvider)`);
  } else {
    md.appendMarkdown(`**LLM Router** — ${vscode.l10n.t("{0} model(s) in Copilot", active)}\n\n`);
    for (const s of statuses) {
      const icon = s.online === undefined ? "$(loading~spin)" : s.online ? "$(pass-filled)" : "$(error)";
      md.appendMarkdown(`${icon} ${s.name} — ${s.online === false ? s.error || "offline" : vscode.l10n.t("{0} models", s.modelCount)}  \n`);
    }
    md.appendMarkdown(`\n[$(dashboard) ${vscode.l10n.t("Open Dashboard")}](command:${CMD}.openDashboard)`);
  }
  item.tooltip = md;
}

export function deactivate() {}
