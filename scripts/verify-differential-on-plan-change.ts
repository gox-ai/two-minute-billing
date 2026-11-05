/**
 * An add-on's differential must follow the PLAN, not the quantity.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────────────────────
 * Measured on a live subscription 2026-08-28: a buyer moved PRO → BUSINESS and reduced the
 * connections add-on from 21 to 2 **in one call**. The plan re-priced; the add-on kept
 * PRO's differential (₹752/unit) on a BUSINESS plan whose contracted rate is ₹470 —
 * ₹564/month overcharged, and billed on INV-3361.
 *
 * Two individually-correct rules cancelled out. Upstream, a quantity-only change
 * deliberately PRESERVES its snapshot, so an edited catalog price never silently re-rates
 * anyone. Downstream, the plan-change re-rating pass skipped every item named in `changes`
 * because they "already got a differential-aware snapshot upstream" — which a quantity-only
 * change had not. An UNTOUCHED add-on on the same change was re-rated correctly, so the
 * quantity was silently deciding the price.
 *
 * Nothing in `verify:*` changed a plan and a quantity in the same call, which is why this
 * survived. All three cases below are asserted together on purpose: the fix is only correct
 * if it re-rates the quantity-only case WITHOUT breaking the two rules that made the
 * original behaviour defensible.
 *
 *   1. plan change + quantity-only add-on change  → add-on takes the NEW plan's rate  (the bug)
 *   2. plan change + explicit customAmountMinor   → the custom amount STANDS           (must not regress)
 *   3. quantity-only change, no plan change       → snapshot PRESERVED                 (must not regress)
 *
 * Usage: pnpm tsx scripts/verify-differential-on-plan-change.ts
 */

import { eq } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, setDifferentialPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { estimateChange } from "@/modules/subscriptions/estimate";
import { subscriptionItems } from "@db/schema";

const PRO_RATE = 75200; // ₹752.00 — the outgoing plan's contracted add-on rate
const BUSINESS_RATE = 47000; // ₹470.00 — the incoming plan's
const CUSTOM_RATE = 12345; // deliberately unlike either, so a re-rate cannot hide in it

const checks: Array<[string, boolean, string?]> = [];
const ok = (label: string, cond: boolean, detail?: string) => checks.push([label, cond, detail]);

async function main() {
  const org = await createOrganization({ name: "Differential Org" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const ctx = { organizationId: orgId, businessId: biz.id };

  const proProd = await createProduct({ ...ctx, name: "Pro", kind: "plan" });
  const bizProd = await createProduct({ ...ctx, name: "Business", kind: "plan" });
  const seatProd = await createProduct({ ...ctx, name: "Seats", kind: "addon" });

  const proPrice = await createPrice({
    ...ctx,
    productId: proProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 2791800,
    interval: "month",
  });
  const bizPrice = await createPrice({
    ...ctx,
    productId: bizProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5611800,
    interval: "month",
  });

  /**
   * The add-on's catalog price is ZERO on purpose — that is the differential shape. The
   * real rate lives per (add-on, plan, currency, interval), which is exactly why a snapshot
   * taken under the wrong plan is invisible: it looks like a legitimate override rather
   * than a stale rate.
   */
  const seatPrice = await createPrice({
    ...ctx,
    productId: seatProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 0,
    interval: "month",
  });

  await setDifferentialPrice({
    ...ctx,
    addonPublicId: seatProd.publicId,
    planPublicId: proProd.publicId,
    currency: "USD",
    interval: "month",
    amountMinor: PRO_RATE,
  });
  await setDifferentialPrice({
    ...ctx,
    addonPublicId: seatProd.publicId,
    planPublicId: bizProd.publicId,
    currency: "USD",
    interval: "month",
    amountMinor: BUSINESS_RATE,
  });

  let n = 0;
  const mkSub = async (qty: number) => {
    const customer = await createCustomer({ ...ctx, email: `diff-${++n}@verify.invalid` });
    await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
    const { subscription, items } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      items: [
        { price: proPrice, quantity: 1 },
        { price: seatPrice, quantity: qty },
      ],
    });
    const planItem = items.find((i) => i.priceId === proPrice.id)!;
    const seatItem = items.find((i) => i.priceId === seatPrice.id)!;
    return { subscription, planItem, seatItem };
  };

  const seatAmount = async (itemId: string) => {
    const [row] = await systemDb
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.id, itemId))
      .limit(1);
    const snap = row?.priceSnapshot as { amountMinor?: number | string } | null;
    return Number(snap?.amountMinor ?? -1);
  };

  // The add-on starts on PRO's rate in every case — assert it, or a fixture that never
  // resolved the differential at all would make case 1 pass for the wrong reason.
  {
    const { seatItem } = await mkSub(21);
    ok(
      "fixture: the add-on starts on the outgoing plan rate",
      (await seatAmount(seatItem.id)) === PRO_RATE,
      `${await seatAmount(seatItem.id)} vs ${PRO_RATE}`,
    );
  }

  // ── 1. THE BUG ────────────────────────────────────────────────────────────────────
  {
    const { subscription, planItem, seatItem } = await mkSub(21);
    await changeSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      changes: [
        { itemId: planItem.publicId, newPriceId: bizPrice.publicId },
        { itemId: seatItem.publicId, newQuantity: 2 }, // quantity ONLY — no newPriceId
      ],
    });
    const got = await seatAmount(seatItem.id);
    ok(
      "plan change + quantity-only add-on change → the add-on takes the NEW plan rate",
      got === BUSINESS_RATE,
      `got ${got}, expected ${BUSINESS_RATE} (stale PRO rate is ${PRO_RATE})`,
    );
  }

  // ── 2. A DELIBERATE CUSTOM AMOUNT MUST SURVIVE ────────────────────────────────────
  // The differential is a plan-derived rate; a custom amount is the caller's explicit
  // instruction. Re-rating over it would silently undo a negotiated price.
  {
    const { subscription, planItem, seatItem } = await mkSub(21);
    await changeSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      changes: [
        { itemId: planItem.publicId, newPriceId: bizPrice.publicId },
        { itemId: seatItem.publicId, newQuantity: 2, customAmountMinor: CUSTOM_RATE },
      ],
    });
    const got = await seatAmount(seatItem.id);
    ok(
      "plan change + explicit custom amount → the custom amount stands",
      got === CUSTOM_RATE,
      `got ${got}, expected ${CUSTOM_RATE}`,
    );
  }

  // ── 3. NO PLAN CHANGE MEANS NO RE-RATE ────────────────────────────────────────────
  // The original rule, still load-bearing: a quantity change on its own must not re-rate
  // from a catalog that may have been edited since the item was bought.
  {
    const { subscription, seatItem } = await mkSub(21);
    await changeSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      changes: [{ itemId: seatItem.publicId, newQuantity: 2 }],
    });
    const got = await seatAmount(seatItem.id);
    ok(
      "quantity-only change with no plan change → the snapshot is preserved",
      got === PRO_RATE,
      `got ${got}, expected ${PRO_RATE}`,
    );
  }

  // ── THE PREVIEW MUST QUOTE WHAT THE BOOKING CHARGES ───────────────────────────
  // F-16's rule: the differential resolution lives in BOTH paths or they drift. Until
  // 2026-08-28 only the booking had it, so the change-checkout page quoted the OUTGOING
  // plan's rate (752) against an invoice that charged the incoming one (470) — a customer
  // shown one number and billed another. The gap widened when the booking started BILLING
  // the re-rate, which is why this is asserted here rather than left to `verify:estimates`:
  // this is the only fixture with differential prices set up.
  {
    const { subscription, planItem, seatItem } = await mkSub(2);
    const at = subscription.currentPeriodStart!;
    const changes = [{ itemId: planItem.publicId, newPriceId: bizPrice.publicId }];
    const est = await estimateChange({ ...ctx, subscriptionId: subscription.id, now: at, changes });
    const seatLine = est.lines.find((l) => l.description.includes(seatPrice.publicId));
    const applied = await changeSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      now: at,
      changes,
      invoiceImmediately: true,
    });
    const booked = applied.prorationInvoice ? Number(applied.prorationInvoice.totalMinor) : null;

    console.log(
      `  estimate lines=${JSON.stringify(est.lines.map((l) => [l.description, l.amount_minor]))} ` +
        `total=${est.total_minor} booked=${booked} seatSnapshot=${await seatAmount(seatItem.id)}`,
    );
    ok(
      "plan change: the PREVIEW re-rates the add-on to the new plan, like the booking",
      !!seatLine && !String(seatLine.description).includes("Unused")
        ? seatLine.amount_minor === BUSINESS_RATE * 2
        : true,
      `seat line ${seatLine?.amount_minor} vs ${BUSINESS_RATE * 2}`,
    );
    ok(
      "plan change: estimate total == booked total",
      est.total_minor === booked,
      `estimate ${est.total_minor} vs booked ${booked}`,
    );
    ok(
      "plan change: the booking still lands the add-on on the NEW plan rate",
      (await seatAmount(seatItem.id)) === BUSINESS_RATE,
      `${await seatAmount(seatItem.id)} vs ${BUSINESS_RATE}`,
    );
  }

  const failed = checks.filter(([, c]) => !c);
  for (const [label, cond, detail] of checks) {
    console.log(
      `  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${cond || !detail ? "" : ` — ${detail}`}`,
    );
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  await closeDb();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("\x1b[31mcrashed\x1b[0m", e?.message ?? e);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
