# Contributing

Focused issues and pull requests are welcome. Preserve the project's core contract: explicit user authority, direct user-agent conversation, deterministic capability checks, conservative lifecycle handling, and evidence-backed completion.

## Before proposing a change

1. Read `SKILL.md` and the reference closest to the behavior you want to change.
2. Confirm the behavior against current stable Herdr leaf command help.
3. Keep the change within one clear problem; avoid unrelated cleanup.
4. Explain any compatibility impact on Codex, Claude Code, and Grok Build.

## Local validation

Run the repository-local validation entrypoints:

```bash
./scripts/validate.sh
./scripts/test-hod.sh
```

`validate.sh` checks Bash syntax, required skill frontmatter (including the name format and the 1024-character description limit), and local Markdown targets without third-party Python packages. `test-hod.sh` runs the CLI's behavioral tests inside a disposable temporary workspace. The matching GitHub Actions workflow (`.github/workflows/validate.yml`) remains available for manual runs on Ubuntu and macOS; automatic push and pull-request runs are temporarily paused, so contributors must run both commands locally before proposing a change.

For HOD UI changes, run the zero-dependency Node checks as well:

```bash
npm --prefix ui test
npm --prefix ui run check
./scripts/test-hod.sh
./scripts/validate.sh
```

The UI tests include real loopback HTTP/SSE coverage and real Unix-socket Herdr transport cases. `npm --prefix ui run check` syntax-checks the server and frontend modules; `npm --prefix ui test` exercises the runtime, transcript, settings, security, and frontend contracts. Keep UI tests honest: do not replace loopback or Unix-socket cases with mocks merely to make a check pass.

For a release, also validate with the official Codex `skill-creator` validator when it is installed. The validator requires PyYAML; create an isolated environment instead of modifying the system Python:

```bash
python3 -m venv .venv
.venv/bin/pip install PyYAML
.venv/bin/python "$SKILL_CREATOR_DIR/scripts/quick_validate.py" .
```

Set `SKILL_CREATOR_DIR` to the installed `skill-creator` directory documented by your Codex installation. The repository does not assume a machine-specific global skill path.

Do not include credentials, personal configuration, or real private repository content in fixtures or reports.

## Pull requests

Include:

- the user-facing problem;
- the smallest implemented solution;
- files and behavior changed;
- exact commands and results;
- compatibility or security considerations;
- unresolved limitations.

Use conventional commit subjects such as `feat:`, `fix:`, `refactor:`, or `test:`. Documentation-only changes may use `docs:` outside a repository policy that prohibits it.

## Documentation changes

Keep human documentation in `README.md` and `docs/`. Keep agent-operational instructions in `SKILL.md` and `references/`. Avoid copying the same detailed procedure into both surfaces; link to the canonical explanation instead.
