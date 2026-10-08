# XunJie-StudentIDE repository instructions

## Scope

This repository contains the standalone XunJie-StudentIDE Codex plugin, version 0.6.0: a local Monaco editor, Node service, stdio MCP, hooks, process journal and static diagnostics. The internal plugin/MCP/Skill identifiers remain `student-ide` for compatibility. It does not contain the broader teaching product, student answers or research evidence.

## Working rules

- Preserve the existing architecture and module boundaries. Read the affected callers, tests, plugin manifests and build entry points before changing them.
- Update the relevant contract documentation before changing behavior. Propose major changes and obtain user agreement before implementation.
- Run `npm test` for meaningful runtime changes; validate links for documentation changes. Do not bypass failing checks.
- Keep raw events separate from inference. Do not rewrite historical records to improve attribution or completeness claims.
- Source builds and runtime packages are different: dependencies and generated files are local; release packages select only current build manifests.

## Agent and student boundary

- In student operation, the agent only reads `get_editor_snapshot`, `get_coding_events`, `replay_document` and `get_language_capabilities`. Editing, saving, running, file operations, UI control and capture settings belong to the student.
- MCP never starts the service. Startup, toolchain installation, registration and verification require authorized preparation. If a student session is blocked, report it and wait for the student/teacher to switch back to preparation.
- IDE static diagnostics may run in response to student edits; they do not execute the student's answer. The agent must not call diagnostic/write HTTP endpoints or use shell/browser access to bypass the boundary.
- Interface labels and origin channels are not authenticated actor identities. Host shell, filesystem and browser access are not fully isolated.
- Development verification uses isolated fixtures, never a real student's project.

## Permission and data rules

Explain the reason and risks and obtain user agreement before deleting files/directories/Git history; changing `.env`, secrets, tokens or CI/CD; changing database schemas or migrating data; or publishing publicly. Ordinary private repository preparation does not authorize public release.

Do not commit student projects, journals, outboxes, screenshots with student data, local machine paths or credentials. Keep `.student-ide/`, development dependencies, generated bundles and local verification output excluded. New demo files in `lab/` are public fixtures, not collected student work.

## Project entry points

- [README](README.md): setup, features and limitations.
- [Architecture](docs/ARCHITECTURE.md): service/editor/MCP responsibilities.
- [Language contract](docs/LANGUAGE_CONTRACT.md): toolchains and diagnostic adapters.
- [Data and security](docs/DATA_AND_SECURITY.md): event model, privacy and attribution.
- [Development](docs/DEVELOPMENT.md): build, tests and distributable packages.
- [Verification](docs/VERIFICATION.md): what has actually been checked.
