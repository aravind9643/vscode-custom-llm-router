# Project Architecture & Behavioral Rules

## Core Purpose
`vscode-custom-llm-router` exposes custom local/remote LLM endpoints as native language models in VS Code's GitHub Copilot.

## Coding Conventions
1. **TypeScript Quality**: Strict typing, no unresolved promises, clean disposable management via `vscode.Disposable`.
2. **Webview Aesthetics**:
   - Strictly follow VS Code native styling (`var(--vscode-*)`).
   - Use VS Code Codicons (`@vscode/codicons`) for all icons.
   - Maintain the fixed-shell layout where only `.table-container` has `overflow-y: auto` and `th` has `position: sticky; top: 0`.
3. **Network Resilience**:
   - Support streaming SSE responses.
   - Implement abort signals and timeouts on all outbound fetch requests.
   - Never block extension activation on remote endpoint discovery.
