/**
 * The Orders list (`GET /v1/businesses/:biz/orders`). Hand-built data in one business:
 *   A  mug paid 1000                       → order, paid
 *   B  poster ×2 paid 2000, coupon −200    → order, paid, coupon code
 *   C  mug paid 1000, refunded 400, then D mug paid 1000, refunded 1000
 *                                          → partly refunded, refunded
 *   E  credit pack 4000                    → NOT an order
 *   F  mug on a subscription invoice       → NOT an order
 *   G  mug, status pending (a draft)       → NOT an order
 *   H  mug, status posted (unpaid), promotional credit 100 off the total → order, due
 * A second business holds an order that must never show. A key without `invoices:view`
 * is refused.
 *
 *   pnpm verify:orders-list
 */
import { buildApp } from "@/index";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createDefinition } from "@/modules/custom-fields/service";
import { computeOrderMeasures } from "@/modules/metrics/daily/order-measures";
import { createPrice, createProduct } from "@/modules/catalog/service";
import {
  appliedCoupons,
  coupons,
  customers,
  invoiceLineDiscounts,
  invoiceLineItems,
  invoices,
  payments,
  refunds,
  subscriptions,
} from "@db/schema";
import { eq } from "drizzle-orm";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const stamp = Date.now();

const org = await createOrganization({ name: "Orders List Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Orders List Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const other = await createBusiness({
  organizationId: orgId,
  name: "Orders List Other Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const ids = { organizationId: orgId, businessId: biz.id };
const otherIds = { organizationId: orgId, businessId: other.id };
const buyer = await createCustomer({ ...ids, email: `orders-list-${stamp}@example.test` });
const otherBuyer = await createCustomer({
  ...otherIds,
  email: `orders-list-other-${stamp}@example.test`,
});

const prod = async (scope: typeof ids, name: string, grants = false) => {
  const p = await createProduct({ ...scope, name, kind: "charge" });
  const price = await createPrice({
    ...scope,
    productId: p.id,
    id: `${name.toLowerCase().replace(/\W+/g, "-")}-${stamp}`,
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    ...(grants
      ? {
          grantsCredit: {
            kind: "pack",
            unit: null,
            amount: 4000,
            tax_treatment: "taxed_at_purchase",
          },
        }
      : {}),
  });
  return { product: p, price };
};
const mug = await prod(ids, "Mug");
const poster = await prod(ids, "Poster");
const pack = await prod(ids, "Credit pack", true);
const otherMug = await prod(otherIds, "Other mug");

const [sub] = await withTenant(orgId, (tx) =>
  tx
    .insert(subscriptions)
    .values({
      ...ids,
      customerId: buyer.id,
      publicId: `sub_orders_list_${stamp}`,
      status: "active",
      currency: "USD",
    })
    .returning({ id: subscriptions.id }),
);

let seq = 0;
async function invoice(
  scope: typeof ids,
  customerId: string,
  priceId: string,
  amount: number,
  quantity: number,
  opts: { status?: string; subscriptionId?: string } = {},
): Promise<{ id: string; publicId: string }> {
  return withTenant(orgId, async (tx) => {
    const publicId = `inv_orders_list_${++seq}_${stamp}`;
    const [inv] = await tx
      .insert(invoices)
      .values({
        ...scope,
        customerId,
        publicId,
        status: opts.status ?? "paid",
        currency: "USD",
        subtotalMinor: BigInt(amount),
        totalMinor: BigInt(amount),
        subscriptionId: opts.subscriptionId ?? null,
        paidAt: (opts.status ?? "paid") === "paid" ? new Date() : null,
      })
      .returning({ id: invoices.id });
    await tx.insert(invoiceLineItems).values({
      ...scope,
      invoiceId: inv!.id,
      publicId: `il_orders_list_${seq}_${stamp}`,
      description: "line",
      quantity,
      unitAmountMinor: BigInt(amount / quantity),
      amountMinor: BigInt(amount),
      priceId,
      kind: "one_time",
    });
    return { id: inv!.id, publicId };
  });
}
async function pay(
  scope: typeof ids,
  customerId: string,
  inv: { id: string; publicId: string },
  amount: number,
  refund = 0,
) {
  await withTenant(orgId, async (tx) => {
    const [p] = await tx
      .insert(payments)
      .values({
        ...scope,
        customerId,
        invoiceId: inv.id,
        publicId: `pay_orders_list_${inv.publicId}`,
        status: "succeeded",
        amountMinor: BigInt(amount),
        currency: "USD",
        providerKey: "offline",
      })
      .returning({ id: payments.id });
    if (refund > 0)
      await tx.insert(refunds).values({
        ...scope,
        paymentId: p!.id,
        publicId: `re_orders_list_${inv.publicId}`,
        status: "succeeded",
        amountMinor: BigInt(refund),
        currency: "USD",
        providerKey: "offline",
      });
  });
}

const a = await invoice(ids, buyer.id, mug.price.id, 1000, 1);
await pay(ids, buyer.id, a, 1000);
const b = await invoice(ids, buyer.id, poster.price.id, 2000, 2);
await pay(ids, buyer.id, b, 1800);
const c = await invoice(ids, buyer.id, mug.price.id, 1000, 1);
await pay(ids, buyer.id, c, 1000, 400);
const d = await invoice(ids, buyer.id, mug.price.id, 1000, 1);
await pay(ids, buyer.id, d, 1000, 1000);
const e = await invoice(ids, buyer.id, pack.price.id, 4000, 1);
const f = await invoice(ids, buyer.id, mug.price.id, 1000, 1, { subscriptionId: sub!.id });
const g = await invoice(ids, buyer.id, mug.price.id, 1000, 1, { status: "pending" });
const h = await invoice(ids, buyer.id, mug.price.id, 1000, 1, { status: "posted" });
const x = await invoice(otherIds, otherBuyer.id, otherMug.price.id, 1000, 1);

// H carries a promotional credit: the list prints the total net of it, and so does `order_revenue`.
await withTenant(orgId, (tx) =>
  tx.update(invoices).set({ promotionalCreditsAppliedMinor: 100n }).where(eq(invoices.id, h.id)),
);
// The buyer's country and one custom field, for the customer-level filters.
await createDefinition({
  organizationId: orgId,
  businessId: biz.id,
  entityType: "customer",
  apiName: "tier",
  label: "Tier",
  dataType: "string",
});
await withTenant(orgId, (tx) =>
  tx
    .update(customers)
    .set({ country: "US", customFields: { tier: "gold" } })
    .where(eq(customers.id, buyer.id)),
);

const code = `SPRING${stamp}`;
await withTenant(orgId, async (tx) => {
  const [cp] = await tx
    .insert(coupons)
    .values({ ...ids, code, name: "Spring", kind: "percentage", percentOffBps: 1000 })
    .returning({ id: coupons.id });
  const [ac] = await tx
    .insert(appliedCoupons)
    .values({
      ...ids,
      couponId: cp!.id,
      customerId: buyer.id,
      invoiceId: b.id,
      scope: "invoice",
      publicId: `disc_orders_list_${stamp}`,
    })
    .returning({ id: appliedCoupons.id });
  const [line] = await tx
    .select({ id: invoiceLineItems.id })
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, b.id));
  await tx.insert(invoiceLineDiscounts).values({
    ...ids,
    invoiceId: b.id,
    invoiceLineItemId: line!.id,
    appliedCouponId: ac!.id,
    scope: "document_level",
    amountMinor: 200n,
  });
});

const app = await buildApp({ logger: false });
const auth = { authorization: `Bearer ${org.secret}` };
const get = (url: string, headers = auth) => app.inject({ method: "GET", url, headers });
const j = (r: { body: string }) => JSON.parse(r.body);
const B = `/v1/businesses/${biz.publicId}/orders`;

const res = await get(B);
const body = j(res);
const rows = body.data as Array<Record<string, any>>;
const byId = new Map(rows.map((r) => [r.id, r]));
ok("list answers 200", res.statusCode === 200);
ok(
  "only the five orders are listed (not the pack, subscription or draft invoice)",
  rows.length === 5 && [a, b, c, d, h].every((i) => byId.has(i.publicId)),
);
ok("total counts the five", body.total === 5);
ok("another business's order never shows", !byId.has(x.publicId));
ok("paid order is paid", byId.get(a.publicId)?.status === "paid");
ok("coupon order is paid", byId.get(b.publicId)?.status === "paid");
ok(
  "partly refunded order",
  byId.get(c.publicId)?.status === "partly_refunded" &&
    byId.get(c.publicId)?.refunded_minor === 400,
);
ok("fully refunded order", byId.get(d.publicId)?.status === "refunded");
ok(
  "unpaid order is due",
  byId.get(h.publicId)?.status === "due" && byId.get(h.publicId)?.invoice_status === "posted",
);
const rb = byId.get(b.publicId);
ok(
  "products carry name and units",
  rb?.products?.length === 1 && rb.products[0].name === "Poster" && rb.products[0].units === 2,
);
ok("coupon code is listed", JSON.stringify(rb?.coupons) === JSON.stringify([code]));
ok("an order without a coupon lists none", byId.get(a.publicId)?.coupons.length === 0);
ok("gateway is the paying payment's", byId.get(a.publicId)?.gateway === "offline");
ok("customer is carried", rb?.customer?.email === buyer.email);
ok(
  "amount and currency",
  byId.get(a.publicId)?.total_minor === 1000 && byId.get(a.publicId)?.currency === "USD",
);

const byStatus = j(await get(`${B}?order_status[is]=paid`)).data as Array<{ id: string }>;
ok(
  "filter by status paid",
  byStatus.length === 2 && byStatus.every((r) => r.id === a.publicId || r.id === b.publicId),
);
const refundedSet = j(await get(`${B}?order_status[in]=refunded,partly_refunded`)).data as Array<{
  id: string;
}>;
ok("filter by status refunded and partly refunded", refundedSet.length === 2);
const byProduct = j(await get(`${B}?product[is]=${poster.product.publicId}`)).data as Array<{
  id: string;
}>;
ok("filter by product", byProduct.length === 1 && byProduct[0]!.id === b.publicId);
const byCoupon = j(await get(`${B}?coupon[is]=${code}`)).data as Array<{ id: string }>;
ok("filter by coupon code", byCoupon.length === 1 && byCoupon[0]!.id === b.publicId);
const packFilter = j(await get(`${B}?product[is]=${pack.product.publicId}`)).data as unknown[];
ok("a credit pack product matches no order", packFilter.length === 0);
const ids5 = (r: { body: string }) =>
  (j(r).data as Array<{ id: string }>)
    .map((x) => x.id)
    .sort()
    .join();
const sorted = (...xs: Array<{ publicId: string }>) =>
  xs
    .map((i) => i.publicId)
    .sort()
    .join();
ok("filter by gateway", ids5(await get(`${B}?gateway[is]=offline`)) === sorted(a, b, c, d));
ok("filter by gateway, not_in", ids5(await get(`${B}?gateway[not_in]=offline`)) === sorted(h));
ok(
  "filter by customer country",
  ids5(await get(`${B}?customer_country[is]=us`)) === sorted(a, b, c, d, h) &&
    j(await get(`${B}?customer_country[is]=IN`)).data.length === 0,
);
ok(
  "filter by refunded amount",
  ids5(await get(`${B}?refunded_minor[gt]=0`)) === sorted(c, d) &&
    ids5(await get(`${B}?refunded_minor[between]=300,500`)) === sorted(c),
);
ok("filter by discount amount", ids5(await get(`${B}?discount_minor[gt]=0`)) === sorted(b));
ok("filter by tax amount (none taxed)", j(await get(`${B}?tax_minor[gt]=0`)).data.length === 0);
ok(
  "filter by coupon code, contains",
  ids5(await get(`${B}?coupon[contains]=${code.slice(0, 6).toLowerCase()}`)) === sorted(b) &&
    j(await get(`${B}?coupon[contains]=NOSUCH`)).data.length === 0,
);
ok(
  "filter by customer custom field",
  ids5(await get(`${B}?cf_tier[is]=gold`)) === sorted(a, b, c, d, h) &&
    j(await get(`${B}?cf_tier[is]=silver`)).data.length === 0,
);
ok(
  "a customer custom field is on the row",
  rb?.customer?.custom_fields?.tier === "gold" && rb?.customer?.country === "US",
);
ok("row carries discount and tax", rb?.discount_minor === 200 && rb?.tax_minor === 0);
const sortedBy = async (q: string) =>
  (j(await get(`${B}?${q}`)).data as Array<{ total_minor: number }>).map((x) => x.total_minor);
const asc = await sortedBy("sort_by[asc]=total_minor");
ok("sort by amount ascending", asc.join() === [900, 1000, 1000, 1000, 2000].join());
const paidSort = j(await get(`${B}?sort_by[desc]=paid_at`));
ok("sort by paid on is accepted", paidSort.data.length === 5);
ok(
  "sort by invoice status is accepted",
  (await get(`${B}?sort_by[asc]=status`)).statusCode === 200 &&
    (await get(`${B}?sort_by[asc]=due_date`)).statusCode === 200,
);

// The list prints the total net of a promotional credit, and `order_revenue` is net of it too.
// Hand-computed: lines 1000 + 2000 + 1000 + 1000 + 1000 = 6000 gross, less H's 100 promotional
// credit = 5900; list 1000 + 2000 + 1000 + 1000 + 900 = 5900 (no tax on these orders).
const listed = rows.reduce((sum, r) => sum + r.total_minor, 0);
const revenue = await withTenant(orgId, (tx) =>
  computeOrderMeasures({
    tx,
    businessId: biz.id,
    from: new Date(Date.now() - 86_400_000),
    toExclusive: new Date(Date.now() + 86_400_000),
  }),
);
const orderRevenue = revenue.find(
  (r) => r.measure === "order_revenue" && r.dim === "" && r.currency === "USD",
)?.value;
ok("list totals add up to 5900", listed === 5900);
ok("order revenue is 5900: the lines less the promotional credit", orderRevenue === 5900n);
ok("order revenue = list totals (no tax on these orders)", orderRevenue === BigInt(listed));

// The order page.
const D = (i: { publicId: string }) => `${B}/${i.publicId}`;
const one = await get(D(b));
const ob = j(one);
ok("order detail answers 200", one.statusCode === 200 && ob.id === b.publicId);
ok(
  "order detail carries payments",
  ob.payments?.length === 1 &&
    ob.payments[0].gateway === "offline" &&
    ob.payments[0].amount_minor === 1800,
);
const oc = j(await get(D(c)));
ok(
  "order detail carries refunds",
  oc.refunds?.length === 1 &&
    oc.refunds[0].amount_minor === 400 &&
    oc.refunds[0].status === "succeeded",
);
ok(
  "order detail has the list shape",
  ob.products?.[0]?.name === "Poster" && ob.coupons?.[0] === code,
);
ok("a subscription invoice is no order (404)", (await get(D(f))).statusCode === 404);
ok("a credit pack invoice is no order (404)", (await get(D(e))).statusCode === 404);
ok("a draft invoice is no order (404)", (await get(D(g))).statusCode === 404);
ok("another business's order is 404", (await get(`${B}/${x.publicId}`)).statusCode === 404);
ok("an unknown id is 404", (await get(`${B}/inv_nope`)).statusCode === 404);

const bad = await get(`${B}?nope[is]=1`);
ok("an unknown filter field is a 400", bad.statusCode === 400);
const cross = await get(`/v1/businesses/${other.publicId}/orders`);
ok(
  "the other business lists only its own order",
  j(cross).data.length === 1 && j(cross).data[0].id === x.publicId,
);

// A key that can read customers but not invoices is refused.
const noInvoices = await createApiKey(orgId, "test", "api", "read", "no invoices", null, {
  customers: "read",
});
const refused = await get(B, { authorization: `Bearer ${noInvoices.secret}` });
ok("a key without invoices:view is refused", refused.statusCode === 403);
const withInvoices = await createApiKey(orgId, "test", "api", "read", "invoices", null, {
  invoices: "read",
});
const allowed = await get(B, { authorization: `Bearer ${withInvoices.secret}` });
ok("a key with invoices:view reads orders", allowed.statusCode === 200);
ok(
  "a key without invoices:view cannot read one order",
  (await get(D(a), { authorization: `Bearer ${noInvoices.secret}` })).statusCode === 403,
);

await app.close();
await closeDb();
let failed = 0;
for (const [n, c] of checks) {
  if (!c) failed++;
  console.log(`${c ? "PASS" : "FAIL"}  ${n}`);
}
console.log(failed ? `\n${failed} FAILED` : `\nall ${checks.length} passed`);
process.exit(failed ? 1 : 0);
