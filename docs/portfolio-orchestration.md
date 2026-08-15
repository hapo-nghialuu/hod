# Portfolio Orchestration

Portfolio mode lets one orchestrator agent manage several projects and their agents from a single Herdr session. It uses a strict two-tier hierarchy:

```text
You ↔ Portfolio orchestrator            (control workspace)
        ├── Project controller: shop    (workspace at ~/ws/shop)
        │       ├── shop_impl
        │       └── shop_review
        └── Project controller: blog    (workspace at ~/ws/blog)
                └── blog_fix
```

You talk to one agent. It starts one controller per project; each controller runs its own workers. Workers never start agents, and delegation never goes deeper than two levels. The operational contract lives in [Portfolio hierarchy and tiers](../references/portfolio-hierarchy.md).

Every new HOD child in this hierarchy uses guarded `hod dispatch start`, and every follow-up uses `hod dispatch prompt`; the CLI only enforces deterministic topology mechanics. The controller still owns planning, routing, and authority. The dispatch relation mapping is `worker=delegate`, `advisor=consult`, and `reviewer=tester=verify`; raw Herdr split/start/prompt is unsupported because it can recreate `UNMAPPED`.

## When to use it

Use portfolio mode when several projects need concurrent attention and you want one point of contact. Stay in the normal single-project flow when one project is active; the hierarchy only adds coordination cost there.

## 1. Prepare per-project policies

The orchestrator acts across projects without asking you about every routine step, so you must state in advance what each project allows. Create one policy file per project under the state root:

```bash
mkdir -p ~/.herdr-orc/projects/shop
cp herdr-orchestrator/templates/policy-template.md \
  ~/.herdr-orc/projects/shop/policy.md
"$EDITOR" ~/.herdr-orc/projects/shop/policy.md
```

[The policy template](../templates/policy-template.md) is a starting point; editing it yourself is what turns it into an authority grant.

Example policy:

```markdown
# Policy: shop

Scope: ~/work/agent-workspace/shop

Allowed without asking:
- Edit files under src/ and tests/.
- Run npm test, npm run lint, npm run build.
- Create task worktrees and panes.

Always ask first:
- Committing, pushing, publishing, or tagging.
- Editing package manifests, lockfiles, or CI configuration.
- Anything destructive or externally visible.
```

Policies are yours alone: agents must never write or edit them, and a missing policy means the orchestrator asks instead of assuming. Keeping policies outside the checkouts means no worker with repository access can grant itself authority.

## 2. Start the orchestrator

Launch Herdr, open a pane in your control location, and start your controller CLI as usual. The linked project layout does not change; each project keeps its own adapters.

## 3. Kick off the portfolio

```text
Use Herdr and the herdr-orchestrator skill in hierarchical portfolio mode to
manage my active projects.

Projects:
- ~/work/agent-workspace/shop: finish the checkout retry fix, then run the
  full test suite.
- ~/work/agent-workspace/blog: upgrade the framework patch version and verify
  the build.

Read each project's policy in ~/.herdr-orc/projects/<slug>/policy.md before
delegating. Start one controller per project. Batch questions that need my
decision instead of interrupting me per blocker. Do not commit or push
anywhere.
```

## What to expect

- One workspace per project appears in the Herdr sidebar, so per-project agent states stay visible at a glance.
- Orchestration state persists under `~/.herdr-orc/` (a portfolio ledger and one ledger per project), so a restarted orchestrator reconciles instead of starting blind.
- Blockers that policy cannot answer arrive batched, with a Herdr notification when a decision is waiting.
- Results arrive per project with verified evidence separated from controller claims, exactly as in single-project mode.

## Safety notes

- Portfolio mode never relaxes the safety model; it adds boundaries on top of it. Destructive, published, or credentialed actions still require explicit authority.
- An advisor is available only after your explicit choice of `Fable`, `GPT-5.6 Sol`, or `Opus`; if unavailable, hold and ask rather than defaulting or substituting.
- Content isolation is enforced between projects: a controller sees only its own project's policy, files, and task context.
- If the orchestrator dies mid-flight, workers and controllers keep running in Herdr. Restart the orchestrator and ask it to reconcile; it must rebuild from the ledgers and `herdr agent list`, not from memory.

## Troubleshooting

Start with [Troubleshooting](troubleshooting.md) for adapter, preflight, dispatch, and capability issues; they apply unchanged. After updating HOD, restart or reload long-lived portfolio and project-controller sessions; HOD cannot retrofit their already loaded instructions. For hierarchy-specific problems, inspect `~/.herdr-orc/portfolio.md` and the per-project ledgers first — they are plain Markdown and always reflect the orchestrator's last known state.
