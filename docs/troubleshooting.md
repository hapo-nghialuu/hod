# Troubleshooting

Start with read-only evidence. Do not restart Herdr, update binaries, replace
adapters, or kill pane processes merely to test a theory.

## HOD UI console

### Global observer options

Run the runtime-only observer from any directory with:

```bash
hod start [--port <0-65535>] [--no-open]
```

`hod start --project <path>` is intentionally rejected. Use `hod ui` or
`hod ui --project <path>` for the unchanged legacy/project-scoped console.
The observer is runtime-only: its read-only transcript and all-space counts
(spaces, agents, working, blocked, idle, done) do not depend on the launch
directory. Settings selects a live project/space by workspace ID; the server
resolves the target without exposing project paths to the browser. Settings
mutations require confirmation, while agent control remains disabled.

### Node version

`hod ui` requires Node.js 20 or newer and supports macOS and Linux. Check the
runtime used by the shell:

```bash
node --version
```

If it is below `v20`, install/select a supported Node version and run the
command again. The UI does not have a remote or LAN mode; it always serves on
`127.0.0.1`.

### Browser did not open

The default opener is `open` on macOS and `xdg-open` on Linux. Start with
`--no-open` when you want the URL in the terminal:

```bash
hod ui --no-open
```

If the default opener fails, `hod ui` also prints the recovery URL. Use that
URL only in a browser on the same machine. Its `#token` fragment is a one-time
secret: never share it, put it in a ticket/chat, or write it to logs. The UI
exchanges it for a local HttpOnly/SameSite cookie and clears the fragment.

### 401, invalid, or expired one-time token

The bootstrap token can be exchanged only once. A second tab, a copied/reused
URL, a missing fragment, or an expired local session can produce `401` or a
session-unavailable status. Close the unusable console process if needed and
start a fresh one with `hod ui --no-open`; use the newly printed URL locally.
Do not try to repair the token by editing or logging it.

### Herdr disconnected or reconnecting

Herdr being unavailable is nonfatal. The console marks the connection as
reconnecting, clears stale workspace/agent/transcript state, and retries
automatically. Wait for a fresh snapshot rather than treating the old pane
list as current. If it does not recover, check Herdr without changing it:

```bash
herdr status --json | jq '{client, server}'
```

The HOD runtime uses bounded polling of Herdr snapshots, not a guaranteed
event-driven Herdr subscription, so a small delay is expected.

If Settings cannot load a selected project in `hod start`, refresh the runtime
snapshot and check that the space has one authoritative checkout or coordinator
directory. Missing, unsafe, or ambiguous targets fail closed; choose a different
live space or fix its Herdr workspace metadata. Project paths are never returned
to the browser.

### Config parent permissions or symlink

The console rejects a symlinked config file or immediate config parent. The
immediate parent must be a directory owned by the current user and must not be
group-writable or world-writable. Inspect the path selected by
`HERDR_CONFIG_PATH`, or the default Herdr config location, without printing
its contents:

```bash
config_file="${HERDR_CONFIG_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml}"
printf 'HERDR_CONFIG_PATH=%s\n' "${HERDR_CONFIG_PATH:-<default>}"
ls -ld "$config_file" "$(dirname "$config_file")"
```

Restore ownership and permissions through your normal system procedure, then
restart only the UI process. Do not replace a symlink or overwrite a config
until you have confirmed the intended target. The write path rechecks identity
and uses atomic rename, but a same-user concurrent path swap remains possible
because Node core lacks openat/renameat-style directory-FD anchoring; this is
not a fully fail-closed guarantee.

### Port conflict

The default `--port 0` lets the OS choose a free port. If an explicit port is
busy, either omit `--port` or choose another integer from `0` through `65535`:

```bash
hod ui --port 0
```

Keep the printed URL's `127.0.0.1:<port>` host unchanged; changing it to a LAN
address is outside the supported security boundary.

## The skill does not activate

Confirm the adapter exists:

```bash
hod install --project ./project-a
hod status
```

Confirm you started the controller from the linked project and invoked the
skill explicitly. Codex reads `.agents/skills`; Claude Code and Grok Build use
the `.claude/skills` adapter.

## `Herdr orchestration requires a Herdr-managed pane`

The controller was started outside Herdr, or the environment was stripped.

Check:

```bash
printf 'HERDR_ENV=%s\n' "${HERDR_ENV:-<unset>}"
printf 'HERDR_PANE_ID=%s\n' "${HERDR_PANE_ID:-<unset>}"
```

Start Herdr from the project, then launch the controller inside a Herdr shell
pane. Do not export fake values to bypass this guard.

## Server is running but incompatible

Inspect structured status:

```bash
herdr status --json | jq '{client, server}'
```

The workflow requires both:

```text
.server.running == true
.server.compatible == true
```

Do not stop or update a running Herdr session automatically. Stopping a server
can terminate processes in its panes. Choose a maintenance window and follow
the official Herdr update documentation.

## Adapter already exists and is not a symlink

The installer refuses to replace existing content. Inspect it:

```bash
ls -ld project-a/.agents/skills/herdr-orchestrator
ls -ld project-a/.claude/skills/herdr-orchestrator
```

Decide whether the existing directory is a project-owned skill that must be
preserved. Do not delete or overwrite it without confirming ownership and
backup requirements.

## Requested worker kind is unavailable

Inspect Herdr and the executable:

```bash
herdr agent start --help
command -v codex
command -v claude
command -v grok
```

Do not silently substitute another worker kind when the user named one. Install
the requested CLI or ask the user whether an available kind is acceptable.

## Agent remains `working`

Continue waiting with a bounded timeout. Do not resend the original prompt.
After a timeout, inspect:

```bash
herdr agent get <agent-name>
herdr agent read <agent-name> --source recent-unwrapped --lines 160
```

Timeout is a monitoring event, not task failure.

## Agent state is `unknown`

Read its terminal evidence and ask Herdr to explain detection:

```bash
herdr agent read <agent-name> --source recent-unwrapped --lines 160
herdr agent explain <agent-name> --verbose
```

Do not assume completion or send input to a guessed target.

## A test appears to pass from old pane output

Herdr output waits may match text already present in a reused pane. Run each
command with a unique sentinel and captured exit code, then wait for that exact
sentinel. See
[Operations](../references/operations.md#sentinel-guarded-checks).

## A Claude project model is ignored

Check for higher-priority session or local configuration:

- A native `--model` argument affects the launched session.
- Environment variables may override settings.
- `.claude/settings.local.json` may override shared project settings.
- Resumed sessions may retain their previous model.

Start a new session without a native model override when you want the project
default to apply.

## Collecting a useful issue report

Include:

- operating system and architecture;
- `herdr --version`;
- redacted `herdr status --json` client/server fields;
- relevant leaf `--help` output;
- controller and requested worker kind;
- exact adapter check output;
- expected behavior and actual behavior;
- commands and exit statuses;
- whether the task used a main checkout or Git worktree.

Remove tokens, credentials, personal paths, private repository names, and
unrelated pane output before posting publicly.
