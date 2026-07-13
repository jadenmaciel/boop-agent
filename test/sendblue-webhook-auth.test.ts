import { describe, expect, it } from "vitest";
import {
  deriveWebhookSecret,
  parseApiWebhookListing,
  webhookCheck,
} from "../scripts/sendblue-webhook.mjs";
import {
  deriveSendblueWebhookSecret,
  verifySendblueWebhookSecret,
} from "../server/sendblue-webhook-auth.js";

describe("Sendblue webhook authentication", () => {
  it("derives the same scoped secret in registration and request handling", () => {
    const apiSecret = "test-api-secret-not-real";
    expect(deriveWebhookSecret(apiSecret)).toBe(deriveSendblueWebhookSecret(apiSecret));
  });

  it("accepts only the expected signing header", () => {
    const apiSecret = "test-api-secret-not-real";
    const signingSecret = deriveSendblueWebhookSecret(apiSecret);

    expect(verifySendblueWebhookSecret(signingSecret, apiSecret)).toBe(true);
    expect(verifySendblueWebhookSecret("wrong", apiSecret)).toBe(false);
    expect(verifySendblueWebhookSecret(undefined, apiSecret)).toBe(false);
    expect(verifySendblueWebhookSecret(signingSecret, "")).toBe(false);
  });

  it("parses URL and object webhook entries without treating the global secret as a URL", () => {
    expect(
      parseApiWebhookListing({
        receive: [
          "https://first.example/sendblue/webhook",
          { url: "https://second.example/sendblue/webhook", secret: "hidden" },
        ],
        globalSecret: "hidden",
      }),
    ).toEqual({
      current: [
        { type: "receive", url: "https://first.example/sendblue/webhook" },
        { type: "receive", url: "https://second.example/sendblue/webhook" },
      ],
      globalSecret: "hidden",
    });
  });

  it("does not report a registered webhook as healthy until signing is synchronized", () => {
    const url = "https://active.example/sendblue/webhook";
    const result = webhookCheck(url, [{ type: "receive", url }], "api", false);

    expect(result.ok).toBe(false);
    expect(result.state).toBe("mismatch");
    expect(result.details).toContain("signing secret is not synchronized");
  });
});
