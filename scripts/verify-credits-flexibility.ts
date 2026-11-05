/**
 * Credits Flexibility — merchant control over the AUTO-application of refundable credits
 * and excess payments (0219).
 *
 * ── What this suite has to prove, in both directions ─────────────────────────
 * A settings feature whose default is "behave exactly as before" has two ways to be
 * wrong, and only asserting one of them is how a dead control ships:
 *
 *   1. **INERT BY DEFAULT.** An unconfigured business — which is every business on the
 *      day this ships, including the one that lost ₹69,521.79 on INV-4705 — must apply
 *      credit byte-identically to the code this replaced. §1 and §4A assert that
 *      directly, and running `verify:customers` / `verify:credit-notes` /
 *      `verify:invoices-v2` / `verify:concurrent-credit-apply` unchanged on the same
 *      scratch database is the wider proof.
 *   2. **IT ACTUALLY BINDS.** Each of the three modes, at both levels, on both credit
 *      kinds and both invoice classes, has to change a real invoice's
 *      `refundable_credits_applied_minor` / `excess_payments_applied_minor` and the
 *      ledger behind them — not just resolve to a different number in a pure function.
 *      §4 bills real invoices for that reason; §2/§3 pin the pure rule underneath so a
 *      failure says WHICH half broke.
 *
 * ── The interaction that needed a decision ───────────────────────────────────
 * A business "apply up to a limit" and a SMALLER subscription maximum both apply, and
 * §3 pins that the TIGHTER one wins in both orderings — plus that a subscription cap can
 * never re-enable a bucket the site set to "do not auto-apply". The subscription field
 * is a "maximum limit", and two maxima compose as a minimum; the alternative reading
 * (subscription overrides site) would let a per-subscription value quietly undo the
 * site-wide switch this feature exists to provide.
 *
 * Promotional credit is deliberately untouched by all of it — the screen covers
 * refundable + excess only — and §4E asserts that rather than assuming it.
 *
 * ⚠️ Run it on a SCRATCH database, never the dev one:
 *   pnpm db:scratch --setup --name credits
 *   pnpm db:scratch --name credits -- pnpm verify:credits-flexibility
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, updateSubscriptionSettings } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, createInvoiceFromLines } from "@/modules/invoicing/service";
import { recordOfflinePayment } from "@/modules/invoicing/ops";
import { issueRefundableCreditNote } from "@/modules/credit-notes/service";
import {
  addPromotionalCredits,
  recordExcessPayment,
  bucketBalancesForCurrency,
  planCreditApplication,
  type CustomerBalances,
} from "@/modules/customers/balances";
import {
  resolveCreditsFlexibility,
  creditApplicationLimits,
  DEFAULT_CREDITS_FLEXIBILITY,
  UNLIMITED_CREDIT_LIMITS,
} from "@/modules/customers/credits-flexibility";
import { collectPayment } from "@/modules/customers/collect";
import { invoices } from "@db/schema";

const checks: Array<[string, boolean, string]> = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

/** JSON.stringify chokes on bigint, and every value in this suite is money. */
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

const org = await createOrganization({ name: "Credits Flexibility Org" });
const orgId = org.organization.id;

// ══════════════════════════════════════════════════════════════════════════════
// §1  DEFAULTS ARE INERT — a business with no stored config behaves as before
// ══════════════════════════════════════════════════════════════════════════════
{
  // Every shape a stored value can take that is NOT a deliberate opt-out. `'always'` and
  // the empty object are the malformed cases: the resolver must read them as auto, not
  // invent a cap (see resolveSlot's docblock for why that direction was chosen).
  const inert: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["empty object", {}],
    ["only one kind present", { refundable: {} }],
    ["unknown mode", { refundable: { recurring: { mode: "always" } } }],
    ["'limit' with no amount", { excess: { one_time: { mode: "limit" } } }],
    [
      "'limit' with a negative amount",
      { excess: { one_time: { mode: "limit", limit_minor: -5 } } },
    ],
    ["'limit' beyond 2^53", { excess: { recurring: { mode: "limit", limit_minor: 2 ** 53 + 2 } } }],
  ];
  for (const [label, stored] of inert) {
    const cfg = resolveCreditsFlexibility({ creditsFlexibility: stored });
    const same = j(cfg) === j(DEFAULT_CREDITS_FLEXIBILITY);
    ok(`1: ${label} → auto-apply, unlimited, all four slots`, same, j(cfg));
  }
  const limits = creditApplicationLimits({
    config: resolveCreditsFlexibility(null),
    invoiceClass: "recurring",
  });
  ok(
    "1: unconfigured business → no ceiling on either bucket",
    limits.refundable === null && limits.excess === null,
    `refundable=${limits.refundable} excess=${limits.excess}`,
  );
  // The signature change itself: an unthreaded caller (estimate.ts's three sites, until
  // they are threaded) must behave exactly like an explicitly-unlimited one.
  const balances: CustomerBalances = { promotional: 0n, refundable: 900n, excess: 700n };
  const omitted = planCreditApplication({
    balances,
    discountedSubtotal: 0n,
    postTaxRemaining: 5000n,
  });
  const explicit = planCreditApplication({
    balances,
    discountedSubtotal: 0n,
    postTaxRemaining: 5000n,
    limits: UNLIMITED_CREDIT_LIMITS,
  });
  ok(
    "1: planCreditApplication with `limits` OMITTED === with unlimited limits",
    j(omitted) === j(explicit) && omitted.refundable === 900n && omitted.excess === 700n,
    j(omitted),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// §2  THE THREE MODES BIND, AND THE FOUR SLOTS ARE INDEPENDENT
// ══════════════════════════════════════════════════════════════════════════════
{
  const stored = {
    refundable: {
      recurring: { mode: "none" },
      one_time: { mode: "limit", limit_minor: 250 },
    },
    excess: {
      recurring: { mode: "limit", limit_minor: 1200 },
      // one_time deliberately absent → auto, proving an omitted slot is not "off".
    },
  };
  const cfg = resolveCreditsFlexibility({ creditsFlexibility: stored });
  const rec = creditApplicationLimits({ config: cfg, invoiceClass: "recurring" });
  const one = creditApplicationLimits({ config: cfg, invoiceClass: "one_time" });
  ok(
    '2: refundable/recurring "do not auto-apply" → 0n',
    rec.refundable === 0n,
    `${rec.refundable}`,
  );
  ok('2: excess/recurring "up to 1200" → 1200n', rec.excess === 1200n, `${rec.excess}`);
  ok('2: refundable/one_time "up to 250" → 250n', one.refundable === 250n, `${one.refundable}`);
  ok("2: excess/one_time omitted → unlimited (null), NOT 0", one.excess === null, `${one.excess}`);
  // 0n and null are opposite answers; a `?? 0n` anywhere in this chain would turn the
  // feature on for everybody, so the distinction is asserted rather than assumed.
  ok(
    '2: "do not auto-apply" (0n) is not the same value as unlimited (null)',
    rec.refundable !== one.excess,
  );

  // And the pure applier honours them: refundable capped at 0 leaves the whole remaining
  // collectible for excess, which fills up to its own ceiling and no further.
  const balances: CustomerBalances = { promotional: 0n, refundable: 5000n, excess: 5000n };
  const plan = planCreditApplication({
    balances,
    discountedSubtotal: 0n,
    postTaxRemaining: 10000n,
    limits: rec,
  });
  ok(
    "2: refundable off + excess capped → 0 refundable, 1200 excess",
    plan.refundable === 0n && plan.excess === 1200n,
    j(plan),
  );
  // A ceiling narrows the BUCKET; the invoice's own remaining collectible still bounds it.
  const small = planCreditApplication({
    balances,
    discountedSubtotal: 0n,
    postTaxRemaining: 400n,
    limits: { refundable: 5000n, excess: 5000n },
  });
  ok(
    "2: a ceiling above the invoice total does not inflate what is applied",
    small.refundable === 400n && small.excess === 0n,
    j(small),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// §3  BUSINESS × SUBSCRIPTION — the TIGHTER ceiling wins, in both orderings
// ══════════════════════════════════════════════════════════════════════════════
{
  const withLimit = (minor: number) =>
    resolveCreditsFlexibility({
      creditsFlexibility: {
        refundable: { recurring: { mode: "limit", limit_minor: minor } },
        excess: { recurring: { mode: "limit", limit_minor: minor } },
      },
    });
  const off = resolveCreditsFlexibility({
    creditsFlexibility: {
      refundable: { recurring: { mode: "none" } },
      excess: { recurring: { mode: "none" } },
    },
  });
  const sub = (r: bigint | null, e: bigint | null) => ({
    maxRefundableCreditsUsageMinor: r,
    maxExcessPaymentUsageMinor: e,
  });

  const a = creditApplicationLimits({
    config: withLimit(5000),
    invoiceClass: "recurring",
    subscription: sub(2000n, 2000n),
  });
  ok(
    "3: business 5000 + subscription 2000 → 2000 (subscription is tighter)",
    a.refundable === 2000n && a.excess === 2000n,
    j(a),
  );

  const b = creditApplicationLimits({
    config: withLimit(2000),
    invoiceClass: "recurring",
    subscription: sub(5000n, 5000n),
  });
  ok(
    "3: business 2000 + subscription 5000 → 2000 (business is tighter)",
    b.refundable === 2000n && b.excess === 2000n,
    j(b),
  );

  const c = creditApplicationLimits({
    config: off,
    invoiceClass: "recurring",
    subscription: sub(9999n, 9999n),
  });
  ok(
    '3: business "do not auto-apply" + a generous subscription cap → still 0',
    c.refundable === 0n && c.excess === 0n,
    j(c),
  );

  const d = creditApplicationLimits({
    config: resolveCreditsFlexibility(null),
    invoiceClass: "recurring",
    subscription: sub(3000n, null),
  });
  ok(
    "3: unconfigured business + a subscription cap on refundable only → 3000 / unlimited",
    d.refundable === 3000n && d.excess === null,
    j(d),
  );

  const e = creditApplicationLimits({
    config: withLimit(5000),
    invoiceClass: "one_time",
    subscription: null,
  });
  ok(
    "3: a one-time invoice reads the one_time slots and has no subscription cap",
    e.refundable === null && e.excess === null,
    j(e),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// §4  END TO END — real invoices, real ledger, on the database
// ══════════════════════════════════════════════════════════════════════════════

/**
 * A business with a customer who has 5000 of refundable credit and 5000 of excess, and
 * a 20000/month subscription. `auto_collection: 'off'` so the invoice stays open and the
 * only thing moving `amount_due` is credit application.
 *
 * Refundable balance is seeded the way the engine requires — a paid invoice plus a
 * refundable credit note — not by posting to the bucket directly, so this exercises the
 * same money the incident did.
 */
async function fixture(label: string) {
  const biz = await createBusiness({
    organizationId: orgId,
    name: `CF ${label}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `cf-${label}@a.com`,
    autoCollection: "off",
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 20000,
    interval: "month",
  });
  // Seed refundable: bill 5000, pay it offline, then credit it back refundably.
  const { invoice: seed } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    currency: "USD",
    lines: [{ description: "seed", amountMinor: 5000n }],
  });
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: seed.publicId,
  });
  await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: seed.publicId,
    items: [{ description: "seed credit", amountMinor: 5000 }],
  });
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    amountMinor: 5000,
    currency: "USD",
  });
  return { biz, customer, price };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Bill one month for a fresh subscription and return the stored invoice row. */
async function billMonth(
  f: Fixture,
  subPatch?: {
    maxRefundableCreditsUsageMinor?: bigint | null;
    maxExcessPaymentUsageMinor?: bigint | null;
  },
) {
  const created = await createSubscription({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    now: new Date(),
    items: [{ price: f.price, quantity: 1 }],
  });
  let sub = created.subscription;
  if (subPatch) {
    sub =
      (await updateSubscriptionSettings({
        organizationId: orgId,
        businessId: f.biz.id,
        subscriptionPublicId: sub.publicId,
        ...subPatch,
      })) ?? sub;
  }
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: f.biz.id,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  return withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1))[0]!,
  );
}

const setFlex = (bizPublicId: string, creditsFlexibility: unknown) =>
  updateBusiness(orgId, bizPublicId, { creditsFlexibility });

// ── 4A CONTROL: unconfigured → both buckets applied in full, as before ─────────
{
  const f = await fixture("control");
  const inv = await billMonth(f);
  ok(
    "4A: CONTROL — unconfigured business applies refundable 5000 + excess 5000 in full",
    inv.refundableCreditsAppliedMinor === 5000n &&
      inv.excessPaymentsAppliedMinor === 5000n &&
      inv.amountDueMinor === 10000n,
    `ref=${inv.refundableCreditsAppliedMinor} exc=${inv.excessPaymentsAppliedMinor} due=${inv.amountDueMinor}`,
  );
  const bal = await bucketBalancesForCurrency(orgId, f.customer.id, "USD");
  ok(
    "4A: CONTROL — both buckets drawn to zero",
    bal.refundable === 0n && bal.excess === 0n,
    j(bal),
  );
}

// ── 4B "do not auto-apply" on refundable, recurring ──────────────────────────
{
  const f = await fixture("none");
  await setFlex(f.biz.publicId, { refundable: { recurring: { mode: "none" } } });
  const inv = await billMonth(f);
  ok(
    "4B: refundable off → 0 refundable applied, excess still applies in full",
    inv.refundableCreditsAppliedMinor === 0n && inv.excessPaymentsAppliedMinor === 5000n,
    `ref=${inv.refundableCreditsAppliedMinor} exc=${inv.excessPaymentsAppliedMinor}`,
  );
  ok(
    "4B: amount_due reflects the credit NOT applied (20000 − 5000)",
    inv.amountDueMinor === 15000n,
    `${inv.amountDueMinor}`,
  );
  const bal = await bucketBalancesForCurrency(orgId, f.customer.id, "USD");
  ok(
    "4B: the refundable balance is untouched, not silently spent",
    bal.refundable === 5000n && bal.excess === 0n,
    j(bal),
  );
}

// ── 4C "apply up to a limit" on both kinds ────────────────────────────────────
{
  const f = await fixture("limit");
  await setFlex(f.biz.publicId, {
    refundable: { recurring: { mode: "limit", limit_minor: 1500 } },
    excess: { recurring: { mode: "limit", limit_minor: 2500 } },
  });
  const inv = await billMonth(f);
  ok(
    "4C: caps bind per kind — refundable 1500, excess 2500",
    inv.refundableCreditsAppliedMinor === 1500n && inv.excessPaymentsAppliedMinor === 2500n,
    `ref=${inv.refundableCreditsAppliedMinor} exc=${inv.excessPaymentsAppliedMinor}`,
  );
  ok("4C: amount_due = 20000 − 4000", inv.amountDueMinor === 16000n, `${inv.amountDueMinor}`);
  const bal = await bucketBalancesForCurrency(orgId, f.customer.id, "USD");
  ok(
    "4C: the remainder of each bucket survives",
    bal.refundable === 3500n && bal.excess === 2500n,
    j(bal),
  );
}

// ── 4D THE INTERACTION: a business limit vs a SMALLER subscription cap ────────
{
  const f = await fixture("tighter");
  await setFlex(f.biz.publicId, {
    refundable: { recurring: { mode: "limit", limit_minor: 4000 } },
    excess: { recurring: { mode: "limit", limit_minor: 1000 } },
  });
  const inv = await billMonth(f, {
    // Tighter than the business on refundable, LOOSER on excess — so one assertion
    // proves each side of the min() and neither passes by both being the same number.
    maxRefundableCreditsUsageMinor: 1000n,
    maxExcessPaymentUsageMinor: 4000n,
  });
  ok(
    "4D: business 4000 / subscription 1000 on refundable → 1000 applied",
    inv.refundableCreditsAppliedMinor === 1000n,
    `${inv.refundableCreditsAppliedMinor}`,
  );
  ok(
    "4D: business 1000 / subscription 4000 on excess → 1000 applied",
    inv.excessPaymentsAppliedMinor === 1000n,
    `${inv.excessPaymentsAppliedMinor}`,
  );
}

// ── 4E PROMOTIONAL CREDIT IS OUT OF SCOPE ────────────────────────────────────
{
  const f = await fixture("promo");
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: f.biz.id,
    customer: f.customer,
    amountMinor: 3000,
    currency: "USD",
    description: "welcome",
  });
  // Both refundable and excess switched off; promotional must be unaffected, because the
  // Credits Flexibility screen does not cover it.
  await setFlex(f.biz.publicId, {
    refundable: { recurring: { mode: "none" } },
    excess: { recurring: { mode: "none" } },
  });
  const inv = await billMonth(f);
  ok(
    "4E: promotional credit is applied in full even with both other buckets off",
    inv.promotionalCreditsAppliedMinor === 3000n &&
      inv.refundableCreditsAppliedMinor === 0n &&
      inv.excessPaymentsAppliedMinor === 0n,
    `promo=${inv.promotionalCreditsAppliedMinor} ref=${inv.refundableCreditsAppliedMinor} exc=${inv.excessPaymentsAppliedMinor}`,
  );
  ok(
    "4E: amount_due = 20000 − 3000 promotional",
    inv.amountDueMinor === 17000n,
    `${inv.amountDueMinor}`,
  );
}

// ── 4F INVOICE CLASS: recurring and one-time are configured separately ───────
{
  const f = await fixture("class");
  // Off for RECURRING invoices only. A one-time invoice must be untouched by that.
  await setFlex(f.biz.publicId, {
    refundable: { recurring: { mode: "none" } },
    excess: { recurring: { mode: "none" } },
  });
  const { invoice: oneTime } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "one-off", amountMinor: 3000n }],
    applyCredit: true,
  });
  const row = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(invoices).where(eq(invoices.id, oneTime.id)).limit(1))[0]!,
  );
  ok(
    "4F: a one-time invoice ignores the RECURRING slots (refundable still applied)",
    row.refundableCreditsAppliedMinor === 3000n,
    `ref=${row.refundableCreditsAppliedMinor} exc=${row.excessPaymentsAppliedMinor}`,
  );
}
{
  const f = await fixture("class2");
  // The mirror: off for ONE-TIME invoices only, and a one-time invoice must obey it.
  await setFlex(f.biz.publicId, {
    refundable: { one_time: { mode: "none" } },
    excess: { one_time: { mode: "limit", limit_minor: 800 } },
  });
  const { invoice: oneTime } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "one-off", amountMinor: 3000n }],
    applyCredit: true,
  });
  const row = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(invoices).where(eq(invoices.id, oneTime.id)).limit(1))[0]!,
  );
  ok(
    "4F: the one_time slots bind on a one-time invoice (refundable 0, excess capped at 800)",
    row.refundableCreditsAppliedMinor === 0n && row.excessPaymentsAppliedMinor === 800n,
    `ref=${row.refundableCreditsAppliedMinor} exc=${row.excessPaymentsAppliedMinor}`,
  );
}

// ── 4G collect_payment draws through the same ceilings ───────────────────────
{
  const f = await fixture("collect");
  // Off for recurring, so the renewal invoice is raised with nothing applied and there
  // is a real open debt for collect_payment to attack.
  await setFlex(f.biz.publicId, {
    refundable: { recurring: { mode: "none" } },
    excess: { recurring: { mode: "limit", limit_minor: 2000 } },
  });
  const inv = await billMonth(f);
  ok(
    "4G: setup — the renewal invoice is open with 20000 − 2000 due",
    inv.refundableCreditsAppliedMinor === 0n &&
      inv.excessPaymentsAppliedMinor === 2000n &&
      inv.amountDueMinor === 18000n,
    `ref=${inv.refundableCreditsAppliedMinor} exc=${inv.excessPaymentsAppliedMinor} due=${inv.amountDueMinor}`,
  );
  const res = await collectPayment({
    organizationId: orgId,
    businessId: f.biz.id,
    customerPublicId: f.customer.publicId,
    invoiceIds: [inv.publicId],
  });
  ok(
    '4G: collect_payment respects "do not auto-apply" on refundable',
    res?.applied.refundable === 0,
    `applied ${j(res?.applied)}`,
  );
  ok(
    "4G: collect_payment respects the remaining excess headroom (2000 cap, 2000 already used)",
    res?.applied.excess === 0,
    `applied ${j(res?.applied)}`,
  );
  const bal = await bucketBalancesForCurrency(orgId, f.customer.id, "USD");
  ok(
    "4G: the customer still holds the credit the setting protected",
    bal.refundable === 5000n && bal.excess === 3000n,
    j(bal),
  );
}
{
  // CONTROL for 4G: the same call on an unconfigured business DOES draw both buckets —
  // otherwise the assertions above would pass on a collect_payment that simply never
  // applies credit.
  const f = await fixture("collect-control");
  const inv = await billMonth(f);
  ok(
    "4G: CONTROL — unconfigured renewal already consumed both buckets",
    inv.amountDueMinor === 10000n,
    `${inv.amountDueMinor}`,
  );
  const { invoice: extra } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "second bill", amountMinor: 4000n }],
  });
  await recordExcessPayment({
    organizationId: orgId,
    businessId: f.biz.id,
    customer: f.customer,
    amountMinor: 4000,
    currency: "USD",
  });
  const res = await collectPayment({
    organizationId: orgId,
    businessId: f.biz.id,
    customerPublicId: f.customer.publicId,
    invoiceIds: [extra.publicId],
  });
  ok(
    "4G: CONTROL — with no config, collect_payment applies the excess in full",
    res?.applied.excess === 4000,
    `applied ${j(res?.applied)}`,
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
    ? `\n✅ CREDITS-FLEXIBILITY: PASS (${checks.length} checks)`
    : `\n❌ CREDITS-FLEXIBILITY: FAIL — ${failed} of ${checks.length}`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
