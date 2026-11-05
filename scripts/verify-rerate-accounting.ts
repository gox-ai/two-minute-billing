/**
 * PROBE: across every change shape, does a differential add-on's RE-RATE get accounted for
 * somewhere — and does removing the item afterwards leave the customer's net position at
 * exactly what they owe for the time they actually held it?
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────
 * `docs/PROGRESS.md` (🔴 OPEN 2026-08-31) records that an unused-time credit is rated from
 * `subscription_items.price_snapshot`, which a plan change has already re-priced, and that
 * on `sub_XXXXXXXXXXXXXXXXXXXXXX02` this under-credited ₹16,920 (60 units credited at ₹470
 * against invoices billed at ₹752). The candidate fix — rate the credit off the newest
 * BILLED invoice line instead — was measured to OVER-credit in the deferred shape and was
 * reverted. So the question this probe settles is the one the fix depends on: **is the
 * snapshot basis wrong, or is it right whenever the change accounted for its own re-rate?**
 *
 * ── THE INVARIANT IT CHECKS ─────────────────────────────────────────────────────
 * For the add-on's price alone, across every document:
 *
 *   NET = Σ invoice-line amounts (incl. proration and negative lines)
 *       + Σ still-PENDING unbilled charges          ← money queued, not yet invoiced
 *       − Σ credit-note items                      ← money handed back
 *
 * must equal what the customer owes for the time they held it, rated at whatever rate was
 * in force over each span:  Σ over segments  rate × qty × (segment ÷ term).
 *
 * That is shape-independent: it does not care WHICH document carries the money, only that
 * the arithmetic closes. It is the test the "rate it from the billed line" candidate needed
 * and never got.
 *
 * ── WHAT IT ESTABLISHED (2026-09-01) ───────────────────────────────────────────
 *
 * **(a) The snapshot basis is NOT the defect, and the "obvious fix" would have created one.**
 * Eleven of the twelve shapes below close to the paisa against the current basis. In
 * particular:
 *
 *   · IMMEDIATE downgrade (S1/S3) — the change credits the old term at ₹752 and re-charges
 *     forward at ₹470, so the customer HOLDS ₹470-worth of remaining time and the removal's
 *     credit at the moved snapshot is right. Rating it off the ₹752 billed line over-credits.
 *   · DEFERRED downgrade (S2/S4) — the change queues BOTH halves as unbilled charges,
 *     −₹45,120 and +₹28,200. `settleQueued` therefore returns a NEGATIVE clawback and
 *     `credit − dropped` = ₹28,200 − (−₹16,920) = ₹45,120, the full invoiced amount. The
 *     billed-line basis gives ₹45,120 + ₹16,920 = ₹62,040 — the exact over-credit PROGRESS
 *     reported. It was never a sign error: the basis and the queue term must be rated at the
 *     same rate for the subtraction to mean anything, and the snapshot is what makes that so.
 *   · UPGRADE direction, TERM RESET (both invoicing options), a quantity move in the same
 *     call, a 752→470→752 round trip, and a change that survives a RENEWAL — all close.
 *
 * So the ₹16,920 loss recorded on `sub_XXXXXXXXXXXXXXXXXXXXXX02` is not live behaviour: it is
 * residue of the era before F-17's "AND BILL THE MOVE" block (2026-08-28) and before the reset
 * charge loop read `rerated` (2026-08-31). Changing the basis now would introduce the loss
 * rather than close it. `scripts/probe-settle-queued-semantics.ts` is the companion that
 * establishes the queue term this argument rests on.
 *
 * **(b) But looking for that, S4 found a DIFFERENT live money bug, and it is fixed.** On a
 * deferred downgrade whose add-on is removed ten days later, the queue held
 * `-30080.00 "Unused time on …"` and `+18800.00 "Remaining time on …"`. The removal re-cut
 * both, re-queued the `+9400.00` survivor and DROPPED the `-15040.00` one, because
 * `applyUnbilledChargeSettlements` re-queued a slice only `if (keptMinor > 0n)` — an
 * assumption that queued rows are charges. Net booked ₹86,198.01 against ₹71,158.00 owed:
 * **₹15,040 over-billed**, silently, named by no document. The skip is now exactly zero
 * (proration.ts, `applyUnbilledChargeSettlements`), S4 closes at ₹71,158.00 against
 * ₹71,158.00, and no other scenario moved except S2, which went from 1 paisa out to exact.
 *
 * The bug needs all three of: a change deferred (`invoice_immediately: false`), netting
 * POSITIVE (so the credit lines stay in `billableLines` and are queued rather than turned into
 * a credit note), and the item settled STRICTLY INSIDE the queued window (a mid-term removal
 * or quantity cut, not one at the boundary — S2 removes at the boundary and never saw it).
 *
 *   pnpm db:scratch --name creditrate -- pnpm tsx scripts/verify-rerate-accounting.ts
 *
 * Creates its OWN organization. Reads DATABASE_URL. No resets, no seeds.
 */
import { and, eq, inArray } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, setDifferentialPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { renewSubscription } from "@/modules/subscriptions/renewal";
import { removeSubscriptionItem } from "@/modules/subscriptions/items";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  creditNoteItems,
  creditNotes,
  invoiceLineItems,
  invoices,
  subscriptionItems,
  subscriptions,
  unbilledCharges,
} from "@db/schema";

const R = (m: bigint | number | null | undefined) => (Number(m ?? 0) / 100).toFixed(2);
const DAY = 24 * 60 * 60 * 1000;
const QTY = 60;
const PRO_RATE = 75200n;
const BUS_RATE = 47000n;
const PLAN_PRO = 2791800n;
const PLAN_BUS = 5611800n;
/** prorate's half-up rounding can land a two-sided split 1 minor unit out. */
const TOLERANCE = 100n;

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const org = await createOrganization({ name: `RerateSweep ${Date.now()}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "RS",
  defaultCurrency: "INR",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };

const plan = async (name: string, amountMinor: number) => {
  const product = await createProduct({ ...ctx, name, kind: "plan" });
  const price = await createPrice({
    ...ctx,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor,
    interval: "month",
  });
  return { product, price };
};
const PRO = await plan("PRO", Number(PLAN_PRO));
const BUS = await plan("BUSINESS", Number(PLAN_BUS));
// The defect's shape: catalog list price 0, the real rate living in the differential table.
const connProduct = await createProduct({ ...ctx, name: "Additional Connections", kind: "addon" });
const CONN = await createPrice({
  ...ctx,
  productId: connProduct.id,
  type: "recurring",
  model: "per_unit",
  currency: "INR",
  amountMinor: 0,
  interval: "month",
});
for (const [p, amountMinor] of [
  [PRO, Number(PRO_RATE)],
  [BUS, Number(BUS_RATE)],
] as const)
  await setDifferentialPrice({
    ...ctx,
    addonPublicId: connProduct.publicId,
    planPublicId: p.product.publicId,
    currency: "INR",
    interval: "month",
    amountMinor,
  });

/**
 * Every money figure booked on the subscription, with its sign — ALL prices, no
 * per-price attribution.
 *
 * Deliberately whole-subscription. Attributing a credit-note item to one price is not
 * always possible: on a `net < 0` change that cannot be grossed (the deferred shape, and
 * any shape where the term invoice cannot absorb the gross credit) the engine issues ONE
 * lump item "Prorated credit for subscription change" carrying no price at all — see the
 * `grossed` branch in proration.ts. A per-price sweep silently misses that lump and reports
 * a divergence that is its own blind spot, which is exactly what the first run of this probe
 * did. Summing everything cannot miss it.
 */
async function netForSubscription(subscriptionId: string, customerId: string) {
  return withTenant(orgId, async (tx) => {
    const invs = await tx
      .select({ id: invoices.id, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.subscriptionId, subscriptionId));
    const live = invs.filter((i) => i.status !== "voided");
    const lines = live.length
      ? await tx
          .select({
            amount: invoiceLineItems.amountMinor,
            unit: invoiceLineItems.unitAmountMinor,
            kind: invoiceLineItems.kind,
            desc: invoiceLineItems.description,
          })
          .from(invoiceLineItems)
          .where(
            inArray(
              invoiceLineItems.invoiceId,
              live.map((i) => i.id),
            ),
          )
      : [];
    const queued = await tx
      .select()
      .from(unbilledCharges)
      .where(
        and(
          eq(unbilledCharges.subscriptionId, subscriptionId),
          eq(unbilledCharges.status, "pending"),
        ),
      );
    const notes = await tx
      .select({ id: creditNotes.id, status: creditNotes.status })
      .from(creditNotes)
      .where(eq(creditNotes.customerId, customerId));
    const liveNotes = notes.filter((n) => n.status !== "voided");
    const cnItems = liveNotes.length
      ? await tx
          .select({
            amount: creditNoteItems.amountMinor,
            desc: creditNoteItems.description,
          })
          .from(creditNoteItems)
          .where(
            inArray(
              creditNoteItems.creditNoteId,
              liveNotes.map((n) => n.id),
            ),
          )
      : [];
    // No tax is configured in this fixture, so a tax row would be a fixture bug, not a
    // figure to net; excluded explicitly so it can never be mistaken for supply money.
    const supply = cnItems.filter((i) => !/tax/i.test(i.desc ?? ""));
    const invSum = lines.reduce((s, l) => s + l.amount, 0n);
    const queuedSum = queued.reduce((s, q) => s + q.amountMinor, 0n);
    const cnSum = supply.reduce((s, i) => s + i.amount, 0n);
    if (process.env.SWEEP_VERBOSE) {
      for (const l of lines)
        console.log(`      inv   [${l.kind}] unit=${R(l.unit)} amt=${R(l.amount)} "${l.desc}"`);
      for (const q of queued) console.log(`      queue ${R(q.amountMinor)} "${q.description}"`);
      for (const i of supply) console.log(`      CN    ${R(i.amount)} "${i.desc}"`);
    }
    return { invSum, queuedSum, cnSum, net: invSum + queuedSum - cnSum };
  });
}

/** The rate in force over one span, and the term it falls in. */
type Segment = {
  rate: bigint;
  qty: number;
  from: Date;
  to: Date;
  term: { start: Date; end: Date };
};
const owedFor = (segments: Segment[]) =>
  segments.reduce((sum, s) => {
    const termMs = BigInt(s.term.end.getTime() - s.term.start.getTime());
    const heldMs = BigInt(Math.max(0, s.to.getTime() - s.from.getTime()));
    if (termMs <= 0n || heldMs <= 0n) return sum;
    const full = s.rate * BigInt(s.qty);
    return sum + (full * heldMs + termMs / 2n) / termMs;
  }, 0n);

type Step =
  | {
      op: "change";
      to: "PRO" | "BUSINESS";
      atDay: number;
      invoiceImmediately?: boolean;
      prorate?: boolean;
      resetTerm?: boolean;
      /** Move the add-on's quantity in the SAME call (the CAT/F-17 interaction). */
      newQty?: number;
    }
  | { op: "renew" }
  | { op: "remove"; atDay: number };

async function scenario(
  label: string,
  startOn: "PRO" | "BUSINESS",
  steps: Step[],
  /**
   * Why this scenario's booked position is EXPECTED to differ from "owed for time held",
   * for the one shape where that model does not apply. Printed instead of asserted.
   */
  expectedDivergence?: string,
  /**
   * ASSERT against a MULTIPLE of what is owed instead of against `owed` itself.
   *
   * For the one shape that deliberately bills more than the time held is worth (S13).
   * Exempting it the way S7 is exempted would leave a double charge unmeasured, and an
   * unasserted scenario is decoration; a multiple keeps it pinned to a number that has
   * to keep coming out right. Expressed as a multiple rather than an absolute so it
   * survives proration to the second.
   */
  expectedTimesOwed?: bigint,
) {
  console.log(`\n╔═ ${label}`);
  const customer = await createCustomer({
    ...ctx,
    email: `rs-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`,
  });
  // A renewal with no card is CANCELLED at the boundary, which ends the fixture instead of
  // testing it (measured: S12's first run logged `renewal_no_card_cancel`).
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const startPlan = startOn === "PRO" ? PRO : BUS;
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: startPlan.price, quantity: 1 },
      { price: CONN, quantity: QTY },
    ],
  });
  let term = { start: subscription.currentPeriodStart!, end: subscription.currentPeriodEnd! };
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: term.start,
    periodEnd: term.end,
  });

  const reload = () =>
    withTenant(orgId, async (tx) => {
      const [s] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subscription.id));
      return s!;
    });
  const connItemPublicId = () =>
    withTenant(orgId, async (tx) => {
      const [r] = await tx
        .select({ pub: subscriptionItems.publicId })
        .from(subscriptionItems)
        .where(
          and(
            eq(subscriptionItems.subscriptionId, subscription.id),
            eq(subscriptionItems.priceId, CONN.id),
          ),
        );
      return r?.pub ?? null;
    });
  const planItemPublicId = () =>
    withTenant(orgId, async (tx) => {
      const rows = await tx
        .select({ pub: subscriptionItems.publicId, priceId: subscriptionItems.priceId })
        .from(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, subscription.id));
      return rows.find((r) => r.priceId === PRO.price.id || r.priceId === BUS.price.id)!.pub;
    });

  const day0 = term.start;
  // TWO items are in play and both are re-priced by a plan change, so both are tracked:
  // the plan line itself and the differential add-on. Whole-subscription accounting needs
  // whole-subscription expectations.
  let planRate = startOn === "PRO" ? PLAN_PRO : PLAN_BUS;
  let addonRate = startOn === "PRO" ? PRO_RATE : BUS_RATE;
  let qty = QTY;
  let cursor = term.start;
  const segments: Segment[] = [];
  let addonRemoved = false;
  /** Close both items' spans at `to`, then reopen them at whatever rate now applies. */
  const closeSegment = (to: Date, opts: { addon?: boolean } = {}) => {
    segments.push({ rate: planRate, qty: 1, from: cursor, to, term: { ...term } });
    if (!addonRemoved && opts.addon !== false)
      segments.push({ rate: addonRate, qty, from: cursor, to, term: { ...term } });
  };

  for (const step of steps) {
    if (step.op === "renew") {
      const s = await reload();
      closeSegment(s.currentPeriodEnd!);
      await renewSubscription(orgId, subscription.id, s.currentPeriodEnd!);
      const after = await reload();
      term = { start: after.currentPeriodStart!, end: after.currentPeriodEnd! };
      cursor = term.start;
      continue;
    }
    const at = new Date(day0.getTime() + step.atDay * DAY);
    if (step.op === "remove") {
      closeSegment(at);
      await removeSubscriptionItem({
        ...ctx,
        subscriptionId: subscription.id,
        itemPublicId: (await connItemPublicId())!,
        now: at,
      });
      addonRemoved = true;
      cursor = at;
      continue;
    }
    // A change: close both items' spans, then reopen at the new contracted rates.
    closeSegment(at);
    const target = step.to === "PRO" ? PRO : BUS;
    const changes: Array<{ itemId: string; newPriceId?: string; quantity?: number }> = [
      { itemId: await planItemPublicId(), newPriceId: target.price.publicId },
    ];
    if (step.newQty != null)
      changes.push({ itemId: (await connItemPublicId())!, quantity: step.newQty });
    await changeSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      now: at,
      changes,
      invoiceImmediately: step.invoiceImmediately ?? true,
      prorate: step.prorate,
      resetTerm: step.resetTerm,
    });
    const after = await reload();
    if (process.env.SWEEP_VERBOSE) {
      console.log(`  ── state after the change to ${step.to} at day ${step.atDay}`);
      await netForSubscription(subscription.id, customer.id);
    }
    term = { start: after.currentPeriodStart!, end: after.currentPeriodEnd! };
    planRate = step.to === "PRO" ? PLAN_PRO : PLAN_BUS;
    addonRate = step.to === "PRO" ? PRO_RATE : BUS_RATE;
    if (step.newQty != null) qty = step.newQty;
    cursor = step.resetTerm ? term.start : at;
  }
  // Whatever is still held runs to the end of the term the subscription is in: the term
  // invoice already charged it, so it is owed.
  closeSegment(term.end);

  const snapshot = await withTenant(orgId, async (tx) => {
    const [r] = await tx
      .select({ snap: subscriptionItems.priceSnapshot })
      .from(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.subscriptionId, subscription.id),
          eq(subscriptionItems.priceId, CONN.id),
        ),
      );
    return (r?.snap as { amountMinor?: number | string } | null) ?? null;
  });
  if (snapshot) console.log(`  add-on snapshot now = ${R(Number(snapshot.amountMinor ?? 0))}`);

  const net = await netForSubscription(subscription.id, customer.id);
  const owed = owedFor(segments);
  console.log(
    `  booked: invoices ${R(net.invSum)} + queued ${R(net.queuedSum)} − credited ${R(net.cnSum)} = ${R(net.net)}`,
  );
  console.log(
    `  owed for time held (${segments.length} segment${segments.length === 1 ? "" : "s"}) = ${R(owed)}`,
  );
  const target = expectedTimesOwed != null ? owed * expectedTimesOwed : owed;
  const delta = net.net - target;
  if (expectedTimesOwed != null) {
    console.log(
      `  target = ${expectedTimesOwed}× owed = ${R(target)}  (deliberate, NOT the time-held model)`,
    );
  }
  if (expectedDivergence) {
    console.log(`  ⊘ not asserted — ${expectedDivergence} (off by ${R(delta)})`);
    return;
  }
  ok(
    expectedTimesOwed != null
      ? `the subscription's net booked position is ${expectedTimesOwed}× what it owes for the time held — deliberate`
      : "the subscription's net booked position equals what it owes for the time held",
    delta < 0n ? -delta <= TOLERANCE : delta <= TOLERANCE,
    `${R(net.net)} vs ${R(target)}${delta === 0n ? "" : ` (off by ${R(delta)})`}`,
  );
}

// ── The matrix. Every scenario ends by REMOVING the add-on, which is the operation whose
//    credit basis is under suspicion. ────────────────────────────────────────────────────
await scenario("S1  DOWNGRADE 752→470, immediate, removed the same instant", "PRO", [
  { op: "change", to: "BUSINESS", atDay: 0, invoiceImmediately: true },
  { op: "remove", atDay: 0 },
]);
await scenario("S2  DOWNGRADE, DEFERRED, removed the same instant", "PRO", [
  { op: "change", to: "BUSINESS", atDay: 0, invoiceImmediately: false },
  { op: "remove", atDay: 0 },
]);
await scenario("S3  DOWNGRADE at day 10, immediate, removed day 20", "PRO", [
  { op: "change", to: "BUSINESS", atDay: 10, invoiceImmediately: true },
  { op: "remove", atDay: 20 },
]);
await scenario("S4  DOWNGRADE at day 10, DEFERRED, removed day 20", "PRO", [
  { op: "change", to: "BUSINESS", atDay: 10, invoiceImmediately: false },
  { op: "remove", atDay: 20 },
]);
await scenario("S5  UPGRADE 470→752 at day 10, immediate, removed day 20", "BUSINESS", [
  { op: "change", to: "PRO", atDay: 10, invoiceImmediately: true },
  { op: "remove", atDay: 20 },
]);
await scenario("S6  UPGRADE at day 10, DEFERRED, removed day 20", "BUSINESS", [
  { op: "change", to: "PRO", atDay: 10, invoiceImmediately: false },
  { op: "remove", atDay: 20 },
]);
// `prorate: false` deliberately books NO prorated credit or charge for the plan swap
// (see the field's doc comment), so the customer keeps paying the old plan for the whole
// term and the time-held model cannot apply to the plan line. A residual is therefore
// EXPECTED here, and this scenario is not asserted.
//
// ── THE DIVERGENCE THIS USED TO RECORD IS FIXED (2026-09-01) ─────────────────────────
// The note here read: "the ADD-ON's F-17 re-rate pair is NOT suppressed by `prorate: false`
// — the block at proration.ts ~3475 carries no `prorate_` guard, so this run still booked
// `+₹18,800 Remaining time on Additional Connections` and credited `₹30,080 Unused time on
// …`. One flag, honoured on the plan and ignored on the add-on it re-prices." It was filed
// rather than fixed because which side is correct is a JUDGEMENT question, not an
// arithmetic one — both shapes balance.
//
// Settled by measurement, not by argument (2026-09-01): two identical subscriptions
// differing only in `prorate`. With `prorate=true` the change raised invoice 3193
// (BUSINESS ₹56,118 + connections ₹470) and CN-727 (PRO ₹27,918 + connections ₹752);
// with `prorate=false` it must raise NO invoice, NO credit note and no add-on line
// anywhere — the differential re-rate is suppressed along with everything else, so ours
// was the divergence and the guard is now in place.
//
// The residual moved with it: −₹18,800 before the guard, −₹7,520 after. Both are the
// unasserted plan-line gap this scenario exists to document, and the new figure is the
// honest one — the add-on's prorated pair is no longer inflating it.
await scenario(
  "S7  DOWNGRADE with prorate:FALSE, removed day 20",
  "PRO",
  [
    { op: "change", to: "BUSINESS", atDay: 10, invoiceImmediately: true, prorate: false },
    { op: "remove", atDay: 20 },
  ],
  "prorate:false suppresses the plan's proration by design, so 'owed for time held' is the wrong model for the plan line",
);
await scenario("S8  TERM RESET at day 0, immediate, removed day 10", "PRO", [
  { op: "change", to: "BUSINESS", atDay: 0, invoiceImmediately: true, resetTerm: true },
  { op: "remove", atDay: 10 },
]);
await scenario("S9  TERM RESET at day 0, DEFERRED, removed day 10", "PRO", [
  { op: "change", to: "BUSINESS", atDay: 0, invoiceImmediately: false, resetTerm: true },
  { op: "remove", atDay: 10 },
]);
await scenario("S10 ROUND TRIP 752→470→752 at days 5 and 15, removed day 25", "PRO", [
  { op: "change", to: "BUSINESS", atDay: 5, invoiceImmediately: true },
  { op: "change", to: "PRO", atDay: 15, invoiceImmediately: true },
  { op: "remove", atDay: 25 },
]);
await scenario("S11 DOWNGRADE at day 10 that also moves the add-on's QUANTITY 60→60", "PRO", [
  { op: "change", to: "BUSINESS", atDay: 10, invoiceImmediately: true, newQty: 60 },
  { op: "remove", atDay: 20 },
]);
await scenario("S12 DOWNGRADE day 5, then a RENEWAL, then removed 10 days into term 2", "PRO", [
  { op: "change", to: "BUSINESS", atDay: 5, invoiceImmediately: true },
  { op: "renew" },
  { op: "remove", atDay: 40 },
]);

/**
 * S13 — THE HOLE IN S7's EXEMPTION, and it is ASSERTED.
 *
 * S7 above is deliberately unasserted: `prorate: false` suppresses the plan's proration by
 * design, so "owed for time held" is the wrong model for a term the customer keeps paying the
 * old price for. That exemption is about the SUPPRESSED step. It does not extend to a later
 * PRORATED change, where the model applies again — and that sequence was missing from this
 * suite, which is why nothing here noticed the defect below.
 *
 * BOTH CHANGES AT DAY 0 ON PURPOSE. The suppressed segment then carries no time, so there is
 * no ambiguity about what the customer is owed for holding BUSINESS: nothing. They paid for a
 * PRO term, they hold PRO for that term, and the net booked must equal one PRO term. Any other
 * answer is money, in one direction or the other.
 *
 * MEASURED before the fix (`scripts/probe-prorate-false-then-prorated.ts`, plan-only, no tax):
 * step 2 issued an adjustment credit note for the WHOLE term invoice and raised no charge, so
 * the net was ZERO — a free term. The mechanism was `nonResetItemProration`'s `oldFullMinor`,
 * which reads `item.price_snapshot`: `prorate: false` had already moved that to BUSINESS, a
 * rate the customer was never invoiced at, so the credit was rated from it and then clamped by
 * the invoice's own capacity — landing, coincidentally, on exactly the term that was paid.
 *
 * ⚠️ THE FIX WAS NOT A CHANGE OF CREDIT BASIS. That candidate was measured and REVERTED (see
 * PROGRESS, "an unused-time credit is rated from a snapshot the plan change has already
 * moved") because the snapshot is right for every shape where the change bills its own
 * re-rate. `prorate: false` is the one change that moves the snapshot WITHOUT billing the
 * move — precisely the premise that resolution rests on — so the gate asks only WHETHER
 * anything ever charged that basis, and leaves the amount alone everywhere it did.
 *
 * ── AND THE TARGET IS 2× OWED, ON PURPOSE ────────────────────────────────────────────────
 * Nothing is credited for a composition that was never invoiced and the incoming one is
 * still charged prorated, so TWO terms are billed for one term of service, where the
 * honest answer is ONE. The double charge is deliberate, on the user's explicit
 * instruction.
 *
 * BOTH PATHS NOW AGREE, so this is ASSERTED at 2× owed rather than exempted like S7.
 *
 * It took two gates, because the defect had two homes and only one of them is price-shaped:
 *   · the PLAN's credit, rated from a snapshot the suppressed change moved — gated by
 *     `basisWasEverCharged` on the outgoing PRICE (61758.00 → 117876.00 here);
 *   · the ADD-ON's differential credit in the F-17 re-rate loop, worth 28200.00 = 470 × 60.
 *     A differential add-on keeps ONE price row and only its RATE moves, so the price-level
 *     question answers "charged" and cannot see it; matching a line's unit amount is unsafe
 *     because a prorated line carries a prorated unit and a false negative WITHHOLDS a credit
 *     the customer is owed. The gate is the PLAN instead: an add-on's differential is derived
 *     from the plan, so if the outgoing plan's price was never charged, no rate derived from
 *     it ever was.
 *
 * An unasserted scenario is decoration, and a deliberate double charge is exactly the thing
 * that must not drift unnoticed: if this number moves, one of the two paths changed.
 * Asserted at a MULTIPLE, not an absolute, so it survives proration to the second.
 */
await scenario(
  "S13 prorate:FALSE at day 0, then a PRORATED change BACK at day 0 (bills twice)",
  "PRO",
  [
    { op: "change", to: "BUSINESS", atDay: 0, invoiceImmediately: true, prorate: false },
    { op: "change", to: "PRO", atDay: 0, invoiceImmediately: true },
  ],
  undefined,
  2n,
);

console.log(
  `\n${failures === 0 ? "✅ RERATE ACCOUNTING SWEEP: PASS" : `❌ RERATE ACCOUNTING SWEEP: ${failures} FAILED`}`,
);
await closeDb();
process.exit(failures === 0 ? 0 : 1);
