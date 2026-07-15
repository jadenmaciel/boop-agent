import { beforeEach, describe, expect, it } from "vitest";
import {
  assertPublicHttpUrl,
  pinnedBrowserResolverArg,
  resolvePublicDownloadTarget,
  setBrowserAllowedDomains,
} from "../server/browser/url-policy.js";

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
    setBrowserAllowedDomains(["mail.example.com"]);
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

  it("pins every exact approved hostname and blocks all other DNS", async () => {
    setBrowserAllowedDomains(["mail.example.com"]);
    await expect(pinnedBrowserResolverArg(async () => ["93.184.216.34"]))
      .resolves.toBe(
        "--host-resolver-rules=MAP mail.example.com 93.184.216.34,MAP * ~NOTFOUND",
      );
    await expect(pinnedBrowserResolverArg(async () => ["127.0.0.1"]))
      .rejects.toThrow(/public/);
  });

  it("returns the validated address used by pinned media downloads", async () => {
    await expect(resolvePublicDownloadTarget(
      "https://media.example/image.png",
      async () => ["93.184.216.34"],
    )).resolves.toEqual({
      url: "https://media.example/image.png",
      address: "93.184.216.34",
    });
  });
});
