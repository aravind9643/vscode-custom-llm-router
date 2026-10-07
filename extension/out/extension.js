"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const modelEngine_1 = require("./modelEngine");
const customChatProvider_1 = require("./customChatProvider");
let statusBarItem;
function activate(context) {
    const engine = new modelEngine_1.ModelEngine();
    // Load configuration from standard VS Code extension settings (workspace/global)
    function refreshEngineFromSettings() {
        const config = vscode.workspace.getConfiguration("customLlmRouter");
        const providers = config.get("providers") || [];
        const blacklist = config.get("blacklistPatterns") || [];
        const whitelist = config.get("whitelistExactIds") || [];
        engine.updateConfig(providers, blacklist, whitelist);
    }
    // Initial load
    refreshEngineFromSettings();
    // Watch for configuration changes in VS Code settings
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("customLlmRouter")) {
            refreshEngineFromSettings();
            customChatProvider.notifyModelsChanged();
            updateHealthStatus(engine);
        }
    }));
    // Register Native Custom Model Provider for VS Code Chat & Copilot
    const customChatProvider = new customChatProvider_1.CustomLLMChatProvider(engine);
    try {
        const providerRegistration = vscode.lm.registerLanguageModelChatProvider("custom-llm-router", customChatProvider);
        context.subscriptions.push(providerRegistration);
    }
    catch (err) {
        console.warn("[Custom LLM Router] Native LanguageModelChatProvider registration notice:", err);
    }
    // 1. Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "vscode-custom-llm-router.showMenu";
    statusBarItem.text = "$(hubot) LLM Router";
    statusBarItem.tooltip = "Click to manage Custom LLM Providers";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // 2. Command: Sync Models
    const syncCommand = vscode.commands.registerCommand("vscode-custom-llm-router.syncModels", async (profileArg) => {
        const profile = profileArg || "all";
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Discovering Custom LLM Models (${profile})...`,
            cancellable: false,
        }, async (progress) => {
            refreshEngineFromSettings();
            progress.report({ message: "Discovering and filtering models..." });
            const providers = await engine.generateProviders({
                profile,
                onProgress: (m) => progress.report({ message: m }),
            });
            const totalModels = providers.reduce((acc, p) => acc + (p.models?.length || 0), 0);
            updateStatusBar(totalModels > 0, totalModels);
            // Refresh native model provider
            customChatProvider.notifyModelsChanged();
            if (providers.length === 0) {
                vscode.window.showWarningMessage("No active models found. Please add an endpoint (e.g. Ollama, OpenRouter, FreeLLMAPI) via 'Add Custom Model Provider' or Settings.", "Add Provider", "Open Settings").then((action) => {
                    if (action === "Add Provider")
                        vscode.commands.executeCommand("vscode-custom-llm-router.addProvider");
                    else if (action === "Open Settings")
                        vscode.commands.executeCommand("vscode-custom-llm-router.openSettings");
                });
                return;
            }
            vscode.window.showInformationMessage(`✅ Successfully refreshed ${totalModels} custom models across ${providers.length} provider(s)!`);
        });
    });
    // 3. Command: Check Status
    const statusCommand = vscode.commands.registerCommand("vscode-custom-llm-router.checkStatus", async () => {
        refreshEngineFromSettings();
        const status = await engine.checkEndpoints();
        if (status.all.length === 0) {
            vscode.window.showInformationMessage("No providers configured yet. Click 'Add Custom Provider' to configure your first endpoint.", "Add Provider").then((act) => {
                if (act === "Add Provider")
                    vscode.commands.executeCommand("vscode-custom-llm-router.addProvider");
            });
            return;
        }
        const lines = status.all.map((s) => {
            const icon = s.online ? "✅ ONLINE" : "❌ OFFLINE";
            const err = s.error ? ` [${s.error}]` : "";
            return `${s.name} (${s.url}): ${icon} (${s.modelCount} models)${err}`;
        });
        vscode.window.showInformationMessage(lines.join("\n"), "Add Provider", "Manage Providers").then((act) => {
            if (act === "Add Provider") {
                vscode.commands.executeCommand("vscode-custom-llm-router.addProvider");
            }
            else if (act === "Manage Providers") {
                vscode.commands.executeCommand("vscode-custom-llm-router.manageProviders");
            }
        });
    });
    // 4. Command: Select Profile
    const selectProfileCommand = vscode.commands.registerCommand("vscode-custom-llm-router.selectProfile", async () => {
        const items = [
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
    // 5. Command: Add New Custom Provider (Interactive Wizard)
    const addProviderCommand = vscode.commands.registerCommand("vscode-custom-llm-router.addProvider", async () => {
        const name = await vscode.window.showInputBox({
            title: "Add Custom Model Provider (1/3)",
            prompt: "Enter provider display name",
            placeHolder: "e.g. Ollama Local, OpenRouter, DeepSeek, FreeLLMAPI, OmniRoute",
        });
        if (!name)
            return;
        const endpointUrl = await vscode.window.showInputBox({
            title: "Add Custom Model Provider (2/3)",
            prompt: "Enter base URL of OpenAI-compatible endpoint",
            placeHolder: "e.g. http://localhost:11434, http://localhost:20128, https://api.openai.com",
        });
        if (!endpointUrl)
            return;
        const apiKey = await vscode.window.showInputBox({
            title: "Add Custom Model Provider (3/3)",
            prompt: "Enter API Key (optional - leave empty for local servers without auth)",
            placeHolder: "sk-... or leave blank",
        });
        const config = vscode.workspace.getConfiguration("customLlmRouter");
        const existing = config.get("providers") || [];
        // Add or update provider
        const updated = [...existing.filter((p) => p.name.toLowerCase() !== name.toLowerCase()), {
                name,
                endpointUrl,
                apiKey: apiKey || "",
                autoDiscover: true,
                enabled: true,
            }];
        await config.update("providers", updated, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`✅ Added provider "${name}"! Models are now available in Copilot.`, "Test Connection").then((act) => {
            if (act === "Test Connection")
                vscode.commands.executeCommand("vscode-custom-llm-router.checkStatus");
        });
        vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
    });
    // 6. Command: Manage Providers (Toggle / Delete)
    const manageProvidersCommand = vscode.commands.registerCommand("vscode-custom-llm-router.manageProviders", async () => {
        const config = vscode.workspace.getConfiguration("customLlmRouter");
        const providers = config.get("providers") || [];
        if (providers.length === 0) {
            vscode.window.showInformationMessage("No providers configured yet.", "Add Provider").then((act) => {
                if (act === "Add Provider")
                    vscode.commands.executeCommand("vscode-custom-llm-router.addProvider");
            });
            return;
        }
        const items = providers.map((p) => ({
            label: `${p.enabled !== false ? "$(check)" : "$(x)"} ${p.name}`,
            description: p.endpointUrl,
            detail: p.enabled !== false ? "Status: Enabled" : "Status: Disabled",
            provider: p,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: "Select a provider to toggle or remove",
        });
        if (!picked)
            return;
        const action = await vscode.window.showQuickPick([
            { label: picked.provider.enabled !== false ? "$(circle-slash) Disable Provider" : "$(check) Enable Provider", id: "toggle" },
            { label: "$(trash) Remove Provider", id: "delete" },
        ], { placeHolder: `Action for ${picked.provider.name}` });
        if (!action)
            return;
        if (action.id === "toggle") {
            picked.provider.enabled = picked.provider.enabled === false ? true : false;
            await config.update("providers", providers, vscode.ConfigurationTarget.Global);
            vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
        }
        else if (action.id === "delete") {
            const remaining = providers.filter((p) => p.name !== picked.provider.name);
            await config.update("providers", remaining, vscode.ConfigurationTarget.Global);
            vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
            vscode.window.showInformationMessage(`Removed provider "${picked.provider.name}".`);
        }
    });
    // 7. Command: Open Settings UI
    const openSettingsCommand = vscode.commands.registerCommand("vscode-custom-llm-router.openSettings", () => {
        vscode.commands.executeCommand("workbench.action.openSettings", "customLlmRouter");
    });
    // 8. Master Menu
    const showMenuCommand = vscode.commands.registerCommand("vscode-custom-llm-router.showMenu", async () => {
        const options = [
            { label: "$(sync) Sync Models", detail: "Scan configured endpoints and update Copilot models", id: "sync" },
            { label: "$(plus) Add Custom Provider", detail: "Interactive wizard to add an OpenAI-compatible endpoint", id: "add" },
            { label: "$(list-unordered) Manage Providers", detail: "Enable, disable, or delete configured providers", id: "manage" },
            { label: "$(filter) Switch Profile", detail: "Filter by All, Coding, or Top-tier models", id: "profile" },
            { label: "$(pulse) Check Endpoints Status", detail: "Probe connectivity and model counts across endpoints", id: "status" },
            { label: "$(gear) Extension Settings", detail: "Open VS Code settings for Custom LLM Router", id: "settings" },
        ];
        const chosen = await vscode.window.showQuickPick(options, {
            placeHolder: "Custom LLM Router Actions",
        });
        if (!chosen)
            return;
        if (chosen.id === "sync") {
            vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
        }
        else if (chosen.id === "add") {
            vscode.commands.executeCommand("vscode-custom-llm-router.addProvider");
        }
        else if (chosen.id === "manage") {
            vscode.commands.executeCommand("vscode-custom-llm-router.manageProviders");
        }
        else if (chosen.id === "profile") {
            vscode.commands.executeCommand("vscode-custom-llm-router.selectProfile");
        }
        else if (chosen.id === "status") {
            vscode.commands.executeCommand("vscode-custom-llm-router.checkStatus");
        }
        else if (chosen.id === "settings") {
            vscode.commands.executeCommand("vscode-custom-llm-router.openSettings");
        }
    });
    context.subscriptions.push(syncCommand, statusCommand, selectProfileCommand, addProviderCommand, manageProvidersCommand, openSettingsCommand, showMenuCommand);
    // Background health check on launch
    updateHealthStatus(engine);
}
function updateHealthStatus(engine) {
    engine.checkEndpoints().then((status) => {
        const onlineCount = status.all.filter((s) => s.online).length;
        const totalCount = status.all.length;
        if (totalCount === 0) {
            statusBarItem.text = `$(hubot) LLM Router`;
            statusBarItem.tooltip = "Click to add a Custom Model Provider";
        }
        else if (onlineCount > 0) {
            statusBarItem.text = `$(hubot) LLM Router (${onlineCount}/${totalCount})`;
            statusBarItem.tooltip = `${onlineCount} of ${totalCount} providers online. Click for menu.`;
        }
        else {
            statusBarItem.text = `$(hubot) LLM Router $(warning)`;
            statusBarItem.tooltip = "All configured providers are offline. Click to check status.";
        }
    });
}
function updateStatusBar(online, count) {
    if (online) {
        statusBarItem.text = `$(check) LLM Router (${count})`;
    }
    else {
        statusBarItem.text = `$(hubot) LLM Router $(alert)`;
    }
}
function deactivate() {
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}
//# sourceMappingURL=extension.js.map