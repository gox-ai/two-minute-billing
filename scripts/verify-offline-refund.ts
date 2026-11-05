/**
 * Credit-note OFFLINE refunds + the refunds/allocations timeline (the "Record an
 * offline refund" action + the CN detail timeline).
 *  - refundable CN on a paid invoice → recordOfflineCnRefund partial (check, ref)
 *    → refunded & paid_out advance together, cash decreases, no refunds_payable
 *    residue, transaction stamped offline_check with credit_note_id.
 *  - remaining amount offline-refunded → status flips to `refunded`.
 *  - gateway refundCreditNote on a second CN → its payout transaction is also
 *    stamped with credit_note_id (timeline linkage).
 *  - getCreditNoteDetail returns allocations + refunds arrays.
 *
 *   pnpm verify:offline-refund
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  issueRefundableCreditNote,
  refundCreditNote,
  recordOfflineCnRefund,
  getCreditNoteDetail,
  CreditNoteError,
} from "@/modules/credit-notes/service";
import { ledgerEntries, transactions, creditNotes } from "@db/schema";

const org = await createOrganization({ name: "Offline CN Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
});

async function paidInvoice(email: string) {
  const c = await createCustomer({ organizationId: orgId, businessId: biz.id, email });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  return { customer: c, invoice };
}

const acct = (account: string) =>
  withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.account, account));
    return rows.reduce(
      (s, r) => s + (r.direction === "debit" ? r.amountMinor : -r.amountMinor),
      0n,
    );
  });

const checks: Array<[string, boolean]> = [];

// ── 1) Offline refund: partial then remainder ────────────────────────────────
{
  const { invoice } = await paidInvoice("offline-cn@a.com");
  const cn = await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: invoice.publicId,
    items: [{ description: "goodwill", amountMinor: 4000 }],
  });
  const cashBefore = await acct("cash");

  const after1 = await recordOfflineCnRefund({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: cn.publicId,
    amountMinor: 1500,
    method: "check",
    reference: "CHK-889",
    occurredAt: new Date("2026-07-01T10:00:00Z"),
  });
  checks.push(["partial: refunded=1500", after1.refundedMinor === 1500n]);
  checks.push(["partial: paid_out=1500", after1.paidOutMinor === 1500n]);
  checks.push([
    "partial: status stays refund_due-ish (not refunded)",
    after1.status !== "refunded",
  ]);
  const cashAfter1 = await acct("cash");
  checks.push(["partial: cash decreased by 1500", cashBefore - cashAfter1 === 1500n]);
  const payable = await acct("refunds_payable");
  checks.push(["partial: no refunds_payable residue", payable === 0n]);

  const after2 = await recordOfflineCnRefund({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: cn.publicId,
    method: "cash",
  });
  checks.push(["full: refunded=4000", after2.refundedMinor === 4000n]);
  checks.push(["full: status refunded", after2.status === "refunded"]);

  // Over-refund guard.
  let capped = false;
  try {
    await recordOfflineCnRefund({
      organizationId: orgId,
      businessId: biz.id,
      creditNotePublicId: cn.publicId,
      amountMinor: 1,
      method: "cash",
    });
  } catch (e) {
    capped = e instanceof CreditNoteError;
  }
  checks.push(["over-refund rejected", capped]);

  // Timeline: detail returns two offline refund transactions with method/ref.
  const detail = await getCreditNoteDetail(orgId, biz.id, cn.publicId);
  const txns = detail?.refundTxns ?? [];
  checks.push(["detail: 2 refund txns", txns.length === 2]);
  checks.push([
    "detail: offline_check with ref",
    txns.some((t) => t.gatewayKey === "offline_check" && t.idAtGateway === "CHK-889"),
  ]);
  checks.push(["detail: offline_cash", txns.some((t) => t.gatewayKey === "offline_cash")]);
  checks.push([
    "detail: occurred_at honored",
    txns.some((t) => t.occurredAt.toISOString() === "2026-07-01T10:00:00.000Z"),
  ]);
}

// ── 2) Gateway refund payout is stamped with credit_note_id ─────────────────
{
  const { invoice } = await paidInvoice("gateway-cn@a.com");
  const cn = await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: invoice.publicId,
    items: [{ description: "x", amountMinor: 2500 }],
  });
  await refundCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: cn.publicId,
  });
  const stamped = await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(creditNotes)
      .where(eq(creditNotes.publicId, cn.publicId))
      .limit(1);
    const txns = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.creditNoteId, row!.id), eq(transactions.type, "refund")));
    return txns;
  });
  checks.push([
    "gateway payout txn stamped with credit_note_id",
    stamped.length === 1 && stamped[0]!.status === "succeeded" && stamped[0]!.amountMinor === 2500n,
  ]);
  const detail = await getCreditNoteDetail(orgId, biz.id, cn.publicId);
  checks.push([
    "detail: gateway refund in timeline (not offline)",
    (detail?.refundTxns ?? []).some((t) => !(t.gatewayKey ?? "").startsWith("offline_")),
  ]);
}

console.log("");
let pass = true;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) pass = false;
}
console.log(pass ? "\nPASS" : "\nFAIL");
await closeDb();
process.exit(pass ? 0 : 1);
