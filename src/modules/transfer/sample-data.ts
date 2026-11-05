import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createCoupon } from "@/modules/coupons/service";
import { createCustomer } from "@/modules/customers/service";
import { products, prices, coupons, customers } from "@db/schema";

/**
 * TL-3: seed a test business with demo catalog + a coupon + a customer (all tagged
 * `metadata.sample=true`). NO subscriptions/invoices, so `deleteSampleData` can
 * remove everything cleanly. Test businesses only (enforced at the route).
 */
export async function createSampleData(
  orgId: string,
  bizId: string,
): Promise<{ products: number; prices: number; coupons: number; customers: number }> {
  const meta = { sample: true };
  // Post-H (#12): idempotent — clear any prior sample rows first so a re-create
  // never 409s on the fixed slug ids.
  await deleteSampleData(orgId, bizId);
  const plan = await createProduct({
    organizationId: orgId,
    businessId: bizId,
    name: "Sample Plan",
    id: "sample-plan",
    kind: "plan",
    metadata: meta,
  });
  const addon = await createProduct({
    organizationId: orgId,
    businessId: bizId,
    name: "Sample Addon",
    id: "sample-addon",
    kind: "addon",
    metadata: meta,
  });
  await createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: plan.id,
    id: "sample-plan-monthly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
    metadata: meta,
  });
  await createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: addon.id,
    id: "sample-addon-monthly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
    metadata: meta,
  });
  const coupon = await createCoupon({
    organizationId: orgId,
    businessId: bizId,
    code: "SAMPLE10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "once",
  });
  // Post-H (#12): tag the sample coupon so delete keys off metadata, not the raw
  // code (a merchant's own coupon coded SAMPLE10 must never be swept).
  await withTenant(orgId, (tx) =>
    tx.update(coupons).set({ metadata: meta }).where(eq(coupons.id, coupon.id)),
  );
  await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: "sample.customer@example.com",
    metadata: meta,
    metadataRules: "off",
  });
  return { products: 2, prices: 2, coupons: 1, customers: 1 };
}

/** TL-3: remove sample-tagged demo content (best-effort; catalog is FK-safe here). */
export async function deleteSampleData(
  orgId: string,
  bizId: string,
): Promise<{ products: number; prices: number; coupons: number; customers: number }> {
  return withTenant(orgId, async (tx) => {
    const delPrices = await tx
      .delete(prices)
      .where(and(eq(prices.businessId, bizId), sql`(${prices.metadata} ->> 'sample') = 'true'`))
      .returning({ id: prices.id });
    const delProducts = await tx
      .delete(products)
      .where(and(eq(products.businessId, bizId), sql`(${products.metadata} ->> 'sample') = 'true'`))
      .returning({ id: products.id });
    // Post-H (#12): key off metadata.sample, NOT the code — never sweep a merchant's
    // own coupon that happens to be coded SAMPLE10.
    const delCoupons = await tx
      .delete(coupons)
      .where(and(eq(coupons.businessId, bizId), sql`(${coupons.metadata} ->> 'sample') = 'true'`))
      .returning({ id: coupons.id });
    const delCustomers = await tx
      .delete(customers)
      .where(
        and(eq(customers.businessId, bizId), sql`(${customers.metadata} ->> 'sample') = 'true'`),
      )
      .returning({ id: customers.id });
    return {
      products: delProducts.length,
      prices: delPrices.length,
      coupons: delCoupons.length,
      customers: delCustomers.length,
    };
  });
}
