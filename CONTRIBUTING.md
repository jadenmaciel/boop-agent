# Contributing

Keep changes small, security-focused, and readable. Use Node 22 and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

Add tests before behavior changes. One concern belongs in one commit. Update `CHANGELOG.md` for owner-visible or operational changes.

Before staging, inspect every changed file for personal data and secrets. Use generic E.164 numbers, `example.com`, and placeholder account identifiers. Never commit `.env` files, OAuth data, Composio connection IDs, production URLs, browser profiles, transcripts, or Vault content.

Changes that weaken authentication, confirmation binding, path containment, browser egress restrictions, service isolation, or the read-only Codex sandbox will not be accepted without a documented threat analysis and replacement control.
