---
description: Cancel a running Frontier delegation job
argument-hint: "<job-id>"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" cancel "$ARGUMENTS"`

Present the command output to the user as-is. Do not summarize or condense it.
