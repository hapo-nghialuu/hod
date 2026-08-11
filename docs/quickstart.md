# Quickstart

Five levels. Each one works on its own; climb only when the previous level
feels limiting. You do not need policies, tiers, or worktrees to start — those
words appear only at the level that needs them.

## Level 0 — Just Herdr (2 minutes, no skill required)

```bash
brew install herdr          # or: curl -fsSL https://herdr.dev/install.sh | sh
herdr integration install claude
cd <your-project> && herdr
```

Type `claude` in the pane and work normally. You already get the two things
most people come for: the sidebar shows every agent's state at a glance
(🔴 waiting for you · 🟡 working · 🟢 idle), and nothing dies when you detach.
Want a second agent? Split a pane and start another one. No orchestration
concepts involved.

**You know it works when:** your agent shows up in the sidebar with a state.

## Level 1 — One project, one orchestrated task (5 minutes)

Install the skill once:

```bash
curl -fsSL https://raw.githubusercontent.com/hapo-nghialuu/hod/main/install.sh | sh
hod status
```

Then, inside a Herdr pane running your controller CLI, ask — naming Herdr and
the skill explicitly, or it will not activate:

```text
Use Herdr and the herdr-orchestrator skill to <task>. One writer, one
read-only reviewer. Do not commit or push. Return changed files, test
results, and unresolved questions.
```

The controller runs a preflight, splits panes, starts workers, verifies their
output, and reports back with evidence.

If you prefer, load the skill by command first and then describe the task:
`/herdr-orchestrator` in Claude Code, `$herdr-orchestrator` in Codex. Both
reach the same place as naming it in the sentence — the prefix just saves you
from repeating the name.

**You know it works when:** new panes appear in the sidebar. If you only see
"background agents" messages and the sidebar stays empty, the CLI is using its
internal sub-agents — not Herdr orchestration; restate the request with the
words "Herdr" and "herdr-orchestrator".

No policy files are needed at this level. The controller asks you directly
whenever it needs a decision.

## Level 2 — Parallel work in worktrees (when two tasks must not collide)

```bash
herdr worktree create --cwd <your-project> --branch <feature> --no-focus
```

Click the new workspace in the sidebar and start another agent there. Each
worktree is an independent checkout — two agents cannot overwrite each other's
files. Two things worktrees do not inherit: untracked files (`.claude/`,
`.env`) and running processes. Clean up with `herdr worktree remove`, never by
deleting the directory.

## Level 3 — Roles, boundaries, and many projects

When sessions get long or teams get big, move rules from prompt text into
enforced boundaries:

```bash
hod settings install        # writes .claude/settings.<role>.json profiles
```

Start workers with a profile (`-- --settings .claude/settings.reviewer.json`)
and the harness itself removes the tools that role must not have. Never
combine a profile with `--dangerously-skip-permissions` — that flag disables
every deny rule.

To have one orchestrator manage several projects at once, read
[Portfolio orchestration](portfolio-orchestration.md) — this is where
user-authored policy files and the two-tier contract come in, and not before.

## Level 4 — Local HOD UI console

For a local dashboard of Herdr workspaces, spaces, agents, and one selected
pane's live scrollback:

```bash
hod ui [--project <path>] [--port <0-65535>] [--no-open]
```

Node.js 20+ is required on macOS or Linux. The default port is `0`; the command
opens the browser with the platform opener, while `--no-open` prints the
recovery URL. If opening fails, the URL is printed too. Its one-time `#token`
fragment is sensitive: never share or log it. The browser exchanges it for a
local HttpOnly/SameSite cookie and clears the fragment.

The console is loopback-only at `127.0.0.1` with strict Host/Origin checks and
no LAN mode. Herdr state is refreshed by bounded polling rather than an
event-driven Herdr subscription; a Herdr outage is nonfatal, and reconnect
clears stale dashboard state. Transcript is only the selected pane's RAM-only
16 MiB UTF-8 tail and may be marked gap, truncated, or reconnecting. Settings
cover the three HOD roles and exactly ten typed Herdr keys. See the full
[local HOD UI console guide](usage-guide.md#local-hod-ui-console) for the
settings matrix, write checks, and recovery details.

## Where to go next

- Prompt recipes and steering: [Usage guide](usage-guide.md)
- Full setup detail: [Getting started](getting-started.md)
- Something failing: [Troubleshooting](troubleshooting.md)
