import * as fs from "fs";
import * as path from "path";

export interface ModelRuleConfig {
  blacklistPatterns?: string[];
  whitelistExactIds?: string[];
  providers?: CustomProviderConfig[];
}

export interface CustomModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  vision?: boolean;
}

export interface CustomProviderConfig {
  name: string;
  endpointUrl: string; // e.g. "https://api.openai.com/v1" or "http://localhost:11434/v1"
  apiKey?: string;
  secretHandle?: string; // e.g. "${input:chat.lm.secret.custom}"
  modelsEndpoint?: string; // Optional custom endpoint for model discovery, defaults to endpointUrl/models
  chatEndpoint?: string; // Optional custom endpoint for chat, defaults to endpointUrl/chat/completions
  staticModels?: CustomModelConfig[]; // Static list of models if /v1/models is not available or user wants specific ones
  autoDiscover?: boolean; // Whether to fetch from /v1/models (defaults to true)
  enabled?: boolean; // Whether provider is active (defaults to true)
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
  providerName?: string;
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
  name: string;
  url: string;
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
  "gpt-4",
  "o1",
  "o3",
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

  /**
   * Loads all configured providers:
   * 1. Built-in defaults: FreeLLMAPI and OmniRoute (via env or defaults)
   * 2. Any additional custom providers declared in models.config.json under "providers"
   * 3. Any additional custom providers declared via env prefix CUSTOM_PROVIDER_*
   */
  public getConfiguredProviders(): CustomProviderConfig[] {
    const providers: CustomProviderConfig[] = [];

    // 1. FreeLLMAPI
    providers.push({
      name: "FreeLLMAPI",
      endpointUrl: this.freeLlmUrl,
      apiKey: this.freeLlmKey,
      secretHandle: this.freeLlmSecret,
      autoDiscover: true,
      enabled: true,
    });

    // 2. OmniRoute
    providers.push({
      name: "OmniRoute",
      endpointUrl: this.omniUrl,
      apiKey: this.omniKey,
      secretHandle: this.omniSecret,
      autoDiscover: true,
      enabled: true,
    });

    // 3. User configured providers from models.config.json
    const rules = this.loadRules();
    if (Array.isArray(rules.providers)) {
      for (const p of rules.providers) {
        if (!p.name || !p.endpointUrl) continue;
        // Avoid duplicate by name
        const existingIdx = providers.findIndex((ep) => ep.name.toLowerCase() === p.name.toLowerCase());
        if (existingIdx !== -1) {
          providers[existingIdx] = { ...providers[existingIdx], ...p };
        } else {
          providers.push({
            autoDiscover: p.autoDiscover !== false,
            enabled: p.enabled !== false,
            ...p,
          });
        }
      }
    }

    return providers.filter((p) => p.enabled !== false);
  }

  public async checkEndpoints(): Promise<{ freeLlm: EndpointStatus; omniRoute: EndpointStatus; all: EndpointStatus[] }> {
    const configured = this.getConfiguredProviders();
    const results: EndpointStatus[] = [];

    for (const prov of configured) {
      let status: EndpointStatus = {
        name: prov.name,
        url: prov.endpointUrl,
        online: false,
        modelCount: 0,
      };

      const modelsUrl = prov.modelsEndpoint || `${prov.endpointUrl.replace(/\/+$/, "")}/v1/models`;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (prov.apiKey) {
        headers["Authorization"] = `Bearer ${prov.apiKey}`;
      }

      try {
        const res = await fetch(modelsUrl, {
          headers,
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data: any = await res.json();
          const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
          status.online = true;
          status.modelCount = list.length + (prov.staticModels?.length || 0);
        } else {
          // If models endpoint failed but static models exist, check if chat endpoint responds
          if (prov.staticModels && prov.staticModels.length > 0) {
            status.online = true;
            status.modelCount = prov.staticModels.length;
          } else {
            status.online = false;
            status.error = `HTTP ${res.status}`;
          }
        }
      } catch (e: any) {
        if (prov.staticModels && prov.staticModels.length > 0) {
          status.online = true;
          status.modelCount = prov.staticModels.length;
        } else {
          status.online = false;
          status.error = e.message;
        }
      }
      results.push(status);
    }

    const freeLlm = results.find((r) => r.name === "FreeLLMAPI") || {
      name: "FreeLLMAPI",
      url: this.freeLlmUrl,
      online: false,
      modelCount: 0,
    };
    const omniRoute = results.find((r) => r.name === "OmniRoute") || {
      name: "OmniRoute",
      url: this.omniUrl,
      online: false,
      modelCount: 0,
    };

    return { freeLlm, omniRoute, all: results };
  }

  public prettifyModelName(id: string, rawName?: string, providerName?: string): string {
    if (rawName && rawName.trim().length > 0 && !rawName.startsWith("aihorde/")) {
      return rawName;
    }
    if (id === "auto") return `${providerName || "LLM"} Auto`;
    if (id === "fusion") return `${providerName || "LLM"} Fusion`;

    const parts = id.split("/");
    const prefix = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const base = parts[parts.length - 1];

    if (id.startsWith("auto/best-")) {
      const feat = id.replace("auto/best-", "");
      return `${providerName || "OmniRoute"} Best ${feat.charAt(0).toUpperCase() + feat.slice(1)}`;
    }
    if (id.startsWith("auto/pro-")) {
      const feat = id.replace("auto/pro-", "");
      return `${providerName || "OmniRoute"} Pro ${feat.charAt(0).toUpperCase() + feat.slice(1)}`;
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
      } else if (idLower.includes("gpt-4o") || idLower.includes("o1") || idLower.includes("o3")) {
        contextWindow = 128000;
        maxOutputTokens = maxOutputTokens || 16384;
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

  /**
   * Generates providers and models for all configured endpoints
   */
  public async generateProviders(options: GeneratorOptions = {}): Promise<VSCodeProvider[]> {
    const { profile = "all", onProgress } = options;
    const configured = this.getConfiguredProviders();
    const providers: VSCodeProvider[] = [];

    for (const prov of configured) {
      if (onProgress) onProgress(`Fetching models from ${prov.name}...`);
      
      const cleanEndpoint = prov.endpointUrl.replace(/\/+$/, "");
      const chatUrl = prov.chatEndpoint || `${cleanEndpoint}/v1/chat/completions`;
      const modelsUrl = prov.modelsEndpoint || `${cleanEndpoint}/v1/models`;

      let modelsRaw: any[] = [];

      if (prov.autoDiscover !== false) {
        try {
          const headers: Record<string, string> = { Accept: "application/json" };
          if (prov.apiKey) {
            headers["Authorization"] = `Bearer ${prov.apiKey}`;
          }

          const fetchUrl = prov.name === "FreeLLMAPI" ? `${modelsUrl}?execution_status=ready` : modelsUrl;
          const res = await fetch(fetchUrl, {
            headers,
            signal: AbortSignal.timeout(6000),
          });

          if (res.ok) {
            const d: any = await res.json();
            modelsRaw = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
          }
        } catch {
          // Fall back to static models if discovery fails
        }
      }

      const modelsList: VSCodeModel[] = [];

      // Add auto model for FreeLLMAPI if active
      if (prov.name === "FreeLLMAPI") {
        modelsList.push({
          id: "auto",
          name: "FreeLLMAPI Auto",
          url: chatUrl,
          toolCalling: true,
          vision: true,
          maxInputTokens: 128000,
          maxOutputTokens: 16000,
          providerName: prov.name,
        });
      }

      // Add static models defined by user
      if (Array.isArray(prov.staticModels)) {
        for (const sm of prov.staticModels) {
          const bounds = this.normalizeBounds(sm.id, sm.contextWindow, sm.maxOutputTokens, sm.maxInputTokens);
          modelsList.push({
            id: sm.id,
            name: sm.name || this.prettifyModelName(sm.id, undefined, prov.name),
            url: chatUrl,
            toolCalling: sm.toolCalling !== undefined ? sm.toolCalling : true,
            vision: sm.vision !== undefined ? sm.vision : false,
            maxInputTokens: bounds.maxInputTokens,
            maxOutputTokens: bounds.maxOutputTokens,
            contextWindow: bounds.contextWindow,
            providerName: prov.name,
          });
        }
      }

      // Process auto-discovered models
      for (const raw of modelsRaw) {
        const id = raw?.id || raw?.model;
        if (!id) continue;
        if (modelsList.some((existing) => existing.id === id)) continue; // avoid duplicate with staticModels

        const bounds = this.normalizeBounds(id, raw?.contextWindow || raw?.context_window, raw?.maxOutputTokens, raw?.maxInputTokens);
        modelsList.push({
          id,
          name: this.prettifyModelName(id, raw?.name, prov.name),
          url: chatUrl,
          toolCalling: raw?.toolCalling !== undefined ? Boolean(raw.toolCalling) : true,
          vision: Boolean(raw?.vision || raw?.supports_vision),
          maxInputTokens: bounds.maxInputTokens,
          maxOutputTokens: bounds.maxOutputTokens,
          contextWindow: bounds.contextWindow,
          providerName: prov.name,
        });
      }

      const filtered = this.filterModels(modelsList, profile);
      if (filtered.length > 0) {
        providers.push({
          name: prov.name,
          vendor: "customendpoint",
          apiKey: prov.secretHandle || prov.apiKey || "",
          apiType: "chat-completions",
          models: filtered,
        });
      }
    }

    return providers;
  }

  public getTargetPaths(): { name: string; chatModelsJson: string }[] {
    const targets: { name: string; chatModelsJson: string }[] = [];
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const appData = process.env.APPDATA;

    const candidates: { name: string; dir: string }[] = [];

    if (process.platform === "win32" && appData) {
      candidates.push(
        { name: "VS Code Insiders", dir: path.join(appData, "Code - Insiders", "User") },
        { name: "VS Code", dir: path.join(appData, "Code", "User") }
      );
    } else if (process.platform === "darwin" && home) {
      candidates.push(
        { name: "VS Code Insiders", dir: path.join(home, "Library", "Application Support", "Code - Insiders", "User") },
        { name: "VS Code", dir: path.join(home, "Library", "Application Support", "Code", "User") }
      );
    } else if (home) {
      // Linux / Unix
      candidates.push(
        { name: "VS Code Insiders", dir: path.join(home, ".config", "Code - Insiders", "User") },
        { name: "VS Code", dir: path.join(home, ".config", "Code", "User") }
      );
    }

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

    // Write local workspace file if in a writable directory
    try {
      const localFile = path.resolve(this.baseDir, "chatLanguageModels.json");
      fs.writeFileSync(localFile, jsonStr, "utf8");
      deployedPaths.push(localFile);
    } catch {}

    for (const t of targets) {
      try {
        fs.writeFileSync(t.chatModelsJson, jsonStr, "utf8");
        deployedPaths.push(t.chatModelsJson);
      } catch {}
    }
    return deployedPaths;
  }
}
