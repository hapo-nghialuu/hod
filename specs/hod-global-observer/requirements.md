# Requirements: HOD Global Observer

## Introduction

Add `hod start`, a foreground loopback observer for runtime Herdr state across all workspaces, while preserving the existing project UI and security boundaries.

## Requirements

### Requirement 1: Global observer runtime

**Objective:** Provide a directory-independent, read-only view of live Herdr runtime state without project or settings access.

#### Acceptance Criteria

- **R1.1** From any current working directory, running `hod start` shall start the observer without a project argument and without resolving the current directory as a project.
- **R1.2** `hod start` shall remain a foreground, loopback-only process; it shall create no daemon PID, expose no LAN listener, and perform no Herdr lifecycle or agent-control action.
- **R1.3** The observer shall use runtime state only and shall perform zero project/config path resolutions and zero project/config reads or writes.
- **R1.4** Every Herdr 0.8 refresh shall use a fresh connection for exactly one snapshot request and shall not call `events.subscribe` during bootstrap.
- **R1.5** A global refresh shall expose every discovered Herdr workspace, tab, pane, agent, and the selected transcript, independent of the command's working directory.

### Requirement 2: UI, compatibility, and capability boundaries

**Objective:** Preserve the established UI and session security while making the new observer globally informative and non-mutating.

#### Acceptance Criteria

- **R2.1** Existing `hod ui` behavior shall remain backward compatible, and `hod ui --project` shall remain backward compatible for project-scoped use.
- **R2.2** The observer shall hide the settings UI and disable settings APIs; settings requests shall not read or write global settings.
- **R2.3** UI requests shall continue to enforce the existing session Host Origin security checks with no observer-specific bypass.
- **R2.4** The existing Claude-orange terminal UI shall remain intact and shall show all-space counts for spaces, agents, and agent states `working`, `blocked`, `idle`, and `done`.
- **R2.5** The selected transcript shall be display-only; the observer shall expose no agent-control, auto-install/update, daemon, or global-settings capability.
