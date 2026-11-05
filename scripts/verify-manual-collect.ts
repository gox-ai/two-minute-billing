/**
 * Operator-initiated collection — over HTTP, against the tmtest gateway.
 *
 *   §1 `POST /customers/:cus/collect_payment` whose card charge FAILS is a manual
 *      attempt: the invoice's `attempt_count` and `next_attempt_at` stay where the clock
 *      put them. The control (an automatic collect on the same invoice) proves the
 *      observable moves when it should.
 *   §2 `POST /invoices/:inv/collect` with `payment_method_id` charges exactly that card,
 *      never a backup; without it, primary then backup as before.
 *   §3 collect_payment charges the invoice subscription's default card before the
 *      customer's primary.
 *   §4 A payment_method_id that is not the customer's (foreign or unknown) is a 400 on
 *      both routes, and nothing is charged or booked.
 *
 *   pnpm verify:manual-collect   (scratch DB: pnpm verify:all:fresh -- --suite manual-collect)
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod, assignPaymentMethodRole } from "@/modules/payment-methods/service";
import { createManualInvoice } from "@/modules/invoicing/ops";
import { billSubscriptionPeriod, collectInvoice } from "@/modules/invoicing/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { invoices, payments } from "@db/schema";

const checks: Array<[string, boolean, string]> = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

const org = await createOrganization({ name: "Manual Collect Org" });
const orgId = org.organization.id;
const app = await buildApp({ logger: false });
const { secret } = await createApiKey(orgId, "test");
const biz = await createBusiness({
  organizationId: orgId,
  name: "Manual Collect",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };

const GOOD = "tok_4242";
const DECLINE = "tok_4000000000009995"; // retriable decline

let keyN = 0;
const post = (url: string, body: unknown = {}) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "idempotency-key": `manual-collect-${keyN++}`,
    },
    payload: JSON.stringify(body),
  });

const invRow = (id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1))[0]!,
  );
const paysOn = (invoiceId: string) =>
  withTenant(orgId, (tx) => tx.select().from(payments).where(eq(payments.invoiceId, invoiceId)));
const openInvoice = async (customerId: string, amt: number) =>
  (
    await createManualInvoice({
      ...ctx,
      customerId,
      currency: "USD",
      lines: [{ description: "Service", amountMinor: BigInt(amt), kind: "one_time" }],
    })
  ).invoice;

// ── §1 collect_payment's failed charge does not spend a scheduled retry ──────────
// A subscription invoice, because one-time invoices are outside dunning by default.
const product = await createProduct({ ...ctx, name: "Plan" });
const price = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 4000,
  interval: "month",
});
async function subInvoice(customerId: string, defaultPaymentMethodId?: string) {
  const sub = await createSubscription({
    ...ctx,
    customerId,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    ...(defaultPaymentMethodId ? { defaultPaymentMethodId } : {}),
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  return invoice;
}
{
  const c = await createCustomer({ ...ctx, email: "m1@example.com", currency: "USD" });
  await vaultPaymentMethod({ ...ctx, customer: c, token: DECLINE });
  // Billing auto-collects: the clock's first attempt, counted, arms the schedule.
  const inv = await subInvoice(c.id);
  const armed = await invRow(inv.id);
  ok(
    "1A: automatic failure counts and arms a retry",
    armed.attemptCount === 1 &&
      armed.nextAttemptAt != null &&
      armed.dunningStatus === "in_progress",
    `attempt_count=${armed.attemptCount} next=${armed.nextAttemptAt?.toISOString()} dunning=${armed.dunningStatus}`,
  );

  const res = await post(`/v1/businesses/${biz.publicId}/customers/${c.publicId}/collect_payment`);
  const body = res.json() as { charged?: number };
  const after = await invRow(inv.id);
  const failedN = (await paysOn(inv.id)).filter((p) => p.status === "failed").length;
  ok(
    "1B: collect_payment charged the card and it failed",
    res.statusCode === 200 && body.charged === 0 && failedN === 2,
    `${res.statusCode} charged=${body.charged} failed=${failedN}`,
  );
  ok(
    "1C: …without advancing attempt_count",
    after.attemptCount === 1,
    `attempt_count=${after.attemptCount}`,
  );
  ok(
    "1D: …or moving the scheduled retry",
    after.nextAttemptAt?.getTime() === armed.nextAttemptAt?.getTime() &&
      after.dunningStatus === "in_progress",
    `next ${armed.nextAttemptAt?.toISOString()} → ${after.nextAttemptAt?.toISOString()} dunning=${after.dunningStatus}`,
  );

  // Control: the same failure through the automatic path does count.
  await collectInvoice({ ...ctx, invoice: after });
  const counted = await invRow(inv.id);
  ok(
    "1E: control — an automatic failure on the same invoice advances it",
    counted.attemptCount === 2,
    `attempt_count=${counted.attemptCount}`,
  );
}

// ── §3 collect_payment charges the subscription's own default card first ──────────
{
  const c = await createCustomer({
    ...ctx,
    email: "m3@example.com",
    currency: "USD",
    autoCollection: "off",
  });
  const bad = await vaultPaymentMethod({ ...ctx, customer: c, token: DECLINE });
  const good = await vaultPaymentMethod({ ...ctx, customer: c, token: GOOD });
  await assignPaymentMethodRole(orgId, c.id, bad.publicId, "primary");
  const inv = await subInvoice(c.id, good.id);
  const res = await post(`/v1/businesses/${biz.publicId}/customers/${c.publicId}/collect_payment`);
  const pays = await paysOn(inv.id);
  ok(
    "3A: subscription default card charged, customer primary never tried",
    res.statusCode === 200 &&
      (await invRow(inv.id)).status === "paid" &&
      pays.length === 1 &&
      pays[0]!.paymentMethodId === good.id &&
      pays[0]!.status === "succeeded",
    `${res.statusCode} ${pays.map((p) => `${p.status}@${p.paymentMethodId === good.id ? "sub-default" : "primary"}`).join(",")}`,
  );
}

// ── §2 invoices/:inv/collect payment_method_id ──────────────────────────────────
// Primary declines, backup succeeds — so every override is distinguishable from the
// default order.
async function twoCardCustomer(email: string) {
  const c = await createCustomer({ ...ctx, email, currency: "USD" });
  const bad = await vaultPaymentMethod({ ...ctx, customer: c, token: DECLINE });
  const good = await vaultPaymentMethod({ ...ctx, customer: c, token: GOOD });
  await assignPaymentMethodRole(orgId, c.id, bad.publicId, "primary");
  await assignPaymentMethodRole(orgId, c.id, good.publicId, "backup");
  return { c, bad, good };
}
const collectUrl = (invPublicId: string) =>
  `/v1/businesses/${biz.publicId}/invoices/${invPublicId}/collect`;
const describe = (ps: Array<typeof payments.$inferSelect>) =>
  ps.map((p) => `${p.status}@${p.paymentMethodId?.slice(0, 8)}`).join(",");

{
  const { c, bad, good } = await twoCardCustomer("m2a@example.com");
  const inv = await openInvoice(c.id, 2500);
  const res = await post(collectUrl(inv.publicId));
  const pays = await paysOn(inv.id);
  ok(
    "2A: no payment_method_id → primary declines, backup settles (unchanged)",
    res.statusCode === 200 &&
      (await invRow(inv.id)).status === "paid" &&
      pays.some((p) => p.status === "failed" && p.paymentMethodId === bad.id) &&
      pays.some((p) => p.status === "succeeded" && p.paymentMethodId === good.id),
    `${res.statusCode} ${describe(pays)}`,
  );
}
{
  const { c, good } = await twoCardCustomer("m2b@example.com");
  const inv = await openInvoice(c.id, 2500);
  const res = await post(collectUrl(inv.publicId), { payment_method_id: good.publicId });
  const pays = await paysOn(inv.id);
  ok(
    "2B: payment_method_id = backup → only that card, primary never tried",
    res.statusCode === 200 &&
      (await invRow(inv.id)).status === "paid" &&
      pays.length === 1 &&
      pays[0]!.paymentMethodId === good.id &&
      pays[0]!.status === "succeeded",
    `${res.statusCode} ${describe(pays)}`,
  );
}
{
  const { c, bad } = await twoCardCustomer("m2c@example.com");
  const inv = await openInvoice(c.id, 2500);
  const res = await post(collectUrl(inv.publicId), { payment_method_id: bad.publicId });
  const pays = await paysOn(inv.id);
  const row = await invRow(inv.id);
  ok(
    "2C: payment_method_id = declining card → one failed attempt, no backup fallback",
    res.statusCode === 200 &&
      row.status !== "paid" &&
      pays.length === 1 &&
      pays[0]!.paymentMethodId === bad.id &&
      pays[0]!.status === "failed",
    `${res.statusCode} status=${row.status} ${describe(pays)}`,
  );
  ok(
    "2D: …and it is a manual attempt (attempt_count 0)",
    row.attemptCount === 0,
    `${row.attemptCount}`,
  );
}
{
  // Another customer's card must never be charged for this invoice.
  const { c } = await twoCardCustomer("m2e@example.com");
  const other = await createCustomer({ ...ctx, email: "m2e-other@example.com", currency: "USD" });
  const foreign = await vaultPaymentMethod({ ...ctx, customer: other, token: GOOD });
  const inv = await openInvoice(c.id, 2500);
  const res = await post(collectUrl(inv.publicId), { payment_method_id: foreign.publicId });
  const foreignPays = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.paymentMethodId, foreign.id)),
  );
  const invPays = await paysOn(inv.id);
  ok(
    "2E: another customer's payment_method_id → 400, nothing charged or booked",
    res.statusCode === 400 &&
      foreignPays.length === 0 &&
      invPays.length === 0 &&
      (await invRow(inv.id)).status !== "paid",
    `${res.statusCode} foreign_payments=${foreignPays.length} invoice_payments=${describe(invPays)}`,
  );
}
{
  const { c } = await twoCardCustomer("m2f@example.com");
  const inv = await openInvoice(c.id, 2500);
  const res = await post(collectUrl(inv.publicId), { payment_method_id: "pm_XXXXXXXXXXXX01" });
  const invPays = await paysOn(inv.id);
  ok(
    "2F: unknown payment_method_id → 400, no payment booked",
    res.statusCode === 400 && invPays.length === 0,
    `${res.statusCode} invoice_payments=${describe(invPays)}`,
  );
}

// ── §4 collect_payment refuses a card that is not the customer's ────────────────
{
  const { c } = await twoCardCustomer("m4@example.com");
  const other = await createCustomer({ ...ctx, email: "m4-other@example.com", currency: "USD" });
  const foreign = await vaultPaymentMethod({ ...ctx, customer: other, token: GOOD });
  const inv = await openInvoice(c.id, 2500);
  const before = await invRow(inv.id);
  const res = await post(`/v1/businesses/${biz.publicId}/customers/${c.publicId}/collect_payment`, {
    payment_method_id: foreign.publicId,
  });
  const after = await invRow(inv.id);
  const invPays = await paysOn(inv.id);
  ok(
    "4A: collect_payment with another customer's card → 400, invoice untouched",
    res.statusCode === 400 &&
      invPays.length === 0 &&
      after.status === before.status &&
      after.amountDueMinor === before.amountDueMinor,
    `${res.statusCode} status=${after.status} payments=${describe(invPays)}`,
  );
}

await app.close();
let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
console.log(
  failed === 0
    ? `\n✅ MANUAL-COLLECT: PASS (${checks.length} checks)`
    : `\n❌ MANUAL-COLLECT: FAIL — ${failed} of ${checks.length}`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
