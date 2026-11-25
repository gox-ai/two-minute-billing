/**
 * "Email me a new link": a customer holding an expired or used link asks for a fresh one.
 *
 * The new link goes ONLY to the email address on file for the link's customer, so holding
 * an old link lets someone trigger an email to the real owner and nothing more. It is
 * sent by the `new_link_send` job, never inside the request, so the response and its
 * timing are the same whether or not anything was sent.
 *
 * Three kinds of link qualify:
 * - a portal link minted for an email (`access_kind = 'email'`): a new portal link on the
 *   same task (`forward_url`);
 * - a restart checkout (`reactivate`) whose subscription is still cancelled: a new
 *   restart checkout;
 * - an unfinished create/purchase checkout with a known customer whose prices are all
 *   still active: the same order, reopened with a new resume token.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import {
  businesses,
  checkoutSessionItems,
  checkoutSessions,
  customers,
  portalSessions,
  prices,
  subscriptions,
} from "@db/schema";
import { createPortalSession } from "./service";
import { mintRestartSession } from "./restart";
import { resolveStorefrontConfig } from "@/modules/checkout/storefront-config";
import { REMINDED_CHECKOUT_TTL_MS } from "@/modules/checkout/reminders";
import { sendNewLinkEmail } from "@/modules/emails/new-link";

const log = createLogger("customer-portal.new-link");

export const NEW_LINK_TASK = "new_link_send";

export interface NewLinkJob {
  kind: "portal" | "restart" | "order";
  organizationId: string;
  businessId: string;
  /** `portal_sessions.id` or `checkout_sessions.id` of the expired link. */
  rowId: string;
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** The job a portal link would get, or null when it cannot have a new one. */
export async function portalNewLinkJob(accessToken: string): Promise<NewLinkJob | null> {
  if (!accessToken.startsWith("pstk_")) return null;
  const [row] = await systemDb
    .select({
      id: portalSessions.id,
      organizationId: portalSessions.organizationId,
      businessId: portalSessions.businessId,
      email: customers.email,
    })
    .from(portalSessions)
    .innerJoin(customers, eq(customers.id, portalSessions.customerId))
    .where(
      and(
        eq(portalSessions.accessTokenHash, sha(accessToken)),
        eq(portalSessions.accessKind, "email"),
        isNull(portalSessions.revokedAt),
      ),
    )
    .limit(1);
  if (!row?.email?.trim()) return null;
  return {
    kind: "portal",
    organizationId: row.organizationId,
    businessId: row.businessId,
    rowId: row.id,
  };
}

/** The job a checkout link would get, or null when it cannot have a new one. */
export async function checkoutNewLinkJob(token: string): Promise<NewLinkJob | null> {
  if (!token.startsWith("cstk_")) return null;
  const [s] = await systemDb
    .select()
    .from(checkoutSessions)
    .where(
      and(
        or(
          eq(checkoutSessions.tokenHash, sha(token)),
          eq(checkoutSessions.resumeTokenHash, sha(token)),
        ),
        isNull(checkoutSessions.revokedAt),
      ),
    )
    .limit(1);
  if (!s || s.status === "completed") return null;
  const kind = await checkoutKind(s);
  return kind
    ? { kind, organizationId: s.organizationId, businessId: s.businessId, rowId: s.id }
    : null;
}

type CheckoutRow = typeof checkoutSessions.$inferSelect;

/** `restart`, `order`, or null; re-checked by the job before it mints anything. */
async function checkoutKind(s: CheckoutRow): Promise<"restart" | "order" | null> {
  // The org is known now: these reads are tenant-scoped.
  return withTenant(s.organizationId, async (tx) => {
    if (s.reactivate && s.subscriptionId) {
      const [sub] = await tx
        .select({ status: subscriptions.status, email: customers.email })
        .from(subscriptions)
        .innerJoin(customers, eq(customers.id, subscriptions.customerId))
        .where(eq(subscriptions.id, s.subscriptionId))
        .limit(1);
      return sub?.status === "cancelled" && sub.email?.trim() ? "restart" : null;
    }
    if (
      (s.mode === "create" || s.mode === "purchase") &&
      s.status === "open" &&
      s.resultingCustomerId
    ) {
      const [cus] = await tx
        .select({ email: customers.email })
        .from(customers)
        .where(eq(customers.id, s.resultingCustomerId))
        .limit(1);
      if (!cus?.email?.trim()) return null;
      const items = await tx
        .select({ active: prices.active })
        .from(checkoutSessionItems)
        .innerJoin(prices, eq(prices.id, checkoutSessionItems.priceId))
        .where(eq(checkoutSessionItems.checkoutSessionId, s.id));
      return items.length > 0 && items.every((i) => i.active) ? "order" : null;
    }
    return null;
  });
}

/** Queue the send. One pending job per link: pressing again replaces it. */
export async function queueNewLink(job: NewLinkJob): Promise<void> {
  const { enqueue } = await import("@/platform/jobs");
  await enqueue(NEW_LINK_TASK, job, { jobKey: `new_link:${job.rowId}`, maxAttempts: 3 });
}

/** The business's email link lifetime, else `fallback`. */
async function emailLinkMs(organizationId: string, businessId: string, fallback: number) {
  const [biz] = await withTenant(organizationId, (tx) =>
    tx
      .select({ storefrontConfig: businesses.storefrontConfig })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1),
  );
  const days = resolveStorefrontConfig(biz ?? null).portalEmailLinkDays;
  return days != null ? days * 86_400_000 : fallback;
}

const PORTAL_LABEL: Array<[RegExp, string]> = [
  [/pay_invoice=/, "Pay now"],
  [/add_card=1/, "Change payment method"],
  [/change=/, "Change your plan"],
  [/cancel=/, "Manage your subscription"],
];

/** The worker half: re-check the link, mint the new one, email it. */
export async function sendQueuedNewLink(job: NewLinkJob): Promise<"sent" | "skipped"> {
  const base = config.PORTAL_BASE_URL?.replace(/\/$/, "");
  if (!base) return "skipped";
  const { organizationId, businessId } = job;

  if (job.kind === "portal") {
    const [old] = await withTenant(organizationId, (tx) =>
      tx
        .select()
        .from(portalSessions)
        .where(and(eq(portalSessions.id, job.rowId), isNull(portalSessions.revokedAt)))
        .limit(1),
    );
    if (!old) return "skipped";
    const fresh = await createPortalSession({
      organizationId,
      businessId,
      customerId: old.customerId,
      kind: "email",
      forwardUrl: old.forwardUrl,
      redirectUrl: old.redirectUrl,
    });
    const f = old.forwardUrl ?? "";
    const label = PORTAL_LABEL.find(([re]) => re.test(f))?.[1] ?? "Open your billing account";
    const ok = await sendNewLinkEmail(organizationId, businessId, {
      customerId: old.customerId,
      url: `${base}/portal/s/${fresh.accessToken}`,
      label,
      windowMs: fresh.accessExpiresAt.getTime() - Date.now(),
    });
    return ok ? "sent" : "skipped";
  }

  const [s] = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(checkoutSessions)
      .where(and(eq(checkoutSessions.id, job.rowId), isNull(checkoutSessions.revokedAt)))
      .limit(1),
  );
  if (!s || (await checkoutKind(s)) !== job.kind) return "skipped";

  if (job.kind === "restart") {
    const [sub] = await withTenant(organizationId, (tx) =>
      tx
        .select({
          id: subscriptions.id,
          publicId: subscriptions.publicId,
          customerId: subscriptions.customerId,
        })
        .from(subscriptions)
        .where(eq(subscriptions.id, s.subscriptionId!))
        .limit(1),
    );
    if (!sub) return "skipped";
    // The old link's price choice: listed items = today's prices, none = the frozen ones.
    const listed = await withTenant(organizationId, (tx) =>
      tx
        .select({ id: checkoutSessionItems.id })
        .from(checkoutSessionItems)
        .where(eq(checkoutSessionItems.checkoutSessionId, s.id))
        .limit(1),
    );
    const ttlMs = await emailLinkMs(organizationId, businessId, 0);
    const fresh = await mintRestartSession({
      organizationId,
      businessId,
      subscription: { id: sub.id, publicId: sub.publicId },
      price: listed.length > 0 ? "current" : "keep",
      ...(s.redirectUrl ? { returnUrl: s.redirectUrl } : {}),
      ...(s.cancelUrl ? { cancelUrl: s.cancelUrl } : {}),
      ...(ttlMs ? { ttlMs } : {}),
    });
    const ok = await sendNewLinkEmail(organizationId, businessId, {
      customerId: sub.customerId,
      url: fresh.url,
      label: "Reactivate subscription",
      windowMs: fresh.expiresAt.getTime() - Date.now(),
    });
    return ok ? "sent" : "skipped";
  }

  // An unfinished order: the same checkout, open again under a new resume token.
  const token = `cstk_${randomBytes(32).toString("base64url")}`;
  const now = new Date();
  const ttlMs = await emailLinkMs(organizationId, businessId, REMINDED_CHECKOUT_TTL_MS);
  const expiresAt = new Date(Math.max(s.expiresAt.getTime(), now.getTime() + ttlMs));
  const reopened = await withTenant(organizationId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({ resumeTokenHash: sha(token), expiresAt, updatedAt: now })
      .where(
        and(
          eq(checkoutSessions.id, s.id),
          eq(checkoutSessions.status, "open"),
          isNull(checkoutSessions.revokedAt),
        ),
      )
      .returning({ id: checkoutSessions.id }),
  );
  if (reopened.length === 0) return "skipped";
  const ok = await sendNewLinkEmail(organizationId, businessId, {
    customerId: s.resultingCustomerId!,
    url: `${base}/checkout/s/${token}`,
    label: "Return to your order",
    windowMs: expiresAt.getTime() - now.getTime(),
  });
  if (!ok) log.warn("new order link not sent", { session: s.publicId });
  return ok ? "sent" : "skipped";
}
