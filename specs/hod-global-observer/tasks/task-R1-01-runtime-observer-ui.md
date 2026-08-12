# Task R1-01: Capability-aware global observer UI

**Requirement:** R1.5 and R2.1-R2.5 — global view, compatibility, and UI capabilities
**Status:** done
**Hotfix status:** tab representation verified
**Priority:** P0
**Estimated Effort:** 2–3 implementation days
**Dependencies:** R0-01
**Spec:** specs/hod-global-observer/

## Context

- **Why:** Users need one global runtime view without losing the existing
  project UI, transcript presentation, terminal styling, or session security.
- **Dependency:** R0-01 supplies the reachable `hod start` runtime, explicit
  capabilities, read-only observer API, and one-shot snapshot state.
- **Repository fact:** the frontend is zero-dependency browser `.mjs` code with
  an existing 200-line file limit. Use the listed modules and existing tests;
  create at most one focused frontend module/test only if the limit requires it.
- **Target outcome:** the observer renders every runtime object, selected
  transcript, and all-space counts while legacy `hod ui` behavior remains
  compatible.

## Constraints

- **MUST:** Consume the R0 observer capabilities exactly: settings=false,
  control=false, mutation=false. Hide Settings when settings is false and do
  not expose mutation/control actions.
- **MUST:** Treat missing capabilities as true for legacy `hod ui`
  compatibility. An explicit false must remain false and authoritative.
- **MUST:** Show all-space counts for spaces, agents, `working`, `blocked`,
  `idle`, and `done`, without filtering the global aggregate by current
  directory or selected space.
- **MUST:** Preserve selected transcript as read-only, preserve the existing
  Claude-orange UI, and preserve the existing Session Host/Origin security
  behavior.
- **MUST NOT:** Add project/config reads, settings I/O, agent/lifecycle
  control, daemon/LAN behavior, auto-install/update, or a second terminal
  theme. Do not modify the R0 server modules in this task.
- **SCOPE:** Modify only the frontend/docs/test paths in Related Files. No
  additional implementation, documentation, or test path is in scope except
  the explicitly limited focused frontend create allowance.

## Steps

1. Make the static shell and console navigation capability-aware.
   - Mark Settings surfaces as capability-gated in `ui/public/index.html`.
   - Update `console-view.mjs` to hide Settings and prevent navigation when
     `capabilities.settings === false`.
   - Keep the runtime/transcript panes and Claude-orange classes unchanged.
   - _Requirements: 2.1, 2.2, 2.4, 2.5_

2. Normalize capabilities in `ui-store.mjs` and `runtime-sync.mjs`.
   - Default a missing capability object to enabled for legacy `hod ui`.
   - Treat explicit false as disabled and avoid settings API refreshes in
     runtime-only mode; an observer `404 ERR_ROUTE` is not a settings failure.
   - Keep reconnect generations from restoring stale settings or transcript
     writes and retain the selected transcript only as display state.
   - _Requirements: 2.1, 2.2, 2.5_

3. Extend the existing global view model and dashboard.
   - Aggregate every returned space/workspace and agent across the snapshot.
   - Calculate totals for spaces, agents, `working`, `blocked`, `idle`, and
     `done`; keep per-space selection available for browsing without changing
     the all-space totals.
   - Render the counts through `dashboard-view.mjs` using the existing safe DOM
     helpers and Claude-orange terminal presentation.
   - _Requirements: 1.5, 2.4_

4. Preserve transcript and security behavior.
   - Keep selected transcript selection/display read-only and compatible with
     the R0 API response.
   - Do not add client-side settings writes, control buttons, command handlers,
     or an observer-specific Host/Origin bypass.
   - _Requirements: 2.3, 2.5_

5. Update the owned frontend tests.
   - Cover capability false hiding Settings, legacy missing-capability defaults,
     no settings refresh in runtime-only mode, selected-transcript retention,
     all-space totals, all four agent states, and safe Claude-orange rendering.
   - Keep tests under the existing line limit; use only the focused create
     allowance if existing test modules cannot remain below 200 lines.
   - _Requirements: 1.5, 2.1, 2.2, 2.3, 2.4, 2.5_

6. Update the named user documentation.
   - Document `hod start --port`/`--no-open`, rejection of `--project`, the
     unchanged `hod ui` path, runtime-only data, read-only transcript,
     capability-disabled settings, and all-space counts.
   - Keep English/Vietnamese and usage/getting-started/quickstart/troubleshooting
     guidance consistent.
   - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

## Requirements

- 1.5 — Every global refresh exposes all discovered workspaces, tabs, panes,
  agents, and the selected transcript.
- 2.1 — `hod ui` and `hod ui --project` retain backward-compatible behavior.
- 2.2 — Settings are hidden when disabled; observer settings routes do not
  cause settings I/O.
- 2.3 — Existing Session Host/Origin checks remain enforced without bypass.
- 2.4 — Claude-orange output shows all-space spaces, agents, and counts for
  `working`, `blocked`, `idle`, and `done`.
- 2.5 — Transcript is display-only and observer control, mutation, update,
  daemon, and global-settings capabilities remain absent.

## Related Files

| Path | Action | Description |
|---|---|---|
| `ui/public/index.html` | Modify | Capability-gated Settings navigation/pane markers. |
| `ui/public/modules/console-view.mjs` | Modify | Hide/deny Settings when the capability is false. |
| `ui/public/modules/dashboard-view.mjs` | Modify | Render all-space counts and preserve space browsing. |
| `ui/public/modules/ui-store.mjs` | Modify | Capability defaults and read-only observer state. |
| `ui/public/modules/view-models.mjs` | Modify | Global space/agent aggregation and six required counts. |
| `ui/public/modules/runtime-sync.mjs` | Modify | Capability-aware refresh/reconnect behavior. |
| `ui/test/frontend-render-security.test.mjs` | Modify | Safe capability-gated markup/rendering checks. |
| `ui/test/runtime-sync.test.mjs` | Modify | Disabled settings refresh and legacy default coverage. |
| `ui/test/ui-store.test.mjs` | Modify | Capability normalization and transcript state coverage. |
| `ui/test/view-models.test.mjs` | Modify | All-space totals and four agent-state counts. |
| `README.md` | Modify | English command and capability documentation. |
| `README.vi.md` | Modify | Vietnamese command and capability documentation. |
| `docs/usage-guide.md` | Modify | Detailed global observer behavior and boundaries. |
| `docs/getting-started.md` | Modify | `hod start` onboarding path. |
| `docs/quickstart.md` | Modify | Concise runtime-only quickstart. |
| `docs/troubleshooting.md` | Modify | Runtime-only option, route, and reconnect diagnostics. |

## Completion Criteria

- [x] Settings is hidden and unreachable in runtime-only mode while legacy
  missing-capability state keeps `hod ui` compatible.
- [x] Global dashboard shows spaces, agents, and `working`, `blocked`, `idle`,
  and `done` counts across all spaces.
- [x] Every returned workspace/tab/pane/agent remains represented and a
  selected transcript remains visible as read-only display data.
- [x] Claude-orange terminal presentation and existing Host/Origin behavior
  remain intact.
- [x] No runtime-only frontend path calls settings endpoints or exposes
  control/mutation actions.
- [x] Named documentation is consistent and all requested validators pass.

## Evidence

Verification: PASS — 2026-08-12 02:12 +07:00; R1 evidence synchronized to the latest repository gates.

- [x] Automated verification
  - Command(s):
    `node --test ui/test/view-models.test.mjs ui/test/frontend-render-security.test.mjs` (R1);
    `node --test ui/test/runtime-sync.test.mjs ui/test/ui-store.test.mjs ui/test/view-models.test.mjs ui/test/frontend-render-security.test.mjs` (full R1 regression);
    `node --test ui/test/server-entrypoint.test.mjs ui/test/runtime-options.test.mjs ui/test/runtime-client-connections.test.mjs ui/test/global-observer-runtime.test.mjs ui/test/global-observer-api-controller.test.mjs` (R0);
    `npm --prefix ui run check`; `./scripts/test-hod.sh`;
    `./scripts/validate.sh`; `git diff --check`; `node --check ui/public/modules/view-models.mjs && node --check ui/public/modules/dashboard-view.mjs && node --check ui/test/view-models.test.mjs && node --check ui/test/frontend-render-security.test.mjs`.
  - Results: focused R1 tab suite 14 passed, 0 failed; independently verified
    full R1 regression 26 passed, 0 failed; focused R0 suite 25 passed, 0
    failed; UI check exit 0; `test-hod.sh` 150 passed, 0 failed;
    `validate.sh`, `git diff --check`, and all four syntax checks exit 0.
    Line check PASS; `spec-ground` PASS with 23 paths; `validate-spec-output`
    PASS.
- [x] Artifact / runtime verification
  - Inspect: the owned view-model, dashboard, and frontend security/test paths.
  - Result: top-level `tabs` are normalized and selected-space filtering remains
    available; the dashboard renders every tab ID/label through safe text nodes,
    including the zero-agent tab, while all-space totals and per-space agent
    browsing remain intact. Existing Claude-orange classes were reused; no CSS,
    tab mutation, or control action was added. Line counts: `view-models.mjs`
    174, `dashboard-view.mjs` 167, `view-models.test.mjs` 99,
    `frontend-render-security.test.mjs` 147; all are below 200.
- [ ] Runtime reachability verification
  - Entrypoint/caller: `hod start` → R0 runtime → existing browser UI.
  - Result: `test-hod.sh` proves the R0 launcher reaches runtime-only mode from
    two unrelated cwd fixtures; live browser/Herdr socket E2E was not run, so
    no live reachability or Host/Origin claim is made here. Sandbox loopback
    binding remains an environment-gated EPERM concern.
- [x] Contract / negative-path verification
  - Check: settings UI/API, transcript writes, agent/lifecycle controls,
    auto-install/update, LAN/daemon behavior, and missing/mismatched Host or
    Origin.
  - Result: explicit false hides/blocks Settings and skips settings refresh;
    missing/partial capabilities default true; legacy settings 404 fails
    refresh; no new control/mutation action or server/security path was added.

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Global aggregation accidentally filters by selected space or current directory. | High | Use multi-space fixtures and assert every identifier plus six all-space totals. |
| Missing capability defaults break legacy `hod ui`. | High | Test absent, true, and explicit false capability shapes separately. |
| Disabled settings still trigger parallel refresh or stale UI navigation. | High | Gate settings fetch/render/navigation and assert zero settings calls. |
| UI count additions regress the existing terminal presentation or security. | Medium | Keep DOM helpers/Host/Origin server unchanged and run frontend/security checks. |
