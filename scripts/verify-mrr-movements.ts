/**
 * MRR movement ledger (0254) + the retention ratios built on it.
 *
 * The ledger's whole claim is an identity: **Σ delta over a window = the change in MRR
 * across it**. Everything else — expansion, contraction, GRR, NRR, quick ratio — is a
 * reading of rows that satisfy it, so the identity is checked first and directly, against
 * `subscriptions.mrr` itself rather than against another reading of the same rows.
 *
 * Then each classification is driven for real, through the engine's own mutation paths:
 * an upgrade must file as expansion and a downgrade as contraction, because the pair is
 * indistinguishable from the stock column alone — that invisibility is the defect this
 * table exists to fix.
 *
 *   pnpm verify:mrr-movements
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  reactivateSubscriptionWithOptions,
} from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { scheduleChange } from "@/modules/subscriptions/scheduled-changes";
import { applyManualDiscount } from "@/modules/coupons/service";
import { updateBusiness } from "@/modules/tenancy/service";
import { computeBusinessAnalytics } from "@/modules/metrics/analytics";
import { classifyMrrMove, retentionRates } from "@/modules/metrics/mrr-movements";
import { mrrMovements, subscriptions, exchangeRateHistory } from "@db/schema";
import { removeCurrency } from "@/modules/tenancy/exchange-rates";
import { buildRateTimeline } from "@/platform/fx/history";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "Movement Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Movement Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plans" });
const price = async (amountMinor: number, model: "flat" | "per_unit" = "flat") =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model,
    currency: "USD",
    amountMinor,
    interval: "month",
  });
const p50 = await price(5000);
// Quantity only moves on a per-unit price — a flat price refuses any quantity but 1, which
// is what makes it the wrong fixture for an upgrade.
const pu50 = await price(5000, "per_unit");

async function newSub(p: typeof p50) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `mv${Math.random()}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  const created = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: p, quantity: 1 }],
  });
  return { sub: created.subscription, itemId: created.items[0]!.publicId };
}

const movementsFor = (subscriptionId: string) =>
  withTenant(orgId, (tx) =>
    tx
      .select({
        reason: mrrMovements.reason,
        previous: mrrMovements.previousMrrMinor,
        next: mrrMovements.newMrrMinor,
        delta: mrrMovements.deltaMinor,
        planProductId: mrrMovements.planProductId,
        previousPlanProductId: mrrMovements.previousPlanProductId,
      })
      .from(mrrMovements)
      .where(eq(mrrMovements.subscriptionId, subscriptionId))
      .orderBy(asc(mrrMovements.occurredAt), asc(mrrMovements.createdAt)),
  );

// ── The classifier, in isolation ─────────────────────────────────────────────
// Driven directly because two of its branches are hard to stage through the engine and
// easy to get wrong: revenue reaching zero on a subscription that is still RUNNING is a
// contraction, not churn, and a resumed pause is neither new business nor a win-back.
ok(
  "classify: 0 → x with no history is new",
  classifyMrrMove({
    previousMinor: 0n,
    nextMinor: 5000n,
    status: "active",
    priorReason: null,
    hasPrior: false,
  }) === "new",
);
ok(
  "classify: 0 → x after a pause is a resume",
  classifyMrrMove({
    previousMinor: 0n,
    nextMinor: 5000n,
    status: "active",
    priorReason: "pause",
    hasPrior: true,
  }) === "resume",
);
ok(
  "classify: 0 → x after a churn is a reactivation",
  classifyMrrMove({
    previousMinor: 0n,
    nextMinor: 5000n,
    status: "active",
    priorReason: "churn",
    hasPrior: true,
  }) === "reactivation",
);
ok(
  "classify: x → 0 while STILL ACTIVE is contraction, not churn",
  classifyMrrMove({
    previousMinor: 5000n,
    nextMinor: 0n,
    status: "active",
    priorReason: "new",
    hasPrior: true,
  }) === "contraction",
);
ok(
  "classify: x → 0 on a cancelled subscription is churn",
  classifyMrrMove({
    previousMinor: 5000n,
    nextMinor: 0n,
    status: "cancelled",
    priorReason: "new",
    hasPrior: true,
  }) === "churn",
);
ok(
  "classify: x → 0 on a paused subscription is a pause",
  classifyMrrMove({
    previousMinor: 5000n,
    nextMinor: 0n,
    status: "paused",
    priorReason: "new",
    hasPrior: true,
  }) === "pause",
);

// ── The engine's own paths ───────────────────────────────────────────────────
const { sub: opened, itemId: openedItem } = await newSub(pu50);
{
  const m = await movementsFor(opened.id);
  ok("create: one opening row", m.length === 1);
  ok("create: …filed as new, 0 → 5000", m[0]?.reason === "new" && m[0]?.next === 5000n);
}

// Upgrade, then downgrade. Indistinguishable from the stock column alone — this pair is
// the reason the table exists.
// Quantity, not a price swap: the point is the DIRECTION of the move, and a quantity
// edit exercises the same `/change` path with less fixture noise.
await changeSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: opened.id,
  changes: [{ itemId: openedItem, newQuantity: 3 }],
  now: new Date(),
});
await changeSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: opened.id,
  changes: [{ itemId: openedItem, newQuantity: 1 }],
  now: new Date(),
});
{
  const m = await movementsFor(opened.id);
  ok(
    "change: an upgrade files as expansion",
    m.some((r) => r.reason === "expansion" && r.delta === 10000n),
  );
  ok(
    "change: a downgrade files as contraction",
    m.some((r) => r.reason === "contraction" && r.delta === -10000n),
  );
}

// A 100% discount takes revenue to zero on a subscription that is still running.
await applyManualDiscount({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: opened.id,
  kind: "percentage",
  percentOffBps: 10000,
  durationType: "forever",
  now: new Date(),
});
{
  const m = await movementsFor(opened.id);
  const last = m.at(-1)!;
  ok(
    "discount: 100% off is a contraction to 0, not churn",
    last.reason === "contraction" && last.next === 0n,
  );
}

// Pause / resume keep the identity whole even though neither is a sale or a loss.
const { sub: paused } = await newSub(p50);
await pauseSubscription({ organizationId: orgId, businessId: biz.id, subscriptionId: paused.id });
await resumeSubscription({ organizationId: orgId, businessId: biz.id, subscriptionId: paused.id });
{
  const m = await movementsFor(paused.id);
  ok(
    "pause: files as pause",
    m.some((r) => r.reason === "pause" && r.next === 0n),
  );
  ok("resume: files as resume, not as new business", m.at(-1)?.reason === "resume");
}

// Churn.
const { sub: churned } = await newSub(p50);
await cancelSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: churned.id,
  atPeriodEnd: false,
  now: new Date(),
});
{
  const m = await movementsFor(churned.id);
  ok("cancel: files as churn to 0", m.at(-1)?.reason === "churn" && m.at(-1)?.next === 0n);
}

// ── The plan dimension (0256) ────────────────────────────────────────────────
// Stored at write time, because after a plan change a join cannot reproduce which plan the
// money moved ON — and that change is exactly the movement being explained. The ordering
// trap this guards: `createSubscription` records its opening move, and had that stayed
// before the items insert, every first sale would file under "no plan".
{
  const m = await movementsFor(opened.id);
  ok("plan: the opening move carries a plan id", m[0]?.planProductId === product.id);
  ok(
    "plan: every later move carries it too",
    m.every((r) => r.planProductId === product.id),
  );
  const other = await movementsFor(paused.id);
  ok("plan: a second subscription carries its own", other[0]?.planProductId === product.id);
}

// ── The from-plan dimension (0258) ───────────────────────────────────────────
// `plan_product_id` alone cannot tell "three seats instead of one" from "moved to a
// pricier plan": both land on a plan and both file as expansion. The from-plan is what
// separates them, and it comes from the PREVIOUS movement row — the live items describe
// the destination only, and the trip is the thing being explained.
const productB = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Plans B",
});
const priceOnB = (amountMinor: number) =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: productB.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor,
    interval: "month",
  });
const pB90 = await priceOnB(9000);
const pB200 = await priceOnB(20000);
const { sub: moved, itemId: movedItem } = await newSub(p50);
await changeSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: moved.id,
  changes: [{ itemId: movedItem, newPriceId: pB90.publicId }],
  now: new Date(),
});
{
  const m = await movementsFor(moved.id);
  ok("from-plan: a first movement has no plan to come from", m[0]?.previousPlanProductId === null);
  const change = m.at(-1)!;
  ok(
    "from-plan: a plan change records previous ≠ current",
    change.previousPlanProductId === product.id && change.planProductId === productB.id,
  );
  const qty = (await movementsFor(opened.id)).find((r) => r.reason === "expansion")!;
  ok(
    "from-plan: more quantity on the SAME plan records previous === current",
    qty.previousPlanProductId === product.id && qty.planProductId === product.id,
  );
}

// ── The scheduled delta (0259) ───────────────────────────────────────────────
// Priced when the change is scheduled, so a report sums a column instead of re-running an
// estimate per pending row. Gross: no discounts, catalog prices of the moment.
{
  const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const up = await scheduleChange({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: moved.id,
    type: "change",
    effectiveAt: soon,
    changes: [{ itemId: movedItem, newPriceId: pB200.publicId }],
  });
  ok("scheduled: an upgrade stores a positive delta, 9000 → 20000", up.mrrDeltaMinor === 11000n);
  const down = await scheduleChange({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: moved.id,
    type: "change",
    effectiveAt: soon,
    changes: [{ itemId: movedItem, newPriceId: p50.publicId }],
  });
  ok("scheduled: a downgrade stores a negative delta, 9000 → 5000", down.mrrDeltaMinor === -4000n);
  const cancel = await scheduleChange({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: moved.id,
    type: "cancel",
    effectiveAt: soon,
  });
  ok(
    "scheduled: a cancel stores no delta — scheduling it moves no rate",
    cancel.mrrDeltaMinor === null,
  );
}

// ── The FX rate, as at the time the money moved (0260) ───────────────────────
// Movements are stored in the subscription's own currency, and every converted roll-up
// divides by the business's CURRENT manual rate at read time. That map is overwritten in
// place, so before 0260 a rate edit silently restated last March's expansion. The stamp is
// what makes a converted figure sourceable, so what is checked here is that it is taken at
// INSERT time and never moves afterwards.
{
  const fxFor = (subscriptionId: string) =>
    withTenant(orgId, (tx) =>
      tx
        .select({
          reason: mrrMovements.reason,
          currency: mrrMovements.currency,
          delta: mrrMovements.deltaMinor,
          rate: mrrMovements.exchangeRate,
          base: mrrMovements.exchangeRateBase,
        })
        .from(mrrMovements)
        .where(eq(mrrMovements.subscriptionId, subscriptionId))
        .orderBy(asc(mrrMovements.occurredAt), asc(mrrMovements.createdAt)),
    );
  const foreignPrice = (currency: string) =>
    createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: product.id,
      type: "recurring",
      model: "per_unit",
      currency,
      amountMinor: 9000,
      interval: "month",
    });

  // A rate for EUR, none for GBP — the two answers are different facts and the column has
  // to keep them apart.
  await updateBusiness(orgId, biz.publicId, { exchangeRates: { EUR: 0.9 } });

  // The business's OWN currency: 1, with the base named. Parity here is a fact, not an
  // assumption, which is why this one case stores a number at all.
  {
    const own = await fxFor(opened.id);
    ok(
      "fx: a movement in the business's own currency stores rate 1 against its base",
      own.length > 0 && own.every((r) => Number(r.rate) === 1 && r.base === "USD"),
    );
  }

  // A foreign currency: the rate that was in effect, in the documented direction — units
  // of the MOVEMENT's currency per 1 unit of the base. 1 USD = 0.9 EUR stores 0.9 on the
  // EUR row, which is the direction analytics divides by (minor / rate).
  const { sub: eur, itemId: eurItem } = await newSub(await foreignPrice("EUR"));
  {
    const m = await fxFor(eur.id);
    ok("fx: a foreign movement is recorded in its own currency", m[0]?.currency === "EUR");
    ok(
      "fx: …and stamps the rate in effect, EUR per 1 USD",
      m.length === 1 && Number(m[0]?.rate) === 0.9 && m[0]?.base === "USD",
    );
  }

  // No rate configured for GBP: NULL, never 1. A missing rate and parity are different
  // facts, and 1 would assert a parity nobody entered.
  const { sub: gbp } = await newSub(await foreignPrice("GBP"));
  {
    const m = await fxFor(gbp.id);
    ok(
      "fx: no rate configured for the currency stores NULL, not 1",
      m.length === 1 && m[0]?.rate === null && m[0]?.base === null,
    );
  }

  // The point of the whole column: move the business's rate and the row already written
  // must not budge, while the NEXT movement takes the new rate. Before this, both figures
  // were the same read-time conversion and history repriced itself.
  await updateBusiness(orgId, biz.publicId, { exchangeRates: { EUR: 0.8 } });
  {
    const after = await fxFor(eur.id);
    ok(
      "fx: changing the business's rate does NOT alter the stamp on an existing row",
      after.length === 1 && Number(after[0]?.rate) === 0.9,
    );
  }
  await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: eur.id,
    changes: [{ itemId: eurItem, newQuantity: 2 }],
    now: new Date(),
  });
  {
    const m = await fxFor(eur.id);
    ok(
      "fx: the next movement stamps the NEW rate, beside the old one",
      m.length === 2 &&
        Number(m[0]?.rate) === 0.9 &&
        m[1]?.reason === "expansion" &&
        Number(m[1]?.rate) === 0.8,
    );
  }

  await updateBusiness(orgId, biz.publicId, { exchangeRates: { EUR: 0.9 } });
}

// ── The rate history (0264) ──────────────────────────────────────────────────
//
// `businesses.exchange_rates` is overwritten in place, so the value standing there is the
// only one that exists and a converted figure that moved between two readings cannot say
// whether the book changed or the rate did. This records each observed change, which is
// what lets the waterfall carry an FX column at all.
//
// The rate writes above already drove three changes on EUR (0.9 → 0.8 → 0.9), so the
// timeline is read here rather than staged again.
{
  const history = () =>
    withTenant(orgId, (tx) =>
      tx
        .select({
          currency: exchangeRateHistory.currency,
          base: exchangeRateHistory.baseCurrency,
          rate: exchangeRateHistory.rate,
          effectiveFrom: exchangeRateHistory.effectiveFrom,
        })
        .from(exchangeRateHistory)
        .where(eq(exchangeRateHistory.businessId, biz.id))
        .orderBy(asc(exchangeRateHistory.effectiveFrom), asc(exchangeRateHistory.createdAt)),
    );

  const rows = await history();
  ok(
    "rate history: every rate write is observed, in order, quoted against the base",
    rows.length === 3 &&
      rows.every((r) => r.currency === "EUR" && r.base === "USD") &&
      rows.map((r) => Number(r.rate)).join(",") === "0.9,0.8,0.9",
  );

  // A settings save that leaves the rate where it was is NOT a rate change. Recording it
  // would turn the timeline into one row per save and make "when did this move" unanswerable.
  await updateBusiness(orgId, biz.publicId, { exchangeRates: { EUR: 0.9 } });
  ok("rate history: writing the same rate again appends nothing", (await history()).length === 3);

  // The reader, at the instants that matter. Before the first observation there is nothing
  // to read, so the answer is the CURRENT rate — the one every converted figure already
  // uses. That fallback is why adding this table restates nothing.
  {
    const obs = (await history()).map((r) => ({
      currency: r.currency,
      base: r.base,
      rate: r.rate,
      effectiveFrom: r.effectiveFrom,
    }));
    const t = buildRateTimeline({ base: "USD", currentRates: { EUR: 0.9 }, observations: obs });
    const before = new Date(obs[0]!.effectiveFrom.getTime() - 1);
    ok(
      "rate history: before the first observation the reader falls back to the current rate",
      t.rateAt("EUR", before) === "0.9",
    );
    ok(
      "rate history: at an instant between two observations it reads the earlier one",
      Number(t.rateAt("EUR", new Date(obs[1]!.effectiveFrom.getTime() + 1))) === 0.8,
    );
    ok("rate history: the base currency is 1 against itself", t.rateAt("USD", new Date()) === "1");
    ok(
      "rate history: a currency with no rate and no observation reads null, never 1",
      t.rateAt("GBP", new Date()) === null,
    );
  }

  // Removing the currency is an observation of its own: NO usable rate from here on, which
  // is a different fact from the last one it held. Leaving the old rate standing forever
  // would convert at a rate the business no longer holds.
  await removeCurrency({
    organizationId: orgId,
    businessId: biz.id,
    currency: "EUR",
    now: new Date(),
  });
  const afterRemoval = await history();
  ok(
    "rate history: removing a currency records the absence, as NULL and never as 1",
    afterRemoval.length === 4 && afterRemoval[3]!.rate === null,
  );

  /**
   * Append-only at the GRANT, not merely in a comment — the same guarantee as the movement
   * ledger. Asserted on SQLSTATE 42501 rather than on message text: drizzle wraps the real
   * PostgresError one level down, and matching on words is how four such checks in
   * `verify:audit` went red on a dependency bump while the guarantee was intact.
   */
  const isGrantDenial = (e: unknown): boolean => {
    for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
      const err = cur as { code?: string; message?: string; cause?: unknown };
      if (err.code === "42501") return true;
      if (
        String(err.message ?? "")
          .toLowerCase()
          .includes("permission denied")
      )
        return true;
      cur = err.cause;
    }
    return false;
  };
  let updateDenied = false;
  try {
    await withTenant(orgId, (tx) => tx.update(exchangeRateHistory).set({ rate: "1" }));
  } catch (e: unknown) {
    updateDenied = isGrantDenial(e);
  }
  ok("rate history: UPDATE is denied (append-only)", updateDenied);
  let deleteDenied = false;
  try {
    await withTenant(orgId, (tx) => tx.delete(exchangeRateHistory));
  } catch (e: unknown) {
    deleteDenied = isGrantDenial(e);
  }
  ok("rate history: DELETE is denied (append-only)", deleteDenied);

  // Put the rate back: the checks below read a converted book.
  await updateBusiness(orgId, biz.publicId, { exchangeRates: { EUR: 0.9 } });
}

// ── The identity ─────────────────────────────────────────────────────────────
// Σ delta per subscription must equal what the subscription stores. Checked in SQL against
// the column itself, not against another reading of these rows — a ledger that only agrees
// with itself proves nothing.
{
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        subscriptionId: subscriptions.id,
        stored: subscriptions.mrr,
        summed: sql<string>`coalesce(sum(${mrrMovements.deltaMinor}), 0)`,
      })
      .from(subscriptions)
      .leftJoin(mrrMovements, eq(mrrMovements.subscriptionId, subscriptions.id))
      .where(and(eq(subscriptions.businessId, biz.id)))
      .groupBy(subscriptions.id, subscriptions.mrr),
  );
  const disagreeing = rows.filter((r) => BigInt(r.summed) !== (r.stored ?? 0n));
  for (const d of disagreeing) console.log("  ↳ disagrees:", JSON.stringify(d));
  ok(
    `identity: Σ delta = stored mrr for all ${rows.length} subscriptions`,
    disagreeing.length === 0,
  );
}

// ── The ratio arithmetic ─────────────────────────────────────────────────────
// Against known numbers, because a dashboard that returns *a* number always looks like it
// works, and staging a fixture a calendar month in the past to prove 88% would test the
// clock more than the formula.
//
// A base of 100000 that loses 5000 to contraction and 15000 to churn, wins 12000 of
// expansion and 3000 back, and sells 40000 of new business:
//   GRR = (100000 − 20000) / 100000                       = 80%
//   NRR = (100000 + 12000 + 3000 − 20000) / 100000        = 95%
//   quick ratio = (40000 + 12000 + 3000) / 20000          = 2.75×
{
  const r = retentionRates({
    startingMrr: 100000,
    newMrr: 40000,
    expansion: 12000,
    reactivation: 3000,
    contraction: 5000,
    churn: 15000,
  });
  ok("ratios: GRR = 80%", r.gross_retention_bps === 8000);
  ok("ratios: NRR = 95% — expansion counts, new business does not", r.net_retention_bps === 9500);
  ok("ratios: quick ratio = 2.75×", r.quick_ratio_bps === 27500);
  const grown = retentionRates({
    startingMrr: 100000,
    newMrr: 0,
    expansion: 30000,
    reactivation: 0,
    contraction: 5000,
    churn: 5000,
  });
  ok("ratios: NRR exceeds 100% when expansion outruns losses", grown.net_retention_bps === 12000);
  ok("ratios: …while GRR cannot, by construction", grown.gross_retention_bps === 9000);
  const noLoss = retentionRates({
    startingMrr: 100000,
    newMrr: 10000,
    expansion: 0,
    reactivation: 0,
    contraction: 0,
    churn: 0,
  });
  ok("ratios: nothing lost → quick ratio is null, not Infinity", noLoss.quick_ratio_bps === null);
  const noBase = retentionRates({
    startingMrr: 0,
    newMrr: 10000,
    expansion: 0,
    reactivation: 0,
    contraction: 0,
    churn: 0,
  });
  ok(
    "ratios: no base → retention is null, not 0%",
    noBase.gross_retention_bps === null && noBase.net_retention_bps === null,
  );
}

// ── The ratios ───────────────────────────────────────────────────────────────
// Analytics quotes retention over the LAST COMPLETE calendar month; everything above
// happened today, so this month's book is the one with movement in it and last month's is
// empty. The assertion is therefore about the shape of the answer when there is no base:
// a rate over nothing is undefined, and reporting 0% would read as total churn.
{
  const a = await computeBusinessAnalytics(orgId, biz.id, {
    range: "daily",
    currency: "USD",
    now: new Date(),
  });
  const r = a.kpis.retention;
  console.log("retention:", JSON.stringify(r));
  ok(
    "analytics: retention names the month it describes",
    typeof r.window_label === "string" && r.window_label.length > 0,
  );
  ok(
    "analytics: no base last month → rates are null, not 0%",
    r.starting_mrr_minor === 0 && r.gross_retention_bps === null && r.net_retention_bps === null,
  );
  const keys = [
    "total_new_mrr",
    "total_expansion_mrr",
    "total_reactivation_mrr",
    "total_contraction_mrr",
    "total_churn_mrr",
  ];
  ok(
    "analytics: all five movement series are present",
    keys.every((k) => a.series.some((s) => s.key === k)),
  );
  // The series bucket by occurrence, so today's moves land in the current window.
  const s = (k: string) => a.series.find((x) => x.key === k)!;
  ok(
    "analytics: new MRR series carries today's four sales",
    s("total_new_mrr").headline.value === 20000,
  );
  ok(
    "analytics: expansion series carries both upgrades — quantity and plan",
    s("total_expansion_mrr").headline.value === 14000,
  );
  ok(
    "analytics: contraction series carries the downgrade + the full discount",
    s("total_contraction_mrr").headline.value === 15000,
  );
  ok(
    "analytics: churn series carries the cancel and the pause",
    s("total_churn_mrr").headline.value === 10000,
  );
  // The per-plan breakdown describes the same month as the retention rates, which is LAST
  // month — this fixture's movement is all today, so its shape is what is checked here.
  ok("analytics: the per-plan breakdown is reported", Array.isArray(a.mrr_movement_by_plan));
}

// ── Reactivate with options ──────────────────────────────────────────────────
// After the analytics block, whose figures are exact: this adds a churn today. The rate must
// reach the ledger as ONE `reactivation` row, and be the discounted rate, not the list price.
{
  const { sub } = await newSub(p50);
  await applyManualDiscount({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "forever",
    now: new Date(),
  });
  await cancelSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    atPeriodEnd: false,
    now: new Date(),
  });
  const { subscription: re } = await reactivateSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
  });
  const m = await movementsFor(sub.id);
  const back = m.filter((r) => r.reason === "reactivation");
  const summed = m.reduce((a, r) => a + r.delta, 0n);
  console.log(
    "reactivate-with-options:",
    JSON.stringify(m, (_, v) => (typeof v === "bigint" ? `${v}` : v)),
  );
  ok("reactivate with options: stores the discounted rate", re.mrr === 4000n);
  ok(
    "reactivate with options: one reactivation row, 0 → the rate",
    back.length === 1 && back[0]!.previous === 0n && back[0]!.delta === 4000n,
  );
  ok("reactivate with options: Σ delta = stored mrr", summed === re.mrr);
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length} failed`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
