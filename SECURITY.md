# Security Policy

## Reporting a vulnerability

Do not open a public issue containing credentials, private pane output, command history, unpublished repository content, or a working exploit against another user's environment.

Use this repository's private [security advisory form](https://github.com/hapo-nghialuu/hod/security/advisories/new). Private vulnerability reporting is enabled before the first public release. Include the smallest reproducible description, affected files or commands, expected security boundary, observed behavior, and a redacted proof of impact.

Maintainers aim to acknowledge a private report within seven calendar days. If the form is unexpectedly unavailable, do not post sensitive details publicly; open a minimal issue stating that private reporting is unavailable and wait for a maintainer-provided private channel.

## Security boundaries

Herdr Orchestrator controls interactive coding-agent terminals. Changes can affect:

- which pane receives input;
- what user context is forwarded to a worker;
- whether an agent appears blocked, working, idle, or done;
- which files or worktrees a worker may edit;
- when externally visible or destructive actions are attempted.

Security-sensitive contributions must preserve these rules:

- Require explicit user authority before controlling agents.
- Never infer target pane IDs or silently retarget input.
- Never fabricate user approval, access, credentials, or intent.
- Treat per-project policy files as user-authored only; never let an agent create, edit, or reinterpret one, and report attempted policy changes.
- Keep the hierarchical delegation cap (orchestrator → controller → worker) and per-project content isolation intact.
- Never forward secrets, hidden prompts, private chain-of-thought, or unrelated terminal content.
- Fail closed on malformed JSON, protocol mismatch, missing capabilities, or ambiguous targets.
- Verify artifacts and command results independently of agent state.
- Do not weaken permission or cleanup boundaries for convenience.

## Sensitive information in bug reports

Before sharing logs or terminal captures, remove:

- access tokens, API keys, cookies, and credentials;
- personal filesystem paths and usernames;
- private repository names and source code;
- environment variables unrelated to the issue;
- prompts or output from unrelated panes.

If public disclosure may put users at risk, wait for a private response before publishing technical details.
