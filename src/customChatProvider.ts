import * as vscode from "vscode";
import { ModelEngine, VSCodeModel } from "./modelEngine";

export class CustomLLMChatProvider implements vscode.LanguageModelChatProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  private engine: ModelEngine;
  private cachedModels: VSCodeModel[] = [];
  private modelVendorMap: Map<string, { endpointUrl: string; apiKey: string; providerName: string; rawModelId?: string }> = new Map();

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
      const activeProfile = this.engine.getActiveProfile();
      // Enforce onlyVerifiedWorking so failed/offline models are strictly excluded from VS Code's model picker
      const providers = await this.engine.generateProviders({
        profile: activeProfile,
        onlyVerifiedWorking: true,
      });

      const result: vscode.LanguageModelChatInformation[] = [];
      this.cachedModels = [];
      this.modelVendorMap.clear();

      for (const prov of providers) {
        const familyName = prov.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
        for (const m of prov.models) {
          // Extra guard: If a model was verified as failed/offline, do not present it to VS Code
          const cache = this.engine.getCacheEntry(prov.name, m.id);
          if (cache && cache.working === false) {
            continue;
          }
          if (m._verifiedWorking === false) {
            continue;
          }

          // Exclude any model deselected by the user in the dashboard
          if (this.engine.isModelDisabled(prov.name, m.id)) {
            continue;
          }

          // Prevent model ID collision if multiple providers share the exact same model id
          const registrationId = this.modelVendorMap.has(m.id)
            ? `${familyName}/${m.id}`
            : m.id;

          this.cachedModels.push(m);
          this.modelVendorMap.set(registrationId, {
            endpointUrl: m.url,
            apiKey: prov.apiKey,
            providerName: prov.name,
            rawModelId: m.id,
          });

          result.push({
            id: registrationId,
            name: `${m.name} (${prov.name})`,
            family: familyName,
            tooltip: `Model ${m.id} on ${prov.name} (${m.url})`,
            detail: `${prov.name} â€¢ ${m.contextWindow ? Math.round(m.contextWindow / 1000) + 'k ctx' : 'OpenAI compatible'}`,
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
    const endpointBase = routing?.endpointUrl || "http://localhost:11434";
    const apiKey = routing?.apiKey || "";
    const targetModelId = routing?.rawModelId || model.id;

    // Convert VS Code messages into OpenAI Chat Completion messages format
    const formattedMessages: any[] = [];

    for (const msg of messages) {
      const role = msg.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
      
      let textContent = "";
      const toolCalls: any[] = [];
      const imageParts: any[] = [];

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
        } else if (part && typeof part === "object" && ("mimeType" in part || "data" in part || "image" in part)) {
          // Multimodal image attachment support (for vision-capable models)
          const pAny = part as any;
          const mime = pAny.mimeType || "image/png";
          const rawData = pAny.data || pAny.image;
          if (rawData) {
            const b64 = Buffer.isBuffer(rawData)
              ? rawData.toString("base64")
              : typeof rawData === "string"
              ? rawData
              : "";
            if (b64) {
              imageParts.push({
                type: "image_url",
                image_url: { url: b64.startsWith("data:") ? b64 : `data:${mime};base64,${b64}` }
              });
            }
          }
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
      } else if (imageParts.length > 0) {
        formattedMessages.push({
          role,
          content: [
            ...(textContent ? [{ type: "text", text: textContent }] : []),
            ...imageParts,
          ],
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
      model: targetModelId,
      messages: formattedMessages,
      stream: true,
    };

    // Forward Copilot generation parameters (temperature, maxTokens, topP)
    if (options.modelOptions) {
      if (typeof options.modelOptions.temperature === "number") {
        requestBody.temperature = options.modelOptions.temperature;
      }
      if (typeof options.modelOptions.maxTokens === "number") {
        requestBody.max_tokens = options.modelOptions.maxTokens;
      }
      if (typeof options.modelOptions.topP === "number") {
        requestBody.top_p = options.modelOptions.topP;
      }
    }

    if (requestTools.length > 0) {
      requestBody.tools = requestTools;
    }

    // Initiate streaming POST request to OpenAI compatible endpoint
    const url = endpointBase.includes("/chat/completions")
      ? endpointBase
      : `${endpointBase.replace(/\/+$/, "")}/v1/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: abortController.signal,
      });

      // Automatic 1-retry with backoff on transient HTTP 429 / 500 / 502 / 503 errors
      if (!response.ok && (response.status === 429 || response.status >= 500) && !token.isCancellationRequested) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!token.isCancellationRequested) {
          response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
            signal: abortController.signal,
          });
        }
      }
    } catch (fetchErr: any) {
      if (!token.isCancellationRequested) {
        progress.report(new vscode.LanguageModelTextPart(`\n\n⚠️ **Connection failed to ${model.id}:** ${fetchErr?.message || fetchErr}\n`));
      }
      return;
    }

    if (!response.ok) {
      const errText = await response.text();
      const errorMsg = `Error from ${model.id} (${response.status}): ${errText}`;
      if (routing?.providerName) {
        await this.engine.setCacheEntry({
          modelId: model.id,
          providerName: routing.providerName,
          working: false,
          latency: 0,
          testedAt: Date.now(),
        });
        this.notifyModelsChanged();
      }
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
    let isReasoningActive = false;
    let inThinkTag = false;

    const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

    try {
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

          // 1. Reasoning / Thinking delta (DeepSeek R1 / OmniRoute reasoning_content)
          if (delta.reasoning_content && !delta.content) {
            if (!isReasoningActive) {
              isReasoningActive = true;
              progress.report(new vscode.LanguageModelTextPart("\n> 💭 *Thinking:*\n> "));
            }
            const formattedReasoning = delta.reasoning_content.replace(/\n/g, "\n> ");
            progress.report(new vscode.LanguageModelTextPart(formattedReasoning));
          }

          // 2. Text delta
          if (delta.content) {
            if (isReasoningActive) {
              isReasoningActive = false;
              progress.report(new vscode.LanguageModelTextPart("\n\n"));
            }

            let text = delta.content;
            if (text.includes("<think>")) {
              inThinkTag = true;
              text = text.replace("<think>", "\n> 💭 *Thinking:*\n> ");
            }
            if (text.includes("</think>")) {
              inThinkTag = false;
              text = text.replace("</think>", "\n\n");
            } else if (inThinkTag) {
              text = text.replace(/\n/g, "\n> ");
            }

            progress.report(new vscode.LanguageModelTextPart(text));
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
  } catch (streamErr: any) {
      if (!token.isCancellationRequested) {
        progress.report(new vscode.LanguageModelTextPart(`\n\n⚠️ **Stream interrupted:** ${streamErr?.message || streamErr}\n`));
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

