import { ConfirmationService } from "./confirmations.js";
import { OwnerQueue } from "./owner-queue.js";
import { PersonalAgent } from "./personal-agent.js";
import type { StoredMedia } from "./media-store.js";
import { sendImessage } from "./sendblue.js";
import { StateStore } from "./state.js";

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
    if (content.trim().toUpperCase() === "STOP") {
      const cancelled = this.queue.stop();
      const invalidated = this.state.cancelPendingActions();
      return `Stopped ${cancelled} active or queued task${cancelled === 1 ? "" : "s"} and cancelled ${invalidated} pending confirmation${invalidated === 1 ? "" : "s"}.`;
    }
    return await this.queue.enqueue(async (abort) => {
      const approval = this.confirmations.approveFromMessage(content);
      if (approval.ok) {
        if (!approval.ready) {
          return "iMessage approval recorded. Complete the Tailscale approval shown in the confirmation message.";
        }
        return await this.agent.executeApproved(approval.action);
      }
      return await this.agent.respond(conversationId, content, abort, images);
    }).then((result) => result === "cancelled" ? "Cancelled." : result);
  }

  async approveFromTailscale(code: string): Promise<string> {
    const approval = this.confirmations.approveFromTailscale(code);
    if (!approval.ok) return "No matching high-risk confirmation is pending.";
    if (!approval.ready) return "Tailscale approval recorded; iMessage approval is still required.";
    const result = await this.queue.enqueue(() => this.agent.executeApproved(approval.action));
    const reply = result === "cancelled" ? "Cancelled." : result;
    await sendImessage(this.ownerNumber, reply);
    return reply;
  }
}
