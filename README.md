# Boop Personal Agent

This fork turns [raroque/boop-agent](https://github.com/raroque/boop-agent) into a private, headless personal agent for one owner. The sole conversation surface is an owner-only Sendblue iMessage number. It runs on a VPS with Codex, SQLite, Composio, and a persistent Patchright browser profile.

This repository contains the application. Host installation, systemd units, Google Drive synchronization, encrypted backups, watchdogs, and rollout runbooks live in the separate Agent operations repository.

## Security boundary

- Sendblue signatures and the exact owner number are checked before deduplication, persistence, downloads, model calls, or tool execution.
- Owner iMessages and owner-created automations are the only instructions. Email, calendar events, websites, files, attachments, and tool output are untrusted data.
- External writes require a one-use six-character confirmation code bound to the canonical payload and provenance for one hour.
- Purchases over $250 and password, MFA, recovery, or payment-method changes also require `boop approve <code>` over Tailscale SSH.
- The Codex runtime uses a read-only sandbox with no generic shell tool. Personal data changes happen only through the typed Vault and integration tools.
- Only `POST /sendblue/webhook` is public. Health, approval, and backup routes accept local requests only.

## Capabilities

- Complete owner transcript retention with a ten-turn model window.
- Owner-sourced SQLite FTS5 memory.
- Personal Vault read, search, atomic create/edit, move, trash, and restore.
- Autonomous Vault changes through 25 affected files; larger manifests require confirmation.
- Gmail, Google Calendar, and other approved Composio integrations.
- Read-only integration calls without confirmation; every external write is staged first.
- Owner-created cron automations and proactive iMessage results.
- Patchright navigation with public-domain allowlisting and private-address/DNS-rebinding defenses.
- Images up to 10 MB, MIME and magic-byte checked, expiring after three days unless saved.
- `STOP` aborts the active model run, clears the FIFO queue, and invalidates pending confirmations.

## Local development

Requirements: Node 22, pnpm, Codex CLI authentication, and the environment values in `.env.example`.

```bash
pnpm install --frozen-lockfile
pnpm exec patchright install chromium
pnpm typecheck
pnpm test
pnpm start
```

The server binds to `127.0.0.1:3456`. Configure a tunnel that routes exactly `/sendblue/webhook`; do not publish the whole origin.

## Storage

The application uses direct, pinned `better-sqlite3`, not Convex. Production defaults are:

- `/var/lib/boop/boop.db`
- `/srv/boop/personal`
- `/var/lib/boop/browser-profile`
- `/var/lib/boop/media`
- `/etc/boop/boop.env`

SQLite uses WAL, foreign keys, a busy timeout, `synchronous=FULL`, numbered transactional migrations, and one logical writer. Conversation history is owner-controlled; operational run and Vault journals are pruned after 90 days.

## Fork policy

The fork started from upstream commit `31979130b1371acd9defbea115279a06c63c1fb4`. Upstream attribution is retained. Future upstream changes are imported manually after review and tests; production never tracks an unpinned branch.

Hermes is a separate agent and is not a dependency or fallback for Boop.
