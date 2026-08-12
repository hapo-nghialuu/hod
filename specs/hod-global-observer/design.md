# Design: HOD Global Observer

## Overview

`hod start` adds a global, read-only observer for live Herdr workspaces, tabs,
panes, agents, and a selected transcript. It runs in the foreground over the
existing loopback HTTP/session boundary and does not treat the caller's
directory as a project.

The repository is a Bash launcher plus a zero-dependency Node.js 20 `.mjs`
console; it has no TypeScript command tree. The existing `hod ui`
entrypoint, `hod ui --project` compatibility, Session Host/Origin checks, and
Claude-orange terminal presentation remain unchanged.

## Entrypoint and option contract

- Public `hod start` accepts `--port <0-65535>` and `--no-open`.
- Public `hod start --project <path>` is rejected as a usage error.
- The internal server selector is `--runtime-only`.
- Public `hod ui` keeps its current `--project`, `--port`, and `--no-open`
  behavior; it does not become runtime-only.
- The production chain is exactly:
  `hod start -> bin/hod -> ui/server.mjs --runtime-only -> ui/server/global-observer-runtime.mjs`.

## Scope

- Start a foreground observer from any directory.
- Read live Herdr snapshots for every discovered workspace, tab, pane, and
  agent, independent of the current directory.
- Show a selected transcript as display-only data.
- Show all-space counts for spaces, agents, `working`, `blocked`, `idle`, and
  `done`.
- Preserve the existing loopback/session/Host/Origin HTTP server and terminal
  presentation.

## Out of Scope

- Project/config path resolution or project/config reads and writes in the
  runtime-only path.
- Settings UI, settings APIs that perform I/O, or global settings access.
- Agent control, transcript writes, Herdr lifecycle control, daemon PIDs,
  background services, LAN exposure, auto-install, or auto-update.
- A second snapshot client or an `events.subscribe` bootstrap connection.

## Architecture

1. `bin/hod` adds the public `start` dispatch. It validates the public option
   surface, rejects `--project`, and forwards the internal `--runtime-only`
   selector to the existing Node entrypoint.
2. `ui/server.mjs` selects the runtime-only composition when that selector is
   present. It reuses the existing loopback HTTP server, `SessionAuth`, and
   static/session Host/Origin security boundary; it does not resolve a
   project/config path for this mode.
3. `ui/server/global-observer-runtime.mjs` composes the existing `RuntimeEvents`
   coordinator and its `RuntimeClientConnections` one-shot manager. Each
   Herdr 0.8 refresh uses one fresh connection and one `session.snapshot`
   request, then closes it. No new snapshot client is introduced.
4. `ui/server/global-observer-api-controller.mjs` exposes runtime state,
   explicit observer capabilities, and read-only transcript selection. It does
   not construct or call a settings service. Observer settings routes return
   the existing route error: HTTP 404 with error code `ERR_ROUTE`.
5. The R1 frontend consumes the explicit capabilities, aggregates all spaces
   and agents, keeps selected transcript state read-only, and reuses the
   existing Claude-orange renderer.

The existing `ui/server/application-paths.mjs`,
`ui/server/live-console-runtime.mjs`, `ui/server/api-controller.mjs`, and
`ui/server/runtime-events.mjs` remain unchanged for this spec. They are not
replaced by observer-specific copies; later evidence may request a scope
correction if an implementation constraint proves otherwise.

## Named Contracts

### GLOBAL_OBSERVER_MODE

<!-- contract:GLOBAL_OBSERVER_MODE -->
```json
{
  "entrypoint": "hod start",
  "publicOptions": ["--port", "--no-open"],
  "projectOption": "rejected",
  "internalSelector": "--runtime-only",
  "legacyEntrypoint": "hod ui unchanged",
  "workingDirectory": "ignored",
  "process": "foreground",
  "network": "loopback-only",
  "data": "runtime-only",
  "projectConfigPathResolution": false,
  "projectConfigReadWrite": false,
  "snapshot": "one-request-per-connection",
  "eventsSubscribeAtBootstrap": false,
  "daemonPid": false,
  "herdrLifecycleControl": false
}
```

### UI_CAPABILITIES

<!-- contract:UI_CAPABILITIES -->
```json
{
  "scope": "all Herdr workspaces/tabs/panes/agents",
  "capabilities": {
    "settings": false,
    "control": false,
    "mutation": false
  },
  "settingsUi": false,
  "settingsApi": false,
  "agentControl": false,
  "settingsRoute": {
    "status": 404,
    "code": "ERR_ROUTE",
    "settingsIo": false
  },
  "selectedTranscript": "read-only",
  "counts": ["spaces", "agents", "working", "blocked", "idle", "done"],
  "autoInstallUpdate": false,
  "terminalTheme": "Claude-orange",
  "sessionHostOriginSecurity": "preserved",
  "legacyEntrypoints": ["hod ui", "hod ui --project"]
}
```

## Capability and API semantics

- Runtime-only state carries `capabilities.settings = false`,
  `capabilities.control = false`, and `capabilities.mutation = false`.
- The frontend treats an absent capability as `true` for legacy `hod ui`
  compatibility. An explicit `false` is authoritative and hides/denies that
  surface.
- `GET /api/settings`, `POST /api/settings/hod`, and
  `POST /api/settings/herdr` in observer mode return HTTP 404 `ERR_ROUTE` and
  perform no settings I/O.
- Transcript selection is a read-only display operation. No transcript write,
  agent command, control, or lifecycle handler is exposed.
- Missing, stale, or failed runtime snapshots become unavailable/reconnecting
  display state; they never fall back to project/config reads.

## File ownership

R0 owns the runtime entrypoint and server boundary:

| Action | Path |
|---|---|
| Modify | `bin/hod` |
| Modify | `ui/server.mjs` |
| Modify | `ui/server/runtime-options.mjs` |
| Modify | `scripts/test-hod.sh` |
| Modify | `ui/test/server-entrypoint.test.mjs` |
| Modify | `ui/test/runtime-options.test.mjs` |
| Modify | `ui/test/runtime-client-connections.test.mjs` |
| Create | `ui/server/global-observer-runtime.mjs` |
| Create | `ui/server/global-observer-api-controller.mjs` |
| Create | `ui/test/global-observer-runtime.test.mjs` |
| Create | `ui/test/global-observer-api-controller.test.mjs` |

R1 owns the capability-aware frontend and user documentation:

| Action | Path |
|---|---|
| Modify | `ui/public/index.html` |
| Modify | `ui/public/modules/console-view.mjs` |
| Modify | `ui/public/modules/dashboard-view.mjs` |
| Modify | `ui/public/modules/ui-store.mjs` |
| Modify | `ui/public/modules/view-models.mjs` |
| Modify | `ui/public/modules/runtime-sync.mjs` |
| Modify | `ui/test/frontend-render-security.test.mjs` |
| Modify | `ui/test/runtime-sync.test.mjs` |
| Modify | `ui/test/ui-store.test.mjs` |
| Modify | `ui/test/view-models.test.mjs` |
| Modify | `README.md` |
| Modify | `README.vi.md` |
| Modify | `docs/usage-guide.md` |
| Modify | `docs/getting-started.md` |
| Modify | `docs/quickstart.md` |
| Modify | `docs/troubleshooting.md` |

R1 may create only one focused frontend module or test if that is required to
keep the existing 200-line source/test limit. No such creation is required by
the current plan. No implementation, documentation, or test path outside the
tables above is in scope.

## Test and evidence strategy

- **R0 targeted Node tests:**
  `node --test ui/test/server-entrypoint.test.mjs ui/test/runtime-options.test.mjs ui/test/runtime-client-connections.test.mjs ui/test/global-observer-runtime.test.mjs ui/test/global-observer-api-controller.test.mjs`
- **R1 targeted Node tests:**
  `node --test ui/test/runtime-sync.test.mjs ui/test/ui-store.test.mjs ui/test/view-models.test.mjs ui/test/frontend-render-security.test.mjs`
- **Repository evidence:** `npm --prefix ui run check`,
  `./scripts/test-hod.sh`, `./scripts/validate.sh`, and `git diff --check`.
- **Spec gates from `/Users/nghialuutrung/Desktop/ngeax`:**
  `node .codex/scripts/validate-spec-output.cjs /Users/nghialuutrung/.herdr/worktrees/ngeax/feat-hod-ui-console/specs/hod-global-observer`
  and
  `node .codex/scripts/spec-ground.cjs /Users/nghialuutrung/.herdr/worktrees/ngeax/feat-hod-ui-console/specs/hod-global-observer --root /Users/nghialuutrung/.herdr/worktrees/ngeax/feat-hod-ui-console`.
- **Negative/security:** prove `--project` rejection for `hod start`, no
  project/config access, no settings I/O, 404 `ERR_ROUTE` settings routes,
  no `events.subscribe` bootstrap, one request per fresh connection, exact
  loopback binding, and existing Host/Origin rejection behavior.

## Requirements Traceability

| Requirement | Design coverage |
|---|---|
| R1.1-R1.4 | Entrypoint/option contract, `GLOBAL_OBSERVER_MODE`, R0 runtime and snapshot flow |
| R1.5 | R1 global aggregation and all-space view model |
| R2.1-R2.3 | Legacy entrypoints, reused HTTP/session/Host/Origin boundary, capability defaults |
| R2.4 | `UI_CAPABILITIES`, all-space counts, and Claude-orange frontend preservation |
| R2.5 | Read-only transcript, disabled capabilities, and 404 `ERR_ROUTE` settings behavior |
