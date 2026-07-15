import { afterEach, describe, expect, it } from "vitest";
import {
  composioToolEffect,
  validateComposioConnectionRequest,
} from "../server/composio.js";

const originalPolicy = process.env.BOOP_COMPOSIO_POLICY_JSON;

afterEach(() => {
  if (originalPolicy === undefined) delete process.env.BOOP_COMPOSIO_POLICY_JSON;
  else process.env.BOOP_COMPOSIO_POLICY_JSON = originalPolicy;
});

describe("Composio maintenance policy", () => {
  it("fails closed for undeclared tools and OAuth scopes", () => {
    process.env.BOOP_COMPOSIO_POLICY_JSON = JSON.stringify({
      gmail: {
        read: ["GMAIL_FETCH_EMAILS"],
        write: ["GMAIL_SEND_EMAIL"],
        scopes: ["gmail.readonly"],
      },
    });

    expect(composioToolEffect("gmail", "GMAIL_FETCH_EMAILS")).toBe("read");
    expect(composioToolEffect("gmail", "GMAIL_SEND_EMAIL")).toBe("write");
    expect(composioToolEffect("gmail", "GMAIL_DELETE_EMAIL")).toBeNull();
    expect(() => validateComposioConnectionRequest("gmail", ["gmail.readonly"]))
      .not.toThrow();
    expect(() => validateComposioConnectionRequest("gmail", ["gmail.modify"]))
      .toThrow(/not approved/);
  });
});
