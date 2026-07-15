import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type MessageRole = "user" | "assistant" | "system";

export interface MessageRecord {
  id: number;
  conversationId: string;
  role: MessageRole;
  content: string;
  at: number;
}

export type ActionRiskTier = "standard" | "high";
export type ActionStatus =
  | "pending"
  | "dispatching"
  | "succeeded"
  | "failed"
  | "unknown"
  | "cancelled"
  | "expired";

export interface PendingActionRecord {
  id: string;
  kind: string;
  summary: string;
  canonicalPayload: string;
  payloadHash: string;
  provenance: string;
  codeHash: string;
  bindingMac: string;
  riskTier: ActionRiskTier;
  status: ActionStatus;
  expiresAt: number;
  messageApprovedAt: number | null;
  tailscaleApprovedAt: number | null;
  result: string | null;
}

export interface AutomationRecord {
  id: string;
  runId?: string;
  name: string;
  task: string;
  schedule: string;
  timezone: string;
  conversationId: string;
  integrations: string[];
  enabled: boolean;
  nextRunAt: number | null;
}

export interface InboundMessageRecord {
  handle: string;
  content: string;
  fromNumber: string;
  mediaUrls: string[];
  response: string | null;
}

export class StateStore {
  readonly db: Database.Database;

  constructor(path = process.env.BOOP_DATABASE_PATH ?? "/var/lib/boop/boop.db") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    this.applyMigration(1, `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        handle TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_created
        ON messages(conversation_id, created_at, id);
      CREATE TABLE IF NOT EXISTS pending_actions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        canonical_payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        provenance TEXT NOT NULL,
        risk_tier TEXT NOT NULL CHECK (risk_tier IN ('standard', 'high')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'succeeded', 'failed', 'unknown', 'cancelled', 'expired')),
        code_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        message_approved_at INTEGER,
        tailscale_approved_at INTEGER,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_actions_status_expiry
        ON pending_actions(status, expires_at);
      CREATE TABLE IF NOT EXISTS memory_records (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('owner', 'retrieved')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        content,
        tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        task TEXT NOT NULL,
        schedule TEXT NOT NULL,
        timezone TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        integrations TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS automations_due
        ON automations(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        result TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        saved_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    this.applyMigration(2, `
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
      CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_records_created ON usage_records(created_at);
      CREATE TABLE IF NOT EXISTS vault_operations (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        manifest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vault_operations_created ON vault_operations(created_at);
    `);
    this.applyMigration(3, `
      CREATE TABLE IF NOT EXISTS inbound_messages (
        handle TEXT PRIMARY KEY REFERENCES webhook_deliveries(handle) ON DELETE CASCADE,
        content TEXT NOT NULL,
        from_number TEXT NOT NULL,
        media_urls TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'completed')),
        response TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbound_messages_status_created
        ON inbound_messages(status, created_at);
    `);
    this.applyMigration(4, `
      ALTER TABLE pending_actions ADD COLUMN binding_mac TEXT NOT NULL DEFAULT '';
      UPDATE pending_actions
      SET status = CASE WHEN status = 'dispatching' THEN 'unknown' ELSE 'cancelled' END,
          result = 'Invalidated by confirmation integrity migration',
          updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE status IN ('pending', 'dispatching');
    `);
  }

  private applyMigration(version: number, sql: string): void {
    if (this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)) return;
    this.db.transaction(() => {
      this.db.exec(sql);
      this.db
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, Date.now());
    }).immediate();
  }

  addMessage(input: {
    conversationId: string;
    role: MessageRole;
    content: string;
    at?: number;
  }): number {
    const result = this.db
      .prepare(
        "INSERT INTO messages(conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(input.conversationId, input.role, input.content, input.at ?? Date.now());
    return Number(result.lastInsertRowid);
  }

  recentMessages(conversationId: string, limit = 10): MessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, created_at
         FROM (
           SELECT id, conversation_id, role, content, created_at
           FROM messages WHERE conversation_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?
         ) ORDER BY created_at ASC, id ASC`,
      )
      .all(conversationId, limit) as Array<{
      id: number;
      conversation_id: string;
      role: MessageRole;
      content: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      at: row.created_at,
    }));
  }

  createPendingAction(input: {
    id: string;
    kind: string;
    summary: string;
    canonicalPayload: string;
    payloadHash: string;
    provenance: string;
    riskTier: ActionRiskTier;
    codeHash: string;
    bindingMac: string;
    expiresAt: number;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pending_actions(
          id, kind, summary, canonical_payload, payload_hash, provenance,
          risk_tier, status, code_hash, binding_mac, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.kind,
        input.summary,
        input.canonicalPayload,
        input.payloadHash,
        input.provenance,
        input.riskTier,
        input.codeHash,
        input.bindingMac,
        input.expiresAt,
        input.now,
        input.now,
      );
  }

  approvePendingAction(
    codeHash: string,
    channel: "message" | "tailscale",
    now: number,
  ): { action: PendingActionRecord; ready: boolean } | null {
    return this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE pending_actions SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?",
        )
        .run(now, now);
      const row = this.db
        .prepare("SELECT * FROM pending_actions WHERE code_hash = ? AND status = 'pending'")
        .get(codeHash) as PendingActionRow | undefined;
      if (!row) return null;
      if (channel === "tailscale" && row.risk_tier !== "high") return null;
      const column = channel === "message" ? "message_approved_at" : "tailscale_approved_at";
      if (row[column] !== null) return null;
      this.db
        .prepare(`UPDATE pending_actions SET ${column} = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, row.id);
      const action = this.getPendingAction(row.id);
      if (!action) return null;
      const ready = action.messageApprovedAt !== null &&
        (action.riskTier === "standard" || action.tailscaleApprovedAt !== null);
      if (!ready) return { action, ready };
      const claimed = this.db
        .prepare(
          `UPDATE pending_actions SET status = 'dispatching', updated_at = ?
           WHERE id = ? AND status = 'pending' AND expires_at > ?`,
        )
        .run(now, action.id, now).changes;
      if (claimed !== 1) return null;
      return { action: this.getPendingAction(action.id)!, ready: true };
    })();
  }

  claimPendingAction(id: string, bindingMac: string, now = Date.now()): boolean {
    const dispatching = this.db
      .prepare(
        "SELECT 1 FROM pending_actions WHERE id = ? AND binding_mac = ? AND status = 'dispatching'",
      )
      .get(id, bindingMac);
    if (dispatching) return true;
    const result = this.db
      .prepare(
        `UPDATE pending_actions SET status = 'dispatching', updated_at = ?
         WHERE id = ? AND binding_mac = ? AND status = 'pending' AND expires_at > ?
           AND message_approved_at IS NOT NULL
           AND (risk_tier = 'standard' OR tailscale_approved_at IS NOT NULL)`,
      )
      .run(now, id, bindingMac, now);
    return result.changes === 1;
  }

  markInterruptedPendingActionsUnknown(now = Date.now()): number {
    return this.db
      .prepare(
        `UPDATE pending_actions SET status = 'unknown',
         result = 'Service restarted after dispatch was claimed; execution was not retried', updated_at = ?
         WHERE status = 'dispatching'`,
      )
      .run(now).changes;
  }

  markDispatchingPendingActionUnknown(
    id: string,
    bindingMac: string,
    result: string,
    now = Date.now(),
  ): boolean {
    return this.db
      .prepare(
        `UPDATE pending_actions SET status = 'unknown', result = ?, updated_at = ?
         WHERE id = ? AND binding_mac = ? AND status = 'dispatching'`,
      )
      .run(result, now, id, bindingMac).changes === 1;
  }

  finishPendingAction(
    id: string,
    status: "succeeded" | "failed" | "unknown",
    result: string,
    now = Date.now(),
  ): void {
    const changed = this.db
      .prepare(
        "UPDATE pending_actions SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'dispatching'",
      )
      .run(status, result, now, id).changes;
    if (changed !== 1) throw new Error(`Pending action ${id} is not dispatching.`);
  }

  cancelPendingActions(now = Date.now()): number {
    return this.db
      .prepare(
        "UPDATE pending_actions SET status = 'cancelled', updated_at = ? WHERE status = 'pending'",
      )
      .run(now).changes;
  }

  getPendingAction(id: string): PendingActionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM pending_actions WHERE id = ?")
      .get(id) as PendingActionRow | undefined;
    return row ? mapPendingAction(row) : null;
  }

  addMemory(source: "owner" | "retrieved", content: string, now = Date.now()): number {
    return this.db.transaction(() => {
      const id = Number(
        this.db
          .prepare("INSERT INTO memory_records(source, content, created_at) VALUES (?, ?, ?)")
          .run(source, content, now).lastInsertRowid,
      );
      if (source === "owner") {
        this.db
          .prepare("INSERT INTO memory_fts(memory_id, content) VALUES (?, ?)")
          .run(id, content);
      }
      return id;
    })();
  }

  searchMemories(query: string, limit = 10): Array<{ id: number; content: string }> {
    const match = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replaceAll('"', '""')}"`)
      .join(" AND ");
    if (!match) return [];
    return this.db
      .prepare(
        `SELECT m.id, m.content
         FROM memory_fts f JOIN memory_records m ON m.id = CAST(f.memory_id AS INTEGER)
         WHERE memory_fts MATCH ? AND m.source = 'owner'
         ORDER BY bm25(memory_fts), m.created_at DESC LIMIT ?`,
      )
      .all(match, limit) as Array<{ id: number; content: string }>;
  }

  listMemories(limit = 100): Array<{ id: number; content: string; createdAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, content, created_at
         FROM memory_records WHERE source = 'owner'
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: number; content: string; created_at: number }>;
    return rows.map((row) => ({ id: row.id, content: row.content, createdAt: row.created_at }));
  }

  deleteMemory(id: number): boolean {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(id);
      return this.db
        .prepare("DELETE FROM memory_records WHERE id = ? AND source = 'owner'")
        .run(id).changes === 1;
    })();
  }

  clearMemories(): number {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_fts").run();
      return this.db.prepare("DELETE FROM memory_records WHERE source = 'owner'").run().changes;
    })();
  }

  deleteConversationHistory(conversationId: string): number {
    return this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId)
      .changes;
  }

  createAutomation(input: {
    id: string;
    name: string;
    task: string;
    schedule: string;
    timezone: string;
    conversationId: string;
    integrations: string[];
    nextRunAt: number | null;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO automations(
          id, name, task, schedule, timezone, conversation_id, integrations,
          enabled, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.task,
        input.schedule,
        input.timezone,
        input.conversationId,
        JSON.stringify(input.integrations),
        input.nextRunAt,
        now,
        now,
      );
  }

  listAutomations(conversationId: string): AutomationRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM automations WHERE conversation_id = ? ORDER BY created_at, id")
      .all(conversationId) as AutomationRow[];
    return rows.map(mapAutomation);
  }

  setAutomationEnabled(id: string, enabled: boolean, now = Date.now()): boolean {
    return this.db
      .prepare("UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, now, id).changes === 1;
  }

  deleteAutomation(id: string): boolean {
    return this.db.prepare("DELETE FROM automations WHERE id = ?").run(id).changes === 1;
  }

  claimDueAutomations(now = Date.now(), limit = 10): AutomationRecord[] {
    const claim = this.db.transaction((claimAt: number, claimLimit: number) => {
      const rows = this.db
        .prepare(
          `SELECT * FROM automations
           WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
           ORDER BY next_run_at, id LIMIT ?`,
        )
        .all(claimAt, claimLimit) as AutomationRow[];
      const claimed: AutomationRecord[] = [];
      for (const row of rows) {
        const changed = this.db
          .prepare(
            "UPDATE automations SET next_run_at = NULL, updated_at = ? WHERE id = ? AND next_run_at = ?",
          )
          .run(claimAt, row.id, row.next_run_at).changes;
        if (changed !== 1) continue;
        const runId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO automation_runs(id, automation_id, status, started_at) VALUES (?, ?, 'running', ?)",
          )
          .run(runId, row.id, claimAt);
        claimed.push({ ...mapAutomation(row), runId, nextRunAt: null });
      }
      return claimed;
    });
    return claim.immediate(now, limit);
  }

  finishAutomationRun(input: {
    runId: string;
    automationId: string;
    status: "completed" | "failed" | "cancelled";
    result?: string;
    error?: string;
    nextRunAt: number | null;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE automation_runs SET status = ?, result = ?, error = ?, finished_at = ?
           WHERE id = ? AND automation_id = ? AND status = 'running'`,
        )
        .run(input.status, input.result ?? null, input.error ?? null, now, input.runId, input.automationId);
      this.db
        .prepare(
          "UPDATE automations SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, input.nextRunAt, now, input.automationId);
    })();
  }

  recoverInterruptedAutomationRuns(
    nextRun: (schedule: string, timezone: string) => number | null,
    now = Date.now(),
  ): number {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT a.* FROM automations a
           JOIN automation_runs r ON r.automation_id = a.id
           WHERE r.status = 'running'`,
        )
        .all() as AutomationRow[];
      this.db
        .prepare(
          `UPDATE automation_runs SET status = 'failed', error = 'Interrupted by restart', finished_at = ?
           WHERE status = 'running'`,
        )
        .run(now);
      for (const row of rows) {
        this.db
          .prepare("UPDATE automations SET next_run_at = ?, updated_at = ? WHERE id = ?")
          .run(nextRun(row.schedule, row.timezone), now, row.id);
      }
      return rows.length;
    }).immediate();
  }

  addMedia(input: {
    id: string;
    path: string;
    mediaType: string;
    size: number;
    expiresAt: number;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        "INSERT INTO media(id, path, media_type, size, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(input.id, input.path, input.mediaType, input.size, input.expiresAt, now);
  }

  expiredMedia(now = Date.now()): Array<{ id: string; path: string }> {
    return this.db
      .prepare("SELECT id, path FROM media WHERE saved_at IS NULL AND expires_at <= ?")
      .all(now) as Array<{ id: string; path: string }>;
  }

  deleteMedia(id: string): void {
    this.db.prepare("DELETE FROM media WHERE id = ?").run(id);
  }

  mediaPath(id: string): string | null {
    const row = this.db.prepare("SELECT path FROM media WHERE id = ?").get(id) as
      | { path: string }
      | undefined;
    return row?.path ?? null;
  }

  markMediaSaved(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE media SET saved_at = ? WHERE id = ?").run(now, id);
  }

  claimWebhookDelivery(handle: string, now = Date.now()): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO webhook_deliveries(handle, received_at) VALUES (?, ?)")
      .run(handle, now);
    return result.changes === 1;
  }

  acceptWebhookDelivery(
    handle: string,
    now = Date.now(),
    limit = 20,
    windowMs = 60_000,
  ): "accepted" | "duplicate" | "limited" {
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM webhook_deliveries WHERE handle = ?").get(handle)) {
        return "duplicate" as const;
      }
      const row = this.db
        .prepare("SELECT COUNT(*) AS count FROM webhook_deliveries WHERE received_at > ?")
        .get(now - windowMs) as { count: number };
      if (row.count >= limit) return "limited" as const;
      this.db
        .prepare("INSERT INTO webhook_deliveries(handle, received_at) VALUES (?, ?)")
        .run(handle, now);
      return "accepted" as const;
    }).immediate();
  }

  acceptInboundMessage(
    message: { handle: string; content: string; fromNumber: string; mediaUrls: string[] },
    now = Date.now(),
    limit = 20,
    windowMs = 60_000,
  ): "accepted" | "duplicate" | "limited" {
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM webhook_deliveries WHERE handle = ?").get(message.handle)) {
        return "duplicate" as const;
      }
      const row = this.db
        .prepare("SELECT COUNT(*) AS count FROM webhook_deliveries WHERE received_at > ?")
        .get(now - windowMs) as { count: number };
      if (row.count >= limit) return "limited" as const;
      this.db
        .prepare("INSERT INTO webhook_deliveries(handle, received_at) VALUES (?, ?)")
        .run(message.handle, now);
      this.db
        .prepare(
          `INSERT INTO inbound_messages(
             handle, content, from_number, media_urls, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          message.handle,
          message.content,
          message.fromNumber,
          JSON.stringify(message.mediaUrls),
          now,
          now,
        );
      return "accepted" as const;
    }).immediate();
  }

  requeueInboundMessages(now = Date.now()): number {
    return this.db
      .prepare("UPDATE inbound_messages SET status = 'pending', updated_at = ? WHERE status = 'processing'")
      .run(now).changes;
  }

  pendingInboundMessages(limit = 100): InboundMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT handle, content, from_number, media_urls, response
         FROM inbound_messages WHERE status IN ('pending', 'ready')
         ORDER BY created_at, handle LIMIT ?`,
      )
      .all(limit) as InboundMessageRow[];
    return rows.map(mapInboundMessage);
  }

  claimInboundMessage(handle: string, now = Date.now()): InboundMessageRecord | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT handle, content, from_number, media_urls, response
           FROM inbound_messages WHERE handle = ? AND status IN ('pending', 'ready')`,
        )
        .get(handle) as InboundMessageRow | undefined;
      if (!row) return null;
      const expected = row.response === null ? "pending" : "ready";
      const changed = this.db
        .prepare(
          "UPDATE inbound_messages SET status = 'processing', updated_at = ? WHERE handle = ? AND status = ?",
        )
        .run(now, handle, expected).changes;
      return changed === 1 ? mapInboundMessage(row) : null;
    }).immediate();
  }

  setInboundResponse(handle: string, response: string, now = Date.now()): void {
    const changed = this.db
      .prepare(
        `UPDATE inbound_messages SET response = ?, status = 'ready', updated_at = ?
         WHERE handle = ? AND status = 'processing'`,
      )
      .run(response, now, handle).changes;
    if (changed !== 1) throw new Error(`Inbound message ${handle} is not processing.`);
  }

  retryInboundMessage(handle: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE inbound_messages SET status = CASE WHEN response IS NULL THEN 'pending' ELSE 'ready' END,
         updated_at = ? WHERE handle = ? AND status = 'processing'`,
      )
      .run(now, handle);
  }

  completeInboundMessage(handle: string, now = Date.now()): void {
    const changed = this.db
      .prepare(
        "UPDATE inbound_messages SET status = 'completed', updated_at = ? WHERE handle = ? AND status = 'processing'",
      )
      .run(now, handle).changes;
    if (changed !== 1) throw new Error(`Inbound message ${handle} is not processing.`);
  }

  cancelQueuedInboundMessages(now = Date.now()): number {
    return this.db
      .prepare(
        `UPDATE inbound_messages SET status = 'completed', response = 'Cancelled by STOP.', updated_at = ?
         WHERE status IN ('pending', 'ready')`,
      )
      .run(now).changes;
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  recordRun(input: {
    id: string;
    conversationId: string;
    status: "running" | "succeeded" | "failed" | "cancelled";
    error?: string;
    at?: number;
  }): void {
    const at = input.at ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO runs(id, conversation_id, status, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           error = excluded.error,
           finished_at = excluded.finished_at`,
      )
      .run(
        input.id,
        input.conversationId,
        input.status,
        input.error ?? null,
        at,
        input.status === "running" ? null : at,
      );
  }

  recordVaultOperation(input: {
    id: string;
    operation: string;
    manifest: string;
    status: "succeeded" | "failed" | "cancelled";
    at?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO vault_operations(id, operation, manifest, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.operation, input.manifest, input.status, input.at ?? Date.now());
  }

  pruneOperationalRecords(now = Date.now(), retentionDays = 90): {
    runs: number;
    usageRecords: number;
    vaultOperations: number;
    automationRuns: number;
    inboundMessages: number;
    webhookDeliveries: number;
    pendingActions: number;
  } {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
    return this.db.transaction(() => {
      const usageRecords = this.db
        .prepare("DELETE FROM usage_records WHERE created_at < ?")
        .run(cutoff).changes;
      const runs = this.db.prepare("DELETE FROM runs WHERE started_at < ?").run(cutoff).changes;
      const vaultOperations = this.db
        .prepare("DELETE FROM vault_operations WHERE created_at < ?")
        .run(cutoff).changes;
      const automationRuns = this.db
        .prepare("DELETE FROM automation_runs WHERE started_at < ?")
        .run(cutoff).changes;
      const inboundMessages = this.db
        .prepare("DELETE FROM inbound_messages WHERE status = 'completed' AND updated_at < ?")
        .run(cutoff).changes;
      const webhookDeliveries = this.db
        .prepare(
          `DELETE FROM webhook_deliveries
           WHERE received_at < ? AND NOT EXISTS (
             SELECT 1 FROM inbound_messages WHERE inbound_messages.handle = webhook_deliveries.handle
           )`,
        )
        .run(cutoff).changes;
      const pendingActions = this.db
        .prepare(
          `DELETE FROM pending_actions
           WHERE updated_at < ? AND status IN ('succeeded', 'failed', 'unknown', 'cancelled', 'expired')`,
        )
        .run(cutoff).changes;
      return {
        runs,
        usageRecords,
        vaultOperations,
        automationRuns,
        inboundMessages,
        webhookDeliveries,
        pendingActions,
      };
    })();
  }

  async backup(destination: string): Promise<void> {
    mkdirSync(dirname(destination), { recursive: true });
    await this.db.backup(destination);
  }

  close(): void {
    this.db.close();
  }
}

interface PendingActionRow {
  id: string;
  kind: string;
  summary: string;
  canonical_payload: string;
  payload_hash: string;
  provenance: string;
  code_hash: string;
  binding_mac: string;
  risk_tier: ActionRiskTier;
  status: ActionStatus;
  expires_at: number;
  message_approved_at: number | null;
  tailscale_approved_at: number | null;
  result: string | null;
}

interface AutomationRow {
  id: string;
  name: string;
  task: string;
  schedule: string;
  timezone: string;
  conversation_id: string;
  integrations: string;
  enabled: number;
  next_run_at: number | null;
}

interface InboundMessageRow {
  handle: string;
  content: string;
  from_number: string;
  media_urls: string;
  response: string | null;
}

function mapPendingAction(row: PendingActionRow): PendingActionRecord {
  return {
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    canonicalPayload: row.canonical_payload,
    payloadHash: row.payload_hash,
    provenance: row.provenance,
    codeHash: row.code_hash,
    bindingMac: row.binding_mac,
    riskTier: row.risk_tier,
    status: row.status,
    expiresAt: row.expires_at,
    messageApprovedAt: row.message_approved_at,
    tailscaleApprovedAt: row.tailscale_approved_at,
    result: row.result,
  };
}

function mapAutomation(row: AutomationRow): AutomationRecord {
  return {
    id: row.id,
    name: row.name,
    task: row.task,
    schedule: row.schedule,
    timezone: row.timezone,
    conversationId: row.conversation_id,
    integrations: JSON.parse(row.integrations) as string[],
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
  };
}

function mapInboundMessage(row: InboundMessageRow): InboundMessageRecord {
  return {
    handle: row.handle,
    content: row.content,
    fromNumber: row.from_number,
    mediaUrls: JSON.parse(row.media_urls) as string[],
    response: row.response,
  };
}
