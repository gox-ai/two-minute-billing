/**
 * Proration permutation matrix — covers the gaps the audit flagged:
 *  1. PLAN-SWAP (newPriceId) — supported but was never tested,
 *  2. timing boundaries: swap at 0% elapsed (full difference) and ~100% (≈0),
 *  3. tiered-price proration (computeLineAmount tiered inside proration),
 *  4. multi-item subscription: change one item, the other is untouched.
 *
 *   pnpm verify:proration-matrix
 */
import { desc, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, getSubscriptionItems } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  subscriptions,
  subscriptionItems,
  invoices,
  invoiceLineItems,
  creditNotes,
} from "@db/schema";

const org = await createOrganization({ name: "ProrationMatrix" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plans" });
const A = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
}); // $50
const B = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
}); // $100
const T = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "tiered",
  currency: "USD",
  interval: "month",
  tiers: [
    { upToMinor: 10, unitAmountMinor: 1000, flatAmountMinor: 0 },
    { upToMinor: null, unitAmountMinor: 500, flatAmountMinor: 0 },
  ],
});

async function mkSub(prices: Array<{ price: typeof A; quantity: number }>) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `m${Math.random()}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  return (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: prices,
    })
  ).subscription;
}
const midOf = (s: typeof subscriptions.$inferSelect) => {
  const ps = s.currentPeriodStart!.getTime(),
    pe = s.currentPeriodEnd!.getTime();
  return new Date(ps + Math.floor((pe - ps) / 2));
};
const near = (a: number | null | undefined, b: number, tol = 30) =>
  a != null && Math.abs(a - b) <= tol;
const checks: Array<[string, boolean]> = [];

// A plan SWAP is a TERM RESET (2026-07-14): charge the FULL new
// plan B (10000) on a fresh term and credit the unused portion of old plan A
// (ms-prorated on this anniversary business). WHERE that credit lands depends on
// whether the current term was ever invoiced:
//
//   billed term      → the credit is a CREDIT NOTE applied to the new invoice, so
//                      the invoice itself still reads the FULL new plan.
//   NEVER-billed term → there is NO credit at all. No money was taken for that
//                      term, so there is nothing to hand back, and crediting it
//                      would invent money (`proration.ts`, `resetCreditDropped`).
//
// `mkSub` raises no first invoice, so every sub below is the NEVER-BILLED case and
// each swap is the full new plan: 10000 at every elapsed fraction.
//
// This block used to expect a NET (7500 @50%, 5000 @0%) — the pre-term-reset
// behaviour, where the credit booked as a negative line. That rule was superseded
// by the never-billed drop and these expectations were never updated, so the suite
// went red and — being 12th of ~60 in a fail-fast runner — hid every suite after
// it.
//
// ⚠️ COVERAGE GAP, stated rather than papered over: nothing here exercises the
// BILLED path, where a credit really is due and arrives as a credit note —
// adding it here needs a helper to raise and settle a first invoice, which this
// script does not have.

// ══════════════════════════════════════════════════════════════════════════════
// PLAN SWAPS 1–3: a SAME-CADENCE swap does NOT reset the term.
// ══════════════════════════════════════════════════════════════════════════════
// Until 2026-08-22 `resetTerm` included `isPlanSwap`, so every plan swap restarted the
// term and charged the FULL new price. These three asserted that, and the 2026-07-14
// decision behind it rested on fixtures that swap plan in the SAME INSTANT the
// subscription is created, where a reset-to-now is indistinguishable from no reset AND
// the money is identical (prorated new = full new, unused old = full old at zero
// elapsed). Those cases could not see the difference they were cited for.
//
// Measured 15 days into a 31-day term instead, $7 → $24 same cadence:
//   default            → term UNCHANGED, charge 1239 (= 2400 × 16/31), credit 361 (= 700 × 16/31)
//   force_term_reset   → term restarts,  charge 2400 (full),           credit 361
// `force_term_reset` defaults to FALSE and only applies when the cadence matches;
// a DIFFERENT cadence always resets, which is what our `frequencyChanged` arm still does.
//
// 1) PLAN SWAP A($50)→B($100) at 50%: prorated B (5000) − unused half of A (2500) → net 2500.
{
  const s = await mkSub([{ price: A, quantity: 1 }]);
  const item = (await getSubscriptionItems(orgId, s.id))[0]!;
  const r = await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s.id,
    now: midOf(s),
    changes: [{ itemId: item.publicId, newPriceId: B.publicId }],
    invoiceImmediately: true,
  });
  const total = r.prorationInvoice ? Number(r.prorationInvoice.totalMinor) : null;
  // confirm the item's price actually swapped to B
  const after = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptionItems).where(eq(subscriptionItems.id, item.id)),
    )
  )[0]!;
  console.log(
    `plan-swap A→B @50%: net=${total} (exp 2500 = prorated B 5000 − unused A 2500), item.priceId==B? ${after.priceId === B.id}`,
  );
  checks.push(
    ["plan-swap @50% net 2500 (prorated, NO term reset)", near(total, 2500)],
    ["plan-swap status paid", r.prorationInvoice?.status === "paid"],
    ["item price swapped to B", after.priceId === B.id],
  );
}

// 2) PLAN SWAP at 0% elapsed (now=start) → full B (10000) − full unused A (5000) → net 5000.
//    Unchanged by the reset rule: at zero elapsed, prorated == full on both sides. This is
//    exactly the blind spot that hid the defect in the earlier fixtures.
{
  const s = await mkSub([{ price: A, quantity: 1 }]);
  const item = (await getSubscriptionItems(orgId, s.id))[0]!;
  const r = await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s.id,
    now: s.currentPeriodStart!,
    changes: [{ itemId: item.publicId, newPriceId: B.publicId }],
    invoiceImmediately: true,
  });
  const total = r.prorationInvoice ? Number(r.prorationInvoice.totalMinor) : null;
  console.log(`plan-swap @0% elapsed: net=${total} (exp 5000 = B 10000 − unused A 5000)`);
  checks.push(["swap @start net 5000 (full B − full unused A)", near(total, 5000)]);
}

// 3) PLAN SWAP at ~100% elapsed (1ms before end) → NOTHING is booked.
// Without the term reset this is the honest answer: ~0 of the new term is being bought
// and ~0 of the old one is left to credit, so the net is 0 and no invoice is raised.
// It used to assert 10000 — a full extra term charged to a customer 1ms before their
// existing term ended, which is the clearest illustration of what the reset rule cost.
{
  const s = await mkSub([{ price: A, quantity: 1 }]);
  const item = (await getSubscriptionItems(orgId, s.id))[0]!;
  const nearEnd = new Date(s.currentPeriodEnd!.getTime() - 1);
  const r = await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s.id,
    now: nearEnd,
    changes: [{ itemId: item.publicId, newPriceId: B.publicId }],
    invoiceImmediately: true,
  });
  const total = r.prorationInvoice ? Number(r.prorationInvoice.totalMinor) : null;
  console.log(
    `plan-swap @~100% elapsed: net=${total} (exp null — ~0 charge, ~0 credit, no invoice)`,
  );
  checks.push(["swap @end books nothing (no invoice)", total === null]);
}

// 4) TIERED price proration: qty 5→15 at 50%. old=5*1000=5000, new=10*1000+5*500=12500. net~(12500-5000)/2=3750.
{
  const s = await mkSub([{ price: T, quantity: 5 }]);
  const item = (await getSubscriptionItems(orgId, s.id))[0]!;
  const r = await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s.id,
    now: midOf(s),
    changes: [{ itemId: item.publicId, newQuantity: 15 }],
    invoiceImmediately: true,
  });
  const total = r.prorationInvoice ? Number(r.prorationInvoice.totalMinor) : null;
  console.log(`tiered qty 5→15 @50%: net=${total} (exp ~3750)`);
  checks.push(["tiered proration ~3750", near(total, 3750)]);
}

// 5) MULTI-ITEM: sub [P(per_unit $10)×1, B(flat)×1], bump P→qty 3 at 50%.
//    Only the per_unit item scales: old=1000, new=3000, net~(3000-1000)/2=1000. B untouched.
//    (A flat price is intentionally NOT used here — flat ignores quantity, so a qty
//     change on it correctly nets 0; quantity changes only matter for per_unit/usage.)
{
  const P = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const s = await mkSub([
    { price: P, quantity: 1 },
    { price: B, quantity: 1 },
  ]);
  const items = await getSubscriptionItems(orgId, s.id);
  const itemP = items.find((i) => i.priceId === P.id)!;
  const itemB = items.find((i) => i.priceId === B.id)!;
  const r = await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s.id,
    now: midOf(s),
    changes: [{ itemId: itemP.publicId, newQuantity: 3 }],
    invoiceImmediately: true,
  });
  const total = r.prorationInvoice ? Number(r.prorationInvoice.totalMinor) : null;
  const bAfter = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptionItems).where(eq(subscriptionItems.id, itemB.id)),
    )
  )[0]!;
  console.log(
    `multi-item bump P(per_unit) 1→3 @50%: net=${total} (exp ~1000), B qty unchanged? ${bAfter.quantity === 1}`,
  );
  checks.push(
    ["multi-item per_unit proration ~1000", near(total, 1000)],
    ["other item untouched", bAfter.quantity === 1],
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// THE MATRIX — all five cells, measured 2026-08-22
// ══════════════════════════════════════════════════════════════════════════════
// One rule explains every row: `prorate: false` suppresses the PRORATED artefacts and
// nothing else. A full new-term charge caused by a term reset is not a prorated
// artefact, so it survives. (docs/PROGRESS.md used to claim the opposite — that a reset
// with proration off would restart the term "charging and crediting nothing, a free
// term". Not here: the reset still charges in full.)
{
  const YEAR = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 60000,
    interval: "year",
  });

  // ── same cadence + prorate:false → no reset, NO money ────────────────────────
  const s1 = await mkSub([{ price: A, quantity: 1 }]);
  const i1 = (await getSubscriptionItems(orgId, s1.id))[0]!;
  const before1 = s1.currentPeriodStart!.getTime();
  const r1 = await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s1.id,
    now: midOf(s1),
    changes: [{ itemId: i1.publicId, newPriceId: B.publicId }],
    prorate: false,
    invoiceImmediately: true,
  });
  const a1 = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptionItems).where(eq(subscriptionItems.id, i1.id)),
    )
  )[0]!;
  const sub1 = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, s1.id)),
    )
  )[0]!;
  console.log(
    `matrix same-cadence prorate=false: invoice=${r1.prorationInvoice ? String(r1.prorationInvoice.totalMinor) : "none"} cn=${r1.creditNote ? String(r1.creditNote.totalMinor) : "none"} termMoved=${sub1.currentPeriodStart!.getTime() !== before1}`,
  );
  checks.push(
    ["same-cadence prorate=false: term NOT reset", sub1.currentPeriodStart!.getTime() === before1],
    ["same-cadence prorate=false: no invoice", r1.prorationInvoice == null],
    ["same-cadence prorate=false: no credit note", r1.creditNote == null],
    ["same-cadence prorate=false: the plan STILL changed", a1.priceId === B.id],
  );

  // ── frequency change + prorate:false → RESET, full charge, NO credit ─────────
  const s2 = await mkSub([{ price: A, quantity: 1 }]);
  const i2 = (await getSubscriptionItems(orgId, s2.id))[0]!;
  const before2 = s2.currentPeriodStart!.getTime();
  const r2 = await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s2.id,
    now: midOf(s2),
    changes: [{ itemId: i2.publicId, newPriceId: YEAR.publicId }],
    prorate: false,
    invoiceImmediately: true,
  });
  const sub2 = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, s2.id)),
    )
  )[0]!;
  const t2 = r2.prorationInvoice ? Number(r2.prorationInvoice.totalMinor) : null;
  console.log(
    `matrix freq-change prorate=false: invoice=${t2} (exp 60000 FULL) cn=${r2.creditNote ? String(r2.creditNote.totalMinor) : "none"} termMoved=${sub2.currentPeriodStart!.getTime() !== before2}`,
  );
  checks.push(
    [
      "freq-change prorate=false: term RESETS anyway",
      sub2.currentPeriodStart!.getTime() !== before2,
    ],
    ["freq-change prorate=false: FULL new term still charged (no free term)", near(t2, 60000)],
    ["freq-change prorate=false: unused-time credit suppressed", r2.creditNote == null],
  );

  // ── D1: a term billed across SEVERAL invoices is credited once PER INVOICE ─────
  // This combination used to be impossible. `issueCurrentTermCredit` credited a single
  // invoice — "the newest live" — and capped at ITS cash, so once a mid-term quantity
  // change had raised a second (small) invoice, the whole-term credit trivially exceeded
  // it and every later plan change was REFUSED for the rest of the term:
  //   "Refundable credit 4902646 exceeds refundable paid amount 171746"
  // The credit SPLITS — one credit note per invoice in the cycle, each for that
  // invoice's own amount, all applied to the new invoice (CN-182 vs #2165 + CN-183 vs
  // #2166 → #2167). That split is now what we do.
  {
    const seats = await createProduct({
      organizationId: orgId,
      businessId: biz.id,
      name: `D1${Math.random()}`,
      kind: "addon",
    });
    const seatsM = await createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: seats.id,
      type: "recurring",
      model: "per_unit",
      currency: "USD",
      amountMinor: 500,
      interval: "month",
    });
    const s8 = await mkSub([
      { price: A, quantity: 1 },
      { price: seatsM, quantity: 10 },
    ]);
    // Bill the first term, so the term has a real invoice before the proration one.
    const { billSubscriptionPeriod } = await import("@/modules/invoicing/service");
    await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: s8,
      periodStart: s8.currentPeriodStart!,
      periodEnd: s8.currentPeriodEnd!,
    });
    const it8 = await getSubscriptionItems(orgId, s8.id);
    // Quantity change → a SECOND invoice for the same term. This is the state that broke it.
    await changeSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: s8.id,
      now: s8.currentPeriodStart!,
      changes: [{ itemId: it8.find((i) => i.priceId === seatsM.id)!.publicId, newQuantity: 12 }],
      invoiceImmediately: true,
    });
    const before8 = await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, s8.id)),
    );
    // …then the plan change that used to be refused.
    const it8b = await getSubscriptionItems(orgId, s8.id);
    let blocked: string | null = null;
    let out: Awaited<ReturnType<typeof changeSubscription>> | null = null;
    try {
      out = await changeSubscription({
        organizationId: orgId,
        businessId: biz.id,
        subscriptionId: s8.id,
        now: s8.currentPeriodStart!,
        changes: [
          { itemId: it8b.find((i) => i.priceId === A.id)!.publicId, newPriceId: YEAR.publicId },
        ],
        invoiceImmediately: true,
      });
    } catch (e) {
      blocked = (e as Error).message;
    }
    const notes = out?.creditNotes ?? [];
    console.log(
      `matrix D1: invoicesInTerm=${before8.length} blocked=${blocked ? "YES" : "no"} creditNotes=${notes.length} totals=${notes.map((n) => String(n.totalMinor)).join("+")}`,
    );
    checks.push(
      ["D1: a plan change after a mid-term quantity change is no longer refused", blocked == null],
      ["D1: the term had TWO invoices to credit", before8.length === 2],
      ["D1: one credit note per invoice in the term", notes.length === 2],
      [
        "D1: the notes together credit the whole term (5000 + 10×500 plan/seats + 2×500 delta)",
        notes.reduce((sum, n) => sum + Number(n.totalMinor), 0) === 11000,
      ],
      [
        "D1: each note is capped at its own invoice (none exceeds its source)",
        notes.every((n) => {
          const src = before8.find((i) => i.id === n.invoiceId);
          return src != null && Number(n.totalMinor) <= Number(src.totalMinor);
        }),
      ],
    );
  }

  // ── ANNUALISATION: a shorter-cadence add-on must be scaled onto the new cycle ──
  // A monthly add-on's price multiplies by 12 for a yearly term (`alignSnapshotToCycle`).
  // We billed ONE MONTH for the year — measured 2026-08-23, ₹149,930 short per
  // subscription-year on a real subscription. The reset branch now re-aligns every
  // recurring item onto the new cycle.
  {
    const seats = await createProduct({
      organizationId: orgId,
      businessId: biz.id,
      name: `Seats${Math.random()}`,
      kind: "addon",
    });
    const seatsM = await createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: seats.id,
      type: "recurring",
      model: "per_unit",
      currency: "USD",
      amountMinor: 500,
      interval: "month",
    }); // $5/mo
    const s4 = await mkSub([
      { price: A, quantity: 1 },
      { price: seatsM, quantity: 10 },
    ]);
    const items4 = await getSubscriptionItems(orgId, s4.id);
    const planItem4 = items4.find((i) => i.priceId === A.id)!;
    const r4 = await changeSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: s4.id,
      now: s4.currentPeriodStart!,
      changes: [{ itemId: planItem4.publicId, newPriceId: YEAR.publicId }],
      invoiceImmediately: true,
    });
    // YEAR is $600/yr; 10 seats at $5/mo must become 10 × $60/yr = $600. Total $1200.
    const t4 = r4.prorationInvoice ? Number(r4.prorationInvoice.totalMinor) : null;
    const after4 = await getSubscriptionItems(orgId, s4.id);
    const seatSnap = after4.find((i) => i.priceId === seatsM.id)!.priceSnapshot as {
      amountMinor: number;
      interval: string;
      cadenceMultiple?: number;
    };
    console.log(
      `matrix annualise: invoice=${t4} (exp 120000 = 60000 plan + 10×6000 seats) seatSnap=${seatSnap.amountMinor}/${seatSnap.interval} ×${seatSnap.cadenceMultiple ?? 1}`,
    );
    checks.push(
      ["annualise: the monthly add-on is charged 12× on the yearly term", near(t4, 120000)],
      [
        "annualise: the persisted snapshot moved to the new cycle",
        seatSnap.amountMinor === 6000 && seatSnap.interval === "year",
      ],
      ["annualise: and records the multiple it was scaled by", seatSnap.cadenceMultiple === 12],
    );
    // The snapshot half is what stops the leak RECURRING: probe 2 showed the renewal
    // repeated the shortfall because the item still said "monthly".
    const { renewSubscription } = await import("@/modules/subscriptions/renewal");
    const mid4 = (
      await withTenant(orgId, (tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.id, s4.id)),
      )
    )[0]!;
    await renewSubscription(orgId, s4.id, mid4.currentPeriodEnd!);
    const renewInv = (
      await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(invoices)
          .where(eq(invoices.subscriptionId, s4.id))
          .orderBy(desc(invoices.createdAt))
          .limit(1),
      )
    )[0];
    checks.push([
      "annualise: the RENEWAL bills the annualised amount too (leak does not recur)",
      near(renewInv ? Number(renewInv.totalMinor) : null, 120000),
    ]);
  }

  // ── the reverse: yearly → monthly must rewind, not keep the ×12 amount ────────
  // This combination used to be REFUSED outright ("Cannot change the plan's billing
  // frequency while … is folded into the current cycle"), with the refusal documented as
  // a placeholder for exactly the re-derivation now in place. Billing the folded ₹5,700
  // monthly would have been a 12× overcharge, which is why it was refused rather than
  // guessed at.
  {
    const seats = await createProduct({
      organizationId: orgId,
      businessId: biz.id,
      name: `Seats${Math.random()}`,
      kind: "addon",
    });
    const seatsM = await createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: seats.id,
      type: "recurring",
      model: "per_unit",
      currency: "USD",
      amountMinor: 500,
      interval: "month",
    });
    const s5 = await mkSub([
      { price: YEAR, quantity: 1 },
      { price: seatsM, quantity: 10 },
    ]);
    const items5 = await getSubscriptionItems(orgId, s5.id);
    const folded = items5.find((i) => i.priceId === seatsM.id)!.priceSnapshot as {
      amountMinor: number;
      cadenceMultiple?: number;
    };
    const planItem5 = items5.find((i) => i.priceId === YEAR.id)!;
    await changeSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: s5.id,
      now: s5.currentPeriodStart!,
      changes: [{ itemId: planItem5.publicId, newPriceId: A.publicId }],
      invoiceImmediately: true,
    });
    const after5 = await getSubscriptionItems(orgId, s5.id);
    const rewound = after5.find((i) => i.priceId === seatsM.id)!.priceSnapshot as {
      amountMinor: number;
      interval: string;
      cadenceMultiple?: number;
    };
    console.log(
      `matrix rewind: folded=${folded.amountMinor}×${folded.cadenceMultiple ?? 1} → ${rewound.amountMinor}/${rewound.interval}`,
    );
    checks.push(
      [
        "rewind: the add-on was folded ×12 on the yearly plan to begin with",
        folded.amountMinor === 6000 && folded.cadenceMultiple === 12,
      ],
      [
        "rewind: switching to monthly restores $5/month, not $60",
        rewound.amountMinor === 500 && rewound.interval === "month",
      ],
      ["rewind: and clears the multiple", (rewound.cadenceMultiple ?? 1) === 1],
    );
  }

  // ── a model with no single scalable amount is REFUSED, by name ────────────────
  // Tiered/package/percentage have no unambiguous ×12, so billing one period of twelve
  // would be a silent under-charge. `cadenceMismatch` already words this.
  {
    const s6 = await mkSub([
      { price: A, quantity: 1 },
      { price: T, quantity: 5 },
    ]);
    const items6 = await getSubscriptionItems(orgId, s6.id);
    let refused: string | null = null;
    try {
      await changeSubscription({
        organizationId: orgId,
        businessId: biz.id,
        subscriptionId: s6.id,
        now: s6.currentPeriodStart!,
        changes: [
          { itemId: items6.find((i) => i.priceId === A.id)!.publicId, newPriceId: YEAR.publicId },
        ],
        invoiceImmediately: true,
      });
    } catch (e) {
      refused = (e as Error).message;
    }
    console.log(`matrix tiered-refusal: ${refused ? refused.slice(0, 80) : "ACCEPTED (wrong)"}`);
    checks.push([
      "a TIERED add-on blocks a cadence change instead of being billed one month of twelve",
      refused != null && refused.includes(T.publicId),
    ]);
  }

  // ── forced reset on a same cadence → reset + FULL charge (force_term_reset) ──
  const s3 = await mkSub([{ price: A, quantity: 1 }]);
  const i3 = (await getSubscriptionItems(orgId, s3.id))[0]!;
  const before3 = s3.currentPeriodStart!.getTime();
  const r3 = await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s3.id,
    now: midOf(s3),
    changes: [{ itemId: i3.publicId, newPriceId: B.publicId }],
    resetTerm: true,
    invoiceImmediately: true,
  });
  const sub3 = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, s3.id)),
    )
  )[0]!;
  const t3 = r3.prorationInvoice ? Number(r3.prorationInvoice.totalMinor) : null;
  console.log(
    `matrix force_term_reset: invoice=${t3} (exp 10000 FULL) termMoved=${sub3.currentPeriodStart!.getTime() !== before3}`,
  );
  // The LABEL, not just the amount. A reset charges a whole new term, and that line is
  // named plainly — measured 2026-08-30, 15 days into a 31-day term, lite-monthly-7 →
  // basic-monthly-24:
  //   force_term_reset=true → invoice 2400, line "BASIC … Monthly Plan"
  //   no reset (control)    → invoice 1239, line "BASIC … Monthly Plan - Prorated Charges"
  // Guarded HERE because proration-line WORDING is asserted nowhere else, so a label
  // regression would pass in silence. That blind spot is how the charge came to be labelled
  // from `frequencyChanged` — only ONE of the two ways `resetTerm` becomes true — leaving a
  // forced same-cadence reset (what the hosted checkout sends) calling a full-term charge
  // "Prorated Charges".
  const lines3 = r3.prorationInvoice
    ? await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, r3.prorationInvoice!.id)),
      )
    : [];
  const charge3 = lines3.find((l) => l.kind !== "tax" && l.amountMinor > 0n);
  console.log(`matrix force_term_reset: charge line = "${charge3?.description ?? "(none)"}"`);
  checks.push(
    [
      "force_term_reset: term RESETS on a same-cadence swap",
      sub3.currentPeriodStart!.getTime() !== before3,
    ],
    ["force_term_reset: FULL new term charged, not prorated", near(t3, 10000)],
    [
      'force_term_reset: the full charge is NOT called "Prorated Charges"',
      charge3 != null && !charge3.description.includes("Prorated Charges"),
    ],
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SHAPE: a same-price QUANTITY change nets; only a PRICE SWAP grosses.
// ══════════════════════════════════════════════════════════════════════════════
// Closes the coverage gap stated at the top of this file ("nothing here exercises the
// BILLED path, where a credit really is due and arrives as a credit note") for the one
// question that needs it: gross-vs-delta is decided inside `changeSubscription`'s
// `net < 0` branch by `termInvoiceCanAbsorb`, which can only say yes on a term that was
// actually invoiced and collected. `mkSub` raises no invoice, so `mkBilledSub` does.
//
// THE THREE SHAPES:
//   quantity DOWN → credit the REMOVED UNITS ONLY, raise NO invoice. "No invoice
//     is generated, and prorated refundable credits of $5 x 1 = $5 are issued" (paid term)
//     and "unused service = plan price x UNUSED QUANTITY x fraction = $30 x 1 x 0.5"
//     (partially paid). MEASURED 2026-08-31: add-on qty 4 -> 2 mid-term against a
//     payment_due invoice gave "NEW invoices raised by the change: 0; credit notes: 1 ->
//     CN-722 adjustment USD 100.00, qty=2".
//   quantity UP → one invoice for the ADDED UNITS, no credit note (2026-08-25).
//   price SWAP → credit the old price GROSS, invoice the new price (2026-08-28: the
//     change invoice is charges-only at the new rates and the old one is reversed by its
//     own note).
//
// So both cases below are asserted TOGETHER, on purpose. The quantity one is the
// regression; the swap one is the guard that says the fix stayed inside the same-price
// rule and did NOT widen the gross credit-note branch — the direction already measured as
// wrong, and the one that would have "fixed" `verify-change-atomicity`'s 19500-delta
// fixture. The mechanism is in `proration.ts`: a same-price quantity DECREASE now collapses
// its unused/remaining pair into ONE negative line, exactly as an INCREASE has collapsed
// into one "Prorated Charges" line since 2026-08-25. With no positive line left, the
// downgrade builder has nothing to invoice and the credit note is the whole outcome,
// reached through machinery that already existed. `estimateChange` carries the twin
// collapse so the preview quotes the same two documents.
const U = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 3000,
  interval: "month",
}); // $30/unit — the worked-example fixture

// A subscription whose FIRST TERM IS BILLED AND COLLECTED. `vaultPaymentMethod` in
// `mkSub` is what settles it, so the invoice is `paid` and its cash is what
// `termInvoiceCanAbsorb` measures the gross credit against.
async function mkBilledSub(prices: Array<{ price: typeof A; quantity: number }>) {
  const s = await mkSub(prices);
  const b = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: s,
    periodStart: s.currentPeriodStart!,
    periodEnd: s.currentPeriodEnd!,
  });
  return { sub: s, seedInvoice: b.invoice };
}
// Every note this customer holds, and every invoice raised AFTER the seed one.
async function shapeOf(sub: typeof subscriptions.$inferSelect, seedInvoiceId: string) {
  return withTenant(orgId, async (tx) => {
    const notes = await tx
      .select()
      .from(creditNotes)
      .where(eq(creditNotes.customerId, sub.customerId));
    const invs = await tx.select().from(invoices).where(eq(invoices.subscriptionId, sub.id));
    return {
      notes,
      creditMinor: notes.reduce((x, n) => x + Number(n.totalMinor), 0),
      newInvoices: invs.filter((i) => i.id !== seedInvoiceId),
    };
  });
}

// 1) QUANTITY DOWNGRADE on a paid term, invoiced immediately: ONE credit note for the
//    removed unit, NO invoice. $30/unit, qty 3 -> 2 at 50% elapsed => 3000 x 1 x 0.5 = 1500.
//    BEFORE the 2026-09-01 fix this produced the price-swap GROSS shape — a 4500 note
//    (all three units' unused time) plus a 3000 invoice (the two kept units re-charged),
//    net-identical but two documents where one is right. Not cosmetic: a re-charge is a
//    taxed supply whose credit reverses tax separately, and a coupon applied AFTER the term
//    was billed lands on that re-charge, which is never raised — measured on
//    `verify:estimates`' own fixture (qty 10 -> 6, 10%) as a 70800 gap.
{
  const { sub, seedInvoice } = await mkBilledSub([{ price: U, quantity: 3 }]);
  const item = (await getSubscriptionItems(orgId, sub.id))[0]!;
  const r = await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: midOf(sub),
    changes: [{ itemId: item.publicId, newQuantity: 2 }],
    prorate: true,
    invoiceImmediately: true,
  });
  const shape = await shapeOf(sub, seedInvoice.id);
  console.log(
    `qty-down 3->2 @50% (paid term, invoiceImmediately): notes=[${shape.notes
      .map((n) => `${n.kind} ${n.totalMinor}`)
      .join(", ")}] newInvoices=${shape.newInvoices.length} ` +
      `charge=${r.prorationInvoice ? Number(r.prorationInvoice.totalMinor) : "none"} ` +
      `(exp 1 note of 1500, NO invoice)`,
  );
  checks.push(
    ["qty-down: exactly ONE credit note", shape.notes.length === 1],
    ["qty-down: the note credits the REMOVED unit only (1500)", near(shape.creditMinor, 1500)],
    [
      "qty-down: NO invoice is raised",
      r.prorationInvoice === null && shape.newInvoices.length === 0,
    ],
  );
}

// 2) CONTROL — PRICE SWAP DOWN on a paid term still GROSSES. B($100) -> A($50) at 50%,
//    same cadence so no term reset: credit unused B (10000 x 0.5 = 5000) as its own note,
//    invoice prorated A (5000 x 0.5 = 2500). `priceSwapped` is true, so the collapse does
//    not fire and this path is byte-for-byte what it was.
{
  const { sub, seedInvoice } = await mkBilledSub([{ price: B, quantity: 1 }]);
  const item = (await getSubscriptionItems(orgId, sub.id))[0]!;
  const r = await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: midOf(sub),
    changes: [{ itemId: item.publicId, newPriceId: A.publicId }],
    prorate: true,
    invoiceImmediately: true,
  });
  const shape = await shapeOf(sub, seedInvoice.id);
  const charge = r.prorationInvoice ? Number(r.prorationInvoice.totalMinor) : null;
  console.log(
    `swap-down B->A @50% (paid term, invoiceImmediately): notes=[${shape.notes
      .map((n) => `${n.kind} ${n.totalMinor}`)
      .join(", ")}] charge=${charge} (exp note 5000 GROSS + invoice 2500)`,
  );
  checks.push(
    ["swap-down: unused OLD price credited GROSS (5000)", near(shape.creditMinor, 5000)],
    ["swap-down: the NEW price is still invoiced (2500)", near(charge, 2500)],
  );
}

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ PRORATION MATRIX: PASS" : "❌ PRORATION MATRIX: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
