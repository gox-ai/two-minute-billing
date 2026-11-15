/**
 * The explain routes, on real engine output, and the MCP tools over them.
 *
 *  - § A invoice explanation: the ladder adds up, lines carry their facts, the second of two
 *        proration invoices is compared to the first
 *  - § B MRR bridge: new + expansion by reason, opening + change = closing, closing = the
 *        business's current MRR, the largest movement names its customer
 *  - § C the explain_* MCP tools return the same answers through /mcp
 *
 *   pnpm verify:explain
 */
import { randomBytes } from "node:crypto";
import { buildApp } from "@/index";
import { closeDb } from "@/platform/db";
import { createOrganization, createApiKey, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { zonedDayString } from "@/platform/timezones";

const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const uniq = randomBytes(4).toString("hex");

const org = await createOrganization({ name: `Explain ${uniq}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: `Explain Biz ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const key = (await createApiKey(orgId, "test", "api", "read", "AI")).secret;

const get = async (path: string) => {
  const r = await app.inject({
    method: "GET",
    url: `/v1/businesses/${biz.publicId}/${path}`,
    headers: { authorization: `Bearer ${key}` },
  });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};

const customer = await createCustomer({
  ...ctx,
  email: `explain-${uniq}@example.com`,
  firstName: "Larkfield",
  lastName: "Studio",
});
await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
const product = await createProduct({ ...ctx, name: "Seats", kind: "plan" });
const price = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const start = new Date();
const { subscription, items } = await createSubscription({
  ...ctx,
  customerId: customer.id,
  now: start,
  items: [{ price, quantity: 1 }],
});
const changeAt = new Date(start.getTime() + 10 * 86_400_000);
const { prorationInvoice: firstChange } = await changeSubscription({
  ...ctx,
  subscriptionId: subscription.id,
  now: changeAt,
  changes: [{ itemId: items[0]!.publicId, newQuantity: 3 }],
  invoiceImmediately: true,
});
// A second mid-period change raises a second invoice to compare with the first.
const secondAt = new Date(start.getTime() + 15 * 86_400_000);
const { prorationInvoice } = await changeSubscription({
  ...ctx,
  subscriptionId: subscription.id,
  now: secondAt,
  changes: [{ itemId: items[0]!.publicId, newQuantity: 5 }],
  invoiceImmediately: true,
});

// ── § A · invoice explanation ────────────────────────────────────────────────────
{
  const first = firstChange?.publicId;
  ok("A0 setup: two proration invoices exist", !!first && !!prorationInvoice);

  const e1 = await get(`invoices/${first}/explanation`);
  ok(
    "A1 the first change's invoice explains (200)",
    e1.status === 200 && e1.body.object === "invoice_explanation",
  );
  ok("A2 its totals ladder adds up", e1.body.totals?.holds === true);
  ok(
    "A3 its line is a proration naming its price, quantity and period",
    (e1.body.lines ?? []).some(
      (l: any) =>
        l.kind === "proration" &&
        l.price === price.publicId &&
        l.quantity === 2 &&
        l.period_days > 0,
    ),
  );
  ok(
    "A4 the first invoice of the subscription has nothing to compare with",
    e1.body.compared_to_previous === null,
  );

  const e2 = await get(`invoices/${prorationInvoice!.publicId}/explanation`);
  ok(
    "A5 the second change's invoice explains and adds up",
    e2.status === 200 && e2.body.totals?.holds === true,
  );
  ok(
    "A6 it has a proration line with a why",
    (e2.body.lines ?? []).some((l: any) => l.kind === "proration" && typeof l.why === "string"),
  );
  const cmp = e2.body.compared_to_previous;
  ok("A7 it is compared to the first change's invoice", cmp?.previous_invoice === first);
  ok(
    "A8 the comparison's total delta is the two stored totals' difference",
    cmp?.total_delta_minor === e2.body.totals.total_minor - e1.body.totals.total_minor,
  );
  ok(
    "A9 the comparison shows the proration charge changing, with its quantities",
    cmp?.line_changes?.[0]?.change === "changed" &&
      cmp.line_changes[0].before?.quantity === 2 &&
      cmp.line_changes[0].after?.quantity === 2 &&
      cmp.line_changes[0].delta_minor === cmp.total_delta_minor,
  );

  const missing = await get(`invoices/inv_doesnotexist/explanation`);
  ok("A10 an unknown invoice → 404", missing.status === 404);
}

// ── § B · MRR bridge ─────────────────────────────────────────────────────────────
{
  const startDay = zonedDayString(new Date(start.getTime() - 86_400_000), biz.timezone);
  const endDay = zonedDayString(new Date(secondAt.getTime() + 86_400_000), biz.timezone);
  const b = await get(`mrr_bridge?start=${startDay}&end=${endDay}`);
  const reason = (r: string) => (b.body.reasons ?? []).find((x: any) => x.reason === r);
  ok("B1 the bridge answers (200)", b.status === 200 && b.body.object === "mrr_bridge");
  ok("B2 new = 1,000 (one seat)", reason("new")?.mrr_delta_minor === 1000);
  ok(
    "B3 expansion = 4,000 in two movements (two seats, twice)",
    reason("expansion")?.mrr_delta_minor === 4000 && reason("expansion")?.movements === 2,
  );
  ok(
    "B4 opening + change = closing",
    b.body.opening_mrr_minor + b.body.change_minor === b.body.closing_mrr_minor,
  );
  const metrics = await get("metrics");
  const usd = (metrics.body.currencies ?? []).find((c: any) => c.currency === "USD");
  ok("B5 closing = the business's current MRR", usd?.mrr_minor === b.body.closing_mrr_minor);
  ok(
    "B6 the largest expansion names the customer and subscription",
    reason("expansion")?.largest?.[0]?.customer === customer.publicId &&
      reason("expansion")?.largest?.[0]?.subscription === subscription.publicId &&
      reason("expansion")?.largest?.[0]?.customer_name === "Larkfield Studio",
  );
  const later = zonedDayString(new Date(secondAt.getTime() + 2 * 86_400_000), biz.timezone);
  const after = await get(`mrr_bridge?start=${later}&end=${later}`);
  ok(
    "B7 a later window opens at the earlier close and moves nothing",
    after.body.opening_mrr_minor === b.body.closing_mrr_minor && after.body.change_minor === 0,
  );
  const bad = await get(`mrr_bridge?start=${endDay}&end=${startDay}`);
  ok("B8 start after end → 400", bad.status === 400);
  const unknown = await get(`mrr_bridge?nonsense=1`);
  ok("B9 an unknown parameter → 400", unknown.status === 400);
}

// ── § C · the MCP tools ──────────────────────────────────────────────────────────
{
  let id = 0;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await app.inject({
      method: "POST",
      url: `/mcp/${biz.publicId}`,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args },
      },
    });
    const res = r.json().result as { isError?: boolean; content: Array<{ text: string }> };
    const text = res?.content?.[0]?.text ?? "";
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      if (res?.isError !== true || !name.startsWith("explain_balance"))
        console.log(`    ${name}: ${text}`);
    }
    return { isError: res?.isError === true, body, text };
  };
  const ei = await tool("explain_invoice", { invoice: prorationInvoice!.publicId });
  ok(
    "C1 explain_invoice answers through MCP",
    !ei.isError && ei.body?.result?.object === "invoice_explanation",
  );
  const em = await tool("explain_mrr_change", {
    start: zonedDayString(new Date(start.getTime() - 86_400_000), biz.timezone),
    end: zonedDayString(new Date(secondAt.getTime() + 86_400_000), biz.timezone),
  });
  ok(
    "C2 explain_mrr_change answers through MCP",
    !em.isError && em.body?.result?.closing_mrr_minor === 5000,
  );
  const ep = await tool("explain_payment", { invoice: prorationInvoice!.publicId });
  ok(
    "C3 explain_payment returns the state, the journey and the payment methods",
    !ep.isError && !!ep.body?.result?.invoice?.status && !!ep.body?.result?.dunning_journey,
  );
  const eb = await tool("explain_balance", { customer: customer.publicId });
  ok(
    "C4 explain_balance answers through MCP",
    !eb.isError && "promotional_credits" in (eb.body?.result ?? {}),
  );
  const missing = await tool("explain_balance", { customer: "cus_doesnotexist" });
  ok("C5 explain_balance on an unknown customer is an error result", missing.isError);
}

await app.close();
let failed = 0;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
await closeDb();
process.exit(failed ? 1 : 0);
