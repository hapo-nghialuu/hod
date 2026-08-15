# Policy: <project-slug>

<!-- Copy this file to ~/.herdr-orc/projects/<project-slug>/policy.md and
     edit it yourself. A policy file is a user-authored authority grant:
     agents must never create, edit, or reinterpret one. An unedited
     template grants nothing beyond what you deliberately keep in it. -->

Scope: <absolute project path>

Allowed without asking:
- Edit source and test files inside this repository.
- Run the repository's build, lint, and test commands: <fill in exact commands>
- Create task worktrees and panes.

Always ask first:
- Committing, pushing, publishing, tagging, or deploying.
- Editing package manifests, lockfiles, migrations, or CI configuration.
- Deleting files, changing tool configuration, or any credential use.

Notes:
- <project-specific conventions, milestones, or constraints>
