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
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const modelEngine_1 = require("./modelEngine");
let statusBarItem;
function activate(context) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || context.extensionPath;
    const engine = new modelEngine_1.ModelEngine(workspaceRoot);
    // 1. Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "vscode-custom-llm-router.showMenu";
    statusBarItem.text = "$(hubot) LLM Router";
    statusBarItem.tooltip = "Click to manage FreeLLMAPI & OmniRoute endpoints";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // 2. Command: Sync Models
    const syncCommand = vscode.commands.registerCommand("vscode-custom-llm-router.syncModels", async (profileArg) => {
        const profile = profileArg || "all";
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Syncing LLM Models (${profile})...`,
            cancellable: false,
        }, async (progress) => {
            engine.reloadConfig();
            progress.report({ message: "Discovering and filtering models..." });
            const providers = await engine.generateProviders({
                profile,
                onProgress: (m) => progress.report({ message: m }),
            });
            if (providers.length === 0) {
                vscode.window.showWarningMessage("No active models retrieved. Is OmniRoute or FreeLLMAPI running?");
                return;
            }
            const deployed = engine.deployToVSCode(providers);
            const totalModels = providers.reduce((acc, p) => acc + (p.models?.length || 0), 0);
            updateStatusBar(true, totalModels);
            vscode.window.showInformationMessage(`✅ Successfully synced ${totalModels} custom models to VS Code Insiders!`, "View Config").then((action) => {
                if (action === "View Config" && deployed[0]) {
                    vscode.workspace.openTextDocument(deployed[0]).then((doc) => {
                        vscode.window.showTextDocument(doc);
                    });
                }
            });
        });
    });
    // 3. Command: Check Status
    const statusCommand = vscode.commands.registerCommand("vscode-custom-llm-router.checkStatus", async () => {
        engine.reloadConfig();
        const status = await engine.checkEndpoints();
        const freeIcon = status.freeLlm.online ? "✅ ONLINE" : "❌ OFFLINE";
        const omniIcon = status.omniRoute.online ? "✅ ONLINE" : "❌ OFFLINE";
        const msg = [
            `FreeLLMAPI (${engine.freeLlmUrl}): ${freeIcon} (${status.freeLlm.modelCount} models)`,
            `OmniRoute (${engine.omniUrl}): ${omniIcon} (${status.omniRoute.modelCount} models)`,
        ].join("\n");
        vscode.window.showInformationMessage(msg, "Sync Models", "Configure Endpoints").then((act) => {
            if (act === "Sync Models") {
                vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
            }
            else if (act === "Configure Endpoints") {
                openEnvFile(workspaceRoot);
            }
        });
    });
    // 4. Command: Select Profile
    const selectProfileCommand = vscode.commands.registerCommand("vscode-custom-llm-router.selectProfile", async () => {
        const items = [
            {
                label: "$(sparkle) All Models",
                description: "Deploy complete catalog (~90+ models)",
                profile: "all",
            },
            {
                label: "$(code) Coding Only",
                description: "Specialized coding/developer models (~24 models)",
                profile: "coding",
            },
            {
                label: "$(rocket) Top Tier",
                description: "Premier flagship models only (~14 models)",
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
    // 5. Command: Show Master Menu
    const showMenuCommand = vscode.commands.registerCommand("vscode-custom-llm-router.showMenu", async () => {
        const options = [
            { label: "$(sync) Sync Models (Fast)", id: "sync" },
            { label: "$(filter) Switch Profile (All / Coding / Top)", id: "profile" },
            { label: "$(pulse) Check Endpoints Status", id: "status" },
            { label: "$(gear) Configure .env Endpoints & Keys", id: "env" },
            { label: "$(json) Open models.config.json Rules", id: "rules" },
        ];
        const chosen = await vscode.window.showQuickPick(options, {
            placeHolder: "VS Code Custom LLM Router Actions",
        });
        if (!chosen)
            return;
        if (chosen.id === "sync") {
            vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
        }
        else if (chosen.id === "profile") {
            vscode.commands.executeCommand("vscode-custom-llm-router.selectProfile");
        }
        else if (chosen.id === "status") {
            vscode.commands.executeCommand("vscode-custom-llm-router.checkStatus");
        }
        else if (chosen.id === "env") {
            openEnvFile(workspaceRoot);
        }
        else if (chosen.id === "rules") {
            openConfigFile(workspaceRoot);
        }
    });
    context.subscriptions.push(syncCommand, statusCommand, selectProfileCommand, showMenuCommand);
    // Background health check on launch
    engine.checkEndpoints().then((status) => {
        const totalOnline = (status.freeLlm.online ? 1 : 0) + (status.omniRoute.online ? 1 : 0);
        if (totalOnline > 0) {
            statusBarItem.text = `$(hubot) LLM Router (${totalOnline}/2)`;
        }
        else {
            statusBarItem.text = `$(hubot) LLM Router $(warning)`;
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
function openEnvFile(root) {
    const envPath = path.resolve(root, ".env");
    if (!fs.existsSync(envPath)) {
        const example = path.resolve(root, ".env.example");
        if (fs.existsSync(example)) {
            fs.copyFileSync(example, envPath);
        }
    }
    vscode.workspace.openTextDocument(envPath).then((doc) => {
        vscode.window.showTextDocument(doc);
    });
}
function openConfigFile(root) {
    const configPath = path.resolve(root, "models.config.json");
    vscode.workspace.openTextDocument(configPath).then((doc) => {
        vscode.window.showTextDocument(doc);
    });
}
function deactivate() {
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}
//# sourceMappingURL=extension.js.map