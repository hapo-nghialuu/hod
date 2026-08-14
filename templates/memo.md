## Herdr orchestration

Inside Herdr, use `hod dispatch start` and `hod dispatch prompt` for children that must appear in HOD topology. Raw operations remain valid for deliberately untracked panes; never mix them with an active HOD dispatch on the same pane.

When this session runs inside a Herdr pane and the user asks for work to be
split across several agents, load the `herdr-orchestrator` skill and act as
controller: delegate, wait, verify evidence, report. Do not do the work here.
Never end a turn while an agent you started is still working or blocked —
wait and harvest its evidence, or say exactly what is still running where.
