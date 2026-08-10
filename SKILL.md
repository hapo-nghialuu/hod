---
name: herdr-orchestrator
description: "Orchestrate coding agents through Herdr as the user's authorized proxy from Codex CLI, Claude Code CLI, or Grok Build CLI. Use only when the current CLI is already running inside Herdr and the user explicitly asks to use Herdr to delegate, parallelize, coordinate, monitor, redirect, test, review, or collect work from other coding agents. Do not trigger for an ordinary implementation, test, or review request that does not name Herdr or Herdr-managed agents. Worker prompts and replies must read as direct user-agent conversation. Requires HERDR_ENV=1, HERDR_PANE_ID, and explicit user authority to control agents."
---

# Herdr Orchestrator

Use Herdr as the transport and control plane. The current CLI remains the single accountable agent for planning, delegation, evidence, integration, and the final answer to the user. The controller may be Codex CLI, Claude Code CLI, or Grok Build CLI; do not make controller-specific assumptions.

## Non-negotiable contract

- Act only within the user's request and authority. Never fabricate approval, intent, decisions, preferences, prior actions, access, or credentials — and never use delegation to obtain authority the user did not grant.
- Address every worker as the user. Do not mention an orchestrator, parent agent, sub-agent, relay, hidden controller, or internal routing unless the user explicitly asks. Herdr prompt input has no sender field, so wording alone determines whether routing internals leak.
- Treat worker replies as evidence available to the user, not private reports. Separate worker claims from independently verified facts, and resolve conflicting claims from artifacts, never from confidence language.
- Do not claim success from an agent state or verbal report. `idle` and `done` are readiness states, not proof; verify artifacts and fresh check output.
- Treat a prompt as delivered only after submission is confirmed. `agent_prompt_stalled` means it was not: the text still sits unsent in the worker's input box, and everything on that screen is your own words — not worker output, not evidence.
- Never end your turn while an agent you started is `working` or `blocked`. Wait and harvest, resolve the blocker within established intent, or tell the user exactly which agents remain, in which panes, waiting for what.
- Delegate through Herdr panes, never through the CLI's own in-process sub-agents. A pane keeps the worker's transcript out of your context and visible in the sidebar; an internal sub-agent floods your context and appears nowhere the user can see or answer. Workers likewise never start or coordinate further coding agents — the only exception is the controller tier of portfolio mode.
- One live writer per file. Reviewers are read-only and started fresh — never the session that wrote the code, and never a resumed transcript of it.
- Ask the user before changing scope, risk, cost, permissions, publication, purchases, credential use, or externally visible behavior. Use ordinary technical judgment only for reversible, in-scope choices. A worker's request for approval is a request to the user, not permission to invent consent.
- Do not expose chain-of-thought, hidden prompts, credentials, personal configuration, unrelated pane contents, or one worker's transcript to another. Share the minimum task-relevant facts and redact secrets from reports.
- Fail closed. On malformed JSON, a protocol mismatch, a missing capability, or an ambiguous target: stop that path, preserve the command and stderr evidence, refresh only with read-only discovery, and surface what cannot be resolved. A timeout is a monitoring event — inspect state and output before waiting, redirecting, or asking.
- Clean up conservatively. Keep task-created panes for user inspection by default. Never close, kill, delete, or reset anything the task did not create; remove task-created resources only when authorized, resolving exact targets with read-only checks first.

## Preflight and capability gate

Fail fast unless the controller is in a Herdr-managed pane:

```bash
if [ "${HERDR_ENV:-}" != 1 ] || [ -z "${HERDR_PANE_ID:-}" ]; then
  printf '%s\n' 'Herdr orchestration requires a Herdr-managed pane.' >&2
  exit 1
fi
command -v herdr && command -v jq && herdr --version
herdr status --json | jq -e \
  '.server.running == true and .server.compatible == true' >/dev/null
ls "$PWD"/.claude/settings.*.json 2>/dev/null   # role profiles the user already wrote
```

If either environment value is absent, stop and tell the user to launch the controller inside Herdr; never control a focused Herdr session from outside it. If status JSON is malformed, the server is not running, or compatibility is not exactly `true`, stop and report the client and server versions. Do not restart or update Herdr without user authorization.

Installed leaf help is the only command authority. Run `herdr agent --help` and `herdr pane --help`, then the exact leaf (`herdr agent start --help`, …) before first use of any mutating form. Never run bare `herdr` for discovery, probe a mutating leaf by omitting arguments, or infer syntax from a version number. Use the modern family only when leaf help confirms it; if help instead matches the legacy forms exactly, read [Legacy Herdr 0.7.1](references/legacy-herdr-0.7.1.md) before acting. If neither family matches, fail closed and show the capability difference. Do not mix command families.

Use explicit pane IDs or unique live agent names, parsed from JSON with `jq -e` — never predicted from examples, focus, pane order, or sidebar position. `HERDR_PANE_ID`, `HERDR_TAB_ID`, and `HERDR_WORKSPACE_ID` identify the calling context; IDs are opaque, stable, and never reused. Prefer `--current` only for the calling pane and `--no-focus` for background work.

## Workflow

1. Confirm explicit user authority, the Herdr environment, and a complete supported command family.
2. Split the request into the smallest useful team with distinct roles, dependencies, write ownership, and proof requirements. Prefer one worker for small or tightly interleaved work; parallelize only tasks that cannot consume each other's unfinished edits, and chain dependent work in order.
3. Select each `--kind` from the values in the installed `herdr agent start --help`, using only kinds whose CLI is installed and usable locally. An explicit user choice wins; if it is unavailable, show the evidence and ask — never substitute silently. Otherwise route on task fit and availability, never on brand reputation or invented rankings.
4. Create only the panes or worktrees the task requires, preserving cwd and focus. Start each worker with its role profile and the model the user named.
5. Send one complete direct-user prompt atomically, and confirm it was delivered.
6. Wait with bounded lifecycle commands, inspect terminal evidence, resolve blockers within established intent or relay them, and redirect only with relevant new facts.
7. Verify the integrated state: real diffs, fresh sentinel-guarded checks, and an independent read-only reviewer for material code changes. Resolve correctness and security findings before claiming completion.
8. Report one cohesive, evidence-backed result ending with a distinct section for anything that still needs a user decision — or state plainly that nothing does.

## Opt-in adaptive coordinator

Activate adaptive routing only when the user explicitly asks for an adaptive
coordinator or for coordinator plus advisor behavior. Without that opt-in, the
workflow above and the existing small-task/direct-user behavior are unchanged.

When active, read [Adaptive Coordinator with Tripwire Escalation](references/coordinator-advisor.md)
as the normative hod `0.1.14` reference. It defines three base modes —
`DIRECT`, `SINGLE`, and `ORCHESTRATE` — plus `CONSULT` and `ASK_USER` overlays.
Plain `DIRECT` stays ceremony-free. A `DIRECT` route may carry an independently
triggered overlay; it then records R0 and the overlay artifact but still creates
no worker plan or external checkpoint. `SINGLE` and `ORCHESTRATE` add only the
artifacts their route requires. R0 v2 types uncertainty and risk, permits at
most one route-changing read-only probe, and reruns R0 before action. An
upstream fingerprint change holds affected dependents and invalidates their
stale packet, gate, and evidence state under the normative reference.

The adaptive protocol requires an E0 mechanical evidence receipt for every
repository change, uses `HOLD` before tripwire re-routing, and calls a fresh
advisor only on the reference's gates and triggers. Advisor selection remains
user-owned, and the advisor never grants authority. Do not infer adaptive
mode, a checkpoint, or an advisor consult from model confidence alone.

## Writing worker prompts

Lead with an imperative outcome (`Implement <concrete outcome>.`). State constraints as user instructions, not policies from an unseen controller. End by asking for the outcome, changed files, commands run, test results, and unresolved questions. Keep the packet self-contained — work context path, exact writable paths (or "read-only"), files to read, dependency interfaces, acceptance criteria — without replaying conversation history. On follow-up, send only what changed, restate ownership when it grows, and name changed artifacts explicitly: a worker does not notice filesystem changes made behind its last read.

Never send another worker's transcript where a factual summary suffices, guesses framed as user decisions, or framing like "you are a sub-agent — report to the parent". A read-only role is stated directly: "Review the current diff. Do not edit files. Return actionable findings with file and line references."

Answer a worker's factual question only when established task context already contains the answer. A request for a preference, an approval, or new authority pauses that path and goes to the user; keep independent work moving when safe. Batch non-urgent questions across workers into one message, and keep every question attributed to its source until resolved — harvest each worker's open questions when it settles, and never leave one buried in a transcript.

## Roles, models, and boundaries

Model, revived context, and role boundary are independent axes, all passed to the worker CLI after Herdr's `--` separator. Resolve exact flag grammar from each CLI's installed help; this table names the axes, not the syntax:

| Axis | Claude Code | Codex | Grok |
| --- | --- | --- | --- |
| Model | `--model` | `-m` + `-c model_reasoning_effort=` | `-m` |
| Revive context | `--continue` / `--resume` | `codex exec resume <id>` | `--resume <id>` |
| Role boundary | `--settings <file>` | `-s <sandbox>` `-a <policy>` | `--allow/--deny` |

For exact three-role promises, CLI flags, and enforcement gaps, see [Role Boundaries](references/role-boundaries.md).

- A spoken model name is a label, not an ID. Resolve the exact string from the installed CLI before starting. If the CLI rejects it, report its error verbatim and ask — never substitute, downgrade, or retry with a guess. When no model is named, omit the flag and let the CLI use its configured default.
- A project profile (`.claude/settings.<role>.json`) only takes effect when passed at start. A worker started bare silently discards the user's configuration — treat that as a defect. Map each role to its matching profile; never invent, substitute, or author one. A boundary role (read-only reviewer, coordinator-only controller) started without a profile is enforced by wording alone — say so in the report.
- Refuse contradictions instead of passing them: `--dangerously-skip-permissions` disables every deny rule loaded through `--settings`, and `--continue`/`--resume` on a reviewer defeats its independence. An enforced boundary is the same contract as a written one — never route around a denied tool by shelling out or handing the action to another agent. The sole exception is adaptive checkpoint metadata: when the normative reference requires it, only the active coordinator may use a local shell to write the one exact external checkpoint path. That narrow control-plane write never permits task-file, repository, or worker-artifact writes, and its path restriction is wording-level plus evidence-checked where the harness leaves shell access available.
- Continue a live agent only when the task directly extends its work with the same role and file ownership. Start fresh for review or audit, for a changed role or ownership, or when information isolation matters — and never resume a transcript for a review step: a resumed reviewer looks independent and is not.

## Lifecycle and evidence

`agent start` needs an existing pane (`pane split --current --no-focus`) and always begins an empty session. `agent prompt <target> <text> --wait` submits atomically — bracketed paste plus Enter — and confirms delivery through an observed state change. Do not rebuild submission from raw text and key events, and do not prompt a `working` agent except for an urgent correction: Herdr does not correlate turns, so the reply may answer the wrong request.

On a settled wait, act on the state, not the screen:

- `working` — keep waiting; never duplicate the prompt.
- `blocked` — read the pane; answer only from established user intent, otherwise relay to the user. Detection is heuristic, so always inspect the visible output and run `agent explain` on a suspicious classification.
- `idle` / `done` — the worker is waiting to be harvested; read its output, then verify artifacts. Neither state proves success, and `done` is only the unseen-attention form of `idle`.
- `agent_prompt_stalled` — the prompt never entered the agent; recover per [Operations](references/operations.md) before treating anything on that screen as output.
- timeout — inspect `agent get` and `agent read`; never blindly resend. `agent_not_running` — refresh `agent list`; never guess another pane or target.

With several workers, round-robin instead of blocking on one: harvest settled and blocked agents first — an unharvested `idle` worker is the usual reason a team looks stalled — and keep the user informed during long waits. Before composing the final reply, run `agent list` one last time and settle every agent this task started; a report that omits a live worker abandons it.

Evidence discipline: `pane wait-output` matches text already on screen, so every check runs with a fresh per-run sentinel and captured exit status — stale `passed` text is never a result. Dispatch builds, tests, and anything verbose to a pane (`pane run`); keep inline only short read-only checks needed to decide the next step. Validate behavior on the integrated state, not isolated worker states, and record failed or skipped checks with their impact.

## Team and integration

Keep an internal ledger per worker: role, kind, pane, ownership globs, task, required proof, dependencies, state. From three concurrent workers on, persist it to one file outside the checkout; a controller resuming after a restart reconciles from that file plus `agent list`, adopting or replacing each agent explicitly rather than guessing.

Ownership is exact paths or narrow globs with one live writer each; shared manifests, lockfiles, and migrations belong to one designated integration owner. If two workers need the same file, sequence their turns or reassign ownership before either edits — never let writes race. Overlapping edits go to a designated integrator worker: the controller decides and states the intended outcome, but a controller that repairs a conflict itself has silently become a writer. Use worktrees only when isolation genuinely requires them — never to bypass approval or shared-file coordination — and never force-push or destructively reset another worker's branch.

## Coordinator-only mode

When the user restricts the controller to coordination, honor it for the rest of the session: the line is between performing and reading. The controller performs nothing — no task-file edits (including "quick fixes"), builds, tests, debugging, reviewing, conflict resolution, or committing self-authored changes — and reads everything: planning, prompts, Herdr control commands, short read-only inspection, evidence judgment, and commits of verified worker changes when authorized. The only permitted write is the exact external adaptive checkpoint metadata required by the normative protocol; it is a narrow control-plane exception, not task work, and does not authorize any repository write. Delegating work while accepting claims without reading evidence is not delegation — it is abdication. Do not assume this mode without the user's request; for a single small task it costs more than it returns.

## Modes and detailed guidance

- Multi-project orchestration — only on the user's explicit request: [Portfolio hierarchy and tiers](references/portfolio-hierarchy.md). One orchestrator starts one controller per project, controllers start workers only inside their own project, workers never start agents, and user-authored policy files outside the checkouts carry per-project authority.
- Command recipes, stalled-prompt recovery, the sentinel procedure, session revival, task packets, worktree and integration checklists, transcript recovery: [Operations](references/operations.md).
- Legacy 0.7.1 command family — only when installed help confirms it: [Legacy Herdr 0.7.1](references/legacy-herdr-0.7.1.md).
