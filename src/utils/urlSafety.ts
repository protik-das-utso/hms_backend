// Defense against SSRF on tenant-supplied SMS gateway URLs (and any future
// outbound HTTP that takes a user-controlled URL).
//
// We block:
//   - Non-http(s) schemes (file://, gopher://, etc.)
//   - Hostnames that resolve to private/loopback/link-local IPs
//   - Numeric IP literals in private/loopback ranges
//   - Cloud metadata addresses (AWS 169.254.169.254 et al.)
//
// Unknown hostnames (DNS not resolvable) are allowed at validate time and
// rejected at dispatch time when the actual fetch fails — we deliberately
// don't do live DNS lookups during validation to avoid making this a slow
// network call.

import { ApiError } from "./ApiError";
import dns from "node:dns/promises";
import net from "node:net";

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];

const isPrivateV4 = (ip: string) => PRIVATE_V4.some((r) => r.test(ip));

const isPrivateV6 = (ip: string) => {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("fe80:")) return true; // link-local
  // IPv4-mapped IPv6 (::ffff:10.0.0.1)
  const v4mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (v4mapped && isPrivateV4(v4mapped[1])) return true;
  return false;
};

const isPrivateIp = (ip: string) =>
  net.isIPv4(ip) ? isPrivateV4(ip) : net.isIPv6(ip) ? isPrivateV6(ip) : false;

/**
 * Validate a tenant-supplied URL is safe to fetch from the server. Returns
 * the parsed URL on success; throws ApiError(400) with a clear reason on
 * failure. Pass `allowEmpty: true` to short-circuit on empty/null input.
 */
export const validatePublicUrl = (raw: string | null | undefined, opts: { allowEmpty?: boolean } = {}): URL | null => {
  if (raw == null || raw === "") {
    if (opts.allowEmpty) return null;
    throw ApiError.badRequest("URL is required");
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw ApiError.badRequest("Invalid URL — must include https:// or http://");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw ApiError.badRequest(`URL scheme not allowed: ${u.protocol}`);
  }
  // Reject userinfo like https://user:pass@host — common SSRF/credential trick.
  if (u.username || u.password) {
    throw ApiError.badRequest("URL must not contain credentials");
  }
  // Block IP-literal hosts that are private/loopback/metadata.
  const host = u.hostname;
  if (net.isIP(host) && isPrivateIp(host)) {
    throw ApiError.badRequest("URL points to a private/loopback address");
  }
  // Common metadata hostnames.
  if (
    host === "metadata.google.internal" ||
    host === "metadata.azure.com" ||
    host === "metadata"
  ) {
    throw ApiError.badRequest("URL points to a cloud metadata service");
  }
  // Block obvious local hosts.
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") {
    throw ApiError.badRequest("URL points to localhost");
  }
  return u;
};

/**
 * Stronger check used at dispatch time — resolves DNS and ensures every
 * returned A/AAAA record is public. Returns true on safe, false otherwise.
 * Catches DNS-rebinding attacks where a hostname briefly resolves to public
 * during validation but flips to 169.254.169.254 between requests.
 */
export const resolvesToPublicOnly = async (urlOrHost: string): Promise<boolean> => {
  let host: string;
  try {
    host = new URL(urlOrHost).hostname;
  } catch {
    host = urlOrHost;
  }
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.length === 0) return false;
    return addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
};
