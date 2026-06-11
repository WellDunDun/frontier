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
to run unless the `frontier-omlx` profile exists in `~/.codex/config.toml`, the
pi path refuses unless the `omlx` provider exists in `~/.pi/agent/models.json`,
and both refuse if the oMLX server is unreachable.

## One-time setup

1. Start the oMLX server:

       omlx start

   (or serve a specific model with `omlx serve <model>`). As a manual
   alternative, `omlx launch <tool>` opens an interactive configure-and-launch
   TUI — run it yourself; the plugin never invokes it.

2. Run setup and apply the Codex profile:

       /frontier:setup

   If the Codex `frontier-omlx` profile is missing, accept the prompt to apply
   it. The apply step backs up `~/.codex/config.toml` first and only appends the
   provider and profile if they are absent.

3. Smoke test the delegation path:

       /frontier:delegate reply with OK

## Commands

- `/frontier:delegate [--harness pi|codex] [--write] [--background] [--model <m>] <task>`
  — delegate a bounded sub-task to a local model and return its output verbatim.
- `/frontier:status [job-id]` — list active and recent jobs, or detail one.
- `/frontier:result <job-id>` — print a finished job's final output.
- `/frontier:cancel <job-id>` — cancel a running job.
- `/frontier:setup [--apply-codex]` — check oMLX, Pi, and Codex readiness and
  optionally apply the Codex profile.

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
