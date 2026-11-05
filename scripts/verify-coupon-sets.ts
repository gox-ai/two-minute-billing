/**
 * Coupon sets (bulk unique single-use codes) — integration coverage:
 *  - create a set of N codes off a parent coupon; codes are unique + not_redeemed,
 *  - a code redeems onto a subscription (inherits the parent coupon's discount),
 *  - the SAME code cannot be redeemed twice (single-use),
 *  - redeemed_count / status update; unknown code rejected; archived parent rejected,
 *  - ARCHIVED codes count separately and are not advertised as available,
 *  - the discount actually reduces the invoice (parent rules applied),
 *  - RLS: a set is invisible cross-org.
 *
 *   pnpm verify:coupon-sets
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  createCoupon,
  setCouponActive,
  createCouponSet,
  listCouponSets,
  getCouponSet,
  listCouponSetCodes,
  archiveCouponCode,
  applyCouponToSubscription,
  CouponError,
} from "@/modules/coupons/service";
import { subscriptions } from "@db/schema";

const org = await createOrganization({ name: "Coupon Set Org" });
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
  interval: "month", // $100
});

async function mkSub(email: string) {
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
    items: [{ price, quantity: 1 }],
  });
  return subscription;
}
async function billTotal(sub: typeof subscriptions.$inferSelect): Promise<number> {
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1))[0]!,
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

const checks: Array<[string, boolean]> = [];

// Parent coupon: 25% off forever.
const parent = await createCoupon({
  organizationId: orgId,
  businessId: biz.id,
  code: "PARENT25",
  kind: "percentage",
  percentOffBps: 2500,
  durationType: "forever",
});

// 1) Create a set of 50 codes.
const set = await createCouponSet({
  organizationId: orgId,
  businessId: biz.id,
  couponId: parent.code,
  name: "Launch",
  count: 50,
  codePrefix: "launch",
});
const codes = (await listCouponSetCodes(orgId, biz.id, set.set.publicId))!;
const allUnique = new Set(codes.map((c) => c.code)).size === 50;
const allFresh = codes.every((c) => c.status === "not_redeemed");
const prefixed = codes.every((c) => c.code.startsWith("LAUNCH-"));
console.log(
  `set: total=${set.totalCount} codes=${codes.length} unique=${allUnique} fresh=${allFresh} prefixed=${prefixed}`,
);
checks.push(
  ["set created with N codes", codes.length === 50 && set.totalCount === 50],
  ["codes are unique", allUnique],
  ["codes start not_redeemed", allFresh],
  ["codes carry the prefix", prefixed],
);

// 2) Redeem a code onto a subscription → parent discount applies (25% off $100 = $75).
const sub1 = await mkSub("a@a.com");
const code = codes[0]!.code;
await applyCouponToSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: sub1.id,
  code,
  now: new Date(),
});
const total1 = await billTotal(sub1);
console.log(`redeem: invoice total=${total1} (want 7500)`);
checks.push(["redeemed code applies the parent discount", total1 === 7500]);

// 3) Single-use: the same code cannot be redeemed again (even on another sub).
const sub2 = await mkSub("b@a.com");
let reused = false;
try {
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub2.id,
    code,
    now: new Date(),
  });
} catch (e) {
  reused = e instanceof CouponError;
}
checks.push(["same code cannot be redeemed twice", reused]);

// 4) Counts + code status update.
const after = await getCouponSet(orgId, biz.id, set.set.publicId);
const redeemedCodes = (await listCouponSetCodes(orgId, biz.id, set.set.publicId, {
  status: "redeemed",
}))!;
console.log(`counts: redeemed=${after?.redeemedCount} redeemed-codes=${redeemedCodes.length}`);
checks.push(
  ["redeemed_count reflects one redemption", after?.redeemedCount === 1],
  [
    "the redeemed code links + shows redeemed",
    redeemedCodes.length === 1 && redeemedCodes[0]!.code === code,
  ],
  [
    "the redeemed code names its subscription",
    redeemedCodes[0]?.subscriptionPublicId === sub1.publicId,
  ],
  [
    "an unredeemed code names none",
    (await listCouponSetCodes(orgId, biz.id, set.set.publicId, { status: "not_redeemed" }))!.every(
      (c) => c.subscriptionPublicId === null,
    ),
  ],
);

// 5) Unknown code rejected.
let unknownRejected = false;
try {
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub2.id,
    code: "NOPE-XXXX",
    now: new Date(),
  });
} catch (e) {
  unknownRejected = e instanceof CouponError;
}
checks.push(["unknown code rejected", unknownRejected]);

// 5b) Archived codes are NOT available. `coupon_set_codes.status` has three
// values, so `total_count - redeemed_count` is *not_redeemed + archived* — it
// advertised deliberately-withdrawn codes as still redeemable. The counts are
// each read directly off the status, and this asserts all four agree.
await archiveCouponCode({ organizationId: orgId, businessId: biz.id, code: codes[1]!.code });
await archiveCouponCode({ organizationId: orgId, businessId: biz.id, code: codes[2]!.code });
const withArchived = await getCouponSet(orgId, biz.id, set.set.publicId);
const archivedCodes = (await listCouponSetCodes(orgId, biz.id, set.set.publicId, {
  status: "archived",
}))!;
console.log(
  `archived: total=${withArchived?.totalCount} redeemed=${withArchived?.redeemedCount}` +
    ` archived=${withArchived?.archivedCount} unredeemed=${withArchived?.notRedeemedCount}` +
    ` (subtraction would say ${(withArchived?.totalCount ?? 0) - (withArchived?.redeemedCount ?? 0)})`,
);
checks.push(
  ["archived_count counts the withdrawn codes", withArchived?.archivedCount === 2],
  ["archived codes are listable by status", archivedCodes.length === 2],
  // 50 total, 1 redeemed, 2 archived ⇒ 47 available. The old arithmetic said 49.
  ["unredeemed excludes archived (47, not 49)", withArchived?.notRedeemedCount === 47],
  [
    "the three statuses account for every code",
    (withArchived?.redeemedCount ?? 0) +
      (withArchived?.archivedCount ?? 0) +
      (withArchived?.notRedeemedCount ?? 0) ===
      withArchived?.totalCount,
  ],
  // An archived code is withdrawn, not spent by a customer.
  ["archiving does not inflate redeemed_count", withArchived?.redeemedCount === 1],
);

// 5c) An archived code cannot then be redeemed.
const sub3 = await mkSub("c@a.com");
let archivedCodeRejected = false;
try {
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub3.id,
    code: codes[1]!.code,
    now: new Date(),
  });
} catch (e) {
  archivedCodeRejected = e instanceof CouponError;
}
checks.push(["an archived code cannot be redeemed", archivedCodeRejected]);

// 6) A set off an archived parent coupon is rejected at create time.
const parent2 = await createCoupon({
  organizationId: orgId,
  businessId: biz.id,
  code: "ARCHIVED",
  kind: "percentage",
  percentOffBps: 1000,
  durationType: "once",
});
await setCouponActive(orgId, biz.id, parent2.code, false);
let archivedRejected = false;
try {
  await createCouponSet({
    organizationId: orgId,
    businessId: biz.id,
    couponId: parent2.code,
    name: "X",
    count: 5,
  });
} catch (e) {
  archivedRejected = e instanceof CouponError;
}
checks.push(["set off an archived coupon rejected", archivedRejected]);

// 7) RLS: another org can't see this set.
const org2 = await createOrganization({ name: "Coupon Set Org 2" });
const seen = await listCouponSets(org2.organization.id, biz.id);
checks.push(["set invisible to another org (RLS)", seen.length === 0]);

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ COUPON SETS: PASS" : "❌ COUPON SETS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
