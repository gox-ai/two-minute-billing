/**
 * Outbound HTTP to a URL an operator typed — a webhook endpoint, an invoice logo.
 *
 * Such a URL must not reach our own network: loopback, RFC 1918, link-local (cloud
 * metadata at 169.254.169.254), CGNAT, multicast and the other reserved ranges.
 * Checked at save time (`checkPublicUrl`, a clear 400) and again at connect time
 * (`guardedFetch`), because DNS can change after save. The connect-time check runs
 * inside the socket's own `lookup`, so the address we check is the address we dial —
 * a rebinding DNS answer has no second lookup to win. Redirects are never followed: a
 * public URL that answers 302 to a private one is the usual bypass.
 *
 * `WEBHOOK_ALLOW_PRIVATE_TARGETS=TRUE` turns the address check off (self-hosted, local
 * dev, verify suites). It is read per call, so a suite can flip it.
 */
import { BlockList, isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { config } from "@/platform/config";

export const PRIVATE_TARGET_MESSAGE =
  "The URL points to a private or reserved network address. We send only to public addresses";

export class EgressRefusedError extends Error {
  readonly code = "EGRESS_REFUSED";
  constructor(message = PRIVATE_TARGET_MESSAGE) {
    super(message);
    this.name = "EgressRefusedError";
  }
}

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

/** The eight 16-bit groups of an IPv6 address, or null if it does not parse. */
function v6Groups(ip: string): number[] | null {
  let s = ip.split("%")[0]!.toLowerCase();
  const dotted = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...tail].map((g) =>
    parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** The IPv4 address an IPv6 one carries (mapped, NAT64, 6to4), if any. */
function embeddedV4(g: number[]): string | null {
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return null;
}

/** True for any address we refuse to send to. A string that is not an IP is refused too. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family !== 6) return true;
  const groups = v6Groups(ip);
  if (!groups) return true;
  const inner = embeddedV4(groups);
  if (inner) return blocked.check(inner, "ipv4");
  return blocked.check(ip, "ipv6");
}

/** `URL.hostname` without IPv6 brackets or a trailing root dot. */
function bareHost(url: URL): string {
  return url.hostname
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isLocalName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

function resolveAll(host: string, timeoutMs: number): Promise<LookupAddress[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    dnsLookup(host, { all: true }, (err, addresses) => {
      clearTimeout(timer);
      resolve(err ? null : addresses);
    });
  });
}

/**
 * Save-time check: the refusal reason, or null when the URL may be stored.
 *
 * A name that does not resolve yet is allowed — the operator may be setting up DNS — and
 * `guardedFetch` checks it again on every send.
 */
export async function checkPublicUrl(raw: string): Promise<string | null> {
  if (config.WEBHOOK_ALLOW_PRIVATE_TARGETS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null; // the schema reports a malformed URL
  }
  const host = bareHost(url);
  if (isIP(host)) return isPrivateAddress(host) ? PRIVATE_TARGET_MESSAGE : null;
  if (isLocalName(host)) return PRIVATE_TARGET_MESSAGE;
  const addresses = await resolveAll(host, 3_000);
  return addresses?.some((a) => isPrivateAddress(a.address)) ? PRIVATE_TARGET_MESSAGE : null;
}

/** `net` lookup that refuses the connection when ANY resolved address is private. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(new EgressRefusedError() as NodeJS.ErrnoException, "", 0);
    }
    if (options.all) return (callback as (e: null, a: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

// Separate pools, so a socket opened with the check off is never reused with it on.
const agents = {
  guarded: {
    http: new http.Agent({ keepAlive: true, lookup: guardedLookup }),
    https: new https.Agent({ keepAlive: true, lookup: guardedLookup }),
  },
  open: {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({ keepAlive: true }),
  },
};

export interface GuardedRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * `fetch` for operator-typed URLs: refuses private targets and never follows a redirect
 * (a 3xx comes back as the response). Returns a standard `Response`.
 */
export function guardedFetch(raw: string, init: GuardedRequest = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      reject(new TypeError("Invalid URL"));
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new EgressRefusedError("The URL must use http or https"));
      return;
    }
    const allowPrivate = config.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    const host = bareHost(url);
    // `net` skips `lookup` for a literal address, so check it here.
    if (!allowPrivate && ((isIP(host) && isPrivateAddress(host)) || isLocalName(host))) {
      reject(new EgressRefusedError());
      return;
    }
    const pool = allowPrivate ? agents.open : agents.guarded;
    const headers: Record<string, string> = { ...init.headers };
    const names = Object.keys(headers).map((k) => k.toLowerCase());
    if (init.body !== undefined && !names.includes("content-length")) {
      headers["Content-Length"] = String(Buffer.byteLength(init.body));
    }
    if (!names.includes("user-agent")) headers["User-Agent"] = "TwoMinuteBilling/1.0";
    const req = (url.protocol === "https:" ? https : http).request(url, {
      method: init.method ?? "GET",
      headers,
      signal: init.signal,
      agent: url.protocol === "https:" ? pool.https : pool.http,
      ...(allowPrivate ? {} : { lookup: guardedLookup }),
    });
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 599) {
        res.destroy();
        reject(new Error(`The endpoint answered an HTTP status we cannot read (${status})`));
        return;
      }
      const out = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        try {
          out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
        } catch {
          // a header value the Fetch spec refuses; drop it
        }
      }
      const noBody = status === 204 || status === 205 || status === 304;
      if (noBody) res.resume();
      resolve(
        new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
          status,
          statusText: res.statusMessage ?? "",
          headers: out,
        }),
      );
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

/**
 * A network failure as a fixed sentence we can store and show. The raw error (an address,
 * a port, an OS message) goes to the log only.
 */
export function describeEgressError(e: unknown): string {
  if (e instanceof EgressRefusedError) return e.message;
  const err = e as { name?: string; code?: string } | null;
  const code = err?.code ?? "";
  if (err?.name === "AbortError" || err?.name === "TimeoutError" || code === "ABORT_ERR")
    return "The endpoint did not answer in time";
  if (code === "ENOTFOUND" || code.startsWith("EAI_"))
    return "We could not find the endpoint host in DNS";
  if (code === "ECONNREFUSED") return "The endpoint host refused the connection";
  if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET")
    return "The connection closed before the endpoint answered";
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO|DEPTH_ZERO|ERR_SSL/.test(code))
    return "We could not make a secure connection to the endpoint. Check its TLS certificate";
  return "We could not connect to the endpoint";
}
