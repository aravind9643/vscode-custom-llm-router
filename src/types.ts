export interface StaticModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  vision?: boolean;
}

/** Provider entry as persisted in `customLlmRouter.providers`. */
export interface ProviderConfig {
  name: string;
  endpointUrl: string;
  /** Legacy plaintext key. New keys are kept in SecretStorage instead. */
  apiKey?: string;
  headers?: Record<string, string>;
  modelsEndpoint?: string;
  chatEndpoint?: string;
  staticModels?: StaticModelConfig[];
  autoDiscover?: boolean;
  enabled?: boolean;
  timeoutMs?: number;
  /** Ollama only: how long models stay loaded after a chat (e.g. "30m", "-1" = forever). */
  keepAlive?: string;
  /** Wire protocol. Default: "ollama" for Ollama servers, "anthropic" for api.anthropic.com, else "openai". */
  api?: ApiKind;
  /** How the API key is sent on OpenAI-compatible APIs (Azure OpenAI uses "api-key"). */
  authHeader?: "bearer" | "api-key" | "x-api-key";
  /** Ollama native only: context length to load models with (num_ctx). */
  contextLength?: number;
}

export type ApiKind = "openai" | "ollama" | "anthropic";

/** User-set per-model corrections, stored in `customLlmRouter.modelOverrides` by model key. */
export interface ModelOverride {
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  vision?: boolean;
  /** USD per million tokens. */
  inputPerM?: number;
  outputPerM?: number;
}

/** A virtual Copilot model that tries its member models in order (`customLlmRouter.routes`). */
export interface RouteConfig {
  name: string;
  models: string[];
}

export type ModelStatus = "untested" | "testing" | "working" | "failed";

/** `called`: the model emitted a tool call. `accepted`: the server took the tools but the model answered in text. */
export type ToolSupport = "called" | "accepted" | "unsupported";

export type ProviderKind = "ollama" | "lmstudio" | "openai";

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  coding: boolean;
}

export interface ModelStats {
  requests: number;
  failures: number;
  /** Exponential moving averages over real chat requests. */
  ttftMs?: number;
  tokensPerSec?: number;
  lastUsedAt?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Estimated spend from usage × price, when the model has a price. */
  costUsd?: number;
}

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  source: "server" | "list" | "override";
}

export interface CatalogModel {
  /** `${providerName}::${modelId}` — identity used for selection, cache and stats. */
  key: string;
  providerName: string;
  id: string;
  name: string;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Where the context window came from. */
  contextSource: "override" | "server" | "guess";
  caps: ModelCapabilities;
  status: ModelStatus;
  latencyMs?: number;
  error?: string;
  testedAt?: number;
  toolSupport?: ToolSupport;
  selected: boolean;
  isStatic: boolean;
  hasOverride: boolean;
  stats?: ModelStats;
  pricing?: ModelPricing;
  /** Native thinking support (Ollama `thinking` capability, Anthropic adaptive thinking). */
  thinkingSupported?: boolean;
}

export interface RouteView {
  name: string;
  /** Registration id suffix, also used as the route's identity in the UI. */
  slug: string;
  models: string[];
  /** Members that are currently working. */
  available: number;
}

export interface ProviderStatus {
  name: string;
  endpointUrl: string;
  enabled: boolean;
  kind: ProviderKind;
  /** undefined while discovery has not run yet. */
  online?: boolean;
  error?: string;
  latencyMs?: number;
  modelCount: number;
  checkedAt?: number;
  keySource: "secret" | "settings" | "none";
  remote: boolean;
  api: ApiKind;
  /** The server rejected our credentials (401/403) — on this machine the key is missing or wrong. */
  needsKey?: boolean;
  /** Header names whose values are kept in SecretStorage. */
  secretHeaderNames: string[];
  /** Header names that look secret but are still stored in plain-text settings. */
  plaintextSecretHeaders: string[];
}

export interface VerifiedCacheEntry {
  modelId: string;
  providerName: string;
  working: boolean;
  latency: number;
  /** Legacy (v2.0) boolean; superseded by toolSupport. */
  verifiedTools?: boolean;
  toolSupport?: ToolSupport;
  error?: string;
  testedAt: number;
}

export interface VerifiedCacheStore {
  updatedAt: number;
  entries: Record<string, VerifiedCacheEntry>;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  modelCount?: number;
  error?: string;
}

export function modelKey(providerName: string, modelId: string): string {
  return `${providerName}::${modelId}`;
}

export function splitKey(key: string): { providerName: string; modelId: string } | undefined {
  const at = key.indexOf("::");
  return at < 0 ? undefined : { providerName: key.slice(0, at), modelId: key.slice(at + 2) };
}
