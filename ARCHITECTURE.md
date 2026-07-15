# Architecture

```text
Owner iMessage
    │
    ▼
Cloudflare path-only tunnel ──► signed Sendblue webhook
                                      │
                                      ▼
                             owner auth + dedup
                                      │
                                      ▼
                                one FIFO queue
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
             Codex app-server     typed tools      confirmations
             read-only sandbox   Vault/reads       durable SQLite
                    │                 │                 │
                    └─────────────────┴─────────────────┘
                                      │
                                      ▼
                              owner iMessage reply
```

## Runtime

`server/app.ts` mounts the signed Sendblue router before a local-only middleware. `server/owner-messages.ts` serializes work, handles exact confirmation codes, and implements `STOP`. `server/personal-agent.ts` constructs the ten-turn prompt, retrieves only owner-sourced memories, exposes safe reads, and stages writes.

Codex starts through `server/runtimes/codex-app-server.ts` with `approvalPolicy=never`, a read-only sandbox, and only the explicitly registered runtime tools. Generated protocol types may describe other app-server capabilities, but they are not added to the allowed tool set.

## State

`server/state.ts` is the only storage layer. It owns transactional migrations and the tables `messages`, `inbound_messages`, `memory_records`, `memory_fts`, `automations`, `automation_runs`, `webhook_deliveries`, `pending_actions`, `media`, `runs`, `usage_records`, `settings`, `vault_operations`, and `schema_migrations`. Authorized inbound deliveries are durable before the webhook returns; prepared replies survive restart without rerunning the model.

Pending actions move atomically through:

```text
pending → dispatching → succeeded | failed | unknown
       └──────────────→ cancelled | expired
```

An ambiguous provider timeout becomes `unknown` and is never retried automatically. Automation claims atomically clear `next_run_at` and create a run row, preventing duplicate execution after overlapping ticks.

## Vault

`server/vault.ts` resolves every path under one real root, rejects traversal and symlinks, and excludes protected top-level paths. Text and image writes use a same-directory temporary file, `fsync`, and atomic rename. Deletions move to `.boop-trash/<date>/<operation-id>`.

The 25-file fuse hashes the sorted path, size, and modification-time manifest. The confirmation record binds that exact hash; a changed tree cannot reuse the approval. A root-controlled read-only sentinel disables mutations during rollout, backup, sync recovery, or low-disk conditions.

## Integrations and browser

Composio tools and OAuth scopes are classified by the maintenance-owned allowlist. Declared reads are available directly, declared writes are catalogued for `propose_external_action`, and unknown tools fail closed. Owner automations receive only their stored integration allowlist and share the same serialized owner queue.

Patchright accepts exact approved hostnames only. At browser launch it resolves each hostname to public addresses, pins Chromium to those results, blocks all other DNS, and rechecks every routed request. Changing the allowlist closes the browser so the next launch repins it. Login handoff writes a bounded request file consumed by a systemd path unit; VNC binds only to the VPS Tailscale address and expires after 30 minutes.

## Operations boundary

The application never receives rclone, Restic/B2, Cloudflare, or watchdog credentials. Separate system users and units own sync, backup, tunnel, and alerting. Backups briefly make Vault mutations read-only, use SQLite's online backup API, and snapshot the database copy and Vault in one quiesced window.
