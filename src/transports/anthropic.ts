import Anthropic from "@anthropic-ai/sdk";
import { ProviderConfig } from "../types";
import { describeFetchError, normalizeBaseUrl } from "../endpoints";
import { Auth, ChatRequest, ChatResult, ChatSink, HttpError, ListResult, Transport, WireMessage, WirePart } from "./types";

/**
 * List prices (USD per million tokens) for current Claude models, used for spend estimates.
 * Anthropic's Models API does not return prices; users can correct these per model with an override.
 */
const LIST_PRICES: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

/** Models that accept the server-side refusal fallback in its `"default"` form on the Claude API. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function client(p: ProviderConfig, auth: Auth, timeoutMs: number): Anthropic {
  // The SDK appends /v1/... itself.
  const baseURL = normalizeBaseUrl(p.endpointUrl).replace(/\/v1$/i, "");
  return new Anthropic({
    apiKey: auth.apiKey ?? null,
    baseURL,
    defaultHeaders: { ...(p.headers || {}), ...auth.secretHeaders },
    maxRetries: 0, // the chat provider owns retries and route fallback
    timeout: timeoutMs,
  });
}

function isFirstParty(p: ProviderConfig): boolean {
  try {
    return new URL(p.endpointUrl).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

export const anthropicTransport: Transport = {
  async listModels(p, auth, timeoutMs): Promise<ListResult> {
    const start = Date.now();
    const customAuth = Object.keys({ ...(p.headers || {}), ...auth.secretHeaders }).some((h) => /^(x-api-key|authorization)$/i.test(h));
    if (!auth.apiKey && !customAuth) {
      // The SDK refuses to send without credentials; report it like the server would.
      return { ok: false, latencyMs: 0, models: [], status: 401, error: "No API key set for this provider" };
    }
    try {
      const models = [];
      for await (const m of client(p, auth, timeoutMs).models.list({ limit: 100 })) {
        const caps: any = m.capabilities;
        const price = LIST_PRICES[m.id];
        models.push({
          id: m.id,
          name: m.display_name,
          contextWindow: m.max_input_tokens ?? undefined,
          maxOutputTokens: m.max_tokens ?? undefined,
          toolCalling: true,
          vision: caps ? Boolean(caps.image_input?.supported) : undefined,
          reasoning: caps ? Boolean(caps.thinking?.types?.adaptive?.supported) : undefined,
          inputPerM: price?.[0],
          outputPerM: price?.[1],
        });
      }
      return { ok: true, latencyMs: Date.now() - start, models };
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof Anthropic.APIError && err.status) {
        return { ok: false, latencyMs, models: [], status: err.status, error: `HTTP ${err.status}: ${apiMessage(err)}` };
      }
      return { ok: false, latencyMs, models: [], error: describeFetchError(err) };
    }
  },

  async chat(p, auth, req, sink, signal): Promise<ChatResult> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const params: any = {
      model: req.model,
      // max_tokens is required; streaming makes a large ceiling safe.
      max_tokens: req.maxTokens ?? 32000,
      messages,
    };
    if (system) params.system = system;
    // Current Claude models reject temperature/top_p and forced tool_choice, so neither is sent.
    if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true }));
      params.tool_choice = { type: "auto" };
    }
    if (req.thinkingSupported) params.thinking = { type: "adaptive", display: req.reasoning ? "summarized" : "omitted" };
    if (isFirstParty(p) && FALLBACK_MODELS.has(req.model)) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = "default";
    }

    try {
      const stream = client(p, auth, 10 * 60 * 1000).beta.messages.stream(params, { signal });
      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") sink.text(event.delta.text);
        else if (event.delta.type === "thinking_delta") sink.reasoning(event.delta.thinking);
      }
      const final: any = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        const category = final.stop_details?.category;
        throw new Error(`Claude declined this request${category ? ` (${category})` : ""}.`);
      }
      const toolUses = (final.content || []).filter((b: any) => b.type === "tool_use");
      if (final.stop_reason === "max_tokens" && toolUses.length) {
        throw new Error("The response hit max_tokens while writing a tool call; the call was not run. Try again or raise the model's max output.");
      }
      for (const b of toolUses) {
        // With eager input streaming the input is not validated server-side; only pass objects on.
        if (!b.input || typeof b.input !== "object" || Array.isArray(b.input)) throw new Error(`Tool call ${b.name} had malformed input.`);
        sink.toolCall(b.id, b.name, b.input);
      }
      const u = final.usage || {};
      return {
        promptTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        completionTokens: u.output_tokens,
      };
    } catch (err) {
      if (err instanceof Anthropic.APIError && err.status) {
        const retryAfter = Number(err.headers?.get?.("retry-after"));
        throw new HttpError(err.status, `HTTP ${err.status}: ${apiMessage(err)}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
      }
      throw err;
    }
  },
};

function apiMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const e: any = err.error;
  return (e?.error?.message || e?.message || err.message || "").replace(/\s+/g, " ").slice(0, 200);
}

/** OpenAI-style messages → Anthropic: system hoisted, tool calls as tool_use, results as tool_result in user turns. */
export function toAnthropicMessages(input: WireMessage[]): { system?: string; messages: any[] } {
  const system: string[] = [];
  const out: { role: "user" | "assistant"; content: any[] }[] = [];
  const push = (role: "user" | "assistant", blocks: any[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  const blocksOf = (content: WireMessage["content"]) => {
    const parts: WirePart[] = typeof content === "string" ? [{ type: "text", text: content }] : content || [];
    return parts
      .map((x) => {
        if (x.type === "text") return x.text ? { type: "text", text: x.text } : undefined;
        const m = /^data:([^;]+);base64,(.*)$/s.exec(x.image_url.url);
        return m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : undefined;
      })
      .filter(Boolean);
  };

  for (const m of input) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : blocksOf(m.content).map((b: any) => b.text || "").join("");
      if (text) system.push(text);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : "" }]);
    } else if (m.role === "assistant") {
      const blocks: any[] = blocksOf(m.content);
      for (const c of m.tool_calls || []) {
        let args: unknown = {};
        try {
          args = JSON.parse(c.function.arguments || "{}");
        } catch {
          // keep {}
        }
        blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input: args });
      }
      push("assistant", blocks);
    } else {
      push("user", blocksOf(m.content));
    }
  }
  // The API requires the conversation to start with a user turn.
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: [{ type: "text", text: "(continued)" }] });
  return { system: system.join("\n\n") || undefined, messages: out };
}
