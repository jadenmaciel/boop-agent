import { beforeEach, describe, expect, it } from "vitest";
import { assertPublicHttpUrl, setBrowserAllowedDomains } from "../server/browser/url-policy.js";

describe("browser URL policy", () => {
  beforeEach(() => setBrowserAllowedDomains(["example.com", "metadata.example"]));

  it("blocks internal targets after DNS resolution", async () => {
    await expect(
      assertPublicHttpUrl("http://metadata.example/path", async () => ["169.254.169.254"]),
    ).rejects.toThrow(/public/);
    await expect(
      assertPublicHttpUrl("https://example.com", async () => ["93.184.216.34"]),
    ).resolves.toBe("https://example.com/");
  });

  it("enforces the owner-configured public-domain allowlist", async () => {
    setBrowserAllowedDomains(["example.com"]);
    await expect(
      assertPublicHttpUrl("https://mail.example.com", async () => ["93.184.216.34"]),
    ).resolves.toBe("https://mail.example.com/");
    await expect(
      assertPublicHttpUrl("https://unapproved.test", async () => ["93.184.216.34"]),
    ).rejects.toThrow(/not approved/);
  });

  it("fails closed when no public domains are approved", async () => {
    setBrowserAllowedDomains([]);
    await expect(
      assertPublicHttpUrl("https://example.com", async () => ["93.184.216.34"]),
    ).rejects.toThrow(/No browser domains/);
  });
});
