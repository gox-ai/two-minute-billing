/**
 * One credit balance, many drawers — the APPLICATION side of the wallet / promotional-credit
 * model, probed for the over-draw that `verify:concurrent-collect` and
 * `verify:concurrent-refund` found on the collect and refund paths.
 *
 * ── WHY THIS EXISTS, AND WHAT IT IS NOT ─────────────────────────────────────────
 * Unlike the two suites this is modelled on, this one is NOT the record of a bug. Reading
 * the code, every application path already takes `lockCustomerBalances` — the codebase's
 * `pg_advisory_xact_lock` serialisation primitive for buckets — inside the same transaction
 * that reads the balance and posts the draw:
 *
 *   src/modules/invoicing/service.ts:813    commitSubscriptionPeriodInvoice (renewals)
 *   src/modules/invoicing/service.ts:1502   createInvoiceFromLines, when applyCredit
 *   src/modules/customers/collect.ts:94     collectPayment (draw credit across open invoices)
 *   src/modules/customers/balances.ts:185   deductPromotionalCredits
 *   src/modules/customers/balances.ts:232   setPromotionalCredits
 *
 * The MINT side needs no lock and correctly has none: `addPromotionalCredits`,
 * `recordExcessPayment` and `topUpWallet` only ADD to a bucket, and an add cannot
 * over-draw. (`topUpWallet`'s gateway idempotency key is a fresh `pay_…` per call, so two
 * concurrent top-up REQUESTS charge the card twice — but those are two distinct intents
 * deduplicated by the API's `Idempotency-Key`, not a guard being raced past, and no balance
 * is read-then-acted upon. Out of scope here.)
 *
 * Reading is not measuring, so this file exists to hold the claim to the same standard as
 * the paths that failed it, and to keep holding it: a future edit that drops one of those
 * `lockCustomerBalances` calls, or moves a bucket read outside the locked transaction,
 * turns this suite red. The mutation test in the report is exactly that.
 *
 * ── THE MEASUREMENT TRAP ────────────────────────────────────────────────────────
 * `bucketBalance()` CLAMPS: it returns 0 for a negative balance (and logs
 * `ledger_bucket_negative`). Asserting on it would report a perfectly healthy 0 for a
 * bucket that had been over-drawn into the red — the exact "passes for the wrong reason"
 * shape. This file sums `ledger_entries` itself, unclamped, and requires ≥ 0.
 *
 *   tsx scripts/verify-concurrent-credit-apply.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  addPromotionalCredits,
  recordExcessPayment,
  PROMOTIONAL_CREDIT,
  EXCESS_PAYMENT,
} from "@/modules/customers/balances";
import { createInvoiceFromLines } from "@/modules/invoicing/service";
import { collectPayment } from "@/modules/customers/collect";
import { invoices } from "@db/schema";

const GRANT = 1000n;
const LINE = 400n;
const DRAWERS = 5;

const checks: [string, boolean, string][] = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

async function scenario(label: string) {
  const org = await createOrganization({ name: `Concurrent Apply ${label}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    defaultCurrency: "USD",
    organizationId: orgId,
    name: "Biz",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `cap-${label}@a.com`,
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: Number(LINE),
  });
  return { orgId, bizId: biz.id, customer, priceId: price.id };
}

/**
 * RAW bucket balance from the ledger — deliberately not `bucketBalance()`, which clamps a
 * negative to 0 and would hide the very failure this suite is looking for.
 */
async function rawBucket(
  orgId: string,
  customerId: string,
  account: string,
  currency = "USD",
): Promise<bigint> {
  return withTenant(orgId, async (tx) => {
    const res = await tx.execute(sql`
      select coalesce(sum(case when direction = 'credit' then amount_minor else -amount_minor end), 0)::bigint as bal
      from ledger_entries
      where customer_id = ${customerId} and account = ${account} and currency = ${currency}
    `);
    const row = (res as unknown as Array<{ bal: string | number }>)[0];
    return BigInt(row?.bal ?? 0);
  });
}

/** What the invoices themselves claim was applied, per bucket. */
async function appliedTotals(orgId: string, customerId: string) {
  const rows = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.customerId, customerId)),
  );
  const sum = (f: (r: (typeof rows)[number]) => bigint | null) =>
    rows.reduce((s, r) => s + (f(r) ?? 0n), 0n);
  return {
    promotional: sum((r) => r.promotionalCreditsAppliedMinor),
    refundable: sum((r) => r.refundableCreditsAppliedMinor),
    excess: sum((r) => r.excessPaymentsAppliedMinor),
    count: rows.length,
  };
}

const line = (n: bigint, priceId: string) => [{ description: "Probe", amountMinor: n, priceId }];

// ══ 1. many concurrent ad-hoc invoices drawing ONE promotional balance ══════════
// Exercises `createInvoiceFromLines`'s conditional lock (service.ts:1502). Five invoices
// of 400 against a 1000 grant: at most two-and-a-half invoices' worth of credit exists,
// so an unserialized read would let all five apply 400 each — 2000 drawn from 1000.
{
  const s = await scenario("adhoc");
  await addPromotionalCredits({
    organizationId: s.orgId,
    businessId: s.bizId,
    customer: s.customer,
    amountMinor: Number(GRANT),
    currency: "USD",
    description: "probe grant",
  });
  const res = await Promise.allSettled(
    Array.from({ length: DRAWERS }, () =>
      createInvoiceFromLines({
        organizationId: s.orgId,
        businessId: s.bizId,
        customerId: s.customer.id,
        currency: "USD",
        lines: line(LINE, s.priceId),
        applyCredit: true,
      }),
    ),
  );
  const made = res.filter((r) => r.status === "fulfilled").length;
  const bucket = await rawBucket(s.orgId, s.customer.id, PROMOTIONAL_CREDIT);
  const applied = await appliedTotals(s.orgId, s.customer.id);
  ok(
    `1a: LEDGER — ${DRAWERS} concurrent invoices never draw promotional credit below zero`,
    bucket >= 0n,
    `promotional_credit_balance ${bucket} (RAW, unclamped) after ${made}/${DRAWERS} invoices`,
  );
  ok(
    `1b: the credit the invoices claim to have applied never exceeds the ${GRANT} granted`,
    applied.promotional <= GRANT,
    `Σ promotional_credits_applied_minor ${applied.promotional} across ${applied.count} invoice(s)`,
  );
  ok(
    "1c: LEDGER — the ledger and the invoice columns agree on what was drawn",
    GRANT - bucket === applied.promotional,
    `drawn per ledger ${GRANT - bucket}, per invoices ${applied.promotional}`,
  );
  // POSITIVE CONTROL: credit must actually have been applied. A path that drew nothing
  // would satisfy every cap above.
  ok(
    "1d: CONTROL — credit really was applied (the drawers are not all no-ops)",
    applied.promotional > 0n && made >= 1,
    `${made} invoice(s) created, ${applied.promotional} of credit applied`,
  );
}

// ══ 2. many concurrent collectPayment calls drawing ONE post-tax balance ════════
// Exercises `collectPayment`'s lock (customers/collect.ts:94). The invoices are created
// FIRST with no credit applied, then raced upon — so every racer sees the same open set
// and the same balance, which is the shape the collect double-book had.
{
  const s = await scenario("collect");
  await recordExcessPayment({
    organizationId: s.orgId,
    businessId: s.bizId,
    customer: s.customer,
    amountMinor: Number(GRANT),
    currency: "USD",
    description: "probe excess",
  });
  for (let i = 0; i < DRAWERS; i++) {
    await createInvoiceFromLines({
      organizationId: s.orgId,
      businessId: s.bizId,
      customerId: s.customer.id,
      currency: "USD",
      lines: line(LINE, s.priceId),
      applyCredit: false,
    });
  }
  await Promise.allSettled(
    Array.from({ length: DRAWERS }, () =>
      collectPayment({
        organizationId: s.orgId,
        businessId: s.bizId,
        customerPublicId: s.customer.publicId,
        currency: "USD",
      }),
    ),
  );
  const bucket = await rawBucket(s.orgId, s.customer.id, EXCESS_PAYMENT);
  const applied = await appliedTotals(s.orgId, s.customer.id);
  ok(
    `2a: LEDGER — ${DRAWERS} concurrent collectPayment calls never draw excess credit below zero`,
    bucket >= 0n,
    `excess_payment_balance ${bucket} (RAW, unclamped)`,
  );
  ok(
    `2b: the credit the invoices claim to have applied never exceeds the ${GRANT} available`,
    applied.excess <= GRANT,
    `Σ excess_payments_applied_minor ${applied.excess}`,
  );
  ok(
    "2c: LEDGER — the ledger and the invoice columns agree on what was drawn",
    GRANT - bucket === applied.excess,
    `drawn per ledger ${GRANT - bucket}, per invoices ${applied.excess}`,
  );
  const settled = await withTenant(s.orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.customerId, s.customer.id), eq(invoices.status, "paid"))),
  );
  ok(
    "2d: the credit settled the invoices it paid for (1000 covers two 400s in full)",
    settled.length === 2,
    `${settled.length} invoice(s) paid from credit (expect 2), ${applied.excess} applied`,
  );
}

// ══ 2S. the same draw, SEQUENTIAL — the positive control for scenario 2 ═════════
// Establishes what correct looks like, so a failure above can only be a concurrency
// failure: ONE collectPayment against 1000 of excess and five 400 invoices must apply the
// whole 1000 (400 + 400 + 200), settle exactly two invoices, and leave the columns
// agreeing with the ledger.
{
  const s = await scenario("collect-seq");
  await recordExcessPayment({
    organizationId: s.orgId,
    businessId: s.bizId,
    customer: s.customer,
    amountMinor: Number(GRANT),
    currency: "USD",
    description: "probe excess",
  });
  for (let i = 0; i < DRAWERS; i++) {
    await createInvoiceFromLines({
      organizationId: s.orgId,
      businessId: s.bizId,
      customerId: s.customer.id,
      currency: "USD",
      lines: line(LINE, s.priceId),
      applyCredit: false,
    });
  }
  await collectPayment({
    organizationId: s.orgId,
    businessId: s.bizId,
    customerPublicId: s.customer.publicId,
    currency: "USD",
  });
  const bucket = await rawBucket(s.orgId, s.customer.id, EXCESS_PAYMENT);
  const applied = await appliedTotals(s.orgId, s.customer.id);
  const settled = await withTenant(s.orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.customerId, s.customer.id), eq(invoices.status, "paid"))),
  );
  ok(
    "2S: CONTROL — one collectPayment applies the whole 1000, settles two invoices, columns match the ledger",
    bucket === 0n &&
      applied.excess === GRANT &&
      settled.length === 2 &&
      GRANT - bucket === applied.excess,
    `bucket ${bucket}, applied ${applied.excess}, ${settled.length} paid`,
  );
}

// ══ 3. concurrent DEDUCT (clawback) against one balance ════════════════════════
// `deductPromotionalCredits` caps at the available balance rather than refusing, so the
// race would show as a NEGATIVE bucket, not as an error.
{
  const s = await scenario("deduct");
  await addPromotionalCredits({
    organizationId: s.orgId,
    businessId: s.bizId,
    customer: s.customer,
    amountMinor: Number(GRANT),
    currency: "USD",
    description: "probe grant",
  });
  const { deductPromotionalCredits } = await import("@/modules/customers/balances");
  const res = await Promise.allSettled(
    Array.from({ length: DRAWERS }, () =>
      deductPromotionalCredits({
        organizationId: s.orgId,
        businessId: s.bizId,
        customer: s.customer,
        amountMinor: Number(GRANT),
        currency: "USD",
        description: "clawback probe",
      }),
    ),
  );
  const deducted = res
    .filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof deductPromotionalCredits>>> =>
        r.status === "fulfilled",
    )
    .reduce((sum, r) => sum + r.value.deductedMinor, 0n);
  const bucket = await rawBucket(s.orgId, s.customer.id, PROMOTIONAL_CREDIT);
  ok(
    `3a: LEDGER — ${DRAWERS} concurrent clawbacks of ${GRANT} deduct ${GRANT} in total, not more`,
    bucket >= 0n && deducted <= GRANT,
    `promotional_credit_balance ${bucket} (RAW), total deducted ${deducted}`,
  );
  ok(
    "3b: CONTROL — the clawback really happened (balance is zero, not untouched)",
    bucket === 0n && deducted === GRANT,
    `balance ${bucket}, deducted ${deducted}`,
  );
}

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (pass) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
console.log(
  failed === 0
    ? `\n✅ CONCURRENT CREDIT APPLY: PASS (${checks.length} checks)`
    : `\n❌ CONCURRENT CREDIT APPLY: FAIL — ${failed} of ${checks.length}`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
