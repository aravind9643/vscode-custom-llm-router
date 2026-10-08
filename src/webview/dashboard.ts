/* LLM Router dashboard — bundled by esbuild into media/dashboard.js and loaded by DashboardPanel
   under a strict nonce CSP. Rule: every dynamic value is rendered through esc(); no inline event handlers. */
import type { DashboardState, HostMessage, WebviewMessage } from "../protocol";
import type { CatalogModel, StaticModelConfig } from "../types";
import type { DashboardSettings } from "../protocol";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void; getState(): any; setState(state: unknown): void };

(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  let S: DashboardState = { providers: [], models: [], routes: [], overrides: {}, discovered: false, verifying: null, spend: 0, settings: {} as DashboardState["settings"] };
  let hasState = false;
  /** Rows above this count are rendered in a scroll window instead of all at once. */
  const VIRTUAL_THRESHOLD = 200;
  const ROW_HEIGHT = 46;

  const ui = {
    tab: saved.tab || null,
    q: saved.q || "",
    provider: saved.provider || "",
    status: saved.status || "all",
    caps: new Set(saved.caps || []),
    sort: saved.sort || { col: "smart", dir: 1 },
    editor: null as any,
    cardResults: {} as Record<string, { ok: boolean; text: string }>,
    /** Key of the model whose limits editor row is open. */
    limitsFor: null as string|null,
    rows: [] as any[],
    window: null as number[]|null,
  };
  const persist = () =>
    vscode.setState({ tab: ui.tab, q: ui.q, provider: ui.provider, status: ui.status, caps: [...ui.caps], sort: ui.sort });
  const post = (msg: WebviewMessage) => vscode.postMessage(msg);

  const PRESETS = [
    { id: "ollama", name: "Ollama", url: "http://localhost:11434", note: "Local · no key" },
    { id: "lmstudio", name: "LM Studio", url: "http://localhost:1234", note: "Local · no key" },
    { id: "vllm", name: "vLLM", url: "http://localhost:8000", note: "Self-hosted" },
    { id: "localai", name: "LocalAI", url: "http://localhost:8080", note: "Local · no key" },
    { id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/api", note: "API key", key: true },
    { id: "openai", name: "OpenAI", url: "https://api.openai.com/v1", note: "API key", key: true },
    { id: "gemini", name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", note: "API key", key: true },
    { id: "deepseek", name: "DeepSeek", url: "https://api.deepseek.com", note: "API key", key: true },
    { id: "groq", name: "Groq", url: "https://api.groq.com/openai/v1", note: "API key", key: true },
    { id: "cerebras", name: "Cerebras", url: "https://api.cerebras.ai/v1", note: "Ultra-fast · API key", key: true },
    { id: "together", name: "Together AI", url: "https://api.together.xyz/v1", note: "API key", key: true },
    { id: "mistral", name: "Mistral AI", url: "https://api.mistral.ai/v1", note: "API key", key: true },
    { id: "perplexity", name: "Perplexity", url: "https://api.perplexity.ai", note: "Sonar search · API key", key: true },
    { id: "xai", name: "xAI (Grok)", url: "https://api.x.ai/v1", note: "API key", key: true },
    { id: "sambanova", name: "SambaNova", url: "https://api.sambanova.ai/v1", note: "Fast · API key", key: true },
    {
      id: "github", name: "GitHub Models", url: "https://models.github.ai/inference", note: "GitHub token", key: true,
      chatEndpoint: "https://models.github.ai/inference/chat/completions", modelsEndpoint: "https://models.github.ai/catalog/models",
    },
    { id: "anthropic", name: "Anthropic", url: "https://api.anthropic.com", note: "Claude · native API", key: true, api: "anthropic" },
    {
      id: "azure", name: "Azure OpenAI", url: "https://YOUR-RESOURCE.openai.azure.com/openai/v1", note: "api-key · deployments as model IDs", key: true,
      authHeader: "api-key", autoDiscover: false,
    },
    { id: "freellmapi", name: "FreeLLMAPI", url: "http://127.0.0.1:31415", note: "Local router" },
    { id: "omniroute", name: "OmniRoute", url: "http://localhost:20128", note: "Local router" },
    { id: "custom", name: "", url: "", note: "Any OpenAI-compatible URL", label: "Custom" },
  ];

  const STATUS_ORDER = { working: 0, testing: 1, untested: 2, failed: 3 };
  const CAP_FILTERS = [
    { id: "copilot", label: "In Copilot", icon: "copilot", test: (m) => m.selected },
    { id: "coding", label: "Coding", icon: "code", test: (m) => m.caps.coding },
    { id: "reasoning", label: "Reasoning", icon: "lightbulb", test: (m) => m.caps.reasoning },
    { id: "vision", label: "Vision", icon: "eye", test: (m) => m.caps.vision },
    { id: "tools", label: "Tools", icon: "tools", test: (m) => m.caps.tools },
    { id: "fast", label: "Fast < 1s", icon: "zap", test: (m) => m.status === "working" && m.latencyMs < 1000 },
  ];

  // ------------------------------------------------------------ helpers

  /** @param {unknown} s */
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
  }
  const icon = (name, cls = "") => `<i class="codicon codicon-${name} ${cls}"></i>`;
  const $ = (sel) => (document.querySelector(sel) as HTMLElement);
  const kTokens = (n: number) => (n >= 1000000 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const money = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;

  function timeAgo(ts) {
    if (!ts) return "";
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const h = Math.round(mins / 60);
    return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  }

  /** Mirrors src/endpoints.ts so the editor can preview the resolved URL. */
  function previewChatUrl(draft) {
    let b = draft.endpointUrl.trim().replace(/\/+$/, "").replace(/\/(chat\/completions|models)$/i, "");
    if (!b) return "";
    let host = "", port = "";
    try {
      ({ hostname: host, port } = new URL(b));
    } catch {
      // incomplete URL while typing
    }
    const api = draft.api || (host === "api.anthropic.com" ? "anthropic" : port === "11434" || /ollama/i.test(draft.name) ? "ollama" : "openai");
    if (api === "anthropic") return `${b.replace(/\/v1$/i, "")}/v1/messages`;
    if (api === "ollama") return `${b.replace(/\/v\d+[a-z0-9]*$/i, "")}/api/chat`;
    if (draft.chatEndpoint.trim()) return draft.chatEndpoint.trim();
    return `${/\/(v\d+[a-z0-9]*|openai)$/i.test(b) ? b : b + "/v1"}/chat/completions`;
  }

  let toastTimer;
  function toast(text, kind = "ok") {
    const t = $("#toast");
    t.className = `toast ${kind}`;
    t.innerHTML = `${icon(kind === "ok" ? "pass-filled" : "error")}<span>${esc(text)}</span>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
  }

  // -------------------------------------------------------------- shell

  $("#app").innerHTML = `
    <header class="app-header">
      <div class="topbar">
        <div class="brand">${icon("hubot")}LLM Router</div>
        <div class="stats" id="stats"></div>
        <div class="top-actions">
          <button class="btn" data-action="refresh" id="refreshBtn" title="Re-fetch model lists from every provider">${icon("refresh")}Refresh</button>
          <button class="btn primary" data-action="verify-untested" id="verifyBtn">${icon("beaker")}Verify</button>
        </div>
      </div>
      <div class="progress hidden" id="progress"></div>
      <nav class="tabs" role="tablist">
        <button class="tab" role="tab" data-action="tab" data-tab="models">${icon("symbol-class")}Models <span class="count" id="count-models">0</span></button>
        <button class="tab" role="tab" data-action="tab" data-tab="providers">${icon("server")}Providers <span class="count" id="count-providers">0</span></button>
        <button class="tab" role="tab" data-action="tab" data-tab="routes">${icon("git-merge")}Routes <span class="count" id="count-routes">0</span></button>
        <button class="tab" role="tab" data-action="tab" data-tab="settings">${icon("settings-gear")}Settings</button>
      </nav>
    </header>
    <main class="app-body">
      <section class="panel" id="panel-models">
        <div class="toolbar">
          <div class="row">
            <div class="search">${icon("search")}<input type="search" id="q" placeholder="Search models  ( / )" aria-label="Search models"></div>
            <select id="provSel" aria-label="Filter by provider"></select>
            <div class="segmented" id="statusSeg" role="group" aria-label="Filter by status"></div>
          </div>
          <div class="row" id="chips"></div>
          <div id="banners" class="toolbar"></div>
          <div class="bulkbar" id="bulk"></div>
        </div>
        <div class="table-wrap" id="tableWrap">
          <table>
            <thead><tr id="thead"></tr></thead>
            <tbody id="tbody"></tbody>
          </table>
        </div>
      </section>
      <section class="panel scroll" id="panel-providers"></section>
      <section class="panel scroll" id="panel-routes"></section>
      <section class="panel scroll" id="panel-settings"></section>
    </main>
    <div id="toast" class="toast hidden" role="status"></div>`;

  (($("#q") as unknown) as HTMLInputElement).value = ui.q;

  // ------------------------------------------------------------- render

  function render() {
    if (!ui.tab) ui.tab = S.providers.length ? "models" : "providers";
    renderHeader();
    renderModels();
    if (!ui.editor) renderProviders();
    renderRoutes();
    renderSettings();
  }

  function renderHeader() {
    const enabled = S.providers.filter((p) => p.enabled);
    const online = enabled.filter((p) => p.online).length;
    const working = S.models.filter((m) => m.status === "working").length;
    const inCopilot = S.models.filter((m) => m.selected && m.status === "working").length;
    const untested = S.models.filter((m) => m.status === "untested").length;
    const anyOffline = enabled.some((p) => p.online === false);

    $("#stats").innerHTML = enabled.length
      ? `<span class="stat"><span class="dot ${anyOffline ? "err" : online ? "ok" : ""}"></span><strong>${online}/${enabled.length}</strong> providers online</span>
         <span class="stat">${icon("pass")}<strong>${working}</strong> verified</span>
         <span class="stat">${icon("copilot")}<strong>${inCopilot}</strong> in Copilot</span>` +
        (S.spend > 0 ? `<span class="stat" title="Estimated from reported usage × model prices (list or provider prices; correct them per model with ⚙)">${icon("credit-card")}<strong>~${money(S.spend)}</strong> spent</span>` : "")
      : "";

    const vb = ($("#verifyBtn") as HTMLButtonElement);
    if (S.verifying) {
      vb.dataset.action = "cancel-verify";
      vb.innerHTML = `${icon("debug-stop")}Stop`;
      vb.disabled = false;
    } else {
      vb.dataset.action = "verify-untested";
      vb.innerHTML = `${icon("beaker")}Verify ${untested ? `untested (${untested})` : "untested"}`;
      vb.disabled = untested === 0;
      vb.title = untested ? "Test every model that has no recent result" : "Every model has a fresh result — use “Re-test shown” to force";
    }

    const pr = $("#progress");
    if (S.verifying) {
      const { done, total, working: w, failed } = S.verifying;
      pr.classList.remove("hidden");
      pr.innerHTML = `${icon("sync", "spin")}<span>Verifying ${done}/${total}</span>
        <div class="track"><div class="fill" style="width:${total ? (done / total) * 100 : 0}%"></div></div>
        <span class="muted">${w} ok · ${failed} failed</span>`;
    } else pr.classList.add("hidden");

    $("#count-models").textContent = String(S.models.length);
    $("#count-providers").textContent = String(S.providers.length);
    $("#count-routes").textContent = String(S.routes.length);
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", (t as HTMLElement).dataset.tab === ui.tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${ui.tab}`));
  }

  // ------------------------------------------------------------- models

  function matchesBase(m, ignoreStatus) {
    const q = ui.q.trim().toLowerCase();
    if (q && !`${m.name} ${m.id} ${m.providerName}`.toLowerCase().includes(q)) return false;
    if (ui.provider && m.providerName !== ui.provider) return false;
    if (!ignoreStatus && !matchesStatus(m, ui.status)) return false;
    return true;
  }
  function matchesStatus(m, status) {
    if (status === "all") return true;
    if (status === "untested") return m.status === "untested" || m.status === "testing";
    return m.status === status;
  }
  const matchesCaps = (m) => CAP_FILTERS.every((f) => !ui.caps.has(f.id) || f.test(m));
  const visibleModels = () => sortModels(S.models.filter((m) => matchesBase(m, false) && matchesCaps(m)));

  function sortModels(list) {
    const { col, dir } = ui.sort;
    const lat = (m) => (m.status === "working" ? m.latencyMs : 1e9 + STATUS_ORDER[m.status]);
    const cmp = {
      smart: (a, b) => Number(b.selected) - Number(a.selected) || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || lat(a) - lat(b) || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      provider: (a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name),
      ctx: (a, b) => a.contextWindow - b.contextWindow,
      status: (a, b) => lat(a) - lat(b),
    }[col] || (() => 0);
    return [...list].sort((a, b) => cmp(a, b) * dir);
  }

  function renderModels() {
    // Provider filter
    const names = [...new Set(S.providers.filter((p) => p.enabled).map((p) => p.name))];
    if (ui.provider && !names.includes(ui.provider)) ui.provider = "";
    $("#provSel").innerHTML =
      `<option value="">All providers</option>` +
      names.map((n) => `<option value="${esc(n)}" ${n === ui.provider ? "selected" : ""}>${esc(n)}</option>`).join("");

    // Status segments (counts respect search + provider)
    const base = S.models.filter((m) => matchesBase(m, true));
    const seg = [
      ["all", "All", ""],
      ["working", "Working", "pass"],
      ["untested", "Untested", "circle-outline"],
      ["failed", "Failed", "error"],
    ];
    $("#statusSeg").innerHTML = seg
      .map(([id, label, ic]) => {
        const n = base.filter((m) => matchesStatus(m, id)).length;
        return `<button data-action="status" data-status="${id}" class="${ui.status === id ? "active" : ""}" aria-pressed="${ui.status === id}">${ic ? icon(ic) : ""}${label} <span class="n">${n}</span></button>`;
      })
      .join("");

    // Capability chips
    const statusBase = base.filter((m) => matchesStatus(m, ui.status));
    const anyFilter = ui.q || ui.provider || ui.status !== "all" || ui.caps.size;
    $("#chips").innerHTML =
      CAP_FILTERS.map(
        (f) =>
          `<button class="chip ${ui.caps.has(f.id) ? "active" : ""}" data-action="cap" data-cap="${f.id}" aria-pressed="${ui.caps.has(f.id)}">${icon(f.icon)}${f.label} <span class="n">${statusBase.filter(f.test).length}</span></button>`
      ).join("") + (anyFilter ? `<span class="sep"></span><button class="link-btn" data-action="reset-filters">Clear filters</button>` : "");

    renderBanners();

    const rows = visibleModels();
    const inCopilot = S.models.filter((m) => m.selected && m.status === "working").length;
    const shownSelectable = rows.filter((m) => m.status !== "failed" && !m.selected).length;
    const shownSelected = rows.filter((m) => m.selected).length;
    $("#bulk").innerHTML = S.models.length
      ? `<span class="grow">Showing <strong>${rows.length}</strong> of ${S.models.length} · <strong>${inCopilot}</strong> in Copilot</span>
         <button class="btn small" data-action="bulk-add" ${shownSelectable ? "" : "disabled"} title="Add every shown model that has not failed">${icon("add")}Add shown to Copilot</button>
         <button class="btn small" data-action="bulk-remove" ${shownSelected ? "" : "disabled"}>${icon("remove")}Remove shown</button>
         <button class="btn small" data-action="bulk-test" ${rows.length && !S.verifying ? "" : "disabled"} title="Re-test every shown model, ignoring cached results">${icon("beaker")}Re-test shown</button>`
      : "";

    // Table
    const th = (col, label, cls) =>
      col
        ? `<th class="${cls} sortable" data-action="sort" data-col="${col}" aria-sort="${ui.sort.col === col ? (ui.sort.dir > 0 ? "ascending" : "descending") : "none"}">${label}${ui.sort.col === col ? icon(ui.sort.dir > 0 ? "arrow-up" : "arrow-down") : ""}</th>`
        : `<th class="${cls}">${label}</th>`;
    const allShownSelected = rows.length > 0 && rows.every((m) => m.selected || m.status === "failed") && shownSelected > 0;
    $("#thead").innerHTML =
      `<th class="col-check"><input type="checkbox" data-action="toggle-shown" title="Add or remove all shown models" ${allShownSelected ? "checked" : ""} ${rows.length ? "" : "disabled"}></th>` +
      th("name", "Model", "") +
      th("provider", "Provider", "col-provider") +
      th("", "Capabilities", "col-caps") +
      th("ctx", "Context", "col-ctx") +
      th("status", "Status", "col-status") +
      `<th class="col-act"></th>`;

    ui.rows = rows;
    // Don't yank the limits editor out from under the user while they type in it.
    if (document.getElementById("limitsRow")?.contains(document.activeElement)) return;
    renderRows();
  }

  /** Renders all rows, or only the visible window (plus spacers) for very long lists. */
  function renderRows() {
    const rows = ui.rows;
    const body = $("#tbody");
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7">${emptyModels()}</td></tr>`;
      return;
    }
    const virtual = rows.length > VIRTUAL_THRESHOLD && !ui.limitsFor;
    $("#tableWrap").classList.toggle("virtual", virtual);
    if (!virtual) {
      body.innerHTML = rows.map((m) => modelRow(m) + (ui.limitsFor === m.key ? limitsRow(m) : "")).join("");
      return;
    }
    const wrap = $("#tableWrap");
    const first = Math.max(0, Math.floor(wrap.scrollTop / ROW_HEIGHT) - 10);
    const count = Math.ceil((wrap.clientHeight || 800) / ROW_HEIGHT) + 20;
    const last = Math.min(rows.length, first + count);
    const spacer = (n) => (n > 0 ? `<tr class="spacer" aria-hidden="true"><td colspan="7" style="height:${n * ROW_HEIGHT}px"></td></tr>` : "");
    body.innerHTML = spacer(first) + rows.slice(first, last).map(modelRow).join("") + spacer(rows.length - last);
    ui.window = [first, last];
  }

  function renderBanners() {
    const out = [];
    const enabled = S.providers.filter((p) => p.enabled);
    for (const p of enabled.filter((p) => p.needsKey)) {
      out.push(`<div class="banner warn">${icon("key")}<span class="grow"><strong>${esc(p.name)}</strong> needs an API key on this machine — keys are stored per machine and are not synced.</span>
        <button class="btn small primary" data-action="set-key" data-name="${esc(p.name)}">Enter API key</button></div>`);
    }
    for (const p of enabled.filter((p) => p.online === false && !p.needsKey)) {
      out.push(`<div class="banner warn">${icon("warning")}<span class="grow"><strong>${esc(p.name)}</strong> is unreachable — ${esc(p.error || "no response")}</span>
        <button class="btn small" data-action="edit-provider" data-name="${esc(p.name)}">Edit provider</button></div>`);
    }
    const untested = S.models.filter((m) => m.status === "untested").length;
    const working = S.models.filter((m) => m.status === "working");
    const selectedWorking = working.filter((m) => m.selected).length;
    if (!S.verifying && untested && !working.length) {
      out.push(`<div class="banner">${icon("info")}<span class="grow">Copilot only lists models that pass a quick health check. ${plural(untested, "model")} ${untested === 1 ? "hasn't" : "haven't"} been checked yet.</span>
        <button class="btn small primary" data-action="verify-untested">${icon("beaker")}Verify now</button></div>`);
    } else if (working.length && !selectedWorking && !S.models.some((m) => m.selected)) {
      out.push(`<div class="banner">${icon("copilot")}<span class="grow">No models are in Copilot yet. Tick the ones you want in the model picker, or add every working model.</span>
        <button class="btn small primary" data-action="add-all-working">Add ${plural(working.length, "working model")}</button></div>`);
    }
    if (S.settings.budgetLimitUsd && S.spend >= S.settings.budgetLimitUsd) {
      out.push(`<div class="banner warn">${icon("warning")}<span class="grow">Estimated spend of <strong>${money(S.spend)}</strong> has reached or exceeded your budget limit of <strong>$${S.settings.budgetLimitUsd}</strong>.</span>
        <button class="btn small" data-action="tab" data-tab="settings">Adjust budget</button></div>`);
    }
    $("#banners").innerHTML = out.join("");
    $("#banners").classList.toggle("hidden", !out.length);
  }

  function emptyModels() {
    if (!S.providers.length)
      return `<div class="empty">${icon("plug")}No providers yet.<br><br><button class="btn primary" data-action="add-provider">${icon("add")}Add a provider</button></div>`;
    if (!hasState || !S.discovered) return `<div class="empty">${icon("loading", "spin")}Loading models…</div>`;
    if (!S.models.length)
      return `<div class="empty">${icon("search-stop")}No chat models were found. Check that your providers are online and enabled.<br><br><button class="btn" data-action="tab" data-tab="providers">Open providers</button></div>`;
    return `<div class="empty">${icon("filter")}No models match these filters.<br><br><button class="btn" data-action="reset-filters">Clear filters</button></div>`;
  }

  function modelRow(m) {
    const key = esc(m.key);
    const canCheck = m.selected || m.status !== "failed";
    const checkTitle = m.selected
      ? m.status === "working" ? "Shown in Copilot — click to remove" : "Selected — appears in Copilot once it passes verification"
      : m.status === "failed" ? "Failed verification — re-test it first" : m.status === "working" ? "Add to Copilot" : "Add to Copilot (it is verified first)";
    const caps = [
      ["coding", "code", "Coding"],
      ["reasoning", "lightbulb", "Reasoning"],
      ["vision", "eye", "Image input"],
      ["tools", "tools", "Tool calling"],
    ]
      .map(([k, ic, t]) => {
        if (k === "tools" && m.toolSupport === "accepted")
          return `<span class="cap tools weak" title="Accepts tools, but did not call one when asked — may struggle in agent mode">${icon(ic)}</span>`;
        const title = k === "tools" && m.toolSupport === "called" ? "Tool calling (verified: it called a tool)" : m.caps[k] ? t : "No " + t.toLowerCase();
        return `<span class="cap ${k === "coding" ? "code" : k} ${m.caps[k] ? "" : "off"}" title="${title}">${icon(ic)}</span>`;
      })
      .join("");

    let status;
    if (m.status === "working")
      status = `<span class="status working" title="Verified ${esc(timeAgo(m.testedAt))}">${icon("pass-filled")}<span class="lat ${m.latencyMs > 3000 ? "slow" : ""}">${m.latencyMs}ms</span></span>`;
    else if (m.status === "testing") status = `<span class="status testing">${icon("loading", "spin")}Testing…</span>`;
    else if (m.status === "failed")
      status = `<span class="status failed">${icon("error")}Failed</span><div class="err-line" title="${esc(m.error)}">${esc(m.error || "")}</div>`;
    else status = `<span class="status untested">${icon("circle-outline")}Untested</span>`;
    const st = m.stats;
    if (st?.requests && (st.ttftMs !== undefined || st.tokensPerSec)) {
      const bits = [st.ttftMs !== undefined && `${st.ttftMs}ms first token`, st.tokensPerSec && `${st.tokensPerSec} tok/s`].filter(Boolean);
      if (st.costUsd) bits.push(`~${money(st.costUsd)}`);
      status += `<div class="speed" title="From ${st.requests} real chat request${st.requests === 1 ? "" : "s"}${st.failures ? `, ${st.failures} failed` : ""}">${icon("graph")}${esc(bits.join(" · "))}</div>`;
    }
    const prov = S.providers.find((p) => p.name === m.providerName);
    const ctxNote =
      m.contextSource === "override" ? "set by you" : m.contextSource === "server" ? "reported by the server" : "estimated from the model name — set it if it is wrong";
    const ollamaNote = prov?.kind === "ollama" && m.contextSource !== "override" ? "\nOllama serves OLLAMA_CONTEXT_LENGTH tokens (often 4k–8k) unless configured — override it here to match." : "";

    return `<tr class="${m.selected ? "selected" : ""}">
      <td class="col-check"><input type="checkbox" data-action="toggle-model" data-key="${key}" ${m.selected ? "checked" : ""} ${canCheck ? "" : "disabled"} title="${esc(checkTitle)}" aria-label="In Copilot: ${esc(m.name)}"></td>
      <td><div class="model-name" title="${esc(m.name)}">${esc(m.name)}</div><div class="model-id" title="${esc(m.id)}">${esc(m.id)}</div></td>
      <td class="col-provider"><span class="tag" title="${esc(m.providerName)}">${esc(m.providerName)}</span></td>
      <td class="col-caps"><div class="caps">${caps}</div></td>
      <td class="col-ctx num ${m.contextSource}" title="${esc(`${m.contextWindow.toLocaleString()} tokens context (${ctxNote}) · ${m.maxOutputTokens.toLocaleString()} max output${ollamaNote}`)}">${m.contextSource === "guess" ? "~" : ""}${kTokens(m.contextWindow)}${m.hasOverride ? icon("pinned", "ov") : ""}${
        m.pricing ? `<div class="price" title="USD per million tokens, input · output (${m.pricing.source === "list" ? "list price" : m.pricing.source === "override" ? "your price" : "provider price"})">$${m.pricing.inputPerM} · $${m.pricing.outputPerM}</div>` : ""
      }</td>
      <td class="col-status">${status}</td>
      <td class="col-act"><div class="act">
        <button class="icon-btn" data-action="ping" data-key="${key}" title="Re-test this model" ${m.status === "testing" ? "disabled" : ""}>${icon("debug-rerun")}</button>
        <button class="icon-btn ${ui.limitsFor === m.key ? "on" : ""}" data-action="edit-limits" data-key="${key}" title="Edit name, limits and capabilities">${icon("settings")}</button>
      </div></td>
    </tr>`;
  }

  /** Inline editor for a model's override (name, limits, capabilities). */
  function limitsRow(m) {
    const ov = S.overrides[m.key] || {};
    const tri = (field, label) => {
      const v = ov[field] === true ? "on" : ov[field] === false ? "off" : "auto";
      return `<label class="lim-field">${label}<select data-lim="${field}">
        <option value="auto" ${v === "auto" ? "selected" : ""}>Auto</option>
        <option value="on" ${v === "on" ? "selected" : ""}>Yes</option>
        <option value="off" ${v === "off" ? "selected" : ""}>No</option></select></label>`;
    };
    return `<tr id="limitsRow" class="limits-row"><td></td><td colspan="6">
      <div class="limits">
        <label class="lim-field grow">Display name<input type="text" data-lim="name" value="${esc(ov.name || "")}" placeholder="${esc(m.name)}"></label>
        <label class="lim-field">Context window<input type="number" min="1024" data-lim="contextWindow" value="${esc(ov.contextWindow || "")}" placeholder="${m.contextWindow}"></label>
        <label class="lim-field">Max output<input type="number" min="256" data-lim="maxOutputTokens" value="${esc(ov.maxOutputTokens || "")}" placeholder="${m.maxOutputTokens}"></label>
        <label class="lim-field">$ / M input<input type="number" min="0" step="0.01" data-lim="inputPerM" value="${esc(ov.inputPerM ?? "")}" placeholder="${m.pricing ? m.pricing.inputPerM : "—"}"></label>
        <label class="lim-field">$ / M output<input type="number" min="0" step="0.01" data-lim="outputPerM" value="${esc(ov.outputPerM ?? "")}" placeholder="${m.pricing ? m.pricing.outputPerM : "—"}"></label>
        ${tri("toolCalling", "Tools")}
        ${tri("vision", "Images")}
        <div class="lim-actions">
          <button class="btn small primary" data-action="save-limits" data-key="${esc(m.key)}">Save</button>
          ${S.overrides[m.key] ? `<button class="btn small" data-action="reset-limits" data-key="${esc(m.key)}">Reset</button>` : ""}
          <button class="btn small" data-action="close-limits">Cancel</button>
        </div>
      </div>
      <div class="hint">Leave a field empty to use the detected value. Copilot uses these limits to decide how much context to send.</div>
    </td></tr>`;
  }

  // ---------------------------------------------------------- providers

  function renderProviders() {
    const el = $("#panel-providers");
    if (!S.providers.length) {
      el.innerHTML = `<div class="hero">${icon("plug")}
        <h2>Connect a model provider</h2>
        <p>Pick a preset or point at any OpenAI-compatible endpoint. Verified models can then be added to the Copilot model picker.</p>
        <div style="margin-bottom:14px"><button class="btn" data-action="scan-local">${icon("search")}Scan local servers</button></div>
        ${presetGrid(null)}</div>`;
      return;
    }
    el.innerHTML = `<div class="section-head"><h2>Providers</h2>
        <button class="btn" data-action="scan-local" title="Scan local ports (11434, 1234, 8000, 8080) for running LLMs">${icon("search")}Scan local</button>
        <button class="btn" data-action="import">${icon("cloud-download")}Import</button>
        <button class="btn primary" data-action="add-provider">${icon("add")}Add provider</button></div>
      <div class="cards">${S.providers.map(providerCard).join("")}</div>`;
  }

  function providerCard(p) {
    const name = esc(p.name);
    const models = S.models.filter((m) => m.providerName === p.name);
    const inCopilot = models.filter((m) => m.selected && m.status === "working").length;
    const dot = !p.enabled ? "" : p.online === true ? "ok" : p.online === false ? "err" : "";
    const meta = [];
    if (!p.enabled) meta.push(`<span>${icon("circle-slash")}Disabled</span>`);
    else if (p.online === undefined) meta.push(`<span>${icon("loading", "spin")}Connecting…</span>`);
    else if (p.online) meta.push(`<span>${icon("pulse")}${p.latencyMs ?? "?"}ms</span><span>${icon("symbol-class")}${plural(models.length, "model")}${inCopilot ? ` · ${inCopilot} in Copilot` : ""}</span>`);
    else meta.push(`<span class="err" title="${esc(p.error)}">${icon("error")}${esc((p.error || "Unreachable").slice(0, 80))}</span>`);
    if (p.needsKey) meta.push(`<span class="warn" title="The server rejected the credentials. API keys are stored per machine and do not sync.">${icon("key")}API key needed on this machine</span>`);
    if (p.plaintextSecretHeaders?.length)
      meta.push(`<span class="warn" title="Edit and save the provider to move these values to secret storage.">${icon("warning")}${esc(p.plaintextSecretHeaders.join(", "))} in plain text</span>`);
    if (p.api && p.api !== "openai") meta.push(`<span>${icon(p.api === "anthropic" ? "sparkle" : "server-process")}${p.api === "anthropic" ? "Anthropic API" : "Ollama native"}</span>`);
    if (p.keySource === "secret") meta.push(`<span title="Stored in VS Code secret storage">${icon("lock")}Key secured</span>`);
    else if (p.keySource === "settings")
      meta.push(`<span class="warn" title="This key is in settings.json as plain text. Edit and save the provider to move it to secret storage.">${icon("warning")}Key in plain-text settings</span>`);
    const res = ui.cardResults[p.name];

    return `<div class="card ${p.enabled ? "" : "off"}">
      <div class="p-head"><span class="p-dot ${dot}"></span><span class="p-name" title="${name}">${name}</span>
        <button class="icon-btn" data-action="delete-provider" data-name="${name}" title="Delete provider" aria-label="Delete ${name}">${icon("trash")}</button>
        <label class="switch" title="${p.enabled ? "Disable" : "Enable"} provider"><input type="checkbox" data-action="toggle-provider" data-name="${name}" ${p.enabled ? "checked" : ""} aria-label="Enable ${name}"><span></span></label></div>
      <div class="p-url">${esc(p.endpointUrl)}</div>
      <div class="p-meta">${meta.join("")}</div>
      <div class="p-actions">
        ${p.needsKey ? `<button class="btn small primary" data-action="set-key" data-name="${name}">${icon("key")}Enter API key</button>` : ""}
        <button class="btn small" data-action="test-provider" data-name="${name}">${icon("plug")}Test</button>
        <button class="btn small" data-action="verify-provider" data-name="${name}" ${p.enabled && models.length && !S.verifying ? "" : "disabled"}>${icon("beaker")}Verify models</button>
        ${p.kind === "ollama" && p.enabled ? `<button class="btn small" data-action="pull-ollama" data-name="${name}" title="Download a model from the Ollama library">${icon("cloud-download")}Pull model</button>` : ""}
        <button class="btn small" data-action="edit-provider" data-name="${name}">${icon("edit")}Edit</button>
      </div>
      ${res ? `<div class="inline-result ${res.ok ? "ok" : "err"}">${esc(res.text)}</div>` : ""}
    </div>`;
  }

  function presetGrid(activeId) {
    return `<div class="presets">${PRESETS.map(
      (p) => `<button class="preset ${activeId === p.id ? "active" : ""}" data-action="preset" data-preset="${p.id}"><strong>${esc(p.label || p.name)}</strong><span>${esc(p.note)}</span></button>`
    ).join("")}</div>`;
  }

  // ------------------------------------------------------------- editor

  function openEditor(name) {
    const p = name ? S.providers.find((x) => x.name === name) : null;
    ui.editor = {
      original: p ? p.name : null,
      preset: null,
      keySource: p ? p.keySource : "none",
      staticModels: p?.staticModels || [],
      draft: {
        name: p?.name || "",
        endpointUrl: p?.endpointUrl || "",
        apiKey: "",
        clearKey: false,
        autoDiscover: p ? p.autoDiscover !== false : true,
        enabled: p ? p.enabled : true,
        modelsEndpoint: p?.modelsEndpoint || "",
        chatEndpoint: p?.chatEndpoint || "",
        timeoutSec: p?.timeoutMs ? String(Math.round(p.timeoutMs / 1000)) : "",
        headersText: Object.entries(p?.headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n"),
        staticText: (p?.staticModels || []).map((m) => m.id).join("\n"),
        keepAlive: p?.keepAlive || "",
        api: p?.api || "",
        authHeader: p?.authHeader || "bearer",
        contextLength: p?.contextLength ? String(p.contextLength) : "",
      },
      errors: {},
      saving: false,
    };
    ui.tab = "providers";
    persist();
    renderHeader();
    renderEditor();
  }

  function closeEditor() {
    ui.editor = null;
    renderProviders();
  }

  function renderEditor() {
    const e = ui.editor;
    const d = e.draft;
    const advancedOpen = d.modelsEndpoint || d.chatEndpoint || d.timeoutSec || d.headersText || d.keepAlive || d.contextLength || d.api || d.authHeader !== "bearer" || (d.staticText && !d.autoDiscover);
    const select = (id: string, label: string, value: string, options: [string, string][], hint = "") => `<div class="field">
        <label for="f-${id}">${label}</label>
        <select id="f-${id}" data-field="${id}">${options.map(([v, t]) => `<option value="${v}" ${v === value ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
        ${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
    const keyPlaceholder =
      e.keySource === "secret" ? "•••••••• stored securely — leave blank to keep" : e.keySource === "settings" ? "Key in settings.json — leave blank to move it to secure storage" : PRESETS.find((x) => x.id === e.preset)?.key ? "Required for this provider" : "Optional for local servers";
    const field = (id: string, label: string, value: unknown, opts: { type?: string; placeholder?: string; hint?: string } = {}) => `<div class="field">
        <label for="f-${id}">${label}</label>
        <input type="${opts.type || "text"}" id="f-${id}" data-field="${id}" value="${esc(value)}" placeholder="${esc(opts.placeholder || "")}" ${opts.type === "number" ? 'min="1" max="600"' : ""} spellcheck="false" autocomplete="off">
        ${opts.hint ? `<div class="hint">${opts.hint}</div>` : ""}<div class="error" id="err-${id}">${esc(e.errors[id] || "")}</div></div>`;

    $("#panel-providers").innerHTML = `<div class="editor">
      <button class="btn small back" data-action="close-editor">${icon("arrow-left")}Providers</button>
      <div class="section-head"><h2>${e.original ? `Edit ${esc(e.original)}` : "Add a provider"}</h2></div>
      ${e.original ? "" : `<div class="field"><label>Start from a preset</label>${presetGrid(e.preset)}</div>`}
      <div class="form">
        <div class="field-row">
          ${field("name", "Name", d.name, { placeholder: "e.g. Ollama" })}
          ${field("endpointUrl", "Base URL", d.endpointUrl, { placeholder: "http://localhost:11434", hint: `<span id="urlPreview"></span>` })}
        </div>
        <div class="field">
          <label for="f-apiKey">API key</label>
          <div class="input-group">
            <input type="password" id="f-apiKey" data-field="apiKey" value="${esc(d.apiKey)}" placeholder="${esc(keyPlaceholder)}" autocomplete="off" spellcheck="false" ${d.clearKey ? "disabled" : ""}>
            <button class="icon-btn" data-action="toggle-key" title="Show or hide the key" aria-label="Show or hide the key">${icon("eye")}</button>
          </div>
          <div class="hint">${icon("lock")} Saved in VS Code's encrypted secret storage — never written to settings.json.</div>
          ${e.keySource !== "none" ? `<label class="toggle-line" style="margin-top:6px"><input type="checkbox" data-field="clearKey" ${d.clearKey ? "checked" : ""}> Remove the stored key</label>` : ""}
        </div>
        <label class="toggle-line"><span class="switch"><input type="checkbox" data-field="autoDiscover" ${d.autoDiscover ? "checked" : ""}><span></span></span>
          Discover models automatically from the <code>/models</code> endpoint</label>
        <details class="advanced" ${advancedOpen ? "open" : ""}>
          <summary>Advanced</summary>
          <div class="form">
            <div class="field-row">
              ${select("api", "API type", d.api, [["", "Automatic"], ["openai", "OpenAI-compatible"], ["ollama", "Ollama native"], ["anthropic", "Anthropic Messages API"]], "Automatic picks Ollama native for Ollama servers and Anthropic for api.anthropic.com.")}
              ${select("authHeader", "Send the API key as", d.authHeader, [["bearer", "Authorization: Bearer …"], ["api-key", "api-key header (Azure OpenAI)"], ["x-api-key", "x-api-key header"]])}
            </div>
            <div class="field-row">
              ${field("chatEndpoint", "Chat completions URL", d.chatEndpoint, { placeholder: "Derived from base URL" })}
              ${field("modelsEndpoint", "Models list URL", d.modelsEndpoint, { placeholder: "Derived from base URL" })}
            </div>
            <div class="field-row">
              ${field("timeoutSec", "Health-check timeout (seconds)", d.timeoutSec, { type: "number", placeholder: "20" })}
              ${field("contextLength", "Ollama context length", d.contextLength, { type: "number", placeholder: "32768", hint: "Ollama native only. Tokens of context models are loaded with (num_ctx); more uses more memory." })}
            </div>
            <div class="field-row">
              ${field("keepAlive", "Ollama keep-alive", d.keepAlive, { placeholder: "5m (Ollama default)", hint: "Ollama only. Keeps the model loaded after a chat, e.g. <code>30m</code>, <code>2h</code> or <code>-1</code> (forever)." })}
            </div>
            <div class="field"><label for="f-headersText">Extra request headers</label>
              <textarea id="f-headersText" data-field="headersText" placeholder="HTTP-Referer: https://example.com&#10;X-Title: VS Code" spellcheck="false">${esc(d.headersText)}</textarea>
              <div class="hint">One <code>Name: value</code> per line. Values of headers named like <code>*key*</code>, <code>*token*</code> or <code>*auth*</code> are kept in secret storage; <code>••••••</code> keeps the stored value.</div><div class="error" id="err-headersText"></div></div>
            <div class="field"><label for="f-staticText">Manual model IDs</label>
              <textarea id="f-staticText" data-field="staticText" placeholder="llama3.1:8b" spellcheck="false">${esc(d.staticText)}</textarea>
              <div class="hint">One ID per line. Use this for servers that don't list their models.</div></div>
          </div>
        </details>
        <div class="form-footer">
          <button class="btn" data-action="test-draft">${icon("plug")}Test connection</button>
          <span id="draftResult" class="inline-result"></span>
          <span class="grow"></span>
          <button class="btn" data-action="close-editor">Cancel</button>
          <button class="btn primary" data-action="save-draft" ${e.saving ? "disabled" : ""}>${icon("save")}${e.original ? "Save changes" : "Add provider"}</button>
        </div>
      </div>
    </div>`;
    updateUrlPreview();
  }

  function updateUrlPreview() {
    const el = document.getElementById("urlPreview");
    if (!el || !ui.editor) return;
    const url = previewChatUrl(ui.editor.draft);
    el.innerHTML = url ? `Chat requests go to <code>${esc(url)}</code>` : "The <code>/v1</code> suffix is optional.";
  }

  function parseHeaders(text) {
    const headers: Record<string,string> = {};
    const bad = [];
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      const at = line.indexOf(":");
      if (at <= 0) bad.push(i + 1);
      else headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    });
    return { headers, bad };
  }

  function draftToProvider() {
    const e = ui.editor;
    const d = e.draft;
    const errors: Record<string, string> = {};
    if (!d.name.trim()) errors.name = "Give the provider a name.";
    else if (S.providers.some((p) => p.name === d.name.trim() && p.name !== e.original)) errors.name = "Another provider already uses this name.";
    if (!/^https?:\/\/[^\s/]+/i.test(d.endpointUrl.trim())) errors.endpointUrl = "Enter a full URL starting with http:// or https://";
    const { headers, bad } = parseHeaders(d.headersText);
    if (bad.length) errors.headersText = `Line ${bad.join(", ")} is not in “Name: value” form.`;
    const ids: string[] = [...new Set<string>(String(d.staticText).split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
    e.errors = errors;
    for (const id of ["name", "endpointUrl", "headersText"]) {
      const el = document.getElementById(`err-${id}`);
      if (el) el.textContent = errors[id] || "";
      document.getElementById(`f-${id}`)?.classList.toggle("invalid", !!errors[id]);
    }
    if (Object.keys(errors).some((k) => errors[k])) return null;
    const existing = new Map<string, StaticModelConfig>(e.staticModels.map((m: StaticModelConfig) => [m.id, m]));
    return {
      name: d.name.trim(),
      endpointUrl: d.endpointUrl.trim(),
      enabled: d.enabled,
      autoDiscover: d.autoDiscover,
      chatEndpoint: d.chatEndpoint.trim() || undefined,
      modelsEndpoint: d.modelsEndpoint.trim() || undefined,
      timeoutMs: Number(d.timeoutSec) > 0 ? Number(d.timeoutSec) * 1000 : undefined,
      headers: Object.keys(headers).length ? headers : undefined,
      staticModels: ids.length ? ids.map((id) => existing.get(id) || { id }) : undefined,
      keepAlive: d.keepAlive.trim() || undefined,
      api: d.api || undefined,
      authHeader: d.authHeader !== "bearer" ? d.authHeader : undefined,
      contextLength: Number(d.contextLength) >= 1024 ? Math.round(Number(d.contextLength)) : undefined,
    };
  }

  function draftKey() {
    const d = ui.editor.draft;
    if (d.clearKey) return "";
    return d.apiKey.trim() ? d.apiKey.trim() : undefined;
  }

  function applyPreset(id) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    if (!ui.editor) openEditor(null);
    const d = ui.editor.draft;
    let name = p.name;
    for (let i = 2; name && S.providers.some((x) => x.name === name); i++) name = `${p.name} ${i}`;
    Object.assign(d, {
      name,
      endpointUrl: p.url,
      chatEndpoint: p.chatEndpoint || "",
      modelsEndpoint: p.modelsEndpoint || "",
      api: p.api || "",
      authHeader: p.authHeader || "bearer",
      autoDiscover: p.autoDiscover !== false,
    });
    ui.editor.preset = id;
    ui.editor.errors = {};
    renderEditor();
    document.getElementById(id === "custom" ? "f-name" : p.key ? "f-apiKey" : "f-endpointUrl")?.focus();
  }

  // ------------------------------------------------------------- routes

  /** Locally edited copy of the routes, posted back as a whole on every change. */
  function routesDraft() {
    return S.routes.map((r) => ({ name: r.name, models: [...r.models], ...(r.policy ? { policy: r.policy } : {}) }));
  }
  function saveRoutes(routes) {
    S.routes = routes.map((r) => ({ ...r, slug: r.name, available: r.models.filter((k) => S.models.find((m) => m.key === k)?.status === "working").length }));
    renderRoutes();
    renderHeader();
    post({ type: "saveRoutes", routes });
  }

  function renderRoutes() {
    const el = $("#panel-routes");
    if (el.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") return;
    const byKey = new Map(S.models.map((m) => [m.key, m]));
    const options = [...S.models]
      .filter((m) => m.status !== "failed")
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
    const memberLine = (r, k, i) => {
      const m = byKey.get(k);
      const st = !m ? `<span class="status failed">${icon("question")}missing</span>` :
        m.status === "working" ? `<span class="status working">${icon("pass-filled")}${m.latencyMs}ms</span>` :
        m.status === "failed" ? `<span class="status failed">${icon("error")}failed — skipped</span>` :
        `<span class="status untested">${icon("circle-outline")}untested</span>`;
      return `<li class="member">
        <span class="order">${i + 1}</span>
        <span class="m-text"><span class="model-name">${esc(m ? m.name : k)}</span><span class="model-id">${esc(m ? m.providerName : "")}</span></span>
        ${st}
        <button class="icon-btn" data-action="route-move" data-route="${esc(r.name)}" data-index="${i}" data-dir="-1" title="Move up" ${i === 0 ? "disabled" : ""}>${icon("arrow-up")}</button>
        <button class="icon-btn" data-action="route-move" data-route="${esc(r.name)}" data-index="${i}" data-dir="1" title="Move down" ${i === r.models.length - 1 ? "disabled" : ""}>${icon("arrow-down")}</button>
        <button class="icon-btn" data-action="route-remove" data-route="${esc(r.name)}" data-index="${i}" title="Remove from route">${icon("close")}</button>
      </li>`;
    };
    const cards = S.routes.map((r) => `<div class="card route">
        <div class="p-head"><span class="p-dot ${r.available ? "ok" : "err"}"></span><span class="p-name">${esc(r.name)}</span>
          <select class="policy-select" data-action="route-policy" data-route="${esc(r.name)}" aria-label="Route policy" title="How members are tried">
            <option value="priority" ${r.policy !== "round-robin" && r.policy !== "least-latency" ? "selected" : ""}>Priority</option>
            <option value="round-robin" ${r.policy === "round-robin" ? "selected" : ""}>Round-robin</option>
            <option value="least-latency" ${r.policy === "least-latency" ? "selected" : ""}>Least latency</option>
          </select>
          <span class="muted">${r.available}/${r.models.length} working · ${r.available ? "in Copilot" : "hidden until a member works"}</span>
          <button class="icon-btn" data-action="route-delete" data-route="${esc(r.name)}" title="Delete route">${icon("trash")}</button></div>
        <ol class="members">${r.models.map((k, i) => memberLine(r, k, i)).join("") || `<li class="muted">No models yet — add one below.</li>`}</ol>
        <div class="row"><select data-route-add="${esc(r.name)}" aria-label="Add a model to ${esc(r.name)}">
          <option value="">Add a model…</option>
          ${options.filter((m) => !r.models.includes(m.key)).map((m) => `<option value="${esc(m.key)}">${esc(m.name)} — ${esc(m.providerName)}${m.status === "working" ? "" : " (untested)"}</option>`).join("")}
        </select></div>
      </div>`).join("");
    el.innerHTML = `<div class="routes">
      <div class="section-head"><h2>Routes</h2></div>
      <p class="muted intro">A route is one entry in the Copilot model picker that tries several models in order. If a model is down, rate-limited or errors before answering, the next one takes over — e.g. a fast local model first, a cloud model as backup.</p>
      <div class="row new-route"><input type="text" id="newRouteName" placeholder="Route name, e.g. Coding (auto)" aria-label="New route name">
        <button class="btn primary" data-action="route-create">${icon("add")}Create route</button></div>
      <div class="cards single">${cards || `<div class="empty">${icon("git-merge")}No routes yet.</div>`}</div>
    </div>`;
  }

  // ----------------------------------------------------------- settings

  function renderSettings() {
    const el = $("#panel-settings");
    if (el.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") return;
    const s = S.settings;
    el.innerHTML = `<div class="settings">
      <div class="card"><h3>Verification</h3><div class="desc">Copilot only lists models that passed a health check. Results are cached so models aren't re-tested on every start.</div>
        <div class="setting"><div class="text"><div>Parallel checks</div><div>How many models are tested at once (1–25).</div></div>
          <input type="number" min="1" max="25" data-setting="testConcurrency" value="${esc(s.testConcurrency)}" aria-label="Parallel checks"></div>
        <div class="setting"><div class="text"><div>Parallel checks per remote provider</div><div>Keeps bulk checks under paid APIs' rate limits (1–25). Local servers use the overall limit.</div></div>
          <input type="number" min="1" max="25" data-setting="providerConcurrency" value="${esc(s.providerConcurrency)}" aria-label="Parallel checks per remote provider"></div>
        <div class="setting"><div class="text"><div>Keep results for (hours)</div><div>Selected models are re-checked automatically when their result expires.</div></div>
          <input type="number" min="1" max="720" data-setting="cacheTtlHours" value="${esc(s.cacheTtlHours)}" aria-label="Cache lifetime in hours"></div>
        <div class="setting"><div class="text"><div>Tool-calling check</div><div>“Full” also checks that the model calls a tool (2 requests per model). “Basic” only checks chat.</div></div>
          <select data-setting="toolCheck" aria-label="Tool-calling check">
            <option value="full" ${s.toolCheck !== "basic" ? "selected" : ""}>Full</option>
            <option value="basic" ${s.toolCheck === "basic" ? "selected" : ""}>Basic</option></select></div>
        <div class="setting"><div class="text"><div>Clear verification results</div><div>Forget every health-check result and start over.</div></div>
          <button class="btn danger" data-action="clear-cache">${icon("trash")}Clear</button></div>
      </div>
      <div class="card"><h3>Chat</h3>
        <div class="setting"><div class="text"><div>Show model reasoning</div><div>Render &lt;think&gt; / reasoning output as a quoted block above the answer.</div></div>
          <label class="switch"><input type="checkbox" data-setting="showReasoning" ${s.showReasoning ? "checked" : ""} aria-label="Show model reasoning"><span></span></label></div>
      </div>
      <div class="card"><h3>Usage & Budget</h3>
        <div class="setting"><div class="text"><div>Speed and spend statistics</div><div>Measured from your own chats and kept on this machine${S.spend > 0 ? ` — about ${money(S.spend)} so far` : ""}.</div></div>
          <button class="btn" data-action="reset-stats">${icon("discard")}Reset</button><button class="btn" data-action="export-stats">${icon("graph")}Export stats</button></div>
        <div class="setting"><div class="text"><div>Monthly budget warning ($)</div><div>Show a warning banner when estimated spend reaches this threshold (0 to disable).</div></div>
          <input type="number" min="0" step="1" data-setting="budgetLimitUsd" value="${esc(s.budgetLimitUsd || "")}" placeholder="0 (disabled)" aria-label="Budget limit in USD"></div>
      </div>
      <div class="card"><h3>Configuration</h3>
        <div class="setting"><div class="text"><div>Export / import</div><div>Providers, Copilot selection, routes and model overrides as JSON. API keys and secret headers are never exported.</div></div>
          <button class="btn" data-action="export">${icon("cloud-upload")}Export</button><button class="btn" data-action="import">${icon("cloud-download")}Import</button></div>
        <div class="setting"><div class="text"><div>Raw settings</div><div>Edit <code>customLlmRouter.*</code> in VS Code settings.</div></div>
          <button class="btn" data-action="open-settings">${icon("settings")}Open settings</button><button class="btn" data-action="logs">${icon("output")}Logs</button></div>
      </div>
    </div>`;
  }

  function openLimits(key) {
    ui.limitsFor = key;
    renderRows();
    if (key) (document.querySelector('#limitsRow [data-lim="contextWindow"]') as HTMLInputElement|null)?.focus();
  }

  let scrollQueued = false;
  $("#tableWrap").addEventListener("scroll", () => {
    if (scrollQueued || ui.rows.length <= VIRTUAL_THRESHOLD || ui.limitsFor) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      const wrap = $("#tableWrap");
      const first = Math.max(0, Math.floor(wrap.scrollTop / ROW_HEIGHT) - 10);
      // Only re-render once the user scrolled past the buffered rows.
      if (!ui.window || first < ui.window[0] || first + Math.ceil(wrap.clientHeight / ROW_HEIGHT) > ui.window[1] - 2 || first > ui.window[0] + 8) renderRows();
    });
  });

  // ------------------------------------------------------------- events

  function setSelected(keys, selected) {
    if (!keys.length) return;
    const set = new Set(keys);
    S.models.forEach((m) => set.has(m.key) && (m.selected = selected)); // optimistic
    renderHeader();
    renderModels();
    post({ type: "setSelected", keys, selected });
  }

  const actions = {
    tab: (el) => {
      ui.tab = el.dataset.tab;
      persist();
      renderHeader();
    },
    refresh: () => post({ type: "refresh" }),
    "verify-untested": () => post({ type: "verify" }),
    "cancel-verify": () => post({ type: "cancelVerify" }),
    status: (el) => {
      ui.status = el.dataset.status;
      persist();
      renderModels();
    },
    cap: (el) => {
      const id = el.dataset.cap;
      ui.caps.has(id) ? ui.caps.delete(id) : ui.caps.add(id);
      persist();
      renderModels();
    },
    "reset-filters": () => {
      Object.assign(ui, { q: "", provider: "", status: "all" });
      ui.caps.clear();
      (($("#q") as unknown) as HTMLInputElement).value = "";
      persist();
      renderModels();
    },
    sort: (el) => {
      const col = el.dataset.col;
      ui.sort = ui.sort.col === col ? (ui.sort.dir > 0 ? { col, dir: -1 } : { col: "smart", dir: 1 }) : { col, dir: 1 };
      persist();
      renderModels();
    },
    "toggle-model": (el) => setSelected([el.dataset.key], el.checked),
    "toggle-shown": (el) => {
      const rows = visibleModels();
      if (el.checked) setSelected(rows.filter((m) => !m.selected && m.status !== "failed").map((m) => m.key), true);
      else setSelected(rows.filter((m) => m.selected).map((m) => m.key), false);
    },
    "bulk-add": () => setSelected(visibleModels().filter((m) => !m.selected && m.status !== "failed").map((m) => m.key), true),
    "bulk-remove": () => setSelected(visibleModels().filter((m) => m.selected).map((m) => m.key), false),
    "bulk-test": () => post({ type: "verify", keys: visibleModels().map((m) => m.key), force: true }),
    "add-all-working": () => setSelected(S.models.filter((m) => m.status === "working" && !m.selected).map((m) => m.key), true),
    ping: (el) => post({ type: "verify", keys: [el.dataset.key], force: true }),
    "edit-limits": (el) => openLimits(ui.limitsFor === el.dataset.key ? null : el.dataset.key),
    "close-limits": () => openLimits(null),
    "reset-limits": (el) => {
      delete S.overrides[el.dataset.key];
      post({ type: "setOverride", key: el.dataset.key });
      openLimits(null);
    },
    "save-limits": (el) => {
      const key = el.dataset.key;
      const ov: Record<string, any> = {};
      document.querySelectorAll("#limitsRow [data-lim]").forEach((n) => {
        const input = (n as HTMLInputElement);
        const field = input.dataset.lim || "";
        const v = input.value.trim();
        if (!v || v === "auto") return;
        if (field === "toolCalling" || field === "vision") ov[field] = v === "on";
        else if (field === "name") ov.name = v;
        else if (field === "inputPerM" || field === "outputPerM") {
          if (Number(v) >= 0) ov[field] = Number(v);
        } else if (Number(v) > 0) ov[field] = Math.round(Number(v));
      });
      if (ov.maxOutputTokens && ov.contextWindow && ov.maxOutputTokens >= ov.contextWindow) {
        toast("Max output must be smaller than the context window", "err");
        return;
      }
      if (Object.keys(ov).length) S.overrides[key] = ov;
      else delete S.overrides[key];
      post({ type: "setOverride", key, override: Object.keys(ov).length ? ov : undefined });
      toast("Saved — Copilot picks up the new limits after the refresh");
      openLimits(null);
    },
    "pull-ollama": (el) => post({ type: "pullOllama", name: el.dataset.name }),
    "set-key": (el) => post({ type: "setApiKey", name: el.dataset.name }),
    "reset-stats": () => post({ type: "resetStats" }),

    "route-create": () => {
      const input = (document.getElementById("newRouteName") as HTMLInputElement);
      const name = input.value.trim();
      if (!name) return input.focus();
      if (S.routes.some((r) => r.name.toLowerCase() === name.toLowerCase())) return toast("A route with that name already exists", "err");
      input.value = "";
      saveRoutes([...routesDraft(), { name, models: [] }]);
    },
    "route-delete": (el) => saveRoutes(routesDraft().filter((r) => r.name !== el.dataset.route)),
    "route-remove": (el) =>
      saveRoutes(routesDraft().map((r) => (r.name === el.dataset.route ? { ...r, models: r.models.filter((_, i) => i !== Number(el.dataset.index)) } : r))),
    "route-move": (el) =>
      saveRoutes(
        routesDraft().map((r) => {
          if (r.name !== el.dataset.route) return r;
          const i = Number(el.dataset.index);
          const j = i + Number(el.dataset.dir);
          if (j < 0 || j >= r.models.length) return r;
          const models = [...r.models];
          [models[i], models[j]] = [models[j], models[i]];
          return { ...r, models };
        })
      ),

    "add-provider": () => openEditor(null),
    preset: (el) => applyPreset(el.dataset.preset),
    "edit-provider": (el) => openEditor(el.dataset.name),
    "close-editor": closeEditor,
    "toggle-provider": (el) => post({ type: "toggleProvider", name: el.dataset.name, enabled: el.checked }),
    "delete-provider": (el) => post({ type: "deleteProvider", name: el.dataset.name }),
    "verify-provider": (el) =>
      post({ type: "verify", keys: S.models.filter((m) => m.providerName === el.dataset.name).map((m) => m.key), force: true }),
    "test-provider": (el) => {
      const p = S.providers.find((x) => x.name === el.dataset.name);
      if (!p) return;
      ui.cardResults[p.name] = { ok: true, text: "Connecting…" };
      renderProviders();
      post({ type: "testConnection", reqId: `card:${p.name}`, provider: p, originalName: p.name });
    },
    "toggle-key": () => {
      const k = (document.getElementById("f-apiKey") as HTMLInputElement);
      if (k) k.type = k.type === "password" ? "text" : "password";
    },
    "test-draft": () => {
      const p = draftToProvider();
      if (!p) return;
      const r = $("#draftResult");
      r.className = "inline-result";
      r.innerHTML = `${icon("loading", "spin")} Connecting…`;
      post({ type: "testConnection", reqId: "draft", provider: p, originalName: ui.editor.original, apiKey: draftKey() });
    },
    "save-draft": () => {
      const p = draftToProvider();
      if (!p) return;
      ui.editor.saving = true;
      post({ type: "saveProvider", originalName: ui.editor.original, provider: p, apiKey: draftKey() });
    },

    "clear-cache": () => post({ type: "clearCache" }),
    export: () => post({ type: "exportConfig" }),
    "export-stats": () => post({ type: "exportStats" }),
    "scan-local": () => {
      const btn = document.querySelector('[data-action="scan-local"]');
      if (btn) btn.innerHTML = `${icon("sync", "spin")} Scanning…`;
      post({ type: "scanLocalServers" });
    },
    "route-policy": (el) => {
      const policy = (el as HTMLSelectElement).value as any;
      saveRoutes(routesDraft().map((r) => (r.name === el.dataset.route ? { ...r, policy } : r)));
    },
    import: () => post({ type: "importConfig" }),
    "open-settings": () => post({ type: "openSettings" }),
    logs: () => post({ type: "showLogs" }),
  };

  document.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement)?.closest?.("[data-action]") as HTMLElement | null;
    if (!el || (el as HTMLButtonElement).disabled || el.tagName === "INPUT" || el.tagName === "SELECT") return;
    actions[el.dataset.action]?.(el, ev);
  });

  document.addEventListener("change", (ev) => {
    const el = (ev.target as HTMLInputElement);
    if (el.dataset.action && (el.tagName === "INPUT" || el.tagName === "SELECT")) actions[el.dataset.action]?.(el, ev);
    else if (el.id === "provSel") {
      ui.provider = el.value;
      persist();
      renderModels();
    } else if (el.dataset.routeAdd !== undefined && el.value) {
      const key = el.value;
      saveRoutes(routesDraft().map((r) => (r.name === el.dataset.routeAdd ? { ...r, models: [...r.models, key] } : r)));
    } else if (el.dataset.setting) {
      let value: any = el.tagName === "SELECT" ? el.value : el.type === "checkbox" ? el.checked : Number(el.value);
      if (el.type === "number") {
        const min = el.min !== "" ? Number(el.min) : -Infinity;
        const max = el.max !== "" ? Number(el.max) : Infinity;
        if (!Number.isFinite(value) || value < min) value = Number.isFinite(min) && min !== -Infinity ? min : 0;
        if (value > max) value = max;
        el.value = String(value);
      }
      post({ type: "updateSetting", key: el.dataset.setting as keyof DashboardSettings, value });
    } else if (el.dataset.field && ui.editor && el.tagName === "SELECT") {
      ui.editor.draft[el.dataset.field] = el.value;
      updateUrlPreview();
    } else if (el.dataset.field && ui.editor && el.type === "checkbox") {
      ui.editor.draft[el.dataset.field] = el.checked;
      if (el.dataset.field === "clearKey") {
        const k = (document.getElementById("f-apiKey") as HTMLInputElement);
        if (k) k.disabled = el.checked;
      }
    }
  });

  document.addEventListener("input", (ev) => {
    const el = (ev.target as HTMLInputElement);
    if (el.id === "q") {
      ui.q = el.value;
      persist();
      renderModels();
    } else if (el.dataset.field && ui.editor && el.type !== "checkbox") {
      ui.editor.draft[el.dataset.field] = el.value;
      if (["endpointUrl", "chatEndpoint", "name"].includes(el.dataset.field)) updateUrlPreview();
      if (el.classList.contains("invalid")) {
        el.classList.remove("invalid");
        const err = document.getElementById(`err-${el.dataset.field}`);
        if (err) err.textContent = "";
      }
    }
  });

  document.addEventListener("keydown", (ev) => {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (ev.key === "/" && ui.tab === "models" && tag !== "INPUT" && tag !== "TEXTAREA") {
      ev.preventDefault();
      $("#q").focus();
    } else if (ev.key === "Escape" && ui.editor && tag !== "TEXTAREA") {
      closeEditor();
    } else if (ev.key === "Enter" && tag === "INPUT" && (ev.target as HTMLElement).closest("#limitsRow")) {
      (document.querySelector('#limitsRow [data-action="save-limits"]') as HTMLElement)?.click();
    } else if (ev.key === "Enter" && tag === "INPUT" && (ev.target as HTMLElement).id === "newRouteName") {
      actions["route-create"]();
    } else if (ev.key === "Escape" && ui.limitsFor) {
      openLimits(null);
    } else if (ev.key === "Enter" && ui.editor && tag === "INPUT" && (ev.target as HTMLInputElement).type !== "checkbox") {
      actions["save-draft"]();
    }
  });

  window.addEventListener("message", (ev: MessageEvent<HostMessage>) => {
    const msg = ev.data;
    if (msg.type === "state") {
      S = msg.state;
      hasState = true;
      render();
    } else if (msg.type === "focus") {
      if (msg.tab) ui.tab = msg.tab;
      persist();
      if (msg.addProvider) openEditor(null);
      else if (msg.editProvider) openEditor(msg.editProvider);
      else if (msg.editModel) {
        const m = S.models.find((x) => x.key === msg.editModel);
        Object.assign(ui, { q: m ? m.id : "", provider: m ? m.providerName : "", status: "all" });
        ui.caps.clear();
        (($("#q") as unknown) as HTMLInputElement).value = ui.q;
        renderHeader();
        renderModels();
        openLimits(msg.editModel);
      } else render();
    } else if (msg.type === "connectionResult") {
      const text = msg.ok ? `Connected in ${msg.latencyMs}ms · ${plural(msg.modelCount ?? 0, "model")} listed` : msg.error || "Connection failed";
      if (msg.reqId === "draft") {
        const r = document.getElementById("draftResult");
        if (r) {
          r.className = `inline-result ${msg.ok ? "ok" : "err"}`;
          r.innerHTML = `${icon(msg.ok ? "pass-filled" : "error")} ${esc(text)}`;
        }
      } else if (typeof msg.reqId === "string" && msg.reqId.startsWith("card:")) {
        ui.cardResults[msg.reqId.slice(5)] = { ok: msg.ok, text };
        if (!ui.editor) renderProviders();
      }
    } else if (msg.type === "saveResult") {
      if (!ui.editor) return;
      ui.editor.saving = false;
      if (msg.ok) {
        const isNew = !ui.editor.original;
        ui.editor = null;
        toast(isNew ? `Added ${msg.name} — discovering models…` : `Saved ${msg.name}`);
        renderProviders();
      } else {
        toast(msg.error || "Could not save provider", "err");
        const btn = document.querySelector('[data-action="save-draft"]');
        if (btn) (btn as HTMLButtonElement).disabled = false;
      }
    } else if (msg.type === "localScanResult") {
      const btn = document.querySelector('[data-action="scan-local"]');
      if (btn) btn.innerHTML = `${icon("search")}Scan local`;
      if (!msg.found.length) {
        toast("No local LLM servers detected on standard ports (11434, 1234, 8000, 8080)");
      } else {
        toast(`Found ${msg.found.length} local server(s): ${msg.found.map((f) => f.name).join(", ")}`);
        const unconfigured = msg.found.find((f) => !S.providers.some((p) => p.name.toLowerCase() === f.name.toLowerCase() || p.endpointUrl.includes(f.url)));
        if (unconfigured) {
          applyPreset(unconfigured.name.toLowerCase().replace(/[^a-z]/g, ""));
        }
      }
    }
  });

  renderHeader();
  renderModels();
  post({ type: "ready" });
})();
