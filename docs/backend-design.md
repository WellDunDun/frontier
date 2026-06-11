# Backend Portability Design

Goal: make the companion runtime work across local and remote model providers,
supporting three backend flavors with one resolution pipeline:

- `omlx` — oMLX server
- `ollama` — Ollama's OpenAI-compatible endpoint
- `openai` — any OpenAI-compatible server or hosted gateway, via explicit config

## Backend descriptor

A single module `scripts/lib/backend.mjs` owns backend resolution and exports
one shape consumed everywhere else:

```js
{
  flavor: "omlx" | "ollama" | "openai",
  baseUrl: "http://127.0.0.1:8000/v1",   // always the OpenAI-compatible /v1 root
  envKey: "OMLX_API_KEY" | null,          // env var name harnesses authenticate with
  apiKey: "..." | null,                   // resolved secret value (never logged)
  piProvider: "omlx" | "ollama" | "frontier-local",
  codexProfile: "frontier-omlx" | "frontier-ollama" | "frontier-local",
  codexSupported: boolean                 // false when /v1/responses is absent
}
```

Resolution precedence (first hit wins):

1. `frontier.config.json` at the workspace root (repo-level, committable)
2. `~/.frontier/config.json` (user-level)
3. Auto-detect: oMLX (`~/.omlx/settings.json` exists or `127.0.0.1:8000`
   answers) → Ollama (`127.0.0.1:11434` answers)

Config file schema (both levels, all fields optional except `baseUrl` when
`flavor` is `openai`):

```json
{
  "flavor": "openai",
  "baseUrl": "http://127.0.0.1:1234/v1",
  "apiKey": { "env": "MY_KEY" },
  "defaultModel": "qwen3-coder",
  "piProvider": "frontier-local",
  "codexProfile": "frontier-local"
}
```

`apiKey` accepts `{ "env": "NAME" }`, `{ "file": "/path", "jsonPath": "a.b" }`,
or `{ "value": "literal" }` (discouraged, works). Missing → no auth.

## Flavor specifics

### omlx (verified live 2026-06-11)
- Host/port from `~/.omlx/settings.json` `server.host` / `server.port`
  (fall back `127.0.0.1:8000`). Key at `auth.api_key`. Env key `OMLX_API_KEY`.
- `GET /v1/models` (Bearer) → `{data:[{id, max_model_len}]}`; entries with
  `max_model_len == null` are utility models (document converter) — exclude.
- Active model: `GET /api/status` → `loaded_models` (the GUI selection; use
  when exactly one) else `default_model`.
- Serves `/v1/responses` → `codexSupported: true`.

### ollama (not installed on the dev machine — code defensively, test via fixture)
- Base `http://127.0.0.1:11434`, OpenAI compat under `/v1`. No auth by default.
- Available models: `GET /api/tags` → `{models:[{name}]}` (fallback `/v1/models`).
- Active model: `GET /api/ps` → `{models:[{name}]}` (loaded); when empty fall
  back to config `defaultModel`, then single-entry model list, else refuse with
  a clear message naming `--model`.
- `codexSupported`: probe `/v1/responses` at setup; if absent, codex-harness
  delegation must refuse with a clear message (pi harness still works).

### openai (generic)
- Everything from config. Active model ladder: config `defaultModel` →
  `/v1/models` single entry → require explicit `--model`.
- `codexSupported` by probing `/v1/responses`.

## Capability ladder for the active model (all flavors)

explicit `--model` → flavor status endpoint (omlx `/api/status`, ollama
`/api/ps`) → config `defaultModel` → `/v1/models` single entry → pi provider
entry first model (pi only, last resort) → refuse codex/pi run with actionable
error.

## Provisioning (setup)

`setup --apply` (keep `--apply-codex` as an alias) must provision BOTH
harnesses for the resolved backend, additively and with timestamped backups:

- Pi: ensure `~/.pi/agent/models.json` has the backend's provider entry
  (create file/entry if missing — on fresh machines nothing pre-creates it),
  models synced from the server. Preserve unrelated providers byte-for-byte.
- Codex: ensure the backend's profile exists in `~/.codex/config.toml` with
  `wire_api = "responses"`, `env_key` only when the backend has one, and the
  model resolved from the live server (no hardcoded model ids anywhere).
- Report must show: detected flavor, baseUrl, models found, active model,
  codexSupported, and exact next steps when something is missing.

## Invariants (do not regress — these fixed real bugs)

1. Pi runs MUST always pin `--model`; a bare `--provider` lets pi's user-level
   default (possibly a cloud provider) win. Verified live.
2. Harness child processes MUST receive the backend's env key (e.g.
   `OMLX_API_KEY`) — pi's provider entry and codex's profile both reference it.
3. Post-run guard: refuse a pi result whose JSON event stream shows a
   `"provider"` other than the backend's `piProvider`.
4. Codex is bound to the selected provider by `--profile`; `-m` only swaps the
   model within it. Never pass `-m` without the profile.
5. Preflight refuses to run when provider config or the configured backend is
   missing. No silent fallback to any unintended provider or model, ever. Cloud
   providers are allowed only when selected explicitly through config.

## Constraints

- Plain JavaScript ESM (`.mjs`), Node >= 20, zero npm dependencies.
  Tests use `node:test` (`npm test` = `node --test tests/`).
- `npm run check` must pass: never write the literal oMLX interactive launch
  subcommand or the codex interactive approval flag in any runtime file.
- Architecture stays: thin forwarder agent → companion CLI → lib modules.
  No CLI strings in agent/command/skill markdown.
- For testability, modules that read config files take an optional `paths`/
  `env` parameter defaulting to the real locations; tests must not touch the
  real home directory.
