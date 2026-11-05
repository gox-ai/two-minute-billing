/**
 * Per-line tax storage model (Phase 10 foundation) — integration coverage:
 *  - a multi-line invoice (plan + addon) taxed → one `applied_taxes` row PER
 *    taxable line, each proportional to the line amount,
 *  - the per-line pieces sum EXACTLY to the invoice's tax (largest-remainder),
 *  - money is preserved: total = subtotal + tax (behaviour unchanged),
 *  - RLS: applied_taxes invisible cross-org.
 *
 *   pnpm verify:tax-lines
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { createCoupon, applyCouponToSubscription } from "@/modules/coupons/service";
import { billSubscriptionPeriod, createInvoiceFromLines } from "@/modules/invoicing/service";
import {
  createFlatTaxRate,
  allocateTaxAcrossLines,
  allocateTaxAcrossSignedLines,
  getTaxProvider,
  taxMinorFor,
} from "@/modules/tax/service";
import {
  subscriptions,
  subscriptionItems,
  invoices,
  invoiceLineItems,
  appliedTaxes,
  ledgerEntries,
  creditNotes,
  creditNoteItems,
} from "@db/schema";

const org = await createOrganization({ name: "Tax Lines Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const gstRate = await createFlatTaxRate({
  organizationId: orgId,
  businessId: biz.id,
  name: "GST",
  country: "IN",
  rateBps: 2000,
}); // 20%

const plan = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Pro",
  kind: "plan",
});
const planPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
}); // $100
const addon = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Seats",
  kind: "addon",
});
const addonPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: addon.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
}); // $50

const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "t@a.com",
  address: { line1: "1 St", country: "IN" },
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const { subscription } = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [
    { price: planPrice, quantity: 1 },
    { price: addonPrice, quantity: 1 },
  ],
});

// Re-bill a fresh period to get a clean invoice.
const fresh = await withTenant(
  orgId,
  async (tx) =>
    (
      await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
    )[0]!,
);
const { invoice } = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: fresh,
  periodStart: fresh.currentPeriodStart!,
  periodEnd: fresh.currentPeriodEnd!,
});

const rows = await withTenant(orgId, async (tx) =>
  tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, invoice.id)),
);
const taxableLines = await withTenant(orgId, async (tx) =>
  (
    await tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id))
  ).filter((l) => l.kind !== "tax" && l.kind !== "discount" && l.amountMinor > 0n),
);
const sum = rows.reduce((s, r) => s + r.amountMinor, 0n);
const taxLine = await withTenant(orgId, async (tx) =>
  (await tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id))).find(
    (l) => l.kind === "tax",
  ),
);

// Allocation of the plan line ($100 of $150 → 2/3 of $30 tax = $20) and addon ($10).
const byLine = new Map(rows.map((r) => [r.invoiceLineItemId, r.amountMinor]));
const planLineId = taxableLines.find((l) => l.amountMinor === 10000n)?.id;
const addonLineId = taxableLines.find((l) => l.amountMinor === 5000n)?.id;

const checks: Array<[string, boolean]> = [
  [
    "invoice total = subtotal + tax (unchanged)",
    invoice.totalMinor === 18000n && invoice.subtotalMinor === 15000n,
  ],
  ["aggregate tax line = $30", taxLine?.amountMinor === 3000n],
  ["one applied_taxes row per taxable line", rows.length === 2 && taxableLines.length === 2],
  ["per-line pieces sum EXACTLY to invoice tax", sum === 3000n],
  ["plan line taxed $20 (proportional)", byLine.get(planLineId!) === 2000n],
  ["addon line taxed $10 (proportional)", byLine.get(addonLineId!) === 1000n],
  [
    "rows snapshot rate + reason",
    rows.every((r) => r.rateBps === 2000 && r.taxabilityReason === "standard_rated"),
  ],
  // The link is now to the COMPONENT row, not a flat rate row — one component here,
  // but an India GST line would carry two rows pointing at two different components.
  ["rows snapshot the resolved tax_component_id", rows.every((r) => r.taxComponentId !== null)],
  [
    "rows all point at the SAME component (single flat rate)",
    new Set(rows.map((r) => r.taxComponentId)).size === 1,
  ],
];

// Provider factory: default is the rate table; external scaffolds throw until configured.
{
  const def = getTaxProvider();
  const stripe = getTaxProvider("stripe_tax");
  let stripeThrows = false;
  try {
    await stripe.resolve({ organizationId: orgId, businessId: biz.id, country: "US" });
  } catch {
    stripeThrows = true;
  }
  checks.push(
    ["getTaxProvider() defaults to rate_table", def.key === "rate_table"],
    ['getTaxProvider("stripe_tax") returns the Stripe Tax scaffold', stripe.key === "stripe_tax"],
    ["unconfigured external provider throws a clear error", stripeThrows],
  );
}

// Unit-level allocation edge: a 3-way split of an odd tax reconciles exactly.
{
  const alloc = allocateTaxAcrossLines(
    [
      { id: "a", amountMinor: 100n },
      { id: "b", amountMinor: 100n },
      { id: "c", amountMinor: 100n },
    ],
    10n,
  );
  const total = alloc.reduce((s, a) => s + a.amountMinor, 0n);
  checks.push(["largest-remainder reconciles an odd split (10 over 3)", total === 10n]);
}

// A NEGATIVE line owes NEGATIVE tax, and the rows must still reconcile to the header.
// This is the shape a proration invoice takes on an upgrade — one "Remaining time on …"
// charge plus one "Unused time on …" credit — and it was the gap that let
// `applied_taxes` overstate by the credit line's tax while the invoice header taxed the
// net. Measured on a real invoice before the fix: header ₹261.98, rows ₹1,571.92.
//
// Each line is taxed at ITS OWN rate (what a tax invoice has to state), with any
// rounding drift swept so the rows sum to the header exactly.
{
  const signed = [
    { id: "charge", amountMinor: 873290n },
    { id: "credit", amountMinor: -727742n },
  ];
  const header = 26198n; // 18% of the net 1,455.48
  const rows = allocateTaxAcrossSignedLines(signed, header, 1800);
  const sum = rows.reduce((s, r) => s + r.amountMinor, 0n);
  const byId = new Map(rows.map((r) => [r.lineId, r.amountMinor]));
  checks.push(["signed allocation: rows reconcile to the invoice tax", sum === header]);
  checks.push([
    "signed allocation: the charge line is taxed at its own rate",
    byId.get("charge") === 157192n,
  ]);
  checks.push([
    "signed allocation: the credit line carries NEGATIVE tax",
    byId.get("credit") === -130994n,
  ]);
  // Direction-independent: a net-negative invoice (a downgrade) reconciles too.
  const down = allocateTaxAcrossSignedLines(
    [
      { id: "a", amountMinor: -90000n },
      { id: "b", amountMinor: 10000n },
    ],
    -14400n,
    1800,
  );
  checks.push([
    "signed allocation: a net-negative invoice reconciles",
    down.reduce((s, r) => s + r.amountMinor, 0n) === -14400n,
  ]);
  // A zero-amount line is not a supply and takes no row at all.
  const withZero = allocateTaxAcrossSignedLines(
    [
      { id: "a", amountMinor: 10000n },
      { id: "z", amountMinor: 0n },
    ],
    1800n,
    1800,
  );
  checks.push([
    "signed allocation: a zero line gets no row",
    !withZero.some((r) => r.lineId === "z"),
  ]);
}

// Exemption: a tax_exempt customer is charged NO tax, and each taxable line gets a
// zero-rate applied_taxes row with reason 'customer_exempt' (invoice explains WHY).
{
  const exempt = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "exempt@a.com",
    address: { line1: "1 St", country: "IN" },
    taxExempt: true,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: exempt,
    token: "tok_4242",
  });
  const { subscription: esub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: exempt.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  const efresh = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, esub.id)).limit(1))[0]!,
  );
  const { invoice: einv } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: efresh,
    periodStart: efresh.currentPeriodStart!,
    periodEnd: efresh.currentPeriodEnd!,
  });
  const erows = await withTenant(orgId, async (tx) =>
    tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, einv.id)),
  );
  const etaxLine = await withTenant(orgId, async (tx) =>
    (await tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, einv.id))).find(
      (l) => l.kind === "tax",
    ),
  );
  console.log(
    `exempt: total=${einv.totalMinor} (want 10000) taxLine=${etaxLine ? "present" : "none"} rows=${erows.length} reason=${erows[0]?.taxabilityReason}`,
  );
  checks.push(
    ["exempt customer charged no tax (total = subtotal)", einv.totalMinor === 10000n],
    ["no tax line item on an exempt invoice", !etaxLine],
    [
      "exempt invoice records a zero-rate applied_taxes row",
      erows.length === 1 && erows[0]!.amountMinor === 0n,
    ],
    ["exempt row carries reason customer_exempt", erows[0]?.taxabilityReason === "customer_exempt"],
  );
}

// Per-line taxability: a non-taxable addon is EXCLUDED from the taxable base and
// recorded as product_exempt; only the taxable plan line is taxed.
{
  const exemptAddon = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Exempt Addon",
    kind: "addon",
  });
  const exemptAddonPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: exemptAddon.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
    isTaxable: false,
  });
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "mixed@a.com",
    address: { line1: "1 St", country: "IN" },
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cust,
    token: "tok_4242",
  });
  const { subscription: msub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cust.id,
    now: new Date(),
    items: [
      { price: planPrice, quantity: 1 },
      { price: exemptAddonPrice, quantity: 1 },
    ],
  });
  const mfresh = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, msub.id)).limit(1))[0]!,
  );
  const { invoice: minv } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: mfresh,
    periodStart: mfresh.currentPeriodStart!,
    periodEnd: mfresh.currentPeriodEnd!,
  });
  const mrows = await withTenant(orgId, async (tx) =>
    tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, minv.id)),
  );
  const mlines = await withTenant(
    orgId,
    async (tx) =>
      await tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, minv.id)),
  );
  const mtaxLine = mlines.find((l) => l.kind === "tax");
  const std = mrows.filter((r) => r.taxabilityReason === "standard_rated");
  const prodExempt = mrows.filter((r) => r.taxabilityReason === "product_exempt");
  // Taxable base = only the $100 plan (addon $50 excluded). Tax = 20% × $100 = $20.
  console.log(
    `mixed: total=${minv.totalMinor} (want 18000) tax=${mtaxLine?.amountMinor} std=${std.length} prod_exempt=${prodExempt.length}`,
  );
  checks.push(
    [
      "non-taxable line excluded from taxable base (tax = $20, not $30)",
      mtaxLine?.amountMinor === 2000n,
    ],
    ["total = subtotal 150 + tax 20 = $170", minv.totalMinor === 17000n],
    [
      "one standard_rated row (the plan) + one product_exempt row (the addon)",
      std.length === 1 && prodExempt.length === 1,
    ],
    ["product_exempt row is zero-amount", prodExempt[0]?.amountMinor === 0n],
  );
}

// Inclusive pricing: a $120 tax-inclusive plan (IN 20%) → total STAYS $120 (tax not
// added on top); the $20 is backed out → net revenue $100 + tax_payable $20.
{
  const incPlan = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Inclusive Plan",
    kind: "plan",
  });
  const incPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: incPlan.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 12000,
    interval: "month",
    taxBehavior: "inclusive",
  });
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "inc@a.com",
    address: { line1: "1 St", country: "IN" },
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cust,
    token: "tok_4242",
  });
  const { subscription: isub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cust.id,
    now: new Date(),
    items: [{ price: incPrice, quantity: 1 }],
  });
  const ifresh = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, isub.id)).limit(1))[0]!,
  );
  const { invoice: iinv } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: ifresh,
    periodStart: ifresh.currentPeriodStart!,
    periodEnd: ifresh.currentPeriodEnd!,
  });
  const irows = await withTenant(orgId, async (tx) =>
    tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, iinv.id)),
  );
  const iTaxLine = await withTenant(orgId, async (tx) =>
    (await tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, iinv.id))).find(
      (l) => l.kind === "tax",
    ),
  );
  const led = await withTenant(orgId, async (tx) =>
    tx.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, iinv.publicId)),
  );
  const bal: Record<string, bigint> = {};
  for (const e of led)
    bal[e.account] =
      (bal[e.account] ?? 0n) + (e.direction === "debit" ? e.amountMinor : -e.amountMinor);
  const ledgerBalances = Object.values(bal).reduce((s, v) => s + v, 0n) === 0n;
  const iSum = irows.reduce((s, r) => s + r.amountMinor, 0n);
  console.log(
    `inclusive: total=${iinv.totalMinor} (want 12000) taxLine=${iTaxLine ? "present" : "none"} revenue=${bal["revenue"]} tax_payable=${bal["tax_payable"]} applied=${iSum}`,
  );
  checks.push(
    ["inclusive: total stays gross $120 (tax not added on top)", iinv.totalMinor === 12000n],
    ["inclusive: no additive tax line item", !iTaxLine],
    ["inclusive: revenue booked NET ($100)", bal["revenue"] === -10000n],
    ["inclusive: tax_payable = backed-out $20", bal["tax_payable"] === -2000n],
    ["inclusive: applied_taxes records the $20", iSum === 2000n],
    ["inclusive: ledger balances", ledgerBalances],
  );
}

// Withholding / TDS: a customer with a 10% withholding rate → the payer withholds
// $10 of the $100 base; invoice face stays $120 ($100 + 20% tax) but the collectible
// drops to $110, and $10 is booked to withholding_receivable (asset).
{
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "tds@a.com",
    address: { line1: "1 St", country: "IN" },
    withholdingRateBps: 1000,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cust,
    token: "tok_4242",
  });
  const { subscription: wsub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cust.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  const wfresh = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, wsub.id)).limit(1))[0]!,
  );
  const { invoice: winv } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: wfresh,
    periodStart: wfresh.currentPeriodStart!,
    periodEnd: wfresh.currentPeriodEnd!,
  });
  const wled = await withTenant(orgId, async (tx) =>
    tx.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, winv.publicId)),
  );
  const wbal: Record<string, bigint> = {};
  for (const e of wled)
    wbal[e.account] =
      (wbal[e.account] ?? 0n) + (e.direction === "debit" ? e.amountMinor : -e.amountMinor);
  const wBalanced = Object.values(wbal).reduce((s, v) => s + v, 0n) === 0n;
  console.log(
    `withholding: total=${winv.totalMinor} withheld=${winv.withholdingMinor} amount_due=${winv.amountDueMinor} wh_recv=${wbal["withholding_receivable"]} ar=${wbal["accounts_receivable"]}`,
  );
  checks.push(
    ["withholding: invoice face total stays gross $120", winv.totalMinor === 12000n],
    ["withholding: $10 withheld recorded on the invoice", winv.withholdingMinor === 1000n],
    ["withholding: collectible amount_due = $110", winv.amountDueMinor === 11000n],
    ["withholding: withholding_receivable asset = $10", wbal["withholding_receivable"] === 1000n],
    [
      "withholding: collectible = $110 (AR+cash), not the gross $120",
      (wbal["accounts_receivable"] ?? 0n) + (wbal["cash"] ?? 0n) === 11000n,
    ],
    ["withholding: ledger balances", wBalanced],
  );
}

// END-TO-END: a mid-term quantity increase raises a proration invoice carrying BOTH a
// "Remaining time on …" charge and a negative "Unused time on …" credit. Every
// applied_taxes row on it must sum to the invoice's own tax (total − subtotal).
//
// This is the assertion the unit cases above cannot make: the defect was not in the
// allocator, it was `recordLineTaxes` deriving each component from its OWN base (the
// positive lines) while the invoice header taxed the net. Both were "correct" in
// isolation. Only comparing the finished invoice to its rows catches that.
{
  const { changeSubscription } = await import("@/modules/subscriptions/proration");
  const live = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
      )[0]!,
  );
  const items = await withTenant(orgId, async (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, live.id)),
  );
  const addonItem = items.find((i) => i.priceId === addonPrice.id);
  // A price SWAP, not a quantity bump: the addon is a `flat` price, where quantity must
  // stay 1. Swapping to a dearer price produces the same two-sided shape this is about —
  // "Unused time on <old>" (negative) plus "Remaining time on <new>" (positive).
  const addonPriceUp = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: addon.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 8000,
    interval: "month",
  }); // $80
  // Halfway through the term, so the proration actually slices rather than landing on a
  // whole-term boundary — that is what makes the two sides round independently.
  const midTerm = new Date(
    live.currentPeriodStart!.getTime() +
      (live.currentPeriodEnd!.getTime() - live.currentPeriodStart!.getTime()) / 2,
  );
  await changeSubscription({
    // `subscriptionId` is the INTERNAL id here (the lookup is `eq(subscriptions.id, …)`),
    // while `itemId` really is the item's public id — they differ, so don't copy one.
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: live.id,
    now: midTerm,
    changes: [{ itemId: addonItem!.publicId, newPriceId: addonPriceUp.publicId }],
    invoiceImmediately: true,
  });
  const prorationInvoices = await withTenant(orgId, async (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, live.id)),
  );
  let checked = 0;
  let allReconcile = true;
  let sawNegativeTax = false;
  for (const inv of prorationInvoices) {
    const atRows = await withTenant(orgId, async (tx) =>
      tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, inv.id)),
    );
    if (atRows.length === 0) continue;
    const rowSum = atRows.reduce((acc, r) => acc + r.amountMinor, 0n);
    const headerTax = inv.totalMinor - inv.subtotalMinor;
    if (rowSum !== headerTax) allReconcile = false;
    if (atRows.some((r) => r.amountMinor < 0n)) sawNegativeTax = true;
    checked++;
  }
  checks.push([
    `applied_taxes reconciles to total-subtotal on every invoice (${checked} checked)`,
    checked > 0 && allReconcile,
  ]);
  // Guards the guard: the reconciliation above must not pass VACUOUSLY, so something has
  // to prove the proration actually reversed tax on the unused time.
  //
  // It used to prove that by requiring a NEGATIVE `applied_taxes` row, because a mid-term
  // change netted its credit onto the new invoice as a negative line. `4b7b5be`
  // (2026-08-25) deliberately stopped that: a same-cadence upgrade now issues a CREDIT NOTE
  // for the unused term and bills the new term at full price, which is what stopped the
  // netting from silently swallowing a coupon. So there is no
  // negative line left to carry a negative tax row — this assertion fired for exactly the
  // reason its own comment predicted, and the reversal did not disappear, it MOVED.
  //
  // Assert it where it now lives: the credit note's `Tax reversal on credited time` item.
  // Keep asserting SOMETHING, or the reconciliation check goes back to being vacuous.
  const prorationCns = await withTenant(orgId, async (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.businessId, biz.id)),
  );
  let sawCreditedTax = false;
  for (const cn of prorationCns.filter((c) => c.status !== "voided")) {
    const items = await withTenant(orgId, async (tx) =>
      tx.select().from(creditNoteItems).where(eq(creditNoteItems.creditNoteId, cn.id)),
    );
    if (items.some((i) => /tax/i.test(i.description) && i.amountMinor > 0n)) sawCreditedTax = true;
  }
  checks.push([
    "the proration reversed tax — on a credit note (4b7b5be) or as a negative row (legacy netting)",
    sawCreditedTax || sawNegativeTax,
  ]);
}

// RLS: another org can't see these rows.
const org2 = await createOrganization({ name: "Tax Lines Org 2" });
const seen = await withTenant(org2.organization.id, async (tx) =>
  tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, invoice.id)),
);
checks.push(["applied_taxes invisible cross-org (RLS)", seen.length === 0]);

console.log(
  `invoice total=${invoice.totalMinor} tax-line=${taxLine?.amountMinor} rows=${rows.length} sum=${sum} plan=${byLine.get(planLineId!)} addon=${byLine.get(addonLineId!)}`,
);
// ── THE SAME INCLUSIVE RULE, ON THE createInvoiceFromLines PATH ─────────────────
//
// The block above pins the renewal path, which has always skipped inclusive rows when it
// emits tax lines. `createInvoiceFromLines` was routed through `computeInvoiceTax` on
// 2026-08-26 (a correct fix — it had been taxing the whole subtotal with one invoice-level
// determination) but did not carry over that skip, so an inclusive invoice raised here came
// out with the tax counted TWICE on the document: a 12000 product line plus a 2000
// "VAT (20.00%)" line against a 12000 total. `total_minor` stayed right and no money moved,
// but the document contradicted itself and `invoice_total_consistent` — a CRITICAL invariant
// — reported every such invoice. Two paths must not disagree about what an inclusive invoice
// looks like, so the rule is asserted on both.
{
  const p2 = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Inclusive One-Off",
    kind: "addon",
  });
  const pr2 = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: p2.id,
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 12000,
    taxBehavior: "inclusive",
  });
  const c2 = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "inc-lines@a.com",
    address: { line1: "1 St", country: "IN" },
  });
  const { invoice: linv } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c2.id,
    currency: "USD",
    lines: [
      { description: "inclusive one-off", amountMinor: 12000n, priceId: pr2.id, quantity: 1 },
    ],
    applyTax: true,
    country: "IN",
  });
  const lLines = await withTenant(orgId, async (tx) =>
    tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, linv.id)),
  );
  const lTaxLine = lLines.find((l) => l.kind === "tax");
  const lSumLines = lLines.reduce((s, l) => s + l.amountMinor, 0n);
  const lApplied = (
    await withTenant(orgId, async (tx) =>
      tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, linv.id)),
    )
  ).reduce((s, r) => s + r.amountMinor, 0n);
  console.log(
    `inclusive/lines: total=${linv.totalMinor} sumLines=${lSumLines} taxLine=${lTaxLine ? "present" : "none"} applied=${lApplied}`,
  );
  checks.push(
    ["inclusive/lines: total stays gross $120", linv.totalMinor === 12000n],
    ["inclusive/lines: no additive tax line item (same as the renewal path)", !lTaxLine],
    // The invariant's own predicate, asserted at the source: a document whose lines do not
    // sum to its total is wrong even when the total is right.
    [
      "inclusive/lines: Σ(line amounts) === total — the document adds up",
      lSumLines === linv.totalMinor,
    ],
    ["inclusive/lines: applied_taxes still records the backed-out $20", lApplied === 2000n],
  );
}

// ── A NEGATIVE TAX ROW IS PART OF THE TAX, ON BOTH PATHS ───────────────────────
//
// The tax LINE ITEMS used to be summed from the POSITIVE `applied_taxes` rows only
// (`if (r.inclusive || r.amountMinor <= 0n) continue`), while `additiveTaxMinor` — and so
// `total_minor` — nets every row. A negative exclusive row is not noise: it is the tax on a
// reversal, either an "Unused time" proration credit or the document-level discount line
// that `createInvoiceFromLines` receives as a line of its own. Dropping it printed MORE tax
// than was charged on an invoice whose total was right: measured on INV-3213, ₹169.20 of
// IGST shown as ₹1,979.64, and 36 such invoices in the local database.
// `invoice_total_consistent` (critical) is what reported them; the first block below is that
// invariant's predicate pinned at the writer that produced all 36.
{
  const c3 = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "neg-lines@a.com",
    address: { line1: "1 St", country: "IN" },
  });
  // A charge and a reversal in one document — the proration shape, built directly so the
  // numbers are exact: base 2000 − 500 = 1500, tax 20% = 300, total 1800.
  const { invoice: ninv } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c3.id,
    currency: "USD",
    lines: [
      { description: "Remaining time on Pro", amountMinor: 2000n, quantity: 1 },
      { description: "Unused time on Pro", amountMinor: -500n, quantity: 1 },
    ],
    applyTax: true,
    country: "IN",
  });
  const nLines = await withTenant(orgId, async (tx) =>
    tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, ninv.id)),
  );
  const nRows = await withTenant(orgId, async (tx) =>
    tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, ninv.id)),
  );
  const nTax = nLines.filter((l) => l.kind === "tax").reduce((s, l) => s + l.amountMinor, 0n);
  const nApplied = nRows.reduce((s, r) => s + r.amountMinor, 0n);
  const nSum = nLines.reduce((s, l) => s + l.amountMinor, 0n);
  console.log(
    `negative/lines: total=${ninv.totalMinor} sumLines=${nSum} taxLine=${nTax} applied=${nApplied} rows=${nRows.map((r) => r.amountMinor).join(",")}`,
  );
  checks.push(
    // Non-vacuous: without a negative row there is nothing here to get wrong.
    [
      "negative/lines: the reversal carries a NEGATIVE applied_taxes row",
      nRows.some((r) => r.amountMinor < 0n),
    ],
    ["negative/lines: tax LINE nets the reversal (300, not 400)", nTax === 300n],
    ["negative/lines: Σ(tax lines) === Σ(applied_taxes)", nTax === nApplied],
    ["negative/lines: Σ(line amounts) === total — the document adds up", nSum === ninv.totalMinor],
    ["negative/lines: total = 1500 base + 300 tax", ninv.totalMinor === 1800n],
  );
}
{
  // The renewal path, which reaches `computeInvoiceTax` differently: it passes the PRODUCT
  // lines plus a separate `discountMinor`, so an invoice-level coupon reduces each line's
  // taxable base instead of arriving as a negative line — and this fixture produces no
  // negative row (verified: reverting the fix leaves these three green). They are here as the
  // regression guard for the discounted-base arithmetic and the adds-up rule on that writer;
  // the negative-row proof is the block above. This path can still carry a negative line — a
  // netted proration credit — which is why it was corrected to the same rule.
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "neg-renewal@a.com",
    address: { line1: "1 St", country: "IN" },
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cust,
    token: "tok_4242",
  });
  const { subscription: dsub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cust.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "DOC10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
    applyOn: "invoice_amount",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: dsub.id,
    code: "DOC10",
    now: new Date(),
  });
  const dfresh = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, dsub.id)).limit(1))[0]!,
  );
  const { invoice: dinv } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: dfresh,
    periodStart: dfresh.currentPeriodStart!,
    periodEnd: dfresh.currentPeriodEnd!,
  });
  const dLines = await withTenant(orgId, async (tx) =>
    tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, dinv.id)),
  );
  const dRows = await withTenant(orgId, async (tx) =>
    tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, dinv.id)),
  );
  const dTax = dLines.filter((l) => l.kind === "tax").reduce((s, l) => s + l.amountMinor, 0n);
  const dApplied = dRows.reduce((s, r) => s + r.amountMinor, 0n);
  const dSum = dLines.reduce((s, l) => s + l.amountMinor, 0n);
  console.log(
    `negative/renewal: total=${dinv.totalMinor} sumLines=${dSum} taxLine=${dTax} applied=${dApplied} rows=${dRows.map((r) => r.amountMinor).join(",")}`,
  );
  checks.push(
    ["negative/renewal: Σ(tax lines) === Σ(applied_taxes)", dTax === dApplied],
    [
      "negative/renewal: Σ(line amounts) === total — the document adds up",
      dSum === dinv.totalMinor,
    ],
    ["negative/renewal: tax is charged on the DISCOUNTED base ($90 → $18)", dTax === 1800n],
  );
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ TAX LINES: PASS" : "❌ TAX LINES: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
