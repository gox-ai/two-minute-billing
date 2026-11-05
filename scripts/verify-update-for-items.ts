/**
 * `POST /v1/businesses/:biz/subscriptions/:sub/update_for_items` — the API sibling of
 * the change-mode checkout, driven through the REAL server (`app.inject`) so the zod
 * body, the option mapping and the engine call are all covered rather than just the
 * service function underneath.
 *
 * The case that motivated it is a TRIAL upgrade: a consumer auto-upgrades a trialing customer
 * who exceeds their plan's connector limit, and that must move items WITHOUT charging
 * anything before the trial converts. So the money assertions matter as much as the
 * item ones — an "upgrade" that raises an invoice mid-trial is the bug, not a detail.
 *
 * Covers: upsert default · replace_items_list · mandatory_items_to_remove ·
 * the plan is never removable by either mechanism · prorate:false raises no invoice ·
 * unknown price is a 400 not a 500 · a no-op list is a no-op.
 *
 *   pnpm verify:update-for-items
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createCustomer } from "@/modules/customers/service";
import { createSubscription } from "@/modules/subscriptions/service";
import type { LightMyRequestResponse } from "fastify";
import {
  invoices,
  invoiceLineItems,
  subscriptionItems,
  prices,
  products,
  subscriptions,
} from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

const app = await buildApp({ logger: false });

// ── Fixture ──────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "UFI Co" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "UFI Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
await createGatewayAccount({
  organizationId: orgId,
  businessId: biz.id,
  gatewayKey: "tmtest",
  label: "TM Test",
  credentials: {},
});

const key = await createApiKey(orgId, "test");
const auth = { authorization: `Bearer ${key.secret}` };
let idem = 0;
const post = (url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  app.inject({
    method: "POST",
    url,
    payload,
    headers: { ...auth, "idempotency-key": `ufi-${++idem}` },
  });

const planProd = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Lite",
  kind: "plan",
});
const proProd = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Pro",
  kind: "plan",
});
const addonProd = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Connections",
  kind: "addon",
});
const destProd = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Destination",
  kind: "addon",
});

const mk = (productId: string, amountMinor: number) =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor,
    interval: "month",
  });
const litePrice = await mk(planProd.id, 1000);
const proPrice = await mk(proProd.id, 5000);
const connPrice = await mk(addonProd.id, 500);
const destPrice = await mk(destProd.id, 700);

const cus = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "ufi@example.com",
  firstName: "UFI",
  lastName: "Buyer",
});
// A TRIAL subscription — the state the motivating flow actually runs in.
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: cus.id,
  now: new Date(),
  items: [{ price: litePrice, quantity: 1 }],
  trialDays: 14,
});
const subId = sub.subscription.publicId;
const base = `/v1/businesses/${biz.publicId}/subscriptions/${subId}/update_for_items`;

const itemsNow = async () =>
  withTenant(orgId, (tx) =>
    tx
      .select({ price: prices.publicId, qty: subscriptionItems.quantity, kind: products.kind })
      .from(subscriptionItems)
      .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
      .innerJoin(products, eq(products.id, prices.productId))
      .where(eq(subscriptionItems.subscriptionId, sub.subscription.id)),
  );
const invoiceCount = async () =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, sub.subscription.id)),
    )
  ).length;

ok(
  "fixture: subscription is in trial",
  sub.subscription.status === "in_trial",
  sub.subscription.status,
);
const invoicesAtStart = await invoiceCount();

// ── 1. UPSERT is the default: add an add-on, leave the plan alone ────────────
const r1 = await post(base, {
  items: [{ price: connPrice.publicId, quantity: 2 }],
  prorate: false,
  invoice_immediately: false,
});
ok("upsert: 200", r1.statusCode === 200, r1.body.slice(0, 200));
const after1 = await itemsNow();
ok(
  "upsert: the add-on was added",
  after1.some((i) => i.price === connPrice.publicId && i.qty === 2),
);
ok(
  "upsert: the plan is untouched",
  after1.some((i) => i.price === litePrice.publicId && i.kind === "plan"),
);
ok(
  "upsert: applied.added reported",
  JSON.parse(r1.body).applied?.added === 1,
  JSON.parse(r1.body).applied,
);
// The whole point of the trial path: items moved, no money did.
ok("TRIAL: no invoice was raised", (await invoiceCount()) === invoicesAtStart);

// ── 2. Quantity change on an existing line ───────────────────────────────────
const r2 = await post(base, {
  items: [{ price: connPrice.publicId, quantity: 5 }],
  prorate: false,
  invoice_immediately: false,
});
ok("quantity: 200", r2.statusCode === 200);
ok(
  "quantity: updated in place",
  (await itemsNow()).some((i) => i.price === connPrice.publicId && i.qty === 5),
);
ok("quantity: reported as a change, not an add", JSON.parse(r2.body).applied?.changed === 1);
ok("TRIAL: still no invoice", (await invoiceCount()) === invoicesAtStart);

// ── 3. mandatory_items_to_remove drops a named price under UPSERT ────────────
await post(base, {
  items: [{ price: destPrice.publicId, quantity: 1 }],
  prorate: false,
  invoice_immediately: false,
});
ok(
  "fixture: destination add-on present",
  (await itemsNow()).some((i) => i.price === destPrice.publicId),
);
const r3 = await post(base, {
  items: [{ price: connPrice.publicId, quantity: 5 }],
  mandatory_items_to_remove: [destPrice.publicId],
  prorate: false,
  invoice_immediately: false,
});
ok("explicit removal: 200", r3.statusCode === 200, r3.body.slice(0, 200));
const after3 = await itemsNow();
ok(
  "explicit removal: the named price is gone",
  !after3.some((i) => i.price === destPrice.publicId),
);
ok(
  "explicit removal: the unlisted add-on SURVIVED (upsert, not replace)",
  after3.some((i) => i.price === connPrice.publicId),
);
ok(
  "explicit removal: reported by price id",
  JSON.parse(r3.body).applied?.removed?.includes(destPrice.publicId),
);

// ── 4. replace_items_list drops everything unlisted ──────────────────────────
await post(base, {
  items: [{ price: destPrice.publicId, quantity: 1 }],
  prorate: false,
  invoice_immediately: false,
});
const beforeReplace = await itemsNow();
ok(
  "fixture: both add-ons present before replace",
  beforeReplace.some((i) => i.price === connPrice.publicId) &&
    beforeReplace.some((i) => i.price === destPrice.publicId),
);
const r4 = await post(base, {
  items: [
    { price: litePrice.publicId, quantity: 1 },
    { price: destPrice.publicId, quantity: 1 },
  ],
  replace_items_list: true,
  prorate: false,
  invoice_immediately: false,
});
ok("replace: 200", r4.statusCode === 200, r4.body.slice(0, 200));
const after4 = await itemsNow();
ok("replace: the omitted add-on was removed", !after4.some((i) => i.price === connPrice.publicId));
ok(
  "replace: the listed add-on survived",
  after4.some((i) => i.price === destPrice.publicId),
);
ok("replace: the plan survived", after4.filter((i) => i.kind === "plan").length === 1);

// ── 5. The plan is never a removal candidate, by either mechanism ────────────
const r5 = await post(base, {
  items: [{ price: destPrice.publicId, quantity: 1 }],
  replace_items_list: true,
  mandatory_items_to_remove: [litePrice.publicId], // asking to remove the PLAN
  prorate: false,
  invoice_immediately: false,
});
ok("plan-removal attempt: 200 (not an error, just refused)", r5.statusCode === 200);
const after5 = await itemsNow();
ok(
  "the plan survives an exhaustive list that omits it",
  after5.filter((i) => i.kind === "plan").length === 1,
);
ok(
  "the plan survives being NAMED in mandatory_items_to_remove",
  after5.some((i) => i.price === litePrice.publicId),
);

// ── 6. A plan SWAP re-points the plan item, never adds a second ──────────────
const r6 = await post(base, {
  items: [{ price: proPrice.publicId, quantity: 1 }],
  prorate: false,
  invoice_immediately: false,
});
ok("swap: 200", r6.statusCode === 200, r6.body.slice(0, 200));
const after6 = await itemsNow();
ok("swap: exactly one plan", after6.filter((i) => i.kind === "plan").length === 1);
ok("swap: it is the new plan", after6.find((i) => i.kind === "plan")?.price === proPrice.publicId);
ok("TRIAL: a plan swap still raised no invoice", (await invoiceCount()) === invoicesAtStart);
const stillTrial = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.id, sub.subscription.id)),
);
ok(
  "TRIAL: the subscription is still in trial after the upgrade",
  stillTrial[0]!.status === "in_trial",
  stillTrial[0]!.status,
);

// ── 7. Input handling ────────────────────────────────────────────────────────
const rBad = await post(base, { items: [{ price: "price_does_not_exist" }], prorate: false });
ok("unknown price → 400, not 500", rBad.statusCode === 400, rBad.statusCode);
const rEmpty = await post(base, { items: [] });
ok("empty item list → 400", rEmpty.statusCode === 400, rEmpty.statusCode);
const before7 = await itemsNow();
const rNoop = await post(base, {
  items: [{ price: proPrice.publicId, quantity: 1 }],
  prorate: false,
  invoice_immediately: false,
});
ok(
  "a no-op list is a no-op",
  rNoop.statusCode === 200 && JSON.parse(rNoop.body).applied?.changed === 0,
);
ok("a no-op list changed nothing", JSON.stringify(await itemsNow()) === JSON.stringify(before7));

// ── 8. A TERM RESET must not bill an item the same call REMOVES (money, 2026-08-31) ──
// Reported from real data: driving the change-mode checkout for a subscription whose
// current term was open, the page rendered "Additional Connections × 60 — Removed" and the
// new-term invoice billed it ₹45,120.00 + tax = ₹53,241.60 anyway, for an item the same
// call deleted from `subscription_items`. Cause: `applyItemOperations` ran the removals as
// a leg AFTER `changeSubscription`, so the reset's charge loop — which bills "the FULL
// new-term price for every POST-change item" and reads `removedItemIds` to know which
// those are — saw an empty removal set and could not exclude it.
//
// Asserted on the invoice LINES, not the total. The total is also wrong, but a line naming
// the removed add-on is the evidence, and a total can be right for two offsetting reasons.
{
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "ufi-reset-remove@a.com",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cus.id,
    now: new Date("2026-09-01T00:00:00.000Z"),
    items: [
      { price: litePrice, quantity: 1 },
      { price: connPrice, quantity: 5 },
    ],
  });
  const url = `/v1/businesses/${biz.publicId}/subscriptions/${sub.subscription.publicId}/update_for_items`;
  // replace_items_list with ONLY the new plan ⇒ the connections add-on is removed, and
  // reset_term forces the whole-new-term charge that exposes the defect.
  const res = await post(url, {
    items: [{ price: proPrice.publicId, quantity: 1 }],
    replace_items_list: true,
    reset_term: true,
    prorate: true,
    invoice_immediately: true,
  });
  ok("§8 reset+remove: the call succeeds", res.statusCode === 200, res.statusCode);
  const after = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, sub.subscription.id)),
  );
  ok("§8 the add-on really is removed from the subscription", after.length === 1, after.length);
  const invs = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, sub.subscription.id)),
  );
  const lines = await withTenant(orgId, async (tx) => {
    const out: Array<{ desc: string; amount: bigint }> = [];
    for (const i of invs) {
      const rows = await tx
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, i.id));
      for (const r of rows) out.push({ desc: r.description ?? "", amount: r.amountMinor });
    }
    return out;
  });
  const connLines = lines.filter(
    (l) => l.desc.toLowerCase().includes("connection") && l.amount > 0n,
  );
  ok(
    "§8 NO positive invoice line charges the removed add-on",
    connLines.length === 0,
    connLines.map((l) => `${l.desc}=${l.amount}`),
  );
  const planLines = lines.filter((l) => l.desc.toLowerCase().includes("pro") && l.amount > 0n);
  ok(
    "§8 CONTROL — the new plan IS billed for the new term",
    planLines.length > 0,
    planLines.length,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail === 0 ? 0 : 1);
