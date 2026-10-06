const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ============================================================
// ENVIRONMENT LOADER (Zero-dependency .env reader)
// ============================================================
function loadEnv() {
  const envPath = path.resolve(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

// ============================================================
// CONFIGURATION
// ============================================================
const OUTPUT_FILE = path.resolve(__dirname, "chatLanguageModels.json");
const BACKUP_DIR = path.resolve(__dirname, "backups");
const REPORT_FILE = path.resolve(__dirname, "model-test-report.json");
const VERIFIED_CACHE_FILE = path.resolve(__dirname, "verified-models-cache.json");

// FreeLLMAPI Config
const FREELLMAPI_URL = process.env.FREELLMAPI_URL || "http://127.0.0.1:31415";
const FREELLMAPI_KEY = process.env.FREELLMAPI_KEY || "";
const FREELLMAPI_SECRET = process.env.FREELLMAPI_VSCODE_SECRET || "${input:chat.lm.secret.50cd2a8f}";

// OmniRoute Config
const OMNIROUTE_URL = process.env.OMNIROUTE_URL || "http://localhost:20128";
const OMNIROUTE_KEY = process.env.OMNIROUTE_KEY || process.env.OMNIROUTE_API_KEY || "";
const OMNIROUTE_SECRET = process.env.OMNIROUTE_VSCODE_SECRET || "${input:chat.lm.secret.5048ce49}";

// Test settings
const TEST_TIMEOUT_MS = 15000;
const CONCURRENCY = 5;
const MAX_RETRIES = 1;
const CACHE_TTL_HOURS = 48; // Auto-evict cache older than 48 hours

// Profile filters
const TOP_MODEL_KEYWORDS = [
  "claude-3-7",
  "claude-3.7",
  "claude-3-5",
  "claude-3.5",
  "gpt-4o",
  "deepseek-r1",
  "deepseek-v3",
  "qwen-2.5-coder",
  "qwen2.5-coder",
  "gemini-2.5",
  "gemini-2.0",
  "auto/best-coding",
  "auto/pro-coding",
  "auto/best-fast",
  "auto/best-reasoning",
  "auto/pro-reasoning",
  "auto/best-vision",
  "auto/pro-vision",
  "auto/best-chat",
  "auto/best-free",
];

const CODING_MODEL_KEYWORDS = [
  "coder",
  "coding",
  "code",
  "dev",
  "claude",
  "gpt-4",
  "deepseek",
  "qwen",
];

// ============================================================
// HELPERS
// ============================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getModelId(model) {
  return model?.id || model?.model;
}

// ------------------------------------------------------------
// FEATURE 1: MODEL DISPLAY NAME PRETTIFICATION
// ------------------------------------------------------------
function prettifyModelName(id, rawName) {
  if (id === "auto") return "FreeLLMAPI Auto";
  if (id === "fusion") return "FreeLLMAPI Fusion";

  // Clean OmniRoute prefixes like 'auto/', 'ddgw/', 'agy/', 'no-think/', 'cfp/'
  let clean = id;
  const parts = clean.split("/");
  const prefix = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  const base = parts[parts.length - 1];

  // Specific canonical formats
  if (clean.startsWith("auto/best-")) {
    const feature = clean.replace("auto/best-", "");
    return `OmniRoute Best ${feature.charAt(0).toUpperCase() + feature.slice(1)}`;
  }
  if (clean.startsWith("auto/pro-")) {
    const feature = clean.replace("auto/pro-", "");
    return `OmniRoute Pro ${feature.charAt(0).toUpperCase() + feature.slice(1)}`;
  }

  // Prettify common family names
  let name = base
    .replace(/^meta-llama-|^llama-/, "Llama ")
    .replace(/^deepseek-ai-|^deepseek-/, "DeepSeek ")
    .replace(/^qwen-|^qwen/, "Qwen ")
    .replace(/^claude-/, "Claude ")
    .replace(/^gpt-/, "GPT-")
    .replace(/^gemini-/, "Gemini ")
    .replace(/^mistral-/, "Mistral ")
    .replace(/^nemotron-/, "Nemotron ")
    .replace(/-instruct|-it/i, " Instruct")
    .replace(/-/g, " ")
    .trim();

  // Capitalize word beginnings
  name = name.replace(/\b\w/g, (c) => c.toUpperCase());

  // Tag special routing conditions
  if (prefix.includes("no-think")) {
    name += " (Fast/Direct)";
  } else if (prefix && !prefix.startsWith("auto")) {
    name += ` (${prefix})`;
  }

  return name;
}

function getNumber(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

function getBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const v = value.toLowerCase();
      if (v === "true" || v === "yes" || v === "supported") return true;
      if (v === "false" || v === "no" || v === "unsupported") return false;
    }
  }
  return undefined;
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function backupExistingConfig() {
  if (fs.existsSync(OUTPUT_FILE)) {
    ensureBackupDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(BACKUP_DIR, `chatLanguageModels-${stamp}.json`);
    fs.copyFileSync(OUTPUT_FILE, target);
    console.log(`Backed up existing configuration to: ${target}`);
  }
}

// ------------------------------------------------------------
// FEATURE 2: CACHE MANAGEMENT & AUTO-PRUNING
// ------------------------------------------------------------
function loadVerifiedCache(forceRefresh = false) {
  if (forceRefresh || !fs.existsSync(VERIFIED_CACHE_FILE)) {
    return { omniroute: [], updatedAt: 0 };
  }

  try {
    const data = JSON.parse(fs.readFileSync(VERIFIED_CACHE_FILE, "utf8"));
    const updatedAt = data.updatedAt || 0;
    const hoursOld = (Date.now() - updatedAt) / (1000 * 60 * 60);

    if (hoursOld > CACHE_TTL_HOURS) {
      console.log(`Cache is ${hoursOld.toFixed(1)} hours old (exceeds ${CACHE_TTL_HOURS}h TTL). Pruning cache.`);
      return { omniroute: [], updatedAt: 0 };
    }

    return data;
  } catch {
    return { omniroute: [], updatedAt: 0 };
  }
}

function saveVerifiedCache(cache) {
  cache.updatedAt = Date.now();
  fs.writeFileSync(VERIFIED_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

// ============================================================
// TEST CHAT COMPLETIONS FOR A SINGLE MODEL
// ============================================================
async function testModelChat(chatUrl, apiKey, modelId) {
  let lastResult = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    const start = Date.now();

    try {
      const response = await fetch(chatUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
          max_tokens: 5,
          temperature: 0,
        }),
        signal: controller.signal,
      });

      const elapsed = Date.now() - start;
      const text = await response.text();

      if (response.ok) {
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          lastResult = { model: modelId, working: false, status: response.status, latency: elapsed, error: "Invalid JSON" };
          continue;
        }

        if (!Array.isArray(data?.choices) || !data.choices[0]) {
          lastResult = { model: modelId, working: false, status: response.status, latency: elapsed, error: "No choices returned" };
          continue;
        }

        return {
          model: modelId,
          working: true,
          status: response.status,
          latency: elapsed,
          response: data.choices[0]?.message?.content || "",
        };
      }

      lastResult = {
        model: modelId,
        working: false,
        status: response.status,
        latency: elapsed,
        error: text.substring(0, 300),
      };

      if (response.status >= 400 && response.status < 500) {
        return lastResult;
      }
    } catch (err) {
      lastResult = {
        model: modelId,
        working: false,
        status: 0,
        latency: Date.now() - start,
        error: err.name === "AbortError" ? "Timeout" : err.message,
      };
    } finally {
      clearTimeout(timer);
    }

    if (attempt < MAX_RETRIES) {
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  return lastResult;
}

// ============================================================
// VERIFY TOOL-CALLING CAPABILITY (PREVENTS VS CODE COPILOT CRASHES)
// ============================================================
async function verifyToolCallingSupport(chatUrl, apiKey, modelId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(chatUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "What is 2+2?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "calculator",
              description: "Calculate mathematical expression",
              parameters: {
                type: "object",
                properties: { expr: { type: "string" } },
                required: ["expr"],
              },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 15,
      }),
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// CONCURRENT TEST RUNNER
// ============================================================
async function testModelsPool(chatUrl, apiKey, models, tag, verifyTools = false) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= models.length) return;
      const model = models[index];
      const id = getModelId(model);
      if (!id) continue;

      process.stdout.write(`  [${tag}] [${index + 1}/${models.length}] ${id} ... `);
      const res = await testModelChat(chatUrl, apiKey, id);

      if (res.working && verifyTools) {
        process.stdout.write(`[tools] `);
        const toolsOk = await verifyToolCallingSupport(chatUrl, apiKey, id);
        res.verifiedToolCalling = toolsOk;
      }

      results.push(res);

      if (res.working) {
        const toolTag = res.verifiedToolCalling !== undefined ? ` [tools:${res.verifiedToolCalling ? 'yes' : 'no'}]` : "";
        console.log(`✅ (${res.latency}ms)${toolTag}`);
      } else {
        console.log(`❌ ${res.status || ""} ${res.error?.slice(0, 50) || ""}`);
      }
    }
  }

  const workers = [];
  const workerCount = Math.min(CONCURRENCY, models.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

// ============================================================
// FEATURE 3: SMART CONTEXT WINDOW & TOKEN BOUNDS NORMALIZATION
// ============================================================
function normalizeTokenBounds(modelId, rawContext, rawMaxOutput, rawMaxInput) {
  const idLower = modelId.toLowerCase();

  let contextWindow = rawContext;
  let maxOutputTokens = rawMaxOutput;
  let maxInputTokens = rawMaxInput;

  // Infer well-known architecture parameters if missing or zero
  if (!contextWindow) {
    if (idLower.includes("claude-3-7") || idLower.includes("claude-3-5")) {
      contextWindow = 200000;
      maxOutputTokens = maxOutputTokens || 64000;
    } else if (idLower.includes("claude-3")) {
      contextWindow = 200000;
      maxOutputTokens = maxOutputTokens || 8192;
    } else if (idLower.includes("deepseek-r1") || idLower.includes("deepseek-v3")) {
      contextWindow = 131072;
      maxOutputTokens = maxOutputTokens || 16384;
    } else if (idLower.includes("qwen2.5") || idLower.includes("qwen-2.5")) {
      contextWindow = 131072;
      maxOutputTokens = maxOutputTokens || 16384;
    } else if (idLower.includes("gpt-4o") || idLower.includes("gpt-4-turbo")) {
      contextWindow = 128000;
      maxOutputTokens = maxOutputTokens || 16384;
    } else if (idLower.includes("gemini-2")) {
      contextWindow = 1048576;
      maxOutputTokens = maxOutputTokens || 65536;
    } else if (idLower.includes("nemotron-3-super") || idLower.includes("nemotron-3-ultra")) {
      contextWindow = 1048576;
      maxOutputTokens = maxOutputTokens || 16384;
    } else {
      contextWindow = 131072;
      maxOutputTokens = maxOutputTokens || 16000;
    }
  }

  if (!maxOutputTokens) maxOutputTokens = 16000;

  if (!maxInputTokens) {
    maxInputTokens = Math.max(1000, contextWindow - maxOutputTokens);
  }

  return { contextWindow, maxOutputTokens, maxInputTokens };
}

// ============================================================
// MODEL CAPABILITIES & VS CODE MODEL BUILDER
// ============================================================
function detectCapabilities(model, isOmniRoute = false, verifiedToolCalling) {
  if (verifiedToolCalling !== undefined) {
    return {
      toolCalling: verifiedToolCalling,
      vision: getBoolean(model?.vision, model?.supports_vision, model?.capabilities?.vision) ?? false,
      thinking: getBoolean(model?.thinking, model?.reasoning, model?.supports_reasoning),
    };
  }

  const capabilities = model?.capabilities || {};
  const metadata = model?.metadata || {};
  const features = model?.features || {};

  const toolCalling = getBoolean(
    model.toolCalling,
    model.tool_calling,
    model.supports_tool_calling,
    capabilities.toolCalling,
    capabilities.tool_calling,
    capabilities.tools,
    metadata.toolCalling,
    metadata.tool_calling,
    metadata.tools
  );

  const vision = getBoolean(
    model.vision,
    model.supports_vision,
    capabilities.vision,
    capabilities.image_input,
    capabilities.images,
    metadata.vision,
    metadata.image_input,
    metadata.images,
    features.vision,
    features.image_input
  );

  const thinking = getBoolean(
    model.thinking,
    model.reasoning,
    model.supports_reasoning,
    capabilities.thinking,
    capabilities.reasoning,
    metadata.thinking,
    metadata.reasoning
  );

  return {
    toolCalling: toolCalling ?? (isOmniRoute ? true : false),
    vision: vision ?? false,
    thinking,
  };
}

function buildVSCodeModel(model, chatUrl, isOmniRoute = false, verifiedToolCalling, latency = 0) {
  const id = getModelId(model);
  if (!id) return null;

  const caps = detectCapabilities(model, isOmniRoute, verifiedToolCalling);

  const rawContext = getNumber(
    model.contextWindow,
    model.context_window,
    model.contextLength,
    model.context_length,
    model.max_context_tokens,
    model.maxContextTokens
  );

  const rawMaxOutput = getNumber(
    model.maxOutputTokens,
    model.max_output_tokens,
    model.max_completion_tokens,
    model.output_token_limit
  );

  const rawMaxInput = getNumber(
    model.maxInputTokens,
    model.max_input_tokens,
    model.input_token_limit
  );

  const bounds = normalizeTokenBounds(id, rawContext, rawMaxOutput, rawMaxInput);

  const result = {
    id,
    name: prettifyModelName(id, model?.name),
    url: chatUrl,
    toolCalling: caps.toolCalling,
    vision: caps.vision,
    maxInputTokens: bounds.maxInputTokens,
    maxOutputTokens: bounds.maxOutputTokens,
  };

  if (bounds.contextWindow) {
    result.contextWindow = bounds.contextWindow;
  }

  if (caps.thinking !== undefined) {
    result.thinking = caps.thinking;
  }

  result._latency = latency;
  return result;
}

// ============================================================
// PROVIDER FETCHERS
// ============================================================
async function fetchFreeLLMAPIModels() {
  const modelsUrl = `${FREELLMAPI_URL}/v1/models?execution_status=ready`;
  console.log(`\nFetching FreeLLMAPI models from: ${modelsUrl}`);
  try {
    const res = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${FREELLMAPI_KEY}`, Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`FreeLLMAPI returned HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.data) ? data.data : [];
  } catch (err) {
    console.warn(`Could not connect to FreeLLMAPI (${FREELLMAPI_URL}): ${err.message}`);
    return [];
  }
}

async function fetchOmniRouteModels() {
  const modelsUrl = `${OMNIROUTE_URL}/v1/models`;
  console.log(`\nFetching OmniRoute models from: ${modelsUrl}`);
  try {
    const res = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${OMNIROUTE_KEY}`, Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`OmniRoute returned HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.data) ? data.data : [];
  } catch (err) {
    console.warn(`Could not connect to OmniRoute (${OMNIROUTE_URL}): ${err.message}`);
    return [];
  }
}

// ============================================================
// PROFILE FILTERING
// ============================================================
function applyProfileFilter(models, profile) {
  if (!profile || profile === "all") return models;

  if (profile === "top") {
    return models.filter((m) => {
      if (m.id === "auto" || m.id.startsWith("auto/best-") || m.id.startsWith("auto/pro-")) return true;
      const idLower = m.id.toLowerCase();
      return TOP_MODEL_KEYWORDS.some((kw) => idLower.includes(kw));
    });
  }

  if (profile === "coding") {
    return models.filter((m) => {
      if (m.id === "auto" || m.id.includes("coding")) return true;
      const idLower = m.id.toLowerCase();
      return CODING_MODEL_KEYWORDS.some((kw) => idLower.includes(kw));
    });
  }

  return models;
}

// ============================================================
// DIRECT VS CODE CHAT LANGUAGE MODELS DEPLOYMENT (--apply)
// ============================================================
function getTargetVSCodePaths() {
  const appData = process.env.APPDATA;
  if (!appData) return [];

  const targets = [];
  const candidates = [
    { name: "VS Code Insiders", dir: path.join(appData, "Code - Insiders", "User") },
    { name: "VS Code Stable", dir: path.join(appData, "Code", "User") },
  ];

  for (const c of candidates) {
    if (fs.existsSync(c.dir)) {
      targets.push({
        name: c.name,
        dir: c.dir,
        chatModelsJson: path.join(c.dir, "chatLanguageModels.json"),
      });
    }
  }

  return targets;
}

function applyToVSCodeSettings(providersConfig) {
  const targets = getTargetVSCodePaths();

  if (targets.length === 0) {
    console.warn("Could not find any VS Code User directory (neither Code nor Code - Insiders).");
    return;
  }

  console.log(`\n============================================================`);
  console.log(` Deploying directly to VS Code User Environment`);
  console.log(` (Writing chatLanguageModels.json only)`);
  console.log(`============================================================`);

  const formattedModelsJson = JSON.stringify(providersConfig, null, 4);

  for (const target of targets) {
    console.log(`\n[+] Target: ${target.name} (${target.dir})`);

    try {
      if (fs.existsSync(target.chatModelsJson)) {
        const backupFile = path.join(
          BACKUP_DIR,
          `${target.name.replace(/\s+/g, "-").toLowerCase()}-chatLM-${Date.now()}.json`
        );
        ensureBackupDir();
        fs.copyFileSync(target.chatModelsJson, backupFile);
      }

      fs.writeFileSync(target.chatModelsJson, formattedModelsJson + "\n", "utf8");
      console.log(`  ✅ Successfully updated: ${target.chatModelsJson}`);
    } catch (err) {
      console.warn(`  ⚠️ Could not write ${target.chatModelsJson}: ${err.message}`);
    }
  }
}

// ============================================================
// FEATURE 4: INTERACTIVE MODEL PICKER (npm run select)
// ============================================================
async function runInteractiveSelection(availableModels) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n============================================================");
  console.log(" 🎯 Interactive Model Selector");
  console.log("============================================================");
  console.log("Available models:");
  availableModels.forEach((m, idx) => {
    console.log(`  [${idx + 1}] ${m.name} (${m.id})`);
  });

  return new Promise((resolve) => {
    rl.question(
      "\nEnter numbers to select (e.g. 1, 3, 5-8) or press ENTER for all: ",
      (answer) => {
        rl.close();
        const trimmed = answer.trim();
        if (!trimmed) {
          resolve(availableModels);
          return;
        }

        const selectedIndices = new Set();
        const tokens = trimmed.split(/[\s,]+/);

        for (const token of tokens) {
          if (token.includes("-")) {
            const [start, end] = token.split("-").map(Number);
            if (!isNaN(start) && !isNaN(end)) {
              for (let i = start; i <= end; i++) {
                if (i >= 1 && i <= availableModels.length) selectedIndices.add(i - 1);
              }
            }
          } else {
            const n = Number(token);
            if (!isNaN(n) && n >= 1 && n <= availableModels.length) {
              selectedIndices.add(n - 1);
            }
          }
        }

        if (selectedIndices.size === 0) {
          console.log("No valid selections made. Keeping all models.");
          resolve(availableModels);
          return;
        }

        const filtered = availableModels.filter((_, idx) => selectedIndices.has(idx));
        console.log(`\nSelected ${filtered.length} models.`);
        resolve(filtered);
      }
    );
  });
}

// ============================================================
// MAIN GENERATOR
// ============================================================
async function runGenerator(options = {}) {
  const { skipTest, profile = "all", verifyTools = false, apply = false, interactive = false, forceRefresh = false } = options;

  console.log("============================================================");
  console.log(" VS Code Custom Endpoint Models Generator (FreeLLMAPI + OmniRoute)");
  console.log("============================================================");
  console.log(`Mode         : ${skipTest ? "FAST" : "FULL PROBE"}`);
  console.log(`Profile      : ${profile.toUpperCase()}`);
  console.log(`Verify Tools : ${verifyTools ? "YES" : "NO"}`);
  console.log(`Auto-Apply   : ${apply ? "YES" : "NO"}`);
  console.log(`Interactive  : ${interactive ? "YES" : "NO"}`);

  const verifiedCache = loadVerifiedCache(forceRefresh);

  const reports = {};
  const providersConfig = [];

  // ------------------------------------------------------------
  // 1. FREELLMAPI
  // ------------------------------------------------------------
  const freeLLMModels = await fetchFreeLLMAPIModels();
  const freeChatUrl = `${FREELLMAPI_URL}/v1/chat/completions`;

  if (freeLLMModels.length > 0) {
    console.log(`Found ${freeLLMModels.length} models from FreeLLMAPI`);
    let workingFreeModels = freeLLMModels;
    const latencyMap = new Map();
    const toolMap = new Map();

    if (!skipTest) {
      console.log(`Testing FreeLLMAPI models...`);
      const testResults = await testModelsPool(freeChatUrl, FREELLMAPI_KEY, freeLLMModels, "FreeLLM", verifyTools);
      reports.freellmapi = testResults;
      const workingIds = new Set(testResults.filter((r) => r.working).map((r) => r.model));
      workingFreeModels = freeLLMModels.filter((m) => workingIds.has(getModelId(m)));
      for (const r of testResults) {
        if (r.working) {
          latencyMap.set(r.model, r.latency);
          if (r.verifiedToolCalling !== undefined) toolMap.set(r.model, r.verifiedToolCalling);
        }
      }
      console.log(`FreeLLMAPI Working: ${workingFreeModels.length}/${freeLLMModels.length}`);
    }

    const freeVSCodeModels = [];
    freeVSCodeModels.push({
      id: "auto",
      name: "FreeLLMAPI Auto",
      url: freeChatUrl,
      toolCalling: true,
      vision: true,
      maxInputTokens: 128000,
      maxOutputTokens: 16000,
      _latency: 0,
    });

    for (const model of workingFreeModels) {
      const id = getModelId(model);
      const v = buildVSCodeModel(model, freeChatUrl, false, toolMap.get(id), latencyMap.get(id) || 0);
      if (v && v.id !== "auto") freeVSCodeModels.push(v);
    }

    let filteredFree = applyProfileFilter(freeVSCodeModels, profile);

    if (interactive && filteredFree.length > 0) {
      filteredFree = await runInteractiveSelection(filteredFree);
    }

    const uniqueFree = Array.from(new Map(filteredFree.map((m) => [m.id, m])).values());

    uniqueFree.sort((a, b) => {
      if (a.id === "auto") return -1;
      if (b.id === "auto") return 1;
      if (a._latency && b._latency && a._latency !== b._latency) return a._latency - b._latency;
      return a.name.localeCompare(b.name);
    });

    for (const m of uniqueFree) delete m._latency;

    providersConfig.push({
      name: "FreeLLMAPI",
      vendor: "customendpoint",
      apiKey: FREELLMAPI_SECRET,
      apiType: "chat-completions",
      models: uniqueFree,
    });
  }

  // ------------------------------------------------------------
  // 2. OMNIROUTE
  // ------------------------------------------------------------
  const omniModels = await fetchOmniRouteModels();
  const omniChatUrl = `${OMNIROUTE_URL}/v1/chat/completions`;

  if (omniModels.length > 0) {
    console.log(`Found ${omniModels.length} models from OmniRoute`);
    let workingOmniModels = omniModels;
    const latencyMap = new Map();
    const toolMap = new Map();

    if (!skipTest) {
      console.log(`Testing OmniRoute models...`);
      const testResults = await testModelsPool(omniChatUrl, OMNIROUTE_KEY, omniModels, "OmniRoute", verifyTools);
      reports.omniroute = testResults;
      const workingIds = new Set(testResults.filter((r) => r.working).map((r) => r.model));
      workingOmniModels = omniModels.filter((m) => workingIds.has(getModelId(m)));
      for (const r of testResults) {
        if (r.working) {
          latencyMap.set(r.model, r.latency);
          if (r.verifiedToolCalling !== undefined) toolMap.set(r.model, r.verifiedToolCalling);
        }
      }
      console.log(`OmniRoute Working: ${workingOmniModels.length}/${omniModels.length}`);

      verifiedCache.omniroute = Array.from(workingIds);
      saveVerifiedCache(verifiedCache);
    } else {
      const verifiedList = verifiedCache.omniroute || [];
      if (verifiedList.length > 0) {
        const set = new Set(verifiedList);
        workingOmniModels = omniModels.filter((m) => set.has(getModelId(m)));
        console.log(`Using ${workingOmniModels.length} cached working models`);
      }
    }

    const omniVSCodeModels = [];
    for (const model of workingOmniModels) {
      const id = getModelId(model);
      const v = buildVSCodeModel(model, omniChatUrl, true, toolMap.get(id), latencyMap.get(id) || 0);
      if (v) omniVSCodeModels.push(v);
    }

    let filteredOmni = applyProfileFilter(omniVSCodeModels, profile);

    if (interactive && filteredOmni.length > 0) {
      filteredOmni = await runInteractiveSelection(filteredOmni);
    }

    const uniqueOmni = Array.from(new Map(filteredOmni.map((m) => [m.id, m])).values());

    uniqueOmni.sort((a, b) => {
      if (a._latency && b._latency && a._latency !== b._latency) return a._latency - b._latency;
      return a.name.localeCompare(b.name);
    });

    for (const m of uniqueOmni) delete m._latency;

    providersConfig.push({
      name: "OmniRoute",
      vendor: "customendpoint",
      apiKey: OMNIROUTE_SECRET,
      apiType: "chat-completions",
      models: uniqueOmni,
    });
  }

  // ------------------------------------------------------------
  // SAVE OUTPUTS
  // ------------------------------------------------------------
  if (providersConfig.length === 0) {
    console.error("❌ No provider models could be retrieved.");
    process.exit(1);
  }

  backupExistingConfig();

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(providersConfig, null, 4) + "\n", "utf8");
  if (Object.keys(reports).length > 0) {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(reports, null, 4) + "\n", "utf8");
  }

  const totalModels = providersConfig.reduce((acc, p) => acc + (p.models?.length || 0), 0);

  console.log("\n============================================================");
  console.log(" ✅ COMPLETED");
  console.log("============================================================");
  console.log(`Providers configured : ${providersConfig.length}`);
  for (const p of providersConfig) {
    console.log(`  - ${p.name}: ${p.models.length} models`);
  }
  console.log(`Total active models  : ${totalModels}`);
  console.log(`Output written to    : ${OUTPUT_FILE}`);

  if (apply) {
    applyToVSCodeSettings(providersConfig);
  }
}

// ============================================================
// PRE-FLIGHT STATUS CHECK (npm run status)
// ============================================================
async function checkStatus() {
  console.log("============================================================");
  console.log(" 🩺 Local LLM Endpoints Status Check");
  console.log("============================================================\n");

  // 1. FreeLLMAPI
  process.stdout.write(`• FreeLLMAPI (${FREELLMAPI_URL}) ... `);
  try {
    const res = await fetch(`${FREELLMAPI_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${FREELLMAPI_KEY}`, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      const count = Array.isArray(data.data) ? data.data.length : 0;
      console.log(`✅ ONLINE (${count} models available)`);
    } else {
      console.log(`⚠️ HTTP ${res.status} (Check API key or server status)`);
    }
  } catch (err) {
    console.log(`❌ OFFLINE (${err.message})`);
  }

  // 2. OmniRoute
  process.stdout.write(`• OmniRoute  (${OMNIROUTE_URL}) ... `);
  try {
    const res = await fetch(`${OMNIROUTE_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${OMNIROUTE_KEY}`, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      const count = Array.isArray(data.data) ? data.data.length : 0;
      console.log(`✅ ONLINE (${count} models available)`);
    } else {
      console.log(`⚠️ HTTP ${res.status} (Check API key or server status)`);
    }
  } catch (err) {
    console.log(`❌ OFFLINE (${err.message})`);
  }

  console.log("\nTarget VS Code Directories:");
  const targets = getTargetVSCodePaths();
  if (targets.length === 0) {
    console.log("  ⚠️ No VS Code user directories detected.");
  } else {
    for (const t of targets) {
      const exists = fs.existsSync(t.chatModelsJson);
      console.log(`  • ${t.name}: ${exists ? "✅ Config exists" : "⚪ Config not yet deployed"} (${t.chatModelsJson})`);
    }
  }
}

// ============================================================
// CLI PARSER & WATCH MODE
// ============================================================
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--status") || args.includes("status")) {
    await checkStatus();
    return;
  }

  const skipTest = args.includes("--fast") || args.includes("--skip-test");
  const verifyTools = args.includes("--verify-tools") || args.includes("--tools");
  const apply = args.includes("--apply") || args.includes("--install");
  const interactive = args.includes("--select") || args.includes("-i");
  const forceRefresh = args.includes("--refresh-cache");

  let profile = "all";
  const profileIdx = args.findIndex((a) => a === "--profile");
  if (profileIdx !== -1 && args[profileIdx + 1]) {
    profile = args[profileIdx + 1].toLowerCase();
  } else if (args.includes("--coding")) {
    profile = "coding";
  } else if (args.includes("--top")) {
    profile = "top";
  }

  const watchIdx = args.findIndex((a) => a === "--watch");
  if (watchIdx !== -1) {
    let intervalMinutes = 30;
    const rawVal = args[watchIdx + 1];
    if (rawVal && !rawVal.startsWith("--")) {
      const parsed = parseInt(rawVal, 10);
      if (!isNaN(parsed) && parsed > 0) intervalMinutes = parsed;
    }

    console.log(`🔁 Watch mode activated. Refresh interval: every ${intervalMinutes} minutes.`);
    await runGenerator({ skipTest, profile, verifyTools, apply, interactive: false, forceRefresh });

    setInterval(async () => {
      console.log(`\n⏰ [${new Date().toLocaleTimeString()}] Scheduled refresh triggering...`);
      try {
        await runGenerator({ skipTest, profile, verifyTools, apply, interactive: false, forceRefresh });
      } catch (err) {
        console.error("Scheduled refresh error:", err.message);
      }
    }, intervalMinutes * 60 * 1000);
  } else {
    await runGenerator({ skipTest, profile, verifyTools, apply, interactive, forceRefresh });
  }
}

main().catch((err) => {
  console.error("\n❌ ERROR:", err.message);
  process.exit(1);
});
