/**
 * In-term reactivation: a subscription dunning cancelled, reactivated before its term ends,
 * continues that term with no new invoice; anything else still opens a fresh billed term.
 *
 *   pnpm verify:reactivation-in-term
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod, setDefaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  recomputeSubscriptionMrr,
  subscriptionDues,
} from "@/modules/subscriptions/service";
import { recordOfflinePayment } from "@/modules/invoicing/ops";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { sendAdhocEmail } from "@/modules/emails/adhoc-service";
import { reactivateAndBill } from "@/modules/subscriptions/reactivate";
import { estimateReactivate } from "@/modules/subscriptions/estimate";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { invoices, subscriptions } from "@db/schema";
import { asTeamMembers } from "./lib/team-addresses";

const org = await createOrganization({ name: "In-term Reactivation Org" });
const orgId = org.organization.id;
await asTeamMembers(orgId, "partpaid@example.com"); // test mode emails only team members
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const product = await createProduct({ ...ctx, name: "Pro", kind: "plan" });
const price = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
});

const checks: Array<[string, boolean]> = [];
type SubRow = typeof subscriptions.$inferSelect;

const load = (id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!,
  );
const invoicesOf = (id: string) =>
  withTenant(orgId, (tx) => tx.select().from(invoices).where(eq(invoices.subscriptionId, id)));

/** A subscription with its first term billed and left unpaid, then cancelled as dunning does. */
async function dunningCancelled(opts: {
  email: string;
  autoCollection: "on" | "off";
  card?: string;
  reason?: string | null;
}): Promise<SubRow> {
  const customer = await createCustomer({ ...ctx, email: opts.email });
  if (opts.card) await vaultPaymentMethod({ ...ctx, customer, token: opts.card });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    autoCollection: opts.autoCollection,
  });
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  // The write `dunning.ts` makes when it gives up.
  await withTenant(orgId, async (tx) => {
    await tx
      .update(subscriptions)
      .set({
        status: "cancelled",
        canceledAt: new Date(),
        cancelReason: opts.reason === undefined ? "not_paid" : opts.reason,
      })
      .where(eq(subscriptions.id, subscription.id));
    await recomputeSubscriptionMrr(tx, subscription.id, new Date());
  });
  return load(subscription.id);
}

const reactivate = (
  sub: SubRow,
  now = new Date(),
  items?: Array<{ price: string; quantity?: number }>,
  term: "auto" | "continue" | "new" = "auto",
) =>
  reactivateAndBill({
    ...ctx,
    business: biz,
    subscription: sub,
    now,
    term,
    withOptions: !!items,
    items,
  });

const estimate = (sub: SubRow, quantity = 1, term?: "continue" | "new") =>
  estimateReactivate({
    ...ctx,
    subscriptionId: sub.id,
    items: [{ price: price.publicId, quantity }],
    now: new Date(),
    ...(term ? { term } : {}),
  });
const refuses = (p: Promise<unknown>) =>
  p.then(
    () => false,
    () => true,
  );

// 1) Auto-collection off: continues the term, raises nothing, leaves the invoice open.
{
  const sub = await dunningCancelled({ email: "off@example.com", autoCollection: "off" });
  const [termInvoice] = await invoicesOf(sub.id);
  const est = await estimate(sub);
  const changed = await estimate(sub, 2);
  const res = await reactivate(sub, new Date(), [{ price: price.publicId, quantity: 1 }]);
  const after = await load(sub.id);
  const invs = await invoicesOf(sub.id);
  checks.push(
    [
      "estimate: in-term with the term's invoice",
      est.in_term_reactivation?.invoice.id === termInvoice!.publicId,
    ],
    [
      "estimate: nothing due now",
      est.amount_due_minor === 0 && est.in_term_reactivation?.collects_now === false,
    ],
    [
      "estimate: outstanding is the open balance",
      est.in_term_reactivation?.invoice.outstanding_minor === 10000,
    ],
    // A flat price: quantity 2 still costs one term, billed fresh.
    [
      "estimate: a changed line set opens a fresh term",
      !changed.in_term_reactivation && changed.amount_due_minor === 10000,
    ],
    ["reactivated → active", after.status === "active" && !res.refused],
    ["no invoice raised", !res.invoice && invs.length === 1 && !!res.inTerm],
    [
      "term kept",
      after.currentPeriodStart!.getTime() === sub.currentPeriodStart!.getTime() &&
        after.currentPeriodEnd!.getTime() === sub.currentPeriodEnd!.getTime(),
    ],
    [
      "start_date kept (first-period heal stays off)",
      after.startDate?.getTime() === sub.startDate?.getTime(),
    ],
    ["cancel fields cleared", after.canceledAt === null && after.cancelReason === null],
    ["term invoice untouched", invs[0]!.status === termInvoice!.status],
    ["MRR restored", (after.mrr ?? 0n) > 0n],
  );
}

// 2) Not dunning: a voluntary cancellation opens a fresh billed term.
{
  const sub = await dunningCancelled({
    email: "vol@example.com",
    autoCollection: "off",
    reason: null,
  });
  const est = await estimate(sub);
  const estContinue = await refuses(estimate(sub, 1, "continue"));
  const resContinue = await refuses(reactivate(sub, new Date(), undefined, "continue"));
  const res = await reactivate(sub);
  checks.push(
    ["voluntary cancel: estimate is a fresh term", !est.in_term_reactivation],
    ["voluntary cancel: in_term_available false", est.in_term_available === false],
    ["voluntary cancel: term=continue refused (estimate + booking)", estContinue && resContinue],
    ["voluntary cancel: fresh term invoiced", !!res.invoice && !res.inTerm],
  );
}

// 2b) Eligible, but term=new: the operator asked for a fresh billed term.
{
  const sub = await dunningCancelled({ email: "new@example.com", autoCollection: "off" });
  const est = await estimate(sub, 1, "new");
  const res = await reactivate(sub, new Date(), undefined, "new");
  const invs = await invoicesOf(sub.id);
  checks.push(
    [
      "term=new: estimate is a fresh term, choice still offered",
      !est.in_term_reactivation && est.in_term_available === true && est.amount_due_minor === 10000,
    ],
    ["term=new: fresh term invoiced", !!res.invoice && !res.inTerm && invs.length === 2],
  );
}

// 3) Voided term invoice: not eligible.
{
  const sub = await dunningCancelled({ email: "void@example.com", autoCollection: "off" });
  await withTenant(orgId, (tx) =>
    tx.update(invoices).set({ status: "voided" }).where(eq(invoices.subscriptionId, sub.id)),
  );
  const res = await reactivate(sub);
  checks.push(["voided term invoice: fresh term invoiced", !!res.invoice && !res.inTerm]);
}

// 4) Term already over: a fresh term.
{
  const sub = await dunningCancelled({ email: "late@example.com", autoCollection: "off" });
  const res = await reactivate(sub, new Date(sub.currentPeriodEnd!.getTime() + 86_400_000));
  checks.push(["term ended: fresh term invoiced", !!res.invoice && !res.inTerm]);
}

// 5) Charge required (the default) + auto-collection on: the term's invoice is collected
//    first. A decline refuses and changes nothing; a good card reactivates with no new invoice.
{
  const sub = await dunningCancelled({
    email: "on@example.com",
    autoCollection: "on",
    card: "4000000000009995",
  });
  const est = await estimate(sub);
  const declined = await reactivate(sub);
  const stillCancelled = await load(sub.id);
  const good = await vaultPaymentMethod({
    ...ctx,
    customer: await withTenant(orgId, async (tx) => {
      const { customers } = await import("@db/schema");
      return (await tx.select().from(customers).where(eq(customers.id, sub.customerId)))[0]!;
    }),
    token: "tok_4242",
  });
  await setDefaultPaymentMethod(orgId, sub.customerId, good.publicId);
  const ok = await reactivate(stillCancelled);
  const after = await load(sub.id);
  const invs = await invoicesOf(sub.id);
  const paid = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.subscriptionId, sub.id), eq(invoices.status, "paid"))),
  );
  checks.push(
    [
      "charge required: estimate collects the open balance",
      est.in_term_reactivation?.collects_now === true && est.amount_due_minor === 10000,
    ],
    ["decline refuses", !!declined.refused && stillCancelled.status === "cancelled"],
    [
      "good card: reactivated in term",
      ok.subscription.status === "active" && !!ok.inTerm && !ok.invoice,
    ],
    ["good card: term invoice paid, none raised", invs.length === 1 && paid.length === 1],
    ["good card: term kept", after.currentPeriodEnd!.getTime() === sub.currentPeriodEnd!.getTime()],
  );
}

// 6) A caller that does not opt in (the reactivating checkout) still opens a fresh term.
{
  const sub = await dunningCancelled({ email: "checkout@example.com", autoCollection: "off" });
  const res = await reactivateAndBill({
    ...ctx,
    business: biz,
    subscription: sub,
    now: new Date(),
    withOptions: false,
  });
  checks.push(["no opt-in: fresh term invoiced", !!res.invoice && !res.inTerm]);
}

// 7) The prod shape: a part-paid term invoice. Dues net the cash payment out, everywhere.
{
  const sub = await dunningCancelled({ email: "partpaid@example.com", autoCollection: "off" });
  const [termInvoice] = await invoicesOf(sub.id);
  await recordOfflinePayment({
    ...ctx,
    invoicePublicId: termInvoice!.publicId,
    amountMinor: 9000,
  });
  const dues = await subscriptionDues(orgId, sub.id);
  const outbox: OutboundEmail[] = [];
  setMailer({
    kind: "console",
    target: null,
    async send(msg) {
      outbox.push(msg);
      return { providerMessageId: "fake-1", status: "sent" };
    },
  });
  await sendAdhocEmail(orgId, biz.id, {
    type: "payment_request",
    invoiceId: termInvoice!.publicId,
  });
  const payReq = outbox.find((m) => m.subject.startsWith("Payment request"));
  const est = await estimate(sub);
  const res = await reactivate(sub);
  checks.push(
    [
      "part-paid: subscription dues net the payment",
      dues.total_dues_minor === 1000 && dues.due_invoices_count === 1,
    ],
    [
      "part-paid: a payment request asks for what is left",
      !!payReq && payReq.text.includes("$10.00") && !payReq.text.includes("$100.00"),
    ],
    [
      "part-paid: estimate names the remaining balance",
      est.in_term_reactivation?.invoice.outstanding_minor === 1000,
    ],
    [
      "part-paid: reactivated in term, nothing raised",
      !!res.inTerm && !res.invoice && res.inTerm.outstandingMinor === 1000n,
    ],
  );
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ REACTIVATION IN TERM: PASS" : "❌ REACTIVATION IN TERM: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
