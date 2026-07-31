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
# help / version
# ---------------------------------------------------------------------------
expect_success 'help exits 0' "$hod" help
expect_success 'version exits 0' "$hod" version
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

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail_count"
if (( fail_count > 0 )); then
  printf 'failed: %s\n' "${failures[@]}" >&2
  exit 1
fi
