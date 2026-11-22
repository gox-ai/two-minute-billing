// verify:charge-customer-sync — a name or address saved after the card reaches the gateway
// before the next charge, once, and a failed push never fails the charge.
//
// Regression: on 2026-11-16 a buyer abroad added a billing address in checkout after saving a
// card; the charge kept addressing the Stripe customer created without it, and an Indian
// Stripe account refused it twice more (`cross_border_classification_missing_name_and_address`).
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { loadGeoReference } from "@/platform/geo";
import { providerCustomers } from "@db/schema";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer, updateCustomer } from "@/modules/customers/service";
import { syncProviderCustomerBeforeCharge } from "@/modules/payment-methods/service";
import type { EnsureCustomerInput, PaymentProvider, ProviderCustomerRef } from "@/providers/types";

await loadGeoReference();
const org = await createOrganization({ name: "Charge Sync Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "buyer@example.com",
});

// A provider that records what it is sent, and can be told to fail.
const pushed: EnsureCustomerInput[] = [];
let failNext = false;
const provider = {
  key: "stripe",
  async updateCustomer(_ref: ProviderCustomerRef, input: EnsureCustomerInput) {
    if (failNext) {
      failNext = false;
      throw new Error("gateway timeout");
    }
    pushed.push(input);
  },
} as unknown as PaymentProvider;

const PROVIDER_CUSTOMER = "cus_XXXXXXXXXXXX01";
// Mapped when the card was saved, before any address existed.
await withTenant(orgId, (tx) =>
  tx.insert(providerCustomers).values({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    providerKey: "stripe",
    gatewayAccountId: null,
    providerCustomerId: PROVIDER_CUSTOMER,
  }),
);
const sync = () =>
  syncProviderCustomerBeforeCharge({
    organizationId: orgId,
    customerId: customer.id,
    providerCustomerId: PROVIDER_CUSTOMER,
    provider,
  });
const syncedAt = async () =>
  (
    await withTenant(orgId, (tx) =>
      tx
        .select({ at: providerCustomers.updatedAt })
        .from(providerCustomers)
        .where(
          and(
            eq(providerCustomers.customerId, customer.id),
            eq(providerCustomers.providerCustomerId, PROVIDER_CUSTOMER),
          ),
        ),
    )
  )[0]!.at;

const checks: Array<[string, boolean]> = [];

await sync();
checks.push(["nothing changed since the mapping: no push", pushed.length === 0]);

await new Promise((r) => setTimeout(r, 20));
await updateCustomer({
  organizationId: orgId,
  businessId: biz.id,
  customerPublicId: customer.publicId,
  address: {
    line1: "12 Elm Street",
    city: "Tulsa",
    stateCode: "OK",
    postalCode: "74103",
    country: "US",
    firstName: "Dana",
    lastName: "Whitfield",
  },
});
const before = await syncedAt();
await sync();
const sent = pushed[0] as (EnsureCustomerInput & { address?: { city?: string } }) | undefined;
checks.push(
  ["an address added after the card is pushed before the charge", pushed.length === 1],
  ["...with the new address", JSON.stringify(sent ?? {}).includes("Tulsa")],
  ["...and the mapping is marked synced", (await syncedAt()) > before],
);

await sync();
checks.push(["a second charge with nothing new makes no call", pushed.length === 1]);

await new Promise((r) => setTimeout(r, 20));
await updateCustomer({
  organizationId: orgId,
  businessId: biz.id,
  customerPublicId: customer.publicId,
  email: "dana.whitfield@example.com",
});
failNext = true;
let threw = false;
try {
  await sync();
} catch {
  threw = true;
}
checks.push(
  ["a failed push never fails the charge", !threw],
  ["...and is not marked synced", pushed.length === 1],
);
await sync();
checks.push(["the next charge pushes it again", pushed.length === 2]);

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ CHARGE CUSTOMER SYNC: PASS" : "❌ FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
