import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

// ─────────────────────────────────────────────────────────────────────────────
// SSRF / egress protection for target-DB connections (spec §7, §17). Shared by
// gateway-api (test-connection) and worker-core (job execution).
//
// DENY by default: loopback, private, link-local, and cloud-metadata ranges.
// The RESOLVED IP is validated (not just the name) to defeat DNS rebinding.
// An admin allow-list (hosts or CIDRs) permits otherwise-denied targets.
// ─────────────────────────────────────────────────────────────────────────────

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const DENY_RANGES = new Set([
  'unspecified',
  'loopback',
  'private',
  'linkLocal', // covers 169.254.169.254 cloud metadata
  'uniqueLocal',
  'carrierGradeNat',
  'reserved',
  'broadcast',
]);

function ipIsDenied(ip: string): boolean {
  try {
    return DENY_RANGES.has(ipaddr.process(ip).range());
  } catch {
    return true;
  }
}

function isAllowlisted(host: string, ip: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    if (entry === host || entry === ip) return true;
    if (entry.includes('/')) {
      try {
        const [range, bits] = ipaddr.parseCIDR(entry);
        const addr = ipaddr.process(ip);
        if (addr.kind() === range.kind() && addr.match(range, bits)) return true;
      } catch {
        /* malformed CIDR — ignore */
      }
    }
  }
  return false;
}

/** Parse SSRF_ALLOWLIST env into an array. */
export function envAllowlist(): string[] {
  return (process.env.SSRF_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface SsrfCheckResult {
  resolvedIps: string[];
}

export async function assertHostAllowed(
  host: string,
  allowlist: string[] = [],
): Promise<SsrfCheckResult> {
  let results: { address: string }[];
  try {
    results = await lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new SsrfError(`cannot resolve host "${host}": ${(err as Error).message}`);
  }
  const resolvedIps = results.map((r) => r.address);
  if (resolvedIps.length === 0) throw new SsrfError(`host "${host}" resolved to no addresses`);

  for (const ip of resolvedIps) {
    if (ipIsDenied(ip) && !isAllowlisted(host, ip, allowlist)) {
      throw new SsrfError(
        `connection to "${host}" (${ip}) is blocked: address is in a denied range and not allow-listed`,
      );
    }
  }
  return { resolvedIps };
}
