# AGENTS.md - Agent Context & Guidelines for vscode-custom-llm-router

## 1. Project Overview
**vscode-custom-llm-router** is a high-performance VS Code extension that enables developers to use custom, local, and third-party LLMs directly inside **GitHub Copilot Chat** using VS Code's native Language Model API (`vscode.lm.registerLanguageModelChatProvider`).

Supported backends include:
- Local engines: **Ollama**, **LM Studio**, **vLLM**, **LocalAI**
- Cloud/Aggregator providers: **OpenRouter**, **DeepSeek**, **Groq**, **Together AI**, **Mistral**, **GitHub Models**, **FreeLLMAPI**, **OmniRoute**
- Any OpenAI-compatible `/v1/chat/completions` HTTP endpoint.

---

## 2. Technology Stack & Key Dependencies
- **Runtime**: VS Code Extension API (`@types/vscode: ^1.140.0`)
- **Language**: TypeScript 5.4+ (Target: ES2022, CommonJS module)
- **UI & Icons**: Vanilla HTML/CSS inside VS Code Webview with embedded **@vscode/codicons** (base64 font for 100% offline & zero CSP friction)
- **Packaging**: `@vscode/vsce`
- **Test Server**: Python 3 (`mock_llm_server.py`) providing an OpenAI-compatible mock server on port 31415 for offline validation.

---

## 3. Directory & File Architecture
```
vscode-custom-llm-router/
├── src/
│   ├── extension.ts           # Entry point: activation, command handlers, status bar, engine lifecycle
│   ├── modelEngine.ts         # Core engine: provider discovery, capability detection, health checks, cache, Copilot registration
│   ├── customChatProvider.ts  # VS Code LM Chat Provider: prompt formatting, streaming SSE, tool calling, vision
│   └── configWebview.ts       # Interactive Dashboard: provider manager, model benchmark, filter chips, selection bar
├── media/
│   ├── codicon.css            # VS Code Codicon styles
│   └── codicon.ttf            # Codicon font binary
├── mock_llm_server.py         # Offline mock LLM server for automated testing and benchmarking
├── package.json               # Extension manifest, commands, configuration schema
├── tsconfig.json              # TypeScript compiler settings
└── AGENTS.md                  # This agent context guide
```

---

## 4. Source Component Details

### `src/modelEngine.ts`
- **Provider Management**: Manages endpoints, API keys, custom headers, and timeout configurations.
- **Model Discovery**: Calls `/v1/models` or `/models` with fallback handling.
- **Capability Inference**:
  - `isCoding`: detected via model name regex (e.g. `code`, `coder`, `deepseek-coder`, `starcoder`, `claude`, `gpt-4`).
  - `isReasoning`: detected via regex (`r1`, `reason`, `reasoning`, `deepseek-r1`, `o1`, `o3`).
  - `isVision`: detected via regex (`vision`, `vl`, `4o`, `gemini`).
  - `supportsTools`: verified during benchmark ping tests.
- **Verification Cache**:
  - Saved in `globalState` with key `verifiedModelsCache.v1` (48-hour TTL).
  - Avoids re-pinging slow models on every startup.
- **Copilot Model Registration**:
  - Maintains `copilotModelIds: Set<string>`.
  - Only models that are both **working** and **selected** are exposed to Copilot to avoid cluttering the Copilot model selector.

### `src/customChatProvider.ts`
- Implements `vscode.LanguageModelChatProvider`.
- **Request Processing**:
  - Normalizes chat messages (system, user, assistant, tool results).
  - Handles image data URLs for vision-capable models.
  - Converts VS Code tool definitions to OpenAI tool JSON schema.
- **Streaming Parser**:
  - Reads server-sent events (`data: { ... }`).
  - Writes text fragments to `vscode.LanguageModelResponseStream.write()`.
  - Assembles and returns structured tool calls (`vscode.LanguageModelToolCall`).
- **URL Resolution Rule**:
  - Always normalizes `baseUrl` to avoid double `/v1` (e.g., handles `http://host/v1` vs `http://host` cleanly).

### `src/configWebview.ts`
- **Isolated Scroll Layout**:
  - Root container: `html, body { height: 100vh; overflow: hidden; }`.
  - Header: `.app-header` (fixed, containing title, Refresh, Add Provider, and Tabs).
  - Body: `.app-body { flex: 1; overflow: hidden; }`.
  - Models Toolbar: `.models-sticky-toolbar { flex-shrink: 0; }` (fixed search, benchmarks, filter chips, selection bar).
  - Dedicated Scroll Pane: `.table-container { flex: 1; overflow-y: auto; }` with sticky `th { position: sticky; top: 0; }`.
  - **Only table data rows scroll** when scrolling.
- **Codicons Integration**:
  - Uses `@vscode/codicons` via embedded base64 font in the `<style>` tag for zero external network overhead and complete offline reliability.
- **Filter Chips**:
  - Category filters: `All`, `Coding`, `Reasoning`, `Vision`, `Working`, `Failed`, `In Copilot`.
- **Copilot Model Selection**:
  - Checkboxes per row, with "Enable All Working", "Select Visible", and "Deselect Visible" controls.

---

## 5. Development Workflows & Commands

### Building and Compiling
```bash
# Compile TypeScript to /out
npm run compile

# Continuous compilation watch mode
npm run watch
```

### Packaging Extension
```bash
# Create .vsix bundle
npx @vscode/vsce package --no-dependencies
```

### Installing Extension in VS Code Insiders
```bash
code-insiders --install-extension "vscode-custom-llm-router-1.0.1.vsix" --force
```

### Running the Offline Test Mock Server
```bash
# Starts mock OpenAI server on 127.0.0.1:31415
python mock_llm_server.py
```

---

## 6. Critical Rules for Future Agents

1. **Verify TypeScript Compilation**: Always run `npm run compile` after modifying `*.ts` files to ensure zero type errors.
2. **Webview JavaScript Safety**:
   - When modifying embedded `<script>` in `configWebview.ts`, test syntax with Node.js `vm.Script` to avoid unescaped backtick/quote errors that silently crash webviews.
3. **Workspace Boundary**:
   - Only edit files within `vscode-custom-llm-router`. Do not touch other workspace directories unless instructed.
4. **URL Path Construction**:
   - Always check if `baseUrl.endsWith('/v1')` or `baseUrl.endsWith('/')` before appending `/chat/completions` or `/models`.
5. **Copilot Registration Integrity**:
   - Never register failed or offline models in Copilot by default; always respect `copilotModelIds` and health check status.
