#!/usr/bin/env bash

set -euo pipefail

# Behavioral tests for bin/hod. Everything runs inside a disposable temporary
# workspace; the real ~/.hod, ~/.claude, ~/.agents, ~/.local/bin, and real
# projects are never touched. Home-derived paths are overridden via HOD_HOME,
# HOD_BIN_DIR, HOD_CLAUDE_DIR, HOD_AGENTS_DIR, and HOD_REPO_URL.

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)

tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/hod-test.XXXXXX")
tmp_root=$(cd -- "$tmp_root" && pwd -P)
trap 'rm -rf -- "$tmp_root"' EXIT

configure_test_repo_identity() {
  local repo=$1
  git -C "$repo" config user.email "hod-test@example.com"
  git -C "$repo" config user.name "hod-test"
  git -C "$repo" config commit.gpgSign false
}

# Local source repository so install never hits the network.
src_repo=$tmp_root/src-repo
mkdir -p -- "$src_repo"
# Copy working tree (including uncommitted bin/hod under test) into a local git repo.
tar -C "$repo_dir" \
  --exclude .git \
  --exclude .venv \
  -cf - . | tar -C "$src_repo" -xf -
git -C "$src_repo" init -q
configure_test_repo_identity "$src_repo"
git -C "$src_repo" add -A
git -C "$src_repo" commit -q -m "test fixture"

# Fake home layout.
fake_home=$tmp_root/home
hod_home=$fake_home/hod
bin_dir=$fake_home/local/bin
claude_dir=$fake_home/claude
agents_dir=$fake_home/agents
mkdir -p -- "$hod_home" "$bin_dir" "$claude_dir" "$agents_dir"

export HOD_HOME=$hod_home
export HOD_BIN_DIR=$bin_dir
export HOD_CLAUDE_DIR=$claude_dir
export HOD_AGENTS_DIR=$agents_dir
export HOD_REPO_URL=$src_repo
# Ensure PATH sees the fake bin dir for status checks, without requiring real tools
# to disappear — we only override HOD paths.
export PATH="$bin_dir:$PATH"

hod=$repo_dir/bin/hod
chmod +x "$hod" "$repo_dir/install.sh" 2>/dev/null || true

pass=0
fail_count=0
failures=()

record() {
  local name=$1
  local ok=$2

  if [[ "$ok" == true ]]; then
    pass=$((pass + 1))
    printf 'ok: %s\n' "$name"
  else
    fail_count=$((fail_count + 1))
    failures+=("$name")
    printf 'FAIL: %s\n' "$name"
  fi
}

expect_success() {
  local name=$1
  shift
  local output
  if output=$("$@" 2>&1); then
    record "$name" true
  else
    printf '  output: %s\n' "$output" >&2
    record "$name" false
  fi
}

expect_rejection() {
  local name=$1
  shift
  local output
  if output=$("$@" 2>&1); then
    record "$name" false
  else
    record "$name" true
  fi
}

expect_rejection_contains() {
  local name=$1
  local needle=$2
  shift 2
  local out
  if out=$("$@" 2>&1); then
    printf '  output: %s\n' "$out" >&2
    record "$name" false
  elif [[ "$out" == *"$needle"* ]]; then
    record "$name" true
  else
    printf '  output: %s\n' "$out" >&2
    record "$name" false
  fi
}

expect_output_contains() {
  local name=$1
  local needle=$2
  shift 2
  local out
  if out=$("$@" 2>&1) && printf '%s\n' "$out" | grep -qF -- "$needle"; then
    record "$name" true
  else
    printf '  output: %s\n' "$out" >&2
    record "$name" false
  fi
}

expect_output_success() {
  local name=$1
  shift
  local out
  if out=$("$@" 2>&1); then
    record "$name" true
  else
    printf '  output: %s\n' "$out" >&2
    record "$name" false
  fi
}

test_sha256_text() {
  local text=$1
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$text" | shasum -a 256 | cut -d ' ' -f 1
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$text" | sha256sum | cut -d ' ' -f 1
  else
    return 1
  fi
}
check_hod_topology_contract() {
  python3 - "$repo_dir/SKILL.md" "$repo_dir/references/operations.md" <<'PY'
import re
import sys

skill_path, operations_path = sys.argv[1:]
text = "\n".join(
    open(path, encoding="utf-8").read() for path in (skill_path, operations_path)
)

allowed_tokens = {
    "hod_role",
    "hod_parent",
    "hod_relation",
    "hod_task",
    "hod_run",
}
token_names = set(re.findall(r"\bhod_[a-z]+\b", text))
if token_names != allowed_tokens:
    raise SystemExit(f"unexpected topology token names: {sorted(token_names)}")

if "herdr pane report-metadata" not in text or "--source hod" not in text:
    raise SystemExit("report-metadata source contract is missing")
ttl_values = re.findall(r"--ttl-ms\s+([0-9]+)", text)
expected_ttl = 86400000
if not ttl_values or any(int(value) != expected_ttl for value in ttl_values):
    raise SystemExit(
        f"metadata TTL must remain the finite 24-hour value {expected_ttl}: "
        f"{ttl_values}"
    )

if ".result.pane.pane_id" not in text or "HERDR_PANE_ID" not in text:
    raise SystemExit("dispatch does not require real pane IDs")
if "hod dispatch start" not in text or "hod dispatch prompt" not in text:
    raise SystemExit("guarded dispatch path is missing")
if "pane get" not in text or "HOD_HERDR_BIN" not in text:
    raise SystemExit("dispatch readback or test-only Herdr override is missing")
if re.search(r"best-effort|fail-soft|continue the main orchestration unchanged", text, re.I):
    raise SystemExit("supported Herdr topology still claims fail-soft behavior")
if not re.search(r"old Herdr|older Herdr.*fail|before.*split", text, re.I | re.S):
    raise SystemExit("old Herdr failure-before-split behavior is undocumented")
for token in ("--source hod", "--ttl-ms 86400000", "hod_role", "hod_parent", "hod_relation", "hod_task", "hod_run"):
    if token not in text:
        raise SystemExit(f"dispatch metadata contract is missing: {token}")

lines = text.splitlines()
for role, relation in (
    ("worker", "delegate"),
    ("advisor", "consult"),
    ("reviewer", "verify"),
    ("tester", "verify"),
):
    if not any(role in line and relation in line for line in lines):
        raise SystemExit(f"missing {role}/{relation} mapping")
if not re.search(r"impl.*implementer.*report.*worker", text, re.I | re.S):
    raise SystemExit("implementation profiles are not pinned to worker topology")
if not re.search(r"run_id.*controller.*every child", text, re.I | re.S):
    raise SystemExit("shared controller/child run ID contract is missing")
if not re.search(r"controller pane.*reused.*refresh.*before.*child", text, re.I | re.S):
    raise SystemExit("reused-controller run refresh contract is missing")
PY
}

check_hod_topology_privacy() {
  python3 - "$repo_dir/SKILL.md" "$repo_dir/references/operations.md" <<'PY'
import re
import sys

text = "\n".join(open(path, encoding="utf-8").read() for path in sys.argv[1:])
if "[a-z0-9._-]" not in text or not re.search(r"at most 48", text, re.I):
    raise SystemExit("bounded task-label contract is missing")
if re.search(r"hod_task[^\n]*(?:prompt|transcript|secret|credential|api[_-]?key|bearer)", text, re.I):
    raise SystemExit("private or credential-like data appears in task binding")
if not re.search(r"hod_run[^\n]*(?:safe|identifier|run)", text, re.I):
    raise SystemExit("hod_run is not bound to the non-secret run identifier")
PY
}

expect_success 'HOD topology metadata contract is documented' \
  check_hod_topology_contract
expect_success 'HOD topology metadata keeps task labels private and bounded' \
  check_hod_topology_privacy

run_dispatch_regressions() {
  local fake_herdr=$tmp_root/fake-herdr
  local dispatch_cwd=$tmp_root/dispatch-cwd
  mkdir -p -- "$dispatch_cwd"

  cat <<'EOF' | sed 's/\\\$/\$/g' >"$fake_herdr"
#!/usr/bin/env bash

set -euo pipefail

state=\${FAKE_DISPATCH_STATE:?}
scenario=\${FAKE_DISPATCH_SCENARIO:-success}
mkdir -p -- "$state"
order_file=$state/order

log() {
  printf '%s\n' "$1" >>"$order_file"
}

safe_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

token_file() {
  printf '%s/%s.tokens\n' "$state" "$(safe_name "$1")"
}

write_initial_child_tokens() {
  local pane=$1 file child_task
  [[ "$pane" == "\${FAKE_CHILD_PANE:-child-pane}" ]] || return 0
  [[ "\${FAKE_START_FRESH_CHILD:-0}" == 1 ]] && return 0
  [[ "$scenario" == start_missing_child_tokens ]] && return 0
  file=$(token_file "$pane")
  [[ -e "$file" ]] && return 0
  child_task=\${FAKE_INITIAL_CHILD_TASK:-old-task}
  [[ "$scenario" == prompt_invalid_child_task ]] && child_task='bad/task'
  printf 'hod_role=%s\n' "\${FAKE_INITIAL_CHILD_ROLE:-worker}" >"$file"
  printf 'hod_parent=%s\n' "\${FAKE_INITIAL_CHILD_PARENT:-ctl}" >>"$file"
  printf 'hod_relation=%s\n' "\${FAKE_INITIAL_CHILD_RELATION:-delegate}" >>"$file"
  printf 'hod_task=%s\n' "$child_task" >>"$file"
  printf 'hod_run=%s\n' "\${FAKE_INITIAL_CHILD_RUN:-run-redirect}" >>"$file"
}

tokens_json() {
  local file=$1 tokens='{}' key value
  [[ -f "$file" ]] || {
    printf '{}\n'
    return 0
  }
  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || continue
    tokens=$(jq -cn --argjson object "$tokens" --arg key "$key" --arg value "$value" \
      '$object + {($key): $value}')
  done <"$file"
  printf '%s\n' "$tokens"
}

agent_identity_json() {
  local type=$1 status=${2:-idle} ready=${3:-true}
  local name pane kind workspace session_id=session-1 terminal_id
  local sequence revision=5
  name=${FAKE_AGENT_NAME:-child-agent}
  pane=${FAKE_CHILD_PANE:-child-pane}
  kind=${FAKE_AGENT_KIND:-claude}
  workspace=${FAKE_WORKSPACE:-ws-main}
  terminal_id=term-$(safe_name "$pane")
  [[ -f "$state/agent-name" ]] && name=$(<"$state/agent-name")
  [[ -f "$state/agent-pane" ]] && pane=$(<"$state/agent-pane")
  [[ -f "$state/agent-kind" ]] && kind=$(<"$state/agent-kind")
  [[ -f "$state/agent-terminal" ]] && terminal_id=$(<"$state/agent-terminal")
  sequence=0
  [[ -f "$state/agent-seq" ]] && sequence=$(<"$state/agent-seq")
  case "$scenario" in
    wrong_start_identity)
      [[ "$type" == agent_started ]] && name=wrong-start-name
      ;;
    wrong_prompt_identity)
      [[ "$type" == agent_prompted ]] && pane=wrong-prompt-pane
      ;;
    wrong_get_identity)
      [[ "$type" == agent_info ]] && workspace=wrong-get-workspace
      ;;
    prompt_kind_drift)
      [[ "$type" == agent_info && "${get_count:-0}" -ge 2 ]] && kind=codex
      ;;
    prompt_identity_drift)
      [[ "$type" == agent_info && "${get_count:-0}" -ge 2 ]] && name=replaced-agent
      ;;
    prompt_session_drift)
      [[ "$type" == agent_info && "${get_count:-0}" -ge 2 ]] && session_id=session-2
      ;;
    prompt_terminal_drift)
      [[ "$type" == agent_info && "${get_count:-0}" -ge 2 ]] && terminal_id=term-replaced
      ;;
    start_terminal_drift)
      [[ "$type" == agent_info ]] && terminal_id=term-replaced
      ;;
    start_wrong_launch_terminal)
      [[ "$type" == agent_started ]] && terminal_id=term-replaced
      ;;
    start_state_drift)
      [[ "$type" == agent_info ]] && sequence=0
      ;;
    start_session_deferred|start_sessionless_done)
      session_id=''
      ;;
    prompt_missing_session)
      [[ "$type" == agent_prompted ]] && session_id=''
      ;;
  esac
  jq -cn \
    --arg type "$type" \
    --arg name "$name" \
    --arg pane_id "$pane" \
    --arg agent "$kind" \
    --arg workspace_id "$workspace" \
    --arg status "$status" \
    --arg session_id "$session_id" \
    --arg terminal_id "$terminal_id" \
    --argjson state_change_seq "$sequence" \
    --argjson revision "$revision" \
    --argjson ready "$ready" \
    '{result: {type: $type, agent: {
      name: $name,
      pane_id: $pane_id,
      agent: $agent,
      agent_session: (if $session_id == "" then null else
        {agent: $agent, kind: "id", source: "herdr:test", value: $session_id} end),
      terminal_id: $terminal_id,
      workspace_id: $workspace_id,
      interactive_ready: $ready,
      launch_pending: ($ready | not),
      agent_status: $status,
      state_change_seq: $state_change_seq,
      revision: $revision
    }}}'
}

help_output() {
  case "$1 $2" in
    'agent start')
      if [[ "$scenario" == missing_capability ]]; then
        printf '%s\n' 'Usage: herdr agent start <NAME>'
      else
        printf '%s\n' \
          'Usage: herdr agent start <NAME> --kind <KIND> --pane <ID> [OPTIONS] [-- [AGENT_ARG]...]' \
          '--kind <KIND>' \
          '[possible values: pi, claude, codex, grok]' \
          '--pane <ID>' \
          '--timeout <MS>'
      fi
      ;;
    'agent prompt')
      printf '%s\n' \
        'Usage: herdr agent prompt <TARGET> <TEXT> [OPTIONS]' \
        '--wait' '--until <STATUS>' \
        '[possible values: idle, working, blocked, done, unknown]' \
        '--timeout <MS>'
      ;;
    'agent get')
      printf '%s\n' 'Usage: herdr agent get <TARGET>'
      ;;
    'agent read')
      printf '%s\n' \
        'Usage: herdr agent read <TARGET> [OPTIONS]' \
        '--source <SOURCE>' '[possible values: visible, recent, recent-unwrapped, detection]' \
        '--lines <N>' '--format <FORMAT>' '[possible values: text, ansi]'
      ;;
    'pane get')
      printf '%s\n' 'Usage: herdr pane get <pane_id>'
      ;;
    'pane report-metadata')
      if [[ "$scenario" == missing_capability ]]; then
        printf '%s\n' 'Usage: herdr pane report-metadata [OPTIONS] <PANE_ID>' '--source <ID>'
      else
        printf '%s\n' \
          'Usage: herdr pane report-metadata [OPTIONS] --source <ID> <PANE_ID>' \
          '--source <ID>' '--token <NAME=VALUE>' '--clear-token <NAME>' '--ttl-ms <N>'
      fi
      ;;
    'pane split')
      printf '%s\n' \
        'Usage: herdr pane split [OPTIONS] [PANE_ID]' \
        '--direction <DIRECTION>' '[possible values: right, down]' \
        '--cwd <PATH>' '--no-focus'
      ;;
    'pane close')
      printf '%s\n' 'Usage: herdr pane close <pane_id>'
      ;;
  esac
}

if [[ "\${3:-}" == --help ]]; then
  help_output "$1" "$2"
  exit 0
fi

if [[ "\${1:-}" == pane && "\${2:-}" == report-metadata ]]; then
  pane=\${3:-}
  log "report:$pane"
  count_file=$state/report-count
  count=0
  [[ -f "$count_file" ]] && count=$(<"$count_file")
  count=$((count + 1))
  printf '%s\n' "$count" >"$count_file"
  printf '%s\0' "$@" >"$state/report-$count.argv"
  if [[ "$scenario" == report_fail ||
    ( ( "$scenario" == child_report_fail || "$scenario" == child_report_close_fail ||
      "$scenario" == cleanup_agent_claimed ||
      "$scenario" == cleanup_get_term_ignoring ||
      "$scenario" == cleanup_early_expiry ) &&
      "$pane" == "\${FAKE_CHILD_PANE:-child-pane}" ) ]]; then
    [[ "$scenario" == cleanup_agent_claimed ]] && : >"$state/cleanup-agent-claimed"
    [[ "$scenario" == cleanup_get_term_ignoring ]] && : >"$state/cleanup-hang"
    [[ "$scenario" == cleanup_early_expiry ]] && : >"$state/cleanup-early-expiry"
    printf '%s\n' 'report_failure' >&2
    exit 23
  fi
  file=$(token_file "$pane")
  : >"$file"
  args=("$@")
  for ((index = 4; index < \${#args[@]}; index += 1)); do
    if [[ "\${args[index]}" == --token && $((index + 1)) -lt \${#args[@]} ]]; then
      item=\${args[index + 1]}
      printf '%s\n' "$item" >>"$file"
    fi
  done
  exit 0
fi

write_initial_controller_tokens() {
  local controller_file controller_run controller_task
  [[ "$pane" == "\${FAKE_CONTROLLER_PANE:-ctl}" ]] || return 0
  [[ "\${FAKE_INITIAL_CONTROLLER_ROLE:-}" == controller ]] || return 0
  [[ "$scenario" == start_bootstrap_empty ]] && return 0
  controller_file=$(token_file "$pane")
  [[ -e "$controller_file" ]] && return 0
  case "$scenario" in
    start_child_tokens)
      printf 'hod_role=worker\n' >"$controller_file"
      printf 'hod_parent=other-controller\n' >>"$controller_file"
      printf 'hod_relation=delegate\n' >>"$controller_file"
      printf 'hod_task=old-child-task\n' >>"$controller_file"
      printf 'hod_run=%s\n' "\${FAKE_INITIAL_CONTROLLER_RUN:-old-run}" >>"$controller_file"
      return 0
      ;;
    start_partial_tokens)
      printf 'hod_role=controller\n' >"$controller_file"
      printf 'hod_run=%s\n' "\${FAKE_INITIAL_CONTROLLER_RUN:-old-run}" >>"$controller_file"
      return 0
      ;;
    start_invalid_tokens)
      printf 'hod_role=controller\n' >"$controller_file"
      printf 'hod_task=old-controller-task\n' >>"$controller_file"
      printf 'hod_run=%s\n' "\${FAKE_INITIAL_CONTROLLER_RUN:-old-run}" >>"$controller_file"
      printf 'hod_extra=unexpected\n' >>"$controller_file"
      return 0
      ;;
  esac
  controller_run=\${FAKE_INITIAL_CONTROLLER_RUN:-old-controller-run}
  controller_task=\${FAKE_INITIAL_CONTROLLER_TASK:-old-controller-task}
  [[ "$scenario" == start_controller_wrong_run ]] && controller_run=other-controller-run
  [[ "$scenario" == start_invalid_existing_task ]] && controller_task='bad/task'
  [[ "$scenario" == start_invalid_existing_run ]] && controller_run='bad/run'
  printf 'hod_role=controller\n' >"$controller_file"
  printf 'hod_task=%s\n' "$controller_task" >>"$controller_file"
  printf 'hod_run=%s\n' "$controller_run" >>"$controller_file"
}

if [[ "\${1:-}" == pane && "\${2:-}" == close ]]; then
  log "close:\${3:-}"
  printf '%s\0' "$@" >"$state/close.argv"
  if [[ "$scenario" == child_report_close_fail ]]; then
    printf '%s\n' 'close_failure' >&2
    exit 51
  fi
  exit 0
fi

if [[ "\${1:-}" == pane && "\${2:-}" == get ]]; then
  pane=\${3:-}
  log "get:$pane"
  if [[ "$scenario" == cleanup_get_term_ignoring &&
    "$pane" == "\${FAKE_CHILD_PANE:-child-pane}" && -f "$state/cleanup-hang" ]]; then
    trap '' TERM
    exec sleep 30
  fi
  if [[ "$scenario" == cleanup_early_expiry &&
    "$pane" == "\${FAKE_CHILD_PANE:-child-pane}" &&
    -f "$state/cleanup-early-expiry" ]]; then
    kill -USR1 "$PPID"
    trap '' TERM
    exec sleep 30
  fi
  if [[ "$scenario" == get_fail ]]; then
    printf '%s\n' 'readback_failure' >&2
    exit 29
  fi
  write_initial_controller_tokens
  write_initial_child_tokens "$pane"
  file=$(token_file "$pane")
  if [[ "$scenario" == readback_fail || "$scenario" == prompt_readback_fail ]] &&
    [[ "$pane" == "\${FAKE_CHILD_PANE:-child-pane}" ]]; then
    : >"$state/malformed-readback"
    printf '%s\n' '{"result":{"pane":'
    exit 0
  fi
  tokens=$(tokens_json "$file")
  workspace=\${FAKE_WORKSPACE:-ws-main}
  if [[ "$scenario" == prompt_controller_workspace_drift &&
    "$pane" == "\${FAKE_CONTROLLER_PANE:-ctl}" && -f "$state/report-count" ]]; then
    workspace=ws-other
  fi
  agent_status=idle
  agent=''
  agent_session=''
  terminal_id=term-$(safe_name "$pane")
  pane_revision=0
  if [[ "$scenario" == malformed_tokens && "$pane" == "\${FAKE_CONTROLLER_PANE:-ctl}" ]]; then
    jq -cn \
      --arg pane_id "$pane" --arg workspace_id "$workspace" \
      --arg cwd "\${FAKE_CWD:-/tmp}" --arg agent_status "$agent_status" \
      '{result:{pane:{pane_id:$pane_id,workspace_id:$workspace_id,cwd:$cwd,
        agent_status:$agent_status,revision:0,tokens:"malformed"}}}'
    exit 0
  fi
  if [[ "$scenario" == wrong_workspace && "$pane" == "\${FAKE_CHILD_PANE:-child-pane}" ]]; then
    workspace=ws-other
  fi
  if [[ "$pane" == "\${FAKE_CHILD_PANE:-child-pane}" ]]; then
    if [[ -f "$state/started" ]]; then
      agent=\${FAKE_AGENT_KIND:-claude}
      agent_session=session-1
      pane_revision=5
    elif [[ "\${FAKE_START_FRESH_CHILD:-0}" != 1 ]]; then
      agent=\${FAKE_AGENT_KIND:-claude}
      agent_session=session-1
      pane_revision=5
    elif [[ "$scenario" == start_child_preclaimed ]]; then
      agent=codex
      agent_session=claimed-session
    elif [[ "$scenario" == cleanup_agent_claimed &&
      -f "$state/cleanup-agent-claimed" ]]; then
      agent=codex
    fi
    if [[ "$scenario" == start_child_claimed_after_report &&
      -f "$state/report-count" && "$(<"$state/report-count")" -ge 2 ]]; then
      agent=codex
      agent_session=claimed-after-report
      pane_revision=1
    fi
    if [[ "$scenario" == prompt_session_drift &&
      -f "$state/agent-get-count" && "$(<"$state/agent-get-count")" -ge 2 ]]; then
      agent_session=session-2
      pane_revision=6
    fi
    [[ "$scenario" == working_child ]] && agent_status=working
    if [[ "$scenario" == final_workspace_race && -e "$state/prompted" ]]; then
      workspace=ws-race
    fi
    if [[ "$scenario" == wrong_parent ]]; then
      tokens=$(jq -cn --argjson object "$tokens" '$object + {hod_parent:"other-parent"}')
    elif [[ "$scenario" == wrong_run ]]; then
      tokens=$(jq -cn --argjson object "$tokens" '$object + {hod_run:"other-run"}')
    elif [[ "$scenario" == wrong_relation ]]; then
      tokens=$(jq -cn --argjson object "$tokens" '$object + {hod_relation:"consult"}')
    elif [[ "$scenario" == post_start_mismatch && -e "$state/started" ]]; then
      tokens=$(jq -cn --argjson object "$tokens" '$object + {hod_run:"post-start-wrong"}')
    fi
  elif [[ "$pane" == "\${FAKE_CONTROLLER_PANE:-ctl}" ]]; then
    if [[ "$scenario" == start_controller_revision_regress ]]; then
      pane_revision=5
      [[ -f "$state/report-count" ]] && pane_revision=0
    fi
    if [[ "$scenario" == start_controller_terminal_drift && -f "$state/report-count" ]]; then
      terminal_id=term-replaced-controller
    fi
    if [[ "$scenario" == prompt_controller_session_drift && -f "$state/report-count" ]]; then
      agent=codex
      agent_session=replaced-controller-session
    fi
    if [[ "$scenario" == rollback_controller_session_drift && -f "$state/split.argv" ]]; then
      agent=codex
      agent_session=replaced-controller-session
      pane_revision=1
    fi
  fi
  pane_json=$(jq -cn \
    --arg pane_id "$pane" \
    --arg workspace_id "$workspace" \
    --arg cwd "\${FAKE_CWD:-/tmp}" \
    --arg agent_status "$agent_status" \
    --arg agent "$agent" \
    --arg agent_session "$agent_session" \
    --arg terminal_id "$terminal_id" \
    --argjson revision "$pane_revision" \
    --argjson tokens "$tokens" \
    '{result:{pane:{pane_id:$pane_id, workspace_id:$workspace_id, cwd:$cwd,
      agent_status:$agent_status,
      agent:(if $agent == "" then null else $agent end),
      agent_session:(if $agent_session == "" then null else
        {agent:$agent,kind:"id",source:"herdr:test",value:$agent_session} end),
      terminal_id:$terminal_id,revision:$revision,tokens:$tokens}}}')
  if [[ "$scenario" == start_missing_child_tokens &&
    "$pane" == "\${FAKE_CHILD_PANE:-child-pane}" && ! -f "$file" ]]; then
    printf '%s\n' "$pane_json" | jq -c 'del(.result.pane.tokens)'
  else
    printf '%s\n' "$pane_json"
  fi
  exit 0
fi

if [[ "\${1:-}" == agent && "\${2:-}" == get ]]; then
  target=\${3:-}
  log "agent-get:$target"
  if [[ "$scenario" == get_fail ]]; then
    printf '%s\n' 'agent_get_failure' >&2
    exit 29
  fi
  if [[ "$scenario" == get_hang ]]; then
    exec sleep 5
  fi
  if [[ "$scenario" == get_term_ignoring ]]; then
    trap '' TERM
    exec sleep 30
  fi
  get_count_file=$state/agent-get-count
  get_count=0
  [[ -f "$get_count_file" ]] && get_count=$(<"$get_count_file")
  get_count=$((get_count + 1))
  printf '%s\n' "$get_count" >"$get_count_file"
  ready=true
  status=idle
  if [[ "$scenario" == delayed_readiness && $get_count -lt 3 ]]; then
    ready=false
  elif [[ "$scenario" == readiness_never ]]; then
    ready=false
  elif [[ "$scenario" == working_after_start ||
    "$scenario" == prompt_agent_working ]]; then
    status=working
  elif [[ "$scenario" == prompt_agent_not_ready ]]; then
    ready=false
  fi
  if [[ "$scenario" == prompt_state_drift && $get_count -ge 2 ]]; then
    printf '%s\n' 2 >"$state/agent-seq"
  fi
  if [[ "$scenario" == delayed_readiness && $get_count -le 3 ]]; then
    printf '%s\n' "$get_count" >"$state/agent-seq"
  elif [[ ! -f "$state/agent-seq" ]]; then
    printf '%s\n' 1 >"$state/agent-seq"
  fi
  agent_identity_json agent_info "$status" "$ready"
  exit 0
fi

if [[ "\${1:-}" == agent && "\${2:-}" == read ]]; then
  target=\${3:-}
  log "agent-read:$target"
  read_count_file=$state/agent-read-count
  read_count=0
  [[ -f "$read_count_file" ]] && read_count=$(<"$read_count_file")
  read_count=$((read_count + 1))
  printf '%s\n' "$read_count" >"$read_count_file"
  if [[ "$scenario" == codex_surface_never ||
    ( "$scenario" == codex_surface_delayed && $read_count -lt 3 ) ]]; then
    printf '%s\n' 'codex process launching'
  else
    printf '%s\n' 'OpenAI Codex' '› Ready'
  fi
  exit 0
fi

if [[ "\${1:-}" == pane && "\${2:-}" == split ]]; then
  if [[ $# -ne 8 || -z "\${3:-}" || "\${3:-}" == --* ||
    "\${4:-}" != --direction || -z "\${5:-}" ||
    "\${6:-}" != --cwd || -z "\${7:-}" ||
    "\${8:-}" != --no-focus ]]; then
    printf '%s\n' 'pane split requires PANE_ID immediately after split' >&2
    exit 32
  fi
  log split
  printf '%s\0' "$@" >"$state/split.argv"
  if [[ "$scenario" == split_failure || "$scenario" == rollback_controller_session_drift ]]; then
    printf '%s\n' 'split_failure' >&2
    exit 31
  fi
  if [[ "$scenario" == split_bad_json ]]; then
    printf '%s\n' '{}'
    exit 0
  fi
  child=\${FAKE_CHILD_PANE:-child-pane}
  [[ "$scenario" == split_same_controller ]] && child=\${FAKE_CONTROLLER_PANE:-ctl}
  printf '%s\n' "$child" >"$state/child"
  workspace=\${FAKE_WORKSPACE:-ws-main}
  [[ "$scenario" == wrong_workspace ]] && workspace=ws-other
  jq -cn --arg pane_id "$child" --arg workspace_id "$workspace" \
    --arg terminal_id "term-$(safe_name "$child")" \
    '{result:{pane:{pane_id:$pane_id, workspace_id:$workspace_id,
      terminal_id:$terminal_id}}}'
  exit 0
fi

if [[ "\${1:-}" == agent && "\${2:-}" == start ]]; then
  agent_name=\${3:-}
  log start
  printf '%s\0' "$@" >"$state/start.argv"
  args=("$@")
  kind=claude
  pane=\${FAKE_CHILD_PANE:-child-pane}
  for ((index = 0; index < \${#args[@]}; index += 1)); do
    [[ "\${args[index]}" == --kind ]] && kind=\${args[index + 1]}
    [[ "\${args[index]}" == --pane ]] && pane=\${args[index + 1]}
  done
  printf '%s\n' "$agent_name" >"$state/agent-name"
  printf '%s\n' "$kind" >"$state/agent-kind"
  printf '%s\n' "$pane" >"$state/agent-pane"
  FAKE_AGENT_NAME="$agent_name"
  FAKE_AGENT_KIND="$kind"
  FAKE_CHILD_PANE="$pane"
  export FAKE_AGENT_NAME FAKE_AGENT_KIND FAKE_CHILD_PANE
  if [[ "$scenario" == duplicate_name ]]; then
    printf '%s\n' '{"error":{"code":"agent_name_taken","message":"duplicate agent name"}}' >&2
    exit 37
  fi
  if [[ "$scenario" == malformed_start_exit0 ]]; then
    printf '%s\n' '{}'
    exit 0
  fi
  if [[ "$scenario" == forged_start_exit0 ]]; then
    printf '%s\n' '{"result":{"type":"agent_started","agent":{"name":"forged"}}}'
    exit 0
  fi
  if [[ "$scenario" == start_fail ]]; then
    printf '%s\n' '{"error":{"code":"agent_start_failed","message":"start_failure"}}' >&2
    exit 37
  fi
  if [[ "$scenario" == start_message_contains_busy ]]; then
    printf '%s\n' \
      '{"error":{"code":"agent_start_failed","message":"agent_pane_busy"}}' >&2
    exit 37
  fi
  if [[ "$scenario" == busy_once && ! -e "$state/busy-seen" ]]; then
    : >"$state/busy-seen"
    printf '%s\n' \
      '{"error":{"code":"agent_pane_busy","message":"short race"}}' >&2
    exit 41
  fi
  if [[ "$scenario" == busy_always ]]; then
    printf '%s\n' \
      '{"error":{"code":"agent_pane_busy","message":"persistent race"}}' >&2
    exit 41
  fi
  : >"$state/started"
  printf '%s\n' 1 >"$state/agent-seq"
  if [[ "$scenario" == start_not_ready || "$scenario" == delayed_readiness ]]; then
    agent_identity_json agent_started idle false
  else
    agent_identity_json agent_started idle true
  fi
  exit 0
fi

if [[ "\${1:-}" == agent && "\${2:-}" == prompt ]]; then
  log prompt
  printf '%s\0' "$@" >"$state/prompt.argv"
  if [[ "$scenario" == prompt_fail ]]; then
    printf '%s\n' 'prompt_failure' >&2
    exit 43
  fi
  if [[ "$scenario" == prompt_stalled ]]; then
    printf '%s\n' '{"error":{"code":"agent_prompt_stalled","message":"prompt stalled"}}' >&2
    exit 47
  fi
  if [[ "$scenario" == malformed_prompt_exit0 ]]; then
    printf '%s\n' '{"result":{"type":"agent_prompted"'
    exit 0
  fi
  if [[ "$scenario" == forged_prompt_exit0 ]]; then
    printf '%s\n' '{"result":{"agent_status":"working"}}'
    exit 0
  fi
  prompt_seq=1
  [[ -f "$state/agent-seq" ]] && prompt_seq=$(<"$state/agent-seq")
  if [[ "$scenario" == stale_prompt_seq ]]; then
    printf '%s\n' "$prompt_seq" >"$state/agent-seq"
  else
    prompt_seq=$((prompt_seq + 1))
    printf '%s\n' "$prompt_seq" >"$state/agent-seq"
  fi
  if [[ "$scenario" == prompt_blocked ]]; then
    : >"$state/prompted"
    agent_identity_json agent_prompted blocked true
    exit 0
  fi
  if [[ "$scenario" == start_sessionless_done ]]; then
    : >"$state/prompted"
    agent_identity_json agent_prompted done true
    exit 0
  fi
  : >"$state/prompted"
  agent_identity_json agent_prompted working true
  exit 0
fi

printf 'unexpected fake Herdr argv:' >&2
printf ' %q' "$@" >&2
printf '\n' >&2
exit 97
EOF
  chmod +x "$fake_herdr"

  dispatch_relation() {
    case "$1" in
      worker) printf 'delegate\n' ;;
      advisor) printf 'consult\n' ;;
      reviewer|tester) printf 'verify\n' ;;
      *) return 1 ;;
    esac
  }

  dispatch_start() {
    local state=$1 role=$2 task=$3 run=$4 kind=$5 cwd=$6 direction=$7
    local timeout=$8 scenario=$9 prompt=${10} name=${11:-}
    local name_option=${12:---name}
    local advisor_choice=${13:-} advisor_model=${14:-} native_model controller_task
    native_model=$role-model
    controller_task=$task
    case "$scenario" in
      duplicate_name|split_failure|split_bad_json|child_report_fail|cleanup_agent_claimed|\
      rollback_controller_session_drift|start_child_claimed_after_report|\
      cleanup_get_term_ignoring|cleanup_early_expiry)
        controller_task=original-task
        ;;
    esac
    if [[ "$role" == advisor && "$advisor_model" != __omit__ ]]; then
      native_model=$advisor_model
    elif [[ "$role" == advisor ]]; then
      native_model=arbitrary-model
    fi
    local -a start_args=("$hod" dispatch start)
    [[ -n "$name" ]] && start_args+=("$name_option" "$name")
    start_args+=(
      --role "$role"
      --task "$task"
      --run "$run"
      --kind "$kind"
      --cwd "$cwd"
      --direction "$direction"
      --timeout "$timeout"
    )
    if [[ "$role" == advisor && "$advisor_choice" != __omit__ &&
      "$advisor_model" != __omit__ ]]; then
      start_args+=(--advisor-choice "$advisor_choice" --advisor-model "$advisor_model")
    elif [[ "$role" != advisor && ( -n "$advisor_choice" || -n "$advisor_model" ) ]]; then
      start_args+=(--advisor-choice "${advisor_choice:-fable}" --advisor-model "${advisor_model:-fable}")
    fi
    case ${HOD_TEST_NATIVE_MODE:-default} in
      resume)
        start_args+=(-- resume session-id)
        ;;
      claude-resume)
        start_args+=(-- --resume session-id)
        ;;
      dangerous)
        start_args+=(-- --model "$native_model" --dangerously-skip-permissions)
        ;;
      dangerous-equals)
        start_args+=(-- --model "$native_model" --dangerously-skip-permissions=true)
        ;;
      allow-dangerous)
        start_args+=(-- --model "$native_model" --allow-dangerously-skip-permissions)
        ;;
      codex-dangerous)
        start_args+=(-- --model "$native_model" --dangerously-bypass-approvals-and-sandbox)
        ;;
      codex-hook-dangerous)
        start_args+=(-- --model "$native_model" --dangerously-bypass-hook-trust)
        ;;
      yolo)
        start_args+=(-- --model "$native_model" --yolo)
        ;;
      sandbox-danger-short)
        start_args+=(-- --model "$native_model" -s danger-full-access)
        ;;
      sandbox-danger-long)
        start_args+=(-- --model "$native_model" --sandbox danger-full-access)
        ;;
      sandbox-danger-equals)
        start_args+=(-- --model "$native_model" --sandbox=danger-full-access)
        ;;
      permission-bypass)
        start_args+=(-- --model "$native_model" --permission-mode bypassPermissions)
        ;;
      permission-bypass-equals)
        start_args+=(-- --model "$native_model" --permission-mode=bypassPermissions)
        ;;
      config-sandbox-danger)
        start_args+=(-- --model "$native_model" -c 'sandbox_mode="danger-full-access"')
        ;;
      config-sandbox-danger-escaped)
        start_args+=(-- --model "$native_model" -c 'sandbox_mode="danger\u002dfull\u002daccess"')
        ;;
      inline-settings-bypass)
        start_args+=(-- --model "$native_model" --settings '{"permissions":{"defaultMode":"bypassPermissions"}}')
        ;;
      inline-settings-bypass-escaped)
        start_args+=(-- --model "$native_model" --settings '{"permissions":{"defaultMode":"bypass\u0050ermissions"}}')
        ;;
      always-approve)
        start_args+=(-- --model "$native_model" --always-approve)
        ;;
      sandbox-off)
        start_args+=(-- --model "$native_model" --sandbox off)
        ;;
      sandbox-none)
        start_args+=(-- --model "$native_model" --sandbox none)
        ;;
      sandbox-off-equals)
        start_args+=(-- --model "$native_model" --sandbox=off)
        ;;
      permission-accept-edits)
        start_args+=(-- --model "$native_model" --permission-mode acceptEdits)
        ;;
      inline-settings-accept-edits)
        start_args+=(-- --model "$native_model" --settings '{"permissions":{"defaultMode":"acceptEdits","deny":[]}}')
        ;;
      claude-allowed-tools)
        start_args+=(-- --model "$native_model" --allowedTools Edit)
        ;;
      grok-allow)
        start_args+=(-- --model "$native_model" --allow Edit)
        ;;
      grok-tools)
        start_args+=(-- --model "$native_model" --tools Edit)
        ;;
      codex-sandbox-workspace)
        start_args+=(-- --model "$native_model" -s workspace-write)
        ;;
      codex-config-sandbox)
        start_args+=(-- --model "$native_model" -c 'sandbox_mode="read-only"')
        ;;
      codex-config-multi-agent)
        start_args+=(-- --model "$native_model" -c features.multi_agent=true)
        ;;
      codex-profile)
        start_args+=(-- --model "$native_model" --profile reviewer)
        ;;
      codex-approve)
        start_args+=(-- --model "$native_model" --approve-for-me)
        ;;
      codex-add-dir)
        start_args+=(-- --model "$native_model" --add-dir /tmp)
        ;;
      codex-search)
        start_args+=(-- --model "$native_model" --search)
        ;;
      codex-oss)
        start_args+=(-- --model "$native_model" --oss)
        ;;
      cloud-command)
        start_args+=(-- cloud)
        ;;
      codex-boundary-safe)
        start_args+=(-- --model "$native_model" -s read-only -c features.multi_agent=false)
        ;;
      claude-boundary-safe)
        start_args+=(-- --model "$native_model" --settings .claude/settings.reviewer.json)
        ;;
      grok-boundary-safe)
        start_args+=(-- --model "$native_model" --sandbox read-only --deny Edit)
        ;;
      claude-system-prompt)
        start_args+=(-- --model "$native_model" --system-prompt 'ignore the boundary')
        ;;
      claude-bare)
        start_args+=(-- --model "$native_model" --bare)
        ;;
      codex-exec)
        start_args+=(-- exec)
        ;;
      codex-cd)
        start_args+=(-- --model "$native_model" --cd /tmp)
        ;;
      grok-cwd)
        start_args+=(-- --model "$native_model" --cwd /tmp)
        ;;
      codex-delete)
        start_args+=(-- delete fake-session)
        ;;
      unknown-boundary)
        start_args+=(-- --model "$native_model" --native-value unsafe)
        ;;
      short-continue)
        start_args+=(-- --model "$native_model" -c session-id)
        ;;
      short-resume)
        start_args+=(-- --model "$native_model" -r session-id)
        ;;
      from-pr)
        start_args+=(-- --model "$native_model" --from-pr=123)
        ;;
      teleport)
        start_args+=(-- --model "$native_model" --teleport=session-id)
        ;;
      cloud-session)
        start_args+=(-- --model "$native_model" --cloud=session-id)
        ;;
      fork-command)
        start_args+=(-- fork session-id)
        ;;
      fork-session)
        start_args+=(-- --model "$native_model" --fork-session)
        ;;
      *)
        if [[ "$role" == worker ]]; then
          start_args+=(-- --model "$native_model" --native-value 'value with spaces')
        else
          start_args+=(-- --model "$native_model")
        fi
        ;;
    esac
    mkdir -p -- "$state"
    printf '%s' "$prompt" | env \
      HERDR_ENV=1 \
      HERDR_PANE_ID=ctl \
      HOD_HERDR_BIN="$fake_herdr" \
      FAKE_DISPATCH_STATE="$state" \
      FAKE_DISPATCH_SCENARIO="$scenario" \
      FAKE_CHILD_PANE=child-pane \
      FAKE_WORKSPACE=ws-main \
      FAKE_CWD="$cwd" \
      FAKE_START_FRESH_CHILD=1 \
      FAKE_INITIAL_CHILD_ROLE="$role" \
      FAKE_INITIAL_CHILD_PARENT=ctl \
      FAKE_INITIAL_CHILD_RELATION="$(dispatch_relation "$role" 2>/dev/null || printf 'delegate')" \
      FAKE_INITIAL_CHILD_RUN="$run" \
      FAKE_INITIAL_CONTROLLER_ROLE=controller \
      FAKE_INITIAL_CONTROLLER_TASK="$controller_task" \
      FAKE_INITIAL_CONTROLLER_RUN="$run" \
      "${start_args[@]}" \
      >"$state/receipt.json"
  }

  dispatch_start_with_native_mode() {
    local mode=$1
    shift
    HOD_TEST_NATIVE_MODE=$mode dispatch_start "$@"
  }

  dispatch_prompt() {
    local state=$1 task=$2 run=$3 role=$4 scenario=$5 prompt=$6
    local parent=ctl relation controller_run=run-redirect
    shift 6
    relation=$(dispatch_relation "$role")
    case "$scenario" in
      prompt_wrong_parent) parent=other-parent ;;
      prompt_wrong_relation) relation=consult ;;
      prompt_wrong_run) run=other-run ;;
      stale_controller) controller_run=old-controller-run ;;
    esac
    mkdir -p -- "$state"
    printf '%s' "$prompt" | env \
      HERDR_ENV=1 \
      HERDR_PANE_ID=ctl \
      HOD_HERDR_BIN="$fake_herdr" \
      FAKE_DISPATCH_STATE="$state" \
      FAKE_DISPATCH_SCENARIO="$scenario" \
      FAKE_CHILD_PANE=child-pane \
      FAKE_WORKSPACE=ws-main \
      FAKE_INITIAL_CHILD_ROLE="$role" \
      FAKE_INITIAL_CHILD_PARENT="$parent" \
      FAKE_INITIAL_CHILD_RELATION="$relation" \
      FAKE_INITIAL_CHILD_RUN="$run" \
      FAKE_INITIAL_CHILD_TASK=old-task \
      FAKE_INITIAL_CONTROLLER_ROLE=controller \
      FAKE_INITIAL_CONTROLLER_TASK=old-controller-task \
      FAKE_INITIAL_CONTROLLER_RUN="$controller_run" \
      FAKE_AGENT_NAME=redirect-agent \
      FAKE_AGENT_KIND=claude \
      "$hod" dispatch prompt \
      --pane child-pane \
      --kind claude \
      --task "$task" \
      --run run-redirect \
      --timeout 120000 \
      "$@"
  }

  assert_no_lifecycle_after_failure() {
    local state=$1
    [[ ! -f "$state/order" ]] || ! grep -Eq '(^|:)(start|prompt)$' "$state/order"
  }

  assert_no_dispatch_mutation() {
    local state=$1
    [[ ! -f "$state/order" ]] ||
      ! grep -Eq '^(report|split|start|prompt)(:|$)' "$state/order"
  }

  assert_no_report_or_prompt() {
    local state=$1
    [[ ! -f "$state/order" ]] || ! grep -Eq '^(report|prompt)(:|$)' "$state/order"
  }

  dispatch_start_with_nul() {
    local state=$1
    mkdir -p -- "$state"
    printf 'prefix\0suffix' | env \
      HERDR_ENV=1 \
      HERDR_PANE_ID=ctl \
      HOD_HERDR_BIN="$fake_herdr" \
      FAKE_DISPATCH_STATE="$state" \
      FAKE_DISPATCH_SCENARIO=success \
      FAKE_CHILD_PANE=child-pane \
      FAKE_WORKSPACE=ws-main \
      FAKE_CWD="$dispatch_cwd" \
      FAKE_INITIAL_CHILD_ROLE=worker \
      FAKE_INITIAL_CHILD_PARENT=ctl \
      FAKE_INITIAL_CHILD_RELATION=delegate \
      FAKE_INITIAL_CHILD_RUN=run-nul \
      "$hod" dispatch start \
      --name worker-nul --role worker --task task-nul --run run-nul \
      --kind claude --cwd "$dispatch_cwd" --direction right --timeout 120000 \
      -- --model worker-model \
      >"$state/receipt.json"
  }

  local role relation state prompt lock_key lock_dir oversized_prompt
  local cleanup_started cleanup_elapsed cleanup_lock_key

  for scenario in duplicate_name malformed_start_exit0 forged_start_exit0 \
    wrong_start_identity readiness_never working_after_start \
    wrong_get_identity start_state_drift start_wrong_launch_terminal \
    start_controller_terminal_drift start_controller_revision_regress; do
    state=$tmp_root/dispatch-start-$scenario
    scenario_timeout=120000
    [[ "$scenario" == readiness_never || "$scenario" == working_after_start ]] &&
      scenario_timeout=1000
    expect_rejection "dispatch rejects $scenario" \
      dispatch_start "$state" worker "task-$scenario" "run-$scenario" claude \
      "$dispatch_cwd" right "$scenario_timeout" "$scenario" "$scenario" worker-$scenario
    expect_success "$scenario never prompts" test ! -e "$state/prompt.argv"
  done

  for scenario in start_controller_terminal_drift start_controller_revision_regress; do
    state=$tmp_root/dispatch-start-$scenario
    expect_success "$scenario stops before split or agent lifecycle" \
      test ! -e "$state/split.argv" -a ! -e "$state/start.argv" -a ! -e "$state/prompt.argv"
  done

  state=$tmp_root/dispatch-start-duplicate_name
  expect_success 'duplicate name closes the proven fresh unstarted child' \
    test -e "$state/close.argv"
  expect_success 'duplicate name restores the previous controller task' \
    grep -qxF 'hod_task=original-task' "$state/ctl.tokens"

  state=$tmp_root/dispatch-start-child-preclaimed
  expect_rejection 'dispatch rejects a fresh child claimed before topology binding' \
    dispatch_start "$state" worker task-preclaimed run-preclaimed claude \
    "$dispatch_cwd" right 120000 start_child_preclaimed \
    'preclaimed child' worker-preclaimed
  expect_success 'preclaimed child is never relabeled, started, prompted, or closed' \
    test "$(grep -c '^report:child-pane$' "$state/order" || true)" -eq 0 \
      -a ! -e "$state/start.argv" -a ! -e "$state/prompt.argv" -a ! -e "$state/close.argv"

  state=$tmp_root/dispatch-start-child-claimed-after-report
  expect_rejection 'dispatch rejects a fresh child claimed during topology binding' \
    dispatch_start "$state" worker task-claimed-after run-claimed-after claude \
    "$dispatch_cwd" right 120000 start_child_claimed_after_report \
    'claimed during binding' worker-claimed-after
  expect_success 'claimed-after-report child is never started, prompted, or closed' \
    test "$(grep -c '^report:child-pane$' "$state/order" || true)" -eq 1 \
      -a ! -e "$state/start.argv" -a ! -e "$state/prompt.argv" -a ! -e "$state/close.argv"
  expect_success 'claimed-after-report failure restores only the unchanged controller owner' \
    grep -qxF 'hod_task=original-task' "$state/ctl.tokens"

  state=$tmp_root/dispatch-start-delayed-readiness
  expect_success 'dispatch settles delayed agent readiness before prompt' \
    dispatch_start "$state" worker task-delayed run-delayed claude \
    "$dispatch_cwd" right 120000 delayed_readiness 'delayed readiness' worker-delayed
  expect_success 'delayed readiness probes agent get before one prompt' \
    test "$(grep -c '^agent-get:' "$state/order" || true)" -ge 3 \
      -a "$(grep -c '^prompt$' "$state/order" || true)" -eq 1

  state=$tmp_root/dispatch-start-session-deferred
  expect_success 'dispatch start accepts a sessionless first prompt bound to its launch terminal' \
    dispatch_start "$state" worker task-session run-session claude \
    "$dispatch_cwd" right 120000 start_session_deferred 'deferred session' worker-session
  expect_success 'sessionless first delivery still sends exactly one prompt' \
    test "$(grep -c '^prompt$' "$state/order" || true)" -eq 1

  state=$tmp_root/dispatch-start-sessionless-done
  expect_rejection 'dispatch never reports a sessionless idle completion as delivered' \
    dispatch_start "$state" worker task-session-done run-session-done claude \
    "$dispatch_cwd" right 120000 start_sessionless_done \
    'sessionless done' worker-sessionless-done
  expect_success 'ambiguous sessionless completion is attempted only once' \
    test "$(grep -c '^prompt$' "$state/order" || true)" -eq 1 \
      -a ! -e "$state/close.argv"

  state=$tmp_root/dispatch-start-terminal-drift
  expect_rejection 'dispatch start rejects a changed launch terminal' \
    dispatch_start "$state" worker task-terminal run-terminal claude \
    "$dispatch_cwd" right 500 start_terminal_drift 'terminal drift' worker-terminal
  expect_success 'start terminal drift never prompts a changed agent' \
    test ! -e "$state/prompt.argv"

  state=$tmp_root/dispatch-start-codex-surface-delayed
  expect_success 'dispatch waits for the real Codex prompt surface' \
    dispatch_start "$state" tester task-codex-ready run-codex-ready codex \
    "$dispatch_cwd" right 120000 codex_surface_delayed \
    'codex surface readiness' tester-codex-ready
  expect_success 'Codex prompt is sent only after its prompt surface appears' \
    test "$(grep -c '^agent-read:' "$state/order" || true)" -ge 3 \
      -a "$(grep -c '^prompt$' "$state/order" || true)" -eq 1

  state=$tmp_root/dispatch-start-codex-surface-never
  expect_rejection 'dispatch rejects a false-positive Codex idle state' \
    dispatch_start "$state" tester task-codex-false run-codex-false codex \
    "$dispatch_cwd" right 1000 codex_surface_never \
    'false Codex readiness' tester-codex-false
  expect_success 'false-positive Codex readiness never prompts' \
    test ! -e "$state/prompt.argv"

  state=$tmp_root/dispatch-start-get-timeout
  expect_rejection_contains 'dispatch wall-clock timeout terminates a hung Herdr get' \
    'dispatch exceeded its wall-clock timeout' \
    dispatch_start "$state" worker task-timeout run-timeout claude \
    "$dispatch_cwd" right 1000 get_hang 'hung get' worker-timeout
  expect_success 'hung Herdr get never reaches prompt' test ! -e "$state/prompt.argv"

  state=$tmp_root/dispatch-start-get-term-ignoring
  expect_rejection_contains 'dispatch hard-kills a TERM-ignoring Herdr get at the wall-clock deadline' \
    'dispatch exceeded its wall-clock timeout' \
    dispatch_start "$state" worker task-hard-timeout run-hard-timeout claude \
    "$dispatch_cwd" right 1000 get_term_ignoring 'hung get' worker-hard-timeout
  expect_success 'TERM-ignoring Herdr get never reaches prompt' \
    test ! -e "$state/prompt.argv"

  state=$tmp_root/dispatch-start-nul
  expect_rejection 'dispatch rejects NUL-containing stdin without truncation' \
    dispatch_start_with_nul "$state"
  expect_success 'NUL stdin never reaches prompt' test ! -e "$state/prompt.argv"

  oversized_prompt=$(head -c 131073 /dev/zero | tr '\0' x)
  state=$tmp_root/dispatch-start-oversized-prompt
  expect_rejection 'dispatch rejects oversized prompt before mutation' \
    dispatch_start "$state" worker task-oversized run-oversized claude \
    "$dispatch_cwd" right 120000 success "$oversized_prompt" worker-oversized
  expect_success 'oversized prompt causes no lifecycle command' \
    assert_no_dispatch_mutation "$state"

  state=$tmp_root/dispatch-start-bootstrap-empty
  expect_success 'dispatch start bootstraps an untagged controller pane' \
    dispatch_start "$state" worker task-bootstrap run-bootstrap claude \
    "$dispatch_cwd" right 120000 start_bootstrap_empty 'bootstrap prompt' worker-bootstrap

  state=$tmp_root/dispatch-start-missing-child-tokens
  expect_success 'dispatch start accepts a fresh Herdr pane with omitted tokens' \
    dispatch_start "$state" worker task-missing-tokens run-missing-tokens claude \
    "$dispatch_cwd" right 120000 start_missing_child_tokens \
    'missing child tokens' worker-missing-tokens
  expect_success 'missing child tokens are bound before start and prompt' \
    test -e "$state/started" -a -e "$state/prompted"

  for scenario in start_controller_wrong_run start_child_tokens \
    start_partial_tokens start_invalid_tokens malformed_tokens \
    start_invalid_existing_task start_invalid_existing_run; do
    state=$tmp_root/dispatch-$scenario
    expect_rejection "dispatch rejects $scenario before mutation" \
      dispatch_start "$state" worker "task-$scenario" "run-$scenario" claude \
      "$dispatch_cwd" right 120000 "$scenario" "$scenario" "worker-$scenario"
    expect_success "$scenario has no topology mutation" assert_no_dispatch_mutation "$state"
  done

  lock_key=$(printf '%s' ctl | cksum | awk '{print $1}')
  lock_dir=$hod_home/dispatch-locks/$lock_key.lock
  expect_success 'successful dispatch releases its controller lock' \
    test ! -d "$lock_dir"
  mkdir -p -- "$lock_dir"
  printf '%s\n' 'other-owner' >"$lock_dir/owner"
  state=$tmp_root/dispatch-controller-lock
  expect_rejection 'dispatch serializes concurrent operations for one controller' \
    dispatch_start "$state" worker task-lock run-lock claude \
    "$dispatch_cwd" right 1 success 'locked dispatch' worker-lock
  expect_success 'contended dispatch performs no topology mutation' \
    assert_no_dispatch_mutation "$state"
  expect_success 'contended dispatch does not steal or remove another owner lock' \
    test "$(<"$lock_dir/owner")" = other-owner
  rm -f -- "$lock_dir/owner"
  rmdir -- "$lock_dir"

  state=$tmp_root/dispatch-start-advisor-arbitrary
  expect_rejection 'advisor requires canonical selection and matching model' \
    dispatch_start "$state" advisor task-advisor run-advisor claude \
    "$dispatch_cwd" right 120000 success 'arbitrary advisor model' advisor-arbitrary \
    __omit__ __omit__
  expect_success 'arbitrary advisor model never prompts' test ! -e "$state/prompt.argv"

  state=$tmp_root/dispatch-start-advisor-fable-codex
  expect_rejection 'fable advisor requires claude kind' \
    dispatch_start "$state" advisor task-advisor-fable run-advisor-fable codex \
    "$dispatch_cwd" right 120000 success 'wrong fable kind' advisor-fable-codex \
    fable fable
  expect_success 'fable wrong kind has no topology mutation' assert_no_dispatch_mutation "$state"

  state=$tmp_root/dispatch-start-advisor-sol-claude
  expect_rejection 'gpt-5.6-sol advisor requires codex kind' \
    dispatch_start "$state" advisor task-advisor-sol run-advisor-sol claude \
    "$dispatch_cwd" right 120000 success 'wrong sol kind' advisor-sol-claude \
    gpt-5.6-sol gpt-5.6-sol
  expect_success 'gpt-5.6-sol wrong kind has no topology mutation' \
    assert_no_dispatch_mutation "$state"

  state=$tmp_root/dispatch-reviewer-resume
  expect_rejection 'reviewer dispatch rejects a resumed Codex session' \
    dispatch_start_with_native_mode resume "$state" reviewer \
    task-reviewer-resume run-reviewer-resume codex "$dispatch_cwd" right 120000 \
    success 'reviewer resume' reviewer-resume
  expect_success 'reviewer resume rejection happens before mutation' \
    assert_no_dispatch_mutation "$state"

  state=$tmp_root/dispatch-tester-resume
  expect_rejection 'tester dispatch rejects a resumed Claude session' \
    dispatch_start_with_native_mode claude-resume "$state" tester \
    task-tester-resume run-tester-resume claude "$dispatch_cwd" right 120000 \
    success 'tester resume' tester-resume
  expect_success 'tester resume rejection happens before mutation' \
    assert_no_dispatch_mutation "$state"

  while read -r mode role kind label; do
    state=$tmp_root/dispatch-$role-$mode
    expect_rejection "$role dispatch rejects $label" \
      dispatch_start_with_native_mode "$mode" "$state" "$role" \
      "task-$mode-$role" "run-$mode-$role" "$kind" "$dispatch_cwd" right 120000 \
      success "$role permission bypass" "$role-$mode"
    expect_success "$role $label rejection happens before mutation" \
      assert_no_dispatch_mutation "$state"
  done <<'EOF'
dangerous worker claude dangerously-skip-permissions
dangerous-equals worker claude equals-dangerously-skip-permissions
allow-dangerous worker claude allow-dangerously-skip-permissions
codex-dangerous worker codex dangerously-bypass-approvals-and-sandbox
codex-hook-dangerous worker codex dangerously-bypass-hook-trust
yolo worker grok yolo
sandbox-danger-short reviewer codex short-sandbox-danger-full-access
sandbox-danger-long tester codex long-sandbox-danger-full-access
sandbox-danger-equals worker codex equals-sandbox-danger-full-access
permission-bypass worker claude split-permission-mode-bypass
permission-bypass-equals reviewer claude equals-permission-mode-bypass
permission-bypass tester claude split-permission-mode-bypass
config-sandbox-danger reviewer codex config-sandbox-danger-full-access
config-sandbox-danger-escaped reviewer codex escaped-config-sandbox-danger-full-access
inline-settings-bypass tester claude inline-settings-permission-bypass
inline-settings-bypass-escaped tester claude escaped-inline-settings-permission-bypass
always-approve worker grok always-approve
sandbox-off reviewer grok grok-sandbox-off
sandbox-none tester grok grok-sandbox-none
sandbox-off-equals worker grok grok-sandbox-off-equals
permission-accept-edits reviewer grok grok-permission-accept-edits
permission-accept-edits tester claude claude-permission-accept-edits
inline-settings-accept-edits reviewer claude inline-settings-accept-edits
claude-allowed-tools tester claude claude-allowed-tools
grok-allow tester grok grok-allow
grok-tools reviewer grok grok-tools
codex-sandbox-workspace reviewer codex codex-workspace-write
codex-config-sandbox tester codex codex-config-sandbox-mode
codex-config-multi-agent reviewer codex codex-enable-multi-agent
codex-profile tester codex codex-profile
codex-approve reviewer codex codex-approve-for-me
codex-add-dir tester codex codex-add-dir
codex-search reviewer codex codex-search
codex-oss advisor codex codex-oss-provider-override
cloud-command reviewer codex codex-cloud-command
claude-system-prompt reviewer claude claude-system-prompt
claude-bare tester claude claude-bare
codex-exec reviewer codex codex-exec-subcommand
codex-cd tester codex codex-native-cwd
grok-cwd reviewer grok grok-native-cwd
codex-delete tester codex codex-delete-subcommand
unknown-boundary reviewer claude unknown-boundary-argument
short-continue reviewer grok grok-short-continue
short-resume tester grok grok-short-resume
from-pr reviewer claude claude-from-pr
teleport tester claude claude-teleport
cloud-session advisor claude claude-cloud-session
fork-command reviewer codex codex-fork-command
fork-session tester grok grok-fork-session
EOF

  while read -r mode kind label; do
    state=$tmp_root/dispatch-reviewer-$mode
    expect_success "reviewer dispatch accepts $label" \
      dispatch_start_with_native_mode "$mode" "$state" reviewer \
      "task-$mode" "run-$mode" "$kind" "$dispatch_cwd" right 120000 \
      success "safe reviewer boundary" "reviewer-$mode"
  done <<'EOF'
codex-boundary-safe codex canonical-Codex-boundary
claude-boundary-safe claude file-based-Claude-boundary
grok-boundary-safe grok read-only-Grok-boundary
EOF

  state=$tmp_root/dispatch-advisor-dangerous
  expect_rejection 'advisor dispatch rejects permission bypass flags' \
    dispatch_start_with_native_mode dangerous "$state" advisor \
    task-advisor-danger run-advisor-danger claude "$dispatch_cwd" right 120000 \
    success 'advisor dangerous' advisor-danger --name fable fable
  expect_success 'advisor bypass rejection happens before mutation' \
    assert_no_dispatch_mutation "$state"

  state=$tmp_root/dispatch-start-non-advisor-selection
  expect_rejection 'non-advisor rejects advisor selection flags' \
    dispatch_start "$state" worker task-non-advisor run-non-advisor claude \
    "$dispatch_cwd" right 120000 success 'non-advisor flags' worker-selection \
    fable fable
  expect_success 'non-advisor selection causes no lifecycle command' \
    assert_no_lifecycle_after_failure "$state"

  while read -r role relation advisor_choice advisor_model; do
    state=$tmp_root/dispatch-start-$role
    prompt=$(printf 'Direct user %s\npreserve $HOME *' "$role")
    expect_success "dispatch start succeeds for $role" \
      dispatch_start "$state" "$role" "task-$role" "run-$role" claude \
      "$dispatch_cwd" right 120000 success "$prompt" "agent-$role-1" \
      --name "$advisor_choice" "$advisor_model"
    expect_success "dispatch maps $role to $relation" \
      python3 - "$state/report-2.argv" "$role" "$relation" <<'PY'
import sys
argv = open(sys.argv[1], "rb").read().split(b"\0")[:-1]
role, relation = sys.argv[2:4]
tokens = {}
for index, value in enumerate(argv[:-1]):
    if value == b"--token":
        key, token_value = argv[index + 1].decode().split("=", 1)
        tokens[key] = token_value
assert tokens == {
    "hod_role": role,
    "hod_parent": "ctl",
    "hod_relation": relation,
    "hod_task": f"task-{role}",
    "hod_run": f"run-{role}",
}, tokens
PY
    if [[ "$role" == advisor ]]; then
      expect_success 'advisor receipt records canonical selection and model' \
        python3 - "$state/receipt.json" <<'PY'
import json
import sys
receipt = json.load(open(sys.argv[1], encoding="utf-8"))
assert receipt["advisor_choice"] == "fable", receipt
assert receipt["requested_model"] == "fable", receipt
assert receipt["runtime_model_verified"] is False, receipt
PY
    fi
    if [[ "$role" == worker ]]; then
      printf '%s\n' \
        'get:ctl' 'report:ctl' 'get:ctl' 'split' \
        'get:child-pane' 'report:child-pane' 'get:child-pane' 'start' \
        'agent-get:agent-worker-1' 'get:child-pane' \
        'report:child-pane' 'get:child-pane' 'get:child-pane' \
        'agent-get:child-pane' 'get:child-pane' 'get:child-pane' \
        'get:ctl' 'prompt' \
        >"$state/order.expected"
      expect_success 'dispatch start uses the guarded command order' \
        cmp -s "$state/order.expected" "$state/order"
      expect_success 'dispatch split targets the explicit controller pane' \
        python3 - "$state/split.argv" "$dispatch_cwd" <<'PY'
import sys
argv = open(sys.argv[1], "rb").read().split(b"\0")[:-1]
cwd = sys.argv[2].encode()
assert argv == [
    b"pane", b"split", b"ctl", b"--direction", b"right", b"--cwd", cwd,
    b"--no-focus",
], argv
PY
      expect_success 'dispatch start forwards native argv and stdin exactly' \
        python3 - "$state/start.argv" "$state/prompt.argv" <<'PY'
import sys
start = open(sys.argv[1], "rb").read().split(b"\0")[:-1]
prompt = open(sys.argv[2], "rb").read().split(b"\0")[:-1]
assert start == [
    b"agent", b"start", b"agent-worker-1", b"--kind", b"claude",
    b"--pane", b"child-pane", b"--timeout", b"120000", b"--",
    b"--model", b"worker-model", b"--native-value", b"value with spaces",
], start
assert prompt[0:2] == [b"agent", b"prompt"], prompt
assert prompt[2] == b"agent-worker-1", prompt
assert prompt[3] == b"Direct user worker\npreserve $HOME *", prompt
assert prompt[4:] == [
    b"--wait",
    b"--until", b"working",
    b"--until", b"blocked",
    b"--until", b"done",
    b"--until", b"idle",
    b"--until", b"unknown",
    b"--timeout", b"120000",
], prompt
PY
      expect_success 'dispatch start returns an exact JSON receipt' \
        python3 - "$state/receipt.json" <<'PY'
import json
import sys
receipt = json.load(open(sys.argv[1], encoding="utf-8"))
assert set(receipt) == {"pane_id", "name", "role", "relation", "task", "run"}, receipt
assert receipt == {
    "pane_id": "child-pane",
    "name": "agent-worker-1",
    "role": "worker",
    "relation": "delegate",
    "task": "task-worker",
    "run": "run-worker",
}, receipt
PY
    fi
  done <<'EOF'
worker delegate
advisor consult fable fable
reviewer verify
tester verify
EOF

  state=$tmp_root/dispatch-start-busy
  expect_success 'dispatch retries only exact agent_pane_busy once' \
    dispatch_start "$state" worker task-busy run-busy claude \
    "$dispatch_cwd" right 120000 busy_once 'busy prompt' worker-busy
  expect_success 'dispatch busy retry is bounded to two starts' \
    test "$(grep -c '^start$' "$state/order")" -eq 2

  state=$tmp_root/dispatch-start-busy-always
  expect_rejection 'dispatch bounds repeated agent_pane_busy retries' \
    dispatch_start "$state" worker task-busy-always run-busy-always claude \
    "$dispatch_cwd" right 120000 busy_always 'busy always' worker-busy-always
  expect_success 'dispatch attempts agent_pane_busy at most ten times' \
    test "$(grep -c '^start$' "$state/order")" -eq 10

  state=$tmp_root/dispatch-start-message-contains-busy
  expect_rejection 'dispatch does not retry a non-matching JSON error message' \
    dispatch_start "$state" worker task-message-busy run-message-busy claude \
    "$dispatch_cwd" right 120000 start_message_contains_busy 'message busy' worker-message-busy
  expect_success 'non-matching JSON error message causes one start' \
    test "$(grep -c '^start$' "$state/order")" -eq 1

  state=$tmp_root/dispatch-invalid-role
  expect_rejection 'dispatch rejects invalid role' \
    dispatch_start "$state" planner task-valid run-valid claude \
    "$dispatch_cwd" right 120000 success 'invalid role' planner-agent
  expect_success 'invalid role causes no lifecycle command' \
    assert_no_lifecycle_after_failure "$state"

  state=$tmp_root/dispatch-invalid-task
  expect_rejection 'dispatch rejects unsafe task' \
    dispatch_start "$state" worker 'bad/task' run-valid claude \
    "$dispatch_cwd" right 120000 success 'invalid task' worker-invalid-task
  expect_success 'invalid task causes no lifecycle command' \
    assert_no_lifecycle_after_failure "$state"

  state=$tmp_root/dispatch-invalid-run
  expect_rejection 'dispatch rejects unsafe run' \
    dispatch_start "$state" worker task-valid 'bad/run' claude \
    "$dispatch_cwd" right 120000 success 'invalid run' worker-invalid-run
  expect_success 'invalid run causes no lifecycle command' \
    assert_no_lifecycle_after_failure "$state"

  state=$tmp_root/dispatch-missing-name
  expect_rejection 'dispatch rejects missing agent name' \
    dispatch_start "$state" worker task-name run-name claude \
    "$dispatch_cwd" right 120000 success 'missing name'
  expect_success 'missing agent name causes no lifecycle command' \
    assert_no_lifecycle_after_failure "$state"

  state=$tmp_root/dispatch-agent-alias
  expect_rejection 'dispatch rejects ambiguous --agent alias' \
    dispatch_start "$state" worker task-alias run-alias claude \
    "$dispatch_cwd" right 120000 success 'agent alias' legacy-agent --agent
  expect_success 'ambiguous --agent alias causes no lifecycle command' \
    assert_no_lifecycle_after_failure "$state"

  state=$tmp_root/dispatch-missing-capability
  expect_rejection 'dispatch fails closed on missing capability' \
    dispatch_start "$state" worker task-cap run-cap claude \
    "$dispatch_cwd" right 120000 missing_capability 'missing capability' worker-cap
  expect_success 'missing capability does not split, start, or prompt' \
    assert_no_lifecycle_after_failure "$state"

  state=$tmp_root/dispatch-report-failure
  expect_rejection 'dispatch fails closed on controller report failure' \
    dispatch_start "$state" worker task-report run-report claude \
    "$dispatch_cwd" right 120000 report_fail 'report failure' worker-report
  expect_success 'report failure does not split, start, or prompt' \
    assert_no_lifecycle_after_failure "$state"

  for scenario in split_failure split_bad_json split_same_controller wrong_workspace \
    wrong_parent wrong_run readback_fail child_report_fail child_report_close_fail \
    cleanup_agent_claimed get_fail; do
    state=$tmp_root/dispatch-$scenario
    expect_rejection "dispatch fails closed on $scenario" \
      dispatch_start "$state" worker "task-$scenario" "run-$scenario" claude \
      "$dispatch_cwd" right 120000 "$scenario" "$scenario" worker-$scenario
    expect_success "$scenario does not start or prompt" \
      assert_no_lifecycle_after_failure "$state"
    case "$scenario" in
      wrong_parent|wrong_run|child_report_fail|child_report_close_fail)
        expect_success "$scenario closes only the freshly split unstarted child" \
          test -e "$state/close.argv"
        expect_success "$scenario cleanup targets the exact returned child" \
          python3 - "$state/close.argv" <<'PY'
import sys
argv = open(sys.argv[1], "rb").read().split(b"\0")[:-1]
assert argv == [b"pane", b"close", b"child-pane"], argv
PY
        ;;
      *)
        expect_success "$scenario never closes an unproven pane" \
          test ! -e "$state/close.argv"
        ;;
    esac
  done

  state=$tmp_root/dispatch-cleanup_agent_claimed
  expect_success 'cleanup does not close a freshly split pane claimed by another agent' \
    test ! -e "$state/close.argv"

  state=$tmp_root/dispatch-cleanup_get_term_ignoring
  cleanup_started=$SECONDS
  expect_rejection_contains 'cleanup deadline kills a TERM-ignoring Herdr readback' \
    'cleanup could not re-read freshly split pane' \
    dispatch_start "$state" worker task-cleanup-deadline run-cleanup-deadline claude \
    "$dispatch_cwd" right 120000 cleanup_get_term_ignoring \
    'cleanup deadline' worker-cleanup-deadline
  cleanup_elapsed=$((SECONDS - cleanup_started))
  expect_success 'cleanup deadline bounds the complete failure cleanup path' \
    test "$cleanup_elapsed" -ge 3 -a "$cleanup_elapsed" -lt 8
  expect_success 'cleanup deadline never reaches agent start or prompt' \
    test ! -e "$state/start.argv" -a ! -e "$state/prompt.argv"
  cleanup_lock_key=$(printf '%s' ctl | cksum | awk '{print $1}')
  expect_success 'cleanup deadline always releases the controller lock' \
    test ! -d "$hod_home/dispatch-locks/$cleanup_lock_key.lock"

  state=$tmp_root/dispatch-cleanup_early_expiry
  cleanup_started=$SECONDS
  expect_rejection 'cleanup launch race fails closed' \
    dispatch_start "$state" worker task-cleanup-race run-cleanup-race claude \
    "$dispatch_cwd" right 120000 cleanup_early_expiry \
    'cleanup launch race' worker-cleanup-race
  cleanup_elapsed=$((SECONDS - cleanup_started))
  expect_success 'cleanup launch race is bounded and never starts an agent' \
    test "$cleanup_elapsed" -lt 4 -a ! -e "$state/start.argv" -a ! -e "$state/prompt.argv"
  expect_success 'cleanup launch race releases the controller lock' \
    test ! -d "$hod_home/dispatch-locks/$cleanup_lock_key.lock"

  for scenario in split_failure split_bad_json child_report_fail cleanup_agent_claimed; do
    state=$tmp_root/dispatch-$scenario
    expect_success "$scenario restores the previous controller task" \
      grep -qxF 'hod_task=original-task' "$state/ctl.tokens"
  done

  state=$tmp_root/dispatch-rollback-controller-session-drift
  expect_rejection 'rollback refuses a replaced controller session' \
    dispatch_start "$state" worker task-rollback-owner run-rollback-owner claude \
    "$dispatch_cwd" right 120000 rollback_controller_session_drift \
    'rollback owner drift' worker-rollback-owner
  expect_success 'replaced controller receives no rollback metadata write' \
    test "$(<"$state/report-count")" -eq 1
  expect_success 'replaced controller keeps the last transaction metadata for manual recovery' \
    grep -qxF 'hod_task=task-rollback-owner' "$state/ctl.tokens"
  expect_success 'controller replacement never reaches child agent lifecycle' \
    test ! -e "$state/start.argv" -a ! -e "$state/prompt.argv"

  state=$tmp_root/dispatch-start-failure
  expect_rejection 'dispatch fails closed on agent start failure' \
    dispatch_start "$state" worker task-start run-start claude \
    "$dispatch_cwd" right 120000 start_fail 'start failure' worker-start
  expect_success 'start failure does not prompt' \
    test ! -e "$state/prompt.argv"
  expect_success 'start failure never closes a pane after start was attempted' \
    test ! -e "$state/close.argv"

  state=$tmp_root/dispatch-post-start-mismatch
  expect_rejection 'dispatch fails closed on post-start metadata mismatch' \
    dispatch_start "$state" worker task-post run-post claude \
    "$dispatch_cwd" right 120000 post_start_mismatch 'post-start mismatch' worker-post
  expect_success 'post-start mismatch does not prompt' \
    test ! -e "$state/prompt.argv"

  state=$tmp_root/dispatch-prompt-failure
  expect_rejection 'dispatch fails closed on prompt failure' \
    dispatch_start "$state" worker task-prompt run-prompt claude \
    "$dispatch_cwd" right 120000 prompt_fail 'prompt failure' worker-prompt

  state=$tmp_root/dispatch-prompt-blocked
  expect_success 'dispatch succeeds when Herdr observes blocked immediately' \
    dispatch_start "$state" worker task-blocked run-blocked claude \
    "$dispatch_cwd" right 120000 prompt_blocked 'prompt blocked' worker-blocked
  expect_success 'blocked prompt records delivery' \
    test -e "$state/prompt.argv"

  while read -r role relation; do
    [[ "$role" == advisor ]] && continue
    state=$tmp_root/dispatch-prompt-$role
    expect_success "dispatch prompt validates and refreshes $role" \
      dispatch_prompt "$state" redirect-task run-redirect "$role" success \
      "redirect $role"
    printf '%s\n' \
      'get:ctl' 'get:child-pane' 'get:child-pane' 'get:child-pane' \
      'agent-get:child-pane' 'get:child-pane' 'report:ctl' 'get:ctl' \
      'report:child-pane' 'get:child-pane' 'get:child-pane' \
      'agent-get:child-pane' 'get:child-pane' 'get:child-pane' \
      'get:ctl' 'prompt' \
      >"$state/order.expected"
    expect_success "dispatch prompt command order for $role" \
      cmp -s "$state/order.expected" "$state/order"
    expect_success "dispatch prompt sends exactly one prompt for $role" \
      test "$(grep -c '^prompt$' "$state/order")" -eq 1
  done <<'EOF'
worker delegate
advisor consult
reviewer verify
tester verify
EOF

  for scenario in wrong_prompt_identity malformed_prompt_exit0 forged_prompt_exit0 \
    stale_prompt_seq prompt_missing_session prompt_stalled; do
    state=$tmp_root/dispatch-prompt-$scenario
    expect_rejection "dispatch prompt rejects $scenario" \
      dispatch_prompt "$state" redirect-task run-redirect worker "$scenario" \
      "$scenario"
    expect_success "$scenario attempts exactly one prompt" \
      test "$(grep -c '^prompt$' "$state/order" 2>/dev/null || true)" -eq 1
  done

  state=$tmp_root/dispatch-prompt-final-workspace-race
  expect_success 'validated delivery receipt is not turned into a retryable post-prompt failure' \
    dispatch_prompt "$state" redirect-task run-redirect worker final_workspace_race \
    'final workspace race'
  expect_success 'final workspace race submits exactly one prompt' \
    test "$(grep -c '^prompt$' "$state/order" 2>/dev/null || true)" -eq 1

  for scenario in working_child stale_controller prompt_agent_working \
    prompt_agent_not_ready prompt_invalid_child_task; do
    state=$tmp_root/dispatch-prompt-$scenario
    expect_rejection "dispatch prompt rejects $scenario" \
      dispatch_prompt "$state" redirect-task run-redirect worker "$scenario" \
      "$scenario"
    expect_success "$scenario has no report or prompt" assert_no_report_or_prompt "$state"
  done

  state=$tmp_root/dispatch-prompt-advisor
  expect_rejection 'advisor redirect requires a fresh consult' \
    dispatch_prompt "$state" redirect-task run-redirect advisor success \
    'advisor redirect'
  expect_success 'advisor redirect has no report or prompt' assert_no_report_or_prompt "$state"

  for scenario in prompt_kind_drift prompt_identity_drift prompt_session_drift \
    prompt_terminal_drift prompt_state_drift; do
    state=$tmp_root/dispatch-prompt-$scenario
    expect_rejection "dispatch prompt rejects $scenario" \
      dispatch_prompt "$state" redirect-task run-redirect worker "$scenario" \
      "$scenario"
    expect_success "$scenario never prompts a changed agent" \
      test ! -e "$state/prompt.argv"
  done
  state=$tmp_root/dispatch-prompt-prompt_kind_drift
  expect_success 'rejected redirect restores the controller task' \
    grep -qxF 'hod_task=old-controller-task' "$state/ctl.tokens"
  expect_success 'rejected redirect restores the child task' \
    grep -qxF 'hod_task=old-task' "$state/child-pane.tokens"

  state=$tmp_root/dispatch-prompt-prompt_session_drift
  expect_success 'rollback refuses metadata writes to a replaced child session' \
    grep -qxF 'hod_task=redirect-task' "$state/child-pane.tokens"
  expect_success 'child replacement still permits exact controller rollback' \
    grep -qxF 'hod_task=old-controller-task' "$state/ctl.tokens"
  expect_success 'replaced child receives no rollback report' \
    test "$(<"$state/report-count")" -eq 3

  state=$tmp_root/dispatch-prompt-controller-workspace-drift
  expect_rejection 'dispatch prompt rejects controller workspace drift' \
    dispatch_prompt "$state" redirect-task run-redirect worker \
    prompt_controller_workspace_drift 'workspace drift'
  expect_success 'controller workspace drift never prompts' test ! -e "$state/prompt.argv"

  state=$tmp_root/dispatch-prompt-controller-session-drift
  expect_rejection 'dispatch prompt rejects controller session replacement' \
    dispatch_prompt "$state" redirect-task run-redirect worker \
    prompt_controller_session_drift 'controller session drift'
  expect_success 'controller session replacement never prompts the child' \
    test ! -e "$state/prompt.argv"

  expect_rejection 'dispatch prompt requires an explicit expected kind' \
    "$hod" dispatch prompt --pane child-pane --task redirect-task \
    --run run-redirect --timeout 120000

  for scenario in prompt_wrong_parent prompt_wrong_relation prompt_wrong_run prompt_readback_fail get_fail; do
    state=$tmp_root/dispatch-$scenario
    expect_rejection "dispatch prompt rejects $scenario" \
      dispatch_prompt "$state" redirect-task run-redirect worker "$scenario" \
      "$scenario"
    expect_success "$scenario does not report or prompt" \
      assert_no_report_or_prompt "$state"
    if [[ "$scenario" == prompt_readback_fail ]]; then
      expect_success 'prompt_readback_fail emits malformed pane-get JSON' \
        test -e "$state/malformed-readback"
    fi
  done

  state=$tmp_root/dispatch-prompt-report-failure
  expect_rejection 'dispatch prompt fails closed on report failure' \
    dispatch_prompt "$state" redirect-task run-redirect worker report_fail \
    'redirect report failure'
  expect_success 'prompt report failure does not prompt' \
    test ! -e "$state/prompt.argv"

  state=$tmp_root/dispatch-prompt-delivery-failure
  expect_rejection 'dispatch prompt fails closed on delivery failure' \
    dispatch_prompt "$state" redirect-task run-redirect worker prompt_fail \
    'redirect delivery failure'

  state=$tmp_root/dispatch-prompt-relation-option
  expect_rejection 'dispatch prompt rejects free-form relation' \
    dispatch_prompt "$state" redirect-task run-redirect worker success \
    'free-form relation' --relation verify
  expect_success 'free-form relation causes no lifecycle command' \
    test ! -e "$state/order"
}

run_dispatch_regressions

if [[ "${HOD_TEST_DISPATCH_ONLY:-0}" == 1 ]]; then
  printf '\n%d passed, %d failed\n' "$pass" "$fail_count"
  if (( fail_count > 0 )); then
    printf 'failed: %s\n' "${failures[@]}" >&2
    exit 1
  fi
  exit 0
fi
# Test-only E0 snapshot primitive. It deliberately stays out of bin/hod: the
# adaptive protocol is documentation, not a new public evidence CLI.
capture_e0_pass() {
  local repo_root=$1
  local base_revision=$2
  local pass_dir=$3
  local head_before
  local head_after
  local relative_path

  head_before=$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}') ||
    return 1
  git -C "$repo_root" rev-parse --verify "${base_revision}^{commit}" \
    >/dev/null 2>&1 || return 1
  git -C "$repo_root" merge-base --is-ancestor \
    "$base_revision" "$head_before" || return 1

  {
    printf 'HOD-E0-SNAPSHOT-V1\0'
    printf 'DOMAIN committed\0'
    git -C "$repo_root" --no-pager diff --binary --no-color \
      --no-ext-diff --no-textconv --no-renames \
      "$base_revision" "$head_before" -- || return 1
    printf '\0DOMAIN staged\0'
    git -C "$repo_root" --no-pager diff --cached --binary --no-color \
      --no-ext-diff --no-textconv --no-renames "$head_before" -- || return 1
    printf '\0DOMAIN unstaged\0'
    git -C "$repo_root" --no-pager diff --binary --no-color \
      --no-ext-diff --no-textconv --no-renames -- || return 1
    printf '\0DOMAIN non-ignored-untracked\0'
    git -C "$repo_root" ls-files --others --exclude-standard -z |
      while IFS= read -r -d '' relative_path; do
        printf 'PATH\0%s\0BLOB\0' "$relative_path"
        git -C "$repo_root" hash-object --no-filters -- "$relative_path" ||
          exit 1
      done || return 1
  } >"$pass_dir/payload" || return 1

  if ! {
    git -C "$repo_root" diff --name-only -z --no-renames \
      "$base_revision" "$head_before" -- || exit 1
    git -C "$repo_root" diff --cached --name-only -z --no-renames \
      "$head_before" -- || exit 1
    git -C "$repo_root" diff --name-only -z --no-renames -- || exit 1
    git -C "$repo_root" ls-files --others --exclude-standard -z || exit 1
  } | LC_ALL=C sort -zu >"$pass_dir/paths"; then
    return 1
  fi

  git -C "$repo_root" status --porcelain=v1 -z --untracked-files=all \
    >"$pass_dir/status" || return 1
  head_after=$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}') ||
    return 1
  [[ "$head_before" == "$head_after" ]] || return 1
  printf '%s\n' "$head_before" >"$pass_dir/head"
  python3 -c \
    'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' \
    "$pass_dir/payload" >"$pass_dir/hash" || return 1
}

capture_e0_snapshot() {
  local fixture_path=$1
  local base_revision=$2
  local payload=$3
  local changed_paths=$4
  local between_pass_hook=${5:-}
  local repo_root
  local capture_dir

  repo_root=$(git -C "$fixture_path" rev-parse --show-toplevel 2>/dev/null) ||
    return 1
  repo_root=$(cd -- "$repo_root" && pwd -P) || return 1
  capture_dir=$(mktemp -d "$tmp_root/e0-capture.XXXXXX") || return 1
  mkdir -p -- "$capture_dir/first" "$capture_dir/second"
  rm -f -- "$payload" "$changed_paths"

  if ! capture_e0_pass "$repo_root" "$base_revision" "$capture_dir/first"; then
    rm -rf -- "$capture_dir"
    return 1
  fi
  if [[ -n "$between_pass_hook" ]] &&
    ! "$between_pass_hook" "$repo_root"; then
    rm -rf -- "$capture_dir"
    return 1
  fi
  if ! capture_e0_pass "$repo_root" "$base_revision" "$capture_dir/second"; then
    rm -rf -- "$capture_dir"
    return 1
  fi

  if ! cmp -s "$capture_dir/first/head" "$capture_dir/second/head" ||
    ! cmp -s "$capture_dir/first/payload" "$capture_dir/second/payload" ||
    ! cmp -s "$capture_dir/first/paths" "$capture_dir/second/paths" ||
    ! cmp -s "$capture_dir/first/status" "$capture_dir/second/status" ||
    ! cmp -s "$capture_dir/first/hash" "$capture_dir/second/hash"; then
    rm -rf -- "$capture_dir"
    return 1
  fi

  cp -- "$capture_dir/second/payload" "$payload"
  cp -- "$capture_dir/second/paths" "$changed_paths"
  cat -- "$capture_dir/second/hash"
  rm -rf -- "$capture_dir"
}

skill_dir=$hod_home/skill
global_agents=$agents_dir/skills/herdr-orchestrator
global_claude=$claude_dir/skills/herdr-orchestrator

adapter_points_to_skill() {
  local link=$1
  [[ -L "$link" ]] && [[ -d "$link" ]] && \
    [[ "$(cd -- "$link" && pwd -P)" == "$(cd -- "$skill_dir" && pwd -P)" ]]
}

# ---------------------------------------------------------------------------
# Fresh global install
# ---------------------------------------------------------------------------
expect_success 'fresh global install' \
  "$hod" install

expect_success 'skill checkout exists after install' \
  test -d "$skill_dir/.git"

expect_success 'global agents adapter resolves to skill' \
  adapter_points_to_skill "$global_agents"

expect_success 'global claude adapter resolves to skill' \
  adapter_points_to_skill "$global_claude"

expect_success 'executable link installed' \
  test -L "$bin_dir/hod" -o -x "$bin_dir/hod"

# ---------------------------------------------------------------------------
# Idempotent re-install
# ---------------------------------------------------------------------------
expect_success 'idempotent re-install' \
  "$hod" install

expect_success 'adapters still resolve after re-install' \
  adapter_points_to_skill "$global_claude"

# ---------------------------------------------------------------------------
# status exit codes both ways
# ---------------------------------------------------------------------------
# With a complete install and PATH set, status may still fail if herdr/jq/agents
# are missing on the host. Force a clean "all good" path by stubbing missing
# required tools into the fake bin dir, then a failing path by breaking an adapter.

stub_dir=$tmp_root/stubs
mkdir -p -- "$stub_dir"

# Preserve real tools when present; only stub missing ones needed for a green status.
for tool in herdr git jq claude; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    cat >"$stub_dir/$tool" <<'EOF'
#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "$0 0.0.0-test"
  exit 0
fi
exit 0
EOF
    chmod +x "$stub_dir/$tool"
  fi
done
export PATH="$stub_dir:$bin_dir:$PATH"

expect_success 'status exits 0 when required pieces are present' \
  "$hod" status

# Break an adapter → status must fail.
rm -f -- "$global_claude"
expect_rejection 'status exits non-zero when adapter is missing' \
  "$hod" status

# Restore for later tests.
"$hod" install >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# --project install on a git repo
# ---------------------------------------------------------------------------
project=$tmp_root/projects/demo
mkdir -p -- "$project"
git -C "$project" init -q
git -C "$project" config user.email "hod-test@example.com"
git -C "$project" config user.name "hod-test"

expect_success 'project install on a git repo' \
  "$hod" install --project "$project"

expect_success 'project agents adapter present' \
  test -L "$project/.agents/skills/herdr-orchestrator"

expect_success 'project claude adapter present' \
  test -L "$project/.claude/skills/herdr-orchestrator"

expect_success 'project adapters resolve to skill' \
  adapter_points_to_skill "$project/.claude/skills/herdr-orchestrator"

expect_success 'project exclude has agents adapter entry' \
  grep -qxF -- .agents/skills/herdr-orchestrator "$project/.git/info/exclude"

expect_success 'project exclude has claude adapter entry' \
  grep -qxF -- .claude/skills/herdr-orchestrator "$project/.git/info/exclude"

# ---------------------------------------------------------------------------
# a non-git --project target installs, skipping only the git-exclude step
# ---------------------------------------------------------------------------
plain=$tmp_root/projects/not-git
mkdir -p -- "$plain"
expect_success 'project install accepts non-git directory' \
  "$hod" install --project "$plain"

# ---------------------------------------------------------------------------
# uninstall removes adapters and leaves foreign files untouched
# ---------------------------------------------------------------------------
foreign=$agents_dir/skills/other-skill
mkdir -p -- "$agents_dir/skills"
echo keep-me >"$foreign"

expect_success 'uninstall removes global adapters' \
  "$hod" uninstall

expect_success 'global agents adapter removed' \
  test ! -e "$global_agents" -a ! -L "$global_agents"

expect_success 'global claude adapter removed' \
  test ! -e "$global_claude" -a ! -L "$global_claude"

expect_success 'foreign skill file left untouched' \
  test -f "$foreign"

# Project uninstall
"$hod" install --project "$project" >/dev/null 2>&1 || true
foreign_project=$project/.agents/skills/keep-me
echo foreign >"$foreign_project"

expect_success 'uninstall --project removes project adapters' \
  "$hod" uninstall --project "$project"

expect_success 'project adapters removed' \
  test ! -e "$project/.agents/skills/herdr-orchestrator" -a \
       ! -e "$project/.claude/skills/herdr-orchestrator"

expect_success 'foreign project file left untouched' \
  test -f "$foreign_project"

expect_success 'exclude entries left alone after uninstall' \
  grep -qxF -- .agents/skills/herdr-orchestrator "$project/.git/info/exclude"

# ---------------------------------------------------------------------------
# update refuses a dirty checkout
# ---------------------------------------------------------------------------
"$hod" install >/dev/null 2>&1 || true
echo dirty >>"$skill_dir/SKILL.md"
expect_rejection 'update refuses dirty skill checkout' \
  "$hod" update

# Restore clean tree for remaining tests.
git -C "$skill_dir" checkout -- SKILL.md >/dev/null 2>&1 || \
  git -C "$skill_dir" restore SKILL.md >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# broken-symlink detection in doctor
# ---------------------------------------------------------------------------
"$hod" install >/dev/null 2>&1 || true
rm -f -- "$global_claude"
ln -s -- "$skill_dir/does-not-exist" "$global_claude"

doctor_out=$tmp_root/doctor.out
set +e
"$hod" doctor >"$doctor_out" 2>&1
doctor_rc=$?
set -e

if [[ $doctor_rc -ne 0 ]] && grep -Eqi 'dangling|broken|does not|missing|points' "$doctor_out"; then
  record 'doctor detects broken/dangling adapter symlink' true
else
  printf '  doctor rc=%s output:\n%s\n' "$doctor_rc" "$(cat "$doctor_out")" >&2
  record 'doctor detects broken/dangling adapter symlink' false
fi

# ---------------------------------------------------------------------------
# pinned (tag) install and update
# ---------------------------------------------------------------------------
# Give the source repo two tags so update has somewhere to move.
git -C "$src_repo" tag -a vt1 -m t1
printf 'marker vt2\n' >>"$src_repo/README.md"
git -C "$src_repo" add -A
git -C "$src_repo" commit -q -m "vt2 content"
git -C "$src_repo" tag -a vt2 -m t2

# Fully isolated home/adapters so earlier global installs cannot interfere.
pin_home=$tmp_root/pin-home
pin_env=(env HOD_HOME="$pin_home" HOD_BIN_DIR="$tmp_root/pin-bin" \
  HOD_CLAUDE_DIR="$tmp_root/pin-claude" HOD_AGENTS_DIR="$tmp_root/pin-agents")
mkdir -p -- "$pin_home" "$tmp_root/pin-bin" "$tmp_root/pin-claude" "$tmp_root/pin-agents"

expect_success 'install --ref pins to a tag' \
  "${pin_env[@]}" "$hod" install --ref vt1

pinned_tag_is() {
  local want=$1
  [[ "$(git -C "$pin_home/skill" describe --tags --exact-match 2>/dev/null)" == "$want" ]]
}
expect_success 'pinned checkout sits at the requested tag' pinned_tag_is vt1
git -C "$pin_home/skill" branch vt2 HEAD

expect_success 'update on a pinned checkout moves to the newest tag' \
  "${pin_env[@]}" "$hod" update
expect_success 'pinned checkout now at the newest tag' pinned_tag_is vt2
pinned_checkout_is_detached_exact_tag() {
  ! git -C "$pin_home/skill" symbolic-ref -q HEAD >/dev/null 2>&1 || return 1
  [[ "$(git -C "$pin_home/skill" rev-parse HEAD)" == \
    "$(git -C "$pin_home/skill" rev-parse 'refs/tags/vt2^{commit}')" ]]
}
expect_success 'pinned update ignores a same-name local branch' \
  pinned_checkout_is_detached_exact_tag

expect_success 'doctor reports pinned mode' \
  bash -c "$(printf '%q ' "${pin_env[@]:1}") '$hod' doctor 2>/dev/null | grep -q 'pinned to tag vt2'"

# A configured upstream must be merged by its canonical full ref. A tag named
# like the abbreviated remote ref must not shadow refs/remotes/origin/<branch>.
upstream_collision_home=$tmp_root/upstream-collision-home
upstream_collision_env=(env HOD_HOME="$upstream_collision_home" \
  HOD_BIN_DIR="$tmp_root/upstream-collision-bin" \
  HOD_CLAUDE_DIR="$tmp_root/upstream-collision-claude" \
  HOD_AGENTS_DIR="$tmp_root/upstream-collision-agents")
mkdir -p -- "$upstream_collision_home" "$tmp_root/upstream-collision-bin" \
  "$tmp_root/upstream-collision-claude" "$tmp_root/upstream-collision-agents"
expect_success 'install fixture for abbreviated upstream collision' \
  "${upstream_collision_env[@]}" "$hod" install
upstream_collision_skill=$upstream_collision_home/skill
upstream_collision_branch=$(git -C "$upstream_collision_skill" symbolic-ref --short HEAD)
git -C "$upstream_collision_skill" tag \
  "origin/$upstream_collision_branch" HEAD
# Leave the configured upstream in branch.* config but force update to recreate
# its remote-tracking ref, so a short collision cannot be rescued by Git's
# abbreviation heuristics.
git -C "$upstream_collision_skill" update-ref -d \
  "refs/remotes/origin/$upstream_collision_branch"
printf 'marker canonical upstream ref\n' >>"$src_repo/README.md"
git -C "$src_repo" add README.md
git -C "$src_repo" commit -q -m "advance canonical upstream ref fixture"
upstream_collision_update() {
  local before after remote_ref
  before=$(git -C "$upstream_collision_skill" rev-parse HEAD)
  "${upstream_collision_env[@]}" "$hod" update >/dev/null 2>&1 || return 1
  after=$(git -C "$upstream_collision_skill" rev-parse HEAD)
  remote_ref="refs/remotes/origin/$upstream_collision_branch"
  [[ "$before" != "$after" ]] || return 1
  [[ "$after" == "$(git -C "$upstream_collision_skill" rev-parse "$remote_ref")" ]] || return 1
  git -C "$upstream_collision_skill" show HEAD:README.md | \
    grep -qF 'marker canonical upstream ref'
}
expect_success 'configured upstream ignores same-name tag' \
  upstream_collision_update

# A branch without configured upstream must resolve its unique same-name remote
# branch after fetch instead of letting `git pull --ff-only` fail with Git's
# generic "no tracking information" error.
no_upstream_home=$tmp_root/no-upstream-home
no_upstream_env=(env HOD_HOME="$no_upstream_home" HOD_BIN_DIR="$tmp_root/no-upstream-bin" \
  HOD_CLAUDE_DIR="$tmp_root/no-upstream-claude" HOD_AGENTS_DIR="$tmp_root/no-upstream-agents")
mkdir -p -- "$no_upstream_home" "$tmp_root/no-upstream-bin" \
  "$tmp_root/no-upstream-claude" "$tmp_root/no-upstream-agents"

expect_success 'install fixture for branch without upstream' \
  "${no_upstream_env[@]}" "$hod" install

no_upstream_skill=$no_upstream_home/skill
configure_test_repo_identity "$no_upstream_skill"
no_upstream_branch=$(git -C "$no_upstream_skill" symbolic-ref --short HEAD)
expect_success 'fixture branch starts with configured upstream' \
  git -C "$no_upstream_skill" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'

printf 'marker tracking upstream\n' >>"$src_repo/README.md"
git -C "$src_repo" add README.md
git -C "$src_repo" commit -q -m "advance tracking upstream branch"
update_tracking_branch() {
  "${no_upstream_env[@]}" "$hod" update >/dev/null 2>&1 || return 1
  [[ "$(git -C "$no_upstream_skill" symbolic-ref --short HEAD)" == "$no_upstream_branch" ]] || return 1
  git -C "$no_upstream_skill" show HEAD:README.md | \
    grep -qF 'marker tracking upstream'
}
expect_success 'update fast-forwards configured upstream' update_tracking_branch

git -C "$no_upstream_skill" branch --unset-upstream

printf 'marker no-upstream remote\n' >>"$src_repo/README.md"
git -C "$src_repo" add README.md
git -C "$src_repo" commit -q -m "advance no-upstream remote branch"

update_no_upstream_unique() {
  local before after
  before=$(git -C "$no_upstream_skill" rev-parse HEAD)
  "${no_upstream_env[@]}" "$hod" update >/dev/null 2>&1 || return 1
  after=$(git -C "$no_upstream_skill" rev-parse HEAD)
  [[ "$before" != "$after" ]] || return 1
  [[ "$(git -C "$no_upstream_skill" symbolic-ref --short HEAD)" == "$no_upstream_branch" ]] || return 1
  git -C "$no_upstream_skill" show HEAD:README.md | \
    grep -qF 'marker no-upstream remote' || return 1
  ! git -C "$no_upstream_skill" rev-parse --abbrev-ref --symbolic-full-name \
    '@{upstream}' >/dev/null 2>&1
}
expect_success 'update fast-forwards unique same-name remote without upstream' \
  update_no_upstream_unique

orphan_branch=orphan-update
git -C "$no_upstream_skill" checkout --quiet -b "$orphan_branch"
printf 'orphan local commit\n' >"$no_upstream_skill/orphan-local.txt"
git -C "$no_upstream_skill" add orphan-local.txt
git -C "$no_upstream_skill" commit -q -m "keep orphan local commit"
orphan_head_before=$(git -C "$no_upstream_skill" rev-parse HEAD)
orphan_branch_before=$(git -C "$no_upstream_skill" symbolic-ref --short HEAD)
orphan_status_before=$(git -C "$no_upstream_skill" status --porcelain)
orphan_update_preserves_state() {
  [[ "$(git -C "$no_upstream_skill" rev-parse HEAD)" == "$orphan_head_before" ]] || return 1
  [[ "$(git -C "$no_upstream_skill" symbolic-ref --short HEAD)" == "$orphan_branch_before" ]] || return 1
  [[ "$(git -C "$no_upstream_skill" status --porcelain)" == "$orphan_status_before" ]] || return 1
  git -C "$no_upstream_skill" show HEAD:orphan-local.txt | \
    grep -qF 'orphan local commit'
}
expect_rejection_contains 'orphan branch fails with stable error' \
  "branch '$orphan_branch' has no upstream and no unique remote branch named '$orphan_branch'" \
  "${no_upstream_env[@]}" "$hod" update
expect_success 'orphan update preserves HEAD, branch, worktree, and local commit' \
  orphan_update_preserves_state

ambiguous_home=$tmp_root/ambiguous-home
ambiguous_env=(env HOD_HOME="$ambiguous_home" HOD_BIN_DIR="$tmp_root/ambiguous-bin" \
  HOD_CLAUDE_DIR="$tmp_root/ambiguous-claude" HOD_AGENTS_DIR="$tmp_root/ambiguous-agents")
mkdir -p -- "$ambiguous_home" "$tmp_root/ambiguous-bin" \
  "$tmp_root/ambiguous-claude" "$tmp_root/ambiguous-agents"
expect_success 'install fixture for ambiguous remote branches' \
  "${ambiguous_env[@]}" "$hod" install
ambiguous_skill=$ambiguous_home/skill
configure_test_repo_identity "$ambiguous_skill"
ambiguous_branch=$(git -C "$ambiguous_skill" symbolic-ref --short HEAD)
git -C "$ambiguous_skill" remote add backup "$src_repo"
git -C "$ambiguous_skill" fetch --quiet backup
git -C "$ambiguous_skill" branch --unset-upstream
printf 'ambiguous local commit\n' >"$ambiguous_skill/ambiguous-local.txt"
git -C "$ambiguous_skill" add ambiguous-local.txt
git -C "$ambiguous_skill" commit -q -m "keep ambiguous local commit"
ambiguous_head_before=$(git -C "$ambiguous_skill" rev-parse HEAD)
ambiguous_branch_before=$(git -C "$ambiguous_skill" symbolic-ref --short HEAD)
ambiguous_status_before=$(git -C "$ambiguous_skill" status --porcelain)
ambiguous_update_preserves_state() {
  [[ "$(git -C "$ambiguous_skill" rev-parse HEAD)" == "$ambiguous_head_before" ]] || return 1
  [[ "$(git -C "$ambiguous_skill" symbolic-ref --short HEAD)" == "$ambiguous_branch_before" ]] || return 1
  [[ "$(git -C "$ambiguous_skill" status --porcelain)" == "$ambiguous_status_before" ]] || return 1
  git -C "$ambiguous_skill" show HEAD:ambiguous-local.txt | \
    grep -qF 'ambiguous local commit'
}
expect_rejection_contains 'ambiguous remotes fail with stable error' \
  "branch '$ambiguous_branch' has no upstream and multiple matching remote branches: backup/$ambiguous_branch, origin/$ambiguous_branch" \
  "${ambiguous_env[@]}" "$hod" update
expect_success 'ambiguous update preserves HEAD, branch, worktree, and local commit' \
  ambiguous_update_preserves_state

deleted_branch=deleted-update
git -C "$src_repo" branch "$deleted_branch"
deleted_home=$tmp_root/deleted-home
deleted_env=(env HOD_HOME="$deleted_home" HOD_BIN_DIR="$tmp_root/deleted-bin" \
  HOD_CLAUDE_DIR="$tmp_root/deleted-claude" HOD_AGENTS_DIR="$tmp_root/deleted-agents")
mkdir -p -- "$deleted_home" "$tmp_root/deleted-bin" \
  "$tmp_root/deleted-claude" "$tmp_root/deleted-agents"
expect_success 'install fixture for deleted remote branch' \
  "${deleted_env[@]}" "$hod" install
deleted_skill=$deleted_home/skill
configure_test_repo_identity "$deleted_skill"
git -C "$deleted_skill" checkout --quiet --no-track -b "$deleted_branch" \
  "origin/$deleted_branch"
git -C "$src_repo" branch -D "$deleted_branch" >/dev/null
printf 'deleted remote local commit\n' >"$deleted_skill/deleted-local.txt"
git -C "$deleted_skill" add deleted-local.txt
git -C "$deleted_skill" commit -q -m "keep deleted remote local commit"
deleted_head_before=$(git -C "$deleted_skill" rev-parse HEAD)
deleted_branch_before=$(git -C "$deleted_skill" symbolic-ref --short HEAD)
deleted_status_before=$(git -C "$deleted_skill" status --porcelain)
deleted_update_preserves_state() {
  [[ "$(git -C "$deleted_skill" rev-parse HEAD)" == "$deleted_head_before" ]] || return 1
  [[ "$(git -C "$deleted_skill" symbolic-ref --short HEAD)" == "$deleted_branch_before" ]] || return 1
  [[ "$(git -C "$deleted_skill" status --porcelain)" == "$deleted_status_before" ]] || return 1
  ! git -C "$deleted_skill" show-ref --verify --quiet \
    "refs/remotes/origin/$deleted_branch" || return 1
  git -C "$deleted_skill" show HEAD:deleted-local.txt | \
    grep -qF 'deleted remote local commit'
}
expect_rejection_contains 'deleted remote branch fails with stable error' \
  "branch '$deleted_branch' has no upstream and no unique remote branch named '$deleted_branch'" \
  "${deleted_env[@]}" "$hod" update
expect_success 'deleted remote update preserves HEAD, branch, worktree, and local commit' \
  deleted_update_preserves_state

non_tag_home=$tmp_root/non-tag-home
non_tag_env=(env HOD_HOME="$non_tag_home" HOD_BIN_DIR="$tmp_root/non-tag-bin" \
  HOD_CLAUDE_DIR="$tmp_root/non-tag-claude" HOD_AGENTS_DIR="$tmp_root/non-tag-agents")
mkdir -p -- "$non_tag_home" "$tmp_root/non-tag-bin" \
  "$tmp_root/non-tag-claude" "$tmp_root/non-tag-agents"
expect_success 'install fixture for detached non-tag checkout' \
  "${non_tag_env[@]}" "$hod" install
non_tag_skill=$non_tag_home/skill
git -C "$non_tag_skill" checkout --quiet --detach HEAD
non_tag_head_before=$(git -C "$non_tag_skill" rev-parse HEAD)
non_tag_status_before=$(git -C "$non_tag_skill" status --porcelain)
non_tag_update_preserves_state() {
  [[ "$(git -C "$non_tag_skill" rev-parse HEAD)" == "$non_tag_head_before" ]] || return 1
  git -C "$non_tag_skill" symbolic-ref -q HEAD >/dev/null 2>&1 && return 1
  [[ "$(git -C "$non_tag_skill" status --porcelain)" == "$non_tag_status_before" ]]
}
expect_rejection_contains 'detached non-tag fails with stable error' \
  'checkout is detached at a non-tag commit; checkout an exact tag or branch' \
  "${non_tag_env[@]}" "$hod" update
expect_success 'detached non-tag update preserves HEAD and worktree' \
  non_tag_update_preserves_state

# ---------------------------------------------------------------------------
# settings profiles
# ---------------------------------------------------------------------------
sproj=$tmp_root/projects/settings-demo
mkdir -p -- "$sproj"
git -C "$sproj" init -q
git -C "$sproj" config user.email "hod-test@example.com"
git -C "$sproj" config user.name "hod-test"

expect_success 'settings list exits 0' \
  "$hod" settings list

expect_rejection 'settings rejects unknown subcommand' \
  "$hod" settings bogus

expect_rejection 'settings install rejects unknown role' \
  "$hod" settings install --project "$sproj" --role nope

# A plain directory installs fine; only the git-exclude step is skipped.
expect_success 'settings install accepts non-git target' \
  "$hod" settings install --project "$plain"
expect_success 'settings profile written to non-git target' \
  test -f "$plain/.claude/settings.impl.json"
expect_output_contains 'settings install reports skipped exclude' \
  'skipped git exclude' \
  "$hod" settings install --project "$plain" --force

# linked git worktree
wt_root=$tmp_root/projects/wt-root
wt_link=$tmp_root/projects/wt-link
mkdir -p -- "$wt_root"
git -C "$wt_root" init -q
git -C "$wt_root" config user.email "hod-test@example.com"
git -C "$wt_root" config user.name "hod-test"
git -C "$wt_root" commit -q --allow-empty -m init
git -C "$wt_root" worktree add -q "$wt_link" -b feat
expect_success 'settings install on linked git worktree' \
  "$hod" settings install --project "$wt_link" --role impl
expect_success 'worktree settings file written' \
  test -f "$wt_link/.claude/settings.impl.json"
expect_success 'worktree exclude lands in main repo' \
  grep -qxF -- .claude/settings.impl.json "$wt_root/.git/info/exclude"

# project install on linked worktree
expect_success 'project install on linked git worktree' \
  "$hod" install --project "$wt_link"
expect_success 'worktree agents adapter linked' \
  test -L "$wt_link/.agents/skills/herdr-orchestrator"
expect_success 'worktree agents exclude lands in main repo' \
  grep -qxF -- .agents/skills/herdr-orchestrator "$wt_root/.git/info/exclude"

# Installing from inside a non-git directory works the same as --project.
plain_cwd=$tmp_root/projects/plain-cwd
mkdir -p -- "$plain_cwd"
expect_success 'settings install accepts non-git cwd' \
  bash -c 'cd "$1" && "$2" settings install --role impl' _ "$plain_cwd" "$hod"
expect_success 'settings profile written from non-git cwd' \
  test -f "$plain_cwd/.claude/settings.impl.json"

# Project adapters install into a plain directory; only the exclude is skipped.
plain_proj=$tmp_root/projects/plain-proj
mkdir -p -- "$plain_proj"
expect_output_contains 'project install reports skipped exclude' \
  'skipped git exclude' \
  "$hod" install --project "$plain_proj"
expect_success 'project adapter linked in non-git dir' \
  test -L "$plain_proj/.agents/skills/herdr-orchestrator"

expect_success 'settings install writes all roles' \
  "$hod" settings install --project "$sproj"

for role in controller impl reviewer; do
  expect_success "settings profile written: $role" \
    test -f "$sproj/.claude/settings.$role.json"
  expect_success "settings profile is valid json: $role" \
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" \
      "$sproj/.claude/settings.$role.json"
  expect_success "settings profile excluded from git: $role" \
    grep -qxF -- ".claude/settings.$role.json" "$sproj/.git/info/exclude"
done

# Profiles must never ship credentials.
expect_rejection 'settings profiles carry no credential keys' \
  grep -rqE 'ANTHROPIC_(API_KEY|AUTH_TOKEN)|apiKeyHelper' "$sproj/.claude/"

# A bare "Agent" deny removes the sub-agent tool from the model's context, which
# is what forces delegation through Herdr panes instead of in-process children.
for role in controller reviewer; do
  expect_success "profile denies the sub-agent tool: $role" \
    python3 -c 'import json,sys; sys.exit(0 if "Agent" in json.load(open(sys.argv[1]))["permissions"]["deny"] else 1)' \
      "$sproj/.claude/settings.$role.json"
done

# Every profile pins its own defaultMode. A --settings file outranks the user's
# settings.json, so a machine configured with dontAsk would otherwise auto-deny
# unlisted tools and block AskUserQuestion, stranding the worker.
expect_success 'controller profile uses default mode' \
  bash -c "test \"\$(jq -r '.permissions.defaultMode' '$sproj/.claude/settings.controller.json')\" = default"
expect_success 'reviewer profile uses default mode' \
  bash -c "test \"\$(jq -r '.permissions.defaultMode' '$sproj/.claude/settings.reviewer.json')\" = default"
expect_success 'impl profile uses acceptEdits mode' \
  bash -c "test \"\$(jq -r '.permissions.defaultMode' '$sproj/.claude/settings.impl.json')\" = acceptEdits"
expect_rejection 'no profile ships dontAsk mode' \
  grep -rq 'dontAsk' "$sproj/.claude/"


expect_rejection 'controller profile has no build-tool prefix denies' \
  grep -qE '"Bash\((npm|pnpm|yarn|npx|cargo|make|go |pytest|xcodebuild|swift)' \
    "$sproj/.claude/settings.controller.json"

# Existing user edits are preserved unless --force.
printf '{ "permissions": { "deny": ["Mine"] } }\n' >"$sproj/.claude/settings.impl.json"
expect_success 'settings install keeps an existing profile' \
  "$hod" settings install --project "$sproj" --role impl
expect_success 'existing profile content untouched' \
  grep -q 'Mine' "$sproj/.claude/settings.impl.json"

expect_success 'settings install --force overwrites' \
  "$hod" settings install --project "$sproj" --role impl --force
expect_rejection 'forced profile no longer has user content' \
  grep -q 'Mine' "$sproj/.claude/settings.impl.json"

# A symlinked destination must be refused rather than followed.
rm -f -- "$sproj/.claude/settings.reviewer.json"
ln -s /etc/hosts "$sproj/.claude/settings.reviewer.json"
expect_rejection 'settings install refuses a symlinked destination' \
  "$hod" settings install --project "$sproj" --role reviewer --force
expect_success 'symlink target untouched' \
  test -L "$sproj/.claude/settings.reviewer.json"

# ---------------------------------------------------------------------------
# memo blocks in CLAUDE.md / AGENTS.md
# ---------------------------------------------------------------------------
memo_begin='<!-- hod:begin — managed by hod; edits inside this block are overwritten -->'

new_memo_project() {
  local dir=$1
  mkdir -p -- "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "hod-test@example.com"
  git -C "$dir" config user.name "hod-test"
}

mproj=$tmp_root/projects/memo-demo
new_memo_project "$mproj"
printf '# CLAUDE.md\n\nuser prose above\n' >"$mproj/CLAUDE.md"
chmod 644 "$mproj/CLAUDE.md"

expect_success 'project install writes memo blocks' \
  "$hod" install --project "$mproj"

for name in CLAUDE.md AGENTS.md; do
  expect_success "memo block present in $name" \
    grep -qxF -- "$memo_begin" "$mproj/$name"
done

expect_success 'memo keeps existing prose' \
  grep -qxF -- 'user prose above' "$mproj/CLAUDE.md"

expect_success 'memo preserves file mode' \
  python3 -c 'import os,stat,sys; sys.exit(0 if stat.S_IMODE(os.stat(sys.argv[1]).st_mode) == 0o644 else 1)' \
    "$mproj/CLAUDE.md"

# Content the user adds after the block must survive a re-install.
printf '\n## added later\n\nkeep me\n' >>"$mproj/CLAUDE.md"
cp -- "$mproj/CLAUDE.md" "$tmp_root/memo-snapshot.md"
expect_success 'memo re-install succeeds' \
  "$hod" install --project "$mproj"
expect_success 'memo re-install is idempotent' \
  cmp -s "$tmp_root/memo-snapshot.md" "$mproj/CLAUDE.md"
expect_success 'memo block is not duplicated' \
  bash -c "test \"\$(grep -cxF -- '$memo_begin' '$mproj/CLAUDE.md')\" = 1"

expect_success 'uninstall strips memo blocks' \
  "$hod" uninstall --project "$mproj"
expect_rejection 'memo block gone after uninstall' \
  grep -qxF -- "$memo_begin" "$mproj/CLAUDE.md"
expect_success 'user prose survives uninstall' \
  grep -qxF -- 'keep me' "$mproj/CLAUDE.md"
expect_rejection 'hod-only memo file is removed, not left empty' \
  test -e "$mproj/AGENTS.md"

# --no-memo keeps adapters but never touches the repository's own files.
mskip=$tmp_root/projects/memo-skip
new_memo_project "$mskip"
expect_success 'install --no-memo succeeds' \
  "$hod" install --project "$mskip" --no-memo
expect_rejection 'install --no-memo writes no CLAUDE.md' \
  test -e "$mskip/CLAUDE.md"
expect_success 'install --no-memo still links adapters' \
  test -L "$mskip/.claude/skills/herdr-orchestrator"

# Damaged or hostile memo files must stop the install rather than be rewritten.
mbad=$tmp_root/projects/memo-unbalanced
new_memo_project "$mbad"
printf '# x\n%s\nno closing marker\n' "$memo_begin" >"$mbad/CLAUDE.md"
expect_rejection 'unbalanced memo markers are rejected' \
  "$hod" install --project "$mbad"

mlink=$tmp_root/projects/memo-symlink
new_memo_project "$mlink"
printf 'outside content\n' >"$tmp_root/memo-outside.md"
ln -s -- "$tmp_root/memo-outside.md" "$mlink/CLAUDE.md"
expect_rejection 'symlinked memo file is rejected' \
  "$hod" install --project "$mlink"
expect_success 'symlink target left untouched' \
  grep -qxF -- 'outside content' "$tmp_root/memo-outside.md"

# Memo variants: --memo-strict writes the Herdr-first block, a plain re-install
# preserves whichever variant the project already carries, and --memo-default
# explicitly downgrades.
strict_marker='Herdr-first project'
mvar=$tmp_root/projects/memo-variant
new_memo_project "$mvar"
expect_success 'install --memo-strict succeeds' \
  "$hod" install --project "$mvar" --memo-strict
expect_success 'strict block written' \
  grep -qF -- "$strict_marker" "$mvar/CLAUDE.md"
expect_success 'plain re-install succeeds on a strict project' \
  "$hod" install --project "$mvar"
expect_success 'plain re-install keeps the strict variant' \
  grep -qF -- "$strict_marker" "$mvar/CLAUDE.md"
expect_success 'strict block not duplicated' \
  bash -c "test \"\$(grep -cxF -- '$memo_begin' '$mvar/CLAUDE.md')\" = 1"
expect_success 'install --memo-default downgrades' \
  "$hod" install --project "$mvar" --memo-default
expect_rejection 'strict marker gone after downgrade' \
  grep -qF -- "$strict_marker" "$mvar/CLAUDE.md"

# User prose outside the markers mentioning the strict phrase must not flip
# the managed block's variant on a plain re-install.
mcol=$tmp_root/projects/memo-collide
new_memo_project "$mcol"
expect_success 'collide: default install succeeds' \
  "$hod" install --project "$mcol"
printf '\n## Team note\n\nThis is a Herdr-first project by policy.\n' >>"$mcol/CLAUDE.md"
expect_success 'collide: plain re-install succeeds' \
  "$hod" install --project "$mcol"
expect_success 'variant detection ignores prose outside the markers' \
  bash -c "awk -v b='$memo_begin' -v e='<!-- hod:end -->' '\$0==b{f=1;next} \$0==e{f=0} f' '$mcol/CLAUDE.md' | grep -c . >/dev/null && ! awk -v b='$memo_begin' -v e='<!-- hod:end -->' '\$0==b{f=1;next} \$0==e{f=0} f' '$mcol/CLAUDE.md' | grep -qF -- '$strict_marker'"
expect_success 'collide: user prose survived' \
  grep -qF -- 'by policy' "$mcol/CLAUDE.md"

expect_rejection 'memo flags without --project are rejected' \
  "$hod" install --memo-strict
expect_rejection '--no-memo conflicts with --memo-strict' \
  "$hod" install --project "$mvar" --no-memo --memo-strict

# ---------------------------------------------------------------------------
# E0-style snapshot: all four Git change domains, paths, content, and staleness
# ---------------------------------------------------------------------------
# Reproduce the 0.1.13 defect first: both revisions were captured only after a
# worker commit, so the committed delta vanished and non-ignored untracked
# files were outside the tracked-only path set.
e0_legacy_repo=$tmp_root/projects/e0-legacy-regression
mkdir -p -- "$e0_legacy_repo"
git -C "$e0_legacy_repo" init -q
git -C "$e0_legacy_repo" config user.email "hod-test@example.com"
git -C "$e0_legacy_repo" config user.name "hod-test"
git -C "$e0_legacy_repo" config commit.gpgSign false
printf 'baseline\n' >"$e0_legacy_repo/tracked.txt"
git -C "$e0_legacy_repo" add tracked.txt
git -C "$e0_legacy_repo" commit -q -m baseline
printf 'worker commit\n' >>"$e0_legacy_repo/tracked.txt"
git -C "$e0_legacy_repo" add tracked.txt
git -C "$e0_legacy_repo" commit -q -m worker-change
printf 'worker untracked\n' >"$e0_legacy_repo/untracked.txt"
e0_legacy_base=$(git -C "$e0_legacy_repo" rev-parse HEAD)
e0_legacy_head=$(git -C "$e0_legacy_repo" rev-parse HEAD)
e0_legacy_paths=$(git -C "$e0_legacy_repo" diff --name-only \
  "$e0_legacy_base" "$e0_legacy_head" --)

e0_legacy_defect_is_reproduced() {
  [[ "$e0_legacy_base" == "$e0_legacy_head" ]] &&
    [[ -z "$e0_legacy_paths" ]] &&
    [[ $(git -C "$e0_legacy_repo" rev-list --count HEAD) -eq 2 ]] &&
    [[ -f "$e0_legacy_repo/untracked.txt" ]]
}
expect_success 'E0 0.1.13 tracked-only recipe misses committed and untracked work' \
  e0_legacy_defect_is_reproduced

e0_repo=$tmp_root/projects/e0-snapshot
mkdir -p -- "$e0_repo"
git -C "$e0_repo" init -q
git -C "$e0_repo" config user.email "hod-test@example.com"
git -C "$e0_repo" config user.name "hod-test"
git -C "$e0_repo" config commit.gpgSign false
printf 'baseline committed\n' >"$e0_repo/committed.txt"
printf 'baseline unstaged\n' >"$e0_repo/unstaged.txt"
printf 'ignored/\n' >"$e0_repo/.gitignore"
git -C "$e0_repo" add -A
git -C "$e0_repo" commit -q -m baseline
e0_base=$(git -C "$e0_repo" rev-parse HEAD)

printf 'committed-domain-content\n' >>"$e0_repo/committed.txt"
git -C "$e0_repo" add committed.txt
git -C "$e0_repo" commit -q -m committed-change
printf 'staged-domain-content\n' >"$e0_repo/staged.txt"
git -C "$e0_repo" add staged.txt
printf 'unstaged-domain-content\n' >>"$e0_repo/unstaged.txt"
printf 'untracked-domain-content\n' >"$e0_repo/untracked.txt"
mkdir -p -- "$e0_repo/nested"
printf 'nested-untracked-content\n' >"$e0_repo/nested/nested-untracked.txt"
printf 'newline-path-content\n' >"$e0_repo/line
break.txt"
printf 'unicode-path-content\n' >"$e0_repo/tệp.txt"
mkdir -p -- "$e0_repo/ignored"
printf 'ignored-content\n' >"$e0_repo/ignored/not-captured.txt"

e0_payload_1=$tmp_root/e0-payload-1
e0_paths_1=$tmp_root/e0-paths-1
e0_payload_2=$tmp_root/e0-payload-2
e0_paths_2=$tmp_root/e0-paths-2
e0_payload_nested=$tmp_root/e0-payload-nested
e0_paths_nested=$tmp_root/e0-paths-nested
e0_expected_paths_unsorted=$tmp_root/e0-expected-paths-unsorted
e0_expected_paths=$tmp_root/e0-expected-paths
e0_hash_1=$(capture_e0_snapshot "$e0_repo" "$e0_base" "$e0_payload_1" "$e0_paths_1")
e0_hash_2=$(capture_e0_snapshot "$e0_repo" "$e0_base" "$e0_payload_2" "$e0_paths_2")
e0_hash_nested=$(capture_e0_snapshot "$e0_repo/nested" "$e0_base" \
  "$e0_payload_nested" "$e0_paths_nested")
printf '%s\0' committed.txt staged.txt unstaged.txt untracked.txt \
  nested/nested-untracked.txt $'line\nbreak.txt' 'tệp.txt' \
  >"$e0_expected_paths_unsorted"
LC_ALL=C sort -zu "$e0_expected_paths_unsorted" >"$e0_expected_paths"

expect_success 'E0 snapshot captures committed, staged, unstaged, and untracked paths' \
  cmp -s "$e0_expected_paths" "$e0_paths_1"

for content in committed-domain-content staged-domain-content \
  unstaged-domain-content; do
  expect_success "E0 snapshot captures content: $content" \
    grep -a -qF -- "$content" "$e0_payload_1"
done

e0_untracked_blob=$(git -C "$e0_repo" hash-object --no-filters -- untracked.txt)
expect_success 'E0 snapshot hashes non-ignored untracked content' \
  grep -a -qF -- "$e0_untracked_blob" "$e0_payload_1"
expect_success 'E0 snapshot preserves a newline path' \
  grep -a -qF -- $'line\nbreak.txt' "$e0_payload_1"
e0_payload_has_non_ascii_path() {
  python3 -c \
    'import sys; fields=open(sys.argv[1], "rb").read().split(b"\0"); raise SystemExit(0 if any(f.endswith(b".txt") and any(byte >= 128 for byte in f) for f in fields) else 1)' \
    "$e0_payload_1"
}
expect_success 'E0 snapshot preserves a non-ASCII path' \
  e0_payload_has_non_ascii_path

expect_rejection 'E0 snapshot excludes ignored untracked content' \
  grep -a -qF -- ignored-content "$e0_payload_1"

e0_hash_is_nonempty_sha256() {
  [[ "$e0_hash_1" =~ ^[0-9a-f]{64}$ ]]
}
expect_success 'E0 snapshot produces a nonempty SHA-256' \
  e0_hash_is_nonempty_sha256

e0_snapshot_is_deterministic() {
  [[ "$e0_hash_1" == "$e0_hash_2" ]] &&
    cmp -s "$e0_payload_1" "$e0_payload_2" &&
    cmp -s "$e0_paths_1" "$e0_paths_2"
}
expect_success 'E0 snapshot is deterministic for unchanged state' \
  e0_snapshot_is_deterministic

e0_nested_cwd_is_invariant() {
  [[ "$e0_hash_1" == "$e0_hash_nested" ]] &&
    cmp -s "$e0_payload_1" "$e0_payload_nested" &&
    cmp -s "$e0_paths_1" "$e0_paths_nested" &&
    python3 -c \
      'import sys; paths=set(open(sys.argv[1], "rb").read().split(b"\0")); raise SystemExit(0 if {b"untracked.txt", b"nested/nested-untracked.txt"} <= paths else 1)' \
      "$e0_paths_nested"
}
expect_success 'E0 snapshot is repository-root invariant from nested cwd' \
  e0_nested_cwd_is_invariant

expect_rejection 'E0 snapshot rejects an invalid BASE_SHA' \
  capture_e0_snapshot "$e0_repo" deadbeef \
  "$tmp_root/e0-invalid-base-payload" "$tmp_root/e0-invalid-base-paths"

e0_non_repo=$tmp_root/projects/e0-not-a-repo
mkdir -p -- "$e0_non_repo"
expect_rejection 'E0 snapshot rejects a non-repository target' \
  capture_e0_snapshot "$e0_non_repo" "$e0_base" \
  "$tmp_root/e0-non-repo-payload" "$tmp_root/e0-non-repo-paths"

e0_race_repo=$tmp_root/projects/e0-race
mkdir -p -- "$e0_race_repo"
git -C "$e0_race_repo" init -q
git -C "$e0_race_repo" config user.email "hod-test@example.com"
git -C "$e0_race_repo" config user.name "hod-test"
git -C "$e0_race_repo" config commit.gpgSign false
printf 'baseline\n' >"$e0_race_repo/race.txt"
git -C "$e0_race_repo" add race.txt
git -C "$e0_race_repo" commit -q -m baseline
e0_race_base=$(git -C "$e0_race_repo" rev-parse HEAD)
printf 'before-snapshot\n' >>"$e0_race_repo/race.txt"

mutate_e0_between_passes() {
  local repo_root=$1
  printf 'between-snapshots\n' >>"$repo_root/race.txt"
}

expect_rejection 'E0 snapshot rejects mutation between consecutive passes' \
  capture_e0_snapshot "$e0_race_repo" "$e0_race_base" \
  "$tmp_root/e0-race-payload" "$tmp_root/e0-race-paths" \
  mutate_e0_between_passes
expect_rejection 'E0 unstable capture emits no payload' \
  test -e "$tmp_root/e0-race-payload"
expect_rejection 'E0 unstable capture emits no changed-path union' \
  test -e "$tmp_root/e0-race-paths"

# Change content on an already captured path. The path union remains identical,
# so only a content-aware receipt can detect that the old hash is stale.
printf 'later-change-invalidates-receipt\n' >>"$e0_repo/untracked.txt"
e0_payload_3=$tmp_root/e0-payload-3
e0_paths_3=$tmp_root/e0-paths-3
e0_hash_3=$(capture_e0_snapshot "$e0_repo" "$e0_base" "$e0_payload_3" "$e0_paths_3")
e0_untracked_blob_3=$(git -C "$e0_repo" hash-object --no-filters -- untracked.txt)

expect_success 'E0 later content change preserves the changed-path union' \
  cmp -s "$e0_paths_1" "$e0_paths_3"

e0_snapshot_becomes_stale() {
  [[ "$e0_hash_1" != "$e0_hash_3" ]] &&
    [[ "$e0_untracked_blob" != "$e0_untracked_blob_3" ]] &&
    grep -a -qF -- "$e0_untracked_blob_3" "$e0_payload_3"
}
expect_success 'E0 snapshot becomes stale after a later content change' \
  e0_snapshot_becomes_stale

# ---------------------------------------------------------------------------
# help / version
# ---------------------------------------------------------------------------
expect_success 'help exits 0' "$hod" help
expect_success 'version exits 0' "$hod" version
expect_output_contains 'version reports 0.1.16' 'hod 0.1.16' "$hod" version
expect_success 'no-args prints usage' "$hod"

# ---------------------------------------------------------------------------
# prompt-safe and harvest use an isolated Herdr stub
# ---------------------------------------------------------------------------
herdr_stub=$tmp_root/herdr-stub
herdr_call_log=$tmp_root/herdr-call.log
herdr_stall_state=$tmp_root/herdr-stall-state
herdr_prompt_start=$tmp_root/herdr-prompt-start
herdr_prompt_release=$tmp_root/herdr-prompt-release
cat >"$herdr_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

command=${1:-}
subcommand=${2:-}
printf '%s\n' "$*" >>"${HOD_TEST_CALL_LOG:?}"
case "$command $subcommand" in
  'agent list')
    list_json=${HOD_TEST_LIST_JSON:-}
    [[ -n "$list_json" ]] || list_json='{"agents":[]}'
    printf '%s\n' "$list_json"
    ;;
  'agent prompt')
    [[ $# -eq 7 && "$5" == --wait && "$6" == --timeout && "$7" =~ ^[0-9]+$ ]] || {
      printf 'unexpected prompt args: %s\n' "$*" >&2
      exit 2
    }
    if [[ "${HOD_TEST_PROMPT_MODE:-success}" == fail ]]; then
      printf 'prompt failed\n' >&2
      exit 1
    fi
    if [[ "${HOD_TEST_PROMPT_MODE:-success}" == stall ]]; then
      printf 'agent_prompt_stalled\n'
      exit 1
    fi
    if [[ "${HOD_TEST_PROMPT_MODE:-success}" == slow ]]; then
      : >"${HOD_TEST_PROMPT_START_MARKER:?}"
      while [[ ! -e "${HOD_TEST_PROMPT_RELEASE_MARKER:?}" ]]; do
        sleep 0.05
      done
    fi
    printf 'prompt sent\n'
    ;;
  'agent send-keys')
    [[ $# -eq 4 && "$3" == "${HOD_TEST_STALL_TARGET:?}" && "$4" == enter ]] || {
      printf 'unexpected send-keys args: %s\n' "$*" >&2
      exit 2
    }
    if [[ "${HOD_TEST_SEND_KEYS_MODE:-success}" == fail ]]; then
      printf 'send-keys failed\n' >&2
      exit 1
    fi
    if [[ "${HOD_TEST_SEND_KEYS_MODE:-success}" != no-transition ]]; then
      # Recovery state changes only after the exact Enter action succeeds.
      printf 'working\n' >"${HOD_TEST_STALL_STATE_FILE:?}"
    fi
    printf 'send-keys accepted\n'
    ;;
  'agent get')
    [[ $# -eq 3 ]] || {
      printf 'unexpected get args: %s\n' "$*" >&2
      exit 2
    }
    if [[ "$3" == "${HOD_TEST_STALL_TARGET:-}" ]]; then
      printf '{"result":{"agent":{"agent_status":"%s"}}}\n' \
        "$(<"${HOD_TEST_STALL_STATE_FILE:?}")"
    else
      get_json=${HOD_TEST_GET_JSON:-}
      [[ -n "$get_json" ]] || get_json='{"agent_status":"idle"}'
      printf '%s\n' "$get_json"
    fi
    ;;
  'agent read')
    [[ $# -eq 7 && "$4" == --source && "$5" == recent-unwrapped && \
      "$6" == --lines && "$7" =~ ^[0-9]+$ ]] || {
      printf 'unexpected read args: %s\n' "$*" >&2
      exit 2
    }
    if [[ "${HOD_TEST_READ_MODE:-success}" == fail ]]; then
      printf 'read failed\n' >&2
      exit 1
    fi
    printf '%s\n' "${HOD_TEST_READ_OUTPUT:-harvested output}"
    ;;
  *)
    printf 'unexpected stub command: %s\n' "$*" >&2
    exit 2
    ;;
esac
EOF
chmod +x "$herdr_stub"
export HOD_HERDR_BIN=$herdr_stub
export HOD_TEST_CALL_LOG=$herdr_call_log
export HOD_TEST_STALL_STATE_FILE=$herdr_stall_state
export HOD_TEST_PROMPT_START_MARKER=$herdr_prompt_start
export HOD_TEST_PROMPT_RELEASE_MARKER=$herdr_prompt_release
export HOD_TEST_STALL_TARGET=stall-agent
export HOD_TEST_LIST_JSON='{"result":{"agents":[{"name":"working-agent","pane_id":"pane-working","agent_status":"working"},{"name":"safe-agent","pane_id":"pane-safe","agent_status":"idle"},{"name":"stall-agent","pane_id":"pane-stall","agent_status":"idle"},{"name":"harvest-agent","pane_id":"pane-harvest","agent_status":"idle"}]}}'
export HOD_TEST_PROMPT_MODE=success
export HOD_TEST_GET_JSON='{"result":{"agent":{"agent_status":"working"}}}'
export HOD_TEST_READ_MODE=success
export HOD_TEST_READ_OUTPUT='harvested output from stub'
printf 'idle\n' >"$herdr_stall_state"
: >"$herdr_call_log"

expect_rejection 'prompt-safe rejects a target absent from live agents' \
  "$hod" prompt-safe missing-agent 'hello'

ambiguous_out=$tmp_root/ambiguous.out
export HOD_TEST_LIST_JSON='{"result":{"agents":[{"name":"ambiguous-agent","pane_id":"pane-a","agent_status":"idle"},{"name":"ambiguous-agent","pane_id":"pane-b","agent_status":"idle"}]}}'
set +e
"$hod" prompt-safe ambiguous-agent 'hello' >"$ambiguous_out" 2>&1
ambiguous_rc=$?
set -e
if [[ $ambiguous_rc -ne 0 ]] && \
   grep -qF -- 'expected exactly one' "$ambiguous_out" && \
   grep -qF -- 'pane-a' "$ambiguous_out" && \
   grep -qF -- 'pane-b' "$ambiguous_out"; then
  record 'prompt-safe rejects ambiguous target and lists matches' true
else
  printf '  ambiguous rc=%s output:\n%s\n' "$ambiguous_rc" "$(cat "$ambiguous_out")" >&2
  record 'prompt-safe rejects ambiguous target and lists matches' false
fi
export HOD_TEST_LIST_JSON='{"result":{"agents":[{"name":"working-agent","pane_id":"pane-working","agent_status":"working"},{"name":"safe-agent","pane_id":"pane-safe","agent_status":"idle"},{"name":"stall-agent","pane_id":"pane-stall","agent_status":"idle"},{"name":"harvest-agent","pane_id":"pane-harvest","agent_status":"idle"}]}}'

expect_rejection 'prompt-safe rejects a working agent without force' \
  "$hod" prompt-safe working-agent 'work'
expect_success 'prompt-safe sends to a working agent with force' \
  "$hod" prompt-safe working-agent 'work' --force --timeout 1234
expect_success 'prompt-safe resolves a target by pane_id' \
  "$hod" prompt-safe pane-safe 'by pane id'
expect_success 'prompt-safe sends resolved pane_id target' \
  grep -qxF -- 'agent prompt pane-safe by pane id --wait --timeout 45000' "$herdr_call_log"
expect_success 'prompt args include target text wait and timeout' \
  grep -qxF -- 'agent prompt working-agent work --wait --timeout 1234' "$herdr_call_log"

expect_success 'prompt-safe sends the first prompt' \
  "$hod" prompt-safe safe-agent 'same text'
expect_rejection 'prompt-safe rejects a duplicate prompt within 10 minutes' \
  "$hod" prompt-safe safe-agent 'same text'
expect_success 'prompt lock is cleaned after duplicate rejection' \
  test ! -e "$hod_home/state/prompt-safe.lock"
force_prompt_count_before=$(grep -cF -- 'agent prompt safe-agent same text --wait --timeout 45000' "$herdr_call_log" || true)
expect_success 'prompt-safe sends a duplicate with force' \
  "$hod" prompt-safe safe-agent 'same text' --force
force_prompt_count_after=$(grep -cF -- 'agent prompt safe-agent same text --wait --timeout 45000' "$herdr_call_log" || true)
if [[ "$force_prompt_count_after" -eq $((force_prompt_count_before + 1)) ]]; then
  record 'prompt-safe --force calls Herdr for duplicate' true
else
  record 'prompt-safe --force calls Herdr for duplicate' false
fi

hash_file=$hod_home/state/prompt-hashes
rm -f -- "$hash_file"
export HOD_TEST_PROMPT_MODE=fail
expect_rejection 'prompt-safe prompt failure is rejected' \
  "$hod" prompt-safe safe-agent 'failed prompt'
expect_success 'prompt-safe prompt failure does not record hash' \
  test ! -e "$hash_file"
export HOD_TEST_PROMPT_MODE=success

old_prompt_hash=$(test_sha256_text 'safe-agent old prompt')
old_prompt_timestamp=$(( $(date +%s) - 601 ))
printf '%s %s\n' "$old_prompt_hash" "$old_prompt_timestamp" >"$hash_file"
expect_success 'prompt-safe sends duplicate hash older than 10 minutes' \
  "$hod" prompt-safe safe-agent 'old prompt'
expect_success 'old duplicate prompt reached Herdr' \
  grep -qF -- 'agent prompt safe-agent old prompt --wait --timeout 45000' "$herdr_call_log"

: >"$hash_file"
for ((line_number = 1; line_number <= 25; line_number++)); do
  printf 'old-hash-%02d 1\n' "$line_number" >>"$hash_file"
done
expect_success 'prompt-safe appends hash record' \
  "$hod" prompt-safe safe-agent 'twentieth-line prompt'
record_line_count=$(wc -l <"$hash_file")
if [[ "$record_line_count" -eq 20 ]]; then
  record 'prompt hash record keeps exactly 20 lines' true
else
  printf '  prompt hash line count: %s\n' "$record_line_count" >&2
  record 'prompt hash record keeps exactly 20 lines' false
fi

# A dead owner can be reclaimed only after ps confirms it is absent.
(exit 0) & stale_pid=$!
wait "$stale_pid"
stale_lock=$hod_home/state/prompt-safe.lock
mkdir -p -- "$stale_lock"
printf '%s\n' "$stale_pid" >"$stale_lock/pid"
expect_success 'prompt-safe reclaims stale dead-PID lock' \
  "$hod" prompt-safe safe-agent 'reclaim dead lock'
expect_success 'reclaimed stale lock leaves no sentinel' \
  test ! -e "$stale_lock"

mkdir -p -- "$stale_lock"
printf '%s\n' "$$" >"$stale_lock/pid"
expect_rejection 'prompt-safe keeps live-PID lock' \
  "$hod" prompt-safe safe-agent 'live lock'
if [[ -f "$stale_lock/pid" ]]; then
  record 'live-PID lock remains intact' true
else
  record 'live-PID lock remains intact' false
fi
rm -f -- "$stale_lock/pid"
rmdir -- "$stale_lock"

mkdir -p -- "$stale_lock"
printf '%s\n' "$stale_pid" >"$stale_lock/pid"
sentinel=$stale_lock/sentinel
printf 'keep me\n' >"$sentinel"
expect_rejection 'prompt-safe keeps lock with extra file' \
  "$hod" prompt-safe safe-agent 'extra lock file'
if [[ -f "$stale_lock/pid" && -f "$sentinel" ]]; then
  record 'extra lock file is not deleted' true
else
  record 'extra lock file is not deleted' false
fi
rm -f -- "$stale_lock/pid" "$sentinel"
rmdir -- "$stale_lock"

# Two processes must serialize duplicate check, send, and hash recording. The
# first prompt holds the lock at a marker; the second must fail before sending.
race_prompt_start=$herdr_prompt_start-race
race_prompt_release=$herdr_prompt_release-race
rm -f -- "$race_prompt_start" "$race_prompt_release"
export HOD_TEST_PROMPT_MODE=slow
export HOD_TEST_PROMPT_START_MARKER=$race_prompt_start
export HOD_TEST_PROMPT_RELEASE_MARKER=$race_prompt_release
race_one_out=$tmp_root/race-one.out
race_two_out=$tmp_root/race-two.out
set +e
"$hod" prompt-safe safe-agent 'race text' >"$race_one_out" 2>&1 &
race_one_pid=$!
set -e
race_ready=false
for attempt in $(seq 1 100); do
  if [[ -f "$race_prompt_start" ]]; then
    race_ready=true
    break
  fi
  sleep 0.05
done
race_two_pid=''
race_two_rc=99
if [[ "$race_ready" == true ]]; then
  set +e
  "$hod" prompt-safe safe-agent 'race text' >"$race_two_out" 2>&1 &
  race_two_pid=$!
  set -e
fi
: >"$race_prompt_release"
set +e
wait "$race_one_pid"
race_one_rc=$?
if [[ -n "$race_two_pid" ]]; then
  wait "$race_two_pid"
  race_two_rc=$?
fi
set -e
race_prompt_count=$(grep -cF -- 'agent prompt safe-agent race text --wait --timeout 45000' "$herdr_call_log" || true)
if [[ "$race_ready" == true && $race_one_rc -eq 0 && $race_two_rc -ne 0 && \
      "$race_prompt_count" == 1 ]] && \
   [[ ! -e "$hod_home/state/prompt-safe.lock" ]]; then
  record 'prompt-safe duplicate guard serializes concurrent sends' true
else
  printf '  race ready=%s first_rc=%s second_rc=%s prompt_count=%s\n' \
    "$race_ready" "$race_one_rc" "$race_two_rc" "$race_prompt_count" >&2
  printf '  first output: %s\n' "$(cat "$race_one_out" 2>/dev/null || true)" >&2
  printf '  second output: %s\n' "$(cat "$race_two_out" 2>/dev/null || true)" >&2
  record 'prompt-safe duplicate guard serializes concurrent sends' false
fi
export HOD_TEST_PROMPT_MODE=success

export HOD_TEST_PROMPT_MODE=stall
export HOD_TEST_LIST_JSON='{"result":{"agents":[{"name":"stall-agent","pane_id":"pane-stall","agent_status":"blocked"}]}}'
printf 'blocked\n' >"$herdr_stall_state"
export HOD_TEST_SEND_KEYS_MODE=no-transition
expect_rejection 'stall recovery rejects unchanged blocked state after successful Enter' \
  "$hod" prompt-safe stall-agent 'blocked unchanged'

export HOD_TEST_LIST_JSON='{"result":{"agents":[{"name":"stall-agent","pane_id":"pane-stall","agent_status":"working"}]}}'
printf 'working\n' >"$herdr_stall_state"
expect_rejection 'stall recovery rejects unchanged working state after successful Enter' \
  "$hod" prompt-safe stall-agent 'working unchanged' --force

export HOD_TEST_LIST_JSON='{"result":{"agents":[{"name":"working-agent","pane_id":"pane-working","agent_status":"working"},{"name":"safe-agent","pane_id":"pane-safe","agent_status":"idle"},{"name":"stall-agent","pane_id":"pane-stall","agent_status":"idle"},{"name":"harvest-agent","pane_id":"pane-harvest","agent_status":"idle"}]}}'
printf 'idle\n' >"$herdr_stall_state"
export HOD_TEST_SEND_KEYS_MODE=success
expect_success 'prompt-safe recovers a stalled prompt' \
  "$hod" prompt-safe stall-agent 'recover me'
expect_success 'stall recovery sends target Enter' \
  grep -qxF -- 'agent send-keys stall-agent enter' "$herdr_call_log"
printf 'idle\n' >"$herdr_stall_state"
export HOD_TEST_SEND_KEYS_MODE=fail
expect_rejection 'stalled prompt with failed Enter stays rejected' \
  "$hod" prompt-safe stall-agent 'recover failed'
expect_success 'prompt lock is cleaned after failed recovery' \
  test ! -e "$hod_home/state/prompt-safe.lock"
export HOD_TEST_SEND_KEYS_MODE=success
export HOD_TEST_PROMPT_MODE=success

harvest_output=$tmp_root/harvest-path
if harvest_output=$("$hod" harvest harvest-agent --lines 37 2>/dev/null) && \
   [[ -f "$harvest_output" ]] && \
   grep -qxF -- 'harvested output from stub' "$harvest_output" && \
   [[ "$(basename -- "$harvest_output")" == *-harvest-agent.txt ]] && \
   grep -qxF -- 'agent read harvest-agent --source recent-unwrapped --lines 37' "$herdr_call_log"; then
  record 'harvest writes bounded output to a sanitized timestamped path' true
else
  printf '  harvest path: %s\n' "$harvest_output" >&2
  record 'harvest writes bounded output to a sanitized timestamped path' false
fi

harvest_before=$tmp_root/harvest-before.txt
harvest_after=$tmp_root/harvest-after.txt
harvest_failure_out=$tmp_root/harvest-failure.out
find "$hod_home/harvest" -type f -print | sort >"$harvest_before"
export HOD_TEST_READ_MODE=fail
set +e
"$hod" harvest harvest-agent >"$harvest_failure_out" 2>&1
harvest_failure_rc=$?
set -e
find "$hod_home/harvest" -type f -print | sort >"$harvest_after"
harvest_temp_files=$(find "$hod_home/harvest" -type f -name '.harvest*' -print -quit)
export HOD_TEST_READ_MODE=success
if [[ $harvest_failure_rc -ne 0 ]] && cmp -s "$harvest_before" "$harvest_after" && \
   [[ -z "$harvest_temp_files" ]]; then
  record 'harvest read failure exits 1 without temporary or artifact files' true
else
  printf '  harvest failure rc=%s output:\n%s\n' "$harvest_failure_rc" "$(cat "$harvest_failure_out")" >&2
  printf '  files before:\n%s\n' "$(cat "$harvest_before")" >&2
  printf '  files after:\n%s\n' "$(cat "$harvest_after")" >&2
  record 'harvest read failure exits 1 without temporary or artifact files' false
fi

expect_rejection 'harvest rejects a target absent from live agents' \
  "$hod" harvest missing-agent
# ui launcher: isolated Node gate, argv forwarding, and entry safety
# ---------------------------------------------------------------------------
ui_fixture_root=$tmp_root/ui-launcher
fake_node_dir=$ui_fixture_root/bin
ui_home=$ui_fixture_root/home
mkdir -p -- "$fake_node_dir" "$ui_home"

fake_node=$fake_node_dir/node
cat >"$fake_node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == --version ]]; then
  printf '%s\n' "${FAKE_NODE_VERSION:-v20.0.0}"
  exit 0
fi

filtered_argv=()
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --hod-owner-marker ]]; then
    shift 2
    continue
  fi
  filtered_argv+=("$1")
  shift
done
printf '%s\0' "${filtered_argv[@]}" >"${FAKE_NODE_ARGV:?}"
exit "${FAKE_NODE_EXIT:-0}"
EOF
chmod +x "$fake_node"

# Keep the dummy entry in the already-created temporary skill checkout. Never
# create a server entry in the real repository; the source checkout currently
# has no ui/server.mjs, so fallback-only real launches remain unavailable.
mkdir -p -- "$skill_dir/ui"
printf '%s\n' '// disposable HOD UI launcher entry' >"$skill_dir/ui/server.mjs"

ui_project="$tmp_root/projects/ui project with spaces"
mkdir -p -- "$ui_project"

run_fake_ui() {
  local argv_file=$1
  local node_version=$2
  local node_exit=$3
  shift 3

  env \
    HOME="$ui_home" \
    HOD_HOME="$hod_home" \
    HOD_BIN_DIR="$bin_dir" \
    HOD_CLAUDE_DIR="$claude_dir" \
    HOD_AGENTS_DIR="$agents_dir" \
    HOD_REPO_URL="$src_repo" \
    PATH="$fake_node_dir:$PATH" \
    FAKE_NODE_ARGV="$argv_file" \
    FAKE_NODE_VERSION="$node_version" \
    FAKE_NODE_EXIT="$node_exit" \
    "$hod" ui "$@"
}

run_fake_start() {
  local argv_file=$1
  local node_version=$2
  local node_exit=$3
  shift 3

  local rc
  if env \
    HOME="$ui_home" \
    HOD_HOME="$hod_home" \
    HOD_BIN_DIR="$bin_dir" \
    HOD_CLAUDE_DIR="$claude_dir" \
    HOD_AGENTS_DIR="$agents_dir" \
    HOD_REPO_URL="$src_repo" \
    PATH="$fake_node_dir:$PATH" \
    FAKE_NODE_ARGV="$argv_file" \
    FAKE_NODE_VERSION="$node_version" \
    FAKE_NODE_EXIT="$node_exit" \
    "$hod" start "$@"; then
    rc=0
  else
    rc=$?
  fi

  if (( rc == 0 )); then
    for _ in {1..100}; do
      [[ -e "$argv_file" ]] && break
      sleep 0.01
    done
  fi
  return "$rc"
}

run_fake_start_from() {
  local cwd=$1
  shift
  (cd -- "$cwd" && run_fake_start "$@")
}

ui_argv_log=$tmp_root/ui-argv.log
ui_argv_expected=$tmp_root/ui-argv.expected
expect_success 'ui launches with a spaced project and port 0' \
  run_fake_ui "$ui_argv_log" v20.0.0 0 \
  --project "$ui_project" --port 0 --no-open
printf '%s\0' "$skill_dir/ui/server.mjs" --hod-bin "$hod" \
  --project "$ui_project" --port 0 --no-open >"$ui_argv_expected"
expect_success 'ui preserves exact argv and spaced paths' \
  cmp -s "$ui_argv_expected" "$ui_argv_log"

ui_runtime_only_log=$tmp_root/ui-runtime-only.log
rm -f -- "$ui_runtime_only_log"
if run_fake_ui "$ui_runtime_only_log" v20.0.0 0 --runtime-only; then
  ui_runtime_only_rc=0
else
  ui_runtime_only_rc=$?
fi
if [[ $ui_runtime_only_rc -eq 2 ]]; then
  record 'public ui rejects the internal runtime-only selector with usage exit 2' true
else
  printf '  expected public ui exit 2, got %s\n' "$ui_runtime_only_rc" >&2
  record 'public ui rejects the internal runtime-only selector with usage exit 2' false
fi
expect_success 'public ui runtime-only rejection does not launch Node' \
  test ! -e "$ui_runtime_only_log"

ui_max_log=$tmp_root/ui-max-argv.log
ui_max_expected=$tmp_root/ui-max-argv.expected
expect_success 'ui accepts port 65535' \
  run_fake_ui "$ui_max_log" v20.0.0 0 --port 65535
printf '%s\0' "$skill_dir/ui/server.mjs" --hod-bin "$hod" \
  --port 65535 >"$ui_max_expected"
expect_success 'ui preserves the maximum port argv' \
  cmp -s "$ui_max_expected" "$ui_max_log"

ui_unknown_log=$tmp_root/ui-unknown-argv.log
ui_unknown_expected=$tmp_root/ui-unknown-argv.expected
expect_success 'ui delegates an unknown option to server parsing' \
  run_fake_ui "$ui_unknown_log" v20.0.0 0 --unknown-ui-option
printf '%s\0' "$skill_dir/ui/server.mjs" --hod-bin "$hod" \
  --unknown-ui-option >"$ui_unknown_expected"
expect_success 'ui preserves the unknown option argv' \
  cmp -s "$ui_unknown_expected" "$ui_unknown_log"

ui_duplicate_log=$tmp_root/ui-duplicate-argv.log
ui_duplicate_expected=$tmp_root/ui-duplicate-argv.expected
expect_success 'ui delegates a duplicate option to server parsing' \
  run_fake_ui "$ui_duplicate_log" v20.0.0 0 --port 1 --port 2
printf '%s\0' "$skill_dir/ui/server.mjs" --hod-bin "$hod" \
  --port 1 --port 2 >"$ui_duplicate_expected"
expect_success 'ui preserves duplicate option argv' \
  cmp -s "$ui_duplicate_expected" "$ui_duplicate_log"

ui_missing_log=$tmp_root/ui-missing-value-argv.log
ui_missing_expected=$tmp_root/ui-missing-value-argv.expected
expect_success 'ui delegates a missing option value to server parsing' \
  run_fake_ui "$ui_missing_log" v20.0.0 0 --project
printf '%s\0' "$skill_dir/ui/server.mjs" --hod-bin "$hod" \
  --project >"$ui_missing_expected"
expect_success 'ui preserves missing-value argv' \
  cmp -s "$ui_missing_expected" "$ui_missing_log"

ui_exit_log=$tmp_root/ui-exit-argv.log
if run_fake_ui "$ui_exit_log" v20.0.0 37; then
  ui_exit_rc=0
else
  ui_exit_rc=$?
fi
if [[ $ui_exit_rc -eq 37 ]]; then
  record 'ui preserves the server exit status' true
else
  printf '  expected ui exit 37, got %s\n' "$ui_exit_rc" >&2
  record 'ui preserves the server exit status' false
fi

ui_old_node_log=$tmp_root/ui-old-node.log
rm -f -- "$ui_old_node_log"
expect_rejection 'ui rejects Node versions below 20' \
  run_fake_ui "$ui_old_node_log" v19.9.0 0
expect_success 'ui does not launch with an old Node' \
  test ! -e "$ui_old_node_log"

ui_outside_entry=$tmp_root/outside-ui-entry.fixture
printf '%s\n' '// outside disposable entry' >"$ui_outside_entry"
rm -f -- "$skill_dir/ui/server.mjs"
ln -s -- "$ui_outside_entry" "$skill_dir/ui/server.mjs"
ui_symlink_log=$tmp_root/ui-symlink.log
expect_rejection 'ui refuses a symlinked installed entry' \
  run_fake_ui "$ui_symlink_log" v20.0.0 0
expect_success 'ui does not launch through a symlinked entry' \
  test ! -e "$ui_symlink_log"
rm -f -- "$skill_dir/ui/server.mjs"

# Exercise missing-entry rejection from a temporary copy so the assertion is
# independent of whether a concurrent checkout later adds the real fallback.
missing_repo=$tmp_root/missing-ui-repo
missing_hod=$missing_repo/bin/hod
missing_home=$tmp_root/missing-ui-home
mkdir -p -- "$missing_repo/bin" "$missing_home"
cp -- "$hod" "$missing_hod"
chmod +x "$missing_hod"
run_missing_ui() {
  local argv_file=$1
  shift

  env \
    HOME="$ui_home" \
    HOD_HOME="$missing_home" \
    HOD_BIN_DIR="$tmp_root/missing-ui-bin" \
    HOD_CLAUDE_DIR="$tmp_root/missing-ui-claude" \
    HOD_AGENTS_DIR="$tmp_root/missing-ui-agents" \
    PATH="$fake_node_dir:$PATH" \
    FAKE_NODE_ARGV="$argv_file" \
    FAKE_NODE_VERSION=v20.0.0 \
    FAKE_NODE_EXIT=0 \
    "$missing_hod" ui "$@"
}

ui_missing_entry_log=$tmp_root/ui-missing-entry.log
expect_rejection 'ui rejects a missing installed and fallback entry' \
  run_missing_ui "$ui_missing_entry_log"
expect_success 'ui does not launch when the entry is missing' \
  test ! -e "$ui_missing_entry_log"

# Restore the disposable installed entry for the start argv checks below.
printf '%s\n' '// disposable HOD UI launcher entry' >"$skill_dir/ui/server.mjs"

start_cwd_a=$tmp_root/start-cwd-a
start_cwd_b=$tmp_root/start-cwd-b
mkdir -p -- "$start_cwd_a" "$start_cwd_b"
start_log_a=$tmp_root/start-a.log
start_log_b=$tmp_root/start-b.log
start_log_default=$tmp_root/start-default.log
start_expected_a=$tmp_root/start-a.expected
start_expected_b=$tmp_root/start-b.expected
start_expected_default=$tmp_root/start-default.expected

expect_success 'start defaults to detached mode from an unrelated cwd' \
  run_fake_start_from "$start_cwd_a" "$start_log_default" v20.0.0 0 --no-open
printf '%s\0' "$skill_dir/ui/server.mjs" --hod-bin "$hod" \
  --no-open --runtime-only >"$start_expected_default"
expect_success 'start default forwards runtime-only argv' \
  cmp -s "$start_expected_default" "$start_log_default"

expect_success 'start launches with an explicit port from an unrelated cwd' \
  run_fake_start_from "$start_cwd_a" "$start_log_a" v20.0.0 0 --port 0 --no-open
printf '%s\0' "$skill_dir/ui/server.mjs" --hod-bin "$hod" \
  --port 0 --no-open --runtime-only >"$start_expected_a"
expect_success 'start forwards runtime-only argv from the first cwd' \
  cmp -s "$start_expected_a" "$start_log_a"

expect_success 'start launches from a second unrelated cwd' \
  run_fake_start_from "$start_cwd_b" "$start_log_b" v20.0.0 0 --no-open --port 65535
printf '%s\0' "$skill_dir/ui/server.mjs" --hod-bin "$hod" \
  --no-open --port 65535 --runtime-only >"$start_expected_b"
expect_success 'start forwards runtime-only argv from the second cwd' \
  cmp -s "$start_expected_b" "$start_log_b"

start_project_log=$tmp_root/start-project.log
expect_rejection 'start rejects --project before Node or project validation' \
  run_fake_start_from "$start_cwd_a" "$start_project_log" v20.0.0 0 \
  --project "$tmp_root/project-does-not-exist"
expect_success 'start --project does not invoke the Node entry' \
  test ! -e "$start_project_log"

# ---------------------------------------------------------------------------
# start / stop: real detached lifecycle, PID/log/lock, no tray
# ---------------------------------------------------------------------------
bg_node_dir=$tmp_root/bg-node/bin
mkdir -p -- "$bg_node_dir"
bg_node=$bg_node_dir/node
bg_token=supersecrettokenvalue123456
cat >"$bg_node" <<EOF
#!/usr/bin/env bash
set -uo pipefail

if [[ "\${1:-}" == --version ]]; then
  printf '%s\n' "\${FAKE_NODE_VERSION:-v20.0.0}"
  exit 0
fi

printf 'http://127.0.0.1:%s/#token=%s\n' "\${FAKE_BG_PORT:-0}" "$bg_token"

if [[ "\${FAKE_BG_IGNORE_TERM:-false}" == true ]]; then
  trap '' TERM
fi

while :; do
  sleep 0.2
done
EOF
chmod +x "$bg_node"

run_bg() {
  env \
    HOME="$ui_home" \
    HOD_HOME="$hod_home" \
    HOD_BIN_DIR="$bin_dir" \
    HOD_CLAUDE_DIR="$claude_dir" \
    HOD_AGENTS_DIR="$agents_dir" \
    HOD_REPO_URL="$src_repo" \
    PATH="$bg_node_dir:$PATH" \
    "$hod" "$@"
}

# Bounded, portable stand-in for GNU `timeout` (absent on stock macOS): race a
# watchdog against the real command so a regression that blocks forever fails
# the suite instead of hanging it.
run_bounded() {
  local limit=$1
  shift
  "$@" &
  local cmd_pid=$! watchdog_pid rc=0
  ( sleep "$limit"; kill -TERM "$cmd_pid" 2>/dev/null || true ) &
  watchdog_pid=$!
  wait "$cmd_pid" 2>/dev/null || rc=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  return "$rc"
}

bg_pid_file=$hod_home/run/start.pid
bg_log_file=$hod_home/run/start.log
bg_lock_dir=$hod_home/run/start.lock

log_lacks_token() {
  ! grep -q "$bg_token" "$1"
}

rm -rf -- "$hod_home/run"
expect_success 'start returns without blocking (bounded 5s)' \
  run_bounded 5 run_bg start --no-open
expect_success 'start writes a pid file' \
  test -f "$bg_pid_file"

read -r bg_pid _ <"$bg_pid_file"
expect_success 'start --background pid is a real live process' \
  kill -0 "$bg_pid"
run_dir_mode=$(stat -f '%Lp' "$hod_home/run" 2>/dev/null || stat -c '%a' "$hod_home/run" 2>/dev/null)
expect_success 'start creates run/ with mode 700' \
  test "$run_dir_mode" = 700
expect_success 'start log never contains the raw one-time token' \
  log_lacks_token "$bg_log_file"
expect_success 'start log keeps a redacted marker in place of the fragment' \
  grep -qF '#[REDACTED]' "$bg_log_file"

first_bg_pid=$bg_pid
expect_output_contains 'a second start reports already running' \
  'already running' run_bg start --background --no-open
read -r bg_pid _ <"$bg_pid_file"
expect_success 'a second start does not spawn a duplicate process' \
  test "$bg_pid" = "$first_bg_pid"

expect_output_contains 'stop terminates the background process' \
  'stopped' run_bg stop
expect_success 'stop removes the pid file' \
  test ! -e "$bg_pid_file"
expect_rejection 'stopped background pid is no longer alive' \
  kill -0 "$first_bg_pid"

expect_output_contains 'stop is idempotent when nothing is running' \
  'not running' run_bg stop

# A plausible, definitely-dead pid: spawn a trivial process and let it exit,
# instead of an out-of-range number — `ps -p` on some platforms answers an
# absurd pid with an error message rather than empty output, which the
# fail-closed liveness check correctly treats as ambiguous, not confirmed
# dead. That is the liveness check doing its job, not a stale-pid bug.
( : ) & dead_pid=$!
wait "$dead_pid" 2>/dev/null || true
printf '%s\n' "$dead_pid" >"$bg_pid_file"
expect_output_contains 'stop cleans up a stale pid file' \
  'not running' run_bg stop
expect_success 'stop removed the stale pid file' \
  test ! -e "$bg_pid_file"

# A live but foreign pid (no hod-owned command line) must never be signaled:
# a bare pid number can be reused by an unrelated process, and `hod stop`
# must fail closed instead of killing whatever now holds that number.
rm -rf -- "$hod_home/run"
mkdir -p -m 700 -- "$hod_home/run"
sleep 60 & foreign_pid=$!
disown "$foreign_pid" 2>/dev/null || true
printf '%s\n' "$foreign_pid" >"$bg_pid_file"
expect_rejection 'stop refuses a live pid with no ownership marker' \
  run_bg stop
expect_success 'the unrelated foreign process is still alive' \
  kill -0 "$foreign_pid"
expect_success 'the pid file for the foreign process is untouched' \
  test -f "$bg_pid_file"
read -r foreign_pid_after _ <"$bg_pid_file"
expect_success 'the untouched pid file still names the foreign pid' \
  test "$foreign_pid_after" = "$foreign_pid"
kill -KILL "$foreign_pid" 2>/dev/null || true
wait "$foreign_pid" 2>/dev/null || true
rm -f -- "$bg_pid_file"

rm -rf -- "$hod_home/run"
mkdir -p -m 700 -- "$hod_home/run"
ln -s -- /nonexistent-target "$bg_pid_file"
expect_rejection 'start refuses a symlinked pid file' \
  run_bg start --no-open
expect_rejection 'stop refuses a symlinked pid file' \
  run_bg stop
rm -f -- "$bg_pid_file"

rm -rf -- "$hod_home/run"
mkdir -p -m 700 -- "$hod_home/run"
ln -s -- /nonexistent-target "$bg_log_file"
expect_rejection 'start refuses a symlinked log file' \
  run_bg start --no-open
rm -f -- "$bg_log_file"

rm -rf -- "$hod_home/run"
FAKE_BG_IGNORE_TERM=true run_bg start --no-open >/dev/null
read -r term_ignoring_pid _ <"$bg_pid_file"
expect_rejection 'stop without --force fails against a SIGTERM-ignoring process' \
  run_bg stop --timeout 500
expect_success 'the SIGTERM-ignoring process is still alive after the timeout' \
  kill -0 "$term_ignoring_pid"
expect_output_contains 'stop --force kills a SIGTERM-ignoring process' \
  'stopped' run_bg stop --force --timeout 500
expect_rejection 'force-stopped process is no longer alive' \
  kill -0 "$term_ignoring_pid"
expect_success 'stop --force removed the pid file' \
  test ! -e "$bg_pid_file"

rm -rf -- "$hod_home/run"
( run_bg start --no-open >"$tmp_root/bg-race-a.out" 2>&1 ) &
race_a_pid=$!
( run_bg start --no-open >"$tmp_root/bg-race-b.out" 2>&1 ) &
race_b_pid=$!
# One side may legitimately lose the start.lock and exit non-zero (fail-
# closed, not a graceful wait/retry) — under `set -e` a bare `wait` on that
# exit status would abort the whole suite, so both are tolerated here; the
# assertions below are what actually prove no duplicate/corrupted state.
wait "$race_a_pid" 2>/dev/null || true
wait "$race_b_pid" 2>/dev/null || true
expect_success 'a start race leaves exactly one pid file' \
  test -f "$bg_pid_file"
read -r race_pid _ <"$bg_pid_file"
race_live_count=$(pgrep -f "$bg_node.*--no-open --runtime-only" 2>/dev/null | wc -l | tr -d ' ')
expect_success 'a start race spawns exactly one live process' \
  test "$race_live_count" = 1
run_bg stop >/dev/null 2>&1 || true

# Leave no fake background process or state behind for later test groups.
rm -rf -- "$hod_home/run"

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail_count"
if (( fail_count > 0 )); then
  printf 'failed: %s\n' "${failures[@]}" >&2
  exit 1
fi
