import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { StateStore, type ActionRiskTier, type PendingActionRecord } from "./state.js";

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;
const ONE_HOUR_MS = 60 * 60 * 1_000;

export interface ActionProvenance {
  source: string;
  reference: string;
}

export interface StageActionInput {
  kind: string;
  summary: string;
  payload: unknown;
  provenance: ActionProvenance[];
  riskTier: ActionRiskTier;
  now?: number;
}

export interface StagedAction {
  id: string;
  code: string;
  expiresAt: number;
  payloadHash: string;
  prompt: string;
}

export class ConfirmationService {
  private readonly codeGenerator: () => string;

  constructor(
    private readonly store: StateStore,
    private readonly options: { hmacSecret: string; codeGenerator?: () => string },
  ) {
    if (options.hmacSecret.length < 16) throw new Error("Confirmation HMAC secret is too short.");
    this.codeGenerator = options.codeGenerator ?? generateCode;
  }

  stage(input: StageActionInput): StagedAction {
    const now = input.now ?? Date.now();
    const code = normalizeCode(this.codeGenerator());
    if (!new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code)) {
      throw new Error("Confirmation code generator returned an invalid code.");
    }
    const canonicalPayload = canonicalJson(input.payload);
    const payloadHash = createHash("sha256").update(canonicalPayload).digest("hex");
    const id = randomUUID();
    const expiresAt = now + ONE_HOUR_MS;
    const codeHash = this.hashCode(code);
    const provenance = canonicalJson(input.provenance);
    const bindingMac = this.bindingMac({
      id,
      codeHash,
      canonicalPayload,
      payloadHash,
      provenance,
      riskTier: input.riskTier,
      expiresAt,
    });
    this.store.createPendingAction({
      id,
      kind: input.kind,
      summary: input.summary,
      canonicalPayload,
      payloadHash,
      provenance,
      riskTier: input.riskTier,
      codeHash,
      bindingMac,
      expiresAt,
      now,
    });
    const sourceLines = input.provenance.map(
      (source) => `Source: ${source.source} (${source.reference})`,
    );
    const secondFactor =
      input.riskTier === "high"
        ? `\nThen run: boop approve ${code} over Tailscale SSH.`
        : "";
    return {
      id,
      code,
      expiresAt,
      payloadHash,
      prompt: `${input.summary}\nDetails: ${canonicalPayload}\n${sourceLines.join("\n")}\nReply with ${code} within one hour.${secondFactor}`,
    };
  }

  approveFromMessage(code: string, now = Date.now()) {
    return this.approve(code, "message", now);
  }

  approveFromTailscale(code: string, now = Date.now()) {
    return this.approve(code, "tailscale", now);
  }

  private approve(code: string, channel: "message" | "tailscale", now: number) {
    const normalized = normalizeCode(code);
    if (!new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(normalized)) {
      return { ok: false } as const;
    }
    const result = this.store.approvePendingAction(this.hashCode(normalized), channel, now);
    return result ? ({ ok: true, ...result } as const) : ({ ok: false } as const);
  }

  private hashCode(code: string): string {
    return createHmac("sha256", this.options.hmacSecret).update(code).digest("hex");
  }

  verifyAction(action: PendingActionRecord): boolean {
    const stored = Buffer.from(action.bindingMac, "hex");
    const expected = Buffer.from(this.bindingMac(action), "hex");
    return stored.length === expected.length && timingSafeEqual(stored, expected);
  }

  private bindingMac(action: Pick<
    PendingActionRecord,
    "id" | "codeHash" | "canonicalPayload" | "payloadHash" | "provenance" | "riskTier" | "expiresAt"
  >): string {
    const material = canonicalJson({
      id: action.id,
      codeHash: action.codeHash,
      canonicalPayload: action.canonicalPayload,
      payloadHash: action.payloadHash,
      provenance: action.provenance,
      riskTier: action.riskTier,
      expiresAt: action.expiresAt,
    });
    return createHmac("sha256", this.options.hmacSecret).update(material).digest("hex");
  }
}

export function redactConfirmationCodeForTranscript(text: string): string {
  const pattern = `[${CODE_ALPHABET}]{${CODE_LENGTH}}`;
  if (looksLikeConfirmationCode(text)) {
    return "[confirmation code submitted]";
  }
  return text
    .replace(new RegExp(`Reply with ${pattern} within one hour\\.`, "gi"),
      "Reply with [confirmation code] within one hour.")
    .replace(new RegExp(`boop approve ${pattern}`, "gi"), "boop approve [confirmation code]");
}

export function looksLikeConfirmationCode(text: string): boolean {
  return new RegExp(`^\\s*[${CODE_ALPHABET}]{${CODE_LENGTH}}\\s*$`, "i").test(text);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}
