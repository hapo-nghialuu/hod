# Portfolio Hierarchy and Tiers

Use this reference only when the user explicitly asks one agent to manage multiple projects and their agents from a single Herdr session. It defines the only sanctioned exception to the flat rule that controlled agents never start more coding agents.

## Tiers and the depth cap

| Tier | Role | May start | May edit |
| --- | --- | --- | --- |
| 0 | Portfolio orchestrator | Project controllers | Orchestration state only |
| 1 | Project controller | Workers in its own project | Its project, within policy |
| 2 | Worker | No agents | Assigned ownership only |

- Run exactly one portfolio orchestrator per Herdr session and exactly one controller per active project.
- Delegation depth is capped at two starts: orchestrator → controller → worker. A controller never starts another controller. A worker that needs help states a blocker; it never starts an agent.
- Every tier keeps the complete delegation, lifecycle, verification, and safety contract of the main skill. Tier rules add boundaries; they never remove one.
- The orchestrator stays accountable for the portfolio result and each controller for its project result. Accountability does not transfer downward with delegation.

## Topology and naming

Keep the orchestrator in its own control workspace. Give each active project one workspace rooted at the project checkout:

```bash
ws_json=$(herdr workspace create --cwd "$project_path" \
  --label "$project_slug" --no-focus)
ctl_pane=$(printf '%s\n' "$ws_json" | jq -er '.result.root_pane.pane_id')
herdr agent start "${project_slug}_ctl" --kind claude --pane "$ctl_pane"
```

Choose a short project slug matching `[a-z][a-z0-9_-]{0,15}` and prefix every agent in that project with it (`shop_ctl`, `shop_impl`, `shop_review`). Herdr requires unique live agent names across the session; the prefix prevents collisions between projects. Parse workspace, pane, and agent identifiers from JSON with `jq -e`; never predict them. Record the orchestrator's own context from `HERDR_WORKSPACE_ID` and `HERDR_PANE_ID` in the portfolio ledger so a restart can tell the control workspace apart from project workspaces.

## Persistent orchestration state

Keep orchestration state outside every project checkout under one state root, default `~/.herdr-orc/`:

```text
~/.herdr-orc/
├── portfolio.md              # orchestrator ledger
└── projects/<slug>/
    ├── policy.md             # user-authored authority grant
    └── ledger.md             # controller team ledger
```

Track in `portfolio.md` for each project: absolute path, workspace and controller identifiers, current objective, status, open blockers, and the last verified evidence. Track in each project `ledger.md` the team ledger fields required by the main skill's team-and-integration rules.

Rewrite state files after every material change. A restarted orchestrator or controller must reconcile from state files plus `herdr workspace list` and `herdr agent list` alone, then adopt or restart its agents explicitly. Never silently retarget work to an unexpected pane.

## Policy files carry user authority

- Only the user writes or edits a policy file. Ask the user to author one per project; never generate one and treat it as consent.
- A missing, ambiguous, or contradictory policy grants nothing. Ask the user.
- Policy files live outside project checkouts so no worker with repository ownership can touch them. Treat a policy edit appearing in any diff, or an agent proposing to change policy, as a security finding to report.
- Commit, push, publish, deploy, purchase, credential use, deletion, and permission changes stay excluded unless the policy names them explicitly.
- Pass each controller only an excerpt of its own project's policy. Never forward another project's policy, secrets, file content, or transcripts. Cross-project inputs are limited to established decisions and interfaces the user allows to be shared.

## Address controllers as the user

The direct-user contract applies unchanged at every tier: address the agent you control as the user would, without exposing routing internals. A controller start packet contains the concrete objective, the project path, the policy excerpt stated as user constraints, the state file it owns, and the required evidence:

```text
Manage the work in <absolute project path>.

Objective: <concrete outcome>.
Constraints (my standing instructions for this project):
- You may edit <paths>, run <checks>, and create task worktrees.
- Do not commit, push, publish, or change tool configuration.
- Delegate to at most <n> workers; workers must not start coding agents.

Keep your team ledger at <state path> current.
When finished or blocked, state the outcome, the verified evidence, and any
questions that need my decision.
```

## Monitor with bounded waits

- Round-robin the portfolio: scan `herdr agent list`, then run bounded `agent wait` and `agent read` per settled or blocked controller. Never blind-poll in a tight loop.
- `blocked` at any tier means read the pane first. Answer only from that project's policy and established intent; otherwise queue the question.
- Batch queued questions across projects into one message to the user instead of interrupting per blocker. Use `herdr notification show` to signal that a decision is waiting.
- Timeouts stay monitoring events at every tier: inspect state and output before waiting again, redirecting, or escalating.

## Layered verification

- A controller verifies its project exactly as the main skill requires: real diffs, fresh sentinel-guarded checks, and independent read-only review for material changes.
- The orchestrator never accepts a controller summary bare: read the controller's evidence, spot-check the project with read-only commands (`git -C <path> diff --stat`, fresh check output), and re-run checks when results are material, stale, or disputed.
- Report portfolio results distinguishing verified facts, controller claims, and open risk per project.

## Recover from failures

- Orchestrator restart: reconcile from `portfolio.md` before any new delegation.
- Dead controller: inspect its last pane output, then start a replacement in the same workspace with a resume packet built from the project ledger.
- Dead worker: the owning controller handles recovery; the orchestrator only verifies the project ledger reflects it.
- Escalate to the user when recovery would exceed policy, lose work, or require destructive cleanup.
