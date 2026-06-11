---
description: Print the final output of a finished Frontier delegation job
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" result "$ARGUMENTS"`

Present the command output to the user as-is. Do not summarize or condense it.
If the job is still running, relay the guidance to check `/frontier:status`
and retry once it finishes.
If the user omitted a job id, the command safely defaults to the latest finished
job from the current Claude Code session.
