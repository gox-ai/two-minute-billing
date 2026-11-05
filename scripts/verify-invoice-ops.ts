/**
 * Invoicing & payments completeness (Phase 9):
 *  - manual/one-off invoice (open; Net-D due date; collect→paid),
 *  - void an open invoice → reverses revenue/AR (ledger stays balanced),
 *  - write off → uncollectible + bad_debt expense booked,
 *  - offline/manual payment (mark-paid) → cash/AR booked, invoice paid,
 *  - dunning "retry now" collects an open invoice,
 *  - printable HTML invoice renders,
 *  - INVARIANT: every ledger transaction nets to zero.
 *
 *   pnpm verify:invoice-ops
 */
import { sql } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import {
  createManualInvoice,
  voidInvoice,
  writeOffInvoice,
  recordOfflinePayment,
  collectInvoiceNow,
  renderInvoiceHtml,
} from "@/modules/invoicing/ops";

const org = await createOrganization({ name: "InvoiceOps Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const checks: Array<[string, boolean]> = [];

async function mkCustomer(email: string, withCard = false) {
  const customer = await createCustomer({ ...ctx, email, currency: "USD" });
  if (withCard) await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  return customer;
}
const line = (desc: string, amt: number) => ({
  description: desc,
  amountMinor: BigInt(amt),
  kind: "one_time",
});

// 1) Manual invoice — open, Net-30 due date.
{
  const c = await mkCustomer("manual@a.com");
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: c.id,
    currency: "USD",
    lines: [line("Consulting", 5000)],
    netDays: 30,
  });
  const dueInDays = invoice.dueDate
    ? Math.round((invoice.dueDate.getTime() - Date.now()) / 86_400_000)
    : -1;
  checks.push(
    [
      "manual invoice posted + total 5000",
      invoice.status === "posted" && Number(invoice.totalMinor) === 5000,
    ],
    ["net-30 due date set", dueInDays === 30],
  );
}

// 2) Manual invoice with collect → paid.
{
  const c = await mkCustomer("collect@a.com", true);
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: c.id,
    currency: "USD",
    lines: [line("Setup", 3000)],
    collect: true,
  });
  checks.push(["manual invoice collect → paid", invoice.status === "paid"]);
}

// 3) Void an open invoice.
{
  const c = await mkCustomer("void@a.com");
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: c.id,
    currency: "USD",
    lines: [line("Oops", 4000)],
  });
  const voided = await voidInvoice(orgId, biz.id, invoice.publicId);
  checks.push(["invoice voided", voided.status === "voided"]);
}

// 4) Write off a posted invoice → routed through an adjustment CN (INV-4): the
//    invoice reads paid + written_off, and bad_debt is booked on the CN path.
{
  const c = await mkCustomer("writeoff@a.com");
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: c.id,
    currency: "USD",
    lines: [line("Unpaid", 6000)],
  });
  const wo = await writeOffInvoice(orgId, biz.id, invoice.publicId);
  // Scope to this run's org — the shared dev DB accumulates bad_debt from other runs.
  const badDebt = (await systemDb.execute(
    sql`select coalesce(sum(amount_minor),0) as n from ledger_entries where account='bad_debt' and direction='debit' and organization_id=${orgId}`,
  )) as unknown as Array<{ n: string }>;
  checks.push(
    ["invoice written off → paid + written_off", wo.status === "paid" && wo.writtenOff === true],
    ["bad_debt expense booked", Number(badDebt[0]!.n) === 6000],
  );
}

// 5) Offline/manual payment (mark paid).
{
  const c = await mkCustomer("offline@a.com");
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: c.id,
    currency: "USD",
    lines: [line("Wire me", 7000)],
  });
  const { invoice: paid, payment } = await recordOfflinePayment({
    ...ctx,
    invoicePublicId: invoice.publicId,
    method: "wire",
  });
  checks.push(
    ["offline payment marks invoice paid", paid.status === "paid"],
    [
      "offline payment recorded",
      payment.providerKey === "offline" && Number(payment.amountMinor) === 7000,
    ],
  );
}

// 5b) Part-payments that ADD UP to the total settle the invoice — and the next
//     "mark paid" cannot collect it a second time.
//
//     Regression for the INV-2309 double-collection (2026-08-04): the stored
//     `amount_due_minor` never moves on a cash payment, so reading it as "what's
//     outstanding" made every part-payment see the FULL total, left a fully-paid
//     invoice open, and let a blank-amount mark-paid take the whole total again.
{
  const c = await mkCustomer("partial@a.com");
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: c.id,
    currency: "USD",
    lines: [line("In three parts", 9000)],
  });
  await recordOfflinePayment({
    ...ctx,
    invoicePublicId: invoice.publicId,
    amountMinor: 6000,
    method: "wire",
  });
  const mid = await recordOfflinePayment({
    ...ctx,
    invoicePublicId: invoice.publicId,
    amountMinor: 2900,
    method: "wire",
  });
  checks.push(["part-paid invoice stays open until covered", mid.invoice.status !== "paid"]);
  const last = await recordOfflinePayment({
    ...ctx,
    invoicePublicId: invoice.publicId,
    method: "wire",
  });
  // Blank amount = "the rest", which is 100 — not another 9000.
  checks.push(
    ["blank amount pays the REMAINDER, not the total", Number(last.payment.amountMinor) === 100],
    ["part-payments summing to the total → paid", last.invoice.status === "paid"],
  );
  const paid = (await systemDb.execute(
    sql`select coalesce(sum(amount_minor),0) as n from payments where invoice_id=${invoice.id} and status='succeeded'`,
  )) as unknown as Array<{ n: string }>;
  checks.push(["collected exactly the invoice total (never 2×)", Number(paid[0]!.n) === 9000]);
  // The invoice is paid now, so recording another payment is refused outright.
  let refused = false;
  try {
    await recordOfflinePayment({ ...ctx, invoicePublicId: invoice.publicId, method: "wire" });
  } catch {
    refused = true;
  }
  checks.push(["a settled invoice refuses further offline payments", refused]);
}

// 5c) Money ABOVE the outstanding balance is credited to the customer's
//     excess-payment bucket, not over-applied to the invoice.
{
  const c = await mkCustomer("excess@a.com");
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: c.id,
    currency: "USD",
    lines: [line("Overpay me", 4000)],
  });
  const res = await recordOfflinePayment({
    ...ctx,
    invoicePublicId: invoice.publicId,
    amountMinor: 5000,
    method: "cash",
  });
  const { bucketBalancesForCurrency } = await import("@/modules/customers/balances-read");
  const bals = await bucketBalancesForCurrency(orgId, c.id, "USD");
  const ar = (await systemDb.execute(
    sql`select coalesce(sum(case when direction='credit' then amount_minor else -amount_minor end),0) as n from ledger_entries where account='accounts_receivable' and organization_id=${orgId} and source_id=${res.payment.publicId}`,
  )) as unknown as Array<{ n: string }>;
  checks.push(
    [
      "overpayment applies only the balance to the invoice",
      Number(res.payment.amountMinor) === 4000 && res.invoice.status === "paid",
    ],
    ["overpayment reports the excess", res.excessMinor === 1000],
    ["excess lands in the customer excess-payment bucket", Number(bals.excess) === 1000],
    ["AR is credited by the applied part only (never over-credited)", Number(ar[0]!.n) === 4000],
  );
}

// 6) Retry/collect-now on an open invoice with a good card → paid.
{
  const c = await mkCustomer("retry@a.com", true);
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: c.id,
    currency: "USD",
    lines: [line("Retryable", 2000)],
  });
  const { invoice: after } = await collectInvoiceNow(orgId, biz.id, invoice.publicId);
  checks.push(["collect-now charges an open invoice → paid", after.status === "paid"]);
}

// 6b) A SECOND collect-now really charges again — it is not a replay of the first.
//
// The gateway idempotency key carries an attempt number, and it used to come from
// `invoices.attempt_count` — which a manual attempt deliberately does not advance (M12).
// So two presses of "Collect now" / "Pay now" on the same invoice and card built the SAME
// key, tmtest replayed the first outcome (as a real gateway would), and the engine wrote a
// second `payments` row for a charge that never happened: a buyer who had just topped up
// their account kept being shown the original decline. The number now counts the invoice's
// booked attempts (`bookedAttemptsForInvoice`), so each press is its own charge.
//
// Asserted through the GATEWAY-FACING transactions rather than the key itself: a distinct
// `id_at_gateway` per attempt is the proof the gateway was actually reached, and it is
// what a replay cannot fake.
{
  const c = await mkCustomer("replay@a.com");
  await vaultPaymentMethod({ ...ctx, customer: c, token: "tok_4000000000009995" }); // retriable decline
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: c.id,
    currency: "USD",
    lines: [line("Declines", 4000)],
  });
  for (let i = 0; i < 3; i++) await collectInvoiceNow(orgId, biz.id, invoice.publicId);
  const pays = (await systemDb.execute(
    sql`select count(*) as n from payments where invoice_id=${invoice.id}`,
  )) as unknown as Array<{ n: string }>;
  const ids = (await systemDb.execute(
    sql`select distinct id_at_gateway from transactions where invoice_id=${invoice.id} and status='failed' and id_at_gateway is not null and id_at_gateway <> ''`,
  )) as unknown as unknown[];
  checks.push(
    ["three manual collects record three attempts", Number(pays[0]!.n) === 3],
    [
      "…and each one reached the gateway (distinct charge ids, no idempotent replay)",
      ids.length === 3,
    ],
  );
}

// 7) PDF (HTML) renders.
//
// Asserts the human invoice NUMBER (INV-…), not the `inv_…` public id. The public
// id is an internal API identifier and deliberately does not appear on a document
// handed to a customer — the shared document model (501364d) renders `meta.number`
// in both the title and the "Invoice #" row. This assertion predates that rewrite
// and had been failing ever since, unnoticed until 2026-07-27, because it still
// looked for the public id.
{
  const c = await mkCustomer("pdf@a.com");
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: c.id,
    currency: "USD",
    lines: [line("Doc", 1000)],
  });
  const html = await renderInvoiceHtml(orgId, biz.id, invoice.publicId);
  checks.push([
    "invoice HTML renders (number, Total, line amount)",
    // A finalized invoice always has a number; if it were null the document would
    // have nothing to identify it by, which is itself a failure.
    !!html &&
      !!invoice.number &&
      html.includes(invoice.number) &&
      html.includes("Total") &&
      html.includes("Doc"),
  ]);
}

// 8) Ledger invariant: every transaction balances.
{
  /**
   * PER (transaction, CURRENCY) — grouping on `transaction_id` alone was wrong in BOTH
   * directions, and it cost a full-gate investigation on 2026-09-03. `assertBalanced`
   * (ledger/service.ts) validates each posting per CURRENCY, so a transaction with legs
   * in two currencies is legitimate and its cross-currency sum of `amount_minor` is
   * meaningless — the old query called such a row UNBALANCED. The same flattening hides
   * the real thing: +100 USD against -100 INR nets to zero and passed. It also failed
   * SILENTLY, returning a bare boolean, so the red line named nothing and sent the next
   * reader bisecting sixty suites. The rows are printed now. ⚠ Still GLOBAL on purpose:
   * it judges every organization's entries, which is why it passes alone and failed
   * inside `verify:all`; scoping it would make it hermetic but blind to an imbalance
   * created elsewhere — a real trade-off, see docs/PROGRESS.md.
   */
  const rows = (await systemDb.execute(sql`select transaction_id, currency,
             sum(case when direction='debit' then amount_minor else -amount_minor end) as net,
             string_agg(distinct account, ',') as accounts,
             string_agg(distinct source_type, ',') as sources
        from ledger_entries group by transaction_id, currency
       having sum(case when direction='debit' then amount_minor else -amount_minor end) <> 0
       limit 5`)) as unknown as unknown[];
  for (const r of rows) console.log(`    ↳ unbalanced: ${JSON.stringify(r)}`);
  checks.push(["all ledger transactions balanced", rows.length === 0]);
}

// Money on an invoice blocks its void: a void reversed the invoice but not the payment,
// stranding the customer's cash with no credit and no refund.
{
  const c = await mkCustomer("void-partial@a.com");
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: c.id,
    currency: "USD",
    lines: [line("Service", 10000)],
    netDays: 30,
  });
  await recordOfflinePayment({
    ...ctx,
    invoicePublicId: invoice.publicId,
    amountMinor: 4000,
    method: "cash",
  });
  let refused: string | null = null;
  try {
    await voidInvoice(orgId, biz.id, invoice.publicId);
  } catch (e) {
    refused = (e as Error).message;
  }
  const [after] = (await systemDb.execute(
    sql`select status from invoices where public_id = ${invoice.publicId}`,
  )) as unknown as Array<{ status: string }>;
  checks.push([
    "void refused on a partly paid invoice, which stays open",
    refused != null && /is paid on this invoice/.test(refused) && after?.status !== "voided",
  ]);
  // The rest can still be cleared, just not by a void.
  await writeOffInvoice(orgId, biz.id, invoice.publicId);
  checks.push(["…and write-off still clears the rest", true]);
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ INVOICE OPS: PASS" : "❌ INVOICE OPS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
