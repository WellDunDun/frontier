# Frontier

Frontier is a Claude Code plugin for frontier-model orchestration. Fable (the
frontier model running in Claude Code) stays the orchestrator; bounded sub-tasks
are delegated to local models served by oMLX through two harnesses, Pi and
Codex.

The working pattern is simple: keep planning, tradeoffs, synthesis, and final
review with the frontier model; delegate bounded research, implementation,
testing, and log reduction to local-model workers. Provider mechanics are
configuration, never baked into prompts.

## How it works

- **Companion runtime** — `scripts/frontier-companion.mjs` owns every harness
  detail: building the `pi` and `codex` command lines, checking the oMLX server,
  verifying provider configuration, parsing output, and tracking jobs. No agent
  or command prompt ever composes a raw CLI string.
- **frontier-worker agent** — a thin forwarder. It makes exactly one call to the
  companion `task` subcommand and returns the output verbatim. It picks `pi` for
  research/review/summarization/log reduction and `codex` for
  implementation/patches/tests.
- **Commands** — `/frontier:delegate`, `/frontier:status`, `/frontier:result`,
  `/frontier:cancel`, and `/frontier:setup`.
- **Orchestration skill** — `/frontier-orchestration` is judgment-only guidance
  for decomposition, handoff packets, stop conditions, and the review loop.

A structural guardrail prevents a silent cloud fallback: the codex path refuses
to run unless the backend's profile (e.g. `frontier-omlx`) exists in
`~/.codex/config.toml`, the pi path refuses unless the backend's provider (e.g.
`omlx`) exists in `~/.pi/agent/models.json`, and both refuse if the local server
is unreachable.

## Backends

Frontier resolves one backend descriptor that drives every harness detail
(base URL, auth, provider/profile names, model resolution). Two local flavors are
supported today:

- **oMLX** — the oMLX server (`127.0.0.1:8000`), with auth and `/v1/responses`
  (so both the Pi and Codex harnesses work).
- **Ollama** — Ollama's OpenAI-compatible endpoint (`127.0.0.1:11434`), no auth
  by default. Active/available models come from Ollama's `/api/ps` and
  `/api/tags`. If the server does not serve `/v1/responses`, the Codex harness is
  disabled for that backend and `setup` says so; the Pi harness still works.

The flavor is chosen by an **auto-detect ladder** — oMLX first (its settings file
exists or the server answers on `127.0.0.1:8000`), then Ollama (the server answers
on `127.0.0.1:11434`). A `frontier.config.json` (workspace root) or
`~/.frontier/config.json` (user) can select a flavor explicitly and override the
base URL.

## One-time setup

1. Start the oMLX server:

       omlx start

   (or serve a specific model with `omlx serve <model>`). As a manual
   alternative, `omlx launch <tool>` opens an interactive configure-and-launch
   TUI — run it yourself; the plugin never invokes it.

2. Run setup and provision the Pi provider and Codex profile:

       /frontier:setup

   If the Pi provider or Codex `frontier-omlx` profile is missing, accept the
   prompt to provision them. The apply step (`--apply`) provisions both harnesses
   additively: it ensures the `omlx` provider exists in `~/.pi/agent/models.json`
   and the provider/profile exist in `~/.codex/config.toml`, taking a timestamped
   backup before any write and preserving unrelated entries. Models — including
   the Codex profile's model — are read from the live server, so the server must
   be running when you apply.

3. Smoke test the delegation path:

       /frontier:delegate reply with OK

## Commands

- `/frontier:delegate [--harness pi|codex] [--write] [--background] [--model <m>] <task>`
  — delegate a bounded sub-task to a local model and return its output verbatim.
- `/frontier:status [job-id]` — list active and recent jobs, or detail one.
- `/frontier:result <job-id>` — print a finished job's final output.
- `/frontier:cancel <job-id>` — cancel a running job.
- `/frontier:setup [--apply]` — check oMLX, Pi, and Codex readiness and
  optionally provision the Pi provider and Codex profile (server must be up).
  `--apply-codex` is kept as a backward-compatible alias for `--apply`.

## Skills

### /frontier-orchestration

Use Fable as the frontier-model orchestrator while local-model workers handle
bounded research, coding, testing, and log reduction through the Pi and Codex
harnesses. Judgment stays with the frontier model; token-heavy work is
delegated.

Frontier intentionally ships only this orchestration skill. Provider and harness
mechanics live in the companion runtime and the `frontier-worker` agent, not in
duplicated planning or recap skills inherited from the source repo.

## Local development

Load the plugin from this checkout while iterating:

    claude --plugin-dir .

Then run `/agents` in Claude Code and confirm `frontier-worker` is listed, and
`/help` to confirm the five `frontier:` commands.

Validate the plugin:

    claude plugin validate .

Run the functional check (frontmatter, required files, script syntax, forbidden
flags):

    npm run check
