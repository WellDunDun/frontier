---
description: Cancel a running Frontier delegation job
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" cancel "$ARGUMENTS"`

Present the command output to the user as-is. Do not summarize or condense it.
If the user omitted a job id, the command cancels only when exactly one active
job exists in the current Claude Code session; otherwise it asks for a job id.
