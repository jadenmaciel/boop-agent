# Changelog

## 0.3.0 — 2026-07-17

- [BREAKING] Replaced Convex application services with direct, pinned SQLite and transactional migrations.
- [BREAKING] Removed the admin dashboard, Electron app, Claude fallback, Apple/Mac connectors, embeddings, and generic agent spawning.
- Added exact-owner Sendblue authentication before all side effects, one FIFO queue, durable webhook deduplication, and `STOP` cancellation.
- Added payload- and provenance-bound one-hour confirmation codes, with Tailscale approval for high-risk actions.
- Added typed Personal Vault tools, atomic writes, synced trash/restore, symlink containment, a 25-file bulk fuse, and operational journals.
- Fixed temporary bulk-manifest files to use group-readable 0640 permissions (previously 0600 under umask 077), restoring boop-sync group read access to the delete-manifest.
- Excluded Obsidian and local agent-state roots from every Personal Vault operation.
- Added owner-sourced FTS5 memory, transactional automations, complete transcript retention, and 90-day operational retention.
- Added confirmation-gated Composio writes and OAuth connection flows for Gmail, Calendar, and additional approved toolkits.
- Added `hasExactOAuthScopes()` so `authorizeToolkit()` allows a custom OAuth config when its scopes match the policy exactly, enabling the live Gmail and Google Calendar OAuth connections.
- Added Patchright public-destination enforcement, persistent profiles, and temporary Tailscale-only login handoff.
- Added validated inbound images up to 10 MB with three-day expiry unless saved.
- Added an online SQLite backup endpoint restricted to local requests.

The fork began at upstream commit `31979130b1371acd9defbea115279a06c63c1fb4`. Earlier upstream history remains available in Git.
