/**
 * Proves the ARCHIVAL history import (Option A) + the reconcile harness
 * (fixture source — no external keys):
 *  - settled invoices/payments/refunds/credit notes import as archival rows
 *    (imported=true, verbatim totals/lines/dates, raw payload in metadata),
 *    with NO ledger postings — money truth starts at cutover,
 *  - OPEN invoices become real collectible AR (opening_balance entries) and
 *    refundable credit-note balances open as customer_balance credit,
 *  - the ledger stays balanced and post-cutover revenue stays at zero,
 *  - invoice numbering is bumped past the imported max (no collisions),
 *  - settled archival rows REJECT lifecycle ops; open imported ones behave
 *    normally (offline payment settles AR; void reverses the opening entry),
 *  - pending (unfinalized) source invoices are skipped,
 *  - the source's raw events archive into imported_events (idempotent),
 *  - reconcile: clean right after import; flags an injected mismatch,
 *  - re-runs are idempotent.
 *
 *   pnpm verify:migration-history
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { importFromSource } from "@/modules/migration/import";
import { FixtureSource } from "@/modules/migration/fixture";
import { reconcileWithSource } from "@/modules/migration/reconcile";
import {
  voidInvoice,
  recordOfflinePayment,
  collectInvoiceNow,
  InvoiceOpsError,
} from "@/modules/invoicing/ops";
import { accountBalance } from "@/modules/ledger/service";
import { customerCreditBalance } from "@/modules/customers/balances";
import { voidCreditNote } from "@/modules/credit-notes/service";
import { serializeCreditNote } from "@/modules/credit-notes/serialize";
import { serializeInvoice } from "@/modules/invoicing/serialize";
import {
  invoices,
  invoiceLineItems,
  payments,
  refunds,
  creditNotes,
  importedEvents,
  ledgerEntries,
  businesses,
  customers as customersT,
  subscriptionItems,
  subscriptions,
} from "@db/schema";

const fails: string[] = [];
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) fails.push(n);
};

const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 24 * 3600_000);

const source = new FixtureSource({
  name: "src-fixture",
  catalog: {
    products: [{ sourceId: "item_pro", kind: "plan", name: "Pro" }],
    prices: [
      {
        sourceId: "price_pro",
        productSourceId: "item_pro",
        model: "flat",
        amountMinor: 4900,
        currency: "USD",
        interval: "month",
        intervalCount: 1,
      },
    ],
  },
  customers: [
    { sourceId: "src_carol", email: "carol@x.com", firstName: "Carol" },
    { sourceId: "src_dave", email: "dave@x.com", firstName: "Dave" },
  ],
  subscriptions: [
    {
      sourceId: "sub_carol",
      customerSourceId: "src_carol",
      status: "active",
      currency: "USD",
      currentTermStart: days(-10),
      currentTermEnd: days(20),
      items: [{ priceSourceId: "price_pro", kind: "plan", quantity: 1 }],
    },
  ],
  invoices: [
    {
      sourceId: "inv_1001",
      customerSourceId: "src_carol",
      subscriptionSourceId: "sub_carol",
      number: "1001",
      status: "paid",
      currency: "USD",
      subtotalMinor: 4900,
      totalMinor: 4900,
      amountDueMinor: 0,
      date: days(-60),
      paidAt: days(-60),
      lines: [
        {
          description: "Pro plan",
          priceSourceId: "price_pro",
          quantity: 1,
          unitAmountMinor: 4000,
          amountMinor: 4000,
          periodStart: days(-60),
          periodEnd: days(-30),
        },
        { description: "One-time setup", quantity: 1, unitAmountMinor: 900, amountMinor: 900 },
      ],
      rawPayload: { id: "inv_1001", total: 4900 },
    },
    {
      sourceId: "inv_1002",
      customerSourceId: "src_dave",
      number: "1002",
      status: "posted",
      currency: "USD",
      subtotalMinor: 2000,
      totalMinor: 2000,
      amountDueMinor: 2000,
      date: days(-10),
      dueDate: days(5),
      lines: [{ description: "Consulting", quantity: 1, unitAmountMinor: 2000, amountMinor: 2000 }],
    },
    {
      sourceId: "inv_1003",
      customerSourceId: "src_carol",
      number: "1003",
      status: "voided",
      currency: "USD",
      subtotalMinor: 500,
      totalMinor: 500,
      amountDueMinor: 0,
      date: days(-30),
      lines: [{ description: "Voided item", quantity: 1, unitAmountMinor: 500, amountMinor: 500 }],
    },
    {
      // Unfinalized at the source — must be skipped, not imported.
      sourceId: "inv_1004",
      customerSourceId: "src_carol",
      number: "1004",
      status: "pending",
      currency: "USD",
      subtotalMinor: 100,
      totalMinor: 100,
      amountDueMinor: 100,
      date: days(-1),
      lines: [],
    },
    {
      sourceId: "inv_1005",
      customerSourceId: "src_dave",
      number: "1005",
      status: "posted",
      currency: "USD",
      subtotalMinor: 300,
      totalMinor: 300,
      amountDueMinor: 300,
      date: days(-3),
      lines: [{ description: "Late fee", quantity: 1, unitAmountMinor: 300, amountMinor: 300 }],
    },
  ],
  transactions: [
    {
      sourceId: "txn_1",
      customerSourceId: "src_carol",
      type: "payment",
      status: "succeeded",
      amountMinor: 4900,
      currency: "USD",
      gateway: "stripe",
      gatewayTransactionId: "ch_123",
      date: days(-60),
      linkedInvoices: [{ invoiceSourceId: "inv_1001", appliedAmountMinor: 4900 }],
      rawPayload: { id: "txn_1" },
    },
    {
      sourceId: "txn_2",
      customerSourceId: "src_carol",
      type: "refund",
      status: "succeeded",
      amountMinor: 1000,
      currency: "USD",
      gateway: "stripe",
      gatewayTransactionId: "re_123",
      date: days(-50),
      refundedTransactionSourceId: "txn_1",
    },
  ],
  creditNotes: [
    {
      sourceId: "cn_1",
      customerSourceId: "src_carol",
      invoiceSourceId: "inv_1001",
      type: "refundable",
      status: "refund_due",
      totalMinor: 1000,
      amountAvailableMinor: 600,
      currency: "USD",
      reason: "service_unsatisfactory",
      date: days(-50),
      lines: [{ description: "Credit", amountMinor: 1000 }],
      rawPayload: { id: "cn_1", billing_address: { line1: "1 Example Street" } },
    },
  ],
  events: [
    {
      sourceId: "ev_1",
      eventType: "subscription_created",
      occurredAt: days(-100),
      payload: { id: "ev_1" },
    },
    {
      sourceId: "ev_2",
      eventType: "invoice_generated",
      occurredAt: days(-60),
      payload: { id: "ev_2" },
    },
    {
      sourceId: "ev_3",
      eventType: "payment_succeeded",
      occurredAt: days(-60),
      payload: { id: "ev_3" },
    },
  ],
});

const org = await createOrganization({ name: "History Migration Org" });
const orgId = org.organization.id;
const biz = await createBusiness({ organizationId: orgId, name: "Biz", defaultCurrency: "USD" });

console.log("import (with history + events)…");
const r1 = await importFromSource({ organizationId: orgId, businessId: biz.id, source });
for (const w of r1.warnings) console.log(`  ⚠ ${w}`);
const c = r1.counts;
check(
  "counts: 4 invoices created, 1 pending skipped",
  c.invoices?.created === 4 && c.invoices?.skipped === 1,
);
check(
  "counts: 1 payment, 1 refund, 1 credit note, 3 events",
  c.payments?.created === 1 &&
    c.refunds?.created === 1 &&
    c.credit_notes?.created === 1 &&
    c.events?.created === 3,
);
check(
  "nothing failed",
  Object.values(c).every((x) => x.failed === 0),
);

const state = await withTenant(orgId, async (tx) => {
  const invs = await tx.select().from(invoices).where(eq(invoices.businessId, biz.id));
  const lines = await tx
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.businessId, biz.id));
  const pays = await tx.select().from(payments).where(eq(payments.businessId, biz.id));
  const refs = await tx.select().from(refunds).where(eq(refunds.businessId, biz.id));
  const cns = await tx.select().from(creditNotes).where(eq(creditNotes.businessId, biz.id));
  const events = await tx
    .select()
    .from(importedEvents)
    .where(eq(importedEvents.businessId, biz.id));
  const ledger = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.businessId, biz.id));
  const [bizRow] = await tx.select().from(businesses).where(eq(businesses.id, biz.id));
  const [carol] = await tx
    .select()
    .from(customersT)
    .where(and(eq(customersT.businessId, biz.id), eq(customersT.email, "carol@x.com")));
  return { invs, lines, pays, refs, cns, events, ledger, bizRow, carol };
});

const inv1001 = state.invs.find((i) => i.number === "1001")!;
const inv1002 = state.invs.find((i) => i.number === "1002")!;
const inv1003 = state.invs.find((i) => i.number === "1003")!;
const inv1005 = state.invs.find((i) => i.number === "1005")!;

// --- archival fidelity ---
check(
  "paid invoice archival: imported, verbatim totals, historical date, payload kept",
  inv1001.imported &&
    inv1001.status === "paid" &&
    Number(inv1001.totalMinor) === 4900 &&
    !!inv1001.paidAt &&
    inv1001.createdAt < days(-59) &&
    (inv1001.metadata as any)?.source_payload?.total === 4900,
);
check(
  "lines verbatim (2 lines, price resolved on the plan line)",
  state.lines.filter((l) => l.invoiceId === inv1001.id).length === 2 &&
    state.lines.some(
      (l) => l.invoiceId === inv1001.id && l.priceId !== null && Number(l.amountMinor) === 4000,
    ),
);
check("void invoice archival", inv1003.imported && inv1003.status === "voided");
check(
  "open invoice is real AR (status posted, amount due 2000)",
  inv1002.imported && inv1002.status === "posted" && Number(inv1002.amountDueMinor) === 2000,
);
check("pending invoice NOT imported", !state.invs.some((i) => i.number === "1004"));
check(
  "archival payment row (stripe/ch_123, imported, historical date)",
  state.pays.length === 1 &&
    state.pays[0]!.imported &&
    state.pays[0]!.providerKey === "stripe" &&
    state.pays[0]!.providerChargeId === "ch_123" &&
    state.pays[0]!.invoiceId === inv1001.id,
);
check(
  "archival refund row linked to the payment",
  state.refs.length === 1 &&
    state.refs[0]!.imported &&
    state.refs[0]!.paymentId === state.pays[0]!.id,
);
check(
  "archival credit note (metadata keeps source status/type)",
  state.cns.length === 1 &&
    state.cns[0]!.imported &&
    (state.cns[0]!.metadata as any)?.source_status === "refund_due",
);
{
  // The raw import record stays stored but never reaches an API read.
  const invOut = serializeInvoice(inv1001).metadata as Record<string, unknown> | null;
  const cnOut = serializeCreditNote({
    note: state.cns[0]!,
    invoicePublicId: "inv_x",
    invoiceNumber: null,
    items: [],
  }).metadata as Record<string, unknown> | null;
  check(
    "API serializers drop metadata.source_payload, keep source + source_id",
    !!invOut &&
      !("source_payload" in invOut) &&
      typeof invOut.source_id === "string" &&
      !!cnOut &&
      !("source_payload" in cnOut) &&
      cnOut.source_status === "refund_due" &&
      (state.cns[0]!.metadata as any)?.source_payload != null,
  );
}
check(
  "events archived raw (3, typed, timestamped)",
  state.events.length === 3 &&
    state.events.every((e) => e.source === "src-fixture" && !!e.eventType),
);

// --- ledger: opening entries ONLY (no fabricated history) ---
const arOpen = await accountBalance(orgId, biz.id, "accounts_receivable", "USD");
const revenue = await accountBalance(orgId, biz.id, "revenue", "USD");
const carolCredit = await customerCreditBalance(orgId, state.carol!.id, "USD");
check("open AR equals source outstanding (2000 + 300 = 2300)", arOpen === 2300n);
check("NO revenue fabricated for settled history (revenue = 0)", revenue === 0n);
check("refundable credit-note balance opened as customer credit (600)", carolCredit === 600n);
const byTxn = new Map<string, bigint>();
for (const e of state.ledger) {
  const key = `${e.transactionId}:${e.currency}`;
  byTxn.set(
    key,
    (byTxn.get(key) ?? 0n) + (e.direction === "debit" ? e.amountMinor : -e.amountMinor),
  );
}
check(
  "ledger balanced (every transaction nets to zero)",
  [...byTxn.values()].every((v) => v === 0n),
);
check(
  "monthly totals match source exactly (archival sum 4900+2000+500+300)",
  state.invs.filter((i) => i.imported).reduce((s, i) => s + Number(i.totalMinor), 0) === 7700,
);

// --- invoice numbering bumped past the imported max ---
check(
  "invoice numbering bumped past imported max (next ≥ 1006)",
  (state.bizRow!.invoiceNextNumber ?? 0n) >= 1006n,
);

// --- reconcile: clean now, flags an injected mismatch ---
console.log("reconcile (right after import)…");
const rec1 = await reconcileWithSource({ organizationId: orgId, businessId: biz.id, source });
for (const m of rec1.mismatches)
  console.log(
    `  ✗ ${m.area} [${m.sourceId}]: expected ${JSON.stringify(m.expected)} got ${JSON.stringify(m.actual)}`,
  );
check("reconcile CLEAN right after import", rec1.pass);

await withTenant(orgId, async (tx) => {
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.businessId, biz.id));
  await tx
    .update(subscriptionItems)
    .set({ quantity: 3 })
    .where(eq(subscriptionItems.subscriptionId, sub!.id));
});
const rec2 = await reconcileWithSource({ organizationId: orgId, businessId: biz.id, source });
check(
  "reconcile flags an injected drift (quantity 1 → 3)",
  !rec2.pass && rec2.mismatches.some((m) => m.area === "subscription.item_quantity"),
);
await withTenant(orgId, async (tx) => {
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.businessId, biz.id));
  await tx
    .update(subscriptionItems)
    .set({ quantity: 1 })
    .where(eq(subscriptionItems.subscriptionId, sub!.id));
});

// --- lifecycle guards on archival rows ---
const rejects = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof InvoiceOpsError && String((e as Error).message).includes("archival");
  }
};
check(
  "settled archival rejects void",
  await rejects(() => voidInvoice(orgId, biz.id, inv1001.publicId)),
);
check(
  "settled archival rejects collect-now",
  await rejects(() => collectInvoiceNow(orgId, biz.id, inv1001.publicId)),
);
check(
  "settled archival rejects offline payment",
  await rejects(() =>
    recordOfflinePayment({
      organizationId: orgId,
      businessId: biz.id,
      invoicePublicId: inv1001.publicId,
    }),
  ),
);

// --- open imported invoices behave like real AR ---
const paid = await recordOfflinePayment({
  organizationId: orgId,
  businessId: biz.id,
  invoicePublicId: inv1002.publicId,
});
check("open imported invoice settles via offline payment", paid.invoice.status === "paid");
const voided = await voidInvoice(orgId, biz.id, inv1005.publicId);
check("open imported invoice can be voided (opening entry reversed)", voided.status === "voided");
const arAfter = await accountBalance(orgId, biz.id, "accounts_receivable", "USD");
check("AR fully settled after pay + void (0)", arAfter === 0n);

// --- idempotency ---
console.log("re-import (idempotency)…");
const r2 = await importFromSource({ organizationId: orgId, businessId: biz.id, source });
check(
  "re-run creates nothing",
  Object.values(r2.counts).every((x) => x.created === 0),
);
check("events re-run skipped (3)", r2.counts.events?.skipped === 3);

// --- source cleanup states: a voided note, a written-off invoice ---
// A refundable note voided at the source maps to 0 available, which read as "fully
// refunded"; a write-off settles an invoice with no payment and must say so.
console.log("voided notes + write-offs…");
{
  const o2 = await createOrganization({ name: "History Cleanup Org" });
  const b2 = await createBusiness({
    organizationId: o2.organization.id,
    name: "Biz",
    defaultCurrency: "USD",
  });
  const s2 = new FixtureSource({
    name: "src-fixture",
    customers: [{ sourceId: "src_erin", email: "erin@x.com", firstName: "Erin" }],
    invoices: [
      {
        sourceId: "inv_2001",
        customerSourceId: "src_erin",
        number: "2001",
        status: "paid",
        currency: "USD",
        subtotalMinor: 1000,
        totalMinor: 1000,
        amountDueMinor: 0,
        date: days(-40),
        paidAt: days(-1),
        writeOffMinor: 794,
        issue: {
          billingAddress: { company: "Erin Co", city: "Pune", state_code: "MH", country: "IN" },
          customerTaxId: "27AAAAA0000A1Z5",
          sellerTaxId: "33BBBBB0000B1Z5",
          sellerTaxCountry: "IN",
          priceType: "exclusive",
          notes: "",
        },
        lines: [{ description: "Pro", quantity: 1, unitAmountMinor: 1000, amountMinor: 1000 }],
      },
      {
        sourceId: "inv_2002",
        customerSourceId: "src_erin",
        number: "2002",
        status: "paid",
        currency: "USD",
        subtotalMinor: 700,
        totalMinor: 700,
        amountDueMinor: 0,
        date: days(-30),
        paidAt: days(-30),
        lines: [{ description: "Pro", quantity: 1, unitAmountMinor: 700, amountMinor: 700 }],
      },
    ],
    creditNotes: [
      {
        sourceId: "cn_wo",
        customerSourceId: "src_erin",
        invoiceSourceId: "inv_2001",
        type: "adjustment",
        status: "adjusted",
        totalMinor: 794,
        amountAvailableMinor: 0,
        currency: "USD",
        reason: "write_off",
        date: days(-1),
        lines: [{ description: "Write off", amountMinor: 794 }],
      },
      {
        sourceId: "cn_void",
        customerSourceId: "src_erin",
        invoiceSourceId: "inv_2002",
        type: "refundable",
        status: "voided",
        voidedAt: days(-1),
        totalMinor: 700,
        amountAvailableMinor: 0,
        amountAllocatedMinor: 0,
        amountRefundedMinor: 0,
        currency: "USD",
        date: days(-20),
        lines: [{ description: "Credit", amountMinor: 700 }],
      },
      {
        sourceId: "cn_due",
        customerSourceId: "src_erin",
        invoiceSourceId: "inv_2002",
        type: "refundable",
        status: "refund_due",
        totalMinor: 300,
        amountAvailableMinor: 300,
        amountAllocatedMinor: 0,
        amountRefundedMinor: 0,
        currency: "USD",
        date: days(-10),
        lines: [{ description: "Credit", amountMinor: 300 }],
      },
    ],
  });
  const r3 = await importFromSource({
    organizationId: o2.organization.id,
    businessId: b2.id,
    source: s2,
  });
  check(
    "cleanup import: nothing failed",
    Object.values(r3.counts).every((x) => x.failed === 0),
  );
  const st = await withTenant(o2.organization.id, async (tx) => ({
    invs: await tx.select().from(invoices).where(eq(invoices.businessId, b2.id)),
    cns: await tx.select().from(creditNotes).where(eq(creditNotes.businessId, b2.id)),
  }));
  const cnBy = (src: string) =>
    st.cns.find((n) => (n.metadata as { source_id?: string })?.source_id === src);
  check(
    "written-off invoice imports written off",
    st.invs.find((i) => i.number === "2001")?.writtenOff === true,
  );
  const inv2001 = st.invs.find((i) => i.number === "2001");
  check(
    "imported invoice keeps the source's issue snapshot",
    (inv2001?.billingAddress as { state_code?: string } | null)?.state_code === "MH" &&
      inv2001?.customerTaxId === "27AAAAA0000A1Z5" &&
      inv2001?.sellerTaxId === "33BBBBB0000B1Z5" &&
      inv2001?.priceType === "exclusive" &&
      inv2001?.notes === "",
  );
  check(
    "a paid invoice stays not written off",
    st.invs.find((i) => i.number === "2002")?.writtenOff === false,
  );
  check("write-off note keeps its reason", cnBy("cn_wo")?.reasonCode === "write_off");
  const vn = cnBy("cn_void");
  check(
    `voided note imports voided, not refunded [${vn?.status}]`,
    vn?.status === "voided" && vn?.voidedAt != null,
  );
  const erin = st.cns[0]!.customerId;
  check(
    "refundable credit = the refund-due note only (300)",
    (await customerCreditBalance(o2.organization.id, erin, "USD")) === 300n,
  );

  // Voiding an imported refund-due note must take back the credit its import opened.
  const due = cnBy("cn_due")!;
  await voidCreditNote({
    organizationId: o2.organization.id,
    businessId: b2.id,
    creditNotePublicId: due.publicId,
  });
  check(
    "voiding an imported note returns refundable credit to 0",
    (await customerCreditBalance(o2.organization.id, erin, "USD")) === 0n,
  );
}

console.log("");
console.log(
  fails.length === 0
    ? "✅ MIGRATION HISTORY: PASS"
    : `❌ MIGRATION HISTORY: FAIL (${fails.length}: ${fails.join(" | ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
