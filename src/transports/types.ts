import { ProviderConfig } from "../types";

/** Credentials resolved for one request: the API key plus header values kept in SecretStorage. */
export interface Auth {
  apiKey?: string;
  secretHeaders: Record<string, string>;
}

/** OpenAI-style chat message; every transport converts from this neutral shape. */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | WirePart[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  cache_control?: boolean;
}
export type WirePart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface WireTool {
  name: string;
  description: string;
  parameters: object;
}

export interface ChatRequest {
  model: string;
  messages: WireMessage[];
  tools?: WireTool[];
  toolChoice?: "auto" | "required";
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Ask for usage numbers (OpenAI `stream_options`), when the server accepts it. */
  wantUsage: boolean;
  /** Request reasoning output when the model supports it. */
  reasoning: boolean;
  /** Ollama native only. */
  numCtx?: number;
  keepAlive?: string;
  /** The model supports native thinking (Ollama `think`, Anthropic adaptive thinking). */
  thinkingSupported?: boolean;
}

/** Receives streamed output. `text` may still contain inline <think> tags. */
export interface ChatSink {
  text(chunk: string): void;
  reasoning(chunk: string): void;
  toolCall(id: string, name: string, input: object): void;
}

export interface ChatResult {
  promptTokens?: number;
  completionTokens?: number;
}

/** A model as listed by a provider, normalized across APIs. */
export interface ListedModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  toolCalling?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  /** USD per million tokens, when the provider publishes prices. */
  inputPerM?: number;
  outputPerM?: number;
  /** Raw `owned_by`, used to recognise Ollama. */
  ownedBy?: string;
}

export interface ListResult {
  ok: boolean;
  latencyMs: number;
  models: ListedModel[];
  error?: string;
  status?: number;
}

/** Non-2xx answer received before any output was streamed. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

export interface Transport {
  listModels(p: ProviderConfig, auth: Auth, timeoutMs: number): Promise<ListResult>;
  chat(p: ProviderConfig, auth: Auth, req: ChatRequest, sink: ChatSink, signal: AbortSignal): Promise<ChatResult>;
}
