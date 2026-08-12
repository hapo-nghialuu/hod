# Task R0-01: Runtime-only entrypoint and boundaries

**Requirement:** R1.1-R1.4 and R2.2 — global observer runtime boundary
**Status:** done
**Priority:** P0
**Estimated Effort:** 1–2 implementation days
**Dependencies:** none
**Spec:** specs/hod-global-observer/

## Context

- **Repository fact:** the production path is `bin/hod` Bash plus a
  zero-dependency Node.js 20 `.mjs` UI; there is no TypeScript command tree.
- **Why:** `hod start` must work from any directory while remaining a
  foreground, read-only, loopback-only observer.
- **Target outcome:** the real chain is
  `hod start -> bin/hod -> ui/server.mjs --runtime-only -> ui/server/global-observer-runtime.mjs`.

## Constraints

- **MUST:** Public `hod start` accepts `--port` and `--no-open`, rejects
  `--project`, and leaves `hod ui` plus `hod ui --project` unchanged.
- **MUST:** Use the internal `--runtime-only` server selector and compose the
  existing `RuntimeEvents` and `RuntimeClientConnections` one-shot machinery.
  Do not create another snapshot client.
- **MUST:** Reuse the existing loopback HTTP server, `SessionAuth`, static
  serving, and Host/Origin request policy.
- **MUST:** Runtime-only state includes capabilities settings=false,
  control=false, and mutation=false. Settings endpoints return HTTP 404
  `ERR_ROUTE` without settings I/O; selected transcript is read-only.
- **MUST NOT:** Resolve/read/write project or config paths, call
  `events.subscribe` at bootstrap, create a daemon PID, bind LAN, control
  agents, or control the Herdr lifecycle.
- **MUST NOT:** Modify `ui/server/application-paths.mjs`,
  `ui/server/live-console-runtime.mjs`, `ui/server/api-controller.mjs`, or
  `ui/server/runtime-events.mjs` unless later implementation evidence requires
  a separately recorded scope correction.
- **SCOPE:** Modify/create only the paths listed in Related Files. Leave global
  frontend aggregation to R1-01.

## Steps

1. Add the real `hod start` dispatch in `bin/hod`.
   - Forward `--port` and `--no-open` and append the internal
     `--runtime-only` selector when invoking `ui/server.mjs`.
   - Reject `--project` and unknown/duplicate options with the established
     usage path.
   - Preserve exact `hod ui` argv forwarding and behavior.
   - _Requirements: 1.1, 2.1_

2. Extend `ui/server/runtime-options.mjs` with a runtime-only mode.
   - Keep the existing project parser for `hod ui`.
   - In runtime-only mode accept only `--runtime-only`, `--port`, `--no-open`,
     and the existing internal launcher value as applicable.
   - Reject `--project` in runtime-only mode and return a stable usage error.
   - _Requirements: 1.1, 2.1_

3. Select the runtime-only composition in `ui/server.mjs`.
   - Route `--runtime-only` to `global-observer-runtime.mjs` and its API
     controller without calling project/config resolution or `LiveConsoleRuntime`.
   - Keep the existing loopback/session/Host/Origin HTTP server and browser
     launch lifecycle.
   - Keep Herdr startup failure nonfatal and the process foreground.
   - _Requirements: 1.1, 1.2, 1.3, 2.3_

4. Create `ui/server/global-observer-runtime.mjs`.
   - Compose/inject `RuntimeEvents`; rely on its existing
     `RuntimeClientConnections` for fresh one-request snapshot polling.
   - Expose runtime state and explicit observer capabilities without a second
     socket/snapshot client or event subscription.
   - Keep transcript selection display-only and stop/close all owned runtime
     resources cleanly.
   - _Requirements: 1.3, 1.4, 2.5_

5. Create `ui/server/global-observer-api-controller.mjs`.
   - Serve runtime state and read-only transcript selection.
   - Return `{ status: 404, body: { error: { code: 'ERR_ROUTE' } } }` for
     observer settings routes, without constructing, reading, or writing a
     settings controller.
   - Expose `capabilities: { settings: false, control: false, mutation: false }`.
   - _Requirements: 1.5, 2.2, 2.5_

6. Update the owned R0 tests and Bash harness.
   - Prove public option forwarding/rejection and legacy `hod ui` compatibility.
   - Prove runtime mode bypasses project/config access and uses the production
     entrypoint.
   - Prove one fresh client/connection and one `session.snapshot` request per
     refresh, with no `events.subscribe`.
   - Prove settings routes are 404 `ERR_ROUTE` with no settings I/O and the
     selected transcript response is sanitized/read-only.
   - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3_

## Requirements

- 1.1 — `hod start` runs from any current working directory, accepts only its
  public runtime options, and rejects `--project`.
- 1.2 — The observer is foreground and loopback-only with no daemon, LAN,
  lifecycle, or agent-control behavior.
- 1.3 — Runtime-only operation performs no project/config path resolution or
  reads/writes and uses runtime state only.
- 1.4 — Herdr 0.8 refreshes use one request per fresh connection with no
  bootstrap subscription.
- 2.1 — `hod ui` and `hod ui --project` remain backward compatible.
- 2.2 — Settings UI/API capability is disabled; settings routes return 404
  `ERR_ROUTE` without settings I/O.
- 2.3 — The existing loopback/session/Host/Origin security boundary remains in
  use.
- 2.5 — Observer state and transcript selection expose no mutation/control.

## Related Files

| Path | Action | Description |
|---|---|---|
| `bin/hod` | Modify | Public `start` dispatch, option forwarding, and `--project` rejection. |
| `ui/server.mjs` | Modify | Internal `--runtime-only` composition selection. |
| `ui/server/runtime-options.mjs` | Modify | Runtime-only option parsing while preserving `hod ui`. |
| `scripts/test-hod.sh` | Modify | Hermetic Bash launcher coverage for `hod start`. |
| `ui/test/server-entrypoint.test.mjs` | Modify | Production entrypoint composition and lifecycle coverage. |
| `ui/test/runtime-options.test.mjs` | Modify | Public/internal option contract coverage. |
| `ui/test/runtime-client-connections.test.mjs` | Modify | One-shot reuse and no-subscription coverage. |
| `ui/server/global-observer-runtime.mjs` | Create | Runtime-only composition over `RuntimeEvents`. |
| `ui/server/global-observer-api-controller.mjs` | Create | Read-only state/transcript API and disabled settings routes. |
| `ui/test/global-observer-runtime.test.mjs` | Create | Runtime composition, capabilities, and no-project-I/O tests. |
| `ui/test/global-observer-api-controller.test.mjs` | Create | API status, `ERR_ROUTE`, no-settings-I/O, and read-only tests. |

## Completion Criteria

- [x] `hod start --port <port> --no-open` reaches the real runtime-only server
  from unrelated working directories.
- [x] `hod start --project <path>` is rejected; `hod ui` and
  `hod ui --project` retain their current argv and behavior.
- [x] Public `hod ui --runtime-only` rejects with usage exit 2 while the
  private `hod start` launcher still appends the internal selector.
- [x] The process is foreground and loopback-only, with no project/config I/O,
  LAN, daemon, lifecycle, or agent-control path.
- [x] Runtime polling reuses `RuntimeEvents` and `RuntimeClientConnections`;
  each refresh has exactly one fresh connection and one snapshot request.
- [x] Settings routes return 404 `ERR_ROUTE` without settings I/O, and state
  advertises settings/control/mutation as false.
- [x] Selected transcript output is read-only and the existing Host/Origin
  checks are still enforced by the shared HTTP server.

## Evidence

Verification: PASS — 2026-08-12 02:12 +07:00; R0 evidence synchronized to the latest repository gates.

- [x] Automated verification
  - Focused Node command: `node --test ui/test/server-entrypoint.test.mjs ui/test/runtime-options.test.mjs ui/test/runtime-client-connections.test.mjs ui/test/global-observer-runtime.test.mjs ui/test/global-observer-api-controller.test.mjs`: 25 passed, 0 failed, exit 0.
  - `bash -n bin/hod scripts/test-hod.sh` and `node --check` on `ui/server.mjs`, `ui/server/runtime-options.mjs`, `ui/server/global-observer-runtime.mjs`, `ui/test/runtime-options.test.mjs`, `ui/test/server-entrypoint.test.mjs`, `ui/test/global-observer-runtime.test.mjs`, `ui/test/global-observer-api-controller.test.mjs`: exit 0.
  - `npm --prefix ui run check`: exit 0.
  - `./scripts/test-hod.sh`: 150 passed, 0 failed, exit 0.
  - `./scripts/validate.sh`: exit 0.
  - `git diff --check`: exit 0.
  - Line check: PASS.
  - `spec-ground`: PASS with 23 paths; `validate-spec-output`: PASS.
  - Proof covers the public/internal launcher boundary, `--project` rejection, runtime-only resolver bypass, exact one-shot snapshot calls, settings denial, capabilities, transcript sanitization, and legacy `hod ui` forwarding.
- [x] Artifact / runtime verification
  - Inspected `bin/hod`, `ui/server.mjs`, `ui/server/runtime-options.mjs`, and both observer modules; all new/modified JS modules remain under roughly 200 lines.
  - Production chain is wired as `hod start` → `bin/hod` → `ui/server.mjs --runtime-only` → `ui/server/global-observer-runtime.mjs`, with no second snapshot client or `events.subscribe` bootstrap.
  - Default observer composition test constructs the default `RuntimeEvents`, transcript watcher, and SSE hub with deterministic timers; it proves one `session.snapshot`, no `events.subscribe`, no settings service fields, and successful cleanup.
  - Stop regression covers synchronous and asynchronous hub-close failures during pre-start and started cleanup; both stops settle, `_stopPromise` resets to `null`, and restart succeeds.
- [x] Runtime reachability verification
  - Fake-Node production launcher checks reached the runtime-only selector from two unrelated cwd fixtures and preserved foreground `exec` behavior; exit 0.
  - Fresh direct bind probe command: `node --input-type=module -e "import { createServer } from 'node:http'; const server = createServer(); server.once('error', (error) => { console.log('bind-error:', error.code, error.message); process.exitCode = 1; }); server.listen(0, '127.0.0.1', () => { const address = server.address(); console.log('bind-ok:', address.address, address.port); server.close(() => process.exit(0)); });"` → exit 1, `bind-error: EPERM listen EPERM: operation not permitted 127.0.0.1`.
  - Live HTTP/Herdr socket E2E is therefore environment-gated and not claimed; local deterministic fixtures are the passed evidence.
- [x] Contract / negative-path verification
  - `--project` is rejected in Bash before Node/project validation; runtime-only parsing rejects it before `statSync`.
  - Runtime-only server tests use throwing project/config resolver and legacy-runtime tripwires; no protected settings/project construction or I/O can pass silently.
  - Settings API tests use throwing protected-option getters and a throwing runtime-store proxy; settings routes return 404 `ERR_ROUTE` without touching either.
  - Shared HTTP construction receives `127.0.0.1`; settings routes return 404 `ERR_ROUTE` without settings service construction; control/lifecycle routes are absent; no PID or lifecycle path exists; snapshot fixtures record no `events.subscribe`.

### Byte-bound worktree receipt

- `HEAD`: `3691a2cca7829dc0035eccd6fb03e59bee2d6815`.
- Full worktree status/path set captured at this Evidence sync:

  ```text
   M README.md
   M README.vi.md
   M bin/hod
   M docs/getting-started.md
   M docs/quickstart.md
   M docs/troubleshooting.md
   M docs/usage-guide.md
   M scripts/test-hod.sh
   M ui/public/index.html
   M ui/public/modules/console-view.mjs
   M ui/public/modules/dashboard-view.mjs
   M ui/public/modules/runtime-sync.mjs
   M ui/public/modules/ui-store.mjs
   M ui/public/modules/view-models.mjs
   M ui/server.mjs
   M ui/server/runtime-options.mjs
   M ui/test/frontend-render-security.test.mjs
   M ui/test/runtime-options.test.mjs
   M ui/test/server-entrypoint.test.mjs
   M ui/test/runtime-sync.test.mjs
   M ui/test/ui-store.test.mjs
   M ui/test/view-models.test.mjs
  ?? specs/hod-global-observer/design.md
  ?? specs/hod-global-observer/requirements.md
  ?? specs/hod-global-observer/research.md
  ?? specs/hod-global-observer/spec.json
  ?? specs/hod-global-observer/tasks/task-R0-01-runtime-only-entrypoint.md
  ?? specs/hod-global-observer/tasks/task-R1-01-runtime-observer-ui.md
  ?? ui/server/global-observer-api-controller.mjs
  ?? ui/server/global-observer-runtime.mjs
  ?? ui/test/global-observer-api-controller.test.mjs
  ?? ui/test/global-observer-runtime.test.mjs
  ```

- Scoped working-tree SHA-256 bytes (computed with Node `crypto`):

  ```text
  9bed49200be501ec3c7c44155766003d74bf960299be6f9af90d37fe74af3917  bin/hod
  e9e04b1767b892b887afa3125de8c1286e7f03472759fe17ca68e7f165592fb0  scripts/test-hod.sh
  d969e9364d68f85ce5a06e47c7e57f9a993a7995cffa7f7a0462475ff09b0c1b  ui/server.mjs
  ba0b016f1d392c06653cf8bfdf20cbb18c88778d0beedbb238a972025ee54746  ui/server/runtime-options.mjs
  f38dfbaf1e7c33e6645aa6d77885adc5dc80c40e7526ceafe57eca79d2f2823f  ui/server/global-observer-runtime.mjs
  76b6a7d055ef4f7083a7dc4d91761f19310ad8f62eacffdf3ea837538570b9f5  ui/test/runtime-options.test.mjs
  6345b7b74358012c953a7541670bc1619abfacbbccdb9ffe3e371c29da4f5a71  ui/test/server-entrypoint.test.mjs
  8a8bcc17a33b39e109384d818718f48cd5ea32d46dae86f71bf7dfb7e193fa6f  ui/test/global-observer-runtime.test.mjs
  c321e709e35b7214b77b94e49a0ac16ad9488191e71cbb2f35cbaada4a48c9f1  ui/test/global-observer-api-controller.test.mjs
  a275b3427dff1721404f46b1532bdb040d6d4946db597e676f176dea1869e6f0  specs/hod-global-observer/spec.json
  bcbff04f3f5835d6e127c8eaae893507ebc93ac195dd85132fac80050a2b80ea  ui/server/global-observer-api-controller.mjs
  ```

  The API controller is a pre-existing, unmodified R0 dependency; that note is
  intentionally outside the hash field. The task file is intentionally excluded
  from the hash list because it contains this receipt. Recompute every listed
  hash, HEAD, and status/path set with:

  ```sh
  node --input-type=module -e "import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto'; const paths = ['bin/hod','scripts/test-hod.sh','ui/server.mjs','ui/server/runtime-options.mjs','ui/server/global-observer-runtime.mjs','ui/test/runtime-options.test.mjs','ui/test/server-entrypoint.test.mjs','ui/test/global-observer-runtime.test.mjs','ui/test/global-observer-api-controller.test.mjs','specs/hod-global-observer/spec.json','ui/server/global-observer-api-controller.mjs']; for (const path of paths) console.log(createHash('sha256').update(readFileSync(path)).digest('hex') + '  ' + path);"
  git rev-parse --verify HEAD
  git status --porcelain=v1 --untracked-files=all
  ```


Unresolved questions: live loopback/Herdr socket E2E remains environment-gated.

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| The Bash launcher accidentally routes `start` through project UI logic. | High | Assert exact argv and reject `--project` in Bash and Node tests. |
| Runtime-only mode accidentally constructs settings/project services. | High | Inject spies in the new runtime/API tests and keep protected modules out of R0 writes. |
| A reconnect path creates a second snapshot client or subscription. | High | Count clients, connections, requests, closes, and method names per refresh. |
| Shared HTTP security is bypassed by the observer controller. | High | Exercise the real loopback server's Session Host/Origin policy. |
