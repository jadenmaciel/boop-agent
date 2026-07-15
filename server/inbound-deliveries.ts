import { MediaStore } from "./media-store.js";
import { OwnerMessageService } from "./owner-messages.js";
import { sendImessage, type AcceptedSendblueMessage } from "./sendblue.js";
import { StateStore } from "./state.js";

export class InboundDeliveryService {
  private drainPromise: Promise<void> | null = null;

  constructor(
    private readonly state: StateStore,
    private readonly messages: OwnerMessageService,
    private readonly media: MediaStore,
    private readonly ownerNumber: string,
  ) {}

  async recover(): Promise<void> {
    await this.drain();
  }

  async process(message: AcceptedSendblueMessage): Promise<void> {
    if (message.content.trim().toUpperCase() === "STOP") {
      await this.processOne(message);
      return;
    }
    await this.drain();
  }

  private drain(): Promise<void> {
    this.drainPromise ??= this.drainInOrder().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drainInOrder(): Promise<void> {
    while (true) {
      const next = this.state.pendingInboundMessages(1)[0];
      if (!next) return;
      try {
        await this.processOne(next);
      } catch {
        console.error(`[boop] inbound delivery retry failed for opaque handle suffix ${next.handle.slice(-6)}`);
        return;
      }
    }
  }

  private async processOne(message: AcceptedSendblueMessage): Promise<void> {
    const claimed = this.state.claimInboundMessage(message.handle);
    if (!claimed) return;
    try {
      let reply = claimed.response;
      if (reply === null) {
        const images = [];
        const errors: string[] = [];
        const mediaUrls = claimed.content.trim().toUpperCase() === "STOP" ? [] : claimed.mediaUrls;
        for (const url of mediaUrls) {
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
