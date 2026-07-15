import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfirmationService,
  redactConfirmationCodeForTranscript,
} from "../server/confirmations.js";
import { StateStore } from "../server/state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "boop-confirm-"));
  roots.push(root);
  const store = new StateStore(join(root, "boop.db"));
  const confirmations = new ConfirmationService(store, {
    hmacSecret: "test-secret-not-real",
    codeGenerator: () => "ABC234",
  });
  return { store, confirmations };
}

describe("external action confirmations", () => {
  it("binds a high-risk action to one code and requires both approval channels", () => {
    const { store, confirmations } = setup();
    const staged = confirmations.stage({
      kind: "purchase",
      summary: "Buy one test item for $300",
      payload: { item: "test item", quantity: 1, price: 300 },
      provenance: [{ source: "owner-message", reference: "turn-1" }],
      riskTier: "high",
      now: 1_000,
    });

    expect(staged.code).toBe("ABC234");
    expect(confirmations.approveFromMessage("yes", 2_000)).toEqual({ ok: false });
    expect(confirmations.approveFromMessage("ABC234", 2_000)).toMatchObject({
      ok: true,
      ready: false,
    });
    expect(confirmations.approveFromTailscale("ABC234", 2_100)).toMatchObject({
      ok: true,
      ready: true,
    });
    const action = store.getPendingAction(staged.id)!;
    expect(confirmations.verifyAction(action)).toBe(true);
    expect(store.claimPendingAction(staged.id, action.bindingMac, 2_200)).toBe(true);
    store.finishPendingAction(staged.id, "unknown", "provider timed out", 2_300);
    expect(confirmations.approveFromMessage("ABC234", 2_400)).toEqual({ ok: false });

    store.close();
  });

  it("rejects a pending action whose canonical payload was changed", () => {
    const { store, confirmations } = setup();
    const staged = confirmations.stage({
      kind: "send",
      summary: "Send a test message",
      payload: { recipient: "original", content: "hello" },
      provenance: [{ source: "owner-message", reference: "turn-2" }],
      riskTier: "standard",
      now: 1_000,
    });
    store.db
      .prepare("UPDATE pending_actions SET canonical_payload = ? WHERE id = ?")
      .run('{"content":"changed","recipient":"attacker"}', staged.id);

    expect(confirmations.verifyAction(store.getPendingAction(staged.id)!)).toBe(false);
    store.close();
  });

  it("never persists a usable confirmation code in transcript text", () => {
    expect(redactConfirmationCodeForTranscript("ABC234")).toBe(
      "[confirmation code submitted]",
    );
    expect(redactConfirmationCodeForTranscript(
      "Reply with ABC234 within one hour. Then run: boop approve ABC234 over Tailscale SSH.",
    )).toBe(
      "Reply with [confirmation code] within one hour. Then run: boop approve [confirmation code] over Tailscale SSH.",
    );
  });

  it("turns a claimed action into unknown after restart instead of retrying it", () => {
    const { store, confirmations } = setup();
    const staged = confirmations.stage({
      kind: "send",
      summary: "Send once",
      payload: { content: "hello" },
      provenance: [{ source: "owner-message", reference: "turn-3" }],
      riskTier: "standard",
      now: 1_000,
    });
    expect(confirmations.approveFromMessage(staged.code, 2_000)).toMatchObject({
      ok: true,
      ready: true,
      action: { status: "dispatching" },
    });

    expect(store.markInterruptedPendingActionsUnknown(3_000)).toBe(1);
    expect(store.getPendingAction(staged.id)?.status).toBe("unknown");
    store.close();
  });
});
