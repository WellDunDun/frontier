---
name: frontier-orchestration
description: Orchestrate work with a frontier harness or model as planner, reviewer, and synthesizer while worker harnesses handle bounded research, coding, testing, and log reduction through adapters such as Pi and Codex. Use when the user wants Frontier, harness orchestration, provider-backed delegation, Pi, Codex, oMLX, Ollama, OpenAI-compatible models, or token-heavy codebase work coordinated through subagents.
---

# Frontier Orchestration

Use the frontier orchestrator for judgment. Use worker harnesses for bounded
heavy lifting. The point is not to maximize the number of agents; it is to spend
the strongest planning/review model on architecture, tradeoffs, integration,
verification strategy, and final synthesis, while delegating token-heavy scans,
narrow patches, test runs, and log reduction to configured models and providers.

## Quick Start

1. Decide what the frontier orchestrator should own: ambiguity, architecture,
   risk, sequencing, cross-cutting edits, and final review.
2. Split token-heavy work into independent packets: repo scans, prior-art
   lookup, narrow patches, test runs, and log reduction.
3. Delegate each packet with `/frontier:delegate` (or the `frontier-worker`
   subagent). It routes the packet to a configured model through a harness.
4. Integrate worker output centrally. Treat returned claims as evidence to
   verify, not as final truth.
5. Report the final answer from the orchestrator with changed files,
   verification, and residual risk.

## Worker Selection

Delegation goes through `/frontier:delegate`, which forwards to the
`frontier-worker` subagent. The worker is a thin forwarder over a deterministic
companion runtime that owns all harness mechanics. You choose the harness by the
shape of the task:

- **Pi** for research, review, summarization, code reading, and log reduction.
- **Codex** for implementation, patches, refactors, and tests.

Each harness runs against the model/provider selected by backend configuration.
That can be local or cloud. Provider mechanics live in the companion runtime,
never in a prompt. Do not write harness command strings in this skill or in any
worker prompt.

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
4. Resolve disagreements between workers at the orchestrator layer.
5. Keep the final user-facing synthesis concise and evidence-backed.

## Guardrails

- Do not delegate the immediate blocker if the orchestrator needs the answer
  before planning the next step.
- Do not ask multiple workers to edit the same files at the same time.
- Do not let a worker silently fall back to an unintended provider or model.
  The companion refuses to run when selected provider config is missing or the
  configured backend is unreachable; trust that refusal instead of working
  around it.
- Do not delegate destructive operations.
- Do not claim cost or speed savings when the task is tiny, serial, or judgment
  heavy.
