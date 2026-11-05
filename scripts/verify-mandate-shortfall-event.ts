/**
 * A subscription created on a card that CANNOT carry it must say so, at create time.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
 * A mandate is sized ONCE, at vault time. In the ordinary signup order — vault the card,
 * THEN create the subscription — that is the moment least is known, so the ceiling can be
 * the fallback while the renewal it must carry is larger. Nothing re-sizes it afterwards,
 * and a registered ceiling cannot be raised in place: only a fresh authorisation replaces
 * it, and only the BUYER can give one.
 *
 * Until 2026-09-04 the gap was detected only when somebody happened to load an estimate
 * (`mandateShortfallFor` rides on the renewal preview), so a signup could sit for a month
 * and fail its first renewal with nobody warned. Measured on the dev book that day: 33 of
 * 200 INR mandates on customers with a live subscription were already below their own
 * renewal. `createSubscription` now emits `payment_source_mandate_insufficient`.
 *
 *   pnpm verify:mandate-shortfall-event
 */
import { eq, and } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { loadGeoReference } from "@/platform/geo";
import { paymentMethods, events } from "@db/schema";

await loadGeoReference();
const checks: Array<[string, boolean]> = [];
const ok = (label: string, pass: boolean) => checks.push([label, pass]);

const org = await createOrganization({ name: "Mandate Shortfall Co" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Shortfall Biz",
  defaultCurrency: "INR",
  livemode: "test",
  timezone: "Asia/Kolkata",
});
await createGatewayAccount({
  organizationId: orgId,
  businessId: biz.id,
  gatewayKey: "tmtest",
  label: "TM Test",
  credentials: {},
});
const product = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Big Plan",
});
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "INR",
  amountMinor: 5_000_000, // ₹50,000/month — far above the ₹15,000 fallback ceiling
  interval: "month",
});

async function eventsFor(customerId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(
        and(eq(events.businessId, biz.id), eq(events.type, "payment_source_mandate_insufficient")),
      ),
  );
}

// ── (1) THE GAP: a card vaulted before the subscription, at the fallback ceiling ──────
{
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "short@ex.com",
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cust,
    token: "tok_4242",
  });
  // The fallback a real vault-then-subscribe lands on: ₹15,000, the AFA-free ceiling.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: 1_500_000n, mandateCurrency: "INR", mandateRail: "card" })
      .where(eq(paymentMethods.id, pm.id)),
  );
  const before = (await eventsFor(cust.id)).length;
  await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cust.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const after = await eventsFor(cust.id);
  ok(
    `a ₹50,000 subscription on a ₹15,000 mandate emits the warning [${before} → ${after.length}]`,
    after.length === before + 1,
  );
  const data = after[after.length - 1]?.data as Record<string, unknown> | undefined;
  const src = (data?.payment_source ?? {}) as Record<string, unknown>;
  // ⚠️ The facts live in a SIBLING key, not inside `payment_source`: `emitEvent` replaces
  // the resource key with a full snapshot loaded from the DB, so anything the caller put
  // there is overwritten. Found by asserting on it and reading NaN.
  const sf = (data?.mandate_shortfall ?? {}) as Record<string, unknown>;
  ok("…naming the CARD, so a portal can put the notice on the right row", src.id === pm.publicId);
  ok(
    "…and the snapshot loader still enriched the resource key",
    typeof src.id === "string" && Object.keys(src).length > 1,
  );
  ok(
    `…the ceiling it has (₹${Number(sf.mandate_ceiling_minor) / 100})`,
    Number(sf.mandate_ceiling_minor) === 1_500_000,
  );
  ok(
    `…and the amount it must reach (₹${Number(sf.next_amount_minor) / 100}), which is what makes re-authorising a decision`,
    Number(sf.next_amount_minor) > 1_500_000,
  );
  ok(
    "…plus what a fresh authorisation would buy",
    Number(sf.reauthorized_ceiling_minor) >= Number(sf.next_amount_minor),
  );
  ok("…and the subscription that exposed it", typeof sf.subscription === "string");
}

// ── (2) NO FALSE POSITIVE: a ceiling that covers the renewal stays silent ─────────────
{
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "ample@ex.com",
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cust,
    token: "tok_4242",
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: 9_000_000n, mandateCurrency: "INR", mandateRail: "card" })
      .where(eq(paymentMethods.id, pm.id)),
  );
  const before = (await eventsFor(cust.id)).length;
  await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cust.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  ok(
    "a ₹90,000 mandate on the same plan emits NOTHING — an alert that always fires is one nobody reads",
    (await eventsFor(cust.id)).length === before,
  );
}

// ── (3) NO MANDATE AT ALL is not a shortfall ──────────────────────────────────────────
{
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "nomandate@ex.com",
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cust,
    token: "tok_4242",
  });
  const before = (await eventsFor(cust.id)).length;
  await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cust.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  // A null ceiling means UNKNOWN, not zero: the charge pre-flight skips its check, so
  // claiming a shortfall would invent a limit the provider never reported.
  ok(
    "a card with no registered ceiling emits nothing — null is unknown, not too small",
    (await eventsFor(cust.id)).length === before,
  );
}

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`${passed ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!passed) failed++;
}
console.log(
  `\n${failed === 0 ? `✅ MANDATE SHORTFALL EVENT: PASS (${checks.length} checks)` : `❌ MANDATE SHORTFALL EVENT: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
