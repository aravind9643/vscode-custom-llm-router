import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ModelEngine } from "./modelEngine";
import { CustomLLMChatProvider } from "./customChatProvider";

let statusBarItem: vscode.StatusBarItem;

function resolveConfigRoots(context: vscode.ExtensionContext): string[] {
  const candidates: string[] = [];
  
  // 1. Current workspace folder(s)
  if (vscode.workspace.workspaceFolders) {
    for (const folder of vscode.workspace.workspaceFolders) {
      candidates.push(folder.uri.fsPath);
    }
  }

  // 2. Extension Global Storage directory (persists per user across workspaces)
  if (context.globalStorageUri) {
    const storagePath = context.globalStorageUri.fsPath;
    try {
      if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
      }
      candidates.push(storagePath);
    } catch {}
  }

  // 3. Extension path fallback
  if (!candidates.includes(context.extensionPath)) {
    candidates.push(context.extensionPath);
  }

  return candidates;
}

function findFileAcrossRoots(fileName: string, roots: string[]): string | undefined {
  for (const root of roots) {
    const candidate = path.resolve(root, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext) {
  const configRoots = resolveConfigRoots(context);
  const primaryRoot = configRoots[0] || context.extensionPath;
  const engine = new ModelEngine(primaryRoot);

  // Register Native Custom Model Provider for VS Code Chat & Copilot
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
  statusBarItem.tooltip = "Click to manage FreeLLMAPI & OmniRoute endpoints";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 2. Command: Sync Models
  const syncCommand = vscode.commands.registerCommand(
    "vscode-custom-llm-router.syncModels",
    async (profileArg?: "all" | "coding" | "top") => {
      const profile = profileArg || "all";
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Syncing LLM Models (${profile})...`,
          cancellable: false,
        },
        async (progress) => {
          engine.reloadConfig();
          progress.report({ message: "Discovering and filtering models..." });
          const providers = await engine.generateProviders({
            profile,
            onProgress: (m) => progress.report({ message: m }),
          });

          if (providers.length === 0) {
            vscode.window.showWarningMessage(
              "No active models found. Please configure an endpoint (e.g. Ollama, OpenRouter, FreeLLMAPI, OmniRoute) via 'Add Custom Model Provider' or 'Configure models.config.json & Providers'."
            );
            return;
          }

          const deployed = engine.deployToVSCode(providers);
          const totalModels = providers.reduce((acc, p) => acc + (p.models?.length || 0), 0);
          updateStatusBar(true, totalModels);

          // Refresh native model provider
          customChatProvider.notifyModelsChanged();

          vscode.window.showInformationMessage(
            `✅ Successfully synced ${totalModels} custom models to VS Code Chat & Custom Model Provider!`,
            "View Config"
          ).then((action) => {
            if (action === "View Config" && deployed[0]) {
              openTargetDocument(deployed[0]);
            }
          });
        }
      );
    }
  );

  // 3. Command: Check Status
  const statusCommand = vscode.commands.registerCommand("vscode-custom-llm-router.checkStatus", async () => {
    engine.reloadConfig();
    const status = await engine.checkEndpoints();
    const lines = status.all.map((s) => {
      const icon = s.online ? "✅ ONLINE" : "❌ OFFLINE";
      const err = s.error ? ` [${s.error}]` : "";
      return `${s.name} (${s.url}): ${icon} (${s.modelCount} models)${err}`;
    });

    vscode.window.showInformationMessage(lines.join("\n"), "Sync Models", "Configure Providers").then((act) => {
      if (act === "Sync Models") {
        vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
      } else if (act === "Configure Providers") {
        vscode.commands.executeCommand("vscode-custom-llm-router.configureRules");
      }
    });
  });

  // 4. Command: Select Profile
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
      placeHolder: "Select which model profile to deploy to VS Code Copilot",
    });

    if (pick) {
      vscode.commands.executeCommand("vscode-custom-llm-router.syncModels", pick.profile);
    }
  });

  // 5. Command: Configure .env
  const configureEnvCommand = vscode.commands.registerCommand("vscode-custom-llm-router.configureEnv", async () => {
    const roots = resolveConfigRoots(context);
    let target = findFileAcrossRoots(".env", roots);

    if (!target) {
      const example = findFileAcrossRoots(".env.example", roots);
      target = path.resolve(roots[0], ".env");
      if (example && fs.existsSync(example)) {
        fs.copyFileSync(example, target);
      } else {
        fs.writeFileSync(
          target,
          `# FreeLLMAPI (Local proxy / port 31415)\nFREELLMAPI_URL=http://127.0.0.1:31415\nFREELLMAPI_KEY=\nFREELLMAPI_VSCODE_SECRET=\${input:chat.lm.secret.50cd2a8f}\n\n# OmniRoute (Local routing bridge / port 20128)\nOMNIROUTE_URL=http://localhost:20128\nOMNIROUTE_KEY=\nOMNIROUTE_VSCODE_SECRET=\${input:chat.lm.secret.5048ce49}\n`,
          "utf8"
        );
      }
    }

    openTargetDocument(target);
  });

  // 6. Command: Configure rules & Custom Providers
  const configureRulesCommand = vscode.commands.registerCommand("vscode-custom-llm-router.configureRules", async () => {
    const roots = resolveConfigRoots(context);
    let target = findFileAcrossRoots("models.config.json", roots);

    if (!target) {
      target = path.resolve(roots[0], "models.config.json");
      fs.writeFileSync(
        target,
        JSON.stringify(
          {
            blacklistPatterns: ["image", "inpainting", "pixel-art", "flux", "diffusion", "tts", "voice", "translat"],
            whitelistExactIds: ["auto", "auto/best-coding", "auto/best-fast", "auto/best-reasoning"],
            providers: [
              {
                name: "Ollama Local",
                endpointUrl: "http://localhost:11434",
                apiKey: "",
                autoDiscover: true,
                enabled: false,
              },
              {
                name: "OpenAI Official",
                endpointUrl: "https://api.openai.com",
                apiKey: "${env:OPENAI_API_KEY}",
                autoDiscover: false,
                enabled: false,
                staticModels: [
                  { id: "gpt-4o", name: "GPT-4o (Omni)", contextWindow: 128000, maxOutputTokens: 16384 },
                  { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000, maxOutputTokens: 16384 },
                ],
              },
            ],
          },
          null,
          2
        ),
        "utf8"
      );
    }

    openTargetDocument(target);
  });

  // 7. Command: Add New Custom Provider (Interactive Wizard)
  const addProviderCommand = vscode.commands.registerCommand("vscode-custom-llm-router.addProvider", async () => {
    const name = await vscode.window.showInputBox({
      title: "Add Custom Model Provider (1/3)",
      prompt: "Enter provider name (e.g. Ollama, OpenRouter, DeepSeek, Local Server)",
      placeHolder: "My Custom Provider",
    });
    if (!name) return;

    const endpointUrl = await vscode.window.showInputBox({
      title: "Add Custom Model Provider (2/3)",
      prompt: "Enter base URL of OpenAI-compatible endpoint",
      placeHolder: "http://localhost:11434 or https://api.openai.com",
    });
    if (!endpointUrl) return;

    const apiKey = await vscode.window.showInputBox({
      title: "Add Custom Model Provider (3/3)",
      prompt: "Enter API Key (optional - leave blank for local servers like Ollama)",
      placeHolder: "sk-... or leave empty",
    });

    const roots = resolveConfigRoots(context);
    let target = findFileAcrossRoots("models.config.json", roots) || path.resolve(roots[0], "models.config.json");

    let currentConfig: any = { blacklistPatterns: [], whitelistExactIds: [], providers: [] };
    if (fs.existsSync(target)) {
      try {
        currentConfig = JSON.parse(fs.readFileSync(target, "utf8"));
      } catch {}
    }
    if (!Array.isArray(currentConfig.providers)) {
      currentConfig.providers = [];
    }

    currentConfig.providers.push({
      name,
      endpointUrl,
      apiKey: apiKey || "",
      autoDiscover: true,
      enabled: true,
    });

    fs.writeFileSync(target, JSON.stringify(currentConfig, null, 2), "utf8");
    vscode.window.showInformationMessage(
      `✅ Added custom provider "${name}"! Syncing models now...`,
      "View Config"
    ).then((act) => {
      if (act === "View Config") openTargetDocument(target);
    });

    vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
  });

  // 8. Master Menu
  const showMenuCommand = vscode.commands.registerCommand("vscode-custom-llm-router.showMenu", async () => {
    const options = [
      { label: "$(sync) Sync Models", detail: "Discover and stream custom models directly in Copilot", id: "sync" },
      { label: "$(plus) Add Custom Provider", detail: "Configure new endpoint, API key, and models interactively", id: "add" },
      { label: "$(filter) Switch Profile", detail: "Filter by All, Coding, or Top-tier models", id: "profile" },
      { label: "$(pulse) Check Endpoints Status", detail: "Test connection across all configured endpoints", id: "status" },
      { label: "$(gear) Configure models.config.json & Providers", detail: "Edit providers list, endpoints, API keys, and model rules", id: "rules" },
      { label: "$(key) Configure .env Endpoints & Keys", detail: "Edit default FreeLLMAPI and OmniRoute keys", id: "env" },
    ];

    const chosen = await vscode.window.showQuickPick(options, {
      placeHolder: "Custom LLM Router Actions",
    });

    if (!chosen) return;

    if (chosen.id === "sync") {
      vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
    } else if (chosen.id === "add") {
      vscode.commands.executeCommand("vscode-custom-llm-router.addProvider");
    } else if (chosen.id === "profile") {
      vscode.commands.executeCommand("vscode-custom-llm-router.selectProfile");
    } else if (chosen.id === "status") {
      vscode.commands.executeCommand("vscode-custom-llm-router.checkStatus");
    } else if (chosen.id === "rules") {
      vscode.commands.executeCommand("vscode-custom-llm-router.configureRules");
    } else if (chosen.id === "env") {
      vscode.commands.executeCommand("vscode-custom-llm-router.configureEnv");
    }
  });

  context.subscriptions.push(
    syncCommand,
    statusCommand,
    selectProfileCommand,
    configureEnvCommand,
    configureRulesCommand,
    addProviderCommand,
    showMenuCommand
  );

  // Background health check on launch
  engine.checkEndpoints().then((status) => {
    const onlineCount = status.all.filter((s) => s.online).length;
    const totalCount = status.all.length;
    if (onlineCount > 0) {
      statusBarItem.text = `$(hubot) LLM Router (${onlineCount}/${totalCount})`;
    } else {
      statusBarItem.text = `$(hubot) LLM Router $(warning)`;
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

async function openTargetDocument(filePath: string) {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (err: any) {
    vscode.window.showErrorMessage(`Could not open file: ${filePath} (${err.message})`);
  }
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
