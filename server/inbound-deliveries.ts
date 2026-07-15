import { MediaStore } from "./media-store.js";
import { OwnerMessageService } from "./owner-messages.js";
import { sendImessage, type AcceptedSendblueMessage } from "./sendblue.js";
import { StateStore } from "./state.js";

export class InboundDeliveryService {
  constructor(
    private readonly state: StateStore,
    private readonly messages: OwnerMessageService,
    private readonly media: MediaStore,
    private readonly ownerNumber: string,
  ) {}

  async recover(): Promise<void> {
    for (const message of this.state.pendingInboundMessages()) {
      try {
        await this.process(message);
      } catch {
        console.error(`[boop] inbound delivery retry failed for opaque handle suffix ${message.handle.slice(-6)}`);
      }
    }
  }

  async process(message: AcceptedSendblueMessage): Promise<void> {
    const claimed = this.state.claimInboundMessage(message.handle);
    if (!claimed) return;
    try {
      let reply = claimed.response;
      if (reply === null) {
        const images = [];
        const errors: string[] = [];
        for (const url of claimed.mediaUrls) {
          try {
            images.push(await this.media.ingest(url));
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        const content = errors.length
          ? `${claimed.content}\n[Some inbound media could not be loaded: ${errors.join("; ")}]`
          : claimed.content;
        reply = await this.messages.process(`sms:${claimed.fromNumber}`, content, images);
        this.state.setInboundResponse(claimed.handle, reply);
        const ready = this.state.claimInboundMessage(claimed.handle);
        if (!ready) throw new Error("Could not claim the prepared owner reply.");
      }
      await sendImessage(this.ownerNumber, reply);
      this.state.completeInboundMessage(claimed.handle);
    } catch (error) {
      this.state.retryInboundMessage(claimed.handle);
      throw error;
    }
  }
}
