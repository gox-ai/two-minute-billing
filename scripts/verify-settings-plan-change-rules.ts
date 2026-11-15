/**
 * verify:settings-plan-change-rules — proration, gate and timing for plan changes
 * (`billing_rules_config.upgrade_* / downgrade_*`), per direction.
 *
 * Every option of every setting, through the API (`/estimate`, `/change`, `/schedule`)
 * and the customer portal; the billing-period rule; in-trial changes apply now; the
 * estimate and the apply agree on proration and invoicing; and an unset business behaves
 * as before.
 *
 *   pnpm verify:settings-plan-change-rules
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { applyCouponToSubscription, createCoupon } from "@/modules/coupons/service";
import { configureIndiaGst } from "@/modules/tax/service";
import { issueRefundableCreditNote } from "@/modules/credit-notes/service";
import { PAST_DUE_DOWNGRADE_MESSAGE } from "@/modules/subscriptions/proration";
import { loadGeoReference } from "@/platform/geo";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, createInvoiceFromLines } from "@/modules/invoicing/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import { directionOfItemEdit, resolveChangePolicy } from "@/modules/subscriptions/change-policy";
import { setDifferentialPrice } from "@/modules/catalog/service";
import { editSubscriptionFromHubSpot } from "@/modules/hubspot/app/subscribe";
import {
  completeCheckout,
  createCheckoutSession,
  getCheckoutView,
  resolveCheckoutSession,
} from "@/modules/checkout/service";
import { timingRulesFromForm } from "../dashboard/lib/billing-rules";
import {
  changeEditKey,
  policyReady,
  portalNowHint,
  prorateToSend,
} from "../dashboard/lib/change-policy-view";
import { applyDueScheduledChanges } from "@/modules/subscriptions/scheduled-changes";
import { renewSubscription } from "@/modules/subscriptions/renewal";
import { initialBillingRulesConfig } from "@/modules/subscriptions/billing-rules-config";
import {
  businesses,
  creditNotes,
  invoices,
  paymentMethods,
  scheduledChanges,
  subscriptionItems,
  unbilledCharges,
} from "@db/schema";
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

const app = await buildApp({ logger: false });
await clearPublicRateLimits();
const org = await createOrganization({ name: "Plan Change Rules Co" });
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

type Plan = "basic" | "pro" | "basicYear";

/** What a change moved: its invoice less the credit note it raised (the estimate's total). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const net = (r: any) => (r.proration_invoice?.total_minor ?? 0) - (r.credit_note?.total_minor ?? 0);

/** A business with the given rules, three plans, and one paid subscription on `start`. */
async function setup(
  rules?: Record<string, unknown>,
  opts: { start?: Plan; trial?: boolean; unpaid?: boolean } = {},
) {
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Rules",
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
      },
      defaultInvoiceImmediately: true,
    })
    .where(eq(businesses.id, biz.id));
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Plan",
    kind: "plan",
    enabledInPortal: true,
  });
  const mk = (amountMinor: number, interval: "month" | "year", trial = false) =>
    createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: product.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval,
      ...(trial ? { trialPeriod: 14, trialPeriodUnit: "day" as const } : {}),
    });
  const price: Record<Plan, Awaited<ReturnType<typeof mk>>> = {
    basic: await mk(1000, "month", opts.trial),
    pro: await mk(3000, "month"),
    // 5000 a year is less per month than 1000 a month: the period rule still makes it an upgrade.
    basicYear: await mk(5000, "year"),
  };
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `r${Math.random().toString(36).slice(2)}@example.com`,
  });
  // `unpaid`: no payment method, so the term invoice stays open.
  const pm = opts.unpaid
    ? null
    : await vaultPaymentMethod({
        organizationId: orgId,
        businessId: biz.id,
        customer,
        token: "tok_4242",
      });
  const created = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: price[opts.start ?? "basic"], quantity: 1 }],
    ...(pm ? { defaultPaymentMethodId: pm.id } : {}),
    ...(opts.trial ? { trialDays: 14 } : {}),
  });
  const sub = created.subscription;
  // Bill and collect the first term, so a change has a paid term to credit against.
  if (!opts.trial)
    await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: sub,
      periodStart: sub.currentPeriodStart!,
      periodEnd: sub.currentPeriodEnd!,
    });
  const item = created.items[0]!.publicId;
  const base = `/v1/businesses/${biz.publicId}/subscriptions/${sub.publicId}`;
  const edit = (to: Plan) => ({ changes: [{ item, price: price[to].publicId }] });
  return {
    biz,
    price,
    customer,
    sub,
    item,
    estimate: (to: Plan, extra: object = {}) =>
      api("POST", `${base}/estimate`, { ...edit(to), ...extra }),
    change: (to: Plan, extra: object = {}) =>
      api("POST", `${base}/change`, { ...edit(to), ...extra }),
    schedule: (to: Plan) =>
      api("POST", `${base}/schedule`, {
        type: "change",
        effective_at: new Date(sub.currentPeriodEnd!.getTime() - 3_600_000).toISOString(),
        ...edit(to),
      }),
    planPrice: async () =>
      (
        await withTenant(orgId, (tx) =>
          tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id)),
        )
      )[0]!.priceId,
    /** An open invoice the customer has not paid. */
    owe: async () => {
      const { invoice } = await createInvoiceFromLines({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        currency: "USD",
        lines: [{ description: "Setup fee", amountMinor: 1500n, kind: "one_time" }],
        collect: false,
      });
      return invoice;
    },
    policy: async (
      direction: "upgrade" | "downgrade",
      source: "portal" | "dashboard" | "api" | "scheduled",
    ) => {
      const [row] = await withTenant(orgId, (tx) =>
        tx.select().from(businesses).where(eq(businesses.id, biz.id)),
      );
      return resolveChangePolicy({ business: row!, subscription: sub, direction, source });
    },
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

// ── Storage: API read, PATCH, new-business defaults ───────────────────────────────
{
  const created = json(
    await api("POST", "/v1/businesses", { default_currency: "USD", name: "Key-made" }),
  );
  const r = created.billing_rules_config;
  check(
    "a key-created business reads today's rules (prorated, no gate, timing not saved)",
    r?.upgrade_proration === "prorated" &&
      r?.downgrade_proration === "prorated" &&
      r?.upgrade_gate === "off" &&
      r?.downgrade_gate === "off" &&
      r?.upgrade_timing === null &&
      r?.downgrade_timing === null,
    JSON.stringify(r),
  );
  const p = json(
    await api("PATCH", `/v1/businesses/${created.id}`, {
      billing_rules_config: {
        upgrade_proration: "none",
        downgrade_gate: "invoices_paid",
        upgrade_timing: "customer_chooses",
      },
    }),
  ).billing_rules_config;
  check(
    "PATCH stores each plan-change key",
    p?.upgrade_proration === "none" &&
      p?.downgrade_gate === "invoices_paid" &&
      p?.upgrade_timing === "customer_chooses",
    JSON.stringify(p),
  );
  const cleared = json(
    await api("PATCH", `/v1/businesses/${created.id}`, {
      billing_rules_config: { upgrade_timing: null },
    }),
  ).billing_rules_config;
  check("timing null → not saved again", cleared?.upgrade_timing === null);
  const bad = await api("PATCH", `/v1/businesses/${created.id}`, {
    billing_rules_config: { upgrade_proration: "full" },
  });
  check("an option we do not offer (full) → 400", bad.statusCode === 400);
  const fresh = initialBillingRulesConfig({ hasOperator: true }) as Record<string, unknown>;
  check(
    "a person's new business: prorated/prorated, upgrade needs paid invoices, upgrade now, downgrade at term end",
    fresh.upgrade_proration === "prorated" &&
      fresh.downgrade_proration === "prorated" &&
      fresh.upgrade_gate === "invoices_paid" &&
      fresh.downgrade_gate === "off" &&
      fresh.upgrade_timing === "now" &&
      fresh.downgrade_timing === "end_of_term",
  );
}

// ── Credit and allowance resets (design-G3b § 6): storage only, the engine is G3b's suite ──
{
  const created = json(
    await api("POST", "/v1/businesses", { default_currency: "USD", name: "Reset rules" }),
  );
  const r = created.billing_rules_config;
  check(
    "resets: a new business reads the recommended options",
    JSON.stringify(r?.plan_credits) ===
      JSON.stringify({
        on_upgrade: "full",
        on_downgrade: "next_window",
        first_window: "full",
        on_pause: "skip",
        on_cancel_at_period_end: "grant_started_window",
        grant_when: "invoice_issued",
        on_unpaid_cancel: "keep",
      }) && r?.allowances?.on_upgrade === "new_window",
    JSON.stringify({ pc: r?.plan_credits, al: r?.allowances }),
  );
  const options: Array<[string, string[]]> = [
    ["on_upgrade", ["prorated", "next_window", "full"]],
    ["on_downgrade", ["full", "prorated", "next_window"]],
    ["first_window", ["prorated", "next_full_window", "full"]],
    ["on_pause", ["keep_granting", "shift", "skip"]],
    ["on_cancel_at_period_end", ["stop_at_request", "grant_started_window"]],
    ["grant_when", ["invoice_paid", "invoice_issued"]],
    ["on_unpaid_cancel", ["void_unused", "keep"]],
  ];
  for (const [key, values] of options)
    for (const v of values) {
      const got = json(
        await api("PATCH", `/v1/businesses/${created.id}`, {
          billing_rules_config: { plan_credits: { [key]: v } },
        }),
      ).billing_rules_config?.plan_credits;
      check(`resets: plan_credits.${key}=${v} is stored`, got?.[key] === v, JSON.stringify(got));
    }
  for (const v of ["keep_used", "prorated", "new_window"]) {
    const got = json(
      await api("PATCH", `/v1/businesses/${created.id}`, {
        billing_rules_config: { allowances: { on_upgrade: v } },
      }),
    ).billing_rules_config?.allowances;
    check(`resets: allowances.on_upgrade=${v} is stored`, got?.on_upgrade === v);
  }
  json(
    await api("PATCH", `/v1/businesses/${created.id}`, {
      billing_rules_config: { plan_credits: { on_pause: "shift", on_upgrade: "prorated" } },
    }),
  );
  const partial = json(
    await api("PATCH", `/v1/businesses/${created.id}`, {
      billing_rules_config: { plan_credits: { on_upgrade: "next_window" } },
    }),
  ).billing_rules_config?.plan_credits;
  check(
    "resets: a PATCH of one plan_credits key keeps the others",
    partial?.on_upgrade === "next_window" && partial?.on_pause === "shift",
    JSON.stringify(partial),
  );
  const other = json(
    await api("PATCH", `/v1/businesses/${created.id}`, {
      billing_rules_config: { upgrade_proration: "none" },
    }),
  ).billing_rules_config;
  check(
    "resets: a PATCH of another billing rule keeps plan_credits",
    other?.plan_credits?.on_pause === "shift" && other?.upgrade_proration === "none",
  );
  for (const [body, label] of [
    [{ plan_credits: { on_downgrade: "customer_chooses" } }, "on_downgrade=customer_chooses"],
    [{ plan_credits: { on_pause: "customer_chooses" } }, "on_pause=customer_chooses"],
    [{ allowances: { on_upgrade: "full" } }, "allowances.on_upgrade=full"],
  ] as const) {
    const bad = await api("PATCH", `/v1/businesses/${created.id}`, { billing_rules_config: body });
    check(`resets: an option we do not offer (${label}) → 400`, bad.statusCode === 400);
  }
  const reset = json(
    await api("PATCH", `/v1/businesses/${created.id}`, { billing_rules_config: null }),
  ).billing_rules_config;
  check(
    "resets: billing_rules_config null → the recommended options again",
    reset?.plan_credits?.on_pause === "skip" && reset?.allowances?.on_upgrade === "new_window",
  );
}

// ── 2.3 Proration per direction ────────────────────────────────────────────────────
{
  // Unset = today: an upgrade prorates and invoices.
  const u = await setup();
  const est = json(await u.estimate("pro"));
  const res = json(await u.change("pro", { invoice_immediately: true }));
  check(
    "unset: an upgrade prorates (estimate and apply)",
    est.change_policy?.prorate === true &&
      est.change_policy?.direction === "upgrade" &&
      est.total_minor > 0 &&
      net(res) === est.total_minor,
    `est=${est.total_minor} inv=${res.proration_invoice?.total_minor}`,
  );

  for (const opt of ["prorated", "none"] as const) {
    const c = await setup({ upgrade_proration: opt });
    const e = json(await c.estimate("pro"));
    const r = json(await c.change("pro", { invoice_immediately: true }));
    check(
      `upgrade_proration=${opt}: estimate and apply agree`,
      e.change_policy?.prorate === (opt === "prorated") &&
        (opt === "prorated"
          ? e.total_minor > 0 && net(r) === e.total_minor
          : e.total_minor === 0 && r.proration_invoice === null) &&
        (await c.planPrice()) === c.price.pro.id,
      `est=${e.total_minor} inv=${JSON.stringify(r.proration_invoice)} status=${r.error?.message ?? ""}`,
    );
  }
  for (const opt of ["prorated", "none"] as const) {
    const c = await setup({ downgrade_proration: opt, downgrade_timing: "now" }, { start: "pro" });
    const e = json(await c.estimate("basic"));
    const r = json(await c.change("basic", { invoice_immediately: true }));
    check(
      `downgrade_proration=${opt}: estimate and apply agree`,
      e.change_policy?.direction === "downgrade" &&
        e.change_policy?.prorate === (opt === "prorated") &&
        (opt === "prorated" ? !!r.credit_note?.id : r.credit_note === null) &&
        (await c.planPrice()) === c.price.basic.id,
      `credit=${JSON.stringify(r.credit_note)} est=${e.total_minor}`,
    );
  }
  // The call's own prorate wins, in both directions.
  const none = await setup({ upgrade_proration: "none" });
  const forced = json(await none.estimate("pro", { prorate: true }));
  check("prorate: true on the call wins over upgrade_proration=none", forced.total_minor > 0);
  const on = await setup({ downgrade_proration: "prorated" }, { start: "pro" });
  const off = json(await on.change("basic", { prorate: false, invoice_immediately: true }));
  check(
    "prorate: false on the call wins over downgrade_proration=prorated",
    off.credit_note === null,
  );

  // The period rule: monthly → yearly is an upgrade although the monthly amount falls.
  const period = await setup({ upgrade_proration: "none", downgrade_proration: "prorated" });
  const toYear = json(await period.estimate("basicYear"));
  check(
    "monthly → yearly (lower monthly amount) counts as an upgrade",
    toYear.change_policy?.direction === "upgrade" && toYear.change_policy?.prorate === false,
    JSON.stringify(toYear.change_policy),
  );
  const yearly = await setup({}, { start: "basicYear" });
  const toMonth = json(await yearly.estimate("basic"));
  check(
    "yearly → monthly (higher monthly amount) counts as a downgrade",
    toMonth.change_policy?.direction === "downgrade",
  );

  // invoice_immediately: resolved once, the same answer in the estimate and the apply.
  const deferred = await setup();
  await systemDb
    .update(businesses)
    .set({ defaultInvoiceImmediately: false })
    .where(eq(businesses.id, deferred.biz.id));
  const de = json(await deferred.estimate("pro"));
  const dr = json(await deferred.change("pro"));
  check(
    "invoice_immediately: the estimate states the rule the apply then uses",
    de.change_policy?.invoice_immediately === false &&
      dr.proration_invoice === null &&
      (dr.unbilled_charges?.length ?? 0) > 0,
    JSON.stringify({ p: de.change_policy, inv: dr.proration_invoice }),
  );

  // A net credit is never queued: under the deferring rule an existing (unset) business
  // books one credit note now and no unbilled charge.
  const credit = await setup({ downgrade_timing: "now" }, { start: "pro" });
  await systemDb
    .update(businesses)
    .set({ defaultInvoiceImmediately: false })
    .where(eq(businesses.id, credit.biz.id));
  const ce = json(await credit.estimate("basic"));
  const cr = json(await credit.change("basic"));
  check(
    "a net-credit downgrade under the deferring rule books a credit note and no unbilled charge",
    ce.change_policy?.invoice_immediately === false &&
      ce.change_policy?.net_credit_documents === null &&
      ce.total_minor < 0 &&
      !!cr.credit_note?.id &&
      cr.proration_invoice === null &&
      (cr.unbilled_charges?.length ?? 0) === 0,
    JSON.stringify({ p: ce.change_policy, total: ce.total_minor, cr }),
  );
  // The preview default (what the change form preselects) resolves `on_change` first.
  const over = await setup();
  await systemDb
    .update(businesses)
    .set({
      defaultInvoiceImmediately: false,
      unbilledChargesConfig: { on_change: "invoice_immediately" },
    })
    .where(eq(businesses.id, over.biz.id));
  const oe = json(await over.estimate("pro"));
  const or = json(await over.change("pro"));
  check(
    "the estimate's invoice_immediately follows unbilled_charges_config.on_change",
    oe.change_policy?.invoice_immediately === true &&
      !!or.proration_invoice?.id &&
      (or.unbilled_charges?.length ?? 0) === 0,
    JSON.stringify({ p: oe.change_policy, inv: or.proration_invoice?.id }),
  );
}

// ── Net-credit documents (`net_credit_documents`, 2026-11-13) ─────────────────────────
// Unset (an existing business) keeps one credit note; a business a person creates stores
// two documents; any business opts in by PATCH; one call overrides either way.
{
  const TWO = { downgrade_timing: "now", net_credit_documents: "credit_note_and_invoice" };
  const changeNotes = async (c: Ctx) =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(creditNotes)
        .where(
          and(
            eq(creditNotes.customerId, c.customer.id),
            eq(creditNotes.reasonCode, "subscription_change"),
          ),
        ),
    );
  const invoiceRow = async (publicId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.publicId, publicId)),
      )
    )[0]!;
  /** What the change booked, in the estimate's `documents` terms. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const booked = async (c: Ctx, r: any) => {
    const notes = await changeNotes(c);
    const sum = (kind: string) =>
      notes.filter((n) => n.kind === kind).reduce((t, n) => t + Number(n.totalMinor), 0);
    const inv = r.proration_invoice?.id ? await invoiceRow(r.proration_invoice.id) : null;
    return {
      adjustment: sum("adjustment"),
      refundable: sum("refundable"),
      invoice: inv ? Number(inv.totalMinor) : 0,
      inv,
      notes,
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const previewed = (e: any) => {
    const docs: Array<{ type: string; kind?: string; total_minor: number }> = e.documents ?? [];
    const sum = (type: string, kind?: string) =>
      docs
        .filter((d) => d.type === type && (kind ? d.kind === kind : true))
        .reduce((t, d) => t + d.total_minor, 0);
    return {
      adjustment: sum("credit_note", "adjustment"),
      refundable: sum("credit_note", "refundable"),
      invoice: sum("invoice"),
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parity = async (name: string, c: Ctx, e: any, r: any) => {
    const b = await booked(c, r);
    const p = previewed(e);
    check(
      `${name}: the estimate lists the documents the change books`,
      p.adjustment === b.adjustment && p.refundable === b.refundable && p.invoice === b.invoice,
      JSON.stringify({
        previewed: p,
        booked: { ...b, inv: undefined, notes: undefined },
        docs: e.documents,
      }),
    );
    return b;
  };

  // An existing business (unset) keeps the rule before 2026-11-13: one credit note unless
  // the change is invoiced immediately; the estimate prices the same documents.
  const legacy = await setup({ downgrade_timing: "now" }, { start: "pro" });
  await systemDb
    .update(businesses)
    .set({ defaultInvoiceImmediately: false })
    .where(eq(businesses.id, legacy.biz.id));
  const le = json(await legacy.estimate("basic"));
  const lr = json(await legacy.change("basic"));
  check(
    "unset net_credit_documents, not invoiced now: one credit note, no invoice (unchanged)",
    le.change_policy?.net_credit_documents === null &&
      !!lr.credit_note?.id &&
      lr.proration_invoice === null &&
      le.lines?.length === 1,
    JSON.stringify({ le: le.change_policy, lr }),
  );
  await parity("unset, not invoiced now", legacy, le, lr);
  const legacyNow = await setup({ downgrade_timing: "now" }, { start: "pro" });
  const lne = json(await legacyNow.estimate("basic"));
  const lnr = json(await legacyNow.change("basic"));
  check(
    "unset net_credit_documents, invoiced now: a credit note and an invoice (unchanged)",
    lne.change_policy?.invoice_immediately === true &&
      !!lnr.credit_note?.id &&
      !!lnr.proration_invoice?.id,
    JSON.stringify({ lne: lne.change_policy, lnr }),
  );
  await parity("unset, invoiced now", legacyNow, lne, lnr);
  const legacyRead = json(await api("GET", `/v1/businesses/${legacy.biz.publicId}`));
  check(
    "an unset business reads net_credit_documents null (not saved)",
    legacyRead.billing_rules_config?.net_credit_documents === null,
    JSON.stringify(legacyRead.billing_rules_config?.net_credit_documents),
  );

  // A business a person creates stores two documents.
  const fresh = initialBillingRulesConfig({ hasOperator: true }) as Record<string, unknown>;
  check(
    "a person's new business stores net_credit_documents credit_note_and_invoice",
    fresh.net_credit_documents === "credit_note_and_invoice",
  );
  const newBiz = await setup({ ...fresh, downgrade_timing: "now" }, { start: "pro" });
  const ne = json(await newBiz.estimate("basic"));
  const nr = json(await newBiz.change("basic", { invoice_immediately: false }));
  const nb = await parity("new business, paid term", newBiz, ne, nr);
  check(
    "new business, paid term: a refundable note and a paid invoice that draws it",
    nb.refundable > 0 &&
      nb.adjustment === 0 &&
      nb.inv?.status === "paid" &&
      nb.notes[0]?.allocatedMinor === nb.inv.totalMinor &&
      (nr.unbilled_charges?.length ?? 0) === 0,
    JSON.stringify({ nr, nb: { ...nb, inv: nb.inv?.status, notes: undefined } }),
  );

  // Opt in by PATCH: the same business moves to two documents.
  const optIn = await setup({ downgrade_timing: "now" }, { start: "pro" });
  const patched = json(
    await api("PATCH", `/v1/businesses/${optIn.biz.publicId}`, {
      billing_rules_config: { net_credit_documents: "credit_note_and_invoice" },
    }),
  ).billing_rules_config;
  const oe = json(await optIn.estimate("basic"));
  const or = json(await optIn.change("basic"));
  check(
    "opt-in by PATCH: stored, previewed and booked as a credit note and an invoice",
    patched?.net_credit_documents === "credit_note_and_invoice" &&
      oe.change_policy?.net_credit_documents === "credit_note_and_invoice" &&
      !!or.credit_note?.id &&
      !!or.proration_invoice?.id,
    JSON.stringify({ patched: patched?.net_credit_documents, or }),
  );
  await parity("opt-in", optIn, oe, or);
  check(
    "both shapes leave the customer the same net credit",
    net(or) === net(lr),
    `${net(or)} vs ${net(lr)}`,
  );
  const badDocs = await api("PATCH", `/v1/businesses/${optIn.biz.publicId}`, {
    billing_rules_config: { net_credit_documents: "netted" },
  });
  check("net_credit_documents outside its options → 400", badDocs.statusCode === 400);

  // One call overrides the rule, both ways.
  const callTwo = await setup({ downgrade_timing: "now" }, { start: "pro" });
  const cte = json(
    await callTwo.estimate("basic", { net_credit_documents: "credit_note_and_invoice" }),
  );
  const ctr = json(
    await callTwo.change("basic", { net_credit_documents: "credit_note_and_invoice" }),
  );
  check(
    "per call credit_note_and_invoice on an unset business: two documents",
    !!ctr.credit_note?.id && !!ctr.proration_invoice?.id,
    JSON.stringify(ctr),
  );
  await parity("per call two", callTwo, cte, ctr);
  const callOne = await setup(TWO, { start: "pro" });
  const coe = json(await callOne.estimate("basic", { net_credit_documents: "one_credit_note" }));
  const cor = json(await callOne.change("basic", { net_credit_documents: "one_credit_note" }));
  check(
    "per call one_credit_note on a two-document business: one note, no invoice",
    !!cor.credit_note?.id && cor.proration_invoice === null && coe.lines?.length === 1,
    JSON.stringify(cor),
  );
  await parity("per call one", callOne, coe, cor);
  const scheduled = await callOne.change("pro", {
    timing: "end_of_term",
    net_credit_documents: "one_credit_note",
  });
  check(
    "a change at the end of the term cannot carry net_credit_documents (400)",
    scheduled.statusCode === 400 && /net_credit_documents/.test(scheduled.payload),
    scheduled.payload.slice(0, 200),
  );

  // Paid term, `downgrade_credit: refund`: the invoice takes its share, the rest goes back.
  const refund = await setup({ ...TWO, downgrade_credit: "refund" }, { start: "pro" });
  const rr = json(await refund.change("basic"));
  check(
    "paid term, downgrade_credit refund: the invoice takes its share, the rest is refunded",
    !!rr.proration_invoice?.id &&
      rr.credit_refunds?.[0]?.refunded_minor ===
        rr.credit_note?.total_minor - rr.proration_invoice?.total_minor,
    JSON.stringify(rr),
  );

  // Unpaid term: an adjustment on the term invoice; the new invoice is due.
  const unpaid = await setup(TWO, { start: "pro", unpaid: true });
  const [termInv] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, unpaid.sub.id)),
  );
  const ue = json(await unpaid.estimate("basic"));
  const ur = json(await unpaid.change("basic"));
  const ub = await parity("unpaid term", unpaid, ue, ur);
  check(
    "unpaid term: an adjustment note on the term invoice and an open invoice for the new plan",
    termInv?.status === "payment_due" &&
      ub.adjustment > 0 &&
      ub.refundable === 0 &&
      ub.notes.every((n) => n.invoiceId === termInv.id) &&
      ub.inv?.status === "payment_due",
    JSON.stringify({
      ur,
      term: termInv?.status,
      ub: { ...ub, inv: ub.inv?.status, notes: undefined },
    }),
  );

  // Partly paid term: an adjustment for what is owed and a refundable note for what was paid.
  const partly = await setup(TWO, { start: "pro", unpaid: true });
  const [partInv] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, partly.sub.id)),
  );
  const paidPart = await api(
    "POST",
    `/v1/businesses/${partly.biz.publicId}/invoices/${partInv!.publicId}/pay`,
    {
      amount_minor: 1000,
      method: "cash",
    },
  );
  const pe = json(await partly.estimate("basic"));
  const pr = json(await partly.change("basic"));
  const pb = await parity("partly paid term", partly, pe, pr);
  check(
    "partly paid term: an adjustment and a refundable note, and the new invoice draws the refundable part",
    paidPart.statusCode === 200 &&
      pb.adjustment > 0 &&
      pb.refundable > 0 &&
      pb.inv?.status === "paid",
    JSON.stringify({
      pay: paidPart.statusCode,
      pr,
      pb: { ...pb, inv: pb.inv?.status, notes: undefined },
    }),
  );

  // Capacity: a 2000 service credit already went back on the 3000 term invoice, so it can
  // take only 1000 more. Two documents still; the note stops at what the invoice can take.
  const cap = await setup(TWO, { start: "pro" });
  const [capInv] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, cap.sub.id)),
  );
  await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: cap.biz.id,
    invoicePublicId: capInv!.publicId,
    items: [{ description: "Service credit", amountMinor: 2000 }],
    reason: "capacity fixture",
  });
  const ke = json(await cap.estimate("basic"));
  const kr = json(await cap.change("basic"));
  const kb = await parity("capacity", cap, ke, kr);
  check(
    "capacity: no netting — a credit note up to the invoice's capacity, and a paid invoice",
    !!kr.proration_invoice?.id &&
      kb.inv?.status === "paid" &&
      kb.refundable > 0 &&
      kb.refundable <= 1000,
    JSON.stringify({ kr, kb: { ...kb, inv: kb.inv?.status, notes: undefined } }),
  );

  // A net debit (an upgrade) is not affected by the setting.
  const upA = await setup();
  const upB = await setup({ net_credit_documents: "credit_note_and_invoice" });
  const ua = json(await upA.change("pro", { invoice_immediately: true }));
  const ub2 = json(await upB.change("pro", { invoice_immediately: true }));
  check(
    "an upgrade books the same documents under either net_credit_documents",
    !!ua.proration_invoice?.id &&
      !!ub2.proration_invoice?.id &&
      ua.proration_invoice.total_minor === ub2.proration_invoice.total_minor &&
      (ua.credit_note?.total_minor ?? 0) === (ub2.credit_note?.total_minor ?? 0),
    JSON.stringify({ ua, ub2 }),
  );
}

// ── block_downgrade_when_past_due ─────────────────────────────────────────────────────
{
  const guarded = await setup(
    { downgrade_timing: "customer_chooses", block_downgrade_when_past_due: true },
    { start: "pro", unpaid: true },
  );
  const refused = await guarded.change("basic", { timing: "now" });
  check(
    "guard on + a past-due invoice: a downgrade now is refused (400) and nothing changes",
    refused.statusCode === 400 &&
      json(refused).error?.message === PAST_DUE_DOWNGRADE_MESSAGE &&
      (await guarded.planPrice()) === guarded.price.pro.id,
    `${refused.statusCode} ${refused.payload.slice(0, 200)}`,
  );
  const later = await guarded.change("basic", { timing: "end_of_term" });
  check(
    "guard on: the same downgrade at the end of the term is allowed",
    later.statusCode === 200 && !!json(later).scheduled_change?.id,
    `${later.statusCode} ${later.payload.slice(0, 200)}`,
  );
  const up = await guarded.change("pro", { timing: "now" });
  check(
    "guard on: a change that credits nothing is not refused",
    up.statusCode === 200,
    up.payload.slice(0, 200),
  );
  const open = await setup({ downgrade_timing: "now" }, { start: "pro", unpaid: true });
  const allowed = await open.change("basic");
  check(
    "guard off (unset) + a past-due invoice: the downgrade applies",
    allowed.statusCode === 200 && !!json(allowed).credit_note?.id,
    `${allowed.statusCode} ${allowed.payload.slice(0, 200)}`,
  );
  const stored = json(
    await api("PATCH", `/v1/businesses/${open.biz.publicId}`, {
      billing_rules_config: { block_downgrade_when_past_due: true },
    }),
  ).billing_rules_config;
  check(
    "PATCH stores block_downgrade_when_past_due",
    stored?.block_downgrade_when_past_due === true,
    JSON.stringify(stored?.block_downgrade_when_past_due),
  );
}

// ── Net credit under India GST: each document carries its own tax ─────────────────────
{
  await loadGeoReference();
  const gBiz = await createBusiness({
    organizationId: orgId,
    name: "GST Rules",
    defaultCurrency: "INR",
    livemode: "test",
    billingRulesConfig: { net_credit_documents: "credit_note_and_invoice" },
  });
  const g = { organizationId: orgId, businessId: gBiz.id };
  await configureIndiaGst({
    ...g,
    homeStateCode: "TN",
    cgstBps: 900,
    sgstBps: 900,
    registrationNumber: "33AAFCN5032R1Z6",
  });
  const mkPlan = async (name: string, amountMinor: number) => {
    const product = await createProduct({ ...g, name, kind: "plan" });
    const price = await createPrice({
      ...g,
      productId: product.id,
      type: "recurring",
      model: "flat",
      currency: "INR",
      amountMinor,
      interval: "month",
    });
    return { product, price };
  };
  const pro = await mkPlan("Pro", 999900);
  const basic = await mkPlan("Basic", 399900);
  // 10% off the Pro plan only: the old plan's invoice is discounted, the new plan's is not.
  await createCoupon({
    ...g,
    code: "PRO10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [
      { itemKind: "plan", constraintType: "specific", productIds: [pro.product.publicId] },
    ],
  });
  const cus = await createCustomer({
    ...g,
    email: `gst${Date.now()}@example.com`,
    address: { line1: "1 Mount Rd", city: "Chennai", country: "IN", stateCode: "TN" } as never,
  } as never);
  const pm = await vaultPaymentMethod({ ...g, customer: cus, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...g,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: pro.price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  await applyCouponToSubscription({
    ...g,
    subscriptionId: subscription.id,
    code: "PRO10",
    now: new Date(),
  });
  const { invoice: termInv } = await billSubscriptionPeriod({
    ...g,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const base = `/v1/businesses/${gBiz.publicId}`;
  const body = { changes: [{ item: items[0]!.publicId, price: basic.price.publicId }] };
  const ge = json(
    await api("POST", `${base}/subscriptions/${subscription.publicId}/estimate`, body),
  );
  // Booked at the estimate's instant, so an exact-time proration credits the same time.
  const gr = json(
    await api("POST", `${base}/subscriptions/${subscription.publicId}/change`, {
      ...body,
      priced_at: ge.priced_at,
      quote: ge.quote,
    }),
  );
  const term = json(await api("GET", `${base}/invoices/${termInv.publicId}`));
  const note = gr.credit_note?.id
    ? json(await api("GET", `${base}/credit_notes/${gr.credit_note.id}`))
    : {};
  const inv = gr.proration_invoice?.id
    ? json(await api("GET", `${base}/invoices/${gr.proration_invoice.id}`))
    : {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const names = (rows: any[] | undefined, key: string) =>
    (rows ?? []).map((t) => String(t[key])).sort();
  const half = (bps: number, base: number) => Math.round((base * bps) / 10000);
  const termTax = (term.taxes ?? []).reduce(
    (s: number, t: { amount_minor: number }) => s + t.amount_minor,
    0,
  );
  const termTaxable = term.total_minor - termTax;
  const noteTax = (note.taxes ?? []).reduce(
    (s: number, t: { amount_minor: number }) => s + t.amount_minor,
    0,
  );
  const noteNet = note.total_minor - noteTax;
  console.log(
    `GST: term ${term.total_minor} tax ${termTax} · note ${note.total_minor} tax ${noteTax} ${JSON.stringify(note.taxes)} · invoice ${inv.total_minor} ${JSON.stringify(inv.taxes)}`,
  );
  check(
    "GST net credit: a credit note and an invoice",
    !!note.id && !!inv.id && gr.proration_invoice?.status === "paid",
    JSON.stringify(gr),
  );
  check(
    "GST: the credit note reverses CGST + SGST at the term invoice's own rate",
    names(note.taxes, "description").length === 2 &&
      names(note.taxes, "description")[0]!.startsWith("CGST") &&
      names(note.taxes, "description")[1]!.startsWith("SGST") &&
      note.taxes[0].amount_minor === note.taxes[1].amount_minor &&
      // The note's tax is the term invoice's tax, in proportion to the net credited.
      Math.abs(noteTax * termTaxable - termTax * noteNet) <= termTaxable * 2,
    JSON.stringify({ note, termTax, termTaxable }),
  );
  // The note credits the unused list amount at the old plan's 10% discount (its net is
  // stated after the discount), where the new invoice's base carries none.
  const unusedList = -(ge.lines ?? [])
    .filter((l: { amount_minor: number }) => l.amount_minor < 0)
    .reduce((s: number, l: { amount_minor: number }) => s + l.amount_minor, 0);
  check(
    "GST: the credit note carries the old plan's 10% discount",
    unusedList > 0 && Math.abs(noteNet - (unusedList * 9) / 10) <= 1,
    JSON.stringify({ noteNet, unusedList }),
  );
  check(
    "GST: the new invoice carries CGST 9% + SGST 9% on the new plan, with no discount",
    names(inv.taxes, "name").length === 2 &&
      (inv.taxes ?? []).every(
        (t: { rate_bps: number; amount_minor: number }) =>
          t.rate_bps === 900 && t.amount_minor === half(900, inv.subtotal_minor),
      ) &&
      (inv.discount_minor ?? 0) === 0,
    JSON.stringify({ sub: inv.subtotal_minor, taxes: inv.taxes, d: inv.discount_minor }),
  );
  check(
    "GST: the estimate equals the credit note, the invoice and its tax rows",
    ge.credit_note_total_minor === note.total_minor &&
      ge.invoice_total_minor === inv.total_minor &&
      ge.tax_minor ===
        (inv.taxes ?? []).reduce((s: number, t: { amount_minor: number }) => s + t.amount_minor, 0),
    JSON.stringify({
      ge: [ge.credit_note_total_minor, ge.invoice_total_minor, ge.tax_minor],
      n: note.total_minor,
      i: inv.total_minor,
    }),
  );
}

// ── 2.4 Gate ───────────────────────────────────────────────────────────────────────
{
  const unset = await setup();
  await unset.owe();
  check(
    "unset gate: an upgrade with an unpaid invoice still applies (today)",
    (await unset.change("pro", { invoice_immediately: true })).statusCode === 200,
  );

  const g = await setup({ upgrade_gate: "invoices_paid", downgrade_timing: "now" });
  check(
    "upgrade_gate=invoices_paid, nothing owed → the upgrade applies",
    json(await g.estimate("pro")).change_policy?.blocked === null,
  );
  const inv = await g.owe();
  const [row] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, inv.id)),
  );
  check("the fixture invoice is open and owes money", Number(row!.amountDueMinor) > 0);
  const ge = json(await g.estimate("pro"));
  const gc = await g.change("pro", { invoice_immediately: true });
  check(
    "upgrade_gate=invoices_paid + unpaid invoice → estimate says blocked, /change 409",
    ge.change_policy?.blocked?.code === "invoices_unpaid" &&
      gc.statusCode === 409 &&
      json(gc).error?.code === "invoices_unpaid" &&
      (await g.planPrice()) === g.price.basic.id,
    `${gc.statusCode} ${gc.payload}`,
  );
  check("…and /schedule 409", (await g.schedule("pro")).statusCode === 409);
  check(
    "the dashboard message names the reason and the next step",
    /unpaid invoices.*Collect the open invoices/.test(
      (await g.policy("upgrade", "dashboard")).blocked?.message ?? "",
    ),
  );
  check(
    "the portal message is the buyer's",
    (await g.policy("upgrade", "portal")).blocked?.message ===
      "Pay your open invoices before you change your plan.",
  );
  check(
    "a scheduled change is not gated when it lands (it was checked when scheduled)",
    (await g.policy("upgrade", "scheduled")).blocked === null,
  );

  const d = await setup(
    { downgrade_gate: "invoices_paid", downgrade_timing: "now" },
    { start: "pro" },
  );
  await d.owe();
  check(
    "downgrade_gate=invoices_paid + unpaid invoice → the downgrade is refused",
    (await d.change("basic", { invoice_immediately: true })).statusCode === 409,
  );
  const dUp = json(await d.estimate("basicYear"));
  check(
    "…and an upgrade (gate off) is not blocked",
    dUp.change_policy?.direction === "upgrade" && dUp.change_policy?.blocked === null,
  );
  const both = await setup({ downgrade_gate: "off", upgrade_gate: "off" }, { start: "pro" });
  await both.owe();
  check(
    "downgrade_gate=off + unpaid invoice → the downgrade applies",
    (await both.change("basic", { invoice_immediately: true })).statusCode === 200,
  );
}

// ── 2.38 Timing ────────────────────────────────────────────────────────────────────
{
  // Unset: the API applies now unless the caller schedules.
  const u = await setup({}, { start: "pro" });
  const now = json(await u.change("basic", { invoice_immediately: true }));
  check(
    "unset: an omitted timing applies the downgrade now (today)",
    now.timing === "now" && now.scheduled_change === null,
  );
  const u2 = await setup();
  const later = json(await u2.change("pro", { timing: "end_of_term" }));
  check(
    "unset: an explicit end_of_term is honoured",
    later.timing === "end_of_term" &&
      !!later.scheduled_change?.id &&
      (await u2.planPrice()) === u2.price.basic.id,
  );

  const n = await setup({ upgrade_timing: "now" });
  check(
    "upgrade_timing=now: end_of_term → 400",
    (await n.change("pro", { timing: "end_of_term" })).statusCode === 400,
  );
  check("upgrade_timing=now: /schedule → 400", (await n.schedule("pro")).statusCode === 400);
  check(
    "upgrade_timing=now: omitted → applied now",
    json(await n.change("pro", { invoice_immediately: true })).timing === "now",
  );

  const e = await setup({ downgrade_timing: "end_of_term" }, { start: "pro" });
  // The preview prices what `/change` will do: the term end, so no credit now.
  const ee = json(await e.estimate("basic"));
  check(
    "downgrade_timing=end_of_term: the estimate prices the term end (no credit now)",
    new Date(ee.priced_at).getTime() === e.sub.currentPeriodEnd!.getTime() &&
      ee.total_minor >= 0 &&
      !ee.credit_note_total_minor &&
      !ee.lines?.some((l: { amount_minor: number }) => l.amount_minor < 0),
    JSON.stringify(ee),
  );
  check(
    "downgrade_timing=end_of_term: now → 400",
    (await e.change("basic", { timing: "now" })).statusCode === 400,
  );
  check(
    "downgrade_timing=end_of_term: a scheduled change cannot carry prorate → 400",
    (await e.change("basic", { prorate: true })).statusCode === 400,
  );
  // Hosted checkout: the view says Confirm will refuse, so the page shows why, not a credit.
  const eSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: e.biz.id,
    priceId: e.price.basic.publicId,
    mode: "change",
    subscriptionId: e.sub.publicId,
  });
  const eView = await getCheckoutView((await resolveCheckoutSession(eSession.token))!);
  check(
    "downgrade_timing=end_of_term: the change-mode checkout view carries `blocked` (change_timing)",
    eView?.change?.blocked?.code === "change_timing" &&
      /end of the term/.test(eView?.change?.blocked?.message ?? ""),
    JSON.stringify(eView?.change?.blocked),
  );
  const eo = json(await e.change("basic"));
  check(
    "downgrade_timing=end_of_term: omitted → scheduled for the term end",
    eo.timing === "end_of_term" &&
      new Date(eo.scheduled_change?.effective_at).getTime() === e.sub.currentPeriodEnd!.getTime() &&
      (await e.planPrice()) === e.price.pro.id,
    JSON.stringify(eo),
  );

  const c = await setup({
    upgrade_timing: "customer_chooses",
    downgrade_timing: "customer_chooses",
  });
  const cu = json(await c.estimate("pro"));
  check(
    "customer_chooses: an upgrade offers both, default now",
    cu.change_policy?.timings?.length === 2 && cu.change_policy?.default_timing === "now",
  );
  const c2 = await setup(
    { upgrade_timing: "customer_chooses", downgrade_timing: "customer_chooses" },
    { start: "pro" },
  );
  check(
    "customer_chooses: an omitted downgrade timing → term end",
    json(await c2.change("basic")).timing === "end_of_term",
  );
  const c3 = await setup({ downgrade_timing: "customer_chooses" }, { start: "pro" });
  check(
    "customer_chooses: an explicit now is honoured",
    json(await c3.change("basic", { timing: "now", invoice_immediately: true })).timing === "now",
  );

  // In a trial every change applies now.
  const t = await setup(
    { downgrade_timing: "end_of_term", upgrade_timing: "end_of_term" },
    { trial: true },
  );
  const tp = await t.policy("upgrade", "api");
  check(
    "in trial: a saved end_of_term still applies now",
    tp.timings.length === 1 && tp.defaultTiming === "now",
  );
  check(
    "in trial: the API applies the change now",
    json(await t.change("pro")).timing === "now" && (await t.planPrice()) === t.price.pro.id,
  );
  const tp2 = await t.policy("downgrade", "portal");
  check(
    "in trial: the portal applies a downgrade now",
    tp2.defaultTiming === "now" && tp2.timings.length === 1,
  );
}

// ── A term-end downgrade previews what the renewal books ─────────────────────────────
{
  const c = await setup({ downgrade_timing: "end_of_term" }, { start: "pro" });
  const est = json(await c.estimate("basic", { change_option: "end_of_term" }));
  const sched = json(await c.change("basic"));
  const at = new Date(c.sub.currentPeriodEnd!.getTime() + 1000);
  await runWithClockScope({ onlyBusinessId: c.biz.id, now: at }, async () => {
    await applyDueScheduledChanges(at);
    await renewSubscription(orgId, c.sub.id, at);
  });
  const subInvoices = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, c.sub.id)),
  );
  const renewal = [...subInvoices].sort((x, y) => +y.createdAt - +x.createdAt)[0];
  const notes = await withTenant(orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.customerId, c.customer.id)),
  );
  check(
    "term-end downgrade: the preview's next invoice equals what the renewal books, with no credit",
    sched.timing === "end_of_term" &&
      (await c.planPrice()) === c.price.basic.id &&
      est.next_renewal?.amount_due_minor === Number(renewal?.totalMinor) &&
      Number(renewal?.totalMinor) === 1000 &&
      !est.credit_note_total_minor &&
      notes.length === 0,
    `preview=${JSON.stringify(est.next_renewal?.amount_due_minor)} booked=${renewal?.totalMinor} notes=${notes.length}`,
  );
  check(
    "term-end preview refuses its own prorate (the scheduled change takes the rule)",
    (await c.estimate("basic", { change_option: "end_of_term", prorate: true })).statusCode === 400,
  );
}

// ── Portal source: every setting reaches the portal ─────────────────────────────────
{
  const u = await setup();
  const tok = await portalToken(u);
  const opts = json(
    await portal(tok, "GET", `/portal/v1/subscriptions/${u.sub.publicId}/change_options`),
  );
  check(
    "portal, unset timing: upgrade now only, downgrade at term end only (today)",
    JSON.stringify(opts.timing?.upgrade?.options) === '["now"]' &&
      JSON.stringify(opts.timing?.downgrade?.options) === '["end_of_term"]',
    JSON.stringify(opts.timing),
  );
  const pre = json(
    await portal(tok, "POST", `/portal/v1/subscriptions/${u.sub.publicId}/change/preview`, {
      plan: u.price.pro.publicId,
    }),
  );
  check(
    "portal, unset proration: an upgrade is prorated",
    pre.direction === "upgrade" && pre.total_minor > 0,
  );
  check(
    'portal preview states the resolved proration and invoicing for its "Now" text',
    pre.prorate === true && pre.invoice_immediately === true,
    JSON.stringify({ prorate: pre.prorate, inv: pre.invoice_immediately }),
  );

  for (const rule of ["now", "end_of_term", "customer_chooses"] as const) {
    const c = await setup({ upgrade_timing: rule, downgrade_timing: rule });
    const o = json(
      await portal(
        await portalToken(c),
        "GET",
        `/portal/v1/subscriptions/${c.sub.publicId}/change_options`,
      ),
    );
    const want = rule === "customer_chooses" ? ["now", "end_of_term"] : [rule];
    check(
      `portal, timing=${rule}: both directions offer ${want.join(" + ")}`,
      JSON.stringify(o.timing?.upgrade?.options) === JSON.stringify(want) &&
        JSON.stringify(o.timing?.downgrade?.options) === JSON.stringify(want) &&
        (rule !== "customer_chooses" ||
          (o.timing.upgrade.default === "now" && o.timing.downgrade.default === "end_of_term")),
      JSON.stringify(o.timing),
    );
  }

  const none = await setup({ upgrade_proration: "none" });
  const np = json(
    await portal(
      await portalToken(none),
      "POST",
      `/portal/v1/subscriptions/${none.sub.publicId}/change/preview`,
      {
        plan: none.price.pro.publicId,
      },
    ),
  );
  check(
    "portal, upgrade_proration=none: nothing to pay now",
    np.total_minor === 0,
    JSON.stringify(np),
  );

  const g = await setup({ upgrade_gate: "invoices_paid" });
  await g.owe();
  const gt = await portalToken(g);
  const go = json(
    await portal(gt, "GET", `/portal/v1/subscriptions/${g.sub.publicId}/change_options`),
  );
  const gp = await portal(gt, "POST", `/portal/v1/subscriptions/${g.sub.publicId}/change/preview`, {
    plan: g.price.pro.publicId,
  });
  check(
    "portal, upgrade_gate: the options say why and the preview is refused (409)",
    go.timing?.upgrade?.blocked?.message ===
      "Pay your open invoices before you change your plan." &&
      go.timing?.downgrade?.blocked === null &&
      gp.statusCode === 409,
    `${gp.statusCode} ${JSON.stringify(go.timing)}`,
  );

  const pd = await setup({ downgrade_gate: "invoices_paid" }, { start: "pro" });
  await pd.owe();
  const pdp = await portal(
    await portalToken(pd),
    "POST",
    `/portal/v1/subscriptions/${pd.sub.publicId}/change/preview`,
    {
      plan: pd.price.basic.publicId,
    },
  );
  check("portal, downgrade_gate: a downgrade is refused (409)", pdp.statusCode === 409);
}

// ── Portal "Now" text follows what the change books ─────────────────────────────────
{
  const c = await setup({ upgrade_proration: "none" });
  await systemDb
    .update(businesses)
    .set({
      storefrontConfig: {
        allow_plan_changes: true,
        allow_addon_changes: true,
        charge_upgrade: "next_invoice",
      },
    })
    .where(eq(businesses.id, c.biz.id));
  const seatProd = await createProduct({
    organizationId: orgId,
    businessId: c.biz.id,
    name: "Per seat",
    kind: "addon",
    enabledInPortal: true,
    // The portal offers an add-on only on plans it applies to (#319).
    addonAppliesToAll: true,
  });
  const seat = await createPrice({
    organizationId: orgId,
    businessId: c.biz.id,
    productId: seatProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 500,
    interval: "month",
  });
  const tok = await portalToken(c);
  const url = `/portal/v1/subscriptions/${c.sub.publicId}/change`;
  const body = { addons: [{ price: seat.publicId, quantity: 1 }] };
  const pre = json(await portal(tok, "POST", `${url}/preview`, body));
  const hint = portalNowHint(pre);
  const applied = await portal(tok, "POST", url, {
    ...body,
    expected_total_minor: pre.total_minor,
  });
  const queued = await withTenant(orgId, (tx) =>
    tx.select().from(unbilledCharges).where(eq(unbilledCharges.subscriptionId, c.sub.id)),
  );
  check(
    "portal: upgrade_proration=none + an add-on add → the text names the prorated charge on the next invoice, and it is booked",
    pre.prorate === false &&
      pre.adds_items === true &&
      pre.due_today?.added_to_next_invoice === true &&
      pre.due_today?.total_minor > 0 &&
      /prorated amount for each add-on that you add to your next invoice/.test(hint) &&
      !/We do not charge a prorated amount for the rest of this period/.test(hint) &&
      applied.statusCode === 200 &&
      queued.reduce((t, q) => t + Number(q.amountMinor), 0) === pre.due_today?.total_minor,
    `hint=${hint} due=${JSON.stringify(pre.due_today)} queued=${queued.map((q) => q.amountMinor).join(",")} ${applied.statusCode}`,
  );
}

// ── A scheduled change lands with the direction's proration ───────────────────────
for (const opt of ["prorated", "none"] as const) {
  const c = await setup({ upgrade_proration: opt });
  const before = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, c.sub.id)),
    )
  ).length;
  const s = await c.schedule("pro");
  const effectiveAt = new Date(json(s).effective_at);
  const at = new Date(effectiveAt.getTime() + 1000);
  await runWithClockScope({ onlyBusinessId: c.biz.id, now: at }, () =>
    applyDueScheduledChanges(at),
  );
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(scheduledChanges)
      .where(
        and(eq(scheduledChanges.subscriptionId, c.sub.id), eq(scheduledChanges.type, "change")),
      ),
  );
  const raised = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, c.sub.id)),
  );
  check(
    `scheduled upgrade lands with upgrade_proration=${opt}`,
    row?.status === "applied" &&
      (await c.planPrice()) === c.price.pro.id &&
      // A proration invoice only when prorated.
      raised.length - before === (opt === "prorated" ? 1 : 0),
    `status=${row?.status} invoices=${before}→${raised.length} err=${row?.lastError ?? ""}`,
  );
}

// ── Review fixes ──────────────────────────────────────────────────────────────────
/** A bare business with a card-holding customer; prices and the subscription come per check. */
async function bare(rules?: Record<string, unknown>) {
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Review",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  await systemDb
    .update(businesses)
    .set({ ...(rules ? { billingRulesConfig: rules } : {}), defaultInvoiceImmediately: true })
    .where(eq(businesses.id, biz.id));
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `v${Math.random().toString(36).slice(2)}@example.com`,
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const product = (name: string, kind: "plan" | "addon") =>
    createProduct({ organizationId: orgId, businessId: biz.id, name, kind });
  const price = (productId: string, extra: Record<string, unknown>) =>
    createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId,
      type: "recurring",
      currency: "USD",
      ...extra,
    } as Parameters<typeof createPrice>[0]);
  const subscribe = async (
    items: Array<{ price: Awaited<ReturnType<typeof price>>; quantity: number }>,
  ) => {
    const created = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: new Date(),
      items,
      defaultPaymentMethodId: pm.id,
    });
    const sub = created.subscription;
    await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: sub,
      periodStart: sub.currentPeriodStart!,
      periodEnd: sub.currentPeriodEnd!,
    });
    return { sub, items: created.items };
  };
  const owe = () =>
    createInvoiceFromLines({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      currency: "USD",
      lines: [{ description: "Setup fee", amountMinor: 1500n, kind: "one_time" }],
      collect: false,
    });
  return { biz, customer, product, price, subscribe, owe };
}
const directionOf = (
  sub: { id: string; businessId: string },
  edit: Parameters<typeof directionOfItemEdit>[2],
) => withTenant(orgId, (tx) => directionOfItemEdit(tx, sub, edit));

// R1 — a monthly add-on on a yearly plan is stored cycle-aligned (×12); it counts per month.
{
  const b = await bare();
  const plan = await b.product("Yearly plan", "plan");
  const yearly = await b.price(plan.id, { model: "flat", amountMinor: 12000, interval: "year" });
  const addon = await b.product("Support", "addon");
  const a500 = await b.price(addon.id, { model: "flat", amountMinor: 500, interval: "month" });
  const a700 = await b.price(addon.id, { model: "flat", amountMinor: 700, interval: "month" });
  const { sub, items } = await b.subscribe([
    { price: yearly, quantity: 1 },
    { price: a500, quantity: 1 },
  ]);
  const addonRow = items.find((i) => i.priceId === a500.id)!;
  const addonItem = addonRow.publicId;
  check(
    "R1 fixture: the add-on's snapshot is cycle-aligned (6000 a year)",
    (addonRow.priceSnapshot as { amountMinor?: number } | null)?.amountMinor === 6000,
    JSON.stringify(addonRow.priceSnapshot),
  );
  check(
    "R1: on a yearly plan, a 500 → 700 a month add-on swap is an upgrade",
    (await directionOf(sub, { changes: [{ itemId: addonItem, newPriceId: a700.publicId }] })) ===
      "upgrade",
  );
}

// R2 — a differential add-on counts at its per-plan rate, not its 0 list price.
{
  const b = await bare({ upgrade_gate: "invoices_paid" });
  const plan = await b.product("Pro", "plan");
  const pro = await b.price(plan.id, { model: "flat", amountMinor: 3000, interval: "month" });
  const seat = await b.product("Seat", "addon");
  const seat0 = await b.price(seat.id, { model: "per_unit", amountMinor: 0, interval: "month" });
  await setDifferentialPrice({
    organizationId: orgId,
    businessId: b.biz.id,
    addonPublicId: seat.publicId,
    planPublicId: plan.publicId,
    currency: "USD",
    interval: "month",
    amountMinor: 800,
  });
  const { sub } = await b.subscribe([{ price: pro, quantity: 1 }]);
  check(
    "R2: attaching a differential add-on (list price 0) is an upgrade",
    (await directionOf(sub, { changes: [], adds: [{ priceId: seat0.publicId, quantity: 1 }] })) ===
      "upgrade",
  );
  await b.owe();
  const r = await api(
    "POST",
    `/v1/businesses/${b.biz.publicId}/subscriptions/${sub.publicId}/change`,
    {
      adds: [{ price: seat0.publicId, quantity: 1 }],
      invoice_immediately: true,
    },
  );
  check("R2: …so the upgrade gate refuses it (409)", r.statusCode === 409, r.payload);
}

// R3 — a tiered plan counts at its quantity: more seats up, fewer seats down.
{
  const b = await bare({ downgrade_proration: "none", downgrade_timing: "now" });
  const plan = await b.product("Seats", "plan");
  const tiered = await b.price(plan.id, {
    model: "tiered",
    interval: "month",
    tiers: [
      { upToMinor: 10, unitAmountMinor: 1000, flatAmountMinor: 0 },
      { upToMinor: null, unitAmountMinor: 500, flatAmountMinor: 0 },
    ],
  });
  const { sub, items } = await b.subscribe([{ price: tiered, quantity: 3 }]);
  const item = items[0]!.publicId;
  check(
    "R3: tiered 3 → 5 seats is an upgrade",
    (await directionOf(sub, { changes: [{ itemId: item, newQuantity: 5 }] })) === "upgrade",
  );
  const est = json(
    await api("POST", `/v1/businesses/${b.biz.publicId}/subscriptions/${sub.publicId}/estimate`, {
      changes: [{ item, quantity: 1 }],
    }),
  );
  check(
    "R3: tiered 3 → 1 seat is a downgrade and takes downgrade_proration=none",
    est.change_policy?.direction === "downgrade" && est.change_policy?.prorate === false,
    JSON.stringify(est.change_policy),
  );
}

// R4 — fields only an immediate change can carry imply `now` when the timing is omitted.
{
  const c = await setup({ downgrade_timing: "customer_chooses" }, { start: "pro" });
  const r = await c.change("basic", { invoice_immediately: true });
  check(
    "R4: customer_chooses + invoice_immediately, no timing → applied now (not a 400)",
    r.statusCode === 200 && json(r).timing === "now",
    r.payload,
  );
  const e = await setup({ downgrade_timing: "end_of_term" }, { start: "pro" });
  const refused = await e.change("basic", { invoice_immediately: true });
  check(
    "R4: end_of_term only → 400 that names the field and the rule",
    refused.statusCode === 400 &&
      /invoice_immediately/.test(json(refused).error?.message ?? "") &&
      /downgrade at the end of the term/.test(json(refused).error?.message ?? ""),
    refused.payload,
  );
}

// R5 — an unsaved timing is stored on an explicit save, and only then.
{
  const fd = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };
  check(
    "R5: a save of other rows leaves the preselected timing unsaved",
    JSON.stringify(
      timingRulesFromForm(fd({ upgrade_timing: "now", upgrade_timing_unset: "now" })),
    ) === "{}",
  );
  check(
    "R5: “Save this timing” stores the preselected value",
    timingRulesFromForm(
      fd({ upgrade_timing: "now", upgrade_timing_unset: "now", upgrade_timing_save: "on" }),
    ).upgrade_timing === "now",
  );
  check(
    "R5: a changed select stores its value",
    timingRulesFromForm(fd({ downgrade_timing: "now" })).downgrade_timing === "now",
  );
}

// R6 — the change screen submits only on the policy of the current edit, and sends only
// the operator's own prorate.
{
  const k1 = changeEditKey([{ item: "si_1", price: "up" }], [], []);
  const k2 = changeEditKey([{ item: "si_1", price: "down" }], [], []);
  check(
    "R6: a policy answered for an earlier edit does not allow submit",
    !policyReady({ hasLineWork: true, reactivating: false, answeredKey: k1, editKey: k2 }) &&
      policyReady({ hasLineWork: true, reactivating: false, answeredKey: k2, editKey: k2 }),
  );
  const items = [[{ item: "si_1", price: "down" }], [], []] as const;
  const now = changeEditKey(...items, ["now", null, false]);
  const later = changeEditKey(...items, ["end_of_term", null, false]);
  check(
    "R6: a timing switch is a new edit: the answer for the other timing does not allow submit",
    now !== later &&
      !policyReady({ hasLineWork: true, reactivating: false, answeredKey: now, editKey: later }),
  );
  check(
    "R6: an untouched prorate is not sent (the server resolves it for the direction)",
    prorateToSend(true, null) === undefined && prorateToSend(true, false) === false,
  );
}

// R7 — every route that changes recurring items honours the gate and the timing.
{
  const g = await setup(
    { upgrade_gate: "invoices_paid", downgrade_gate: "invoices_paid" },
    { start: "pro" },
  );
  await g.owe();
  const base = `/v1/businesses/${g.biz.publicId}/subscriptions/${g.sub.publicId}`;
  const addon = await createProduct({
    organizationId: orgId,
    businessId: g.biz.id,
    name: "Extra",
    kind: "addon",
  });
  const extra = await createPrice({
    organizationId: orgId,
    businessId: g.biz.id,
    productId: addon.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 400,
    interval: "month",
  });
  const add = await api("POST", `${base}/items`, { price: extra.publicId });
  check("R7: POST …/items, upgrade gated → 409", add.statusCode === 409, add.payload);
  const ufi = await api("POST", `${base}/update_for_items`, {
    items: [{ price: g.price.basic.publicId }],
    replace_items_list: true,
  });
  check("R7: update_for_items, downgrade gated → 409", ufi.statusCode === 409, ufi.payload);

  const d = await bare({ downgrade_gate: "invoices_paid" });
  const plan = await d.product("Plan", "plan");
  const pp = await d.price(plan.id, { model: "flat", amountMinor: 3000, interval: "month" });
  const ap = await d.product("Addon", "addon");
  const apx = await d.price(ap.id, { model: "flat", amountMinor: 500, interval: "month" });
  const s = await d.subscribe([
    { price: pp, quantity: 1 },
    { price: apx, quantity: 1 },
  ]);
  await d.owe();
  const del = await api(
    "DELETE",
    `/v1/businesses/${d.biz.publicId}/subscriptions/${s.sub.publicId}/items/${s.items.find((i) => i.priceId === apx.id)!.publicId}`,
  );
  check("R7: DELETE …/items/:item, downgrade gated → 409", del.statusCode === 409, del.payload);

  const t = await setup({ upgrade_timing: "end_of_term" });
  const tAdd = await api(
    "POST",
    `/v1/businesses/${t.biz.publicId}/subscriptions/${t.sub.publicId}/items`,
    { price: t.price.pro.publicId },
  );
  check(
    "R7: POST …/items when upgrades wait for the term end → 400",
    tAdd.statusCode === 400,
    tAdd.payload,
  );

  // HubSpot app: the same gate as the API.
  let hubspot = "";
  try {
    await editSubscriptionFromHubSpot({
      conn: { organizationId: orgId, businessId: g.biz.id, settings: {} } as unknown as Parameters<
        typeof editSubscriptionFromHubSpot
      >[0]["conn"],
      subscriptionId: g.sub.id,
      pricePublicId: g.price.basicYear.publicId,
    });
  } catch (e) {
    hubspot = (e as { code?: string }).code ?? String(e);
  }
  check("R7: the HubSpot app refuses a gated upgrade", hubspot === "invoices_unpaid", hubspot);

  // Hosted checkout in change mode: the buyer's message, nothing applied.
  const session = await createCheckoutSession({
    organizationId: orgId,
    businessId: g.biz.id,
    priceId: g.price.basicYear.publicId,
    mode: "change",
    subscriptionId: g.sub.publicId,
  });
  const ctx = await resolveCheckoutSession(session.token);
  const view = await getCheckoutView(ctx!);
  check(
    "R7: the change-mode checkout view carries `blocked` before Confirm",
    view?.change?.blocked?.code === "invoices_unpaid" &&
      view?.change?.blocked?.message === "Pay your open invoices before you change your plan.",
    JSON.stringify(view?.change?.blocked),
  );
  const pms = () =>
    withTenant(orgId, (tx) =>
      tx
        .select({ id: paymentMethods.id, role: paymentMethods.role })
        .from(paymentMethods)
        .where(eq(paymentMethods.customerId, g.customer.id)),
    );
  const pmsBefore = await pms();
  let checkoutErr = "";
  try {
    await completeCheckout(ctx!, { paymentMethodToken: "tok_4242" });
  } catch (e) {
    checkoutErr = (e as Error).message;
  }
  check(
    "R7: a change-mode checkout refuses a gated upgrade with the buyer's message",
    checkoutErr === "Pay your open invoices before you change your plan." &&
      (await g.planPrice()) === g.price.pro.id,
    checkoutErr,
  );
  const pmsAfter = await pms();
  const primary = (rows: Awaited<ReturnType<typeof pms>>) =>
    rows.find((r) => r.role === "primary")?.id ?? null;
  check(
    "R7: a gated confirm vaults no card and leaves the primary payment method unchanged",
    pmsAfter.length === pmsBefore.length && primary(pmsAfter) === primary(pmsBefore),
    `before=${JSON.stringify(pmsBefore)} after=${JSON.stringify(pmsAfter)}`,
  );
}

// ── Q: `/change` books the amounts its `/estimate` showed (`priced_at` + `quote`) ──────
// A large plan moves the unused-time credit ~38 minor units a second, so 1.5 s shows it.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Quote",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Enterprise",
    kind: "plan",
  });
  const mk = (amountMinor: number) =>
    createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: product.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  const big = await mk(100_000_000);
  const bigger = await mk(200_000_000);
  const mkSub = async () => {
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `q${Math.random().toString(36).slice(2)}@example.com`,
    });
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
      // Started an hour ago, so the change falls well inside the paid term.
      now: new Date(Date.now() - 3_600_000),
      items: [{ price: big, quantity: 1 }],
      defaultPaymentMethodId: pm.id,
    });
    const sub = created.subscription;
    await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: sub,
      periodStart: sub.currentPeriodStart!,
      periodEnd: sub.currentPeriodEnd!,
    });
    const base = `/v1/businesses/${biz.publicId}/subscriptions/${sub.publicId}`;
    const body = { changes: [{ item: created.items[0]!.publicId, price: bigger.publicId }] };
    return {
      sub,
      estimate: () => api("POST", `${base}/estimate`, body),
      change: (extra: object) =>
        api("POST", `${base}/change`, {
          ...body,
          timing: "now",
          invoice_immediately: true,
          ...extra,
        }),
      planPrice: async () =>
        (
          await withTenant(orgId, (tx) =>
            tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id)),
          )
        )[0]!.priceId,
    };
  };
  const wait = () => new Promise((r) => setTimeout(r, 1500));

  const a = await mkSub();
  const aEst = json(await a.estimate());
  check(
    "Q: /estimate returns priced_at and quote",
    typeof aEst.priced_at === "string" && typeof aEst.quote === "string",
    JSON.stringify({ priced_at: aEst.priced_at, quote: aEst.quote }),
  );
  await wait();
  const aRes = await a.change({ priced_at: aEst.priced_at, quote: aEst.quote });
  check(
    "Q: /change 1.5 s later with priced_at + quote books exactly the estimated total",
    aRes.statusCode === 200 && net(json(aRes)) === aEst.total_minor,
    `${aRes.statusCode} booked=${net(json(aRes))} estimated=${aEst.total_minor} ${aRes.payload.slice(0, 200)}`,
  );

  const b = await mkSub();
  const bEst = json(await b.estimate());
  await wait();
  const bRes = await b.change({ quote: bEst.quote });
  check(
    "Q: a quote whose amounts moved (no priced_at) → 409 param=quote, nothing booked",
    bRes.statusCode === 409 &&
      json(bRes).error?.param === "quote" &&
      (await b.planPrice()) === big.id,
    `${bRes.statusCode} ${bRes.payload.slice(0, 200)}`,
  );

  const c = await mkSub();
  const cEst = json(await c.estimate());
  await wait();
  const cRes = await c.change({
    priced_at: new Date(Date.now() - 16 * 60_000).toISOString(),
    quote: cEst.quote,
  });
  check(
    "Q: a priced_at older than 15 minutes is not re-used → 409",
    cRes.statusCode === 409 && json(cRes).error?.param === "quote",
    `${cRes.statusCode} ${cRes.payload.slice(0, 200)}`,
  );

  // Neither field: priced at the moment of the call, as before.
  const d = await mkSub();
  await d.estimate();
  const dRes = await d.change({});
  check(
    "Q: a /change with neither field applies as before",
    dRes.statusCode === 200 && (await d.planPrice()) === bigger.id,
    `${dRes.statusCode} ${dRes.payload.slice(0, 200)}`,
  );

  // A quote fits only a change applied now: elsewhere it is a 400 that names the fields,
  // never a 409 that cannot clear.
  const eot = await setup({ downgrade_timing: "end_of_term" }, { start: "pro" });
  const eotRes = await eot.change("basic", { quote: aEst.quote, priced_at: aEst.priced_at });
  check(
    "Q: quote on a change the business rule schedules for the term end → 400",
    eotRes.statusCode === 400 && /quote and priced_at/.test(eotRes.payload),
    `${eotRes.statusCode} ${eotRes.payload.slice(0, 200)}`,
  );
  const e = await mkSub();
  const eEst = json(await e.estimate());
  const atRes = await e.change({
    at: new Date(Date.now() - 60_000).toISOString(),
    quote: eEst.quote,
  });
  check(
    "Q: quote with at → 400",
    atRes.statusCode === 400 && /Remove at/.test(atRes.payload),
    `${atRes.statusCode} ${atRes.payload.slice(0, 200)}`,
  );
  const lone = await e.change({ priced_at: eEst.priced_at });
  check(
    "Q: priced_at without quote → 400",
    lone.statusCode === 400 && /priced_at with quote/.test(lone.payload),
    `${lone.statusCode} ${lone.payload.slice(0, 200)}`,
  );

  // Renewed after the estimate: priced_at is inside the window but before the new term.
  const f = await mkSub();
  const fEst = json(await f.estimate());
  await renewSubscription(orgId, f.sub.id, f.sub.currentPeriodEnd!);
  const fRes = await f.change({ priced_at: fEst.priced_at, quote: fEst.quote });
  check(
    "Q: priced_at before a renewal that happened since → 409 param=quote",
    fRes.statusCode === 409 && json(fRes).error?.param === "quote",
    `${fRes.statusCode} ${fRes.payload.slice(0, 200)}`,
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
