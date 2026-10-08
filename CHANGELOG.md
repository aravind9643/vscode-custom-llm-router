# Changelog

## 2.3.0

### Added
- **Flexible Route Policies**: Routes can now be configured with `priority` (sequential fallback), `round-robin` (evenly distributed load), or `least-latency` (fastest response time first).
- **Route Circuit Breaker & Health Backoff**: Automatically de-prioritizes models returning 429 (Rate Limit) or 5xx server errors for 30–60s so fallbacks are instantaneous without repeatedly stalling.
- **Dynamic Context-Length Route Filtering**: Routes automatically prefer and select member models capable of handling the incoming request's message length.
- **Prompt Caching Hint Forwarding**: Translates Copilot cache breakpoints to Anthropic ephemeral cache control blocks and passes cache markers to optimize token costs and TTFT.
- **Expanded Provider Presets**: One-click configuration for **Cerebras** (ultra-fast inference), **Perplexity** (Sonar search), **xAI (Grok)**, and **SambaNova**.
- **Local Server Scanner**: One-click scanning for running local LLMs across standard ports (Ollama `11434`, LM Studio `1234`, vLLM `8000`, LocalAI `8080`) with auto-preset filling.
- **Telemetry & Spend Export**: Export model requests, failure counts, TTFT, tok/s, prompt tokens, completion tokens, and USD costs as CSV or JSON (`Export Usage Statistics…`).
- **Spend Budget Warnings**: Configurable monthly budget threshold (`customLlmRouter.budgetLimitUsd`) with active dashboard warning banners when spend exceeds budget.
- **Enhanced Keyboard Ergonomics**: Quick model search focus with `/` and modal/limits dismissal with `Escape`.

## 2.2.0

### Added
- **Native Anthropic API** (Claude) via the official SDK. Context window, max output tokens, image input and adaptive-thinking support come from the Models API. Thinking is shown as a summary, refusals are reported clearly, and server-side refusal fallbacks are on by default for the models that support them on api.anthropic.com.
- **Native Ollama API** (`/api/chat`): sends `num_ctx` so long chats are no longer cut at Ollama's default context, plus `keep_alive` and native thinking. The context length can be set per provider (default 32k).
- **Azure OpenAI** preset, plus an *API type* and *Send the API key as* (`Authorization: Bearer`, `api-key`, `x-api-key`) choice for any provider.
- **Prices and spend**: provider prices (OpenRouter) or list prices (Anthropic) are shown per model, can be overridden, and are combined with reported usage into a spend estimate per model and in total.
- **Secret headers**: header values named like `*key*`, `*token*`, `*auth*` or `*secret*` are kept in secret storage, never in `settings.json`.
- **"API key needed on this machine"**: when a provider rejects the credentials (keys don't sync between machines), the sidebar, dashboard and a one-time notification offer **Set API Key…**.
- **Per-provider rate limit** for bulk checks (`customLlmRouter.providerConcurrency`, default 3 for remote APIs).
- Usage statistics can be reset from Settings.

### Changed
- Routes fall back to the next model immediately on 429/5xx instead of waiting to retry.
- A local model that times out on its first health check (still loading) gets one longer second attempt.
- The dashboard is written in TypeScript and shares a typed message protocol with the extension.
- The URL preview in the provider editor shows the endpoint the selected API will actually call.

### Fixed
- High Contrast: ticked checkboxes and switches were invisible.
- Dollar signs were missing from price and spend text in the sidebar tooltips.

## 2.1.0
- Fallback **routes**, per-model limit overrides, real context windows from Ollama/LM Studio, three-level tool-calling check, cost-aware bulk checks, speed stats, calibrated token counts, Ollama pull and keep-alive, windowed rendering for large model lists, localization, esbuild bundle, unit/dashboard/integration tests and CI.

## 2.0.0
- Redesign: native sidebar, rebuilt dashboard, opt-in Copilot selection, API keys in secret storage, parallel cached discovery, fixed `/v1/v1` URLs, safe HTML escaping, streaming fixes.
