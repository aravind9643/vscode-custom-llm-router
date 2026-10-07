"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelEngine = void 0;
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
class ModelEngine {
    _providers = [];
    _blacklistPatterns = ["image", "inpainting", "pixel-art", "flux", "diffusion", "tts", "voice", "translat", "whisper", "safety"];
    _whitelistExactIds = ["auto", "auto/best-coding", "auto/best-fast", "auto/best-reasoning", "auto/best-vision", "auto/best-chat", "auto/best-free"];
    constructor() {
        this.reloadConfig();
    }
    updateConfig(providers, blacklist, whitelist) {
        this._providers = providers || [];
        if (blacklist)
            this._blacklistPatterns = blacklist;
        if (whitelist)
            this._whitelistExactIds = whitelist;
    }
    reloadConfig() {
        // Providers are updated directly via VS Code settings / global state
    }
    getConfiguredProviders() {
        return this._providers.filter((p) => p.enabled !== false && p.endpointUrl && p.endpointUrl.trim().length > 0);
    }
    async checkEndpoints() {
        const configured = this.getConfiguredProviders();
        const results = [];
        for (const prov of configured) {
            const status = {
                name: prov.name,
                url: prov.endpointUrl,
                online: false,
                modelCount: 0,
            };
            const cleanEndpoint = prov.endpointUrl.replace(/\/+$/, "");
            const modelsUrl = prov.modelsEndpoint || `${cleanEndpoint}/v1/models`;
            const headers = { Accept: "application/json" };
            if (prov.apiKey) {
                headers["Authorization"] = `Bearer ${prov.apiKey}`;
            }
            try {
                const res = await fetch(modelsUrl, {
                    headers,
                    signal: AbortSignal.timeout(4000),
                });
                if (res.ok) {
                    const data = await res.json();
                    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
                    status.online = true;
                    status.modelCount = list.length + (prov.staticModels?.length || 0);
                }
                else {
                    if (prov.staticModels && prov.staticModels.length > 0) {
                        status.online = true;
                        status.modelCount = prov.staticModels.length;
                    }
                    else {
                        status.online = false;
                        status.error = `HTTP ${res.status}`;
                    }
                }
            }
            catch (e) {
                if (prov.staticModels && prov.staticModels.length > 0) {
                    status.online = true;
                    status.modelCount = prov.staticModels.length;
                }
                else {
                    status.online = false;
                    status.error = e.message;
                }
            }
            results.push(status);
        }
        return { all: results };
    }
    prettifyModelName(id, rawName, providerName) {
        if (rawName && rawName.trim().length > 0 && !rawName.startsWith("aihorde/")) {
            return rawName;
        }
        if (id === "auto")
            return `${providerName || "LLM"} Auto`;
        if (id === "fusion")
            return `${providerName || "LLM"} Fusion`;
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
        }
        else if (prefix && !prefix.startsWith("auto")) {
            name += ` (${prefix})`;
        }
        return name;
    }
    normalizeBounds(modelId, rawCtx, rawMaxOut, rawMaxIn) {
        const idLower = modelId.toLowerCase();
        let contextWindow = rawCtx;
        let maxOutputTokens = rawMaxOut;
        let maxInputTokens = rawMaxIn;
        if (!contextWindow) {
            if (idLower.includes("claude-3-7") || idLower.includes("claude-3-5")) {
                contextWindow = 200000;
                maxOutputTokens = maxOutputTokens || 64000;
            }
            else if (idLower.includes("deepseek-r1") || idLower.includes("deepseek-v3") || idLower.includes("qwen")) {
                contextWindow = 131072;
                maxOutputTokens = maxOutputTokens || 16384;
            }
            else if (idLower.includes("gemini")) {
                contextWindow = 1048576;
                maxOutputTokens = maxOutputTokens || 65536;
            }
            else if (idLower.includes("gpt-4o") || idLower.includes("o1") || idLower.includes("o3")) {
                contextWindow = 128000;
                maxOutputTokens = maxOutputTokens || 16384;
            }
            else {
                contextWindow = 131072;
                maxOutputTokens = maxOutputTokens || 16000;
            }
        }
        if (!maxOutputTokens)
            maxOutputTokens = 16000;
        if (!maxInputTokens) {
            maxInputTokens = Math.max(1000, contextWindow - maxOutputTokens);
        }
        return { contextWindow, maxOutputTokens, maxInputTokens };
    }
    filterModels(models, profile = "all") {
        const blacklist = this._blacklistPatterns;
        const whitelist = new Set(this._whitelistExactIds);
        let filtered = models.filter((m) => {
            if (whitelist.has(m.id))
                return true;
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
                if (m.id === "auto" || m.id.includes("coding"))
                    return true;
                const idLower = m.id.toLowerCase();
                return CODING_MODEL_KEYWORDS.some((kw) => idLower.includes(kw));
            });
        }
        return filtered;
    }
    async generateProviders(options = {}) {
        const { profile = "all", onProgress } = options;
        const configured = this.getConfiguredProviders();
        const providers = [];
        for (const prov of configured) {
            if (onProgress)
                onProgress(`Fetching models from ${prov.name}...`);
            const cleanEndpoint = prov.endpointUrl.replace(/\/+$/, "");
            const chatUrl = prov.chatEndpoint || `${cleanEndpoint}/v1/chat/completions`;
            const modelsUrl = prov.modelsEndpoint || `${cleanEndpoint}/v1/models`;
            let modelsRaw = [];
            if (prov.autoDiscover !== false) {
                try {
                    const headers = { Accept: "application/json" };
                    if (prov.apiKey) {
                        headers["Authorization"] = `Bearer ${prov.apiKey}`;
                    }
                    const fetchUrl = prov.name === "FreeLLMAPI" ? `${modelsUrl}?execution_status=ready` : modelsUrl;
                    const res = await fetch(fetchUrl, {
                        headers,
                        signal: AbortSignal.timeout(6000),
                    });
                    if (res.ok) {
                        const d = await res.json();
                        modelsRaw = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
                    }
                }
                catch {
                    // ignore network error
                }
            }
            const modelsList = [];
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
                if (!id)
                    continue;
                if (modelsList.some((existing) => existing.id === id))
                    continue;
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
                    apiKey: prov.apiKey || "",
                    apiType: "chat-completions",
                    models: filtered,
                });
            }
        }
        return providers;
    }
}
exports.ModelEngine = ModelEngine;
//# sourceMappingURL=modelEngine.js.map