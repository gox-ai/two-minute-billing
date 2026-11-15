/**
 * verify:credits-follow-money — plan credits follow what the customer pays for.
 *
 *  A1(a) a scheduled end-of-term downgrade grants the lower plan's first window at the
 *        renewal (next_window, prorated and full alike: exactly the new plan's amount);
 *  A1(b) an immediate downgrade may prorate (business rule and per-call), reset and term grants;
 *  A2    `grant_when: invoice_paid`: plan credits are pending while their invoice is unpaid,
 *        not spendable, active once paid with their window, voided on a non-payment cancel;
 *        `on_unpaid_cancel: void_unused` voids the unpaid period's credits; `keep` keeps them;
 *  A3    a $0 first invoice needs no card; an amount due without one is refused, nothing kept;
 *  A4    `in_flight_applies: other_holds_open` checks the hold share only beside another hold;
 *        a PATCH that omits it keeps it;
 *  B7    usage ingested just before a test-clock advance is billed on that renewal;
 *        defaults for new businesses and for unset ones.
 *
 *   pnpm verify:all:fresh -- --suite credits-follow-money
 */
import { buildApp } from "@/index";
import { closeDb } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { getCustomerByPublicId } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import {
  initialBillingRulesConfig,
  resolveBillingRulesConfig,
} from "@/modules/subscriptions/billing-rules-config";
import { initialCreditConfig } from "@/modules/credits/customer-settings";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";

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
const org = await createOrganization({ name: "Credits Follow Money Org" });
const orgId = org.organization.id;
const { secret } = await createApiKey(orgId, "test");
let n = 0;
const call = async (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
) => {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      ...(method === "GET" ? {} : { "idempotency-key": `cfm-${n++}-${Date.now()}` }),
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

const H = 3_600_000;
const DAY = 24 * H;
const ms = (s: string | null | undefined) => (s ? new Date(s).getTime() : NaN);
/** Proration rounds half-up to a whole step. */
const halfUp = (num: bigint, den: bigint) => (2n * num + den) / (2n * den);
const METER = "image_credits";

const credits = (amount: number, reset: boolean) => ({
  kind: "per_cycle",
  unit: "credit",
  amount,
  ...(reset ? { reset: { every: "month" } } : {}),
  rollover: { mode: "none" },
  on_exhausted: "block",
  applicability: { kind: "meters", meters: [METER] },
});

type Biz = { biz: { id: string; publicId: string }; B: string };
const ttStarted: string[] = [];

/** Free $0 (5 credits), Basic $39 (75), Pro $99 (500) each month; term twins; usage at 60. */
async function setUp(name: string): Promise<Biz> {
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
      id: METER,
      name: "Image credits",
      event_name: METER,
      aggregation: "sum",
      value_property: "credits",
    }),
    "meter",
  );
  for (const p of ["free", "basic", "pro"])
    must(await call("POST", `${B}/products`, { id: p, name: p, kind: "plan" }), `product ${p}`);
  must(await call("POST", `${B}/products`, { id: "usage", name: "Usage", kind: "addon" }), "addon");
  const plan = (id: string, product: string, amount: number, grant: number, reset: boolean) =>
    call("POST", `${B}/prices`, {
      id,
      product,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amount_minor: amount,
      interval: "month",
      grants_credit: credits(grant, reset),
    });
  must(await plan("free-monthly", "free", 0, 50, true), "free price");
  must(await plan("basic-monthly", "basic", 3900, 750, true), "basic price");
  must(await plan("pro-monthly", "pro", 9900, 5000, true), "pro price");
  must(await plan("basic-term", "basic", 3900, 750, false), "basic term price");
  must(await plan("pro-term", "pro", 9900, 5000, false), "pro term price");
  must(
    await call("POST", `${B}/prices`, {
      id: "usage-monthly",
      product: "usage",
      type: "recurring",
      model: "usage",
      currency: "USD",
      interval: "month",
      meter: METER,
      unit_amount_decimal: "60",
    }),
    "usage price",
  );
  return { biz, B };
}

const patchBiz = (b: Biz, body: Record<string, unknown>) => call("PATCH", b.B, body);

async function startClock(b: Biz) {
  must(
    await call("POST", `${b.B}/time_travel/start`, {
      genesis_time: new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString(),
    }),
    "time travel start",
  );
  ttStarted.push(b.B);
}
const simNow = async (b: Biz) =>
  new Date(must(await call("GET", `${b.B}/time_travel`), "clock").simulated_now);
const advanceTo = async (b: Biz, to: Date) =>
  must(await call("POST", `${b.B}/time_travel/advance`, { to_time: to.toISOString() }), "advance");

/** A customer, optionally with a card on file. */
async function customer(b: Biz, tag: string, token?: string) {
  const cus = must(
    await call("POST", `${b.B}/customers`, {
      email: `${tag}-${n}@example.com`,
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
  const row = (await getCustomerByPublicId(orgId, b.biz.id, cus.id))!;
  const pm = token
    ? await vaultPaymentMethod({
        organizationId: orgId,
        businessId: b.biz.id,
        customer: row,
        token,
      })
    : null;
  return { id: cus.id as string, row, pm: pm?.publicId ?? null };
}

const subscribe = (b: Biz, cus: string, prices: string[], auto: "on" | "off") =>
  call("POST", `${b.B}/customers/${cus}/subscriptions`, {
    items: prices.map((price) => ({ price })),
    auto_collection: auto,
  });

/** The good card goes; a hard-declining card is the only one left. */
async function swapToDecliningCard(b: Biz, c: { id: string; row: any; pm: string | null }) {
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: b.biz.id,
    customer: c.row,
    token: "tok_4000000000000002",
  });
  must(await call("DELETE", `${b.B}/customers/${c.id}/payment_methods/${c.pm}`), "detach card");
}

type Grant = {
  id: string;
  amount: number;
  status: string;
  source: string;
  effective_at: string;
  expires_at: string | null;
  invoice: string | null;
  remaining: { units: number };
};
const planGrants = async (b: Biz, cus: string): Promise<Grant[]> =>
  (
    (must(await call("GET", `${b.B}/customers/${cus}/credit_grants?limit=100`), "grants").data ??
      []) as Grant[]
  ).filter((g) => g.source === "plan_cycle");
const brief = (gs: Grant[]) =>
  gs.map((g) => [g.amount, g.status, g.effective_at, g.expires_at, g.remaining?.units]);
/** Active and live at `at`. */
const liveAt = (gs: Grant[], at: Date) =>
  gs.filter(
    (g) =>
      g.status === "active" &&
      ms(g.effective_at) <= at.getTime() &&
      (g.expires_at === null || ms(g.expires_at) > at.getTime()),
  );
const itemOf = (sub: any, price: string) =>
  (sub.items ?? []).find((i: any) => i.price === price)?.id as string;
const invoicesOf = async (b: Biz, sub: string) =>
  (must(await call("GET", `${b.B}/invoices?subscription=${sub}`), "invoices").data ?? []) as any[];
const access = async (b: Biz, cus: string, estimate?: number) =>
  must(
    await call(
      "GET",
      `${b.B}/customers/${cus}/access?meter=${METER}${estimate ? `&estimate=${estimate}` : ""}`,
    ),
    "access",
  );
const creditUnits = (a: any) =>
  (a.available_units ?? []).find((u: any) => u.unit === "credit")?.units ?? 0;

try {
  // ── A1(a) · end-of-term downgrade: the lower plan's first window at the renewal ──
  for (const rule of [null, "prorated", "full"] as const) {
    const tag = rule ?? "unset";
    const b = await setUp(`Term End Downgrade ${tag}`);
    if (rule) {
      const p = await patchBiz(b, {
        billing_rules_config: { plan_credits: { on_downgrade: rule } },
      });
      ok(
        `A1(a) ${tag}: PATCH plan_credits.on_downgrade=${rule} → 200`,
        p.status === 200 && p.body.billing_rules_config?.plan_credits?.on_downgrade === rule,
        p.body.billing_rules_config?.plan_credits ?? p.body,
      );
    }
    await startClock(b);
    const c = await customer(b, `ted-${tag}`, "tok_4242");
    const sub = must(await subscribe(b, c.id, ["pro-monthly", "usage-monthly"], "on"), "pro sub");
    const termEnd = new Date(sub.next_billing_at);
    const ch = await call("POST", `${b.B}/subscriptions/${sub.id}/change`, {
      changes: [{ item: itemOf(sub, "pro-monthly"), price: "basic-monthly" }],
      timing: "end_of_term",
    });
    ok(`A1(a) ${tag}: Pro → Basic scheduled for the term end → 200`, ch.status === 200, ch.body);
    await advanceTo(b, new Date(termEnd.getTime() + H));
    const after = must(await call("GET", `${b.B}/subscriptions/${sub.id}`), "sub");
    ok(
      `A1(a) ${tag}: after the term end the subscription is on Basic, in a new term`,
      !!itemOf(after, "basic-monthly") &&
        !itemOf(after, "pro-monthly") &&
        ms(after.current_period_start) === termEnd.getTime(),
      { items: after.items, start: after.current_period_start, termEnd },
    );
    const invs = await invoicesOf(b, sub.id);
    const renewal = invs.find((i) => ms(i.period_start) === termEnd.getTime());
    ok(
      `A1(a) ${tag}: the renewal invoice is $39, paid`,
      renewal?.total_minor === 3900 && renewal?.status === "paid",
      invs.map((i) => [i.period_start, i.total_minor, i.status]),
    );
    const now = await simNow(b);
    const gs = await planGrants(b, c.id);
    const live = liveAt(gs, now);
    ok(
      `A1(a) ${tag}: the only live plan grant is Basic's 750, effective at the term end`,
      live.length === 1 &&
        live[0]!.amount === 750 &&
        ms(live[0]!.effective_at) === termEnd.getTime(),
      { termEnd, grants: brief(gs) },
    );
  }

  // ── A1(b) · immediate downgrade, prorated ───────────────────────────────────────
  {
    const b = await setUp("Immediate Downgrade Prorated");
    const p = await patchBiz(b, {
      billing_rules_config: { plan_credits: { on_downgrade: "prorated" } },
    });
    ok(
      "A1(b): PATCH plan_credits.on_downgrade=prorated → 200",
      p.status === 200 && p.body.billing_rules_config?.plan_credits?.on_downgrade === "prorated",
      p.body.billing_rules_config?.plan_credits ?? p.body,
    );
    const back = must(await call("GET", b.B), "business");
    ok(
      "A1(b): the business reads on_downgrade=prorated back",
      back.billing_rules_config?.plan_credits?.on_downgrade === "prorated",
      back.billing_rules_config?.plan_credits,
    );
    await startClock(b);
    const c = await customer(b, "imm-reset", "tok_4242");
    const sub = must(await subscribe(b, c.id, ["pro-monthly", "usage-monthly"], "on"), "pro sub");
    const ct = await customer(b, "imm-term", "tok_4242");
    const subT = must(await subscribe(b, ct.id, ["pro-term", "usage-monthly"], "on"), "term sub");
    const start = await simNow(b);
    await advanceTo(b, new Date(start.getTime() + 10 * DAY));
    const at = await simNow(b);

    const proBefore = (await planGrants(b, c.id)).find(
      (g) => g.amount === 5000 && g.status === "active",
    );
    const r = await call("POST", `${b.B}/subscriptions/${sub.id}/change`, {
      changes: [{ item: itemOf(sub, "pro-monthly"), price: "basic-monthly" }],
      timing: "now",
    });
    ok("A1(b) rule: Pro → Basic now, 10 days in → 200", r.status === 200, r.body);
    const gs = await planGrants(b, c.id);
    const pro = gs.find((g) => g.id === proBefore?.id);
    const basic = gs.find((g) => g.amount !== 5000 && g.status === "active");
    const wStart = ms(proBefore?.effective_at);
    const wEnd = ms(proBefore?.expires_at);
    const want = halfUp(750n * BigInt(wEnd - at.getTime()), BigInt(wEnd - wStart));
    ok("A1(b) rule: the Pro grant ends at the change", ms(pro?.expires_at) === at.getTime(), {
      at,
      pro: pro && brief([pro]),
    });
    ok(
      "A1(b) rule: Basic grants round_half_up(750 × rest ÷ window) from the change to the window end",
      basic !== undefined &&
        BigInt(basic.amount) === want &&
        ms(basic.effective_at) === at.getTime() &&
        ms(basic.expires_at) === wEnd,
      {
        want: String(want),
        at,
        window: [proBefore?.effective_at, proBefore?.expires_at],
        grants: brief(gs),
      },
    );

    const proT = (await planGrants(b, ct.id)).find(
      (g) => g.amount === 5000 && g.status === "active",
    );
    const rt = await call("POST", `${b.B}/subscriptions/${subT.id}/change`, {
      changes: [{ item: itemOf(subT, "pro-term"), price: "basic-term" }],
      timing: "now",
    });
    ok("A1(b) term grant: Pro → Basic now, 10 days in → 200", rt.status === 200, rt.body);
    const gt = await planGrants(b, ct.id);
    const tStart = ms(proT?.effective_at);
    const tEnd = ms(proT?.expires_at);
    const wantT = halfUp(750n * BigInt(tEnd - at.getTime()), BigInt(tEnd - tStart));
    const proTAfter = gt.find((g) => g.id === proT?.id);
    const basicT = gt.find((g) => g.amount !== 5000 && g.status === "active");
    ok(
      "A1(b) term grant: Pro's term grant ends at the change; Basic's is prorated over the term",
      ms(proTAfter?.expires_at) === at.getTime() &&
        basicT !== undefined &&
        BigInt(basicT.amount) === wantT &&
        ms(basicT.expires_at) === tEnd,
      { want: String(wantT), at, term: [proT?.effective_at, proT?.expires_at], grants: brief(gt) },
    );
  }
  {
    const b = await setUp("Immediate Downgrade Per Call");
    await startClock(b);
    const c = await customer(b, "imm-call", "tok_4242");
    const sub = must(await subscribe(b, c.id, ["pro-monthly", "usage-monthly"], "on"), "pro sub");
    const start = await simNow(b);
    await advanceTo(b, new Date(start.getTime() + 10 * DAY));
    const at = await simNow(b);
    const proBefore = (await planGrants(b, c.id)).find(
      (g) => g.amount === 5000 && g.status === "active",
    );
    const r = await call("POST", `${b.B}/subscriptions/${sub.id}/change`, {
      changes: [{ item: itemOf(sub, "pro-monthly"), price: "basic-monthly" }],
      timing: "now",
      plan_credits: "prorated",
    });
    ok(
      "A1(b) per call: unset business, downgrade with plan_credits=prorated → 200",
      r.status === 200,
      r.body,
    );
    const gs = await planGrants(b, c.id);
    const wStart = ms(proBefore?.effective_at);
    const wEnd = ms(proBefore?.expires_at);
    const want = halfUp(750n * BigInt(wEnd - at.getTime()), BigInt(wEnd - wStart));
    const basic = gs.find((g) => g.amount !== 5000 && g.status === "active");
    ok(
      "A1(b) per call: the Pro grant ends at the change and Basic's grant is prorated",
      ms(gs.find((g) => g.id === proBefore?.id)?.expires_at) === at.getTime() &&
        basic !== undefined &&
        BigInt(basic.amount) === want,
      { want: String(want), at, grants: brief(gs) },
    );
  }

  // ── A2 · grant_when: invoice_paid ───────────────────────────────────────────────
  {
    const b = await setUp("Credits When Paid");
    const p = await patchBiz(b, {
      billing_rules_config: { plan_credits: { grant_when: "invoice_paid" } },
      credit_config: {
        blocking_enabled: true,
        on_exhausted_default: "block",
        in_flight_applies: "other_holds_open",
      },
    });
    ok(
      "A2: PATCH plan_credits.grant_when=invoice_paid → 200 and reads back",
      p.status === 200 && p.body.billing_rules_config?.plan_credits?.grant_when === "invoice_paid",
      p.body.billing_rules_config?.plan_credits ?? p.body,
    );
    await startClock(b);

    // (iii) first invoice unpaid at create: reset-month and term prices.
    const x = await customer(b, "paid-reset");
    const subX = must(await subscribe(b, x.id, ["pro-monthly", "usage-monthly"], "off"), "sub x");
    const xInv = (await invoicesOf(b, subX.id))[0];
    const xg0 = await planGrants(b, x.id);
    ok(
      "A2(iii) month reset: an unpaid first invoice holds the grant pending against it",
      xg0.length === 1 &&
        xg0[0]!.status === "pending" &&
        xg0[0]!.amount === 5000 &&
        xg0[0]!.invoice === xInv?.id,
      { invoice: [xInv?.id, xInv?.status], grants: brief(xg0) },
    );
    must(await call("POST", `${b.B}/invoices/${xInv.id}/pay`, {}), "pay x first");
    const xg1 = await planGrants(b, x.id);
    ok(
      "A2(iii) month reset: paid → the grant is active with the same window",
      xg1.length === 1 &&
        xg1[0]!.status === "active" &&
        xg1[0]!.effective_at === xg0[0]?.effective_at &&
        xg1[0]!.expires_at === xg0[0]?.expires_at,
      { before: brief(xg0), after: brief(xg1) },
    );

    const y = await customer(b, "paid-term");
    const subY = must(await subscribe(b, y.id, ["pro-term", "usage-monthly"], "off"), "sub y");
    const yInv = (await invoicesOf(b, subY.id))[0];
    const yg0 = await planGrants(b, y.id);
    ok(
      "A2(iii) term: an unpaid first invoice holds the term grant pending",
      yg0.length === 1 && yg0[0]!.status === "pending" && yg0[0]!.invoice === yInv?.id,
      { invoice: [yInv?.id, yInv?.status], grants: brief(yg0) },
    );
    must(await call("POST", `${b.B}/invoices/${yInv.id}/pay`, {}), "pay y first");
    const yg1 = await planGrants(b, y.id);
    ok(
      "A2(iii) term: paid → the term grant is active with the same window",
      yg1.length === 1 &&
        yg1[0]!.status === "active" &&
        yg1[0]!.effective_at === yg0[0]?.effective_at &&
        yg1[0]!.expires_at === yg0[0]?.expires_at,
      { before: brief(yg0), after: brief(yg1) },
    );

    // (iv) paid at issue: a card charge and a $0 invoice.
    const z = await customer(b, "paid-card", "tok_4242");
    const subZ = must(await subscribe(b, z.id, ["pro-monthly", "usage-monthly"], "on"), "sub z");
    const zInv = (await invoicesOf(b, subZ.id))[0];
    const zg = await planGrants(b, z.id);
    ok(
      "A2(iv) card charged at create: the grant is active at once, nothing pending",
      zInv?.status === "paid" &&
        zg.length === 1 &&
        zg[0]!.status === "active" &&
        zg[0]!.amount === 5000,
      { invoice: [zInv?.total_minor, zInv?.status], grants: brief(zg) },
    );
    const f = await customer(b, "paid-free");
    const subF = must(await subscribe(b, f.id, ["free-monthly", "usage-monthly"], "on"), "sub f");
    const fInv = (await invoicesOf(b, subF.id))[0];
    const fg = await planGrants(b, f.id);
    ok(
      "A2(iv) $0 invoice: the Free grant is active at once, nothing pending",
      fInv?.total_minor === 0 &&
        fInv?.status === "paid" &&
        fg.length === 1 &&
        fg[0]!.status === "active" &&
        fg[0]!.amount === 50,
      { invoice: [fInv?.total_minor, fInv?.status], grants: brief(fg) },
    );

    // (i) and (ii): the renewal.
    await swapToDecliningCard(b, z);
    const termEnd = new Date(subX.next_billing_at);
    await advanceTo(b, new Date(termEnd.getTime() + H));
    const now = await simNow(b);

    const xRenewal = (await invoicesOf(b, subX.id)).find(
      (i) => ms(i.period_start) === termEnd.getTime(),
    );
    const xg2 = await planGrants(b, x.id);
    const xNew = xg2.find((g) => ms(g.effective_at) === termEnd.getTime());
    ok(
      "A2(i): the unpaid renewal holds the new window's grant pending against it",
      xRenewal !== undefined &&
        xRenewal.status !== "paid" &&
        xNew?.status === "pending" &&
        xNew?.amount === 5000 &&
        xNew?.invoice === xRenewal.id,
      { renewal: [xRenewal?.id, xRenewal?.status], grants: brief(xg2) },
    );
    const a0 = await access(b, x.id);
    ok(
      "A2(i): the balance does not count the pending grant",
      creditUnits(a0) === 0 && a0.balance?.grants_minor === 0,
      { units: a0.available_units, balance: a0.balance },
    );
    ok(
      "A2(i): the access check answers insufficient_credit",
      a0.allowed === false && a0.code === "insufficient_credit",
      { code: a0.code, available: a0.available_minor },
    );
    const h0 = await call("POST", `${b.B}/customers/${x.id}/credit_holds`, {
      amount_minor: 60,
      meter: METER,
    });
    ok(
      "A2(i): a hold against the pending grant is refused (402 insufficient_credit)",
      h0.status === 402 && h0.body.error?.code === "insufficient_credit",
      h0,
    );
    if (xRenewal) must(await call("POST", `${b.B}/invoices/${xRenewal.id}/pay`, {}), "pay renewal");
    const xg3 = await planGrants(b, x.id);
    const xPaid = xg3.find((g) => g.id === xNew?.id);
    ok(
      "A2(i): paid → the grant is active with the same window",
      xPaid?.status === "active" &&
        xPaid.effective_at === xNew?.effective_at &&
        xPaid.expires_at === xNew?.expires_at,
      { before: xNew && brief([xNew]), after: brief(xg3) },
    );
    const a1 = await access(b, x.id);
    ok(
      "A2(i): the balance counts it (5000 units) and access is allowed",
      creditUnits(a1) === 5000 && a1.allowed === true,
      { units: a1.available_units, code: a1.code, balance: a1.balance },
    );

    const zSub = must(await call("GET", `${b.B}/subscriptions/${subZ.id}`), "sub z");
    const zg2 = await planGrants(b, z.id);
    const zNew = zg2.find((g) => ms(g.effective_at) === termEnd.getTime());
    ok(
      "A2(ii): the declined renewal cancels the subscription for non-payment",
      zSub.status === "cancelled",
      {
        status: zSub.status,
        invoices: (await invoicesOf(b, subZ.id)).map((i) => [i.total_minor, i.status]),
      },
    );
    ok(
      "A2(ii): the renewal's pending grant is voided, nothing pending is left",
      zNew?.status === "voided" && !zg2.some((g) => g.status === "pending"),
      { termEnd, grants: brief(zg2) },
    );

    const fg2 = await planGrants(b, f.id);
    const fNew = fg2.find((g) => ms(g.effective_at) === termEnd.getTime());
    ok(
      "A2(iv) $0 renewal: the new window's grant is active at once",
      fNew?.status === "active" && liveAt(fg2, now).length === 1,
      { grants: brief(fg2) },
    );
  }

  // ── A2 · on_unpaid_cancel with grants at issue ──────────────────────────────────
  for (const rule of ["void_unused", null] as const) {
    const tag = rule ?? "unset (keep)";
    const b = await setUp(`Unpaid Cancel ${rule ?? "unset"}`);
    if (rule) {
      const p = await patchBiz(b, {
        billing_rules_config: { plan_credits: { on_unpaid_cancel: rule } },
      });
      ok(
        `A2 ${tag}: PATCH plan_credits.on_unpaid_cancel=${rule} → 200`,
        p.status === 200 && p.body.billing_rules_config?.plan_credits?.on_unpaid_cancel === rule,
        p.body.billing_rules_config?.plan_credits ?? p.body,
      );
    }
    await startClock(b);
    const c = await customer(b, `uc-${rule ?? "keep"}`, "tok_4242");
    const sub = must(await subscribe(b, c.id, ["pro-monthly", "usage-monthly"], "on"), "pro sub");
    const termEnd = new Date(sub.next_billing_at);
    await swapToDecliningCard(b, c);
    await advanceTo(b, new Date(termEnd.getTime() + H));
    const after = must(await call("GET", `${b.B}/subscriptions/${sub.id}`), "sub");
    ok(`A2 ${tag}: the declined renewal cancels the subscription`, after.status === "cancelled", {
      status: after.status,
    });
    const gs = await planGrants(b, c.id);
    const renewalGrant = gs.find((g) => ms(g.effective_at) === termEnd.getTime());
    const firstGrant = gs.find((g) => ms(g.effective_at) < termEnd.getTime());
    const a = await access(b, c.id);
    if (rule === "void_unused") {
      ok(
        "A2 void_unused: the unpaid period's grant is voided, nothing left on it",
        renewalGrant?.status === "voided" && renewalGrant.remaining?.units === 0,
        { termEnd, grants: brief(gs) },
      );
      ok(
        "A2 void_unused: the balance no longer counts it",
        creditUnits(a) === 0 && a.balance?.grants_minor === 0,
        { units: a.available_units, balance: a.balance },
      );
      ok(
        "A2 void_unused: the paid period's grant is not voided",
        firstGrant !== undefined && firstGrant.status !== "voided",
        { grants: brief(gs) },
      );
    } else {
      ok(
        "A2 keep (unset): the unpaid period's grant stays active",
        renewalGrant?.status === "active" && renewalGrant.amount === 5000,
        { termEnd, grants: brief(gs) },
      );
    }
  }

  // ── A3 · a $0 first invoice needs no card ───────────────────────────────────────
  {
    const b = await setUp("No Card Signups");
    const c = await customer(b, "nocard-free");
    const free = await subscribe(b, c.id, ["free-monthly", "usage-monthly"], "on");
    const freeInv = free.status === 201 ? (await invoicesOf(b, free.body.id))[0] : null;
    ok(
      "A3: no card, auto-collection on, Free → 201 active",
      free.status === 201 && free.body.status === "active",
      { status: free.status, body: free.body?.error ?? free.body?.status },
    );
    ok(
      "A3: the Free signup's first invoice is $0, paid",
      freeInv?.total_minor === 0 && freeInv?.status === "paid",
      freeInv && [freeInv.total_minor, freeInv.status],
    );
    const d = await customer(b, "nocard-basic");
    const basic = await subscribe(b, d.id, ["basic-monthly", "usage-monthly"], "on");
    ok(
      "A3: no card, auto-collection on, Basic → 400 no_chargeable_payment_method",
      basic.status === 400 && basic.body.error?.code === "no_chargeable_payment_method",
      basic,
    );
    const left = must(await call("GET", `${b.B}/subscriptions?customer=${d.id}`), "list");
    ok(
      "A3: the refused Basic signup leaves no subscription",
      (left.data ?? []).length === 0,
      left.data,
    );
  }

  // ── A4 · the hold share only beside another hold ────────────────────────────────
  {
    const funded = async (b: Biz, tag: string) => {
      const c = await customer(b, tag);
      must(await subscribe(b, c.id, ["usage-monthly"], "off"), "usage sub");
      must(
        await call("POST", `${b.B}/customers/${c.id}/credit_grants`, {
          unit: "credit",
          amount: 15,
        }),
        "grant 1.5 credits",
      );
      return c;
    };
    const hold = (b: Biz, cus: string, amount: number) =>
      call("POST", `${b.B}/customers/${cus}/credit_holds`, { amount_minor: amount, meter: METER });

    const b = await setUp("Hold Share Parallel Only");
    const p = await patchBiz(b, {
      credit_config: {
        blocking_enabled: true,
        on_exhausted_default: "block",
        in_flight_applies: "other_holds_open",
      },
    });
    ok(
      "A4: PATCH credit_config.in_flight_applies=other_holds_open → 200",
      p.status === 200 && p.body.credit_config?.in_flight_applies === "other_holds_open",
      p.body.credit_config ?? p.body,
    );
    const c = await funded(b, "hold-parallel");
    const h1 = await hold(b, c.id, 60);
    ok(
      "A4 other_holds_open: a 1-credit hold on 1.5 credits, no other hold → 201",
      h1.status === 201,
      h1,
    );
    const h2 = await hold(b, c.id, 20);
    ok(
      "A4 other_holds_open: a parallel hold over 50% with the first open → 402 in_flight_limit",
      h2.status === 402 && h2.body.error?.code === "in_flight_limit",
      h2,
    );
    if (h1.status === 201) {
      const rel = await call("POST", `${b.B}/credit_holds/${h1.body.id}/release`, {});
      ok("A4 other_holds_open: the first hold releases", rel.status === 200, rel.body);
    }
    const kept = await patchBiz(b, {
      credit_config: {
        blocking_enabled: true,
        on_exhausted_default: "block",
        hold_default_seconds: 600,
      },
    });
    ok(
      "A4: a credit_config PATCH without in_flight_applies keeps other_holds_open",
      kept.status === 200 &&
        kept.body.credit_config?.in_flight_applies === "other_holds_open" &&
        kept.body.credit_config?.hold_default_seconds === 600,
      kept.body.credit_config ?? kept.body,
    );

    const u = await setUp("Hold Share Every Hold");
    must(
      await patchBiz(u, {
        credit_config: { blocking_enabled: true, on_exhausted_default: "block" },
      }),
      "unset credit config",
    );
    const cu = await funded(u, "hold-always");
    const hu = await hold(u, cu.id, 60);
    ok(
      "A4 unset: a 1-credit hold on 1.5 credits → 402 in_flight_limit (every hold)",
      hu.status === 402 && hu.body.error?.code === "in_flight_limit",
      hu,
    );
  }

  // ── B7 · usage ingested just before a test-clock advance bills on the renewal ────
  {
    const b = await setUp("Usage Before Advance");
    must(
      await call("POST", `${b.B}/prices`, {
        id: "plain-monthly",
        product: "pro",
        type: "recurring",
        model: "flat",
        currency: "USD",
        amount_minor: 9900,
        interval: "month",
      }),
      "plain price",
    );
    await startClock(b);
    const c = await customer(b, "b7-fresh", "tok_4242");
    const sub = must(await subscribe(b, c.id, ["plain-monthly", "usage-monthly"], "on"), "sub");
    const clock0 = await simNow(b);
    for (const i of [1, 2])
      must(
        await call("POST", `${b.B}/usage_events`, {
          key: `b7-${i}-${Date.now()}`,
          customer: c.id,
          event_name: METER,
          timestamp: clock0.toISOString(),
          properties: { credits: 1 },
        }),
        `ingest ${i}`,
      );
    const termEnd = new Date(sub.next_billing_at);
    await advanceTo(b, new Date(termEnd.getTime() + H));
    const renewal = (await invoicesOf(b, sub.id)).find(
      (i) => ms(i.period_start) === termEnd.getTime(),
    );
    const lines = renewal
      ? (must(await call("GET", `${b.B}/invoices/${renewal.id}`), "invoice").lines ?? [])
      : [];
    ok(
      "B7: 2 units ingested right before the advance bill on the renewal (2 × 60 = 120)",
      lines.some((l: any) => l.price === "usage-monthly" && l.amount_minor === 120),
      { renewal: renewal?.id, lines: lines.map((l: any) => [l.price, l.quantity, l.amount_minor]) },
    );
  }

  // ── Defaults ─────────────────────────────────────────────────────────────────────
  {
    const withOp = initialBillingRulesConfig({ hasOperator: true }) as any;
    ok(
      "defaults: a person's new business prorates downgrades and voids unpaid credits",
      JSON.stringify(withOp?.plan_credits) ===
        JSON.stringify({ on_downgrade: "prorated", on_unpaid_cancel: "void_unused" }),
      withOp?.plan_credits,
    );
    ok(
      "defaults: a person's new business applies a change only when it is paid",
      withOp?.failed_change_charge === "apply_when_paid",
      withOp?.failed_change_charge,
    );
    ok(
      "defaults: a key's new business gets no billing rules (plan_credits unset)",
      initialBillingRulesConfig({})?.plan_credits === undefined,
      initialBillingRulesConfig({}),
    );
    ok(
      "defaults: a person's new business checks the hold share beside other holds only",
      JSON.stringify(initialCreditConfig({ hasOperator: true })) ===
        JSON.stringify({ in_flight_applies: "other_holds_open" }),
      initialCreditConfig({ hasOperator: true }),
    );
    ok(
      "defaults: a key's new business gets no credit_config",
      initialCreditConfig({}) === undefined,
      initialCreditConfig({}),
    );
    const pc = resolveBillingRulesConfig({ billingRulesConfig: null }).planCredits;
    ok(
      "defaults: an unset business resolves next_window, invoice_issued, keep",
      pc.onDowngrade === "next_window" &&
        pc.grantWhen === "invoice_issued" &&
        pc.onUnpaidCancel === "keep",
      pc,
    );
  }
} catch (e) {
  fail++;
  console.log(`✗ the suite stopped: ${(e as Error).stack ?? e}`);
} finally {
  for (const B of ttStarted) await call("POST", `${B}/time_travel/stop`, { wipe: false });
}

await app.close();
await closeDb();
console.log(`\n${fail === 0 ? "✅" : "❌"} credits-follow-money: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
