import { ApiKind } from "../types";
import { anthropicTransport } from "./anthropic";
import { ollamaTransport } from "./ollama";
import { openaiTransport } from "./openai";
import { Transport } from "./types";

export * from "./types";

export function transportFor(api: ApiKind): Transport {
  return api === "anthropic" ? anthropicTransport : api === "ollama" ? ollamaTransport : openaiTransport;
}
