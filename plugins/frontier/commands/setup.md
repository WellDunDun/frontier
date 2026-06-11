---
description: Check whether the selected Frontier backend and harness adapters are ready, and optionally provision the Pi provider and Codex profile
argument-hint: "[--apply]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" setup $ARGUMENTS
```

Present the setup output to the user. The report shows the detected backend
flavor, base URL, how the flavor was selected (the auto-detect ladder or a config
file), models found on the server, the active model, whether Codex is supported,
and the readiness of the Pi provider and Codex profile.

The backend flavor is chosen by an auto-detect ladder — oMLX first (its settings
file exists or the server answers on `127.0.0.1:8000`), then Ollama (the server
answers on `127.0.0.1:11434`) — unless a `frontier.config.json` (workspace) or
`~/.frontier/config.json` (user) selects a flavor explicitly. The `openai` flavor
(any OpenAI-compatible server) is config-only and never auto-detected; it requires
`baseUrl` in the config. The report's "key source" line shows where auth comes from
(env / file / literal / none) and never prints the secret value.

If the report errors out because a config file is malformed JSON or names an
unknown flavor, relay the message verbatim — it identifies the offending file and
what to fix.

If the report says Codex is unsupported on the backend (the server does not serve
`/v1/responses`, as with a vanilla Ollama install):
- The Codex harness is disabled for that backend; the Pi harness still works.
- Relay the guidance to use `--harness pi`, or to point Frontier at a backend
  that exposes the OpenAI Responses API. Do not offer to provision the Codex
  profile in this case.

If the report says the backend endpoint is not reachable:
- Relay the backend-specific guidance from the setup output. For oMLX that means
  starting oMLX; for Ollama, start Ollama and make a model available; for an
  explicit OpenAI-compatible backend, fix the configured URL/auth or start that
  service.
- Provisioning needs the backend reachable so models are read from it; do not
  apply while it is unreachable.

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

- `--apply` provisions BOTH harnesses additively: it ensures the selected Pi
  provider entry exists in `~/.pi/agent/models.json` and the selected Codex
  provider/profile exist in `~/.codex/config.toml`, taking a timestamped backup
  before any write and preserving unrelated entries. The model is resolved from
  the configured backend, so no model id is hardcoded. Relay the final output,
  including any backup paths.
- `--apply-codex` still works as a backward-compatible alias for `--apply`.

If everything is already ready, do not ask anything — just present the report.
