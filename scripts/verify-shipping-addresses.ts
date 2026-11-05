/**
 * Shipping address book (0360). What regresses without each check:
 *  - the legacy `customer.shipping_address` write stops reaching the book (or the mirror);
 *  - a second address steals the default, or two defaults exist;
 *  - a subscription ships to the default when it was told to ship elsewhere;
 *  - an invoice prints the customer's CURRENT address instead of the one it shipped to;
 *  - archiving an address a live subscription ships to silently re-routes it;
 *  - another customer's (or org's) address can be assigned or read;
 *  - GDPR erasure leaves addresses behind.
 *
 *   pnpm verify:shipping-addresses
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { buildApp } from "@/index";
import { loadGeoReference } from "@/platform/geo";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { clearPersonalData, createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { getSubscriptionByPublicId } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { customerAddresses, customers, events, invoices } from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const RUN = Math.random().toString(36).slice(2, 8);

const HOME = {
  line1: "1 Home St",
  city: "Austin",
  state_code: "TX",
  postal_code: "78701",
  country: "US",
};
const OFFICE = {
  label: "Office",
  line1: "9 Work Ave",
  city: "Denver",
  state_code: "CO",
  postal_code: "80202",
  country: "US",
};

async function main() {
  await loadGeoReference();
  const org = await createOrganization({ name: `Ship Org ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Ship Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const other = await createOrganization({ name: `Ship Other ${RUN}` });

  // 1) The legacy field creates the default book entry.
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `ship-${RUN}@example.com`,
    address: {
      country: "US",
      line1: "1 Bill St",
      city: "Austin",
      stateCode: "TX",
      postalCode: "78701",
    },
    shippingAddress: { ...HOME, zip: undefined },
  });
  const book0 = await withTenant(orgId, (tx) =>
    tx.select().from(customerAddresses).where(eq(customerAddresses.customerId, customer.id)),
  );
  ok(
    "legacy shipping_address creates one default book entry",
    book0.length === 1 && book0[0]!.isDefault,
  );
  ok(
    "…and the customer mirror carries it",
    (customer.shippingAddress as { line1?: string } | null)?.line1 === HOME.line1,
  );

  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const plan = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Box",
    id: `box-${RUN}`,
    kind: "plan",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 2500,
    interval: "month",
  });
  const stranger = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `stranger-${RUN}@example.com`,
    shippingAddress: { line1: "5 Elsewhere", country: "US" },
  });

  const app = await buildApp({ logger: false });
  try {
    const { secret } = await createApiKey(orgId, "test");
    const auth = { authorization: `Bearer ${secret}` };
    const base = `/v1/businesses/${biz.publicId}/customers/${customer.publicId}/shipping_addresses`;
    const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: {
          ...auth,
          "idempotency-key": crypto.randomUUID(),
          ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
      });

    // 2) A second address joins the book without taking the default.
    const created = await call("POST", base, OFFICE);
    const office = created.json() as { id: string; is_default: boolean; label: string };
    ok(
      "POST shipping_addresses answers 201",
      created.statusCode === 201,
      created.body.slice(0, 200),
    );
    ok("…a second address is not the default", office.is_default === false);
    const list = (await call("GET", base)).json() as {
      data: Array<{ id: string; is_default: boolean }>;
    };
    ok("GET lists both addresses", list.data.length === 2);
    const home = list.data.find((a) => a.id !== office.id)!;

    const bad = await call("POST", base, { city: "Nowhere" });
    ok(
      "an address without line1 and country is refused",
      bad.statusCode === 400,
      bad.body.slice(0, 200),
    );

    // 3) Moving the default moves the mirror; only one default exists.
    const moved = await call("PATCH", `${base}/${office.id}`, { is_default: true });
    ok("PATCH is_default answers 200", moved.statusCode === 200, moved.body.slice(0, 200));
    const cust1 = (
      await call("GET", `/v1/businesses/${biz.publicId}/customers/${customer.publicId}`)
    ).json() as { shipping_address: { line1: string } | null };
    ok(
      "…the customer's shipping_address now mirrors the new default",
      cust1.shipping_address?.line1 === OFFICE.line1,
    );
    const defaults = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(customerAddresses)
        .where(
          and(eq(customerAddresses.customerId, customer.id), eq(customerAddresses.isDefault, true)),
        ),
    );
    ok(
      "…exactly one default remains",
      defaults.length === 1 && defaults[0]!.publicId === office.id,
    );

    // 4) A subscription pinned to the non-default address ships there.
    const subRes = await call(
      "POST",
      `/v1/businesses/${biz.publicId}/customers/${customer.publicId}/subscriptions`,
      {
        items: [{ price: price.publicId, quantity: 1 }],
        shipping_address_id: home.id,
      },
    );
    const sub = subRes.json() as {
      id: string;
      shipping_address_id: string | null;
      shipping_address: { id: string; line1: string } | null;
    };
    ok(
      "POST subscription with shipping_address_id answers 201",
      subRes.statusCode === 201,
      subRes.body.slice(0, 300),
    );
    ok(
      "…it reports its own ship-to",
      sub.shipping_address_id === home.id && sub.shipping_address?.line1 === HOME.line1,
    );

    const foreign = (
      await call(
        "GET",
        `/v1/businesses/${biz.publicId}/customers/${stranger.publicId}/shipping_addresses`,
      )
    ).json() as { data: Array<{ id: string }> };
    const graft = await call("PATCH", `/v1/businesses/${biz.publicId}/subscriptions/${sub.id}`, {
      shipping_address_id: foreign.data[0]!.id,
    });
    ok(
      "another customer's address cannot be assigned",
      graft.statusCode === 400,
      graft.body.slice(0, 200),
    );

    // 5) The invoice records the address it shipped to, and keeps it after an edit.
    const subRow = (await getSubscriptionByPublicId(orgId, biz.id, sub.id))!;
    let [inv] = await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, subRow.id)).limit(1),
    );
    if (!inv)
      inv = (
        await billSubscriptionPeriod({
          organizationId: orgId,
          businessId: biz.id,
          subscription: subRow,
          periodStart: subRow.currentPeriodStart!,
          periodEnd: subRow.currentPeriodEnd!,
        })
      ).invoice;
    ok(
      "the invoice snapshots the subscription's ship-to, not the default",
      (inv!.shippingAddress as { line1?: string } | null)?.line1 === HOME.line1,
      JSON.stringify(inv!.shippingAddress),
    );
    await call("PATCH", `${base}/${home.id}`, { line1: "2 Moved St" });
    const [invAfter] = await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, inv!.id)).limit(1),
    );
    ok(
      "…and keeps it after the address is edited",
      (invAfter!.shippingAddress as { line1?: string } | null)?.line1 === HOME.line1,
    );

    // 6) Archive guard.
    const blocked = await call("POST", `${base}/${home.id}/archive`);
    ok(
      "archiving an address a live subscription ships to answers 409",
      blocked.statusCode === 409,
      blocked.body.slice(0, 200),
    );
    const repoint = await call("PATCH", `/v1/businesses/${biz.publicId}/subscriptions/${sub.id}`, {
      shipping_address_id: null,
    });
    const repointed = repoint.json() as {
      shipping_address_id: string | null;
      shipping_address: { id: string } | null;
    };
    ok(
      "shipping_address_id: null falls back to the customer's default",
      repoint.statusCode === 200 &&
        repointed.shipping_address_id === null &&
        repointed.shipping_address?.id === office.id,
      repoint.body.slice(0, 300),
    );
    const archived = await call("POST", `${base}/${home.id}/archive`);
    ok(
      "…then the address archives",
      archived.statusCode === 200 && (archived.json() as { archived: boolean }).archived,
    );
    const live = (await call("GET", base)).json() as { data: unknown[] };
    const all = (await call("GET", `${base}?include_archived=true`)).json() as { data: unknown[] };
    ok(
      "archived addresses leave the default list but stay retrievable",
      live.data.length === 1 && all.data.length === 2,
    );
    const reuse = await call("PATCH", `/v1/businesses/${biz.publicId}/subscriptions/${sub.id}`, {
      shipping_address_id: home.id,
    });
    ok("an archived address cannot be assigned", reuse.statusCode === 400);
    const dropDefault = await call("POST", `${base}/${office.id}/archive`);
    ok(
      "the default cannot be archived while a live subscription ships to the default",
      dropDefault.statusCode === 409,
      dropDefault.body.slice(0, 200),
    );
    const restored = await call("POST", `${base}/${home.id}/restore`);
    const back = restored.json() as { archived: boolean; is_default: boolean };
    ok(
      "restore brings an archived address back as a non-default entry",
      restored.statusCode === 200 && !back.archived && !back.is_default,
      restored.body.slice(0, 200),
    );

    // 7) Legacy null clears the default (the row stays).
    await call("PATCH", `/v1/businesses/${biz.publicId}/customers/${customer.publicId}`, {
      shipping_address: null,
    });
    const [mirror] = await withTenant(orgId, (tx) =>
      tx.select().from(customers).where(eq(customers.id, customer.id)),
    );
    const officeRow = await withTenant(orgId, (tx) =>
      tx.select().from(customerAddresses).where(eq(customerAddresses.publicId, office.id)),
    );
    ok(
      "shipping_address: null clears the default but keeps the book entry",
      mirror!.shippingAddress === null &&
        officeRow[0]?.isDefault === false &&
        officeRow[0]?.archivedAt === null,
    );

    // 8) Events.
    const types = await withTenant(orgId, (tx) =>
      tx.select({ type: events.type }).from(events).where(eq(events.organizationId, orgId)),
    );
    for (const t of [
      "customer_shipping_address_added",
      "customer_shipping_address_updated",
      "customer_shipping_address_archived",
    ])
      ok(
        `emitted ${t}`,
        types.some((e) => e.type === t),
      );

    // 9) Tenancy.
    const leaked = await withTenant(other.organization.id, (tx) =>
      tx.select().from(customerAddresses).where(eq(customerAddresses.customerId, customer.id)),
    );
    ok("RLS hides the book from another organization", leaked.length === 0);

    // 10) GDPR.
    await clearPersonalData(orgId, biz.id, customer.publicId);
    const left = await withTenant(orgId, (tx) =>
      tx.select().from(customerAddresses).where(eq(customerAddresses.customerId, customer.id)),
    );
    ok("clearing personal data deletes the address book", left.length === 0);
    const afterClear = await call("POST", base, OFFICE);
    ok("…and refuses new addresses", afterClear.statusCode === 400);
  } finally {
    await app.close();
  }
}

try {
  await main();
} catch (e) {
  console.error(`threw: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push(["suite completed", false]);
}

console.log("");
let pass = true;
for (const [n, c, detail] of checks) {
  console.log(`${c ? "✅" : "❌"} ${n}${!c && detail ? `  (${detail})` : ""}`);
  if (!c) pass = false;
}
console.log(pass ? "\n✅ SHIPPING ADDRESSES: PASS" : "\n❌ SHIPPING ADDRESSES: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
