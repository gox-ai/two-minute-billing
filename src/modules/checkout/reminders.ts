import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { publicId } from "@/platform/ids";
import { formatMoney } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import {
  businesses,
  checkoutSessionItems,
  checkoutSessions,
  customers,
  emailMessages,
  prices,
  products,
} from "@db/schema";
import { accountHolderName } from "@/modules/customers/names";
import { applySubjectPrefix, resolveEmailConfig } from "@/modules/emails/config";
import { blocksFor, renderEmail, type RenderVars } from "@/modules/emails/templates";
import { loadTemplateOverride } from "@/modules/emails/template-service";
import { computeLineAmount } from "@/modules/catalog/pricing";
import { tokenHash } from "./service";
import type { TickError } from "@/modules/subscriptions/renewal";

const log = createLogger("checkout-reminders");

/** First reminder an hour after the buyer leaves, the second a day after the first. */
export const FIRST_REMINDER_AFTER_MS = 60 * 60_000;
export const SECOND_REMINDER_AFTER_MS = 24 * 60 * 60_000;
/** A reminded checkout stays open this long, so its link still works when it is read. */
export const REMINDED_CHECKOUT_TTL_MS = 48 * 60 * 60_000;
const BATCH = 100;

/**
 * Email buyers who gave their email at a checkout and left without paying (E6).
 *
 * Only for businesses that switched `checkout_reminder` on — filtered in SQL, so a business
 * that has not cannot fill the batch and starve the rest. Two reminders at most; a buyer who
 * came back within the hour is not reminded. The token is never stored, so each reminder
 * mints a resume token: the newest reminder's link works, an older one's stops.
 *
 * Delivery is the outbox's: the row is queued `pending`, and `deliverPendingEmails` applies
 * test mode, suppression and retries exactly as for every other email.
 */
export async function sendCheckoutReminders(
  now: Date,
): Promise<{ reminded: number; errors: TickError[] }> {
  const base = config.PORTAL_BASE_URL?.replace(/\/$/, "");
  if (!base) return { reminded: 0, errors: [] };
  const firstDue = new Date(now.getTime() - FIRST_REMINDER_AFTER_MS);
  const secondDue = new Date(now.getTime() - SECOND_REMINDER_AFTER_MS);
  const candidates = await systemDb
    .select({ s: checkoutSessions, email: customers.email })
    .from(checkoutSessions)
    .innerJoin(businesses, eq(businesses.id, checkoutSessions.businessId))
    .innerJoin(customers, eq(customers.id, checkoutSessions.resultingCustomerId))
    .where(
      and(
        eq(checkoutSessions.status, "open"),
        sql`${checkoutSessions.revokedAt} is null`,
        gt(checkoutSessions.expiresAt, now),
        inArray(checkoutSessions.mode, ["create", "purchase"]),
        isNotNull(checkoutSessions.lastUsedAt),
        lte(checkoutSessions.lastUsedAt, firstDue),
        isNotNull(customers.email),
        sql`${businesses.emailConfig}->>'enabled' = 'true'`,
        sql`${businesses.emailConfig}->'types'->>'checkout_reminder' = 'true'`,
        or(
          eq(checkoutSessions.reminderCount, 0),
          and(
            eq(checkoutSessions.reminderCount, 1),
            lte(checkoutSessions.lastRemindedAt, secondDue),
          ),
        ),
      ),
    )
    .orderBy(checkoutSessions.lastUsedAt)
    .limit(BATCH);

  let reminded = 0;
  const errors: TickError[] = [];
  for (const { s, email } of candidates) {
    try {
      if (await remindOne(s, email!, base, now)) reminded += 1;
    } catch (e) {
      log.error(e, { event: "checkout_reminder_failed", session: s.publicId });
      errors.push({
        organization: s.organizationId,
        business: s.businessId,
        step: "checkout_reminder",
        message: (e as Error)?.message ?? String(e),
      });
    }
  }
  return { reminded, errors };
}

async function remindOne(
  s: typeof checkoutSessions.$inferSelect,
  to: string,
  base: string,
  now: Date,
): Promise<boolean> {
  const token = `cstk_${randomBytes(32).toString("base64url")}`;
  return withTenant(s.organizationId, async (tx) => {
    // Claim it: two workers on one tick must not both send. A changed count means the
    // other one won; a moved last_used_at means the buyer came back meanwhile.
    const claimed = await tx
      .update(checkoutSessions)
      .set({
        reminderCount: s.reminderCount + 1,
        lastRemindedAt: now,
        resumeTokenHash: tokenHash(token),
        expiresAt: new Date(
          Math.max(s.expiresAt.getTime(), now.getTime() + REMINDED_CHECKOUT_TTL_MS),
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(checkoutSessions.id, s.id),
          eq(checkoutSessions.reminderCount, s.reminderCount),
          eq(checkoutSessions.status, "open"),
        ),
      )
      .returning({ id: checkoutSessions.id });
    if (claimed.length === 0) return false;

    const [biz] = await tx.select().from(businesses).where(eq(businesses.id, s.businessId));
    const [cust] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, s.resultingCustomerId!));
    if (!biz || !cust) return false;
    const lines = await tx
      .select({
        quantity: checkoutSessionItems.quantity,
        price: prices,
        name: sql<string>`coalesce(${prices.externalName}, ${products.externalName}, ${products.name})`,
      })
      .from(checkoutSessionItems)
      .innerJoin(prices, eq(prices.id, checkoutSessionItems.priceId))
      .innerJoin(products, eq(products.id, prices.productId))
      .where(eq(checkoutSessionItems.checkoutSessionId, s.id))
      .orderBy(checkoutSessionItems.position);
    if (lines.length === 0) return false;
    const orderSummary = lines
      .map((l) => (l.quantity > 1 ? `${l.name} × ${l.quantity}` : l.name))
      .join(", ");
    // A purchase's total is exact; a subscription's first invoice depends on terms the
    // reminder does not restate, so it names the order and leaves the amount to the page.
    const amount =
      s.mode === "purchase"
        ? formatMoney(
            lines.reduce((n, l) => n + computeLineAmount(l.price, l.quantity), 0n),
            lines[0]!.price.currency,
          )
        : undefined;

    const cfg = resolveEmailConfig(biz);
    const vars: RenderVars = {
      businessName: biz.name,
      customerName: accountHolderName(cust) ?? "there",
      orderSummary,
      ...(amount ? { amount } : {}),
      checkoutUrl: `${base}/checkout/s/${token}`,
      ...(biz.logoUrl ? { logoUrl: biz.logoUrl } : {}),
      ...(biz.iconUrl ? { iconUrl: biz.iconUrl } : {}),
      ...(biz.brandColor ? { brandColor: biz.brandColor } : {}),
      ...(cfg.footerNote ? { footerNote: cfg.footerNote } : {}),
    };
    const override = await loadTemplateOverride(tx, s.businessId, "checkout_reminder");
    const rendered = renderEmail(
      "checkout_reminder",
      { ...vars, ...blocksFor("checkout_reminder", vars) },
      override,
    );
    await tx.insert(emailMessages).values({
      publicId: publicId("em"),
      organizationId: s.organizationId,
      businessId: s.businessId,
      customerId: cust.id,
      type: "checkout_reminder",
      toAddress: to,
      ccAddresses: [],
      subject: applySubjectPrefix(cfg, rendered.subject),
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
    });
    return true;
  });
}
