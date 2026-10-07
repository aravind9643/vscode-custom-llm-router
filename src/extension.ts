import * as vscode from "vscode";
import { ModelEngine, CustomProviderConfig } from "./modelEngine";
import { CustomLLMChatProvider } from "./customChatProvider";
import { ConfigWebviewPanel } from "./configWebview";

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const engine = new ModelEngine();

  function refreshEngineFromSettings() {
    const config = vscode.workspace.getConfiguration("customLlmRouter");
    const providers = config.get<CustomProviderConfig[]>("providers") || [];
    const blacklist = config.get<string[]>("blacklistPatterns") || [];
    const whitelist = config.get<string[]>("whitelistExactIds") || [];
    engine.updateConfig(providers, blacklist, whitelist);
  }

  refreshEngineFromSettings();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("customLlmRouter")) {
        refreshEngineFromSettings();
        customChatProvider.notifyModelsChanged();
        updateHealthStatus(engine);
      }
    })
  );

  const customChatProvider = new CustomLLMChatProvider(engine);
  try {
    const providerRegistration = vscode.lm.registerLanguageModelChatProvider(
      "custom-llm-router",
      customChatProvider
    );
    context.subscriptions.push(providerRegistration);
  } catch (err) {
    console.warn("[Custom LLM Router] Native LanguageModelChatProvider registration notice:", err);
  }

  // 1. Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "vscode-custom-llm-router.showMenu";
  statusBarItem.text = "$(hubot) LLM Router";
  statusBarItem.tooltip = "Click to open Custom LLM Router Dashboard";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 2. Command: Open Dashboard (Custom dedicated webview page)
  const openDashboardCommand = vscode.commands.registerCommand(
    "vscode-custom-llm-router.openDashboard",
    () => {
      ConfigWebviewPanel.createOrShow(engine);
    }
  );

  // 3. Command: Sync Models
  const syncCommand = vscode.commands.registerCommand(
    "vscode-custom-llm-router.syncModels",
    async (profileArg?: "all" | "coding" | "top") => {
      const profile = profileArg || "all";
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Discovering Custom LLM Models (${profile})...`,
          cancellable: false,
        },
        async (progress) => {
          refreshEngineFromSettings();
          progress.report({ message: "Discovering and filtering models..." });
          const providers = await engine.generateProviders({
            profile,
            onProgress: (m) => progress.report({ message: m }),
          });

          const totalModels = providers.reduce((acc, p) => acc + (p.models?.length || 0), 0);
          updateStatusBar(totalModels > 0, totalModels);
          customChatProvider.notifyModelsChanged();

          if (providers.length === 0) {
            vscode.window.showWarningMessage(
              "No active models found. Please configure an endpoint in the Dashboard.",
              "Open Dashboard"
            ).then((action) => {
              if (action === "Open Dashboard") vscode.commands.executeCommand("vscode-custom-llm-router.openDashboard");
            });
            return;
          }

          vscode.window.showInformationMessage(
            `Successfully refreshed ${totalModels} custom models across ${providers.length} provider(s)!`
          );
        }
      );
    }
  );

  // 4. Command: Check Status
  const statusCommand = vscode.commands.registerCommand("vscode-custom-llm-router.checkStatus", async () => {
    refreshEngineFromSettings();
    const outputChannel = vscode.window.createOutputChannel("Custom LLM Router Status");
    outputChannel.show();
    outputChannel.appendLine(`=== Custom LLM Router: Endpoints Status ===`);
    outputChannel.appendLine(`Time: ${new Date().toISOString()}\n`);

    const status = await engine.checkEndpoints();
    for (const ep of status.all) {
      if (ep.online) {
        outputChannel.appendLine(`[ONLINE] ${ep.name} (${ep.url}) - ${ep.modelCount} models ready`);
      } else {
        outputChannel.appendLine(`[OFFLINE] ${ep.name} (${ep.url}) - Error: ${ep.error || "Unreachable"}`);
      }
    }
    outputChannel.appendLine(`\nTip: Run 'Custom LLM Router: Open Configuration Dashboard' to manage endpoints.`);
  });

  // 5. Command: Switch Profile
  const selectProfileCommand = vscode.commands.registerCommand("vscode-custom-llm-router.selectProfile", async () => {
    const items: (vscode.QuickPickItem & { profile: "all" | "coding" | "top" })[] = [
      {
        label: "$(sparkle) All Models",
        description: "Deploy complete catalog from all enabled providers",
        profile: "all",
      },
      {
        label: "$(code) Coding Only",
        description: "Specialized coding/developer models (Claude, Qwen-Coder, DeepSeek, etc.)",
        profile: "coding",
      },
      {
        label: "$(rocket) Top Tier",
        description: "Premier flagship models only (Claude 3.7, GPT-4o, DeepSeek R1/V3, etc.)",
        profile: "top",
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select which model profile to make available in VS Code Copilot",
    });

    if (pick) {
      vscode.commands.executeCommand("vscode-custom-llm-router.syncModels", pick.profile);
    }
  });

  // 6. Direct shortcuts that open the Dashboard
  const addProviderCommand = vscode.commands.registerCommand("vscode-custom-llm-router.addProvider", () => {
    vscode.commands.executeCommand("vscode-custom-llm-router.openDashboard");
  });

  const manageProvidersCommand = vscode.commands.registerCommand("vscode-custom-llm-router.manageProviders", () => {
    vscode.commands.executeCommand("vscode-custom-llm-router.openDashboard");
  });

  const openSettingsCommand = vscode.commands.registerCommand("vscode-custom-llm-router.openSettings", () => {
    vscode.commands.executeCommand("workbench.action.openSettings", "customLlmRouter");
  });

  // 7. Master Menu
  const showMenuCommand = vscode.commands.registerCommand("vscode-custom-llm-router.showMenu", async () => {
    const options = [
      { label: "$(dashboard) Open Dashboard", detail: "Dedicated configuration page for providers, live tests & models catalog", id: "dashboard" },
      { label: "$(sync) Sync Models", detail: "Scan configured endpoints and update Copilot models", id: "sync" },
      { label: "$(filter) Switch Profile", detail: "Filter by All, Coding, or Top-tier models", id: "profile" },
      { label: "$(pulse) Check Endpoints Status", detail: "Probe connectivity and model counts across endpoints", id: "status" },
      { label: "$(gear) Extension Settings", detail: "Open raw VS Code settings for Custom LLM Router", id: "settings" },
    ];

    const chosen = await vscode.window.showQuickPick(options, {
      placeHolder: "Custom LLM Router Actions",
    });

    if (!chosen) return;

    if (chosen.id === "dashboard") {
      vscode.commands.executeCommand("vscode-custom-llm-router.openDashboard");
    } else if (chosen.id === "sync") {
      vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
    } else if (chosen.id === "profile") {
      vscode.commands.executeCommand("vscode-custom-llm-router.selectProfile");
    } else if (chosen.id === "status") {
      vscode.commands.executeCommand("vscode-custom-llm-router.checkStatus");
    } else if (chosen.id === "settings") {
      vscode.commands.executeCommand("vscode-custom-llm-router.openSettings");
    }
  });

  context.subscriptions.push(
    openDashboardCommand,
    syncCommand,
    statusCommand,
    selectProfileCommand,
    addProviderCommand,
    manageProvidersCommand,
    openSettingsCommand,
    showMenuCommand
  );

  updateHealthStatus(engine);
}

function updateHealthStatus(engine: ModelEngine) {
  engine.checkEndpoints().then((status) => {
    const onlineCount = status.all.filter((s) => s.online).length;
    const totalCount = status.all.length;
    if (totalCount === 0) {
      statusBarItem.text = `$(hubot) LLM Router`;
      statusBarItem.tooltip = "Click to configure Custom Model Providers";
    } else if (onlineCount > 0) {
      statusBarItem.text = `$(hubot) LLM Router (${onlineCount}/${totalCount})`;
      statusBarItem.tooltip = `${onlineCount} of ${totalCount} providers online. Click for Dashboard.`;
    } else {
      statusBarItem.text = `$(hubot) LLM Router $(warning)`;
      statusBarItem.tooltip = "All configured providers are offline. Click to open Dashboard.";
    }
  });
}

function updateStatusBar(online: boolean, count: number) {
  if (online) {
    statusBarItem.text = `$(check) LLM Router (${count})`;
  } else {
    statusBarItem.text = `$(hubot) LLM Router $(alert)`;
  }
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
