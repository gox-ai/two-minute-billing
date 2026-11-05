/**
 * Every "charge this open invoice" path spends credit on file before a card — the
 * invoice's Collect now / Retry included, not only the customer's Collect payment.
 *
 *   pnpm verify:collect-credit-first
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { postEntries } from "@/modules/ledger/service";
import { collectInvoiceNow } from "@/modules/invoicing/ops";
import { bucketBalancesForCurrency } from "@/modules/customers/balances";
import { refundCreditNote, creditNoteSpendable } from "@/modules/credit-notes/service";
import { creditNoteAllocations, creditNotes, invoices } from "@db/schema";

const checks: Array<[string, boolean]> = [];

const org = await createOrganization({ name: `Collect credit first ${Date.now()}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "INR",
  livemode: "test",
});
const c = { organizationId: orgId, businessId: biz.id };

/** A customer with `credit` of refundable credit and one open, card-less 10000 invoice. */
async function fixture(label: string, credit: bigint) {
  const cust = await createCustomer({ ...c, email: `ccf-${label}-${Date.now()}@example.com` });
  const invPub = publicId("inv");
  await withTenant(orgId, async (tx) => {
    await tx.insert(invoices).values({
      ...c,
      customerId: cust.id,
      publicId: invPub,
      status: "payment_due",
      currency: "INR",
      subtotalMinor: 10000n,
      totalMinor: 10000n,
      amountDueMinor: 10000n,
    });
    await postEntries(
      {
        ...c,
        customerId: cust.id,
        sourceType: "invoice",
        sourceId: invPub,
        lines: [
          {
            account: "accounts_receivable",
            direction: "debit",
            amountMinor: 10000n,
            currency: "INR",
          },
          { account: "revenue", direction: "credit", amountMinor: 10000n, currency: "INR" },
        ],
      },
      tx,
    );
    await postEntries(
      {
        ...c,
        customerId: cust.id,
        sourceType: "import",
        sourceId: invPub,
        lines: [
          { account: "opening_balance", direction: "debit", amountMinor: credit, currency: "INR" },
          {
            account: "refundable_credit_balance",
            direction: "credit",
            amountMinor: credit,
            currency: "INR",
          },
        ],
      },
      tx,
    );
  });
  return { cust, invPub };
}

// Credit covers part: it is applied, and only the remainder goes to the card leg.
{
  const f = await fixture("part", 4000n);
  const { invoice } = await collectInvoiceNow(orgId, biz.id, f.invPub).catch(async () => ({
    invoice: (
      await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.publicId, f.invPub)),
      )
    )[0]!,
  }));
  const b = await bucketBalancesForCurrency(orgId, f.cust.id, "INR");
  console.log(
    `part: applied=${invoice.refundableCreditsAppliedMinor} due=${invoice.amountDueMinor} bucket=${b.refundable}`,
  );
  checks.push(
    [
      "partial: credit is applied before the card attempt",
      invoice.refundableCreditsAppliedMinor === 4000n,
    ],
    ["partial: the balance due drops by the credit", invoice.amountDueMinor === 6000n],
    ["partial: the bucket is spent", b.refundable === 0n],
  );
}

// Credit covers all: the invoice is paid by credit and no card is attempted.
{
  const f = await fixture("full", 12000n);
  const { invoice, payment } = await collectInvoiceNow(orgId, biz.id, f.invPub);
  const b = await bucketBalancesForCurrency(orgId, f.cust.id, "INR");
  console.log(
    `full: status=${invoice.status} payment=${payment?.publicId ?? null} bucket=${b.refundable}`,
  );
  checks.push(
    ["full: the invoice is paid by credit alone", invoice.status === "paid"],
    ["full: no card charge is attempted", payment === null],
    ["full: only what the invoice needed is drawn", b.refundable === 2000n],
  );
}

// Credit that came from a refundable credit note: the draw is recorded against that note,
// or the note keeps offering a refund for money this invoice already spent.
{
  const f = await fixture("note", 3000n);
  const cnPub = publicId("cn");
  await withTenant(orgId, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.publicId, f.invPub));
    await tx.insert(creditNotes).values({
      ...c,
      customerId: f.cust.id,
      invoiceId: inv!.id,
      publicId: cnPub,
      kind: "refundable",
      creditMethod: "refund",
      status: "refund_due",
      totalMinor: 3000n,
      allocatedMinor: 0n,
      refundedMinor: 0n,
      currency: "INR",
    });
  });
  await collectInvoiceNow(orgId, biz.id, f.invPub).catch(() => null);
  const { note, allocs } = await withTenant(orgId, async (tx) => {
    const [note] = await tx.select().from(creditNotes).where(eq(creditNotes.publicId, cnPub));
    const allocs = await tx
      .select({ amount: creditNoteAllocations.amountMinor, invoice: invoices.publicId })
      .from(creditNoteAllocations)
      .innerJoin(invoices, eq(invoices.id, creditNoteAllocations.invoiceId))
      .where(eq(creditNoteAllocations.creditNoteId, note!.id));
    return { note: note!, allocs };
  });
  console.log(
    `note: allocated=${note.allocatedMinor} status=${note.status} allocs=${allocs.length}`,
  );
  checks.push(
    ["note: the draw is allocated to the funding credit note", note.allocatedMinor === 3000n],
    [
      "note: the allocation names this invoice",
      allocs.length === 1 && allocs[0]!.invoice === f.invPub && allocs[0]!.amount === 3000n,
    ],
    ["note: a fully spent note no longer reads refund_due", note.status !== "refund_due"],
  );
}

// A note imported already settled: `refunded`, but its imported amounts leave money "left".
// It must not take the draw (the live `refund_due` note must), and it cannot be refunded.
{
  const f = await fixture("settled", 3000n);
  const settledPub = publicId("cn");
  const livePub = publicId("cn");
  await withTenant(orgId, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.publicId, f.invPub));
    const base = {
      ...c,
      customerId: f.cust.id,
      invoiceId: inv!.id,
      kind: "refundable",
      creditMethod: "refund",
      allocatedMinor: 0n,
      refundedMinor: 0n,
      currency: "INR",
    };
    await tx.insert(creditNotes).values([
      {
        ...base,
        publicId: settledPub,
        status: "refunded",
        totalMinor: 5000n,
        imported: true,
        createdAt: new Date("2023-06-06T00:00:00Z"),
      },
      { ...base, publicId: livePub, status: "refund_due", totalMinor: 3000n },
    ]);
  });
  await collectInvoiceNow(orgId, biz.id, f.invPub).catch(() => null);
  const notes = await withTenant(orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.customerId, f.cust.id)),
  );
  const settled = notes.find((n) => n.publicId === settledPub)!;
  const live = notes.find((n) => n.publicId === livePub)!;
  const refundRefused = await refundCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: settledPub,
  }).then(
    () => false,
    () => true,
  );
  console.log(
    `settled: settled.alloc=${settled.allocatedMinor} live.alloc=${live.allocatedMinor} live.status=${live.status}`,
  );
  checks.push(
    ["settled: an imported refunded note takes no draw", settled.allocatedMinor === 0n],
    ["settled: the live refund_due note takes it", live.allocatedMinor === 3000n],
    ["settled: an imported refunded note reads 0 spendable", creditNoteSpendable(settled) === 0n],
    ["settled: and cannot be refunded", refundRefused],
  );
}

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ COLLECT CREDIT FIRST: PASS" : "❌ COLLECT CREDIT FIRST: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
