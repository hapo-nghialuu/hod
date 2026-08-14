# Operations

Executable recipes and recovery procedures for the rules in `SKILL.md`. The
installed leaf help remains the only syntax authority — these are confirmed
shapes, not a substitute for `--help`. Topology-tracked child creation and
redirects use `hod dispatch`; deliberately untracked raw operations remain
outside that lifecycle contract.

## Confirm the modern command family

Inspect every relevant leaf with read-only help commands before first use:

```bash
herdr agent start --help;  herdr agent prompt --help
herdr agent send-keys --help;  herdr agent wait --help
herdr agent get --help;  herdr agent read --help;  herdr agent explain --help
herdr pane split --help;  herdr pane run --help;  herdr pane wait-output --help
```

Use the modern leaf family only when help confirms these signatures. These are
read-only capability references; supported child mutation goes through
`hod dispatch`:

```text
agent start <name> --kind KIND --pane ID
agent prompt <target> <text>
agent send-keys <target>
agent wait <target> [--until STATUS]
```

A group listing proves only that a subcommand exists; require the matching leaf
help to prove its signature.

## Adaptive mode: bounded recipes

Use these short recipes only after the user opts into adaptive mode. The
normative rules, gates, and exceptions are in
[Adaptive Coordinator with Tripwire Escalation](coordinator-advisor.md); do not
recreate that reference in an operations packet.

### R0 v2, one bounded scout, and dependent invalidation

For a worker dispatch, `CONSULT`, `ASK_USER`, or an existing checkpoint, record
the smallest useful envelope before acting. This includes a `DIRECT` base mode
when it carries `CONSULT` or `ASK_USER`:

```text
ROUTE_VERSION: 2
BASE_MODE: DIRECT | SINGLE | ORCHESTRATE
FACTS: <at most three>
HARD_TRIGGERS: none | <IDs>
UNCERTAINTY_KIND: NONE | DISCOVERABLE_FACT | TECHNICAL_JUDGMENT | USER_PREFERENCE | USER_AUTHORITY | EXECUTION_OUTCOME
UNCERTAINTY: none | <route-changing unknown>
DECISION_RISK: LOW_REVERSIBLE | MATERIAL | HIGH_OR_IRREVERSIBLE
PROBE_BUDGET: 0 | 1
PROBES_USED: 0 | 1
NEXT_OBSERVATION: none | <one read-only observation and route-changing results>
INVALIDATE_IF: none | <route-staling fact, revision, authority, or outcome>
NEXT: dispatch | read-only-scout | consult | ask-user | stop
STOP_REASON: none | <required when NEXT is stop>
```

Do not structure, print, or persist this envelope for plain `DIRECT` without an
overlay. Apply the canonical precedence in the normative reference. Scout only
when `UNCERTAINTY_KIND` is `DISCOVERABLE_FACT`, `PROBES_USED: 0`, and the named
`NEXT_OBSERVATION` can change the route. Then set `PROBES_USED: 1`, add the
fact, and rerun R0. Never take a second scout; ask the user when their decision
can resolve the remaining uncertainty, otherwise set `NEXT: stop` and explain
`STOP_REASON`.

For an `ORCHESTRATE` node, keep `NODE_ID`, `OWNER`, `DEPENDS_ON`, `READY_WHEN`,
`INPUT_FINGERPRINT`, `INVALIDATE_IF`, `COMPLETION_CRITERION`, and `EVIDENCE_REF`
in its versioned packet. When an upstream fingerprint changes: `HOLD` affected
dependents, bump `PACKET_REVISION`, invalidate affected `INPUT_FINGERPRINT`,
gate verdicts, and `EVIDENCE_REF`, compute the new fingerprint, then rerun R0,
G1, and G2 where the normative applicability rules require them. Dispatch only
after the new packet satisfies `READY_WHEN`.

### E0 receipt capture

For every repository-changing task, establish a clean baseline before
dispatch. Resolve one canonical repository root even when the controller starts
inside a subdirectory, then run every Git capture relative to that root. Capture
`HEAD` on both sides of a status read, and require no staged, unstaged, or
non-ignored untracked entry. If either SHA differs or status is non-empty, use
`HOLD`; do not assign pre-existing dirt to the task:

```bash
set -o pipefail
if ! repo_root=$(git rev-parse --show-toplevel); then
  printf '%s\n' 'E0 cannot resolve the repository root; HOLD.' >&2
  exit 1
fi
if ! repo_root=$(cd -- "$repo_root" && pwd -P); then
  printf '%s\n' 'E0 cannot canonicalize the repository root; HOLD.' >&2
  exit 1
fi
if ! e0_tmp=$(mktemp -d "${TMPDIR:-/tmp}/hod-e0.XXXXXX"); then
  printf '%s\n' 'E0 cannot create a private capture directory; HOLD.' >&2
  exit 1
fi
cleanup_e0() { rm -rf -- "$e0_tmp"; }
trap cleanup_e0 EXIT HUP INT TERM

if ! base_sha_before=$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}'); then
  printf '%s\n' 'E0 cannot resolve the baseline HEAD; HOLD.' >&2
  exit 1
fi
if ! git -C "$repo_root" status --porcelain=v1 -z --untracked-files=all \
  >"$e0_tmp/baseline.status"; then
  printf '%s\n' 'E0 cannot read baseline status; HOLD.' >&2
  exit 1
fi
if ! base_sha_after=$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}'); then
  printf '%s\n' 'E0 cannot re-resolve the baseline HEAD; HOLD.' >&2
  exit 1
fi
if [ "$base_sha_before" != "$base_sha_after" ] ||
  [ -s "$e0_tmp/baseline.status" ]; then
  printf '%s\n' 'E0 baseline is not stable and clean; HOLD.' >&2
  exit 1
fi
base_sha=$base_sha_after
```

Run the required checks next, in a pane with a fresh sentinel:

```bash
sentinel="VERIFY_$(date +%s)_$RANDOM"
herdr pane run "$check_pane" "<check>; rc=\$?; printf '%s exit=%s\\n' '$sentinel' \"\$rc\""
herdr pane wait-output "$check_pane" --match "$sentinel" --timeout 600000
herdr pane read "$check_pane" --source recent-unwrapped --lines 120
```

Only after the checks settle and every writer is quiescent, capture the four
change domains twice. Each pass brackets the capture with `HEAD`, keeps paths
NUL-delimited and repository-relative, and anchors committed and staged diffs
to that pass's `HEAD`. The two complete passes must match byte-for-byte:

```bash
capture_e0_pass() {
  local pass_dir=$1
  local head_before
  local head_after
  local untracked_path

  mkdir -p -- "$pass_dir" || return 1
  head_before=$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}') ||
    return 1
  git -C "$repo_root" rev-parse --verify "${base_sha}^{commit}" \
    >/dev/null || return 1
  git -C "$repo_root" merge-base --is-ancestor \
    "$base_sha" "$head_before" || return 1
  printf '%s\n' "$head_before" >"$pass_dir/head"

  if ! {
    git -C "$repo_root" diff --name-only -z --no-renames \
      "$base_sha" "$head_before" -- || exit 1
    git -C "$repo_root" diff --cached --name-only -z --no-renames \
      "$head_before" -- || exit 1
    git -C "$repo_root" diff --name-only -z --no-renames -- || exit 1
    git -C "$repo_root" ls-files --others --exclude-standard -z || exit 1
  } | LC_ALL=C sort -zu >"$pass_dir/paths"; then
    return 1
  fi

  {
    printf 'COMMITTED\0'
    git -C "$repo_root" diff --binary --no-color --no-ext-diff \
      --no-textconv --no-renames "$base_sha" "$head_before" -- || return 1
    printf '\0STAGED\0'
    git -C "$repo_root" diff --cached --binary --no-color --no-ext-diff \
      --no-textconv --no-renames "$head_before" -- || return 1
    printf '\0UNSTAGED\0'
    git -C "$repo_root" diff --binary --no-color --no-ext-diff \
      --no-textconv --no-renames -- || return 1
    printf '\0UNTRACKED\0'
    git -C "$repo_root" ls-files --others --exclude-standard -z |
      while IFS= read -r -d '' untracked_path; do
        printf '%s\0' "$untracked_path"
        git -C "$repo_root" hash-object --no-filters -- "$untracked_path" ||
          exit 1
      done || return 1
  } >"$pass_dir/payload" || return 1

  shasum -a 256 "$pass_dir/payload" | awk '{print $1}' \
    >"$pass_dir/hash" || return 1
  grep -Eq '^[0-9a-f]{64}$' "$pass_dir/hash" || return 1
  git -C "$repo_root" status --porcelain=v1 -z --untracked-files=all \
    >"$pass_dir/status" || return 1
  head_after=$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}') ||
    return 1
  [ "$head_before" = "$head_after" ] || return 1
}

if ! capture_e0_pass "$e0_tmp/first" ||
  ! capture_e0_pass "$e0_tmp/second"; then
  printf '%s\n' 'E0 cannot capture two complete repository states; HOLD.' >&2
  exit 1
fi
for artifact in head paths payload hash status; do
  if ! cmp -s "$e0_tmp/first/$artifact" "$e0_tmp/second/$artifact"; then
    printf '%s\n' 'E0 repository changed during capture; HOLD.' >&2
    exit 1
  fi
done

head_sha=$(cat "$e0_tmp/second/head")
diff_sha=$(cat "$e0_tmp/second/hash")
changed_paths_file=$e0_tmp/second/paths
dirty_state_file=$e0_tmp/second/status
```

The explicit diff flags keep the receipt independent of color, rename,
text-conversion, and external-diff configuration. Read the NUL-delimited
`changed_paths_file` and `dirty_state_file` directly rather than storing them in
shell variables. Every component command must exit successfully. Fill E0 from
these runtime outputs, not worker prose. An absent sentinel, unknown exit,
changed revision, unstable double capture, ownership conflict, incomplete
domain, or stale artifact is `HOLD` and requires a new capture. This is bounded
stabilization after writers quiesce, not an atomic filesystem snapshot or a
claim to defeat an adversarial ABA mutation.

If G2 runs, send this post-check receipt. After the verdict, repeat the entire
stable double capture and compare `HEAD_SHA`, all four change sets, their union,
`DIFF_SHA256`, and dirty state with the packet. Any mismatch invalidates E0 and
G2; rerun checks, E0, and G2 on the new state before acceptance.

### External checkpoint and handoff

Create the checkpoint outside the checkout only when the reference requires
one:

```bash
if ! repo_root=$(git rev-parse --show-toplevel); then
  printf '%s\n' 'Cannot resolve the checkout root; HOLD.' >&2
  exit 1
fi
if ! repo_root=$(cd -- "$repo_root" && pwd -P); then
  printf '%s\n' 'Cannot canonicalize the checkout root; HOLD.' >&2
  exit 1
fi
temp_root=${TMPDIR:-/tmp}
if ! temp_root=$(cd -- "$temp_root" && pwd -P); then
  printf '%s\n' 'Cannot canonicalize the temporary root; HOLD.' >&2
  exit 1
fi
case "$temp_root/" in
  "$repo_root/"*)
    printf '%s\n' 'Temporary root is inside the checkout; HOLD.' >&2
    exit 1
    ;;
esac
umask 077
if ! checkpoint_dir=$(mktemp -d "$temp_root/hod-adaptive.XXXXXX"); then
  printf '%s\n' 'Cannot create the external checkpoint directory; HOLD.' >&2
  exit 1
fi
if ! checkpoint_dir=$(cd -- "$checkpoint_dir" && pwd -P); then
  printf '%s\n' 'Cannot canonicalize the checkpoint directory; HOLD.' >&2
  exit 1
fi
case "$checkpoint_dir/" in
  "$repo_root/"*)
    printf '%s\n' 'Checkpoint resolved inside the checkout; HOLD.' >&2
    exit 1
    ;;
esac
checkpoint_path="$checkpoint_dir/checkpoint.md"
```

Record the absolute path in the handoff. Only the active coordinator writes
bounded metadata there; workers and advisors do not. This exact local-shell
write is the sole sanctioned control-plane exception to the no-shell-bypass
rule. It authorizes only the one checkpoint path outside the checkout, never a
task file, repository path, worker artifact, or substitute location. Existing
profiles do not mechanically confine an available shell to that path, so this
limit is wording-level and evidence-checked, not a claimed sandbox guarantee.
On resume, reconcile Herdr state, Git state, actual artifacts, and a fresh E0
receipt before any dispatch. If the external path is not writable, do not
broaden the sandbox or fall back into the checkout: use a fresh independent R0,
otherwise `HOLD + ASK_USER`. Retain the directory until the user authorizes
cleanup.

### Permission prompts

Start Claude with the existing role profile and inspect any residual dialog in
the pane. A pre-allow or one-time approval is valid only for the exact action
covered by an exact user authority reference. Missing or ambiguous authority,
generic shell access, wildcard expansion, or a broader relaunch is `HOLD +
ASK_USER`. Never use a dangerous permission bypass or an approval loop. For
Codex, use only sandbox and approval flags confirmed by installed help; a
sandbox failure is evidence to inspect, not permission to widen capability.

## Guarded topology dispatch

Every topology-tracked HOD child and redirect uses `hod dispatch`. The command
performs the read-only capability probes and metadata readbacks around the
mutating leaves. Raw split/start/prompt remains valid for deliberately
untracked work, but those panes may be UNMAPPED and carry no HOD lifecycle
guarantee. Never mix raw mutations with an active HOD dispatch on the same pane.

The exact leaves probed before mutation are `agent start --help`,
`agent prompt --help`, `agent get --help`, `pane get --help`,
`pane report-metadata --help`, and `pane split --help`. An old Herdr without the required report-metadata or
other exact capability fails before split; there is no fallback. Herdr 0.8
places the pane ID immediately after `report-metadata`; `pane split` likewise
requires its pane ID immediately after `split`, before `--direction`, `--cwd`,
and `--no-focus`:

```bash
herdr pane split "$pane_id" --direction "$direction" --cwd "$cwd" --no-focus
```

```bash
printf '%s\n' "$DIRECT_USER_PROMPT" | hod dispatch start \
  --name worker-1 \
  --role worker --task task-slug --run run-id --kind claude \
  --cwd "$PWD" --direction right --timeout 120000 -- \
  --settings .claude/settings.impl.json
```

For an advisor, the user must choose the canonical option explicitly and the
native model must match it exactly:

```bash
printf '%s\n' "$DIRECT_USER_PROMPT" | hod dispatch start \
  --name advisor-1 --role advisor --task task-slug --run run-id --kind claude \
  --cwd "$PWD" --direction right --timeout 120000 \
  --advisor-choice fable --advisor-model fable -- --model fable
```

The command requires a unique `--name`, `HERDR_ENV=1`, a real
`HERDR_PANE_ID`, non-empty direct user prompt stdin, and safe bounded
role/task/run/kind/cwd/direction/timeout values. The name is forwarded exactly
to `agent start`; it is independent of topology role. Before mutation, the
initial controller `pane get` must show no HOD tokens, or an exact controller
token set whose `hod_run` matches the requested run. Child, partial, extra, or
invalid HOD tokens fail before report, split, start, or prompt. It reports the
controller with `herdr pane report-metadata <pane_id> --source hod --ttl-ms 86400000`, reads it back with `pane get`, splits the explicit controller pane
without `--current`, and parses exactly
`.result.pane.pane_id`, and requires the child workspace to match. It derives
the relation internally: worker/delegate, advisor/consult, reviewer/verify,
tester/verify. It reports the child and reads back all five metadata tokens
before `agent start`; native arguments are forwarded only after `--`. Advisor
starts require `--advisor-choice fable|gpt-5.6-sol|opus` and
`--advisor-model` with the same value, plus exactly one matching native `-m` or
`--model`; both flags are rejected for non-advisor roles. `fable` and `opus`
require `--kind claude`, while `gpt-5.6-sol` requires `--kind codex`. The
receipt records `advisor_choice`, `requested_model`, and
`runtime_model_verified=false`; Herdr does not report the runtime model. After a successful start it refreshes and reads the child again, then submits the
prompt with `--wait` and repeated `--until` values for `working`, `blocked`,
`done`, `idle`, and `unknown`, returning after an observed state change instead
of waiting for agent settlement. The prompt capability must advertise all five
states. Successful `agent_started`/`agent_prompted` responses must have the
strict response type and exact name, pane, agent, workspace, terminal identity,
and boolean `interactive_ready`; `agent_status` is limited to `idle`, `working`, `blocked`,
`done`, or `unknown`, and `state_change_seq` is a non-negative safe integer.
After start, `agent get` must confirm the same identity, readiness true, and a
non-working state before the single prompt. Codex may omit agent-session until
after that first prompt; HOD binds the unchanged launch terminal and sequence,
then waits for `agent read --source detection` to show the actual Codex prompt
surface before delivery. The prompt targets the unique agent name and its
receipt must bind back to the expected pane. A sessionless first receipt is
valid only while `working` or `blocked`, never idle/done. Every
redirect requires a later authoritative non-empty, exact session. Prompt
readback must keep the bound identity and advance the sequence. Only an exact JSON
`.error.code == "agent_pane_busy"` gets a bounded retry: at most 10 attempts,
100ms apart. A matching message with another error code stops immediately. Any
capability, report, parse, workspace, readback, start, or prompt failure exits
nonzero; there is no prompt before verified metadata. Stalled prompts and
ambiguous transport do not auto-retry. A NUL byte in prompt stdin is rejected
without truncation, and prompts over 131072 bytes fail before mutation.
Controller workspace, terminal, kind, and session remain exact across mutation;
its pane revision may advance but never regress. The
requested timeout is an overall wall-clock deadline through capability probes,
lock acquisition, metadata, lifecycle calls, and delivery. Failure cleanup has
a separate hard three-second cap. Before any start or prompt attempt, a failure restores staged controller/child metadata
when Herdr accepts the rollback; after an ambiguous lifecycle attempt HOD never
pretends delivery was absent and does not auto-retry. Successful start emits a single JSON receipt containing
`pane_id`, `name`, `role`, `relation`, `task`, and `run`; advisor receipts also
contain `advisor_choice`, `requested_model`, and `runtime_model_verified`.

Use the real child pane ID for redirects and no free-form relation:

```bash
printf '%s\n' "$DIRECT_USER_PROMPT" | hod dispatch prompt \
  --pane "$child_pane" --kind claude \
  --task redirect-slug --run run-id --timeout 120000
```

`hod dispatch prompt` reads the current child role, parent, relation, and run
from authoritative tokens with `pane get`. It requires the parent to equal
the current `HERDR_PANE_ID`, validates the requested run and role/relation
mapping, refreshes controller and child metadata, reads both back, and only
then prompts. Before any `report-metadata` mutation it rejects advisor, pane
working, authoritative agent working, or `interactive_ready != true`. It rejects
a working child from either authoritative `agent get` or pane readback, and an
advisor redirect always fails because each consult is a fresh start. It cannot
reparent a child, and readback never uses `api snapshot`.
A failed readback or report prevents prompt delivery.
Both lifecycle leaves serialize on an atomic per-controller lock. Redirect
requires an explicit expected kind and two unchanged authoritative reads of
name, kind, terminal, agent session, workspace, and sequence. A freshly split
child is closed on a verified pre-start bind failure only after cleanup re-reads
the exact pane, workspace, canonical cwd, terminal, and empty agent/session
identity. If another actor claimed or changed the pane, HOD leaves it open and
fails closed. HOD never closes an unproven pane or a pane after an agent-start
attempt.

Herdr 0.8 does not expose session-CAS on `agent prompt`. The supported contract
therefore requires every coordinator lifecycle operation to use the same HOD
lock; do not run raw stop/start/prompt concurrently against a managed child.
HOD sends to the unique name and verifies the returned session, terminal, and
pane, but cannot retract input after an outside replacement in the final API
interval. Likewise, a split that mutates Herdr but loses its receipt never
proceeds to start; any unproven empty pane is left for explicit inspection
rather than guessed from pane order or cwd.

Only these metadata names are allowed: `hod_role`, `hod_parent`,
`hod_relation`, `hod_task`, and `hod_run`. The root has role/task/run; every
child has all five. `hod_parent` is the direct coordinator pane ID returned by
Herdr or the current `HERDR_PANE_ID`, never a name, focus, order, or guess.
Task labels match `[a-z0-9._-]` and are at most 48 characters. The `hod_run`
value is a safe non-secret identifier for the run. Use one `run_id` for the
controller and every child. If a controller pane is reused, refresh that
controller before reporting or starting any child. An `impl` or
`implementer` profile must report role `worker`, not its profile name.

Advisor routing remains explicit opt-in policy: reserve `advisor`/`consult`
for an adaptive `CONSULT`, require exactly one user-selected `Fable`,
`GPT-5.6 Sol`, or `Opus` before split, and use `HOLD + ASK_USER` when the
choice is absent or unavailable. The implementation defaults to `herdr`; the
`HOD_HERDR_BIN` override is test-only.

## Wait, read, and redirect

```bash
herdr agent wait api_impl --timeout 120000
herdr agent get api_impl
herdr agent read api_impl --source recent-unwrapped --lines 160
```

Without `--until`, a wait settles on `idle`, `done`, or `blocked`; pass
`--until` only to demand one specific state, and request `unknown` explicitly.
On `unknown`, read the output and run `herdr agent explain <target> --verbose`;
never assume completion. Prefer bounded waits; never blind-poll in a tight
loop or abandon a task because one wait timed out.

Redirect with the guarded command, carrying the new evidence or corrected
constraint in direct-user voice. It reads the child topology before delivery;
do not restart or reparent an agent when a follow-up suffices:

```bash
printf '%s\n' "$DIRECT_USER_PROMPT" | hod dispatch prompt \
  --pane "$child_pane" --kind claude \
  --task redirect-slug --run "$run_id" --timeout 120000
```

Use `esc`/`ctrl+c` only for a deliberate, in-scope interruption, and re-read
state afterwards. After an agent exits, refresh `agent list`; never silently
retarget work to a different pane.

## Sentinel-guarded checks

`pane wait-output` searches text already present before it waits, so a generic
match like `passed` from a reused pane proves nothing. For each finite command:

```bash
sentinel="VERIFY_$(date +%s)_$RANDOM"
herdr pane run "$check_pane" "make test; printf '%s exit=%s\n' \"$sentinel\" \"\$?\""
herdr pane wait-output "$check_pane" --match "$sentinel" --timeout 600000
herdr pane read "$check_pane" --source recent-unwrapped --lines 120
```

Use a fresh sentinel per run, and verify both the result and the captured exit
status. For a long-running server, emit a run-specific startup token and
separately verify the process stays alive. `pane run` executes without an
agent, so the output is first-hand evidence and the transcript stays out of
the controller's context.

## Task packet shape

```text
<Concrete outcome in direct-user voice>

Packet ID: <stable UUID for this task lineage>
Task ID: <stable UUID for the parent user objective>
Packet revision: <positive integer starting at 1>
Attempt ID: <UUID unique to this dispatch>
Attempt number: <positive integer starting at 1>
Retry limit: <integer from 0 to 2 fixed before attempt 1>
Retries used: <attempt number minus 1>
Work context: <absolute repository or worktree path>
Files you may modify: <exact paths or globs, or "none; read-only">
Files to read: <specific files>
Dependency inputs: <established interfaces, decisions, or artifacts>

ORCHESTRATE node (omit for DIRECT/SINGLE):
NODE_ID: <stable node ID>
OWNER: <one writer and exact paths or narrow globs>
DEPENDS_ON: none | <upstream NODE_IDs>
READY_WHEN: <observable dispatch precondition>
INPUT_FINGERPRINT: <upstream revision and artifact or evidence hashes>
INVALIDATE_IF: <observable upstream or input change that makes this packet stale>
COMPLETION_CRITERION: <one or more verifiable criteria>
EVIDENCE_REF: none | <current evidence path, ID, or hash>

Acceptance criteria:
- <observable behavior or artifact>
- <required compile, lint, test, or review evidence>

Constraints:
- Preserve unrelated changes.
- Stay within file ownership and user authority.
- Do not start other coding agents.

When finished, state the outcome, files changed, commands run, test results,
and unresolved questions.
```

State whether an input is verified, inferred, or worker-reported when the
distinction matters.

Increment the packet revision when a material input changes. An unchanged
retry gets a new attempt ID and consumes the recorded budget. Once exhausted,
freeze the path and ask the user; a new session, rewording, packet ID, or
revision must not reset the budget.

## Revive a previous session

Most agent CLIs can reload a transcript at startup — Claude Code takes
`--continue` (latest in that directory) or `--resume` (pick one); pass the
flag after `--`. Use revival only when the same role resumes the same work and
its earlier context outweighs the tokens to rebuild it. Never for review or
audit. Record in the ledger that a session was resumed, and from which task,
so a later reader can tell an independent pass from a continued one.

## Worktree checklist

For each worktree: record its absolute path and branch in the ledger; start
its worker with that worktree as the working context; keep ownership disjoint
across worktrees too; avoid broad formatting or generated-file rewrites
outside ownership; commit only when the user or repository workflow authorizes
it; preserve a traceable diff for integration.

## Integrate through one owner

1. Confirm prerequisite workers are settled and their evidence is readable.
2. Inspect each actual diff and artifact before accepting it.
3. Resolve interface mismatches and ownership conflicts (via the integrator
   worker — the controller states the intended outcome, it does not edit).
4. Bring approved changes into the target checkout using the repository's
   permitted workflow.
5. Run validation against the integrated state, not isolated worker states.
6. Request independent read-only review for material code changes.

Worker completion does not transfer ownership; update the ledger before asking
another worker to modify an already-owned file.

## Recover missing full-screen output

Alternate-screen agents may not retain old rows. First enlarge the pane or
read the visible screen. If transcript recovery still fails and existing
authority already permits a report write, allocate one task-scoped temporary
directory and one exact Markdown path, and accept only that exact regular
file: reject substitutions, symlinks, and paths outside the directory. If the
worker was read-only and no written report was authorized, ask the user before
expanding its role. Retain the file for inspection unless cleanup is
authorized.
