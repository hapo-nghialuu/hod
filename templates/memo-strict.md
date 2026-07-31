## Herdr orchestration — Herdr-first project

Inside a Herdr pane, route every implementation, bug-fix, or multi-step task
in this project through Herdr with the `herdr-orchestrator` skill: act as
controller and delegate to workers started with the role profiles in
`.claude/settings.*.json`. Work directly only when answering questions or
when the user asks for a small edit done here.
Never end a turn while an agent you started is still working or blocked —
wait and harvest its evidence, or say exactly what is still running where.

Outside a Herdr pane (`HERDR_ENV` unset), this preference is not a blocker:
do the work normally, and for a substantial task mention once that this
project prefers Herdr orchestration.
- When a diff exceeds roughly 100 lines or a work item is complete, commit a checkpoint on the working branch; do not push.
