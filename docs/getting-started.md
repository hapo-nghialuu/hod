# Getting Started

Six steps from a clean machine to your first orchestrated session. Each step ends with a ✅ check — pass it before moving on.

Already have Herdr and an agent CLI working? Jump to [step 5](#5-install-hod). Prefer the shortest possible path, with concepts introduced only as they become necessary? Read the [Quickstart](quickstart.md) instead.

## 1. Base tools

**macOS:**

```bash
xcode-select --install    # git, if you do not have it yet
brew install jq
```

Install [Homebrew](https://brew.sh/) first if you do not have it.

**Linux:**

```bash
sudo apt install -y git jq      # or dnf / pacman equivalents
```

✅ `git --version && jq --version` both print a version.

## 2. Herdr

```bash
brew install herdr
# or: curl -fsSL https://herdr.dev/install.sh | sh
```

Herdr provides the persistent panes, agent detection, and local control API that everything else builds on.

✅ `herdr --version` prints `herdr 0.7.x` or newer.

## 3. At least one agent CLI, authenticated

Install the CLI you plan to use — one is enough, add others later:

```bash
npm install -g @anthropic-ai/claude-code   # Claude Code
brew install --cask codex                  # Codex
# Grok Build: follow xAI's official installer
```

Run each one once (`claude`, `codex`, `grok`) to complete its own login flow. If your team shares a proxy or model configuration, this is the moment to copy that `~/.claude/settings.json` shape — **never** someone else's token; each person supplies their own.

✅ `command -v claude` (and/or `codex`, `grok`) resolves, and launching it does not prompt for login again.

## 4. Herdr integrations

```bash
herdr integration install claude
herdr integration install codex     # if you use codex
```

Without an integration Herdr infers agent state from screen output — a heuristic. With one, lifecycle state comes from an authoritative source, so the sidebar and every `agent wait` become reliable. Install these yourself; agents must never install them on your behalf.

✅ `herdr integration status` shows `claude: current (vX)`.

Grok Build has no integration: it runs fine as a controller or worker, but its state does not appear in the sidebar.

## 5. Install hod

```bash
# Track the latest:
curl -fsSL https://raw.githubusercontent.com/hapo-nghialuu/hod/main/install.sh | sh

# Or pin a release — recommended for teams, reproducible:
curl -fsSL https://raw.githubusercontent.com/hapo-nghialuu/hod/main/install.sh | HOD_REF=v0.1.17 sh
```

This clones the skill into `~/.hod/skill/`, puts the `hod` executable on `~/.local/bin/`, and links global adapters so every agent CLI can find the skill. If the installer warns about `PATH`, add the exact line it prints to your shell profile and open a new terminal.

```bash
hod status    # overall health; exit 0 when everything is fine
hod doctor    # same checks plus the exact command to fix each ✗
```

✅ `hod status` exits 0 with every line ✓.

Optional, any time after this:

```bash
hod install --project /path/to/repo   # attach one project (global already covers all)
hod settings install                  # inside a project: write the three role profiles
```

A project install also appends a short reminder block to `CLAUDE.md` and `AGENTS.md`, between `<!-- hod:begin -->` and `<!-- hod:end -->` markers, so the controller does not forget that Herdr orchestration is available. Re-running replaces only that block; `hod uninstall --project` removes it. Those files normally belong to the repository, so review the diff before committing — or pass `--no-memo` to skip the block entirely. For a project where every implementation task should route through Herdr workers, use `--memo-strict`; a plain re-install preserves the variant, and `--memo-default` switches back.

## 6. Your first orchestrated session

```bash
cd /path/to/project
herdr
```

In the pane, start your controller:

```bash
claude          # or codex / grok
```

Then paste a request that **names Herdr and the skill** — without those words the skill stays dormant:

```text
Use Herdr and the herdr-orchestrator skill to <a small, verifiable task>.
One writer, one read-only reviewer. Do not commit or push.
Return changed files, real test results, and unresolved questions.
```

The controller runs its preflight and uses guarded `hod dispatch`: it binds and reads back the controller, splits, binds and reads back the child, starts it, refreshes and reads it back, then submits the direct-user prompt. It verifies the output and reports back.

Two equivalent ways to reach the skill:

| Style | Claude Code | Codex | Grok Build |
| --- | --- | --- | --- |
| Load by command, then describe the task | `/herdr-orchestrator` | `$herdr-orchestrator` | — |
| Name it inside the request | works everywhere, as above | | |

The command form saves repeating the name; the plain request is one less thing to remember. Either way the task still needs its outcome, roles, and the evidence you expect back.

✅ **New panes appear in the Herdr sidebar** when it hires workers. If you only see "background agents" messages while the sidebar stays still, the CLI is using its own internal sub-agents rather than Herdr orchestration — restate the request with both names.

### Guarded topology dispatch

HOD child creation is public through `hod dispatch start`; the prompt must be a non-empty direct-user message on stdin:

```bash
project_cwd="$(pwd -P)"
printf '%s\n' 'Implement the health endpoint and return changed files and test results.' |
  hod dispatch start --name health-worker --role worker \
    --task health-endpoint --run run-demo-001 --kind claude \
    --cwd "$project_cwd" --direction right --timeout 120000 -- \
    --settings .claude/settings.impl.json
```

The required shape is `--name <unique> --role worker|advisor|reviewer|tester --task <safe-slug> --run <safe-id> --kind <kind> --cwd <absolute> --direction right|down --timeout <ms> -- [native args...]`. A successful start prints a JSON receipt with `pane_id`, `name`, `role`, `relation`, `task`, and `run`; relations map `worker=delegate`, `advisor=consult`, and `reviewer=tester=verify`. For advisor, add explicit matching `--advisor-choice fable|gpt-5.6-sol|opus` and `--advisor-model` flags plus exactly one matching native `-m` or `--model`; `fable`/`opus` require `--kind claude`, while `gpt-5.6-sol` requires `--kind codex`; the receipt records `requested_model` and explicitly sets `runtime_model_verified=false` because Herdr does not expose the runtime model. Without a user choice, hold and ask. Herdr 0.8 identity/readiness/status/sequence readbacks are authoritative, including an unchanged launch terminal. A session may appear only after the initial prompt; start validates the first delivery by terminal and sequence, waits for the actual Codex UI prompt surface, and sends by unique agent name. A sessionless receipt is accepted only in `working` or `blocked`, while redirects require a later non-empty, unchanged session. NUL-containing stdin is rejected without truncation, prompts above 131072 bytes fail before mutation, and the requested timeout is one wall-clock deadline through guarded delivery. Failure cleanup has a separate hard three-second cap. Start bootstraps only an untagged controller; existing controller run, child, partial, or invalid HOD tokens are checked before mutation. Prompt rejects advisor, working, or not-ready children before metadata reporting.

Redirect an existing child only through the guarded prompt command:

```bash
printf '%s\n' 'Continue the task and report fresh verification.' |
  hod dispatch prompt --pane "$child_pane_id" --task health-follow-up \
    --kind claude --run run-demo-001 --timeout 120000
```

It refreshes and validates before redirecting. Dispatches for the same coordinator are serialized; redirect requires the expected agent kind and unchanged authoritative terminal, agent-session identity, and sequence. Raw `herdr pane split`, `herdr agent start`, and `herdr agent prompt` are unsupported in the HOD workflow because they can recreate `UNMAPPED`; an old Herdr missing the exact capability fails before split. After updating HOD, restart or reload long-lived controller sessions so they load the new instructions; HOD cannot retrofit a running session's loaded instructions. On a verified failure before any agent-start attempt, HOD closes only the freshly split child after exact cleanup readback. A change visible at that read makes HOD leave it open and fail closed. Herdr 0.8 has no owner-CAS for the following close or metadata write, so an outside mutation in that final interval remains a race; never mix raw lifecycle operations with an active HOD dispatch. Pre-delivery failures restore staged metadata when possible; ambiguous lifecycle attempts are never auto-retried. HOD never intentionally closes an unproven or already-started pane.

## Optional: local HOD UI console

The implemented local web console is available on macOS and Linux with Node.js 20 or newer:

```bash
hod ui [--project <path>] [--port <0-65535>] [--no-open]
```

`--project` defaults to the current directory and `--port 0` lets the OS choose a free port. By default the command opens the browser (`open` on macOS, `xdg-open` on Linux); `--no-open`, or an opener failure, prints a recovery URL. The URL's one-time `#token` is sensitive: never share or log it. The browser exchanges it for a local HttpOnly/SameSite cookie and clears the fragment.

The console is strictly local at `127.0.0.1` with strict Host/Origin checks and no remote/LAN mode. Its runtime dashboard tracks multiple workspaces/spaces and agents. Herdr unavailability is nonfatal; reconnect automatically clears stale state. Herdr state is refreshed by bounded polling, not an event-driven Herdr subscription. The selected-pane transcript is a RAM-only, capped 16 MiB UTF-8 tail and may show gap, truncated, or reconnecting markers; it is not persistent, byte-exact, append-only, or an audit log.

The Settings view covers HOD's `controller`, `impl`, and `reviewer` roles plus exactly ten typed, allowlisted Herdr settings. Unknown and secret keys are not exposed. For the full settings matrix, confirmation/force behavior, config check/backup/reload flow, write-safety limits, and the residual same-user path-swap boundary, read [Local HOD UI console](usage-guide.md#local-hod-ui-console).

### Global runtime-only observer

To observe every Herdr workspace from any directory, start the detached observer:

```bash
hod start [--port <0-65535>] [--no-open] [--background]
```

`hod start --project <path>` is rejected and the observer ignores the current directory. It uses fixed port `4317` unless `--port` overrides it, and `--background` is retained for compatibility. Its dashboard shows all-space totals for spaces, agents, working, blocked, idle, and done; the selected transcript is a read-only, RAM-only display. Settings selects a live project/space by workspace ID, while the server resolves the current checkout without exposing its path to the browser. Missing or ambiguous targets fail closed. Confirmed settings mutations are enabled, but agent control remains disabled. The existing `hod ui` and `hod ui --project` paths remain unchanged.

## While a session runs

| Sidebar | Meaning | What you do |
| --- | --- | --- |
| 🟡 working | The agent is busy | Nothing |
| 🔴 blocked | It needs you | Open that pane to **read** the question, then answer **in the controller pane** |
| 🔵 done / 🟢 idle | Finished or free | Nothing — the controller harvests it |

Detach any time with `ctrl+b` then `q`; everything keeps running. Reattach with `herdr`.

## Three rules worth memorising

1. Answer blocked workers **through the controller**, never by typing into the worker's pane — one chain of command.
2. Never combine a native permission bypass flag or mode with a `--settings` role profile. Forms such as `--dangerously-skip-permissions` and `--permission-mode bypassPermissions` disable deny rules; `hod dispatch start` rejects direct forms and values in native argv before mutation. It does not inspect referenced settings, profile, or config files, custom sandbox profiles, or ambient CLI configuration; pass only inputs you trust. Advisor, reviewer, and tester starts additionally use a positive native-arg allowlist: no root subcommands or native cwd/system-prompt changes. Use file-based Claude settings, Codex `-s read-only -c features.multi_agent=false`, or Grok `--sandbox read-only` plus deny rules.
3. When something breaks, run `hod doctor` first and read [Troubleshooting](troubleshooting.md) — do not restart the Herdr server.

## Verifying the environment by hand

The controller does this automatically; run it yourself when diagnosing. Inside a Herdr-managed pane:

```bash
test "${HERDR_ENV:-}" = 1 && test -n "${HERDR_PANE_ID:-}"

status_json=$(herdr status --json)
printf '%s\n' "$status_json" | jq -e \
  '.server.running == true and .server.compatible == true'
```

Never export those variables outside Herdr — they are environment evidence, not a feature toggle. Installed leaf help (`hod dispatch start --help`, `hod dispatch prompt --help`, and the underlying `herdr ... --help`) is the authority on command syntax; never mix forms from different Herdr versions.

## Choosing models and roles

Model selection is a native CLI argument passed after Herdr's `--` separator, and it is separate from role enforcement:

```bash
printf '%s\n' 'Implement the requested task and return verification.' |
  hod dispatch start --name model-worker --role worker --task model-task \
    --run run-demo-001 --kind claude --cwd "$(pwd -P)" \
    --direction right --timeout 120000 -- \
    --settings .claude/settings.impl.json --model <model-id>
```

Project defaults live in each CLI's own configuration — for Claude Code, a `model` field in `.claude/settings.json`. Exact model IDs and effort controls are provider-specific; resolve them from the installed CLI's help rather than guessing. See [Usage guide](usage-guide.md) for full recipes.

## Next steps

- [Quickstart](quickstart.md) — the same journey in five escalating levels
- [Usage guide](usage-guide.md) — prompt recipes, parallel teams, steering
- [Portfolio orchestration](portfolio-orchestration.md) — one orchestrator, many projects
- [Troubleshooting](troubleshooting.md) — adapters, preflight, capability mismatches
