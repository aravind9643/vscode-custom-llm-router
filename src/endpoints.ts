import { ApiKind, ProviderConfig, ProviderKind } from "./types";
import type { Auth } from "./transports/types";

export const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Normalizes a provider base URL: trims whitespace and trailing slashes and strips a
 * pasted `/chat/completions` or `/models` suffix so both forms resolve identically.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw || "").trim().replace(/\/+$/, "");
  url = url.replace(/\/(chat\/completions|models)$/i, "");
  return url.replace(/\/+$/, "");
}

/** True when the base already carries an API version segment (`/v1`, `/api/v1`, `/v1beta/openai`, ...). */
function hasVersionSegment(base: string): boolean {
  return /\/(v\d+[a-z0-9]*|openai)$/i.test(base);
}

function apiRoot(base: string): string {
  return hasVersionSegment(base) ? base : `${base}/v1`;
}

export function resolveChatUrl(p: ProviderConfig): string {
  if (p.chatEndpoint && p.chatEndpoint.trim()) return p.chatEndpoint.trim();
  return `${apiRoot(normalizeBaseUrl(p.endpointUrl))}/chat/completions`;
}

export function resolveModelsUrl(p: ProviderConfig): string {
  if (p.modelsEndpoint && p.modelsEndpoint.trim()) return p.modelsEndpoint.trim();
  const url = `${apiRoot(normalizeBaseUrl(p.endpointUrl))}/models`;
  // FreeLLMAPI lists every model unless asked for the ready ones only.
  return p.name === "FreeLLMAPI" ? `${url}?execution_status=ready` : url;
}

/** Server root without the OpenAI version segment, for native APIs such as Ollama's `/api/show`. */
export function nativeRoot(p: ProviderConfig): string {
  return normalizeBaseUrl(p.endpointUrl).replace(/\/v\d+[a-z0-9]*$/i, "");
}

/** True for loopback / private-network hosts, where health checks cost nothing. */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "host.docker.internal"
  );
}

/** Header names that carry credentials; their values go to SecretStorage, not settings. */
export function isSecretHeaderName(name: string): boolean {
  return /(key|token|auth|secret|password|cookie|credential)/i.test(name);
}

export function buildHeaders(p: ProviderConfig, auth: Auth, accept: "json" | "sse" = "json"): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept === "json" ? "application/json" : "text/event-stream", "Content-Type": "application/json" };
  if (auth.apiKey) {
    if (p.authHeader === "api-key") headers["api-key"] = auth.apiKey;
    else if (p.authHeader === "x-api-key") headers["x-api-key"] = auth.apiKey;
    else headers["Authorization"] = `Bearer ${auth.apiKey}`;
  }
  for (const [k, v] of Object.entries(p.headers || {})) {
    if (k && typeof v === "string" && v) headers[k] = v;
  }
  for (const [k, v] of Object.entries(auth.secretHeaders || {})) {
    if (k && v) headers[k] = v;
  }
  return headers;
}

/** Wire protocol for a provider: explicit setting first, then what the server looks like. */
export function resolveApi(p: ProviderConfig, kind: ProviderKind): ApiKind {
  if (p.api) return p.api;
  if (kind === "ollama") return "ollama";
  try {
    if (new URL(p.endpointUrl).hostname === "api.anthropic.com") return "anthropic";
  } catch {
    // invalid URL — fall through
  }
  return "openai";
}

export function timeoutFor(p: ProviderConfig, fallback = DEFAULT_TIMEOUT_MS): number {
  return p.timeoutMs && p.timeoutMs > 0 ? p.timeoutMs : fallback;
}

export function describeFetchError(err: any): string {
  if (!err) return "Unknown error";
  if (err.name === "TimeoutError" || err.name === "AbortError") return "Timed out";
  const cause = err.cause?.code || err.cause?.message;
  return cause ? `${err.message} (${cause})` : err.message || String(err);
}

/** Extracts a short human-readable message from an OpenAI-style error body. */
export function summarizeErrorBody(status: number, body: string): string {
  let msg = body;
  try {
    const parsed = JSON.parse(body);
    msg = parsed?.error?.message || parsed?.message || parsed?.detail || body;
    if (typeof msg !== "string") msg = JSON.stringify(msg);
  } catch {
    // not JSON — keep raw text
  }
  msg = msg.replace(/\s+/g, " ").trim().slice(0, 200);
  return `HTTP ${status}${msg ? `: ${msg}` : ""}`;
}
