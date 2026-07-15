import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPublicDownloadUrl } from "./browser/url-policy.js";
import { MAX_IMAGE_BYTES, validateImageHeader, type ImageMediaType } from "./images/mime.js";
import { StateStore } from "./state.js";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1_000;

export interface StoredMedia {
  id: string;
  mediaType: ImageMediaType;
  data: Buffer;
}

export class MediaStore {
  constructor(
    private readonly state: StateStore,
    private readonly root = process.env.BOOP_MEDIA_ROOT ?? "/var/lib/boop/media",
    private readonly fetcher: typeof fetch = fetch,
    private readonly validateUrl: (url: string) => Promise<string> = assertPublicDownloadUrl,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }

  async ingest(url: string, now = Date.now()): Promise<StoredMedia> {
    const safeUrl = await this.validateUrl(url);
    if (!safeUrl.startsWith("https://")) throw new Error("Inbound media must use HTTPS.");
    const response = await this.fetcher(safeUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Media download returned HTTP ${response.status}.`);
    const lengthHeader = response.headers.get("content-length");
    const header = validateImageHeader({
      contentType: response.headers.get("content-type") ?? undefined,
      contentLength: lengthHeader ? Number(lengthHeader) : undefined,
    });
    if (!header.ok) throw new Error(header.reason);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Media response has no body.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Image exceeds 10 MB.");
      }
      chunks.push(value);
    }
    const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
    if (!hasExpectedMagic(data, header.mediaType)) throw new Error("Image bytes do not match its MIME type.");
    const id = randomUUID();
    const path = join(this.root, id);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, data, { mode: 0o600 });
    renameSync(temporary, path);
    this.state.addMedia({
      id,
      path,
      mediaType: header.mediaType,
      size,
      expiresAt: now + THREE_DAYS_MS,
      now,
    });
    return { id, mediaType: header.mediaType, data };
  }

  read(id: string, mediaType: ImageMediaType): StoredMedia {
    return { id, mediaType, data: readFileSync(join(this.root, id)) };
  }

  markSaved(id: string): void {
    const path = this.state.mediaPath(id);
    if (path) rmSync(path, { force: true });
    this.state.deleteMedia(id);
  }

  cleanup(now = Date.now()): number {
    const expired = this.state.expiredMedia(now);
    for (const media of expired) {
      rmSync(media.path, { force: true });
      this.state.deleteMedia(media.id);
    }
    return expired.length;
  }
}

function hasExpectedMagic(data: Buffer, mediaType: ImageMediaType): boolean {
  if (mediaType === "image/jpeg") return data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (mediaType === "image/png") {
    return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mediaType === "image/gif") return /^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"));
  return data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
}
