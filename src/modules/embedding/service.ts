/**
 * Embedding: which websites may show a business's checkout, portal and usage widget inside
 * their own pages. One list per business (`businesses.embed_origins`); a session names the one
 * website it may be framed by (`embed_origin`), checked when it is minted and again on every
 * framed page load, so removing a website stops its embeds at once.
 */
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { businesses } from "@db/schema";

export const MAX_EMBED_ORIGINS = 20;

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

/**
 * An origin is scheme + host + port, compared exactly (as `platform/cors.ts`). https only,
 * except http on a loopback host for local testing. Returns the normalised origin or an error.
 */
export function normaliseEmbedOrigin(raw: string): { origin: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: `${raw} is not a URL. Enter an origin like https://app.example.com.` };
  }
  const local = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    return { error: `${raw} must use https.` };
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
    return { error: `${raw} must be an origin only, with no path.` };
  return { origin: url.origin };
}

const isLoopback = (origin: string) => LOOPBACK.has(new URL(origin).hostname);

export async function getEmbedOrigins(organizationId: string, businessId: string) {
  return withTenant(organizationId, async (tx) => {
    const [b] = await tx
      .select({ origins: businesses.embedOrigins })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return b?.origins ?? [];
  });
}

/** Replace the list. Writes `usage_widget_origins` too, until that column is dropped. */
export async function setEmbedOrigins(
  organizationId: string,
  businessId: string,
  origins: string[],
): Promise<string[]> {
  const unique = [...new Set(origins)];
  await withTenant(organizationId, (tx) =>
    tx
      .update(businesses)
      .set({ embedOrigins: unique, usageWidgetOrigins: unique, updatedAt: new Date() })
      .where(eq(businesses.id, businessId)),
  );
  return unique;
}

/**
 * Check a session's `embed_origin` before it is stored: a valid origin, on the business's list,
 * and a loopback origin only in a test business (a live buyer never pays inside localhost).
 */
export async function checkEmbedOrigin(
  tx: Tx,
  businessId: string,
  raw: string,
): Promise<{ origin: string } | { error: string }> {
  const n = normaliseEmbedOrigin(raw);
  if ("error" in n) return n;
  const [b] = await tx
    .select({ origins: businesses.embedOrigins, livemode: businesses.livemode })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!b?.origins.includes(n.origin))
    return {
      error:
        `${n.origin} is not in this business's allowed websites. Add it with ` +
        "PUT /v1/businesses/{biz}/settings/embedding first.",
    };
  if (isLoopback(n.origin) && b.livemode !== "test")
    return { error: `${n.origin} is a local address. Use it in a test business only.` };
  return n;
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/**
 * The website that may frame the storefront page this credential opens, or null.
 *
 * `credential` is what the framed URL carries: a checkout link token (`cstk_…`), a portal entry
 * token (`pstk_…`), or a session id (`cosess_…`, `psess_…`) on the pages after the exchange.
 * Answers only while the session's `embed_origin` is still on its business's list. Reads
 * through the system connection: the caller is the storefront, before any tenant is known.
 */
export async function resolveFrameAncestor(credential: string): Promise<string | null> {
  const q = (() => {
    if (/^cstk_[A-Za-z0-9_-]{16,128}$/.test(credential))
      return sql`select s.embed_origin from checkout_sessions s join businesses b on b.id = s.business_id
        where s.token_hash = ${sha256(credential)} and s.embed_origin = any(b.embed_origins) limit 1`;
    if (/^cosess_[A-Za-z0-9]{1,64}$/.test(credential))
      return sql`select s.embed_origin from checkout_sessions s join businesses b on b.id = s.business_id
        where s.public_id = ${credential} and s.embed_origin = any(b.embed_origins) limit 1`;
    if (/^pstk_[A-Za-z0-9_-]{16,128}$/.test(credential))
      return sql`select s.embed_origin from portal_sessions s join businesses b on b.id = s.business_id
        where s.access_token_hash = ${sha256(credential)} and s.embed_origin = any(b.embed_origins) limit 1`;
    if (/^psess_[A-Za-z0-9]{1,64}$/.test(credential))
      return sql`select s.embed_origin from portal_sessions s join businesses b on b.id = s.business_id
        where s.public_id = ${credential} and s.embed_origin = any(b.embed_origins) limit 1`;
    return null;
  })();
  if (!q) return null;
  const rows = (await systemDb.execute(q)) as unknown as { embed_origin: string }[];
  return rows[0]?.embed_origin ?? null;
}

/** CORS preflight for the usage widget carries no token: allow an origin some business lists. */
export async function isAnyEmbedOrigin(origin: string): Promise<boolean> {
  const r = await systemDb.execute(
    sql`select 1 from businesses where ${origin} = any(embed_origins) limit 1`,
  );
  return (r as unknown as unknown[]).length > 0;
}
