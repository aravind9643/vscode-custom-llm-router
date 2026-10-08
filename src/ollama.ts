import * as vscode from "vscode";
import { ProviderConfig } from "./types";
import { buildHeaders, describeFetchError, nativeRoot } from "./endpoints";
import type { Auth } from "./transports/types";

/**
 * Pulls a model through Ollama's native `/api/pull`, reporting download progress.
 * Resolves to an error message, or undefined on success.
 */
export async function pullOllamaModel(
  provider: ProviderConfig,
  auth: Auth,
  model: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  const abort = new AbortController();
  const sub = token.onCancellationRequested(() => abort.abort());
  try {
    const res = await fetch(`${nativeRoot(provider)}/api/pull`, {
      method: "POST",
      headers: buildHeaders(provider, auth),
      body: JSON.stringify({ model, stream: true }),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) return `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastPct = 0;
    for (;;) {
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
        if (evt.error) return String(evt.error);
        if (evt.total && evt.completed) {
          const pct = Math.floor((evt.completed / evt.total) * 100);
          progress.report({ message: `${evt.status} ${pct}%`, increment: Math.max(0, pct - lastPct) });
          lastPct = pct;
        } else if (evt.status) {
          if (lastPct >= 100 || evt.status.startsWith("pulling manifest")) lastPct = 0;
          progress.report({ message: evt.status });
        }
      }
    }
    return undefined;
  } catch (err) {
    return token.isCancellationRequested ? "Cancelled" : describeFetchError(err);
  } finally {
    sub.dispose();
  }
}
