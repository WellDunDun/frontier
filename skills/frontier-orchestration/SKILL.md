---
name: frontier-orchestration
description: Orchestrate Claude Code work with Fable as the frontier-model planner, reviewer, and synthesizer while local model workers handle bounded research, coding, testing, and log reduction through the Pi and Codex harnesses. Use when the user wants Fable, oMLX, Pi, Codex, local model delegation, or token-heavy codebase work coordinated through subagents.
---

# Frontier Orchestration

Use Fable for judgment. Use local model workers for bounded heavy lifting. The
point is not to maximize the number of agents; it is to spend the frontier model
on architecture, tradeoffs, integration, verification strategy, and final
synthesis, while delegating token-heavy scans, narrow patches, test runs, and
log reduction to local models.

## Quick Start

1. Decide what only Fable should own: ambiguity, architecture, risk, sequencing,
   cross-cutting edits, and final review.
2. Split token-heavy work into independent packets: repo scans, prior-art
   lookup, narrow patches, test runs, and log reduction.
3. Delegate each packet with `/frontier:delegate` (or the `frontier-worker`
   subagent). It routes the packet to a local model through a harness.
4. Integrate worker output centrally. Treat returned claims as evidence to
   verify, not as final truth.
5. Report the final answer from Fable with changed files, verification, and
   residual risk.

## Worker Selection

Delegation goes through `/frontier:delegate`, which forwards to the
`frontier-worker` subagent. The worker is a thin forwarder over a deterministic
companion runtime that owns all harness mechanics. You choose the harness by the
shape of the task:

- **Pi** for research, review, summarization, code reading, and log reduction.
- **Codex** for implementation, patches, refactors, and tests.

Both harnesses run against the same local oMLX-served model. Provider mechanics
live in the companion runtime, never in a prompt. Do not write harness command
strings in this skill or in any worker prompt.

## Handoff Packet

Every delegated task should be self-contained:

- repo path and objective;
- files, packages, or surfaces in scope;
- explicit out-of-scope areas;
- whether edits are allowed;
- expected return format: findings, patch, command output, line refs, failures,
  or uncertainty;
- verification command or success condition;
- stop conditions.

Good worker prompts are narrow enough that the worker can finish without asking
for context from the parent conversation.

## Stop Conditions

Tell workers to stop and report when:

- the repo does not match the handoff assumptions;
- the task needs files outside the assigned scope;
- a command fails twice after a reasonable retry;
- credentials, secrets, or external accounts are required;
- the worker cannot produce concrete evidence for its claim.

## Review Loop

Before presenting completion:

1. Reopen the important files the worker cited.
2. Inspect high-risk diffs directly.
3. Rerun or spot-check the meaningful verification.
4. Resolve disagreements between workers at the Fable layer.
5. Keep the final user-facing synthesis concise and evidence-backed.

## Guardrails

- Do not delegate the immediate blocker if Fable needs the answer before
  planning the next step.
- Do not ask multiple workers to edit the same files at the same time.
- Do not let a worker silently fall back from a local provider to a cloud model.
  The companion refuses to run when provider config is missing or the oMLX
  server is down; trust that refusal instead of working around it.
- Do not delegate destructive operations.
- Do not claim cost or speed savings when the task is tiny, serial, or judgment
  heavy.
