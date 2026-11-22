/**
 * Open and click tracking, database parts. See `tracking.ts` for the rules.
 *
 * What a request leaves behind: the time, `machine`, a device/browser/OS family and, for a
 * click, the link's host, masked path and label. The IP address and the user agent are read
 * here to decide `machine` and to take the families, then dropped.
 */
import { and, eq, sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { businesses, emailEngagements, emailLinks, emailMessages } from "@db/schema";
import { parseUserAgent } from "@/modules/storefront-analytics/user-agent";
import { resolveEmailConfig, SYSTEM_EMAIL_TYPES, type EmailConfig } from "./config";
import {
  classifyEngagement,
  instrumentHtml,
  linkShape,
  trackingBase,
  verifyToken,
  type TrackedLink,
} from "./tracking";

/** One email cannot grow without bound if its pixel or a link is fetched in a loop. */
const MAX_EVENTS_PER_EMAIL = 200;

/**
 * The HTML to send for one outbox row. Returns the stored HTML as it is when the business has
 * tracking off, the email is system mail, or the API has no public address.
 */
export async function trackedHtmlFor(
  row: {
    id: string;
    type: string;
    organizationId: string;
    businessId: string | null;
    bodyHtml: string;
  },
  cfg: Pick<EmailConfig, "trackEngagement">,
): Promise<{ html: string; tracked: boolean }> {
  const base = trackingBase();
  if (
    !cfg.trackEngagement ||
    !base ||
    !row.businessId ||
    (SYSTEM_EMAIL_TYPES as readonly string[]).includes(row.type) ||
    !row.bodyHtml
  )
    return { html: row.bodyHtml, tracked: false };
  const r = instrumentHtml(row.bodyHtml, row.id, base);
  if (r.links.length) await saveLinks(row.id, row.organizationId, row.businessId, r.links);
  return { html: r.html, tracked: true };
}

async function saveLinks(
  emailId: string,
  organizationId: string,
  businessId: string,
  links: TrackedLink[],
): Promise<void> {
  // A retry re-sends the same body, so the same positions: the first write stands.
  await systemDb
    .insert(emailLinks)
    .values(
      links.map((l) => ({
        emailMessageId: emailId,
        position: l.position,
        organizationId,
        businessId,
        url: l.url,
        label: l.label,
      })),
    )
    .onConflictDoNothing();
}

interface Meta {
  method: string;
  userAgent: string | null;
  ip: string | null;
}

type Target = {
  organizationId: string;
  businessId: string;
  sentAt: Date | null;
  emailConfig: unknown;
};

async function targetOf(emailId: string): Promise<Target | null> {
  const [t] = await systemDb
    .select({
      organizationId: emailMessages.organizationId,
      businessId: emailMessages.businessId,
      sentAt: emailMessages.sentAt,
      emailConfig: businesses.emailConfig,
    })
    .from(emailMessages)
    .innerJoin(businesses, eq(businesses.id, emailMessages.businessId))
    .where(eq(emailMessages.id, emailId))
    .limit(1);
  return t ? ({ ...t, businessId: t.businessId! } as Target) : null;
}

async function record(
  emailId: string,
  t: Target,
  kind: "open" | "click",
  meta: Meta,
  link?: { position: number; url: string; label: string | null },
  now = new Date(),
): Promise<void> {
  // The business turned tracking off after this email went out: record nothing.
  if (!resolveEmailConfig({ emailConfig: t.emailConfig }).trackEngagement) return;
  const c = classifyEngagement({
    kind,
    method: meta.method,
    userAgent: meta.userAgent,
    ip: meta.ip,
    // No sent time yet: the relay has the email and the row is not updated, so this is a prefetch.
    sinceSentMs: t.sentAt ? now.getTime() - t.sentAt.getTime() : 0,
  });
  const ua = c.machine ? null : parseUserAgent(meta.userAgent);
  const shape = link ? linkShape(link.url) : null;
  const e = emailEngagements;
  const inserted = await systemDb.execute(sql`
    insert into email_engagements
      (organization_id, business_id, email_message_id, kind, machine, link_position, link_label,
       link_host, link_path, device_category, browser, os)
    select ${t.organizationId}::uuid, ${t.businessId}::uuid, ${emailId}::uuid, ${kind}, ${c.machine},
           ${link?.position ?? null}, ${link?.label ?? null}, ${shape?.host ?? null},
           ${shape?.path ?? null}, ${ua?.device ?? null}, ${ua?.browser ?? null}, ${ua?.os ?? null}
    where (select count(*) from ${e} where ${e.emailMessageId} = ${emailId}::uuid) < ${MAX_EVENTS_PER_EMAIL}
    returning 1`);
  const wrote = Array.isArray(inserted)
    ? inserted.length
    : ((inserted as { rows?: unknown[] }).rows?.length ?? 0);
  if (!wrote || c.machine) return;
  await systemDb
    .update(emailMessages)
    .set(
      kind === "open"
        ? { firstOpenedAt: sql`coalesce(first_opened_at, app_now())` }
        : { firstClickedAt: sql`coalesce(first_clicked_at, app_now())` },
    )
    .where(eq(emailMessages.id, emailId));
}

/** The pixel was fetched. False = the token is not ours (answer 404). */
export async function recordOpen(token: string, meta: Meta): Promise<boolean> {
  const v = verifyToken("o", token);
  if (!v) return false;
  const t = await targetOf(v.emailId);
  if (!t) return false;
  await record(v.emailId, t, "open", meta);
  return true;
}

/** A link was followed. Returns the stored URL, or null (answer 404). */
export async function recordClick(token: string, meta: Meta): Promise<string | null> {
  const v = verifyToken("c", token);
  if (!v || v.position < 1) return null;
  const [link] = await systemDb
    .select({ url: emailLinks.url, label: emailLinks.label })
    .from(emailLinks)
    .where(and(eq(emailLinks.emailMessageId, v.emailId), eq(emailLinks.position, v.position)))
    .limit(1);
  if (!link) return null;
  const t = await targetOf(v.emailId);
  if (!t) return null;
  await record(v.emailId, t, "click", meta, { position: v.position, ...link });
  return link.url;
}
