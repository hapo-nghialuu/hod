# Usage Guide

This guide focuses on how to request and steer work. The controller owns
intent, planning, routing, authority, worker lifecycle, integration, and
evidence collection; for orchestration, the `hod` CLI owns only deterministic
dispatch guards.

## Request template

Provide the outcome, work context, constraints, and proof requirements:

```text
Use Herdr and the herdr-orchestrator skill to <concrete outcome>.

Work context: <repository path or project name>
Requirements:
- <observable behavior>
- <compatibility or scope boundary>

Execution constraints:
- Read repository instructions before editing.
- Preserve unrelated changes.
- Do not commit, merge, push, publish, or clean up unless explicitly requested.

Verification:
- Run <compile/lint/test commands, if known>.
- Use an independent read-only reviewer for material changes.
- Return changed files, command results, warnings, and unresolved questions.
```

You do not need to specify every worker. Explicit routing is useful only when a
particular CLI, model, or independent perspective is a real requirement.

## Guarded topology dispatch

In the HOD workflow, create a child only through the public guarded command.
`hod dispatch start` requires a non-empty direct-user prompt on stdin and this
exact flag shape:

```text
hod dispatch start --name <unique> --role worker|advisor|reviewer|tester \
  --task <safe-slug> --run <safe-id> --kind <kind> --cwd <absolute> \
  --direction right|down --timeout <ms> \
  [--advisor-choice fable|gpt-5.6-sol|opus --advisor-model <same>] -- [native args...]
```

Example:

```bash
project_cwd="$(pwd -P)"
printf '%s\n' 'Implement the health endpoint and return changed files and test results.' |
  hod dispatch start --name health-worker --role worker \
    --task health-endpoint --run run-demo-001 --kind claude \
    --cwd "$project_cwd" --direction right --timeout 120000 -- \
    --settings .claude/settings.impl.json
```

The guard binds and reads back the controller, splits, binds and reads back the
child, starts it, refreshes and reads it back, and only then submits the
prompt. Success prints a JSON receipt containing `pane_id`, `name`, `role`,
`relation`, `task`, and `run`. Relations map `worker=delegate`,
`advisor=consult`, and `reviewer=tester=verify`.
Advisor start additionally requires explicit matching
`--advisor-choice`/`--advisor-model` values and exactly one matching native
`-m` or `--model`; `fable`/`opus` require `--kind claude`, while
`gpt-5.6-sol` requires `--kind codex`; the receipt records
`requested_model` and `runtime_model_verified=false`, not an observed runtime
model. Without a user choice, use `HOLD + ASK_USER`, not a default. Advisor,
reviewer, and tester starts use a positive native-argument allowlist: no root
subcommands, native cwd/system-prompt changes, inline tool grants, or
non-read-only boundary overrides. Use file-based Claude settings, canonical
Codex `-s read-only -c features.multi_agent=false`, or Grok `--sandbox
read-only` plus deny rules. Referenced settings and ambient CLI configuration
remain trusted user inputs rather than content HOD inspects. Herdr 0.8 start/get/prompt success requires
the exact identity (including launch terminal), boolean readiness, an allowed
`agent_status`, and an advancing safe `state_change_seq`; NUL-containing stdin
and prompts above 131072 bytes are rejected before mutation. `--timeout` is an
overall wall-clock deadline through probes, locking, metadata, lifecycle calls,
and delivery; failure cleanup has a separate hard three-second cap. When start/get has not exposed a session yet, the first delivery
is bound by terminal and sequence. Codex additionally waits for its real prompt
surface, then delivery targets the unique agent name; a sessionless receipt is
valid only in `working` or `blocked`. Redirects require a later authoritative
non-empty, exact session.
Start bootstraps only an untagged controller pane; an existing controller must
match the requested `hod_run`, and child/partial/invalid HOD tokens fail before
report, split, start, or prompt. Prompt rejects advisor, pane-working,
authoritative-agent-working, and not-ready children before metadata reporting.

Redirect an existing child with a direct-user prompt on stdin:

```bash
printf '%s\n' 'Continue the task and report fresh verification.' |
  hod dispatch prompt --pane "$child_pane_id" --task health-follow-up \
    --kind claude --run run-demo-001 --timeout 120000
```

`hod dispatch prompt` refreshes and validates before redirecting, including the
authoritative agent-get working-state check. Advisor redirect is rejected
because every consult is a fresh start. Raw `herdr pane split`, `herdr agent
start`, and `herdr agent prompt` remain valid for deliberately untracked work;
those panes may appear `UNMAPPED` and carry no HOD lifecycle guarantee. Never
mix raw mutations with an active HOD dispatch on the same pane. An old Herdr missing the
exact capability fails before split; there is no fallback. After updating HOD,
restart or reload long-lived controller sessions so they load the new
instructions — HOD cannot retrofit instructions already loaded in a running
session.

Dispatches for one coordinator are serialized. Redirect binds the explicitly
expected kind, agent name, workspace, terminal identity, agent-session
identity, and state sequence across its authoritative reads. A verified failure
before any agent-start attempt closes only the freshly split child after an
exact cleanup readback of pane/workspace/cwd/terminal and empty agent/session.
A change visible at that read makes HOD leave it open and fail closed. Herdr
0.8 has no owner-CAS for the following close or metadata write, so an outside
mutation in that final interval remains a race; never mix raw lifecycle
operations with an active HOD dispatch. Pre-delivery failures restore staged
metadata when possible; ambiguous lifecycle attempts are never auto-retried.
HOD never intentionally closes an unproven or already-started pane.

## Adaptive coordinator (opt-in)

Ask for adaptive behavior explicitly. Without that opt-in, the normal workflow
and its existing small-task path stay in effect. Adaptive mode selects one
base mode and may add an overlay:

Before a worker dispatch or overlay, the coordinator records a bounded R0 only
when structured routing is needed. It classifies the unknown, chooses the risk
level, and may use at most one read-only scout when that observation can change
the route. Plain `DIRECT` remains ceremony-free.

### `DIRECT`

Use it for a question, explanation, read-only inspection, or status check:

```text
Use Herdr and the herdr-orchestrator skill in adaptive coordinator mode to
explain this retry path from the current source. Keep the work read-only;
return the evidence and unresolved questions.
```

There is no formal plan, worker, or external checkpoint for this fast path.

### `SINGLE`

Use it for one reversible outcome with one narrow owner:

```text
Use Herdr and the herdr-orchestrator skill in adaptive coordinator mode to add
the parser regression test in tests/parser.test.js. One writer owns that file,
do not commit or push, and return the fresh E0 receipt plus test results.
```

The coordinator sends one task packet. A repository change always receives E0;
an advisor is added only when you explicitly request one or a qualifying
technical trigger fires, and only after you explicitly choose exactly one of
`Fable`, `GPT-5.6 Sol`, or `Opus`. If it is unavailable, the coordinator holds
and asks instead of defaulting or substituting.

### `ORCHESTRATE`

Use it when ownership, dependencies, or phases require a working plan:

```text
Use Herdr and the herdr-orchestrator skill in adaptive coordinator mode to
implement the API and UI changes. Give each worker disjoint ownership,
document dependencies, use a working plan, and stop before integration if
ownership or evidence conflicts.
```

The coordinator registers ownership before dispatch and uses `HOLD` before any
tripwire re-route. A dependent task records the upstream input fingerprint and
stays stopped until its `READY_WHEN` condition holds; an upstream change makes
the dependent packet stale and forces re-routing before another dispatch. On
stale input: `HOLD` affected dependents, bump `PACKET_REVISION`, invalidate
stale `INPUT_FINGERPRINT`, `EVIDENCE_REF`, and gate verdicts, compute new
fingerprint, rerun R0, rerun applicable gates (G1 for plan/ownership/dependency/
criteria changes; E0 and G2 for repository output or review evidence changes),
and resume only after `READY_WHEN` is true on the new packet revision.

### Overlays: `CONSULT` and `ASK_USER`

Request a technical assessment without giving the advisor authority:

```text
Use Herdr and the herdr-orchestrator skill in adaptive coordinator mode and
consult a fresh advisor on this public API compatibility choice. I choose
GPT-5.6 Sol; do not substitute if it is unavailable.
```

The other allowed advisor choices are `Fable` and `Opus`. Name exactly one
selected model in a real request; if it is unavailable, the coordinator holds
and asks you instead of defaulting or substituting.

Use `ASK_USER` for a permission, cost, credential, publication, external, or
irreversible decision:

```text
Use Herdr and the herdr-orchestrator skill in adaptive coordinator mode. Hold
before publishing the package. Show the exact target, scope, cost, and
rollback, then ask me; do not treat an advisor assessment as approval.
```

### One-fixture validation

For live protocol validation, use one disposable fixture root outside the
candidate checkout for every applicable scenario. Keep an immutable baseline,
use working copies with distinct ownership, and attach a fresh E0 receipt to
each revision. Do not create a fixture-local commit or use a production
repository. The fixture demonstrates routing and containment behavior; it is
not evidence for general pricing or model-comparison conclusions.

## Pattern 1: Small implementation

Keep one writer and one optional reviewer:

```text
Use Herdr to implement password-reset rate limiting.

Use one implementation writer. After tests pass, use one independent read-only
reviewer. Do not create parallel writers because the route and its tests share
files. Do not commit or push.
```

Expected sequence:

```text
Inspect → Implement → Test → Review → Final verification
```

## Pattern 2: Explicit heterogeneous team

```text
Use Herdr to implement the API change.

- Use Codex for implementation and give it ownership of src/api/**.
- Use Grok for tests and give it ownership only of tests/api/**.
- Use Claude as a read-only final reviewer.
- Run implementation and tests sequentially if the tests depend on unfinished
  interfaces.
- Do not let any worker start more coding agents.
```

The controller must verify each requested CLI exists. It must not silently
replace a user-selected kind.

## Pattern 3: Parallel independent tasks

```text
Use Herdr to handle two independent changes in parallel.

Workstream A owns packages/parser/**.
Workstream B owns packages/renderer/**.
The integration owner alone owns package manifests and lockfiles.
Use separate worktrees if checkout isolation is required. Inspect both diffs,
integrate through one owner, then run the complete repository test suite.
```

Parallelism is inappropriate when both paths need the same file, one consumes
the unfinished output of the other, or the task is too small to justify extra
coordination.

## Pattern 4: Feature plus production bug

```text
Use Herdr to coordinate two workstreams.

Feature work:
- Use branch feat/<feature> and an isolated worktree.
- Break the feature into verifiable milestones.

Bug work:
- Use branch fix/<bug> and an isolated worktree.
- Reproduce the bug before changing code.
- Capture the environment, steps, expected behavior, and actual behavior.

If both workstreams need shared core files, pause concurrent writing. Give the
shared fix to one owner, verify it, then update the dependent feature branch.
Do not merge or push without explicit approval.
```

## Pattern 5: Hierarchical portfolio

```text
Use Herdr and the herdr-orchestrator skill in hierarchical portfolio mode to
manage my active projects.

Projects:
- ~/work/agent-workspace/shop: finish the checkout retry fix, then run the
  full test suite.
- ~/work/agent-workspace/blog: upgrade the framework patch version and verify
  the build.

Read each project's policy in ~/.herdr-orc/projects/<slug>/policy.md before
delegating. Start one controller per project and batch questions that need my
decision. Do not commit or push anywhere.
```

Each project controller runs the same sequential pipeline as Pattern 1 inside
its own workspace. See
[Portfolio orchestration](portfolio-orchestration.md) for setup and
[Portfolio hierarchy and tiers](../references/portfolio-hierarchy.md) for the
operational contract.

## Model selection

`--kind` chooses the CLI executable; it does not choose the provider model.
Native model arguments are passed after Herdr's `--` separator. Each CLI has
its own flags — Codex separates the model from reasoning effort, while Grok and
Claude take a single model flag:

```bash
printf '%s\n' 'Implement the task and return fresh verification.' |
  hod dispatch start --name codex-worker --role worker --task codex-task \
    --run run-demo-001 --kind codex --cwd "$(pwd -P)" \
    --direction right --timeout 120000 -- \
    -m <codex-model-id> -c model_reasoning_effort=max
printf '%s\n' 'Run the requested tests and report their results.' |
  hod dispatch start --name grok-tester --role tester --task grok-tests \
    --run run-demo-001 --kind grok --cwd "$(pwd -P)" \
    --direction right --timeout 120000 -- -m <grok-model-id>
printf '%s\n' 'Review the current diff read-only and return findings.' |
  hod dispatch start --name claude-reviewer --role reviewer --task final-review \
    --run run-demo-001 --kind claude --cwd "$(pwd -P)" \
    --direction right --timeout 120000 -- --model <claude-model>
```

Name the exact model ID your CLI accepts, not a spoken shorthand. A phrase like
"codex gpt-5.6 max" is really a model ID (`-m gpt-5.6-sol`) plus a separate
reasoning setting (`-c model_reasoning_effort=max`); the controller cannot
reliably guess the split, so give both parts explicitly. If a CLI rejects the
model, the controller stops and asks you for the correct ID rather than
substituting another — so a wrong name costs one round trip, not a silent
downgrade. Find valid IDs with `grok models`, `codex --help`, `claude --help`,
or your `~/.codex/config.toml`.

Prefer project defaults when a repository already governs model selection;
omitting the flag lets each CLI use its configured default. Avoid hardcoding
model IDs in shared documentation unless the team intentionally pins them and
all users have access.

## Steering a running workflow

Use ordinary direct requests:

```text
Prioritize the production bug and pause feature implementation.
```

```text
Show the reproduction evidence before authorizing a code change.
```

```text
The test failed on Ubuntu 24.04 with this output: <relevant evidence>. Re-read
the affected files, fix only the demonstrated regression, and rerun the test.
```

```text
Keep both worktrees for inspection. Do not merge or clean them up.
```

```text
Run coordinator-only from now on: do not create or edit any file yourself.
Delegate every change to a worker, verify its diff and checks, and ask me
when a change seems too small to be worth a worker.
```

```text
Also run builds, tests, lint and packaging in a pane with `pane run` instead
of your own shell. Wait for a per-run sentinel, read the output back, and
report the real exit status — keep your own context for coordination.
```

The controller should redirect an existing worker with `hod dispatch prompt`
and new evidence rather than restart it or duplicate the original prompt; the
guard refreshes and validates the topology before sending it.

## Local HOD UI console

The optional HOD web console is for observing and making the narrowly scoped
settings changes described below. Launch it from the project you want to
inspect:

```bash
hod ui [--project <path>] [--port <0-65535>] [--no-open]
```

It supports macOS and Linux and requires Node.js 20 or newer. `--project` must
name an existing directory and defaults to the current working directory.
`--port` accepts an integer from `0` through `65535`; the default `0` asks the
OS to select a free port.

By default, the launcher asks macOS `open` or Linux `xdg-open` to open the
browser. `--no-open` prints a recovery URL instead, and the same URL is printed
if the browser opener fails. The URL contains a one-time sensitive `#token`
fragment. Use it only on the local machine; never share it, paste it into an
issue or chat, or write it to logs. The browser exchanges the fragment for a
local `HttpOnly; SameSite=Strict` cookie and clears the fragment from the
address bar. The bootstrap token is single-use, so a reused or expired URL
needs a fresh console launch.

### Global runtime-only observer

Use the directory-independent observer from any working directory:

```bash
hod start [--port <0-65535>] [--no-open] [--background]
hod stop [--force] [--timeout <ms>]
```

`hod start --project <path>` is rejected. `hod start` is detached by default,
loopback-only, and independent of the launch directory. It uses fixed port
`4317` unless `--port` overrides it. It does not
start or control Herdr agents. Its Settings view selects a current Herdr
project/space by workspace ID and supports confirmed settings mutations; the
server resolves the authoritative checkout without exposing project paths to
the browser. The existing `hod ui` and `hod ui --project` commands remain
unchanged.

`--background` is retained as a compatibility flag; `hod start` already forks
the process, writes `$HOD_HOME/run/start.pid` and a
redacted `$HOD_HOME/run/start.log` (mode `700` directory), and returns
immediately without holding the terminal. No tray or menu-bar icon is
created — it stays a headless background process. A `--background` call
while one is already running reports the existing PID instead of spawning a
second one. `hod stop` sends `SIGTERM`, polls for up to `--timeout` (default
`10000`ms), and only sends `SIGKILL` with `--force`; it is idempotent when
nothing is running, refuses a symlinked PID/log file, and never removes a PID
file that a newer `hod start --background` has since overwritten. The log
filter strips the one-time `#token` fragment and other credential-shaped
`key=value` pairs from both stdout and stderr before they reach disk.

### Local-only boundary

The server always binds `127.0.0.1`. It applies strict `Host` and `Origin`
checks for the selected port and rejects forwarded-host headers. There is no
remote or LAN mode. Static root validation failures and preload failures not
covered by the supported per-asset cases below prevent the server from
listening. During preload, supported per-asset symlink, oversized, and
changed-file failures are captured for that asset; it remains unavailable while
the rest of the valid asset set can still be served.

### Runtime dashboard and reconnect behavior

The Runtime view can show the `ALL` view plus multiple Herdr workspaces/spaces,
their tabs, and their agents. It exposes all-space totals for spaces, agents,
working, blocked, idle, and done; selecting a space only changes browsing and
does not change those totals. Agent states are presented as idle, working,
blocked, done, or unknown. Herdr being unavailable is nonfatal: the UI enters
reconnecting state, clears the stale workspace/tab/agent snapshot and selected
pane, then retries automatically. When Herdr returns, a fresh snapshot repopulates
the dashboard.

HOD obtains runtime state with bounded `session.snapshot` polling, normally
about once per second. Reconnect delay backs off within bounded limits. The
browser receives updates from the local console event stream, but the Herdr
side is not an event-driven Herdr subscription; do not describe the dashboard
as a guaranteed push or zero-latency view.

### Transcript limits

Transcript is only the currently selected pane. The server asks Herdr for that
pane's held recent scrollback (`recent_unwrapped` text), keeps the selected
result in RAM, and retains at most the newest 16 MiB of UTF-8 text. The view may
show `gap`, `truncated`, or `reconnecting` markers when Herdr's read was already
truncated, the console had to discard older text to meet its byte cap, or a
reconnect interrupted continuity.

This is a live bounded, read-only snapshot, not a transcript archive: it is not persistent,
byte-exact, append-only, or an audit log. Do not use it as the sole record of
agent activity or as evidence that omitted output never existed.

### Settings view

The Settings view is available in both `hod ui` and `hod start`. In `hod start`,
the browser chooses from bounded project/space labels and opaque workspace IDs;
the backend resolves a fresh Herdr snapshot to one authoritative checkout or
coordinator directory. It rejects missing, unsafe, or ambiguous targets and
never returns project paths to the browser. Settings and confirmed mutations
are enabled, while agent control remains disabled. The Settings view shows HOD
role profile status for exactly `controller`, `impl`, and `reviewer`. A missing
role uses the confirmation
`INSTALL HOD ROLE`. A role whose installed file differs requires `force` and
the confirmation `OVERWRITE HOD ROLE`. A matching role is already `[OK]`; an
unsafe destination is shown as disabled rather than overwritten.

The Herdr configuration surface is an allowlist of exactly ten keys. The UI
exposes typed metadata and controls only for these keys:

| Key | Type and allowed values | Apply mode |
| --- | --- | --- |
| `theme.name` | string: built-in theme name | reload |
| `theme.auto_switch` | boolean | reload |
| `theme.light_name` | string: built-in theme name or `catppuccin-latte` | reload |
| `theme.dark_name` | string: built-in theme name | reload |
| `ui.agent_panel_sort` | string: `spaces`, `priority`, or `workspaces` | reload |
| `ui.toast.delivery` | string: `off`, `herdr`, `terminal`, or `system` | reload |
| `ui.toast.delay_seconds` | integer from `0` through `300` | reload |
| `ui.sound.enabled` | boolean | reload |
| `session.resume_agents_on_restore` | boolean | restart required |
| `advanced.scrollback_limit_bytes` | integer from `262144` through `1073741824` bytes | restart required |

The built-in theme names are `catppuccin`, `terminal`, `tokyo-night`,
`dracula`, `nord`, `gruvbox`, `one-dark`, `solarized`, `kanagawa`, `rose-pine`,
and `vesper`. Every change requires the exact `APPLY HERDR SETTING`
confirmation. The writer creates a temporary candidate, runs `herdr config
check`, atomically replaces the config, creates a backup when an existing
config is replaced, and requests `herdr server reload-config`. The response
marks the two restart-required settings; the UI does not silently restart
Herdr. Unknown and secret config keys, raw invalid values, and credentials are
never exposed through the console.

### Config write safety and residual limit

Symlinked config files and symlinked immediate config parents are rejected. The
immediate config parent must be a directory owned by the current user and must
not be group-writable or world-writable. The writer rechecks parent and target
identity around validation and atomic rename, and rolls back when reload fails.

There is an explicit same-user concurrent path-swap residual boundary. Node
core does not provide the openat/renameat-style directory-FD anchoring needed
to bind every later path operation to the originally checked parent. A same-user
process can still swap a path after the final check, so this implementation
must not be described as fully fail-closed against that race.

## Permission and blocker handling

Workers may encounter prompts requiring credentials, destructive actions,
publication, or a change in scope. The controller may answer only when the
user's established instructions already provide that authority. Otherwise it
must pause the affected path and ask the user.

Independent work may continue when it does not depend on the blocked decision.

## Completion standard

A workflow is complete only when the controller has:

1. Read the settled worker output.
2. Inspected actual diffs and artifacts.
3. Confirmed file ownership was respected.
4. Run fresh relevant validation on the integrated state.
5. Resolved critical review findings.
6. Reported failed, skipped, or environment-limited checks.

`idle`, `done`, and confident language are lifecycle signals, not correctness
evidence.
