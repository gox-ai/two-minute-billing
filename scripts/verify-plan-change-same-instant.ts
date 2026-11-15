/**
 * verify:plan-change-same-instant — a plan change at the instant the subscription started.
 *
 * A test business with a started (frozen) clock creates and changes a subscription at one
 * simulated time. The old plan's credit grant starts at that instant, so it cannot expire there
 * (`expires_at > effective_at`); the change used to answer 500. Proves, on a $0 plan that
 * grants credits each month, upgraded to a paid plan:
 *  - `update_for_items` (auto-collection off): 200, the paid plan is on, the $0 grant is booked out;
 *  - a hosted `change` checkout (auto-collection on, card on file): completes, the $99 invoice is
 *    paid and the paid plan's grant is the only active one;
 *  - a create checkout on the frozen clock stamps the subscription at the simulated instant, and
 *    usage sent at that instant bills on the renewal;
 *  - the same `update_for_items` on an unfrozen business still ends the old grant at the change.
 *
 *   pnpm verify:all:fresh -- --suite plan-change-same-instant
 */
import { buildApp } from "@/index";
import { closeDb } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { getCustomerByPublicId } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { runWithClockScope } from "@/platform/clock";
import { runPlanCreditResets } from "@/modules/credits/credit-clock";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { sendEvent } from "./lib/meter-fixtures";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++;
  else fail++;
  console.log(
    `${cond ? "✓" : "✗"} ${label}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
};

const app = await buildApp({ logger: false });
await clearPublicRateLimits();
const org = await createOrganization({ name: "Same Instant Change Org" });
const orgId = org.organization.id;
const { secret } = await createApiKey(orgId, "test");
let n = 0;
const call = async (
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
  token = secret,
) => {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      ...(method === "GET" ? {} : { "idempotency-key": `psi-${n++}-${Date.now()}` }),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
  let body: any = {};
  try {
    body = res.json();
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
};
const must = (r: { status: number; body: any }, what: string) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

const credits = (amount: number) => ({
  kind: "per_cycle",
  unit: "credit",
  amount,
  reset: { every: "month" },
  rollover: { mode: "none" },
  on_exhausted: "block",
  applicability: { kind: "meters", meters: ["image_credits"] },
});

/** A business with a $0 Free plan and a $99 Pro plan, each granting credits every month. */
async function setUp(name: string) {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  const B = `/v1/businesses/${biz.publicId}`;
  must(
    await call("POST", `${B}/credit_units`, {
      id: "credit",
      name: "credit",
      currency: "USD",
      minor_per_unit: "60",
      decimals: 1,
    }),
    "credit unit",
  );
  must(
    await call("POST", `${B}/meters`, {
      id: "image_credits",
      name: "Image credits",
      event_name: "image_credits",
      aggregation: "sum",
      value_property: "credits",
    }),
    "meter",
  );
  for (const p of ["free", "pro"])
    must(await call("POST", `${B}/products`, { id: p, name: p, kind: "plan" }), `product ${p}`);
  must(await call("POST", `${B}/products`, { id: "usage", name: "Usage", kind: "addon" }), "addon");
  const plan = (id: string, product: string, amount: number, grant: number) =>
    call("POST", `${B}/prices`, {
      id,
      product,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amount_minor: amount,
      interval: "month",
      grants_credit: credits(grant),
    });
  must(await plan("free-monthly", "free", 0, 50), "free price");
  must(await plan("pro-monthly", "pro", 9900, 5000), "pro price");
  must(
    await call("POST", `${B}/prices`, {
      id: "usage-monthly",
      product: "usage",
      type: "recurring",
      model: "usage",
      currency: "USD",
      interval: "month",
      meter: "image_credits",
      unit_amount_decimal: "60",
    }),
    "usage price",
  );
  return { biz, B };
}

/** A customer with a card on file and a $0 Free subscription created by API. */
async function freeSignup(b: { biz: { id: string }; B: string }, tag: string) {
  const cus = must(
    await call("POST", `${b.B}/customers`, {
      email: `${tag}@example.com`,
      address: {
        line1: "1 Main Street",
        city: "Austin",
        state_code: "TX",
        postal_code: "73301",
        country: "US",
        first_name: "Test",
        last_name: "Buyer",
      },
    }),
    "customer",
  );
  const customer = (await getCustomerByPublicId(orgId, b.biz.id, cus.id))!;
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: b.biz.id,
    customer,
    token: "tok_4242",
  });
  const sub = must(
    await call("POST", `${b.B}/customers/${cus.id}/subscriptions`, {
      items: [{ price: "free-monthly" }, { price: "usage-monthly" }],
      auto_collection: "off",
    }),
    "free subscription",
  );
  return { cus: cus.id as string, sub: sub.id as string };
}

const grantsOf = async (B: string, cus: string) =>
  (must(await call("GET", `${B}/customers/${cus}/credit_grants`), "grants").data ?? []) as Array<{
    status: string;
    amount: number;
  }>;
const toPro = {
  items: [{ price: "pro-monthly" }, { price: "usage-monthly" }],
  replace_items_list: true,
};

// ── 1 · frozen clock: update_for_items ─────────────────────────────────────────
const frozen = await setUp("Frozen Clock Biz");
must(
  await call("POST", `${frozen.B}/time_travel/start`, { genesis_time: new Date().toISOString() }),
  "time travel start",
);
try {
  const a = await freeSignup(frozen, "frozen-api");
  const before = await grantsOf(frozen.B, a.cus);
  ok(
    "frozen clock: the Free signup grants 5 credits (50 tenths)",
    before.length === 1 && before[0]!.amount === 50 && before[0]!.status === "active",
    before,
  );
  const upd = await call("POST", `${frozen.B}/subscriptions/${a.sub}/update_for_items`, {
    ...toPro,
    reset_term: true,
  });
  ok(
    "frozen clock: update_for_items Free → Pro at the signup instant → 200",
    upd.status === 200,
    upd.body,
  );
  ok(
    "frozen clock: the subscription is on Pro",
    (upd.body.items ?? []).some((i: any) => i.price === "pro-monthly") &&
      !(upd.body.items ?? []).some((i: any) => i.price === "free-monthly"),
    upd.body.items,
  );
  // A term reset grants the new plan through its term invoice, open here (auto-collection off).
  const after = await grantsOf(frozen.B, a.cus);
  ok(
    "frozen clock: the Free grant is booked out (expired, nothing left) and no Free grant is active",
    after.some((g: any) => g.amount === 50 && g.status === "expired" && g.remaining?.units === 0) &&
      !after.some((g) => g.amount === 50 && g.status === "active"),
    after.map((g: any) => [g.amount, g.status, g.remaining?.units]),
  );

  // ── 2 · frozen clock: hosted change checkout, card on file, auto-collection on ──
  const c = await freeSignup(frozen, "frozen-checkout");
  must(
    await call("PATCH", `${frozen.B}/subscriptions/${c.sub}`, { auto_collection: "on" }),
    "auto-collection on",
  );
  const session = must(
    await call("POST", `${frozen.B}/checkout_sessions`, {
      mode: "change",
      subscription: c.sub,
      ...toPro,
      reset_term: true,
    }),
    "change session",
  );
  const done = await call("POST", "/checkout/v1/complete", {}, session.token);
  ok("frozen clock: a change checkout Free → Pro completes (201)", done.status === 201, done.body);
  const sub = must(await call("GET", `${frozen.B}/subscriptions/${c.sub}`), "sub");
  ok(
    "frozen clock: the checkout put the subscription on Pro",
    (sub.items ?? []).some((i: any) => i.price === "pro-monthly"),
    sub.items,
  );
  const invs = must(await call("GET", `${frozen.B}/invoices?subscription=${c.sub}`), "invoices");
  ok(
    "frozen clock: the change invoice of $99 is paid",
    (invs.data ?? []).some((i: any) => i.total_minor === 9900 && i.status === "paid"),
    (invs.data ?? []).map((i: any) => [i.total_minor, i.status]),
  );
  // A term reset hands the new plan's monthly window to the credit clock's next pass.
  const simNow = new Date(
    must(await call("GET", `${frozen.B}/time_travel`), "clock").simulated_now,
  );
  await runWithClockScope({ onlyBusinessId: frozen.biz.id, now: simNow }, () =>
    runPlanCreditResets(simNow),
  );
  const paidGrants = await grantsOf(frozen.B, c.cus);
  ok(
    "frozen clock: after the paid change, the Pro grant (5000) is the only active one",
    paidGrants
      .filter((g) => g.status === "active")
      .map((g) => g.amount)
      .join() === "5000",
    paidGrants.map((g) => [g.amount, g.status]),
  );

  // ── 2b · hosted checkout writes at the business clock ─────────────────────────
  // A checkout-created subscription used to be stamped at wall time, after usage stamped at the
  // simulated instant, so its renewal billed that usage as 0.
  const k = must(
    await call("POST", `${frozen.B}/customers`, { email: "frozen-create@example.com" }),
    "customer",
  );
  const kSession = must(
    await call("POST", `${frozen.B}/checkout_sessions`, {
      items: [{ price: "pro-monthly" }, { price: "usage-monthly" }],
      customer_id: k.id,
    }),
    "create session",
  );
  await call(
    "POST",
    "/checkout/v1/customer",
    {
      address: {
        line1: "2 Main Street",
        city: "Austin",
        state_code: "TX",
        postal_code: "73301",
        country: "US",
        first_name: "Frozen",
        last_name: "Buyer",
      },
    },
    kSession.token,
  );
  const kDone = await call("POST", "/checkout/v1/complete", { token: "tok_4242" }, kSession.token);
  const clock0 = new Date(
    must(await call("GET", `${frozen.B}/time_travel`), "clock").simulated_now,
  );
  const kSub = must(
    await call("GET", `${frozen.B}/subscriptions/${kDone.body.subscription_id}`),
    "sub",
  );
  ok(
    "frozen clock: a checkout-created subscription is stamped at the simulated instant",
    kDone.status === 201 && new Date(kSub.created_at).getTime() === clock0.getTime(),
    { done: kDone.status, created_at: kSub.created_at, simulated_now: clock0 },
  );
  // Received 10 minutes ago on the real clock, so the 5-minute fold cutoff does not hold it back.
  const kCustomer = (await getCustomerByPublicId(orgId, frozen.biz.id, k.id))!;
  await sendEvent(
    { organizationId: orgId, businessId: frozen.biz.id },
    {
      customerId: kCustomer.id,
      eventName: "image_credits",
      at: clock0,
      properties: { credits: 2 },
    },
  );
  must(
    await call("POST", `${frozen.B}/time_travel/advance`, {
      to_time: new Date(clock0.getTime() + 32 * 86_400_000).toISOString(),
    }),
    "advance",
  );
  const kInvs = must(await call("GET", `${frozen.B}/invoices?subscription=${kSub.id}`), "invoices");
  const renewal = (kInvs.data ?? []).find(
    (i: any) =>
      i.billing_reason !== "subscription_create" &&
      i.id !== kDone.body.invoice_id &&
      i.total_minor === 9900,
  );
  const renewalLines = renewal
    ? (must(await call("GET", `${frozen.B}/invoices/${renewal.id}`), "invoice").lines ?? [])
    : [];
  ok(
    "frozen clock: usage at the signup instant bills on the renewal (2 credits = 120)",
    renewalLines.some((l: any) => l.price === "usage-monthly" && l.amount_minor === 120),
    {
      invoices: (kInvs.data ?? []).map((i: any) => [i.id, i.total_minor]),
      lines: renewalLines.map((l: any) => [l.price, l.amount_minor]),
    },
  );
} finally {
  await call("POST", `${frozen.B}/time_travel/stop`, { wipe: false });
}

// ── 3 · real clock: the old grant still ends at the change ─────────────────────
const live = await setUp("Real Clock Biz");
const r = await freeSignup(live, "real-api");
await new Promise((res) => setTimeout(res, 5));
const upd = await call("POST", `${live.B}/subscriptions/${r.sub}/update_for_items`, toPro);
ok("real clock: update_for_items Free → Pro → 200", upd.status === 200, upd.body);
const g = await grantsOf(live.B, r.cus);
ok(
  "real clock: the Free grant is ended by the change and the Pro grant is active",
  g.some((x) => x.amount === 50) &&
    g.some((x) => x.amount === 5000 && x.status === "active") &&
    g.filter((x) => x.status === "active" && x.amount === 50).length <= 1,
  g,
);

await app.close();
await closeDb();
console.log(
  `\n${fail === 0 ? "✅" : "❌"} plan-change-same-instant: ${pass} passed, ${fail} failed`,
);
process.exit(fail === 0 ? 0 : 1);
