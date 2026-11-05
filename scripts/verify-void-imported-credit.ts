/**
 * Voiding an IMPORTED invoice that consumed a refundable credit note must hand the credit
 * back as spendable balance, not only on the note.
 *
 * An imported invoice's credit is netted into its opening AR, so the ledger mirror has no
 * `credit_applied` draw to reverse. Without the top-up in `voidInvoice` the note reads
 * "refund due" while `refundable_credit_balance` stays 0, and collect / apply_credits
 * find nothing to apply.
 *
 *   pnpm verify:void-imported-credit
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { postEntries } from "@/modules/ledger/service";
import { voidInvoice } from "@/modules/invoicing/ops";
import { bucketBalancesForCurrency } from "@/modules/customers/balances";
import { creditNoteAllocations, creditNotes, invoices, ledgerEntries } from "@db/schema";

const checks: Array<[string, boolean]> = [];

const org = await createOrganization({ name: `Void imported credit ${Date.now()}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "INR",
  livemode: "test",
});
const c = { organizationId: orgId, businessId: biz.id };
const cust = await createCustomer({ ...c, email: `void-imported-${Date.now()}@example.com` });

// What the importer leaves behind: a 10000 invoice with 4000 of a refundable note already
// applied, so opening AR is 6000 and the fully-allocated note opened no bucket credit.
const TOTAL = 10000n;
const CREDIT = 4000n;
const invPub = publicId("inv");
const cnPub = publicId("cn");
await withTenant(orgId, async (tx) => {
  const [inv] = await tx
    .insert(invoices)
    .values({
      ...c,
      customerId: cust.id,
      publicId: invPub,
      status: "payment_due",
      currency: "INR",
      subtotalMinor: TOTAL,
      totalMinor: TOTAL,
      amountDueMinor: TOTAL - CREDIT,
      imported: true,
    })
    .returning();
  const [cn] = await tx
    .insert(creditNotes)
    .values({
      ...c,
      customerId: cust.id,
      invoiceId: inv!.id,
      publicId: cnPub,
      creditMethod: "refund",
      kind: "refundable",
      status: "refunded",
      totalMinor: CREDIT,
      allocatedMinor: CREDIT,
      currency: "INR",
      imported: true,
    })
    .returning();
  await tx
    .insert(creditNoteAllocations)
    .values({ ...c, creditNoteId: cn!.id, invoiceId: inv!.id, amountMinor: CREDIT });
  await postEntries(
    {
      ...c,
      customerId: cust.id,
      sourceType: "import",
      sourceId: invPub,
      lines: [
        {
          account: "accounts_receivable",
          direction: "debit",
          amountMinor: TOTAL - CREDIT,
          currency: "INR",
        },
        {
          account: "opening_balance",
          direction: "credit",
          amountMinor: TOTAL - CREDIT,
          currency: "INR",
        },
      ],
    },
    tx,
  );
});

await voidInvoice(orgId, biz.id, invPub);

const buckets = await bucketBalancesForCurrency(orgId, cust.id, "INR");
const [note] = await withTenant(orgId, (tx) =>
  tx.select().from(creditNotes).where(eq(creditNotes.publicId, cnPub)),
);
const ar = (
  await withTenant(orgId, (tx) =>
    tx.select().from(ledgerEntries).where(eq(ledgerEntries.customerId, cust.id)),
  )
)
  .filter((e) => e.account === "accounts_receivable")
  .reduce((s, e) => s + (e.direction === "debit" ? e.amountMinor : -e.amountMinor), 0n);
console.log(
  `after void: refundable=${buckets.refundable} note=${note?.status} allocated=${note?.allocatedMinor} ar=${ar}`,
);
checks.push(
  [
    "the note's allocation is released",
    note?.allocatedMinor === 0n && note?.status === "refund_due",
  ],
  [
    "the released credit is spendable: refundable bucket = note's available",
    buckets.refundable === CREDIT,
  ],
  ["the receivable is fully reversed", ar === 0n],
);

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ VOID IMPORTED CREDIT: PASS" : "❌ VOID IMPORTED CREDIT: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
