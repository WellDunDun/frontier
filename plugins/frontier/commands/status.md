---
description: Show active and recent Frontier delegation jobs for this repository
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job id:
- Render the command output as a single compact Markdown table of jobs in this
  repository (job id, harness, status, duration, summary).
- Do not add prose outside the table.

If the user did pass a job id:
- Present the full command output as-is. Do not summarize or condense it.
