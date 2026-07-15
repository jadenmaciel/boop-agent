import {
  ConfirmationService,
  looksLikeConfirmationCode,
  redactConfirmationCodeForTranscript,
} from "./confirmations.js";
import { OwnerQueue } from "./owner-queue.js";
import { PersonalAgent } from "./personal-agent.js";
import type { StoredMedia } from "./media-store.js";
import { sendImessage } from "./sendblue.js";
import { StateStore } from "./state.js";
import type { AutomationRecord } from "./state.js";

export class OwnerMessageService {
  readonly queue = new OwnerQueue();

  constructor(
    private readonly state: StateStore,
    private readonly confirmations: ConfirmationService,
    private readonly agent: PersonalAgent,
    private readonly ownerNumber: string,
  ) {}

  async receive(conversationId: string, content: string, images: StoredMedia[] = []): Promise<void> {
    const reply = await this.process(conversationId, content, images);
    await sendImessage(this.ownerNumber, reply);
  }

  async process(conversationId: string, content: string, images: StoredMedia[] = []): Promise<string> {
    this.state.addMessage({
      conversationId,
      role: "user",
      content: redactConfirmationCodeForTranscript(content),
    });
    if (content.trim().toUpperCase() === "STOP") {
      const cancelled = this.queue.stop();
      const invalidated = this.state.cancelPendingActions();
      const discarded = this.state.cancelQueuedInboundMessages();
      const reply = `Stopped ${cancelled} active or queued task${cancelled === 1 ? "" : "s"}, cleared ${discarded} queued message${discarded === 1 ? "" : "s"}, and cancelled ${invalidated} pending confirmation${invalidated === 1 ? "" : "s"}.`;
      this.state.addMessage({ conversationId, role: "assistant", content: reply });
      return reply;
    }
    return await this.queue.enqueue(async (abort) => {
      const approval = this.confirmations.approveFromMessage(content);
      if (approval.ok) {
        if (!approval.ready) {
          const reply = "iMessage approval recorded. Complete the Tailscale approval shown in the confirmation message.";
          this.state.addMessage({ conversationId, role: "assistant", content: reply });
          return reply;
        }
        const reply = await this.agent.executeApproved(approval.action, abort.signal);
        this.state.addMessage({ conversationId, role: "assistant", content: reply });
        return reply;
      }
      if (looksLikeConfirmationCode(content)) {
        const reply = "No matching confirmation is pending. I did not execute anything.";
        this.state.addMessage({ conversationId, role: "assistant", content: reply });
        return reply;
      }
      return await this.agent.respond(conversationId, content, abort, images, {
        inputAlreadyRecorded: true,
      });
    }).then((result) => result === "cancelled" ? "Cancelled." : result);
  }

  async approveFromTailscale(code: string): Promise<string> {
    const approval = this.confirmations.approveFromTailscale(code);
    if (!approval.ok) return "No matching high-risk confirmation is pending.";
    if (!approval.ready) return "Tailscale approval recorded; iMessage approval is still required.";
    const result = await this.queue.enqueue((abort) =>
      this.agent.executeApproved(approval.action, abort.signal));
    if (result === "cancelled") {
      this.state.markDispatchingPendingActionUnknown(
        approval.action.id,
        approval.action.bindingMac,
        "Cancelled by STOP around the dispatch boundary; not retried",
      );
    }
    const reply = result === "cancelled"
      ? "STOP interrupted the approval. I will not retry it; verify the external result before trying again."
      : result;
    this.state.addMessage({
      conversationId: `sms:${this.ownerNumber}`,
      role: "assistant",
      content: reply,
    });
    await sendImessage(this.ownerNumber, reply);
    return reply;
  }

  async runAutomation(automation: AutomationRecord): Promise<string> {
    const result = await this.queue.enqueue((abort) =>
      this.agent.respond(
        automation.conversationId,
        `[owner-created automation: ${automation.name}] ${automation.task}`,
        abort,
        [],
        { allowedIntegrations: automation.integrations },
      ));
    if (result === "cancelled") throw new Error("Automation cancelled by STOP.");
    return result;
  }
}
