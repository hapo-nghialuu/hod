# Operations

Executable recipes and recovery procedures for the rules in `SKILL.md`. The
installed leaf help remains the only syntax authority — these are confirmed
shapes, not a substitute for `--help`.

## Confirm the modern command family

Inspect every relevant leaf with read-only help commands before first use:

```bash
herdr agent start --help;  herdr agent prompt --help
herdr agent send-keys --help;  herdr agent wait --help
herdr agent get --help;  herdr agent read --help;  herdr agent explain --help
herdr pane split --help;  herdr pane run --help;  herdr pane wait-output --help
```

Use the modern flow only when help confirms all of these forms:

```text
agent start <name> --kind KIND --pane ID
agent prompt <target> <text>
agent send-keys <target>
agent wait <target> [--until STATUS]
```

A group listing proves only that a subcommand exists; require the matching leaf
help to prove its signature.

## Adaptive mode: bounded recipes

Use these short recipes only after the user opts into adaptive mode. The
normative rules, gates, and exceptions are in
[Adaptive Coordinator with Tripwire Escalation](coordinator-advisor.md); do not
recreate that reference in an operations packet.

### R0 before a dispatch or overlay

For a worker dispatch, `CONSULT`, `ASK_USER`, or an existing checkpoint, record
the smallest useful envelope before acting:

```text
ROUTE_VERSION: 1
BASE_MODE: SINGLE | ORCHESTRATE
FACTS: <at most three>
HARD_TRIGGERS: none | <IDs>
UNCERTAINTY: none | <route-changing unknown>
NEXT: dispatch | read-only-scout | consult | ask-user
```

Do not print or persist this envelope for a clear `DIRECT` answer.

### E0 receipt capture

For every repository-changing task, capture fresh values from Git and the
actual check process. A bounded shell inspection can establish the revision
and changed paths; run verbose checks in a pane with a fresh sentinel:

```bash
base_sha=$(git rev-parse HEAD)
head_sha=$(git rev-parse HEAD)
changed_paths=$(git diff --name-only "$base_sha" --)
diff_sha=$(git diff --binary "$base_sha" -- | shasum -a 256 | awk '{print $1}')
sentinel="VERIFY_$(date +%s)_$RANDOM"
herdr pane run "$check_pane" "<check>; rc=\$?; printf '%s exit=%s\\n' '$sentinel' \"\$rc\""
herdr pane wait-output "$check_pane" --match "$sentinel" --timeout 600000
herdr pane read "$check_pane" --source recent-unwrapped --lines 120
git status --short
```

Fill the E0 fields from those outputs, not from a worker's prose. An absent
sentinel, unknown exit, changed revision, ownership conflict, or stale artifact
is `HOLD` and requires a new capture.

### External checkpoint and handoff

Create the checkpoint outside the checkout only when the reference requires
one:

```bash
checkpoint_dir=$(mktemp -d "${TMPDIR:-/tmp}/hod-adaptive.XXXXXX")
checkpoint_path="$checkpoint_dir/checkpoint.md"
```

Record the absolute path in the handoff. Only the active coordinator writes
bounded metadata there; workers and advisors do not. On resume, reconcile
Herdr state, Git state, actual artifacts, and a fresh E0 receipt before any
dispatch. If the external path is not writable, do not broaden the sandbox or
fall back into the checkout: use a fresh independent R0, otherwise `HOLD +
ASK_USER`. Retain the directory until the user authorizes cleanup.

### Permission prompts

Start Claude with the existing role profile and inspect any residual dialog in
the pane. A pre-allow or one-time approval is valid only for the exact action
covered by an exact user authority reference. Missing or ambiguous authority,
generic shell access, wildcard expansion, or a broader relaunch is `HOLD +
ASK_USER`. Never use a dangerous permission bypass or an approval loop. For
Codex, use only sandbox and approval flags confirmed by installed help; a
sandbox failure is evidence to inspect, not permission to widen capability.

## Start a worker

```bash
split_json=$(herdr pane split --current --direction right --cwd "$PWD" --no-focus)
worker_pane=$(printf '%s\n' "$split_json" | jq -er '.result.pane.pane_id')

# Implementer continuing its previous session, with the impl boundary:
herdr agent start impl --kind claude --pane "$worker_pane" \
  -- --continue --settings .claude/settings.impl.json

# Reviewer: always a fresh session — no --continue, no --resume:
herdr agent start reviewer --kind claude --pane "$p2" \
  -- --settings .claude/settings.reviewer.json --model <model-id>
```

Split right for a wide pane, down for a tall one. `agent start` requires an
existing available shell pane; it does not create topology. Native agent
arguments go only after `--`. Role names match `[a-z][a-z0-9_-]{0,31}`
(`api_impl`, `tester`, `reviewer`); Herdr requires unique live agent names.

Model flags per CLI (resolve exact IDs from the installed CLI, e.g.
`grok models`, `claude --help`, `codex --help` plus its `config.toml`):

```bash
herdr agent start planner --kind codex --pane "$p1" \
  -- -m <codex-model-id> -c model_reasoning_effort=<low|medium|high|max>
herdr agent start impl --kind grok --pane "$p2" -- -m <grok-model-id>
```

## Submit, confirm delivery, recover a stall

```bash
herdr agent prompt api_impl "$task_prompt" --wait --timeout 120000
```

Per the installed help, `--wait` from a non-working state requires an observed
state change shortly after submission; `agent_prompt_stalled` means none
occurred — the prompt never entered the agent. Reading your own prompt back
from the pane and reporting it as a result fabricates a completion that never
ran. Recover in order:

1. Confirm the target and that the agent is the pane's foreground process.
2. Read the pane; your prompt visible in the input box confirms the stall.
3. Submit it (`agent send-keys <target> enter`) or re-prompt.
4. Confirm the agent actually left its pre-submission state — a settled
   `agent wait` or a changed `agent_status` in `agent get` — before treating
   anything on that screen as the worker's work.

`agent send-keys` is for interactive controls only (enter, esc, ctrl+c); never
rebuild prompt submission from raw text and key events.

## Wait, read, and redirect

```bash
herdr agent wait api_impl --timeout 120000
herdr agent get api_impl
herdr agent read api_impl --source recent-unwrapped --lines 160
```

Without `--until`, a wait settles on `idle`, `done`, or `blocked`; pass
`--until` only to demand one specific state, and request `unknown` explicitly.
On `unknown`, read the output and run `herdr agent explain <target> --verbose`;
never assume completion. Prefer bounded waits; never blind-poll in a tight
loop or abandon a task because one wait timed out.

Redirect with a follow-up `agent prompt` in direct-user voice carrying the new
evidence or corrected constraint; do not restart an agent when a follow-up
suffices. Use `esc`/`ctrl+c` only for a deliberate, in-scope interruption, and
re-read state afterwards. After an agent exits, refresh `agent list`; never
silently retarget work to a different pane.

## Sentinel-guarded checks

`pane wait-output` searches text already present before it waits, so a generic
match like `passed` from a reused pane proves nothing. For each finite command:

```bash
sentinel="VERIFY_$(date +%s)_$RANDOM"
herdr pane run "$check_pane" "make test; printf '%s exit=%s\n' \"$sentinel\" \"\$?\""
herdr pane wait-output "$check_pane" --match "$sentinel" --timeout 600000
herdr pane read "$check_pane" --source recent-unwrapped --lines 120
```

Use a fresh sentinel per run, and verify both the result and the captured exit
status. For a long-running server, emit a run-specific startup token and
separately verify the process stays alive. `pane run` executes without an
agent, so the output is first-hand evidence and the transcript stays out of
the controller's context.

## Task packet shape

```text
<Concrete outcome in direct-user voice>

Work context: <absolute repository or worktree path>
Files you may modify: <exact paths or globs, or "none; read-only">
Files to read: <specific files>
Dependency inputs: <established interfaces, decisions, or artifacts>
Acceptance criteria:
- <observable behavior or artifact>
- <required compile, lint, test, or review evidence>

Constraints:
- Preserve unrelated changes.
- Stay within file ownership and user authority.
- Do not start other coding agents.

When finished, state the outcome, files changed, commands run, test results,
and unresolved questions.
```

State whether an input is verified, inferred, or worker-reported when the
distinction matters.

## Revive a previous session

Most agent CLIs can reload a transcript at startup — Claude Code takes
`--continue` (latest in that directory) or `--resume` (pick one); pass the
flag after `--`. Use revival only when the same role resumes the same work and
its earlier context outweighs the tokens to rebuild it. Never for review or
audit. Record in the ledger that a session was resumed, and from which task,
so a later reader can tell an independent pass from a continued one.

## Worktree checklist

For each worktree: record its absolute path and branch in the ledger; start
its worker with that worktree as the working context; keep ownership disjoint
across worktrees too; avoid broad formatting or generated-file rewrites
outside ownership; commit only when the user or repository workflow authorizes
it; preserve a traceable diff for integration.

## Integrate through one owner

1. Confirm prerequisite workers are settled and their evidence is readable.
2. Inspect each actual diff and artifact before accepting it.
3. Resolve interface mismatches and ownership conflicts (via the integrator
   worker — the controller states the intended outcome, it does not edit).
4. Bring approved changes into the target checkout using the repository's
   permitted workflow.
5. Run validation against the integrated state, not isolated worker states.
6. Request independent read-only review for material code changes.

Worker completion does not transfer ownership; update the ledger before asking
another worker to modify an already-owned file.

## Recover missing full-screen output

Alternate-screen agents may not retain old rows. First enlarge the pane or
read the visible screen. If transcript recovery still fails and existing
authority already permits a report write, allocate one task-scoped temporary
directory and one exact Markdown path, and accept only that exact regular
file: reject substitutions, symlinks, and paths outside the directory. If the
worker was read-only and no written report was authorized, ask the user before
expanding its role. Retain the file for inspection unless cleanup is
authorized.
