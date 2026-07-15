import express from "express";
import { redactContactHandle, redactPhoneNumbers } from "./privacy.js";
import { verifySendblueWebhookSecret } from "./sendblue-webhook-auth.js";

const API_BASE = "https://api.sendblue.com/api";
const MAX_CHUNK = 2_900;

export interface SendblueWebhookBody {
  content?: unknown;
  from_number?: unknown;
  is_outbound?: unknown;
  message_handle?: unknown;
  media_url?: unknown;
  media_urls?: unknown;
}

export interface AcceptedSendblueMessage {
  content: string;
  fromNumber: string;
  handle: string;
  mediaUrls: string[];
}

export interface SendblueWebhookDeps {
  apiSecret: string;
  ownerNumber: string;
  claim: (
    message: AcceptedSendblueMessage,
  ) => boolean | "accepted" | "duplicate" | "limited";
}

export function acceptSendblueWebhook(
  input: { signingSecret?: string; body: SendblueWebhookBody },
  deps: SendblueWebhookDeps,
):
  | { status: number; body: Record<string, unknown> }
  | { status: 202; body: { ok: true }; message: AcceptedSendblueMessage } {
  if (!verifySendblueWebhookSecret(input.signingSecret, deps.apiSecret)) {
    return { status: 401, body: { error: "invalid webhook signature" } };
  }
  const fromNumber = typeof input.body.from_number === "string"
    ? normalizeE164(input.body.from_number)
    : undefined;
  const content = typeof input.body.content === "string" ? input.body.content : "";
  const mediaUrls = extractSendblueMediaUrls(input.body.media_url, input.body.media_urls);
  if (input.body.is_outbound || !fromNumber || (!content && mediaUrls.length === 0)) {
    return { status: 200, body: { ok: true, skipped: true } };
  }
  if (fromNumber !== normalizeE164(deps.ownerNumber)) {
    return { status: 404, body: { error: "not found" } };
  }
  const handle = typeof input.body.message_handle === "string"
    ? input.body.message_handle.trim()
    : "";
  if (!handle) return { status: 400, body: { error: "message handle required" } };
  const message = { content, fromNumber, handle, mediaUrls };
  const claim = deps.claim(message);
  if (claim === "limited") return { status: 429, body: { error: "rate limit exceeded" } };
  if (claim === false || claim === "duplicate") {
    return { status: 200, body: { ok: true, deduped: true } };
  }
  return {
    status: 202,
    body: { ok: true },
    message,
  };
}

export function createSendblueRouter(
  deps: SendblueWebhookDeps & {
    handle: (message: AcceptedSendblueMessage) => Promise<void>;
  },
): express.Router {
  const router = express.Router();
  router.post("/webhook", (req, res) => {
    const accepted = acceptSendblueWebhook(
      { signingSecret: req.get("sb-signing-secret"), body: req.body ?? {} },
      deps,
    );
    res.status(accepted.status).json(accepted.body);
    if ("message" in accepted) {
      void deps.handle(accepted.message).catch(() => {
        console.error("[sendblue] authorized message handler failed; durable retry remains pending");
      });
    }
  });
  return router;
}

export function extractSendblueMediaUrls(mediaUrl: unknown, mediaUrls: unknown): string[] {
  const urls = new Set<string>();
  if (Array.isArray(mediaUrls)) {
    for (const value of mediaUrls) {
      if (typeof value === "string" && value.trim()) urls.add(value.trim());
    }
  }
  if (typeof mediaUrl === "string" && mediaUrl.trim()) urls.add(mediaUrl.trim());
  return [...urls];
}

export async function sendImessage(toNumber: string, text: string): Promise<void> {
  const apiKey = requiredEnv("SENDBLUE_API_KEY");
  const apiSecret = requiredEnv("SENDBLUE_API_SECRET");
  const fromNumber = normalizeE164(requiredEnv("SENDBLUE_FROM_NUMBER"));
  const recipient = normalizeE164(toNumber);
  if (!fromNumber || !recipient) throw new Error("Sendblue phone number is invalid.");
  const headers = {
    "Content-Type": "application/json",
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": apiSecret,
  };
  const plain = redactPhoneNumbers(stripMarkdown(text));
  for (const part of chunk(plain)) {
    const response = await fetch(`${API_BASE}/send-message`, {
      method: "POST",
      headers,
      body: JSON.stringify({ number: recipient, content: part, from_number: fromNumber }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body = redactPhoneNumbers(await response.text().catch(() => ""));
      throw new Error(`Sendblue returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    console.log(`[sendblue] sent ${part.length} characters to ${redactContactHandle(recipient)}`);
  }
}

export function normalizeE164(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
  if (/^[1-9]\d{10,14}$/.test(trimmed)) return `+${trimmed}`;
  return undefined;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const parts: string[] = [];
  for (let offset = 0; offset < text.length; offset += MAX_CHUNK) {
    parts.push(text.slice(offset, offset + MAX_CHUNK));
  }
  return parts;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
