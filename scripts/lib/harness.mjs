import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { modelsUrlFor, OLLAMA_DEFAULT_CONTEXT_WINDOW } from "./backend.mjs";
import { runCommand } from "./process.mjs";

// =============================================================================
// All provider / CLI mechanics live here, in deterministic Node. Nothing in an
// agent or command prompt file should ever hand-roll a pi or codex CLI string.
//
// Backend-specific values (base URL, env key, provider/profile names, model id)
// are NOT hardcoded here — they arrive via the backend descriptor resolved in
// backend.mjs. Functions take the backend (or a baseUrl/apiKey pair) so a new
// flavor needs no changes in this file.
// =============================================================================

const PI_MODELS_PATH = path.join(os.homedir(), ".pi", "agent", "models.json");
const CODEX_CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");

// -----------------------------------------------------------------------------
// Auth helpers
// -----------------------------------------------------------------------------

// The backend descriptor already carries the resolved apiKey (read from the
// backend's settings or config). Header-building is centralized so every probe
// authenticates identically. A null key means "no auth" (e.g. local ollama).
function authHeaders(backend) {
  const key = backend?.apiKey;
  return typeof key === "string" && key ? { Authorization: `Bearer ${key}` } : {};
}

// -----------------------------------------------------------------------------
// Server health
// -----------------------------------------------------------------------------

// Probe the backend's /v1/models endpoint. Any HTTP response (even 401) proves
// the server is reachable; only a connection failure means it is down.
export async function checkOmlxHealth(backend, timeoutMs = 4000) {
  const headers = authHeaders(backend);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(modelsUrlFor(backend.baseUrl), {
      method: "GET",
      headers,
      signal: controller.signal
    });
    return {
      reachable: true,
      ok: response.status === 200,
      status: response.status,
      hasApiKey: Boolean(backend?.apiKey),
      detail: response.status === 200 ? "ok" : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      status: null,
      hasApiKey: Boolean(backend?.apiKey),
      detail:
        error?.name === "AbortError"
          ? `timed out after ${timeoutMs}ms`
          : String(error?.message ?? error)
    };
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Dynamic model resolution from the server
// -----------------------------------------------------------------------------

async function fetchBackendJson(url, backend, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: authHeaders(backend), signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The model selected in the backend surfaces as the server's loaded/active model.
// Resolve at call time so delegation always follows the user's selection instead
// of a hardcoded id. The resolution endpoint and response shape are flavor-
// specific, so this dispatches on backend.flavor. Returns null when nothing can
// be resolved; the runner's last-resort/refusal path handles null.
//
// (Name kept as fetchOmlxActiveModel for call-site stability across runner/setup;
// it is now backend-flavor-aware, not omlx-only.)
export async function fetchOmlxActiveModel(backend, timeoutMs = 4000) {
  if (backend?.flavor === "ollama") {
    return fetchOllamaActiveModel(backend, timeoutMs);
  }
  if (backend?.flavor === "openai") {
    return fetchOpenAiActiveModel(backend, timeoutMs);
  }
  return fetchOmlxStatusActiveModel(backend, timeoutMs);
}

// Generic OpenAI-compatible active-model ladder (spec): config defaultModel →
// /v1/models single entry → null. There is no flavor-specific "loaded model"
// status endpoint, so the user's config defaultModel is the primary signal; a
// single served model is an unambiguous fallback. null defers to the runner's
// existing refusal/last-resort path.
async function fetchOpenAiActiveModel(backend, timeoutMs) {
  if (typeof backend?.defaultModel === "string" && backend.defaultModel) {
    return backend.defaultModel;
  }
  const models = await fetchOmlxModels(backend, timeoutMs);
  if (models.length === 1) {
    return models[0].id;
  }
  return null;
}

// oMLX active model: GET /api/status → loaded_models (the GUI selection; use when
// exactly one) else default_model. Unchanged from Phase 1.
async function fetchOmlxStatusActiveModel(backend, timeoutMs) {
  if (!backend?.statusUrl) {
    return null;
  }
  const status = await fetchBackendJson(backend.statusUrl, backend, timeoutMs);
  if (!status) {
    return null;
  }
  const loaded = Array.isArray(status.loaded_models)
    ? status.loaded_models.filter((m) => typeof m === "string" && m)
    : [];
  if (loaded.length === 1) {
    return loaded[0];
  }
  if (typeof status.default_model === "string" && status.default_model) {
    return status.default_model;
  }
  return loaded[0] ?? null;
}

// Ollama active model ladder (spec): GET /api/ps → models[].name (loaded; use
// when exactly one) → config defaultModel → /v1/models single entry → null.
async function fetchOllamaActiveModel(backend, timeoutMs) {
  if (backend?.activeUrl) {
    const ps = await fetchBackendJson(backend.activeUrl, backend, timeoutMs);
    const loaded = Array.isArray(ps?.models)
      ? ps.models.map((m) => m?.name).filter((n) => typeof n === "string" && n)
      : [];
    if (loaded.length === 1) {
      return loaded[0];
    }
  }
  if (typeof backend?.defaultModel === "string" && backend.defaultModel) {
    return backend.defaultModel;
  }
  const models = await fetchOmlxModels(backend, timeoutMs);
  if (models.length === 1) {
    return models[0].id;
  }
  return null;
}

// Chat-capable models the server currently serves. Dispatches on flavor:
//   omlx   — GET /v1/models; utility models (e.g. the document converter) report
//            no context length (max_model_len == null) and are excluded.
//   ollama — GET /api/tags → models[].name (fallback /v1/models). The basic tags
//            shape carries no context-window info, so a sensible default is used.
export async function fetchOmlxModels(backend, timeoutMs = 4000) {
  if (backend?.flavor === "ollama") {
    return fetchOllamaModels(backend, timeoutMs);
  }
  if (backend?.flavor === "openai") {
    return fetchOpenAiModels(backend, timeoutMs);
  }
  const list = await fetchBackendJson(modelsUrlFor(backend.baseUrl), backend, timeoutMs);
  const data = Array.isArray(list?.data) ? list.data : [];
  return data
    .filter((m) => typeof m?.id === "string" && m.id && m.max_model_len != null)
    .map((m) => ({ id: m.id, contextWindow: m.max_model_len }));
}

// Generic OpenAI-compatible available models: GET /v1/models → data[].id. Unlike
// oMLX, a generic server's entries carry no max_model_len/context info, so every
// listed model is kept (no utility-model filter) and a sensible default context
// window is used (same default as ollama).
async function fetchOpenAiModels(backend, timeoutMs) {
  const list = await fetchBackendJson(modelsUrlFor(backend.baseUrl), backend, timeoutMs);
  const data = Array.isArray(list?.data) ? list.data : [];
  return data
    .filter((m) => typeof m?.id === "string" && m.id)
    .map((m) => ({
      id: m.id,
      contextWindow:
        typeof m.max_model_len === "number" && m.max_model_len > 0
          ? m.max_model_len
          : OLLAMA_DEFAULT_CONTEXT_WINDOW
    }));
}

async function fetchOllamaModels(backend, timeoutMs) {
  if (backend?.tagsUrl) {
    const tags = await fetchBackendJson(backend.tagsUrl, backend, timeoutMs);
    const names = Array.isArray(tags?.models)
      ? tags.models.map((m) => m?.name).filter((n) => typeof n === "string" && n)
      : [];
    if (names.length > 0) {
      return names.map((id) => ({ id, contextWindow: OLLAMA_DEFAULT_CONTEXT_WINDOW }));
    }
  }
  // Fallback: OpenAI-compatible /v1/models (entries are { id }, no context info).
  const list = await fetchBackendJson(modelsUrlFor(backend.baseUrl), backend, timeoutMs);
  const data = Array.isArray(list?.data) ? list.data : [];
  return data
    .filter((m) => typeof m?.id === "string" && m.id)
    .map((m) => ({ id: m.id, contextWindow: OLLAMA_DEFAULT_CONTEXT_WINDOW }));
}

// -----------------------------------------------------------------------------
// Pi provider configuration (read + provision)
// -----------------------------------------------------------------------------

// Build a single model entry for pi's provider in the shape pi expects. Reuses
// an existing entry's fields when the id is already known so manual tweaks are
// preserved across syncs.
function piModelEntry(serverModel, known) {
  return known
    ? { ...known, contextWindow: serverModel.contextWindow }
    : {
        id: serverModel.id,
        contextWindow: serverModel.contextWindow,
        maxTokens: 32768,
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      };
}

// Resolve the apiKey value to write into pi's provider entry. When the backend
// has an env key, reference it (`$NAME`) so the secret is injected from the child
// env, never inlined. When it does not (e.g. local ollama), pi still requires a
// non-empty apiKey, so preserve any existing value or fall back to a stub equal
// to the provider name (the conventional ollama stub is "ollama").
function piProviderApiKey(backend, existingApiKey) {
  if (backend.envKey) {
    return `$${backend.envKey}`;
  }
  if (typeof existingApiKey === "string" && existingApiKey) {
    return existingApiKey;
  }
  return backend.piProvider;
}

// Mirror the server's chat models into pi's provider entry so pi can resolve
// whichever model the user selects in the backend GUI. Rewrites only
// providers.<piProvider>.models; everything else in models.json is preserved.
// `piModelsPath` defaults to the real location but is overridable for tests.
export function syncPiOmlxModels(backend, serverModels, piModelsPath = PI_MODELS_PATH) {
  if (!Array.isArray(serverModels) || serverModels.length === 0) {
    return { synced: false, changed: false, reason: "no server models" };
  }
  try {
    const config = JSON.parse(fs.readFileSync(piModelsPath, "utf8"));
    const provider = config?.providers?.[backend.piProvider];
    if (!provider) {
      return { synced: false, changed: false, reason: `${backend.piProvider} provider missing` };
    }
    const existing = Array.isArray(provider.models) ? provider.models : [];
    const fingerprint = (models) => JSON.stringify(models.map((m) => [m.id, m.contextWindow]));
    const next = serverModels.map((m) =>
      piModelEntry(m, existing.find((e) => e?.id === m.id))
    );
    if (fingerprint(next) === fingerprint(existing)) {
      return { synced: true, changed: false };
    }
    provider.models = next;
    fs.writeFileSync(piModelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return { synced: true, changed: true };
  } catch (error) {
    return { synced: false, changed: false, reason: String(error?.message ?? error) };
  }
}

// Provision pi's provider entry for the backend, creating ~/.pi/agent/models.json
// (and the provider block) when missing. Existing/unrelated providers are
// preserved exactly; a timestamped backup is taken before any write. Models are
// populated from the live server when available. Idempotent: a no-op when the
// resolved provider entry already matches.
export function applyPiConfig(backend, serverModels, piModelsPath = PI_MODELS_PATH) {
  const dir = path.dirname(piModelsPath);
  fs.mkdirSync(dir, { recursive: true });

  let existingRaw = null;
  try {
    existingRaw = fs.readFileSync(piModelsPath, "utf8");
  } catch {
    existingRaw = null;
  }

  let config = {};
  if (existingRaw != null) {
    try {
      config = JSON.parse(existingRaw);
    } catch {
      // Refuse to clobber a file we cannot parse; the caller surfaces the reason.
      return {
        applied: false,
        alreadyPresent: false,
        backupPath: null,
        configPath: piModelsPath,
        reason: "existing models.json is not valid JSON"
      };
    }
  }
  if (!config || typeof config !== "object") {
    config = {};
  }
  if (!config.providers || typeof config.providers !== "object") {
    config.providers = {};
  }

  const providerName = backend.piProvider;
  const before = config.providers[providerName]
    ? JSON.stringify(config.providers[providerName])
    : null;

  const existingProvider =
    config.providers[providerName] && typeof config.providers[providerName] === "object"
      ? config.providers[providerName]
      : {};
  const existingModels = Array.isArray(existingProvider.models) ? existingProvider.models : [];
  const models = Array.isArray(serverModels)
    ? serverModels.map((m) => piModelEntry(m, existingModels.find((e) => e?.id === m.id)))
    : existingModels;

  // The provider's apiKey references the backend env key so pi authenticates
  // from the injected child env (never an inline secret). Pi requires SOME
  // apiKey value in a provider entry even when the backend needs no real auth
  // (e.g. local ollama); the conventional stub is the provider name. Precedence:
  // env-key reference > preserved existing value > stub.
  config.providers[providerName] = {
    ...existingProvider,
    name: existingProvider.name ?? `${backend.flavor} (local)`,
    baseUrl: backend.baseUrl,
    apiKey: piProviderApiKey(backend, existingProvider.apiKey),
    models
  };

  const after = JSON.stringify(config.providers[providerName]);
  if (before != null && before === after) {
    return { applied: false, alreadyPresent: true, backupPath: null, configPath: piModelsPath };
  }

  let backupPath = null;
  if (existingRaw != null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${piModelsPath}.frontier-backup-${stamp}`;
    fs.writeFileSync(backupPath, existingRaw, "utf8");
  }

  fs.writeFileSync(piModelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { applied: true, alreadyPresent: false, backupPath, configPath: piModelsPath };
}

// -----------------------------------------------------------------------------
// Provider configuration guardrails (structural no-cloud-fallback)
// -----------------------------------------------------------------------------

export function piOmlxProviderPresent(backend, piModelsPath = PI_MODELS_PATH) {
  try {
    const config = JSON.parse(fs.readFileSync(piModelsPath, "utf8"));
    const provider = config?.providers?.[backend.piProvider];
    return Boolean(provider && provider.baseUrl);
  } catch {
    return false;
  }
}

// Pi resolves its model from user-level settings (~/.pi/agent/settings.json)
// when only --provider is passed, which silently routes to whatever default
// provider the user last picked — including cloud ones. Always pin --model to
// the provider's configured entry so that fallback path cannot trigger.
export function piOmlxDefaultModel(backend, piModelsPath = PI_MODELS_PATH) {
  try {
    const config = JSON.parse(fs.readFileSync(piModelsPath, "utf8"));
    const id = config?.providers?.[backend.piProvider]?.models?.[0]?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export function codexProfilePresent(backend, codexConfigPath = CODEX_CONFIG_PATH) {
  const toml = readCodexConfig(codexConfigPath);
  if (toml == null) {
    return false;
  }
  return (
    tomlHasTable(toml, `profiles.${backend.codexProfile}`) &&
    tomlHasTable(toml, `model_providers.${backend.piProvider}`)
  );
}

export function readCodexConfig(codexConfigPath = CODEX_CONFIG_PATH) {
  try {
    return fs.readFileSync(codexConfigPath, "utf8");
  } catch {
    return null;
  }
}

// Lightweight TOML table detector. We only need to know whether a `[table]`
// header exists; we never parse values, so this avoids a TOML dependency.
function tomlHasTable(toml, tableName) {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*\\[\\s*${escaped}\\s*\\]\\s*$`, "m");
  return pattern.test(toml);
}

// -----------------------------------------------------------------------------
// Codex config setup (additive, idempotent, backed up)
// -----------------------------------------------------------------------------

// Build the additive codex provider + profile block for the backend. The model
// is resolved from the live server (no hardcoded id); env_key is only emitted
// when the backend actually has one. wire_api = "responses" because the server
// exposes the OpenAI Responses API at /v1/responses and codex >= 0.130 rejects
// "chat".
export function buildCodexConfigBlock(backend, model) {
  const lines = [
    "",
    "# --- Frontier: local provider (added by frontier-companion setup) ---",
    `[model_providers.${backend.piProvider}]`,
    `name = "${backend.flavor} (local)"`,
    `base_url = "${backend.baseUrl}"`,
    'wire_api = "responses"'
  ];
  if (backend.envKey) {
    lines.push(`env_key = "${backend.envKey}"`);
  }
  lines.push("");
  lines.push(`[profiles.${backend.codexProfile}]`);
  lines.push(`model_provider = "${backend.piProvider}"`);
  if (typeof model === "string" && model) {
    lines.push(`model = "${model}"`);
  }
  lines.push("");
  return lines.join("\n");
}

// Apply the codex provider + profile additively. Never rewrites existing
// content. Backs up the config to a timestamped copy first. Idempotent: if the
// entries already exist, it is a no-op. `model` is resolved from the live server
// by the caller (setup), so no model id is hardcoded anywhere.
export function applyCodexConfig(backend, model, codexConfigPath = CODEX_CONFIG_PATH) {
  const existing = readCodexConfig(codexConfigPath);
  const dir = path.dirname(codexConfigPath);
  fs.mkdirSync(dir, { recursive: true });

  if (existing != null && codexProfilePresent(backend, codexConfigPath)) {
    return { applied: false, alreadyPresent: true, backupPath: null, configPath: codexConfigPath };
  }

  let backupPath = null;
  if (existing != null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${codexConfigPath}.frontier-backup-${stamp}`;
    fs.copyFileSync(codexConfigPath, backupPath);
  }

  const block = buildCodexConfigBlock(backend, model);
  const base = existing == null ? "" : existing.endsWith("\n") ? existing : `${existing}\n`;
  fs.writeFileSync(codexConfigPath, `${base}${block}`, "utf8");

  return { applied: true, alreadyPresent: false, backupPath, configPath: codexConfigPath };
}

// -----------------------------------------------------------------------------
// Pi invocation
// -----------------------------------------------------------------------------

const READ_ONLY_PREAMBLE =
  "You are running in read-only mode. Do not modify, create, or delete any files. " +
  "Inspect and report only.\n\n";

export function buildPiArgs({ provider, model, write, prompt }) {
  const args = ["--provider", provider, "--no-session", "--mode", "json", "--print"];
  if (model) {
    args.push("--model", model);
  }
  if (!write) {
    // Read-only: deny edit/write tools. bash stays available, so we also pin a
    // read-only instruction into the prompt.
    args.push("--exclude-tools", "edit,write");
  }
  args.push("-p", prompt);
  return args;
}

export function buildPiPrompt({ prompt, write }) {
  return write ? prompt : `${READ_ONLY_PREAMBLE}${prompt}`;
}

// Pi's --mode json emits a stream of JSON objects (one per line, or a single
// JSON array/object). Extract the final assistant text robustly.
export function extractPiFinalMessage(stdout) {
  const text = String(stdout ?? "");
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  // Try whole-output JSON first (array or object).
  const whole = tryParseJson(trimmed);
  if (whole !== undefined) {
    const fromWhole = pickAssistantText(whole);
    if (fromWhole != null) {
      return fromWhole;
    }
  }

  // Otherwise treat as JSONL: parse each line, keep the last assistant-ish text.
  let lastText = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const value = tryParseJson(line.trim());
    if (value === undefined) {
      continue;
    }
    const picked = pickAssistantText(value);
    if (picked != null && picked !== "") {
      lastText = picked;
    }
  }
  if (lastText != null) {
    return lastText;
  }

  // Last resort: return raw stdout so the caller still sees the model output.
  return trimmed;
}

function tryParseJson(candidate) {
  if (!candidate) {
    return undefined;
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

// Walk common shapes pi/openai-style payloads use to locate assistant text.
function pickAssistantText(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    let last = null;
    for (const item of value) {
      const picked = pickAssistantText(item);
      if (picked != null && picked !== "") {
        last = picked;
      }
    }
    return last;
  }
  if (typeof value !== "object") {
    return null;
  }

  // Common direct fields.
  for (const key of ["text", "content", "message", "response", "output", "result"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key];
    }
  }

  // OpenAI-style { role: "assistant", content: ... }
  if (value.role && value.role !== "assistant") {
    // Skip non-assistant roles when role is explicit.
  }
  if (value.content != null) {
    const picked = pickAssistantText(value.content);
    if (picked != null) {
      return picked;
    }
  }
  if (value.message != null) {
    const picked = pickAssistantText(value.message);
    if (picked != null) {
      return picked;
    }
  }
  if (Array.isArray(value.choices)) {
    const picked = pickAssistantText(value.choices);
    if (picked != null) {
      return picked;
    }
  }
  if (value.delta != null) {
    const picked = pickAssistantText(value.delta);
    if (picked != null) {
      return picked;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Codex invocation
// -----------------------------------------------------------------------------

export function buildCodexArgs({ write, lastMessageFile, prompt, model, profile }) {
  // codex exec rejects the interactive approval flag, so it is never passed
  // here. Never use a bare -m without the profile: the profile is what binds
  // codex to the local provider, preventing a silent cloud fallback. With the
  // profile in place, -m only swaps which local model is requested.
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    write ? "workspace-write" : "read-only",
    "--profile",
    profile,
    "--output-last-message",
    lastMessageFile,
    "--json"
  ];
  if (model) {
    args.push("--model", model);
  }
  args.push(prompt);
  return args;
}

// Read the final assistant message codex wrote via --output-last-message.
export function readCodexLastMessage(lastMessageFile) {
  try {
    return fs.readFileSync(lastMessageFile, "utf8").trim();
  } catch {
    return "";
  }
}

// -----------------------------------------------------------------------------
// Binary presence summary for setup
// -----------------------------------------------------------------------------

export function probeBinaries() {
  const probe = (name, args) => {
    const result = runCommand(name, args);
    if (result.error && result.error.code === "ENOENT") {
      return { name, available: false, detail: "not found on PATH" };
    }
    if (result.error) {
      return { name, available: false, detail: result.error.message };
    }
    const detail = (result.stdout || result.stderr || "ok").trim().split(/\r?\n/)[0];
    return { name, available: result.status === 0 || Boolean(detail), detail };
  };
  return {
    omlx: probe("omlx", ["--help"]),
    pi: probe("pi", ["--version"]),
    codex: probe("codex", ["--version"]),
    node: probe("node", ["--version"])
  };
}

export const paths = {
  piModels: PI_MODELS_PATH,
  codexConfig: CODEX_CONFIG_PATH
};
