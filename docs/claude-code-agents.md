# Frontier Claude Code Agents

Frontier lets Fable, the frontier orchestrator, delegate bounded work to local
models served by oMLX through the Pi and Codex harnesses. All harness mechanics
live in one deterministic runtime; the agent surface is intentionally thin.

## Companion runtime

`scripts/frontier-companion.mjs` is the single source of truth for provider and
CLI mechanics. Subcommands:

- `task [--harness pi|codex] [--write] [--model <m>] [--background] [--timeout-ms <n>] "<prompt>"`
  — run a bounded sub-task on a local model. The prompt may also arrive on
  stdin. Default harness is `pi`. Read-only unless `--write` is given.
- `status [job-id] [--json]` — list jobs for this repository, newest first, or
  detail one.
- `result [job-id] [--json]` — print a finished job's final message. Without
  an id, defaults to the latest finished job in the current Claude Code session.
- `cancel [job-id] [--json]` — terminate a running job and mark its state.
  Without an id, cancels only when exactly one active job exists in the current
  Claude Code session.
- `setup [--apply-codex] [--json]` — diagnose readiness; optionally apply the
  Codex profile additively.

The runtime builds the harness command lines itself:

- **Pi**: `pi --provider omlx --no-session --mode json --print` plus
  `--exclude-tools edit,write` when read-only, and `--model` only when a model is
  named.
- **Codex**: `codex exec --ephemeral --skip-git-repo-check --sandbox <read-only|workspace-write>
  --profile frontier-omlx --output-last-message <file> --json`. Codex always runs
  under the `frontier-omlx` profile so it is bound to the local oMLX provider; it
  never uses a bare model flag and never the interactive approval flag.

### No-cloud-fallback guardrail

Before launching, the runtime verifies configuration so a silent cloud fallback
is structurally impossible:

- the Pi path requires the `omlx` provider in `~/.pi/agent/models.json`;
- the Codex path requires the `frontier-omlx` profile and `omlx` provider in
  `~/.codex/config.toml`;
- both require the oMLX server at `http://127.0.0.1:8000/v1` to answer a health
  probe.

If any check fails, the runtime refuses and prints the exact next command
(`frontier-companion.mjs setup`).

## frontier-worker agent

`agents/frontier-worker.md` is a thin forwarder (model `haiku`, `Bash` only). It
makes exactly one call to the companion `task` subcommand and returns stdout
verbatim. It chooses `--harness pi` for research, review, summarization, and log
reduction, and `--harness codex` for implementation, patches, and tests. It adds
`--write` only when edits are explicitly allowed and prefers `--background` for
open-ended work. It never inspects the repository and never composes raw pi or
codex CLI strings.

## Commands

- `/frontier:delegate` — routes a request to `frontier-worker` and returns its
  output verbatim.
- `/frontier:status` — renders the companion `status` output as a compact table.
- `/frontier:result` — prints a finished job's output.
- `/frontier:cancel` — cancels a running job.
- `/frontier:setup` — runs the companion `setup` and, if the Codex profile is
  missing, surfaces the proposed TOML and offers to apply it with `--apply-codex`.

## Job state

Job records live outside the repository under Claude Code's
`CLAUDE_PLUGIN_DATA/state/<workspace>/jobs/` directory, with an OS temp
fallback for direct CLI use. Each job has one JSON record plus
`stdout`/`stderr` logs. Each record stores the harness, model, prompt excerpt,
status (`running`/`completed`/`failed`/`cancelled`), timestamps, cwd, pid,
Claude Code session id when available, and the path to the result.

## Prerequisites

These CLIs must be on PATH: `omlx`, `pi`, `codex`. Start the oMLX server with
`omlx start` (or `omlx serve <model>`) before delegating. `omlx launch <tool>` is
an interactive configure-and-launch TUI; run it manually if you want it — the
plugin never invokes it.
