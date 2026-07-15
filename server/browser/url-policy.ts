import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type ResolveHost = (hostname: string) => Promise<string[]>;
export interface PublicDownloadTarget {
  url: string;
  address: string;
}
let allowedDomainOverride: string[] | null = null;

export function setBrowserAllowedDomains(domains: string[]): void {
  allowedDomainOverride = domains.map(normalizeDomain).filter(Boolean);
}

export async function pinnedBrowserResolverArg(
  resolveHost: ResolveHost = resolveAddresses,
): Promise<string> {
  const configured = configuredDomains();
  if (configured.length === 0) throw new Error("No browser domains are approved.");
  const rules: string[] = [];
  for (const domain of configured) {
    if (isIP(domain)) {
      if (!isPublicAddress(domain)) throw new Error("Browser targets must resolve only to public addresses.");
      rules.push(`MAP ${domain} ${domain}`);
      continue;
    }
    const addresses = await resolveHost(domain);
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
      throw new Error(`Approved browser domain ${domain} did not resolve only to public addresses.`);
    }
    const selected = addresses.find((address) => isIP(address) === 4);
    if (!selected) throw new Error(`Approved browser domain ${domain} requires a public IPv4 address.`);
    rules.push(`MAP ${domain} ${selected}`);
  }
  rules.push("MAP * ~NOTFOUND");
  return `--host-resolver-rules=${rules.join(",")}`;
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
  return (await resolvePublicDownloadTarget(input, resolveHost)).url;
}

export async function resolvePublicDownloadTarget(
  input: string,
  resolveHost: ResolveHost = resolveAddresses,
): Promise<PublicDownloadTarget> {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) throw new Error("Browser URLs cannot contain credentials.");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Browser targets must resolve to a public address.");
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error("Browser targets must resolve only to public addresses.");
  }
  return { url: url.toString(), address: addresses[0]! };
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
  const configured = configuredDomains();
  if (!configured.length) throw new Error("No browser domains are approved.");
  if (!configured.includes(hostname)) {
    throw new Error(`Browser domain ${hostname} is not approved.`);
  }
}

function configuredDomains(): string[] {
  return allowedDomainOverride ?? process.env.BOOP_BROWSER_ALLOWED_DOMAINS?.split(",")
    .map(normalizeDomain)
    .filter(Boolean) ?? [];
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
