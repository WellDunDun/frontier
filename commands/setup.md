---
description: Check whether the local Frontier harnesses (oMLX, Pi, Codex) are ready, and optionally provision the Pi provider and Codex profile
argument-hint: "[--apply]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" setup $ARGUMENTS
```

Present the setup output to the user. The report shows the detected backend
flavor, base URL, models found on the server, the active model, whether Codex is
supported, and the readiness of the Pi provider and Codex profile.

If the report says the local server is not reachable:
- Relay the guidance to start it: `omlx start` (or `omlx serve <model>`).
- Provisioning needs the server up so models are read from it; do not apply
  while it is unreachable.

If the report says the Pi provider or the Codex profile is missing and the
request did not already include `--apply`:
- Surface the proposed Codex TOML block from the output.
- Use `AskUserQuestion` exactly once to ask whether to provision now. Put the
  apply option first:
  - `Provision Pi + Codex (Recommended)`
  - `Skip for now`
- If the user chooses to apply, rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" setup --apply
```

- `--apply` provisions BOTH harnesses additively: it ensures the Pi provider
  entry exists in `~/.pi/agent/models.json` and the Codex provider/profile exist
  in `~/.codex/config.toml`, taking a timestamped backup before any write and
  preserving unrelated entries. The model is resolved from the live server, so
  no model id is hardcoded. Relay the final output, including any backup paths.
- `--apply-codex` still works as a backward-compatible alias for `--apply`.

If everything is already ready, do not ask anything — just present the report.
