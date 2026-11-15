/**
 * verify:change-invoice-revert — `billing_rules_config.failed_change_charge` when a change's
 * invoice is hard-declined at once (not_paid, dunning exhausted right after collection).
 *
 *  §1 unset (`start_dunning`): the dunning final action runs (cancel by default), reply 200.
 *     A per-call `on_charge_failure: revert` on /change still reverts (402).
 *  §2 `revert`: the change is undone and its invoice and credit notes voided, 402:
 *     hosted Free → Pro (refusal, session open, its coupon released, a retry with a good card
 *     completes); update_for_items Free → Pro; /change Basic → Pro (Basic credits back with
 *     their old expiry, no Pro credit); POST /items (the seat comes off).
 *  §2b `revert` whose void fails (test fault after the invoice void): nothing is reverted and
 *     the final action runs; never a reverted change with a collectable invoice.
 *  §3 `revert` with a blocker (the change removes an item): the final action runs.
 *  §4 `revert` controls: a paid change applies.
 *  §5 `grant_when: invoice_paid`: a mid-term change's grant waits for its invoice.
 *  §6 `next_renewal`: unchanged — the change stays and no final action runs.
 *
 * tmtest authorizes every card; 4000000000000002 fails at capture (non-retriable),
 * 4000000000009995 fails retriably.
 *
 *   pnpm verify:all:fresh -- --suite change-invoice-revert
 */
import { buildApp } from "@/index";
import { closeDb, withTenant } from "@/platform/db";
import { and, eq } from "drizzle-orm";
import { appliedCoupons, auditLogs, checkoutSessions } from "@db/schema";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { getCustomerByPublicId } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { initialBillingRulesConfig } from "@/modules/subscriptions/billing-rules-config";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { runWithClockScope } from "@/platform/clock";
import { runPlanCreditResets } from "@/modules/credits/credit-clock";
import { setRevertVoidFaultForTests } from "@/modules/subscriptions/change-revert";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++;
  else fail++;
  console.log(
    `${cond ? "✓" : "✗"} ${label}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
};

const HARD = "4000000000000002";
const SOFT = "4000000000009995";

const app = await buildApp({ logger: false });
await clearPublicRateLimits();
const org = await createOrganization({ name: "Change Revert Org" });
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
      ...(method === "GET" ? {} : { "idempotency-key": `cir-${n++}-${Date.now()}` }),
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

// A new business gets `apply_when_paid` since 2026-11-15 (verify:pending-change); `revert` is
// still offered and is set by hand below.
ok(
  "a new business gets failed_change_charge: apply_when_paid",
  (initialBillingRulesConfig({ hasOperator: true }) as any)?.failed_change_charge ===
    "apply_when_paid",
  initialBillingRulesConfig({ hasOperator: true }),
);

const biz = await createBusiness({
  organizationId: orgId,
  name: "Change Revert Biz",
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
    minor_per_unit: null,
    decimals: 1,
  }),
  "credit unit",
);
for (const p of ["free", "basic", "pro"])
  must(await call("POST", `${B}/products`, { id: p, name: p, kind: "plan" }), `product ${p}`);
must(await call("POST", `${B}/products`, { id: "seats", name: "seats", kind: "addon" }), "addon");
const plan = (id: string, product: string, amount: number, grant: number) =>
  call("POST", `${B}/prices`, {
    id,
    product,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amount_minor: amount,
    interval: "month",
    grants_credit: { kind: "per_cycle", unit: "credit", amount: grant },
  });
must(await plan("free-monthly", "free", 0, 50), "free price");
must(await plan("basic-monthly", "basic", 2900, 500), "basic price");
must(await plan("pro-monthly", "pro", 9900, 5000), "pro price");
must(
  await call("POST", `${B}/prices`, {
    id: "seat-monthly",
    product: "seats",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amount_minor: 1000,
    interval: "month",
  }),
  "seat price",
);
must(
  await call("POST", `${B}/coupons`, {
    code: "UPGRADE10",
    kind: "percentage",
    percent_off_bps: 1000,
    duration_type: "forever",
    max_redemptions_per_customer: 1,
  }),
  "coupon",
);

type Signup = { cus: string; sub: string; customer: any; pm: string };
/** A customer paying with `token`, subscribed to `price` by API. */
async function signup(tag: string, price: string, token: string): Promise<Signup> {
  const cus = must(
    await call("POST", `${B}/customers`, {
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
  const customer = (await getCustomerByPublicId(orgId, biz.id, cus.id))!;
  const pm = await setCard(cus.id, customer, token);
  const sub = must(
    await call("POST", `${B}/customers/${cus.id}/subscriptions`, { items: [{ price }] }),
    `${price} subscription`,
  );
  return { cus: cus.id as string, sub: sub.id as string, customer, pm };
}
/** Vault `token` and make it the customer's default card. */
async function setCard(cus: string, customer: any, token: string) {
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token,
  });
  must(
    await call("POST", `${B}/customers/${cus}/payment_methods/${pm.publicId}/default`, {}),
    "default",
  );
  return pm.publicId as string;
}
/** Leave only `token` on file: collection falls back to backups, so the good card goes. */
async function onlyCard(x: Signup, token: string) {
  await setCard(x.cus, x.customer, token);
  must(
    await call("POST", `${B}/customers/${x.cus}/payment_methods/${x.pm}/delete_local`, {}),
    "remove 4242",
  );
}
const rules = async (cfg: unknown) =>
  must(await call("PATCH", B, { billing_rules_config: cfg }), "billing rules");
const subOf = async (id: string) => must(await call("GET", `${B}/subscriptions/${id}`), "sub");
const invoicesOf = async (id: string) =>
  (must(await call("GET", `${B}/invoices?subscription=${id}`), "invoices").data ?? []) as any[];
/** The newest invoice that is not the signup's. */
const changeInvoice = async (id: string, signupTotal: number) =>
  (await invoicesOf(id))
    .filter((i) => i.total_minor > 0 && i.total_minor !== signupTotal)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
const grantsOf = async (cus: string) =>
  (must(await call("GET", `${B}/customers/${cus}/credit_grants`), "grants").data ?? []) as any[];
const onPlan = (sub: any, price: string) => (sub.items ?? []).some((i: any) => i.price === price);
const prices = (sub: any) => (sub.items ?? []).map((i: any) => i.price);
const fromFree = { items: [{ price: "pro-monthly" }], replace_items_list: true, reset_term: true };
const fromBasic = { items: [{ price: "pro-monthly" }], replace_items_list: true };
const basicItem = async (sub: string) =>
  (await subOf(sub)).items.find((i: any) => i.price === "basic-monthly").id as string;
const toProChange = async (sub: string) => ({
  changes: [{ item: await basicItem(sub), price: "pro-monthly" }],
  invoice_immediately: true,
});

/** A term reset grants the new plan's credits on the credit clock's next pass: run it first. */
const creditClock = async () => {
  const now = new Date();
  await runWithClockScope({ onlyBusinessId: biz.id, now }, () => runPlanCreditResets(now));
};
const liveUnits = async (cus: string) => {
  await creditClock();
  const live = (await grantsOf(cus)).filter((g) => g.status === "active");
  return { live, units: live.reduce((s, g) => s + g.remaining.units, 0) };
};
const grantOf = async (cus: string, amount: number) =>
  (await grantsOf(cus)).find((g) => g.amount === amount && g.status === "active");
const expiryOf = async (cus: string, amount: number) =>
  (await grantOf(cus, amount))?.expires_at ?? null;

/** 402 `payment_failed`, naming the voided invoice and the decline. */
const is402 = (tag: string, r: { status: number; body: any }) => {
  ok(
    `${tag}: 402 payment_failed with the invoice and the decline`,
    r.status === 402 &&
      r.body?.error?.code === "payment_failed" &&
      typeof r.body?.error?.invoice === "string" &&
      typeof r.body?.error?.decline_code === "string",
    [r.status, r.body],
  );
};
/** The change is undone: old plan, old credits with their expiry, invoice voided, audited. */
const reverted = async (
  tag: string,
  x: { cus: string; sub: string },
  inv: string | undefined,
  oldPrice: string,
  oldAmount: number,
  oldExpiry: string | null,
) => {
  const invoice = (await invoicesOf(x.sub)).find((i) => i.id === inv);
  ok(`${tag}: the change invoice is voided`, invoice?.status === "voided", [
    inv,
    invoice?.status,
    invoice?.dunning_status,
  ]);
  const s2 = await subOf(x.sub);
  ok(
    `${tag}: still active on ${oldPrice}`,
    s2.status === "active" && onPlan(s2, oldPrice) && !onPlan(s2, "pro-monthly"),
    [s2.status, prices(s2)],
  );
  const { live, units } = await liveUnits(x.cus);
  ok(
    `${tag}: no live Pro credit`,
    !live.some((g) => g.amount === 5000),
    live.map((g) => [g.amount, g.source]),
  );
  ok(
    `${tag}: ${oldPrice}'s ${oldAmount} credits are spendable`,
    units === oldAmount,
    live.map((g) => [g.amount, g.remaining.units]),
  );
  const back = live.find((g) => g.remaining.units === oldAmount);
  ok(`${tag}: the credit keeps its old expiry`, !!back && back.expires_at === oldExpiry, [
    back?.expires_at,
    oldExpiry,
  ]);
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.resourceId, x.sub), eq(auditLogs.action, "subscription.change_reverted")),
      ),
  );
  ok(`${tag}: a subscription.change_reverted audit row`, !!row);
};
/** The final action ran: cancelled for non-payment, the invoice not_paid / exhausted. */
const finalActionRan = async (tag: string, sub: string, signupTotal: number) => {
  const s = await subOf(sub);
  const inv = await changeInvoice(sub, signupTotal);
  ok(`${tag}: the invoice failed for good`, inv?.dunning_status === "exhausted", [
    inv?.status,
    inv?.dunning_status,
  ]);
  ok(
    `${tag}: the final action cancelled the subscription`,
    s.status === "cancelled" && s.cancel_reason === "not_paid",
    [s.status, s.cancel_reason, prices(s)],
  );
};

// ── §1 · unset: a hard decline runs the dunning final action ─────────────────
{
  const a = await signup("unset-free", "free-monthly", HARD);
  const r = await call("POST", `${B}/subscriptions/${a.sub}/update_for_items`, {
    ...fromFree,
    invoice_immediately: true,
  });
  ok("§1 unset Free → Pro with 0002: 200", r.status === 200, [r.status, r.body]);
  await finalActionRan("§1 unset Free → Pro", a.sub, 0);

  const b = await signup("unset-basic", "basic-monthly", "tok_4242");
  await onlyCard(b, HARD);
  const rb = await call("POST", `${B}/subscriptions/${b.sub}/change`, await toProChange(b.sub));
  ok("§1 unset /change Basic → Pro with 0002: 200", rb.status === 200, [rb.status, rb.body]);
  await finalActionRan("§1 unset /change Basic → Pro", b.sub, 2900);

  const c = await signup("unset-percall", "basic-monthly", "tok_4242");
  const cExp = await expiryOf(c.cus, 500);
  await onlyCard(c, HARD);
  const rc = await call("POST", `${B}/subscriptions/${c.sub}/change`, {
    ...(await toProChange(c.sub)),
    on_charge_failure: "revert",
  });
  is402("§1 unset, per-call on_charge_failure: revert", rc);
  await reverted("§1 per-call revert", c, rc.body?.error?.invoice, "basic-monthly", 500, cExp);
}

// ── §2 · revert ──────────────────────────────────────────────────────────────
await rules({ failed_change_charge: "revert", plan_credits: { on_unpaid_cancel: "void_unused" } });
{
  // Hosted Free → Pro with a coupon: refused, the session stays open, the coupon comes off
  // with its redemption given back, and a retry with a good card completes.
  const a = await signup("rv-hosted", "free-monthly", HARD);
  const aExp = await expiryOf(a.cus, 50);
  const session = must(
    await call("POST", `${B}/checkout_sessions`, {
      mode: "change",
      subscription: a.sub,
      coupons: ["UPGRADE10"],
      ...fromFree,
    }),
    "change session",
  );
  const done = await call("POST", "/checkout/v1/complete", {}, session.token);
  const msg = done.body?.error?.message ?? "";
  ok(
    "§2 hosted Free → Pro with 0002: refused with the decline",
    done.status === 400 && /We could not change your plan/.test(msg) && /declin/i.test(msg),
    [done.status, done.body],
  );
  const [sess] = await withTenant(orgId, (tx) =>
    tx
      .select({ status: checkoutSessions.status })
      .from(checkoutSessions)
      .where(eq(checkoutSessions.publicId, session.id)),
  );
  ok("§2 hosted: the session stays open to retry", !!sess && sess.status !== "completed", sess);
  const aInv = await changeInvoice(a.sub, 0);
  await reverted("§2 hosted Free → Pro", a, aInv?.id, "free-monthly", 50, aExp);
  const aSubRow = (await subOf(a.sub)) as any;
  const active = await withTenant(orgId, (tx) =>
    tx
      .select({ status: appliedCoupons.status })
      .from(appliedCoupons)
      .where(eq(appliedCoupons.customerId, a.customer.id)),
  );
  ok(
    "§2 hosted: the session's coupon is released, not left on Free",
    active.length === 1 && active[0]!.status === "released",
    [active, aSubRow.coupons ?? aSubRow.discounts],
  );
  const cpn = must(await call("GET", `${B}/coupons/UPGRADE10`), "coupon");
  ok(
    "§2 hosted: the coupon's redemption is given back",
    cpn.times_redeemed === 0,
    cpn.times_redeemed,
  );
  await setCard(a.cus, a.customer, "tok_4242");
  const retry = await call("POST", "/checkout/v1/complete", {}, session.token);
  const s2 = await subOf(a.sub);
  ok(
    "§2 hosted: a retry with a good card completes on Pro (the coupon cap of 1 allows it)",
    retry.status < 300 && onPlan(s2, "pro-monthly") && s2.status === "active",
    [retry.status, retry.body?.error ?? null, prices(s2)],
  );
  const live = await withTenant(orgId, (tx) =>
    tx
      .select({ status: appliedCoupons.status })
      .from(appliedCoupons)
      .where(
        and(eq(appliedCoupons.customerId, a.customer.id), eq(appliedCoupons.status, "active")),
      ),
  );
  ok("§2 hosted retry: the coupon is on the subscription", live.length === 1, live);
}
{
  const c = await signup("rv-free-api", "free-monthly", HARD);
  const cExp = await expiryOf(c.cus, 50);
  const r = await call("POST", `${B}/subscriptions/${c.sub}/update_for_items`, {
    ...fromFree,
    invoice_immediately: true,
  });
  is402("§2 update_for_items Free → Pro", r);
  await reverted(
    "§2 update_for_items Free → Pro",
    c,
    r.body?.error?.invoice,
    "free-monthly",
    50,
    cExp,
  );
}
{
  const b = await signup("rv-basic", "basic-monthly", "tok_4242");
  const bExp = await expiryOf(b.cus, 500);
  await onlyCard(b, HARD);
  const r = await call("POST", `${B}/subscriptions/${b.sub}/change`, await toProChange(b.sub));
  is402("§2 /change Basic → Pro", r);
  await reverted("§2 /change Basic → Pro", b, r.body?.error?.invoice, "basic-monthly", 500, bExp);
  const notes = (must(await call("GET", `${B}/credit_notes?customer=${b.cus}`), "notes").data ??
    []) as any[];
  ok(
    "§2 /change Basic → Pro: the unused-Basic credit note is voided",
    notes.length > 0 && notes.every((x) => x.status === "voided"),
    notes.map((x) => x.status),
  );
  const cus = must(await call("GET", `${B}/customers/${b.cus}`), "customer");
  const bal = (cus.balances ?? []).find((x: any) => x.currency_code === "USD");
  ok(
    "§2 /change Basic → Pro: no credit left on the customer",
    !bal || (bal.refundable_credits === 0 && bal.promotional_credits === 0),
    bal,
  );
}
{
  // Gap (b): an added seat whose invoice hard-declines comes off.
  const e = await signup("rv-seat", "basic-monthly", "tok_4242");
  await onlyCard(e, HARD);
  const r = await call("POST", `${B}/subscriptions/${e.sub}/items`, {
    price: "seat-monthly",
    invoice_immediately: true,
  });
  is402("§2 POST /items seat", r);
  const s = await subOf(e.sub);
  ok(
    "§2 POST /items: the seat is removed, still active on Basic",
    s.status === "active" && onPlan(s, "basic-monthly") && !onPlan(s, "seat-monthly"),
    [s.status, prices(s)],
  );
  const inv = (await invoicesOf(e.sub)).find((i) => i.id === r.body?.error?.invoice);
  ok("§2 POST /items: the seat invoice is voided", inv?.status === "voided", inv?.status);
}

// ── §2b · revert whose void fails: the revert rolls back, the final action runs ──
{
  const auditRow = async (sub: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.resourceId, sub),
              eq(auditLogs.action, "subscription.change_reverted"),
            ),
          ),
      )
    ).length > 0;
  /** Reverted with the invoice voided, or not reverted with the final action: nothing else. */
  const allOrNothing = async (tag: string, sub: string, signupTotal: number) => {
    const s = await subOf(sub);
    const inv = await changeInvoice(sub, signupTotal);
    const rev = await auditRow(sub);
    ok(`${tag}: the void rolled back with the revert (not reverted)`, !rev, rev);
    ok(`${tag}: the invoice is not voided`, !!inv && inv.status !== "voided", inv?.status);
    ok(
      `${tag}: never reverted with a collectable invoice`,
      rev ? inv?.status === "voided" : s.status === "cancelled",
      [rev, inv?.status, s.status],
    );
    await finalActionRan(tag, sub, signupTotal);
  };
  const fault = () => {
    throw new Error("test fault: void failed");
  };

  const b = await signup("rv-void-fail", "basic-monthly", "tok_4242");
  await onlyCard(b, HARD);
  setRevertVoidFaultForTests(fault);
  let r;
  try {
    r = await call("POST", `${B}/subscriptions/${b.sub}/change`, await toProChange(b.sub));
  } finally {
    setRevertVoidFaultForTests(null);
  }
  ok("§2b /change Basic → Pro, void fails: 200, not 402", r.status === 200, [r.status, r.body]);
  await allOrNothing("§2b /change Basic → Pro", b.sub, 2900);
  const notes = (must(await call("GET", `${B}/credit_notes?customer=${b.cus}`), "notes").data ??
    []) as any[];
  ok(
    "§2b /change Basic → Pro: the credit note is not voided",
    notes.length > 0 && notes.every((x) => x.status !== "voided"),
    notes.map((x) => x.status),
  );

  const e = await signup("rv-seat-void-fail", "basic-monthly", "tok_4242");
  await onlyCard(e, HARD);
  setRevertVoidFaultForTests(fault);
  let rs;
  try {
    rs = await call("POST", `${B}/subscriptions/${e.sub}/items`, {
      price: "seat-monthly",
      invoice_immediately: true,
    });
  } finally {
    setRevertVoidFaultForTests(null);
  }
  ok("§2b POST /items seat, void fails: not 402", rs.status < 300, [rs.status, rs.body]);
  await allOrNothing("§2b POST /items seat", e.sub, 2900);
}

// ── §3 · revert, but a blocker: the change also removes an item ──────────────
{
  const e = await signup("rv-blocker", "basic-monthly", "tok_4242");
  must(
    await call("POST", `${B}/subscriptions/${e.sub}/update_for_items`, {
      items: [{ price: "basic-monthly" }, { price: "seat-monthly" }],
      invoice_immediately: true,
    }),
    "seat",
  );
  await onlyCard(e, HARD);
  const r = await call("POST", `${B}/subscriptions/${e.sub}/update_for_items`, {
    ...fromBasic,
    invoice_immediately: true,
  });
  ok("§3 blocker (item removed): 200, not reverted", r.status === 200, [r.status, r.body]);
  await finalActionRan("§3 blocker", e.sub, 2900);
}

// ── §4 · revert controls: a good card pays and the change applies ────────────
{
  const d = await signup("rv-free-paid", "free-monthly", "tok_4242");
  must(
    await call("POST", `${B}/subscriptions/${d.sub}/update_for_items`, {
      ...fromFree,
      invoice_immediately: true,
    }),
    "paid change",
  );
  const dInv = await changeInvoice(d.sub, 0);
  const dSub = await subOf(d.sub);
  ok(
    "§4 paid Free → Pro: invoice paid, active on Pro",
    dInv?.status === "paid" && dSub.status === "active" && onPlan(dSub, "pro-monthly"),
    [dInv?.status, dSub.status],
  );
  const f = await signup("rv-basic-paid", "basic-monthly", "tok_4242");
  must(await call("POST", `${B}/subscriptions/${f.sub}/change`, await toProChange(f.sub)), "paid");
  const fSub = await subOf(f.sub);
  const fInv = await changeInvoice(f.sub, 2900);
  ok(
    "§4 paid Basic → Pro: invoice paid, active on Pro",
    fInv?.status === "paid" && fSub.status === "active" && onPlan(fSub, "pro-monthly"),
    [fInv?.status, fSub.status],
  );
  ok("§4 paid Basic → Pro: Pro's credit is live", !!(await grantOf(f.cus, 5000)));
}

// ── §5 · grant_when: invoice_paid — the change grant waits for its invoice ───
await rules({ plan_credits: { grant_when: "invoice_paid" } });
{
  const proGrant = async (cus: string) =>
    (await grantsOf(cus)).filter((g) => g.amount === 5000).map((g) => g.status);

  const p = await signup("gw-paid", "basic-monthly", "tok_4242");
  must(await call("POST", `${B}/subscriptions/${p.sub}/change`, await toProChange(p.sub)), "paid");
  ok(
    "§5 paid upgrade: the Pro grant is active",
    (await proGrant(p.cus)).join() === "active",
    await proGrant(p.cus),
  );

  const s = await signup("gw-soft", "basic-monthly", "tok_4242");
  await onlyCard(s, SOFT);
  const rs = await call("POST", `${B}/subscriptions/${s.sub}/change`, await toProChange(s.sub));
  ok("§5 soft decline: 200, the change stays", rs.status === 200, [rs.status, rs.body]);
  ok(
    "§5 soft decline: the Pro grant is pending",
    (await proGrant(s.cus)).join() === "pending",
    await proGrant(s.cus),
  );
  const sInv = await changeInvoice(s.sub, 2900);
  ok("§5 soft decline: the invoice is in dunning", sInv?.status === "payment_due", [
    sInv?.status,
    sInv?.dunning_status,
  ]);
  must(
    await call("POST", `${B}/invoices/${sInv.id}/pay`, { method: "bank_transfer" }),
    "mark paid",
  );
  ok(
    "§5 mark-paid: the Pro grant is active",
    (await proGrant(s.cus)).join() === "active",
    await proGrant(s.cus),
  );

  const h = await signup("gw-hard", "basic-monthly", "tok_4242");
  await onlyCard(h, HARD);
  const rh = await call("POST", `${B}/subscriptions/${h.sub}/change`, await toProChange(h.sub));
  is402("§5 hard decline", rh);
  ok(
    "§5 hard decline: the Pro grant is voided",
    (await proGrant(h.cus)).join() === "voided",
    await proGrant(h.cus),
  );
  ok("§5 hard decline: Basic's grant is still active", !!(await grantOf(h.cus, 500)));
}

// ── §6 · next_renewal: unchanged ─────────────────────────────────────────────
await rules({ failed_change_charge: "next_renewal" });
{
  const x = await signup("nr-basic", "basic-monthly", "tok_4242");
  await onlyCard(x, HARD);
  const r = await call("POST", `${B}/subscriptions/${x.sub}/change`, await toProChange(x.sub));
  ok("§6 next_renewal hard decline: 200", r.status === 200, [r.status, r.body]);
  const s = await subOf(x.sub);
  ok(
    "§6 next_renewal: the change stays and no final action runs",
    s.status === "active" && onPlan(s, "pro-monthly"),
    [s.status, prices(s)],
  );
  const inv = await changeInvoice(x.sub, 2900);
  ok("§6 next_renewal: the invoice is not voided", inv?.status === "not_paid", inv?.status);
  console.log(
    `  · next_renewal invoice: status=${inv?.status} dunning=${inv?.dunning_status} next_attempt=${inv?.next_attempt_at ?? null}`,
  );
}

await app.close();
await closeDb();
console.log(`\n${fail === 0 ? "✅" : "❌"} CHANGE INVOICE REVERT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
