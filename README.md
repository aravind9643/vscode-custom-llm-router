# Custom LLM Router - VS Code Extension

[![VS Code Insiders](https://img.shields.io/badge/VS%20Code-Insiders-purple.svg)](https://code.visualstudio.com/insiders/)
[![Language Model Provider](https://img.shields.io/badge/API-vscode.lm-blue.svg)](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)

Native Visual Studio Code **Language Model Chat Provider (`vscode.lm`)** that connects **any OpenAI-compatible endpoint** (Ollama, LM Studio, vLLM, OpenRouter, DeepSeek, OpenAI, FreeLLMAPI, OmniRoute, or self-hosted servers) directly into VS Code Copilot and Chat with real-time SSE streaming and tool calling.

**Clean & Zero Disk Pollution**: The extension stores all settings and endpoints purely in standard VS Code Settings (`customLlmRouter.*`). It does not litter your workspace with `.env`, `models.config.json`, or `chatLanguageModels.json` files!

---

## 🚀 Key Features

1. **Native VS Code Language Model Provider (`vscode.lm`)**:
   - Models appear directly in the **VS Code Copilot Model Picker** dropdown.
   - Streams responses in real time with sub-second latency and handles function calling / tool use.
2. **Universal Compatibility**:
   - Works with **any OpenAI-compatible API** (`/v1/chat/completions` & `/v1/models`).
   - Connect to **Ollama, LM Studio, vLLM, OpenRouter, DeepSeek, OpenAI, FreeLLMAPI, OmniRoute**, or private AI clusters.
3. **Pure VS Code Native Settings**:
   - Configured through standard VS Code Settings UI or `settings.json` under `customLlmRouter.providers`.
   - No filesystem pollution, no temporary JSON files, and zero disk writes in user projects.
4. **Interactive Wizard & Status Bar**:
   - Status Bar item showing real-time endpoint status (`$(hubot) LLM Router (2/2)`).
   - Interactive wizard to add, toggle, or remove custom endpoints on the fly.
   - Filter models by **All**, **Coding Only**, or **Top Tier Flagships**.

---

## 📖 Tutorial: How to Use the Extension

### Step 1: Install the Extension
```bash
code-insiders --install-extension vscode-custom-llm-router-1.0.0.vsix --force
```

---

### Step 2: Open the Action Menu

Click the **`$(hubot) LLM Router`** item in the bottom-right **Status Bar**, or press `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`) and type:
```
Custom LLM Router: Show Menu
```

The menu options:
- **`$(sync) Refresh / Sync Models`**: Scan configured endpoints and update Copilot models.
- **`$(plus) Add Custom Provider`**: Onboard a new endpoint interactively.
- **`$(list-unordered) Manage / Toggle Providers`**: Enable, disable, or delete configured endpoints.
- **`$(filter) Switch Profile`**: Toggle between All Models, Coding Only, or Top Tier.
- **`$(pulse) Check Endpoints Status`**: Probe connectivity and model counts across endpoints.
- **`$(gear) Open Extension Settings`**: Open standard VS Code Settings UI for Custom LLM Router.

---

### Step 3: Add a Custom Provider (Interactive Wizard)

You can connect local or remote OpenAI-compatible endpoints in 3 seconds:

1. Press `Ctrl+Shift+P` -> Select **`Custom LLM Router: Add Custom Model Provider`**.
2. **Prompt 1**: Enter the provider name (e.g. `Ollama Local`, `My DeepSeek`, `LM Studio`).
3. **Prompt 2**: Enter the endpoint URL:
   - **Ollama**: `http://localhost:11434`
   - **LM Studio**: `http://localhost:1234`
   - **vLLM / Local Server**: `http://localhost:8000`
   - **OpenRouter**: `https://openrouter.ai/api`
   - **DeepSeek**: `https://api.deepseek.com`
4. **Prompt 3**: Enter the API key (leave empty for local servers without auth).
5. The extension will automatically test the connection, fetch available models, and register them into VS Code Copilot!

---

### Step 4: Configure via Standard VS Code Settings

You can also manage providers directly in your VS Code `settings.json`:

```json
{
  "customLlmRouter.providers": [
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

---

### Step 5: Chatting with Your Custom Models in VS Code Copilot

1. Open VS Code Chat (`Ctrl+Alt+I` or click the Copilot Chat icon in the Activity Bar).
2. Click the **Model Picker** dropdown in the chat input box (where model names are shown).
3. Select your custom model under the **Custom LLM Router** provider!
4. Send your prompt—responses stream in real time with tool-calling capabilities.

---

## 🛠️ Command Palette Reference

| Command | Title | Action |
|---|---|---|
| `vscode-custom-llm-router.showMenu` | **Show Menu** | Opens the interactive Master Menu |
| `vscode-custom-llm-router.syncModels` | **Refresh / Sync Models** | Scans all endpoints and registers models |
| `vscode-custom-llm-router.addProvider` | **Add Custom Model Provider** | 3-step wizard to add an endpoint |
| `vscode-custom-llm-router.manageProviders` | **Manage / Toggle Providers** | Enable, disable, or delete configured endpoints |
| `vscode-custom-llm-router.checkStatus` | **Check Endpoints Status** | Tests latency and status of all configured endpoints |
| `vscode-custom-llm-router.selectProfile` | **Switch Model Profile** | Choose All, Coding, or Top Tier models |
| `vscode-custom-llm-router.openSettings` | **Open Extension Settings** | Opens native VS Code Settings UI |
