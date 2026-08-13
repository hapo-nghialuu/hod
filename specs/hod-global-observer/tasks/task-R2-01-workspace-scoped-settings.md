# Task R2-01: Workspace-scoped Settings

**Requirement:** R1.3, R2.2, R2.5, and R2.6 — bounded Settings in the global observer
**Status:** done
**Priority:** P0
**Estimated Effort:** 1 implementation day
**Dependencies:** R0-01, R1-01
**Spec:** specs/hod-global-observer/
Contracts: WORKSPACE_SETTINGS_TARGET

<!-- contract:WORKSPACE_SETTINGS_TARGET -->
```json
{
  "requestIdentity": "opaque workspaceId",
  "pathInputFromBrowser": false,
  "resolutionPriority": ["workspace checkout_path", "single root controller cwd", "single unique pane cwd"],
  "canonicalDirectoryRequired": true,
  "missingOrStale": "reject",
  "ambiguous": "reject",
  "invalidOrUnsafe": "reject",
  "hodRoles": ["controller", "impl", "reviewer"],
  "herdrKeys": "existing typed allowlist",
  "confirmationRequired": true,
  "agentControl": false
}
```

## Context

- **Why:** Users need to configure a live Herdr project from the global `hod start` UI without launching HOD from that checkout.
- **Current state:** R0/R1 shipped a read-only observer with Settings denied; the user explicitly approved expanding that boundary to workspace-scoped Settings.
- **Target outcome:** Settings selects one live workspace by opaque ID, resolves its target server-side from a fresh snapshot, exposes no path, and retains all existing allowlists and confirmations.

## Constraints

- **MUST:** Resolve every project-scoped read/write from a fresh authoritative Herdr snapshot and fail closed for missing, stale, ambiguous, invalid, or unsafe targets.
- **SHOULD:** Reuse the existing HOD role and Herdr config services so their allowlists, atomic write checks, postconditions, and confirmation tokens stay authoritative.
- **MUST NOT:** Accept or return project paths, derive a target from the launch directory, expose agent control, or widen the documented role/key allowlists.
- **SCOPE:** Implement only workspace-scoped Settings and the approved `scope_lock`; runtime observation and transcript selection remain read-only.

## Steps

- [x] 1. Add authoritative workspace target resolution and Settings composition.
  - Read one fresh `session.snapshot` per Settings operation, prefer checkout metadata, then one root coordinator, then one unique pane directory.
  - Canonicalize the result and reject missing, stale, ambiguous, invalid, or unsafe metadata.
  - _Requirements: 1.3, 2.6_

- [x] 2. Add bounded Settings API and UI selection.
  - Accept only opaque `workspaceId` plus existing HOD role or Herdr setting fields; reject path-like query/body fields.
  - Preserve role/key allowlists, confirmation tokens, serialized mutations, and disabled agent control.
  - _Requirements: 2.2, 2.5, 2.6_

- [x] 3. Add regression and integration coverage.
  - Cover fresh snapshots, resolution precedence, fail-closed targets, path redaction/rejection, stale UI responses, confirmations, and runtime reachability.
  - _Requirements: 1.3, 2.2, 2.5, 2.6_

## Requirements

- 1.3 — Observation ignores the launch directory; Settings resolves only a selected workspace from fresh authoritative state and exposes no path.
- 2.2 — HOD role and global Herdr setting mutations retain documented allowlists and confirmation tokens.
- 2.5 — Transcript display remains read-only and agent/lifecycle control remains absent.
- 2.6 — Missing, stale, ambiguous, invalid, unsafe, or path-injected targets fail closed.

## Related Files

| Path | Action | Description |
|---|---|---|
| `ui/server/global-settings.mjs` | Create | Fresh snapshot reader, workspace resolver, and bounded Settings composition. |
| `ui/server/global-observer-api-controller.mjs` | Modify | Capabilities and bounded Settings routes. |
| `ui/server/global-observer-runtime.mjs` | Modify | Compose the global Settings controller. |
| `ui/server/application-paths.mjs` | Modify | Supply existing HOD templates/binary and Herdr config paths. |
| `ui/server.mjs` | Modify | Pass Settings dependencies into runtime-only composition. |
| `ui/public/modules/settings-project-selector.mjs` | Create | Render opaque live workspace choices. |
| `ui/public/modules/settings-view.mjs` | Modify | Select workspace and preserve confirmations. |
| `ui/public/modules/api-client.mjs` | Modify | Send only workspace IDs and allowlisted Settings fields. |
| `ui/public/modules/runtime-sync.mjs` | Modify | Coordinate workspace Settings refreshes without stale replacement. |
| `ui/public/app.mjs` | Modify | Wire workspace selection callbacks. |
| `ui/test/global-settings.test.mjs` | Create | Resolver, freshness, redaction, mutation, and negative-path coverage. |
| `ui/test/global-observer-api-controller.test.mjs` | Modify | Settings route and input-boundary coverage. |
| `ui/test/global-observer-runtime.test.mjs` | Modify | Production composition coverage. |
| `ui/test/settings-view.test.mjs` | Modify | Selector, confirmation, and stale-response coverage. |
| `ui/test/runtime-sync.test.mjs` | Modify | Workspace Settings synchronization coverage. |
| `ui/test/server-entrypoint.test.mjs` | Modify | Runtime entrypoint dependency coverage. |
| `ui/test/ui-store.test.mjs` | Modify | Selected workspace state coverage. |

## Completion Criteria

- [x] Settings lists live workspace labels and never exposes a target path to browser state or responses.
- [x] Every project-scoped operation resolves a fresh authoritative target and all invalid/ambiguous/unsafe cases make zero writes.
- [x] Existing role/key allowlists, confirmations, atomic Herdr writes, and HOD postconditions remain enforced.
- [x] `hod start` reaches the Settings flow while transcript observation stays read-only and agent control stays disabled.

## Evidence

Verification: PASS on the final functional release snapshot at `2026-08-13T10:00:50+07:00`.

- [x] Automated verification
  - Commands: `node --test ui/test/global-settings.test.mjs ui/test/global-observer-api-controller.test.mjs ui/test/global-observer-runtime.test.mjs ui/test/settings-view.test.mjs ui/test/runtime-sync.test.mjs ui/test/server-entrypoint.test.mjs ui/test/ui-store.test.mjs`; `npm --prefix ui test`; `npm --prefix ui run check`.
  - Proof: independent full QA passed `152/152` HOD tests and `216/216` UI tests (`368/368` total); validation, syntax, and `git diff --check` exited 0; every changed production `.mjs` is at most 200 lines.
- [x] Artifact / runtime verification
  - Inspect: `/api/settings`, workspace selector, selected Settings state, and the production `hod start` composition.
  - Proof: route, composition, loopback HTTP, selection, confirmation, and redaction integration tests passed; responses expose workspace IDs/labels only and mutations resolve targets server-side.
- [x] Runtime reachability verification
  - Entrypoint/caller: `hod start` → `ui/server.mjs --runtime-only` → `GlobalObserverRuntime` → global Settings controller → Settings UI.
  - Proof: production imports and entrypoint integration passed in `scripts/test-hod.sh`, `server-entrypoint.test.mjs`, and the complete UI suite.
- [x] Contract / negative-path verification
  - Check: path injection, duplicate/unknown workspace, multiple root coordinators, unsafe canonicalization, stale UI response, invalid role/key/value/confirmation, and agent-control absence.
  - Proof: independent adversarial review scored `PASS 10/10` with zero Critical/High/Medium findings; its focused counterexamples passed `21/21`.

Browser screenshot/viewport E2E remained environment-gated because no browser backend was connected; deterministic loopback, DOM, responsive CSS, CSP, and renderer tests passed and are the release evidence used here.

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Workspace metadata changes between UI selection and mutation. | High | Resolve a fresh authoritative snapshot for every mutation and fail closed on target ambiguity. |
| Browser input redirects a write to an arbitrary path. | High | Accept only opaque workspace IDs, reject path-like fields, canonicalize server-derived targets, and never return paths. |
| Settings expansion accidentally enables agent control. | Medium | Keep `control: false`, expose no control route, and retain negative tests. |
