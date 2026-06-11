# Security Policy

Frontier shells out to local harnesses and can optionally write to a workspace when a delegation uses `--write`. Security issues in this repo should be treated as runtime and credential-boundary issues, not only web vulnerabilities.

## Reporting

Please report suspected vulnerabilities privately through GitHub Security Advisories for this repository. Do not open a public issue for a vulnerability until there is a fix or mitigation.

If GitHub Security Advisories are not available, open a minimal issue asking for a private contact path without including exploit details.

## Scope

High-priority issues include:

- leaking API keys, model provider tokens, or local credential file contents;
- bypassing the local-provider guardrails and silently falling back to a cloud provider;
- command injection through slash-command arguments, backend config, model names, or job ids;
- unintended writes when a task did not request `--write`; and
- reading or persisting sensitive local files outside documented config paths.

## Supported Versions

Only the current `main` branch is supported until the project starts publishing tagged releases.
