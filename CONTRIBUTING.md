# Contributing

Frontier is early-stage infrastructure for local-model delegation from Claude Code. Contributions are welcome when they keep the runtime deterministic, provider-safe, and easy to verify.

## Development

1. Use Node 20 or newer.
2. Install with `npm ci`.
3. Run `npm run check` before opening a pull request.
4. Validate the plugin locally with `claude plugin validate .` when changing commands, agents, hooks, skills, or plugin manifests.

## Architecture Rules

- Keep provider and harness mechanics in `scripts/frontier-companion.mjs` and `scripts/lib/*`.
- Keep command, agent, and skill markdown free of raw provider CLI composition.
- Preserve the no-cloud-fallback guardrails. A missing local provider, profile, model, or server should fail closed with an actionable message.
- Do not commit generated job state, local agent worktrees, credentials, or machine-specific paths.

## Pull Requests

Include:

- a short explanation of the behavior change;
- tests or a clear reason tests are not applicable;
- the validation commands you ran.

By contributing, you agree that your contribution is licensed under the Apache License, Version 2.0.
