# Research Evidence and Decisions

## Evidence Summary

The existing draft paths were inspected only to replace their incomplete templates:

| Current draft path | Evidence in the draft | Decision |
|---|---|---|
| `specs/hod-global-observer/requirements.md` | Placeholder R1/R2 groups and acceptance-criteria IDs | Replace with two measurable requirement groups only. |
| `specs/hod-global-observer/research.md` | Generic research-template sections | Keep evidence concise and contract-based. |
| `specs/hod-global-observer/design.md` | Generic architecture, contract, scope, and test sections | Define the two named contracts and the required boundaries. |

No memory, repository instructions, or source outside these three draft paths was used. The supplied contract is the complete feature evidence: `hod start` is a foreground loopback runtime observer; Herdr 0.8 uses one-request-per-connection snapshots; `hod ui` and `hod ui --project` remain compatible; Session Host Origin security and the Claude-orange terminal UI remain unchanged.

## Selected Decisions

- Treat `hod start` as a read-only global runtime mode, not a project mode or daemon.
- Derive all displayed data from live Herdr runtime snapshots and retain the one-request-per-connection protocol.
- Express settings visibility and action permissions as explicit disabled capabilities.
- Keep legacy UI entrypoints and the existing terminal presentation unchanged.

## Rejected Alternatives

- Project/config discovery: rejected because it violates directory independence and runtime-only access.
- Daemon or LAN service: rejected because lifecycle ownership and network exposure are out of scope.
- Event subscription or agent commands: rejected because they conflict with the Herdr 0.8 snapshot contract or observer-only behavior.

## Open Questions

None for the contract. Implementation-specific source paths and live-environment verification belong to implementation and test work.
