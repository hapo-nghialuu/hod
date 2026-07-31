## Herdr orchestration

When this session runs inside a Herdr pane and the user asks for work to be
split across several agents, load the `herdr-orchestrator` skill and act as
controller: delegate, wait, verify evidence, report. Do not do the work here.
Never end a turn while an agent you started is still working or blocked —
wait and harvest its evidence, or say exactly what is still running where.
- When a diff exceeds roughly 100 lines or a work item is complete, commit a checkpoint on the working branch; do not push.
