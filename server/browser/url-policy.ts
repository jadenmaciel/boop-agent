import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type ResolveHost = (hostname: string) => Promise<string[]>;
let allowedDomainOverride: string[] | null = null;

export function setBrowserAllowedDomains(domains: string[]): void {
  allowedDomainOverride = domains.map(normalizeDomain).filter(Boolean);
}

export async function assertPublicHttpUrl(
  input: string,
  resolveHost: ResolveHost = resolveAddresses,
): Promise<string> {
  return validatePublicHttpUrl(input, resolveHost, true);
}

export async function assertPublicDownloadUrl(
  input: string,
  resolveHost: ResolveHost = resolveAddresses,
): Promise<string> {
  return validatePublicHttpUrl(input, resolveHost, false);
}

async function validatePublicHttpUrl(
  input: string,
  resolveHost: ResolveHost,
  requireApprovedDomain: boolean,
): Promise<string> {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) throw new Error("Browser URLs cannot contain credentials.");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Browser targets must resolve to a public address.");
  }
  if (requireApprovedDomain) assertAllowedDomain(hostname);
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error("Browser targets must resolve only to public addresses.");
  }
  return url.toString();
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function assertAllowedDomain(hostname: string): void {
  const configured = allowedDomainOverride ?? process.env.BOOP_BROWSER_ALLOWED_DOMAINS?.split(",")
    .map(normalizeDomain)
    .filter(Boolean);
  if (!configured?.length) throw new Error("No browser domains are approved.");
  if (!configured.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new Error(`Browser domain ${hostname} is not approved.`);
  }
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

function isPublicAddress(address: string): boolean {
  if (address.toLowerCase().startsWith("::ffff:")) {
    return isPublicAddress(address.slice("::ffff:".length));
  }
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized)
    );
  }
  return false;
}
