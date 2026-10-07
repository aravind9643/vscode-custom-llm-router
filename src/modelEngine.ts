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
  endpointUrl: string; // e.g. "http://localhost:11434" or "https://api.openai.com"
  apiKey?: string;
  modelsEndpoint?: string;
  chatEndpoint?: string;
  staticModels?: CustomModelConfig[];
  autoDiscover?: boolean;
  enabled?: boolean;
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
  _verifiedWorking?: boolean;
}

export interface VSCodeProvider {
  name: string;
  vendor: "customendpoint";
  apiKey: string;
  apiType: "chat-completions";
  models: VSCodeModel[];
}

export interface ModelTestResult {
  modelId: string;
  providerName: string;
  working: boolean;
  status: number;
  latency: number;
  verifiedTools?: boolean;
  error?: string;
  reply?: string;
  testedAt: number;
}

export interface VerifiedCacheEntry {
  modelId: string;
  providerName: string;
  working: boolean;
  latency: number;
  verifiedTools?: boolean;
  testedAt: number;
}

export interface VerifiedCacheStore {
  updatedAt: number;
  entries: Record<string, VerifiedCacheEntry>; // key: `${providerName}::${modelId}`
}

export interface GeneratorOptions {
  profile?: "all" | "coding" | "top";
  onlyVerifiedWorking?: boolean;
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

const CACHE_TTL_MS = 48 * 60 * 60 * 1000; // 48 Hours

export class ModelEngine {
  private _providers: CustomProviderConfig[] = [];
  private _blacklistPatterns: string[] = [
    "image",
    "inpainting",
    "pixel-art",
    "flux",
    "diffusion",
    "tts",
    "voice",
    "translat",
    "whisper",
    "safety",
  ];
  private _whitelistExactIds: string[] = [
    "auto",
    "auto/best-coding",
    "auto/best-fast",
    "auto/best-reasoning",
    "auto/best-vision",
    "auto/best-chat",
    "auto/best-free",
  ];

  // In-memory / GlobalState Verified Cache
  private _verifiedCache: VerifiedCacheStore = {
    updatedAt: 0,
    entries: {},
  };

  private _memento?: { get: <T>(k: string, def?: T) => T; update: (k: string, v: any) => Thenable<void> };

  constructor(memento?: { get: <T>(k: string, def?: T) => T; update: (k: string, v: any) => Thenable<void> }) {
    this._memento = memento;
    this.loadCache();
  }

  public setMemento(memento: { get: <T>(k: string, def?: T) => T; update: (k: string, v: any) => Thenable<void> }) {
    this._memento = memento;
    this.loadCache();
  }

  public loadCache(): void {
    if (this._memento) {
      const stored = this._memento.get<VerifiedCacheStore>("customLlmRouter.verifiedCache", {
        updatedAt: 0,
        entries: {},
      });
      // Auto-prune entries older than 48 hours
      const now = Date.now();
      const prunedEntries: Record<string, VerifiedCacheEntry> = {};
      for (const [key, item] of Object.entries(stored.entries || {})) {
        if (now - item.testedAt < CACHE_TTL_MS) {
          prunedEntries[key] = item;
        }
      }
      this._verifiedCache = {
        updatedAt: stored.updatedAt || now,
        entries: prunedEntries,
      };
    }
  }

  public async saveCache(): Promise<void> {
    this._verifiedCache.updatedAt = Date.now();
    if (this._memento) {
      await this._memento.update("customLlmRouter.verifiedCache", this._verifiedCache);
    }
  }

  public async clearCache(): Promise<void> {
    this._verifiedCache = { updatedAt: Date.now(), entries: {} };
    if (this._memento) {
      await this._memento.update("customLlmRouter.verifiedCache", this._verifiedCache);
    }
  }

  public getCacheEntry(providerName: string, modelId: string): VerifiedCacheEntry | undefined {
    const key = `${providerName}::${modelId}`;
    const entry = this._verifiedCache.entries[key];
    if (!entry) return undefined;
    if (Date.now() - entry.testedAt > CACHE_TTL_MS) {
      delete this._verifiedCache.entries[key];
      return undefined;
    }
    return entry;
  }

  public async setCacheEntry(entry: VerifiedCacheEntry): Promise<void> {
    const key = `${entry.providerName}::${entry.modelId}`;
    this._verifiedCache.entries[key] = entry;
    await this.saveCache();
  }

  public getAllCacheEntries(): VerifiedCacheEntry[] {
    return Object.values(this._verifiedCache.entries);
  }

  public updateConfig(providers: CustomProviderConfig[]) {
    this._providers = providers || [];
  }

  public reloadConfig(): void {
    this.loadCache();
  }

  public getConfiguredProviders(): CustomProviderConfig[] {
    return this._providers.filter(
      (p) => p.enabled !== false && p.endpointUrl && p.endpointUrl.trim().length > 0
    );
  }

  // Live test for a single model with retry logic
  public async testSingleModel(
    provider: CustomProviderConfig,
    modelId: string,
    verifyTools: boolean = false
  ): Promise<ModelTestResult> {
    const cleanEndpoint = provider.endpointUrl.replace(/\/+$/, "");
    const chatUrl = provider.chatEndpoint || `${cleanEndpoint}/v1/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;

    let lastResult: ModelTestResult = {
      modelId,
      providerName: provider.name,
      working: false,
      status: 0,
      latency: 0,
      testedAt: Date.now(),
    };

    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const start = Date.now();
      try {
        const res = await fetch(chatUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: "Reply with exactly OK." }],
            max_tokens: 5,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(12000),
        });

        const latency = Date.now() - start;
        const text = await res.text();

        if (res.ok) {
          let data: any;
          try {
            data = JSON.parse(text);
          } catch {
            lastResult = {
              modelId,
              providerName: provider.name,
              working: false,
              status: res.status,
              latency,
              error: "Invalid JSON response",
              testedAt: Date.now(),
            };
            continue;
          }

          if (!Array.isArray(data?.choices) || !data.choices[0]) {
            lastResult = {
              modelId,
              providerName: provider.name,
              working: false,
              status: res.status,
              latency,
              error: "No choices returned in payload",
              testedAt: Date.now(),
            };
            continue;
          }

          let toolsOk: boolean | undefined = undefined;
          if (verifyTools) {
            toolsOk = await this.verifyToolCalling(chatUrl, provider.apiKey, modelId);
          }

          const workingResult: ModelTestResult = {
            modelId,
            providerName: provider.name,
            working: true,
            status: res.status,
            latency,
            verifiedTools: toolsOk,
            reply: data.choices[0]?.message?.content || "",
            testedAt: Date.now(),
          };

          // Cache verified result
          await this.setCacheEntry({
            modelId,
            providerName: provider.name,
            working: true,
            latency,
            verifiedTools: toolsOk,
            testedAt: Date.now(),
          });

          return workingResult;
        }

        lastResult = {
          modelId,
          providerName: provider.name,
          working: false,
          status: res.status,
          latency,
          error: text.slice(0, 150),
          testedAt: Date.now(),
        };

        if (res.status >= 400 && res.status < 500) {
          break; // Client error, do not retry
        }
      } catch (err: any) {
        lastResult = {
          modelId,
          providerName: provider.name,
          working: false,
          status: 0,
          latency: Date.now() - start,
          error: err.name === "AbortError" ? "Timeout" : err.message,
          testedAt: Date.now(),
        };
      }
    }

    // Cache negative result
    await this.setCacheEntry({
      modelId,
      providerName: provider.name,
      working: false,
      latency: lastResult.latency,
      testedAt: Date.now(),
    });

    return lastResult;
  }

  // Tool-calling verification (prevents VS Code Copilot crashes)
  public async verifyToolCalling(chatUrl: string, apiKey: string | undefined, modelId: string): Promise<boolean> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    try {
      const res = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "What is 2+2?" }],
          tools: [
            {
              type: "function",
              function: {
                name: "calculator",
                description: "Calculate mathematical expression",
                parameters: {
                  type: "object",
                  properties: { expr: { type: "string" } },
                  required: ["expr"],
                },
              },
            },
          ],
          tool_choice: "auto",
          max_tokens: 15,
        }),
        signal: AbortSignal.timeout(8000),
      });

      return res.ok;
    } catch {
      return false;
    }
  }

  // Concurrent verification pool for discovering and testing all working models
  public async verifyAllModels(
    options: {
      concurrency?: number;
      forceRecheck?: boolean;
      verifyTools?: boolean;
      onProgress?: (tested: number, total: number, currentModel: string, ok: boolean) => void;
    } = {}
  ): Promise<ModelTestResult[]> {
    const { concurrency = 5, forceRecheck = false, verifyTools = false, onProgress } = options;
    const allProviders = await this.generateProviders({ profile: "all" });

    const modelsToTest: { provider: CustomProviderConfig; modelId: string }[] = [];
    const configuredList = this.getConfiguredProviders();

    for (const prov of allProviders) {
      const origConfig = configuredList.find((p) => p.name === prov.name) || {
        name: prov.name,
        endpointUrl: "",
        apiKey: prov.apiKey,
      };

      for (const m of prov.models) {
        modelsToTest.push({ provider: origConfig, modelId: m.id });
      }
    }

    const total = modelsToTest.length;
    const results: ModelTestResult[] = [];
    let nextIndex = 0;
    let completedCount = 0;

    const worker = async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= total) break;

        const item = modelsToTest[idx];
        const cached = !forceRecheck ? this.getCacheEntry(item.provider.name, item.modelId) : undefined;

        let res: ModelTestResult;
        if (cached) {
          res = {
            modelId: cached.modelId,
            providerName: cached.providerName,
            working: cached.working,
            status: cached.working ? 200 : 0,
            latency: cached.latency,
            verifiedTools: cached.verifiedTools,
            testedAt: cached.testedAt,
          };
        } else {
          res = await this.testSingleModel(item.provider, item.modelId, verifyTools);
        }

        results.push(res);
        completedCount++;

        if (onProgress) {
          onProgress(completedCount, total, `${item.provider.name}: ${item.modelId}`, res.working);
        }
      }
    };

    const workerCount = Math.min(concurrency, total || 1);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    return results;
  }

  public async checkEndpoints(): Promise<{ all: EndpointStatus[] }> {
    const configured = this.getConfiguredProviders();
    const results: EndpointStatus[] = [];

    for (const prov of configured) {
      const status: EndpointStatus = {
        name: prov.name,
        url: prov.endpointUrl,
        online: false,
        modelCount: 0,
      };

      const cleanEndpoint = prov.endpointUrl.replace(/\/+$/, "");
      const modelsUrl =
        prov.modelsEndpoint ||
        (prov.name === "FreeLLMAPI"
          ? `${cleanEndpoint}/v1/models?execution_status=ready`
          : `${cleanEndpoint}/v1/models`);
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

    return { all: results };
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
      } else if (
        idLower.includes("deepseek-r1") ||
        idLower.includes("deepseek-v3") ||
        idLower.includes("qwen")
      ) {
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

  public filterModels(
    models: VSCodeModel[],
    profile: string = "all",
    onlyVerifiedWorking: boolean = false
  ): VSCodeModel[] {
    const blacklist = this._blacklistPatterns;
    const whitelist = new Set(this._whitelistExactIds);

    let filtered = models.filter((m) => {
      // 1. Strictly exclude any model that is verified as offline/failed
      const cache = this.getCacheEntry(m.providerName || '', m.id);
      if (cache && cache.working === false) {
        return false;
      }
      if (m._verifiedWorking === false) {
        return false;
      }

      // 2. If onlyVerifiedWorking mode is active, exclude models that haven't been tested yet
      if (onlyVerifiedWorking && (!cache || cache.working !== true)) {
        return false;
      }

      if (whitelist.has(m.id)) return true;
      const idLower = m.id.toLowerCase();
      return !blacklist.some((pat) => idLower.includes(pat.toLowerCase()));
    });

    if (profile === "top") {
      return filtered.filter((m) => {
        if (m.id === "auto" || m.id.startsWith("auto/best-") || m.id.startsWith("auto/pro-"))
          return true;
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
    const { profile = "all", onlyVerifiedWorking = false, onProgress } = options;
    const configured = this.getConfiguredProviders();
    const providers: VSCodeProvider[] = [];

    for (const prov of configured) {
      if (onProgress) onProgress(`Fetching models from ${prov.name}...`);

      const cleanEndpoint = prov.endpointUrl.replace(/\/+$/, "");
      const chatUrl = prov.chatEndpoint || `${cleanEndpoint}/v1/chat/completions`;
      const modelsUrl =
        prov.modelsEndpoint ||
        (prov.name === "FreeLLMAPI"
          ? `${cleanEndpoint}/v1/models?execution_status=ready`
          : `${cleanEndpoint}/v1/models`);

      let modelsRaw: any[] = [];

      if (prov.autoDiscover !== false) {
        try {
          const headers: Record<string, string> = { Accept: "application/json" };
          if (prov.apiKey) {
            headers["Authorization"] = `Bearer ${prov.apiKey}`;
          }

          const res = await fetch(modelsUrl, {
            headers,
            signal: AbortSignal.timeout(6000),
          });

          if (res.ok) {
            const d: any = await res.json();
            modelsRaw = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
          }
        } catch {
          // ignore network error
        }
      }

      const modelsList: VSCodeModel[] = [];

      // Add auto model for FreeLLMAPI if active
      if (prov.name === "FreeLLMAPI") {
        const cache = this.getCacheEntry(prov.name, "auto");
        modelsList.push({
          id: "auto",
          name: "FreeLLMAPI Auto",
          url: chatUrl,
          toolCalling: true,
          vision: true,
          maxInputTokens: 128000,
          maxOutputTokens: 16000,
          providerName: prov.name,
          _latency: cache?.latency,
          _verifiedWorking: cache?.working,
        });
      }

      // Add static models defined by user
      if (Array.isArray(prov.staticModels)) {
        for (const sm of prov.staticModels) {
          const bounds = this.normalizeBounds(
            sm.id,
            sm.contextWindow,
            sm.maxOutputTokens,
            sm.maxInputTokens
          );
          const cache = this.getCacheEntry(prov.name, sm.id);
          modelsList.push({
            id: sm.id,
            name: sm.name || this.prettifyModelName(sm.id, undefined, prov.name),
            url: chatUrl,
            toolCalling:
              cache?.verifiedTools !== undefined
                ? cache.verifiedTools
                : sm.toolCalling !== undefined
                ? sm.toolCalling
                : true,
            vision: sm.vision !== undefined ? sm.vision : false,
            maxInputTokens: bounds.maxInputTokens,
            maxOutputTokens: bounds.maxOutputTokens,
            contextWindow: bounds.contextWindow,
            providerName: prov.name,
            _latency: cache?.latency,
            _verifiedWorking: cache?.working,
          });
        }
      }

      // Process auto-discovered models
      for (const raw of modelsRaw) {
        const id = raw?.id || raw?.model;
        if (!id) continue;
        if (modelsList.some((existing) => existing.id === id)) continue;

        const bounds = this.normalizeBounds(
          id,
          raw?.contextWindow || raw?.context_window,
          raw?.maxOutputTokens,
          raw?.maxInputTokens
        );
        const cache = this.getCacheEntry(prov.name, id);
        modelsList.push({
          id,
          name: this.prettifyModelName(id, raw?.name, prov.name),
          url: chatUrl,
          toolCalling:
            cache?.verifiedTools !== undefined
              ? cache.verifiedTools
              : raw?.toolCalling !== undefined
              ? Boolean(raw.toolCalling)
              : true,
          vision: Boolean(raw?.vision || raw?.supports_vision),
          maxInputTokens: bounds.maxInputTokens,
          maxOutputTokens: bounds.maxOutputTokens,
          contextWindow: bounds.contextWindow,
          providerName: prov.name,
          _latency: cache?.latency,
          _verifiedWorking: cache?.working,
        });
      }

      const filtered = this.filterModels(modelsList, profile, onlyVerifiedWorking);
      if (filtered.length > 0) {
        providers.push({
          name: prov.name,
          vendor: "customendpoint",
          apiKey: prov.apiKey || "",
          apiType: "chat-completions",
          models: filtered,
        });
      }
    }

    return providers;
  }
}

