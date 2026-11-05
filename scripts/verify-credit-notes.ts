/**
 * Credit notes — permutations:
 *  - 'refund' method on a paid invoice → money back via the refund flow (cash out),
 *  - 'balance' method → customer_balance increases (spendable on future invoices),
 *  - partial credit note then another, cumulative guard rejects over-credit,
 *  - 'refund' on an unpaid invoice is rejected,
 *  - items recorded.
 *
 *   pnpm verify:credit-notes
 */
import { eq, inArray } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { removeSubscriptionItem } from "@/modules/subscriptions/items";
import { invoices, invoiceLineItems } from "@db/schema";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  issueCreditNote,
  issueAdjustmentCreditNote,
  issueRefundableCreditNote,
  listCreditNotes,
  CreditNoteError,
} from "@/modules/credit-notes/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import { customerCreditBalance } from "@/modules/customers/balances";
import {
  ledgerEntries,
  creditNoteItems,
  creditNotes as creditNotesTable,
  payments,
} from "@db/schema";
import { publicId } from "@/platform/ids";
import { settlePaymentSucceeded, settlePaymentFailed } from "@/modules/payments/settlement";
import { bucketBalancesForCurrency } from "@/modules/customers/balances";

const org = await createOrganization({ name: "CN Org" });
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
const cash = () => acct("cash");

const checks: Array<[string, boolean]> = [];

// 1) 'refund' method: $40 credit note on paid $100 invoice → cash out 40.
{
  const { invoice } = await paidInvoice("refund-cn@a.com");
  // refundCreditNote draws the bucket into a refunds_payable LIABILITY, then PAYS
  // THE CUSTOMER via a gateway refund that clears refunds_payable → cash (Phase F
  // review fix — previously the payable was booked but never settled, so the money
  // never actually left). Net: cash out 4000, refunds_payable back to 0.
  const cashBefore = await cash();
  const payableBefore = await acct("refunds_payable");
  const cn = await issueCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: invoice.publicId,
    creditMethod: "refund",
    items: [{ description: "partial refund", amountMinor: 4000 }],
    reason: "goodwill",
  });
  const cashAfter = await cash();
  const payableAfter = await acct("refunds_payable");
  const items = await withTenant(orgId, (tx) =>
    tx.select().from(creditNoteItems).where(eq(creditNoteItems.creditNoteId, cn.id)),
  );
  console.log(
    `refund CN: cash ${cashBefore}→${cashAfter} (−4000), refunds_payable ${payableBefore}→${payableAfter} (net 0), items=${items.length}`,
  );
  checks.push(
    ["refund CN → cash out 4000 (customer paid)", cashBefore - cashAfter === 4000n],
    ["refund CN → refunds_payable cleared (net 0)", payableAfter === payableBefore],
    ["refund CN has item", items.length === 1],
  );
}

// 2) 'balance' method: $25 → customer_balance +25.
{
  const { customer, invoice } = await paidInvoice("balance-cn@a.com");
  const balBefore = await customerCreditBalance(orgId, customer.id, "USD");
  await issueCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: invoice.publicId,
    creditMethod: "balance",
    items: [{ description: "service credit", amountMinor: 2500 }],
  });
  const balAfter = await customerCreditBalance(orgId, customer.id, "USD");
  console.log(`balance CN: customer_balance ${balBefore}→${balAfter} (+2500)`);
  checks.push(["balance CN +2500", balAfter - balBefore === 2500n]);
}

// 3) cumulative guard: $60 + $40 ok (=100), a further $1 rejected.
{
  const { invoice } = await paidInvoice("cum-cn@a.com");
  await issueCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: invoice.publicId,
    creditMethod: "balance",
    items: [{ description: "a", amountMinor: 6000 }],
  });
  await issueCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: invoice.publicId,
    creditMethod: "balance",
    items: [{ description: "b", amountMinor: 4000 }],
  });
  let over = false;
  try {
    await issueCreditNote({
      organizationId: orgId,
      businessId: biz.id,
      invoicePublicId: invoice.publicId,
      creditMethod: "balance",
      items: [{ description: "c", amountMinor: 1 }],
    });
  } catch (e) {
    over = e instanceof CreditNoteError;
  }
  const notes = await listCreditNotes(orgId, invoice.id);
  console.log(
    `cumulative: 2 notes total 10000, over-credit rejected=${over}, notes=${notes.length}`,
  );
  checks.push(
    ["cumulative over-credit rejected", over],
    ["two notes recorded", notes.length === 2],
  );
}

// 4) 'refund' on an unpaid invoice (no card) is rejected.
{
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "nopay-cn@a.com",
  }); // no payment method
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
  let rejected = false;
  try {
    await issueCreditNote({
      organizationId: orgId,
      businessId: biz.id,
      invoicePublicId: invoice.publicId,
      creditMethod: "refund",
      items: [{ description: "x", amountMinor: 1000 }],
    });
  } catch (e) {
    rejected = e instanceof CreditNoteError;
  }
  console.log(`refund on unpaid invoice rejected: ${rejected}`);
  checks.push(["refund-on-unpaid rejected", rejected]);
}

// GB2 (G-review regression): a DECLINED payout must not
// mark the CN refunded, must not re-inflate the refundable cap, and — since the
// reversal change — must NOT consume the CN either: the un-paid earmark is
// reversed (compensating ledger), `available` re-inflates, the caller gets the
// gateway's reason, and the failed attempt lands on the CN timeline.
{
  const {
    issueRefundableCreditNote,
    refundCreditNote,
    sweepOutstandingCnPayouts,
    getCreditNoteDetail,
  } = await import("@/modules/credit-notes/service");
  const { creditNotes } = await import("@db/schema");
  // The invoice is charged at a clean amount (20000 → charge succeeds, invoice
  // paid). The refundable CN is a PARTIAL 10013 whose refund amount ends in …13 →
  // tmtest's isNeedsAttentionAmount refuses the payout (declines). Note: …13 makes
  // tmtest fail the CHARGE too (needs_attention), so we cannot bill a full …13
  // invoice and expect it paid — a partial …13 refund on a clean paid invoice is
  // the way to exercise a declined payout (mirrors verify-gateway's refund-fail).
  const price20k = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 20000,
    interval: "month",
  });
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "declined-payout@a.com",
  });
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
    items: [{ price: price20k, quantity: 1 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  const cashBefore = await cash();
  const cn = await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: invoice.publicId,
    items: [{ description: "x", amountMinor: 10013 }],
  });
  let declineMsg: string | null = null;
  try {
    await refundCreditNote({
      organizationId: orgId,
      businessId: biz.id,
      creditNotePublicId: cn.publicId,
    });
  } catch (e) {
    if (e instanceof CreditNoteError) declineMsg = e.message;
  }
  checks.push([
    "GB2: fully-declined payout → refundCreditNote throws with the gateway reason",
    declineMsg != null && declineMsg.startsWith("Refund failed:"),
  ]);
  const afterRefund = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(creditNotes).where(eq(creditNotes.id, cn.id)).limit(1))[0]!,
  );
  checks.push([
    "GB2: declined payout does NOT consume the CN — earmark reversed, available re-inflated",
    afterRefund.status === "refund_due" &&
      afterRefund.refundedMinor === 0n &&
      afterRefund.paidOutMinor === 0n,
  ]);
  checks.push([
    "GB2: cash untouched, no refunds_payable residue after reversal",
    (await cash()) === cashBefore && (await acct("refunds_payable")) === 0n,
  ]);
  // The failed attempt is durable on the CN's own timeline (failed refund txn + reason).
  const detail = await getCreditNoteDetail(orgId, biz.id, cn.publicId);
  const failedTxn = detail?.refundTxns.find((t) => t.status === "failed");
  checks.push([
    "GB2: failed payout attempt recorded on the CN timeline with a reason",
    !!failedTxn && !!failedTxn.errorText,
  ]);
  // Cap: the OPEN CN's un-refunded total (10013) still counts against the paid
  // 20000, leaving 9987 refundable. A fresh CN for 9988 must be rejected — the
  // reversal restores `available`, it must not double the refundable headroom.
  let capped = false;
  try {
    await issueRefundableCreditNote({
      organizationId: orgId,
      businessId: biz.id,
      invoicePublicId: invoice.publicId,
      items: [{ description: "y", amountMinor: 9988 }],
    });
  } catch (e) {
    capped = e instanceof CreditNoteError;
  }
  checks.push(["GB2: cap counts the open CN — reversal does not double-commit", capped]);
  // Nothing is stranded for the sweep: refunded == paid_out, so this CN has no gap.
  await sweepOutstandingCnPayouts();
  const reread = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(creditNotes).where(eq(creditNotes.id, cn.id)).limit(1))[0]!,
  );
  checks.push([
    "GB2: no stranded earmark for the sweep (refunded == paid_out == 0)",
    reread.status === "refund_due" && reread.refundedMinor === 0n && reread.paidOutMinor === 0n,
  ]);
}

// ── GB3: THE SWEEP MUST NOT RETRY A PAYOUT THAT IS STILL IN FLIGHT ───────────────
//
// `refunded_minor > paid_out_minor` is true for a STRANDED payable and equally true for one
// mid-gateway-call. Until 2026-08-26 the sweep could not tell them apart and re-sent a refund
// 1.4 seconds after it had already succeeded (Stripe: "charge has already been refunded" — a
// FULL refund, so nothing was left to send; a PARTIAL one would have gone out twice).
//
// Simulating the window directly rather than trying to race a real gateway: a gap plus a FRESH
// `payoutAttemptAt` is exactly the state the live path holds between earmark and settle.
{
  const { CN_PAYOUT_LEASE_MS, sweepOutstandingCnPayouts, issueRefundableCreditNote } =
    await import("@/modules/credit-notes/service");
  const { postEntries } = await import("@/modules/ledger/service");
  const { creditNotes } = await import("@db/schema");
  // ── THIS BLOCK OWNS ITS FIXTURE. ────────────────────────────────────────────────
  // It used to take `select().from(creditNotes).limit(1)` — an arbitrary note belonging to
  // ANOTHER check — and overwrite its money columns. `limit(1)` returned check 1's $40 refund
  // CN, so every run of this suite left that note reading `refunded=500 / paid_out=500` on a
  // 4000 total, and the sweep below sent a REAL 500 refund against its payment. Measured
  // 2026-08-29: 23 customers carrying a negative `refunds_payable`, one per suite run since
  // 08-27, all of them this. A test that fabricates state must fabricate its own.
  const gapFix = await paidInvoice("sweep-gap@a.com");
  const gapCn = await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: gapFix.invoice.publicId,
    items: [{ description: "sweep gap fixture", amountMinor: 500 }],
  });
  // ── AND IT FABRICATES THE WHOLE STATE, NOT HALF OF IT. ──────────────────────────
  // The state this block simulates is "earmarked, not yet settled", and that state has TWO
  // halves: the columns AND the `refunds_payable` credit the earmark posts. Setting only the
  // columns left the sweep clearing a liability nobody had booked — the payout debited
  // `refunds_payable` with no matching credit, which is precisely how the balance went
  // negative. Posting the earmark here makes the fixture honest, so the reclaim below nets to
  // zero exactly as the live path does.
  const earmarked = { done: false };
  const setState = async (refunded: bigint, paidOut: bigint, attemptAt: Date | null) => {
    if (refunded > paidOut && !earmarked.done) {
      await postEntries({
        organizationId: orgId,
        businessId: biz.id,
        customerId: gapFix.customer.id,
        sourceType: "credit_note_refund",
        sourceId: gapCn.publicId,
        lines: [
          {
            account: "refundable_credit_balance",
            direction: "debit",
            amountMinor: refunded - paidOut,
            currency: "USD",
          },
          {
            account: "refunds_payable",
            direction: "credit",
            amountMinor: refunded - paidOut,
            currency: "USD",
          },
        ],
      });
      earmarked.done = true;
    }
    await withTenant(orgId, (tx) =>
      tx
        .update(creditNotes)
        .set({
          kind: "refundable",
          status: "refund_due",
          refundedMinor: refunded,
          paidOutMinor: paidOut,
          payoutAttemptAt: attemptAt,
        })
        .where(eq(creditNotes.id, gapCn.id)),
    );
  };
  const reread2 = () =>
    withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(creditNotes).where(eq(creditNotes.id, gapCn.id)).limit(1))[0]!,
    );

  // IN FLIGHT: a gap, leased one second ago. The sweep must leave it completely alone —
  // untouched `refunded_minor` proves it neither retried the payout nor reversed the earmark.
  await setState(500n, 0n, new Date());
  await sweepOutstandingCnPayouts();
  const inFlight = await reread2();
  checks.push([
    "GB3: sweep SKIPS a payout still in flight (fresh lease)",
    inFlight.refundedMinor === 500n &&
      inFlight.paidOutMinor === 0n &&
      inFlight.payoutAttemptAt != null,
  ]);

  // EXPIRED: the same gap, leased longer ago than the lease bound — the process attempting it
  // is presumed dead, and reclaiming that is the entire point of the sweep. It must act.
  await setState(500n, 0n, new Date(Date.now() - CN_PAYOUT_LEASE_MS - 60_000));
  await sweepOutstandingCnPayouts();
  const expired = await reread2();
  checks.push([
    "GB3: sweep RECLAIMS a payout whose lease has expired",
    expired.refundedMinor !== 500n || expired.paidOutMinor !== 0n,
  ]);

  // A lease must never outlive its earmark, or a crashed payout is stranded forever.
  checks.push(["GB3: reclaiming clears the lease", expired.payoutAttemptAt == null]);
}

// ── AN INVOICE ALREADY CREDITED IN FULL MUST ABSORB NOTHING MORE ──────────────────
// PROGRESS :146. Removing an add-on produced TWO notes of the same amount: one correctly
// allocated to the live invoice, one against an invoice a previous note had already
// credited in full. The second had nothing to offset, so it landed as `refund_due` — a
// cash liability instead of a reduction — and left the buyer out of pocket against a
// refund nobody actioned.
//
// The cause was one helper answering two questions. `refundableCapacityForInvoice` asks
// "how much CASH may a payout draw", and rightly ignores credit that was ALLOCATED
// elsewhere (that rule exists because counting a note's whole total made an invoice's cash
// permanently unreachable). `creditAcrossInvoices` asks "how much of this
// invoice may still be CREDITED", where allocated credit HAS consumed the value. It now
// has its own measure; the payout one is deliberately unchanged.
{
  const org2 = await createOrganization({ name: `CreditCap ${Date.now()}` });
  const o2 = org2.organization.id;
  const b2 = await createBusiness({
    organizationId: o2,
    name: "Cap",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const c2 = { organizationId: o2, businessId: b2.id };

  const planProd = await createProduct({ ...c2, name: "Cap Plan", kind: "plan" });
  const planA = await createPrice({
    ...c2,
    productId: planProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 50000,
    interval: "month",
  });
  const planB = await createPrice({
    ...c2,
    productId: planProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 90000,
    interval: "year",
  });
  const addProd = await createProduct({ ...c2, name: "Cap Addon", kind: "addon" });
  const addP = await createPrice({
    ...c2,
    productId: addProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });

  const cust = await createCustomer({ ...c2, email: `cap${Date.now()}@a.com` });
  await vaultPaymentMethod({ ...c2, customer: cust, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...c2,
    customerId: cust.id,
    now: new Date(),
    items: [
      { price: planA, quantity: 1 },
      { price: addP, quantity: 1 },
    ],
  });
  const addItem = items.find((i) => i.priceId === addP.id)!;
  await billSubscriptionPeriod({
    ...c2,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });

  // A CADENCE change forces a term reset: it credits the first invoice IN FULL and bills a
  // second one — the two-invoice shape the bug needs.
  const planItem = items.find((i) => i.priceId === planA.id)!;
  await changeSubscription({
    ...c2,
    subscriptionId: subscription.id,
    now: subscription.currentPeriodStart!,
    changes: [{ itemId: planItem.publicId, newPriceId: planB.publicId }],
    invoiceImmediately: true,
  });

  const notesBefore = (
    await withTenant(o2, (tx) =>
      tx.select().from(creditNotesTable).where(eq(creditNotesTable.businessId, b2.id)),
    )
  ).length;
  const { creditNotes: fromRemoval } = await removeSubscriptionItem({
    ...c2,
    subscriptionId: subscription.id,
    itemPublicId: addItem.publicId,
    now: subscription.currentPeriodStart!,
  });
  const invRows = (
    await withTenant(o2, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, subscription.id)),
    )
  ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  // The FIRST invoice is the one the term reset already credited in full. A refundable note
  // against the LIVE invoice is correct — it is paid, so the money genuinely comes back;
  // what must never happen is another note landing on the spent one.
  const spentInvoiceId = invRows[0]?.id;
  const againstSpent = fromRemoval.filter((n) => n.invoiceId === spentInvoiceId);

  console.log(
    `credit capacity: invoices=${invRows.length} notesBefore=${notesBefore} ` +
      `removalNotes=${fromRemoval.length} againstAlreadyCredited=${againstSpent.length}`,
  );
  // ── every credited SUPPLY line must say which period it reversed ────────────────────
  // `creditAcrossInvoices` spells each note out from the source invoice's own lines but used
  // to drop those lines' ids on the way, so every credit-note item was written with
  // `period_start`, `period_end` and `invoice_line_item_id` NULL — the three columns added
  // for exactly this. A customer reading the note could not tell what period was credited,
  // and neither could a report. Putting the period in the line TEXT instead ("… - Prorated
  // Credits for 31-Aug-2026 - 29-Sep-2026") is the weaker answer; we carry it structurally,
  // which is only better if it is actually carried.
  //
  // Asserted HERE rather than in `verify-proration-matrix`: that suite's `mkSub` raises no
  // first invoice, so its term is never billed, so there is nothing to credit and no note is
  // produced at all. This block bills the term first, which is what makes the credit note
  // exist.
  //
  // Scoped to THIS subscription's invoices, and the TAX line is exempt: it reverses a
  // proportional slice of the whole invoice rather than any one line, so it inherits no
  // period.
  const termInvoiceIds = invRows.map((i) => i.id);
  const creditedItems = await withTenant(o2, (tx) =>
    tx
      .select({
        description: creditNoteItems.description,
        periodStart: creditNoteItems.periodStart,
        periodEnd: creditNoteItems.periodEnd,
        invoiceLineItemId: creditNoteItems.invoiceLineItemId,
      })
      .from(creditNoteItems)
      .innerJoin(creditNotesTable, eq(creditNotesTable.id, creditNoteItems.creditNoteId))
      .where(inArray(creditNotesTable.invoiceId, termInvoiceIds)),
  );
  const supplyItems = creditedItems.filter((i) => !/^Tax reversal/.test(i.description));
  const withPeriod = supplyItems.filter((i) => i.periodStart != null && i.periodEnd != null);
  const withLine = supplyItems.filter((i) => i.invoiceLineItemId != null);
  console.log(
    `credited line provenance: items=${creditedItems.length} supply=${supplyItems.length} ` +
      `withPeriod=${withPeriod.length} withLineId=${withLine.length}`,
  );
  checks.push(
    ["a term reset leaves two invoices on the term", invRows.length >= 2],
    ["removing an add-on credits it ONCE, not once per invoice", fromRemoval.length <= 1],
    ["no note lands on the invoice a previous credit already spent", againstSpent.length === 0],
    ["the term produced credited supply lines to check", supplyItems.length > 0],
    [
      "every credited supply line carries the SERVICE PERIOD it reversed",
      supplyItems.length > 0 && withPeriod.length === supplyItems.length,
    ],
    [
      "every credited supply line names the invoice line it reverses",
      supplyItems.length > 0 && withLine.length === supplyItems.length,
    ],
  );
}

// ── REMOVING AN ADD-ON WHILE A PAYMENT IS IN FLIGHT — BOTH OUTCOMES ───────────────
// The dunning race: an invoice is open, a retry has left our process and not yet come
// back, and the buyer removes an item in that window. Dunning retries are exactly when
// people go and remove things, so the window is not as narrow as it sounds.
//
// The defect (found by `probe-inflight-adjustment.ts`, fixed in `1df9e8a`): the removal's
// adjustment is sized on `invoiceOutstanding`, which counts SUCCEEDED payments only, so a
// PENDING attempt is invisible to it. Measured — invoice 3628400, attempt in flight, remove
// the GDS add-on → due 3167800, then the webhook settles the original 3628400: the customer
// was 4606 over and the invoice reported `paid`.
//
// Fixed at the SETTLEMENT rather than by refusing the removal — refusing would let a stuck
// payment freeze the subscription, and would not cover a void or a write-off either.
//
// Until now that fix was held by a probe and nothing else: no verify suite called settlement
// at all. Both outcomes are asserted here, because they are different rules —
//
//   the attempt FAILS    → the debt was simply reduced; the invoice stays open at the
//                          smaller amount and dunning carries on
//   the attempt SUCCEEDS → the payment overshoots what is now owed; the excess must be
//                          detached and credited to the customer rather than left as an
//                          overpayment on an invoice claiming to be settled
//
// The composition is the reported one: PRO + 3 connections + the GDS destination add-on.
{
  const mk = async (label: string) => {
    const org = await createOrganization({ name: `Inflight ${label} ${Date.now()}` });
    const o = org.organization.id;
    const b = await createBusiness({
      organizationId: o,
      name: "IF",
      defaultCurrency: "USD",
      livemode: "test",
    });
    const c = { organizationId: o, businessId: b.id };
    const planProd = await createProduct({ ...c, name: "PRO", kind: "plan" });
    const plan = await createPrice({
      ...c,
      productId: planProd.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: 27918,
      interval: "month",
    });
    const connProd = await createProduct({ ...c, name: "Connections", kind: "addon" });
    const conn = await createPrice({
      ...c,
      productId: connProd.id,
      type: "recurring",
      model: "per_unit",
      currency: "USD",
      amountMinor: 752,
      interval: "month",
    });
    const gdsProd = await createProduct({ ...c, name: "GDS Destination", kind: "addon" });
    const gds = await createPrice({
      ...c,
      productId: gdsProd.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: 4606,
      interval: "month",
    });
    // NO card on file, deliberately: with one, billing collects on the spot and the
    // invoice is `paid` before there is anything to be in flight. No instrument leaves it
    // open at `payment_due` — the dunning shape this scenario needs.
    const cust = await createCustomer({ ...c, email: `inflight-${label}-${Date.now()}@a.com` });
    const { subscription, items } = await createSubscription({
      ...c,
      customerId: cust.id,
      now: new Date(),
      items: [
        { price: plan, quantity: 1 },
        { price: conn, quantity: 3 },
        { price: gds, quantity: 1 },
      ],
    });
    const billed = await billSubscriptionPeriod({
      ...c,
      subscription,
      periodStart: subscription.currentPeriodStart!,
      periodEnd: subscription.currentPeriodEnd!,
    });
    const invId = billed.invoice!.id;
    const readInv = async () =>
      (await withTenant(o, (tx) => tx.select().from(invoices).where(eq(invoices.id, invId))))[0]!;
    const inv0 = await readInv();
    // The row a gateway call writes before its webhook lands.
    const payPub = publicId("pay");
    await withTenant(o, (tx) =>
      tx.insert(payments).values({
        organizationId: o,
        businessId: b.id,
        customerId: cust.id,
        invoiceId: invId,
        publicId: payPub,
        status: "pending",
        amountMinor: inv0.totalMinor,
        currency: "USD",
        providerKey: "stripe",
        providerChargeId: `ch_${label}_${Date.now()}`,
      }),
    );
    const gdsItem = items.find((i) => i.priceId === gds.id)!;
    await removeSubscriptionItem({
      ...c,
      subscriptionId: subscription.id,
      itemPublicId: gdsItem.publicId,
      now: new Date(),
    });
    const [payRow] = await withTenant(o, (tx) =>
      tx.select().from(payments).where(eq(payments.publicId, payPub)),
    );
    return { o, b, cust, invId, readInv, payRow: payRow!, attempted: inv0.totalMinor };
  };

  // ── the attempt FAILS ──────────────────────────────────────────────────────────
  const f = await mk("fail");
  const dueAfterRemoval = (await f.readInv()).amountDueMinor ?? (await f.readInv()).totalMinor;
  await withTenant(f.o, (tx) =>
    settlePaymentFailed(tx, { organizationId: f.o, businessId: f.b.id, paymentId: f.payRow.id }),
  );
  const failInv = await f.readInv();
  const failBuckets = await bucketBalancesForCurrency(f.o, f.cust.id, "USD");
  console.log(
    `in-flight FAIL : attempted=${f.attempted} dueAfterRemoval=${dueAfterRemoval} status=${failInv.status} due=${failInv.amountDueMinor} excess=${failBuckets.excess}`,
  );
  checks.push(
    ["in-flight fail: the removal reduced what is owed", dueAfterRemoval < f.attempted],
    ["in-flight fail: the invoice stays OPEN at the reduced amount", failInv.status !== "paid"],
    ["in-flight fail: a failed attempt hands the customer nothing", failBuckets.excess === 0n],
  );

  // ── the attempt SUCCEEDS ───────────────────────────────────────────────────────
  const s2 = await mk("ok");
  const dueBeforeSettle = (await s2.readInv()).amountDueMinor ?? (await s2.readInv()).totalMinor;
  await withTenant(s2.o, (tx) =>
    settlePaymentSucceeded(tx, {
      organizationId: s2.o,
      businessId: s2.b.id,
      paymentId: s2.payRow.id,
    }),
  );
  const okInv = await s2.readInv();
  const okBuckets = await bucketBalancesForCurrency(s2.o, s2.cust.id, "USD");
  const overshoot = s2.attempted - dueBeforeSettle;
  // The customer paid `attempted` against a debt of `dueBeforeSettle`. Whatever the
  // engine does with the difference, it must not vanish: it is either still owed on the
  // invoice or held for the customer, never absorbed by an invoice that never earned it.
  const held = okBuckets.excess + okBuckets.refundable;
  const stillLinked = (
    await withTenant(s2.o, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, s2.invId)),
    )
  )
    .filter((p) => p.status === "succeeded")
    .reduce((sum, p) => sum + p.amountMinor, 0n);
  console.log(
    `in-flight OK   : attempted=${s2.attempted} dueBeforeSettle=${dueBeforeSettle} overshoot=${overshoot} status=${okInv.status} held=${held} stillLinked=${stillLinked}`,
  );
  checks.push(
    ["in-flight ok: the settled attempt overshoots the reduced debt", overshoot > 0n],
    ["in-flight ok: the overshoot is returned to the customer, not absorbed", held >= overshoot],
    // THE POSITION INVARIANT, not the invoice's cached `amount_due_minor`. That column is
    // not what the API reports — `serialize.ts` DERIVES `amount_due_minor` from payments and
    // credits (`remainingDue`) — so asserting on the raw column tests a stale cache rather
    // than the answer any caller sees. What must hold is arithmetic on the cash: every unit
    // the customer paid either cleared the debt or is being held for them, and none of it
    // was absorbed by an invoice that never earned it.
    [
      "in-flight ok: cash in = debt cleared + money held (nothing absorbed, nothing lost)",
      s2.attempted - held === dueBeforeSettle,
    ],
    // THE DETACH, asserted separately because the arithmetic above survives without it.
    // `paidTotals` sums invoice-linked SUCCEEDED payments into the invoice's reported
    // `amount_paid`, so an overshooting payment left linked credits the invoice with money
    // it never absorbed — and the invoice is ALSO settled from the excess credit, counting
    // the same cash twice. Verified by mutation: drop the `invoiceId: null` update and this
    // is the only check that fails.
    [
      "in-flight ok: the overshooting payment is DETACHED, so the invoice is not credited twice",
      stillLinked <= dueBeforeSettle,
    ],
  );
}

// ── NOTE TAX: each line's own tax, and nothing left after a full credit (2026-10-24) ──
// B15: a note that names lines reverses THOSE lines' tax, not the invoice average.
// B16: the note that fully credits the invoice reverses every remaining unit of tax.
{
  async function taxedBiz(name: string, rateBps: number) {
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
      rateBps,
    });
    const prod = await createProduct({ organizationId: orgId, businessId: b.id, name: "Plan" });
    const mkPrice = (amountMinor: number, isTaxable = true) =>
      createPrice({
        organizationId: orgId,
        businessId: b.id,
        productId: prod.id,
        type: "recurring",
        model: "flat",
        currency: "USD",
        amountMinor,
        interval: "month",
        isTaxable,
      });
    return { b, mkPrice };
  }
  async function billFor(
    businessId: string,
    email: string,
    prices: Awaited<ReturnType<typeof createPrice>>[],
    paid: boolean,
  ) {
    const c = await createCustomer({
      organizationId: orgId,
      businessId,
      email,
      autoCollection: paid ? "on" : "off",
      address: { line1: "1 St", city: "London", postalCode: "EC1", country: "GB" },
    });
    if (paid)
      await vaultPaymentMethod({
        organizationId: orgId,
        businessId,
        customer: c,
        token: "tok_4242",
      });
    const sub = await createSubscription({
      organizationId: orgId,
      businessId,
      customerId: c.id,
      now: new Date(),
      items: prices.map((price) => ({ price, quantity: 1 })),
    });
    const { invoice } = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId,
      subscription: sub.subscription,
      periodStart: sub.subscription.currentPeriodStart!,
      periodEnd: sub.subscription.currentPeriodEnd!,
    });
    const lines = await withTenant(orgId, (tx) =>
      tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id)),
    );
    const inv = await withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1))[0]!,
    );
    const lineFor = (priceId: string) => lines.find((l) => l.priceId === priceId)!.publicId;
    return { inv, lineFor };
  }
  /** The tax this note moved off `tax_payable`. */
  const noteTax = (cnPublicId: string) =>
    withTenant(orgId, async (tx) =>
      (await tx.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, cnPublicId)))
        .filter((e) => e.account === "tax_payable")
        .reduce((s, e) => s + (e.direction === "debit" ? e.amountMinor : -e.amountMinor), 0n),
    );
  const bizTaxPayable = (businessId: string) =>
    withTenant(orgId, async (tx) =>
      (await tx.select().from(ledgerEntries).where(eq(ledgerEntries.businessId, businessId)))
        .filter((e) => e.account === "tax_payable")
        .reduce((s, e) => s + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n),
    );

  // Mixed invoice: 10000 taxed at 20% (+2000) and 5000 not taxable → total 17000.
  const mixed = await taxedBiz("CN line tax", 2000);
  const taxed = await mixed.mkPrice(10000);
  const untaxed = await mixed.mkPrice(5000, false);

  // Adjustment (open invoice).
  {
    const { inv, lineFor } = await billFor(
      mixed.b.id,
      "line-tax-adj@a.com",
      [taxed, untaxed],
      false,
    );
    const zeroLine = await issueAdjustmentCreditNote({
      organizationId: orgId,
      businessId: mixed.b.id,
      invoicePublicId: inv.publicId,
      items: [
        {
          description: "untaxed line",
          amountMinor: 5000,
          invoiceLineItemPublicId: lineFor(untaxed.id),
        },
      ],
    });
    const taxedLine = await issueAdjustmentCreditNote({
      organizationId: orgId,
      businessId: mixed.b.id,
      invoicePublicId: inv.publicId,
      items: [
        {
          description: "taxed line",
          amountMinor: 12000,
          invoiceLineItemPublicId: lineFor(taxed.id),
        },
      ],
    });
    const t0 = await noteTax(zeroLine.publicId);
    const t1 = await noteTax(taxedLine.publicId);
    console.log(
      `line tax (adj) : invoice ${inv.totalMinor}, untaxed-line note tax ${t0}, taxed-line note tax ${t1}`,
    );
    checks.push(
      ["line tax: mixed invoice total 17000", inv.totalMinor === 17000n],
      ["line tax (adjustment): crediting the 0% line reverses no tax (was 588)", t0 === 0n],
      ["line tax (adjustment): crediting the 20% line in full reverses its 2000", t1 === 2000n],
    );
  }

  // Refundable (paid invoice), plus the invoice rule for an amount-only note.
  {
    const { inv, lineFor } = await billFor(
      mixed.b.id,
      "line-tax-ref@a.com",
      [taxed, untaxed],
      true,
    );
    const zeroLine = await issueRefundableCreditNote({
      organizationId: orgId,
      businessId: mixed.b.id,
      invoicePublicId: inv.publicId,
      items: [
        {
          description: "untaxed line",
          amountMinor: 5000,
          invoiceLineItemPublicId: lineFor(untaxed.id),
        },
      ],
    });
    const amountOnly = await issueRefundableCreditNote({
      organizationId: orgId,
      businessId: mixed.b.id,
      invoicePublicId: inv.publicId,
      items: [{ description: "goodwill", amountMinor: 5000 }],
    });
    const t0 = await noteTax(zeroLine.publicId);
    const t1 = await noteTax(amountOnly.publicId);
    console.log(
      `line tax (ref) : paid ${inv.status}, untaxed-line note tax ${t0}, amount-only note tax ${t1}`,
    );
    checks.push(
      ["line tax (refundable): invoice paid", inv.status === "paid"],
      ["line tax (refundable): crediting the 0% line reverses no tax (was 588)", t0 === 0n],
      // round(5000 × 2000 / 17000) = 588 — unchanged for a note that names no line.
      ["line tax (refundable): an amount-only note keeps the invoice's average share", t1 === 588n],
    );
  }

  // B16: 847 at 18.06% → tax 153, total 1000; four notes of 250 round 38.25 down.
  {
    const r = await taxedBiz("CN last-note tax", 1806);
    const p = await r.mkPrice(847);
    const { inv } = await billFor(r.b.id, "last-note-tax@a.com", [p], false);
    const shares: bigint[] = [];
    for (let k = 0; k < 4; k++) {
      const cn = await issueAdjustmentCreditNote({
        organizationId: orgId,
        businessId: r.b.id,
        invoicePublicId: inv.publicId,
        items: [{ description: `quarter ${k + 1}`, amountMinor: 250 }],
      });
      shares.push(await noteTax(cn.publicId));
    }
    const left = await bizTaxPayable(r.b.id);
    console.log(
      `last-note tax  : invoice ${inv.totalMinor}, shares ${shares.join("/")}, tax_payable left ${left}`,
    );
    checks.push(
      ["last-note tax: invoice 1000", inv.totalMinor === 1000n],
      [
        "last-note tax: the first three notes round down to 38",
        shares.slice(0, 3).every((s) => s === 38n),
      ],
      ["last-note tax: the fourth note reverses the remaining 39", shares[3] === 39n],
      ["last-note tax: a fully credited invoice leaves 0 on tax_payable (was 1)", left === 0n],
    );
  }

  // ── PER-LINE CAP: an item that names a line credits at most what that line has left ──
  // Tax-inclusive: the 20% line is worth 12000 (10000 + 2000 added tax), the 0% line 5000.
  const refusedOn = async (fn: () => Promise<unknown>, pid: string) => {
    try {
      await fn();
      return false;
    } catch (e) {
      return e instanceof CreditNoteError && e.message.includes(pid);
    }
  };
  {
    const { inv, lineFor } = await billFor(
      mixed.b.id,
      "line-cap-adj@a.com",
      [taxed, untaxed],
      false,
    );
    const taxedPid = lineFor(taxed.id);
    const adj = (items: { amountMinor: number; pid: string }[]) =>
      issueAdjustmentCreditNote({
        organizationId: orgId,
        businessId: mixed.b.id,
        invoicePublicId: inv.publicId,
        items: items.map((i) => ({
          description: "line credit",
          amountMinor: i.amountMinor,
          invoiceLineItemPublicId: i.pid,
        })),
      });
    const overOne = await refusedOn(() => adj([{ amountMinor: 12001, pid: taxedPid }]), taxedPid);
    const overSplit = await refusedOn(
      () =>
        adj([
          { amountMinor: 6001, pid: taxedPid },
          { amountMinor: 6000, pid: taxedPid },
        ]),
      taxedPid,
    );
    const first = await adj([{ amountMinor: 7000, pid: taxedPid }]).catch(() => null);
    const overCumulative = await refusedOn(
      () => adj([{ amountMinor: 5001, pid: taxedPid }]),
      taxedPid,
    );
    const left = await withTenant(orgId, async (tx) => {
      const { lineCreditableAmounts } = await import("@/modules/credit-notes/line-cap");
      return (await lineCreditableAmounts(tx, inv, [taxedPid])).get(taxedPid)?.remainingMinor;
    });
    const rest = await adj([{ amountMinor: 5000, pid: taxedPid }]).then(
      () => true,
      () => false,
    );
    console.log(
      `line cap (adj) : first ${first?.totalMinor}, left after it ${left}, rest accepted ${rest}`,
    );
    checks.push(
      ["line cap: one item over the line's 12000 is refused, naming the line", overOne],
      ["line cap: two items on one line are summed against its cap", overSplit],
      ["line cap: earlier notes on the line count (7000 then 5001 refused)", overCumulative],
      ["line cap: the line reports 5000 still creditable after 7000", left === 5000n],
      ["line cap: exactly the remaining 5000 is accepted", rest],
    );
  }

  // Refundable path, and concurrent notes on one line: the invoice ceiling (17000 paid)
  // admits both 7000 notes, the line's 12000 admits one.
  {
    const { inv, lineFor } = await billFor(
      mixed.b.id,
      "line-cap-ref@a.com",
      [taxed, untaxed],
      true,
    );
    const untaxedPid = lineFor(untaxed.id);
    const taxedPid = lineFor(taxed.id);
    const ref = (amountMinor: number, pid: string) =>
      issueRefundableCreditNote({
        organizationId: orgId,
        businessId: mixed.b.id,
        invoicePublicId: inv.publicId,
        items: [{ description: "line refund", amountMinor, invoiceLineItemPublicId: pid }],
      });
    const overUntaxed = await refusedOn(() => ref(5001, untaxedPid), untaxedPid);
    const race = await Promise.allSettled([ref(7000, taxedPid), ref(7000, taxedPid)]);
    const won = race.filter((r) => r.status === "fulfilled").length;
    const lostOnLine = race.some(
      (r) => r.status === "rejected" && String(r.reason?.message).includes(taxedPid),
    );
    console.log(`line cap (ref) : paid ${inv.status}, concurrent 7000+7000 → ${won} accepted`);
    checks.push(
      ["line cap (refundable): 5001 on the 5000 line is refused", overUntaxed],
      ["line cap (refundable): of two concurrent 7000 notes on one line, one passes", won === 1],
      ["line cap (refundable): the other is refused by the line cap", lostOnLine],
    );
  }

  // Tax-inclusive price: the tax is inside the amount, so the line is worth 12000, not 14000.
  {
    const r = await taxedBiz("CN line cap inclusive", 2000);
    const p = await createPrice({
      organizationId: orgId,
      businessId: r.b.id,
      productId: (await createProduct({ organizationId: orgId, businessId: r.b.id, name: "Inc" }))
        .id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: 12000,
      interval: "month",
      taxBehavior: "inclusive",
    });
    const plain = await r.mkPrice(5000, false);
    const { inv, lineFor } = await billFor(r.b.id, "line-cap-inc@a.com", [p, plain], false);
    const pid = lineFor(p.id);
    const note = (amountMinor: number) =>
      issueAdjustmentCreditNote({
        organizationId: orgId,
        businessId: r.b.id,
        invoicePublicId: inv.publicId,
        items: [{ description: "inc", amountMinor, invoiceLineItemPublicId: pid }],
      });
    const over = await refusedOn(() => note(12001), pid);
    const full = await note(12000).then(
      () => true,
      () => false,
    );
    checks.push(
      ["line cap (inclusive): invoice total 17000", inv.totalMinor === 17000n],
      ["line cap (inclusive): 12001 on the 12000 line is refused (tax not added twice)", over],
      ["line cap (inclusive): the full 12000 is accepted", full],
    );
  }

  // Exclusive tax sits in the supply line's 12000 AND on the 2000 tax line: one pool.
  {
    const taxLineOf = (invoiceId: string) =>
      withTenant(orgId, async (tx) => {
        const rows = await tx
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoiceId));
        return rows.find((l) => l.kind === "tax")!.publicId;
      });
    const setup = async (email: string) => {
      const { inv, lineFor } = await billFor(mixed.b.id, email, [taxed, untaxed], false);
      const note = (items: { amountMinor: number; pid: string }[]) =>
        issueAdjustmentCreditNote({
          organizationId: orgId,
          businessId: mixed.b.id,
          invoicePublicId: inv.publicId,
          items: items.map((i) => ({
            description: "pool",
            amountMinor: i.amountMinor,
            invoiceLineItemPublicId: i.pid,
          })),
        });
      return { supply: lineFor(taxed.id), tax: await taxLineOf(inv.id), note };
    };
    // Supply line in full (tax included), then its tax line.
    const a = await setup("line-cap-pool-a@a.com");
    await a.note([{ amountMinor: 12000, pid: a.supply }]);
    const taxAfterSupply = await refusedOn(() => a.note([{ amountMinor: 1, pid: a.tax }]), a.tax);
    // Tax line first: the supply line keeps only its 10000 net.
    const b = await setup("line-cap-pool-b@a.com");
    await b.note([{ amountMinor: 2000, pid: b.tax }]);
    const supplyOver = await refusedOn(
      () => b.note([{ amountMinor: 10001, pid: b.supply }]),
      b.supply,
    );
    const supplyNet = await b.note([{ amountMinor: 10000, pid: b.supply }]).then(
      () => true,
      () => false,
    );
    // Both in one note.
    const c = await setup("line-cap-pool-c@a.com");
    const oneNote = await refusedOn(
      () =>
        c.note([
          { amountMinor: 12000, pid: c.supply },
          { amountMinor: 2000, pid: c.tax },
        ]),
      c.supply,
    );
    // Half the supply line reverses 1000 tax; the tax line keeps the other 1000.
    const d = await setup("line-cap-pool-d@a.com");
    await d.note([{ amountMinor: 6000, pid: d.supply }]);
    const halfOver = await refusedOn(() => d.note([{ amountMinor: 1001, pid: d.tax }]), d.tax);
    const halfOk = await d.note([{ amountMinor: 1000, pid: d.tax }]).then(
      () => true,
      () => false,
    );
    checks.push(
      ["tax pool: after the supply line in full, its tax line is refused", taxAfterSupply],
      ["tax pool: after the tax line, the supply line refuses 10001", supplyOver],
      ["tax pool: after the tax line, the supply line takes its 10000 net", supplyNet],
      ["tax pool: supply line in full + its tax line in one note is refused", oneNote],
      ["tax pool: after half the supply line, the tax line refuses 1001", halfOver],
      ["tax pool: after half the supply line, the tax line takes 1000", halfOk],
    );
  }
}

// A refund_due note used up by ALLOCATION is stored `refunded` with refunded_minor 0.
// `settled_by` says so, so nobody refunds it again thinking it is unpaid.
{
  const { issueRefundableCreditNote } = await import("@/modules/credit-notes/service");
  const { serializeCreditNote } = await import("@/modules/credit-notes/serialize");
  const { createInvoiceFromLines } = await import("@/modules/invoicing/service");
  const { creditNoteChipStatus } = await import("../dashboard/lib/credit-note-status");
  const { creditNotes } = await import("@db/schema");
  const { customer, invoice } = await paidInvoice("settled-by-allocation@example.com");
  const cn = await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: invoice.publicId,
    items: [{ description: "credit", amountMinor: 4000 }],
  });
  await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    currency: "USD",
    lines: [{ description: "Setup fee", amountMinor: 4000n, kind: "one_time" }],
    applyCredit: true,
    collect: false,
  });
  const note = await withTenant(
    orgId,
    async (tx) => (await tx.select().from(creditNotes).where(eq(creditNotes.id, cn.id)))[0]!,
  );
  const wire = serializeCreditNote({
    note,
    invoicePublicId: invoice.publicId,
    invoiceNumber: null,
    items: [],
  });
  console.log(
    `settled_by: status=${wire.status} allocated=${wire.allocated_minor} refunded=${wire.refunded_minor} settled_by=${wire.settled_by}`,
  );
  checks.push(
    [
      "allocation-settled note: status stays refunded, refunded_minor 0, settled_by allocation",
      wire.status === "refunded" &&
        wire.refunded_minor === 0 &&
        wire.allocated_minor === 4000 &&
        wire.settled_by === "allocation",
    ],
    [
      "…and the dashboard chip reads Applied to invoices",
      creditNoteChipStatus(wire) === "applied_to_invoices",
    ],
    [
      "a refund_due note has no settled_by",
      serializeCreditNote({
        note: { ...note, status: "refund_due", allocatedMinor: 0n },
        invoicePublicId: invoice.publicId,
        invoiceNumber: null,
        items: [],
      }).settled_by === null,
    ],
  );
}

// ── A LINE FROM ANOTHER INVOICE escapes the per-line cap: the API refuses it ──
{
  const { buildApp } = await import("@/index");
  const app = await buildApp({ logger: false });
  const mine = await paidInvoice("foreign-line-a@a.com");
  const other = await paidInvoice("foreign-line-b@a.com");
  const lineOf = async (invoiceId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)),
      )
    ).find((l) => l.kind !== "tax")!.publicId;
  const post = (linePid: string) =>
    app.inject({
      method: "POST",
      url: `/v1/businesses/${biz.publicId}/credit_notes`,
      headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `fl-${Math.random()}` },
      payload: {
        invoice: mine.invoice.publicId,
        kind: "refundable", // the invoice is paid
        items: [{ description: "line credit", amount_minor: 1000, invoice_line_item: linePid }],
      },
    });
  const foreign = await post(await lineOf(other.invoice.id));
  const own = await post(await lineOf(mine.invoice.id));
  console.log(`foreign line   : ${foreign.statusCode} ${foreign.body.slice(0, 160)}`);
  checks.push(
    [
      "API: a line of a different invoice → 400 'is not on this invoice'",
      foreign.statusCode === 400 && foreign.body.includes("is not on this invoice"),
    ],
    ["API: a line of the named invoice still credits (201)", own.statusCode === 201],
  );
  await app.close();
}

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ CREDIT NOTES: PASS" : "❌ CREDIT NOTES: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
