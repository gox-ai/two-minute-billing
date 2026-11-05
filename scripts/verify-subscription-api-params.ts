/**
 * Subscription lifecycle + estimate parameters added for API parity. Each one reaches real
 * behaviour, refuses what it cannot honour, and — absent — leaves the route as it was.
 *
 *  - create `payment_method`; PATCH `payment_method` + `net_term_days`
 *  - reactivate `reactivate_from`, `payment_intent`, `payment_initiator`; estimate `reactivate_from`
 *  - `coupon_ids[]` (at most one) on change / estimate / reactivate
 *  - cancel `end_of_billing_term`, `include_cancellation_day_in_billing` (+ cancel_estimate)
 *  - pause `resume_date`, `unbilled_charges_handling=no_action`
 *  - resume `resume_option=specific_date`; remove_scheduled_cancellation `billing_cycles`
 *  - renewal_estimate query flags; estimate `change_option=specific_date`
 *
 *   pnpm verify:subscription-api-params
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization } from "@/modules/tenancy/service";
import { createPaymentIntent } from "@/modules/payment-intents/service";
import {
  businesses,
  creditNotes,
  customers,
  invoices,
  scheduledChanges,
  subscriptions,
  unbilledCharges,
} from "@db/schema";
import { Tmbilling } from "../sdk/index";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const org = await createOrganization({ name: "Sub API Params Co" });
const orgId = org.organization.id;
const tmb = new Tmbilling({ apiKey: org.secret, baseUrl: base });

let idem = 0;
type Res = { status: number; body: Record<string, any> };
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${org.secret}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "idempotency-key": `sap-${Date.now()}-${++idem}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

async function setup(name: string) {
  const biz = await tmb.businesses.create({ name, default_currency: "USD", livemode: "test" });
  const product = await tmb.products.create(biz.id, { name: "Pro" });
  const price = await tmb.prices.create(biz.id, {
    product: product.id,
    model: "flat",
    currency: "USD",
    amount_minor: 3000,
    interval: "month",
  });
  const unit = await tmb.prices.create(biz.id, {
    product: product.id,
    model: "per_unit",
    currency: "USD",
    amount_minor: 1000,
    interval: "month",
  });
  const bizRow = (
    await systemDb.select().from(businesses).where(eq(businesses.publicId, biz.id)).limit(1)
  )[0]!;
  return { biz: biz.id, price: price.id, unitPrice: unit.id, bizRow };
}

const S = await setup("Params Biz");
const B = `/v1/businesses/${S.biz}`;

async function customerWith(email: string, ...tokens: string[]) {
  const cus = await tmb.customers.create(S.biz, { email });
  const pms: string[] = [];
  for (const t of tokens) {
    const pm = await tmb.paymentMethods.create(S.biz, cus.id, { token: t });
    pms.push(pm.id);
  }
  return { cus: cus.id, pms };
}
const create = (cus: string, extra: Record<string, unknown> = {}) =>
  call("POST", `${B}/customers/${cus}/subscriptions`, {
    items: [{ price: S.price, quantity: 1 }],
    ...extra,
  });
const cusRowId = async (pub: string) =>
  (
    await systemDb.select({ id: customers.id }).from(customers).where(eq(customers.publicId, pub))
  )[0]!.id;
const subRow = async (pub: string) =>
  (await systemDb.select().from(subscriptions).where(eq(subscriptions.publicId, pub)).limit(1))[0]!;

// ── create payment_method ─────────────────────────────────────────────────────────
{
  const { cus, pms } = await customerWith("pin@sap.test", "tok_4000000000000341", "tok_4242");
  const plain = await create(cus);
  ok(
    `create without payment_method charges the primary (declines → ${plain.status})`,
    plain.status === 402,
  );
  const pinned = await create(cus, { payment_method: pms[1] });
  ok(
    `create payment_method charges the pinned card (${pinned.status}, ${pinned.body.latest_invoice?.status})`,
    pinned.status === 201 && pinned.body.latest_invoice?.status === "paid",
  );
  const other = await customerWith("other@sap.test", "tok_4242");
  const foreign = await create(cus, { payment_method: other.pms[0] });
  ok(`another customer's payment method is refused (${foreign.status})`, foreign.status === 400);

  // PATCH: net_term_days + payment_method (override_billing_profile)
  const subId = pinned.body.id as string;
  const nt = await call("PATCH", `${B}/subscriptions/${subId}`, { net_term_days: 30 });
  ok(
    `PATCH net_term_days (${nt.body.net_term_days}), no pin echoed on an unrelated PATCH`,
    nt.status === 200 && nt.body.net_term_days === 30 && !("default_payment_method" in nt.body),
  );
  const repin = await call("PATCH", `${B}/subscriptions/${subId}`, { payment_method: pms[0] });
  const got = await call("GET", `${B}/subscriptions/${subId}`);
  ok(
    `PATCH payment_method pins it (${repin.body.default_payment_method} / GET ${got.body.default_payment_method})`,
    repin.status === 200 &&
      repin.body.default_payment_method === pms[0] &&
      got.body.default_payment_method === pms[0],
  );
  const unpin = await call("PATCH", `${B}/subscriptions/${subId}`, { payment_method: null });
  ok(
    "PATCH payment_method null unpins",
    unpin.status === 200 && unpin.body.default_payment_method === null,
  );
  const bad = await call("PATCH", `${B}/subscriptions/${subId}`, { payment_method: other.pms[0] });
  ok(`PATCH a foreign payment method → 400 (${bad.status})`, bad.status === 400);
}

// ── reactivate_from ──────────────────────────────────────────────────────────────────
{
  const { cus } = await customerWith("refrom@sap.test", "tok_4242");
  const sub = (await create(cus)).body.id as string;
  const active = await call("POST", `${B}/subscriptions/${sub}/reactivate`, {
    reactivate_from: new Date(Date.now() - 86_400_000).toISOString(),
  });
  ok(`reactivate_from on a live subscription → 400 (${active.status})`, active.status === 400);
  await call("POST", `${B}/subscriptions/${sub}/cancel`, { cancel_option: "immediately" });
  const cancelledAt = new Date(Date.now() - 5 * 86_400_000);
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ canceledAt: cancelledAt })
      .where(eq(subscriptions.publicId, sub)),
  );
  const future = await call("POST", `${B}/subscriptions/${sub}/reactivate`, {
    reactivate_from: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const early = await call("POST", `${B}/subscriptions/${sub}/reactivate`, {
    reactivate_from: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  });
  ok(`reactivate_from in the future → 400 (${future.status})`, future.status === 400);
  ok(`reactivate_from before the cancellation → 400 (${early.status})`, early.status === 400);
  const from = new Date(Date.now() - 2 * 86_400_000);
  const est = await call("POST", `${B}/subscriptions/${sub}/reactivate_estimate`, {
    items: [{ price: S.price, quantity: 1 }],
    reactivate_from: from.toISOString(),
  });
  ok(`reactivate_estimate accepts reactivate_from (${est.status})`, est.status === 200);
  const re = await call("POST", `${B}/subscriptions/${sub}/reactivate`, {
    reactivate_from: from.toISOString(),
  });
  const start = re.body.current_period_start;
  ok(
    `reactivate_from backdates the fresh term (${re.status}, start ${start})`,
    re.status === 200 &&
      re.body.status === "active" &&
      start != null &&
      Math.abs(new Date(start).getTime() - from.getTime()) < 1000,
  );
}

// ── reactivate payment_intent / payment_initiator ────────────────────────────────────
{
  const { cus, pms } = await customerWith("intent@sap.test", "tok_4242");
  const sub = (await create(cus)).body.id as string;
  await call("POST", `${B}/subscriptions/${sub}/cancel`, { cancel_option: "immediately" });
  const est = await call("POST", `${B}/subscriptions/${sub}/reactivate_estimate`, {
    items: [{ price: S.price, quantity: 1 }],
  });
  const due = est.body.amount_due_minor as number;
  const mint = (amount: number) =>
    createPaymentIntent({
      organizationId: orgId,
      businessId: S.bizRow.id,
      purpose: "payment",
      paymentMethodPublicId: pms[0],
      customerPublicId: cus,
      amountMinor: amount,
      currency: "USD",
      session: "on_session",
    });
  const wrong = await mint(due + 1);
  const invBefore = (
    await systemDb
      .select()
      .from(invoices)
      .where(eq(invoices.customerId, await cusRowId(cus)))
  ).length;
  const mism = await call("POST", `${B}/subscriptions/${sub}/reactivate`, {
    payment_intent: wrong.intent.publicId,
  });
  const invAfter = (
    await systemDb
      .select()
      .from(invoices)
      .where(eq(invoices.customerId, await cusRowId(cus)))
  ).length;
  ok(
    `payment_intent for the wrong amount → 400 ${mism.body.error?.code}, nothing written`,
    mism.status === 400 &&
      mism.body.error?.code === "payment_intent_amount_mismatch" &&
      invAfter === invBefore &&
      (await subRow(sub)).status === "cancelled",
  );
  const right = await mint(due);
  const re = await call("POST", `${B}/subscriptions/${sub}/reactivate`, {
    payment_intent: right.intent.publicId,
  });
  ok(
    `payment_intent settles the fresh term (${re.status}, ${re.body.latest_invoice?.status}, intent ${re.body.payment_intent?.status})`,
    re.status === 200 &&
      re.body.status === "active" &&
      re.body.latest_invoice?.status === "paid" &&
      re.body.payment_intent?.status === "consumed",
  );
  const live = await call("POST", `${B}/subscriptions/${sub}/reactivate`, {
    payment_intent: right.intent.publicId,
  });
  ok(`payment_intent on a live subscription → 400 (${live.status})`, live.status === 400);
}
{
  const { cus } = await customerWith("sca@sap.test", "tok_4242");
  const sub = (await create(cus)).body.id as string;
  await call("POST", `${B}/subscriptions/${sub}/cancel`, { cancel_option: "immediately" });
  const pmList = await tmb.paymentMethods.list(S.biz, cus);
  for (const pm of pmList.data) await tmb.paymentMethods.detach(S.biz, cus, pm.id);
  await tmb.paymentMethods.create(S.biz, cus, { token: "tok_4000000000003155" });
  const off = await call("POST", `${B}/subscriptions/${sub}/reactivate`, {});
  ok(
    `3DS card, no initiator: refused as before, no challenge handed back (${off.status})`,
    off.status === 402 && !off.body.payment_intent,
  );
  const on = await call("POST", `${B}/subscriptions/${sub}/reactivate`, {
    payment_initiator: "customer",
  });
  ok(
    `payment_initiator=customer hands back the challenge (${on.status} ${on.body.error?.code}, intent ${on.body.payment_intent?.id ? "yes" : "no"})`,
    on.status === 402 && on.body.error?.code === "requires_action" && !!on.body.payment_intent?.id,
  );
  ok("…and nothing was reactivated", (await subRow(sub)).status === "cancelled");
}

// ── coupon_ids ───────────────────────────────────────────────────────────────────────
{
  await tmb.coupons.create(S.biz, {
    code: "SAP10",
    kind: "percentage",
    percent_off_bps: 1000,
    duration_type: "forever",
  });
  await tmb.coupons.create(S.biz, {
    code: "SAP20",
    kind: "percentage",
    percent_off_bps: 2000,
    duration_type: "forever",
  });
  const { cus } = await customerWith("coupons@sap.test", "tok_4242");
  const created = await call("POST", `${B}/customers/${cus}/subscriptions`, {
    items: [{ price: S.unitPrice, quantity: 1 }],
  });
  const sub = created.body.id as string;
  const item = (await call("GET", `${B}/subscriptions/${sub}`)).body.items[0].id as string;
  const two = await call("POST", `${B}/subscriptions/${sub}/change`, {
    changes: [{ item, quantity: 2 }],
    coupon_ids: ["SAP10", "SAP20"],
    invoice_immediately: true,
  });
  ok(`two coupon_ids → 400 (${two.status})`, two.status === 400);
  const a = await call("POST", `${B}/subscriptions/${sub}/estimate`, {
    changes: [{ item, quantity: 2 }],
    coupon_code: "SAP10",
  });
  const b = await call("POST", `${B}/subscriptions/${sub}/estimate`, {
    changes: [{ item, quantity: 2 }],
    coupon_ids: ["SAP10"],
  });
  ok(
    `coupon_ids [x] previews like coupon_code x (${a.body.total_minor} / ${b.body.total_minor})`,
    a.status === 200 && b.status === 200 && a.body.total_minor === b.body.total_minor,
  );

  // change_option=specific_date — a later date prorates less than today.
  const now = await call("POST", `${B}/subscriptions/${sub}/estimate`, {
    changes: [{ item, quantity: 2 }],
  });
  const at = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const later = await call("POST", `${B}/subscriptions/${sub}/estimate`, {
    changes: [{ item, quantity: 2 }],
    change_option: "specific_date",
    changes_scheduled_at: at,
  });
  ok(
    `specific_date preview prorates from that date (${now.body.total_minor} → ${later.body.total_minor})`,
    later.status === 200 && later.body.total_minor < now.body.total_minor,
  );
  const withCoupon = await call("POST", `${B}/subscriptions/${sub}/estimate`, {
    changes: [{ item, quantity: 2 }],
    change_option: "specific_date",
    changes_scheduled_at: at,
    coupon_code: "SAP10",
  });
  const noOpt = await call("POST", `${B}/subscriptions/${sub}/estimate`, {
    changes: [{ item, quantity: 2 }],
    changes_scheduled_at: at,
  });
  ok(
    `a scheduled preview refuses what a schedule cannot carry (${withCoupon.status}) and a bare date (${noOpt.status})`,
    withCoupon.status === 400 && noOpt.status === 400,
  );
}

// ── cancel: end_of_billing_term, remove_scheduled_cancellation billing_cycles, renewal ─
{
  const { cus } = await customerWith("eobt@sap.test", "tok_4242");
  const sub = (await create(cus)).body.id as string;
  const est = await call("POST", `${B}/subscriptions/${sub}/cancel_estimate`, {
    cancel_option: "end_of_billing_term",
  });
  ok(
    `cancel_estimate end_of_billing_term = end_of_term (${est.body.options?.cancel_option})`,
    est.status === 200 && est.body.options?.cancel_option === "end_of_term",
  );
  const c = await call("POST", `${B}/subscriptions/${sub}/cancel`, {
    cancel_option: "end_of_billing_term",
  });
  ok(
    `cancel end_of_billing_term → non_renewing (${c.body.status})`,
    c.body.status === "non_renewing",
  );

  const r0 = await call("GET", `${B}/subscriptions/${sub}/renewal_estimate`);
  const r1 = await call(
    "GET",
    `${B}/subscriptions/${sub}/renewal_estimate?ignore_scheduled_cancellation=true`,
  );
  ok(
    `renewal_estimate: null while cancelling, priced with ignore_scheduled_cancellation (${r1.body.estimate?.total_minor})`,
    r0.body.estimate === null && r1.status === 200 && r1.body.estimate?.total_minor === 3000,
  );
  const badFlag = await call(
    "GET",
    `${B}/subscriptions/${sub}/renewal_estimate?use_existing_balances=maybe`,
  );
  ok(`renewal_estimate refuses a non-boolean flag (${badFlag.status})`, badFlag.status === 400);

  const rsc = await call("POST", `${B}/subscriptions/${sub}/remove_scheduled_cancellation`, {
    billing_cycles: 3,
  });
  ok(
    `remove_scheduled_cancellation billing_cycles (${rsc.body.status}, ${rsc.body.remaining_billing_cycles})`,
    rsc.status === 200 && rsc.body.status === "active" && rsc.body.remaining_billing_cycles === 3,
  );
  await call("POST", `${B}/subscriptions/${sub}/cancel`, { cancel_option: "end_of_term" });
  const rsc2 = await call("POST", `${B}/subscriptions/${sub}/remove_scheduled_cancellation`);
  ok(
    "…omitted still renews forever",
    rsc2.status === 200 && rsc2.body.remaining_billing_cycles === null,
  );

  // include_delayed_charges / use_existing_balances genuinely move the renewal figure.
  await call("POST", `${B}/subscriptions/${sub}/charges`, {
    description: "Setup",
    amount_minor: 700,
    invoice_now: false,
  });
  const withCharge = await call("GET", `${B}/subscriptions/${sub}/renewal_estimate`);
  const noCharge = await call(
    "GET",
    `${B}/subscriptions/${sub}/renewal_estimate?include_delayed_charges=false`,
  );
  ok(
    `include_delayed_charges=false drops the queued charge (${withCharge.body.estimate?.subtotal_minor} → ${noCharge.body.estimate?.subtotal_minor})`,
    withCharge.body.estimate?.subtotal_minor - noCharge.body.estimate?.subtotal_minor === 700,
  );
  await call("POST", `${B}/customers/${cus}/promotional_credits`, {
    action: "add",
    amount_minor: 500,
    currency: "USD",
    description: "Goodwill",
  });
  const credited = await call("GET", `${B}/subscriptions/${sub}/renewal_estimate`);
  const uncredited = await call(
    "GET",
    `${B}/subscriptions/${sub}/renewal_estimate?use_existing_balances=false`,
  );
  ok(
    `use_existing_balances=false previews without credit (due ${credited.body.estimate?.amount_due_minor} → ${uncredited.body.estimate?.amount_due_minor})`,
    uncredited.body.estimate?.amount_due_minor > credited.body.estimate?.amount_due_minor &&
      uncredited.body.estimate?.promotional_credits_applied_minor === 0,
  );

  // A scheduled change that lands first is priced in; `true` prices today's items.
  const item = (await call("GET", `${B}/subscriptions/${sub}`)).body.items[0].id as string;
  await call("POST", `${B}/subscriptions/${sub}/schedule`, {
    type: "change",
    effective_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    // Flat 3000 → per-unit 1000 × 2: the renewal moves to 2000.
    changes: [{ item, price: S.unitPrice, quantity: 2 }],
  });
  const applied = await call("GET", `${B}/subscriptions/${sub}/renewal_estimate`);
  const today = await call(
    "GET",
    `${B}/subscriptions/${sub}/renewal_estimate?ignore_scheduled_changes=true`,
  );
  ok(
    `a scheduled change is priced into the renewal (${applied.body.estimate?.subtotal_minor} vs today ${today.body.estimate?.subtotal_minor}); true ignores it`,
    applied.status === 200 &&
      !!applied.body.estimate?.scheduled_change &&
      today.body.estimate?.scheduled_change === undefined &&
      today.body.estimate.subtotal_minor - applied.body.estimate.subtotal_minor === 1000,
  );
}

// ── pause resume_date / no_action; resume specific_date ─────────────────────────────
{
  const { cus } = await customerWith("pause@sap.test", "tok_4242");
  const sub = (await create(cus)).body.id as string;
  await call("POST", `${B}/subscriptions/${sub}/charges`, {
    description: "Queued",
    amount_minor: 400,
    invoice_now: false,
  });
  // The business default would invoice them; no_action keeps them.
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ pauseConfig: { unbilled_on_pause: "invoice" } })
      .where(eq(businesses.id, S.bizRow.id)),
  );
  const bad = await call("POST", `${B}/subscriptions/${sub}/pause`, {
    pause_option: "billing_cycles",
    resume_date: new Date(Date.now() + 40 * 86_400_000).toISOString(),
  });
  ok(`resume_date with billing_cycles → 400 (${bad.status})`, bad.status === 400);
  const resumeAt = new Date(Date.now() + 12 * 86_400_000);
  const p = await call("POST", `${B}/subscriptions/${sub}/pause`, {
    pause_option: "immediately",
    unbilled_charges_handling: "no_action",
    resume_date: resumeAt.toISOString(),
  });
  await withTenant(orgId, (tx) =>
    tx.update(businesses).set({ pauseConfig: {} }).where(eq(businesses.id, S.bizRow.id)),
  );
  const row = await subRow(sub);
  const pending = await systemDb
    .select()
    .from(unbilledCharges)
    .where(and(eq(unbilledCharges.subscriptionId, row.id), eq(unbilledCharges.status, "pending")));
  const resumes = await systemDb
    .select()
    .from(scheduledChanges)
    .where(
      and(
        eq(scheduledChanges.subscriptionId, row.id),
        eq(scheduledChanges.type, "resume"),
        eq(scheduledChanges.status, "scheduled"),
      ),
    );
  ok(
    `pause resume_date schedules the resume (${p.body.status}, ${p.body.resume_scheduled_at})`,
    p.status === 200 &&
      p.body.status === "paused" &&
      resumes.length === 1 &&
      resumes[0]!.effectiveAt.getTime() === resumeAt.getTime(),
  );
  ok(
    `unbilled_charges_handling=no_action keeps the charge (${pending.length} pending)`,
    pending.length === 1,
  );

  const noOpt = await call("POST", `${B}/subscriptions/${sub}/resume`, {
    resume_date: resumeAt.toISOString(),
  });
  ok(`resume_date without resume_option → 400 (${noOpt.status})`, noOpt.status === 400);
  const soon = new Date(Date.now() + 3 * 86_400_000);
  const r = await call("POST", `${B}/subscriptions/${sub}/resume`, {
    resume_option: "specific_date",
    resume_date: soon.toISOString(),
    charges_handling: "add_to_unbilled_charges",
  });
  const after = await systemDb
    .select()
    .from(scheduledChanges)
    .where(
      and(
        eq(scheduledChanges.subscriptionId, row.id),
        eq(scheduledChanges.type, "resume"),
        eq(scheduledChanges.status, "scheduled"),
      ),
    );
  ok(
    `resume specific_date replaces the pending resume and carries its options (${r.status}, ${r.body.status})`,
    r.status === 200 &&
      r.body.status === "paused" &&
      after.length === 1 &&
      after[0]!.effectiveAt.getTime() === soon.getTime() &&
      (after[0]!.payload as { resume?: { chargesHandling?: string } } | null)?.resume
        ?.chargesHandling === "add_to_unbilled_charges",
  );
  const now = await call("POST", `${B}/subscriptions/${sub}/resume`, {});
  ok(`resume with no option still resumes now (${now.body.status})`, now.body.status === "active");
}

// ── include_cancellation_day_in_billing (whole-day proration) ────────────────────────
{
  const { cus } = await customerWith("day-exact@sap.test", "tok_4242");
  const sub = (await create(cus)).body.id as string;
  const exact = await call("POST", `${B}/subscriptions/${sub}/cancel_estimate`, {
    cancel_option: "immediately",
    credit_option_for_current_term_charges: "prorate",
    include_cancellation_day_in_billing: false,
  });
  ok(`exact-proration business refuses the flag (${exact.status})`, exact.status === 400);

  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ prorationGranularity: "whole_day" })
      .where(eq(businesses.id, S.bizRow.id)),
  );
  const { cus: c2 } = await customerWith("day@sap.test", "tok_4242");
  const sub2 = (await create(c2)).body.id as string;
  const opts = { cancel_option: "immediately", credit_option_for_current_term_charges: "prorate" };
  const billed = await call("POST", `${B}/subscriptions/${sub2}/cancel_estimate`, opts);
  const credited = await call("POST", `${B}/subscriptions/${sub2}/cancel_estimate`, {
    ...opts,
    include_cancellation_day_in_billing: false,
  });
  const dayB = billed.body.cancellation_credit?.delivered_minor;
  const dayC = credited.body.cancellation_credit?.delivered_minor;
  ok(
    `false credits the cancellation day too (${dayB} → ${dayC} of 3000)`,
    credited.status === 200 && dayC === 3000 && dayB < 3000,
  );
  const wrongCredit = await call("POST", `${B}/subscriptions/${sub2}/cancel`, {
    cancel_option: "immediately",
    credit_option_for_current_term_charges: "full",
    include_cancellation_day_in_billing: false,
  });
  ok(`the flag without prorate → 400 (${wrongCredit.status})`, wrongCredit.status === 400);
  const done = await call("POST", `${B}/subscriptions/${sub2}/cancel`, {
    ...opts,
    include_cancellation_day_in_billing: false,
  });
  const cn = done.body.credit_note
    ? (
        await systemDb
          .select()
          .from(creditNotes)
          .where(eq(creditNotes.publicId, done.body.credit_note))
      )[0]
    : undefined;
  ok(
    `the cancel books what the estimate quoted (${cn?.totalMinor})`,
    done.status === 200 && cn != null && Number(cn.totalMinor) === dayC,
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ prorationGranularity: "exact" })
      .where(eq(businesses.id, S.bizRow.id)),
  );
}

// ── cancel_reason survives every cancel timing (operator + portal) ──────────────────
{
  const mk = async (email: string) => {
    const { cus } = await customerWith(email, "tok_4242");
    return { cus, sub: (await create(cus)).body.id as string };
  };
  const reasonOf = async (sub: string) => (await subRow(sub)).cancelReason;

  const eot = await mk("reason-eot@sap.test");
  await call("POST", `${B}/subscriptions/${eot.sub}/cancel`, {
    cancel_option: "end_of_term",
    cancel_reason: "Moving to an annual contract",
    cancel_reason_code: "pricing",
  });
  const eotRow = await subRow(eot.sub);
  ok(
    `end_of_term keeps cancel_reason + code at scheduling (${eotRow.cancelReason} / ${eotRow.cancelReasonCode})`,
    eotRow.cancelReason === "Moving to an annual contract" && eotRow.cancelReasonCode === "pricing",
  );
  const bare = await mk("reason-none@sap.test");
  await call("POST", `${B}/subscriptions/${bare.sub}/cancel`, { cancel_option: "end_of_term" });
  ok("end_of_term with no reason stores none, as before", (await reasonOf(bare.sub)) === null);
  const imm = await mk("reason-imm@sap.test");
  await call("POST", `${B}/subscriptions/${imm.sub}/cancel`, {
    cancel_option: "immediately",
    cancel_reason: "Closed the account",
  });
  ok(
    "immediate cancel stores cancel_reason, unchanged",
    (await reasonOf(imm.sub)) === "Closed the account",
  );
  const sd = await mk("reason-sd@sap.test");
  await call("POST", `${B}/subscriptions/${sd.sub}/cancel`, {
    cancel_option: "specific_date",
    cancel_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    cancel_reason: "Seasonal pause",
  });
  const sdRow = await subRow(sd.sub);
  const [sch] = await systemDb
    .select()
    .from(scheduledChanges)
    .where(and(eq(scheduledChanges.subscriptionId, sdRow.id), eq(scheduledChanges.type, "cancel")));
  ok(
    "specific_date stores cancel_reason now and carries it to the landing cancel",
    sdRow.cancelReason === "Seasonal pause" &&
      (sch?.payload as { cancel?: { cancelReason?: string } } | null)?.cancel?.cancelReason ===
        "Seasonal pause",
  );

  // Portal: free-text `reason` on an end-of-term business.
  await clearPublicRateLimits();
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ storefrontConfig: { allow_cancel_subscription: true, cancel_timing: "end_of_term" } })
      .where(eq(businesses.id, S.bizRow.id)),
  );
  const portalCancel = async (cus: string, sub: string, body: unknown) => {
    const minted = await tmb.paymentMethods.createPortalSession(S.biz, cus);
    const ex = await fetch(`${base}/portal/v1/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted.token}` },
    });
    const token = ((await ex.json()) as { token: string }).token;
    const r = await fetch(`${base}/portal/v1/subscriptions/${sub}/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `sap-portal-${++idem}`,
      },
      body: JSON.stringify(body),
    });
    return r.status;
  };
  const p1 = await mk("portal-reason@sap.test");
  const s1 = await portalCancel(p1.cus, p1.sub, { reason: "Too few integrations" });
  const p1Row = await subRow(p1.sub);
  ok(
    `portal end_of_term + reason stores the buyer's words (${s1}, ${p1Row.cancelReason})`,
    s1 === 200 && p1Row.cancelAtPeriodEnd && p1Row.cancelReason === "Too few integrations",
  );
  const p2 = await mk("portal-noreason@sap.test");
  const s2 = await portalCancel(p2.cus, p2.sub, {});
  ok(
    `portal with no reason keeps the attribution (${s2}, ${await reasonOf(p2.sub)})`,
    s2 === 200 &&
      (await reasonOf(p2.sub)) === "Cancelled by the customer from the self-serve portal",
  );
  const tooLong = await mk("portal-long@sap.test");
  ok(
    "portal reason over 200 chars → 400",
    (await portalCancel(tooLong.cus, tooLong.sub, { reason: "x".repeat(201) })) === 400,
  );
  await withTenant(orgId, (tx) =>
    tx.update(businesses).set({ storefrontConfig: null }).where(eq(businesses.id, S.bizRow.id)),
  );
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length} failed`,
);
await app.close();
await closeDb();
process.exit(failed === 0 ? 0 : 1);
