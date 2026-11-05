/**
 * Custom price override at subscription level (#10).
 * A per-item `unit_price_minor` overrides the flat/per-unit catalog amount for
 * that subscription only; it's frozen onto the item snapshot, so it:
 *   - bills at the override on the first invoice AND on renewal (persists),
 *   - survives a quantity-only change (not silently re-rated from the catalog),
 *   - resets to the catalog price when the plan is re-selected (revert),
 *   - is rejected for non-flat/per-unit models,
 *   - is surfaced on the subscription item view.
 *
 *   pnpm verify:price-override
 */
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  getSubscriptionDetail,
  recomputeSubscriptionMrr,
  SubscriptionError,
} from "@/modules/subscriptions/service";
import { changeSubscription, ProrationError } from "@/modules/subscriptions/proration";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { closeDb, withTenant } from "@/platform/db";

const org = await createOrganization({ name: "Override Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const product = await createProduct({ ...ctx, name: "Pro", kind: "plan" });
const flat = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
});
const perUnit = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const tiered = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "tiered",
  currency: "USD",
  interval: "month",
  tiers: [{ upToMinor: null, unitAmountMinor: 900 }],
});

const checks: Array<[string, boolean]> = [];

async function customer(email: string) {
  const c = await createCustomer({ ...ctx, email });
  await vaultPaymentMethod({ ...ctx, customer: c, token: "tok_4242" });
  return c;
}
async function billFull(
  subscription: Awaited<ReturnType<typeof createSubscription>>["subscription"],
) {
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  return Number(invoice.subtotalMinor);
}

// 1) Create with override on a flat price → bills at override, persists on renewal, shown on item view.
{
  const cus = await customer("flat@a.com");
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: flat, quantity: 1, customAmountMinor: 3000 }],
  });
  const first = await billFull(subscription);
  const renewal = await billFull(subscription);
  const detail = await getSubscriptionDetail(orgId, biz.id, subscription.publicId);
  const item = detail!.items[0]!;
  console.log(
    `flat override: first=${first} renewal=${renewal} (catalog 5000, override 3000); view unit=${item.unit_price_minor} overridden=${item.unit_price_overridden}`,
  );
  checks.push(
    ["flat override bills at 3000 (not 5000)", first === 3000],
    ["override persists on renewal", renewal === 3000],
    ["item view shows unit_price_minor=3000", item.unit_price_minor === 3000],
    ["item view flags unit_price_overridden", item.unit_price_overridden === true],
  );
}

// 2) per_unit override + quantity-only change PRESERVES the override + revert resets to catalog.
{
  const cus = await customer("unit@a.com");
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: perUnit, quantity: 2, customAmountMinor: 700 }],
  });
  const item = items[0]!;
  const create = await billFull(subscription); // 700 × 2
  // quantity-only change → keep the 700 override (NOT catalog 1000).
  await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    changes: [{ itemId: item.publicId, newQuantity: 3 }],
    invoiceImmediately: true,
  });
  const afterQtyChange = await billFull(subscription); // 700 × 3
  // re-select the same price with no override → revert to catalog 1000.
  await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    changes: [{ itemId: item.publicId, newPriceId: perUnit.publicId }],
    invoiceImmediately: true,
  });
  const afterRevert = await billFull(subscription); // 1000 × 3
  console.log(
    `per_unit: create=${create} afterQty(x3)=${afterQtyChange} afterRevert=${afterRevert}`,
  );
  checks.push(
    ["per_unit override bills 700×2=1400", create === 1400],
    ["quantity-only change preserves override → 700×3=2100", afterQtyChange === 2100],
    ["re-selecting the plan reverts to catalog 1000×3=3000", afterRevert === 3000],
  );
}

// 3) Change can SET an override on a previously-catalog-priced item.
{
  const cus = await customer("setviachange@a.com");
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: perUnit, quantity: 1 }],
  });
  const before = await billFull(subscription); // 1000
  await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    changes: [{ itemId: items[0]!.publicId, customAmountMinor: 500 }],
    invoiceImmediately: true,
  });
  const after = await billFull(subscription); // 500
  console.log(`set-via-change: before=${before} after=${after}`);
  checks.push(["change sets override 1000→500", before === 1000 && after === 500]);
}

// 4) Override rejected for non-flat/per-unit models (create + change paths).
{
  const cus = await customer("tiered@a.com");
  let createRejected = false;
  try {
    await createSubscription({
      ...ctx,
      customerId: cus.id,
      now: new Date(),
      items: [{ price: tiered, quantity: 1, customAmountMinor: 100 }],
    });
  } catch (e) {
    createRejected = e instanceof SubscriptionError;
  }
  // A valid tiered sub, then try to override via change.
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: tiered, quantity: 1 }],
  });
  let changeRejected = false;
  try {
    await changeSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      changes: [{ itemId: items[0]!.publicId, customAmountMinor: 100 }],
      invoiceImmediately: true,
    });
  } catch (e) {
    changeRejected = e instanceof ProrationError;
  }
  console.log(`tiered reject: create=${createRejected} change=${changeRejected}`);
  checks.push(
    ["override rejected on create for tiered", createRejected],
    ["override rejected on change for tiered", changeRejected],
  );
}

// ── A TIERED override must be rated into the STORED mrr, not just the snapshot ──
//
// The creation path used to patch `amountMinor` onto the catalog row to rate MRR. That covers
// a FLAT override and silently misses a TIERED one — `customTiers` was never passed — so the
// item's snapshot froze the overridden tiers while `mrr` was computed from the CATALOG tiers.
// Found 2026-08-26 by `stored_mrr_matches_recomputed` on a half-price volume override: stored
// 15000 against a real 12500, a 20% overstatement inherited by every MRR figure. The stored
// column must agree with a fresh recompute the moment the subscription is created — anything
// else is a cache that is wrong until some unrelated write happens to fix it.
{
  const volume = await createPrice({
    ...ctx,
    productId: product.id,
    type: "recurring",
    model: "volume",
    currency: "USD",
    interval: "month",
    tiers: [
      { upToMinor: 10, unitAmountMinor: 1000 },
      { upToMinor: null, unitAmountMinor: 800 },
    ],
  });
  const cus = await customer("tiered-mrr@a.com");
  // Half-price tiers. 5 units sit in the first tier, so the effective rate is 5 x 500 = 2500.
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: cus.id,
    now: new Date(),
    items: [
      {
        price: volume,
        quantity: 5,
        customTiers: [
          { upToMinor: 10, unitAmountMinor: 500 },
          { upToMinor: null, unitAmountMinor: 400 },
        ],
      },
    ],
  });
  checks.push([
    "tiered override: stored mrr uses the OVERRIDDEN tiers (2500, not the catalog 5000)",
    subscription.mrr === 2500n,
  ]);

  const fresh = await withTenant(ctx.organizationId, (tx) =>
    recomputeSubscriptionMrr(tx, subscription.id),
  );
  checks.push([
    "tiered override: a fresh recompute AGREES with what creation stored",
    fresh === subscription.mrr,
  ]);
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ PRICE OVERRIDE: PASS" : "❌ PRICE OVERRIDE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
