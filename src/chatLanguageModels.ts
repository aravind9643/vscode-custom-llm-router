import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ModelEngine, slug } from "./modelEngine";
import { ProviderStore } from "./providerStore";
import { resolveChatUrl, resolveApi } from "./endpoints";
import { ProviderConfig } from "./types";

export interface ChatLMModelEntry {
  id: string;
  name: string;
  url: string;
  toolCalling?: boolean;
  vision?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  requestHeaders?: Record<string, string>;
}

export interface ChatLMProviderGroup {
  name: string;
  vendor: "customendpoint";
  apiKey?: string;
  apiType?: "chat-completions" | "messages" | "responses";
  models: ChatLMModelEntry[];
  [key: string]: unknown;
}

/**
 * Resolves the path to VS Code's user `chatLanguageModels.json` file.
 */
export function getChatLanguageModelsPath(context: vscode.ExtensionContext): string {
  // Primary location: two levels up from globalStorageUri (<UserDataDir>/User/chatLanguageModels.json)
  const fromStorage = path.resolve(context.globalStorageUri.fsPath, "../../chatLanguageModels.json");
  if (fs.existsSync(fromStorage)) {
    return fromStorage;
  }

  // Check known platform candidate locations
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(
        path.join(appData, "Code - Insiders", "User", "chatLanguageModels.json"),
        path.join(appData, "Code", "User", "chatLanguageModels.json"),
        path.join(appData, "Cursor", "User", "chatLanguageModels.json"),
        path.join(appData, "VSCodium", "User", "chatLanguageModels.json")
      );
    }
  } else if (process.platform === "darwin") {
    const home = process.env.HOME;
    if (home) {
      candidates.push(
        path.join(home, "Library", "Application Support", "Code - Insiders", "User", "chatLanguageModels.json"),
        path.join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json"),
        path.join(home, "Library", "Application Support", "Cursor", "User", "chatLanguageModels.json")
      );
    }
  } else {
    const home = process.env.HOME;
    if (home) {
      candidates.push(
        path.join(home, ".config", "Code - Insiders", "User", "chatLanguageModels.json"),
        path.join(home, ".config", "Code", "User", "chatLanguageModels.json"),
        path.join(home, ".config", "Cursor", "User", "chatLanguageModels.json")
      );
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // If none exists yet, prefer fromStorage if its directory exists, otherwise first existing candidate parent
  const parent = path.dirname(fromStorage);
  if (fs.existsSync(parent)) {
    return fromStorage;
  }
  for (const c of candidates) {
    if (fs.existsSync(path.dirname(c))) {
      return c;
    }
  }

  return fromStorage;
}

/**
 * Builds the provider groups formatted for VS Code's native `chatLanguageModels.json`.
 */
export async function buildChatLanguageModelsExport(
  engine: ModelEngine,
  store: ProviderStore,
  options?: { copilotOnly?: boolean }
): Promise<ChatLMProviderGroup[]> {
  const groups: ChatLMProviderGroup[] = [];
  const providers = store.getEnabledProviders();
  const copilotModels = engine.getCopilotModels();
  const allModels = engine.getModels();

  for (const p of providers) {
    // Select models for this provider:
    // If copilotOnly is not explicitly false, use selected Copilot models first;
    // fall back to working models, or all discovered models if none verified yet.
    let providerModels = copilotModels.filter((m) => m.providerName === p.name);
    if (!providerModels.length && options?.copilotOnly === false) {
      const working = allModels.filter((m) => m.providerName === p.name && m.status === "working");
      providerModels = working.length ? working : allModels.filter((m) => m.providerName === p.name);
    }
    if (!providerModels.length) {
      const working = allModels.filter((m) => m.providerName === p.name && m.status === "working");
      providerModels = working.length ? working : allModels.filter((m) => m.providerName === p.name);
    }

    if (!providerModels.length) continue;

    const auth = await store.getAuth(p);
    const status = engine.getProviderStatuses().find((s) => s.name === p.name);
    const api = status?.api ?? resolveApi(p, status?.kind || "openai");
    const apiType: "chat-completions" | "messages" = api === "anthropic" ? "messages" : "chat-completions";
    const chatUrl = api === "anthropic" ? "https://api.anthropic.com/v1/messages" : resolveChatUrl(p);

    const modelEntries: ChatLMModelEntry[] = providerModels.map((m) => {
      const sub = m.subProvider && m.subProvider.toLowerCase() !== p.name.toLowerCase() ? m.subProvider : undefined;
      const displayName = sub ? `[${sub}] ${m.name}` : m.name;
      const entry: ChatLMModelEntry = {
        id: m.id,
        name: displayName,
        url: chatUrl,
        toolCalling: Boolean(m.caps?.tools),
        vision: Boolean(m.caps?.vision),
        maxInputTokens: m.maxInputTokens || m.contextWindow || 128000,
        maxOutputTokens: m.maxOutputTokens || 4096,
      };

      // Add non-secret request headers if configured
      if (p.headers && Object.keys(p.headers).length) {
        entry.requestHeaders = { ...p.headers };
      }

      return entry;
    });

    // Determine apiKey: if secret/stored exists use it, otherwise placeholder reference
    const apiKey = auth.apiKey || (p.apiKey ? p.apiKey : "");

    groups.push({
      name: p.name,
      vendor: "customendpoint",
      ...(apiKey ? { apiKey } : {}),
      apiType,
      models: modelEntries,
    });
  }

  return groups;
}

/**
 * Appends or updates providers and models inside `chatLanguageModels.json`.
 * Preserves existing custom entries created by the user or other tools.
 */
export async function appendOrSyncChatLanguageModels(
  context: vscode.ExtensionContext,
  engine: ModelEngine,
  store: ProviderStore,
  options?: { copilotOnly?: boolean; targetPath?: string }
): Promise<{ filePath: string; addedProviders: number; updatedProviders: number; totalModels: number }> {
  const filePath = options?.targetPath || getChatLanguageModelsPath(context);

  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  let existing: ChatLMProviderGroup[] = [];
  if (fs.existsSync(filePath)) {
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        existing = parsed;
      }
    } catch {
      existing = [];
    }
  }

  const newGroups = await buildChatLanguageModelsExport(engine, store, options);
  let addedProviders = 0;
  let updatedProviders = 0;
  let totalModels = 0;

  for (const group of newGroups) {
    totalModels += group.models.length;
    // Find matching group by name (case-insensitive)
    const idx = existing.findIndex((g) => g.name && g.name.toLowerCase() === group.name.toLowerCase());
    if (idx >= 0) {
      const current = existing[idx];
      // Keep existing apiKey if current uses secret placeholder and group doesn't have an explicit key
      const finalApiKey = current.apiKey && (current.apiKey.startsWith("${") || !group.apiKey)
        ? current.apiKey
        : (group.apiKey || current.apiKey);

      // Merge models
      const modelMap = new Map<string, ChatLMModelEntry>();
      for (const m of current.models || []) {
        modelMap.set(m.id, m);
      }
      for (const m of group.models) {
        modelMap.set(m.id, m);
      }

      existing[idx] = {
        ...current,
        vendor: "customendpoint",
        ...(finalApiKey ? { apiKey: finalApiKey } : {}),
        apiType: group.apiType || current.apiType || "chat-completions",
        models: Array.from(modelMap.values()),
      };
      updatedProviders++;
    } else {
      existing.push(group);
      addedProviders++;
    }
  }

  const jsonStr = JSON.stringify(existing, null, 2) + "\n";
  await fs.promises.writeFile(filePath, jsonStr, "utf-8");

  return { filePath, addedProviders, updatedProviders, totalModels };
}
