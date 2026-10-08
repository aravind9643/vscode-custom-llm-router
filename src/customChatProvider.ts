import * as vscode from "vscode";
import { ModelEngine, slug } from "./modelEngine";
import { CatalogModel, ProviderConfig } from "./types";
import { buildHeaders, describeFetchError, nativeRoot } from "./endpoints";
import { ChatRequest, ChatSink, HttpError, WireMessage, transportFor } from "./transports";

const REASONING_MARKER = "> 💭 *Thinking…*";
/** `LanguageModelChatMessageRole.System` exists at runtime (proposed API) but not in the stable typings. */
const ROLE_SYSTEM = 3;
const ROUTE_PREFIX = "route/";

/** An error whose message is already user-facing; passed through to the chat UI unchanged. */
class RouterError extends Error {}

/** A failure that happened before any output was streamed, so a route may try its next model. */
class RetryableError extends RouterError {}

type Progress = vscode.Progress<vscode.LanguageModelResponsePart>;

export class CustomLLMChatProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  /** Registration id → catalog key (models only; routes are resolved by slug). */
  private _routes = new Map<string, string>();
  private _lastSignature = "";
  private readonly _sub: vscode.Disposable;

  constructor(private readonly _engine: ModelEngine, private readonly _log: vscode.LogOutputChannel) {
    // Only tell VS Code to re-query when the exposed set actually changed.
    this._sub = _engine.onDidChange(() => {
      const sig = this._signature();
      if (sig !== this._lastSignature) {
        this._lastSignature = sig;
        this._onDidChange.fire();
      }
    });
  }

  private _signature() {
    const models = this._engine.getCopilotModels().map((m) => m.key + m.maxInputTokens + m.caps.tools + m.caps.vision + m.name);
    const routes = this._engine.getRoutes().map((r) => r.slug + r.available + r.models.join(","));
    return [...models, ...routes].join("|");
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    try {
      await this._engine.ensureDiscovered();
    } catch (err) {
      this._log.error("[copilot] discovery failed", err as Error);
    }
    this._routes.clear();
    const infos: vscode.LanguageModelChatInformation[] = this._engine.getCopilotModels().map((m) => {
      const id = registrationId(m);
      this._routes.set(id, m.key);
      return {
        id,
        name: m.name,
        family: slug(m.providerName),
        detail: m.providerName,
        tooltip: `${m.id} via ${m.providerName} · ${Math.round(m.contextWindow / 1000)}k context${m.latencyMs ? ` · ${m.latencyMs}ms` : ""}`,
        version: "1.0.0",
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
        capabilities: { toolCalling: m.caps.tools, imageInput: m.caps.vision },
      };
    });

    for (const r of this._engine.getRoutes()) {
      const members = this._engine.routeCandidates(r.slug).filter((m) => m.status === "working");
      if (!members.length) continue;
      infos.push({
        id: ROUTE_PREFIX + r.slug,
        name: r.name,
        family: "llm-router-route",
        detail: `Route · ${members.length} model${members.length === 1 ? "" : "s"}`,
        tooltip: `Tries in order: ${members.map((m) => `${m.name} (${m.providerName})`).join(" → ")}`,
        version: "1.0.0",
        // The route must fit its smallest member, since any of them may answer.
        maxInputTokens: Math.min(...members.map((m) => m.maxInputTokens)),
        maxOutputTokens: Math.min(...members.map((m) => m.maxOutputTokens)),
        capabilities: { toolCalling: members.some((m) => m.caps.tools), imageInput: members.some((m) => m.caps.vision) },
      });
    }
    return infos;
  }

  /** Returns the models to try for a registration id: one for a model, the ordered members for a route. */
  private _targets(info: vscode.LanguageModelChatInformation, requiredTokens?: number): CatalogModel[] {
    if (info.id.startsWith(ROUTE_PREFIX)) return this._engine.routeCandidates(info.id.slice(ROUTE_PREFIX.length), requiredTokens);
    const key = this._routes.get(info.id);
    const m = key ? this._engine.getModel(key) : this._engine.getModels().find((x) => registrationId(x) === info.id);
    return m ? [m] : [];
  }

  async provideLanguageModelChatResponse(
    info: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: Progress,
    token: vscode.CancellationToken
  ): Promise<void> {
    const isRoute = info.id.startsWith(ROUTE_PREFIX);
    const estTokens = isRoute ? Math.ceil(countRequestChars(messages) / 4) : undefined;
    let targets = this._targets(info, estTokens);
    if (!targets.length) {
      throw new RouterError(`"${info.name}" has no available models. Refresh models in the LLM Router dashboard.`);
    }
    if (isRoute && options.tools?.length) {
      // Agent mode needs tools: prefer members that can call them.
      const withTools = targets.filter((m) => m.caps.tools);
      if (withTools.length) targets = withTools;
    }

    const failures: string[] = [];
    for (const model of targets) {
      if (token.isCancellationRequested) return;
      try {
        await this._requestModel(model, messages, options, progress, token, isRoute);
        if (isRoute && failures.length) this._log.info(`[route] ${info.name}: answered by ${model.key} after ${failures.length} fallback(s)`);
        return;
      } catch (err) {
        if (token.isCancellationRequested) return;
        if (!(err instanceof RetryableError) || !isRoute) throw err;
        failures.push(`${model.name}: ${err.message}`);
        this._log.warn(`[route] ${info.name}: ${model.key} failed, trying next — ${err.message}`);
      }
    }
    throw new RouterError(`All models in route "${info.name}" failed:\n${failures.map((f) => `• ${f}`).join("\n")}`);
  }

  private async _requestModel(
    model: CatalogModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: Progress,
    token: vscode.CancellationToken,
    isRoute: boolean
  ): Promise<void> {
    const provider = this._engine.store.findProvider(model.providerName);
    if (!provider) throw new RetryableError(`Provider "${model.providerName}" is no longer configured.`);
    const api = this._engine.apiFor(provider);
    const mo = options.modelOptions || {};
    const req: ChatRequest = {
      model: model.id,
      messages: toOpenAIMessages(messages, model.caps.vision),
      wantUsage: true,
      reasoning: this._engine.store.showReasoning,
      thinkingSupported: model.thinkingSupported,
      temperature: typeof mo.temperature === "number" ? mo.temperature : undefined,
      topP: typeof mo.topP === "number" ? mo.topP : undefined,
      // Anthropic requires max_tokens; streaming makes a generous ceiling safe.
      maxTokens: typeof mo.maxTokens === "number" ? mo.maxTokens : api === "anthropic" ? Math.min(model.maxOutputTokens, 64000) : undefined,
      numCtx: api === "ollama" ? model.contextWindow : undefined,
      keepAlive: api === "ollama" ? provider.keepAlive : undefined,
    };
    if (options.tools?.length && model.caps.tools) {
      req.tools = options.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema || { type: "object", properties: {} } }));
      req.toolChoice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
    }

    const auth = await this._engine.store.getAuth(provider);
    const abort = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abort.abort());
    const started = Date.now();
    const tracked = new TrackingProgress(progress);
    const out = new ReasoningWriter(tracked, this._engine.store.showReasoning);
    const thinkTags = new ThinkTagSplitter();
    // Tool calls are reported after the text so Copilot shows the explanation first.
    const calls: vscode.LanguageModelToolCallPart[] = [];
    const sink: ChatSink = {
      text: (chunk) => {
        for (const seg of thinkTags.push(chunk)) seg.think ? out.reasoning(seg.text) : out.text(seg.text);
      },
      reasoning: (chunk) => out.reasoning(chunk),
      toolCall: (id, name, input) => {
        if (!name) return;
        tracked.markStarted();
        calls.push(new vscode.LanguageModelToolCallPart(id, name, input));
      },
    };

    try {
      const transport = transportFor(api);
      let result;
      try {
        result = await transport.chat(provider, auth, req, sink, abort.signal);
      } catch (err) {
        // One retry for rate limits / server errors — but not inside a route, where the next model is faster.
        if (!(err instanceof HttpError) || !(err.status === 429 || err.status >= 500) || isRoute || tracked.firstAt || token.isCancellationRequested) throw err;
        await new Promise((r) => setTimeout(r, Math.min(err.retryAfterMs ?? 1500, 8000)));
        if (token.isCancellationRequested) return;
        result = await transport.chat(provider, auth, req, sink, abort.signal);
      }
      if (token.isCancellationRequested) return;
      for (const seg of thinkTags.flush()) seg.think ? out.reasoning(seg.text) : out.text(seg.text);
      out.end();
      for (const call of calls) tracked.report(call);

      this._engine.recordChat(model.key, {
        ok: true,
        ttftMs: tracked.firstAt ? tracked.firstAt - started : undefined,
        durationMs: Date.now() - started,
        promptTokens: result.promptTokens,
        outputTokens: result.completionTokens ?? Math.round(tracked.chars / this._engine.charsPerToken(model.key)),
      });
      if (result.promptTokens) this._engine.recordPromptUsage(model.key, countRequestChars(messages), result.promptTokens);
      if (api !== "ollama") this._keepAlive(provider, model);
    } catch (err: any) {
      if (token.isCancellationRequested) return;
      this._engine.recordChat(model.key, { ok: false });
      // Once output reached the user, falling back to another model would garble the answer.
      const Retry = tracked.firstAt ? RouterError : RetryableError;
      if (err instanceof HttpError) {
        this._log.warn(`[chat] ${model.key}: ${err.message}`);
        if (err.status === 429 || err.status >= 500) {
          this._engine.backoffModel(model.key, Math.min(err.retryAfterMs ?? 30000, 60000));
        }
        // Only definitive "this model does not exist here" errors evict a model from Copilot.
        if (err.status === 404 || /model.*(not found|does not exist|not available)/i.test(err.message)) {
          this._engine.markFailed(model.providerName, model.id, err.message);
        }
        const hint = err.status === 401 || err.status === 403 ? " — check the provider's API key (keys are stored per machine)." : "";
        throw new Retry(`${model.providerName} rejected the request (${err.message})${hint}`);
      }
      if (err instanceof RouterError) throw err;
      const detail = err?.message && !/fetch failed|aborted|timeout/i.test(err.message) ? err.message : describeFetchError(err);
      throw new Retry(err?.message?.startsWith("Claude declined") || err?.message?.startsWith("Provider error") || err?.message?.startsWith("Ollama error") ? detail : `Connection to ${model.providerName} failed: ${detail}`);
    } finally {
      cancelSub.dispose();
    }
  }

  /** Ollama unloads idle models after 5 minutes; re-arm the user's keep-alive after each answer. */
  private _keepAlive(provider: ProviderConfig, model: CatalogModel) {
    if (!provider.keepAlive) return;
    const kind = this._engine.getProviderStatuses().find((s) => s.name === provider.name)?.kind;
    if (kind !== "ollama") return; // native transport sends keep_alive with the request itself
    void (async () => {
      try {
        const res = await fetch(`${nativeRoot(provider)}/api/generate`, {
          method: "POST",
          headers: buildHeaders(provider, await this._engine.store.getAuth(provider)),
          body: JSON.stringify({ model: model.id, keep_alive: /^-?\d+$/.test(provider.keepAlive!) ? Number(provider.keepAlive) : provider.keepAlive }),
          signal: AbortSignal.timeout(10000),
        });
        await res.text().catch(() => undefined);
      } catch (err) {
        this._log.warn(`[ollama] keep-alive for ${model.id} failed: ${describeFetchError(err)}`);
      }
    })();
  }

  async provideTokenCount(
    info: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const target = this._targets(info)[0];
    const ratio = target ? this._engine.charsPerToken(target.key) : 4;
    const chars = typeof text === "string" ? text.length : countMessageChars(text);
    return Math.max(1, Math.ceil(chars / ratio));
  }

  dispose() {
    this._sub.dispose();
    this._onDidChange.dispose();
  }
}

// ---------------------------------------------------------------- messages

const IMAGE_CHAR_ESTIMATE = 3000;

function countMessageChars(msg: vscode.LanguageModelChatRequestMessage): number {
  let chars = 0;
  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelTextPart) chars += part.value.length;
    else if (part instanceof vscode.LanguageModelToolCallPart) chars += JSON.stringify(part.input ?? {}).length + part.name.length;
    else if (part instanceof vscode.LanguageModelToolResultPart) chars += toolResultText(part).length;
    else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) chars += IMAGE_CHAR_ESTIMATE;
  }
  return chars;
}

function countRequestChars(messages: readonly vscode.LanguageModelChatRequestMessage[]): number {
  return messages.reduce((n, m) => n + countMessageChars(m), 0);
}

function toOpenAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], allowImages: boolean): WireMessage[] {
  const out: any[] = [];
  for (const msg of messages) {
    const role =
      (msg.role as number) === ROLE_SYSTEM ? "system" : msg.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
    let text = "";
    const images: any[] = [];
    const toolCalls: any[] = [];

    let hasCacheControl = false;
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({ id: part.callId, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        // OpenAI requires tool results immediately after the assistant turn that requested them.
        out.push({ role: "tool", tool_call_id: part.callId, content: toolResultText(part) });
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (part.mimeType === "cache_control" || part.mimeType.includes("cache")) {
          hasCacheControl = true;
        } else if (allowImages && part.mimeType.startsWith("image/")) {
          images.push({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}` } });
        }
      }
    }

    if (role === "assistant") text = stripReasoning(text);
    let entry: any;
    if (toolCalls.length) {
      entry = { role: "assistant", content: text || null, tool_calls: toolCalls };
      out.push(entry);
    } else if (images.length) {
      entry = { role, content: [...(text ? [{ type: "text", text }] : []), ...images] };
      out.push(entry);
    } else if (text) {
      // Merge consecutive system messages; some servers only accept one.
      const prev = out[out.length - 1];
      if (role === "system" && prev?.role === "system") {
        prev.content += `\n\n${text}`;
        entry = prev;
      } else {
        entry = { role, content: text };
        out.push(entry);
      }
    }
    if (entry && hasCacheControl) entry.cache_control = true;
  }
  return out;
}

function toolResultText(part: vscode.LanguageModelToolResultPart): string {
  let s = "";
  for (const c of part.content) {
    if (c instanceof vscode.LanguageModelTextPart) s += c.value;
    else if (typeof c === "string") s += c;
    else if (c && typeof c === "object" && "value" in c) s += String((c as any).value);
  }
  return s;
}

/** Removes the rendered reasoning block from earlier assistant turns so it is not re-sent as context. */
export function stripReasoning(text: string): string {
  if (!text.includes(REASONING_MARKER)) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith(REASONING_MARKER)) {
      skipping = true;
      continue;
    }
    if (skipping && line.startsWith(">")) continue;
    skipping = false;
    kept.push(line);
  }
  return kept.join("\n").replace(/^\s+/, "");
}

// ------------------------------------------------------------------ stream

/** Wraps the Copilot progress sink to measure time-to-first-output and output size. */
class TrackingProgress implements Progress {
  firstAt?: number;
  chars = 0;
  constructor(private readonly _inner: Progress) {}
  markStarted() {
    this.firstAt ??= Date.now();
  }
  report(part: vscode.LanguageModelResponsePart) {
    this.markStarted();
    if (part instanceof vscode.LanguageModelTextPart) this.chars += part.value.length;
    this._inner.report(part);
  }
}

/** Renders reasoning as a quoted block ahead of the answer (no stable thinking part exists yet). */
class ReasoningWriter {
  private _inReasoning = false;
  constructor(private readonly _progress: Progress, private readonly _show: boolean) {}

  reasoning(chunk: string) {
    if (!this._show) return;
    if (!this._inReasoning) {
      this._inReasoning = true;
      this._progress.report(new vscode.LanguageModelTextPart(`${REASONING_MARKER}\n> `));
    }
    this._progress.report(new vscode.LanguageModelTextPart(chunk.replace(/\n/g, "\n> ")));
  }

  text(chunk: string) {
    if (this._inReasoning) {
      this._inReasoning = false;
      this._progress.report(new vscode.LanguageModelTextPart("\n\n"));
      chunk = chunk.replace(/^\n+/, "");
      if (!chunk) return;
    }
    this._progress.report(new vscode.LanguageModelTextPart(chunk));
  }

  end() {
    if (this._inReasoning) this._progress.report(new vscode.LanguageModelTextPart("\n\n"));
    this._inReasoning = false;
  }
}

/** Splits `<think>…</think>` content out of a text stream, even when a tag straddles two chunks. */
export class ThinkTagSplitter {
  private _inThink = false;
  private _pending = "";

  push(chunk: string): { think: boolean; text: string }[] {
    const segs: { think: boolean; text: string }[] = [];
    let buf = this._pending + chunk;
    this._pending = "";
    while (buf) {
      const tag = this._inThink ? "</think>" : "<think>";
      const at = buf.indexOf(tag);
      if (at >= 0) {
        if (at > 0) segs.push({ think: this._inThink, text: buf.slice(0, at) });
        this._inThink = !this._inThink;
        buf = buf.slice(at + tag.length);
        continue;
      }
      // Hold back a trailing partial tag such as "<thi" until the next chunk arrives.
      let keep = 0;
      for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--) {
        if (tag.startsWith(buf.slice(-n))) {
          keep = n;
          break;
        }
      }
      const emit = buf.slice(0, buf.length - keep);
      if (emit) segs.push({ think: this._inThink, text: emit });
      this._pending = buf.slice(buf.length - keep);
      break;
    }
    return segs;
  }

  flush(): { think: boolean; text: string }[] {
    const rest = this._pending;
    this._pending = "";
    return rest ? [{ think: this._inThink, text: rest }] : [];
  }
}

function registrationId(m: CatalogModel) {
  return `${slug(m.providerName)}/${m.id}`;
}
