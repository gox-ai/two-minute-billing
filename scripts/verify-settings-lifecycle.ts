/**
 * verify:settings-lifecycle — subscription lifecycle settings (`billing_rules_config`,
 * lifecycle-config.ts): term on a plan change, coupons on a plan change, money from a
 * downgrade, reactivation charges and a won chargeback; plus the term a resume starts
 * and a chargeback policy's cancel, which changed for every business.
 *
 * Each money path compares the preview with what is booked, and every setting unset
 * behaves as before.
 *
 *   pnpm verify:settings-lifecycle
 */
import { and, desc, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createCoupon, applyCouponToSubscription } from "@/modules/coupons/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import {
  cancelSubscription,
  createSubscription,
  pauseSubscription,
} from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, collectInvoice } from "@/modules/invoicing/service";
import { recordOfflinePayment } from "@/modules/invoicing/ops";
import { createPortalSession } from "@/modules/customer-portal/service";
import { handleDisputeEvent } from "@/modules/disputes/service";
import { initialBillingRulesConfig } from "@/modules/subscriptions/billing-rules-config";
import { resetTermFor, resolveLifecycleConfig } from "@/modules/subscriptions/lifecycle-config";
import {
  appliedCoupons,
  businesses,
  creditNotes,
  customers,
  disputes,
  invoices,
  payments,
  refunds,
  subscriptionItems,
  subscriptions,
  unbilledCharges,
} from "@db/schema";
import type { NormalizedProviderEvent } from "@/providers/types";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push([name, ok]);
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
};

type Res = { statusCode: number; payload: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Res): any => {
  try {
    return JSON.parse(r.payload);
  } catch {
    return {};
  }
};

const DAY = 24 * 3600_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

const app = await buildApp({ logger: false });
await clearPublicRateLimits();
const org = await createOrganization({ name: "Lifecycle Rules Co" });
const orgId = org.organization.id;
const api = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${org.secret}`,
      ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  }) as unknown as Promise<Res>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const net = (r: any) => (r.proration_invoice?.total_minor ?? 0) - (r.credit_note?.total_minor ?? 0);

type Plan = "basic" | "pro";

/** A business with `rules`, two plan products and one paid subscription. */
async function setup(
  rules?: Record<string, unknown>,
  opts: {
    start?: Plan;
    /** When the subscription started; default now. */
    startedAt?: Date;
    storefront?: Record<string, unknown>;
    chargeback?: Record<string, unknown>;
    custom?: number;
    billingCycles?: number;
    bill?: boolean;
    /** Pay the first invoice offline (all of it), or half offline and half by card. */
    offline?: "all" | "half";
    /** Business cancel defaults (0242). */
    cancelDefaults?: Partial<typeof businesses.$inferInsert>;
  } = {},
) {
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Lifecycle",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  await systemDb
    .update(businesses)
    .set({
      ...(rules ? { billingRulesConfig: rules } : {}),
      storefrontConfig: {
        allow_plan_changes: true,
        seat_changes: "both",
        shorter_period: "always",
        charge_upgrade: "now",
        ...(opts.storefront ?? {}),
      },
      ...(opts.chargeback ? { chargebackConfig: opts.chargeback } : {}),
      ...(opts.cancelDefaults ?? {}),
      defaultInvoiceImmediately: true,
    })
    .where(eq(businesses.id, biz.id));
  const mkProduct = (name: string) =>
    createProduct({
      organizationId: orgId,
      businessId: biz.id,
      name,
      kind: "plan",
      enabledInPortal: true,
    });
  const products = { basic: await mkProduct("Basic"), pro: await mkProduct("Pro") };
  const mk = (p: Plan, amountMinor: number) =>
    createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: products[p].id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  const price: Record<Plan, Awaited<ReturnType<typeof mk>>> = {
    basic: await mk("basic", 1000),
    pro: await mk("pro", 3000),
  };
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `l${Math.random().toString(36).slice(2)}@example.com`,
  });
  if (opts.offline)
    await systemDb
      .update(customers)
      .set({ autoCollection: "off" })
      .where(eq(customers.id, customer.id));
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const created = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: opts.startedAt ?? new Date(),
    items: [
      {
        price: price[opts.start ?? "basic"],
        quantity: 1,
        ...(opts.custom != null ? { customAmountMinor: opts.custom } : {}),
        ...(opts.billingCycles != null ? { billingCycles: opts.billingCycles } : {}),
      },
    ],
    defaultPaymentMethodId: pm.id,
  });
  const sub = created.subscription;
  let firstInvoice: Awaited<ReturnType<typeof billSubscriptionPeriod>>["invoice"] | null = null;
  if (opts.bill !== false) {
    firstInvoice = (
      await billSubscriptionPeriod({
        organizationId: orgId,
        businessId: biz.id,
        subscription: sub,
        periodStart: sub.currentPeriodStart!,
        periodEnd: sub.currentPeriodEnd!,
      })
    ).invoice;
  }
  if (opts.offline && firstInvoice) {
    await recordOfflinePayment({
      organizationId: orgId,
      businessId: biz.id,
      invoicePublicId: firstInvoice.publicId,
      ...(opts.offline === "half" ? { amountMinor: Number(firstInvoice.totalMinor) / 2 } : {}),
      method: "wire",
    });
    if (opts.offline === "half") {
      const [open] = await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.id, firstInvoice!.id)),
      );
      await collectInvoice({
        organizationId: orgId,
        businessId: biz.id,
        invoice: open!,
        subscription: sub,
      });
    }
  }
  const item = created.items[0]!.publicId;
  const base = `/v1/businesses/${biz.publicId}/subscriptions/${sub.publicId}`;
  const edit = (to: Plan) => ({ changes: [{ item, price: price[to].publicId }] });
  const row = async () =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)),
      )
    )[0]!;
  const items = () =>
    withTenant(orgId, (tx) =>
      tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id)),
    );
  const subInvoices = () =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(invoices)
        .where(eq(invoices.subscriptionId, sub.id))
        .orderBy(desc(invoices.createdAt)),
    );
  return {
    biz,
    price,
    products,
    customer,
    sub,
    item,
    base,
    firstInvoice,
    row,
    items,
    subInvoices,
    estimate: (to: Plan, extra: object = {}) =>
      api("POST", `${base}/estimate`, { ...edit(to), ...extra }),
    change: (to: Plan, extra: object = {}) =>
      api("POST", `${base}/change`, { ...edit(to), invoice_immediately: true, ...extra }),
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const portalToken = async (c: Ctx) => {
  const session = await createPortalSession({
    organizationId: orgId,
    businessId: c.biz.id,
    customerId: c.customer.id,
  });
  return json(
    (await app.inject({
      method: "POST",
      url: "/portal/v1/session",
      headers: { authorization: `Bearer ${session.accessToken}` },
    })) as unknown as Res,
  ).token as string;
};
const portal = (token: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(payload ? { payload } : {}),
  }) as unknown as Promise<Res>;

const termDays = (r: { currentPeriodStart: Date | null; currentPeriodEnd: Date | null }) =>
  Math.round((r.currentPeriodEnd!.getTime() - r.currentPeriodStart!.getTime()) / DAY);

// ── Storage ────────────────────────────────────────────────────────────────────────
{
  const created = json(
    await api("POST", "/v1/businesses", { default_currency: "USD", name: "Key-made lifecycle" }),
  );
  const r = created.billing_rules_config;
  check(
    "a key-created business reads today's lifecycle rules",
    r?.plan_change_term === "keep_anchor" &&
      r?.plan_change_coupons === "keep" &&
      r?.downgrade_credit === "credit_balance" &&
      r?.reactivation_charges === "invoice_immediately" &&
      r?.chargeback_won === undefined &&
      r?.renewal_uplift === undefined &&
      r?.resume_term === undefined,
    JSON.stringify(r),
  );
  const p = json(
    await api("PATCH", `/v1/businesses/${created.id}`, {
      billing_rules_config: {
        plan_change_term: "reset_on_upgrade",
        downgrade_credit: "refund",
        reactivation_charges: "add_to_unbilled_charges",
      },
    }),
  ).billing_rules_config;
  check(
    "PATCH stores the lifecycle keys",
    p?.plan_change_term === "reset_on_upgrade" &&
      p?.downgrade_credit === "refund" &&
      p?.reactivation_charges === "add_to_unbilled_charges",
    JSON.stringify(p),
  );
  const unknown = await api("PATCH", `/v1/businesses/${created.id}`, {
    billing_rules_config: { plan_change_term: "always" },
  });
  check("an option we do not offer → 400", unknown.statusCode === 400);
  const fresh = initialBillingRulesConfig({ hasOperator: true }) as Record<string, unknown>;
  const freshLife = resolveLifecycleConfig({ billingRulesConfig: fresh });
  check(
    "a person's new business: coupons kept only if valid; every other lifecycle rule is today's",
    freshLife.planChangeCoupons === "keep_if_valid" &&
      freshLife.planChangeTerm === "keep_anchor" &&
      freshLife.downgradeCredit === "credit_balance" &&
      freshLife.reactivationCharges === "invoice_immediately",
  );
  check(
    "resetTermFor: the call wins; a quantity-only edit never resets",
    resetTermFor("reset_on_any_change", "upgrade", true, false) === false &&
      resetTermFor("reset_on_upgrade", "downgrade", true) === undefined &&
      resetTermFor("reset_on_upgrade", "upgrade", false) === undefined &&
      resetTermFor("keep_anchor", "upgrade", true) === undefined,
  );
}

// ── 2.62 Term on a plan change ──────────────────────────────────────────────────────
{
  const u = await setup(undefined, { startedAt: daysAgo(10) });
  const before = await u.row();
  const e = json(await u.estimate("pro"));
  const r = json(await u.change("pro"));
  const after = await u.row();
  check(
    "unset: a same-period upgrade keeps the term (estimate and apply)",
    e.change_policy?.reset_term === false &&
      e.term_reset === false &&
      after.currentPeriodEnd!.getTime() === before.currentPeriodEnd!.getTime() &&
      net(r) === e.total_minor,
    `est=${e.total_minor} net=${net(r)} reset=${e.change_policy?.reset_term}`,
  );

  const up = await setup({ plan_change_term: "reset_on_upgrade" }, { startedAt: daysAgo(10) });
  const ue = json(await up.estimate("pro"));
  const ur = json(await up.change("pro"));
  const uAfter = await up.row();
  check(
    "reset_on_upgrade: the estimate resets, and the booked term and money equal it",
    ue.change_policy?.reset_term === true &&
      ue.term_reset === true &&
      Math.abs(uAfter.currentPeriodEnd!.getTime() - Date.parse(ue.new_period_end)) < 60_000 &&
      termDays(uAfter) >= 28 &&
      net(ur) === ue.total_minor,
    `est=${ue.total_minor}/${ue.new_period_end} net=${net(ur)}/${uAfter.currentPeriodEnd?.toISOString()}`,
  );

  const down = await setup(
    { plan_change_term: "reset_on_upgrade", downgrade_timing: "now" },
    { start: "pro", startedAt: daysAgo(10) },
  );
  const dBefore = await down.row();
  const de = json(await down.estimate("basic"));
  await down.change("basic");
  check(
    "reset_on_upgrade: a downgrade keeps the term",
    de.change_policy?.reset_term === false &&
      (await down.row()).currentPeriodEnd!.getTime() === dBefore.currentPeriodEnd!.getTime(),
  );

  const any = await setup(
    { plan_change_term: "reset_on_any_change", downgrade_timing: "now" },
    { start: "pro", startedAt: daysAgo(10) },
  );
  const ae = json(await any.estimate("basic"));
  const ar = json(await any.change("basic"));
  check(
    "reset_on_any_change: a downgrade resets, booked as estimated",
    ae.change_policy?.reset_term === true &&
      Math.abs((await any.row()).currentPeriodEnd!.getTime() - Date.parse(ae.new_period_end)) <
        60_000 &&
      net(ar) === ae.total_minor,
    `est=${ae.total_minor} net=${net(ar)}`,
  );

  const explicit = await setup(
    { plan_change_term: "reset_on_any_change" },
    { startedAt: daysAgo(10) },
  );
  const xBefore = await explicit.row();
  const xe = json(await explicit.estimate("pro", { reset_term: false }));
  await explicit.change("pro", { reset_term: false });
  check(
    "reset_term: false on the call wins over the rule",
    xe.change_policy?.reset_term === false &&
      (await explicit.row()).currentPeriodEnd!.getTime() === xBefore.currentPeriodEnd!.getTime(),
  );

  // Portal: the rule applies, preview and apply agree.
  const p = await setup({ plan_change_term: "reset_on_upgrade" }, { startedAt: daysAgo(10) });
  const token = await portalToken(p);
  const pv = json(
    await portal(token, "POST", `/portal/v1/subscriptions/${p.sub.publicId}/change/preview`, {
      plan: p.price.pro.publicId,
    }),
  );
  const pa = await portal(token, "POST", `/portal/v1/subscriptions/${p.sub.publicId}/change`, {
    plan: p.price.pro.publicId,
    expected_total_minor: pv.total_minor,
    priced_at: pv.priced_at,
    quote: pv.quote,
  });
  const pAfter = await p.row();
  check(
    "portal: an upgrade under reset_on_upgrade previews and books a new term",
    pv.reset_term === true &&
      pa.statusCode === 200 &&
      termDays(pAfter) >= 28 &&
      pAfter.currentPeriodStart!.getTime() > p.sub.currentPeriodStart!.getTime(),
    `${pa.statusCode} ${pa.payload.slice(0, 200)}`,
  );
}

// ── 2.65 Coupons on a plan change ───────────────────────────────────────────────────
{
  const activeCodes = (c: Ctx) =>
    withTenant(orgId, async (tx) => {
      const { coupons } = await import("@db/schema");
      return (
        await tx
          .select({ code: coupons.code })
          .from(appliedCoupons)
          .innerJoin(coupons, eq(coupons.id, appliedCoupons.couponId))
          .where(
            and(eq(appliedCoupons.subscriptionId, c.sub.id), eq(appliedCoupons.status, "active")),
          )
      ).map((r) => r.code);
    });
  const withCoupons = async (rules?: Record<string, unknown>) => {
    const c = await setup(rules, { startedAt: daysAgo(10) });
    const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
    // Limited to the Basic plan, and one on the whole invoice.
    await createCoupon({
      organizationId: orgId,
      businessId: c.biz.id,
      code: `BASIC${tag}`,
      kind: "percentage",
      percentOffBps: 1000,
      durationType: "forever",
      applyOn: "each_specified_item",
      itemConstraints: [
        { itemKind: "plan", constraintType: "specific", productIds: [c.products.basic.publicId] },
      ],
    });
    await createCoupon({
      organizationId: orgId,
      businessId: c.biz.id,
      code: `ALL${tag}`,
      kind: "percentage",
      percentOffBps: 500,
      durationType: "forever",
    });
    for (const code of [`BASIC${tag}`, `ALL${tag}`])
      await applyCouponToSubscription({
        organizationId: orgId,
        businessId: c.biz.id,
        subscriptionId: c.sub.id,
        code,
        now: new Date(),
      });
    return { c, basic: `BASIC${tag}`, all: `ALL${tag}` };
  };

  const keep = await withCoupons();
  const ke = json(await keep.c.estimate("pro"));
  const kr = json(await keep.c.change("pro"));
  const kCodes = await activeCodes(keep.c);
  check(
    "unset: both coupons stay after a plan change; booked as estimated",
    kCodes.length === 2 && net(kr) === ke.total_minor,
    `${kCodes} est=${ke.total_minor} net=${net(kr)}`,
  );

  const drop = await withCoupons({ plan_change_coupons: "drop" });
  const dre = json(await drop.c.estimate("pro"));
  const drr = json(await drop.c.change("pro"));
  const dCodes = await activeCodes(drop.c);
  check(
    "drop: every coupon removed; the estimate priced without them equals the booking",
    dCodes.length === 0 && net(drr) === dre.total_minor && dre.total_minor > ke.total_minor,
    `${dCodes} est=${dre.total_minor} net=${net(drr)} keepEst=${ke.total_minor}`,
  );

  const valid = await withCoupons({ plan_change_coupons: "keep_if_valid" });
  const ve = json(await valid.c.estimate("pro"));
  const vr = json(await valid.c.change("pro"));
  const vCodes = await activeCodes(valid.c);
  check(
    "keep_if_valid: the Basic-only coupon goes, the invoice coupon stays; booked as estimated",
    vCodes.length === 1 && vCodes[0] === valid.all && net(vr) === ve.total_minor,
    `${vCodes} est=${ve.total_minor} net=${net(vr)}`,
  );
  const qty = await withCoupons({ plan_change_coupons: "drop" });
  await api("POST", `${qty.c.base}/change`, {
    changes: [{ item: qty.c.item, quantity: 2 }],
    invoice_immediately: true,
  });
  check(
    "a quantity change is not a plan change: coupons stay under drop",
    (await activeCodes(qty.c)).length === 2,
  );

  // `coupons` on `POST …/change` and `…/estimate` overrides the rule for one call.
  const oDrop = await withCoupons({ plan_change_coupons: "keep" });
  const ode = json(await oDrop.c.estimate("pro", { coupons: "drop" }));
  const odr = json(await oDrop.c.change("pro", { coupons: "drop" }));
  check(
    "override: rule keep + coupons drop → every coupon removed; booked as estimated",
    (await activeCodes(oDrop.c)).length === 0 &&
      net(odr) === ode.total_minor &&
      ode.total_minor === dre.total_minor &&
      ode.change_policy?.coupons === "drop",
    `est=${ode.total_minor} net=${net(odr)} dropEst=${dre.total_minor} ${ode.change_policy?.coupons}`,
  );
  const oKeep = await withCoupons({ plan_change_coupons: "drop" });
  const oke = json(await oKeep.c.estimate("pro", { coupons: "keep" }));
  const okr = json(await oKeep.c.change("pro", { coupons: "keep" }));
  check(
    "override: rule drop + coupons keep → both coupons stay; booked as estimated",
    (await activeCodes(oKeep.c)).length === 2 && net(okr) === oke.total_minor,
    `est=${oke.total_minor} net=${net(okr)}`,
  );
  const oValid = await withCoupons({ plan_change_coupons: "drop" });
  await oValid.c.change("pro", { coupons: "keep_if_valid" });
  const ovCodes = await activeCodes(oValid.c);
  check(
    "override: rule drop + coupons keep_if_valid → only the invoice coupon stays",
    ovCodes.length === 1 && ovCodes[0] === oValid.all,
    `${ovCodes}`,
  );
  const oSched = await withCoupons();
  const osr = await oSched.c.change("pro", { coupons: "drop", timing: "end_of_term" });
  check(
    "coupons with a change at the end of the term → 400 naming it",
    osr.statusCode === 400 && osr.payload.includes("coupons"),
    `${osr.statusCode} ${osr.payload.slice(0, 200)}`,
  );
  check(
    "omitted: the estimate reports the business rule (drop)",
    dre.change_policy?.coupons === "drop" && ke.change_policy?.coupons === "keep",
    `${dre.change_policy?.coupons} ${ke.change_policy?.coupons}`,
  );
}

// ── 2.72 Money from a downgrade ─────────────────────────────────────────────────────
{
  const refundRows = (c: Ctx) =>
    withTenant(orgId, (tx) =>
      tx
        .select({ id: refunds.id, amountMinor: refunds.amountMinor })
        .from(refunds)
        .innerJoin(payments, eq(payments.id, refunds.paymentId))
        .where(eq(payments.customerId, c.customer.id)),
    );
  const noteRow = async (id: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(creditNotes).where(eq(creditNotes.publicId, id)),
      )
    )[0]!;
  const unset = await setup({ downgrade_timing: "now" }, { start: "pro", startedAt: daysAgo(5) });
  const ur = json(await unset.change("basic"));
  check(
    "unset: a downgrade's credit stays as account credit (no refund)",
    !!ur.credit_note?.id &&
      ur.credit_refunds === undefined &&
      (await refundRows(unset)).length === 0,
    JSON.stringify(ur.credit_refunds),
  );

  const ref = await setup(
    { downgrade_timing: "now", downgrade_credit: "refund" },
    { start: "pro", startedAt: daysAgo(5) },
  );
  const re = json(await ref.estimate("basic"));
  const rr = json(await ref.change("basic"));
  const rRows = await refundRows(ref);
  check(
    "refund: the estimate says refund; the whole credit goes back to the card",
    re.change_policy?.credit_handling === "refund" &&
      rr.credit_refunds?.[0]?.refunded_minor > 0 &&
      rr.credit_refunds[0].kept_minor === 0 &&
      rRows.length === 1 &&
      Number(rRows[0]!.amountMinor) === rr.credit_refunds[0].refunded_minor,
    JSON.stringify(rr.credit_refunds),
  );

  const offline = await setup(
    { downgrade_timing: "now", downgrade_credit: "refund" },
    { start: "pro", startedAt: daysAgo(5), offline: "all" },
  );
  const or_ = json(await offline.change("basic"));
  const oNote = or_.credit_note?.id ? await noteRow(or_.credit_note.id) : null;
  check(
    "refund: a credit paid offline stays as credit, with nothing earmarked or refunded",
    or_.credit_refunds?.[0]?.refunded_minor === 0 &&
      or_.credit_refunds[0].kept_minor > 0 &&
      (await refundRows(offline)).length === 0 &&
      oNote != null &&
      Number(oNote.refundedMinor ?? 0) === 0,
    JSON.stringify({ r: or_.credit_refunds, e: or_.error }),
  );

  // The preview states the refund, and the next renewal it quotes is the one booked.
  const renewalDue = async (c: Ctx) =>
    json(await api("GET", `${c.base}/renewal_estimate`)).estimate?.amount_due_minor;
  check(
    "refund preview: refunded amount = the refund row; next renewal = the booked renewal",
    re.refunded_to_payment_method_minor === rr.credit_refunds?.[0]?.refunded_minor &&
      (re.refundable_credit_added_minor ?? 0) === 0 &&
      re.next_renewal?.credits_applied_minor === 0 &&
      re.next_renewal?.amount_due_minor === (await renewalDue(ref)),
    JSON.stringify({
      pre: re.refunded_to_payment_method_minor,
      booked: rr.credit_refunds?.[0]?.refunded_minor,
      next: re.next_renewal?.amount_due_minor,
      renewal: await renewalDue(ref),
    }),
  );

  const half = await setup(
    { downgrade_timing: "now", downgrade_credit: "refund" },
    { start: "pro", startedAt: daysAgo(5), offline: "half" },
  );
  const he = json(await half.estimate("basic"));
  const hr = json(await half.change("basic"));
  const hRows = await refundRows(half);
  check(
    "refund: a credit larger than the card payment refunds the card part and keeps the rest",
    hr.credit_refunds?.[0]?.refunded_minor > 0 &&
      hr.credit_refunds[0].refunded_minor <= 1500 &&
      hr.credit_refunds[0].kept_minor > 0 &&
      hRows.reduce((t, r) => t + Number(r.amountMinor), 0) === hr.credit_refunds[0].refunded_minor,
    JSON.stringify({ r: hr.credit_refunds, e: hr.error }),
  );
  check(
    "half card, half offline: the preview's refunded/kept split matches the booking",
    he.refunded_to_payment_method_minor === hr.credit_refunds?.[0]?.refunded_minor &&
      he.refundable_credit_added_minor === hr.credit_refunds?.[0]?.kept_minor &&
      he.next_renewal?.amount_due_minor === (await renewalDue(half)),
    JSON.stringify({
      pre: [he.refunded_to_payment_method_minor, he.refundable_credit_added_minor],
      booked: hr.credit_refunds?.[0],
      next: [he.next_renewal?.amount_due_minor, await renewalDue(half)],
    }),
  );

  const choose = await setup(
    { downgrade_timing: "now", downgrade_credit: "customer_chooses" },
    { start: "pro", startedAt: daysAgo(5) },
  );
  const token = await portalToken(choose);
  const url = `/portal/v1/subscriptions/${choose.sub.publicId}/change`;
  const pv = json(
    await portal(token, "POST", `${url}/preview`, { plan: choose.price.basic.publicId }),
  );
  const pa = json(
    await portal(token, "POST", url, {
      plan: choose.price.basic.publicId,
      credit_handling: "refund",
      expected_total_minor: pv.total_minor,
      priced_at: pv.priced_at,
      quote: pv.quote,
    }),
  );
  check(
    "customer_chooses: the portal offers both, and the customer's refund is made",
    JSON.stringify(pv.credit_handling_options) === '["credit_balance","refund"]' &&
      pa.credit_refunds?.[0]?.refunded_minor > 0,
    JSON.stringify({ o: pv.credit_handling_options, r: pa.credit_refunds, e: pa.error }),
  );
  const notOffered = await setup(
    { downgrade_timing: "now" },
    { start: "pro", startedAt: daysAgo(5) },
  );
  const t2 = await portalToken(notOffered);
  const refused = await portal(
    t2,
    "POST",
    `/portal/v1/subscriptions/${notOffered.sub.publicId}/change/preview`,
    { plan: notOffered.price.basic.publicId, credit_handling: "refund" },
  );
  check("a credit selection the business does not offer → 400", refused.statusCode === 400);

  // `downgrade_credit` on `POST …/change` overrides the rule for one call.
  const oRef = await setup({ downgrade_timing: "now" }, { start: "pro", startedAt: daysAgo(5) });
  const ore = json(await oRef.estimate("basic", { downgrade_credit: "refund" }));
  const orr = json(await oRef.change("basic", { downgrade_credit: "refund" }));
  const orRows = await refundRows(oRef);
  check(
    "override: rule credit_balance + downgrade_credit refund → refunded to the card, as previewed",
    ore.change_policy?.credit_handling === "refund" &&
      orr.credit_refunds?.[0]?.refunded_minor > 0 &&
      ore.refunded_to_payment_method_minor === orr.credit_refunds[0].refunded_minor &&
      orRows.length === 1,
    JSON.stringify({ p: ore.change_policy?.credit_handling, r: orr.credit_refunds }),
  );
  const oKeep = await setup(
    { downgrade_timing: "now", downgrade_credit: "refund" },
    { start: "pro", startedAt: daysAgo(5) },
  );
  const oke = json(await oKeep.estimate("basic", { downgrade_credit: "credit_balance" }));
  const okr = json(await oKeep.change("basic", { downgrade_credit: "credit_balance" }));
  check(
    "override: rule refund + downgrade_credit credit_balance → kept as credit, no refund",
    oke.change_policy?.credit_handling === "credit_balance" &&
      (oke.refunded_to_payment_method_minor ?? 0) === 0 &&
      !!okr.credit_note?.id &&
      okr.credit_refunds === undefined &&
      (await refundRows(oKeep)).length === 0,
    JSON.stringify({ p: oke.change_policy?.credit_handling, r: okr.credit_refunds }),
  );
  const oChoose = await setup(
    { downgrade_timing: "now", downgrade_credit: "customer_chooses" },
    { start: "pro", startedAt: daysAgo(5) },
  );
  const ocr = json(await oChoose.change("basic", { downgrade_credit: "refund" }));
  check(
    "override: rule customer_chooses + downgrade_credit refund → refunded",
    ocr.credit_refunds?.[0]?.refunded_minor > 0,
    JSON.stringify(ocr.credit_refunds),
  );
  const oChooseOmit = await setup(
    { downgrade_timing: "now", downgrade_credit: "customer_chooses" },
    { start: "pro", startedAt: daysAgo(5) },
  );
  const ocoe = json(await oChooseOmit.estimate("basic"));
  const ocor = json(await oChooseOmit.change("basic"));
  check(
    "omitted under customer_chooses: an operator change keeps the credit (unchanged)",
    ocoe.change_policy?.credit_handling === "credit_balance" &&
      ocor.credit_refunds === undefined &&
      (await refundRows(oChooseOmit)).length === 0,
    JSON.stringify({ p: ocoe.change_policy?.credit_handling, r: ocor.credit_refunds }),
  );
}

// ── 2.63 Reactivation ───────────────────────────────────────────────────────────────
{
  const cancelled = async (rules?: Record<string, unknown>) => {
    const c = await setup(rules, { startedAt: daysAgo(20) });
    await cancelSubscription({
      organizationId: orgId,
      businessId: c.biz.id,
      subscriptionId: c.sub.id,
      atPeriodEnd: false,
      now: daysAgo(12),
    });
    return c;
  };
  const plain = await cancelled();
  const before = (await plain.subInvoices()).length;
  const r = await api("POST", `${plain.base}/reactivate`, {});
  const row = await plain.row();
  const today = new Date().getUTCDate();
  check(
    "plain reactivate: a full term anchored on the reactivation day (was the old billing day)",
    r.statusCode === 200 &&
      row.status === "active" &&
      row.billingAnchorDay === row.currentPeriodStart!.getUTCDate() &&
      termDays(row) >= 28 &&
      termDays(row) <= 31,
    `${r.statusCode} anchor=${row.billingAnchorDay} today=${today} days=${termDays(row)}`,
  );
  check(
    "unset reactivation_charges: the new term is invoiced now",
    (await plain.subInvoices()).length === before + 1,
  );

  const deferred = await cancelled({ reactivation_charges: "add_to_unbilled_charges" });
  const dBefore = (await deferred.subInvoices()).length;
  const dr = await api("POST", `${deferred.base}/reactivate`, {});
  const queued = await withTenant(orgId, (tx) =>
    tx.select().from(unbilledCharges).where(eq(unbilledCharges.subscriptionId, deferred.sub.id)),
  );
  check(
    "add_to_unbilled_charges: no invoice, the full term waits as an unbilled charge",
    dr.statusCode === 200 &&
      (await deferred.subInvoices()).length === dBefore &&
      queued.some((q) => Number(q.amountMinor) === 1000),
    `${dr.statusCode} ${dr.payload.slice(0, 200)} queued=${queued.length}`,
  );
  const explicitNow = await cancelled({ reactivation_charges: "add_to_unbilled_charges" });
  const eBefore = (await explicitNow.subInvoices()).length;
  await api("POST", `${explicitNow.base}/reactivate`, { charges_handling: "invoice_immediately" });
  check(
    "charges_handling on the call wins over the rule",
    (await explicitNow.subInvoices()).length === eBefore + 1,
  );
  // A pending cancel: reactivate only withdraws it; the rule has no new term to bill.
  const pending = await setup({ reactivation_charges: "add_to_unbilled_charges" });
  await api("POST", `${pending.base}/cancel`, { cancel_option: "end_of_term" });
  const pr = await api("POST", `${pending.base}/reactivate`, {});
  const pRow = await pending.row();
  const pQueued = await withTenant(orgId, (tx) =>
    tx.select().from(unbilledCharges).where(eq(unbilledCharges.subscriptionId, pending.sub.id)),
  );
  check(
    "a pending cancel under add_to_unbilled_charges: reactivate withdraws it (200), bills nothing",
    pr.statusCode === 200 && !pRow.cancelAtPeriodEnd && pQueued.length === 0,
    `${pr.statusCode} ${pr.payload.slice(0, 200)}`,
  );
  const pendingUnset = await setup();
  await api("POST", `${pendingUnset.base}/cancel`, { cancel_option: "end_of_term" });
  const pu = await api("POST", `${pendingUnset.base}/reactivate`, {});
  check(
    "unset: an empty-body reactivate withdraws a pending cancel (200; it threw a 500)",
    pu.statusCode === 200 && !(await pendingUnset.row()).cancelAtPeriodEnd,
    `${pu.statusCode} ${pu.payload.slice(0, 200)}`,
  );
}

// ── Resume after the paid term ended (every business) ──────────────────────────────
{
  const out = await setup(undefined, { startedAt: daysAgo(45) });
  await pauseSubscription({
    organizationId: orgId,
    businessId: out.biz.id,
    subscriptionId: out.sub.id,
    now: daysAgo(20),
  });
  const fr = await api("POST", `${out.base}/resume`, {});
  const fRow = await out.row();
  check(
    "a resume after the term ended starts a full period on the resume day (was: the old billing day)",
    fr.statusCode === 200 &&
      fRow.billingAnchorDay === fRow.currentPeriodStart!.getUTCDate() &&
      fRow.billingAnchorDay !== out.sub.billingAnchorDay &&
      termDays(fRow) >= 28 &&
      termDays(fRow) <= 31,
    `${fr.statusCode} anchor=${fRow.billingAnchorDay} was=${out.sub.billingAnchorDay} days=${termDays(fRow)}`,
  );
  const inTerm = await setup(undefined, { startedAt: daysAgo(5) });
  await pauseSubscription({
    organizationId: orgId,
    businessId: inTerm.biz.id,
    subscriptionId: inTerm.sub.id,
    now: daysAgo(2),
  });
  await api("POST", `${inTerm.base}/resume`, {});
  const iRow = await inTerm.row();
  // A customer with a billing day set on purpose keeps it.
  const fixed = await setup(undefined, { startedAt: daysAgo(45) });
  await systemDb
    .update(customers)
    .set({ billingDateMode: "manually_set", billingDate: fixed.sub.billingAnchorDay })
    .where(eq(customers.id, fixed.customer.id));
  await pauseSubscription({
    organizationId: orgId,
    businessId: fixed.biz.id,
    subscriptionId: fixed.sub.id,
    now: daysAgo(20),
  });
  await api("POST", `${fixed.base}/resume`, {});
  check(
    "a manually set billing day stays on resume",
    (await fixed.row()).billingAnchorDay === fixed.sub.billingAnchorDay,
  );

  // A pending skip on the old schedule moves to the matching renewal on the new one.
  const skipped = await setup(undefined, { startedAt: daysAgo(45) });
  const { advancePeriod } = await import("@/modules/subscriptions/service");
  const { renewalSkips } = await import("@db/schema");
  const utc = { timezone: "UTC" } as never;
  const oldNext = advancePeriod(
    skipped.sub.currentPeriodEnd!,
    "month",
    1,
    skipped.sub.billingAnchorDay,
    utc,
  );
  const oldSecond = advancePeriod(oldNext, "month", 1, skipped.sub.billingAnchorDay, utc);
  await systemDb.insert(renewalSkips).values({
    organizationId: orgId,
    businessId: skipped.biz.id,
    subscriptionId: skipped.sub.id,
    publicId: `skip_${Math.random().toString(36).slice(2, 14)}`,
    renewalAt: oldSecond,
    source: "api",
  });
  await pauseSubscription({
    organizationId: orgId,
    businessId: skipped.biz.id,
    subscriptionId: skipped.sub.id,
    now: daysAgo(20),
  });
  await api("POST", `${skipped.base}/resume`, {});
  const sRow = await skipped.row();
  const want = advancePeriod(sRow.currentPeriodEnd!, "month", 1, sRow.billingAnchorDay, utc);
  const [skipRow] = await withTenant(orgId, (tx) =>
    tx.select().from(renewalSkips).where(eq(renewalSkips.subscriptionId, skipped.sub.id)),
  );
  check(
    "a skip of the 2nd upcoming renewal moves to the 2nd upcoming renewal on the new day",
    skipRow!.status === "scheduled" && skipRow!.renewalAt.getTime() === want.getTime(),
    `${skipRow!.renewalAt.toISOString()} want ${want.toISOString()} (was ${oldSecond.toISOString()})`,
  );

  check(
    "a resume inside the paid term keeps that term",
    iRow.currentPeriodEnd!.getTime() === inTerm.sub.currentPeriodEnd!.getTime() &&
      iRow.billingAnchorDay === inTerm.sub.billingAnchorDay,
  );
}

// ── Chargeback policy (every business with one) ─────────────────────────────────────
{
  let seq = 0;
  const disputeOn = async (c: Ctx) => {
    if (c.firstInvoice)
      await collectInvoice({
        organizationId: orgId,
        businessId: c.biz.id,
        invoice: c.firstInvoice,
        subscription: c.sub,
      }).catch(() => undefined);
    const [pay] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(payments)
        .where(and(eq(payments.customerId, c.customer.id), eq(payments.status, "succeeded")))
        .limit(1),
    );
    const disputeId = `dp_life_${Date.now()}_${++seq}`;
    const ev = (type: NormalizedProviderEvent["type"]): NormalizedProviderEvent => ({
      providerEventId: `evt_life_${Date.now()}_${++seq}`,
      type,
      providerChargeId: pay!.providerChargeId!,
      providerDisputeId: disputeId,
      disputeReason: "fraudulent",
      disputeAmountMinor: pay!.amountMinor,
      disputeCurrency: "USD",
      occurredAt: new Date(),
      raw: { provider_key: "tmtest" },
    });
    const ctx = { businessId: c.biz.id, providerKey: "tmtest" };
    return {
      send: (t: NormalizedProviderEvent["type"]) => handleDisputeEvent(ev(t), ctx),
      disputeId,
    };
  };
  const pauseCfg = { on_initiated_subscription: "pause_indefinitely" };

  const pz = await setup(undefined, { chargeback: pauseCfg });
  const d0 = await disputeOn(pz);
  await d0.send("dispute.created");
  const pausedRow = await pz.row();
  await d0.send("dispute.won");
  check(
    "the policy's pause runs (it always failed), and a won dispute changes nothing",
    pausedRow.status === "paused" && (await pz.row()).status === "paused",
    pausedRow.status,
  );

  // A policy cancel never refunds or collects, whatever the business's cancel defaults say.
  const safe = await setup(undefined, {
    chargeback: { on_initiated_subscription: "cancel_immediately" },
    cancelDefaults: {
      defaultCreditOptionForCancel: "prorate",
      defaultRefundableCreditsOnCancel: "schedule_refund",
      defaultArHandlingOnCancel: "schedule_payment_collection",
    },
  });
  const d1 = await disputeOn(safe);
  await d1.send("dispute.created");
  const notes = await withTenant(orgId, (tx) =>
    tx
      .select({ id: creditNotes.id })
      .from(creditNotes)
      .where(eq(creditNotes.customerId, safe.customer.id)),
  );
  const safeRefunds = await withTenant(orgId, (tx) =>
    tx
      .select({ id: refunds.id })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(eq(payments.customerId, safe.customer.id)),
  );
  check(
    "a policy cancel takes no cancel defaults: cancelled, no credit note, no refund",
    (await safe.row()).status === "cancelled" && notes.length === 0 && safeRefunds.length === 0,
    `notes=${notes.length} refunds=${safeRefunds.length}`,
  );

  // The cascade skips the customer's other paused subscriptions.
  const cascade = await setup(undefined, {
    chargeback: {
      on_initiated_subscription: "cancel_immediately",
      cascade_to_other_subscriptions: true,
    },
  });
  const other = await createSubscription({
    organizationId: orgId,
    businessId: cascade.biz.id,
    customerId: cascade.customer.id,
    now: new Date(),
    items: [{ price: cascade.price.pro, quantity: 1 }],
  });
  await pauseSubscription({
    organizationId: orgId,
    businessId: cascade.biz.id,
    subscriptionId: other.subscription.id,
    now: new Date(),
  });
  const d2 = await disputeOn(cascade);
  await d2.send("dispute.created");
  const [otherRow] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, other.subscription.id)),
  );
  check(
    "cascade: the disputed subscription is cancelled; another paused one is left paused",
    (await cascade.row()).status === "cancelled" && otherRow!.status === "paused",
    `${(await cascade.row()).status} / ${otherRow!.status}`,
  );

  // A weaker pending state does not count as "already there".
  const far = await setup(undefined, {
    chargeback: { on_initiated_subscription: "cancel_immediately" },
  });
  await api("POST", `${far.base}/cancel`, {
    cancel_option: "specific_date",
    cancel_at: new Date(Date.now() + 180 * DAY).toISOString(),
  });
  const dFar = await disputeOn(far);
  await dFar.send("dispute.created");
  check(
    "a cancel scheduled 6 months out does not stop cancel_immediately: cancelled now",
    (await far.row()).status === "cancelled",
    (await far.row()).status,
  );
  const termEnd = await setup(undefined, {
    chargeback: { on_initiated_subscription: "cancel_end_of_term" },
  });
  await api("POST", `${termEnd.base}/cancel`, { cancel_option: "end_of_term" });
  const before = await termEnd.row();
  const dTe = await disputeOn(termEnd);
  await dTe.send("dispute.created");
  const after = await termEnd.row();
  check(
    "a term-end cancel already pending: cancel_end_of_term leaves it as it is",
    after.cancelAtPeriodEnd === true && after.cancelReason === before.cancelReason,
    `${after.cancelAtPeriodEnd} ${after.cancelReason}`,
  );

  // A person's pause scheduled after the term end is overtaken by the policy's, visibly.
  const later = await setup(undefined, {
    chargeback: { on_initiated_subscription: "pause_end_of_term" },
  });
  const scheduled = json(
    await api("POST", `${later.base}/pause`, {
      pause_option: "specific_date",
      pause_date: new Date(Date.now() + 60 * DAY).toISOString(),
    }),
  );
  const dLater = await disputeOn(later);
  await dLater.send("dispute.created");
  const { scheduledChanges, events } = await import("@db/schema");
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        id: scheduledChanges.publicId,
        status: scheduledChanges.status,
        at: scheduledChanges.effectiveAt,
      })
      .from(scheduledChanges)
      .where(
        and(eq(scheduledChanges.subscriptionId, later.sub.id), eq(scheduledChanges.type, "pause")),
      ),
  );
  const removed = await withTenant(orgId, (tx) =>
    tx
      .select({ data: events.data })
      .from(events)
      .where(
        and(
          eq(events.type, "subscription_scheduled_change_removed"),
          eq(events.businessId, later.biz.id),
        ),
      ),
  );
  const personRow = rows.find((r) => r.id === scheduled.scheduled_change);
  check(
    "policy pause at term end: the person's later pause is withdrawn with a removed event",
    personRow?.status === "canceled" &&
      rows.some((r) => r.status === "scheduled") &&
      removed.length === 1,
    JSON.stringify({ rows, removed: removed.length, s: scheduled.scheduled_change }),
  );

  // A person's pause at D with its resume at R; then a policy pause_indefinitely: the resume
  // goes too, so the policy's pause does not end at R.
  const withResume = await setup(undefined, { chargeback: pauseCfg });
  const D = new Date(Date.now() + 10 * DAY);
  const R = new Date(Date.now() + 40 * DAY);
  await api("POST", `${withResume.base}/pause`, {
    pause_option: "specific_date",
    pause_date: D.toISOString(),
    resume_date: R.toISOString(),
  });
  const dR = await disputeOn(withResume);
  await dR.send("dispute.created");
  const left = await withTenant(orgId, (tx) =>
    tx
      .select({ type: scheduledChanges.type, status: scheduledChanges.status })
      .from(scheduledChanges)
      .where(eq(scheduledChanges.subscriptionId, withResume.sub.id)),
  );
  const { applyDueScheduledChanges } = await import("@/modules/subscriptions/scheduled-changes");
  const { runWithClockScope } = await import("@/platform/clock");
  const pastR = new Date(R.getTime() + DAY);
  await runWithClockScope({ onlyBusinessId: withResume.biz.id, now: pastR }, () =>
    applyDueScheduledChanges(pastR),
  );
  const removedEvents = await withTenant(orgId, (tx) =>
    tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.type, "subscription_scheduled_change_removed"),
          eq(events.businessId, withResume.biz.id),
        ),
      ),
  );
  check(
    "policy pause_indefinitely: the person's later pause and its resume are withdrawn, once each; still paused past R",
    !left.some((r) => r.status === "scheduled") &&
      (await withResume.row()).status === "paused" &&
      removedEvents.length === left.filter((r) => r.status === "canceled").length,
    JSON.stringify({ left, events: removedEvents.length, status: (await withResume.row()).status }),
  );
}

// ── A refund still pending at the gateway (every business) ─────────────────────────
{
  const { issueCreditNote, refundCreditNote, creditNoteSpendable } =
    await import("@/modules/credit-notes/service");
  const { handleProviderEvent } = await import("@/modules/webhooks/inbound");
  const { refundChangeCredit } = await import("@/modules/subscriptions/downgrade-credit");
  // The test gateway accepts a refund whose amount ends in 17 and settles it later.
  const pendingCase = async (amount: number, rules?: Record<string, unknown>) => {
    const c = await setup(rules, { start: "pro" });
    const cn = await issueCreditNote({
      organizationId: orgId,
      businessId: c.biz.id,
      invoicePublicId: c.firstInvoice!.publicId,
      creditMethod: "balance",
      items: [{ description: "Goodwill", amountMinor: amount }],
    });
    const note = async () =>
      (
        await withTenant(orgId, (tx) =>
          tx.select().from(creditNotes).where(eq(creditNotes.id, cn.id)),
        )
      )[0]!;
    const refundRow = async () =>
      (
        await withTenant(orgId, (tx) =>
          tx
            .select()
            .from(refunds)
            .innerJoin(payments, eq(payments.id, refunds.paymentId))
            .where(eq(payments.customerId, c.customer.id)),
        )
      ).map((r) => r.refunds);
    const send = async (
      type: "charge.refunded" | "refund.failed",
      r: typeof refunds.$inferSelect,
    ) => {
      const [pay] = await withTenant(orgId, (tx) =>
        tx.select().from(payments).where(eq(payments.id, r.paymentId)),
      );
      return handleProviderEvent(
        "tmtest",
        {
          providerEventId: `evt_${type}_${r.publicId}_${Math.random()}`,
          type,
          providerChargeId: pay!.providerChargeId!,
          providerRefundId: r.providerRefundId!,
          ...(type === "charge.refunded" ? { amountRefundedMinor: r.amountMinor } : {}),
          occurredAt: new Date(),
          raw: {},
        } as NormalizedProviderEvent,
        { businessId: c.biz.id },
      );
    };
    return { c, cn, note, refundRow, send };
  };

  // Operator path: the refund is accepted, then settles.
  const a = await pendingCase(2017);
  let threw = "";
  try {
    await refundCreditNote({
      organizationId: orgId,
      businessId: a.c.biz.id,
      creditNotePublicId: a.cn.publicId,
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  const [ra] = await a.refundRow();
  const afterAccept = await a.note();
  await a.send("charge.refunded", ra!);
  const afterSettle = await a.note();
  check(
    "operator refund, pending then settled: counted as paid, no credit left (it gave both back)",
    threw === "" &&
      ra?.status === "pending" &&
      creditNoteSpendable(afterAccept) === 0n &&
      Number(afterAccept.paidOutMinor) === 2017 &&
      (await a.refundRow())[0]?.status === "succeeded" &&
      creditNoteSpendable(afterSettle) === 0n,
    `threw=${threw} spendable=${creditNoteSpendable(afterAccept)} paid=${afterAccept.paidOutMinor}`,
  );

  // Operator path: accepted, then refused at the rail.
  const b = await pendingCase(1017);
  await refundCreditNote({
    organizationId: orgId,
    businessId: b.c.biz.id,
    creditNotePublicId: b.cn.publicId,
  });
  const [rb] = await b.refundRow();
  await b.send("refund.failed", rb!);
  await b.send("refund.failed", rb!);
  const failedNote = await b.note();
  check(
    "operator refund, pending then failed: the credit comes back once",
    (await b.refundRow())[0]?.status === "failed" &&
      creditNoteSpendable(failedNote) === 1017n &&
      Number(failedNote.paidOutMinor) === 0 &&
      Number(failedNote.refundedMinor) === 0,
    `spendable=${creditNoteSpendable(failedNote)} paid=${failedNote.paidOutMinor} refunded=${failedNote.refundedMinor}`,
  );

  // Downgrade path (`downgrade_credit: refund`): the same two outcomes.
  const d = await pendingCase(2017, { downgrade_credit: "refund" });
  const out = await refundChangeCredit({
    organizationId: orgId,
    businessId: d.c.biz.id,
    creditNotes: [{ publicId: d.cn.publicId }],
  });
  const [rd] = await d.refundRow();
  await d.send("charge.refunded", rd!);
  check(
    "downgrade refund, pending then settled: reported refunded, no credit left",
    out?.[0]?.refundedMinor === 2017 &&
      out[0].keptMinor === 0 &&
      creditNoteSpendable(await d.note()) === 0n &&
      (await d.refundRow())[0]?.status === "succeeded",
    JSON.stringify(out),
  );
  const f = await pendingCase(1017, { downgrade_credit: "refund" });
  await refundChangeCredit({
    organizationId: orgId,
    businessId: f.c.biz.id,
    creditNotes: [{ publicId: f.cn.publicId }],
  });
  const [rf] = await f.refundRow();
  await f.send("refund.failed", rf!);
  check(
    "downgrade refund, pending then failed: the credit comes back once",
    creditNoteSpendable(await f.note()) === 1017n,
    String(creditNoteSpendable(await f.note())),
  );

  // With `declined_refund: issue_credit` (slice F): a failed credit-note payout is given back
  // once, by the note, and no second note is reopened for it.
  const ic = await pendingCase(1017, { declined_refund: "issue_credit" });
  await refundCreditNote({
    organizationId: orgId,
    businessId: ic.c.biz.id,
    creditNotePublicId: ic.cn.publicId,
  });
  const [ri] = await ic.refundRow();
  await ic.send("refund.failed", ri!);
  await ic.send("refund.failed", ri!);
  const { ledgerEntries } = await import("@db/schema");
  const { REFUNDABLE_CREDIT } = await import("@/modules/customers/balances-read");
  const credit = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.customerId, ic.c.customer.id),
            eq(ledgerEntries.account, REFUNDABLE_CREDIT),
          ),
        ),
    )
  ).reduce((t, e) => t + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);
  const reopened = await withTenant(orgId, (tx) =>
    tx
      .select({ id: creditNotes.id })
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.customerId, ic.c.customer.id),
          eq(creditNotes.reasonCode, "refund_declined"),
        ),
      ),
  );
  const icNote = await ic.note();
  check(
    "issue_credit: a credit-note payout pending then failed — credit once, nothing paid out",
    (await ic.refundRow())[0]?.status === "failed" &&
      creditNoteSpendable(icNote) === 1017n &&
      Number(icNote.paidOutMinor) === 0 &&
      credit === 1017n &&
      reopened.length === 0,
    `spendable=${creditNoteSpendable(icNote)} paid=${icNote.paidOutMinor} credit=${credit} reopened=${reopened.length}`,
  );

  // 1c: a payout refund the gateway could not find: flagged for a person, no credit on our own.
  const { reverseRefund } = await import("@/modules/refunds/settlement");
  const nf = await pendingCase(1017);
  await refundCreditNote({
    organizationId: orgId,
    businessId: nf.c.biz.id,
    creditNotePublicId: nf.cn.publicId,
  });
  const [rn] = await nf.refundRow();
  await reverseRefund(rn!, { failureCode: "refund_not_created", onlyPending: true });
  const shown = json(
    await api("GET", `/v1/businesses/${nf.c.biz.publicId}/credit_notes/${nf.cn.publicId}`),
  );
  check(
    "not found at the gateway: the note is flagged and shows it, and no credit is given back",
    shown.payout_unconfirmed_minor === 1017 &&
      creditNoteSpendable(await nf.note()) === 0n &&
      Number((await nf.note()).paidOutMinor) === 1017,
    JSON.stringify({ u: shown.payout_unconfirmed_minor, a: shown.available_minor }),
  );
  const resolve = () =>
    api(
      "POST",
      `/v1/businesses/${nf.c.biz.publicId}/credit_notes/${nf.cn.publicId}/resolve_payout`,
      {
        resolution: "return_as_credit",
      },
    );
  const r1 = await resolve();
  await resolve();
  const resolved = await nf.note();
  // The invariant: the refunds_payable balance equals what the notes still owe.
  const { ledgerEntries: le } = await import("@db/schema");
  const payable = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(le)
        .where(and(eq(le.customerId, nf.c.customer.id), eq(le.account, "refunds_payable"))),
    )
  ).reduce((t, e) => t + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);
  const owed = (
    await withTenant(orgId, (tx) =>
      tx.select().from(creditNotes).where(eq(creditNotes.customerId, nf.c.customer.id)),
    )
  ).reduce((t, n) => t + (n.refundedMinor - n.paidOutMinor), 0n);
  check(
    "operator returns it as credit: once (a second call changes nothing), and the ledger agrees",
    r1.statusCode === 200 &&
      creditNoteSpendable(resolved) === 1017n &&
      Number(resolved.payoutUnconfirmedMinor) === 0 &&
      Number(resolved.paidOutMinor) === 0 &&
      payable === owed &&
      payable === 0n,
    `${r1.statusCode} spendable=${creditNoteSpendable(resolved)} payable=${payable} owed=${owed}`,
  );
  const mp = await pendingCase(1017);
  await refundCreditNote({
    organizationId: orgId,
    businessId: mp.c.biz.id,
    creditNotePublicId: mp.cn.publicId,
  });
  const [rm] = await mp.refundRow();
  await reverseRefund(rm!, { failureCode: "refund_not_created", onlyPending: true });
  const markPaid = await api(
    "POST",
    `/v1/businesses/${mp.c.biz.publicId}/credit_notes/${mp.cn.publicId}/resolve_payout`,
    { resolution: "mark_paid" },
  );
  const paidNote = await mp.note();
  const payable2 = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(le)
        .where(and(eq(le.customerId, mp.c.customer.id), eq(le.account, "refunds_payable"))),
    )
  ).reduce((t, e) => t + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);
  check(
    "operator marks it paid: stays paid out, no credit, refunds_payable back to 0",
    markPaid.statusCode === 200 &&
      creditNoteSpendable(paidNote) === 0n &&
      Number(paidNote.payoutUnconfirmedMinor) === 0 &&
      payable2 === 0n &&
      (await mp.refundRow())[0]?.status === "succeeded",
    `${markPaid.statusCode} payable=${payable2}`,
  );

  // Two unconfirmed refunds on one note: a late failure resolves only its own amount, and
  // mark paid makes the other count as cash that left.
  const { refundableCapacityForInvoice } = await import("@/modules/credit-notes/service");
  const two = await pendingCase(2034);
  for (let k = 0; k < 2; k++)
    await refundCreditNote({
      organizationId: orgId,
      businessId: two.c.biz.id,
      creditNotePublicId: two.cn.publicId,
      amountMinor: 1017,
    });
  const twoRows = await two.refundRow();
  for (const r of twoRows)
    await reverseRefund(r, { failureCode: "refund_not_created", onlyPending: true });
  const flagged = Number((await two.note()).payoutUnconfirmedMinor);
  await two.send("refund.failed", twoRows[0]!);
  const afterLateFail = await two.note();
  check(
    "late failure on one of two: subtracts its own 1017 from the flag and returns it as credit",
    flagged === 2034 &&
      Number(afterLateFail.payoutUnconfirmedMinor) === 1017 &&
      creditNoteSpendable(afterLateFail) === 1017n,
    `flagged=${flagged} left=${afterLateFail.payoutUnconfirmedMinor} spendable=${creditNoteSpendable(afterLateFail)}`,
  );
  await api(
    "POST",
    `/v1/businesses/${two.c.biz.publicId}/credit_notes/${two.cn.publicId}/resolve_payout`,
    {
      resolution: "mark_paid",
    },
  );
  const cap = await withTenant(orgId, (tx) =>
    refundableCapacityForInvoice(tx, two.c.firstInvoice!.id),
  );
  check(
    "mark paid: the refund is succeeded and the invoice's capacity counts the 1017 that left",
    Number(cap.refundedMinor) === 1017 &&
      (await two.refundRow()).filter((r) => r.status === "succeeded").length === 1 &&
      Number((await two.note()).payoutUnconfirmedMinor) === 0,
    `refunded=${cap.refundedMinor} available=${cap.available}`,
  );

  // A late gateway success while still unresolved settles it as paid.
  const ls = await pendingCase(1017);
  await refundCreditNote({
    organizationId: orgId,
    businessId: ls.c.biz.id,
    creditNotePublicId: ls.cn.publicId,
  });
  const [rls] = await ls.refundRow();
  await reverseRefund(rls!, { failureCode: "refund_not_created", onlyPending: true });
  await ls.send("charge.refunded", rls!);
  const lsNote = await ls.note();
  check(
    "late success while unresolved: settled as paid, no credit, flag cleared",
    (await ls.refundRow())[0]?.status === "succeeded" &&
      Number(lsNote.payoutUnconfirmedMinor) === 0 &&
      creditNoteSpendable(lsNote) === 0n,
    `${(await ls.refundRow())[0]?.status} flag=${lsNote.payoutUnconfirmedMinor}`,
  );

  // A late gateway success after a person returned it as credit: flagged, credit kept.
  const dup = await pendingCase(1017);
  await refundCreditNote({
    organizationId: orgId,
    businessId: dup.c.biz.id,
    creditNotePublicId: dup.cn.publicId,
  });
  const [rd2] = await dup.refundRow();
  await reverseRefund(rd2!, { failureCode: "refund_not_created", onlyPending: true });
  await api(
    "POST",
    `/v1/businesses/${dup.c.biz.publicId}/credit_notes/${dup.cn.publicId}/resolve_payout`,
    {
      resolution: "return_as_credit",
    },
  );
  await dup.send("charge.refunded", rd2!);
  const dupShown = json(
    await api("GET", `/v1/businesses/${dup.c.biz.publicId}/credit_notes/${dup.cn.publicId}`),
  );
  check(
    "late success after return as credit: flagged as paid twice, and the credit is kept",
    dupShown.payout_duplicated_minor === 1017 && dupShown.available_minor === 1017,
    JSON.stringify({ d: dupShown.payout_duplicated_minor, a: dupShown.available_minor }),
  );
  // 3c: that payout then bounces: the cash posting is reversed and the alert cleared.
  await dup.send("refund.failed", rd2!);
  const bounced = json(
    await api("GET", `/v1/businesses/${dup.c.biz.publicId}/credit_notes/${dup.cn.publicId}`),
  );
  const dupPayable = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(le)
        .where(and(eq(le.customerId, dup.c.customer.id), eq(le.account, "refunds_payable"))),
    )
  ).reduce((t, e) => t + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);
  check(
    "paid twice, then the payout bounces: duplicate cleared, credit kept, refunds_payable 0",
    bounced.payout_duplicated_minor === 0 &&
      bounced.available_minor === 1017 &&
      dupPayable === 0n &&
      (await dup.refundRow())[0]?.status === "failed",
    JSON.stringify({
      d: bounced.payout_duplicated_minor,
      a: bounced.available_minor,
      p: String(dupPayable),
    }),
  );

  // 3b: the gateway reported it failed (credit returned), then paid: out of order, not twice.
  const oo = await pendingCase(1017);
  await refundCreditNote({
    organizationId: orgId,
    businessId: oo.c.biz.id,
    creditNotePublicId: oo.cn.publicId,
  });
  const [roo] = await oo.refundRow();
  await reverseRefund(roo!, { failureCode: "refund_not_created", onlyPending: true });
  await oo.send("refund.failed", roo!);
  await oo.send("charge.refunded", roo!);
  const ooShown = json(
    await api("GET", `/v1/businesses/${oo.c.biz.publicId}/credit_notes/${oo.cn.publicId}`),
  );
  check(
    "gateway failure, then gateway success: booked paid, flagged out of order (not paid twice)",
    ooShown.payout_out_of_order_minor === 1017 &&
      ooShown.payout_duplicated_minor === 0 &&
      (await oo.refundRow())[0]?.status === "succeeded",
    JSON.stringify({ o: ooShown.payout_out_of_order_minor, d: ooShown.payout_duplicated_minor }),
  );

  // 3a: the webhook settles first; the not-found sweep after it leaves the refund alone.
  const ws = await pendingCase(1017);
  await refundCreditNote({
    organizationId: orgId,
    businessId: ws.c.biz.id,
    creditNotePublicId: ws.cn.publicId,
  });
  const [rws] = await ws.refundRow();
  await ws.send("charge.refunded", rws!);
  const swept = await reverseRefund(rws!, { failureCode: "refund_not_created", onlyPending: true });
  const [after] = await ws.refundRow();
  const reversals = await withTenant(orgId, (tx) =>
    tx
      .select({ id: le.id })
      .from(le)
      .where(and(eq(le.sourceType, "refund_reversal"), eq(le.sourceId, rws!.publicId))),
  );
  check(
    "settled by the webhook, then the sweep: still succeeded, not flagged, no cash reversed",
    swept === false &&
      after?.status === "succeeded" &&
      after?.notFoundState == null &&
      reversals.length === 0 &&
      Number((await ws.note()).payoutUnconfirmedMinor) === 0,
    JSON.stringify({
      swept,
      status: after?.status,
      state: after?.notFoundState,
      rev: reversals.length,
    }),
  );

  // Failure after the operator marked it paid: the normal reversal gives the credit back once.
  const fp = await pendingCase(1017);
  await refundCreditNote({
    organizationId: orgId,
    businessId: fp.c.biz.id,
    creditNotePublicId: fp.cn.publicId,
  });
  const [rfp] = await fp.refundRow();
  await reverseRefund(rfp!, { failureCode: "refund_not_created", onlyPending: true });
  await api(
    "POST",
    `/v1/businesses/${fp.c.biz.publicId}/credit_notes/${fp.cn.publicId}/resolve_payout`,
    {
      resolution: "mark_paid",
    },
  );
  await fp.send("refund.failed", rfp!);
  await fp.send("refund.failed", rfp!);
  const fpNote = await fp.note();
  const fpPayable = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(le)
        .where(and(eq(le.customerId, fp.c.customer.id), eq(le.account, "refunds_payable"))),
    )
  ).reduce((t, e) => t + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);
  check(
    "failure after mark paid: refund failed, credit back once, refunds_payable 0",
    (await fp.refundRow())[0]?.status === "failed" &&
      creditNoteSpendable(fpNote) === 1017n &&
      Number(fpNote.paidOutMinor) === 0 &&
      fpPayable === 0n,
    `${(await fp.refundRow())[0]?.status} spendable=${creditNoteSpendable(fpNote)} payable=${fpPayable}`,
  );

  // Failure after the operator returned it as credit: nothing more.
  const fc = await pendingCase(1017);
  await refundCreditNote({
    organizationId: orgId,
    businessId: fc.c.biz.id,
    creditNotePublicId: fc.cn.publicId,
  });
  const [rfc] = await fc.refundRow();
  await reverseRefund(rfc!, { failureCode: "refund_not_created", onlyPending: true });
  await api(
    "POST",
    `/v1/businesses/${fc.c.biz.publicId}/credit_notes/${fc.cn.publicId}/resolve_payout`,
    {
      resolution: "return_as_credit",
    },
  );
  await fc.send("refund.failed", rfc!);
  check(
    "failure after return as credit: no second credit",
    creditNoteSpendable(await fc.note()) === 1017n,
    String(creditNoteSpendable(await fc.note())),
  );

  // Success after the sweep flipped a pending refund to not found: settled as paid.
  const sf = await pendingCase(1017);
  await refundCreditNote({
    organizationId: orgId,
    businessId: sf.c.biz.id,
    creditNotePublicId: sf.cn.publicId,
  });
  const [rsf] = await sf.refundRow();
  // The webhook read the row while pending; the sweep flips it before the webhook acts.
  const stalePendingView = { ...rsf! };
  await reverseRefund(rsf!, { failureCode: "refund_not_created", onlyPending: true });
  await sf.send("charge.refunded", stalePendingView);
  const sfNote = await sf.note();
  check(
    "success after the sweep's not-found flip: settled as paid, no credit, flag cleared",
    (await sf.refundRow())[0]?.status === "succeeded" &&
      Number(sfNote.payoutUnconfirmedMinor) === 0 &&
      creditNoteSpendable(sfNote) === 0n,
    `${(await sf.refundRow())[0]?.status} flag=${sfNote.payoutUnconfirmedMinor}`,
  );
}

await app.close();
await closeDb();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const [n] of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
process.exit(0);
