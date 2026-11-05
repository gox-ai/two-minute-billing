/**
 * Phase D — Customers verify suite.
 *
 * The heart is D1: the three-balance split (promotional / refundable / excess)
 * and the invoice application order — discounts → promotional
 * (PRE-tax, reduces the taxable base, capped at the discounted subtotal) → tax →
 * refundable → excess → charge the remainder. Every assertion checks LEDGER
 * balances, not just invoice statuses (the Phase C review found status-only tests
 * hiding ledger bugs).
 *
 *   pnpm verify:customers
 */
import { and, eq, sql } from "drizzle-orm";
import { withTenant, closeDb, type Tx } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import {
  createCustomer,
  updateCustomer,
  validateCustomerVat,
  changeBillingDate,
  clearPersonalData,
  getCustomerByPublicId,
  listCustomersPage,
  CustomerError,
} from "@/modules/customers/service";
import { serializeCustomer } from "@/modules/customers/serialize";
import { createContact, listContacts } from "@/modules/customers/contacts";
import { advancePeriod } from "@/modules/subscriptions/service";
import { DEFAULT_BILLING_MODE as UTC_MODE } from "@/modules/subscriptions/billing-mode";
import { CollectError } from "@/modules/customers/collect";
import {
  vaultPaymentMethod,
  assignPaymentMethodRole,
  getPaymentRoleIds,
  listPaymentMethods,
} from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, createInvoiceFromLines } from "@/modules/invoicing/service";
import { collectPayment } from "@/modules/customers/collect";
import { createFlatTaxRate } from "@/modules/tax/service";
import {
  getCustomerBalances,
  bucketBalancesForCurrency,
  addPromotionalCredits,
  deductPromotionalCredits,
  setPromotionalCredits,
  recordExcessPayment,
} from "@/modules/customers/balances";
import { listEventsFiltered } from "@/modules/events/service";
import {
  invoices,
  invoiceLineItems,
  payments,
  paymentMethods,
  subscriptions,
  customers,
  transactions,
} from "@db/schema";
import { buildApp } from "@/index";
import { getVault } from "@/providers/tmtest/store";
import { createGatewayAccount } from "@/modules/gateway/service";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "Customers Org" });
const orgId = org.organization.id;

/** Debit-positive ledger balance for an account (optionally one customer), USD. */
async function acctBal(businessId: string, account: string, customerId?: string): Promise<bigint> {
  return withTenant(orgId, async (tx: Tx) => {
    const res = await tx.execute(sql`
      select coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
      from ledger_entries
      where business_id = ${businessId} and account = ${account} and currency='USD'
        ${customerId ? sql`and customer_id = ${customerId}` : sql``}
    `);
    return BigInt((res as unknown as Array<{ bal: string | number }>)[0]?.bal ?? 0);
  });
}
/** The whole business's ledger must net to zero (double-entry sanity). */
async function ledgerNetsZero(businessId: string): Promise<boolean> {
  return withTenant(orgId, async (tx: Tx) => {
    const res = await tx.execute(sql`
      select currency, coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
      from ledger_entries where business_id = ${businessId} group by currency
    `);
    return (res as unknown as Array<{ bal: string | number }>).every((r) => BigInt(r.bal) === 0n);
  });
}
async function invRow(id: string) {
  return withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1))[0]!,
  );
}
async function taxLineTotal(invoiceId: string): Promise<bigint> {
  return withTenant(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoiceLineItems)
      .where(and(eq(invoiceLineItems.invoiceId, invoiceId), eq(invoiceLineItems.kind, "tax")));
    return rows.reduce((s, r) => s + r.amountMinor, 0n);
  });
}

// Each balance-math test gets its own business (10% VAT) so absolute ledger
// balances are isolated. Customers are send-invoice (auto_collection=off) with no
// card, so the invoice stays open and AR reflects exactly the credit application
// (no auto-collection noise) — we assert the ledger split directly.
async function freshBiz(name: string) {
  const b = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b.id,
    name: "VAT",
    country: "GB",
    rateBps: 1000,
  });
  const prod = await createProduct({ organizationId: orgId, businessId: b.id, name: "Plan" });
  const mkPrice = (amt: number) =>
    createPrice({
      organizationId: orgId,
      businessId: b.id,
      productId: prod.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: amt,
      interval: "month",
    });
  return { biz: b, mkPrice };
}
async function gbCustomer(bizId: string, email: string) {
  return createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email,
    autoCollection: "off",
    address: { line1: "1 St", city: "London", postalCode: "EC1", country: "GB" },
  });
}
async function bill(
  bizId: string,
  customerId: string,
  priceRow: Awaited<ReturnType<typeof createPrice>>,
) {
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId,
    now: new Date(),
    items: [{ price: priceRow, quantity: 1 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: bizId,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  return invRow(invoice.id);
}

// ── D1(A): promotional credit is PRE-tax — it reduces the taxable base ─────────
{
  const { biz, mkPrice } = await freshBiz("D1-A promo");
  const c = await gbCustomer(biz.id, "promo@a.com");
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 3000,
    currency: "USD",
    description: "welcome",
  });
  const inv = await bill(biz.id, c.id, await mkPrice(10000));
  // taxable base = 10000 − 3000 = 7000 → tax 700 ; total = 10000 + 700 = 10700 ;
  // promo applied 3000 (pre-tax) ; amount_due = 10700 − 3000 = 7700.
  ok("D1: promo pre-tax → tax on (100−30)=7.00", (await taxLineTotal(inv.id)) === 700n);
  ok("D1: promo total = 107.00 (subtotal + reduced tax)", inv.totalMinor === 10700n);
  ok("D1: promo applied recorded = 30.00", inv.promotionalCreditsAppliedMinor === 3000n);
  ok("D1: promo amount_due = 77.00", inv.amountDueMinor === 7700n);
  ok(
    "D1: promo balance drawn to 0",
    (await bucketBalancesForCurrency(orgId, c.id, "USD")).promotional === 0n,
  );
  // Ledger (send-invoice, uncollected): revenue gross 100, tax_payable 7, AR net 77,
  // promo bucket net 0 (granted 3000, then drawn 3000).
  ok("D1: ledger revenue gross = 100.00", (await acctBal(biz.id, "revenue")) === -10000n);
  ok("D1: ledger tax_payable = 7.00", (await acctBal(biz.id, "tax_payable")) === -700n);
  ok("D1: ledger AR net = 77.00", (await acctBal(biz.id, "accounts_receivable")) === 7700n);
  ok(
    "D1: ledger promotional_credit_balance = 0",
    (await acctBal(biz.id, "promotional_credit_balance")) === 0n,
  );
  ok("D1: ledger nets to zero", await ledgerNetsZero(biz.id));
}

// ── D1(B): refundable + excess are POST-tax — they do NOT reduce the base ──────
{
  const { biz, mkPrice } = await freshBiz("D1-B excess");
  const c = await gbCustomer(biz.id, "excess@a.com");
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 3000,
    currency: "USD",
  });
  const inv = await bill(biz.id, c.id, await mkPrice(10000));
  // tax = 10% × 100 = 10.00 (full base) ; total = 110.00 ; excess 30.00 post-tax ;
  // amount_due = 110 − 30 = 80.00.
  ok("D1: excess is post-tax → tax on full 100 = 10.00", (await taxLineTotal(inv.id)) === 1000n);
  ok("D1: excess total = 110.00", inv.totalMinor === 11000n);
  ok("D1: excess applied recorded = 30.00", inv.excessPaymentsAppliedMinor === 3000n);
  ok("D1: excess amount_due = 80.00", inv.amountDueMinor === 8000n);
  ok(
    "D1: excess balance drawn to 0",
    (await bucketBalancesForCurrency(orgId, c.id, "USD")).excess === 0n,
  );
  ok("D1: excess ledger AR net = 80.00", (await acctBal(biz.id, "accounts_receivable")) === 8000n);
  ok("D1: excess ledger nets to zero", await ledgerNetsZero(biz.id));
}

// ── D1(C): all three buckets applied in order, with tax ────────────────────────
{
  const { biz, mkPrice } = await freshBiz("D1-C all3");
  const c = await gbCustomer(biz.id, "all3@a.com");
  // Seed refundable the way the engine now requires: a paid invoice + refundable
  // credit note (negative-subtotal invoices are rejected). Seed it FIRST so the
  // seed invoice can't draw the promo/excess buckets at creation.
  const { invoice: seedInv } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    currency: "USD",
    lines: [{ description: "goodwill seed", amountMinor: 1500n }],
  });
  const { recordOfflinePayment } = await import("@/modules/invoicing/ops");
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: seedInv.publicId,
  });
  const { issueRefundableCreditNote } = await import("@/modules/credit-notes/service");
  await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: seedInv.publicId,
    items: [{ description: "goodwill", amountMinor: 1500 }],
  });
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 2000,
    currency: "USD",
  });
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 1000,
    currency: "USD",
  });
  const before = await bucketBalancesForCurrency(orgId, c.id, "USD");
  ok(
    "D1: seeded balances promo=20 refundable=15 excess=10",
    before.promotional === 2000n && before.refundable === 1500n && before.excess === 1000n,
  );
  const inv = await bill(biz.id, c.id, await mkPrice(10000));
  // promo 2000 pre-tax → base 8000 → tax 800 → total 10800 ; then refundable 1500,
  // excess 1000 post-tax ; amount_due = 10800 − 2000 − 1500 − 1000 = 6300.
  ok("D1: 3-bucket tax on (100−20)=8.00", (await taxLineTotal(inv.id)) === 800n);
  ok("D1: 3-bucket total = 108.00", inv.totalMinor === 10800n);
  ok("D1: 3-bucket promo applied = 20.00", inv.promotionalCreditsAppliedMinor === 2000n);
  ok("D1: 3-bucket refundable applied = 15.00", inv.refundableCreditsAppliedMinor === 1500n);
  ok("D1: 3-bucket excess applied = 10.00", inv.excessPaymentsAppliedMinor === 1000n);
  ok("D1: 3-bucket amount_due = 63.00", inv.amountDueMinor === 6300n);
  const after = await bucketBalancesForCurrency(orgId, c.id, "USD");
  ok(
    "D1: all three buckets drawn to 0",
    after.promotional === 0n && after.refundable === 0n && after.excess === 0n,
  );
  ok("D1: ledger nets to zero (3-bucket)", await ledgerNetsZero(biz.id));
}

// ── D1(D): promotional credit capped at the discounted subtotal ────────────────
{
  const { biz, mkPrice } = await freshBiz("D1-D cap");
  const c = await gbCustomer(biz.id, "cap@a.com");
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 15000,
    currency: "USD",
  }); // $150 vs $100 invoice
  const inv = await bill(biz.id, c.id, await mkPrice(10000));
  // promo capped at 10000 → base 0 → tax 0 → total 10000 ; amount_due 0 (fully paid) ;
  // leftover promo balance = 15000 − 10000 = 5000.
  ok("D1: promo cap → tax 0", (await taxLineTotal(inv.id)) === 0n);
  ok("D1: promo cap → total 100.00", inv.totalMinor === 10000n);
  ok("D1: promo cap applied = 100.00 (capped)", inv.promotionalCreditsAppliedMinor === 10000n);
  ok("D1: promo cap → amount_due 0 + paid", inv.amountDueMinor === 0n && inv.status === "paid");
  ok(
    "D1: promo cap leftover balance = 50.00",
    (await bucketBalancesForCurrency(orgId, c.id, "USD")).promotional === 5000n,
  );
  ok("D1: promo cap ledger nets to zero", await ledgerNetsZero(biz.id));
}

// ── D1(E): getCustomerBalances read model + ops (add/deduct/set) + events ───────
{
  const { biz } = await freshBiz("D1-E ops");
  const c = await gbCustomer(biz.id, "ops@a.com");
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 5000,
    currency: "USD",
  });
  await deductPromotionalCredits({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 2000,
    currency: "USD",
  });
  await setPromotionalCredits({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 4000,
    currency: "USD",
  }); // 3000 → 4000 (add 1000)
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 2500,
    currency: "USD",
  });
  const bals = await getCustomerBalances(orgId, c.id);
  ok(
    "D1: getCustomerBalances promo = 40.00 after add/deduct/set",
    bals["USD"]?.promotional === 4000,
  );
  ok("D1: getCustomerBalances excess = 25.00", bals["USD"]?.excess === 2500);
  // Over-deduct is capped at available (no negative balance).
  const r = await deductPromotionalCredits({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 99999,
    currency: "USD",
  });
  ok("D1: over-deduct capped, balance 0", r.balance === 0n && r.deductedMinor === 4000n);
  const evs = await listEventsFiltered(orgId, { resourceId: c.publicId, limit: 50 });
  const types = new Set(evs.data.map((e) => e.type));
  ok(
    "D1: emits customer.promotional_credits_added",
    types.has("customer_promotional_credits_added"),
  );
  ok(
    "D1: emits customer.promotional_credits_deducted",
    types.has("customer_promotional_credits_deducted"),
  );
  ok("D1: emits customer.excess_payment_recorded", types.has("customer_excess_payment_recorded"));
}

// ── D2: payment roles surfaced (primary / backup) ──────────────────────────────
{
  const { biz } = await freshBiz("D2 roles");
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "roles@a.com",
  });
  const pmA = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  const pmB = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  await assignPaymentMethodRole(orgId, c.id, pmA.publicId, "primary");
  await assignPaymentMethodRole(orgId, c.id, pmB.publicId, "backup");
  const roles = await getPaymentRoleIds(orgId, c.id);
  ok("D2: primary_payment_source_id surfaced", roles.primary === pmA.publicId);
  ok("D2: backup_payment_source_id surfaced", roles.backup === pmB.publicId);
}

// ── D3: ad-hoc collect_payment — credits first, oldest-due-first, charge rest ────
{
  const { biz } = await freshBiz("D3 collect");
  const price40 = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: (await createProduct({ organizationId: orgId, businessId: biz.id, name: "D3" })).id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 4000,
    interval: "month",
  });
  const price60 = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: (await createProduct({ organizationId: orgId, businessId: biz.id, name: "D3b" })).id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 6000,
    interval: "month",
  });
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "collect@a.com",
    autoCollection: "off",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  // Two OPEN invoices FIRST (send-invoice, no credit yet), oldest = $40 then $60.
  const invA = await bill(biz.id, c.id, price40); // created first → oldest
  const invB = await bill(biz.id, c.id, price60);
  // Unpaid with no due date = due on issue = `payment_due` (invoicing/status.ts).
  ok(
    "D3: two open invoices before collect",
    invA.status === "payment_due" && invB.status === "payment_due",
  );
  // Excess arrives AFTER the invoices are open → collect applies it oldest-first.
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 5000,
    currency: "USD",
  }); // $50 excess
  const r = await collectPayment({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c.publicId,
  });
  // Oldest ($40) fully covered by excess; ($60) gets remaining $10 excess + $50 card.
  ok("D3: excess applied = 50.00 (40 + 10)", r!.applied.excess === 5000);
  ok("D3: card charged = 50.00 (remainder of the $60)", r!.charged === 5000);
  ok(
    "D3: excess balance drawn to 0",
    (await bucketBalancesForCurrency(orgId, c.id, "USD")).excess === 0n,
  );
  const aRow = await invRow(invA.id);
  const bRow = await invRow(invB.id);
  ok(
    "D3: oldest invoice paid by credit alone",
    aRow.status === "paid" && aRow.amountDueMinor === 0n,
  );
  ok("D3: newer invoice paid (credit + card)", bRow.status === "paid");
  // Card charge on the newer invoice = $50 (a succeeded payment).
  const cardPay = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, invB.id), eq(payments.status, "succeeded"))),
  );
  ok(
    "D3: card charged $50 on newer invoice",
    cardPay.some((p) => p.amountMinor === 5000n),
  );
  // cash = $50 recorded excess (dr cash) + $50 card charge = $100.
  ok(
    "D3: cash = excess-recorded + card charge = 100.00",
    (await acctBal(biz.id, "cash")) === 10000n,
  );
  ok("D3: ledger nets to zero", await ledgerNetsZero(biz.id));
}

// ── D4: VAT status — noop validator + PATCH resets ─────────────────────────────
{
  const { biz } = await freshBiz("D4 vat");
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "vat@a.com",
    vatNumber: "GB123456789",
    address: { line1: "1", city: "London", postalCode: "E1", country: "GB" },
  });
  ok("D4: new vat number starts not_validated", c.vatNumberStatus === "not_validated");
  const v = await validateCustomerVat(orgId, biz.id, c.publicId);
  ok(
    "D4: noop validator → undetermined (present number)",
    v!.vatNumberStatus === "undetermined" && v!.vatValidatedAt !== null,
  );
  const u = await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c.publicId,
    vatNumber: "GB999",
  });
  ok(
    "D4: editing vat_number resets status",
    u!.vatNumberStatus === "not_validated" && u!.vatValidatedAt === null,
  );
}

// ── D5: calendar billing anchor consumed at subscription create ─────────────────
{
  const { biz, mkPrice } = await freshBiz("D5 anchor");
  const price = await mkPrice(1000);
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "anchor@a.com",
  });
  await changeBillingDate(orgId, biz.id, c.publicId, {
    billingDate: 1,
    billingDateMode: "manually_set",
  });
  // Start mid-month; first period should end on the 1st of next month (the anchor).
  const start = new Date(Date.UTC(2026, 5, 15)); // 2026-06-15
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: start,
    items: [{ price, quantity: 1 }],
  });
  const pe = sub.subscription.currentPeriodEnd!;
  ok(
    "D5: first period ends on the customer billing anchor (1st next month)",
    pe.getUTCFullYear() === 2026 && pe.getUTCMonth() === 6 && pe.getUTCDate() === 1,
  );
}

// ── D8: the picker's server search reaches PAST the first page ─────────────────
//
// The manual-invoice and subscription-create pickers were handed
// `listCustomers(biz, { limit: 1000 })` and filtered it IN THE BROWSER, so customer
// 1001 was unfindable — silently: no "showing 1000 of N", just a search that
// confidently returned nothing, and an operator concluding the customer did not exist.
// Both now search the server. This pins the property that makes that safe: `search`
// narrows in SQL over the WHOLE book, not over whatever page was fetched.
{
  const { biz } = await freshBiz("D8 picker search");
  // Created FIRST so the created_at-DESC first page pushes it out of reach — the exact
  // shape of the bug. A needle that happens to be on page one proves nothing.
  const needle = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "zenobia@needleco.example",
    firstName: "Zenobia",
    lastName: "Needlecraft",
    company: "Needle Co",
  });
  for (let i = 0; i < 30; i++) {
    await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `bulk${i}@a.com`,
      firstName: "Bulk",
      lastName: `Person ${i}`,
    });
  }
  const firstPage = await listCustomersPage(orgId, biz.id, { limit: 25 });
  const onFirstPage = firstPage.data.some((c) => c.id === needle.id);
  ok(
    "D8: the needle is NOT on the first page (so a client-side filter would miss it)",
    !onFirstPage,
  );
  ok("D8: the first page reports more to come", firstPage.hasMore === true);

  const byName = await listCustomersPage(orgId, biz.id, { search: "Needlecraft", limit: 25 });
  ok("D8: search finds it by name", byName.data.length === 1 && byName.data[0]!.id === needle.id);
  const byCompany = await listCustomersPage(orgId, biz.id, { search: "Needle Co", limit: 25 });
  ok(
    "D8: search finds it by company",
    byCompany.data.length === 1 && byCompany.data[0]!.id === needle.id,
  );
  const byEmail = await listCustomersPage(orgId, biz.id, { search: "zenobia@needleco", limit: 25 });
  ok(
    "D8: search finds it by email",
    byEmail.data.length === 1 && byEmail.data[0]!.id === needle.id,
  );
  const byId = await listCustomersPage(orgId, biz.id, { search: needle.publicId, limit: 25 });
  ok("D8: search finds it by public id", byId.data.length === 1 && byId.data[0]!.id === needle.id);
}

// ── D7: a COUNTRY-ONLY billing address survives a read and an edit ─────────────
//
// The serializer used to gate the whole address on `line1`, so a customer carrying
// `country: 'IN'` and no street reported `"address": null` while the row had the
// country and the tax engine correctly charged 18% off it.
//
// The read was the cheap half. The operator edit form prefills from that value and
// REPLACES the whole address on save, so an empty prefill posted `country: null` and
// WIPED the country — silently switching GST off for exactly the customers an API
// provisions. That is the round trip asserted below.
{
  const { biz } = await freshBiz("D7 country only");
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "countryonly@a.com",
    address: { country: "IN" },
  });
  const ser = serializeCustomer(c) as { address: Record<string, string | null> | null };
  ok("D7: a country-only address serializes as an OBJECT, not null", ser.address !== null);
  ok("D7: and it carries the country the tax engine reads", ser.address?.country === "IN");
  ok("D7: with the absent street reported as null, not omitted", ser.address?.line1 === null);

  // The edit form's actual shape: take what the API returned, send it straight back.
  // This is what wiped the country when the prefill was empty.
  const back = await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c.publicId,
    address: {
      line1: ser.address?.line1 ?? null,
      line2: ser.address?.line2 ?? null,
      line3: ser.address?.line3 ?? null,
      city: ser.address?.city ?? null,
      state: ser.address?.state ?? null,
      stateCode: ser.address?.state_code ?? null,
      postalCode: ser.address?.postal_code ?? null,
      country: ser.address?.country ?? null,
      firstName: ser.address?.first_name ?? null,
      lastName: ser.address?.last_name ?? null,
      company: ser.address?.company ?? null,
      phone: ser.address?.phone ?? null,
    },
  });
  ok("D7: re-posting the serialized address PRESERVES the country", back?.country === "IN");

  // The other half of the rule: nothing meaningful still serializes as null, so the
  // fix did not turn "no address" into an object full of nulls.
  const bare = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "noaddr@a.com",
  });
  const bareSer = serializeCustomer(bare) as { address: unknown };
  ok("D7: a customer with NO address still serializes address = null", bareSer.address === null);
}

// ── D6: GDPR clear_personal_data — scrub PII, detach PMs, ledger intact ─────────
{
  const { biz } = await freshBiz("D6 gdpr");
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "gdpr@a.com",
    firstName: "Jane",
    lastName: "Doe",
    phone: "+15551234",
    address: { line1: "9 Rd", city: "NYC", country: "US" },
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 2500,
    currency: "USD",
  });
  const balBefore = (await bucketBalancesForCurrency(orgId, c.id, "USD")).excess;
  const cleared = await clearPersonalData(orgId, biz.id, c.publicId);
  ok("D6: email scrubbed to null", cleared!.email === null);
  ok("D6: name scrubbed to [cleared]", cleared!.name === "[cleared]");
  ok(
    "D6: phone + address scrubbed",
    cleared!.phone === null && cleared!.addressLine1 === null && cleared!.country === null,
  );
  ok("D6: pii_cleared = cleared", cleared!.piiCleared === "cleared");
  const pms = await listPaymentMethods(orgId, c.id);
  ok("D6: payment sources detached", pms.length === 0);
  const balAfter = (await bucketBalancesForCurrency(orgId, c.id, "USD")).excess;
  ok("D6: ledger untouched (excess balance intact)", balBefore === 2500n && balAfter === 2500n);
  ok("D6: ledger still nets to zero", await ledgerNetsZero(biz.id));
}

// ── Review fixes (2026-07-04): void reversal, withholding×promo cap, over-draw ──

// F2(a): voiding a COUPON-DISCOUNTED invoice reverses the discounts debit too —
// previously it re-derived tax=total−subtotal, left discounts stranded, and threw
// "Unbalanced". Now it reverses the exact generation postings.
{
  const { biz } = await freshBiz("F2 discounted void");
  const { createCoupon, applyCouponToSubscription } = await import("@/modules/coupons/service");
  const prod = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "DVoid Plan",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "DV10",
    kind: "percentage",
    percentOffBps: 1000,
  });
  const cus = await gbCustomer(biz.id, "dvoid@a.com");
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cus.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.subscription.id,
    code: "DV10",
    now: new Date(),
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  const { voidInvoice } = await import("@/modules/invoicing/ops");
  const voided = await voidInvoice(orgId, biz.id, invoice.publicId);
  ok("F2: discounted invoice voids without throwing", voided.status === "voided");
  ok(
    "F2: discounted void → ledger nets to zero (discounts reversed)",
    await ledgerNetsZero(biz.id),
  );
  ok(
    "F2: discounted void → AR back to zero",
    (await acctBal(biz.id, "accounts_receivable")) === 0n,
  );
}

// F2(b): voiding an INCLUSIVE-tax invoice reverses cleanly (revenue was booked net
// of inclusive tax; the old re-derivation stranded tax_payable).
{
  const b = await createBusiness({
    organizationId: orgId,
    name: "F2 inclusive void",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b.id,
    name: "VAT",
    country: "GB",
    rateBps: 1000,
  });
  const prod = await createProduct({ organizationId: orgId, businessId: b.id, name: "Inc Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: b.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 11000,
    interval: "month",
    taxBehavior: "inclusive",
  });
  const cus = await gbCustomer(b.id, "incvoid@a.com");
  const inv = await bill(b.id, cus.id, price);
  const { voidInvoice } = await import("@/modules/invoicing/ops");
  const voided = await voidInvoice(orgId, b.id, inv.publicId);
  ok("F2: inclusive-tax invoice voids without throwing", voided.status === "voided");
  ok("F2: inclusive void → ledger nets to zero (tax_payable reversed)", await ledgerNetsZero(b.id));
  ok("F2: inclusive void → tax_payable back to zero", (await acctBal(b.id, "tax_payable")) === 0n);
}

// F2(c): voiding a credit-consuming invoice RETURNS the credit to its buckets.
{
  const { biz, mkPrice } = await freshBiz("F2 credit void");
  const price = await mkPrice(5000);
  const cus = await gbCustomer(biz.id, "credvoid@a.com");
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: cus,
    amountMinor: 3000,
    currency: "USD",
  });
  const inv = await bill(biz.id, cus.id, price);
  const afterBill = (await bucketBalancesForCurrency(orgId, cus.id, "USD")).excess;
  const { voidInvoice } = await import("@/modules/invoicing/ops");
  await voidInvoice(orgId, biz.id, inv.publicId);
  const afterVoid = (await bucketBalancesForCurrency(orgId, cus.id, "USD")).excess;
  ok(
    "F2: void returns consumed excess credit to the bucket",
    afterBill === 0n && afterVoid === 3000n,
  );
  ok("F2: credit-void → ledger nets to zero", await ledgerNetsZero(biz.id));
}

// F3: promotional credit is capped at COLLECTIBLE, not just discounted subtotal —
// with withholding, an over-large promo balance must not drive amountDue negative.
{
  const b = await createBusiness({
    organizationId: orgId,
    name: "F3 wh promo",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const prod = await createProduct({ organizationId: orgId, businessId: b.id, name: "WH Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: b.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  // 10% withholding, no tax → collectible = 9000; promo balance 100000 (huge).
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: b.id,
    email: "whpromo@a.com",
    autoCollection: "off",
    withholdingRateBps: 1000,
  });
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: b.id,
    customer: cus,
    amountMinor: 100000,
    currency: "USD",
  });
  const inv = await bill(b.id, cus.id, price);
  ok("F3: amountDue never negative under withholding+promo", (inv.amountDueMinor ?? 0n) >= 0n);
  ok(
    "F3: promo applied capped at collectible (9000)",
    (inv.promotionalCreditsAppliedMinor ?? 0n) <= 9000n,
  );
  ok("F3: withholding+promo → ledger nets to zero", await ledgerNetsZero(b.id));
}

// F1: concurrent invoices on ONE customer cannot over-draw a bucket (advisory lock).
{
  const { biz, mkPrice } = await freshBiz("F1 overdraw");
  const price = await mkPrice(5000);
  const cus = await gbCustomer(biz.id, "overdraw@a.com");
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: cus,
    amountMinor: 5000,
    currency: "USD",
  });
  // Two subscriptions, billed concurrently — only 5000 of credit exists.
  const s1 = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cus.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const s2 = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cus.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const p = (s: typeof s1) =>
    billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: s.subscription,
      periodStart: s.subscription.currentPeriodStart!,
      periodEnd: s.subscription.currentPeriodEnd!,
    });
  const [i1, i2] = await Promise.all([p(s1), p(s2)]);
  const applied =
    (i1.invoice.excessPaymentsAppliedMinor ?? 0n) + (i2.invoice.excessPaymentsAppliedMinor ?? 0n);
  ok("F1: concurrent draws never exceed the 5000 balance", applied === 5000n);
  ok(
    "F1: excess bucket not driven negative",
    (await bucketBalancesForCurrency(orgId, cus.id, "USD")).excess === 0n,
  );
  ok("F1: over-draw guard → ledger nets to zero", await ledgerNetsZero(biz.id));
}

// ── Warm-up review fixes (Phase D backlog → Phase E session) ────────────────────

// W1: collect_payment budget is CURRENCY-scoped — a USD budget must not draw down
// an EUR invoice (was currency-blind). Also: amount_minor without currency → 400.
{
  const { biz } = await freshBiz("W1 currency scope");
  const prod = await createProduct({ organizationId: orgId, businessId: biz.id, name: "W1" });
  const usdPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 4000,
    interval: "month",
  });
  const eurPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "EUR",
    amountMinor: 4000,
    interval: "month",
  });
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "w1@a.com",
    autoCollection: "off",
  });
  const invUsd = await bill(biz.id, c.id, usdPrice);
  const invEur = await bill(biz.id, c.id, eurPrice);
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 5000,
    currency: "USD",
  });
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 5000,
    currency: "EUR",
  });
  // A large USD budget: it must only settle the USD invoice, never the EUR one.
  const r = await collectPayment({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c.publicId,
    amountMinor: 10000,
    currency: "USD",
  });
  const usdRow = await invRow(invUsd.id);
  const eurRow = await invRow(invEur.id);
  ok("W1: USD invoice settled by USD credit", usdRow.status === "paid");
  ok(
    "W1: EUR invoice untouched by a USD budget",
    eurRow.status === "payment_due" && (eurRow.excessPaymentsAppliedMinor ?? 0n) === 0n,
  );
  ok(
    "W1: EUR excess bucket intact (5000)",
    (await bucketBalancesForCurrency(orgId, c.id, "EUR")).excess === 5000n,
  );
  ok("W1: collect result reports only USD drawn (4000)", r!.applied.excess === 4000);
  let guard = false;
  try {
    await collectPayment({
      organizationId: orgId,
      businessId: biz.id,
      customerPublicId: c.publicId,
      amountMinor: 1000,
    });
  } catch (e) {
    guard = e instanceof CollectError;
  }
  ok("W1: amount_minor without currency → CollectError", guard);
}

// W2: a failing card charge STOPS further card attempts this run (was: charge the
// same failing card on every open invoice, burning a dunning attempt each).
{
  const { biz } = await freshBiz("W2 card fail-stop");
  const p1 = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: (await createProduct({ organizationId: orgId, businessId: biz.id, name: "W2a" })).id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 4000,
    interval: "month",
  });
  const p2 = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: (await createProduct({ organizationId: orgId, businessId: biz.id, name: "W2b" })).id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 4000,
    interval: "month",
  });
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "w2@a.com",
    autoCollection: "off",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "4000000000009995",
  }); // retriable decline
  const invA = await bill(biz.id, c.id, p1); // oldest
  const invB = await bill(biz.id, c.id, p2);
  const r = await collectPayment({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c.publicId,
  });
  ok("W2: nothing charged (card declined)", r!.charged === 0);
  const payA = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, invA.id)),
  );
  const payB = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, invB.id)),
  );
  ok("W2: oldest invoice got exactly one (failed) attempt", payA.length === 1);
  ok("W2: second invoice never charged after the first failure", payB.length === 0);
}

// W3: calendar anchor re-aligns each renewal instead of drifting after a short
// month. Day-31 anchor: Jan-31 → Feb-28 (clamped) → Mar-31 (re-aligned, not 28).
{
  const jan31 = new Date(Date.UTC(2026, 0, 31));
  const feb = advancePeriod(jan31, "month", 1, 31, UTC_MODE);
  ok(
    "W3: day-31 anchor clamps to Feb 28 in a short month",
    feb.getUTCMonth() === 1 && feb.getUTCDate() === 28,
  );
  const mar = advancePeriod(feb, "month", 1, 31, UTC_MODE);
  ok(
    "W3: next renewal re-aligns to the anchor day (Mar 31, not Mar 28)",
    mar.getUTCMonth() === 2 && mar.getUTCDate() === 31,
  );
  const drift = advancePeriod(feb, "month", 1, null, UTC_MODE);
  ok(
    "W3: no anchor → plain interval add (drifts to Mar 28)",
    drift.getUTCMonth() === 2 && drift.getUTCDate() === 28,
  );
  // The anchor day is persisted on the subscription at create.
  const { biz, mkPrice } = await freshBiz("W3 anchor persist");
  const c = await createCustomer({ organizationId: orgId, businessId: biz.id, email: "w3@a.com" });
  await changeBillingDate(orgId, biz.id, c.publicId, {
    billingDate: 31,
    billingDateMode: "manually_set",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(Date.UTC(2026, 0, 10)),
    items: [{ price: await mkPrice(1000), quantity: 1 }],
  });
  ok("W3: subscription persists billing_anchor_day = 31", sub.subscription.billingAnchorDay === 31);
}

// W4: GDPR clear also scrubs additional contacts, and PII can't be re-populated.
{
  const { biz } = await freshBiz("W4 gdpr contacts");
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "w4@a.com",
    firstName: "Dana",
    lastName: "Doe",
  });
  await createContact({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    email: "contact@a.com",
    firstName: "Bob",
    phone: "+15559999",
  });
  await clearPersonalData(orgId, biz.id, c.publicId);
  const cons = await listContacts(orgId, c.id);
  ok("W4: contact email scrubbed to [cleared]", cons[0]?.email === "[cleared]");
  ok("W4: contact name + phone scrubbed", cons[0]?.firstName === null && cons[0]?.phone === null);
  let blocked = false;
  try {
    await updateCustomer({
      organizationId: orgId,
      businessId: biz.id,
      customerPublicId: c.publicId,
      firstName: "Re-added",
    });
  } catch (e) {
    blocked = e instanceof CustomerError;
  }
  ok("W4: re-populating PII on a cleared customer is rejected", blocked);
  const edited = await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c.publicId,
    netTermDays: 15,
  });
  ok("W4: non-PII commercial edit still allowed on a cleared customer", edited!.netTermDays === 15);
}

// ── Review fixes (Phase E backlog): GDPR contacts guard + cross-customer scope ──
{
  const { updateContact, deleteContact, ContactError } =
    await import("@/modules/customers/contacts");
  const { biz } = await freshBiz("W GDPR contacts");
  const c1 = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "c1@a.com",
    firstName: "One",
  });
  const c2 = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "c2@a.com",
    firstName: "Two",
  });
  const con1 = await createContact({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c1.id,
    email: "b1@a.com",
    label: "Billing",
  });
  // Cross-customer scoping: c2's route must not touch c1's contact.
  const crossUpd = await updateContact({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c2.id,
    contactPublicId: con1.publicId,
    label: "Hijack",
  });
  ok("W: contact PATCH scoped to owning customer (cross-customer → null)", crossUpd === null);
  const crossDel = await deleteContact(orgId, biz.id, c2.id, con1.publicId);
  ok("W: contact DELETE scoped to owning customer (cross-customer → false)", crossDel === false);
  // GDPR: after clearing c1, adding/editing PII on its contacts is blocked.
  await clearPersonalData(orgId, biz.id, c1.publicId);
  let addBlocked = false;
  try {
    await createContact({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c1.id,
      email: "new@a.com",
    });
  } catch (e) {
    addBlocked = e instanceof ContactError;
  }
  ok("W: adding a contact to a cleared customer is rejected (GDPR)", addBlocked);
  let editBlocked = false;
  try {
    await updateContact({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c1.id,
      contactPublicId: con1.publicId,
      email: "x@a.com",
    });
  } catch (e) {
    editBlocked = e instanceof ContactError;
  }
  ok("W: setting contact PII on a cleared customer is rejected (GDPR)", editBlocked);
  // A non-PII contact edit is still allowed on a cleared customer.
  const nonPii = await updateContact({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c1.id,
    contactPublicId: con1.publicId,
    enabled: false,
  });
  ok("W: non-PII contact edit still allowed on a cleared customer", nonPii?.enabled === false);
}

// ── Review fix: addInterval clamps month/year rollover (no JS Jan-31→Mar-3) ──────
{
  const { addInterval } = await import("@/modules/subscriptions/service");
  const jan31 = new Date(Date.UTC(2026, 0, 31));
  const plus1mo = addInterval(jan31, "month", 1);
  ok(
    "W: Jan 31 + 1 month clamps to Feb 28 (not rolling to March)",
    plus1mo.getUTCMonth() === 1 && plus1mo.getUTCDate() === 28,
  );
  const feb29 = new Date(Date.UTC(2024, 1, 29)); // leap
  const plus1yr = addInterval(feb29, "year", 1);
  ok(
    "W: Feb 29 + 1 year clamps to Feb 28 in a non-leap year",
    plus1yr.getUTCMonth() === 1 && plus1yr.getUTCDate() === 28,
  );
  // And the anchored advance re-aligns (Jan 31 anchor → Feb 28 → Mar 31).
  const feb = advancePeriod(jan31, "month", 1, 31, UTC_MODE);
  const mar = advancePeriod(feb, "month", 1, 31, UTC_MODE);
  ok(
    "W: anchored advance re-aligns Jan31→Feb28→Mar31 (no drift)",
    feb.getUTCDate() === 28 && mar.getUTCDate() === 31,
  );
}

// ── D9: the Home attention-cell filters ────────────────────────────────────────
//
// `cannot_be_charged`, `payment_method_expiring`, `paying` and `renewing` are the lists behind
// Business Home's "Can't be charged" / "Cards expiring" cells and the Paying customers link, and
// each cell's figure IS its list's total. One customer per case; each filter must pick exactly
// its own, and a filter plus its negation must cover everyone once.
{
  const { biz, mkPrice } = await freshBiz("D9 attention filters");
  const paid = await mkPrice(2000);
  const free = await mkPrice(0);
  const DAY = 86_400_000;
  const monthOf = (at: number) => {
    const d = new Date(at);
    return { expMonth: d.getUTCMonth() + 1, expYear: d.getUTCFullYear() };
  };
  // Unique per run: provider ids are unique across the book, and the suite re-runs on one database.
  const run = Date.now().toString(36);
  let n = 0;
  const card = (customerId: string, status: string, exp: { expMonth: number; expYear: number }) =>
    withTenant(orgId, (tx) =>
      tx.insert(paymentMethods).values({
        organizationId: orgId,
        businessId: biz.id,
        customerId,
        publicId: `pm_d9_${run}_${++n}`,
        providerKey: "mock",
        providerCustomerId: `pc_d9_${run}_${n}`,
        providerPaymentMethodId: `ppm_d9_${run}_${n}`,
        type: "card",
        status,
        ...exp,
      }),
    );
  const expired = monthOf(Date.now() - 60 * DAY);
  // A card expires at the END of its month, so +30d keeps it inside 90 days on any date (+60d did not).
  const soon = monthOf(Date.now() + 30 * DAY);
  const later = monthOf(Date.now() + 200 * DAY);

  // Created offline so creating the subscription charges nothing; each case then sets its own state.
  const make = async (tag: string, price: typeof paid, collect: "on" | "off") => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `${tag}@d9.example.com`,
      autoCollection: "off",
    });
    const sub = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    });
    await withTenant(orgId, (tx) =>
      tx.update(customers).set({ autoCollection: collect }).where(eq(customers.id, c.id)),
    );
    return { c, subId: sub.subscription.id };
  };
  const setSub = (id: string, patch: Partial<typeof subscriptions.$inferInsert>) =>
    withTenant(orgId, (tx) => tx.update(subscriptions).set(patch).where(eq(subscriptions.id, id)));

  const none = await make("none", paid, "on");
  const onlyExpired = await make("expired", paid, "on");
  await card(onlyExpired.c.id, "valid", expired); // printed date past: expired though status says valid
  const onlyInvalid = await make("invalid", paid, "on");
  await card(onlyInvalid.c.id, "invalid", later);
  const backup = await make("backup", paid, "on");
  await card(backup.c.id, "expired", expired);
  await card(backup.c.id, "valid", later);
  const offline = await make("offline", paid, "off");
  const ending = await make("ending", paid, "on");
  await setSub(ending.subId, { cancelAtPeriodEnd: true });
  const freePlan = await make("free", free, "on");
  const cancelled = await make("cancelled", paid, "on");
  await setSub(cancelled.subId, { status: "cancelled", mrr: 0n });
  const expiring = await make("soon", paid, "on");
  await card(expiring.c.id, "valid", soon);
  const notYet = await make("later", paid, "on");
  await card(notYet.c.id, "valid", later);

  const [paidSub] = await withTenant(orgId, (tx) =>
    tx
      .select({ mrr: subscriptions.mrr })
      .from(subscriptions)
      .where(eq(subscriptions.id, none.subId)),
  );
  ok("D9: fixture — a paid subscription carries MRR", (paidSub?.mrr ?? 0n) > 0n);

  const ids = async (field: string, value = "true") =>
    new Set(
      (
        await listCustomersPage(orgId, biz.id, {
          limit: 100,
          filters: [{ field, op: "is", value }],
        })
      ).data.map((c) => c.email),
    );
  const same = (got: Set<string | null>, want: string[]) =>
    got.size === want.length && want.every((e) => got.has(`${e}@d9.example.com`));
  const everyone = (await listCustomersPage(orgId, biz.id, { limit: 100 })).total;

  const cbc = await ids("cannot_be_charged");
  ok(
    "D9: cannot_be_charged = no method, only-expired (status OR printed date) and only-invalid — not a working backup, offline, ending at term, free or cancelled",
    same(cbc, ["none", "expired", "invalid"]),
  );
  ok(
    "D9: paying = active or non-renewing earning MRR (not free, not cancelled)",
    same(await ids("paying"), [
      "none",
      "expired",
      "invalid",
      "backup",
      "offline",
      "ending",
      "soon",
      "later",
    ]),
  );
  ok(
    "D9: renewing = paying minus the subscription ending at term",
    same(await ids("renewing"), [
      "none",
      "expired",
      "invalid",
      "backup",
      "offline",
      "soon",
      "later",
    ]),
  );
  ok(
    "D9: payment_method_expiring = the card expiring inside ninety days, not the one past them",
    same(await ids("payment_method_expiring"), ["soon"]),
  );
  for (const f of ["cannot_be_charged", "paying", "renewing", "payment_method_expiring"]) {
    const yes = (await ids(f)).size;
    const no = (await ids(f, "false")).size;
    ok(`D9: ${f} and its negation partition every customer`, yes + no === everyone);
  }
}

// ── D10: API params — credit annotations/history, excess transaction, allocations,
// caller ids, payment-method retrieve/paging/permanent token/delete_local ─────────
{
  const { biz } = await freshBiz("D10 api params");
  const app = await buildApp({ logger: false });
  const auth = { authorization: `Bearer ${org.secret}` };
  const base = `/v1/businesses/${biz.publicId}`;
  const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({
      method,
      url: base + url,
      headers:
        method === "POST" ? { ...auth, "idempotency-key": crypto.randomUUID() } : { ...auth },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const c = await createCustomer({ organizationId: orgId, businessId: biz.id, email: "d10@a.com" });
  const cus = `/customers/${c.publicId}`;

  // Promotional credits: annotation + history.
  const plain = await call("POST", `${cus}/promotional_credits`, {
    action: "add",
    amount_minor: 1000,
    currency: "USD",
  });
  ok(
    "D10: unannotated promotional_credits reply keeps its old keys",
    plain.statusCode === 200 &&
      Object.keys(plain.json()).sort().join() === "balance_minor,currency,customer,object",
  );
  const ref = await call("POST", `${cus}/promotional_credits`, {
    action: "add",
    amount_minor: 500,
    currency: "USD",
    credit_type: "referral_rewards",
    reference: "referred a friend",
  });
  const refBody = ref.json() as { movement: string; credit_type: string; balance_minor: number };
  ok(
    "D10: annotated add returns movement + credit_type",
    ref.statusCode === 200 && !!refBody.movement && refBody.credit_type === "referral_rewards",
  );
  await call("POST", `${cus}/promotional_credits`, {
    action: "deduct",
    amount_minor: 300,
    currency: "USD",
    credit_type: "loyalty_credits",
  });
  const bad = await call("POST", `${cus}/promotional_credits`, {
    action: "add",
    amount_minor: 1,
    currency: "USD",
    credit_type: "voucher",
  });
  ok("D10: unknown credit_type is 400", bad.statusCode === 400);
  const hist = await call("GET", `${cus}/promotional_credits`);
  const h = hist.json() as {
    data: Array<{
      id: string;
      type: string;
      amount_minor: number;
      closing_balance_minor: number;
      credit_type: string | null;
      reference: string | null;
    }>;
    total: number;
  };
  ok(
    "D10: history lists 3 movements newest first with running balances",
    hist.statusCode === 200 &&
      h.total === 3 &&
      h.data[0]?.type === "decrement" &&
      h.data[0]?.closing_balance_minor === 1200 &&
      h.data[1]?.reference === "referred a friend" &&
      h.data[2]?.closing_balance_minor === 1000,
  );
  const filtered = await call("GET", `${cus}/promotional_credits?credit_type[is]=referral_rewards`);
  ok(
    "D10: history filters by credit_type",
    (filtered.json() as { data: unknown[] }).data.length === 1,
  );
  const incr = await call("GET", `${cus}/promotional_credits?type[is]=increment&limit=1`);
  const incrBody = incr.json() as { data: unknown[]; has_more: boolean };
  ok("D10: history pages and filters by type", incrBody.data.length === 1 && incrBody.has_more);
  const one = await call("GET", `${cus}/promotional_credits/${refBody.movement}`);
  ok(
    "D10: retrieve one movement",
    one.statusCode === 200 && (one.json() as { amount_minor: number }).amount_minor === 500,
  );
  ok(
    "D10: unknown movement id is 404",
    (await call("GET", `${cus}/promotional_credits/nope`)).statusCode === 404,
  );
  ok(
    "D10: balance still derived from the ledger",
    (await bucketBalancesForCurrency(orgId, c.id, "USD")).promotional === 1200n,
  );

  // record_excess_payment: transaction details reach the money log.
  const txCount = async () =>
    withTenant(orgId, async (tx) =>
      tx.select().from(transactions).where(eq(transactions.customerId, c.id)),
    );
  const ex = await call("POST", `${cus}/record_excess_payment`, {
    amount_minor: 700,
    currency: "USD",
  });
  ok(
    "D10: excess payment without transaction: old reply, no transaction row",
    ex.statusCode === 200 &&
      Object.keys(ex.json()).sort().join() === "balance_minor,currency,customer,object" &&
      (await txCount()).length === 0,
  );
  const when = "2026-01-15T10:00:00.000Z";
  const ex2 = await call("POST", `${cus}/record_excess_payment`, {
    amount_minor: 800,
    currency: "USD",
    date: when,
    method: "check",
    reference: "CHQ-1001",
  });
  const rows = await txCount();
  ok(
    "D10: excess payment with transaction records an offline payment transaction",
    ex2.statusCode === 200 &&
      (ex2.json() as { transaction: string }).transaction === rows[0]?.publicId &&
      rows.length === 1 &&
      rows[0]?.gatewayKey === "offline_check" &&
      rows[0]?.idAtGateway === "CHQ-1001" &&
      rows[0]?.occurredAt.toISOString() === when &&
      rows[0]?.amountMinor === 800n,
  );
  const future = await call("POST", `${cus}/record_excess_payment`, {
    amount_minor: 1,
    currency: "USD",
    date: "2999-01-01T00:00:00Z",
    method: "cash",
  });
  ok("D10: a future date is 400", future.statusCode === 400);

  // collect_payment invoice_allocations.
  const payer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "d10-alloc@a.com",
    autoCollection: "off",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: payer,
    token: "tok_4242",
  });
  const p40 = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: (await createProduct({ organizationId: orgId, businessId: biz.id, name: "D10a" }))
      .id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 4000,
    interval: "month",
  });
  const p60 = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: (await createProduct({ organizationId: orgId, businessId: biz.id, name: "D10b" }))
      .id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 6000,
    interval: "month",
  });
  const invA = await bill(biz.id, payer.id, p40);
  const invB = await bill(biz.id, payer.id, p60);
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: payer,
    amountMinor: 1500,
    currency: "USD",
  });
  const pcus = `/customers/${payer.publicId}`;
  const over = await call("POST", `${pcus}/collect_payment`, {
    invoice_allocations: [{ invoice_id: invA.publicId, allocation_amount: 999999 }],
  });
  ok("D10: allocation above what is due is 400", over.statusCode === 400);
  const both = await call("POST", `${pcus}/collect_payment`, {
    invoice_ids: [invA.publicId],
    invoice_allocations: [{ invoice_id: invA.publicId }],
  });
  ok("D10: invoice_ids with invoice_allocations is 400", both.statusCode === 400);
  const sumOver = await call("POST", `${pcus}/collect_payment`, {
    amount_minor: 100,
    currency: "USD",
    invoice_allocations: [{ invoice_id: invA.publicId, allocation_amount: 200 }],
  });
  ok("D10: allocations above amount_minor is 400", sumOver.statusCode === 400);
  const alloc = await call("POST", `${pcus}/collect_payment`, {
    invoice_allocations: [
      { invoice_id: invB.publicId },
      { invoice_id: invA.publicId, allocation_amount: 1000 },
    ],
  });
  const ab = alloc.json() as { applied: { excess: number }; charged: number };
  const aRow = await invRow(invA.id);
  const bRow = await invRow(invB.id);
  ok(
    "D10: allocations settle in the given order — B by credit + card, A left open",
    alloc.statusCode === 200 &&
      ab.applied.excess === 1500 &&
      ab.charged === Number(invB.amountDueMinor ?? invB.totalMinor) - 1500 &&
      bRow.status === "paid" &&
      aRow.status !== "paid",
  );

  // Caller-chosen customer id.
  const made = await call("POST", "/customers", { id: "acme-001", email: "acme@a.com" });
  ok(
    "D10: create with id uses it",
    made.statusCode === 201 && (made.json() as { id: string }).id === "acme-001",
  );
  ok(
    "D10: a taken id is 409",
    (await call("POST", "/customers", { id: "acme-001" })).statusCode === 409,
  );
  ok(
    "D10: a malformed id is 400",
    (await call("POST", "/customers", { id: "-bad id" })).statusCode === 400,
  );
  const gen = await call("POST", "/customers", { email: "gen@a.com" });
  ok("D10: no id still generates cus_…", (gen.json() as { id: string }).id.startsWith("cus_"));

  // Payment methods: retrieve, list narrowing/paging, permanent token, delete_local.
  const owner = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "pm1@a.com",
  });
  const pm1 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: owner,
    token: "tok_4242",
  });
  const pm2 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: owner,
    token: "tok_4242",
  });
  const ocus = `/customers/${owner.publicId}`;
  const full = await call("GET", `${ocus}/payment_methods`);
  ok(
    "D10: list without params keeps its shape",
    Object.keys(full.json()).sort().join() === "data,object" &&
      (full.json() as { data: unknown[] }).data.length === 2,
  );
  const pg = (await call("GET", `${ocus}/payment_methods?limit=1`)).json() as {
    data: Array<{ id: string }>;
    has_more: boolean;
    next_cursor: string;
  };
  const pg2 = (
    await call("GET", `${ocus}/payment_methods?limit=1&starting_after=${pg.next_cursor}`)
  ).json() as { data: Array<{ id: string }>; has_more: boolean };
  ok(
    "D10: list pages",
    pg.data.length === 1 &&
      pg.has_more &&
      pg2.data.length === 1 &&
      !pg2.has_more &&
      pg.data[0]!.id !== pg2.data[0]!.id,
  );
  ok(
    "D10: list filters by type",
    ((await call("GET", `${ocus}/payment_methods?type=upi`)).json() as { data: unknown[] }).data
      .length === 0,
  );
  const got = await call("GET", `${ocus}/payment_methods/${pm1.publicId}`);
  ok(
    "D10: retrieve a payment method",
    got.statusCode === 200 && (got.json() as { id: string }).id === pm1.publicId,
  );
  ok(
    "D10: retrieve another customer's pm is 404",
    (await call("GET", `${cus}/payment_methods/${pm1.publicId}`)).statusCode === 404,
  );

  const target = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "pm2@a.com",
  });
  const tcus = `/customers/${target.publicId}`;
  const noCustomer = await call("POST", `${tcus}/payment_methods/permanent_token`, {
    payment_method_token: pm1.providerPaymentMethodId,
  });
  ok("D10: permanent token with no gateway customer is 400", noCustomer.statusCode === 400);
  const unknown = await call("POST", `${tcus}/payment_methods/permanent_token`, {
    reference_id: `tmcus_${target.publicId}/tmpm_doesnotexist`,
  });
  ok("D10: permanent token the gateway does not know is 400", unknown.statusCode === 400);
  const attached = await call("POST", `${tcus}/payment_methods/permanent_token`, {
    reference_id: `tmcus_${target.publicId}/${pm1.providerPaymentMethodId}`,
    type: "card",
  });
  const att = attached.json() as {
    id: string;
    provider: string;
    reference_id: string;
    role: string;
  };
  ok(
    "D10: permanent token attaches the vaulted instrument",
    attached.statusCode === 201 &&
      att.provider === "tmtest" &&
      att.reference_id === `tmcus_${target.publicId}/${pm1.providerPaymentMethodId}` &&
      att.role === "primary",
  );
  const clash = await call("POST", `${tcus}/payment_methods/permanent_token`, {
    reference_id: `tmcus_someone_else/${pm2.providerPaymentMethodId}`,
  });
  ok("D10: a different gateway customer than the mapping is 400", clash.statusCode === 400);

  // delete_local: refused while a live subscription pays with it; removes only our row.
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: owner.id,
    now: new Date(),
    items: [{ price: p40, quantity: 1 }],
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ defaultPaymentMethodId: pm2.id })
      .where(eq(subscriptions.id, sub.subscription.id)),
  );
  ok(
    "D10: delete_local of a subscription's payment method is 409",
    (await call("POST", `${ocus}/payment_methods/${pm2.publicId}/delete_local`)).statusCode === 409,
  );
  const dl = await call("POST", `${ocus}/payment_methods/${pm1.publicId}/delete_local`);
  // The gateway's side, read as the gateway does: the vault is not tenant data.
  const vault = (await getVault(pm1.providerPaymentMethodId!)) ? [1] : [];
  const left = await listPaymentMethods(orgId, owner.id);
  ok(
    "D10: delete_local removes our row and leaves the gateway vault",
    dl.statusCode === 200 && vault.length === 1 && !left.some((p) => p.id === pm1.id),
  );

  // Permanent token on an account whose off-session debits need a mandate reference.
  const mandateAcc = await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "tmtest",
    label: "Mandate-bound",
    credentials: { per_debit_mandate_reference: "true" },
  });
  const plainAcc = await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "tmtest",
    label: "Not mandate-bound",
    credentials: {},
  });
  const t2 = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "pm3@a.com",
  });
  const t2cus = `/customers/${t2.publicId}`;
  const refused = await call("POST", `${t2cus}/payment_methods/permanent_token`, {
    reference_id: `tmcus_${t2.publicId}/${pm2.providerPaymentMethodId}`,
    gateway_account: mandateAcc.publicId,
  });
  ok(
    "D10: permanent token on an e-mandate-bound account is a clear 400",
    refused.statusCode === 400 &&
      /e-mandate reference/.test((refused.json() as { error: { message: string } }).error.message),
  );
  const usdOk = await call("POST", `${t2cus}/payment_methods/permanent_token`, {
    reference_id: `tmcus_${t2.publicId}/${pm2.providerPaymentMethodId}`,
    gateway_account: plainAcc.publicId,
  });
  ok(
    "D10: the same token on an account that is not mandate-bound attaches",
    usdOk.statusCode === 201,
  );
  await app.close();
}

let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ CUSTOMERS: PASS" : "❌ CUSTOMERS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
