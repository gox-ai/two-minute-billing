/**
 * Optional parameters on the invoice / credit-note / payment-intent routes, over HTTP:
 * each one reaches real behaviour, and leaving it out keeps the old answer.
 *
 *   §1 pay: `date` backdates payment, transaction, ledger and `paid_at`; `reference`; `comment`
 *   §2 void: `void_reason_code` + `comment`; write_off / stop_dunning `comment`
 *   §3 pause_dunning → resume_dunning restores the schedule
 *   §4 collect: `payment_method_id` charges that method; foreign / conflicting ones refused
 *   §5 apply_credits: `credit_notes[]` draws the named note, not the oldest
 *   §6 retrieve `line_items_limit`/`_offset`; pdf `disposition_type`
 *   §7 create invoice: `po_number`, `payment_method`
 *   §8 credit note: `customer_notes`, item `period_start`/`period_end`
 *   §9 payment intent: `gateway_account` is validated, not ignored
 *
 *   pnpm verify:invoice-api-params
 */
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import {
  createOrganization,
  createBusiness,
  createApiKey,
  updateBusiness,
} from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createInvoiceFromLines } from "@/modules/invoicing/service";
import { recordOfflinePayment } from "@/modules/invoicing/ops";
import { issueRefundableCreditNote } from "@/modules/credit-notes/service";
import {
  comments,
  creditNoteAllocations,
  creditNotes,
  invoices,
  ledgerEntries,
  payments,
  transactions,
} from "@db/schema";

const checks: Array<[string, boolean, string]> = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

const org = await createOrganization({ name: "Invoice API Params Org" });
const orgId = org.organization.id;
const app = await buildApp({ logger: false });
const { secret } = await createApiKey(orgId, "test");
const biz = await createBusiness({
  organizationId: orgId,
  name: "Params Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const base = `/v1/businesses/${biz.publicId}`;

let keyN = 0;
async function call(method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url: `${base}${url}`,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(method === "POST"
        ? { "content-type": "application/json", "idempotency-key": `params-${keyN++}` }
        : {}),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.payload) as Record<string, unknown>;
  } catch {
    /* binary */
  }
  return { status: res.statusCode, body, headers: res.headers };
}

let custN = 0;
const mkCustomer = () =>
  createCustomer({ ...ctx, email: `params-${custN++}@example.com`, currency: "USD" });
const mkInvoice = async (customerId: string, amounts: number[] = [5000]) =>
  (
    await createInvoiceFromLines({
      ...ctx,
      customerId,
      currency: "USD",
      lines: amounts.map((a, i) => ({ description: `Line ${i + 1}`, amountMinor: BigInt(a) })),
    })
  ).invoice;
const invoiceComments = (invPid: string) =>
  withTenant(orgId, (tx) =>
    tx
      .select({ body: comments.body })
      .from(comments)
      .where(and(eq(comments.resourceType, "invoice"), eq(comments.resourceId, invPid))),
  );
const invRow = (pid: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.publicId, pid)).limit(1))[0]!,
  );
const DAY = 86_400_000;

// §1 record payment
{
  const c = await mkCustomer();
  const inv = await mkInvoice(c.id);
  // The invoice was raised ten days ago, so a payment five days ago is legitimate.
  const raised = new Date(Date.now() - 10 * DAY);
  await withTenant(orgId, (tx) =>
    tx.update(invoices).set({ createdAt: raised }).where(eq(invoices.id, inv.id)),
  );
  const future = await call("POST", `/invoices/${inv.publicId}/pay`, {
    date: new Date(Date.now() + DAY).toISOString(),
  });
  ok("1A: a future payment date is refused", future.status === 400, JSON.stringify(future.body));
  const early = await call("POST", `/invoices/${inv.publicId}/pay`, {
    date: new Date(raised.getTime() - DAY).toISOString(),
  });
  ok("1B: a date before the invoice is refused", early.status === 400);
  const alias = await call("POST", `/invoices/${inv.publicId}/pay`, { id_at_gateway: "B" });
  ok(
    "1C: id_at_gateway is not a pay param (reference is)",
    alias.status === 400 && /Unknown parameter: id_at_gateway/.test(JSON.stringify(alias.body)),
    JSON.stringify(alias.body),
  );

  const paidOn = new Date(Date.now() - 5 * DAY);
  paidOn.setMilliseconds(0);
  const res = await call("POST", `/invoices/${inv.publicId}/pay`, {
    method: "cheque",
    date: paidOn.toISOString(),
    reference: "CHQ-000123",
    comment: "Cheque received at the front desk",
  });
  const payPid = (res.body.payment as { id?: string } | undefined)?.id ?? "";
  const [pay] = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.publicId, payPid)),
  );
  const [txn] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(transactions)
      .where(eq(transactions.paymentId, pay?.id ?? "")),
  );
  const ledger = await withTenant(orgId, (tx) =>
    tx.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, payPid)),
  );
  const after = await invRow(inv.publicId);
  ok("1D: backdated payment settles the invoice", res.status === 200 && after.status === "paid");
  ok("1E: payment row carries the date", pay?.createdAt.getTime() === paidOn.getTime());
  ok(
    "1F: transaction carries the date and the reference",
    txn?.occurredAt.getTime() === paidOn.getTime() && txn?.idAtGateway === "CHQ-000123",
  );
  ok(
    "1G: ledger postings carry the date",
    ledger.length > 0 && ledger.every((l) => l.createdAt.getTime() === paidOn.getTime()),
  );
  ok("1H: invoice paid_at is the payment date", after.paidAt?.getTime() === paidOn.getTime());
  ok(
    "1I: the comment is on the invoice",
    (await invoiceComments(inv.publicId)).some(
      (r) => r.body === "Cheque received at the front desk",
    ),
  );

  // Absent = now, no reference, no comment.
  const inv2 = await mkInvoice(c.id);
  const before = Date.now();
  const plain = await call("POST", `/invoices/${inv2.publicId}/pay`, {});
  const after2 = await invRow(inv2.publicId);
  const [txn2] = await withTenant(orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.invoiceId, inv2.id)),
  );
  ok(
    "1J: no date → paid now, no reference, no comment",
    plain.status === 200 &&
      (after2.paidAt?.getTime() ?? 0) >= before - 1000 &&
      txn2?.idAtGateway == null &&
      (await invoiceComments(inv2.publicId)).length === 0,
  );
}

// §2 void / write_off / stop_dunning
{
  const c = await mkCustomer();
  const inv = await mkInvoice(c.id);
  const res = await call("POST", `/invoices/${inv.publicId}/void`, {
    void_reason_code: "duplicate_invoice",
    comment: "Raised twice",
  });
  ok(
    "2A: void stores and returns void_reason_code",
    res.status === 200 &&
      res.body.status === "voided" &&
      res.body.void_reason_code === "duplicate_invoice",
    JSON.stringify(res.body).slice(0, 200),
  );
  ok(
    "2B: void comment is on the invoice",
    (await invoiceComments(inv.publicId)).some((r) => r.body === "Raised twice"),
  );
  const inv2 = await mkInvoice(c.id);
  const bare = await app.inject({
    method: "POST",
    url: `${base}/invoices/${inv2.publicId}/void`,
    headers: { authorization: `Bearer ${secret}`, "idempotency-key": `params-${keyN++}` },
  });
  const bareBody = JSON.parse(bare.payload) as Record<string, unknown>;
  ok(
    "2C: a void with no body still voids, with no reason",
    bare.statusCode === 200 && bareBody.status === "voided" && bareBody.void_reason_code === null,
    bare.payload.slice(0, 200),
  );

  const inv3 = await mkInvoice(c.id);
  const wo = await call("POST", `/invoices/${inv3.publicId}/write_off`, {
    comment: "Customer gone",
  });
  ok(
    "2D: write_off comment is on the invoice",
    wo.status === 200 &&
      (await invoiceComments(inv3.publicId)).some((r) => r.body === "Customer gone"),
  );

  const inv4 = await mkInvoice(c.id);
  await withTenant(orgId, (tx) =>
    tx.update(invoices).set({ status: "payment_due" }).where(eq(invoices.id, inv4.id)),
  );
  const stop = await call("POST", `/invoices/${inv4.publicId}/stop_dunning`, {
    comment: "Paying by wire",
  });
  ok(
    "2E: stop_dunning comment is on the invoice",
    stop.status === 200 &&
      stop.body.status === "not_paid" &&
      (await invoiceComments(inv4.publicId)).some((r) => r.body === "Paying by wire"),
  );
}

// §3 pause → resume
{
  const c = await mkCustomer();
  const inv = await mkInvoice(c.id);
  const scheduled = new Date(Date.now() + 2 * DAY);
  scheduled.setMilliseconds(0);
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ status: "payment_due", nextAttemptAt: scheduled, dunningStatus: "in_progress" })
      .where(eq(invoices.id, inv.id)),
  );
  const notPaused = await call("POST", `/invoices/${inv.publicId}/resume_dunning`, {});
  ok("3A: resume without a pause is refused", notPaused.status === 400);
  const until = new Date(Date.now() + 20 * DAY);
  until.setMilliseconds(0);
  const paused = await call("POST", `/invoices/${inv.publicId}/pause_dunning`, {
    until: until.toISOString(),
    comment: "Promised payment next month",
  });
  const mid = await invRow(inv.publicId);
  ok(
    "3B: pause pushes the retry out (unchanged) and keeps the comment",
    paused.status === 200 &&
      mid.nextAttemptAt?.getTime() === until.getTime() &&
      (await invoiceComments(inv.publicId)).some((r) => r.body === "Promised payment next month"),
  );
  // A second pause must not lose the ORIGINAL schedule.
  const until2 = new Date(until.getTime() + DAY);
  await call("POST", `/invoices/${inv.publicId}/pause_dunning`, { until: until2.toISOString() });
  const resumed = await call("POST", `/invoices/${inv.publicId}/resume_dunning`, {});
  const after = await invRow(inv.publicId);
  ok(
    "3C: resume restores the schedule the first pause replaced",
    resumed.status === 200 &&
      after.nextAttemptAt?.getTime() === scheduled.getTime() &&
      after.dunningStatus === "in_progress" &&
      after.dunningPause === null,
    `${after.nextAttemptAt?.toISOString()} vs ${scheduled.toISOString()}`,
  );
  const again = await call("POST", `/invoices/${inv.publicId}/resume_dunning`, {});
  ok("3D: a second resume is refused", again.status === 400);
}

// §4 collect with a chosen payment method
{
  const c = await mkCustomer();
  const other = await mkCustomer();
  await vaultPaymentMethod({ ...ctx, customer: c, token: "tok_4000000000009995" }); // declines
  const good = await vaultPaymentMethod({ ...ctx, customer: c, token: "tok_4242" });
  const foreign = await vaultPaymentMethod({ ...ctx, customer: other, token: "tok_4242" });
  const inv = await mkInvoice(c.id);
  const bad = await call("POST", `/invoices/${inv.publicId}/collect`, {
    payment_method_id: foreign.publicId,
  });
  ok("4A: another customer's method is refused (400)", bad.status === 400);
  const clash = await call("POST", `/invoices/${inv.publicId}/collect`, {
    payment_method_id: good.publicId,
    payment_intent: "pi_XXXXXXXXXXXX01",
  });
  ok("4B: payment_method_id with payment_intent is refused", clash.status === 400);
  const res = await call("POST", `/invoices/${inv.publicId}/collect`, {
    payment_method_id: good.publicId,
    comment: "Charged the new card",
  });
  const [pay] = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, inv.id)),
  );
  ok(
    "4C: collect charges the chosen method",
    res.status === 200 && res.body.status === "paid" && pay?.paymentMethodId === good.id,
    JSON.stringify(res.body).slice(0, 200),
  );
  ok(
    "4D: collect comment is on the invoice",
    (await invoiceComments(inv.publicId)).some((r) => r.body === "Charged the new card"),
  );
}

// §5 apply_credits with chosen credit notes
{
  await updateBusiness(orgId, biz.publicId, {
    creditsFlexibility: {
      refundable: { recurring: { mode: "none" }, one_time: { mode: "none" } },
      excess: { recurring: { mode: "none" }, one_time: { mode: "none" } },
    },
  });
  const c = await mkCustomer();
  const seed = await mkInvoice(c.id, [10000]);
  await recordOfflinePayment({ ...ctx, invoicePublicId: seed.publicId });
  const older = await issueRefundableCreditNote({
    ...ctx,
    invoicePublicId: seed.publicId,
    items: [{ description: "first", amountMinor: 3000 }],
  });
  const newer = await issueRefundableCreditNote({
    ...ctx,
    invoicePublicId: seed.publicId,
    items: [{ description: "second", amountMinor: 2000 }],
  });
  const target = await mkInvoice(c.id, [9000]);
  const stranger = await mkCustomer();
  const sSeed = await mkInvoice(stranger.id, [1000]);
  await recordOfflinePayment({ ...ctx, invoicePublicId: sSeed.publicId });
  const sNote = await issueRefundableCreditNote({
    ...ctx,
    invoicePublicId: sSeed.publicId,
    items: [{ description: "theirs", amountMinor: 1000 }],
  });
  const foreign = await call("POST", `/invoices/${target.publicId}/apply_credits`, {
    credit_notes: [{ id: sNote.publicId }],
  });
  ok("5A: another customer's credit note is refused", foreign.status === 400);
  const mixed = await call("POST", `/invoices/${target.publicId}/apply_credits`, {
    credit_notes: [{ id: newer.publicId }],
    refundable_minor: 100,
  });
  ok("5B: credit_notes with a per-bucket amount is refused", mixed.status === 400);
  const res = await call("POST", `/invoices/${target.publicId}/apply_credits`, {
    credit_notes: [{ id: newer.publicId }],
  });
  const allocs = await withTenant(orgId, (tx) =>
    tx
      .select({ cn: creditNoteAllocations.creditNoteId, amt: creditNoteAllocations.amountMinor })
      .from(creditNoteAllocations)
      .where(eq(creditNoteAllocations.invoiceId, target.id)),
  );
  const [olderAfter] = await withTenant(orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.id, older.id)),
  );
  ok(
    "5C: the named note is drawn, the older one is not",
    res.status === 200 &&
      (res.body.applied as { refundable_minor?: number }).refundable_minor === 2000 &&
      (res.body.applied as { excess_minor?: number }).excess_minor === 0 &&
      allocs.length === 1 &&
      allocs[0]!.cn === newer.id &&
      allocs[0]!.amt === 2000n &&
      olderAfter?.allocatedMinor === 0n,
    JSON.stringify(res.body.applied),
  );
  // Absent → today's FIFO: the older note is drawn first.
  const t2 = await mkInvoice(c.id, [500]);
  await call("POST", `/invoices/${t2.publicId}/apply_credits`, {});
  const fifo = await withTenant(orgId, (tx) =>
    tx
      .select({ cn: creditNoteAllocations.creditNoteId })
      .from(creditNoteAllocations)
      .where(eq(creditNoteAllocations.invoiceId, t2.id)),
  );
  ok("5D: no credit_notes → oldest note first, as before", fifo[0]?.cn === older.id);
}

// §6 retrieve paging + pdf disposition
{
  const c = await mkCustomer();
  const inv = await mkInvoice(c.id, [100, 200, 300]);
  const all = await call("GET", `/invoices/${inv.publicId}`);
  ok(
    "6A: no paging params → every line, no next offset key",
    (all.body.lines as unknown[]).length === 3 && !("line_items_next_offset" in all.body),
  );
  const p1 = await call("GET", `/invoices/${inv.publicId}?line_items_limit=2`);
  const p2 = await call("GET", `/invoices/${inv.publicId}?line_items_limit=2&line_items_offset=2`);
  ok(
    "6B: line pages of 2 then 1",
    (p1.body.lines as unknown[]).length === 2 &&
      p1.body.line_items_next_offset === "2" &&
      (p2.body.lines as unknown[]).length === 1 &&
      p2.body.line_items_next_offset === null,
  );
  const badLimit = await call("GET", `/invoices/${inv.publicId}?line_items_limit=0`);
  ok("6C: line_items_limit=0 is a 400", badLimit.status === 400);
  const dflt = await call("GET", `/invoices/${inv.publicId}/pdf`);
  const inline = await call("GET", `/invoices/${inv.publicId}/pdf?disposition_type=inline`);
  const bad = await call("GET", `/invoices/${inv.publicId}/pdf?disposition_type=embed`);
  ok(
    "6D: pdf is an attachment by default, inline on request, 400 otherwise",
    String(dflt.headers["content-disposition"]).startsWith("attachment;") &&
      String(inline.headers["content-disposition"]).startsWith("inline;") &&
      bad.status === 400,
  );
}

// §7 manual invoice create
{
  const c = await mkCustomer();
  const pm = await vaultPaymentMethod({ ...ctx, customer: c, token: "tok_4242" });
  const noCollect = await call("POST", "/invoices", {
    customer: c.publicId,
    lines: [{ description: "Setup", amount_minor: 1000 }],
    payment_method: pm.publicId,
  });
  ok("7A: payment_method without collect is refused", noCollect.status === 400);
  const res = await call("POST", "/invoices", {
    customer: c.publicId,
    lines: [{ description: "Setup", amount_minor: 1000 }],
    po_number: "PO-7781",
    collect: true,
    payment_method: pm.publicId,
  });
  ok(
    "7B: po_number stored; collect charged the named method",
    res.status === 201 && res.body.po_number === "PO-7781" && res.body.status === "paid",
    JSON.stringify(res.body).slice(0, 200),
  );
  const plain = await call("POST", "/invoices", {
    customer: c.publicId,
    lines: [{ description: "Plain", amount_minor: 1000 }],
  });
  ok("7C: no po_number → null, as before", plain.status === 201 && plain.body.po_number === null);
}

// §8 credit note create
{
  const c = await mkCustomer();
  const inv = await mkInvoice(c.id, [4000]);
  await recordOfflinePayment({ ...ctx, invoicePublicId: inv.publicId });
  const from = "2026-01-01T00:00:00.000Z";
  const to = "2026-01-15T00:00:00.000Z";
  const res = await call("POST", "/credit_notes", {
    invoice: inv.publicId,
    kind: "refundable",
    customer_notes: "Sorry for the outage",
    items: [
      { description: "Outage credit", amount_minor: 1000, period_start: from, period_end: to },
    ],
  });
  const cnPid = String(res.body.id ?? "");
  const detail = await call("GET", `/credit_notes/${cnPid}`);
  const items = await withTenant(orgId, async (tx) =>
    tx.execute(
      sql`select i.period_start, i.period_end from credit_note_items i join credit_notes n on n.id = i.credit_note_id where n.public_id = ${cnPid}`,
    ),
  );
  const item = (
    items as unknown as Array<{ period_start: Date | string; period_end: Date | string }>
  )[0];
  ok(
    "8A: customer_notes returned on create and retrieve",
    res.status === 201 &&
      res.body.customer_notes === "Sorry for the outage" &&
      detail.body.customer_notes === "Sorry for the outage",
  );
  ok(
    "8B: item carries the credited window",
    !!item &&
      new Date(item.period_start).toISOString() === from &&
      new Date(item.period_end).toISOString() === to,
  );
  const inverted = await call("POST", "/credit_notes", {
    invoice: inv.publicId,
    kind: "refundable",
    items: [{ description: "x", amount_minor: 100, period_start: to, period_end: from }],
  });
  ok("8C: an inverted window is refused", inverted.status === 400);
}

// §9 payment intent gateway_account
{
  const c = await mkCustomer();
  const pm = await vaultPaymentMethod({ ...ctx, customer: c, token: "tok_4242" });
  const res = await call("POST", "/payment_intents", {
    payment_method: pm.publicId,
    amount_minor: 1000,
    currency: "USD",
    gateway_account: "gwa_XXXXXXXXXXXX01",
  });
  ok(
    "9A: an unknown gateway_account is refused, not ignored",
    res.status === 400 && /gateway account/i.test(JSON.stringify(res.body)),
    JSON.stringify(res.body).slice(0, 200),
  );
}

let pass = true;
for (const [name, good, detail] of checks) {
  console.log(`  ${good ? "✓" : "✗"} ${name}${good || !detail ? "" : `  — ${detail}`}`);
  if (!good) pass = false;
}
console.log("");
console.log(pass ? "✅ INVOICE API PARAMS: PASS" : "❌ INVOICE API PARAMS: FAIL");
await app.close();
await closeDb();
process.exit(pass ? 0 : 1);
