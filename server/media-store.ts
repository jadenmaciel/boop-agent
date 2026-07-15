import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  assertPublicDownloadUrl,
  resolvePublicDownloadTarget,
  type PublicDownloadTarget,
} from "./browser/url-policy.js";
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
    private readonly fetcher?: typeof fetch,
    private readonly validateUrl: (url: string) => Promise<string> = assertPublicDownloadUrl,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }

  async ingest(url: string, now = Date.now()): Promise<StoredMedia> {
    const response = await this.fetchWithValidatedRedirects(url);
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

  private async fetchWithValidatedRedirects(input: string): Promise<Response> {
    let current = input;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const target = this.fetcher ? null : await resolvePublicDownloadTarget(current);
      const safeUrl = target?.url ?? await this.validateUrl(current);
      if (!safeUrl.startsWith("https://")) throw new Error("Inbound media must use HTTPS.");
      const response = this.fetcher
        ? await this.fetcher(safeUrl, {
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
          })
        : await pinnedHttpsResponse(target!);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) throw new Error("Media redirect has no Location header.");
      if (redirects === 5) throw new Error("Media download exceeded five redirects.");
      await response.body?.cancel();
      current = new URL(location, safeUrl).toString();
    }
    throw new Error("Media download exceeded five redirects.");
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

function pinnedHttpsResponse(target: PublicDownloadTarget): Promise<Response> {
  const url = new URL(target.url);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: target.address,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: url.hostname,
      headers: { host: url.host },
      timeout: 15_000,
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      resolve(new Response(Readable.toWeb(response) as ReadableStream, {
        status: response.statusCode ?? 500,
        headers,
      }));
    });
    req.once("timeout", () => req.destroy(new Error("Media download timed out.")));
    req.once("error", reject);
    req.end();
  });
}

function hasExpectedMagic(data: Buffer, mediaType: ImageMediaType): boolean {
  if (mediaType === "image/jpeg") return data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (mediaType === "image/png") {
    return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mediaType === "image/gif") return /^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"));
  return data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
}
