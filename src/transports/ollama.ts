import { buildHeaders, nativeRoot } from "../endpoints";
import { openaiTransport, httpError } from "./openai";
import { ChatResult, HttpError, Transport, WireMessage, WirePart } from "./types";

/**
 * Ollama's native `/api/chat`. Unlike its OpenAI-compatible endpoint it accepts `num_ctx`, so long
 * Copilot conversations are not silently truncated at Ollama's default context length.
 */
export const ollamaTransport: Transport = {
  // Ollama's /v1/models works and is what discovery already understands.
  listModels: (p, auth, timeoutMs) => openaiTransport.listModels(p, auth, timeoutMs),

  async chat(p, auth, req, sink, signal): Promise<ChatResult> {
    const options: Record<string, number> = {};
    if (req.numCtx) options.num_ctx = req.numCtx;
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.topP !== undefined) options.top_p = req.topP;
    if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;

    const body: Record<string, unknown> = { model: req.model, messages: toOllamaMessages(req.messages), stream: true, options };
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: t }));
    if (req.keepAlive) body.keep_alive = /^-?\d+$/.test(req.keepAlive) ? Number(req.keepAlive) : req.keepAlive;
    if (req.thinkingSupported) body.think = req.reasoning;

    const res = await fetch(`${nativeRoot(p)}/api/chat`, {
      method: "POST",
      headers: buildHeaders(p, auth),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await httpError(res);
    if (!res.body) throw new HttpError(502, "Empty response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const usage: ChatResult = {};
    let buffer = "";
    let calls = 0;
    try {
      for (;;) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.error) throw new Error(`Ollama error: ${evt.error}`);
          const msg = evt.message;
          if (typeof msg?.thinking === "string" && msg.thinking) sink.reasoning(msg.thinking);
          if (typeof msg?.content === "string" && msg.content) sink.text(msg.content);
          for (const tc of Array.isArray(msg?.tool_calls) ? msg.tool_calls : []) {
            const args = tc.function?.arguments;
            const input = typeof args === "string" ? safeJson(args) : args && typeof args === "object" ? args : {};
            sink.toolCall(tc.id || `call_${Date.now()}_${calls++}`, tc.function?.name || "", input);
          }
          if (evt.done) {
            if (typeof evt.prompt_eval_count === "number") usage.promptTokens = evt.prompt_eval_count;
            if (typeof evt.eval_count === "number") usage.completionTokens = evt.eval_count;
          }
        }
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    return usage;
  },
};

function safeJson(s: string): object {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** OpenAI-style messages → Ollama: images as bare base64, tool arguments as objects. */
export function toOllamaMessages(messages: WireMessage[]): any[] {
  const toolNames = new Map<string, string>();
  return messages.map((m) => {
    const parts: WirePart[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
    const text = parts.filter((x): x is { type: "text"; text: string } => x.type === "text").map((x) => x.text).join("");
    const images = parts
      .filter((x): x is { type: "image_url"; image_url: { url: string } } => x.type === "image_url")
      .map((x) => x.image_url.url.replace(/^data:[^;]+;base64,/, ""));
    const out: any = { role: m.role, content: text };
    if (images.length) out.images = images;
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((c) => {
        toolNames.set(c.id, c.function.name);
        return { function: { name: c.function.name, arguments: safeJson(c.function.arguments) } };
      });
    }
    if (m.role === "tool" && m.tool_call_id) out.tool_name = toolNames.get(m.tool_call_id);
    return out;
  });
}
