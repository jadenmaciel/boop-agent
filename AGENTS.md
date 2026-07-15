# Agent guidance

This is the headless, owner-only Boop fork. Read `README.md` and `ARCHITECTURE.md` before changing trust boundaries.

- Use Node 22 and pnpm.
- Add or change behavior test-first with Vitest.
- Keep SQLite behind named `StateStore` methods; do not add an ORM or generic backend abstraction.
- Keep Codex read-only and expose personal-data effects only through narrow typed tools.
- Never weaken owner/signature checks, confirmation payload binding, Vault containment, browser address checks, or local-only maintenance routes.
- Never add secrets, personal phone numbers, emails, hostnames, messages, or account IDs to this public repository.
- Upstream changes are imported manually from the pinned base and reviewed before merge.
