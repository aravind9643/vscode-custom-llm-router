import * as vscode from "vscode";
import {
  CatalogModel,
  ConnectionTestResult,
  ModelCapabilities,
  ModelOverride,
  ModelStats,
  ModelStatus,
  ModelPricing,
  ProviderConfig,
  ProviderKind,
  ProviderStatus,
  RouteConfig,
  RouteView,
  ToolSupport,
  VerifiedCacheEntry,
  VerifiedCacheStore,
  modelKey,
  splitKey,
} from "./types";
import { buildHeaders, describeFetchError, isLocalUrl, nativeRoot, resolveApi, timeoutFor } from "./endpoints";
import { ProviderStore } from "./providerStore";
import { Auth, ChatRequest, ChatSink, HttpError, ListedModel, transportFor } from "./transports";
import { runPool } from "./pool";
import { num } from "./transports/openai";

const CACHE_KEY = "customLlmRouter.verifiedCache";
const META_KEY = "customLlmRouter.nativeMeta";
const STATS_KEY = "customLlmRouter.modelStats";
const RATIO_KEY = "customLlmRouter.tokenRatio";
const DISCOVERY_TIMEOUT_MS = 8000;
const TEST_TIMEOUT_MS = 20000;
/** Local servers may need this long to load a large model on first use. */
const COLD_START_TIMEOUT_MS = 120000;
/** Default Ollama context (num_ctx) when the provider does not set one; more uses more memory. */
const DEFAULT_OLLAMA_CONTEXT = 32768;
const META_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CHARS_PER_TOKEN = 4;

/** Non-chat models that should never be offered to Copilot. */
const EXCLUDE_PATTERNS = [
  /image/, /inpaint/, /pixel-art/, /flux/, /diffusion/, /dall-?e/, /tts/, /voice/, /whisper/,
  /transcri/, /translat/, /embed/, /rerank/, /moderation/, /safety/, /guard/,
];
const ALWAYS_INCLUDE = new Set(["auto"]);

const CODING_RE = /(coder|coding|code|codestral|devstral|starcoder|codellama|claude|gpt-4|gpt-5|deepseek|qwen|kimi|glm)/;
const REASONING_RE = /(reason|thinking|think|deepseek-r1|(^|[\/\-_:])r1([\-_:.]|$)|(^|[\/\-_:])o[134](-|$)|qwq|magistral)/;
const VISION_RE = /(vision|(^|[\-_:])vl([\-_:]|$)|gpt-4o|gpt-4\.1|gpt-5|gemini|claude-3|claude-(sonnet|opus)|llava|pixtral|gemma-?3)/;

/** Limits and capabilities reported by a server's native API (Ollama / LM Studio). */
interface NativeMeta {
  contextWindow?: number;
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  fetchedAt: number;
}

interface ProviderCatalog {
  status: ProviderStatus;
  models: CatalogModel[];
}

export interface VerifyOptions {
  force?: boolean;
  token?: vscode.CancellationToken;
  onProgress?: (done: number, total: number, model: CatalogModel) => void;
}

export interface VerifyProgress {
  done: number;
  total: number;
  working: number;
  failed: number;
}

export interface VerificationEstimate {
  models: number;
  requests: number;
  /** Remote (possibly billed) providers involved, with how many models each. */
  remote: { name: string; models: number }[];
}

/** A globalState-backed record with debounced writes. */
class PersistedRecord<T> {
  private _data: Record<string, T>;
  private _timer?: NodeJS.Timeout;

  constructor(private readonly _memento: vscode.Memento, private readonly _key: string) {
    this._data = { ...(_memento.get<Record<string, T>>(_key) || {}) };
  }
  get(k: string): T | undefined {
    return this._data[k];
  }
  set(k: string, v: T) {
    this._data[k] = v;
    this._schedule();
  }
  clear() {
    this._data = {};
    this._schedule();
  }
  /** Moves every `${from}::*` entry to `${to}::*`. */
  rekeyProvider(from: string, to: string) {
    const prefix = `${from}::`;
    for (const k of Object.keys(this._data)) {
      if (k.startsWith(prefix)) {
        this._data[`${to}::${k.slice(prefix.length)}`] = this._data[k];
        delete this._data[k];
      }
    }
    this._schedule();
  }
  private _schedule() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 1000);
  }
  flush() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = undefined;
    void this._memento.update(this._key, this._data);
  }
}

export class ModelEngine implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever providers, models, statuses, routes or selection change. */
  public readonly onDidChange = this._onDidChange.event;

  private _catalog = new Map<string, ProviderCatalog>();
  private _cache: VerifiedCacheStore = { updatedAt: 0, entries: {} };
  private readonly _meta: PersistedRecord<NativeMeta>;
  private readonly _stats: PersistedRecord<ModelStats>;
  private readonly _ratios: PersistedRecord<number>;
  private _testing = new Set<string>();
  private _backedOff = new Map<string, number>();
  private _roundRobinIndex = new Map<string, number>();
  private _discovery?: Promise<void>;
  private _discovered = false;
  private _saveTimer?: NodeJS.Timeout;
  private _fireTimer?: NodeJS.Timeout;
  private _verifyProgress?: VerifyProgress;
  private _verifyCts?: vscode.CancellationTokenSource;

  constructor(
    private readonly _memento: vscode.Memento,
    public readonly store: ProviderStore,
    private readonly _log: vscode.LogOutputChannel
  ) {
    this._meta = new PersistedRecord(_memento, META_KEY);
    this._stats = new PersistedRecord(_memento, STATS_KEY);
    this._ratios = new PersistedRecord(_memento, RATIO_KEY);
    this._loadCache();
  }

  // ------------------------------------------------------------------ events

  /** Coalesces bursts of changes (e.g. 8 concurrent test results) into one UI update. */
  private _fire(immediate = false) {
    if (immediate) {
      if (this._fireTimer) clearTimeout(this._fireTimer);
      this._fireTimer = undefined;
      this._onDidChange.fire();
      return;
    }
    if (this._fireTimer) return;
    this._fireTimer = setTimeout(() => {
      this._fireTimer = undefined;
      this._onDidChange.fire();
    }, 120);
  }

  // ------------------------------------------------------------------- cache

  private _loadCache() {
    const stored = this._memento.get<VerifiedCacheStore>(CACHE_KEY, { updatedAt: 0, entries: {} });
    this._cache = { updatedAt: stored.updatedAt || 0, entries: { ...(stored.entries || {}) } };
    const ttl = this.store.cacheTtlMs;
    const now = Date.now();
    for (const [k, e] of Object.entries(this._cache.entries)) {
      if (!e || now - e.testedAt > ttl) delete this._cache.entries[k];
    }
  }

  /** Debounced so a concurrent verification run does not write globalState hundreds of times. */
  private _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flushCache(), 500);
  }

  private _flushCache() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = undefined;
    this._cache.updatedAt = Date.now();
    void this._memento.update(CACHE_KEY, this._cache);
  }

  public getCacheEntry(providerName: string, modelId: string): VerifiedCacheEntry | undefined {
    const e = this._cache.entries[modelKey(providerName, modelId)];
    if (!e) return undefined;
    if (Date.now() - e.testedAt > this.store.cacheTtlMs) return undefined;
    return e;
  }

  private _setCacheEntry(entry: VerifiedCacheEntry) {
    this._cache.entries[modelKey(entry.providerName, entry.modelId)] = entry;
    this._scheduleSave();
  }

  public getAllCacheEntries(): VerifiedCacheEntry[] {
    return Object.values(this._cache.entries);
  }

  public async clearCache(): Promise<void> {
    this._cache = { updatedAt: Date.now(), entries: {} };
    await this._memento.update(CACHE_KEY, this._cache);
    this._rebuildStatuses();
    this._fire(true);
  }

  /** Clears cache entries for failed models so they return to untested and can be re-verified. */
  public async clearFailedCache(): Promise<void> {
    let changed = false;
    for (const [k, e] of Object.entries(this._cache.entries)) {
      if (!e.working) {
        delete this._cache.entries[k];
        changed = true;
      }
    }
    if (changed) {
      await this._memento.update(CACHE_KEY, this._cache);
      this._rebuildStatuses();
      this._fire(true);
    }
  }

  /** Marks a model as failed after a definitive runtime error (e.g. 404 model not found). */
  public markFailed(providerName: string, modelId: string, error: string) {
    this._setCacheEntry({ providerName, modelId, working: false, latency: 0, error, testedAt: Date.now() });
    this._rebuildStatuses();
    this._fire();
  }

  /** Carries test results, server metadata and stats over to a renamed provider. */
  public renameProvider(from: string, to: string) {
    if (from === to) return;
    const prefix = `${from}::`;
    for (const k of Object.keys(this._cache.entries)) {
      if (!k.startsWith(prefix)) continue;
      const e = this._cache.entries[k];
      delete this._cache.entries[k];
      this._cache.entries[modelKey(to, e.modelId)] = { ...e, providerName: to };
    }
    this._scheduleSave();
    this._meta.rekeyProvider(from, to);
    this._stats.rekeyProvider(from, to);
    this._ratios.rekeyProvider(from, to);
  }

  // ----------------------------------------------------------------- queries

  public get isDiscovered(): boolean {
    return this._discovered;
  }

  public get verifyProgress(): VerifyProgress | undefined {
    return this._verifyProgress;
  }

  public getProviderStatuses(): ProviderStatus[] {
    return this.store.getProviders().map((p) => {
      const cat = this._catalog.get(p.name);
      const secrets = {
        keySource: this.store.keySource(p),
        secretHeaderNames: this.store.secretHeaderNames(p),
        plaintextSecretHeaders: this.store.plaintextSecretHeaders(p),
      };
      if (cat && p.enabled !== false) return { ...cat.status, ...secrets };
      const kind = detectKind(p, []);
      return { name: p.name, endpointUrl: p.endpointUrl, enabled: p.enabled !== false, kind, api: resolveApi(p, kind), modelCount: 0, remote: !isLocalUrl(p.endpointUrl), ...secrets };
    });
  }

  public getModels(providerName?: string): CatalogModel[] {
    if (providerName) return this._catalog.get(providerName)?.models || [];
    return [...this._catalog.values()].flatMap((c) => c.models);
  }

  public getModel(key: string): CatalogModel | undefined {
    const parts = splitKey(key);
    return parts ? this.getModels(parts.providerName).find((m) => m.key === key) : undefined;
  }

  /** Models exposed to Copilot: selected by the user AND verified working. */
  public getCopilotModels(): CatalogModel[] {
    return this.getModels().filter((m) => m.selected && m.status === "working");
  }

  /** Curates the top working models for Copilot based on coding/reasoning capabilities, latency, and family diversity. */
  public async curateTopSelection(limit = 10): Promise<string[]> {
    const models = this.getModels();
    const working = models.filter((m) => m.status === "working");
    if (working.length === 0) return [];

    const scored = working.map((m) => {
      let score = 0;
      if (m.caps.coding) score += 30;
      if (m.caps.reasoning) score += 25;
      if (m.caps.vision) score += 10;
      if (m.toolSupport === "called" || m.toolSupport === "accepted") score += 20;

      const lat = m.latencyMs ?? 1000;
      if (lat < 250) score += 20;
      else if (lat < 600) score += 10;
      else if (lat < 1500) score += 5;

      if (m.stats?.tokensPerSec && m.stats.tokensPerSec > 50) score += 10;
      if (m.contextWindow >= 128000) score += 10;

      // Penalize snapshot / date variants to prefer clean canonical models
      if (/\d{8}|\d{4}-\d{2}-\d{2}/.test(m.id)) score -= 15;

      return { model: m, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const familyOf = (id: string): string => {
      const l = id.toLowerCase();
      if (l.includes("claude")) return "claude";
      if (l.includes("gpt-4") || l.includes("o1") || l.includes("o3") || l.includes("o4")) return "openai";
      if (l.includes("gemini")) return "gemini";
      if (l.includes("deepseek")) return "deepseek";
      if (l.includes("qwen")) return "qwen";
      if (l.includes("llama")) return "llama";
      if (l.includes("mistral") || l.includes("codestral")) return "mistral";
      return "other";
    };

    const selectedKeys: string[] = [];
    const seenFamilies = new Map<string, number>();

    // Pass 1: balanced distribution (max 2 per model family)
    for (const item of scored) {
      if (selectedKeys.length >= limit) break;
      const fam = familyOf(item.model.id);
      const count = seenFamilies.get(fam) || 0;
      if (count < 2) {
        selectedKeys.push(item.model.key);
        seenFamilies.set(fam, count + 1);
      }
    }

    // Pass 2: fill remaining slots up to limit
    if (selectedKeys.length < limit) {
      for (const item of scored) {
        if (selectedKeys.length >= limit) break;
        if (!selectedKeys.includes(item.model.key)) {
          selectedKeys.push(item.model.key);
        }
      }
    }

    await this.store.setSelection(selectedKeys);
    this.onSelectionChanged();
    return selectedKeys;
  }

  /** Clears all model selections from Copilot. */
  public async deselectAll(): Promise<void> {
    await this.store.setSelection([]);
    this.onSelectionChanged();
  }

  /** Auto-generates recommended routes (Fast Coding, Deep Reasoning, Balanced Load) from working models. */
  public async autoGenerateRoutes(): Promise<RouteConfig[]> {
    const working = this.getModels().filter((m) => m.status === "working");
    if (working.length === 0) return this.store.getRoutes();

    const existing = this.store.getRoutes();
    const existingNames = new Set(existing.map((r) => r.name.toLowerCase()));
    const newRoutes: RouteConfig[] = [...existing];

    const pick = (candidates: CatalogModel[], limit = 4) => candidates.slice(0, limit).map((m) => m.key);

    // 1. Fast Coding (least-latency policy)
    if (!existingNames.has("fast coding")) {
      const codingModels = [...working]
        .filter((m) => m.caps.coding || /code|coder|claude|gpt|deepseek/i.test(m.id))
        .sort((a, b) => (a.latencyMs ?? 9999) - (b.latencyMs ?? 9999));
      const keys = pick(codingModels, 4);
      if (keys.length >= 2) {
        newRoutes.push({ name: "Fast Coding", models: keys, policy: "least-latency" });
      }
    }

    // 2. Deep Reasoning (priority policy)
    if (!existingNames.has("deep reasoning")) {
      const reasoningModels = [...working]
        .filter((m) => m.caps.reasoning || /reason|think|r1|o1|o3|o4|opus|sonnet/i.test(m.id))
        .sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
      const keys = pick(reasoningModels, 4);
      if (keys.length >= 2) {
        newRoutes.push({ name: "Deep Reasoning", models: keys, policy: "priority" });
      }
    }

    // 3. Balanced Load (round-robin policy)
    if (!existingNames.has("balanced load")) {
      const topPerProvider = new Map<string, CatalogModel>();
      for (const m of [...working].sort((a, b) => (a.latencyMs ?? 9999) - (b.latencyMs ?? 9999))) {
        if (!topPerProvider.has(m.providerName)) topPerProvider.set(m.providerName, m);
      }
      const diverse = Array.from(topPerProvider.values());
      if (diverse.length < 2) {
        diverse.push(...working.filter((m) => !diverse.includes(m)).slice(0, 4 - diverse.length));
      }
      const keys = pick(diverse, 4);
      if (keys.length >= 2) {
        newRoutes.push({ name: "Balanced Load", models: keys, policy: "round-robin" });
      }
    }

    await this.store.saveRoutes(newRoutes);
    this._fire(true);
    return newRoutes;
  }

  public getRoutes(): RouteView[] {
    return this.store.getRoutes().map((r) => ({
      name: r.name,
      slug: slug(r.name),
      models: r.models,
      policy: r.policy,
      available: r.models.filter((k) => this.getModel(k)?.status === "working").length,
    }));
  }

  /** Members to try for a route, respecting route policy and circuit-breaker backoffs. */
  public routeCandidates(routeSlug: string, requiredTokens?: number): CatalogModel[] {
    const route = this.store.getRoutes().find((r) => slug(r.name) === routeSlug);
    if (!route) return [];
    let list = route.models
      .map((k) => this.getModel(k))
      .filter((m): m is CatalogModel => !!m && m.status !== "failed");
    if (!list.length) return [];

    // Context guard: if requiredTokens is given, prefer members that can fit it
    if (requiredTokens && requiredTokens > 0) {
      const fitting = list.filter((m) => m.maxInputTokens >= requiredTokens);
      if (fitting.length) list = fitting;
    }

    const policy = route.policy || "priority";
    if (policy === "least-latency") {
      list = [...list].sort((a, b) => {
        const latA = a.stats?.ttftMs ?? a.latencyMs ?? 1e6;
        const latB = b.stats?.ttftMs ?? b.latencyMs ?? 1e6;
        return latA - latB;
      });
    } else if (policy === "round-robin" && list.length > 1) {
      const idx = (this._roundRobinIndex.get(routeSlug) || 0) % list.length;
      this._roundRobinIndex.set(routeSlug, idx + 1);
      list = [...list.slice(idx), ...list.slice(0, idx)];
    }

    // Circuit breaker: models currently backed off are deprioritized
    const now = Date.now();
    const ready = list.filter((m) => (this._backedOff.get(m.key) || 0) <= now);
    const backed = list.filter((m) => (this._backedOff.get(m.key) || 0) > now);
    return [...ready, ...backed];
  }

  public backoffModel(key: string, durationMs = 30000) {
    this._backedOff.set(key, Date.now() + durationMs);
  }

  public isBackedOff(key: string): boolean {
    return (this._backedOff.get(key) || 0) > Date.now();
  }

  public getAllStats(): (ModelStats & { key: string; providerName: string; modelId: string })[] {
    const result: (ModelStats & { key: string; providerName: string; modelId: string })[] = [];
    for (const m of this.getModels()) {
      const st = m.stats || this._stats.get(m.key);
      if (st && st.requests > 0) {
        result.push({ key: m.key, providerName: m.providerName, modelId: m.id, ...st });
      }
    }
    return result;
  }

  // --------------------------------------------------------------- discovery

  /** Runs discovery once; later callers share the result. */
  public ensureDiscovered(): Promise<void> {
    if (this._discovered) return Promise.resolve();
    return this.refresh();
  }

  /** Re-fetches `/models` from every enabled provider in parallel. */
  public refresh(): Promise<void> {
    if (this._discovery) return this._discovery;
    this._discovery = (async () => {
      try {
        const enabled = this.store.getEnabledProviders();
        const results = await Promise.all(enabled.map((p) => this._discoverProvider(p)));
        const next = new Map<string, ProviderCatalog>();
        enabled.forEach((p, i) => next.set(p.name, results[i]));
        this._catalog = next;
        this._discovered = true;
      } finally {
        this._discovery = undefined;
        this._fire(true);
      }
    })();
    return this._discovery;
  }

  private async _discoverProvider(p: ProviderConfig): Promise<ProviderCatalog> {
    const auth = await this.store.getAuth(p);
    const status: ProviderStatus = {
      name: p.name,
      endpointUrl: p.endpointUrl,
      enabled: true,
      kind: detectKind(p, []),
      api: resolveApi(p, detectKind(p, [])),
      modelCount: 0,
      checkedAt: Date.now(),
      keySource: this.store.keySource(p),
      remote: !isLocalUrl(p.endpointUrl),
      secretHeaderNames: this.store.secretHeaderNames(p),
      plaintextSecretHeaders: this.store.plaintextSecretHeaders(p),
    };
    let listed: ListedModel[] = [];

    if (p.autoDiscover !== false) {
      const res = await transportFor(status.api).listModels(p, auth, DISCOVERY_TIMEOUT_MS);
      status.online = res.ok;
      status.latencyMs = res.latencyMs;
      status.error = res.error;
      // Rejected credentials usually mean the key did not sync to this machine (keys are per machine).
      status.needsKey = !res.ok && (res.status === 401 || res.status === 403);
      listed = res.models;
      if (!res.ok) this._log.warn(`[discovery] ${p.name}: ${res.error}`);
    } else {
      status.online = true;
    }
    status.kind = detectKind(p, listed);
    status.api = resolveApi(p, status.kind);

    const specs: { meta: ListedModel; isStatic: boolean }[] = [];
    const seen = new Set<string>();
    const add = (meta: ListedModel, isStatic: boolean) => {
      if (!seen.has(meta.id)) {
        seen.add(meta.id);
        specs.push({ meta, isStatic });
      }
    };
    for (const sm of p.staticModels || []) if (sm?.id) add({ ...sm }, true);
    for (const m of listed) if (this._isChatModel(m.id)) add(m, false);
    // FreeLLMAPI exposes a virtual router model that is not listed by /models.
    if (p.name === "FreeLLMAPI" && status.online) add({ id: "auto", name: "FreeLLMAPI Auto", vision: true }, true);

    if (status.online && (status.kind === "ollama" || status.kind === "lmstudio")) {
      await this._probeNativeMeta(p, auth, status.kind, specs.map((s) => s.meta.id));
    }

    const selection = this.store.getSelection();
    const overrides = this.store.getOverrides();
    const models = specs.map((s) => this._buildModel(p, status, s.meta, s.isStatic, selection, overrides));
    status.modelCount = models.length;
    return { status, models };
  }

  /** Reads real context windows / capabilities from Ollama or LM Studio native APIs (cached for a week). */
  private async _probeNativeMeta(p: ProviderConfig, auth: Auth, kind: ProviderKind, ids: string[]) {
    const now = Date.now();
    const missing = ids.filter((id) => {
      const m = this._meta.get(modelKey(p.name, id));
      return !m || now - m.fetchedAt > META_TTL_MS;
    });
    if (!missing.length) return;
    const root = nativeRoot(p);
    const headers = buildHeaders(p, auth);

    try {
      if (kind === "lmstudio") {
        const res = await fetch(`${root}/api/v0/models`, { headers, signal: AbortSignal.timeout(4000) });
        if (!res.ok) return;
        const data: any = await res.json();
        for (const m of Array.isArray(data?.data) ? data.data : []) {
          if (typeof m?.id !== "string" || !missing.includes(m.id)) continue;
          this._meta.set(modelKey(p.name, m.id), {
            contextWindow: num(m.loaded_context_length) || num(m.max_context_length),
            vision: m.type === "vlm" ? true : undefined,
            tools: Array.isArray(m.capabilities) ? m.capabilities.includes("tool_use") : undefined,
            fetchedAt: now,
          });
        }
        return;
      }

      // Ollama: one /api/show per model, a few at a time.
      let next = 0;
      const worker = async () => {
        while (next < missing.length) {
          const id = missing[next++];
          try {
            const res = await fetch(`${root}/api/show`, {
              method: "POST",
              headers,
              body: JSON.stringify({ model: id }),
              signal: AbortSignal.timeout(4000),
            });
            if (!res.ok) continue;
            const info: any = await res.json();
            const ctxKey = Object.keys(info?.model_info || {}).find((k) => k.endsWith(".context_length"));
            const caps: string[] | undefined = Array.isArray(info?.capabilities) ? info.capabilities : undefined;
            this._meta.set(modelKey(p.name, id), {
              contextWindow: ctxKey ? num(info.model_info[ctxKey]) : undefined,
              tools: caps ? caps.includes("tools") : undefined,
              vision: caps ? caps.includes("vision") : undefined,
              reasoning: caps ? caps.includes("thinking") : undefined,
              fetchedAt: now,
            });
          } catch {
            // older Ollama or model vanished — fall back to guesses
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
    } catch (err) {
      this._log.warn(`[discovery] ${p.name}: native metadata unavailable (${describeFetchError(err)})`);
    }
  }

  private _isChatModel(id: string): boolean {
    if (ALWAYS_INCLUDE.has(id) || id.startsWith("auto/")) return true;
    const lower = id.toLowerCase();
    return !EXCLUDE_PATTERNS.some((re) => re.test(lower));
  }

  private _buildModel(
    p: ProviderConfig,
    status: ProviderStatus,
    meta: ListedModel,
    isStatic: boolean,
    selection: Set<string>,
    overrides: Record<string, ModelOverride>
  ): CatalogModel {
    const id = meta.id;
    const key = modelKey(p.name, id);
    const lower = id.toLowerCase();
    const native = this._meta.get(key);
    const ov = overrides[key];

    // Native APIs (Ollama /api/show, LM Studio loaded context) are more precise than generic /models fields.
    let serverCtx = native?.contextWindow || meta.contextWindow;
    // Ollama native chat loads the model with num_ctx; advertise what will actually be used.
    if (status.api === "ollama") serverCtx = Math.min(serverCtx || Infinity, p.contextLength || DEFAULT_OLLAMA_CONTEXT);
    const ctx = ov?.contextWindow || serverCtx;
    const bounds = inferBounds(lower, ctx, ov?.maxOutputTokens || meta.maxOutputTokens, ov?.contextWindow ? undefined : meta.maxInputTokens);
    const caps: ModelCapabilities = {
      tools: meta.toolCalling ?? native?.tools ?? true,
      vision: meta.vision ?? native?.vision ?? VISION_RE.test(lower),
      reasoning: Boolean(native?.reasoning || meta.reasoning) || REASONING_RE.test(lower),
      coding: CODING_RE.test(lower),
    };
    let pricing: ModelPricing | undefined;
    if (ov?.inputPerM !== undefined || ov?.outputPerM !== undefined) {
      pricing = { inputPerM: ov.inputPerM ?? 0, outputPerM: ov.outputPerM ?? 0, source: "override" };
    } else if (meta.inputPerM !== undefined || meta.outputPerM !== undefined) {
      pricing = { inputPerM: meta.inputPerM ?? 0, outputPerM: meta.outputPerM ?? 0, source: status.api === "anthropic" ? "list" : "server" };
    }
    const rawName = meta.name?.trim();
    const displayName =
      ov?.name ||
      (rawName && !rawName.includes("/") && rawName.toLowerCase() !== id.toLowerCase() ? rawName : undefined) ||
      prettifyModelName(rawName || id, p.name);
    const model: CatalogModel = {
      key,
      providerName: p.name,
      id,
      name: displayName,
      ...bounds,
      contextSource: ov?.contextWindow ? "override" : serverCtx && Number.isFinite(serverCtx) && (native?.contextWindow || meta.contextWindow) ? "server" : "guess",
      caps,
      status: "untested",
      selected: false,
      isStatic,
      hasOverride: !!ov,
      pricing,
      thinkingSupported: status.api === "anthropic" ? meta.reasoning : status.api === "ollama" ? native?.reasoning : undefined,
    };
    this._applyStatus(model, selection, ov);
    return model;
  }

  private _applyStatus(m: CatalogModel, selection: Set<string>, ov?: ModelOverride) {
    const cache = this.getCacheEntry(m.providerName, m.id);
    let status: ModelStatus = cache ? (cache.working ? "working" : "failed") : "untested";
    if (this._testing.has(m.key)) status = "testing";
    m.status = status;
    m.latencyMs = cache?.latency;
    m.error = cache?.working ? undefined : cache?.error;
    m.testedAt = cache?.testedAt;
    m.toolSupport = cache?.toolSupport ?? (cache?.verifiedTools === true ? "accepted" : cache?.verifiedTools === false ? "unsupported" : undefined);
    if (m.toolSupport === "unsupported") m.caps.tools = false;
    else if (m.toolSupport) m.caps.tools = true;
    if (ov && typeof ov.toolCalling === "boolean") m.caps.tools = ov.toolCalling;
    if (ov && typeof ov.vision === "boolean") m.caps.vision = ov.vision;
    m.selected = selection.has(m.key);
    m.stats = this._stats.get(m.key);
  }

  private _rebuildStatuses() {
    const selection = this.store.getSelection();
    const overrides = this.store.getOverrides();
    for (const m of this.getModels()) this._applyStatus(m, selection, overrides[m.key]);
  }

  /** Call after the selection / routes / TTL settings changed outside the engine. */
  public onSelectionChanged() {
    this._rebuildStatuses();
    this._fire(true);
  }

  // ------------------------------------------------------------- connection

  /**
   * Probes `/models`. When `sink` is given the raw model list is appended to it.
   * Works for unsaved providers too (used by the dashboard "Test connection" button).
   */
  public async testConnection(p: ProviderConfig, auth: Auth, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<ConnectionTestResult & { status?: number }> {
    const res = await transportFor(resolveApi(p, detectKind(p, []))).listModels(p, auth, timeoutMs);
    return { ok: res.ok, latencyMs: res.latencyMs, modelCount: res.models.length, error: res.error, status: res.status };
  }

  /** Resolves the wire protocol for a provider, using the kind detected at discovery. */
  public apiFor(p: ProviderConfig) {
    return this._catalog.get(p.name)?.status.api ?? resolveApi(p, detectKind(p, []));
  }

  // ------------------------------------------------------------ verification

  public get isVerifying(): boolean {
    return this._verifyProgress !== undefined;
  }

  public cancelVerification() {
    this._verifyCts?.cancel();
  }

  /** How many requests a verification run would send, and to which remote providers. */
  public estimateVerification(models: CatalogModel[], force: boolean): VerificationEstimate {
    const queue = models.filter((m) => force || m.status === "untested");
    const perModel = this.store.toolCheck === "full" ? 2 : 1;
    const remote = new Map<string, number>();
    const statuses = new Map(this.getProviderStatuses().map((s) => [s.name, s]));
    for (const m of queue) {
      if (statuses.get(m.providerName)?.remote) remote.set(m.providerName, (remote.get(m.providerName) || 0) + 1);
    }
    return {
      models: queue.length,
      requests: queue.length * perModel,
      remote: [...remote].map(([name, n]) => ({ name, models: n })),
    };
  }

  /**
   * Verifies the given models with a bounded worker pool. Cached results are reused
   * unless `force` is set. Cancellation stops scheduling new requests.
   */
  public async verify(models: CatalogModel[], opts: VerifyOptions = {}): Promise<VerifyProgress> {
    const queue = models.filter((m) => !this._testing.has(m.key) && (opts.force || !this.getCacheEntry(m.providerName, m.id)));
    const progress: VerifyProgress = { done: 0, total: queue.length, working: 0, failed: 0 };
    if (queue.length === 0) return progress;

    const ownsRun = !this._verifyProgress;
    const cts = new vscode.CancellationTokenSource();
    const sub = opts.token?.onCancellationRequested(() => cts.cancel());
    if (ownsRun) {
      this._verifyProgress = progress;
      this._verifyCts = cts;
    }
    for (const m of queue) this._testing.add(m.key);
    this._rebuildStatuses();
    this._fire(true);

    const remote = new Set(this.getProviderStatuses().filter((s) => s.remote).map((s) => s.name));
    const run = async (m: CatalogModel) => {
        const ok = await this._testModel(m);
        this._testing.delete(m.key);
        progress.done++;
        if (ok) progress.working++;
        else progress.failed++;
        this._rebuildStatuses();
        this._fire();
        opts.onProgress?.(progress.done, progress.total, m);
    };

    try {
      await runPool(
        queue,
        {
          limit: this.store.concurrency,
          groupOf: (m) => m.providerName,
          // Local servers are only bounded by the global limit; remote APIs get a per-provider cap.
          groupLimit: (name) => (remote.has(name) ? this.store.providerConcurrency : this.store.concurrency),
          cancelled: () => cts.token.isCancellationRequested,
        },
        run
      );
    } finally {
      for (const m of queue) this._testing.delete(m.key);
      sub?.dispose();
      cts.dispose();
      if (ownsRun) {
        this._verifyProgress = undefined;
        this._verifyCts = undefined;
      }
      this._rebuildStatuses();
      this._fire(true);
    }
    this._log.info(`[verify] ${progress.working} working, ${progress.failed} failed of ${progress.total}`);
    return progress;
  }

  /** Re-verifies selected and routed models whose result expired, so they do not silently vanish from Copilot. */
  public async reverifyExpiredSelection(): Promise<void> {
    const routed = new Set(this.store.getRoutes().flatMap((r) => r.models));
    const stale = this.getModels().filter((m) => (m.selected || routed.has(m.key)) && m.status === "untested");
    if (stale.length) {
      this._log.info(`[verify] re-checking ${stale.length} selected model(s) with expired results`);
      await this.verify(stale);
    }
  }

  /** Sends a tiny request through the provider's transport; returns what came back. */
  private async _probe(p: ProviderConfig, auth: Auth, m: CatalogModel, req: Partial<ChatRequest>, timeoutMs: number) {
    const out = { text: "", toolCalls: 0 };
    const sink: ChatSink = {
      text: (s) => (out.text += s),
      reasoning: () => undefined,
      toolCall: () => void out.toolCalls++,
    };
    await transportFor(this.apiFor(p)).chat(
      p,
      auth,
      { model: m.id, messages: [], wantUsage: false, reasoning: false, numCtx: undefined, ...req } as ChatRequest,
      sink,
      AbortSignal.timeout(timeoutMs)
    );
    return out;
  }

  private async _testModel(m: CatalogModel): Promise<boolean> {
    const p = this.store.findProvider(m.providerName);
    if (!p) return false;
    const auth = await this.store.getAuth(p);
    const local = isLocalUrl(p.endpointUrl);
    let timeout = timeoutFor(p, TEST_TIMEOUT_MS);
    const start = Date.now();

    let error: string | undefined;
    let latency = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const attemptStart = Date.now();
      try {
        await this._probe(p, auth, m, { messages: [{ role: "user", content: "Reply with exactly: OK" }], maxTokens: 16, temperature: 0 }, timeout);
        latency = Date.now() - attemptStart;
        const toolSupport = this.store.toolCheck === "full" ? await this._checkTools(p, auth, m, timeout) : undefined;
        this._setCacheEntry({ providerName: m.providerName, modelId: m.id, working: true, latency, toolSupport, testedAt: Date.now() });
        return true;
      } catch (err: any) {
        latency = Date.now() - start;
        if (err instanceof HttpError) {
          error = err.message;
          if (err.status === 429 || err.status >= 500) continue; // transient — retry once
          break;
        }
        error = describeFetchError(err);
        const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
        if (timedOut && local && attempt === 0) {
          // A local server may still be loading the model into memory; give it one long attempt.
          this._log.info(`[verify] ${m.key} timed out after ${timeout}ms — retrying once while the model loads`);
          timeout = Math.max(timeout * 3, COLD_START_TIMEOUT_MS);
          continue;
        }
        if (timedOut && local) error = "Timed out (the model may still be loading — try again)";
        if (!timedOut) break;
      }
    }
    this._setCacheEntry({ providerName: m.providerName, modelId: m.id, working: false, latency, error, testedAt: Date.now() });
    return false;
  }

  /**
   * Sends a request that should clearly trigger a tool call. Copilot agent mode always sends tools,
   * so "unsupported" models are registered without tool calling.
   */
  private async _checkTools(p: ProviderConfig, auth: Auth, m: CatalogModel, timeout: number): Promise<ToolSupport> {
    try {
      const out = await this._probe(
        p,
        auth,
        m,
        {
          messages: [
            { role: "system", content: "You must use the provided tools to answer. Never compute results yourself." },
            { role: "user", content: "What is 1234 * 5678? Use the calculator tool." },
          ],
          tools: [
            {
              name: "calculator",
              description: "Evaluate an arithmetic expression and return the exact result",
              parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
            },
          ],
          toolChoice: "auto",
          temperature: 0,
          maxTokens: this.apiFor(p) === "anthropic" ? 2048 : 200,
        },
        timeout
      );
      return out.toolCalls ? "called" : "accepted";
    } catch {
      return "unsupported";
    }
  }

  // ------------------------------------------------------------ chat telemetry

  /** Records a real chat request (local only — never leaves the machine). */
  public recordChat(key: string, r: { ok: boolean; ttftMs?: number; durationMs?: number; outputTokens?: number; promptTokens?: number }) {
    const s: ModelStats = { requests: 0, failures: 0, ...this._stats.get(key) };
    s.requests++;
    if (!r.ok) s.failures++;
    s.lastUsedAt = Date.now();
    const ema = (prev: number | undefined, v: number) => (prev === undefined ? v : prev * 0.7 + v * 0.3);
    if (r.ok && r.ttftMs !== undefined) s.ttftMs = Math.round(ema(s.ttftMs, r.ttftMs));
    if (r.ok && r.outputTokens && r.durationMs && r.ttftMs !== undefined) {
      const genSec = (r.durationMs - r.ttftMs) / 1000;
      if (genSec > 0.2 && r.outputTokens > 5) s.tokensPerSec = Math.round(ema(s.tokensPerSec, r.outputTokens / genSec) * 10) / 10;
    }
    const m = this.getModel(key);
    if (r.ok && (r.promptTokens || r.outputTokens)) {
      s.promptTokens = (s.promptTokens || 0) + (r.promptTokens || 0);
      s.completionTokens = (s.completionTokens || 0) + (r.outputTokens || 0);
      if (m?.pricing) {
        const cost = ((r.promptTokens || 0) * m.pricing.inputPerM + (r.outputTokens || 0) * m.pricing.outputPerM) / 1e6;
        s.costUsd = Math.round(((s.costUsd || 0) + cost) * 1e6) / 1e6;
      }
    }
    this._stats.set(key, s);
    if (m) m.stats = s;
    this._fire();
  }

  /** Total estimated spend across all models. */
  public totalSpend(): number {
    return this.getModels().reduce((sum, m) => sum + (m.stats?.costUsd || 0), 0);
  }

  public resetStats() {
    this._stats.clear();
    for (const m of this.getModels()) m.stats = undefined;
    this._fire(true);
  }

  /** Characters per token for a model, learned from `usage.prompt_tokens` of real requests. */
  public charsPerToken(key: string): number {
    return this._ratios.get(key) ?? DEFAULT_CHARS_PER_TOKEN;
  }

  public recordPromptUsage(key: string, chars: number, promptTokens: number) {
    if (chars < 200 || promptTokens < 50) return; // too small to be meaningful
    const ratio = Math.min(8, Math.max(1.5, chars / promptTokens));
    const prev = this._ratios.get(key);
    this._ratios.set(key, Math.round((prev === undefined ? ratio : prev * 0.7 + ratio * 0.3) * 100) / 100);
  }

  // --------------------------------------------------------------- migration

  /** v1.0.x used an opt-out list; seed the new opt-in list with what users effectively had. */
  public async migrateLegacySelection(): Promise<void> {
    if (this.store.hasSelectionSetting()) return;
    const disabled = this.store.getLegacyDisabledIds();
    const keys = this.getAllCacheEntries()
      .filter((e) => e.working && !disabled.has(modelKey(e.providerName, e.modelId)) && !disabled.has(e.modelId))
      .map((e) => modelKey(e.providerName, e.modelId));
    await this.store.setSelection(keys);
    this._log.info(`[migrate] seeded Copilot selection with ${keys.length} previously active model(s)`);
  }

  public dispose() {
    if (this._saveTimer) this._flushCache();
    this._meta.flush();
    this._stats.flush();
    this._ratios.flush();
    if (this._fireTimer) clearTimeout(this._fireTimer);
    this._verifyCts?.cancel();
    this._onDidChange.dispose();
  }
}

// ------------------------------------------------------------------- helpers

export function detectKind(p: ProviderConfig, raw: any[]): ProviderKind {
  let port = "";
  try {
    port = new URL(p.endpointUrl).port;
  } catch {
    // invalid URL — treat as generic
  }
  if (port === "11434" || /ollama/i.test(p.name) || raw.some((r) => r?.owned_by === "library" || r?.owned_by === "ollama")) return "ollama";
  if (port === "1234" || /lm ?studio/i.test(p.name)) return "lmstudio";
  return "openai";
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

export function inferBounds(idLower: string, ctx?: number, maxOut?: number, maxIn?: number) {
  let contextWindow = ctx;
  if (!contextWindow) {
    if (/gemini/.test(idLower)) contextWindow = 1048576;
    else if (/claude/.test(idLower)) contextWindow = 200000;
    else if (/gpt-4\.1|gpt-5/.test(idLower)) contextWindow = 400000;
    else if (/gpt-4o|(^|[\/\-])o[134]/.test(idLower)) contextWindow = 128000;
    else contextWindow = 131072;
  }
  const maxOutputTokens = Math.min(maxOut || Math.min(16384, Math.max(2048, Math.floor(contextWindow / 4))), Math.floor(contextWindow / 2));
  const maxInputTokens = maxIn || Math.max(1024, contextWindow - maxOutputTokens);
  return { contextWindow, maxOutputTokens, maxInputTokens };
}

export function prettifyModelName(id: string, providerName: string): string {
  if (id === "auto") return `${providerName} Auto`;
  const auto = /^auto\/(best|pro)-(.+)$/.exec(id);
  if (auto) return `${providerName} ${cap(auto[1])} ${cap(auto[2])}`;

  const parts = id.split("/");
  let base = parts.pop() || id;
  const prefix = parts.join("/");

  let isFree = false;
  let isDirect = prefix.includes("no-think") || base.includes("no-think");
  let tier: string | undefined;

  // Strip trailing :free or tags
  if (/:free$/i.test(base)) {
    isFree = true;
    base = base.replace(/:free$/i, "");
  }
  base = base.replace(/:latest$/i, "").replace(/:beta$/i, "");

  // Detect and extract snapshot dates (e.g. 2024-08-06 or 20251001)
  let snapshotDate: string | undefined;
  const dateMatch = /\b(202\d)[-_]?(\d{2})[-_]?(\d{2})\b/.exec(base);
  if (dateMatch) {
    snapshotDate = `(${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]})`;
    base = base.replace(dateMatch[0], "");
  }

  // Detect and strip effort/quant tiers (-low, -medium, -high)
  const tierMatch = /-(low|medium|high)$/i.exec(base);
  if (tierMatch) {
    tier = cap(tierMatch[1].toLowerCase());
    base = base.replace(/-(low|medium|high)$/i, "");
  }

  // Common prefix cleanups
  base = base
    .replace(/^meta-llama-|^llama-/i, "Llama-")
    .replace(/^deepseek-ai-|^deepseek-/i, "DeepSeek-")
    .replace(/^gpt-/i, "GPT-")
    .replace(/^claude-/i, "Claude-")
    .replace(/^gemini-/i, "Gemini-")
    .replace(/^qwen-/i, "Qwen-")
    .replace(/^mistral-/i, "Mistral-")
    .replace(/^codestral-/i, "Codestral-");

  // Version numbers like 3-5 -> 3.5, 4-6 -> 4.6 (1-2 digits only)
  base = base.replace(/\b(\d{1,2})-(\d{1,2})\b/g, "$1.$2");

  let name = base
    .replace(/[-_:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());

  if (snapshotDate) name += ` ${snapshotDate}`;
  if (tier) name += ` (${tier})`;
  if (isDirect) name += " (Direct)";
  if (isFree) name += " (Free)";
  return name.trim() || id;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
