/**
 * Time Travel row stamps: rows written while a business's clock is pinned record the
 * SIMULATED instant (column defaults via `app_now()`, engine stamps via `stampNow`), and
 * rows written outside a pin record wall time.
 *
 *   during travel      renewal invoice created_at + paid_at, its payment, ledger rows
 *   pinned scope       subscription create → mrr movement, customer updated_at trigger
 *   API on a TM biz    POST customer → created_at = time_travels.simulated_now
 *   outside a pin      service call on the TM biz, API on a plain test biz → wall time
 *
 *   pnpm verify:time-travel-stamps
 */
import { and, eq, desc } from "drizzle-orm";
import { withTenant, closeDb, type Tx } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { buildApp } from "@/index";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { startTimeTravel, travelForward, stopTimeTravel } from "@/modules/time-travel/service";
import { invoices, payments, customers, ledgerEntries, mrrMovements } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const DAY = 86_400_000;
const G = new Date("2026-01-01T00:00:00.000Z");
/** Within `ms` of `at`. */
const near = (d: Date | null | undefined, at: Date, ms = DAY) =>
  d != null && Math.abs(d.getTime() - at.getTime()) <= ms;
/** Recorded at wall time (not the simulated past). */
const wall = (d: Date | null | undefined) => near(d, new Date(), 10 * 60_000);

const org = await createOrganization({ name: "TM Stamps Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "TM stamps",
  defaultCurrency: "USD",
  livemode: "test",
});
const plain = await createBusiness({
  organizationId: orgId,
  name: "Plain test biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const key = (await createApiKey(orgId, "test")).secret;

const plan = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Stamp Plan",
  id: "stamp-plan",
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

const app = await buildApp({ logger: false });
const postCustomer = (bizPublicId: string, email: string) =>
  app.inject({
    method: "POST",
    url: `/v1/businesses/${bizPublicId}/customers`,
    headers: { authorization: `Bearer ${key}`, "idempotency-key": `stamp-${email}` },
    payload: { email, auto_collection: "on" },
  });
const customerByEmail = async (email: string) =>
  (
    await withTenant(orgId, (tx: Tx) =>
      tx.select().from(customers).where(eq(customers.email, email)).limit(1),
    )
  )[0];

// ── API on the time-travelled business → simulated_now ──────────────────────────
const r1 = await postCustomer(biz.publicId, "stamp-api@a.com");
const apiCust = await customerByEmail("stamp-api@a.com");
ok(`API customer on TM biz created (${r1.statusCode})`, r1.statusCode < 300 && !!apiCust);
ok(
  "API customer on TM biz: created_at = simulated_now",
  apiCust?.createdAt.getTime() === G.getTime(),
);

// ── API on a plain test business → wall ────────────────────────────────────────
const r2 = await postCustomer(plain.publicId, "stamp-plain@a.com");
const plainCust = await customerByEmail("stamp-plain@a.com");
ok(`API customer on plain biz created (${r2.statusCode})`, r2.statusCode < 300 && !!plainCust);
ok("API customer on plain biz: created_at = wall time", wall(plainCust?.createdAt));

// ── service call on the TM business with no pin → wall ─────────────────────────
const direct = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "stamp-direct@a.com",
  autoCollection: "on",
});
ok("unpinned service call: customer created_at = wall time", wall(direct.createdAt));

// ── pinned scope: customer + subscription as-of genesis ───────────────────────
const { cust, sub } = await runWithClockScope({ onlyBusinessId: biz.id, now: G }, async () => {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "stamp-sub@a.com",
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
  return { cust: c, sub: subscription };
});
ok("pinned: customer created_at = G", cust.createdAt.getTime() === G.getTime());
ok("pinned: subscription created_at = G", sub.createdAt.getTime() === G.getTime());

const moves = await withTenant(orgId, (tx: Tx) =>
  tx.select().from(mrrMovements).where(eq(mrrMovements.subscriptionId, sub.id)),
);
ok(
  `pinned: mrr movement recorded at G (${moves.length} rows)`,
  moves.length > 0 && moves.every((m) => near(m.createdAt, G, 0) && near(m.occurredAt, G, 0)),
);

// ── outside the pin, an UPDATE fills updated_at with wall time ─────────────────
await withTenant(orgId, (tx: Tx) =>
  tx.update(customers).set({ company: "Wall Co" }).where(eq(customers.id, direct.id)),
);
const directAfter = await customerByEmail("stamp-direct@a.com");
ok("unpinned update: updated_at = wall time", wall(directAfter?.updatedAt));

// ── travel through the first renewal ──────────────────────────────────────────
const renewalAt = new Date("2026-02-01T00:00:00.000Z");
await travelForward({ orgId, bizId: biz.id, toTime: new Date(renewalAt.getTime() + 3 * DAY) });

const invs = await withTenant(orgId, (tx: Tx) =>
  tx
    .select()
    .from(invoices)
    .where(eq(invoices.subscriptionId, sub.id))
    .orderBy(desc(invoices.createdAt)),
);
const renewal = invs.find((i) => near(i.periodStart ?? null, renewalAt, DAY));
ok(`travel: renewal invoice raised (${invs.length} invoices)`, !!renewal);
ok(
  `travel: renewal invoice created_at simulated (${renewal?.createdAt.toISOString()})`,
  near(renewal?.createdAt, renewalAt, 2 * DAY),
);
ok(
  `travel: renewal invoice paid_at simulated (${renewal?.paidAt?.toISOString()})`,
  renewal?.status === "paid" && near(renewal?.paidAt, renewalAt, 2 * DAY),
);

const pays = renewal
  ? await withTenant(orgId, (tx: Tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, renewal.id)),
    )
  : [];
ok(
  `travel: renewal payment created_at simulated (${pays.length} rows)`,
  pays.length > 0 && pays.every((p) => near(p.createdAt, renewalAt, 2 * DAY)),
);

const ledger = await withTenant(orgId, (tx: Tx) =>
  tx
    .select({ createdAt: ledgerEntries.createdAt })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.businessId, biz.id))),
);
ok(
  `travel: no ledger row dated wall time (${ledger.length} rows)`,
  ledger.length > 0 && ledger.every((l) => !wall(l.createdAt)),
);

await stopTimeTravel({ orgId, bizId: biz.id });
await app.close();

let failed = 0;
for (const [n, c] of checks) {
  console.log(`${c ? "✓" : "✗"} ${n}`);
  if (!c) failed++;
}
console.log(failed ? `\n❌ TIME-TRAVEL-STAMPS: FAIL (${failed})` : "\n✅ TIME-TRAVEL-STAMPS: PASS");
await closeDb();
process.exit(failed ? 1 : 0);
