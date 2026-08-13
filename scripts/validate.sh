#!/usr/bin/env bash

set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$repo_dir"

bash -n scripts/*.sh
bash -n bin/hod
sh -n install.sh

python3 - <<'PY'
from pathlib import Path
import re

root = Path.cwd()
skill = (root / "SKILL.md").read_text(encoding="utf-8")
frontmatter = re.match(r"\A---\n(.*?)\n---\n", skill, re.DOTALL)
if not frontmatter:
    raise SystemExit("SKILL.md: missing YAML frontmatter")

header = frontmatter.group(1)
for field in ("name", "description"):
    if not re.search(rf"(?m)^{field}:\s*\S", header):
        raise SystemExit(f"SKILL.md: missing non-empty {field}")

name = re.search(r"(?m)^name:\s*(\S+)\s*$", header).group(1)
if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name):
    raise SystemExit(f"SKILL.md: invalid skill name {name!r}")

description = re.search(r"(?m)^description:\s*(.+)$", header).group(1).strip()
if description.startswith(('"', "'")) and description.endswith(description[0]):
    description = description[1:-1]
if len(description) > 1024:
    raise SystemExit(
        f"SKILL.md: description is {len(description)} characters; limit is 1024"
    )

missing = []
for markdown in sorted(root.rglob("*.md")):
    if ".git" in markdown.parts or "plans" in markdown.parts or ".claude" in markdown.parts or ".agents" in markdown.parts:
        continue
    text = markdown.read_text(encoding="utf-8")
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
        if target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        relative = target.split("#", 1)[0]
        if relative and not (markdown.parent / relative).resolve().exists():
            missing.append(f"{markdown.relative_to(root)}: {target}")

if missing:
    raise SystemExit("Missing local Markdown targets:\n" + "\n".join(missing))

def markdown_section(text, heading):
    level = len(heading) - len(heading.lstrip("#"))
    match = re.search(
        rf"(?ms)^{re.escape(heading)}\s*$\n(.*?)(?=^#{{1,{level}}}\s|\Z)",
        text,
    )
    if not match:
        raise SystemExit(f"Missing contract section: {heading}")
    return match.group(1)


def flattened(text):
    return re.sub(r"\s+", " ", text.replace("`", "")).strip()


def single_text_block(section, label):
    blocks = re.findall(r"(?ms)^```text\s*$\n(.*?)^```\s*$", section)
    if len(blocks) != 1:
        raise SystemExit(f"{label}: expected exactly one text contract block")
    return blocks[0]


def schema(block):
    fields = []
    values = {}
    for line in block.splitlines():
        match = re.match(r"^([A-Z][A-Z0-9_]*):\s*(.+)$", line)
        if match:
            field, value = match.groups()
            fields.append(field)
            values[field] = value.strip()
    return fields, values


def require_schema(label, block, expected_fields):
    fields, values = schema(block)
    if fields != expected_fields:
        raise SystemExit(
            f"{label}: fields must be exactly {', '.join(expected_fields)}"
        )
    return values


def require_patterns(label, text, patterns):
    for detail, pattern in patterns.items():
        if not re.search(pattern, text, re.IGNORECASE):
            raise SystemExit(f"{label}: missing {detail}")


always_loaded_contract = flattened(
    markdown_section(skill, "## Non-negotiable contract")
)
require_patterns(
    "SKILL advisor dispatch guard",
    always_loaded_contract,
    {
        "CONSULT-only advisor metadata": r"Reserve hod_role=advisor \+ hod_relation=consult exclusively for an explicitly opted-in adaptive CONSULT",
        "recorded allowed model gate before dispatch": r"Before any pane split, advisor metadata, or agent start for that path, require a recorded user choice of exactly one of Fable, GPT-5\.6 Sol, or Opus",
        "missing or unavailable selection hold": r"if absent or unavailable, HOLD \+ ASK_USER",
        "no inherited default or substitution": r"never infer a default or substitute",
        "no inherited worker preference": r"A worker/planner/scout/reviewer model preference never carries over",
        "ordinary non-advisor classification": r"Ordinary planning/scouting remains worker/delegate \(or reviewer/verify only when it is actually review\), never advisor/consult",
    },
)


adaptive_reference = (root / "references/coordinator-advisor.md").read_text(
    encoding="utf-8"
)
operations = (root / "references/operations.md").read_text(encoding="utf-8")

r0_section = markdown_section(adaptive_reference, "## R0 floor check")
r0 = flattened(r0_section)
r0_fields = [
    "ROUTE_VERSION",
    "BASE_MODE",
    "FACTS",
    "HARD_TRIGGERS",
    "UNCERTAINTY_KIND",
    "UNCERTAINTY",
    "DECISION_RISK",
    "PROBE_BUDGET",
    "PROBES_USED",
    "NEXT_OBSERVATION",
    "INVALIDATE_IF",
    "NEXT",
    "STOP_REASON",
]
r0_values = require_schema(
    "Adaptive R0 v2",
    single_text_block(r0_section, "Adaptive R0 v2"),
    r0_fields,
)
r0_enums = {
    "ROUTE_VERSION": "2",
    "BASE_MODE": "DIRECT | SINGLE | ORCHESTRATE",
    "UNCERTAINTY_KIND": "NONE | DISCOVERABLE_FACT | TECHNICAL_JUDGMENT | USER_PREFERENCE | USER_AUTHORITY | EXECUTION_OUTCOME",
    "DECISION_RISK": "LOW_REVERSIBLE | MATERIAL | HIGH_OR_IRREVERSIBLE",
    "PROBE_BUDGET": "0 | 1",
    "PROBES_USED": "0 | 1",
    "NEXT": "dispatch | read-only-scout | consult | ask-user | stop",
}
for field, expected in r0_enums.items():
    if r0_values[field] != expected:
        raise SystemExit(f"Adaptive R0 v2: {field} must be exactly {expected}")
require_patterns(
    "Adaptive R0 v2",
    r0,
    {
        "closed enums": r"The enums are closed\. Use only the values shown above",
        "stop reason mapping": r"STOP_REASON is non-none when NEXT: stop and none for every other next action",
    },
)
for route in ("DIRECT + CONSULT", "DIRECT + ASK_USER"):
    if route not in r0:
        raise SystemExit(f"Adaptive contract: R0 must cover {route}")

operations_r0_section = markdown_section(
    operations, "### R0 v2, one bounded scout, and dependent invalidation"
)
operations_r0 = flattened(operations_r0_section)
operations_r0_values = require_schema(
    "Operations R0 v2",
    single_text_block(operations_r0_section, "Operations R0 v2"),
    r0_fields,
)
for field, expected in r0_enums.items():
    if operations_r0_values[field] != expected:
        raise SystemExit(f"Operations R0 v2: {field} must be exactly {expected}")

usage = (root / "docs/usage-guide.md").read_text(encoding="utf-8")
adaptive_usage = markdown_section(usage, "## Adaptive coordinator (opt-in)")

base_modes = flattened(
    markdown_section(adaptive_reference, "## Base execution modes")
)
adaptive_skill_mode = flattened(
    markdown_section(skill, "## Opt-in adaptive coordinator")
)
require_patterns(
    "Adaptive opt-in boundary",
    adaptive_skill_mode,
    {
        "explicit activation": r"Activate adaptive routing only when the user explicitly asks",
        "unchanged default": r"Without that opt-in, the workflow above and the existing small-task/direct-user behavior are unchanged",
    },
)
if not re.search(
    r"DIRECT \+ CONSULT \| ASK_USER\s+->\s+no plan",
    base_modes,
    re.IGNORECASE,
):
    raise SystemExit("Adaptive contract: overlaid DIRECT must remain no-plan")
require_patterns(
    "Adaptive DIRECT fast path",
    base_modes,
    {
        "ceremony-free declaration": r"Plain DIRECT is a ceremony-free fast path",
        "no routing envelope": r"does not print or persist a routing envelope",
        "no pane, plan, advisor, or checkpoint": r"does not create a pane, plan, advisor session, or external checkpoint",
    },
)
if not re.search(
    r"Do not structure, print, or persist this envelope for plain DIRECT without an overlay",
    operations_r0,
    re.IGNORECASE,
):
    raise SystemExit("Operations R0 v2: plain DIRECT must remain ceremony-free")

resolver = flattened(markdown_section(adaptive_reference, "### Resolver precedence"))
resolver_patterns = [
    r"Resolve the first applicable row\. A lower row cannot weaken or bypass a higher one",
    r"1\. USER_AUTHORITY -> HOLD \+ ASK_USER",
    r"2\. USER_PREFERENCE -> ASK_USER",
    r"3\. DISCOVERABLE_FACT -> at most one read-only scout",
    r"4\. TECHNICAL_JUDGMENT at MATERIAL or HIGH_OR_IRREVERSIBLE risk -> CONSULT",
    r"5\. EXECUTION_OUTCOME -> obtain the result from the bounded worker action, test, or E0",
    r"6\. Multiple writers or a dependency chain -> ORCHESTRATE",
    r"7\. One writer with narrow, reversible repository scope -> SINGLE",
    r"8\. No dispatch needed -> DIRECT",
]
position = 0
for pattern in resolver_patterns:
    match = re.search(pattern, resolver[position:], re.IGNORECASE)
    if not match:
        raise SystemExit(
            "Adaptive resolver: precedence must keep USER_AUTHORITY and "
            "USER_PREFERENCE before lower cases"
        )
    position += match.end()

one_probe = flattened(
    markdown_section(adaptive_reference, "### One-probe value-of-information rule")
)
require_patterns(
    "Adaptive one-probe rule",
    one_probe,
    {
        "0-or-1 budget and use": r"PROBE_BUDGET and PROBES_USED are each limited to 0 or 1.*PROBES_USED must not exceed PROBE_BUDGET",
        "discoverable fact gate": r"PROBE_BUDGET: 1 only when UNCERTAINTY_KIND: DISCOVERABLE_FACT",
        "route-changing observation": r"one named read-only observation can change the base mode or overlay.*possible results change that route",
        "R0 rerun": r"increment PROBES_USED to 1.*add the observation to FACTS.*rerun R0 before any dispatch or overlay",
        "no second probe": r"cannot allocate or take a second probe",
        "no reset": r"new session, packet, revision, or wording change does not reset the budget",
        "stop after no-value probe": r"observation cannot change the route.*stop collecting facts.*NEXT: stop.*STOP_REASON",
    },
)
require_patterns(
    "Operations one-probe rule",
    operations_r0,
    {
        "discoverable fact gate": r"Scout only when UNCERTAINTY_KIND is DISCOVERABLE_FACT, PROBES_USED: 0",
        "route-changing observation": r"NEXT_OBSERVATION can change the route",
        "R0 rerun": r"set PROBES_USED: 1.*add the fact, and rerun R0",
        "no second scout": r"Never take a second scout",
        "stop mapping": r"otherwise set NEXT: stop and explain STOP_REASON",
    },
)

task_identity = flattened(
    markdown_section(adaptive_reference, "## Task identity")
)
for identity_rule in (
    r"One user objective is one adaptive task and one stable TASK_ID",
    r"G1.*before the first implementation or review worker",
    r"Run G1 again only when.*stale",
):
    if not re.search(identity_rule, task_identity, re.IGNORECASE):
        raise SystemExit(
            f"Adaptive contract: missing task identity rule {identity_rule}"
        )

dependency_fields = [
    "NODE_ID",
    "OWNER",
    "DEPENDS_ON",
    "READY_WHEN",
    "INPUT_FINGERPRINT",
    "INVALIDATE_IF",
    "COMPLETION_CRITERION",
    "EVIDENCE_REF",
]
dependency_section = markdown_section(
    adaptive_reference, "### `ORCHESTRATE` dependency nodes"
)
require_schema(
    "Adaptive ORCHESTRATE dependency node",
    single_text_block(dependency_section, "Adaptive ORCHESTRATE dependency node"),
    dependency_fields,
)

operations_task_packet_section = markdown_section(operations, "## Task packet shape")
operations_task_packet_block = single_text_block(
    operations_task_packet_section, "Operations task packet"
)
require_schema(
    "Operations ORCHESTRATE dependency node",
    operations_task_packet_block,
    dependency_fields,
)

dependency_rules = flattened(dependency_section)
require_patterns(
    "Adaptive dependency invalidation",
    dependency_rules,
    {
        "upstream change HOLD": r"upstream revision, artifact, completion result, or evidence hash changes, immediately HOLD every affected dependent",
        "revision bump": r"Bump each affected packet's PACKET_REVISION",
        "stale input and evidence invalidation": r"invalidate its stale INPUT_FINGERPRINT, EVIDENCE_REF, and any gate verdict derived from them",
        "new fingerprint": r"compute the new fingerprint",
        "R0 rerun": r"Rerun R0 for the affected route",
        "conditional G1 rerun": r"rerun G1 when plan, ownership, dependency, or criteria semantics changed",
        "conditional E0 and G2 rerun": r"rerun E0 and G2 when repository output or review evidence changed",
        "READY_WHEN resume gate": r"Resume only after READY_WHEN is true on the new packet revision",
    },
)
require_patterns(
    "Operations dependency invalidation",
    operations_r0,
    {
        "upstream change HOLD": r"upstream fingerprint changes: HOLD affected dependents",
        "revision bump": r"bump PACKET_REVISION",
        "input invalidation": r"invalidate affected INPUT_FINGERPRINT",
        "gate and evidence invalidation": r"gate verdicts, and EVIDENCE_REF",
        "new fingerprint": r"compute the new fingerprint",
        "R0 rerun": r"then rerun R0",
        "applicable G1 and G2 rerun": r"G1, and G2 where the normative applicability rules require them",
        "READY_WHEN dispatch gate": r"Dispatch only after the new packet satisfies READY_WHEN",
    },
)

receipt_section = markdown_section(
    adaptive_reference, "## Benchmark-only decision receipt"
)
receipt_fields = [
    "INITIAL_ROUTE",
    "FINAL_ROUTE",
    "UNCERTAINTY_KIND",
    "DECISION_RISK",
    "PROBE_USED",
    "OVERLAY",
    "REROUTE_REASON",
    "STOP_REASON",
    "OUTCOME",
    "EVIDENCE_REF",
]
receipt_values = require_schema(
    "Benchmark-only decision receipt",
    single_text_block(receipt_section, "Benchmark-only decision receipt"),
    receipt_fields,
)
receipt_enums = {
    "INITIAL_ROUTE": "DIRECT | SINGLE | ORCHESTRATE",
    "FINAL_ROUTE": "DIRECT | SINGLE | ORCHESTRATE",
    "UNCERTAINTY_KIND": r0_enums["UNCERTAINTY_KIND"],
    "DECISION_RISK": r0_enums["DECISION_RISK"],
    "OVERLAY": "none | CONSULT | ASK_USER",
}
for field, expected in receipt_enums.items():
    if receipt_values[field] != expected:
        raise SystemExit(
            f"Benchmark-only decision receipt: {field} must be exactly {expected}"
        )
receipt_contract = flattened(receipt_section)
require_patterns(
    "Benchmark-only decision receipt",
    receipt_contract,
    {
        "benchmark-only scope": r"This receipt is a benchmark artifact only",
        "no CLI surface": r"does not create a CLI command",
        "no runtime router": r"does not create.*runtime router",
        "no persistent telemetry": r"does not create.*persistent product telemetry",
        "no production emission or retention": r"Production orchestration does not need to emit or retain it",
    },
)

# A gate summary is not enough: each valid verdict needs its own action and
# explicit next state. Parsing table cells keeps this independent of prose.
table_rows = []
for line in adaptive_reference.splitlines():
    if line.startswith("|") and line.endswith("|"):
        table_rows.append([flattened(cell) for cell in line.strip("|").split("|")])

gate_verdicts = {
    "G1": {
        "PLAN_ACCEPTABLE": "ROUTED",
        "PLAN_REVISE": "HOLD",
        "PLAN_REJECT": "HOLD",
    },
    "G2": {
        "EVIDENCE_SUFFICIENT": "VERIFYING",
        "EVIDENCE_INCOMPLETE": "HOLD",
        "BLOCKING_FINDING": "HOLD",
    },
    "G3": {
        "DIAGNOSIS_READY": "EVIDENCE_CAPTURED",
        "MORE_EVIDENCE_NEEDED": "HOLD",
        "ESCALATE_USER": "WAITING_USER",
    },
    "G4": {
        "RISK_ASSESSED": "WAITING_USER",
        "MORE_EVIDENCE_NEEDED": "HOLD",
    },
}
for gate, verdicts in gate_verdicts.items():
    for verdict, expected_state in verdicts.items():
        transition = next(
            (
                row
                for row in table_rows
                if len(row) >= 4
                and row[0] == gate
                and row[1] == verdict
                and row[2] not in ("", "---")
                and row[-1] == expected_state
            ),
            None,
        )
        if transition is None:
            raise SystemExit(
                f"Adaptive contract: {gate} {verdict} must transition to {expected_state}"
            )

packet_contract = flattened(
    markdown_section(adaptive_reference, "### Common header")
)
if not re.search(r"RETRY_LIMIT:.*0\s+to\s+2", packet_contract):
    raise SystemExit("Adaptive contract: packet retry limit must be bounded at 0..2")
for verdict in (
    "PLAN_REVISE",
    "EVIDENCE_INCOMPLETE",
    "BLOCKING_FINDING",
    "MORE_EVIDENCE_NEEDED",
):
    if verdict not in packet_contract:
        raise SystemExit(
            f"Adaptive contract: repeated {verdict} consult must consume retry budget"
        )

e0_recipe_section = markdown_section(operations, "### E0 receipt capture")
e0_recipe = flattened(e0_recipe_section)
e0_contract = flattened(
    markdown_section(adaptive_reference, "### E0 — always-on repository evidence")
)
require_patterns(
    "Adaptive E0 normative boundary",
    e0_contract,
    {
        "mandatory every repository change": r"mandatory before technical acceptance of every task that changes a repository artifact",
        "canonical repository root": r"canonicalize the repository root once.*Every Git command.*relative to that root",
        "stable double capture": r"capture .* twice in immediate succession.*match byte-for-byte",
        "bounded not atomic": r"not an atomic filesystem snapshot.*adversarial ABA",
    },
)
for stable_diff_flag in (
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
):
    if stable_diff_flag not in e0_recipe:
        raise SystemExit(
            f"Adaptive E0 recipe: missing deterministic diff flag {stable_diff_flag}"
        )
e0_recipe_requirements = {
    "canonical repository root": r"repo_root=.*rev-parse --show-toplevel.*repo_root=.*pwd -P",
    "stable clean baseline": r"base_sha_before.*status --porcelain=v1 -z --untracked-files=all.*base_sha_after",
    "committed domain": r"COMMITTED.*diff .*\$base_sha.*\$head_before",
    "staged domain anchored to captured HEAD": r"STAGED.*diff --cached.*\$head_before",
    "unstaged domain": r"UNSTAGED.*diff .*--no-renames --",
    "non-ignored untracked domain": r"UNTRACKED.*ls-files --others --exclude-standard -z",
    "untracked content hash": r"hash-object --no-filters",
    "NUL-safe path union": r"sort -zu",
    "per-pass HEAD bracket": r"head_before=.*HEAD\^\{commit\}.*head_after=.*HEAD\^\{commit\}.*head_before.*head_after.*return 1",
    "two consecutive complete passes": r"if ! capture_e0_pass \"\$e0_tmp/first\" \|\| ! capture_e0_pass \"\$e0_tmp/second\"; then",
    "byte-identical pass guard": r"for artifact in head paths payload hash status.*cmp -s.*first.*second.*repository changed during capture; HOLD",
    "NUL-safe dirty state": r"status --porcelain=v1 -z --untracked-files=all.*pass_dir/status",
    "post-G2 stable double recapture": r"After the verdict, repeat the entire stable double capture.*Any mismatch.*invalidates E0 and G2",
    "baseline HEAD failure guard": r"if ! base_sha_before=.*git -C.*repo_root.*rev-parse --verify.*HEAD\^\{commit\}",
    "baseline status failure guard": r"if ! git -C.*repo_root.*status --porcelain=v1 -z",
    "BASE_SHA validation": r"git -C.*repo_root.*rev-parse --verify.*\$\{base_sha\}\^\{commit\}",
    "BASE_SHA ancestry guard": r"merge-base --is-ancestor.*\$base_sha.*\$head_before",
    "changed-path failure guard": r"if ! \{.*sort -zu.*pass_dir/paths.*return 1",
    "per-command path failure guard": r"diff --name-only.*\|\| exit 1.*ls-files --others --exclude-standard -z \|\| exit 1",
    "per-command hash failure guard": r"COMMITTED.*diff --binary.*\|\| return 1.*STAGED.*\|\| return 1.*UNSTAGED.*\|\| return 1",
    "hash shape guard": r"grep -Eq.*\^\[0-9a-f\]\{64\}\$.*pass_dir/hash.*return 1",
    "capture failure HOLD": r"cannot capture two complete repository states; HOLD",
}
for label, pattern in e0_recipe_requirements.items():
    if not re.search(pattern, e0_recipe, re.IGNORECASE):
        raise SystemExit(f"Adaptive E0 recipe: missing {label}")

for line in e0_recipe_section.splitlines():
    if "git " in line and "rev-parse --show-toplevel" not in line:
        if 'git -C "$repo_root"' not in line:
            raise SystemExit(
                "Adaptive E0 recipe: every capture Git command must use canonical repo_root"
            )

checkpoint = flattened(
    markdown_section(adaptive_reference, "### Storage and writer contract")
)
checkpoint_requirements = {
    "sole control-plane exception": r"sole\s+sanctioned\s+control-plane\s+exception",
    "active coordinator ownership": r"active\s+coordinator",
    "exact external path": r"one\s+exact\s+external\s+checkpoint\s+path",
    "task-file boundary": r"task\s+files",
    "repository boundary": r"repository\s+content",
    "worker-artifact boundary": r"worker\s+artifacts",
    "honest enforcement boundary": r"wording-level.*evidence-checked.*sandbox\s+enforcement",
}
for label, pattern in checkpoint_requirements.items():
    if not re.search(pattern, checkpoint, re.IGNORECASE):
        raise SystemExit(f"Adaptive checkpoint contract: missing {label}")

checkpoint_shape = flattened(
    adaptive_reference.split("### Minimum Markdown shape", 1)[1].split(
        "### Handoff gap", 1
    )[0]
)
for authority_field in ("action", "exact target and scope", "user-message ref", "status", "time/expiry"):
    if authority_field not in checkpoint_shape:
        raise SystemExit(
            f"Adaptive checkpoint contract: authority record missing {authority_field}"
        )

operations_task_packet = flattened(operations_task_packet_section)
if not re.search(r"Task ID:.*parent user objective", operations_task_packet):
    raise SystemExit("Operations task packet: missing stable parent TASK_ID")
if not re.search(r"Retry limit:.*0 to 2", operations_task_packet):
    raise SystemExit("Operations task packet: retry limit must match 0..2 contract")

checkpoint_recipe = flattened(
    markdown_section(operations, "### External checkpoint and handoff")
)
checkpoint_path_guards = {
    "canonical checkout root": r"repo_root=.*show-toplevel.*pwd -P",
    "canonical temporary root": r"temp_root=.*pwd -P",
    "pre-create outside-checkout guard": r"case \"\$temp_root/\".*\"\$repo_root/\"\*.*HOLD",
    "canonical checkpoint path": r"checkpoint_dir=.*pwd -P",
    "post-create outside-checkout guard": r"case \"\$checkpoint_dir/\".*\"\$repo_root/\"\*.*HOLD",
    "private creation mask": r"umask 077",
}
for label, pattern in checkpoint_path_guards.items():
    if not re.search(pattern, checkpoint_recipe, re.IGNORECASE):
        raise SystemExit(f"Adaptive checkpoint recipe: missing {label}")

model_policy = flattened(markdown_section(adaptive_reference, "## Model policy"))
advisor_policy = flattened(markdown_section(adaptive_reference, "## Invariants"))
if not re.search(
    r"advisor supplies an assessment; no advisor verdict grants authority or replaces the coordinator's judgment",
    advisor_policy,
    re.IGNORECASE,
):
    raise SystemExit(
        "Adaptive advisor policy: an advisor assessment must never grant authority"
    )
if not re.search(
    r"Advisor selection is limited to Fable, GPT-5\.6 Sol, or Opus\.",
    model_policy,
):
    raise SystemExit(
        "Adaptive model policy: advisor allowlist must remain exactly "
        "Fable, GPT-5.6 Sol, or Opus"
    )
if not re.search(
    r"no user-selected advisor.*HOLD \+ ASK_USER.*never infer a default",
    model_policy,
    re.IGNORECASE,
):
    raise SystemExit(
        "Adaptive model policy: missing selection must HOLD and return to user"
    )

usage = (root / "docs/usage-guide.md").read_text(encoding="utf-8")
adaptive_usage = markdown_section(usage, "## Adaptive coordinator (opt-in)")
examples = re.findall(r"(?ms)^```text\s*$\n(.*?)^```\s*$", adaptive_usage)
if len(examples) != 5:
    raise SystemExit("Adaptive usage guide: expected DIRECT, SINGLE, ORCHESTRATE, CONSULT, and ASK_USER examples")
for index, example in enumerate(examples, start=1):
    if not re.search(r"\bHerdr\b", example) or "herdr-orchestrator" not in example:
        raise SystemExit(
            f"Adaptive usage guide: example {index} must name Herdr and herdr-orchestrator"
        )

example_sections = {
    "DIRECT": markdown_section(adaptive_usage, "### `DIRECT`"),
    "SINGLE": markdown_section(adaptive_usage, "### `SINGLE`"),
    "ORCHESTRATE": markdown_section(adaptive_usage, "### `ORCHESTRATE`"),
}
example_semantics = {
    "DIRECT": (r"\bexplain\b", r"read-only"),
    "SINGLE": (r"one writer", r"E0 receipt", r"do not commit or push"),
    "ORCHESTRATE": (r"\bworker", r"disjoint ownership", r"working plan"),
}
for route, patterns in example_semantics.items():
    route_examples = re.findall(
        r"(?ms)^```text\s*$\n(.*?)^```\s*$", example_sections[route]
    )
    if len(route_examples) != 1:
        raise SystemExit(f"Adaptive usage guide: {route} needs exactly one example")
    for pattern in patterns:
        if not re.search(pattern, route_examples[0], re.IGNORECASE):
            raise SystemExit(
                f"Adaptive usage guide: {route} example missing semantic {pattern}"
            )

overlay_section = markdown_section(
    adaptive_usage, "### Overlays: `CONSULT` and `ASK_USER`"
)
overlay_examples = re.findall(r"(?ms)^```text\s*$\n(.*?)^```\s*$", overlay_section)
if len(overlay_examples) != 2:
    raise SystemExit(
        "Adaptive usage guide: overlays must contain CONSULT and ASK_USER examples"
    )
advisor_examples = [overlay_examples[0]]
allowed_advisors = ("Fable", "GPT-5.6 Sol", "Opus")
for example in advisor_examples:
    if not re.search(r"\bconsult\b", example, re.IGNORECASE) or not re.search(
        r"\badvisor\b", example, re.IGNORECASE
    ):
        raise SystemExit(
            "Adaptive usage guide: CONSULT example must explicitly request an advisor"
        )
    selections = sum(example.count(model) for model in allowed_advisors)
    if selections != 1:
        raise SystemExit(
            "Adaptive usage guide: each advisor consult example must choose exactly one allowed model"
        )
    if not re.search(r"I\s+choose\s+GPT-5\.6 Sol;", example):
        raise SystemExit(
            "Adaptive usage guide: benchmark-facing CONSULT example must select GPT-5.6 Sol"
        )
    if not re.search(
        r"do not substitute if it is unavailable", example, re.IGNORECASE
    ):
        raise SystemExit(
            "Adaptive usage guide: selected advisor must not be substituted"
        )

if not re.search(
    r"other allowed advisor choices are Fable and Opus\. Name exactly one selected model",
    flattened(overlay_section),
    re.IGNORECASE,
):
    raise SystemExit(
        "Adaptive usage guide: generic advisor allowlist must retain Fable and Opus"
    )

ask_user_example = overlay_examples[1]
for pattern in (r"\bHold\b", r"\bpublishing\b", r"\bask me\b", r"not.*advisor.*approval"):
    if not re.search(pattern, ask_user_example, re.IGNORECASE):
        raise SystemExit(
            f"Adaptive usage guide: ASK_USER example missing semantic {pattern}"
        )

expected_version = "0.1.15"
version_surfaces = {
    "bin/hod": (
        (root / "bin/hod").read_text(encoding="utf-8"),
        r"(?m)^HOD_VERSION=([0-9.]+)$",
    ),
    "README.md": ((root / "README.md").read_text(encoding="utf-8"), r"HOD_REF=v([0-9.]+)"),
    "README.vi.md": ((root / "README.vi.md").read_text(encoding="utf-8"), r"HOD_REF=v([0-9.]+)"),
    "docs/getting-started.md": (
        (root / "docs/getting-started.md").read_text(encoding="utf-8"),
        r"HOD_REF=v([0-9.]+)",
    ),
    "SKILL.md": (skill, r"normative hod `([0-9.]+)` reference"),
    "references/coordinator-advisor.md": (
        adaptive_reference,
        r"normative reference for hod `([0-9.]+)` adaptive mode",
    ),
}
for surface, (text, pattern) in version_surfaces.items():
    versions = set(re.findall(pattern, text))
    if versions != {expected_version}:
        found = ", ".join(sorted(versions)) if versions else "none"
        raise SystemExit(
            f"Version parity: {surface} must name only {expected_version}; found {found}"
        )

print(
    "Validated Bash syntax, skill frontmatter, local Markdown targets, "
    "and adaptive protocol contracts."
)
PY
