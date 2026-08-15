---
name: herdr-orchestrator
description: "Orchestrate coding agents through Herdr as the user's authorized proxy from Codex CLI, Claude Code CLI, or Grok Build CLI. Use only when the current CLI is already running inside Herdr and the user explicitly asks to use Herdr to delegate, parallelize, coordinate, monitor, redirect, test, review, or collect work from other coding agents. Do not trigger for an ordinary implementation, test, or review request that does not name Herdr or Herdr-managed agents. Worker prompts and replies must read as direct user-agent conversation. Requires HERDR_ENV=1, HERDR_PANE_ID, and explicit user authority to control agents."
---

# Herdr Orchestrator

Use Herdr as the transport and control plane. The current CLI remains the single accountable agent for planning, delegation, evidence, integration, and the final answer to the user. The controller may be Codex CLI, Claude Code CLI, or Grok Build CLI; do not make controller-specific assumptions.

## Outcome kernel

The coordinator owns the user's outcome, not just delegation mechanics. From a stated want, derive one observable `DONE_WHEN` and the current gaps against it, and keep dispatching workers, testers, or reviewers — never the controller's own hands — until every gap closes with fresh evidence. A worker's `done` state closes a task, not the outcome: while `DONE_WHEN` is still unevidenced, the next gap gets its own packet. `DIRECT`, `SINGLE`, and `ORCHESTRATE` are execution modes in service of that outcome, not completion goals in themselves — a clearly-directed task dispatches straight to a worker packet with no added ceremony.

**Coordinator-only is the default, not a special mode.** Acting as the Herdr coordinator, the controller performs no task work — no implementing, building, testing, debugging, reviewing, or resolving conflicts itself, "quick fix" included. It reads: artifacts, diffs, and logs; it judges evidence; it coordinates; and, only once the user has granted authority for that exact change, it commits or pushes an already-verified, worker-authored diff. Committing or pushing worker output is not authoring it — the controller still never originates the diff, and never commits or pushes without a fresh authorization for that exact change.

**Explicit opt-out outranks everything above.** If the user says not to use Herdr or the coordinator, or asks for the work directly, stop orchestrating immediately and do the work yourself as a normal direct agent — no packets, no gates, no advisor. The opt-out's default scope is the current task and its direct follow-ups; it covers the whole session only when the user says so explicitly. If a worker for the current task is already running, settle or harvest it before switching to direct work: read its state and capture what it produced first. A later instruction can turn Herdr back on; nothing here is permanent.

**`CONSULT` is adaptive, never a default.** Open an advisor only when ambiguity, an architecture or design tradeoff, material risk, conflicting evidence, or a stall could actually change the route; a clearly-directed task skips `CONSULT` entirely. Advisor selection stays user-owned: if no choice is recorded, ask once and reuse the answer for later consults in the same task; never pick or substitute a model on the user's behalf.

**Material progress, not motion, is the unit of work.** An artifact, a diff, a test result, a resolved decision, or an evidenced blocker counts as progress; a `working` status, streamed tokens, or another round of file reads do not. Roughly five minutes without material progress is a signal to inspect and consider redirecting — read the pane, judge whether the current path is still productive — not a hard timeout or an automatic kill. Replace a worker only once evidence shows its path is not working, never on the clock alone.

**A changed intent restarts the gap analysis.** When the user changes what they want mid-task, update `DONE_WHEN` to match immediately: evidence, task packets, and gate verdicts tied to the superseded intent are now stale and no longer count toward it. Before dispatching anything under the revised outcome, redirect each affected worker with the new constraint or settle it — read its state and harvest what it produced — so nothing keeps running against an ask the user has already moved past.

**Reuse a fresh result; do not re-verify without a relevant change.** Within the current task or run, once checks have produced a fresh, passing result for the integrated revision, reuse that result as long as the integrated revision, the relevant environment inputs, and the constraints it was checked against remain unchanged; rerunning the full suite again over that same unchanged state manufactures no new evidence. The instant any of those change — the revision, a relevant environment input, or a constraint — the prior result goes stale and must not be reused, no matter how little time has passed: staleness tracks what changed, never a mechanical, time-based timeout. Bring in a tester or an independent reviewer only when risk or an actual evidence gap needs independent judgment, never as a default step after every worker.

`DONE` is asserted only when the user-visible outcome and its stated constraints have fresh, current-revision evidence behind them — never from a worker's claim or an agent state alone. None of this is harness-enforced by itself; it is the coordinator's judgment and the user's oversight, same as the rest of this skill. Only an installed permission profile (see [Role Boundaries](references/role-boundaries.md)) removes a tool at the harness level — wording never substitutes for that boundary.

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
- Reserve `hod_role=advisor` + `hod_relation=consult` exclusively for an explicitly opted-in adaptive `CONSULT`. Before any `pane split`, advisor metadata, or `agent start` for that path, require a recorded user choice of exactly one of `Fable`, `GPT-5.6 Sol`, or `Opus`; if absent or unavailable, `HOLD + ASK_USER` — never infer a default or substitute. A worker/planner/scout/reviewer model preference never carries over. Ordinary planning/scouting remains `worker`/`delegate` (or `reviewer`/`verify` only when it is actually review), never `advisor`/`consult`.
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

Use explicit pane IDs or unique live agent names, parsed from JSON with `jq -e` — never predicted from examples, focus, pane order, or sidebar position. `HERDR_PANE_ID`, `HERDR_TAB_ID`, and `HERDR_WORKSPACE_ID` identify the calling context; IDs are opaque, stable, and never reused. Dispatch passes the explicit controller pane ID immediately after `pane split`, then uses `--direction`, `--cwd`, and `--no-focus` for background work.

## HOD UI topology and guarded dispatch

For a child that must belong to the HOD UI topology, use the guarded `hod dispatch` lifecycle. Raw `pane split`, `agent start`, and `agent prompt` remain valid for deliberately untracked work; they may leave a child UNMAPPED and carry no HOD lifecycle guarantees. Never mix raw mutations with an active HOD dispatch for the same pane.

Start a child from a direct-user prompt with a bounded task/run label and the native agent arguments after `--`:

```bash
printf '%s\n' "$DIRECT_USER_PROMPT" | hod dispatch start \
  --name worker-1 \
  --role worker --task task-slug --run run-id --kind claude \
  --cwd "$PWD" --direction right --timeout 120000 -- \
  --settings .claude/settings.impl.json
```

An advisor start must carry an explicit canonical selection and matching native model:

```bash
printf '%s\n' "$DIRECT_USER_PROMPT" | hod dispatch start \
  --name advisor-1 --role advisor --task task-slug --run run-id --kind claude \
  --cwd "$PWD" --direction right --timeout 120000 \
  --advisor-choice fable --advisor-model fable -- --model fable
```

Redirect an existing child through its real pane ID:

```bash
printf '%s\n' "$DIRECT_USER_PROMPT" | hod dispatch prompt \
  --pane "$child_pane" --kind claude \
  --task redirect-slug --run run-id --timeout 120000
```

`hod dispatch start` requires a unique `--name`, `HERDR_ENV=1`, a real `HERDR_PANE_ID`, and non-empty prompt stdin. The name is forwarded byte-for-byte to `agent start`; it has no role semantics, so multiple workers may share one role when their names are unique. It validates role (`worker`, `advisor`, `reviewer`, or `tester`), bounded safe task/run identifiers, kind, existing absolute cwd, direction, and timeout. It probes the exact Herdr 0.8 leaves before mutation: `agent start`, `agent prompt` with `--until`, `agent get`, `agent read`, `pane get`, `pane report-metadata`, and `pane split`. It reads the controller pane first: an untagged pane may bootstrap, an existing controller must already carry the requested `hod_run`, and child, partial, or invalid HOD tokens fail before any report, split, start, or prompt. It reports controller metadata and reads it back with `pane get`, then invokes `pane split "$pane_id" --direction "$direction" --cwd "$cwd" --no-focus` for the explicit controller pane with no `--current`, parses `.result.pane.pane_id`, requires the child to share the controller workspace, derives the relation, reports the child, and reads back the exact five tokens before starting it. The four mappings are worker/delegate, advisor/consult, reviewer/verify, and tester/verify. Native arguments are forwarded only after `--`. Advisor starts require `--advisor-choice fable|gpt-5.6-sol|opus` and `--advisor-model` with the same value, plus exactly one matching native `-m` or `--model`; both flags are rejected for non-advisor roles. `fable` and `opus` require `--kind claude`; `gpt-5.6-sol` requires `--kind codex`. The receipt records the choice and `requested_model` with `runtime_model_verified=false`; Herdr does not expose a runtime model field, so requested configuration is never claimed as observed. A bounded retry of at most 10 attempts, with 100ms between attempts, is allowed only when the JSON error has exactly `.error.code == "agent_pane_busy"`; a matching message alone never retries. After start, the child is refreshed and read back; only then is the prompt submitted with `--wait` and repeated `--until` values for `working`, `blocked`, `done`, `idle`, and `unknown`, returning after an observed state change rather than waiting for settlement. The installed prompt capability must advertise all five states. Start and prompt success require the strict Herdr 0.8 response type and the exact name, pane, agent kind, workspace, non-empty terminal identity, and boolean `interactive_ready`; `agent_status` must be `idle`, `working`, `blocked`, `done`, or `unknown`, and `state_change_seq` must be a non-negative safe integer. After start, `agent get` must read back the same identity with readiness true and a non-working state before the single prompt. Some agents, including Codex, expose the agent-session only after the first prompt. The launch therefore binds an unchanged terminal and sequence and accepts the exact first delivery response without inventing a session. For Codex, HOD also waits until the detection surface contains the actual Codex UI and prompt marker, so an OSC-title false positive cannot consume the prompt during launcher startup. The lifecycle prompt targets the unique agent name; the response must still bind back to the expected pane. A sessionless first receipt is accepted only in `working` or `blocked`, never as an idle/done false success. Redirect requires a later authoritative read with a non-empty, unchanged session before delivery. Prompt readback must keep the bound identity and advance the sequence. Any capability, report, parse, workspace, readback, start, or prompt failure exits nonzero, and no prompt is sent before verified metadata. Only exact `agent_pane_busy` start errors retry; stalled prompts and ambiguous transport do not. A NUL byte in prompt stdin is rejected without truncation, and prompts above 131072 bytes are rejected before mutation. Controller workspace, terminal, kind, and session must remain exact across mutation, and its pane revision must not regress. `--timeout` is one wall-clock deadline through capability probes, locking, metadata, lifecycle calls, and delivery. Failure cleanup then has its own hard three-second cap so rollback cannot hang the caller. A verified failure before start or delivery restores staged metadata when Herdr accepts the rollback; an ambiguous start or prompt attempt is never retried or rolled back as though delivery were known not to have happened. On success, start prints one machine-readable JSON receipt with `pane_id`, `name`, `role`, `relation`, `task`, and `run`.

`hod dispatch prompt` requires a child pane ID, expected `--kind`, task/run labels, and prompt stdin. It reads the current child role, parent, relation, and run from authoritative tokens, rejects advisor, pane-working, authoritative-agent-working, or `interactive_ready != true` before any `report-metadata` mutation, requires the parent to equal the current `HERDR_PANE_ID`, validates the requested run and role/relation mapping, then refreshes and reads back controller and child metadata before the one prompt attempt. Both agent reads must keep the exact name, kind, terminal, session, workspace, and state sequence. It cannot reparent a pane or accept a free-form relation. Readback uses `pane get`, never `api snapshot`.

Start and redirect are serialized by an atomic per-controller lock. HOD never steals a stale lock. A freshly split pane is closed only when its authoritative split receipt matched the controller workspace and a failure happens before any agent-start attempt. Cleanup first re-reads the exact pane, workspace, canonical cwd, terminal, and empty agent/session identity; a change visible at that read makes HOD fail closed and leave the pane open. Herdr 0.8 has no owner-CAS for the following close or metadata write, so an outside mutation in that final interval remains a race. Never mix raw lifecycle operations with an active HOD dispatch. HOD never intentionally closes an unproven pane or any pane after an agent-start attempt.

The Herdr 0.8 prompt API does not expose a session-CAS argument. Therefore all coordinator lifecycle operations must use this serialized HOD path; never run a raw external stop/start/prompt against the same child concurrently. HOD targets the unique name and validates the returned session/terminal/pane, but cannot unsend input if an outside actor replaces the process in the final API interval. If split transport fails before an authoritative pane receipt, HOD never starts an agent and leaves any unproven empty pane for explicit inspection instead of guessing and closing by order or cwd.

The dispatch implementation accepts `HOD_HERDR_BIN` only as a test-only override and defaults to `herdr`. An old Herdr without the required exact leaf capability fails before split; there is no fallback. The metadata TTL is finite and exactly `86400000` ms, with `--source hod`. Only these token names are allowed: `hod_role`, `hod_parent`, `hod_relation`, `hod_task`, and `hod_run`. The root controller has the role/task/run tokens; each child has all five, including its real direct parent pane ID. Task labels are safe slugs matching `[a-z0-9._-]` and are at most 48 characters. Run IDs are safe non-secret identifiers.

Topology roles are not profile names: an `impl` or `implementer` profile must report `hod_role=worker`. Allocate `run_id` once per orchestration and pass the exact same value to the controller and every child. When a controller pane is reused, refresh it before reporting or starting any child. Advisor routing is opt-in only: reserve `advisor`/`consult` for an explicit adaptive `CONSULT`, require exactly one user-selected `Fable`, `GPT-5.6 Sol`, or `Opus` before split, and use `HOLD + ASK_USER` if absent or unavailable.

## Workflow

1. Confirm explicit user authority, the Herdr environment, and a complete supported command family.
2. Split the request into the smallest useful team with distinct roles, dependencies, write ownership, and proof requirements. Prefer one worker for small or tightly interleaved work; parallelize only tasks that cannot consume each other's unfinished edits, and chain dependent work in order.
3. Select each `--kind` from the values in the installed `herdr agent start --help`, using only kinds whose CLI is installed and usable locally. An explicit user choice wins; if it is unavailable, show the evidence and ask — never substitute silently. Otherwise route on task fit and availability, never on brand reputation or invented rankings.
4. Create only the panes or worktrees the task requires, preserving cwd and focus. Start each worker with its role profile and the model the user named.
5. Send one complete direct-user prompt atomically, and confirm it was delivered.
6. Wait with bounded lifecycle commands, inspect terminal evidence, resolve blockers within established intent or relay them, and redirect only with relevant new facts.
7. Verify the integrated state: real diffs and fresh sentinel-guarded checks; bring in a tester or an independent read-only reviewer only when risk or an actual evidence gap needs independent judgment, not as a default step for every change. Resolve correctness and security findings before claiming completion.
8. Report one cohesive, evidence-backed result ending with a distinct section for anything that still needs a user decision — or state plainly that nothing does.

## Opt-in adaptive coordinator

Activate adaptive routing only when the user explicitly asks for an adaptive coordinator or for coordinator plus advisor behavior. The Outcome kernel above and the base Workflow above stay active either way — this opt-in controls only whether the adaptive checkpoint artifacts below (R0, overlay records, working plans, and gates) get produced, never a separate default path around the explicit opt-out.

When active, read [Adaptive Coordinator with Tripwire Escalation](references/coordinator-advisor.md) as the normative hod `0.1.18` reference. It defines three base modes — `DIRECT`, `SINGLE`, and `ORCHESTRATE` — plus `CONSULT` and `ASK_USER` overlays. Plain `DIRECT` stays ceremony-free. A `DIRECT` route may carry an independently triggered overlay; it then records R0 and the overlay artifact but still creates no worker plan or external checkpoint. `SINGLE` and `ORCHESTRATE` add only the artifacts their route requires. R0 v2 types uncertainty and risk, permits at most one route-changing read-only probe, and reruns R0 before action. An upstream fingerprint change holds affected dependents and invalidates their stale packet, gate, and evidence state under the normative reference.

For `ORCHESTRATE` dependency nodes, the coordinator must use the exact R0 v2 envelope and require these fields in each node: `OWNER`, `READY_WHEN`, `INPUT_FINGERPRINT`, `INVALIDATE_IF`. On any upstream fingerprint change: `HOLD` every affected dependent, bump `PACKET_REVISION`, invalidate stale `INPUT_FINGERPRINT`, `EVIDENCE_REF`, and any gate verdict derived from them, compute the new fingerprint, rerun R0 for the affected route, rerun applicable gates (G1 when plan/ownership/dependency/criteria changed, E0 and G2 when repository output or review evidence changed), and resume only after `READY_WHEN` is true on the new packet revision.

The adaptive protocol requires an E0 mechanical evidence receipt for every repository change, uses `HOLD` before tripwire re-routing, and calls a fresh advisor only on the reference's gates and triggers. Advisor selection remains user-owned, and the advisor never grants authority. Do not infer adaptive mode, a checkpoint, or an advisor consult from model confidence alone.

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
- Refuse contradictions instead of passing them: native bypass forms such as `--dangerously-skip-permissions` or `--permission-mode bypassPermissions` disable deny rules loaded through `--settings`, and resuming, forking, teleporting, or attaching an existing session for a reviewer defeats its independence. `hod dispatch start` rejects direct bypass forms and values in native argv for every role before mutation. Advisor, reviewer, and tester starts use a positive native-argument allowlist: no root subcommands, native cwd/system-prompt changes, inline settings/tool grants, non-read-only sandbox overrides, or arbitrary config/profile/approval overrides. Use file-based Claude settings, canonical Codex `-s read-only -c features.multi_agent=false`, or Grok `--sandbox read-only` plus deny rules. HOD does not inspect referenced settings or ambient CLI configuration; pass only inputs the user trusts. An enforced boundary is the same contract as a written one — never route around a denied tool by shelling out or handing the action to another agent. The sole exception is adaptive checkpoint metadata: when the normative reference requires it, only the active coordinator may use a local shell to write the one exact external checkpoint path. That narrow control-plane write never permits task-file, repository, or worker-artifact writes, and its path restriction is wording-level plus evidence-checked where the harness leaves shell access available.
- Continue a live agent only when the task directly extends its work with the same role and file ownership. Start fresh for review or audit, for a changed role or ownership, or when information isolation matters — and never resume a transcript for a review step: a resumed reviewer looks independent and is not.

## Lifecycle and evidence

`hod dispatch start` owns the split, metadata, and `agent start` sequence for a topology-tracked child; `hod dispatch prompt` owns its guarded `agent prompt <unique-agent-name> <text> --wait` redirect and observed state change. A deliberately untracked raw child remains outside this contract. For the same HOD-managed pane, do not mix raw split/start/prompt mutations, rebuild submission from raw text and key events, or prompt a `working` agent except for an urgent correction: Herdr does not correlate turns, so the reply may answer the wrong request.

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

This is the baseline from the Outcome kernel above, not a special mode to opt into: the line is between performing and reading, and it holds regardless of task size or a worker's speed. The controller performs nothing — no task-file edits (including "quick fixes"), builds, tests, debugging, reviewing, or conflict resolution by its own hands — and reads everything: planning, prompts, Herdr control commands, short read-only inspection, evidence judgment, and the commit/push exception described in the Outcome kernel for an already-verified, worker-authored diff under fresh user authority. The only other permitted write is the exact external adaptive checkpoint metadata required by the normative protocol; it is a narrow control-plane exception, not task work, and it authorizes nothing beyond that one path. Delegating work while accepting claims without reading evidence is not delegation — it is abdication. When the user explicitly asks to hold this line for the rest of the session, honor it across every later task until they say otherwise.

## Modes and detailed guidance

- Multi-project orchestration — only on the user's explicit request: [Portfolio hierarchy and tiers](references/portfolio-hierarchy.md). One orchestrator starts one controller per project, controllers start workers only inside their own project, workers never start agents, and user-authored policy files outside the checkouts carry per-project authority.
- Command recipes, stalled-prompt recovery, the sentinel procedure, session revival, task packets, worktree and integration checklists, transcript recovery: [Operations](references/operations.md).
- Legacy 0.7.1 command family — only when installed help confirms it: [Legacy Herdr 0.7.1](references/legacy-herdr-0.7.1.md).
