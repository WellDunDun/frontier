# Frontier

[![CI](https://github.com/WellDunDun/frontier/actions/workflows/ci.yml/badge.svg)](https://github.com/WellDunDun/frontier/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Frontier is an orchestration runtime for frontier harnesses and models that
need to delegate bounded work to other harnesses, models, and providers. It
starts with Claude Code and Codex plugin surfaces plus a deterministic companion
CLI that routes work through harness adapters such as Pi and Codex.

Status: early public preview. The runtime is usable, but provider support is
still evolving.

The working pattern is simple: keep planning, tradeoffs, synthesis, and final
review with the frontier orchestrator; delegate bounded research,
implementation, testing, and log reduction to configured worker harnesses.
Provider mechanics are configuration, never baked into prompts.

## Get Started

Install Frontier from its Claude Code marketplace:

    /plugin marketplace add WellDunDun/frontier
    /plugin install frontier@frontier-marketplace

Then configure the worker backend:

1. Choose and start or configure a backend:

   - oMLX: start the server with `omlx start` or `omlx serve <model>`.
   - Ollama: start Ollama and make a model available.
   - OpenAI-compatible local or cloud backend: add `frontier.config.json` with
     `flavor: "openai"`, `baseUrl`, and an `apiKey.env` reference when auth
     is required.

   `omlx launch <tool>` opens an interactive configure-and-launch TUI; run it
   yourself if useful. Frontier does not invoke it for you.

2. Check readiness:

       /frontier:setup

3. Provision the Pi provider and Codex profile if they are missing:

       /frontier:setup --apply

   The apply step provisions both harnesses additively: it ensures the selected
   Pi provider exists in `~/.pi/agent/models.json` and the selected Codex
   provider/profile exist in `~/.codex/config.toml`, taking a timestamped backup
   before any write and preserving unrelated entries. Models are read from the
   configured backend, so the backend must be reachable when you apply.

4. Smoke test delegation:

       /frontier:delegate reply with OK

The checkout-based `--plugin-dir` flow is only needed for local development.

## Examples

Delegate a research or review task through the default worker harness:

    /frontier:delegate summarize the failing npm test output and suggest the smallest fix

Send a bounded implementation task through Codex and allow file edits:

    /frontier:delegate --harness codex --write add tests for setup backend readiness

Run a longer task in the background, then collect the result later:

    /frontier:delegate --harness pi --background inspect the latest logs and group recurring failures
    /frontier:status
    /frontier:result <job-id>

Pin a model for a single delegated task when the selected backend exposes more
than one model:

    /frontier:delegate --harness pi --model glm-5.1 compare these two implementation plans

Point Frontier at an OpenAI-compatible gateway, local server, or cloud provider:

```json
{
  "flavor": "openai",
  "baseUrl": "https://api.example.com/v1",
  "apiKey": { "env": "FRONTIER_API_KEY" },
  "defaultModel": "glm-5.1",
  "piProvider": "frontier-gateway",
  "codexProfile": "frontier-gateway"
}
```

With that config in `frontier.config.json`, `/frontier:setup --apply`
provisions the harness entries against that backend instead of auto-detected
local providers.

## How it works

- **Companion runtime** — `plugins/frontier/scripts/frontier-companion.mjs` owns every harness
  detail: building the `pi` and `codex` command lines, checking the configured
  backend endpoint, verifying provider configuration, parsing output, and
  tracking jobs. No agent or command prompt ever composes a raw CLI string.
- **frontier-worker agent** — a thin forwarder. It makes exactly one call to the
  companion `task` subcommand and returns the output verbatim. It picks `pi` for
  research/review/summarization/log reduction and `codex` for
  implementation/patches/tests.
- **Commands** — `/frontier:delegate`, `/frontier:status`, `/frontier:result`,
  `/frontier:cancel`, and `/frontier:setup`.
- **Orchestration skill** — `/frontier-orchestration` is judgment-only guidance
  for decomposition, handoff packets, stop conditions, and the review loop.

A structural guardrail prevents implicit provider fallback: the codex path
refuses to run unless the selected backend's profile exists in
`~/.codex/config.toml`, the pi path refuses unless the selected backend's
provider exists in `~/.pi/agent/models.json`, and both refuse if the configured
backend is unreachable or unhealthy. Cloud models are allowed when they are
selected explicitly through backend configuration.

## Backends

Frontier resolves one backend descriptor that drives every harness detail
(base URL, auth, provider/profile names, model resolution). Backends can be
local or remote. Three flavors are supported:

- **oMLX** — the oMLX server (`127.0.0.1:8000`), with auth and `/v1/responses`
  (so both the Pi and Codex harnesses work).
- **Ollama** — Ollama's OpenAI-compatible endpoint (`127.0.0.1:11434`), no auth
  by default. Active/available models come from Ollama's `/api/ps` and
  `/api/tags`. If the server does not serve `/v1/responses`, the Codex harness is
  disabled for that backend and `setup` says so; the Pi harness still works.
- **openai** — any OpenAI-compatible server (LM Studio, vLLM, llama.cpp's server,
  a hosted gateway, or a cloud provider exposing an OpenAI-compatible API),
  selected **only** via a config file. See [Bring your own server](#bring-your-own-server)
  below.

`oMLX` and `Ollama` are chosen by an **auto-detect ladder** — oMLX first (its
settings file exists or the server answers on `127.0.0.1:8000`), then Ollama (the
server answers on `127.0.0.1:11434`). The `openai` flavor is never auto-detected;
it requires an explicit config selection. A `frontier.config.json` (workspace
root) or `~/.frontier/config.json` (user) can select any flavor explicitly and
override the base URL.

A config file that contains malformed JSON, or that names an unknown `flavor`,
is a hard error naming the offending file — Frontier never silently ignores a
broken config and falls back to auto-detect.

## Bring your own server

To point Frontier at any OpenAI-compatible server, create a
`frontier.config.json` at your workspace root (committable, repo-level) or a
`~/.frontier/config.json` (user-level). Workspace config wins over user config.
Select the `openai` flavor and give it a `baseUrl` (the OpenAI-compatible `/v1`
root). For example, an LM Studio server running on `127.0.0.1:1234` with no auth:

```json
{
  "flavor": "openai",
  "baseUrl": "http://127.0.0.1:1234/v1"
}
```

Full schema (only `flavor` and `baseUrl` are required for `openai`):

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

- **`baseUrl`** (required) — the OpenAI-compatible `/v1` root. Missing it is an
  error with an actionable message.
- **`apiKey`** (optional) — how to obtain the bearer token. Three forms:
  - `{ "env": "MY_KEY" }` — read from the `MY_KEY` environment variable; the
    harnesses reference `$MY_KEY` directly.
  - `{ "file": "/path/to/creds.json", "jsonPath": "a.b" }` — read from a JSON
    file (omit `jsonPath` to read the whole file as the key).
  - `{ "value": "sk-..." }` — an inline literal (discouraged, but works).

  For the `file` and `value` forms the key is injected into the harness child
  process under the env var `FRONTIER_API_KEY` (and referenced as such in the Pi
  provider entry and the Codex profile's `env_key`). With no `apiKey` the backend
  is keyless, like a local Ollama. The secret value is never logged or printed by
  `setup` — only its *source* (env / file / literal / none) is shown.
- **`defaultModel`** (optional) — the model to pin runs to. The active-model
  ladder for `openai` is: `defaultModel` → the single entry in `/v1/models` →
  refuse and require an explicit `--model`.
- **`piProvider`** / **`codexProfile`** (optional) — the names Frontier uses for
  the Pi provider entry and Codex profile (default `frontier-local` for both).

Codex support is detected by probing `/v1/responses`. If your server does not
serve it, `setup` disables the Codex harness for that backend and the Pi harness
still works.

A safe starter file is available at `frontier.config.example.json`. Do not
commit real API keys; prefer `apiKey.env` for any authenticated local or cloud
backend.

## Commands

- `/frontier:delegate [--harness pi|codex] [--write] [--background] [--model <m>] <task>`
  — delegate a bounded sub-task to the configured model/provider and return its
  output verbatim.
- `/frontier:status [job-id]` — list active and recent jobs, or detail one.
- `/frontier:result [job-id]` — print a finished job's final output. Without an
  id, defaults to the latest finished job in the current Claude Code session.
- `/frontier:cancel [job-id]` — cancel a running job. Without an id, cancels
  only when exactly one active job exists in the current Claude Code session.
- `/frontier:setup [--apply]` — check the selected backend plus Pi and
  Codex readiness, then optionally provision the Pi provider and Codex profile
  (backend must be reachable). `--apply-codex` is kept as a backward-compatible
  alias for `--apply`.

## Skills

### /frontier-orchestration

Use a frontier harness or model as the orchestrator while worker harnesses handle
bounded research, coding, testing, and log reduction through adapters such as Pi
and Codex. Judgment stays with the orchestrator; token-heavy work is delegated to
configured models and providers.

Frontier intentionally ships only this orchestration skill. Provider and harness
mechanics live in the companion runtime and the `frontier-worker` agent, not in
duplicated planning or recap skills inherited from the source repo.

## Local development

Load the plugin from this checkout while iterating:

    claude --plugin-dir plugins/frontier

Then run `/agents` in Claude Code and confirm `frontier-worker` is listed, and
`/help` to confirm the five `frontier:` commands.

Validate the marketplace manifest and installable plugin:

    claude plugin validate .
    claude plugin validate plugins/frontier

Run the functional check (plugin metadata, marketplace consistency,
frontmatter, required files, script syntax, forbidden flags):

    npm run check

## Project

- License: Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
- Changes: [CHANGELOG.md](CHANGELOG.md).
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
- Security reports: [SECURITY.md](SECURITY.md).

Frontier is not affiliated with Anthropic, OpenAI, oMLX, Pi, Codex, or Ollama.
Those names belong to their respective owners.
