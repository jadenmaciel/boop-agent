import express from "express";
import { ConfirmationService } from "./confirmations.js";
import { isTrustedLocalRequest } from "./local-access.js";
import { OwnerMessageService } from "./owner-messages.js";
import { InboundDeliveryService } from "./inbound-deliveries.js";
import { PersonalAgent } from "./personal-agent.js";
import { createSendblueRouter, normalizeE164 } from "./sendblue.js";
import { StateStore } from "./state.js";
import { VaultService } from "./vault.js";

export function createApp(deps: {
  state: StateStore;
  confirmations: ConfirmationService;
  agent: PersonalAgent;
  messages: OwnerMessageService;
  ownerNumber: string;
  sendblueApiSecret: string;
  inbound: InboundDeliveryService;
  vault: VaultService;
}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(
    "/sendblue",
    createSendblueRouter({
      apiSecret: deps.sendblueApiSecret,
      ownerNumber: deps.ownerNumber,
      claim: (message) => deps.state.acceptInboundMessage(message),
      handle: (message) => deps.inbound.process(message),
    }),
  );
  app.use((req, res, next) => {
    if (isTrustedLocalRequest(req)) return next();
    res.status(404).json({ error: "not found" });
  });
  app.get("/health", (_req, res) => {
    const database = deps.state.db.pragma("quick_check", { simple: true });
    res.json({ ok: database === "ok", service: "boop", queueDepth: deps.messages.queue.depth });
  });
  app.post("/internal/approve", async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (!code) return res.status(400).json({ error: "code required" });
    const result = await deps.messages.approveFromTailscale(code);
    res.json({ ok: true, result });
  });
  app.post("/internal/backup", async (_req, res) => {
    const destination = process.env.BOOP_DATABASE_BACKUP_PATH ?? "/var/lib/boop/backup/boop.db";
    await deps.state.backup(destination);
    res.json({ ok: true, destination });
  });
  app.post("/internal/quiesce", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/internal/sync-ack", (req, res) => {
    const sha256 = typeof req.body?.sha256 === "string" ? req.body.sha256 : "";
    if (!/^[a-f0-9]{64}$/.test(sha256)) return res.status(400).json({ error: "sha256 required" });
    if (!deps.vault.acknowledgeBulkSync(sha256)) {
      return res.status(409).json({ error: "bulk sync authorization was not consumed" });
    }
    return res.json({ ok: true, consumed: true });
  });
  return app;
}

export function requiredOwnerNumber(): string {
  const number = normalizeE164(process.env.BOOP_OWNER_NUMBER);
  if (!number) throw new Error("BOOP_OWNER_NUMBER must be one valid E.164 number.");
  return number;
}
