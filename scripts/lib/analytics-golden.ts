/**
 * The golden-payload fixture for the analytics + report layer.
 *
 * Shared by `capture-analytics-golden` (writes the files) and
 * `verify-analytics-golden` (re-seeds, recomputes, compares). Both must build the SAME
 * book from the SAME code, or the gate compares a rewrite against a different fixture and
 * reports a difference that is not one.
 *
 * Determinism is the whole product here:
 *  - `NOW` is pinned, and every seeded row is stamped at an instant relative to it — the
 *    services default `created_at`/`occurred_at` to wall clock, which would move the
 *    window boundaries under every figure on the next run;
 *  - the payloads are canonicalised before they are written (keys sorted, generated ids
 *    and `as_of` replaced by placeholders), so a diff shows a CHANGED NUMBER and nothing
 *    else.
 *
 * Ids are replaced with `<id:n>` rather than dropped: a field that disappears has to fail
 * too, and a deleted key is exactly what a rewrite does by accident.
 */
import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, cancelSubscription } from "@/modules/subscriptions/service";
import { createCoupon, applyCouponToSubscription } from "@/modules/coupons/service";
import { createManualInvoice, recordOfflinePayment } from "@/modules/invoicing/ops";
import { computeBusinessMetrics } from "@/modules/metrics/service";
import { computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { writeMetricDay } from "@/modules/metrics/daily/write";
import { utcDayString } from "@/modules/metrics/snapshots";
import { computeBusinessAnalytics, ANALYTICS_RANGES } from "@/modules/metrics/analytics";
import { REPORTS } from "@/modules/metrics/reports/registry";
import { resolveReport, ReportError } from "@/modules/metrics/reports/resolve";
import {
  businesses,
  clockTicks,
  customers,
  invoices,
  mrrMovements,
  payments,
  subscriptions,
  timeTravels,
  transactions,
} from "@db/schema";

/** The instant every figure is read at. Fixed, so re-running yields the same answers. */
export const NOW = new Date("2026-08-14T02:00:00.000Z");

export const GOLDEN_DIR = "test/golden/analytics";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Every seeded term ends here — past `NOW`, and past whatever the real clock says. */
const PARKED_TERM_END = day("2027-06-01");

/** The seeded book's identity — what the capture and the gate both compute against. */
export interface GoldenBook {
  organizationId: string;
  businessId: string;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * A small, varied book: 2 currencies, 2 plans, and one subscription in each state the
 * reports treat differently (live, trialing, cancelled, non-renewing, discounted).
 *
 * Its own organization + business, so the fixture never reads whatever is in the dev
 * database.
 */
export async function seedGoldenBook(): Promise<GoldenBook> {
  const org = await createOrganization({ name: "Analytics Golden Org" });
  const organizationId = org.organization.id;
  const biz = await createBusiness({
    organizationId,
    name: "Analytics Golden Biz",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  /**
   * Take the business off the REAL clock before it holds anything.
   *
   * Parking the terms stops a renewal, but not a dunning sweep, and a live worker sharing
   * this database claimed the fixture's invoices mid-seed — four reports differed on one
   * run in five with every row count still correct. The seam that stops it is the one
   * `platform/clock.ts` exists for: a real tick reads `timeTravelledBusinessIds()` and
   * excludes those businesses from EVERY pass scan.
   *
   * `runWithClockScope` alone cannot do this. It is an AsyncLocalStorage scope inside one
   * process, and the worker that races this fixture is a different process — the row below
   * is the half of the pattern that crosses that boundary. It is written first so the
   * business is already excluded before it has a subscription or an invoice to claim.
   */
  await systemDb.insert(timeTravels).values({
    organizationId,
    businessId: biz.id,
    status: "in_progress",
    genesisTime: NOW,
    simulatedNow: NOW, // non-null ⇒ the real tick skips this business
  });
  /**
   * The row alone is not the fence. A tick reads `timeTravelledBusinessIds()` ONCE, at
   * its start, and carries that list through every pass — so a tick already in flight
   * when the row lands never sees it, and its later passes (invoice due transitions,
   * dunning) still scan this business. That is the window the flake came through: the
   * seed's posted invoice collected under the fixture, and only the payment-shaped
   * payloads differed.
   *
   * So wait for every tick that started before the row to close. After that, any tick
   * takes its snapshot with this business already in it.
   */
  await waitForInFlightTicks();

  // A fixed EUR rate, so the multi-currency roll-up converts instead of disclosing a gap.
  await systemDb
    .update(businesses)
    .set({ exchangeRates: { EUR: 0.9 } })
    .where(eq(businesses.id, biz.id));

  const starter = await createProduct({ organizationId, businessId: biz.id, name: "Starter" });
  const pro = await createProduct({ organizationId, businessId: biz.id, name: "Pro" });

  const price = (
    productId: string,
    currency: string,
    amountMinor: number,
    interval: "month" | "year",
  ) =>
    createPrice({
      organizationId,
      businessId: biz.id,
      productId,
      type: "recurring",
      model: "flat",
      currency,
      amountMinor,
      interval,
    });

  const starterUsd = await price(starter.id, "USD", 5000, "month");
  const starterEur = await price(starter.id, "EUR", 3000, "month");
  const proUsd = await price(pro.id, "USD", 120_000, "year");

  let seq = 0;
  /**
   * Push the term past the real clock, immediately.
   *
   * The book is dated in the past, and a billing worker sharing this database renews
   * anything already due — mid-seed, a few subscriptions at a time. That is the whole
   * reason this fixture drifted: the same seed produced 11, 15 or 21 invoices depending on
   * where the tick landed. Parked terms are never due, so the clock has nothing to claim.
   */
  const park = async (subscriptionId: string) => {
    await systemDb
      .update(subscriptions)
      .set({ currentPeriodEnd: PARKED_TERM_END })
      .where(eq(subscriptions.id, subscriptionId));
    // A trialling subscription is due by `trial_end`, not by its term — park both.
    await systemDb
      .update(subscriptions)
      .set({ trialEnd: PARKED_TERM_END })
      .where(and(eq(subscriptions.id, subscriptionId), isNotNull(subscriptions.trialEnd)));
  };

  /** Deterministic addresses — `Math.random()` here would change nothing but would churn. */
  const nextEmail = () => `golden-${String(++seq).padStart(2, "0")}@example.test`;

  async function subscribe(opts: {
    price: typeof starterUsd;
    startedOn: string;
    signedUpOn: string;
    trialDays?: number;
    /** Distinct per subscription: equal MRR leaves the "top customers" ranking a coin toss. */
    unitAmountMinor: number;
  }) {
    const customer = await createCustomer({
      organizationId,
      businessId: biz.id,
      email: nextEmail(),
      address: { country: "US" },
    });
    await systemDb
      .update(customers)
      .set({ createdAt: day(opts.signedUpOn) })
      .where(eq(customers.id, customer.id));
    await vaultPaymentMethod({
      organizationId,
      businessId: biz.id,
      customer,
      token: "tok_4242",
    });
    const { subscription } = await createSubscription({
      organizationId,
      businessId: biz.id,
      customerId: customer.id,
      now: day(opts.startedOn),
      startDate: day(opts.startedOn),
      trialDays: opts.trialDays,
      items: [{ price: opts.price, quantity: 1, customAmountMinor: opts.unitAmountMinor }],
    });
    await park(subscription.id);
    return { customer, subscription };
  }

  // Live book.
  const a = await subscribe({
    price: starterUsd,
    signedUpOn: "2026-02-08",
    startedOn: "2026-02-10",
    unitAmountMinor: 5000,
  });
  await subscribe({
    price: starterUsd,
    signedUpOn: "2026-03-15",
    startedOn: "2026-03-15",
    unitAmountMinor: 5100,
  });
  await subscribe({
    price: proUsd,
    signedUpOn: "2026-04-01",
    startedOn: "2026-04-01",
    unitAmountMinor: 120_000,
  });
  await subscribe({
    price: starterEur,
    signedUpOn: "2026-05-20",
    startedOn: "2026-05-20",
    unitAmountMinor: 3000,
  });
  // Still in trial at NOW.
  await subscribe({
    price: proUsd,
    signedUpOn: "2026-08-01",
    startedOn: "2026-08-01",
    trialDays: 30,
    unitAmountMinor: 132_000,
  });

  // Churned outright in June.
  const churned = await subscribe({
    price: starterUsd,
    signedUpOn: "2026-01-05",
    startedOn: "2026-01-05",
    unitAmountMinor: 5200,
  });
  await cancelSubscription({
    organizationId,
    businessId: biz.id,
    subscriptionId: churned.subscription.id,
    atPeriodEnd: false,
    now: day("2026-06-10"),
  });
  // Cancelled by dunning — involuntary churn, which the split reports separately.
  const dunned = await subscribe({
    price: starterEur,
    signedUpOn: "2026-01-20",
    startedOn: "2026-01-20",
    unitAmountMinor: 3100,
  });
  await cancelSubscription({
    organizationId,
    businessId: biz.id,
    subscriptionId: dunned.subscription.id,
    atPeriodEnd: false,
    now: day("2026-07-02"),
    cancelReason: "not_paid",
  });
  // Booked to stop at period end: active, committed to nothing.
  const leaving = await subscribe({
    price: starterUsd,
    signedUpOn: "2026-03-01",
    startedOn: "2026-03-01",
    unitAmountMinor: 5300,
  });
  await cancelSubscription({
    organizationId,
    businessId: biz.id,
    subscriptionId: leaving.subscription.id,
    atPeriodEnd: true,
    now: day("2026-08-05"),
  });

  // A coupon, applied — the leakage and discount reports need one that is redeemed.
  await createCoupon({
    organizationId,
    businessId: biz.id,
    code: "GOLDEN10",
    name: "Golden 10%",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  await applyCouponToSubscription({
    organizationId,
    businessId: biz.id,
    subscriptionId: a.subscription.id,
    code: "GOLDEN10",
    now: day("2026-06-01"),
  });

  // Invoices: one paid, one left posted, one driven to not_paid.
  const line = (amountMinor: number) => [
    { description: "Golden line", amountMinor: BigInt(amountMinor), quantity: 1 },
  ];
  const paid = await createManualInvoice({
    organizationId,
    businessId: biz.id,
    customerId: a.customer.id,
    currency: "USD",
    lines: line(5000),
  });
  await recordOfflinePayment({
    organizationId,
    businessId: biz.id,
    invoicePublicId: paid.invoice.publicId,
    method: "wire",
  });
  const posted = await createManualInvoice({
    organizationId,
    businessId: biz.id,
    customerId: a.customer.id,
    currency: "USD",
    lines: line(7500),
    netDays: 15,
  });
  const overdue = await createManualInvoice({
    organizationId,
    businessId: biz.id,
    customerId: churned.customer.id,
    currency: "USD",
    lines: line(12_500),
  });
  // `not_paid` is a dunning OUTCOME; the fixture needs the state, not the retry schedule.
  await systemDb
    .update(invoices)
    .set({ status: "not_paid", dunningStatus: "stopped" })
    .where(eq(invoices.id, overdue.invoice.id));

  await stampInvoices(biz.id, [
    [paid.invoice.id, "2026-06-05"],
    [posted.invoice.id, "2026-07-20"],
    [overdue.invoice.id, "2026-05-12"],
  ]);

  // Settled money, at exact instants. Two payments and a refund across both currencies.
  await systemDb.insert(transactions).values(
    (
      [
        ["payment", 5000, "USD", "2026-06-05"],
        ["payment", 30_000, "USD", "2026-07-11"],
        ["payment", 3000, "EUR", "2026-07-18"],
        ["refund", 1200, "USD", "2026-07-25"],
      ] as const
    ).map(([type, amountMinor, currency, on]) => ({
      organizationId,
      businessId: biz.id,
      publicId: publicId("txn"),
      type,
      status: "succeeded" as const,
      amountMinor: BigInt(amountMinor),
      currency,
      occurredAt: day(on),
      createdAt: day(on),
    })),
  );

  await stampLedgerTimes(biz.id);
  // No retry schedule on the fixture's invoices — same reason the terms are parked.
  await systemDb
    .update(invoices)
    .set({ nextAttemptAt: null })
    .where(eq(invoices.businessId, biz.id));
  await assertSeedShape(biz.id);
  await fillMetricDaily(organizationId, biz.id);
  return { organizationId, businessId: biz.id };
}

/** A tick unfinished for longer than this was abandoned, not running — never wait on it. */
const TICK_ABANDONED_AFTER_MS = 5 * 60_000;
/** Give up waiting well past a legitimate slow tick; proceeding beats hanging a gate. */
const FENCE_WAIT_TIMEOUT_MS = 90_000;

/** Block until no clock tick that started before now is still open. */
async function waitForInFlightTicks(): Promise<void> {
  const deadline = Date.now() + FENCE_WAIT_TIMEOUT_MS;
  const fencedAt = new Date();
  for (;;) {
    const [open] = await systemDb
      .select({ id: clockTicks.id })
      .from(clockTicks)
      .where(
        and(
          isNull(clockTicks.finishedAt),
          lte(clockTicks.startedAt, fencedAt),
          gt(clockTicks.startedAt, new Date(Date.now() - TICK_ABANDONED_AFTER_MS)),
        ),
      )
      .limit(1);
    if (!open) return;
    if (Date.now() >= deadline) {
      console.warn("analytics-golden: a clock tick is still open — seeding anyway");
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The fence row for this book, or null. Evidence, and what the release below removes. */
export async function goldenFence(book: GoldenBook) {
  const [row] = await systemDb
    .select({ businessId: timeTravels.businessId, simulatedNow: timeTravels.simulatedNow })
    .from(timeTravels)
    .where(eq(timeTravels.businessId, book.businessId))
    .limit(1);
  return row ?? null;
}

/**
 * Drop the fence. Must run even when the suite throws: a `time_travels` row left on a
 * business keeps the real clock away from it forever, which is worse than the flake it
 * was added to fix. Scoped to this book's business — nothing else is ever unfenced.
 */
export async function releaseGoldenFence(book: GoldenBook): Promise<void> {
  await systemDb.delete(timeTravels).where(eq(timeTravels.businessId, book.businessId));
}

/** How far back the semantic layer is filled — past the longest range a report quotes. */
const METRIC_DAILY_DAYS = 400;

/**
 * Fill `metric_daily` for the fixture, up to YESTERDAY.
 *
 * Without it the gate only ever exercises the reconstruction: the book is a fresh
 * organization every run, so the store has no row for it and every stock read falls back —
 * a mutation that made the stored answer wrong left all 102 payloads identical, which is
 * exactly a path nobody is checking.
 *
 * It stops a day short of `NOW` on purpose, so BOTH arms stay covered: the history is
 * answered from the store, today still reconstructs. That is also what production looks
 * like between the 5-minutely current-day job's runs.
 */
async function fillMetricDaily(organizationId: string, businessId: string): Promise<void> {
  for (let i = 1; i <= METRIC_DAILY_DAYS; i++) {
    const periodEnd = utcDayString(new Date(NOW.getTime() - i * 86_400_000));
    const rows = await withTenant(organizationId, (tx) =>
      computeMetricPeriod(tx, businessId, "day", periodEnd),
    );
    await writeMetricDay({ organizationId, businessId, grain: "day", periodEnd, rows });
  }
}

/** What the book must contain once seeded. A drift here is a raced seed, not a rewrite. */
const SEED_SHAPE: Record<string, number> = {
  subscriptions: 8,
  invoices: 3,
  mrr_movements: 10,
  // 4 seeded settlements + the one the offline payment books.
  transactions: 5,
};

/**
 * Fail on the SEED, not on the comparison.
 *
 * Anything that reaches this book before the capture does — a billing tick, a dunning
 * sweep — changes every figure downstream, and the gate would report it as a hundred
 * differing reports. Named here instead, once.
 */
async function assertSeedShape(businessId: string): Promise<void> {
  const [row] = await systemDb.execute<Record<string, string>>(sql`
    select (select count(*) from subscriptions where business_id = ${businessId}) as subscriptions,
           (select count(*) from invoices      where business_id = ${businessId}) as invoices,
           (select count(*) from mrr_movements where business_id = ${businessId}) as mrr_movements,
           (select count(*) from transactions  where business_id = ${businessId}) as transactions
  `);
  const got = Object.fromEntries(Object.keys(SEED_SHAPE).map((k) => [k, Number(row?.[k] ?? -1)]));
  const wrong = Object.keys(SEED_SHAPE).filter((k) => got[k] !== SEED_SHAPE[k]);
  if (wrong.length > 0) {
    throw new Error(
      `the golden book was seeded wrong (${wrong
        .map((k) => `${k}: expected ${SEED_SHAPE[k]}, got ${got[k]}`)
        .join("; ")}) — something else wrote to it while it was being built`,
    );
  }
}

/** Invoice dates all follow creation, which the services stamp at wall clock. */
async function stampInvoices(businessId: string, at: Array<[string, string]>): Promise<void> {
  for (const [id, on] of at) {
    await systemDb
      .update(invoices)
      .set({ createdAt: day(on), dueDate: day(on) })
      .where(eq(invoices.id, id));
  }
  await systemDb
    .update(payments)
    .set({
      createdAt: sql`(select created_at from invoices where invoices.id = ${payments.invoiceId})`,
    })
    .where(
      inArray(
        payments.invoiceId,
        at.map(([id]) => id),
      ),
    );
  await systemDb
    .update(invoices)
    .set({ paidAt: sql`${invoices.createdAt}` })
    .where(and(eq(invoices.businessId, businessId), eq(invoices.status, "paid")));
}

/**
 * Move the MRR ledger onto the book's own timeline.
 *
 * `recomputeSubscriptionMrr` stamps `occurred_at` with the clock, not with the instant the
 * caller is simulating, so every movement would otherwise land on the day the fixture was
 * seeded — one spike, and a different one each run.
 */
async function stampLedgerTimes(businessId: string): Promise<void> {
  await systemDb.execute(sql`
    update mrr_movements m
       set occurred_at = case
             when m.reason = 'churn' then coalesce(s.canceled_at, s.started_at, s.created_at)
             else coalesce(s.started_at, s.created_at)
           end
      from subscriptions s
     where s.id = m.subscription_id
       and m.business_id = ${businessId}
  `);
  await systemDb
    .update(subscriptions)
    .set({ createdAt: sql`coalesce(${subscriptions.startedAt}, ${subscriptions.createdAt})` })
    .where(eq(subscriptions.businessId, businessId));
  // The coupon lands after the subscription started, so its movement needs its own date or
  // it would sit on top of the `new` row and the two would be indistinguishable.
  await systemDb
    .update(mrrMovements)
    .set({ occurredAt: day("2026-06-01") })
    .where(and(eq(mrrMovements.businessId, businessId), eq(mrrMovements.reason, "contraction")));
  await systemDb
    .update(customers)
    .set({ updatedAt: sql`${customers.createdAt}` })
    .where(eq(customers.businessId, businessId));
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Every report the registry declares, including the variant keys it lists. */
export function reportKeys(): string[] {
  const keys = new Set<string>();
  for (const r of REPORTS) {
    keys.add(r.key);
    for (const v of r.variants ?? []) keys.add(v.key);
  }
  return [...keys].sort();
}

/** Golden file name → the payload it holds. Names are the file stems under `GOLDEN_DIR`. */
export async function captureAll(book: GoldenBook): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const { organizationId: org, businessId: biz } = book;

  for (const key of reportKeys()) {
    let payload: unknown;
    try {
      payload = await resolveReport(org, biz, key, { now: NOW });
    } catch (err) {
      // A refusal is an answer too — captured so that a rewrite which starts answering,
      // or starts refusing, shows up as a difference rather than as a silent change.
      if (!(err instanceof ReportError)) throw err;
      payload = { error: err.message };
    }
    out.set(`report.${key}`, payload);
  }

  for (const range of ANALYTICS_RANGES) {
    out.set(`analytics.${range}`, await computeBusinessAnalytics(org, biz, { range, now: NOW }));
  }
  out.set("metrics", await computeBusinessMetrics(org, biz, NOW));
  return out;
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `cus_a1b2…` — a public id carries a generated suffix and is no more stable than a uuid. */
const PUBLIC_ID = /^[a-z]{2,5}_[A-Za-z0-9_-]{8,}$/;
/** Timestamps we replace by name, not by shape: a DATE in a label is real output. */
const TIME_KEYS = new Set(["as_of", "computed_at", "generated_at"]);

/**
 * Canonicalise a payload: keys sorted, generated identifiers mapped to stable placeholders,
 * clock-derived fields replaced by a constant.
 *
 * Placeholders are numbered in order of first appearance so two different ids stay two
 * different strings — collapsing them all to one token would hide a swap.
 */
export function canonicalise(value: unknown): unknown {
  const ids = new Map<string, string>();
  const placeholder = (raw: string) => {
    let seen = ids.get(raw);
    if (!seen) {
      seen = `<id:${ids.size + 1}>`;
      ids.set(raw, seen);
    }
    return seen;
  };

  const walk = (node: unknown, key?: string): unknown => {
    if (node === null || node === undefined) return node ?? null;
    if (typeof node === "bigint") return node.toString();
    if (node instanceof Date)
      return key != null && TIME_KEYS.has(key) ? "<timestamp>" : node.toISOString();
    if (typeof node === "string") {
      if (key != null && TIME_KEYS.has(key)) return "<timestamp>";
      return UUID.test(node) || PUBLIC_ID.test(node) ? placeholder(node) : node;
    }
    if (Array.isArray(node)) return node.map((v) => walk(v, key));
    if (typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>).sort(([l], [r]) =>
        l < r ? -1 : l > r ? 1 : 0,
      );
      return Object.fromEntries(entries.map(([k, v]) => [k, walk(v, k)]));
    }
    return node;
  };
  return walk(value);
}

/** The exact bytes a golden file holds. */
export function serialise(value: unknown): string {
  return `${JSON.stringify(canonicalise(value), null, 2)}\n`;
}
