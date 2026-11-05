/**
 * Time Travel finishes a step whose clock pass caps. With TICK_SCAN_LIMIT=3 and 8
 * subscriptions renewing at one instant, the renewal pass caps after 3; a step must re-drive
 * that instant until all 8 renew, not leave 5 to a tick that never comes at that instant.
 *
 *   pnpm verify:time-travel-capped
 */
// Set before any module reads config; the imports below are dynamic for that reason.
export {};
process.env.TICK_SCAN_LIMIT = "3";

const { and, eq, gte } = await import("drizzle-orm");
const { withTenant, systemDb, closeDb } = await import("@/platform/db");
const { config } = await import("@/platform/config");
const { runWithClockScope } = await import("@/platform/clock");
const { createOrganization, createBusiness } = await import("@/modules/tenancy/service");
const { createCustomer } = await import("@/modules/customers/service");
const { vaultPaymentMethod } = await import("@/modules/payment-methods/service");
const { createProduct, createPrice } = await import("@/modules/catalog/service");
const { createSubscription } = await import("@/modules/subscriptions/service");
const { startTimeTravel, travelForward, stopTimeTravel } =
  await import("@/modules/time-travel/service");
const { invoices, clockTicks } = await import("@db/schema");

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const SUBS = 8;
const G = new Date("2026-01-01T00:00:00.000Z");
const FEB = new Date("2026-02-01T00:00:00.000Z");
const startedWall = new Date();

ok(`scan limit is 3 (${config.TICK_SCAN_LIMIT})`, config.TICK_SCAN_LIMIT === 3);

const org = await createOrganization({ name: "TM Capped Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "TM capped",
  defaultCurrency: "USD",
  livemode: "test",
});
const plan = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Capped Plan",
  id: "capped-plan",
  kind: "plan",
});
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});

await startTimeTravel({ orgId, bizId: biz.id, genesisTime: G });
const subIds = await runWithClockScope({ onlyBusinessId: biz.id, now: G }, async () => {
  const ids: string[] = [];
  for (let i = 0; i < SUBS; i++) {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `capped-${i}@example.com`,
      autoCollection: "on",
      address: { country: "US" },
    });
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: biz.id,
      customer: c,
      token: "tok_4242",
    });
    const { subscription } = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: G,
      items: [{ price, quantity: 1 }],
    });
    ids.push(subscription.id);
  }
  return ids;
});

await travelForward({ orgId, bizId: biz.id, toTime: new Date(FEB.getTime() + 3600_000) });

let renewed = 0;
for (const id of subIds) {
  const [inv] = await withTenant(orgId, (tx) =>
    tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.subscriptionId, id), eq(invoices.periodStart, FEB)))
      .limit(1),
  );
  if (inv) renewed++;
}
ok(`every subscription renewed at the boundary (${renewed}/${SUBS})`, renewed === SUBS);

// Non-vacuous: the renewal pass really capped during the travel.
const ticks = await systemDb
  .select({ passes: clockTicks.passes })
  .from(clockTicks)
  .where(gte(clockTicks.startedAt, startedWall));
const cappedRenewals = ticks.filter((t) =>
  ((t.passes as Array<{ name: string; counts?: Record<string, number> }> | null) ?? []).some(
    (p) => p.name === "renewal" && p.counts?.capped === 1,
  ),
).length;
ok(`the renewal pass capped during the travel (${cappedRenewals} ticks)`, cappedRenewals > 0);

await stopTimeTravel({ orgId, bizId: biz.id });

let failed = 0;
for (const [n, c] of checks) {
  console.log(`${c ? "✓" : "✗"} ${n}`);
  if (!c) failed++;
}
console.log(failed ? `\n❌ TIME-TRAVEL-CAPPED: FAIL (${failed})` : "\n✅ TIME-TRAVEL-CAPPED: PASS");
await closeDb();
process.exit(failed ? 1 : 0);
