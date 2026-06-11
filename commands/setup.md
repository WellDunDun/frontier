---
description: Check whether the local Frontier harnesses (oMLX, Pi, Codex) are ready, and optionally apply the Codex profile
argument-hint: "[--apply-codex]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" setup $ARGUMENTS
```

Present the setup output to the user.

If the report says the oMLX server is not reachable:
- Relay the guidance to start it: `omlx start` (or `omlx serve <model>`).

If the report says the Codex `frontier-omlx` profile is missing and the request
did not already include `--apply-codex`:
- Surface the proposed TOML block from the output.
- Use `AskUserQuestion` exactly once to ask whether to apply it now. Put the
  apply option first:
  - `Apply Codex profile (Recommended)`
  - `Skip for now`
- If the user chooses to apply, rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" setup --apply-codex
```

- The apply path backs up `~/.codex/config.toml` first and only appends the
  entries if absent. Relay the final output, including the backup path.

If everything is already ready, do not ask anything — just present the report.
