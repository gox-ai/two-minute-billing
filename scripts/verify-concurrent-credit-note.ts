/**
 * One invoice, many credit notes — `verify:concurrent-collect` / `verify:concurrent-refund`
 * applied to credit-note ISSUE, the third way money leaves the business.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * The two sibling suites cover cash IN (`collectInvoice`) and cash OUT through the gateway
 * (`refundPayment`). Credit-note issue is the path that MINTS the obligation both of those
 * settle, and it is where a race is cheapest to exploit and hardest to see:
 *
 *   - `issueRefundableCreditNote` credits `refundable_credit_balance`, which
 *     `refundCreditNote` will later hand back as real cash. `refundCreditNote` itself is
 *     properly serialized (`lockCustomerBalances`) and is NOT what this file tests — but a
 *     correctly-locked payout of an over-issued balance still pays out too much. Locking
 *     the withdrawal while leaving the mint unguarded protects nothing.
 *   - `issueAdjustmentCreditNote` credits `accounts_receivable`, i.e. it writes off debt.
 *     Over-adjust and the books say a customer owed less than they did; with
 *     `reasonCode: 'write_off'` the same over-issue inflates `bad_debt`.
 *
 * Both are read-then-act, and neither takes any lock:
 *
 *   issueRefundableCreditNote        issueAdjustmentCreditNote
 *   ─────────────────────────        ─────────────────────────
 *   read refundableCapacity...       read invoice.amount_due + paid ⇒ `owed`
 *   if (total > available) throw     if (total > owed) throw
 *   INSERT credit_notes              INSERT credit_notes
 *   post the bucket credit           credit accounts_receivable
 *                                    UPDATE invoices.amount_due
 *
 * Two transactions at READ COMMITTED cannot see each other's uncommitted `credit_notes`
 * row, so both read the full capacity, both pass the cap, and both commit. The
 * `credit_notes` table's only unique index is on `public_id` (unique per row by
 * construction) and on `(business_id, number)` — neither constrains the TOTAL credited
 * against one invoice, so there is no index backstop of the
 * `payments_provider_charge_uq` kind either.
 *
 * ── WHAT THIS ASSERTS ───────────────────────────────────────────────────────────
 * The LEDGER and the bucket, never the row count — the lesson both sibling suites carry.
 * A suite counting `credit_notes` rows cannot tell an intentional split of one credit into
 * two notes from a doubling, and both paths legitimately produce several notes per invoice.
 * What can never be legitimate is the TOTAL:
 *
 *   - refundable: `refundable_credit_balance` may not exceed the cash actually collected,
 *   - adjustment: `accounts_receivable` credited by credit notes may not exceed the debt.
 *
 * Every refusal check is paired with a positive control in the same scenario, so a guard
 * that simply refused everything would fail too.
 *
 *   tsx scripts/verify-concurrent-credit-note.ts
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { billSubscriptionPeriod, collectInvoice } from "@/modules/invoicing/service";
import {
  issueRefundableCreditNote,
  issueAdjustmentCreditNote,
} from "@/modules/credit-notes/service";
import { bucketBalance, REFUNDABLE_CREDIT } from "@/modules/customers/balances";
import { creditNotes, invoices, ledgerEntries, payments } from "@db/schema";

const AMOUNT = 1500n;
const ISSUERS = 5;

const checks: [string, boolean, string][] = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

/**
 * A fresh org with one billed invoice. `collect: true` pays it (the refundable path needs
 * cash on the invoice); `collect: false` leaves it open for the adjustment path.
 */
async function scenario(label: string, opts: { collect: boolean }) {
  // No payment method on the adjustment scenarios: `billSubscriptionPeriod` auto-collects
  // whenever the customer has one, and an adjustment note applies only to an UNPAID
  // invoice. Vaulting a card here silently paid the invoice and every adjustment in the
  // race was refused with "invoice is paid" — the suite would have gone green having
  // tested nothing (`Promise.allSettled` swallows it).
  const vault = opts.collect;
  const org = await createOrganization({ name: `Concurrent CN ${label}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    defaultCurrency: "USD",
    organizationId: orgId,
    name: "Biz",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `ccn-${label}@a.com`,
  });
  if (vault)
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: biz.id,
      customer,
      token: "tok_4242",
    });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: Number(AMOUNT),
    interval: "month",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
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
  if (opts.collect) {
    await collectInvoice({
      organizationId: orgId,
      businessId: biz.id,
      invoice,
      subscription: sub.subscription,
    });
    const paid = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(payments)
        .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "succeeded"))),
    );
    if (paid.length !== 1)
      throw new Error(`${label}: setup expected 1 succeeded payment, got ${paid.length}`);
  }
  return { orgId, bizId: biz.id, customerId: customer.id, invoice };
}

/** Gross movement on one account, from credit notes only, in this org. */
async function cnLedger(
  orgId: string,
  account: string,
  direction: "debit" | "credit",
): Promise<bigint> {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.sourceType, "credit_note"), eq(ledgerEntries.account, account))),
  );
  return rows.filter((r) => r.direction === direction).reduce((s, r) => s + r.amountMinor, 0n);
}

const item = (n: bigint) => [{ description: "Concurrency probe", amountMinor: Number(n) }];

// ══ 1. REFUNDABLE — the mint behind `refundCreditNote`'s cash payout ════════════
{
  const s = await scenario("refundable", { collect: true });
  const res = await Promise.allSettled(
    Array.from({ length: ISSUERS }, () =>
      issueRefundableCreditNote({
        organizationId: s.orgId,
        businessId: s.bizId,
        invoicePublicId: s.invoice.publicId,
        items: item(AMOUNT),
        reason: "concurrency probe",
      }),
    ),
  );
  const issued = res.filter((r) => r.status === "fulfilled").length;
  const rows = await withTenant(s.orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.invoiceId, s.invoice.id)),
  );
  const cnTotal = rows
    .filter((c) => c.status !== "voided")
    .reduce((sum, c) => sum + c.totalMinor, 0n);

  // THE MONEY ASSERTION. `refundable_credit_balance` is what `refundCreditNote` converts
  // into cash at the gateway, so an inflated bucket is an over-refund waiting to be
  // collected — through a payout path that is itself correctly locked.
  const bucket = await withTenant(s.orgId, (tx) =>
    bucketBalance(tx, s.customerId, REFUNDABLE_CREDIT, "USD"),
  );
  ok(
    `1a: LEDGER — refundable credit minted never exceeds the ${AMOUNT} collected`,
    bucket <= AMOUNT,
    `refundable_credit_balance ${bucket} from ${issued}/${ISSUERS} concurrent issues (${cnTotal} across ${rows.length} note(s))`,
  );
  ok(
    `1b: the notes' face value never exceeds the ${AMOUNT} collected`,
    cnTotal <= AMOUNT,
    `credit notes total ${cnTotal}`,
  );
  // POSITIVE CONTROL, in this same scenario: whatever the guard does, ONE full-amount
  // note must have succeeded. A guard that refused everything would leave the bucket at 0
  // and satisfy 1a/1b for the wrong reason.
  ok(
    "1c: CONTROL — the first full-amount refundable note still succeeds",
    issued >= 1 && bucket > 0n,
    `${issued} succeeded, bucket ${bucket}`,
  );
}

// ══ 2. REFUNDABLE — sequential control, proving the cap works when not raced ════
// The cap itself is correct code; only its atomicity is in question. Prove that, so a
// failure in scenario 1 can only be a concurrency failure.
{
  const s = await scenario("refundable-seq", { collect: true });
  await issueRefundableCreditNote({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoicePublicId: s.invoice.publicId,
    items: item(AMOUNT),
    reason: "first",
  });
  let secondRefused = false;
  try {
    await issueRefundableCreditNote({
      organizationId: s.orgId,
      businessId: s.bizId,
      invoicePublicId: s.invoice.publicId,
      items: item(1n),
      reason: "second",
    });
  } catch {
    secondRefused = true;
  }
  const bucket = await withTenant(s.orgId, (tx) =>
    bucketBalance(tx, s.customerId, REFUNDABLE_CREDIT, "USD"),
  );
  ok(
    "2: CONTROL — issued SEQUENTIALLY the cap holds: a second note over capacity is refused",
    secondRefused && bucket === AMOUNT,
    `second refused: ${secondRefused}, bucket ${bucket}`,
  );
}

// ══ 3. ADJUSTMENT — writing off debt that is only owed once ═════════════════════
{
  const s = await scenario("adjustment", { collect: false });
  const [before] = await withTenant(s.orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, s.invoice.id)).limit(1),
  );
  const owed = before!.amountDueMinor ?? before!.totalMinor;
  const res = await Promise.allSettled(
    Array.from({ length: ISSUERS }, () =>
      issueAdjustmentCreditNote({
        organizationId: s.orgId,
        businessId: s.bizId,
        invoicePublicId: s.invoice.publicId,
        items: item(owed),
        reasonCode: "write_off",
        reason: "concurrency probe",
      }),
    ),
  );
  const issued = res.filter((r) => r.status === "fulfilled").length;
  const rows = await withTenant(s.orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.invoiceId, s.invoice.id)),
  );
  const cnTotal = rows
    .filter((c) => c.status !== "voided")
    .reduce((sum, c) => sum + c.totalMinor, 0n);

  // THE MONEY ASSERTION. An adjustment note credits `accounts_receivable` — it erases
  // debt. Credited twice, the books show a receivable that never existed being relieved,
  // and with reason_code 'write_off' the surplus lands in `bad_debt`: an expense claimed
  // for money the customer never owed.
  const arRelieved = await cnLedger(s.orgId, "accounts_receivable", "credit");
  const badDebt = await cnLedger(s.orgId, "bad_debt", "debit");
  const [after] = await withTenant(s.orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, s.invoice.id)).limit(1),
  );
  ok(
    `3a: LEDGER — accounts_receivable relieved by credit notes never exceeds the ${owed} owed`,
    arRelieved <= owed,
    `AR credited ${arRelieved} from ${issued}/${ISSUERS} concurrent write-offs (${cnTotal} across ${rows.length} note(s))`,
  );
  ok(
    `3b: LEDGER — bad_debt claimed never exceeds the ${owed} that was actually owed`,
    badDebt <= owed,
    `bad_debt ${badDebt}`,
  );
  ok(
    "3c: the invoice never ends up owing a NEGATIVE amount",
    (after!.amountDueMinor ?? 0n) >= 0n,
    `amount_due ${after!.amountDueMinor}`,
  );
  // POSITIVE CONTROL: the write-off must still work.
  ok(
    "3d: CONTROL — the write-off still lands (invoice settles, one full-amount note issued)",
    issued >= 1 && after!.status === "paid" && arRelieved > 0n,
    `${issued} succeeded, invoice ${after!.status}, AR relieved ${arRelieved}`,
  );
}

// ══ 4. ADJUSTMENT — sequential control ═════════════════════════════════════════
{
  const s = await scenario("adjustment-seq", { collect: false });
  const [before] = await withTenant(s.orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, s.invoice.id)).limit(1),
  );
  const owed = before!.amountDueMinor ?? before!.totalMinor;
  await issueAdjustmentCreditNote({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoicePublicId: s.invoice.publicId,
    items: item(owed),
    reason: "first",
  });
  let secondRefused = false;
  try {
    await issueAdjustmentCreditNote({
      organizationId: s.orgId,
      businessId: s.bizId,
      invoicePublicId: s.invoice.publicId,
      items: item(1n),
      reason: "second",
    });
  } catch {
    secondRefused = true;
  }
  const arRelieved = await cnLedger(s.orgId, "accounts_receivable", "credit");
  ok(
    "4: CONTROL — issued SEQUENTIALLY the cap holds: a second adjustment past the debt is refused",
    secondRefused && arRelieved === owed,
    `second refused: ${secondRefused}, AR relieved ${arRelieved} of ${owed}`,
  );
}

// ══ 5. A SUBSCRIPTION CHANGE racing a MANUAL credit note on the same invoice ═════
//
// The race sections 1-4 cannot reach. Those two paths both go through
// `issueRefundableCreditNote` / `issueAdjustmentCreditNote`, which take `lockInvoiceCredit`
// and therefore serialize against each other. A subscription CHANGE does not: it credits
// through `creditOneInvoice`, which reaches the UNCAPPED `createRefundableCreditNote`
// primitive and — until 2026-08-31 — took no lock at all. So a change and a manual note had
// NO lock in common, each read the invoice's full capacity, and each passed its own cap.
//
// `changeSubscription`'s optimistic lock does not help: it serialises changes to the
// SUBSCRIPTION, not credits against the INVOICE.
//
// Asserted the same way as every section above — the BUCKET, never the row count. The two
// legitimate serialised outcomes are both fine and the suite must accept either:
//   change first  → it mints its prorated slice, then the manual note's cap refuses the rest
//   manual first  → it mints the full cash, then the change's funding split clamps to 0
// What can never be legitimate is a total above the cash ever collected.
{
  const org = await createOrganization({ name: "Concurrent CN change-vs-manual" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    defaultCurrency: "USD",
    organizationId: orgId,
    name: "Biz",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "ccn-change@a.com",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Seats" });
  // 2 x 750 = 1500, so the paid cash matches AMOUNT and a qty 2->1 downgrade credits a
  // clean prorated slice of one seat.
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 750,
    interval: "month",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 2 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  await collectInvoice({
    organizationId: orgId,
    businessId: biz.id,
    invoice,
    subscription: sub.subscription,
  });
  const paid = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "succeeded"))),
  );
  const cash = paid.filter((p) => p.status === "succeeded").reduce((t, p) => t + p.amountMinor, 0n);
  if (cash !== AMOUNT)
    throw new Error(`change-vs-manual: setup expected ${AMOUNT} collected, got ${cash}`);

  const ps = sub.subscription.currentPeriodStart!.getTime();
  const pe = sub.subscription.currentPeriodEnd!.getTime();
  const mid = new Date(ps + Math.floor((pe - ps) / 2));

  const res = await Promise.allSettled([
    changeSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.subscription.id,
      changes: [{ itemId: sub.items[0]!.publicId, newQuantity: 1 }],
      prorate: true,
      invoiceImmediately: false,
      now: mid,
    }),
    issueRefundableCreditNote({
      organizationId: orgId,
      businessId: biz.id,
      invoicePublicId: invoice.publicId,
      items: item(AMOUNT),
      reasonCode: "other",
      reason: "manual note racing a change",
    }),
  ]);

  const bucket = await withTenant(orgId, (tx) =>
    bucketBalance(tx, customer.id, REFUNDABLE_CREDIT, "USD"),
  );
  const cnMinted = await cnLedger(orgId, REFUNDABLE_CREDIT, "credit");
  const settled = res.filter((r) => r.status === "fulfilled").length;

  ok(
    "5: a CHANGE racing a MANUAL note never mints refundable credit past the cash collected",
    cnMinted <= cash,
    `credit notes minted ${cnMinted} of ${cash} collected (bucket ${bucket}); ${settled}/2 operations completed`,
  );
  // Positive control in the same scenario: the pair is not simply refusing everything.
  ok(
    "5: CONTROL — at least one of the two actually completed",
    settled >= 1,
    res
      .map((r) =>
        r.status === "fulfilled"
          ? "ok"
          : `refused: ${String((r as PromiseRejectedResult).reason).slice(0, 60)}`,
      )
      .join(" | "),
  );
}

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (pass) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
console.log(
  failed === 0
    ? `\n✅ CONCURRENT CREDIT NOTE: PASS (${checks.length} checks)`
    : `\n❌ CONCURRENT CREDIT NOTE: FAIL — ${failed} of ${checks.length}`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
