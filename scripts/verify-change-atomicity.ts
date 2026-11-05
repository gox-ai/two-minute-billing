/**
 * SUBSCRIPTION CHANGE / ITEM REMOVAL — atomicity of the credit, and the cached MRR.
 *
 * Two defects this suite pins down on `POST .../subscriptions/:sub/change` (A–E),
 * plus the SAME class on `DELETE .../subscriptions/:sub/items/:id` (F–G, J):
 *
 *  1. A DOWNGRADE whose credit cannot be issued used to return **500** and still
 *     commit: the item change landed in one transaction, and `issueCurrentTermCredit`
 *     then opened its own, where the refundable-CN cap legitimately refused the
 *     credit. The customer was left downgraded with nothing credited. The invariant
 *     asserted here is the whole point of the fix, and it is binary:
 *       a quantity DECREASE either (a) succeeds AND issues a credit note, or
 *       (b) fails with a 4xx AND leaves the subscription byte-for-byte unchanged.
 *     There is no third outcome. `assertDowngradeOutcome` below is written so that
 *     "committed without a credit" fails a check rather than passing silently.
 *     (Half of that invariant has a third clause since 2026-08-24 — the credit must
 *     also be the FULL amount owed, see 5. The refusal half is asserted in J, on a
 *     refusal the engine still owes.)
 *
 *  2. The cached `subscriptions.mrr` column — what the subscriptions list SHOWS,
 *     sorts and filters on — was never recomputed by this path, so every quantity /
 *     price / cadence change left a stale revenue figure on screen.
 *
 *  3. `removeSubscriptionItem` (items.ts) had the identical hole: it DELETED the
 *     item in one transaction and issued the unused-time credit in another, and the
 *     DELETE route mapped no credit-note refusal — so a removal whose credit the
 *     engine refuses returned 500 with the item already gone. The customer lost the
 *     item AND the credit they were owed. Same binary invariant as (1):
 *       a removal either (a) succeeds AND issues a credit note, or
 *       (b) fails with a 4xx AND leaves the item in place, uncredited.
 *
 *  4. A TERM RESET (plan swap / cadence change) charged the FULL new-term price for
 *     EVERY post-change item and credited "unused time" on every one of them — a
 *     `one_time` fee included. So a plan swap re-charged a setup fee the customer had
 *     already paid AND credited its unused time, though a one-time fee buys no span
 *     of time. Cases H (already billed → neither) and I (never billed → still owed in
 *     full, and the cycle recorded).
 *
 *  5. THE SILENT PARTIAL CREDIT (2026-08-24). Both credit paths above resolved ONE
 *     invoice to credit — "the newest live", or for a single removal "the one that
 *     charged this item" — and `splitCreditByFunding` then clamped the credit to THAT
 *     invoice's cash. A term routinely bills one item across several invoices (an
 *     add-on subscribed at qty 1, then scaled to qty 40, whose second invoice collects
 *     only the delta), so the clamp kept part of the customer's money with no error and
 *     no log: measured 2026-08-24, removing that add-on owed 20000 and issued a single
 *     note for 19500. A downgrade did it too — 500 credited against an unrelated
 *     add-on invoice out of 20000 owed.
 *
 *     EVERY invoice that billed the item is credited, each from its own lines. With an
 *     add-on at 560/unit, qty 1 → invoice 2189 charged 560; scaled to 40 → invoice 2190
 *     charged the delta 21840; removal owes 22400 against a largest-single-invoice cash
 *     of 21840:
 *         CN-202    560.00 → invoice 2189, line qty  1 × 560
 *         CN-203 21840.00 → invoice 2190, line qty 39 × 560
 *     summing to the full 22400. That is what A and F now assert — the outcome, scoped
 *     to the SUBSCRIPTION under test (this suite runs A–J against one business, so a
 *     per-business credit-note dump misattributes notes between scenarios).
 *
 * Driven over real HTTP through the SDK, because the STATUS CODE is half the bug
 * (a 500 invites a retry of a change that can never succeed).
 *
 *   pnpm verify:change-atomicity
 */
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization } from "@/modules/tenancy/service";
import {
  creditNotes,
  invoiceLineItems,
  invoices,
  prices,
  subscriptionItems,
  subscriptions,
  unbilledCharges,
} from "@db/schema";
import { Tmbilling, TmbillingError } from "../sdk/index";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;

const org = await createOrganization({ name: "Change Atomicity Co" });
const tmb = new Tmbilling({ apiKey: org.secret, baseUrl: `http://127.0.0.1:${port}` });
const biz = await tmb.businesses.create({
  name: "Atomicity Biz",
  default_currency: "USD",
  livemode: "test",
});

// per_unit everywhere so a QUANTITY change actually re-rates the line.
const planProduct = await tmb.products.create(biz.id, { name: "Platform", kind: "plan" });
const planMonthly = await tmb.prices.create(biz.id, {
  product: planProduct.id,
  model: "per_unit",
  currency: "USD",
  type: "recurring",
  amount_minor: 20000,
  interval: "month",
});
const planYearly = await tmb.prices.create(biz.id, {
  product: planProduct.id,
  model: "per_unit",
  currency: "USD",
  type: "recurring",
  amount_minor: 480000,
  interval: "year",
});
const addonProduct = await tmb.products.create(biz.id, { name: "Extra connector", kind: "addon" });
const addonMonthly = await tmb.prices.create(biz.id, {
  product: addonProduct.id,
  model: "per_unit",
  currency: "USD",
  type: "recurring",
  amount_minor: 500,
  interval: "month",
});
// A ONE-TIME fee attached as a subscription ITEM (case H) — a setup charge, not a rate.
const setupProduct = await tmb.products.create(biz.id, { name: "Onboarding", kind: "charge" });
const setupFee = await tmb.prices.create(biz.id, {
  product: setupProduct.id,
  name: "Onboarding setup",
  model: "flat",
  currency: "USD",
  type: "one_time",
  amount_minor: 3000,
});

// ── State readers (direct DB, so nothing is taken on the API's word) ──────────
async function subState(subPublicId: string) {
  const [sub] = await systemDb
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.publicId, subPublicId))
    .limit(1);
  const items = await systemDb
    .select({
      id: subscriptionItems.publicId,
      quantity: subscriptionItems.quantity,
      price: prices.publicId,
    })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .where(eq(subscriptionItems.subscriptionId, sub!.id));
  // ── SCOPED TO THE SUBSCRIPTION, not the customer and never the business ────────
  // This suite runs A–I against ONE business, so any per-business credit-note dump
  // misattributes notes between scenarios — a 19500 and a 500 sitting side by side
  // look like one split credit when they belong to two different subscriptions.
  // Scoped through the subscription's OWN invoices, which is also what each note
  // references, so `creditNotes` here can only ever be this subscription's.
  const invRows = await systemDb
    .select({ id: invoices.id, publicId: invoices.publicId, totalMinor: invoices.totalMinor })
    .from(invoices)
    .where(eq(invoices.subscriptionId, sub!.id));
  const cnRows =
    invRows.length === 0
      ? []
      : await systemDb
          .select({
            id: creditNotes.publicId,
            totalMinor: creditNotes.totalMinor,
            invoiceId: creditNotes.invoiceId,
          })
          .from(creditNotes)
          .where(
            inArray(
              creditNotes.invoiceId,
              invRows.map((i) => i.id),
            ),
          );
  // Each note with the invoice it credits — the attribution half of the fix: a removal
  // credit must land on the invoice that CHARGED the thing, not on whichever invoice
  // happened to be newest.
  const cns = cnRows.map((c) => ({
    id: c.id,
    totalMinor: c.totalMinor,
    invoice: invRows.find((i) => i.id === c.invoiceId)?.publicId ?? "(other subscription)",
  }));
  const invs = invRows.map((i) => ({ id: i.publicId, totalMinor: i.totalMinor }));
  // Deferred charges queued against this subscription. A removal settles the money it
  // owes in one of TWO ways — a credit note for what an invoice already collected, and
  // the cancellation of what was only ever QUEUED (0109 made deferral the default, so
  // most mid-term adds are never invoiced at all). Reading only the credit notes made
  // the second form look like "no credit issued". See assertRemovalOutcome.
  const uchRows = await systemDb
    .select({
      id: unbilledCharges.publicId,
      status: unbilledCharges.status,
      amountMinor: unbilledCharges.amountMinor,
    })
    .from(unbilledCharges)
    .where(eq(unbilledCharges.subscriptionId, sub!.id));
  return {
    mrr: sub!.mrr,
    billingPeriodUnit: sub!.billingPeriodUnit,
    resourceVersion: sub!.resourceVersion,
    items: items.sort((a, b) => a.id.localeCompare(b.id)),
    creditNotes: cns,
    invoices: invs,
    unbilled: uchRows,
    /** Still-billable queued money: what a future renewal would fold in. */
    pendingUnbilledMinor: uchRows
      .filter((u) => u.status === "pending")
      .reduce((t, u) => t + u.amountMinor, 0n),
    qtyOf: (pricePublicId: string) =>
      items.find((i) => i.price === pricePublicId)?.quantity ?? null,
    itemIdOf: (pricePublicId: string) => items.find((i) => i.price === pricePublicId)!.id,
  };
}

/** The lines of one invoice, with each line's PRICE resolved to its public id. */
async function linesOf(invoicePublicId: string) {
  const [inv] = await systemDb
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.publicId, invoicePublicId))
    .limit(1);
  const rows = await systemDb
    .select({
      price: prices.publicId,
      amountMinor: invoiceLineItems.amountMinor,
      kind: invoiceLineItems.kind,
      description: invoiceLineItems.description,
    })
    .from(invoiceLineItems)
    .leftJoin(prices, eq(invoiceLineItems.priceId, prices.id))
    .where(eq(invoiceLineItems.invoiceId, inv!.id));
  return rows;
}

/** `cycles_billed` of the item carrying `pricePublicId` — the cap bookkeeping. */
async function cyclesBilledOf(subPublicId: string, pricePublicId: string) {
  const [sub] = await systemDb
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.publicId, subPublicId))
    .limit(1);
  const all = await systemDb
    .select({ cyclesBilled: subscriptionItems.cyclesBilled, price: prices.publicId })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .where(eq(subscriptionItems.subscriptionId, sub!.id));
  return all.find((r) => r.price === pricePublicId)?.cyclesBilled ?? null;
}

/** A customer with a good card, and a subscription on the monthly plan. */
async function setup(email: string, quantity: number) {
  const cus = await tmb.customers.create(biz.id, { email });
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4242" });
  const sub = await tmb.subscriptions.create(biz.id, cus.id, {
    items: [{ price: planMonthly.id, quantity }],
  });
  return { cus, sub };
}

/**
 * THE INVARIANT. Given the state before a quantity DECREASE and the state after,
 * exactly one of two things may be true. Anything else — most importantly "the
 * quantity went down and no credit note appeared" — is a failure.
 */
function assertDowngradeOutcome(
  label: string,
  before: Awaited<ReturnType<typeof subState>>,
  after: Awaited<ReturnType<typeof subState>>,
  err: TmbillingError | null,
  priceId: string,
) {
  const applied = after.qtyOf(priceId) !== before.qtyOf(priceId);
  const credited = after.creditNotes.length > before.creditNotes.length;
  if (err) {
    ok(`${label}: refused with a 4xx (got ${err.status})`, err.status >= 400 && err.status < 500);
    ok(`${label}: refusal left the quantity UNCHANGED`, !applied);
    ok(`${label}: refusal issued no credit note`, !credited);
    ok(`${label}: refusal raised no invoice`, after.invoices.length === before.invoices.length);
    ok(`${label}: refusal left cached mrr UNCHANGED`, after.mrr === before.mrr);
  } else {
    ok(`${label}: applied the quantity decrease`, applied);
    ok(`${label}: applied WITH a credit note`, credited);
  }
  // The one outcome the old code produced and that must never come back.
  ok(`${label}: NEVER committed without its credit`, !(applied && !credited));
}

/**
 * THE SAME INVARIANT, for `DELETE …/items/:id`. A removal owes the customer the
 * unused time on the item, so exactly one of two things may be true. Anything else
 * — most importantly "the item is gone and no credit note appeared" — is a failure.
 */
function assertRemovalOutcome(
  label: string,
  before: Awaited<ReturnType<typeof subState>>,
  after: Awaited<ReturnType<typeof subState>>,
  err: TmbillingError | null,
  priceId: string,
) {
  const removed = before.qtyOf(priceId) !== null && after.qtyOf(priceId) === null;
  const credited = after.creditNotes.length > before.creditNotes.length;
  // ── WHAT "SETTLED" MEANS (widened 2026-08-24, money bug on the CHARGE side) ────
  // A removal owes back the unused remainder of what the item cost. There are two
  // ways to hand that back, and which one applies is decided by whether the item's
  // charge was ever INVOICED:
  //   · invoiced      → a credit note, for the cash already collected. (`credited`)
  //   · still QUEUED  → cancel the pending `unbilled_charge` instead, so the renewal
  //                     never bills it. Nothing was collected, so there is nothing to
  //                     credit — and issuing a note anyway drew refundable CASH out of
  //                     some other invoice's payment while the queued charge stood.
  // Since 0109 deferral is the DEFAULT, so the second form is the common one; treating
  // it as "no credit issued" is what made this check fail on the corrected behaviour.
  const queuedCancelled = after.pendingUnbilledMinor < before.pendingUnbilledMinor;
  const settled = credited || queuedCancelled;
  if (err) {
    ok(`${label}: refused with a 4xx (got ${err.status})`, err.status >= 400 && err.status < 500);
    ok(`${label}: refusal left the ITEM in place`, !removed);
    ok(`${label}: refusal issued no credit note`, !credited);
    ok(`${label}: refusal left cached mrr UNCHANGED`, after.mrr === before.mrr);
    ok(
      `${label}: refusal wrote nothing (resource_version unmoved)`,
      after.resourceVersion === before.resourceVersion,
    );
  } else {
    ok(`${label}: removed the item`, removed);
    ok(`${label}: removed WITH the money it owed settled`, settled);
  }
  // The one outcome the old code produced and that must never come back.
  ok(
    `${label}: NEVER deleted the item leaving the money it owed unsettled`,
    !(removed && !settled),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A) A DOWNGRADE on a term billed across TWO invoices. A cheap add-on raises a
//    small proration invoice, which then becomes the "newest live invoice".
//
//    ── REWRITTEN 2026-08-24, and why ─────────────────────────────────────────
//    A1–A4 used to assert that this change was REFUSED ("Refundable credit 20000
//    exceeds refundable paid amount 500"), because the credit was booked against
//    that newest invoice and a full-unit term credit cannot come out of the 500 it
//    collected. That refusal was never right — it was the symptom of only ever
//    looking at ONE invoice. Once the refusal was softened (ad8c149 / 2f712ee /
//    df3ee5d) the same single-invoice view turned it into something worse: measured
//    2026-08-24, this change credited **500** against the ADD-ON's invoice and
//    silently dropped the other 19500 of a 20000 credit. No error, no log.
//
//    The rule is to credit the invoice that actually charged the thing, and where a
//    term spans several invoices to credit each of them from its own lines. On the
//    sibling removal shape (add-on 560/unit, qty 1 → invoice 2189 charged 560; scaled
//    to 40 → invoice 2190 charged the delta 21840): removing it produces CN-202 560.00
//    → 2189 (qty 1 × 560) and CN-203 21840.00 → 2190 (qty 39 × 560) — 22400 in total,
//    the full 40-unit term value, one note per invoice, each credited from its own
//    lines.
//
//    So this fixture now asserts the OUTCOME: the downgrade applies, the credit lands
//    on the PLAN's invoice, and every minor unit the customer is owed is credited.
//    The refusal half of the invariant did not disappear with it — it moved to J,
//    where a refusal that genuinely still exists proves the same "nothing was
//    written" property A4 was guarding.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { sub } = await setup("multi-invoice-downgrade@atomicity.test", 6);
  // `invoice_immediately: true` is REQUIRED, not decoration. This block needs the
  // add-on's proration to actually land as an invoice, because that small invoice is
  // what the credit must NOT be funded from. Migration 0109 flipped
  // `businesses.default_invoice_immediately` to false ("the safe default is to do
  // nothing extra"), and this fixture omitted the flag — so no second invoice was
  // raised, A0 failed, and A1–A4 fell over behind it. The engine was right the whole
  // time; the fixture was asserting against a default that changed under it, unnoticed
  // because this suite was outside verify:all.
  await tmb.subscriptions.addItem(biz.id, sub.id, {
    price: addonMonthly.id,
    quantity: 1,
    invoice_immediately: true,
  });
  const before = await subState(sub.id);
  ok(
    "A0 setup: two live invoices, the newest one small",
    before.invoices.length === 2 && before.invoices.some((i) => i.totalMinor <= 500n),
  );
  ok("A0 setup: plan quantity is 6", before.qtyOf(planMonthly.id) === 6);
  const planInvoice = before.invoices.find((i) => i.totalMinor === 120000n)!;
  const addonInvoice = before.invoices.find((i) => i.totalMinor === 500n)!;

  let err: TmbillingError | null = null;
  try {
    await tmb.subscriptions.change(biz.id, sub.id, {
      changes: [{ item: before.itemIdOf(planMonthly.id), quantity: 5 }],
      invoice_immediately: true,
    });
  } catch (e) {
    err = e as TmbillingError;
  }
  const after = await subState(sub.id);

  const credited = after.creditNotes.reduce((s, c) => s + c.totalMinor, 0n);
  const rebilled = after.invoices
    .filter((i) => !before.invoices.some((b) => b.id === i.id))
    .reduce((s, i) => s + i.totalMinor, 0n);
  console.log(
    `A multi-invoice downgrade: status=${err?.status ?? "none"} qty ${before.qtyOf(planMonthly.id)}→${after.qtyOf(planMonthly.id)} ` +
      `mrr ${before.mrr}→${after.mrr} credited=${credited} on [${after.creditNotes.map((c) => `${c.totalMinor}→${c.invoice}`).join(" ")}] rebilled=${rebilled}`,
  );
  ok("A1 the downgrade APPLIED (not refused)", err === null && after.qtyOf(planMonthly.id) === 5);
  ok(
    "A2 credited against the invoice that CHARGED THE PLAN",
    after.creditNotes.length > 0 && after.creditNotes.every((c) => c.invoice === planInvoice.id),
  );
  ok(
    "A3 nothing landed on the add-on's proration invoice",
    !after.creditNotes.some((c) => c.invoice === addonInvoice.id),
  );
  // ── SHAPE CHANGED 2026-09-01, MONEY DID NOT ─────────────────────────────────
  // This used to assert the GROSS shape — credit the whole old term (120000) and re-bill
  // the kept 5 units (100000). A same-price quantity DECREASE now emits one negative line
  // for the removed units only: unused service = plan price × unused QUANTITY × fraction,
  // so a qty 4→2 downgrade raises NO invoice and issues one credit note for the 2
  // removed units.
  //
  // So the DOCUMENTS moved and the customer's position did not: A5 below is unchanged and
  // is the assertion that actually guards the money (`credited − rebilled === 20000`, one
  // unit of unused time). What A4 exists to catch — the pre-fix 500, where only the newest
  // invoice's slice was credited — is still caught, because 500 ≠ 20000.
  ok(
    "A4 the removed unit is credited (20000), not the 500 the newest invoice held",
    credited === 20000n,
  );
  ok(
    "A5 the customer nets exactly one unit of unused time (120000 − 100000 = 20000)",
    credited - rebilled === 20000n,
  );
  assertDowngradeOutcome("A6", before, after, err, planMonthly.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// B) The same downgrade WITHOUT the small invoice in the way: it must succeed
//    and issue the credit — the other legal half of the invariant.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { sub } = await setup("credit@atomicity.test", 6);
  const before = await subState(sub.id);
  ok("B0 mrr starts at 6 × 20000", before.mrr === 120000n);

  let err: TmbillingError | null = null;
  // `credit_note` is on the wire (subscription-routes.ts) but not yet in the SDK's
  // declared response shape — read it structurally rather than widening the SDK here.
  let res: { credit_note?: { total_minor?: number } | null } | null = null;
  try {
    const raw = await tmb.subscriptions.change(biz.id, sub.id, {
      changes: [{ item: before.itemIdOf(planMonthly.id), quantity: 5 }],
      invoice_immediately: true,
    });
    res = raw as unknown as { credit_note?: { total_minor?: number } | null };
  } catch (e) {
    err = e as TmbillingError;
  }
  const after = await subState(sub.id);

  console.log(
    `B credited downgrade: err=${err?.status ?? "none"} qty ${before.qtyOf(planMonthly.id)}→${after.qtyOf(planMonthly.id)} cn=${res?.credit_note?.total_minor ?? "none"} mrr ${before.mrr}→${after.mrr}`,
  );
  ok("B1 the response reports the credit note", (res?.credit_note?.total_minor ?? 0) > 0);
  ok("B2 exactly one credit note exists", after.creditNotes.length === 1);
  assertDowngradeOutcome("B3", before, after, err, planMonthly.id);
  ok("B4 cached mrr followed the downgrade (5 × 20000)", after.mrr === 100000n);
}

// ─────────────────────────────────────────────────────────────────────────────
// C) The measured MRR bug: an UPGRADE (which has always returned 200) left the
//    cached column reporting the pre-change revenue.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { sub } = await setup("upgrade@atomicity.test", 5);
  const before = await subState(sub.id);
  ok("C0 mrr starts at 5 × 20000", before.mrr === 100000n);
  await tmb.subscriptions.change(biz.id, sub.id, {
    changes: [{ item: before.itemIdOf(planMonthly.id), quantity: 6 }],
    invoice_immediately: true,
  });
  const after = await subState(sub.id);
  console.log(
    `C upgrade: qty 5→${after.qtyOf(planMonthly.id)} mrr ${before.mrr}→${after.mrr} (want 120000)`,
  );
  ok("C1 quantity applied", after.qtyOf(planMonthly.id) === 6);
  ok("C2 cached mrr recomputed (6 × 20000)", after.mrr === 120000n);
}

// ─────────────────────────────────────────────────────────────────────────────
// D) A TERM-RESET / frequency change must recompute MRR too — the monthly
//    normalization changes, not just the amount (480000/yr = 40000/mo).
// ─────────────────────────────────────────────────────────────────────────────
{
  const { sub } = await setup("cadence@atomicity.test", 1);
  const before = await subState(sub.id);
  ok("D0 mrr starts at 20000/month", before.mrr === 20000n && before.billingPeriodUnit === "month");
  await tmb.subscriptions.change(biz.id, sub.id, {
    changes: [{ item: before.itemIdOf(planMonthly.id), price: planYearly.id }],
    invoice_immediately: true,
  });
  const after = await subState(sub.id);
  console.log(
    `D frequency change: unit ${before.billingPeriodUnit}→${after.billingPeriodUnit} mrr ${before.mrr}→${after.mrr} (want 40000)`,
  );
  ok("D1 cadence re-anchored to yearly", after.billingPeriodUnit === "year");
  ok("D2 cached mrr recomputed off the YEARLY snapshot (480000/12)", after.mrr === 40000n);
  ok("D3 the unused monthly term was credited", after.creditNotes.length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// E) A change that moves no money still keeps mrr honest (same quantity → the
//    money path short-circuits before either credit branch).
// ─────────────────────────────────────────────────────────────────────────────
{
  const { sub } = await setup("noop@atomicity.test", 3);
  const before = await subState(sub.id);
  await tmb.subscriptions.change(biz.id, sub.id, {
    changes: [{ item: before.itemIdOf(planMonthly.id), quantity: 3 }],
    invoice_immediately: true,
  });
  const after = await subState(sub.id);
  ok("E1 zero-net change leaves mrr at 3 × 20000", after.mrr === 60000n);
  ok("E2 zero-net change raises no credit note", after.creditNotes.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// F) THE REMOVAL HOLE — an item billed across TWO invoices. The add-on is charged
//    at qty 1 on its own invoice (500), then scaled to qty 40, whose invoice
//    collects only the DELTA (20000 charged − 500 unused = 19500). The item is now
//    worth a full term of 40 × 500 = 20000, and removing it owes all of it.
//
//    ── REWRITTEN 2026-08-24, and why ─────────────────────────────────────────
//    F1–F3 used to assert a REFUSAL: 20000 owed against 19500 of refundable cash on
//    the one invoice the credit targeted → "exceeds refundable paid amount". Loud,
//    but it blocked a removal the customer is entitled to. After ad8c149 / 2f712ee /
//    df3ee5d the same single-invoice view produced the silent version instead:
//    measured 2026-08-24, ONE credit note for 19500 and 500 of the customer's money
//    kept, with no error and no log.
//
//    The removal applies and issues one note PER INVOICE, each credited from its own
//    lines. With an add-on at 560/unit, qty 1 → invoice 2189 charged 560; scaled to 40
//    → invoice 2190 charged the delta 21840; removal owed 22400 against a
//    largest-single-invoice cash of 21840:
//        CN-202     560.00  → invoice 2189, line qty  1 × 560
//        CN-203  21840.00  → invoice 2190, line qty 39 × 560
//        sum     22400.00  = the full 40-unit term value
//    Not a refusal, and not one capped note. So this fixture asserts that outcome.
//
//    `invoice_immediately: true` on the ADD is load-bearing: without it the first 500
//    is never invoiced at all (it sits as a pending unbilled charge), so the term is
//    billed across ONE invoice and the scenario this fixture describes — an item
//    charged on two invoices — is not reproduced.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { sub } = await setup("remove-multi-invoice@atomicity.test", 1);
  await tmb.subscriptions.addItem(biz.id, sub.id, {
    price: addonMonthly.id,
    quantity: 1,
    invoice_immediately: true,
  });
  const mid = await subState(sub.id);
  await tmb.subscriptions.change(biz.id, sub.id, {
    changes: [{ item: mid.itemIdOf(addonMonthly.id), quantity: 40 }],
    invoice_immediately: true,
  });
  const before = await subState(sub.id);
  ok("F0 setup: the add-on is on the subscription at qty 40", before.qtyOf(addonMonthly.id) === 40);
  ok(
    "F0 setup: it was charged 500 on one invoice…",
    before.invoices.some((i) => i.totalMinor === 500n),
  );
  ok(
    "F0 setup: …and only the 19500 DELTA on another",
    before.invoices.some((i) => i.totalMinor === 19500n),
  );
  ok("F0 setup: no credit note yet", before.creditNotes.length === 0);
  const firstInvoice = before.invoices.find((i) => i.totalMinor === 500n)!;
  const deltaInvoice = before.invoices.find((i) => i.totalMinor === 19500n)!;

  let err: TmbillingError | null = null;
  try {
    await tmb.subscriptions.removeItem(biz.id, sub.id, before.itemIdOf(addonMonthly.id));
  } catch (e) {
    err = e as TmbillingError;
  }
  const after = await subState(sub.id);

  const credited = after.creditNotes.reduce((s, c) => s + c.totalMinor, 0n);
  console.log(
    `F multi-invoice removal: status=${err?.status ?? "none"} item ${before.qtyOf(addonMonthly.id)}→${after.qtyOf(addonMonthly.id)} ` +
      `mrr ${before.mrr}→${after.mrr} credited=${credited} on [${after.creditNotes.map((c) => `${c.totalMinor}→${c.invoice}`).join(" ")}] (want 20000 over 2 notes)`,
  );
  ok("F1 the removal APPLIED (not refused)", err === null && after.qtyOf(addonMonthly.id) === null);
  ok(
    "F2 credited in FULL — 40 × 500 = 20000, not the 19500 one invoice could fund",
    credited === 20000n,
  );
  ok("F3 the credit SPANS both charging invoices — one note each", after.creditNotes.length === 2);
  ok(
    "F3 the first invoice is credited its own 500",
    after.creditNotes.some((c) => c.invoice === firstInvoice.id && c.totalMinor === 500n),
  );
  ok(
    "F3 the delta invoice is credited its own 19500",
    after.creditNotes.some((c) => c.invoice === deltaInvoice.id && c.totalMinor === 19500n),
  );
  assertRemovalOutcome("F4", before, after, err, addonMonthly.id);
  ok("F5 cached mrr dropped back to the plan alone", after.mrr === 20000n);
}

// ─────────────────────────────────────────────────────────────────────────────
// G) The other legal half: a removal whose credit FITS must still remove the item,
//    issue the credit note, and drop the cached MRR (regression guard on the fix).
// ─────────────────────────────────────────────────────────────────────────────
{
  const { sub } = await setup("remove-ok@atomicity.test", 1);
  await tmb.subscriptions.addItem(biz.id, sub.id, { price: addonMonthly.id, quantity: 1 });
  const before = await subState(sub.id);
  ok("G0 mrr includes the add-on (20000 + 500)", before.mrr === 20500n);

  let err: TmbillingError | null = null;
  try {
    await tmb.subscriptions.removeItem(biz.id, sub.id, before.itemIdOf(addonMonthly.id));
  } catch (e) {
    err = e as TmbillingError;
  }
  const after = await subState(sub.id);
  console.log(
    `G credited removal: err=${err?.status ?? "none"} mrr ${before.mrr}→${after.mrr} cns ${before.creditNotes.length}→${after.creditNotes.length} queued ${before.pendingUnbilledMinor}→${after.pendingUnbilledMinor}`,
  );
  assertRemovalOutcome("G1", before, after, err, addonMonthly.id);
  // ── G2 MOVED, 2026-08-24 (money bug on the CHARGE side of a removal) ───────────
  // This add carries no `invoice_immediately`, and 0109 made deferral the DEFAULT, so
  // the add-on's 500 was never invoiced — it was QUEUED as a pending `unbilled_charge`
  // for the rest of the term, to be folded into the next renewal.
  //
  // The old expectation ("a credit note for the add-on term value, 500") was asserting
  // the defect. Removing the item left that queued 500 pending, so the NEXT RENEWAL
  // still billed the customer 500 for an add-on removed the same instant, and the 500
  // credit note it did issue was a REFUNDABLE note against the PLAN's invoice — cash the
  // customer could withdraw, drawn from a payment that never charged the add-on. The two
  // happened to cancel on paper, and stopped cancelling as soon as either half moved
  // (probe scenarios C and D: 212.90 and 112.90 over-billed).
  //
  // The corrected settlement: the queued 500 is cancelled, and no note is issued because
  // no money was ever taken. Same net (the customer pays 0 for an add-on held 0 days),
  // reached by not charging rather than by charging and refunding.
  ok(
    "G2 the queued 500 was cancelled, not left to bill at renewal",
    before.pendingUnbilledMinor - after.pendingUnbilledMinor === 500n,
  );
  ok(
    "G2 nothing was ever invoiced for it, so no credit note is owed",
    after.creditNotes.length === before.creditNotes.length,
  );
  ok("G3 cached mrr dropped back to the plan alone", after.mrr === 20000n);
}

// ─────────────────────────────────────────────────────────────────────────────
// H) A TERM RESET must not re-charge — nor credit — an already-paid ONE-TIME fee.
//    The reset branch charged the FULL new-term price for EVERY post-change item
//    and credited "unused time" on every one of them, both loops keyed on nothing
//    but "is this an item". A `one_time` setup fee is neither: it was already
//    invoiced and paid, and it never bought a span of time to have a remainder of.
//    So a plain monthly→yearly swap re-charged a 3000 fee the customer had paid at
//    signup AND handed back 3000 of "unused" fee — two wrong money lines from one
//    plan change.
//
//    Numbers: signup invoice 23000 (20000 plan + 3000 fee, paid). Swap to the
//    yearly plan (480000) on the same day ⇒ term reset.
//      before: reset invoice 483000 (480000 + the fee AGAIN), credit note 23000
//      after:  reset invoice 480000,                          credit note 20000
//    The recurring plan's own charge and credit are identical either way — that is
//    the control: the fix must remove the fee's two lines and touch nothing else.
// ─────────────────────────────────────────────────────────────────────────────
{
  const cus = await tmb.customers.create(biz.id, { email: "onetime-reset@atomicity.test" });
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4242" });
  const sub = await tmb.subscriptions.create(biz.id, cus.id, {
    items: [
      { price: planMonthly.id, quantity: 1 },
      { price: setupFee.id, quantity: 1 },
    ],
  });
  const before = await subState(sub.id);
  const signupLines = await linesOf(before.invoices[0]!.id);
  ok(
    "H0 setup: the signup invoice billed plan + fee (20000 + 3000)",
    before.invoices.length === 1 && before.invoices[0]!.totalMinor === 23000n,
  );
  ok(
    "H0 setup: the fee is a subscription ITEM, billed on that invoice",
    before.qtyOf(setupFee.id) === 1 &&
      signupLines.some((l) => l.price === setupFee.id && l.amountMinor === 3000n),
  );
  ok(
    "H0 setup: the fee records its one consumed cycle",
    (await cyclesBilledOf(sub.id, setupFee.id)) === 1,
  );

  await tmb.subscriptions.change(biz.id, sub.id, {
    changes: [{ item: before.itemIdOf(planMonthly.id), price: planYearly.id }],
    invoice_immediately: true,
  });
  const after = await subState(sub.id);
  const resetInvoice = after.invoices.find((i) => !before.invoices.some((b) => b.id === i.id))!;
  const resetLines = await linesOf(resetInvoice.id);
  const cn = after.creditNotes[0] ?? null;
  console.log(
    `H term reset: invoice=${Number(resetInvoice.totalMinor)} lines=[${resetLines.map((l) => `${l.price ?? "-"}:${Number(l.amountMinor)}`).join(" ")}] ` +
      `credit=${cn ? Number(cn.totalMinor) : "none"} (want invoice 480000 / credit 20000; bug was 483000 / 23000)`,
  );
  ok(
    "H1 the reset charges the new yearly plan in full (480000)",
    resetLines.some((l) => l.price === planYearly.id && l.amountMinor === 480000n),
  );
  ok(
    "H2 the reset does NOT re-charge the already-paid one-time fee",
    !resetLines.some((l) => l.price === setupFee.id),
  );
  ok(
    "H3 the reset invoice total is the plan alone (480000, not 483000)",
    resetInvoice.totalMinor === 480000n,
  );
  ok(
    "H4 the unused-time credit is the monthly plan alone (20000, not 23000)",
    after.creditNotes.length === 1 && cn!.totalMinor === 20000n,
  );
  ok(
    "H5 the fee ITEM is still attached (not re-charged ≠ removed)",
    after.qtyOf(setupFee.id) === 1,
  );
  ok(
    "H6 the fee still records exactly ONE consumed cycle",
    (await cyclesBilledOf(sub.id, setupFee.id)) === 1,
  );
  ok(
    "H7 the plan item swapped to yearly",
    after.qtyOf(planYearly.id) === 1 && after.billingPeriodUnit === "year",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// I) THE CONTROL for H, so the fix cannot over-reach into "never charge a one-time
//    item on a reset". The skip is keyed on the CAP BOOKKEEPING — the same
//    `billing_cycles ?? (one_time → 1)` vs `cycles_billed` rule the period planner
//    uses — not on the price type alone. An attached-but-never-billed fee (a signup
//    that deferred its first invoice) has consumed no cycle, so a term reset still
//    owes it in FULL, and must record the cycle it consumes or the next renewal
//    bills it a second time.
//
//    `cycles_billed` is reset to 0 directly here to reproduce that state without a
//    deferred-signup fixture; it is exactly the state such a signup leaves behind.
// ─────────────────────────────────────────────────────────────────────────────
{
  const cus = await tmb.customers.create(biz.id, {
    email: "onetime-unbilled-reset@atomicity.test",
  });
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4242" });
  const sub = await tmb.subscriptions.create(biz.id, cus.id, {
    items: [
      { price: planMonthly.id, quantity: 1 },
      { price: setupFee.id, quantity: 1 },
    ],
  });
  await withTenant(org.organization.id, async (tx) => {
    const [subRow] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.publicId, sub.id))
      .limit(1);
    const [feePrice] = await tx
      .select({ id: prices.id })
      .from(prices)
      .where(eq(prices.publicId, setupFee.id))
      .limit(1);
    await tx
      .update(subscriptionItems)
      .set({ cyclesBilled: 0 })
      .where(
        and(
          eq(subscriptionItems.subscriptionId, subRow!.id),
          eq(subscriptionItems.priceId, feePrice!.id),
        ),
      );
  });
  ok(
    "I0 setup: the fee item now shows no consumed cycle",
    (await cyclesBilledOf(sub.id, setupFee.id)) === 0,
  );

  const before = await subState(sub.id);
  await tmb.subscriptions.change(biz.id, sub.id, {
    changes: [{ item: before.itemIdOf(planMonthly.id), price: planYearly.id }],
    invoice_immediately: true,
  });
  const after = await subState(sub.id);
  const resetInvoice = after.invoices.find((i) => !before.invoices.some((b) => b.id === i.id))!;
  const resetLines = await linesOf(resetInvoice.id);
  console.log(
    `I unbilled fee on reset: invoice=${Number(resetInvoice.totalMinor)} lines=[${resetLines.map((l) => `${l.price ?? "-"}:${Number(l.amountMinor)}`).join(" ")}] ` +
      `fee cycles_billed=${await cyclesBilledOf(sub.id, setupFee.id)} (want 483000 and 1)`,
  );
  ok(
    "I1 an UNBILLED one-time fee IS charged in full by the reset (3000)",
    resetLines.some((l) => l.price === setupFee.id && l.amountMinor === 3000n),
  );
  ok("I2 the reset invoice is plan + fee (480000 + 3000)", resetInvoice.totalMinor === 483000n);
  ok(
    "I3 the fee is STILL not credited as unused time (plan alone, 20000)",
    after.creditNotes.length === 1 && after.creditNotes[0]!.totalMinor === 20000n,
  );
  ok(
    "I4 the reset recorded the cycle it consumed, so no renewal re-bills it",
    (await cyclesBilledOf(sub.id, setupFee.id)) === 1,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// J) THE REFUSAL HALF OF THE INVARIANT — kept alive on a refusal that still exists.
//
//    A and F used to be the suite's refused-removal cases, and the property they
//    really guarded was not the refusal itself but what a refusal must leave behind:
//    the original bug was a 500 arriving with the item ALREADY DELETED and nothing
//    credited. That property is unchanged and still binary — a removal either
//    succeeds AND credits, or fails with a 4xx having written NOTHING — so it is
//    asserted here against a refusal the engine still owes: a MANDATORY add-on cannot
//    be detached (CAT-3).
//
//    `assertRemovalOutcome`'s refusal branch runs in full, `resource_version` included:
//    without it the branch would be dead code and "a removal that fails leaves the
//    subscription byte-for-byte unchanged" would be asserted nowhere in this suite.
// ─────────────────────────────────────────────────────────────────────────────
{
  // Its own add-on product, so making it mandatory cannot leak into A–I above.
  const lockedProduct = await tmb.products.create(biz.id, {
    name: "Required connector",
    kind: "addon",
  });
  const lockedPrice = await tmb.prices.create(biz.id, {
    product: lockedProduct.id,
    model: "per_unit",
    currency: "USD",
    type: "recurring",
    amount_minor: 700,
    interval: "month",
  });
  await tmb.products.setApplicablePlans(biz.id, lockedProduct.id, [planProduct.id], {
    [planProduct.id]: "mandatory",
  });

  const { sub } = await setup("mandatory@atomicity.test", 2);
  const before = await subState(sub.id);
  ok("J0 setup: the mandatory add-on was auto-included", before.qtyOf(lockedPrice.id) !== null);

  let err: TmbillingError | null = null;
  try {
    await tmb.subscriptions.removeItem(biz.id, sub.id, before.itemIdOf(lockedPrice.id));
  } catch (e) {
    err = e as TmbillingError;
  }
  const after = await subState(sub.id);

  console.log(
    `J refused removal: status=${err?.status ?? "none"} type=${err?.type ?? "-"} item ${before.qtyOf(lockedPrice.id)}→${after.qtyOf(lockedPrice.id)} rv ${before.resourceVersion}→${after.resourceVersion}`,
  );
  ok("J1 refused with a 400, not a 500", err instanceof TmbillingError && err.status === 400);
  ok("J2 the refusal carries the real reason", !!err?.message.includes("mandatory add-on"));
  ok("J3 error type is a validation error", err?.type === "invalid_request_error");
  assertRemovalOutcome("J4", before, after, err, lockedPrice.id);
}

let pass = true;
console.log("");
for (const [name, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${name}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ CHANGE ATOMICITY: PASS" : "❌ CHANGE ATOMICITY: FAIL");
await app.close();
await closeDb();
process.exit(pass ? 0 : 1);
