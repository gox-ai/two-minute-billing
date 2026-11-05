/**
 * Catalog completeness (Phase 7) — integration coverage:
 *  - product kind (plan/addon/charge) + stable code persist,
 *  - stairstep pricing: flat price of the tier the quantity lands in,
 *  - PRICE SNAPSHOT immutability: editing a price never re-rates a live sub,
 *    but a NEW sub picks up the edited price,
 *  - product edit (name/kind) + soft archive (drops from active list, kept with ?includeArchived),
 *  - price edit + archive,
 *  - add-on applicability: set/list addon→plan links; non-addon / non-plan rejected,
 *  - coupon edit + archive (archived can't be applied).
 *
 *   pnpm verify:catalog
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import {
  createProduct,
  updateProduct,
  setProductActive,
  listProducts,
  createPrice,
  updatePrice,
  setPriceActive,
  listPrices,
  setItemApplicablePlans,
  listItemApplicablePlans,
  CatalogError,
} from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  createCoupon,
  applyCouponToSubscription,
  setCouponActive,
  listCoupons,
  CouponError,
} from "@/modules/coupons/service";
import { subscriptions } from "@db/schema";

const org = await createOrganization({ name: "Catalog Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});

const checks: Array<[string, boolean]> = [];

// Re-bill a sub for its current period (simulates a renewal) → new invoice total.
async function rebill(subId: string): Promise<number> {
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1))[0]!,
  );
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  return Number(invoice.totalMinor);
}

async function mkSub(
  price: Awaited<ReturnType<typeof createPrice>>,
  quantity: number,
  email: string,
) {
  const customer = await createCustomer({ organizationId: orgId, businessId: biz.id, email });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity }],
  });
  return subscription;
}

// 1) Product kind + code.
{
  const plan = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Pro",
    kind: "plan",
    id: "pro",
  });
  const addon = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Extra seats",
    kind: "addon",
  });
  const charge = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Setup fee",
    kind: "charge",
  });
  console.log(`kinds: ${plan.kind}/${addon.kind}/${charge.kind}, id=${plan.publicId}`);
  checks.push(
    ["plan kind", plan.kind === "plan"],
    ["addon kind", addon.kind === "addon"],
    ["charge kind", charge.kind === "charge"],
    ["product slug id persisted", plan.publicId === "pro"],
  );
}

// 2) Stairstep: flat price of the band the quantity lands in.
{
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Tiered Plan",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "stairstep",
    currency: "USD",
    interval: "month",
    tiers: [
      { upToMinor: 10, flatAmountMinor: 9000 }, // 1–10 → $90
      { upToMinor: 20, flatAmountMinor: 18000 }, // 11–20 → $180
      { upToMinor: null, flatAmountMinor: 30000 }, // 21+ → $300
    ],
  });
  const small = await rebill(await mkSub(price, 5, "ss5@a.com").then((s) => s.id));
  const mid = await rebill(await mkSub(price, 15, "ss15@a.com").then((s) => s.id));
  const big = await rebill(await mkSub(price, 25, "ss25@a.com").then((s) => s.id));
  console.log(
    `stairstep: qty5=${small} (exp 9000), qty15=${mid} (exp 18000), qty25=${big} (exp 30000)`,
  );
  checks.push(
    ["stairstep band 1", small === 9000],
    ["stairstep band 2", mid === 18000],
    ["stairstep top band", big === 30000],
  );
}

// 3) Price snapshot immutability.
{
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Snap Plan",
  });
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
  const liveSub = await mkSub(price, 1, "snap-live@a.com");
  // Edit the catalog price AFTER the sub exists.
  await updatePrice({
    organizationId: orgId,
    businessId: biz.id,
    pricePublicId: price.publicId,
    amountMinor: 20000,
  });
  const liveTotal = await rebill(liveSub.id);
  // A brand-new sub created after the edit should pick up the new amount.
  const newSub = await mkSub(
    (await listPrices(orgId, biz.id)).find((r) => r.price.id === price.id)!.price,
    1,
    "snap-new@a.com",
  );
  const newTotal = await rebill(newSub.id);
  console.log(
    `snapshot: live sub=${liveTotal} (exp 10000, frozen), new sub=${newTotal} (exp 20000)`,
  );
  checks.push(
    ["live sub keeps snapshot price", liveTotal === 10000],
    ["new sub gets edited price", newTotal === 20000],
  );
}

// 4) Product edit + soft archive.
{
  const p = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Editable",
    kind: "plan",
  });
  const edited = await updateProduct({
    organizationId: orgId,
    businessId: biz.id,
    productPublicId: p.publicId,
    name: "Renamed",
    kind: "addon",
  });
  await setProductActive(orgId, biz.id, p.publicId, false);
  const active = await listProducts(orgId, biz.id);
  const all = await listProducts(orgId, biz.id, { includeArchived: true });
  console.log(
    `product edit: name=${edited?.name} kind=${edited?.kind}; archived hidden=${!active.some((x) => x.id === p.id)} present-in-all=${all.some((x) => x.id === p.id)}`,
  );
  checks.push(
    ["product renamed + re-kinded", edited?.name === "Renamed" && edited?.kind === "addon"],
    ["archived product hidden from active list", !active.some((x) => x.id === p.id)],
    ["archived product kept in include_archived", all.some((x) => x.id === p.id)],
  );
}

// 5) Price edit (name) + archive.
{
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "PriceEdit Plan",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const named = await updatePrice({
    organizationId: orgId,
    businessId: biz.id,
    pricePublicId: price.publicId,
    name: "Monthly USD",
  });
  await setPriceActive(orgId, biz.id, price.publicId, false);
  const activePrices = await listPrices(orgId, biz.id);
  checks.push(
    ["price name edited", named?.name === "Monthly USD"],
    ["archived price hidden from active list", !activePrices.some((r) => r.price.id === price.id)],
  );
}

// 6) Add-on applicability.
{
  const planA = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Plan A",
    kind: "plan",
  });
  const planB = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Plan B",
    kind: "plan",
  });
  const addon = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Addon X",
    kind: "addon",
  });
  const set = await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: addon.publicId,
    planPublicIds: [planA.publicId, planB.publicId],
  });
  const listed = await listItemApplicablePlans(orgId, biz.id, addon.publicId);
  // Resetting to a subset replaces (not appends).
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: addon.publicId,
    planPublicIds: [planA.publicId],
  });
  const afterReset = await listItemApplicablePlans(orgId, biz.id, addon.publicId);
  // A non-addon product can't have applicable plans.
  let nonAddonRejected = false;
  try {
    await setItemApplicablePlans({
      organizationId: orgId,
      businessId: biz.id,
      itemPublicId: planA.publicId,
      planPublicIds: [planB.publicId],
    });
  } catch (e) {
    nonAddonRejected = e instanceof CatalogError;
  }
  // A non-plan target is rejected.
  let nonPlanRejected = false;
  try {
    await setItemApplicablePlans({
      organizationId: orgId,
      businessId: biz.id,
      itemPublicId: addon.publicId,
      planPublicIds: [planA.publicId, addon.publicId],
    });
  } catch (e) {
    nonPlanRejected = e instanceof CatalogError;
  }
  console.log(
    `applicability: set=${set.plans.length}, reset=${afterReset?.plans.length}, nonAddonRejected=${nonAddonRejected}, nonPlanRejected=${nonPlanRejected}`,
  );
  checks.push(
    ["addon links both plans", set.plans.length === 2 && listed?.plans.length === 2],
    ["set replaces (not appends)", afterReset?.plans.length === 1],
    ["non-addon rejected", nonAddonRejected],
    ["non-plan target rejected", nonPlanRejected],
  );
}

// 7) Coupon edit + archive.
{
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "CAT10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "once",
  });
  const coupon = (await listCoupons(orgId, biz.id)).find((c) => c.code === "CAT10")!;
  await setCouponActive(orgId, biz.id, coupon.code, false);
  const activeCoupons = await listCoupons(orgId, biz.id);
  // Build a sub to try applying the archived coupon.
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Coupon Plan",
  });
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
  const sub = await mkSub(price, 1, "cpn@a.com");
  let archivedRejected = false;
  try {
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      code: "CAT10",
      now: new Date(),
    });
  } catch (e) {
    archivedRejected = e instanceof CouponError;
  }
  console.log(
    `coupon archive: hidden=${!activeCoupons.some((c) => c.id === coupon.id)}, archived-apply-rejected=${archivedRejected}`,
  );
  checks.push(
    ["archived coupon hidden from active list", !activeCoupons.some((c) => c.id === coupon.id)],
    ["archived coupon cannot be applied", archivedRejected],
  );
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ CATALOG: PASS" : "❌ CATALOG: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
