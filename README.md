# VS Code Custom Endpoint Models (FreeLLMAPI & OmniRoute)

Unified generator and validator for configuring local custom language model endpoints in Visual Studio Code (Copilot / Chat), adhering to the [VS Code Language Models custom endpoint specification](https://code.visualstudio.com/docs/agent-customization/language-models).

---

## ⚡ Key Features

- **Single Orchestrator**: [generate-models.js](file:///d:/VSCodeCustomEndpointModels/generate-models.js) queries and integrates both FreeLLMAPI and OmniRoute.
- **Prettified Model Names**: Cleans upstream routing tags (`ddgw/`, `no-think/`, etc.) into clean titles (e.g. `OmniRoute Best Coding`, `Claude 3.7 Sonnet (Fast/Direct)`).
- **Smart Token & Context Bounds**: Accurately infers `contextWindow` and token limits based on model architectures.
- **Cache Management**: Auto-evicts cache entries older than 48 hours to prune offline models.
- **Interactive Model Selection (`npm run select`)**: Pick specific models via CLI numbers/ranges to customize your Copilot menu.
- **Direct VS Code Insiders Deployment (`--apply`)**: Writes directly to `Code - Insiders\User\chatLanguageModels.json` without touching `settings.json`.
- **Background Sync Service**: Windows Task Scheduler script (`npm run service:install`) to sync every hour silently.

---

## 🚀 Usage Guide

### 1. Basic Generation & Fast Export
```bash
# Fast mode using validated cache
npm run generate:fast

# Full live probe of all models
npm run generate
```

### 2. Deploy Directly to VS Code Insiders
```bash
# Deploys to Code - Insiders User/chatLanguageModels.json
npm run apply

# Deploy only curated coding models:
npm run apply:coding

# Deploy only top-tier models:
npm run apply:top
```

### 3. Interactive Model Picker
```bash
# Interactively choose specific models from the list
npm run select
```

### 4. Background Sync Service (Windows Scheduled Task)
```bash
# Register automatic 1-hour background sync
npm run service:install

# Unregister scheduled task
npm run service:uninstall
```
