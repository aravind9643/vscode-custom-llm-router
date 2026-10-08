// Renders the real dashboard bundle (media/dashboard.js + dashboard.css + codicons) in headless Chromium
// with VS Code theme colors, using sample data, and writes PNGs to test/visual/out/ (and the README
// screenshots to media/screenshots/ with --readme). Run: npm run screenshots
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "out");
const README_DIR = path.join(ROOT, "media", "screenshots");
const writeReadme = process.argv.includes("--readme");

const base = {
  "font-family": '"Segoe UI", system-ui, sans-serif',
  "font-size": "13px",
  "editor-font-family": 'Consolas, "Courier New", monospace',
};
const THEMES = {
  dark: {
    "editor-background": "#1f1f1f", foreground: "#cccccc", descriptionForeground: "#9d9d9d", "panel-border": "#2b2b2b", "widget-border": "#313131",
    "sideBar-background": "#181818", "editorWidget-background": "#202020", "list-hoverBackground": "#2a2d2e", focusBorder: "#0078d4",
    "testing-iconPassed": "#73c991", "testing-iconFailed": "#f14c4c", "editorWarning-foreground": "#cca700", "textLink-foreground": "#4daafc",
    "badge-background": "#616161", "badge-foreground": "#f8f8f8", "button-background": "#0078d4", "button-foreground": "#ffffff",
    "button-hoverBackground": "#026ec1", "button-secondaryBackground": "#313131", "button-secondaryForeground": "#cccccc",
    "button-secondaryHoverBackground": "#3c3c3c", "button-border": "#ffffff12", "input-background": "#313131", "input-foreground": "#cccccc",
    "input-border": "#3c3c3c", "dropdown-background": "#313131", "dropdown-foreground": "#cccccc", "dropdown-border": "#3c3c3c",
    "progressBar-background": "#0078d4", "toolbar-hoverBackground": "#5a5d5e50", "toolbar-activeBackground": "#63666750",
    "charts-blue": "#3794ff", "charts-purple": "#b180d7", "charts-orange": "#d18616", "charts-green": "#89d185",
    "notifications-background": "#1f1f1f", "notifications-foreground": "#cccccc", "notifications-border": "#2b2b2b",
    "scrollbarSlider-background": "#79797966", "scrollbarSlider-hoverBackground": "#646464b3", "inputValidation-errorBorder": "#be1100",
  },
  light: {
    "editor-background": "#ffffff", foreground: "#3b3b3b", descriptionForeground: "#717171", "panel-border": "#e5e5e5", "widget-border": "#e5e5e5",
    "sideBar-background": "#f8f8f8", "editorWidget-background": "#f8f8f8", "list-hoverBackground": "#f2f2f2", focusBorder: "#005fb8",
    "testing-iconPassed": "#388a34", "testing-iconFailed": "#e51400", "editorWarning-foreground": "#bf8803", "textLink-foreground": "#005fb8",
    "badge-background": "#cccccc", "badge-foreground": "#3b3b3b", "button-background": "#005fb8", "button-foreground": "#ffffff",
    "button-hoverBackground": "#0258a8", "button-secondaryBackground": "#e5e5e5", "button-secondaryForeground": "#3b3b3b",
    "button-secondaryHoverBackground": "#cccccc", "button-border": "#0000001a", "input-background": "#ffffff", "input-foreground": "#3b3b3b",
    "input-border": "#cecece", "dropdown-background": "#ffffff", "dropdown-foreground": "#3b3b3b", "dropdown-border": "#cecece",
    "progressBar-background": "#005fb8", "toolbar-hoverBackground": "#b8b8b850", "toolbar-activeBackground": "#a6a6a650",
    "charts-blue": "#1a85ff", "charts-purple": "#652d90", "charts-orange": "#d18616", "charts-green": "#388a34",
    "notifications-background": "#ffffff", "notifications-foreground": "#3b3b3b", "notifications-border": "#e5e5e5",
    "scrollbarSlider-background": "#64646466", "scrollbarSlider-hoverBackground": "#646464b3", "inputValidation-errorBorder": "#be1100",
  },
  "high-contrast": {
    "editor-background": "#000000", foreground: "#ffffff", descriptionForeground: "#ffffffb3", "panel-border": "#6fc3df", "widget-border": "#6fc3df",
    "sideBar-background": "#000000", "editorWidget-background": "#0c141f", "list-hoverBackground": "#00000000", focusBorder: "#f38518",
    "testing-iconPassed": "#73c991", "testing-iconFailed": "#f48771", "editorWarning-foreground": "#ffd370", "textLink-foreground": "#21a6ff",
    "badge-background": "#000000", "badge-foreground": "#ffffff", "button-background": "#000000", "button-foreground": "#ffffff",
    "button-hoverBackground": "#000000", "button-secondaryBackground": "#000000", "button-secondaryForeground": "#ffffff",
    "button-secondaryHoverBackground": "#000000", "button-border": "#6fc3df", "input-background": "#000000", "input-foreground": "#ffffff",
    "input-border": "#6fc3df", "dropdown-background": "#000000", "dropdown-foreground": "#ffffff", "dropdown-border": "#6fc3df",
    "progressBar-background": "#6fc3df", "toolbar-hoverBackground": "#00000000", "toolbar-activeBackground": "#00000000",
    "charts-blue": "#3794ff", "charts-purple": "#b180d7", "charts-orange": "#d18616", "charts-green": "#89d185",
    "notifications-background": "#000000", "notifications-foreground": "#ffffff", "notifications-border": "#6fc3df",
    "scrollbarSlider-background": "#6fc3df99", "scrollbarSlider-hoverBackground": "#6fc3dfcc", "inputValidation-errorBorder": "#f38518",
  },
};

const mk = (provider, id, name, status, extra = {}) => ({
  key: `${provider}::${id}`, providerName: provider, id, name, contextWindow: 131072, maxInputTokens: 114688, maxOutputTokens: 16384,
  contextSource: "server", hasOverride: false, caps: { tools: true, vision: false, reasoning: false, coding: true }, status, selected: false, isStatic: false, ...extra,
});
const STATE = {
  providers: [
    { name: "Ollama", endpointUrl: "http://localhost:11434", enabled: true, online: true, latencyMs: 4, modelCount: 4, kind: "ollama", api: "ollama", keySource: "none", remote: false, secretHeaderNames: [], plaintextSecretHeaders: [] },
    { name: "Anthropic", endpointUrl: "https://api.anthropic.com", enabled: true, online: true, latencyMs: 182, modelCount: 3, kind: "openai", api: "anthropic", keySource: "secret", remote: true, secretHeaderNames: [], plaintextSecretHeaders: [] },
    { name: "OpenRouter", endpointUrl: "https://openrouter.ai/api", enabled: true, online: true, latencyMs: 240, modelCount: 3, kind: "openai", api: "openai", keySource: "secret", remote: true, secretHeaderNames: ["X-Api-Token"], plaintextSecretHeaders: [] },
    { name: "Groq", endpointUrl: "https://api.groq.com/openai/v1", enabled: true, online: false, needsKey: true, error: "HTTP 401: Invalid API Key", modelCount: 0, kind: "openai", api: "openai", keySource: "none", remote: true, secretHeaderNames: [], plaintextSecretHeaders: [] },
  ],
  models: [
    mk("Ollama", "qwen2.5-coder:14b", "Qwen2.5 Coder 14b", "working", { latencyMs: 310, selected: true, toolSupport: "called", contextWindow: 32768, maxInputTokens: 24576, maxOutputTokens: 8192, stats: { requests: 42, failures: 0, ttftMs: 280, tokensPerSec: 38.4 } }),
    mk("Ollama", "deepseek-r1:8b", "DeepSeek R1 8b", "working", { latencyMs: 920, toolSupport: "accepted", contextWindow: 32768, caps: { tools: true, vision: false, reasoning: true, coding: true } }),
    mk("Ollama", "llava:7b", "Llava 7b", "untested", { contextWindow: 32768, caps: { tools: false, vision: true, reasoning: false, coding: false } }),
    mk("Ollama", "gemma3:4b", "Gemma3 4b", "failed", { error: "Timed out (the model may still be loading — try again)", caps: { tools: true, vision: true, reasoning: false, coding: false } }),
    mk("Anthropic", "claude-opus-5-5", "Claude Opus 5.5", "working", { latencyMs: 1240, selected: true, toolSupport: "called", contextWindow: 1000000, maxOutputTokens: 128000, caps: { tools: true, vision: true, reasoning: true, coding: true }, pricing: { inputPerM: 4, outputPerM: 20, source: "list" }, stats: { requests: 18, failures: 0, ttftMs: 1450, tokensPerSec: 71, costUsd: 0.8312 } }),
    mk("Anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", "working", { latencyMs: 860, selected: true, toolSupport: "called", contextWindow: 1000000, caps: { tools: true, vision: true, reasoning: true, coding: true }, pricing: { inputPerM: 2, outputPerM: 10, source: "list" }, stats: { requests: 9, failures: 1, ttftMs: 900, tokensPerSec: 95, costUsd: 0.1104 } }),
    mk("Anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "working", { latencyMs: 410, toolSupport: "called", contextWindow: 200000, caps: { tools: true, vision: true, reasoning: false, coding: true }, pricing: { inputPerM: 1, outputPerM: 5, source: "list" } }),
    mk("OpenRouter", "qwen/qwen3-coder", "Qwen3 Coder", "working", { latencyMs: 690, toolSupport: "called", contextWindow: 262144, pricing: { inputPerM: 0.22, outputPerM: 0.95, source: "server" } }),
    mk("OpenRouter", "moonshotai/kimi-k2", "Kimi K2", "testing", { contextWindow: 131072, pricing: { inputPerM: 0.55, outputPerM: 2.2, source: "server" } }),
    mk("OpenRouter", "mistralai/devstral-medium", "Devstral Medium", "untested", { contextSource: "guess", pricing: { inputPerM: 0.4, outputPerM: 2, source: "server" } }),
  ],
  routes: [{ name: "Coding (auto)", slug: "coding-auto", models: ["Ollama::qwen2.5-coder:14b", "Anthropic::claude-sonnet-5-5", "OpenRouter::qwen/qwen3-coder"], available: 3 }],
  overrides: {},
  discovered: true,
  verifying: { done: 3, total: 5, working: 3, failed: 0 },
  spend: 0.9416,
  settings: { testConcurrency: 8, providerConcurrency: 3, cacheTtlHours: 48, showReasoning: true, toolCheck: "full" },
};

function page(theme) {
  const vars = Object.entries({ ...base, ...THEMES[theme] }).map(([k, v]) => `--vscode-${k}: ${v};`).join("\n");
  const css = (f) => fs.readFileSync(path.join(ROOT, "media", f), "utf8");
  const codicons = css("codicon.css").replace(/url\("\.\/codicon\.ttf[^"]*"\)/, `url("data:font/ttf;base64,${fs.readFileSync(path.join(ROOT, "media", "codicon.ttf")).toString("base64")}")`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>:root{${vars}}</style><style>${codicons}</style><style>${css("dashboard.css")}</style></head>
<body class="vscode-${theme === "high-contrast" ? "high-contrast" : theme}"><div id="app"></div>
<script>window.acquireVsCodeApi = () => ({ postMessage: (m) => (window.__sent = (window.__sent || []).concat([m])), getState: () => undefined, setState: () => {} });</script>
<script>${css("dashboard.js")}</script></body></html>`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (writeReadme) fs.mkdirSync(README_DIR, { recursive: true });
  const browser = await chromium.launch();
  const shots = [];
  for (const theme of Object.keys(THEMES)) {
    for (const [name, width, height] of [["wide", 1280, 800], ["narrow", 640, 900]]) {
      const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      const errors = [];
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await p.setContent(page(theme));
      await p.evaluate((state) => window.postMessage({ type: "state", state }, "*"), STATE);
      for (const tab of ["models", "providers", "routes", "settings"]) {
        await p.click(`[data-tab="${tab}"]`);
        await p.waitForTimeout(150);
        const file = path.join(OUT, `${theme}-${name}-${tab}.png`);
        await p.screenshot({ path: file });
        shots.push(file);
        if (writeReadme && theme === "dark" && name === "wide") fs.copyFileSync(file, path.join(README_DIR, `${tab}.png`));
      }
      // Editor and limits views
      await p.click('[data-tab="providers"]');
      await p.click('[data-action="add-provider"]');
      await p.click('[data-preset="anthropic"]');
      await p.click("details.advanced summary");
      await p.screenshot({ path: path.join(OUT, `${theme}-${name}-editor.png`), fullPage: true });
      await p.click('[data-tab="models"]');
      await p.click('[data-action="edit-limits"]');
      await p.screenshot({ path: path.join(OUT, `${theme}-${name}-limits.png`) });
      if (writeReadme && theme === "dark" && name === "wide") fs.copyFileSync(path.join(OUT, `${theme}-${name}-editor.png`), path.join(README_DIR, "editor.png"));
      // Horizontal overflow is a layout bug at any width.
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) errors.push(`horizontal overflow at ${width}px`);
      if (errors.length) console.log(`${theme}/${name}: ${errors.join(" | ")}`);
      await p.close();
    }
  }
  await browser.close();
  console.log(`wrote ${shots.length + 12} screenshots to ${path.relative(ROOT, OUT)}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
