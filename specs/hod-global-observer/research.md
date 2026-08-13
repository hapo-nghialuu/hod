# Research Evidence and Decisions

## Evidence Summary

The existing draft paths were inspected only to replace their incomplete templates:

| Current draft path | Evidence in the draft | Decision |
|---|---|---|
| `specs/hod-global-observer/requirements.md` | Placeholder R1/R2 groups and acceptance-criteria IDs | Replace with two measurable requirement groups only. |
| `specs/hod-global-observer/research.md` | Generic research-template sections | Keep evidence concise and contract-based. |
| `specs/hod-global-observer/design.md` | Generic architecture, contract, scope, and test sections | Define the two named contracts and the required boundaries. |

No memory, repository instructions, or source outside these three draft paths was used. The supplied contract is the complete feature evidence: `hod start` is a foreground loopback runtime observer; Herdr 0.8 uses one-request-per-connection snapshots; `hod ui` and `hod ui --project` remain compatible; Session Host Origin security and the Claude-orange terminal UI remain unchanged.

### 2026-08-12 user-approved scope expansion

The user subsequently approved Settings inside the global UI and explicitly
accepted selecting a project/space before configuration. Source-grounded
inspection found these reusable boundaries:

| Source | Evidence | Decision |
|---|---|---|
| `ui/server/settings/settings-controller.mjs` | Existing role/key validation, public response filtering, confirmations, and serialized mutations | Reuse; do not create a second settings contract. |
| `ui/server/settings/herdr-config-settings.mjs` | Typed allowlist, TOML scalar patching, snapshot-checked atomic write, backup/reload behavior | Keep authoritative for global Herdr mutations. |
| `ui/server/settings/hod-role-settings.mjs` | Three documented roles, canonical directories, force/confirmation checks, bounded command execution, and postcondition inspection | Keep authoritative for selected-project role installation. |
| `ui/server/global-settings.mjs` | Fresh `session.snapshot`, opaque workspace ID, deterministic target precedence, canonicalization, path redaction, and fail-closed ambiguity | Use as the isolation boundary between browser selection and filesystem I/O. |
| `ui/server/global-observer-api-controller.mjs` | Settings capability enabled, agent control disabled, path-like fields rejected | Preserve split capabilities: Settings mutation is not agent control. |

No external research was needed: the expansion composes existing local
settings services and Herdr runtime metadata; it adds no third-party API or
standard.

## Selected Decisions

- Keep runtime observation and transcript display read-only; add a separate,
  explicitly selected Settings lane rather than treating the launch directory
  as a project.
- Derive all displayed data from live Herdr runtime snapshots and retain the one-request-per-connection protocol.
- Express Settings and agent-control permissions as independent capabilities:
  `settings=true`, `mutation=true`, `control=false`.
- Keep legacy UI entrypoints and the existing terminal presentation unchanged.

## Rejected Alternatives

- Launch-directory or browser-path project discovery: rejected because it
  violates directory independence and permits target injection. Server-side
  resolution from a fresh selected workspace snapshot is accepted.
- Daemon or LAN service: rejected because lifecycle ownership and network exposure are out of scope.
- Event subscription or agent commands: rejected because they conflict with the Herdr 0.8 snapshot contract or observer-only behavior.

## Open Questions

None for the contract. Implementation-specific source paths and live-environment verification belong to implementation and test work.
