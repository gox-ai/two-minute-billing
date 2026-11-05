/**
 * Outbound HTTP to URLs a tenant chose: webhook endpoints, partner transforms, logo images.
 *
 * Every such request goes through `outboundFetch`, which refuses to connect to a private,
 * loopback, link-local or otherwise non-public address (CWE-918). The check runs on the
 * RESOLVED address of every connection, redirects included, so a public name that later
 * resolves to 127.0.0.1 (DNS rebinding) or a public URL that redirects to the cloud
 * metadata service is refused the same way as a literal private IP.
 *
 * `assertPublicUrl` is the early check at write time, for a clear 400. It is a convenience,
 * not the control: DNS can change after the check.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { config } from "./config";

export class OutboundTargetError extends Error {
  constructor(public readonly address: string) {
    super(
      `We did not call this URL. It resolves to a private or local network address (${address}).`,
    );
    this.name = "OutboundTargetError";
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  // IPv4-mapped (::ffff:a.b.c.d) needs no rule: BlockList checks it against the IPv4 rules,
  // and a ::ffff:0:0/96 rule would match every IPv4 address.
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 embeds an arbitrary IPv4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10],
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

const privateAllowed = () => config.ALLOW_PRIVATE_OUTBOUND_URLS === "TRUE";

/** True when `ip` is not a public unicast address. Non-IP input is treated as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 0) return true;
  return blocked.check(bare, family === 4 ? "ipv4" : "ipv6");
}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, "", 0);
    const bad = privateAllowed() ? undefined : addresses.find((a) => isBlockedAddress(a.address));
    if (bad) return callback(new OutboundTargetError(bad.address), "", 0);
    if (options.all) {
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    }
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

// A literal IP never reaches `lookup`, so the connector checks it itself.
const baseConnect = buildConnector({ lookup: guardedLookup });
const agent = new Agent({
  connect: (opts, cb) => {
    const host = opts.hostname.replace(/^\[|\]$/g, "");
    if (!privateAllowed() && isIP(host) && isBlockedAddress(host)) {
      return cb(new OutboundTargetError(host), null);
    }
    return baseConnect(opts, cb);
  },
});

/**
 * `fetch` for a tenant-chosen URL. Same contract as the global `fetch`, except a non-public
 * target rejects with `OutboundTargetError` instead of being called.
 */
export async function outboundFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  try {
    const res = await undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    });
    return res as unknown as Response;
  } catch (e) {
    // undici wraps connect errors in `TypeError: fetch failed`; surface the refusal itself.
    const cause = (e as { cause?: unknown })?.cause;
    if (cause instanceof OutboundTargetError) throw cause;
    throw e;
  }
}

/**
 * Write-time check: refuse a URL whose host is, or currently resolves to, a non-public
 * address. A host that does not resolve passes — the dispatch-time guard still applies.
 */
export async function assertPublicUrl(raw: string): Promise<void> {
  if (privateAllowed()) return;
  let host: string;
  try {
    host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return; // shape is the schema's job
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new OutboundTargetError(host);
    return;
  }
  const addresses = await new Promise<LookupAddress[]>((resolve) =>
    dnsLookup(host, { all: true }, (err, a) => resolve(err ? [] : a)),
  );
  const bad = addresses.find((a) => isBlockedAddress(a.address));
  if (bad) throw new OutboundTargetError(bad.address);
}
