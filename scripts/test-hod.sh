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

# Local source repository so install never hits the network.
src_repo=$tmp_root/src-repo
mkdir -p -- "$src_repo"
# Copy working tree (including uncommitted bin/hod under test) into a local git repo.
tar -C "$repo_dir" \
  --exclude .git \
  --exclude .venv \
  -cf - . | tar -C "$src_repo" -xf -
git -C "$src_repo" init -q
git -C "$src_repo" config user.email "hod-test@example.com"
git -C "$src_repo" config user.name "hod-test"
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
  if "$@" >/dev/null 2>&1; then
    record "$name" true
  else
    record "$name" false
  fi
}

expect_rejection() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then
    record "$name" false
  else
    record "$name" true
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

if "topology_metadata_supported=true" not in text:
    raise SystemExit("supported metadata capability path is missing")
if "topology_metadata_supported=false" not in text:
    raise SystemExit("legacy metadata fallback path is missing")
if ".result.pane.pane_id" not in text or "HERDR_PANE_ID" not in text:
    raise SystemExit("metadata contract does not require real pane IDs")
for args_name in ("metadata_args", "report_args"):
    recipe = re.search(
        rf"(?ms)^[ \t]*(?:local[ \t]+)?{args_name}=\(\n(?P<body>.*?)^[ \t]*\)",
        text,
    )
    if not recipe:
        raise SystemExit(f"{args_name} recipe is missing")
    command_lines = [
        line.strip() for line in recipe.group("body").splitlines() if line.strip()
    ]
    recipe_ttl_lines = [
        line for line in command_lines if line.startswith("--ttl-ms")
    ]
    if recipe_ttl_lines != [f"--ttl-ms {expected_ttl}"]:
        raise SystemExit(
            f"{args_name} must contain exactly one finite 24-hour TTL: "
            f"{recipe_ttl_lines}"
        )
    if command_lines[:2] != [
        'herdr pane report-metadata "$pane_id"',
        "--source hod",
    ]:
        raise SystemExit(
            f"{args_name} must place pane_id immediately after report-metadata"
        )
    pattern = rf'if\s+!\s+"\$\{{{args_name}\[@\]\}}"\s*;\s*then'
    if not re.search(pattern, text):
        raise SystemExit(f"{args_name} report is not fail-soft under set -e")
    if re.search(
        rf'if\s+!\s+"\$\{{{args_name}\[@\]\}}"\s+"\$pane_id"',
        text,
    ):
        raise SystemExit(f"{args_name} invocation appends pane_id twice")
if "HOD topology metadata report failed; UI topology may be stale." not in text:
    raise SystemExit("metadata failure warning is missing")
if not re.search(r"report_hod_topology\(\).*?return 0", text, re.S):
    raise SystemExit("metadata helper does not normalize report failure to success")

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

text = "\n".join(
    open(path, encoding="utf-8").read() for path in sys.argv[1:]
)
task_values = re.findall(r'--token\s+"hod_task=([^"]+)"', text)
if not task_values or any(value != "$task_label" for value in task_values):
    raise SystemExit(f"hod_task is not bound only to the sanitized label: {task_values}")
if "[a-z0-9._-]" not in text or not re.search(r"at most 48", text, re.I):
    raise SystemExit("bounded task-label contract is missing")
if re.search(
    r'--token\s+"hod_task=[^"]*(?:prompt|transcript|secret|credential|'
    r'api[_-]?key|bearer|token)',
    text,
    re.I,
):
    raise SystemExit("private or credential-like data appears in hod_task binding")
if not re.search(r'--token\s+"hod_run=\$run_id"', text):
    raise SystemExit("hod_run is not bound to the non-secret run identifier")
PY
}

expect_success 'HOD topology metadata contract is documented' \
  check_hod_topology_contract
expect_success 'HOD topology metadata keeps task labels private and bounded' \
  check_hod_topology_privacy

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

expect_success 'update on a pinned checkout moves to the newest tag' \
  "${pin_env[@]}" "$hod" update
expect_success 'pinned checkout now at the newest tag' pinned_tag_is vt2

expect_success 'doctor reports pinned mode' \
  bash -c "$(printf '%q ' "${pin_env[@]:1}") '$hod' doctor 2>/dev/null | grep -q 'pinned to tag vt2'"

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
expect_output_contains 'version reports 0.1.14' 'hod 0.1.14' "$hod" version
expect_success 'no-args prints usage' "$hod"

# ---------------------------------------------------------------------------
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

printf '%s\0' "$@" >"${FAKE_NODE_ARGV:?}"
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
    "$hod" start "$@"
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
start_expected_a=$tmp_root/start-a.expected
start_expected_b=$tmp_root/start-b.expected

expect_success 'start launches from an unrelated first cwd' \
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
# summary
# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail_count"
if (( fail_count > 0 )); then
  printf 'failed: %s\n' "${failures[@]}" >&2
  exit 1
fi
