import * as fs from "fs";
import * as path from "path";

export interface ModelRuleConfig {
  blacklistPatterns?: string[];
  whitelistExactIds?: string[];
}

export interface VSCodeModel {
  id: string;
  name: string;
  url: string;
  toolCalling?: boolean;
  vision?: boolean;
  thinking?: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  contextWindow?: number;
  _latency?: number;
}

export interface VSCodeProvider {
  name: string;
  vendor: "customendpoint";
  apiKey: string;
  apiType: "chat-completions";
  models: VSCodeModel[];
}

export interface GeneratorOptions {
  skipTest?: boolean;
  profile?: "all" | "coding" | "top";
  verifyTools?: boolean;
  forceRefresh?: boolean;
  onProgress?: (msg: string) => void;
}

export interface EndpointStatus {
  online: boolean;
  modelCount: number;
  error?: string;
}

const TOP_MODEL_KEYWORDS = [
  "claude-3-7",
  "claude-3.7",
  "claude-3-5",
  "claude-3.5",
  "gpt-4o",
  "deepseek-r1",
  "deepseek-v3",
  "qwen-2.5-coder",
  "qwen2.5-coder",
  "gemini-2.5",
  "gemini-2.0",
  "auto/best-coding",
  "auto/pro-coding",
  "auto/best-fast",
  "auto/best-reasoning",
  "auto/pro-reasoning",
  "auto/best-vision",
  "auto/pro-vision",
  "auto/best-chat",
  "auto/best-free",
];

const CODING_MODEL_KEYWORDS = [
  "coder",
  "coding",
  "code",
  "dev",
  "claude",
  "gpt-4",
  "deepseek",
  "qwen",
];

export class ModelEngine {
  public baseDir: string;
  public freeLlmUrl: string;
  public freeLlmKey: string;
  public freeLlmSecret: string;
  public omniUrl: string;
  public omniKey: string;
  public omniSecret: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.loadEnv();
    this.freeLlmUrl = process.env.FREELLMAPI_URL || "http://127.0.0.1:31415";
    this.freeLlmKey = process.env.FREELLMAPI_KEY || "";
    this.freeLlmSecret = process.env.FREELLMAPI_VSCODE_SECRET || "${input:chat.lm.secret.50cd2a8f}";

    this.omniUrl = process.env.OMNIROUTE_URL || "http://localhost:20128";
    this.omniKey = process.env.OMNIROUTE_KEY || process.env.OMNIROUTE_API_KEY || "";
    this.omniSecret = process.env.OMNIROUTE_VSCODE_SECRET || "${input:chat.lm.secret.5048ce49}";
  }

  public reloadConfig(): void {
    this.loadEnv();
    this.freeLlmUrl = process.env.FREELLMAPI_URL || "http://127.0.0.1:31415";
    this.freeLlmKey = process.env.FREELLMAPI_KEY || "";
    this.freeLlmSecret = process.env.FREELLMAPI_VSCODE_SECRET || "${input:chat.lm.secret.50cd2a8f}";

    this.omniUrl = process.env.OMNIROUTE_URL || "http://localhost:20128";
    this.omniKey = process.env.OMNIROUTE_KEY || process.env.OMNIROUTE_API_KEY || "";
    this.omniSecret = process.env.OMNIROUTE_VSCODE_SECRET || "${input:chat.lm.secret.5048ce49}";
  }

  private loadEnv(): void {
    const envPath = path.resolve(this.baseDir, ".env");
    if (!fs.existsSync(envPath)) return;
    try {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    } catch {}
  }

  public async checkEndpoints(): Promise<{ freeLlm: EndpointStatus; omniRoute: EndpointStatus }> {
    let freeStatus: EndpointStatus = { online: false, modelCount: 0 };
    try {
      const res = await fetch(`${this.freeLlmUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${this.freeLlmKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data: any = await res.json();
        freeStatus = { online: true, modelCount: Array.isArray(data?.data) ? data.data.length : 0 };
      } else {
        freeStatus = { online: false, modelCount: 0, error: `HTTP ${res.status}` };
      }
    } catch (e: any) {
      freeStatus = { online: false, modelCount: 0, error: e.message };
    }

    let omniStatus: EndpointStatus = { online: false, modelCount: 0 };
    try {
      const res = await fetch(`${this.omniUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${this.omniKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data: any = await res.json();
        omniStatus = { online: true, modelCount: Array.isArray(data?.data) ? data.data.length : 0 };
      } else {
        omniStatus = { online: false, modelCount: 0, error: `HTTP ${res.status}` };
      }
    } catch (e: any) {
      omniStatus = { online: false, modelCount: 0, error: e.message };
    }

    return { freeLlm: freeStatus, omniRoute: omniStatus };
  }

  public prettifyModelName(id: string, rawName?: string): string {
    if (id === "auto") return "FreeLLMAPI Auto";
    if (id === "fusion") return "FreeLLMAPI Fusion";

    const parts = id.split("/");
    const prefix = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const base = parts[parts.length - 1];

    if (id.startsWith("auto/best-")) {
      const feat = id.replace("auto/best-", "");
      return `OmniRoute Best ${feat.charAt(0).toUpperCase() + feat.slice(1)}`;
    }
    if (id.startsWith("auto/pro-")) {
      const feat = id.replace("auto/pro-", "");
      return `OmniRoute Pro ${feat.charAt(0).toUpperCase() + feat.slice(1)}`;
    }

    let name = base
      .replace(/^meta-llama-|^llama-/, "Llama ")
      .replace(/^deepseek-ai-|^deepseek-/, "DeepSeek ")
      .replace(/^qwen-|^qwen/, "Qwen ")
      .replace(/^claude-/, "Claude ")
      .replace(/^gpt-/, "GPT-")
      .replace(/^gemini-/, "Gemini ")
      .replace(/^mistral-/, "Mistral ")
      .replace(/^nemotron-/, "Nemotron ")
      .replace(/-instruct|-it/i, " Instruct")
      .replace(/-/g, " ")
      .trim();

    name = name.replace(/\b\w/g, (c) => c.toUpperCase());
    if (prefix.includes("no-think")) {
      name += " (Fast/Direct)";
    } else if (prefix && !prefix.startsWith("auto")) {
      name += ` (${prefix})`;
    }
    return name;
  }

  public normalizeBounds(modelId: string, rawCtx?: number, rawMaxOut?: number, rawMaxIn?: number) {
    const idLower = modelId.toLowerCase();
    let contextWindow = rawCtx;
    let maxOutputTokens = rawMaxOut;
    let maxInputTokens = rawMaxIn;

    if (!contextWindow) {
      if (idLower.includes("claude-3-7") || idLower.includes("claude-3-5")) {
        contextWindow = 200000;
        maxOutputTokens = maxOutputTokens || 64000;
      } else if (idLower.includes("deepseek-r1") || idLower.includes("deepseek-v3") || idLower.includes("qwen")) {
        contextWindow = 131072;
        maxOutputTokens = maxOutputTokens || 16384;
      } else if (idLower.includes("gemini")) {
        contextWindow = 1048576;
        maxOutputTokens = maxOutputTokens || 65536;
      } else {
        contextWindow = 131072;
        maxOutputTokens = maxOutputTokens || 16000;
      }
    }
    if (!maxOutputTokens) maxOutputTokens = 16000;
    if (!maxInputTokens) {
      maxInputTokens = Math.max(1000, contextWindow - maxOutputTokens);
    }
    return { contextWindow, maxOutputTokens, maxInputTokens };
  }

  public loadRules(): ModelRuleConfig {
    const configPath = path.resolve(this.baseDir, "models.config.json");
    if (!fs.existsSync(configPath)) {
      return { blacklistPatterns: [], whitelistExactIds: [] };
    }
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      return { blacklistPatterns: [], whitelistExactIds: [] };
    }
  }

  public filterModels(models: VSCodeModel[], profile: string = "all"): VSCodeModel[] {
    const rules = this.loadRules();
    const blacklist = rules.blacklistPatterns || [];
    const whitelist = new Set(rules.whitelistExactIds || []);

    let filtered = models.filter((m) => {
      if (whitelist.has(m.id)) return true;
      const idLower = m.id.toLowerCase();
      return !blacklist.some((pat) => idLower.includes(pat.toLowerCase()));
    });

    if (profile === "top") {
      return filtered.filter((m) => {
        if (m.id === "auto" || m.id.startsWith("auto/best-") || m.id.startsWith("auto/pro-")) return true;
        const idLower = m.id.toLowerCase();
        return TOP_MODEL_KEYWORDS.some((kw) => idLower.includes(kw));
      });
    }

    if (profile === "coding") {
      return filtered.filter((m) => {
        if (m.id === "auto" || m.id.includes("coding")) return true;
        const idLower = m.id.toLowerCase();
        return CODING_MODEL_KEYWORDS.some((kw) => idLower.includes(kw));
      });
    }

    return filtered;
  }

  public async generateProviders(options: GeneratorOptions = {}): Promise<VSCodeProvider[]> {
    const { profile = "all", onProgress } = options;
    const providers: VSCodeProvider[] = [];

    // 1. FreeLLMAPI
    if (onProgress) onProgress("Fetching models from FreeLLMAPI...");
    let freeModelsRaw: any[] = [];
    try {
      const res = await fetch(`${this.freeLlmUrl}/v1/models?execution_status=ready`, {
        headers: { Authorization: `Bearer ${this.freeLlmKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const d: any = await res.json();
        freeModelsRaw = Array.isArray(d?.data) ? d.data : [];
      }
    } catch {}

    const freeChatUrl = `${this.freeLlmUrl}/v1/chat/completions`;
    const freeModelsList: VSCodeModel[] = [];

    freeModelsList.push({
      id: "auto",
      name: "FreeLLMAPI Auto",
      url: freeChatUrl,
      toolCalling: true,
      vision: true,
      maxInputTokens: 128000,
      maxOutputTokens: 16000,
    });

    for (const raw of freeModelsRaw) {
      const id = raw?.id || raw?.model;
      if (!id || id === "auto") continue;
      const bounds = this.normalizeBounds(id, raw?.contextWindow || raw?.context_window, raw?.maxOutputTokens, raw?.maxInputTokens);
      freeModelsList.push({
        id,
        name: this.prettifyModelName(id, raw?.name),
        url: freeChatUrl,
        toolCalling: Boolean(raw?.toolCalling || raw?.tool_calling),
        vision: Boolean(raw?.vision || raw?.supports_vision),
        maxInputTokens: bounds.maxInputTokens,
        maxOutputTokens: bounds.maxOutputTokens,
        contextWindow: bounds.contextWindow,
      });
    }

    const filteredFree = this.filterModels(freeModelsList, profile);
    if (filteredFree.length > 0) {
      providers.push({
        name: "FreeLLMAPI",
        vendor: "customendpoint",
        apiKey: this.freeLlmSecret,
        apiType: "chat-completions",
        models: filteredFree,
      });
    }

    // 2. OmniRoute
    if (onProgress) onProgress("Fetching models from OmniRoute...");
    let omniModelsRaw: any[] = [];
    try {
      const res = await fetch(`${this.omniUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${this.omniKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const d: any = await res.json();
        omniModelsRaw = Array.isArray(d?.data) ? d.data : [];
      }
    } catch {}

    const omniChatUrl = `${this.omniUrl}/v1/chat/completions`;
    const omniModelsList: VSCodeModel[] = [];

    for (const raw of omniModelsRaw) {
      const id = raw?.id || raw?.model;
      if (!id) continue;
      const bounds = this.normalizeBounds(id, raw?.contextWindow || raw?.context_window, raw?.maxOutputTokens, raw?.maxInputTokens);
      omniModelsList.push({
        id,
        name: this.prettifyModelName(id, raw?.name),
        url: omniChatUrl,
        toolCalling: raw?.toolCalling !== undefined ? Boolean(raw.toolCalling) : true,
        vision: Boolean(raw?.vision || raw?.supports_vision),
        maxInputTokens: bounds.maxInputTokens,
        maxOutputTokens: bounds.maxOutputTokens,
        contextWindow: bounds.contextWindow,
      });
    }

    const filteredOmni = this.filterModels(omniModelsList, profile);
    if (filteredOmni.length > 0) {
      providers.push({
        name: "OmniRoute",
        vendor: "customendpoint",
        apiKey: this.omniSecret,
        apiType: "chat-completions",
        models: filteredOmni,
      });
    }

    return providers;
  }

  public getTargetPaths(): { name: string; chatModelsJson: string }[] {
    const appData = process.env.APPDATA;
    if (!appData) return [];
    const targets = [];
    const candidates = [
      { name: "VS Code Insiders", dir: path.join(appData, "Code - Insiders", "User") },
      { name: "VS Code Stable", dir: path.join(appData, "Code", "User") },
    ];
    for (const c of candidates) {
      if (fs.existsSync(c.dir)) {
        targets.push({
          name: c.name,
          chatModelsJson: path.join(c.dir, "chatLanguageModels.json"),
        });
      }
    }
    return targets;
  }

  public deployToVSCode(providers: VSCodeProvider[]): string[] {
    const targets = this.getTargetPaths();
    const deployedPaths: string[] = [];
    const jsonStr = JSON.stringify(providers, null, 4) + "\n";

    // Also write local workspace file
    const localFile = path.resolve(this.baseDir, "chatLanguageModels.json");
    fs.writeFileSync(localFile, jsonStr, "utf8");
    deployedPaths.push(localFile);

    for (const t of targets) {
      try {
        fs.writeFileSync(t.chatModelsJson, jsonStr, "utf8");
        deployedPaths.push(t.chatModelsJson);
      } catch {}
    }
    return deployedPaths;
  }
}
