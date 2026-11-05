/**
 * Threshold invoicing (design G5 §3.7, Decisions 1–2): bill usage during the period once
 * unbilled usage reaches an amount. The interim invoice re-rates the whole window to now and
 * bills what earlier interim invoices did not; the period's final invoice bills the rest and
 * carries every coupon and the minimum (`planSubscriptionPeriodInvoice`). Credit grants apply
 * to an interim invoice before tax, as on any period invoice.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { config as appConfig } from "@/platform/config";
import { scanBusinessFilter, stampNow } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  collectPeriodInvoice,
  commitSubscriptionPeriodInvoice,
  invoiceOutstanding,
  planSubscriptionPeriodInvoice,
} from "@/modules/invoicing/service";
import {
  issueAdjustmentCreditNote,
  issueRefundableCreditNote,
  remainingCreditableAgainstInvoice,
} from "@/modules/credit-notes/service";
import { termCoveredByPriorInvoice, termUsageWindow } from "@/modules/subscriptions/usage-window";
import { registerUsageControlStep } from "./check";
import {
  invoices,
  payments,
  prices,
  products,
  subscriptionItems,
  subscriptions,
  usageInvoiceThresholds,
  type UsageInvoiceThresholdSteps,
} from "@db/schema";

const log = createLogger("usage-controls.threshold-invoicing");

// On arrival (`usage_controls_check`): each claimed customer's subscriptions past their
// threshold get an interim invoice. A throw re-marks the customer for the next run.
registerUsageControlStep("threshold_invoicing", async (_tx, c) => {
  const subs = await withTenant(c.organizationId, (tx) =>
    tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.customerId, c.customerId),
          inArray(subscriptions.status, ["active", "non_renewing"]),
        ),
      ),
  );
  for (const s of subs)
    await raiseInterimInvoice({
      organizationId: c.organizationId,
      businessId: c.businessId,
      subscriptionId: s.id,
      now: c.now,
    });
});

type Sub = typeof subscriptions.$inferSelect;
type Row = typeof usageInvoiceThresholds.$inferSelect;
type TickError = { organization: string; business?: string; step: string; message: string };

export class ThresholdError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "ThresholdError";
  }
}

const steps = (amountMinor: bigint): UsageInvoiceThresholdSteps => [
  { amount_minor: Number(amountMinor), recurring: true },
];

// ── Config ────────────────────────────────────────────────────────────────────

async function productOf(tx: Tx, businessId: string, product: string) {
  const [p] = await tx
    .select({ id: products.id, publicId: products.publicId })
    .from(products)
    .where(and(eq(products.businessId, businessId), eq(products.publicId, product)))
    .limit(1);
  if (!p) throw new ThresholdError(`No such product: ${product}`, 404);
  return p;
}

async function subscriptionOf(tx: Tx, businessId: string, sub: string): Promise<Sub> {
  const [s] = await tx
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.businessId, businessId), eq(subscriptions.publicId, sub)))
    .limit(1);
  if (!s) throw new ThresholdError(`No such subscription: ${sub}`, 404);
  return s;
}

/** One recurring amount per plan and currency: "Invoice usage each time unbilled usage reaches …". */
export async function putPlanUsageThreshold(input: {
  organizationId: string;
  businessId: string;
  productPublicId: string;
  currency: string;
  amountMinor: bigint;
}): Promise<Row> {
  if (input.amountMinor <= 0n)
    throw new ThresholdError("We could not save the threshold. amount_minor must be more than 0.");
  const currency = input.currency.toUpperCase();
  return withTenant(input.organizationId, async (tx) => {
    const p = await productOf(tx, input.businessId, input.productPublicId);
    const [row] = await tx
      .insert(usageInvoiceThresholds)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        scope: "plan",
        productId: p.id,
        currency,
        steps: steps(input.amountMinor),
        active: true,
      })
      .onConflictDoUpdate({
        target: [usageInvoiceThresholds.productId, usageInvoiceThresholds.currency],
        targetWhere: sql`scope = 'plan'`,
        set: {
          steps: steps(input.amountMinor),
          active: true,
          updatedAt: stampNow(input.businessId),
        },
      })
      .returning();
    await activate(tx, input.businessId);
    return row!;
  });
}

/**
 * The subscription's own amount, or `null` to turn threshold invoicing off for it. Wins over
 * the plan's.
 */
export async function putSubscriptionUsageThreshold(input: {
  organizationId: string;
  businessId: string;
  subscriptionPublicId: string;
  amountMinor: bigint | null;
}): Promise<Row> {
  if (input.amountMinor != null && input.amountMinor <= 0n)
    throw new ThresholdError("We could not save the threshold. amount_minor must be more than 0.");
  return withTenant(input.organizationId, async (tx) => {
    const s = await subscriptionOf(tx, input.businessId, input.subscriptionPublicId);
    const values = {
      steps: input.amountMinor == null ? null : steps(input.amountMinor),
      active: input.amountMinor != null,
      updatedAt: stampNow(input.businessId),
    };
    const [row] = await tx
      .insert(usageInvoiceThresholds)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        scope: "subscription",
        subscriptionId: s.id,
        currency: s.currency,
        ...values,
      })
      .onConflictDoUpdate({
        target: usageInvoiceThresholds.subscriptionId,
        targetWhere: sql`scope = 'subscription'`,
        set: values,
      })
      .returning();
    await activate(tx, input.businessId);
    return row!;
  });
}

export async function deleteUsageThreshold(input: {
  organizationId: string;
  businessId: string;
  productPublicId?: string;
  currency?: string;
  subscriptionPublicId?: string;
}): Promise<boolean> {
  return withTenant(input.organizationId, async (tx) => {
    const where = input.subscriptionPublicId
      ? and(
          eq(usageInvoiceThresholds.scope, "subscription"),
          eq(
            usageInvoiceThresholds.subscriptionId,
            (await subscriptionOf(tx, input.businessId, input.subscriptionPublicId)).id,
          ),
        )
      : and(
          eq(usageInvoiceThresholds.scope, "plan"),
          eq(
            usageInvoiceThresholds.productId,
            (await productOf(tx, input.businessId, input.productPublicId!)).id,
          ),
          eq(usageInvoiceThresholds.currency, (input.currency ?? "").toUpperCase()),
        );
    const gone = await tx
      .delete(usageInvoiceThresholds)
      .where(and(eq(usageInvoiceThresholds.businessId, input.businessId), where))
      .returning({ id: usageInvoiceThresholds.id });
    return gone.length > 0;
  });
}

export async function listUsageThresholds(input: {
  organizationId: string;
  businessId: string;
  productPublicId?: string;
  subscriptionPublicId?: string;
}): Promise<Row[]> {
  return withTenant(input.organizationId, async (tx) => {
    const productId = input.productPublicId
      ? (await productOf(tx, input.businessId, input.productPublicId)).id
      : null;
    const subId = input.subscriptionPublicId
      ? (await subscriptionOf(tx, input.businessId, input.subscriptionPublicId)).id
      : null;
    return tx
      .select()
      .from(usageInvoiceThresholds)
      .where(
        and(
          eq(usageInvoiceThresholds.businessId, input.businessId),
          productId ? eq(usageInvoiceThresholds.productId, productId) : undefined,
          subId ? eq(usageInvoiceThresholds.subscriptionId, subId) : undefined,
        ),
      )
      .orderBy(asc(usageInvoiceThresholds.createdAt))
      .limit(1000);
  });
}

export async function serializeUsageThresholds(organizationId: string, rows: Row[]) {
  const refs = await withTenant(organizationId, async (tx) => {
    const pids = rows.flatMap((r) => (r.productId ? [r.productId] : []));
    const sids = rows.flatMap((r) => (r.subscriptionId ? [r.subscriptionId] : []));
    const ps = pids.length
      ? await tx
          .select({ id: products.id, p: products.publicId })
          .from(products)
          .where(inArray(products.id, pids))
      : [];
    const ss = sids.length
      ? await tx
          .select({ id: subscriptions.id, p: subscriptions.publicId })
          .from(subscriptions)
          .where(inArray(subscriptions.id, sids))
      : [];
    return new Map([...ps, ...ss].map((r) => [r.id, r.p]));
  });
  return rows.map((r) => ({
    object: "usage_invoice_threshold",
    scope: r.scope,
    product: r.productId ? (refs.get(r.productId) ?? null) : null,
    subscription: r.subscriptionId ? (refs.get(r.subscriptionId) ?? null) : null,
    currency: r.currency,
    amount_minor: r.steps?.[0]?.amount_minor ?? null,
    active: r.active,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }));
}

async function activate(tx: Tx, businessId: string) {
  await tx.execute(sql`update businesses set usage_controls_active = true
    where id = ${businessId} and not usage_controls_active`);
}

/** The subscription's override, else its plan's amount; null = off. */
export async function effectiveThreshold(tx: Tx, sub: Sub): Promise<bigint | null> {
  const [own] = await tx
    .select()
    .from(usageInvoiceThresholds)
    .where(
      and(
        eq(usageInvoiceThresholds.scope, "subscription"),
        eq(usageInvoiceThresholds.subscriptionId, sub.id),
      ),
    )
    .limit(1);
  if (own) return own.active && own.steps ? BigInt(own.steps[0].amount_minor) : null;
  const [plan] = await tx
    .select({ steps: usageInvoiceThresholds.steps })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .innerJoin(products, eq(products.id, prices.productId))
    .innerJoin(
      usageInvoiceThresholds,
      and(
        eq(usageInvoiceThresholds.scope, "plan"),
        eq(usageInvoiceThresholds.productId, products.id),
        eq(usageInvoiceThresholds.currency, sub.currency),
        eq(usageInvoiceThresholds.active, true),
      ),
    )
    .where(and(eq(subscriptionItems.subscriptionId, sub.id), eq(products.kind, "plan")))
    .limit(1);
  return plan?.steps ? BigInt(plan.steps[0].amount_minor) : null;
}

// ── The interim invoice ──────────────────────────────────────────────────────

export type InterimOutcome = "raised" | "below" | "off" | "exists";

/**
 * Raise an interim invoice when unbilled usage in the open window reaches the threshold. It
 * reads every event received so far (no fold grace) and bills all of it.
 * Idempotent: the origin token `uti:<sub>:<window start>:<n>` makes two runs one invoice.
 * No network call: the `usage_threshold_invoices` pass collects it.
 */
export async function raiseInterimInvoice(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
}): Promise<{ outcome: InterimOutcome; invoiceId?: string; unbilledMinor?: bigint }> {
  const { organizationId, businessId, now } = input;
  const prep = await withTenant(organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub || !["active", "non_renewing"].includes(sub.status)) return null;
    const threshold = await effectiveThreshold(tx, sub);
    if (threshold == null) return null;
    const w = termUsageWindow(sub, { priorCovered: await termCoveredByPriorInvoice(tx, sub) });
    if (!w || now.getTime() <= w.start.getTime() || now.getTime() >= w.end.getTime()) return null;
    const [c] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(
        and(
          eq(invoices.subscriptionId, sub.id),
          eq(invoices.purpose, "usage_interim"),
          eq(invoices.periodStart, w.start),
        ),
      );
    return { sub, threshold, w, n: (c?.n ?? 0) + 1 };
  });
  if (!prep) return { outcome: "off" };
  const { sub, threshold, w, n } = prep;
  const cut = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const originToken = `uti:${sub.publicId}:${w.start.toISOString()}:${n}`;
  const base = {
    organizationId,
    businessId,
    subscription: sub,
    periodStart: w.start,
    periodEnd: cut,
    usagePeriod: { start: w.start, end: cut },
  };
  const plan = await planSubscriptionPeriodInvoice({ ...base, interim: { originToken } });
  if (plan.mode !== "finalize" || plan.lines.length === 0 || plan.subtotal < threshold)
    return { outcome: "below", unbilledMinor: plan.subtotal };
  const inner = plan.inTx;
  plan.inTx = async (tx, inv) => {
    await inner?.(tx, inv);
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "usage_threshold_reached",
      data: buildEventData("usage_threshold_reached", {
        id: sub.publicId,
        invoice: inv.publicId,
        threshold_minor: Number(threshold),
        unbilled_minor: Number(plan.subtotal),
        currency: sub.currency,
        period_start: w.start.toISOString(),
        billed_through: cut.toISOString(),
      }),
    });
  };
  try {
    const { invoice } = await commitSubscriptionPeriodInvoice(plan, { collect: false });
    return { outcome: "raised", invoiceId: invoice.id, unbilledMinor: plan.subtotal };
  } catch (e) {
    const x = e as {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint_name?: string };
    };
    const name = String(x?.constraint ?? x?.cause?.constraint_name ?? "");
    if ((x?.code ?? x?.cause?.code) === "23505" && name.includes("invoices_origin_token_uq"))
      return { outcome: "exists" };
    throw e;
  }
}

/**
 * The on-arrival check (`usage_controls_check` cron) for claimed customers: an interim invoice
 * for each live subscription past its threshold. No network call.
 */
export async function checkUsageThresholds(input: {
  organizationId: string;
  businessId: string;
  customerIds: string[];
  now: Date;
}): Promise<{ raised: number; errors: number }> {
  let raised = 0;
  let errors = 0;
  if (input.customerIds.length === 0) return { raised, errors };
  const subs = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, input.businessId),
          inArray(subscriptions.customerId, input.customerIds),
          inArray(subscriptions.status, ["active", "non_renewing"]),
        ),
      ),
  );
  for (const s of subs) {
    try {
      const r = await raiseInterimInvoice({ ...input, subscriptionId: s.id });
      if (r.outcome === "raised") raised++;
    } catch (e) {
      errors++;
      log.error(e as Error, { event: "usage_threshold_check_failed", subscription: s.id });
    }
  }
  return { raised, errors };
}

// ── The `usage_threshold_invoices` pass ──────────────────────────────────────

export interface ThresholdPassResult {
  collected: number;
  credited: number;
  capped: boolean;
  errors: TickError[];
}

/**
 * Collect fresh interim invoices (with dunning, like a renewal), and credit a final invoice's
 * excess (coupons over its amount, or a negative remainder) on the period's interim invoices.
 */
export async function runUsageThresholdInvoices(now: Date): Promise<ThresholdPassResult> {
  const out: ThresholdPassResult = { collected: 0, credited: 0, capped: false, errors: [] };
  const limit = appConfig.TICK_SCAN_LIMIT;
  void now;
  const fresh = await systemDb
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.purpose, "usage_interim"),
        eq(invoices.status, "payment_due"),
        eq(invoices.attemptCount, 0),
        isNull(invoices.nextAttemptAt),
        isNull(invoices.dunningStatus),
        sql`not exists (select 1 from payments p where p.invoice_id = ${invoices.id})`,
        scanBusinessFilter(invoices.businessId),
      ),
    )
    .orderBy(asc(invoices.createdAt))
    .limit(limit + 1);
  if (fresh.length > limit) out.capped = true;
  for (const inv of fresh.slice(0, limit)) {
    try {
      const [sub] = await withTenant(inv.organizationId, (tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.id, inv.subscriptionId!)).limit(1),
      );
      if (!sub) continue;
      await collectPeriodInvoice({
        organizationId: inv.organizationId,
        businessId: inv.businessId,
        subscription: sub,
        invoice: inv,
      });
      out.collected++;
    } catch (e) {
      out.errors.push({
        organization: inv.organizationId,
        business: inv.businessId,
        step: "usage_threshold_invoices.collect",
        message: e instanceof Error ? e.message : String(e),
      });
      log.error(e as Error, { event: "usage_interim_collect_failed", invoice: inv.publicId });
    }
  }

  const finals = await systemDb
    .select()
    .from(invoices)
    .where(
      and(
        sql`${invoices.metadata} ? 'interim_excess_minor'`,
        sql`not (${invoices.metadata} ? 'interim_excess_credited')`,
        sql`${invoices.status} not in ('voided', 'pending')`,
        scanBusinessFilter(invoices.businessId),
      ),
    )
    .orderBy(asc(invoices.createdAt))
    .limit(limit + 1);
  if (finals.length > limit) out.capped = true;
  for (const f of finals.slice(0, limit)) {
    try {
      out.credited += await creditInterimExcess(f);
    } catch (e) {
      out.errors.push({
        organization: f.organizationId,
        business: f.businessId,
        step: "usage_threshold_invoices.credit",
        message: e instanceof Error ? e.message : String(e),
      });
      log.error(e as Error, { event: "usage_interim_credit_failed", invoice: f.publicId });
    }
  }
  return out;
}

const mulDiv = (a: bigint, b: bigint, d: bigint) => (d === 0n ? a : (a * b + d / 2n) / d);
const CREDIT_REASON =
  "Usage billed on interim invoices: the period's discounts and final usage, credited here.";

/**
 * Credit a final invoice's pre-tax excess on its period's interim invoices, newest first, each
 * capped at what it can still take. One transaction: all notes and the mark, or none.
 */
async function creditInterimExcess(f: typeof invoices.$inferSelect): Promise<number> {
  const meta = (f.metadata ?? {}) as {
    interim_excess_minor?: string;
    interim_window_start?: string;
  };
  let left = BigInt(meta.interim_excess_minor ?? "0");
  const ws = meta.interim_window_start ? new Date(meta.interim_window_start) : null;
  return withTenant(f.organizationId, async (tx) => {
    const interims =
      ws && f.subscriptionId
        ? await tx
            .select()
            .from(invoices)
            .where(
              and(
                eq(invoices.subscriptionId, f.subscriptionId),
                eq(invoices.purpose, "usage_interim"),
                eq(invoices.periodStart, ws),
                sql`${invoices.status} not in ('voided', 'pending')`,
              ),
            )
            .orderBy(desc(invoices.createdAt))
        : [];
    let notes = 0;
    let creditedMinor = 0n;
    for (const inv of interims) {
      if (left <= 0n) break;
      // The excess is pre-tax; a note's amount includes the invoice's tax share.
      const pre = inv.subtotalMinor ?? inv.totalMinor;
      if (pre <= 0n) continue;
      const room = await remainingCreditableAgainstInvoice(tx, inv);
      const open = ["payment_due", "posted", "not_paid"].includes(inv.status);
      let cap = room;
      if (open) {
        const { remainingMinor } = await invoiceOutstanding(tx, inv);
        cap = remainingMinor < cap ? remainingMinor : cap;
      } else {
        const [paid] = await tx
          .select({ s: sql<string>`coalesce(sum(${payments.amountMinor}), 0)` })
          .from(payments)
          .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, "succeeded")));
        const cash = BigInt(paid?.s ?? "0");
        cap = cash < cap ? cash : cap;
      }
      const gross = mulDiv(left, inv.totalMinor, pre);
      const amount = gross < cap ? gross : cap;
      if (amount <= 0n) continue;
      const item = { description: "Usage adjustment for this period", amountMinor: Number(amount) };
      if (open)
        await issueAdjustmentCreditNote({
          organizationId: f.organizationId,
          businessId: f.businessId,
          invoicePublicId: inv.publicId,
          items: [item],
          reason: CREDIT_REASON,
          taxAtInvoiceRate: true,
          tx,
        });
      else
        await issueRefundableCreditNote({
          organizationId: f.organizationId,
          businessId: f.businessId,
          invoicePublicId: inv.publicId,
          items: [item],
          reason: CREDIT_REASON,
          tx,
        });
      notes++;
      const used = amount === gross ? left : mulDiv(amount, pre, inv.totalMinor);
      left -= used;
      creditedMinor += used;
    }
    await tx
      .update(invoices)
      .set({
        metadata: sql`coalesce(${invoices.metadata}, '{}'::jsonb) || ${JSON.stringify({
          interim_excess_credited: String(creditedMinor),
        })}::jsonb`,
      })
      .where(eq(invoices.id, f.id));
    if (left > 0n)
      log.warn("interim invoices could not take the whole excess", {
        event: "usage_interim_excess_left",
        invoice: f.publicId,
        leftMinor: String(left),
      });
    return notes;
  });
}
