import "./env-setup.js";
import { createServer } from "node:http";
import { createApp, requiredOwnerNumber } from "./app.js";
import { nextRunFor, startAutomationLoop } from "./automation-runner.js";
import { closeLocalBrowser } from "./browser/launcher.js";
import { setBrowserAllowedDomains } from "./browser/url-policy.js";
import { ConfirmationService } from "./confirmations.js";
import { OwnerMessageService } from "./owner-messages.js";
import { MediaStore } from "./media-store.js";
import { InboundDeliveryService } from "./inbound-deliveries.js";
import { PersonalAgent } from "./personal-agent.js";
import { getStateStore } from "./state-instance.js";
import { VaultService } from "./vault.js";

const state = getStateStore();
setBrowserAllowedDomains(
  (state.getSetting("browser_allowed_domains") ?? process.env.BOOP_BROWSER_ALLOWED_DOMAINS ?? "")
    .split(",")
    .filter(Boolean),
);
const ownerNumber = requiredOwnerNumber();
const hmacSecret = requiredEnv("BOOP_CONFIRMATION_HMAC_SECRET");
const sendblueApiSecret = requiredEnv("SENDBLUE_API_SECRET");
const confirmations = new ConfirmationService(state, { hmacSecret });
const vault = new VaultService(undefined, state);
const media = new MediaStore(state);
const agent = new PersonalAgent(state, confirmations, vault, media);
const messages = new OwnerMessageService(state, confirmations, agent, ownerNumber);
const inbound = new InboundDeliveryService(state, messages, media, ownerNumber);
state.requeueInboundMessages();
state.markInterruptedPendingActionsUnknown();
state.recoverInterruptedAutomationRuns(nextRunFor);
const app = createApp({
  state,
  confirmations,
  agent,
  messages,
  ownerNumber,
  sendblueApiSecret,
  inbound,
});
const server = createServer(app);
const stopAutomations = startAutomationLoop(state, messages);
const mediaCleanup = setInterval(() => media.cleanup(), 60 * 60 * 1_000);
mediaCleanup.unref();
const operationalRetention = setInterval(
  () => state.pruneOperationalRecords(),
  24 * 60 * 60 * 1_000,
);
operationalRetention.unref();
const inboundRecovery = setInterval(() => void inbound.recover(), 30_000);
inboundRecovery.unref();
const port = Number(process.env.PORT ?? 3456);

server.listen(port, "127.0.0.1", () => {
  console.log(`[boop] listening on 127.0.0.1:${port}`);
  void inbound.recover().catch(() => {
    console.error("[boop] inbound recovery loop failed");
  });
});

let closing = false;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    stopAutomations();
    clearInterval(mediaCleanup);
    clearInterval(operationalRetention);
    clearInterval(inboundRecovery);
    server.close(() => {
      void closeLocalBrowser().finally(() => {
        state.close();
        process.exit(0);
      });
    });
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
