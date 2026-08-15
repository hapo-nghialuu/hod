# Requirements: HOD Global Observer

## Introduction

Add `hod start`, a foreground loopback observer for runtime Herdr state across all workspaces, with workspace-scoped Settings and preserved session security.

## Requirements

### Requirement 1: Global observer runtime

**Objective:** Provide a directory-independent view of live Herdr runtime state; Settings may target only an explicitly selected live workspace.

#### Acceptance Criteria

- **R1.1** From any current working directory, running `hod start` shall start the observer without a project argument and without resolving the current directory as a project.
- **R1.2** `hod start` shall remain a foreground, loopback-only process; it shall create no daemon PID, expose no LAN listener, and perform no Herdr lifecycle or agent-control action.
- **R1.3** Runtime observation shall perform zero launch-directory project/config resolution or I/O. A Settings request shall resolve only its opaque workspace ID from a fresh authoritative Herdr snapshot, and no project path shall be exposed to the browser.
- **R1.4** Every Herdr 0.8 refresh shall use a fresh connection for exactly one snapshot request and shall not call `events.subscribe` during bootstrap.
- **R1.5** A global refresh shall expose every discovered Herdr workspace, tab, pane, agent, and the selected transcript, independent of the command's working directory.

### Requirement 2: UI, compatibility, and capability boundaries

**Objective:** Preserve the established UI and session security while allowing bounded, confirmed Settings mutations without agent control.

#### Acceptance Criteria

- **R2.1** Existing `hod ui` behavior shall remain backward compatible, and `hod ui --project` shall remain backward compatible for project-scoped use.
- **R2.2** The observer shall expose Settings for a selected live workspace. HOD role writes shall be limited to the documented roles, and global Herdr writes shall be limited to the typed allowlist; every mutation shall require its existing confirmation token.
- **R2.3** UI requests shall continue to enforce the existing session Host Origin security checks with no observer-specific bypass.
- **R2.4** The existing Claude-orange terminal UI shall remain intact and shall show all-space counts for spaces, agents, and agent states `working`, `blocked`, `idle`, and `done`.
- **R2.5** The selected transcript shall be display-only; the observer shall expose no agent-control, auto-install/update, daemon, LAN, or Herdr lifecycle capability.
- **R2.6** Settings target resolution shall fail closed for a missing, stale, ambiguous, invalid, or unsafe workspace. The browser shall send only `workspaceId` and allowlisted setting fields; path-like query/body fields shall be rejected.
