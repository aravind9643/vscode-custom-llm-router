# Project Architecture & Behavioral Rules

## Core Purpose
`vscode-custom-llm-router` exposes custom local/remote LLM endpoints as native language models in VS Code's GitHub Copilot.

## Coding Conventions
1. **TypeScript Quality**: Strict typing, no unresolved promises, clean disposable management via `vscode.Disposable`.
2. **Webview Aesthetics**:
   - Strictly follow VS Code native styling (`var(--vscode-*)`).
   - Use VS Code Codicons (`@vscode/codicons`) for all icons.
   - Maintain the fixed-shell layout where only `.table-wrap` (models table) scrolls and `th` has `position: sticky; top: 0`.
   - Dashboard UI lives in `src/webview/dashboard.ts` + `media/dashboard.css`; escape all dynamic values and use `data-action` delegation (no inline handlers under the CSP).
3. **Network Resilience**:
   - Support streaming SSE responses.
   - Implement abort signals and timeouts on all outbound fetch requests.
   - Never block extension activation on remote endpoint discovery.

## More context
See `AGENTS.md` for architecture, rules and the current handoff state (§7).
