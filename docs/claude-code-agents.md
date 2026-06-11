# Frontier Plugin Architecture

Frontier lets a frontier harness or model delegate bounded work to configured
worker harnesses, models, and providers. The current plugin surfaces expose this
through Claude Code/Codex commands and a thin Claude Code subagent, while all
harness mechanics live in one deterministic runtime.

## Companion runtime

`plugins/frontier/scripts/frontier-companion.mjs` is the single source of truth for provider and
CLI mechanics. Subcommands:

- `task [--harness pi|codex] [--write] [--model <m>] [--background] [--timeout-ms <n>] "<prompt>"`
  — run a bounded sub-task on the configured model/provider. The prompt may also
  arrive on stdin. Default harness is `pi`. Read-only unless `--write` is given.
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

- **Pi**: `pi --provider <selected-provider> --no-session --mode json --print`
  plus `--exclude-tools edit,write` when read-only, and an explicit `--model`
  resolved from the selected backend.
- **Codex**: `codex exec --ephemeral --skip-git-repo-check --sandbox <read-only|workspace-write>
  --profile <selected-profile> --output-last-message <file> --json`. Codex
  always runs under the selected backend profile; it never uses a bare model flag
  and never the interactive approval flag.

### Provider fallback guardrail

Before launching, the runtime verifies configuration so an implicit provider
fallback is structurally impossible:

- the Pi path requires the selected provider in `~/.pi/agent/models.json`;
- the Codex path requires the selected profile/provider in `~/.codex/config.toml`;
- both require the configured backend endpoint to answer a health probe.

Cloud providers are valid when selected explicitly in backend configuration; the
guardrail blocks accidental fallback to a different provider or model.

If any check fails, the runtime refuses and prints the exact next command
(`frontier-companion.mjs setup`).

## frontier-worker agent

`plugins/frontier/agents/frontier-worker.md` is a thin forwarder (model `haiku`, `Bash` only). It
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

These CLIs must be on PATH: `pi`, `codex`, and `node`. The `omlx` CLI is
required only when the selected backend flavor is oMLX. Before delegating, make
the selected backend reachable: start oMLX, start Ollama, or configure a reachable
OpenAI-compatible endpoint. `omlx launch <tool>` is an interactive
configure-and-launch TUI; run it manually if useful — the plugin never invokes it.
