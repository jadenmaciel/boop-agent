# Changelog

## Unreleased — private headless fork

- [BREAKING] Replaced Convex application services with direct, pinned SQLite and transactional migrations.
- [BREAKING] Removed the admin dashboard, Electron app, Claude fallback, Apple/Mac connectors, embeddings, and generic agent spawning.
- Added exact-owner Sendblue authentication before all side effects, one FIFO queue, durable webhook deduplication, and `STOP` cancellation.
- Added payload- and provenance-bound one-hour confirmation codes, with Tailscale approval for high-risk actions.
- Added typed Personal Vault tools, atomic writes, synced trash/restore, symlink containment, a 25-file bulk fuse, and operational journals.
- Added owner-sourced FTS5 memory, transactional automations, complete transcript retention, and 90-day operational retention.
- Added confirmation-gated Composio writes and OAuth connection flows for Gmail, Calendar, and additional approved toolkits.
- Added Patchright public-destination enforcement, persistent profiles, and temporary Tailscale-only login handoff.
- Added validated inbound images up to 10 MB with three-day expiry unless saved.
- Added an online SQLite backup endpoint restricted to local requests.

The fork began at upstream commit `31979130b1371acd9defbea115279a06c63c1fb4`. Earlier upstream history remains available in Git.
