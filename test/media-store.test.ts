import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaStore } from "../server/media-store.js";
import { StateStore } from "../server/state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("inbound media", () => {
  it("rejects content whose bytes do not match the declared image type", async () => {
    const root = mkdtempSync(join(tmpdir(), "boop-media-"));
    roots.push(root);
    const state = new StateStore(join(root, "boop.db"));
    const media = new MediaStore(
      state,
      join(root, "media"),
      async () => new Response("not a png", {
        headers: { "content-type": "image/png", "content-length": "9" },
      }),
      async (url) => url,
    );

    await expect(media.ingest("https://media.example/image.png")).rejects.toThrow(
      "Image bytes do not match its MIME type.",
    );
    state.close();
  });

  it("revalidates every media redirect before following it", async () => {
    const root = mkdtempSync(join(tmpdir(), "boop-media-"));
    roots.push(root);
    const state = new StateStore(join(root, "boop.db"));
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://metadata.internal/image.png" },
    }));
    const validate = vi.fn(async (url: string) => {
      if (url.includes("metadata.internal")) throw new Error("not public");
      return url;
    });
    const media = new MediaStore(state, join(root, "media"), fetcher, validate);

    await expect(media.ingest("https://media.example/image.png")).rejects.toThrow("not public");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(2);
    state.close();
  });
});
