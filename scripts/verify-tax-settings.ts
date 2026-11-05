/**
 * verify:tax-settings — tax settings (0489) and their defaults (= behaviour before them):
 *   A. tax rounding (`tax_settings.rounding`): per invoice total (today) vs per line;
 *      the estimate equals the booked invoice under both.
 *   B. customer price type (`customers.tax_behavior`) overrides each price.
 *   C. price type per currency (`tax_settings.behavior_by_currency`) seeds new prices.
 *   D. seller tax ID per destination country (`tax_settings.seller_tax_ids`).
 *   E. the API: PATCH /v1/businesses and the customer routes keep the keys.
 *   G. an inclusive customer in a US sales-tax region and in a VAT region: the tax is backed
 *      out (applied, booked to tax_payable), and the preview quotes the same tax and total.
 *   F. per-line rounding: the estimate equals the invoice with an item coupon, an unbilled-
 *      charges cancel, and credit lines on an unbilled term.
 *
 *   pnpm verify:tax-settings
 */
import { eq, sql } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { cancelSubscriptionWithOptions, createSubscription } from "@/modules/subscriptions/service";
import {
  estimateCancel,
  estimateChange,
  estimateNewSubscription,
} from "@/modules/subscriptions/estimate";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { addAdHocCharges } from "@/modules/subscriptions/items";
import { applyCouponToSubscription, createCoupon } from "@/modules/coupons/service";
import { billSubscriptionPeriod, createInvoiceFromLines } from "@/modules/invoicing/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import { appliedTaxes, invoiceLineItems, invoices, prices } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean, detail?: unknown) => {
  checks.push([n, c]);
  if (!c && detail !== undefined) console.log(`    ${n}:`, detail);
};
const rnd = () => Math.random().toString(36).slice(2, 10);

const org = await createOrganization({ name: "Tax Settings Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Tax Settings Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const setTax = (taxSettings: Record<string, unknown>) =>
  updateBusiness(orgId, biz.publicId, { taxSettings });
await updateBusiness(orgId, biz.publicId, { taxRegistrationNumber: "BIZTAX0001" });
for (const country of ["DE", "FR"])
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: biz.id,
    name: "VAT",
    country,
    rateBps: 1800,
  });

const product = async (kind: "plan" | "addon", name: string) =>
  createProduct({ organizationId: orgId, businessId: biz.id, name, kind });
const flat = async (
  productId: string,
  amountMinor: number,
  extra: { taxBehavior?: "inclusive" | "exclusive"; currency?: string } = {},
) =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId,
    type: "recurring",
    model: "flat",
    currency: extra.currency ?? "USD",
    amountMinor,
    interval: "month",
    ...(extra.taxBehavior ? { taxBehavior: extra.taxBehavior } : {}),
  });

const plan = await product("plan", "Pro");
const addonA = await product("addon", "Seats");
const addonB = await product("addon", "Storage");
// 3 × 1003 at 18%: per line 3 × round(180.54) = 543; on the total round(541.62) = 542.
const planPrice = await flat(plan.id, 1003);
const addonAPrice = await flat(addonA.id, 1003);
const addonBPrice = await flat(addonB.id, 1003);
const threeItems = [
  { price: planPrice, quantity: 1 },
  { price: addonAPrice, quantity: 1 },
  { price: addonBPrice, quantity: 1 },
];

const customer = (country: string, taxBehavior?: "inclusive" | "exclusive") =>
  createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `tax-${rnd()}@example.com`,
    address: { line1: "1 Example St", country },
    ...(taxBehavior ? { taxBehavior } : {}),
  });

/** Estimate a signup, then book it and bill its first period. */
async function estimateAndBill(
  customerId: string,
  items: Array<{ price: typeof prices.$inferSelect; quantity: number }>,
) {
  const est = await estimateNewSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId,
    items,
    now: new Date(),
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId,
    now: new Date(),
    items,
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const [lines, applied] = await withTenant(orgId, async (tx) => [
    await tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id)),
    await tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, invoice.id)),
  ]);
  const taxLines = (lines as Array<typeof invoiceLineItems.$inferSelect>)
    .filter((l) => l.kind === "tax")
    .reduce((s, l) => s + l.amountMinor, 0n);
  const appliedSum = (applied as Array<typeof appliedTaxes.$inferSelect>).reduce(
    (s, r) => s + r.amountMinor,
    0n,
  );
  return {
    est,
    invoice,
    taxLines,
    appliedSum,
    applied: applied as Array<typeof appliedTaxes.$inferSelect>,
  };
}

// ── A. rounding ──────────────────────────────────────────────────────────────
{
  const today = await estimateAndBill((await customer("DE")).id, threeItems);
  ok("A1 default: tax rounds once on the invoice total (542)", today.taxLines === 542n, today);
  ok("A1 default: estimate equals the invoice", BigInt(today.est.tax_minor) === today.taxLines);
  ok("A1 default: Σ applied_taxes = tax lines", today.appliedSum === today.taxLines);

  await setTax({ rounding: "per_line" });
  const perLine = await estimateAndBill((await customer("DE")).id, threeItems);
  ok("A2 per line: 3 × round(180.54) = 543", perLine.taxLines === 543n, perLine.taxLines);
  ok("A2 per line: estimate equals the invoice", BigInt(perLine.est.tax_minor) === 543n);
  ok(
    "A2 per line: each line carries its own rounded tax (181)",
    perLine.applied.length === 3 && perLine.applied.every((r) => r.amountMinor === 181n),
    perLine.applied.map((r) => r.amountMinor),
  );
  ok(
    "A2 per line: total = subtotal + tax",
    perLine.invoice.totalMinor === 3009n + 543n,
    perLine.invoice.totalMinor,
  );
  await setTax({});
}

// ── B. customer price type ───────────────────────────────────────────────────
{
  const inc = await customer("DE", "inclusive");
  const r = await estimateAndBill(inc.id, threeItems);
  // 3009 × 18/118 = 459.0 → backed out, nothing added.
  ok("B1 inclusive customer: no tax added to the total", r.invoice.totalMinor === 3009n, r.invoice);
  ok("B1 inclusive customer: no tax line items", r.taxLines === 0n);
  ok(
    "B1 inclusive customer: tax backed out of the lines (459)",
    r.appliedSum === 459n,
    r.appliedSum,
  );
  ok("B1 inclusive customer: invoice states its price type", r.invoice.priceType === "inclusive");
  ok(
    "B1 inclusive customer: estimate quotes the same total and the tax inside it",
    BigInt(r.est.total_minor) === r.invoice.totalMinor && BigInt(r.est.tax_minor) === r.appliedSum,
    r.est,
  );

  const inclusivePlan = await flat((await product("plan", "Gross")).id, 1180, {
    taxBehavior: "inclusive",
  });
  const plain = await estimateAndBill((await customer("DE")).id, [
    { price: inclusivePlan, quantity: 1 },
  ]);
  ok("B2 default: an inclusive price adds no tax", plain.invoice.totalMinor === 1180n);
  const exc = await customer("DE", "exclusive");
  const forced = await estimateAndBill(exc.id, [{ price: inclusivePlan, quantity: 1 }]);
  ok(
    "B2 exclusive customer: tax added on top of an inclusive price (1180 + 212)",
    forced.invoice.totalMinor === 1392n && forced.taxLines === 212n,
    forced.invoice.totalMinor,
  );
  ok(
    "B2 exclusive customer: invoice states its price type",
    forced.invoice.priceType === "exclusive",
  );
  ok(
    "B2 exclusive customer: estimate equals the invoice",
    BigInt(forced.est.total_minor) === 1392n,
  );
}

// ── C. price type per currency ───────────────────────────────────────────────
{
  const p = await product("plan", "Currency rule");
  const before = await flat(p.id, 500);
  ok(
    "C1 default: a new price with no tax_behavior is exclusive",
    before.taxBehavior === "exclusive",
  );
  await setTax({ behavior_by_currency: { USD: "inclusive" } });
  const usd = await flat(p.id, 600);
  const usdExplicit = await flat(p.id, 700, { taxBehavior: "exclusive" });
  const eur = await flat(p.id, 800, { currency: "EUR" });
  ok("C2 USD rule: a new USD price is inclusive", usd.taxBehavior === "inclusive");
  ok("C2 USD rule: an explicit tax_behavior wins", usdExplicit.taxBehavior === "exclusive");
  ok("C2 USD rule: another currency keeps today's default", eur.taxBehavior === "exclusive");
  const [stored] = await withTenant(orgId, (tx) =>
    tx.select().from(prices).where(eq(prices.id, before.id)),
  );
  ok("C3 existing prices keep their price type", stored?.taxBehavior === "exclusive");
  await setTax({});
}

// ── D. seller tax ID per destination ─────────────────────────────────────────
{
  const de = await customer("DE");
  const fr = await customer("FR");
  const raise = (customerId: string) =>
    createInvoiceFromLines({
      organizationId: orgId,
      businessId: biz.id,
      customerId,
      currency: "USD",
      applyTax: true,
      lines: [{ description: "Setup", amountMinor: 1000n }],
    });
  const beforeDe = await raise(de.id);
  ok(
    "D1 default: the business tax ID is printed",
    beforeDe.invoice.sellerTaxId === "BIZTAX0001",
    beforeDe.invoice.sellerTaxId,
  );
  await setTax({ seller_tax_ids: { DE: "DE999999999" } });
  const afterDe = await raise(de.id);
  const afterFr = await raise(fr.id);
  ok(
    "D2 a DE customer gets the DE registration and its country",
    afterDe.invoice.sellerTaxId === "DE999999999" && afterDe.invoice.sellerTaxCountry === "DE",
    afterDe.invoice,
  );
  ok("D2 a FR customer keeps the business tax ID", afterFr.invoice.sellerTaxId === "BIZTAX0001");
  const [frozen] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, beforeDe.invoice.id)),
  );
  ok("D3 an issued invoice does not change", frozen?.sellerTaxId === "BIZTAX0001");
  await setTax({});
}

// ── E. API ───────────────────────────────────────────────────────────────────
{
  const { buildApp } = await import("@/index");
  const app = await buildApp({ logger: false });
  const call = (method: "GET" | "PATCH" | "POST", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
      ...(payload ? { payload } : {}),
    });
  const path = `/v1/businesses/${biz.publicId}`;
  const fresh = JSON.parse((await call("GET", path)).body);
  ok(
    "E1 GET: unset keys resolve to today's behaviour",
    fresh.tax_rounding === "per_invoice_total" &&
      Object.keys(fresh.seller_tax_ids).length === 0 &&
      Object.keys(fresh.tax_behavior_by_currency).length === 0,
    fresh,
  );
  const patched = await call("PATCH", path, {
    tax_rounding: "per_line",
    seller_tax_ids: { DE: " DE123 ", FR: "" },
    tax_behavior_by_currency: { INR: "inclusive" },
  });
  const body = JSON.parse(patched.body);
  ok(
    "E2 PATCH stores all three keys (blank id dropped)",
    patched.statusCode === 200 &&
      body.tax_rounding === "per_line" &&
      JSON.stringify(body.seller_tax_ids) === JSON.stringify({ DE: "DE123" }) &&
      body.tax_behavior_by_currency.INR === "inclusive",
    body,
  );
  const partial = JSON.parse((await call("PATCH", path, { seller_tax_ids: null })).body);
  ok(
    "E3 PATCH of one key leaves the others",
    partial.tax_rounding === "per_line" &&
      Object.keys(partial.seller_tax_ids).length === 0 &&
      partial.tax_behavior_by_currency.INR === "inclusive",
    partial,
  );
  const bad = await call("PATCH", path, { tax_rounding: "half_even" });
  ok("E4 an unknown rounding is refused", bad.statusCode === 400);
  const uk = await call("PATCH", path, { seller_tax_ids: { UK: "GB123" } });
  const zz = await call("PATCH", path, { seller_tax_ids: { ZZ: "X1" } });
  ok(
    "E4 a VAT prefix (UK) is refused, naming the ISO code",
    uk.statusCode === 400 && uk.body.includes("GB"),
    uk.body,
  );
  ok("E4 an unknown country code is refused", zz.statusCode === 400, zz.body);
  const cus = await call("POST", `${path}/customers`, {
    email: `api-${rnd()}@example.com`,
    tax_behavior: "inclusive",
  });
  const cusBody = JSON.parse(cus.body);
  ok("E5 customer create keeps tax_behavior", cusBody.tax_behavior === "inclusive", cusBody);
  const cleared = JSON.parse(
    (await call("PATCH", `${path}/customers/${cusBody.id}`, { tax_behavior: null })).body,
  );
  ok("E6 customer tax_behavior clears to null", cleared.tax_behavior === null, cleared);
  await app.close();
}

// ── G. inclusive customer: tax backed out, preview = booking ─────────────────────
for (const region of [
  { name: "US sales tax", country: "US", state: "CA", rateBps: 725, backedOut: 202n },
  { name: "VAT", country: "DE", state: null, rateBps: 2000, backedOut: 500n },
] as const) {
  const b = await createBusiness({
    organizationId: orgId,
    name: `Inclusive ${region.name}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const c = { organizationId: orgId, businessId: b.id };
  await createFlatTaxRate({
    ...c,
    name: region.name === "VAT" ? "VAT" : "CA",
    country: region.country,
    ...(region.state ? { state: region.state } : {}),
    rateBps: region.rateBps,
  });
  const mk = async (kind: "plan" | "addon", amountMinor: number) =>
    createPrice({
      ...c,
      productId: (await createProduct({ ...c, name: `${kind}-${rnd()}`, kind })).id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  const items = [
    { price: await mk("plan", 1000), quantity: 1 },
    { price: await mk("addon", 2000), quantity: 1 },
  ];
  const cus = await createCustomer({
    ...c,
    email: `inc-${rnd()}@example.com`,
    taxBehavior: "inclusive",
    address:
      region.country === "US"
        ? {
            line1: "1 Market St",
            city: "San Francisco",
            stateCode: "CA",
            postalCode: "94105",
            country: "US",
          }
        : { line1: "1 Example St", country: region.country },
  });
  const est = await estimateNewSubscription({ ...c, customerId: cus.id, items, now: new Date() });
  const { subscription } = await createSubscription({
    ...c,
    customerId: cus.id,
    now: new Date(),
    items,
  });
  const { invoice } = await billSubscriptionPeriod({
    ...c,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const applied = await withTenant(orgId, (tx) =>
    tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, invoice.id)),
  );
  const appliedSum = applied.reduce((s2, r) => s2 + r.amountMinor, 0n);
  const taxPayable = await withTenant(orgId, async (tx) => {
    const res =
      await tx.execute(sql`select coalesce(sum(case when direction='credit' then amount_minor
      else -amount_minor end), 0)::text as bal from ledger_entries
      where business_id = ${b.id} and account = 'tax_payable'`);
    return BigInt((res as unknown as Array<{ bal: string }>)[0]?.bal ?? "0");
  });
  const label = `G ${region.name}`;
  ok(`${label}: invoice total is the gross 3000`, invoice.totalMinor === 3000n, invoice.totalMinor);
  ok(
    `${label}: tax backed out of the lines (${region.backedOut})`,
    appliedSum === region.backedOut &&
      applied.every((r) => r.taxabilityReason === "standard_rated"),
    applied.map((r) => [r.name, r.amountMinor]),
  );
  ok(`${label}: backed-out tax booked to tax_payable`, taxPayable === region.backedOut, taxPayable);
  ok(
    `${label}: preview quotes the backed-out tax and the same total`,
    BigInt(est.tax_minor) === region.backedOut && BigInt(est.total_minor) === invoice.totalMinor,
    { tax: est.tax_minor, total: est.total_minor, lines: est.tax_lines },
  );
}

// ── F. per-line rounding, estimate = invoice on the other preview paths ─────────
{
  const pl = await createBusiness({
    organizationId: orgId,
    name: "Per-line Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await updateBusiness(orgId, pl.publicId, { taxSettings: { rounding: "per_line" } });
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: pl.id,
    name: "VAT",
    country: "DE",
    rateBps: 1000,
  });
  const c = { organizationId: orgId, businessId: pl.id };
  const mk = async (kind: "plan" | "addon", name: string, amountMinor: number) => {
    const prod = await createProduct({ ...c, name, id: `${name}-${rnd()}`, kind });
    return createPrice({
      ...c,
      productId: prod.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  };
  const cust = () =>
    createCustomer({
      ...c,
      email: `pl-${rnd()}@example.com`,
      address: { line1: "1 Example St", country: "DE" },
    });

  // F1 item coupon: 50 off the add-on only. Lines 1000 | 950 → 100 + 95 = 195.
  const plan = await mk("plan", "pl-plan", 1000);
  const addon = await mk("addon", "pl-addon", 1000);
  const code = `ADD50${rnd()}`.toUpperCase();
  await createCoupon({
    ...c,
    code,
    kind: "fixed_amount",
    amountOffMinor: 50,
    currency: "USD",
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "addon", constraintType: "all" }],
  });
  const f1 = await cust();
  const items = [
    { price: plan, quantity: 1 },
    { price: addon, quantity: 1 },
  ];
  const est = await estimateNewSubscription({
    ...c,
    customerId: f1.id,
    items,
    couponCodes: [code],
    now: new Date(),
  });
  const { subscription: s1 } = await createSubscription({
    ...c,
    customerId: f1.id,
    now: new Date(),
    items,
  });
  await applyCouponToSubscription({ ...c, subscriptionId: s1.id, code, now: new Date() });
  const { invoice: i1 } = await billSubscriptionPeriod({
    ...c,
    subscription: s1,
    periodStart: s1.currentPeriodStart!,
    periodEnd: s1.currentPeriodEnd!,
  });
  ok(
    "F1 item coupon: estimate tax = invoice tax = 195",
    est.tax_minor === 195 && i1.totalMinor === 1950n + 195n,
    { est: est.tax_minor, invoice: i1.totalMinor },
  );

  // F2 cancel with invoice unbilled charges: 2 × 1005 → 2 × round(100.5) = 202.
  const f2 = await cust();
  const { subscription: s2 } = await createSubscription({
    ...c,
    customerId: f2.id,
    now: new Date(),
    items: [{ price: plan, quantity: 1 }],
  });
  await addAdHocCharges({
    ...c,
    subscriptionId: s2.id,
    invoiceNow: false,
    now: new Date(),
    lines: [
      { description: "Overage A", amountMinor: 1005 },
      { description: "Overage B", amountMinor: 1005 },
    ],
  });
  const cancelArgs = {
    ...c,
    subscriptionId: s2.id,
    cancelOption: "immediately" as const,
    unbilledChargesOption: "invoice" as const,
    creditOptionForCurrentTermCharges: "none" as const,
  };
  const ce = await estimateCancel({ ...cancelArgs, now: new Date() });
  await cancelSubscriptionWithOptions({ ...cancelArgs, now: new Date() });
  const [raised] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, s2.id)),
  );
  ok(
    "F2 unbilled-charges cancel: estimate = invoice = 2010 + 202",
    ce.unbilled_charges.total_minor === 2212 && raised?.totalMinor === 2212n,
    { est: ce.unbilled_charges.total_minor, invoice: raised?.totalMinor },
  );

  // F3 credit lines on an unbilled term: a plan swap at the term start credits two lines
  // of −1005; per line that is −202 of tax, on the total −201.
  const planA = await mk("plan", "pl-a", 1005);
  const extra = await mk("addon", "pl-x", 1005);
  const planB = await mk("plan", "pl-b", 3000);
  const extraB = await mk("addon", "pl-y", 2000);
  const f3 = await cust();
  const { subscription: s3, items: it3 } = await createSubscription({
    ...c,
    customerId: f3.id,
    now: new Date(),
    items: [
      { price: planA, quantity: 1 },
      { price: extra, quantity: 1 },
    ],
  });
  const planItem = it3.find((i) => i.priceId === planA.id)!;
  const extraItem = it3.find((i) => i.priceId === extra.id)!;
  const at = s3.currentPeriodStart!;
  const change = [
    { itemId: planItem.publicId, newPriceId: planB.publicId },
    { itemId: extraItem.publicId, newPriceId: extraB.publicId },
  ];
  const che = await estimateChange({ ...c, subscriptionId: s3.id, now: at, changes: change });
  const { prorationInvoice } = await changeSubscription({
    ...c,
    subscriptionId: s3.id,
    now: at,
    changes: change,
    invoiceImmediately: true,
  });
  ok(
    "F3 credit lines: estimate total = booked invoice total",
    !!prorationInvoice && BigInt(che.total_minor) === prorationInvoice.totalMinor,
    { est: che.total_minor, invoice: prorationInvoice?.totalMinor },
  );
}

let pass = true;
for (const [name, good] of checks) {
  console.log(`  ${good ? "✓" : "✗"} ${name}`);
  if (!good) pass = false;
}
console.log("");
console.log(pass ? `✅ TAX SETTINGS: PASS (${checks.length})` : "❌ TAX SETTINGS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
