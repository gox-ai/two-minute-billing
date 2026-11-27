/**
 * Open and click tracking, pure parts: signed references, the HTML rewrite and the machine
 * classification. No database here; `tracking-service.ts` records.
 *
 * Our rules: the pixel goes in the HTML part only; a link is rewritten only when it is http(s);
 * mailto, tel, in-page anchors and unsubscribe links are never rewritten; the redirect target
 * comes from our own table, never from the request.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "@/platform/config";
import { isBot } from "@/modules/storefront-analytics/user-agent";

export type TokenKind = "o" | "c";

const key = () =>
  createHmac("sha256", config.API_KEY_SECRET).update("tmbilling:email-engagement:v1").digest();

const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ""), "hex");
const bytesUuid = (b: Buffer) => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `o` = the open pixel (position 0); `c` = link `position`. 16-byte id + 2-byte position + 12-byte MAC. */
export function signToken(kind: TokenKind, emailId: string, position = 0): string {
  if (!UUID.test(emailId)) throw new Error("email id must be a uuid");
  const body = Buffer.concat([
    uuidBytes(emailId),
    Buffer.from([(position >> 8) & 255, position & 255]),
  ]);
  const mac = createHmac("sha256", key()).update(kind).update(body).digest().subarray(0, 12);
  return Buffer.concat([body, mac]).toString("base64url");
}

/** Null for anything not made by `signToken` with this kind. */
export function verifyToken(
  kind: TokenKind,
  token: string,
): { emailId: string; position: number } | null {
  if (!/^[A-Za-z0-9_-]{40}$/.test(token)) return null;
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== 30) return null;
  const body = raw.subarray(0, 18);
  const mac = createHmac("sha256", key()).update(kind).update(body).digest().subarray(0, 12);
  if (!timingSafeEqual(mac, raw.subarray(18))) return null;
  return { emailId: bytesUuid(body.subarray(0, 16)), position: (body[16]! << 8) | body[17]! };
}

/** Public base of this API for tracking links; null = tracking cannot be added. */
export function trackingBase(): string | null {
  const b = config.ADVERTISED_API_URL;
  return b ? b.replace(/\/+$/, "") : null;
}

export const pixelUrl = (base: string, emailId: string) =>
  `${base}/e/o/${signToken("o", emailId)}.gif`;
export const clickUrl = (base: string, emailId: string, position: number) =>
  `${base}/e/c/${signToken("c", emailId, position)}`;

// --- HTML ---------------------------------------------------------------------------------

export interface TrackedLink {
  position: number;
  url: string;
  label: string | null;
}

const MAX_LINKS = 60;
const MAX_URL = 2048;

const ENTITY: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}

/** Anchor text as a short label: no tags, one line, 60 characters, nothing that looks like an address. */
export function labelOf(inner: string): string | null {
  const t = decodeEntities(inner.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.includes("@")) return null;
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

/** Whether a link may be rewritten. */
export function isTrackable(url: string): boolean {
  if (url.length > MAX_URL || !/^https?:\/\//i.test(url)) return false;
  return !/unsubscribe/i.test(url);
}

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /(\bhref\s*=\s*)(?:"([^"]*)"|'([^']*)')/i;

/**
 * Send every trackable link of `html` through `redirect(position)`. Other attributes, the
 * anchor text and every other tag stay as they were. The same URL twice gets two positions,
 * so each anchor has its own label.
 */
export function rewriteLinks(
  html: string,
  redirect: (position: number) => string,
): { html: string; links: TrackedLink[] } {
  const links: TrackedLink[] = [];
  const out = html.replace(ANCHOR, (whole, attrs: string, inner: string) => {
    const m = HREF.exec(attrs);
    if (!m || links.length >= MAX_LINKS) return whole;
    const url = decodeEntities((m[2] ?? m[3] ?? "").trim());
    if (!isTrackable(url)) return whole;
    const position = links.length + 1;
    links.push({ position, url, label: labelOf(inner) });
    const quote = m[2] !== undefined ? '"' : "'";
    const newAttrs = attrs.replace(HREF, `$1${quote}${redirect(position)}${quote}`);
    return whole.replace(attrs, () => newAttrs);
  });
  return { html: out, links };
}

/** A 1x1 image before `</body>`, else at the end. HTML part only. */
export function addPixel(html: string, src: string): string {
  const img = `<img src="${src}" width="1" height="1" alt="" border="0" style="display:block;width:1px;height:1px;border:0;" />`;
  const i = html.search(/<\/body\s*>/i);
  return i === -1 ? html + img : html.slice(0, i) + img + html.slice(i);
}

/**
 * The HTML to send. `links` holds what the redirect must be able to find; empty with
 * `pixelOnly`-style callers when a click rewrite is not wanted.
 */
export function instrumentHtml(
  html: string,
  emailId: string,
  base: string,
): { html: string; links: TrackedLink[] } {
  const r = rewriteLinks(html, (p) => clickUrl(base, emailId, p));
  return { html: addPixel(r.html, pixelUrl(base, emailId)), links: r.links };
}

/**
 * A link's host and path for the report. A path segment that is not a plain word (an id, a
 * token) becomes `:id`, and the query and fragment are dropped, so a portal link's access
 * token is never kept.
 */
export function linkShape(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    const segs = u.pathname
      .split("/")
      .filter(Boolean)
      .map((s) => (/^[a-z][a-z-]{0,23}$/i.test(s) ? s.toLowerCase() : ":id"));
    return { host: u.hostname.toLowerCase(), path: `/${segs.join("/")}` };
  } catch {
    return null;
  }
}

// --- Machine classification ---------------------------------------------------------------

/** Mail security gateways and link checkers that fetch a link before the person does. */
const SCANNER_UA =
  /proofpoint|mimecast|barracuda|safelinks|office\s?365|ms-?office|microsoft office|bingpreview|forcepoint|symantec|trendmicro|sophos|fireeye|cisco|avanan|urldefense|messagelabs|zscaler|check\s?point|mailscanner/i;
const GOOGLE_PROXY = /googleimageproxy|via ggpht\.com/i;

/** Apple Mail Privacy Protection fetches through addresses in 17.0.0.0/8. */
export function isAppleProxyIp(ip: string | null | undefined): boolean {
  const m = /^(?:::ffff:)?(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(ip ?? "");
  return !!m && Number(m[1]) === 17;
}

/** A click this soon after we handed the email to the relay cannot be a person. */
export const SCANNER_WINDOW_MS = 5_000;
/** The same for the Google image proxy: a fetch this soon is a prefetch or a scan. */
export const GOOGLE_PROXY_WINDOW_MS = 10_000;

export type MachineReason =
  | "apple_proxy"
  | "google_proxy_prefetch"
  | "scanner"
  | "head_request"
  | "bot"
  | "too_fast";

export function classifyEngagement(i: {
  kind: "open" | "click";
  method: string;
  userAgent: string | null | undefined;
  /** Used for the check only; never stored. */
  ip: string | null | undefined;
  /** Milliseconds from the send to this request; null when unknown. */
  sinceSentMs: number | null;
}): { machine: boolean; reason: MachineReason | null } {
  const yes = (reason: MachineReason) => ({ machine: true, reason });
  if (i.method.toUpperCase() === "HEAD") return yes("head_request");
  const ua = i.userAgent ?? "";
  if (i.kind === "open" && isAppleProxyIp(i.ip)) return yes("apple_proxy");
  if (SCANNER_UA.test(ua)) return yes("scanner");
  if (GOOGLE_PROXY.test(ua) && i.sinceSentMs !== null && i.sinceSentMs < GOOGLE_PROXY_WINDOW_MS)
    return yes("google_proxy_prefetch");
  // The Google proxy hides the browser behind its own string, which `isBot` would not know.
  if (!GOOGLE_PROXY.test(ua) && isBot(ua)) return yes("bot");
  if (i.kind === "click" && i.sinceSentMs !== null && i.sinceSentMs < SCANNER_WINDOW_MS)
    return yes("too_fast");
  return { machine: false, reason: null };
}
