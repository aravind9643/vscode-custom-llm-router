import { ProviderConfig } from "../types";
import { buildHeaders, describeFetchError, resolveChatUrl, resolveModelsUrl, summarizeErrorBody } from "../endpoints";
import { Auth, ChatRequest, ChatResult, ChatSink, HttpError, ListResult, ListedModel, Transport } from "./types";

/** Providers that rejected `stream_options` once; usage is not requested from them again. */
const noStreamOptions = new Set<string>();

export const openaiTransport: Transport = {
  async listModels(p, auth, timeoutMs): Promise<ListResult> {
    const start = Date.now();
    try {
      const res = await fetch(resolveModelsUrl(p), { headers: buildHeaders(p, auth), signal: AbortSignal.timeout(timeoutMs) });
      const latencyMs = Date.now() - start;
      const text = await res.text();
      if (!res.ok) return { ok: false, latencyMs, models: [], status: res.status, error: summarizeErrorBody(res.status, text) };
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, latencyMs, models: [], error: "Endpoint did not return JSON — check the base URL." };
      }
      const list: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
      return { ok: true, latencyMs, models: list.map(toListedModel).filter((m): m is ListedModel => !!m) };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, models: [], error: describeFetchError(err) };
    }
  },

  async chat(p, auth, req, sink, signal): Promise<ChatResult> {
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: true };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: t }));
      body.tool_choice = req.toolChoice === "required" ? "required" : "auto";
    }
    const wantUsage = req.wantUsage && !noStreamOptions.has(p.name);
    if (wantUsage) body.stream_options = { include_usage: true };

    const url = resolveChatUrl(p);
    const headers = buildHeaders(p, auth, "sse");
    let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });

    // Some servers reject unknown fields; retry once without the usage request and remember that.
    if (!res.ok && wantUsage && (res.status === 400 || res.status === 422)) {
      const text = await res.text().catch(() => "");
      if (/stream_options|include_usage|extra (inputs|fields)|unrecognized|unknown (field|param)/i.test(text)) {
        noStreamOptions.add(p.name);
        delete body.stream_options;
        res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
      } else {
        throw new HttpError(res.status, summarizeErrorBody(res.status, text));
      }
    }
    if (!res.ok) throw await httpError(res);
    if (!res.body) throw new HttpError(502, "Empty response body");
    return readSse(res.body, sink, signal);
  },
};

export async function httpError(res: Response): Promise<HttpError> {
  const retryAfter = Number(res.headers.get("retry-after"));
  return new HttpError(res.status, summarizeErrorBody(res.status, await res.text().catch(() => "")), Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
}

function toListedModel(r: any): ListedModel | undefined {
  const id = r?.id || r?.model;
  if (typeof id !== "string") return undefined;
  // OpenRouter & compatible providers: pricing in USD per token or per million tokens
  const perM = (v: unknown) => {
    const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
  };
  const promptRaw = r.pricing?.prompt ?? r.pricing?.input ?? r.pricing?.input_cost_per_token;
  const completionRaw = r.pricing?.completion ?? r.pricing?.output ?? r.pricing?.output_cost_per_token;
  const promptPerM = num(r.pricing?.prompt_per_million ?? r.pricing?.input_per_million) ?? perM(promptRaw);
  const completionPerM = num(r.pricing?.completion_per_million ?? r.pricing?.output_per_million) ?? perM(completionRaw);

  return {
    id,
    name: typeof r.name === "string" ? r.name : undefined,
    contextWindow: num(r.context_window ?? r.contextWindow ?? r.context_length ?? r.max_model_len ?? r.max_context_length),
    maxOutputTokens: num(r.max_output_tokens ?? r.maxOutputTokens ?? r.top_provider?.max_completion_tokens),
    maxInputTokens: num(r.maxInputTokens),
    toolCalling: typeof r.toolCalling === "boolean" ? r.toolCalling : Array.isArray(r.supported_parameters) ? r.supported_parameters.includes("tools") : undefined,
    vision: Boolean(r.vision || r.supports_vision || r.architecture?.input_modalities?.includes?.("image")) || undefined,
    inputPerM: promptPerM,
    outputPerM: completionPerM,
    ownedBy: typeof r.owned_by === "string" ? r.owned_by : undefined,
  };
}

export function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Parses an OpenAI chat-completions SSE stream. */
async function readSse(stream: ReadableStream<Uint8Array>, sink: ChatSink, signal: AbortSignal): Promise<ChatResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  const usage: ChatResult = {};
  let buffer = "";
  let finished = false;
  try {
    while (!finished && !signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          finished = true;
          break;
        }
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk?.error) throw new Error(`Provider error: ${chunk.error.message || JSON.stringify(chunk.error)}`);
        if (chunk?.usage) {
          if (typeof chunk.usage.prompt_tokens === "number") usage.promptTokens = chunk.usage.prompt_tokens;
          if (typeof chunk.usage.completion_tokens === "number") usage.completionTokens = chunk.usage.completion_tokens;
        }
        const delta = chunk?.choices?.[0]?.delta;
        if (!delta) continue;
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning) sink.reasoning(reasoning);
        if (typeof delta.content === "string" && delta.content) sink.text(delta.content);
        for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const idx = typeof tc.index === "number" ? tc.index : toolCalls.size;
          let call = toolCalls.get(idx);
          if (!call) toolCalls.set(idx, (call = { id: "", name: "", args: "" }));
          if (tc.id) call.id = tc.id;
          if (tc.function?.name && !call.name) call.name = tc.function.name;
          if (tc.function?.arguments) call.args += tc.function.arguments;
        }
      }
    }
  } finally {
    // Release the connection: servers may keep the stream open after [DONE].
    void reader.cancel().catch(() => undefined);
  }
  for (const [idx, call] of toolCalls) {
    if (!call.name) continue;
    let input: object = {};
    try {
      const parsed = call.args.trim() ? JSON.parse(call.args) : {};
      if (parsed && typeof parsed === "object") input = parsed;
    } catch {
      // malformed arguments — pass an empty object rather than failing the turn
    }
    sink.toolCall(call.id || `call_${Date.now()}_${idx}`, call.name, input);
  }
  return usage;
}
