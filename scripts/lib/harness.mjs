import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./process.mjs";

// =============================================================================
// All provider / CLI mechanics live here, in deterministic Node. Nothing in an
// agent or command prompt file should ever hand-roll a pi or codex CLI string.
// =============================================================================

export const OMLX_BASE_URL = "http://127.0.0.1:8000/v1";
export const OMLX_MODELS_URL = `${OMLX_BASE_URL}/models`;
export const PI_PROVIDER_DEFAULT = "omlx";
export const CODEX_PROFILE = "frontier-omlx";

const PI_MODELS_PATH = path.join(os.homedir(), ".pi", "agent", "models.json");
const CODEX_CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const OMLX_SETTINGS_PATH = path.join(os.homedir(), ".omlx", "settings.json");

// Default model the codex profile points at. The 12B Gemma is the model pi's
// omlx provider also targets; keep the two paths on the same local model.
const CODEX_DEFAULT_MODEL = "mlx-community--gemma-4-12B-it-8bit";

// -----------------------------------------------------------------------------
// oMLX server health
// -----------------------------------------------------------------------------

// The oMLX server requires an API key. We read it from ~/.omlx/settings.json so
// the health probe can authenticate. A 401/200 both prove the server is alive;
// only a connection failure means it is down.
function readOmlxApiKey() {
  try {
    const settings = JSON.parse(fs.readFileSync(OMLX_SETTINGS_PATH, "utf8"));
    const key = settings?.auth?.api_key;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

export async function checkOmlxHealth(timeoutMs = 4000) {
  const apiKey = readOmlxApiKey();
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(OMLX_MODELS_URL, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    // Any HTTP response means the server is reachable.
    return {
      reachable: true,
      ok: response.status === 200,
      status: response.status,
      hasApiKey: Boolean(apiKey),
      detail: response.status === 200 ? "ok" : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      status: null,
      hasApiKey: Boolean(apiKey),
      detail: error?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(error?.message ?? error)
    };
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Provider configuration guardrails (structural no-cloud-fallback)
// -----------------------------------------------------------------------------

export function piOmlxProviderPresent() {
  try {
    const config = JSON.parse(fs.readFileSync(PI_MODELS_PATH, "utf8"));
    const provider = config?.providers?.[PI_PROVIDER_DEFAULT];
    return Boolean(provider && provider.baseUrl);
  } catch {
    return false;
  }
}

export function codexProfilePresent() {
  const toml = readCodexConfig();
  if (toml == null) {
    return false;
  }
  return tomlHasTable(toml, `profiles.${CODEX_PROFILE}`) && tomlHasTable(toml, "model_providers.omlx");
}

export function readCodexConfig() {
  try {
    return fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
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

export function buildCodexConfigBlock() {
  // oMLX exposes the OpenAI Responses API at /v1/responses, and codex >= 0.130
  // requires wire_api = "responses" (it rejects "chat"). env_key points codex at
  // the OMLX_API_KEY environment variable for bearer auth.
  return [
    "",
    "# --- Frontier: local oMLX provider (added by frontier-companion setup) ---",
    "[model_providers.omlx]",
    'name = "oMLX (local)"',
    `base_url = "${OMLX_BASE_URL}"`,
    'wire_api = "responses"',
    'env_key = "OMLX_API_KEY"',
    "",
    "[profiles.frontier-omlx]",
    'model_provider = "omlx"',
    `model = "${CODEX_DEFAULT_MODEL}"`,
    ""
  ].join("\n");
}

// Apply the codex provider + profile additively. Never rewrites existing
// content. Backs up the config to a timestamped copy first. Idempotent: if the
// entries already exist, it is a no-op.
export function applyCodexConfig() {
  const existing = readCodexConfig();
  const dir = path.dirname(CODEX_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });

  if (existing != null && codexProfilePresent()) {
    return { applied: false, alreadyPresent: true, backupPath: null, configPath: CODEX_CONFIG_PATH };
  }

  let backupPath = null;
  if (existing != null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${CODEX_CONFIG_PATH}.frontier-backup-${stamp}`;
    fs.copyFileSync(CODEX_CONFIG_PATH, backupPath);
  }

  const block = buildCodexConfigBlock();
  const base = existing == null ? "" : existing.endsWith("\n") ? existing : `${existing}\n`;
  fs.writeFileSync(CODEX_CONFIG_PATH, `${base}${block}`, "utf8");

  return { applied: true, alreadyPresent: false, backupPath, configPath: CODEX_CONFIG_PATH };
}

// -----------------------------------------------------------------------------
// Pi invocation
// -----------------------------------------------------------------------------

const READ_ONLY_PREAMBLE =
  "You are running in read-only mode. Do not modify, create, or delete any files. " +
  "Inspect and report only.\n\n";

export function buildPiArgs({ provider, model, write, prompt }) {
  const args = [
    "--provider",
    provider,
    "--no-session",
    "--mode",
    "json",
    "--print"
  ];
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

export function buildCodexArgs({ write, lastMessageFile, prompt }) {
  // codex exec rejects the interactive approval flag, so it is never passed
  // here. Never use a bare -m without the profile: the profile is what binds
  // codex to the local oMLX provider, preventing a silent cloud fallback.
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    write ? "workspace-write" : "read-only",
    "--profile",
    CODEX_PROFILE,
    "--output-last-message",
    lastMessageFile,
    "--json"
  ];
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
  codexConfig: CODEX_CONFIG_PATH,
  omlxSettings: OMLX_SETTINGS_PATH
};
