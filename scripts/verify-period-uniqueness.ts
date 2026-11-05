/**
 * One live invoice opens each subscription period (0370, `invoices_opens_period_uq`).
 * What regresses without each check:
 *  - two concurrent clock bills of one period both commit (the customer is billed twice);
 *  - the first-period heal, racing itself, raises a duplicate or records a failure;
 *  - a voided period can no longer be billed again;
 *  - an invoice from a request path (reactivation, term-end arrears) is refused because
 *    the clock's invoice already opens that period.
 *
 *   pnpm verify:period-uniqueness
 */
import { and, eq, ne } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { voidInvoice } from "@/modules/invoicing/ops";
import { invoices } from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const RUN = Math.random().toString(36).slice(2, 8);

async function main() {
  const org = await createOrganization({ name: `Period Unique Org ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Period Unique Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const payer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `period-unique-${RUN}@example.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: payer,
    token: "tok_4242",
  });
  // No card, auto-collection off: its invoices stay open, so they can be voided.
  const offline = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `period-unique-off-${RUN}@example.com`,
    autoCollection: "off",
  });
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Pro",
    id: `pro-${RUN}`,
    kind: "plan",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const subscribe = async (customerId: string, startDate?: Date) => {
    const now = new Date();
    return (
      await createSubscription({
        organizationId: orgId,
        businessId: biz.id,
        customerId,
        now,
        ...(startDate ? { startDate } : {}),
        items: [{ price, quantity: 1 }],
      })
    ).subscription;
  };
  const liveInvoices = (subId: string) =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.subscriptionId, subId), ne(invoices.status, "voided"))),
    );
  const billInput = (sub: Awaited<ReturnType<typeof subscribe>>) => ({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  const nameOf = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? ((r.reason as Error)?.name ?? String(r.reason)) : "fulfilled";

  // ── Two concurrent clock bills of one period ──────────────────────────────
  const a = await subscribe(payer.id);
  const raced = await Promise.allSettled([
    billSubscriptionPeriod(billInput(a), { opensPeriod: true }),
    billSubscriptionPeriod(billInput(a), { opensPeriod: true }),
  ]);
  const invA = await liveInvoices(a.id);
  ok(
    "two concurrent bills of one period create one invoice",
    invA.length === 1,
    String(invA.length),
  );
  ok(
    "…the other finds the period billed",
    raced.filter((r) => r.status === "fulfilled").length === 1 &&
      raced.some((r) => nameOf(r) === "PeriodAlreadyBilledError"),
    raced.map(nameOf).join(","),
  );
  ok("…and the invoice is marked as opening the period", invA[0]?.opensPeriod === true);

  // ── The first-period heal racing itself ───────────────────────────────────
  // Active, start_date = term start, no invoice: the crash window the heal repairs.
  const b = await subscribe(payer.id, new Date());
  const now = new Date();
  const ticks = await Promise.all(
    [1, 2, 3].map(() =>
      runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(now)),
    ),
  );
  const invB = await liveInvoices(b.id);
  ok("three concurrent ticks heal the first period once", invB.length === 1, String(invB.length));
  const errs = ticks.flatMap((t) => t.errors);
  ok("…and record no failure", errs.length === 0, JSON.stringify(errs));

  // ── A voided period can be billed again ───────────────────────────────────
  const c = await subscribe(offline.id);
  const first = await billSubscriptionPeriod(billInput(c), { opensPeriod: true });
  await voidInvoice(orgId, biz.id, first.invoice.publicId);
  const again = await billSubscriptionPeriod(billInput(c), { opensPeriod: true }).then(
    () => "fulfilled",
    (e: Error) => e?.name ?? String(e),
  );
  ok("a voided period can be billed again", again === "fulfilled", again);
  ok("…one live invoice remains", (await liveInvoices(c.id)).length === 1);

  // ── Request-path invoices are not limited ─────────────────────────────────
  const extra = await billSubscriptionPeriod(billInput(c)).then(
    () => "fulfilled",
    (e: Error) => e?.name ?? String(e),
  );
  ok("an unmarked invoice for the same period is still allowed", extra === "fulfilled", extra);
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
console.log(pass ? "\n✅ PERIOD-UNIQUENESS: PASS" : "\n❌ PERIOD-UNIQUENESS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
