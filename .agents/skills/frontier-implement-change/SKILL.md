---
name: frontier-implement-change
description: Implement Frontier repository features or bug fixes. Use when changing the companion runtime, backend resolution, harness execution, Claude commands, agents, hooks, shipped plugin skills, docs, or tests.
---

# Frontier Implement Change

Use this skill for feature work and bug fixes in Frontier.

## Workflow

1. Read `AGENTS.md` first, then read the files and tests for the touched
   surface.
2. Identify the behavior boundary: backend resolution, harness config, runner
   preflight, setup rendering, job state, command markdown, agent forwarding,
   hook behavior, or plugin skill behavior.
3. Add or update tests before implementation when behavior changes. Use temp
   homes, fake binaries, mocked `fetch`, and local servers; do not depend on a
   real configured backend.
4. Implement in `plugins/frontier/scripts/lib/*` or
   `plugins/frontier/scripts/frontier-companion.mjs` when the change is runtime
   behavior. Keep commands, agents, and shipped skills thin.
5. Run targeted tests from the `AGENTS.md` matrix, then run `npm run check`.
6. If commands, agents, hooks, shipped plugin skills, or packaging assets
   changed, also run `claude plugin validate .` and
   `claude plugin validate plugins/frontier` when available.

## Guardrails

- Preserve the no-implicit-provider-fallback invariant.
- Never print secret values; report sources only.
- Never write to real user config from tests.
- Never compose raw Pi or Codex CLI strings in command, agent, or skill
  markdown.
- Keep setup provisioning additive and backed up.
- Keep job state out of the workspace when `CLAUDE_PLUGIN_DATA` is available.

## Output

When done, report changed files, verification commands, and any residual risk.
