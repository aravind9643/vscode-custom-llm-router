# Custom LLM Router - VS Code Extension

[![VS Code Insiders](https://img.shields.io/badge/VS%20Code-Insiders-purple.svg)](https://code.visualstudio.com/insiders/)
[![Language Model Provider](https://img.shields.io/badge/API-vscode.lm-blue.svg)](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)

Native VS Code **Language Model Chat Provider (`vscode.lm`)** extension that connects **any OpenAI-compatible endpoint** (Ollama, LM Studio, vLLM, OpenRouter, DeepSeek, OpenAI, FreeLLMAPI, OmniRoute, or self-hosted servers) directly into VS Code Copilot and Chat with real-time SSE streaming and tool calling.

---

## 🚀 What Makes This Extension Unique?

1. **Native Model Provider Integration (`vscode.lm`)**:
   - Models appear directly in VS Code's **Copilot Model Picker** dropdown.
   - Streams responses with sub-second latency and handles function calling / tool use.
2. **Universal Compatibility**:
   - Works with **any OpenAI-compatible API** (`/v1/chat/completions` & `/v1/models`).
   - Pre-configured support for **Ollama, LM Studio, vLLM, OpenRouter, DeepSeek, OpenAI, FreeLLMAPI, and OmniRoute**.
3. **Interactive UI & Wizard**:
   - Status Bar item showing real-time endpoint status (`$(hubot) LLM Router (2/2)`).
   - Interactive wizard to add custom endpoints on the fly without writing code.
   - Filter models by **All**, **Coding Only**, or **Top Tier Flagships**.

---

## 📖 Tutorial: How to Use the Extension

### Step 1: Install the Extension

If not already installed, package and install the `.vsix` into VS Code:
```bash
# In the extension directory:
npm run package
code-insiders --install-extension vscode-custom-llm-router-1.0.0.vsix --force
```

---

### Step 2: Open the Action Menu

Click the **`$(hubot) LLM Router`** item in the bottom-right **Status Bar**, or press `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`) and type:
```
Custom LLM Router: Show Menu
```

You will see the Master Menu:
- **`$(sync) Sync Models`**: Refresh model list from all active endpoints.
- **`$(plus) Add Custom Provider`**: Onboard a new endpoint interactively.
- **`$(filter) Switch Profile`**: Toggle between All Models, Coding Only, or Top Tier.
- **`$(pulse) Check Endpoints Status`**: Ping and check health across all configured endpoints.
- **`$(gear) Configure models.config.json & Providers`**: Open rules & provider configuration.
- **`$(key) Configure .env Endpoints & Keys`**: Edit environment credentials.

---

### Step 3: Add a Custom Provider (Interactive Wizard)

You can add any local or remote OpenAI-compatible provider in 3 seconds:

1. Press `Ctrl+Shift+P` -> Select **`Custom LLM Router: Add Custom Model Provider`**.
2. **Prompt 1**: Enter the provider name (e.g., `Ollama Local`, `My DeepSeek`, `LM Studio`).
3. **Prompt 2**: Enter the endpoint URL:
   - For **Ollama**: `http://localhost:11434`
   - For **LM Studio**: `http://localhost:1234`
   - For **vLLM / Local**: `http://localhost:8000`
   - For **OpenRouter**: `https://openrouter.ai/api`
   - For **DeepSeek**: `https://api.deepseek.com`
4. **Prompt 3**: Enter the API key (leave blank for local servers like Ollama or LM Studio).
5. The extension will automatically test the connection, fetch available models, and register them into VS Code Copilot!

---

### Step 4: Configure Providers in `models.config.json`

For advanced configuration, open [`models.config.json`](file:///d:/VSCodeCustomEndpointModels/models.config.json) via Command Palette (`Custom LLM Router: Configure models.config.json & Providers`).

Here is an example configuration:

```json
{
  "blacklistPatterns": [
    "image",
    "flux",
    "diffusion",
    "tts",
    "voice"
  ],
  "whitelistExactIds": [
    "auto",
    "auto/best-coding",
    "auto/best-fast",
    "auto/best-reasoning"
  ],
  "providers": [
    {
      "name": "Ollama Local",
      "endpointUrl": "http://localhost:11434",
      "apiKey": "",
      "autoDiscover": true,
      "enabled": true
    },
    {
      "name": "DeepSeek Official",
      "endpointUrl": "https://api.deepseek.com",
      "apiKey": "sk-your-deepseek-api-key",
      "autoDiscover": false,
      "enabled": true,
      "staticModels": [
        {
          "id": "deepseek-chat",
          "name": "DeepSeek V3",
          "contextWindow": 131072,
          "maxOutputTokens": 8192,
          "toolCalling": true
        },
        {
          "id": "deepseek-reasoner",
          "name": "DeepSeek R1",
          "contextWindow": 131072,
          "maxOutputTokens": 8192,
          "toolCalling": false
        }
      ]
    }
  ]
}
```

#### Provider Properties:
| Property | Type | Description |
|---|---|---|
| `name` | `string` | Display name for the provider |
| `endpointUrl` | `string` | Base URL of the OpenAI-compatible service |
| `apiKey` | `string` | Bearer token / API key (optional for local models) |
| `autoDiscover` | `boolean` | Automatically poll `/v1/models` for available models |
| `enabled` | `boolean` | Toggle provider on or off |
| `staticModels` | `array` | Explicit model definitions with custom context bounds & tool options |

---

### Step 5: Chatting with Your Custom Models in VS Code Copilot

1. Open VS Code Chat (`Ctrl+Alt+I` or click the Copilot Chat icon in the Activity Bar).
2. Click the **Model Picker** dropdown in the chat input box (where model names like *Claude 3.7 Sonnet* or *GPT-4o* are displayed).
3. Click **Manage Models...** or scroll to find your custom models under the **Custom LLM Router** vendor!
4. Select your model (e.g. `DeepSeek R1`, `Qwen 2.5 Coder`, `Claude 3.7 Sonnet (OmniRoute)`, `Llama 3.3 (Ollama)`).
5. Start chatting! The extension streams tokens directly from your custom endpoint.

---

## 🛠️ Command Palette Reference

| Command | Title | Action |
|---|---|---|
| `vscode-custom-llm-router.showMenu` | **Show Menu** | Opens the interactive Master Menu |
| `vscode-custom-llm-router.syncModels` | **Sync Models** | Scans all endpoints and registers models |
| `vscode-custom-llm-router.addProvider` | **Add Custom Model Provider** | 3-step wizard to add an endpoint |
| `vscode-custom-llm-router.checkStatus` | **Check Endpoints Status** | Tests latency and status of all configured endpoints |
| `vscode-custom-llm-router.selectProfile` | **Switch Model Profile** | Choose All, Coding, or Top Tier models |
| `vscode-custom-llm-router.configureRules` | **Configure models.config.json** | Open providers list and filter rules |
| `vscode-custom-llm-router.configureEnv` | **Configure .env Endpoints** | Open environment variables configuration |
