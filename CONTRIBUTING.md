# Contributing

Frontier is early-stage infrastructure for harness/model delegation across configured providers. Contributions are welcome when they keep the runtime deterministic, provider-safe, and easy to verify.

## Development

1. Use Node 20 or newer.
2. Install with `npm ci`.
3. Run `npm run check` before opening a pull request.
4. Validate the marketplace and plugin locally with `claude plugin validate .` and `claude plugin validate plugins/frontier` when changing commands, agents, hooks, skills, or plugin manifests.

## Architecture Rules

- Keep provider and harness mechanics in `plugins/frontier/scripts/frontier-companion.mjs` and `plugins/frontier/scripts/lib/*`.
- Keep command, agent, and skill markdown free of raw provider CLI composition.
- Preserve the provider-fallback guardrails. A missing selected provider, profile, model, or backend should fail closed with an actionable message.
- Do not commit generated job state, local agent worktrees, credentials, or machine-specific paths.

## Pull Requests

Include:

- a short explanation of the behavior change;
- tests or a clear reason tests are not applicable;
- the validation commands you ran.

By contributing, you agree that your contribution is licensed under the Apache License, Version 2.0.
