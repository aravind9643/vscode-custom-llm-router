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
function resolveConfigRoots(context) {
    const candidates = [];
    // 1. Current workspace folder(s)
    if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
            candidates.push(folder.uri.fsPath);
        }
    }
    // 2. Default project location if open elsewhere
    const defaultProject = "d:\\VSCodeCustomEndpointModels";
    if (!candidates.includes(defaultProject)) {
        candidates.push(defaultProject);
    }
    // 3. Extension path fallback
    if (!candidates.includes(context.extensionPath)) {
        candidates.push(context.extensionPath);
    }
    return candidates;
}
function findFileAcrossRoots(fileName, roots) {
    for (const root of roots) {
        const candidate = path.resolve(root, fileName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
function activate(context) {
    const configRoots = resolveConfigRoots(context);
    const primaryRoot = configRoots[0] || context.extensionPath;
    const engine = new modelEngine_1.ModelEngine(primaryRoot);
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
                vscode.window.showWarningMessage("No active models retrieved. Please verify that FreeLLMAPI (:31415) or OmniRoute (:20128) is running.");
                return;
            }
            const deployed = engine.deployToVSCode(providers);
            const totalModels = providers.reduce((acc, p) => acc + (p.models?.length || 0), 0);
            updateStatusBar(true, totalModels);
            vscode.window.showInformationMessage(`✅ Successfully synced ${totalModels} custom models to VS Code Insiders!`, "View Config").then((action) => {
                if (action === "View Config" && deployed[0]) {
                    openTargetDocument(deployed[0]);
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
        vscode.window.showInformationMessage(msg, "Sync Models", "Configure .env").then((act) => {
            if (act === "Sync Models") {
                vscode.commands.executeCommand("vscode-custom-llm-router.syncModels");
            }
            else if (act === "Configure .env") {
                vscode.commands.executeCommand("vscode-custom-llm-router.configureEnv");
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
    // 5. Command: Configure .env
    const configureEnvCommand = vscode.commands.registerCommand("vscode-custom-llm-router.configureEnv", async () => {
        const roots = resolveConfigRoots(context);
        let target = findFileAcrossRoots(".env", roots);
        if (!target) {
            // Find template or create one
            const example = findFileAcrossRoots(".env.example", roots);
            target = path.resolve(roots[0], ".env");
            if (example && fs.existsSync(example)) {
                fs.copyFileSync(example, target);
            }
            else {
                fs.writeFileSync(target, `# FreeLLMAPI (Local proxy / port 31415)\nFREELLMAPI_URL=http://127.0.0.1:31415\nFREELLMAPI_KEY=\nFREELLMAPI_VSCODE_SECRET=\${input:chat.lm.secret.50cd2a8f}\n\n# OmniRoute (Local routing bridge / port 20128)\nOMNIROUTE_URL=http://localhost:20128\nOMNIROUTE_KEY=\nOMNIROUTE_VSCODE_SECRET=\${input:chat.lm.secret.5048ce49}\n`, "utf8");
            }
        }
        openTargetDocument(target);
    });
    // 6. Command: Configure rules
    const configureRulesCommand = vscode.commands.registerCommand("vscode-custom-llm-router.configureRules", async () => {
        const roots = resolveConfigRoots(context);
        let target = findFileAcrossRoots("models.config.json", roots);
        if (!target) {
            target = path.resolve(roots[0], "models.config.json");
            fs.writeFileSync(target, JSON.stringify({
                blacklistPatterns: ["image", "inpainting", "pixel-art", "flux", "diffusion", "tts", "voice", "translat"],
                whitelistExactIds: ["auto", "auto/best-coding", "auto/best-fast", "auto/best-reasoning"],
            }, null, 2), "utf8");
        }
        openTargetDocument(target);
    });
    // 7. Master Menu
    const showMenuCommand = vscode.commands.registerCommand("vscode-custom-llm-router.showMenu", async () => {
        const options = [
            { label: "$(sync) Sync Models", detail: "Discover and deploy custom models into Copilot", id: "sync" },
            { label: "$(filter) Switch Profile", detail: "Filter by All, Coding, or Top-tier models", id: "profile" },
            { label: "$(pulse) Check Endpoints Status", detail: "Test connection to :31415 and :20128", id: "status" },
            { label: "$(gear) Configure .env Endpoints & Keys", detail: "Open .env to edit URLs and tokens", id: "env" },
            { label: "$(json) Open models.config.json Rules", detail: "Edit blacklist and whitelist patterns", id: "rules" },
        ];
        const chosen = await vscode.window.showQuickPick(options, {
            placeHolder: "Custom LLM Router Actions",
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
            vscode.commands.executeCommand("vscode-custom-llm-router.configureEnv");
        }
        else if (chosen.id === "rules") {
            vscode.commands.executeCommand("vscode-custom-llm-router.configureRules");
        }
    });
    context.subscriptions.push(syncCommand, statusCommand, selectProfileCommand, configureEnvCommand, configureRulesCommand, showMenuCommand);
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
async function openTargetDocument(filePath) {
    try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc, { preview: false });
    }
    catch (err) {
        vscode.window.showErrorMessage(`Could not open file: ${filePath} (${err.message})`);
    }
}
function deactivate() {
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}
//# sourceMappingURL=extension.js.map