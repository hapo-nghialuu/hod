## Herdr orchestration — Herdr-first project

Inside Herdr, use `hod dispatch start` and `hod dispatch prompt` for children that must appear in HOD topology. Raw operations remain valid for deliberately untracked panes; never mix them with an active HOD dispatch on the same pane.

Inside a Herdr pane, route every implementation, bug-fix, or multi-step task
in this project through Herdr with the `herdr-orchestrator` skill: act as
controller and own the outcome, not just the delegation — track the
observable DONE_WHEN and its current gaps, and delegate to workers started
with the role profiles in `.claude/settings.*.json` until those gaps close
with fresh evidence. Work directly only for questions, read-only inspection,
or status; any other task work here still routes through Herdr unless the
user explicitly opts out, below.
Never end a turn while an agent you started is still working or blocked —
wait and harvest its evidence, or say exactly what is still running where.
An explicit user opt-out — not using Herdr/the coordinator, or a request to
work directly — outranks this project preference: stop orchestrating
immediately for that task and its direct follow-ups, settling or harvesting
any worker already running first. Keep working directly for the rest of the
session only if the user says so explicitly.

Outside a Herdr pane (`HERDR_ENV` unset), this preference is not a blocker:
do the work normally, and for a substantial task mention once that this
project prefers Herdr orchestration.
- When a diff exceeds roughly 100 lines or a work item is complete, commit a checkpoint on the working branch; do not push.
