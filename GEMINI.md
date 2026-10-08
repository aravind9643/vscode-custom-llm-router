# AGENTS.md - Agent Context & Guidelines for vscode-custom-llm-router

> Single source of truth for coding agents. `CLAUDE.md` imports this file; `GEMINI.md` is a verbatim copy (re-copy after editing: `cp AGENTS.md GEMINI.md`). Start with **§7 Current State & Handoff**.

## 1. Project Overview
**vscode-custom-llm-router** is a VS Code extension that lets developers use custom, local, and third-party LLMs inside **GitHub Copilot Chat** through VS Code's native Language Model API (`vscode.lm.registerLanguageModelChatProvider`).

Supported backends include:
- Local engines: **Ollama**, **LM Studio**, **vLLM**, **LocalAI**
- Cloud/Aggregator providers: **Anthropic** (native Messages API), **Azure OpenAI**, **OpenRouter**, **OpenAI**, **Gemini**, **DeepSeek**, **Groq**, **Together AI**, **Mistral**, **GitHub Models**, **FreeLLMAPI**, **OmniRoute**
- Any OpenAI-compatible `/v1/chat/completions` HTTP endpoint.
- Three wire protocols (`src/transports/`): OpenAI-compatible, Ollama native (`/api/chat`), Anthropic Messages API.

---

## 2. Technology Stack & Key Dependencies
- **Runtime**: VS Code Extension API (`@types/vscode: ^1.140.0`)
- **Language**: TypeScript 5.4+ (Target: ES2022, CommonJS module)
- **UI**: native TreeView (sidebar) + a webview dashboard written in TypeScript (`src/webview/dashboard.ts`, no framework), styled only with `var(--vscode-*)` tokens and vendored codicons (`media/codicon.*`).
- **Packaging**: `@vscode/vsce`
- **Build**: `tsc` → `out/` (type-check + tests), `esbuild` → `dist/extension.js` (what ships; `main` points here) and `src/webview/dashboard.ts` → `media/dashboard.js` (generated, git-ignored). The webview is type-checked with `tsconfig.webview.json`.
- **Anthropic**: `@anthropic-ai/sdk` (bundled). Use the SDK for anything Anthropic-specific; no raw fetch.
- **Tests**: `npm test` (typecheck + unit tests against the mock + sidebar tree tests + jsdom dashboard tests), `npm run test:integration` (real VS Code via `@vscode/test-cli`), `npm run screenshots` (Playwright, visual check). CI: `.github/workflows/ci.yml` (every push and PR, Ubuntu + Windows).
- **Test Server**: `mock_llm_server.py [port]` (default 31415, threaded, stdlib only). Hooks:
  - `mock-qwq-think`: split `<think>` tags; rejects tools (400) → toolSupport `unsupported`
  - `mock-coder-32b`: accepts tools but answers in text → `accepted`; `mock-gpt-4o`: calls tools → `called`, has OpenRouter-style pricing
  - `mock-flaky`: real streaming chats return 503 (health checks pass) → route fallback
  - `mock-strict`: 400 on `stream_options`; `mock-slow`: first request sleeps 2.5 s (cold start)
  - prompt containing "weather" + tools → streamed tool call
  - `/api/show|chat|pull|generate`: Ollama native; requests with an `anthropic-version` header hit the Anthropic mock (`/v1/models`, `/v1/messages` SSE; key `sk-ant-test`; prompt "refuse-me" → refusal)
  - paths under `/secure` need `Authorization: Bearer sk-good` or `X-Secret-Token: tok`
  - `GET /_mock/state`: keep-alive calls, last Anthropic request (body + headers), last Ollama chat body
- **Localization**: manifest strings in `package.nls.json`; runtime strings via literal `vscode.l10n.t(...)` (run `npm run l10n:export`).

---

## 3. Directory & File Architecture
```
vscode-custom-llm-router/
├── src/
│   ├── extension.ts           # Wiring only: activation, commands, status bar, config-change routing
│   ├── types.ts               # Shared types (ProviderConfig, CatalogModel, ProviderStatus, cache entries)
│   ├── endpoints.ts           # URL resolution (/v1 handling), headers/auth styles, API-type detection
│   ├── transports/            # one module per wire protocol: openai.ts, ollama.ts (native /api/chat), anthropic.ts (SDK)
│   ├── protocol.ts            # typed host ⇄ dashboard messages and state (imported by both sides)
│   ├── pool.ts                # worker pool with global + per-provider limits
│   ├── providerStore.ts       # Settings + SecretStorage (API keys) + opt-in Copilot selection
│   ├── modelEngine.ts         # Catalog discovery (parallel, cached), verification pool, cache, change events
│   ├── customChatProvider.ts  # LanguageModelChatProvider: message conversion, SSE streaming, tool calls, reasoning
│   ├── sidebarTree.ts         # Activity-bar TreeView: providers → models with Copilot checkboxes
│   ├── ollama.ts              # Ollama native helpers (model pull with progress)
│   ├── dashboardPanel.ts      # Webview host: serializes state, executes actions sent by the dashboard
│   └── webview/dashboard.ts   # Dashboard UI (bundled to media/dashboard.js)
├── media/
│   ├── dashboard.css          # Dashboard styles (dashboard.js is generated)
│   ├── icon.png, screenshots/ # Marketplace icon and README images (screenshots are not packaged)
│   ├── codicon.css / .ttf     # Codicons
│   └── sidebar-icon.svg       # Activity bar icon
├── test/                      # helpers.js (vscode stub, mock launcher), unit/tree/dashboard/integration tests, visual/screenshots.js
├── l10n/bundle.l10n.json      # extracted runtime strings
├── mock_llm_server.py
└── package.json               # Manifest: commands, views, menus, configuration
```

---

## 4. Core Concepts

### Identity & state
- A model's identity is its **key** `${providerName}::${modelId}` — used for selection, cache and UI.
- Registered Copilot model IDs are `${providerSlug}/${modelId}`; `CustomLLMChatProvider` maps them back to keys.
- `ModelEngine` is the single source of runtime state and fires `onDidChange` (coalesced) for the tree, dashboard, status bar and chat provider.

### Copilot exposure rule
A model is exposed to Copilot **only if** it is in `customLlmRouter.copilotModels` (opt-in) **and** its cached verification is `working`. Selecting an untested model triggers verification. Never bypass `engine.getCopilotModels()`.

### Routes (fallback)
- `customLlmRouter.routes`: `{ name, models: [key…] }` registered as `route/<slug>`; exposed while ≥1 member is working.
- Members are tried in order; a failure **before any output** (`RetryableError`) moves to the next; failures after output are surfaced. With tools in the request, tool-capable members are preferred.

### Limits & capabilities
- Precedence: user override (`modelOverrides`) → native API (Ollama `/api/show`, LM Studio `/api/v0/models`, cached 7 days in `customLlmRouter.nativeMeta`) → `/models` fields → name-based guess (`contextSource: "guess"`).
- Tool check (`toolCheck: full`) classifies `called` / `accepted` / `unsupported`; only `unsupported` disables tool calling.

### Telemetry (local only)
- `customLlmRouter.modelStats`: per-model requests, failures, TTFT and tokens/s (EMA) from real chats.
- `customLlmRouter.tokenRatio`: chars-per-token learned from `usage.prompt_tokens` (requested via `stream_options.include_usage`; providers that reject it are remembered for the session).

### Verification cache
- `globalState` key `customLlmRouter.verifiedCache`, TTL from `customLlmRouter.cacheTtlHours` (default 48h), saves debounced.
- On startup, selected models with expired results are re-verified in the background so they don't vanish from Copilot.
- Chat requests only mark a model failed on definitive errors (HTTP 404 / "model not found"), never on 429/5xx.

### Transports
- `transportFor(api)` returns the transport. `resolveApi(p, kind)` uses the explicit `api` setting, then Ollama detection, then the `api.anthropic.com` host, then `openai`.
- Health checks, tool checks, discovery and chat all go through transports, so a new API only needs a new transport module.
- Transports throw `HttpError` for non-2xx responses before output. The chat provider owns retries (none inside routes) and route fallback.
- Anthropic specifics:
  - no `temperature`/`top_p`, and `tool_choice` is always `auto`
  - adaptive thinking only when the Models API says the model supports it
  - `eager_input_streaming` on tools
  - `refusal` is surfaced as an error
  - `fallbacks: "default"` only on api.anthropic.com for Claude Fable 5.1 / Opus 5.5 / Opus 5 / Sonnet 5.5

### Secrets
API keys are stored in `context.secrets` under `customLlmRouter.apiKey.<providerName>`. Header values whose names look like credentials (`isSecretHeaderName`) go under `customLlmRouter.headers.<providerName>`; the dashboard shows `SECRET_SENTINEL` for them and saving the sentinel keeps the stored value. Legacy plaintext values are moved on save. Secrets are never sent to the webview or exported. A 401/403 at discovery sets `needsKey` (keys don't sync between machines).

### Dashboard protocol (`src/protocol.ts`)
- `HostMessage` / `WebviewMessage` / `DashboardState` are shared types; change them there and both sides fail to compile until updated.
- The provider editor, the focused limits row and focused inputs are not re-rendered on `state` pushes (so typing is never lost).
- Model lists over 200 rows render in a scroll window (fixed 46px rows) — keep row height fixed if you change row markup.

---

## 5. Development Workflows & Commands
```bash
npm test                               # typecheck + unit + sidebar + dashboard tests (needs Python 3 on PATH or $PYTHON)
npm run test:integration               # real VS Code
npm run bundle                         # dist/extension.js + media/dashboard.js
npm run screenshots                    # dashboard in Dark/Light/HC → test/visual/out (look at them after UI changes)
python mock_llm_server.py              # offline mock on 31415 (F5 "Run Extension (with mock server)" starts it)
npm run l10n:export                    # after adding/changing vscode.l10n.t strings
npx @vscode/vsce package --no-dependencies
```

---

## 6. Critical Rules for Future Agents

1. **Verify**: run `npm test` after any change (it type-checks); run `npm run test:integration` when touching activation, commands, package.json, transports or the chat provider; run `npm run screenshots` and look at the PNGs after UI changes.
2. **Webview Safety**:
   - All UI code lives in `src/webview/dashboard.ts` (type-checked by `npm run typecheck`); never edit the generated `media/dashboard.js`.
   - Render every dynamic value through `esc()` — model names/IDs come from remote servers.
   - No inline `onclick` handlers (blocked by the CSP); use `data-action` + the delegated listeners.
   - Use `var(--vscode-*)` colors only so light/high-contrast themes work.
3. **Workspace Boundary**: only edit files within `vscode-custom-llm-router`.
4. **URL Path Construction**: always go through `resolveChatUrl` / `resolveModelsUrl` in `endpoints.ts`; never concatenate `/v1/...` by hand.
5. **Copilot Registration Integrity**: never register failed, untested or unselected models; respect `getCopilotModels()`.
6. **Network**: every `fetch` needs a timeout or abort signal; never block activation on network calls; release SSE readers (`reader.cancel()`) when done.
7. **Localization**: user-facing runtime strings use literal `vscode.l10n.t("…")` (no aliases — the extractor needs the literal call); manifest strings go in `package.nls.json`.
8. **Proposed APIs**: do not use them (e.g. `LanguageModelThinkingPart`); they block Marketplace publishing.
9. **Scripted edits**: when editing code with `String.prototype.replace`, remember `$$`, `$&` and `$1` are special in the replacement string (a `$${…}` template becomes `${…}` and silently drops a dollar sign). Prefer `split(a).join(b)` or the Edit tool.
10. **High contrast**: selection colours must not rely on `--vscode-button-background` alone (it is black in HC); see the `body.vscode-high-contrast` rules in `dashboard.css`.
11. **Commands must not await notifications**: a command that `await`s `showInformationMessage(..., actions)` never resolves until the user clicks, which hangs `executeCommand` callers (and the integration tests). Use `void …then(...)`.
12. **Git**: never commit to `main` directly; work on a branch. Generated files (`dist/`, `out/`, `media/dashboard.js`, `*.vsix`, `.vscode-test/`, `test/visual/out/`) are git-ignored — don't force-add them.

---

## 7. Current State & Handoff

_Last updated: 2026-10-08._

### Where things are
- **Branch `redesign/v2`**: comprehensive resilience, route policies, prompt caching, telemetry export, budget warnings, local server scanning, and presets implemented.
- **Version 2.3.0** (`package.json`, `CHANGELOG.md`).
- **Local verification at handoff**: `npm test` → 22 unit + 6 tree + 15 dashboard tests passing; `npm run test:integration` → 5 passing on VS Code 1.141.
- **CI**: green on **ubuntu-latest and windows-latest**.

### Suggested next steps
1. Open a PR from `redesign/v2` to `main` (`gh pr create`).
2. Manual smoke test against real Ollama / OpenRouter / Anthropic keys.
3. Marketplace: publisher verification, `vsce publish`.
4. Backlog ideas not implemented:
   - VS Code's native thinking part (`LanguageModelThinkingPart`) once it leaves proposed API — today reasoning is a quoted block stripped from history (`stripReasoning`).
   - Translations for the dashboard UI (only manifest + extension-host strings are localizable; `l10n/bundle.l10n.json` holds the English source).
   - Anthropic list prices in `src/transports/anthropic.ts` (`LIST_PRICES`) are a static table — keep it current or source prices elsewhere.
   - Models API capability data is only used for Anthropic; other providers rely on `/models` fields, native Ollama/LM Studio APIs and name heuristics (`VISION_RE`, `REASONING_RE`, `CODING_RE` in `modelEngine.ts`).

### Environment gotchas
- **Python**: tests spawn `python -I mock_llm_server.py <port>` (`python3` on non-Windows; override with `$PYTHON`). `-I` ignores `PYTHONIOENCODING`, so the server reconfigures stdout to UTF-8 itself.
- **Integration tests** download VS Code into `.vscode-test/` on first run (`VSCODE_TEST_VERSION` overrides "stable").
- **Screenshots** need `npx playwright install chromium` once; output goes to `test/visual/out/`; `--readme` refreshes `media/screenshots/`.
- **Pushing from this machine**: git has no stored HTTPS credentials; `gh` is logged in. Push with `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push` (does not change global git config).
- **VS Code API facts learned the hard way**: `LanguageModelChat` exposes `maxInputTokens` but not `maxOutputTokens`; `LanguageModelChatMessageRole.System` (3) exists at runtime but not in stable typings; Copilot sends non-image `LanguageModelDataPart`s (e.g. `cache_control`) that must not be forwarded as images; the Anthropic SDK refuses to send without credentials (no HTTP status), which `anthropicTransport.listModels` maps to a 401-like `needsKey`.
