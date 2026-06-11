---
description: Delegate a bounded sub-task to a configured model/provider through the Pi or Codex harness
argument-hint: "[--harness pi|codex] [--write] [--background] [--model <m>] [what the worker should do]"
allowed-tools: Bash(node:*)
---

Route this request to the `frontier:frontier-worker` subagent.
The final user-visible response must be the worker's output verbatim.

Raw user request:
$ARGUMENTS

Operating rules:

- The subagent is a thin forwarder. It makes one `Bash` call to
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" task ...` and
  returns that command's stdout as-is.
- Return the companion stdout verbatim. Do not paraphrase, summarize, rewrite,
  or add commentary before or after it.
- Routing default: use `--harness pi` for research, review, summarization, and
  log reduction; use `--harness codex` for implementation, patches, and tests.
  Honor an explicit harness in the request over this default.
- Pass `--write` through only if the request explicitly allows edits.
- Pass `--background`, `--model`, and `--timeout-ms` through only if present in
  the request.
- Do not ask the subagent to inspect files, poll `/frontier:status`, fetch
  `/frontier:result`, call `/frontier:cancel`, or do follow-up work of its own.
- If the request is empty, ask what the worker should do.
- If the companion reports that the configured backend is unreachable or a
  provider profile is missing, stop and tell the user to run `/frontier:setup`.
