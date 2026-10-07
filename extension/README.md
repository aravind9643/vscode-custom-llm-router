# Custom LLM Router - VS Code Extension

Visual Studio Code extension that bridges local **FreeLLMAPI** (`:31415`) and **OmniRoute** (`:20128`) models directly into GitHub Copilot and Chat.

## Features
- **Status Bar Integration**: Real-time connection indicators and loaded model counts.
- **Command Palette**: One-click model synchronization (`Custom LLM Router: Sync Models`).
- **Profile Switching**: Quickly toggle between All Models, Coding Only, and Top Tier models.
- **Diagnostics**: Check endpoint connectivity on demand.

## Development & Building
```bash
# Compile TypeScript
npm run compile

# Package as .vsix
npm run package
```
