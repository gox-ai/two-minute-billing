/**
 * Price tier lists, over HTTP:
 *  - every write path (price create, price update, differential price) refuses a tier
 *    list that is not contiguous from the first unit, has a zero-width tier, leaves the
 *    last tier bounded, or has an unbounded tier before the last — a 400 with field errors;
 *  - stored rows that break the rules are not touched, and other edits on them still work;
 *  - the graduated_percentage model: create, refusals, and a metered line billed at
 *    renewal with graduated tiers over the money base.
 *
 *   pnpm verify:price-tiers
 */
import { and, desc, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { recordUsage } from "@/modules/metering/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { runWithClockScope } from "@/platform/clock";
import { prices, subscriptions, invoices, invoiceLineItems } from "@db/schema";

const fails: string[] = [];
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fails.push(name);
};

const org = await createOrganization({ name: "Price Tiers Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const app = await buildApp({ logger: false });
const AUTH = { authorization: `Bearer ${org.secret}` };
const base = `/v1/businesses/${biz.publicId}`;
let n = 0;
async function call(method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url: `${base}${url}`,
    headers: { ...AUTH, "idempotency-key": `tiers-${Date.now()}-${n++}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  let body: any = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body };
}
/** A 400 in the house format whose field errors name `field`. */
const refusedOn = (r: { status: number; body: any }, field: string) =>
  r.status === 400 &&
  r.body?.error?.type === "invalid_request_error" &&
  Array.isArray(r.body?.error?.details?.[field]) &&
  r.body.error.details[field].length > 0;

for (const [id, kind] of [
  ["plan", "plan"],
  ["seats", "addon"],
  ["payments", "plan"],
] as const) {
  await call("POST", "/products", { id, name: id, kind });
}
await call("POST", "/prices", {
  product: "plan",
  id: "plan-usd",
  model: "flat",
  currency: "USD",
  amount_minor: 1000,
  interval: "month",
});

const tiered = (id: string, tiers: unknown, model = "tiered") =>
  call("POST", "/prices", {
    product: "seats",
    id,
    model,
    currency: "USD",
    interval: "month",
    tiers,
  });

// ── 1. Price create ─────────────────────────────────────────────────────────────
console.log("1. price create");
const ok = await tiered("seats-ok", [
  { upToMinor: 10, unitAmountMinor: 100 },
  { upToMinor: 20, unitAmountMinor: 80 },
  { upToMinor: null, unitAmountMinor: 50 },
]);
check("a valid tier list is created (201)", ok.status === 201);
check(
  "bounded last tier → 400 on tiers",
  refusedOn(await tiered("bad-1", [{ upToMinor: 10 }, { upToMinor: 20 }]), "tiers"),
);
check(
  "single bounded tier → 400 on tiers",
  refusedOn(await tiered("bad-2", [{ upToMinor: 10, unitAmountMinor: 1 }]), "tiers"),
);
check(
  "unbounded tier before the last → 400 on tiers",
  refusedOn(await tiered("bad-3", [{ upToMinor: null }, { upToMinor: null }]), "tiers"),
);
check(
  "descending bounds → 400 on tiers",
  refusedOn(
    await tiered("bad-4", [{ upToMinor: 20 }, { upToMinor: 10 }, { upToMinor: null }]),
    "tiers",
  ),
);
check(
  "zero-width tier (equal bounds) → 400 on tiers",
  refusedOn(
    await tiered("bad-5", [{ upToMinor: 10 }, { upToMinor: 10 }, { upToMinor: null }]),
    "tiers",
  ),
);
check(
  "volume and stairstep take the same rules",
  refusedOn(await tiered("bad-6", [{ upToMinor: 5 }], "volume"), "tiers") &&
    refusedOn(await tiered("bad-7", [{ upToMinor: 5, flatAmountMinor: 1 }], "stairstep"), "tiers"),
);
const badBody = await tiered("bad-8", [{ upToMinor: 10 }, { upToMinor: 20 }]);
check(
  "the field error names the tier and the rule",
  /tiers\.1\.upToMinor/.test(badBody.body?.error?.message ?? "") &&
    /last tier/i.test(badBody.body?.error?.details?.tiers?.join(" ") ?? ""),
);
check("nothing was stored for a refused list", (await call("GET", "/prices/bad-1")).status === 404);

// ── 2. Price update ─────────────────────────────────────────────────────────────
console.log("2. price update");
check(
  "PATCH with a bounded last tier → 400 on tiers",
  refusedOn(
    await call("PATCH", "/prices/seats-ok", { tiers: [{ upToMinor: 5 }, { upToMinor: 9 }] }),
    "tiers",
  ),
);
check(
  "PATCH tiers: null on a tiered price → 400 on tiers",
  refusedOn(await call("PATCH", "/prices/seats-ok", { tiers: null }), "tiers"),
);
const patched = await call("PATCH", "/prices/seats-ok", {
  tiers: [
    { upToMinor: 5, unitAmountMinor: 100 },
    { upToMinor: null, unitAmountMinor: 90 },
  ],
});
check("PATCH with a valid list → 200", patched.status === 200 && patched.body.tiers.length === 2);

// ── 3. Stored rows are not touched ──────────────────────────────────────────────
console.log("3. stored rows");
const badStored = [
  { upToMinor: 10, unitAmountMinor: 100 },
  { upToMinor: 20, unitAmountMinor: 80 },
];
await withTenant(orgId, (tx) =>
  tx
    .update(prices)
    .set({ tiers: badStored })
    .where(and(eq(prices.businessId, biz.id), eq(prices.publicId, "seats-ok"))),
);
const renamed = await call("PATCH", "/prices/seats-ok", { name: "Seats" });
check(
  "an edit that does not send tiers still works on a stored invalid list, and keeps it",
  renamed.status === 200 && JSON.stringify(renamed.body.tiers) === JSON.stringify(badStored),
);

// ── 4. Differential (per-plan) tier override ────────────────────────────────────
console.log("4. differential price");
const diff = (tiers: unknown) =>
  call("PUT", "/products/seats/differential_prices", {
    plan: "plan",
    currency: "USD",
    interval: "month",
    tiers,
  });
check(
  "bounded last differential tier → 400 on tiers",
  refusedOn(await diff([{ up_to_minor: 10 }, { up_to_minor: 20 }]), "tiers"),
);
check(
  "unbounded differential tier before the last → 400 on tiers",
  refusedOn(
    await diff([{ up_to_minor: null }, { up_to_minor: 5 }, { up_to_minor: null }]),
    "tiers",
  ),
);
const diffOk = await diff([
  { up_to_minor: 10, unit_amount_minor: 90 },
  { up_to_minor: null, unit_amount_minor: 70 },
]);
check("a valid differential tier list is stored (200)", diffOk.status === 200);

// ── 5. Graduated percentage ────────────────────────────────────────────────────
console.log("5. graduated percentage");
const gp = (id: string, tiers: unknown, extra: Record<string, unknown> = {}) =>
  call("POST", "/prices", {
    product: "payments",
    id,
    model: "graduated_percentage",
    currency: "USD",
    interval: "month",
    tiers,
    ...extra,
  });
check(
  "a tier without a rate → 400 on tiers",
  refusedOn(
    await gp("gp-bad-1", [{ upToMinor: 1000, rateBps: 100 }, { upToMinor: null }]),
    "tiers",
  ),
);
check(
  "a tier with a price per unit → 400 on tiers",
  refusedOn(await gp("gp-bad-2", [{ upToMinor: null, rateBps: 100, unitAmountMinor: 5 }]), "tiers"),
);
check("no tiers → 400 on tiers", refusedOn(await gp("gp-bad-3", undefined), "tiers"));
check(
  "a rate on a tiered price → 400 on tiers",
  refusedOn(
    await tiered("bad-rate", [{ upToMinor: null, unitAmountMinor: 1, rateBps: 5 }]),
    "tiers",
  ),
);
// 3% of the first $1,000.00 plus a $5.00 fee, then 2%.
const gpOk = await gp(
  "gp-ok",
  [
    { upToMinor: 100000, rateBps: 300, flatAmountMinor: 500 },
    { upToMinor: null, rateBps: 200 },
  ],
  { usage_aggregation: "sum" },
);
check(
  "a valid graduated percentage price is created and read back",
  gpOk.status === 201 &&
    gpOk.body.model === "graduated_percentage" &&
    gpOk.body.tiers[0].rateBps === 300,
);

const gpRow = await withTenant(
  orgId,
  async (tx) =>
    (
      await tx
        .select()
        .from(prices)
        .where(and(eq(prices.businessId, biz.id), eq(prices.publicId, "gp-ok")))
        .limit(1)
    )[0]!,
);
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "gp@example.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
let qtyRefused = false;
try {
  await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: gpRow, quantity: 5 }],
  });
} catch {
  qtyRefused = true;
}
check("a metered graduated percentage item refuses quantity ≠ 1", qtyRefused);
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price: gpRow, quantity: 1 }],
});
const item = sub.items.find((i) => i.priceId === gpRow.id)!;
const T = Date.now();
await systemDb
  .update(subscriptions)
  .set({ currentPeriodStart: new Date(T - 2 * 3600_000), currentPeriodEnd: new Date(T - 3600_000) })
  .where(eq(subscriptions.id, sub.subscription.id));
// Base $1,500.00 = 100000 in tier 1 and 50000 in tier 2:
// 100000 × 3% + 500 + 50000 × 2% = 3000 + 500 + 1000 = 4500.
for (const q of [100000, 50000]) {
  await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: item.id,
    quantity: q,
    timestamp: new Date(T - 90 * 60_000),
  });
}
await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
const lines = await withTenant(orgId, async (tx) => {
  const [inv] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.subscriptionId, sub.subscription.id))
    .orderBy(desc(invoices.createdAt))
    .limit(1);
  return inv
    ? tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, inv.id))
    : [];
});
const usageLine = lines.find((l) => l.kind === "usage");
console.log(`   usage line: ${usageLine?.amountMinor} (${usageLine?.description})`);
check(
  "renewal bills the base in graduated tiers: 150000 → 4500",
  Number(usageLine?.amountMinor) === 4500 && /150000 base/.test(usageLine?.description ?? ""),
);

// ── 6. Differential tiers never reach a graduated percentage price ────────────
console.log("6. differential tiers vs graduated percentage");
for (const id of ["fees", "fees2"])
  await call("POST", "/products", { id, name: id, kind: "addon" });
const gpTiers = [{ upToMinor: null, rateBps: 100 }];
await call("POST", "/prices", {
  product: "fees",
  id: "fees-gp",
  model: "graduated_percentage",
  currency: "USD",
  interval: "month",
  tiers: gpTiers,
});
const diffOnGp = await call("PUT", "/products/fees/differential_prices", {
  plan: "plan",
  currency: "USD",
  interval: "month",
  tiers: [{ up_to_minor: null, unit_amount_minor: 5 }],
});
check(
  "differential tiers for a graduated percentage price → 400 on tiers",
  refusedOn(diffOnGp, "tiers"),
);
const diffAmount = await call("PUT", "/products/fees/differential_prices", {
  plan: "plan",
  currency: "USD",
  interval: "month",
  amount_minor: 100,
});
check(
  "an amount-only differential on the same add-on is still accepted",
  diffAmount.status === 200,
);
await call("PUT", "/products/fees2/differential_prices", {
  plan: "plan",
  currency: "USD",
  interval: "month",
  tiers: [{ up_to_minor: null, unit_amount_minor: 5 }],
});
const gpUnderDiff = await call("POST", "/prices", {
  product: "fees2",
  id: "fees2-gp",
  model: "graduated_percentage",
  currency: "USD",
  interval: "month",
  tiers: gpTiers,
});
check(
  "a graduated percentage price where differential tiers exist → 400 on tiers",
  refusedOn(gpUnderDiff, "tiers"),
);

await app.close();
console.log("");
console.log(
  fails.length === 0 ? "✅ PRICE TIERS: PASS" : `❌ PRICE TIERS: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
