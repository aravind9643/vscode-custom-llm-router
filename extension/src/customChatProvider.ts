import * as vscode from "vscode";
import { ModelEngine, VSCodeModel } from "./modelEngine";

export class CustomLLMChatProvider implements vscode.LanguageModelChatProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  private engine: ModelEngine;
  private cachedModels: VSCodeModel[] = [];
  private modelVendorMap: Map<string, { endpointUrl: string; apiKey: string }> = new Map();

  constructor(engine: ModelEngine) {
    this.engine = engine;
  }

  public notifyModelsChanged(): void {
    this._onDidChange.fire();
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    try {
      this.engine.reloadConfig();
      // Generate providers list (respects models.config.json blacklist/whitelist)
      const providers = await this.engine.generateProviders({
        skipTest: true,
        forceRefresh: true,
      });

      const result: vscode.LanguageModelChatInformation[] = [];
      this.cachedModels = [];
      this.modelVendorMap.clear();

      for (const prov of providers) {
        const familyName = prov.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
        for (const m of prov.models) {
          this.cachedModels.push(m);
          this.modelVendorMap.set(m.id, {
            endpointUrl: m.url,
            apiKey: prov.apiKey,
          });

          result.push({
            id: m.id,
            name: `${m.name} (${prov.name})`,
            family: familyName,
            tooltip: `Model ${m.id} on ${prov.name} (${m.url})`,
            detail: `${prov.name} • ${m.contextWindow ? Math.round(m.contextWindow / 1000) + 'k ctx' : 'OpenAI compatible'}`,
            version: "1.0.0",
            maxInputTokens: m.maxInputTokens || 128000,
            maxOutputTokens: m.maxOutputTokens || 8192,
            capabilities: {
              toolCalling: m.toolCalling ?? true,
              imageInput: m.vision ?? false,
            },
          });
        }
      }

      return result;
    } catch (err: any) {
      console.error("[CustomLLMChatProvider] provideLanguageModelChatInformation error:", err);
      return [];
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const routing = this.modelVendorMap.get(model.id);
    const endpointBase = routing?.endpointUrl || this.engine.omniUrl || "http://localhost:20128";
    const apiKey = routing?.apiKey || this.engine.omniKey || "";

    // Convert VS Code messages into OpenAI Chat Completion messages format
    const formattedMessages: any[] = [];

    for (const msg of messages) {
      const role = msg.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
      
      let textContent = "";
      const toolCalls: any[] = [];

      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textContent += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId,
            type: "function",
            function: {
              name: part.name,
              arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
            },
          });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          // Tool results in OpenAI are individual messages with role: "tool"
          let toolResultText = "";
          for (const sub of part.content) {
            if (sub instanceof vscode.LanguageModelTextPart) {
              toolResultText += sub.value;
            } else if (typeof sub === "string") {
              toolResultText += sub;
            } else if (typeof sub === "object" && sub !== null && "value" in sub) {
              toolResultText += String((sub as any).value);
            }
          }
          formattedMessages.push({
            role: "tool",
            tool_call_id: part.callId,
            content: toolResultText,
          });
        } else if (typeof part === "string") {
          textContent += part;
        }
      }

      if (toolCalls.length > 0) {
        formattedMessages.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolCalls,
        });
      } else if (textContent.length > 0) {
        formattedMessages.push({
          role,
          content: textContent,
        });
      }
    }

    // Format tools if provided
    const requestTools: any[] = [];
    if (options.tools && options.tools.length > 0) {
      for (const tool of options.tools) {
        requestTools.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema || { type: "object", properties: {} },
          },
        });
      }
    }

    const requestBody: any = {
      model: model.id,
      messages: formattedMessages,
      stream: true,
    };

    if (requestTools.length > 0) {
      requestBody.tools = requestTools;
    }

    // Initiate streaming POST request to OpenAI compatible endpoint
    const url = `${endpointBase.replace(/\/+$/, "")}/v1/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      const errorMsg = `Error from ${model.id} (${response.status}): ${errText}`;
      progress.report(new vscode.LanguageModelTextPart(`\n\n⚠️ **${errorMsg}**\n`));
      return;
    }

    if (!response.body) {
      return;
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    // Tool call accumulator: index -> { id, name, args }
    const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

    while (true) {
      if (token.isCancellationRequested) {
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") {
          break;
        }

        try {
          const parsed = JSON.parse(dataStr);
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (!delta) continue;

          // 1. Text delta
          if (delta.content) {
            progress.report(new vscode.LanguageModelTextPart(delta.content));
          }

          // 2. Reasoning / Thinking delta (if supported by OmniRoute / DeepSeek R1)
          if (delta.reasoning_content && !delta.content) {
            // Stream thinking as italic/blockquote or raw text part if available
            progress.report(new vscode.LanguageModelTextPart(delta.reasoning_content));
          }

          // 3. Tool call deltas
          if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let call = pendingToolCalls.get(idx);
              if (!call) {
                call = { id: tc.id || `call_${Date.now()}_${idx}`, name: tc.function?.name || "", args: "" };
                pendingToolCalls.set(idx, call);
              }
              if (tc.id) call.id = tc.id;
              if (tc.function?.name) call.name += tc.function.name;
              if (tc.function?.arguments) call.args += tc.function.arguments;
            }
          }
        } catch {
          // ignore chunk parse issues
        }
      }
    }

    // Emit completed tool calls if any
    for (const [, call] of pendingToolCalls) {
      try {
        const parsedArgs = call.args ? JSON.parse(call.args) : {};
        progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedArgs));
      } catch {
        progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, { raw: call.args }));
      }
    }
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    // Standard fast heuristic: ~4 characters per token
    if (typeof text === "string") {
      return Math.ceil(text.length / 4);
    }
    
    let totalLength = 0;
    if (text && typeof text === "object" && Array.isArray((text as any).content)) {
      for (const part of (text as any).content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          totalLength += part.value.length;
        } else if (typeof part === "string") {
          totalLength += (part as string).length;
        } else if (part && typeof part === "object" && "value" in part) {
          totalLength += String(part.value).length;
        }
      }
    }
    return Math.max(1, Math.ceil(totalLength / 4));
  }
}
