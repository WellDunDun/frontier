import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// =============================================================================
// Backend resolution. One descriptor shape is consumed everywhere else (harness,
// runner, setup) so the rest of the runtime never hardcodes a host/port, env
// key, provider name, or model id. Phase 1 shipped the omlx flavor; Phase 1.5
// adds ollama. The resolver map below is the single extension point for openai.
//
// resolveBackend is ASYNC: auto-detection probes live ports (8000 for oMLX,
// 11434 for Ollama) and codexSupported probes /v1/responses, both of which are
// inherently asynchronous. When a config file names a flavor explicitly, no
// detection probe runs, so resolution stays effectively synchronous. All real
// callers (companion task/setup, runner preflight/runHarness) are already async.
// =============================================================================

// The resolved descriptor shape (see docs/backend-design.md):
//   {
//     flavor:        "omlx",                     // | "ollama" | "openai" (later)
//     baseUrl:       "http://127.0.0.1:8000/v1", // always the OpenAI /v1 root
//     statusUrl:     "http://127.0.0.1:8000/api/status" | null,  // omlx active model
//     activeUrl:     "http://127.0.0.1:11434/api/ps" | null,     // ollama active model
//     tagsUrl:       "http://127.0.0.1:11434/api/tags" | null,   // ollama available models
//     envKey:        "OMLX_API_KEY" | null,      // env var harnesses auth with
//     apiKey:        "..." | null,               // resolved secret (never logged)
//     defaultModel:  "..." | null,               // config override, if any
//     piProvider:    "omlx",
//     codexProfile:  "frontier-omlx",
//     codexSupported:boolean
//   }

const HOME = os.homedir();

// Default ollama context window. Ollama's /api/tags basic shape carries no
// context-length info (it lives in /api/show per-model), so we default sensibly
// rather than per-model probing. 8192 is a safe lower bound for current models.
export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 8192;

// Default config-file locations. Overridable via the `paths` parameter so tests
// never touch the real home directory (spec "Constraints").
export const DEFAULT_BACKEND_PATHS = {
  userConfig: path.join(HOME, ".frontier", "config.json"),
  omlxSettings: path.join(HOME, ".omlx", "settings.json")
};

const WORKSPACE_CONFIG_NAME = "frontier.config.json";

// -----------------------------------------------------------------------------
// Small file helpers (all tolerant of missing/garbage files)
// -----------------------------------------------------------------------------

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Resolve an `apiKey` config spec into a literal value. Accepts
// { env: "NAME" } | { file: "/path", jsonPath: "a.b" } | { value: "literal" }.
// Missing / unresolvable → null (no auth).
function resolveApiKeySpec(spec, env) {
  if (!spec || typeof spec !== "object") {
    return null;
  }
  if (typeof spec.value === "string" && spec.value) {
    return spec.value;
  }
  if (typeof spec.env === "string" && spec.env) {
    const value = env[spec.env];
    return typeof value === "string" && value ? value : null;
  }
  if (typeof spec.file === "string" && spec.file) {
    const json = readJsonFile(spec.file);
    if (json == null) {
      return null;
    }
    if (typeof spec.jsonPath === "string" && spec.jsonPath) {
      const value = spec.jsonPath
        .split(".")
        .reduce((acc, key) => (acc == null ? acc : acc[key]), json);
      return typeof value === "string" && value ? value : null;
    }
    return typeof json === "string" && json ? json : null;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Derived URLs from a /v1 base
// -----------------------------------------------------------------------------

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

export function modelsUrlFor(baseUrl) {
  return `${stripTrailingSlash(baseUrl)}/models`;
}

// oMLX's status endpoint lives at the server root (sibling of /v1), not under it.
export function statusUrlFor(baseUrl) {
  return `${stripTrailingSlash(baseUrl).replace(/\/v1$/, "")}/api/status`;
}

// Ollama's native endpoints live at the server root (siblings of /v1):
//   /api/ps   → currently-loaded models   (active-model resolution)
//   /api/tags → all installed models      (available-model listing)
function ollamaRootFor(baseUrl) {
  return stripTrailingSlash(baseUrl).replace(/\/v1$/, "");
}

export function ollamaActiveUrlFor(baseUrl) {
  return `${ollamaRootFor(baseUrl)}/api/ps`;
}

export function ollamaTagsUrlFor(baseUrl) {
  return `${ollamaRootFor(baseUrl)}/api/tags`;
}

// The OpenAI Responses endpoint codex requires. Probing it tells us whether a
// backend supports the codex harness (omlx and oMLX-likes serve it; vanilla
// Ollama historically did not).
export function responsesUrlFor(baseUrl) {
  return `${stripTrailingSlash(baseUrl)}/responses`;
}

// -----------------------------------------------------------------------------
// Live probes (async). Kept tiny and dependency-free.
// -----------------------------------------------------------------------------

// Parse host/port out of an http(s) URL for a raw TCP liveness probe. Returns
// null if the URL is unparseable.
function hostPortFromUrl(url) {
  try {
    const parsed = new URL(url);
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

// True if something accepts a TCP connection at host:port within timeoutMs.
// Used by the auto-detect ladder: a server "answers" even before we speak HTTP.
export function probeTcp(url, timeoutMs = 600) {
  const target = hostPortFromUrl(url);
  if (!target) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(target.port, target.host);
  });
}

// Probe POST /v1/responses to decide codexSupported. Any HTTP answer that is NOT
// a 404 counts as supported (per spec): a 404 means the route is absent; a 400/
// 401/422/etc. means the route exists but rejected our empty body. A transport
// failure (server down) is treated as "not supported" — the safe default, since
// preflight refuses unreachable servers anyway and pi still works.
export async function probeCodexSupported(baseUrl, { apiKey } = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  if (typeof apiKey === "string" && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  try {
    const response = await fetch(responsesUrlFor(baseUrl), {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal
    });
    return response.status !== 404;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Per-flavor resolvers. Adding a flavor is a small diff: implement its detect()
// and build(), then register it in FLAVOR_RESOLVERS. Phase 1 ships omlx only.
// -----------------------------------------------------------------------------

const OMLX_DEFAULT_HOST = "127.0.0.1";
const OMLX_DEFAULT_PORT = 8000;

// Build the omlx descriptor from ~/.omlx/settings.json. Host/port fall back to
// 127.0.0.1:8000; the api key lives at auth.api_key. The model id is NEVER baked
// in here — it is resolved from the live server at setup/run time.
function buildOmlxBackend({ paths, configOverrides }) {
  const settings = readJsonFile(paths.omlxSettings) ?? {};
  const host =
    typeof settings?.server?.host === "string" && settings.server.host
      ? settings.server.host
      : OMLX_DEFAULT_HOST;
  const port =
    Number.isFinite(settings?.server?.port) && settings.server.port > 0
      ? settings.server.port
      : OMLX_DEFAULT_PORT;
  const detectedBase = `http://${host}:${port}/v1`;

  // Config files may override baseUrl/defaultModel for the omlx flavor.
  const baseUrl = configOverrides.baseUrl ?? detectedBase;

  // apiKey precedence: config apiKey spec (when given) > settings auth.api_key.
  const settingsKey =
    typeof settings?.auth?.api_key === "string" && settings.auth.api_key
      ? settings.auth.api_key
      : null;
  const apiKey = configOverrides.apiKey ?? settingsKey;

  return {
    flavor: "omlx",
    baseUrl,
    statusUrl: statusUrlFor(baseUrl),
    activeUrl: null,
    tagsUrl: null,
    envKey: "OMLX_API_KEY",
    apiKey,
    defaultModel: configOverrides.defaultModel ?? null,
    piProvider: configOverrides.piProvider ?? "omlx",
    codexProfile: configOverrides.codexProfile ?? "frontier-omlx",
    // oMLX serves /v1/responses; no probe needed (keeps the omlx path offline-safe).
    codexSupported: true
  };
}

// Detect whether omlx is the right flavor for auto-detection: its settings file
// exists OR the server answers on its port. Live probing means a fresh machine
// with no ~/.omlx/settings.json but a running server still resolves to omlx.
async function detectOmlx({ paths }) {
  try {
    fs.accessSync(paths.omlxSettings, fs.constants.F_OK);
    return true;
  } catch {
    // No settings file — fall through to a live port probe.
  }
  return probeTcp(`http://${OMLX_DEFAULT_HOST}:${OMLX_DEFAULT_PORT}/v1`);
}

const OLLAMA_DEFAULT_HOST = "127.0.0.1";
const OLLAMA_DEFAULT_PORT = 11434;

// Build the ollama descriptor. Base is 127.0.0.1:11434 with the OpenAI-compatible
// API under /v1; no auth by default (envKey/apiKey null). Config files may select
// it explicitly (flavor: "ollama") and override baseUrl/defaultModel. The model id
// is NEVER baked in — it is resolved from the live server at setup/run time.
//
// codexSupported is probed from the live /v1/responses route when reachable; when
// the server is down the probe returns false (safe default — codex refuses with a
// clear message, pi still works).
async function buildOllamaBackend({ configOverrides }) {
  const detectedBase = `http://${OLLAMA_DEFAULT_HOST}:${OLLAMA_DEFAULT_PORT}/v1`;
  const baseUrl = configOverrides.baseUrl ?? detectedBase;

  // No auth by default. A config apiKey spec (rare for local ollama) still wins.
  const apiKey = configOverrides.apiKey ?? null;
  const codexSupported = await probeCodexSupported(baseUrl, { apiKey });

  return {
    flavor: "ollama",
    baseUrl,
    statusUrl: null,
    activeUrl: ollamaActiveUrlFor(baseUrl),
    tagsUrl: ollamaTagsUrlFor(baseUrl),
    envKey: null,
    apiKey,
    defaultModel: configOverrides.defaultModel ?? null,
    piProvider: configOverrides.piProvider ?? "ollama",
    codexProfile: configOverrides.codexProfile ?? "frontier-ollama",
    codexSupported
  };
}

// Detect ollama for auto-detection: the server answers on its native port.
function detectOllama() {
  return probeTcp(`http://${OLLAMA_DEFAULT_HOST}:${OLLAMA_DEFAULT_PORT}/v1`);
}

// Resolver order is the auto-detect ladder: oMLX first, then Ollama. Object key
// insertion order is iterated by detectFlavor().
const FLAVOR_RESOLVERS = {
  omlx: { detect: detectOmlx, build: buildOmlxBackend },
  ollama: { detect: detectOllama, build: buildOllamaBackend }
  // openai resolver registers here in a later phase.
};

// -----------------------------------------------------------------------------
// Config-file precedence + resolution entry point
// -----------------------------------------------------------------------------

// Read the two config layers and fold their overrides together. Workspace-root
// config wins over user-level config. A config may select a flavor explicitly
// (`flavor: "omlx" | "ollama"`); when it names a known flavor, detection is
// skipped. Unknown flavors fall through to the auto-detect ladder.
function loadConfigOverrides({ workspaceRoot, paths, env }) {
  const workspaceConfig = workspaceRoot
    ? readJsonFile(path.join(workspaceRoot, WORKSPACE_CONFIG_NAME))
    : null;
  const userConfig = readJsonFile(paths.userConfig);

  const overrides = { source: "auto-detect" };
  const apply = (config, source) => {
    if (!config || typeof config !== "object") {
      return;
    }
    overrides.source = source;
    if (typeof config.baseUrl === "string" && config.baseUrl) {
      overrides.baseUrl = config.baseUrl;
    }
    if (typeof config.defaultModel === "string" && config.defaultModel) {
      overrides.defaultModel = config.defaultModel;
    }
    if (typeof config.piProvider === "string" && config.piProvider) {
      overrides.piProvider = config.piProvider;
    }
    if (typeof config.codexProfile === "string" && config.codexProfile) {
      overrides.codexProfile = config.codexProfile;
    }
    if (config.apiKey && typeof config.apiKey === "object") {
      overrides.apiKey = resolveApiKeySpec(config.apiKey, env);
    }
    if (typeof config.flavor === "string" && config.flavor) {
      overrides.flavor = config.flavor;
    }
  };

  // Apply user-level first, then workspace so the latter overrides.
  apply(userConfig, "user-config");
  apply(workspaceConfig, "workspace-config");
  return overrides;
}

// Resolve the backend descriptor (async — see the module header for why).
//
// Precedence: frontier.config.json (workspace root) > ~/.frontier/config.json >
// auto-detect ladder (oMLX → Ollama). A config may select a flavor explicitly;
// config files can also override baseUrl/defaultModel/provider/profile for the
// chosen flavor.
//
// Parameters (all optional, defaulting to real locations) keep this testable:
//   workspaceRoot — repo root to look for frontier.config.json
//   paths         — { userConfig, omlxSettings }
//   env           — process.env (for apiKey { env } resolution)
export async function resolveBackend({ workspaceRoot, paths, env } = {}) {
  const resolvedPaths = { ...DEFAULT_BACKEND_PATHS, ...(paths ?? {}) };
  const resolvedEnv = env ?? process.env;

  const configOverrides = loadConfigOverrides({
    workspaceRoot,
    paths: resolvedPaths,
    env: resolvedEnv
  });

  // Flavor selection. An explicit, known flavor in config skips live detection;
  // otherwise walk the auto-detect ladder.
  let flavor = configOverrides.flavor;
  if (!flavor || !FLAVOR_RESOLVERS[flavor]) {
    flavor = await detectFlavor(resolvedPaths);
  }

  const resolver = FLAVOR_RESOLVERS[flavor] ?? FLAVOR_RESOLVERS.omlx;
  const backend = await resolver.build({
    paths: resolvedPaths,
    env: resolvedEnv,
    configOverrides
  });
  return { ...backend, configSource: configOverrides.source };
}

// Auto-detect ladder: oMLX (settings file or live port 8000) → Ollama (live port
// 11434). First detector that answers wins. Falls back to omlx when nothing
// answers so the descriptor is always materializable (preflight then reports the
// server as unreachable rather than crashing).
async function detectFlavor(paths) {
  for (const [flavor, resolver] of Object.entries(FLAVOR_RESOLVERS)) {
    // Detectors run sequentially (ladder order matters: oMLX before Ollama).
    // eslint-disable-next-line no-await-in-loop
    if (await resolver.detect({ paths })) {
      return flavor;
    }
  }
  return "omlx";
}
