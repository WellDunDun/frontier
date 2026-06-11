import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// =============================================================================
// Backend resolution. One descriptor shape is consumed everywhere else (harness,
// runner, setup) so the rest of the runtime never hardcodes a host/port, env
// key, provider name, or model id. Phase 1 implements the omlx flavor only; the
// resolver map below is the single extension point for ollama/openai later.
// =============================================================================

// The resolved descriptor shape (see docs/backend-design.md):
//   {
//     flavor:        "omlx",                     // | "ollama" | "openai" (later)
//     baseUrl:       "http://127.0.0.1:8000/v1", // always the OpenAI /v1 root
//     statusUrl:     "http://127.0.0.1:8000/api/status" | null,
//     envKey:        "OMLX_API_KEY" | null,      // env var harnesses auth with
//     apiKey:        "..." | null,               // resolved secret (never logged)
//     defaultModel:  "..." | null,               // config override, if any
//     piProvider:    "omlx",
//     codexProfile:  "frontier-omlx",
//     codexSupported:boolean
//   }

const HOME = os.homedir();

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
    envKey: "OMLX_API_KEY",
    apiKey,
    defaultModel: configOverrides.defaultModel ?? null,
    piProvider: configOverrides.piProvider ?? "omlx",
    codexProfile: configOverrides.codexProfile ?? "frontier-omlx",
    codexSupported: true
  };
}

// Detect whether omlx is the right flavor for auto-detection: its settings file
// exists. (A live-port probe is a later refinement; the Phase 1 anchor is the
// settings file.)
function detectOmlx({ paths }) {
  try {
    fs.accessSync(paths.omlxSettings, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const FLAVOR_RESOLVERS = {
  omlx: { detect: detectOmlx, build: buildOmlxBackend }
  // ollama / openai resolvers register here in later phases.
};

// -----------------------------------------------------------------------------
// Config-file precedence + resolution entry point
// -----------------------------------------------------------------------------

// Read the two config layers and fold their omlx-relevant overrides together.
// Workspace-root config wins over user-level config. Only fields the omlx flavor
// understands are surfaced in Phase 1; an explicit `flavor` of "ollama"/"openai"
// is out of scope and is ignored (auto-detect still chooses omlx).
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

// Resolve the backend descriptor.
//
// Precedence: frontier.config.json (workspace root) > ~/.frontier/config.json >
// auto-detect (omlx). Phase 1 only materializes the omlx flavor; config files
// can override the omlx baseUrl/defaultModel etc., but selecting a different
// flavor is out of scope and falls through to omlx.
//
// Parameters (all optional, defaulting to real locations) keep this testable:
//   workspaceRoot — repo root to look for frontier.config.json
//   paths         — { userConfig, omlxSettings }
//   env           — process.env (for apiKey { env } resolution)
export function resolveBackend({ workspaceRoot, paths, env } = {}) {
  const resolvedPaths = { ...DEFAULT_BACKEND_PATHS, ...(paths ?? {}) };
  const resolvedEnv = env ?? process.env;

  const configOverrides = loadConfigOverrides({
    workspaceRoot,
    paths: resolvedPaths,
    env: resolvedEnv
  });

  // Flavor selection. Config may name a flavor, but Phase 1 only knows omlx;
  // anything else (ollama/openai) is not yet wired, so fall back to omlx.
  let flavor = configOverrides.flavor;
  if (!flavor || !FLAVOR_RESOLVERS[flavor]) {
    flavor = detectFlavor(resolvedPaths);
  }

  const resolver = FLAVOR_RESOLVERS[flavor] ?? FLAVOR_RESOLVERS.omlx;
  const backend = resolver.build({
    paths: resolvedPaths,
    env: resolvedEnv,
    configOverrides
  });
  return { ...backend, configSource: configOverrides.source };
}

// Auto-detect ladder. Phase 1: omlx if its settings exist, otherwise still omlx
// (the only implemented flavor). The structure leaves room for ollama/openai.
function detectFlavor(paths) {
  for (const [flavor, resolver] of Object.entries(FLAVOR_RESOLVERS)) {
    if (resolver.detect({ paths })) {
      return flavor;
    }
  }
  return "omlx";
}
