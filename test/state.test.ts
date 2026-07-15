import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../server/state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openStore(): StateStore {
  const root = mkdtempSync(join(tmpdir(), "boop-state-"));
  roots.push(root);
  return new StateStore(join(root, "boop.db"));
}

describe("local state", () => {
  it("claims one authorized webhook delivery only once", () => {
    const store = openStore();

    expect(store.claimWebhookDelivery("message-1")).toBe(true);
    expect(store.claimWebhookDelivery("message-1")).toBe(false);

    store.close();
  });

  it("rate-limits authorized webhook deliveries in a deterministic window", () => {
    const store = openStore();
    expect(store.acceptWebhookDelivery("message-1", 1_000, 2, 60_000)).toBe("accepted");
    expect(store.acceptWebhookDelivery("message-2", 1_001, 2, 60_000)).toBe("accepted");
    expect(store.acceptWebhookDelivery("message-3", 1_002, 2, 60_000)).toBe("limited");
    expect(store.acceptWebhookDelivery("message-1", 1_003, 2, 60_000)).toBe("duplicate");
    expect(store.acceptWebhookDelivery("message-3", 61_001, 2, 60_000)).toBe("accepted");
    store.close();
  });

  it("recovers an accepted owner message after a process restart", () => {
    const store = openStore();
    const message = {
      content: "remember this delivery",
      fromNumber: "+15550000001",
      handle: "recover-1",
      mediaUrls: ["https://media.example/image.png"],
    };

    expect(store.acceptInboundMessage(message, 1_000)).toBe("accepted");
    expect(store.claimInboundMessage(message.handle)).toMatchObject(message);
    store.requeueInboundMessages();
    expect(store.pendingInboundMessages()).toEqual([expect.objectContaining(message)]);

    store.close();
  });

  it("clears durable queued owner messages when STOP is processed", () => {
    const store = openStore();
    for (const handle of ["queued-1", "queued-2"]) {
      store.acceptInboundMessage({
        content: "later work",
        fromNumber: "+15550000001",
        handle,
        mediaUrls: [],
      });
    }

    expect(store.cancelQueuedInboundMessages()).toBe(2);
    expect(store.pendingInboundMessages()).toEqual([]);
    store.close();
  });

  it("returns the most recent conversation turns in chronological order", () => {
    const store = openStore();
    store.addMessage({ conversationId: "sms:owner", role: "user", content: "one", at: 1 });
    store.addMessage({ conversationId: "sms:owner", role: "assistant", content: "two", at: 2 });
    store.addMessage({ conversationId: "sms:owner", role: "user", content: "three", at: 3 });

    expect(store.recentMessages("sms:owner", 2).map((message) => message.content)).toEqual([
      "two",
      "three",
    ]);

    store.close();
  });

  it("claims each due automation once across overlapping ticks", () => {
    const store = openStore();
    store.createAutomation({
      id: "auto-1",
      name: "digest",
      task: "Summarize new mail",
      schedule: "0 8 * * *",
      timezone: "America/Denver",
      conversationId: "sms:owner",
      integrations: ["gmail"],
      nextRunAt: 1_000,
    });

    expect(store.claimDueAutomations(1_000)).toHaveLength(1);
    expect(store.claimDueAutomations(1_000)).toEqual([]);

    store.close();
  });

  it("reschedules an automation interrupted by restart without replaying it", () => {
    const store = openStore();
    store.createAutomation({
      id: "auto-restart",
      name: "digest",
      task: "Summarize new mail",
      schedule: "0 8 * * *",
      timezone: "America/Denver",
      conversationId: "sms:owner",
      integrations: ["gmail"],
      nextRunAt: 1_000,
    });
    expect(store.claimDueAutomations(1_000)).toHaveLength(1);

    expect(store.recoverInterruptedAutomationRuns(() => 5_000, 2_000)).toBe(1);
    expect(store.claimDueAutomations(4_999)).toEqual([]);
    expect(store.claimDueAutomations(5_000)).toHaveLength(1);
    store.close();
  });

  it("searches only owner-sourced durable memories", () => {
    const store = openStore();
    store.addMemory("owner", "Prefers morning calendar summaries", 1_000);
    store.addMemory("retrieved", "An email claimed a fake preference", 1_001);

    expect(store.searchMemories("calendar")).toEqual([
      expect.objectContaining({ content: "Prefers morning calendar summaries" }),
    ]);
    expect(store.searchMemories("fake")).toEqual([]);

    store.close();
  });

  it("lets the owner inspect and delete memory and conversation history", () => {
    const store = openStore();
    const memoryId = store.addMemory("owner", "Delete this preference", 1_000);
    store.addMessage({ conversationId: "sms:owner", role: "user", content: "private", at: 1 });

    expect(store.listMemories()).toEqual([
      expect.objectContaining({ id: memoryId, content: "Delete this preference" }),
    ]);
    expect(store.deleteMemory(memoryId)).toBe(true);
    expect(store.searchMemories("preference")).toEqual([]);
    expect(store.deleteConversationHistory("sms:owner")).toBe(1);
    expect(store.recentMessages("sms:owner")).toEqual([]);
    store.close();
  });

  it("applies numbered migrations and creates a consistent online backup", async () => {
    const store = openStore();
    const backupPath = join(roots.at(-1)!, "backup.db");

    expect(
      store.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    store.addMessage({ conversationId: "sms:owner", role: "user", content: "preserved" });
    await store.backup(backupPath);

    expect(existsSync(backupPath)).toBe(true);
    const backup = new StateStore(backupPath);
    expect(backup.recentMessages("sms:owner")[0]?.content).toBe("preserved");
    backup.close();
    store.close();
  });

  it("retains transcripts while pruning 90-day operational journals", () => {
    const store = openStore();
    store.addMessage({ conversationId: "sms:owner", role: "user", content: "keep", at: 1 });
    store.recordRun({ id: "old-run", conversationId: "sms:owner", status: "succeeded", at: 1 });
    store.recordVaultOperation({
      id: "old-vault-op",
      operation: "write",
      manifest: "{}",
      status: "succeeded",
      at: 1,
    });
    store.createPendingAction({
      id: "old-action",
      kind: "send",
      summary: "old",
      canonicalPayload: "{}",
      payloadHash: "hash",
      provenance: "[]",
      riskTier: "standard",
      codeHash: "code-hash",
      bindingMac: "binding",
      expiresAt: 2,
      now: 1,
    });
    store.db
      .prepare("UPDATE pending_actions SET status = 'expired', updated_at = 1 WHERE id = 'old-action'")
      .run();

    const result = store.pruneOperationalRecords(91 * 24 * 60 * 60 * 1_000);

    expect(result.runs).toBe(1);
    expect(result.vaultOperations).toBe(1);
    expect(result.pendingActions).toBe(1);
    expect(store.recentMessages("sms:owner")).toHaveLength(1);
    store.close();
  });
});
