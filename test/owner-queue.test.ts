import { describe, expect, it } from "vitest";
import { OwnerQueue } from "../server/owner-queue.js";

describe("owner queue", () => {
  it("reports cancellation when STOP arrives while a task is finishing", async () => {
    const queue = new OwnerQueue();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const result = queue.enqueue(async () => {
      await gate;
      return "completed";
    });

    expect(queue.stop()).toBe(1);
    finish();
    await expect(result).resolves.toBe("cancelled");
  });
});
