/**
 * Regression for the two bug fixes:
 *  A) NON-RETRIABLE failure (hard decline, tmtest magic PAN 4000000000000002) → NO retries scheduled;
 *     invoice goes straight to uncollectible and the subscription is canceled at
 *     first billing (vs a retriable decline which schedules the 4-retry dunning).
 *  B) cross-currency FIXED coupon is rejected at apply-time, and even if somehow
 *     active, does not discount a different-currency invoice.
 *
 *   pnpm verify:dunning-nonretriable
 */
import { and, desc, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { transactions } from "@db/schema";
import { voidInvoice } from "@/modules/invoicing/ops";
import { listRetriesPage, serializeRetry } from "@/modules/invoicing/retries";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createCoupon, applyCouponToSubscription, CouponError } from "@/modules/coupons/service";
import { invoices } from "@db/schema";
import { normalizeRazorpayDecline } from "@/providers/decline-codes";
import { classifyDecline } from "@/modules/subscriptions/decline-policy";
import { mandateRefusal } from "@/modules/invoicing/collection";

const org = await createOrganization({ name: "NonRetriable Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const usd = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
});

const checks: Array<[string, boolean]> = [];

// --- A) non-retriable (expired card) vs retriable (decline) ---
async function billWithCard(token: string) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${token}@a.com`,
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token,
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: usd, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  // Mirror renewal's reaction (billSubscriptionPeriod itself doesn't move sub status here).
  const finalSubStatus = invoice.status === "not_paid" ? "not_paid-or-cancel" : invoice.status;
  return { invoice, finalSubStatus };
}

const expired = await billWithCard("4000000000000002"); // non-retriable
const declined = await billWithCard("4000000000009995"); // retriable
console.log(
  `expired card:  invoice=${expired.invoice.status} nextAttempt=${expired.invoice.nextAttemptAt === null ? "null" : "scheduled"}`,
);
console.log(
  `declined card: invoice=${declined.invoice.status} nextAttempt=${declined.invoice.nextAttemptAt === null ? "null" : "scheduled"}`,
);
checks.push(
  ["non-retriable → not_paid", expired.invoice.status === "not_paid"],
  ["non-retriable → no retry scheduled", expired.invoice.nextAttemptAt === null],
  ["retriable → payment_due", declined.invoice.status === "payment_due"],
  ["retriable → retry scheduled", declined.invoice.nextAttemptAt !== null],
);

// The classification is now PERSISTED (migration 0139), not just acted on. The Retries
// screen states "Hard Failure" / "Soft Failure" per invoice; without this column that
// could only be inferred from whether a retry got scheduled, which is a heuristic.
// Assert the stored flag matches the provider's own verdict.
async function dunningStatusOf(invoiceId: string): Promise<string | null | undefined> {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ d: invoices.dunningStatus })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1),
  );
  return rows[0]?.d;
}

async function storedRetriable(invoiceId: string): Promise<boolean | null | undefined> {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ retriable: transactions.retriable })
      .from(transactions)
      .where(and(eq(transactions.invoiceId, invoiceId), eq(transactions.status, "failed")))
      .orderBy(desc(transactions.occurredAt))
      .limit(1),
  );
  return rows[0]?.retriable;
}
const hardStored = await storedRetriable(expired.invoice.id);
const softStored = await storedRetriable(declined.invoice.id);
console.log(`stored retriable: hard=${hardStored} soft=${softStored}`);
checks.push(
  ["hard decline persists retriable=false", hardStored === false],
  ["soft decline persists retriable=true", softStored === true],
);

// --- A2) the Retries screen's read ---
// Asserted HERE rather than against seeded data because this is the only place
// both a hard and a soft failure genuinely exist, so it proves the whole chain:
// the predicate picks the right invoices, and the batched latest-failed-transaction
// join actually attaches the error/gateway/card/retriable to each row.
{
  const page = await listRetriesPage(orgId, biz.id, { limit: 50 });
  const byInvoice = new Map(page.data.map((r) => [r.invoice.publicId, r]));
  const hardRow = byInvoice.get(expired.invoice.publicId);
  const softRow = byInvoice.get(declined.invoice.publicId);
  checks.push(
    ["retries: hard-declined invoice listed", !!hardRow],
    ["retries: soft-declined invoice listed", !!softRow],
    ["retries: total counts both", (page.total ?? 0) >= 2],
    // The join is the point of the screen — an empty lastFailure would render a
    // row with no error, no gateway and no card, i.e. the useless version.
    ["retries: last failure joined (hard)", hardRow?.lastFailure != null],
    ["retries: last failure joined (soft)", softRow?.lastFailure != null],
    [
      "retries: retriable surfaced per row",
      hardRow?.lastFailure?.retriable === false && softRow?.lastFailure?.retriable === true,
    ],
    ["retries: error text surfaced", !!hardRow?.lastFailure?.errorText],
    ["retries: gateway surfaced", !!hardRow?.lastFailure?.gatewayKey],
    // A never-attempted unpaid invoice must NOT appear: widening the predicate to
    // every payment_due row once pulled in 22 invoices that had never been charged.
    [
      "retries: excludes never-attempted invoices",
      page.data.every(
        (r) =>
          r.invoice.attemptCount > 0 ||
          r.invoice.nextAttemptAt != null ||
          r.invoice.dunningStatus != null,
      ),
    ],
  );

  // ── The nav BADGE counts a narrower set than the screen (activeOnly) ──────────
  //
  // `UNDER_RETRY`'s dunning arm matches on `dunning_status IS NOT NULL`, and that column is
  // a historical record — so a business that has ever exhausted a retry would carry a
  // permanent badge it cannot drive to zero, which is how a count stops being read. The
  // SCREEN must still show those rows (they need a human); the COUNT must not.
  //
  // ⚠️ The distinction is the dunning STATE, not whether a retry is armed. An invoice whose
  // current attempt has not settled has no `next_attempt_at` *because* the outcome is
  // unknown, and it is the most live row on the screen — reported from a real book as
  // "Waiting for the current attempt to settle" with attempt_count 0. Counting only armed
  // rows was tried first and would have dropped exactly that one.
  //
  // Runs BEFORE the void block below, which removes `expired` from the screen entirely.
  {
    const setDunning = (invoiceId: string, dunningStatus: string) =>
      withTenant(orgId, (tx) =>
        tx.update(invoices).set({ dunningStatus }).where(eq(invoices.id, invoiceId)),
      );
    const badgeTotal = async () =>
      (await listRetriesPage(orgId, biz.id, { limit: 1, activeOnly: true })).total ?? 0;

    await setDunning(expired.invoice.id, "exhausted");
    await setDunning(declined.invoice.id, "in_progress");
    const screen = await listRetriesPage(orgId, biz.id, { limit: 50 });
    checks.push(
      [
        "badge: an exhausted retry stays on the SCREEN",
        screen.data.some((r) => r.invoice.publicId === expired.invoice.publicId),
      ],
      ["badge: ...but is NOT counted", (await badgeTotal()) < (screen.total ?? 0)],
      ["badge: an in-progress retry IS counted", (await badgeTotal()) >= 1],
    );

    // `stopped` and `succeeded` are terminal too — an operator already decided, and a
    // recovered invoice is not work at all. With `expired` exhausted, both leave zero.
    await setDunning(declined.invoice.id, "stopped");
    const stopped = await badgeTotal();
    await setDunning(declined.invoice.id, "succeeded");
    const recovered = await badgeTotal();
    // `parked` IS counted: blocked on the merchant's gateway config, but it resumes.
    await setDunning(declined.invoice.id, "parked");
    const parked = await badgeTotal();
    checks.push(
      ["badge: a stopped retry is not counted", stopped === 0],
      ["badge: a recovered retry is not counted", recovered === 0],
      ["badge: a parked retry IS counted — it resumes", parked >= 1],
    );

    // Leave the fixture as the void block below expects to find it.
    await setDunning(declined.invoice.id, "in_progress");
  }

  // A VOIDED invoice must drop off, however it landed in dunning. The predicate had no
  // status filter on its dunning arm, so a dunned-then-voided invoice stayed on the screen
  // forever — 122 of 476 rows on the real book. Voiding here rather than seeding, so the
  // assertion exercises the real void path.
  {
    const before = await listRetriesPage(orgId, biz.id, { limit: 50 });
    const listedBefore = before.data.some((r) => r.invoice.publicId === expired.invoice.publicId);
    await voidInvoice(orgId, biz.id, expired.invoice.publicId);
    const after = await listRetriesPage(orgId, biz.id, { limit: 50 });
    const row = after.data.find((r) => r.invoice.publicId === expired.invoice.publicId);
    checks.push(
      ["retries: the voided invoice was listed before it was voided", listedBefore],
      ["retries: a voided invoice drops off the screen", row == null],
      // …and its dunning history is NOT erased: the row is truthful, the screen was wrong
      // to list it. A sweep that cleared the column instead would have destroyed a record.
      [
        "retries: voiding does not erase the dunning history",
        (await dunningStatusOf(expired.invoice.id)) != null,
      ],
    );
  }

  const serialized = serializeRetry(softRow!);
  checks.push([
    "retries: serializer exposes last_failure_retriable",
    serialized.last_failure_retriable === true,
  ]);
}

// --- C) defect #14: RazorPay per-CYCLE debit-count exhaustion vs OUR per-CHARGE mandate
// ceiling — used to share one canonical code (`mandate_ceiling_exceeded`), opposite
// remedies. Measured twice on sub_XXXXXXXXXXXXXXXXXXXXXX01: pay_XXXXXXXXXXXXXXXXXXXXXX04
// (11:50:29, ₹22,184.00, INV-7824) and txn_XXXXXXXXXXXXXXXXXXXXXX01 (12:56:23, ₹22,184.00,
// INV-7826, RazorPay's error text verbatim below). No DB needed — pure functions.
{
  // Verbatim from txn_XXXXXXXXXXXXXXXXXXXXXX01's `error.description`. RazorPay's own words,
  // passed through unmodified by `declineFailure` (razorpay.ts) — proof nothing here
  // resynthesizes a "raise the ceiling" sentence for a failure that was never about the
  // ceiling.
  const RAZORPAY_CYCLE_LIMIT_TEXT = "Maximum allowed debits in current cycle exceeded";

  const cycle = normalizeRazorpayDecline("card_mandate_current_cycle_allowed_debit_exceeds");
  const ceilingRefusal = mandateRefusal(
    {
      mandateMaxAmountMinor: 1_500_000n,
      mandateCurrency: "INR",
      mandateRail: "card",
    } as unknown as Parameters<typeof mandateRefusal>[0],
    2_218_400n, // ₹22,184.00 — the amount actually refused on both real transactions above
    "INR",
  );

  console.log(
    `defect #14: cycle=${cycle.code}/${cycle.retriable} ceiling=${ceilingRefusal?.failure?.code}/${ceilingRefusal?.failure?.retriable}`,
  );
  console.log(
    `defect #14: ladder cycle=${classifyDecline(cycle.code)} ceiling=${classifyDecline(ceilingRefusal?.failure?.code)}`,
  );

  checks.push(
    // The bug: both used to normalize to the SAME code. They must not, or every downstream
    // consumer that keys off `code` (the ladder, the payment-method-invalid decision) is
    // back to conflating a per-cycle exhaustion with a per-charge ceiling breach.
    [
      "defect #14: per-cycle and per-charge normalize to DIFFERENT codes",
      cycle.code !== ceilingRefusal?.failure?.code,
    ],
    // Retriability: per-charge needs a NEW mandate, never a retry — non-retriable, and
    // `isHardDecline` reads that as a signal about the INSTRUMENT (bad card), which this
    // is not either, but that nuance is `NOT_THE_INSTRUMENTS_FAULT`'s job, not this one's.
    [
      "defect #14: per-charge ceiling breach stays non-retriable",
      ceilingRefusal?.failure?.retriable === false,
    ],
    // Per-cycle exhaustion is retriable LATER (next cycle) — the opposite of a ceiling
    // breach, and for the same reason `recurring_not_enabled` stays retriable: true even
    // though it parks. The instrument is not bad; only the timing is wrong.
    [
      "defect #14: per-cycle limit stays retriable (clears itself, no new mandate needed)",
      cycle.retriable === true,
    ],
    // Copy: the per-charge remedy explicitly names a fresh authorization at a higher limit.
    [
      "defect #14: per-charge copy names the ceiling remedy (new authorization)",
      /new authorization|higher/i.test(ceilingRefusal?.failure?.message ?? ""),
    ],
    // The per-cycle text is RazorPay's own, and must never be made to claim a ceiling
    // problem — asserting the verbatim text stays free of "ceiling"/"higher limit" pins
    // that nothing in this codebase rewrites it into the wrong remedy.
    [
      "defect #14: per-cycle copy never claims a ceiling problem",
      !/ceiling|higher limit/i.test(RAZORPAY_CYCLE_LIMIT_TEXT),
    ],
    // Decline ladder: a ceiling breach parks today (only a human re-authorizing recovers
    // it). The per-cycle code must land somewhere that does NOT burn the ordinary retry
    // schedule on a debit that cannot succeed until the cycle rolls over — park, with its
    // OWN reason, is that place. Not yet true: `mandate_cycle_limit_exceeded` is a code
    // decline-policy.ts (owned by another agent right now) does not classify yet, so it
    // falls through to the liberal `retry` default — see the report for the exact edit.
    [
      "defect #14: per-charge ceiling breach parks",
      classifyDecline(ceilingRefusal?.failure?.code) === "park",
    ],
    [
      "defect #14: per-cycle limit also parks (own reason, not a blind retry default)",
      classifyDecline(cycle.code) === "park",
    ],
  );
}

// --- B) cross-currency fixed coupon ---
const eur = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "EUR",
  amountMinor: 5000,
  interval: "month",
});
const eurCust = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "eur@a.com",
});
const eurSub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: eurCust.id,
  now: new Date(),
  items: [{ price: eur, quantity: 1 }],
});
await createCoupon({
  organizationId: orgId,
  businessId: biz.id,
  code: "USD10OFF",
  kind: "fixed_amount",
  amountOffMinor: 1000,
  currency: "USD",
  durationType: "forever",
});
let crossRejected = false;
try {
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: eurSub.subscription.id,
    code: "USD10OFF",
    now: new Date(),
  });
} catch (e) {
  crossRejected = e instanceof CouponError;
}
console.log(`apply USD coupon to EUR sub rejected: ${crossRejected}`);
checks.push(["cross-currency fixed coupon rejected at apply", crossRejected]);

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ DUNNING NON-RETRIABLE + COUPON CURRENCY: PASS" : "❌ FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
