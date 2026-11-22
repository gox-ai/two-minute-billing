import { sql, type SQL } from "drizzle-orm";
import { and, eq, gte, lt } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { retentionEvents } from "@db/schema";
import { reportableCustomer } from "./reportable";

/**
 * The definitions the hosted-page figures share: the Reports library (`reports/resolve.ts`)
 * and the checkout and portal report pages (`hosted-page-reports.ts`) both read these, so one
 * figure cannot have two answers.
 */

/**
 * The checkout funnel's steps for a `checkout_sessions` reference `t` (an alias or the table).
 *
 * A step counts every session that reached it OR A LATER ONE, so the funnel never rises:
 * sessions completed before `payment_started_at` existed (0343) still count as having paid.
 */
export function checkoutSteps(t: SQL) {
  return {
    opened: sql`(${t}.last_used_at is not null or ${t}.resulting_customer_id is not null or ${t}.payment_started_at is not null or ${t}.completed_at is not null)`,
    details: sql`(${t}.resulting_customer_id is not null or ${t}.payment_started_at is not null or ${t}.completed_at is not null)`,
    payment: sql`(${t}.payment_started_at is not null or ${t}.completed_at is not null)`,
    completed: sql`(${t}.completed_at is not null)`,
  };
}

/** A reminded checkout counts as recovered only when it completed after its last reminder. */
export const checkoutRecoveredSql = (t: SQL): SQL =>
  sql`(${t}.reminder_count > 0 and ${t}.completed_at is not null and ${t}.last_reminded_at is not null and ${t}.completed_at > ${t}.last_reminded_at)`;

/**
 * What a checkout brought in: the purchase's invoice, or the subscription's first invoice.
 * A lateral join exposing `<alias>.id`, `.status`, `.total_minor`, `.currency`, `.paid_at`,
 * `.created_at`; count it as revenue only when `status = 'paid'`.
 */
export const checkoutInvoiceJoin = (t: SQL, alias: string): SQL => sql`
  left join lateral (
    select i.id, i.status, i.total_minor, i.currency, i.paid_at, i.created_at
    from invoices i
    where (${t}.resulting_invoice_id is not null and i.id = ${t}.resulting_invoice_id)
       or (${t}.resulting_invoice_id is null and ${t}.resulting_subscription_id is not null
           and i.subscription_id = ${t}.resulting_subscription_id)
    order by i.created_at, i.id
    limit 1) ${sql.raw(alias)} on true`;

/**
 * The email that carried a portal link: the email row is written in the same transaction as
 * the link, so it has the same business, customer and `created_at`. The portal report's
 * arrival key and the email report's link figures both use this.
 */
export const emailLinkMatch = (ps: SQL, em: SQL): SQL =>
  sql`(${em}.business_id = ${ps}.business_id and ${em}.customer_id = ${ps}.customer_id and ${em}.created_at = ${ps}.created_at)`;

/** A taken offer followed by a cancel of the same subscription within this many days is not a save. */
export const SAVE_HOLD_DAYS = 30;

export interface RetentionRow {
  kind: string;
  offer: string | null;
  offersShown: boolean;
  reasonCode: string | null;
  subscriptionId: string;
  createdAt: Date;
}

export interface CancellationSaves {
  /** Every retention event in the window. */
  inWindow: RetentionRow[];
  /** Taken offers in the window whose subscription was NOT cancelled within SAVE_HOLD_DAYS. */
  saves: RetentionRow[];
  /** Cancels in the window that came after offers were shown, or that revoke a taken offer. */
  lost: RetentionRow[];
  /** saves ÷ (saves + lost), basis points; null with no base. */
  rateBps: number | null;
}

/**
 * The portal cancel flow (0483), over offers taken and cancellations made in [start, end).
 * `where` narrows the rows further (a plan, for the portal report).
 */
export async function cancellationSaves(
  organizationId: string,
  businessId: string,
  start: Date,
  end: Date,
  where?: SQL,
): Promise<CancellationSaves> {
  const e = retentionEvents;
  const hold = SAVE_HOLD_DAYS * 86_400_000;
  // Cancellations up to the hold past the window end, so a save near the end can be revoked.
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        kind: e.kind,
        offer: e.offer,
        offersShown: e.offersShown,
        reasonCode: e.reasonCode,
        subscriptionId: e.subscriptionId,
        createdAt: e.createdAt,
      })
      .from(e)
      .where(
        and(
          eq(e.businessId, businessId),
          gte(e.createdAt, start),
          lt(e.createdAt, new Date(end.getTime() + hold)),
          reportableCustomer(e.customerId),
          where,
        ),
      ),
  );
  const inWindow = (d: Date) => d >= start && d < end;
  const cancels = rows.filter((r) => r.kind === "cancelled");
  const saves = rows.filter(
    (r) =>
      r.kind === "offer_accepted" &&
      inWindow(r.createdAt) &&
      !cancels.some(
        (c) =>
          c.subscriptionId === r.subscriptionId &&
          c.createdAt >= r.createdAt &&
          c.createdAt.getTime() - r.createdAt.getTime() <= hold,
      ),
  );
  // With "offer once" on, a second flow shows no offers but still loses a save it revokes.
  const accepted = rows.filter((r) => r.kind === "offer_accepted");
  const lost = cancels.filter(
    (c) =>
      inWindow(c.createdAt) &&
      (c.offersShown ||
        accepted.some(
          (a) =>
            a.subscriptionId === c.subscriptionId &&
            a.createdAt <= c.createdAt &&
            c.createdAt.getTime() - a.createdAt.getTime() <= hold,
        )),
  );
  const denom = saves.length + lost.length;
  return {
    inWindow: rows.filter((r) => inWindow(r.createdAt)),
    saves,
    lost,
    rateBps: denom > 0 ? Math.round((saves.length * 10000) / denom) : null,
  };
}
