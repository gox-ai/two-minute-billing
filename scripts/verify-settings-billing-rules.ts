/**
 * verify:settings-billing-rules — the six billing rules in `businesses.billing_rules_config`.
 *
 * Each option must change behaviour, and an unset business must behave as before:
 * trial-end action, a date-specific cancel's final period, required reasons, a failed change
 * charge, new-customer auto-collection and a revoked mandate.
 *
 *   pnpm verify:settings-billing-rules
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  cancelSubscriptionWithOptions,
  createSubscription,
  resumeSubscriptionWithOptions,
  editTrialEnd,
} from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { renewSubscription } from "@/modules/subscriptions/renewal";
import {
  applyDunningFinalAction,
  sweepExpiredParkedDunning,
} from "@/modules/subscriptions/dunning";
import { collectInvoice, createInvoiceFromLines } from "@/modules/invoicing/service";
import { settlePaymentFailed } from "@/modules/payments/settlement";
import { applyMandateStatus, handleProviderEvent } from "@/modules/webhooks/inbound";
import { presentationBlock } from "@/modules/invoicing/representment";
import { resumeDunning } from "@/modules/subscriptions/dunning";
import { recordTransaction } from "@/modules/transactions/service";
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import { runWithClockScope } from "@/platform/clock";
import {
  initialBillingRulesConfig,
  resolveBillingRulesConfig,
} from "@/modules/subscriptions/billing-rules-config";
import {
  businesses,
  customers,
  emailMessages,
  events,
  invoices,
  memberships,
  paymentMethods,
  paymentRequests,
  payments,
  scheduledChanges,
  subscriptions,
  users,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push([name, ok]);
  if (!ok && detail) console.log(`    ✗ ${name}: ${detail}`);
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
const org = await createOrganization({ name: "Billing Rules Co" });
const orgId = org.organization.id;
const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${org.secret}`,
      ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  }) as unknown as Promise<Res>;

async function newBiz(rules?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Rules",
    defaultCurrency: "USD",
    livemode: "test",
  });
  if (rules || Object.keys(extra).length)
    await systemDb
      .update(businesses)
      .set({ ...(rules ? { billingRulesConfig: rules } : {}), ...extra })
      .where(eq(businesses.id, biz.id));
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
    trialPeriod: 7,
    trialPeriodUnit: "day",
  });
  return { biz, price };
}

async function customerWithCard(bizId: string, token: string | null, email?: string) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: email ?? `c${Math.random().toString(36).slice(2)}@example.com`,
  });
  const pm = token
    ? await vaultPaymentMethod({ organizationId: orgId, businessId: bizId, customer: c, token })
    : null;
  return { c, pm };
}

const getSub = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
  );
const newestInvoice = (subId: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(invoices)
          .where(eq(invoices.subscriptionId, subId))
          .orderBy(desc(invoices.createdAt))
          .limit(1)
      )[0] ?? null,
  );

/** A trialing subscription whose trial has just ended. */
async function endedTrial(
  b: { biz: { id: string }; price: Awaited<ReturnType<typeof createPrice>> },
  token: string | null,
  email?: string,
) {
  const { c, pm } = await customerWithCard(b.biz.id, token, email);
  const s = (
    await createSubscription({
      organizationId: orgId,
      businessId: b.biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price: b.price, quantity: 1 }],
      trialDays: 7,
      ...(pm ? { defaultPaymentMethodId: pm.id } : {}),
    })
  ).subscription;
  await systemDb
    .update(subscriptions)
    .set({ trialEnd: new Date(Date.now() - 60_000) })
    .where(eq(subscriptions.id, s.id));
  return s;
}

// ── 0. Resolver: unset and malformed resolve to today's behaviour ──────────────────
{
  const d = resolveBillingRulesConfig(null);
  check(
    "unset → today's defaults",
    d.trialEndAction === "activate" &&
      d.specificDateCancelFinalPeriod === "full_period" &&
      Object.values(d.requiredReasons).every((v) => v === false) &&
      d.failedChangeCharge === "start_dunning" &&
      d.newCustomerAutoCollection === "on" &&
      d.mandateRevoked === "follow_dunning",
  );
  const bad = resolveBillingRulesConfig({
    billingRulesConfig: { trial_end_action: "Pause", required_reasons: { refund: "yes" } },
  });
  check(
    "malformed values resolve to the default",
    bad.trialEndAction === "activate" && bad.requiredReasons.refund === false,
  );
  check(
    "final period follows default_credit_option_for_cancel when unset",
    resolveBillingRulesConfig({ defaultCreditOptionForCancel: "prorate" })
      .specificDateCancelFinalPeriod === "prorated",
  );
  check(
    "a person's new business is pinned to today's values; a key's is not",
    resolveBillingRulesConfig({
      billingRulesConfig: initialBillingRulesConfig({ hasOperator: true }),
    }).mandateRevoked === "follow_dunning" &&
      initialBillingRulesConfig({ hasOperator: false }) === undefined,
  );
}

// ── API: read resolved, PATCH merges, null resets ───────────────────────────────────
{
  const created = json(
    await req("POST", "/v1/businesses", { default_currency: "USD", name: "Key-made" }),
  );
  const [row] = await systemDb
    .select({ c: businesses.billingRulesConfig })
    .from(businesses)
    .where(eq(businesses.publicId, created.id))
    .limit(1);
  check("a key-created business stores no billing rules", row?.c == null);
  check(
    "GET returns resolved defaults",
    created.billing_rules_config?.trial_end_action === "activate" &&
      created.billing_rules_config?.mandate_revoked === "follow_dunning",
  );
  await req("PATCH", `/v1/businesses/${created.id}`, {
    billing_rules_config: { trial_end_action: "pause", required_reasons: { refund: true } },
  });
  const p2 = json(
    await req("PATCH", `/v1/businesses/${created.id}`, {
      billing_rules_config: { required_reasons: { void_invoice: true } },
    }),
  );
  check(
    "PATCH merges keys and required_reasons",
    p2.billing_rules_config?.trial_end_action === "pause" &&
      p2.billing_rules_config?.required_reasons?.refund === true &&
      p2.billing_rules_config?.required_reasons?.void_invoice === true,
    JSON.stringify(p2.billing_rules_config),
  );
  const bad = await req("PATCH", `/v1/businesses/${created.id}`, {
    billing_rules_config: { mandate_revoked: "ignore" },
  });
  check("an unknown option is refused", bad.statusCode === 400);
  const reset = json(
    await req("PATCH", `/v1/businesses/${created.id}`, { billing_rules_config: null }),
  );
  check("null resets every key", reset.billing_rules_config?.trial_end_action === "activate");
}

// ── 2.5 Trial-end action ─────────────────────────────────────────────────────────────
{
  const today = await newBiz();
  const s0 = await endedTrial(today, "tok_4242");
  await renewSubscription(orgId, s0.id, new Date());
  check("trial end, unset → activates (today)", (await getSub(s0.id)).status === "active");

  const act = await newBiz({ trial_end_action: "activate" });
  const s1 = await endedTrial(act, "tok_4242");
  await renewSubscription(orgId, s1.id, new Date());
  const a1 = await getSub(s1.id);
  check(
    "trial end, activate → active and billed",
    a1.status === "active" && !!(await newestInvoice(s1.id)),
  );

  const can = await newBiz({ trial_end_action: "cancel" });
  const s2 = await endedTrial(can, "tok_4242");
  await renewSubscription(orgId, s2.id, new Date());
  const a2 = await getSub(s2.id);
  check(
    "trial end, cancel → cancelled trial_ended, no invoice",
    a2.status === "cancelled" && a2.cancelReason === "trial_ended" && !(await newestInvoice(s2.id)),
  );

  const pau = await newBiz({ trial_end_action: "pause" });
  const s3 = await endedTrial(pau, "tok_4242");
  await renewSubscription(orgId, s3.id, new Date());
  const a3 = await getSub(s3.id);
  check(
    "trial end, pause → paused, no invoice",
    a3.status === "paused" && !(await newestInvoice(s3.id)),
    a3.status,
  );
  const r = await resumeSubscriptionWithOptions({
    organizationId: orgId,
    businessId: pau.biz.id,
    subscriptionId: s3.id,
    now: new Date(),
  });
  check(
    "resuming a trial-end pause starts and bills the first term",
    r.subscription.status === "active" && r.invoice != null,
  );

  // The price's own value wins over the business default.
  const priceWins = await createPrice({
    organizationId: orgId,
    businessId: pau.biz.id,
    productId: pau.price.productId,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
    trialPeriod: 7,
    trialPeriodUnit: "day",
    trialEndAction: "activate_subscription",
  });
  const s4 = await endedTrial({ biz: pau.biz, price: priceWins }, "tok_4242");
  await renewSubscription(orgId, s4.id, new Date());
  check(
    "price trial_end_action wins over the business pause",
    (await getSub(s4.id)).status === "active",
  );

  // An operator's "end trial now" activates, whatever the default.
  const { c } = await customerWithCard(pau.biz.id, "tok_4242");
  const s5 = (
    await createSubscription({
      organizationId: orgId,
      businessId: pau.biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price: pau.price, quantity: 1 }],
      trialDays: 7,
    })
  ).subscription;
  await editTrialEnd({
    organizationId: orgId,
    businessId: pau.biz.id,
    subscriptionId: s5.id,
    immediately: true,
    now: new Date(),
  });
  check("end trial now ignores the business pause", (await getSub(s5.id)).status === "active");
}

// ── 2.8 Final period on a date-specific cancel ───────────────────────────────────────
async function scheduledCredit(
  rules: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
  perCall?: "none" | "prorate" | "full",
  finalPeriod?: "full_period" | "prorated" | "nothing",
) {
  const b = await newBiz(rules, extra);
  const { c, pm } = await customerWithCard(b.biz.id, "tok_4242");
  const s = (
    await createSubscription({
      organizationId: orgId,
      businessId: b.biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price: b.price, quantity: 1 }],
      defaultPaymentMethodId: pm!.id,
    })
  ).subscription;
  const out = await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: b.biz.id,
    subscriptionId: s.id,
    now: new Date(),
    cancelOption: "specific_date",
    cancelAt: new Date(Date.now() + 10 * 86_400_000),
    ...(perCall ? { creditOptionForCurrentTermCharges: perCall } : {}),
    ...(finalPeriod ? { finalPeriod } : {}),
  });
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .select({ payload: scheduledChanges.payload })
      .from(scheduledChanges)
      .where(eq(scheduledChanges.publicId, out.scheduledChange!))
      .limit(1),
  );
  return (row?.payload as { cancel?: { creditOptionForCurrentTermCharges?: string } })?.cancel
    ?.creditOptionForCurrentTermCharges;
}
{
  check(
    "specific-date cancel, unset → no credit (today)",
    (await scheduledCredit(undefined)) === "none",
  );
  check(
    "unset follows default_credit_option_for_cancel",
    (await scheduledCredit(undefined, { defaultCreditOptionForCancel: "prorate" })) === "prorate",
  );
  check(
    "full_period → no credit",
    (await scheduledCredit(
      { specific_date_cancel_final_period: "full_period" },
      {
        defaultCreditOptionForCancel: "full",
      },
    )) === "none",
  );
  check(
    "prorated → prorated credit",
    (await scheduledCredit({ specific_date_cancel_final_period: "prorated" })) === "prorate",
  );
  check(
    "nothing → full credit",
    (await scheduledCredit({ specific_date_cancel_final_period: "nothing" })) === "full",
  );
  check(
    "a per-call credit option wins",
    (await scheduledCredit({ specific_date_cancel_final_period: "nothing" }, {}, "none")) ===
      "none",
  );
  check(
    "per-call final_period full_period beats the business nothing",
    (await scheduledCredit(
      { specific_date_cancel_final_period: "nothing" },
      {},
      undefined,
      "full_period",
    )) === "none",
  );
  check(
    "per-call final_period prorated beats the business full_period",
    (await scheduledCredit(
      { specific_date_cancel_final_period: "full_period" },
      {},
      undefined,
      "prorated",
    )) === "prorate",
  );

  // Through the API: refusals, the estimate's resolution, and the cancel itself.
  const b = await newBiz({ specific_date_cancel_final_period: "nothing" });
  const { c, pm } = await customerWithCard(b.biz.id, "tok_4242");
  const s = (
    await createSubscription({
      organizationId: orgId,
      businessId: b.biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price: b.price, quantity: 1 }],
      defaultPaymentMethodId: pm!.id,
    })
  ).subscription;
  const base = `/v1/businesses/${b.biz.publicId}/subscriptions/${s.publicId}`;
  const cancelAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const endTerm = await req("POST", `${base}/cancel`, {
    cancel_option: "end_of_term",
    final_period: "prorated",
  });
  const both = await req("POST", `${base}/cancel_estimate`, {
    cancel_option: "specific_date",
    cancel_at: cancelAt,
    final_period: "prorated",
    credit_option_for_current_term_charges: "full",
  });
  check(
    "final_period: refused with end_of_term, and with a credit option",
    endTerm.statusCode === 400 && both.statusCode === 400,
    `${endTerm.statusCode} ${both.statusCode} ${endTerm.payload}`,
  );
  const estOmit = json(
    await req("POST", `${base}/cancel_estimate`, {
      cancel_option: "specific_date",
      cancel_at: cancelAt,
    }),
  );
  const estOver = json(
    await req("POST", `${base}/cancel_estimate`, {
      cancel_option: "specific_date",
      cancel_at: cancelAt,
      final_period: "prorated",
    }),
  );
  check(
    "cancel estimate: omitted = the business final period; final_period overrides it",
    estOmit.options?.credit_option === "full" && estOver.options?.credit_option === "prorate",
    `${estOmit.options?.credit_option} ${estOver.options?.credit_option}`,
  );
  const done = await req("POST", `${base}/cancel`, {
    cancel_option: "specific_date",
    cancel_at: cancelAt,
    final_period: "full_period",
  });
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .select({ payload: scheduledChanges.payload })
      .from(scheduledChanges)
      .where(eq(scheduledChanges.publicId, json(done).scheduled_change ?? ""))
      .limit(1),
  );
  check(
    "API cancel: final_period full_period schedules no credit over the business nothing",
    done.statusCode === 200 &&
      (row?.payload as { cancel?: { creditOptionForCurrentTermCharges?: string } })?.cancel
        ?.creditOptionForCurrentTermCharges === "none",
    `${done.statusCode} ${JSON.stringify(row?.payload)}`,
  );
}

// ── 2.9 Required reasons (through the API) ──────────────────────────────────────────
{
  const strict = await newBiz({
    required_reasons: {
      cancel_subscription: true,
      void_invoice: true,
      create_credit_note: true,
      refund: true,
    },
  });
  const loose = await newBiz();
  const pidOf = async (id: string) =>
    (
      await systemDb
        .select({ p: businesses.publicId })
        .from(businesses)
        .where(eq(businesses.id, id))
        .limit(1)
    )[0]!.p;
  for (const [label, b, required] of [
    ["required", strict, true],
    ["not required", loose, false],
  ] as const) {
    const bizPid = await pidOf(b.biz.id);
    const { c, pm } = await customerWithCard(b.biz.id, "tok_4242");
    const s = (
      await createSubscription({
        organizationId: orgId,
        businessId: b.biz.id,
        customerId: c.id,
        now: new Date(),
        items: [{ price: b.price, quantity: 1 }],
        defaultPaymentMethodId: pm!.id,
      })
    ).subscription;
    const cancel = await req(
      "POST",
      `/v1/businesses/${bizPid}/subscriptions/${s.publicId}/cancel`,
      {
        cancel_option: "end_of_term",
      },
    );
    const cancelMsg = json(cancel).error?.message ?? "";
    check(
      `cancel without a reason code, ${label}`,
      required
        ? cancel.statusCode === 400 && cancelMsg.startsWith("We could not cancel the subscription.")
        : cancel.statusCode === 200,
      `${cancel.statusCode} ${cancelMsg}`,
    );
    if (required) {
      const ok = await req("POST", `/v1/businesses/${bizPid}/subscriptions/${s.publicId}/cancel`, {
        cancel_option: "end_of_term",
        cancel_reason_code: "pricing_high",
      });
      check("cancel with a reason code, required → 200", ok.statusCode === 200);
    }
    const inv = json(
      await req("POST", `/v1/businesses/${bizPid}/invoices`, {
        customer: c.publicId,
        lines: [{ description: "Setup", amount_minor: 5000 }],
        collect: false,
      }),
    );
    const cn = await req("POST", `/v1/businesses/${bizPid}/credit_notes`, {
      invoice: inv.id,
      kind: "adjustment",
      items: [{ description: "Goodwill", amount_minor: 100 }],
    });
    check(
      `credit note without a reason code, ${label}`,
      required
        ? cn.statusCode === 400 &&
            (json(cn).error?.message ?? "").startsWith("We could not create the credit note.")
        : cn.statusCode === 201,
      `${cn.statusCode} ${cn.payload.slice(0, 200)}`,
    );
    if (required) {
      const ok = await req("POST", `/v1/businesses/${bizPid}/credit_notes`, {
        invoice: inv.id,
        kind: "adjustment",
        reason_code: "other",
        items: [{ description: "Goodwill", amount_minor: 100 }],
      });
      check("credit note with a reason code, required → 201", ok.statusCode === 201);
    }
    const refund = await req(
      "POST",
      `/v1/businesses/${bizPid}/payments/pay_XXXXXXXXXXXX01/refund`,
      {},
    );
    const refundMsg = json(refund).error?.message ?? "";
    check(
      `refund without a reason, ${label}`,
      required
        ? refund.statusCode === 400 && refundMsg.startsWith("We could not refund the payment.")
        : !refundMsg.startsWith("We could not refund the payment. This business"),
      `${refund.statusCode} ${refundMsg}`,
    );
    if (required) {
      const withReason = await req(
        "POST",
        `/v1/businesses/${bizPid}/payments/pay_XXXXXXXXXXXX01/refund`,
        { reason: "Duplicate charge" },
      );
      check(
        "refund with a reason passes the reason check",
        !(json(withReason).error?.message ?? "").startsWith(
          "We could not refund the payment. This",
        ),
      );
    }
    const voidRes = await req("POST", `/v1/businesses/${bizPid}/invoices/${inv.id}/void`, {});
    check(
      `void without a reason, ${label}`,
      required
        ? voidRes.statusCode === 400 &&
            (json(voidRes).error?.message ?? "").startsWith("We could not void the invoice.")
        : voidRes.statusCode === 200,
      `${voidRes.statusCode} ${voidRes.payload.slice(0, 200)}`,
    );
    if (required) {
      const ok = await req("POST", `/v1/businesses/${bizPid}/invoices/${inv.id}/void`, {
        void_reason_code: "duplicate",
      });
      check("void with a reason, required → 200", ok.statusCode === 200, ok.payload.slice(0, 200));
    }
  }
}

// ── 2.40 Failed mid-term change charge ──────────────────────────────────────────────
async function failedChange(rules?: Record<string, unknown>, viaRoute?: Record<string, unknown>) {
  const b = await newBiz(rules);
  // No trial: a trialing subscription raises no change charge.
  const price = await createPrice({
    organizationId: orgId,
    businessId: b.biz.id,
    productId: b.price.productId,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  // Vaults, then every charge fails retriably.
  const { c, pm } = await customerWithCard(b.biz.id, "4000000000000341");
  const created = await createSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm!.id,
  });
  const s = created.subscription;
  if (viaRoute) {
    // `POST …/change` with this call's own fields.
    const r = await req(
      "POST",
      `/v1/businesses/${b.biz.publicId}/subscriptions/${s.publicId}/change`,
      {
        changes: [{ item: created.items[0]!.publicId, quantity: 3 }],
        invoice_immediately: true,
        timing: "now",
        ...viaRoute,
      },
    );
    const invId = json(r).proration_invoice?.id as string | undefined;
    const inv = invId
      ? (
          await withTenant(orgId, (tx) =>
            tx.select().from(invoices).where(eq(invoices.publicId, invId)).limit(1),
          )
        )[0]!
      : null;
    return { sub: await getSub(s.id), inv, payment: null, status: r.statusCode };
  }
  const out = await changeSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    subscriptionId: s.id,
    now: new Date(),
    changes: [{ itemId: created.items[0]!.publicId, newQuantity: 3 }],
    invoiceImmediately: true,
  });
  const inv = out.prorationInvoice
    ? (
        await withTenant(orgId, (tx) =>
          tx.select().from(invoices).where(eq(invoices.id, out.prorationInvoice!.id)).limit(1),
        )
      )[0]!
    : null;
  return { sub: await getSub(s.id), inv, payment: out.payment, status: 200 };
}
{
  const today = await failedChange();
  check(
    "failed change charge, unset → dunning retries before term end (today)",
    today.payment?.status === "failed" &&
      today.inv?.status === "payment_due" &&
      today.inv.dunningStatus === "in_progress" &&
      today.inv.nextAttemptAt != null &&
      today.inv.nextAttemptAt < today.sub.currentPeriodEnd! &&
      today.inv.dunningPause == null,
    `${today.payment?.status} ${today.inv?.status} ${today.inv?.dunningStatus} ${today.inv?.nextAttemptAt?.toISOString()}`,
  );
  const dun = await failedChange({ failed_change_charge: "start_dunning" });
  check(
    "start_dunning → retry armed before term end",
    dun.inv?.nextAttemptAt != null && dun.inv.nextAttemptAt < dun.sub.currentPeriodEnd!,
  );
  const next = await failedChange({ failed_change_charge: "next_renewal" });
  check(
    "next_renewal → retry held until the term ends, change kept",
    next.inv?.status === "payment_due" &&
      next.inv.nextAttemptAt?.getTime() === next.sub.currentPeriodEnd?.getTime() &&
      next.inv.dunningPause != null,
    `${next.inv?.nextAttemptAt?.toISOString()} vs ${next.sub.currentPeriodEnd?.toISOString()}`,
  );
  // `on_charge_failure` on `POST …/change` overrides the rule for one call.
  const held = await failedChange(
    { failed_change_charge: "start_dunning" },
    { on_charge_failure: "next_renewal" },
  );
  check(
    "override: rule start_dunning + on_charge_failure next_renewal → retry held to term end",
    held.status === 200 &&
      held.inv?.status === "payment_due" &&
      held.inv.nextAttemptAt?.getTime() === held.sub.currentPeriodEnd?.getTime() &&
      held.inv.dunningPause != null,
    `${held.status} ${held.inv?.status} ${held.inv?.nextAttemptAt?.toISOString()}`,
  );
  const now = await failedChange(
    { failed_change_charge: "next_renewal" },
    { on_charge_failure: "start_dunning" },
  );
  check(
    "override: rule next_renewal + on_charge_failure start_dunning → retry before term end",
    now.status === 200 &&
      now.inv?.nextAttemptAt != null &&
      now.inv.nextAttemptAt < now.sub.currentPeriodEnd! &&
      now.inv.dunningPause == null,
    `${now.status} ${now.inv?.nextAttemptAt?.toISOString()}`,
  );
  const omitted = await failedChange({ failed_change_charge: "next_renewal" }, {});
  check(
    "override: on_charge_failure omitted on the route → the rule (held)",
    omitted.status === 200 &&
      omitted.inv?.nextAttemptAt?.getTime() === omitted.sub.currentPeriodEnd?.getTime(),
    `${omitted.status} ${omitted.inv?.nextAttemptAt?.toISOString()}`,
  );
}

// ── 2.67 New-customer auto-collection ───────────────────────────────────────────────
{
  const on = await newBiz();
  const off = await newBiz({ new_customer_auto_collection: "off" });
  const pid = async (id: string) =>
    (
      await systemDb
        .select({ p: businesses.publicId })
        .from(businesses)
        .where(eq(businesses.id, id))
        .limit(1)
    )[0]!.p;
  const mk = async (bizId: string, body: Record<string, unknown>) =>
    json(
      await req("POST", `/v1/businesses/${await pid(bizId)}/customers`, {
        email: `n${Math.random().toString(36).slice(2)}@example.com`,
        ...body,
      }),
    );
  check("unset → new customer on (today)", (await mk(on.biz.id, {})).auto_collection === "on");
  check("off → new customer off", (await mk(off.biz.id, {})).auto_collection === "off");
  check(
    "an explicit auto_collection wins",
    (await mk(off.biz.id, { auto_collection: "on" })).auto_collection === "on",
  );
  const viaService = await createCustomer({
    organizationId: orgId,
    businessId: off.biz.id,
    email: "checkout@example.com",
  });
  check("engine-created customers (checkout) stay on", viaService.autoCollection === "on");
}

// ── 2.22 Mandate revoked ─────────────────────────────────────────────────────────────
const REVOKED = "4000000000000150";
async function revoked(
  rules?: Record<string, unknown>,
  dunningConfig?: Record<string, unknown>,
  email?: string,
) {
  const b = await newBiz(rules, dunningConfig ? { dunningConfig } : {});
  const s = await endedTrial(b, REVOKED, email);
  await renewSubscription(orgId, s.id, new Date());
  return { sub: await getSub(s.id), inv: await newestInvoice(s.id) };
}
{
  const today = await revoked();
  check(
    "revoked mandate, unset → dunning ends and the end action cancels (today)",
    today.inv?.status === "not_paid" &&
      today.inv.dunningStatus === "exhausted" &&
      today.sub.status === "cancelled",
    `${today.inv?.status}/${today.inv?.dunningStatus} sub=${today.sub.status}`,
  );
  const retain = { final_action: { invoice: "not_paid", subscription: "retain" } };
  const follow = await revoked({ mandate_revoked: "follow_dunning" }, retain);
  check(
    "follow_dunning → the configured end action (retain keeps it active)",
    follow.inv?.dunningStatus === "exhausted" && follow.sub.status === "active",
    `${follow.inv?.dunningStatus} sub=${follow.sub.status}`,
  );
  const now = await revoked({ mandate_revoked: "cancel_now" }, retain);
  check(
    "cancel_now → cancelled even when the end action retains",
    now.inv?.status === "not_paid" && now.sub.status === "cancelled",
    `${now.inv?.status} sub=${now.sub.status}`,
  );
  const term = await revoked({ mandate_revoked: "cancel_at_term_end" });
  check(
    "cancel_at_term_end → active, cancels at term end",
    term.inv?.status === "not_paid" && term.sub.status === "active" && term.sub.cancelAtPeriodEnd,
    `${term.inv?.status} sub=${term.sub.status} flag=${term.sub.cancelAtPeriodEnd}`,
  );
  const pause = await revoked({ mandate_revoked: "pause" });
  check(
    "pause → paused, invoice still gets the end action",
    pause.inv?.status === "not_paid" && pause.sub.status === "paused",
    `${pause.inv?.status} sub=${pause.sub.status}`,
  );
  // The customer is a team member so test mode lets the request email go out.
  const email = `member-${Date.now()}@example.com`;
  const [u] = await systemDb
    .insert(users)
    .values({ publicId: publicId("usr"), email })
    .returning();
  await systemDb
    .insert(memberships)
    .values({ organizationId: orgId, userId: u!.id, role: "admin" });
  const ask = await revoked({ mandate_revoked: "request_new_mandate" }, undefined, email);
  check(
    "request_new_mandate → invoice parked, subscription kept",
    ask.inv?.status === "payment_due" &&
      ask.inv.dunningStatus === "parked" &&
      ask.inv.nextAttemptAt === null &&
      ask.sub.status === "active",
    `${ask.inv?.status}/${ask.inv?.dunningStatus} sub=${ask.sub.status}`,
  );
  const mails = await withTenant(orgId, (tx) =>
    tx
      .select({ type: emailMessages.type })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.customerId, ask.sub.customerId),
          eq(emailMessages.type, "payment_method_request"),
        ),
      ),
  );
  check(
    "request_new_mandate → one payment method request email recorded",
    mails.length === 1,
    `${mails.length}`,
  );
}

// ── Review fixes: revoked mandates, async paths, the parked sweep, change holds ───────
const retainSmart = {
  mode: "smart",
  final_action: { invoice: "not_paid", subscription: "retain" },
};
const presentedOn = (pmId: string) =>
  withTenant(orgId, async (tx) =>
    (
      await tx
        .select({ id: payments.id, provider: payments.providerKey })
        .from(payments)
        .where(eq(payments.paymentMethodId, pmId))
    ).filter((p) => p.provider !== "none"),
  );
const pmOfSub = async (subId: string) => (await getSub(subId)).defaultPaymentMethodId!;
async function noTrialPrice(bizId: string, productId: string, interval: "month" | "year") {
  return createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: interval === "year" ? 12000 : 1000,
    interval,
  });
}
const invoiceRow = async (id: string) =>
  (
    await withTenant(orgId, (tx) => tx.select().from(invoices).where(eq(invoices.id, id)).limit(1))
  )[0]!;

// 1. request_new_mandate never presents the revoked mandate again.
{
  const parkedSweep = await revoked({ mandate_revoked: "request_new_mandate" });
  const pm = await pmOfSub(parkedSweep.sub.id);
  await systemDb
    .update(invoices)
    .set({ dunningParkedAt: new Date(Date.now() - 400 * 86_400_000) })
    .where(eq(invoices.id, parkedSweep.inv!.id));
  const now = new Date();
  await runWithClockScope({ onlyBusinessId: parkedSweep.sub.businessId, now }, () =>
    sweepExpiredParkedDunning(now),
  );
  check(
    "fix 1: the parked deadline does not charge the revoked mandate again",
    (await presentedOn(pm)).length === 1,
    `${(await presentedOn(pm)).length} presentations`,
  );

  const parkedRenew = await revoked({ mandate_revoked: "request_new_mandate" });
  const pm2 = await pmOfSub(parkedRenew.sub.id);
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: new Date(Date.now() - 60_000) })
    .where(eq(subscriptions.id, parkedRenew.sub.id));
  await renewSubscription(orgId, parkedRenew.sub.id, new Date());
  const renewal = await newestInvoice(parkedRenew.sub.id);
  check(
    "fix 1: a renewal inside the park window does not charge the revoked mandate",
    (await presentedOn(pm2)).length === 1 &&
      renewal?.id !== parkedRenew.inv!.id &&
      renewal?.dunningStatus === "parked",
    `${(await presentedOn(pm2)).length} presentations, renewal ${renewal?.status}/${renewal?.dunningStatus}`,
  );
}

// 2. Async: a pending debit that the gateway later refuses as revoked.
{
  const b = await newBiz({ mandate_revoked: "cancel_now" }, { dunningConfig: retainSmart });
  const s = await endedTrial(b, "4000000000000101"); // async: the charge stays pending
  await renewSubscription(orgId, s.id, new Date());
  const inv = await newestInvoice(s.id);
  const [pending] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, inv!.id), eq(payments.status, "pending")))
      .limit(1),
  );
  await withTenant(orgId, (tx) =>
    settlePaymentFailed(tx, {
      organizationId: orgId,
      businessId: b.biz.id,
      paymentId: pending!.id,
      errorCode: "revocation_of_authorization",
      retriable: false,
    }),
  );
  const after = await getSub(s.id);
  check(
    "fix 2: an async revoked debit runs the subscription action (settlement)",
    !!pending && after.status === "cancelled",
    `pending=${!!pending} sub=${after.status}`,
  );
}
{
  const b = await newBiz({ mandate_revoked: "pause" }, { dunningConfig: retainSmart });
  const monthly = await noTrialPrice(b.biz.id, b.price.productId, "month");
  const { c, pm } = await customerWithCard(b.biz.id, "tok_4242");
  const created = await createSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: monthly, quantity: 1 }],
    defaultPaymentMethodId: pm!.id,
  });
  const { invoice: paid } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    subscriptionId: created.subscription.id,
    currency: "USD",
    lines: [{ description: "Term", amountMinor: 1000n, kind: "one_time" }],
    collect: true,
    subscription: created.subscription,
  });
  const [payRow] = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, paid.id)).limit(1),
  );
  const rid = Math.random().toString(36).slice(2);
  await recordTransaction({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    type: "payment",
    status: "succeeded",
    amountMinor: 1000n,
    currency: "USD",
    gatewayKey: "tmtest",
    idAtGateway: `tmch_rev_${rid}`,
    invoiceId: paid.id,
    paymentId: payRow!.id,
  });
  await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_rev_${rid}`,
      type: "charge.failed",
      providerChargeId: `tmch_rev_${rid}`,
      occurredAt: new Date(),
      failureCode: "revocation_of_authorization",
      raw: { data: { reversal: true } },
    },
    { businessId: b.biz.id, payload: { id: `tmev_rev_${rid}` } },
  );
  const inv = await invoiceRow(paid.id);
  const after = await getSub(created.subscription.id);
  check(
    "fix 2: a revoked reversal runs the subscription action (webhook)",
    paid.status === "paid" && inv.dunningStatus === "exhausted" && after.status === "paused",
    `paid=${paid.status} inv=${inv.status}/${inv.dunningStatus} sub=${after.status}`,
  );
}

// 3. The parked sweep runs the end action when its own deadline attempt ends dunning.
{
  const b = await newBiz({ mandate_revoked: "cancel_now" }, { dunningConfig: retainSmart });
  const s = await endedTrial(b, "4000000000000069"); // expired card: smart mode parks
  await renewSubscription(orgId, s.id, new Date());
  const inv = await newestInvoice(s.id);
  // The customer's next card is one whose mandate the payer then revokes.
  const [cRow] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.id, s.customerId)).limit(1),
  );
  const pmNew = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: b.biz.id,
    customer: cRow!,
    token: "4000000000000150",
  });
  await systemDb
    .update(subscriptions)
    .set({ defaultPaymentMethodId: pmNew.id })
    .where(eq(subscriptions.id, s.id));
  // Parked, with its window long past (as a park on the expired card leaves it).
  await systemDb
    .update(invoices)
    .set({
      status: "payment_due",
      dunningStatus: "parked",
      nextAttemptAt: null,
      dunningParkedAt: new Date(Date.now() - 400 * 86_400_000),
    })
    .where(eq(invoices.id, inv!.id));
  const parkedBefore = (await invoiceRow(inv!.id)).dunningStatus;
  const now = new Date();
  await runWithClockScope({ onlyBusinessId: b.biz.id, now }, () => sweepExpiredParkedDunning(now));
  const after = await getSub(s.id);
  const invAfter = await invoiceRow(inv!.id);
  check(
    "fix 3: a deadline attempt that ends dunning runs the end action",
    parkedBefore === "parked" &&
      invAfter.dunningStatus === "exhausted" &&
      after.status === "cancelled",
    `before=${parkedBefore} after=${invAfter.status}/${invAfter.dunningStatus} sub=${after.status}`,
  );
}

// 4. The governing decline decides, not a backup booked after it.
{
  const b = await newBiz({ mandate_revoked: "cancel_now" }, { dunningConfig: retainSmart });
  const monthly = await noTrialPrice(b.biz.id, b.price.productId, "month");
  const { c, pm: soft } = await customerWithCard(b.biz.id, "4000000000009995"); // retriable
  const backup = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: b.biz.id,
    customer: c,
    token: "4000000000000150",
  });
  await systemDb
    .update(paymentMethods)
    .set({ role: "primary" })
    .where(eq(paymentMethods.id, soft!.id));
  await systemDb
    .update(paymentMethods)
    .set({ role: "backup" })
    .where(eq(paymentMethods.id, backup.id));
  const created = await createSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: monthly, quantity: 1 }],
    defaultPaymentMethodId: soft!.id,
  });
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    subscriptionId: created.subscription.id,
    currency: "USD",
    lines: [{ description: "Term", amountMinor: 1000n, kind: "one_time" }],
    collect: false,
    subscription: created.subscription,
  });
  // The last rung of the schedule: this run exhausts dunning.
  await systemDb.update(invoices).set({ attemptCount: 20 }).where(eq(invoices.id, invoice.id));
  await collectInvoice({
    organizationId: orgId,
    businessId: b.biz.id,
    invoice: await invoiceRow(invoice.id),
    subscription: created.subscription,
  });
  const inv = await invoiceRow(invoice.id);
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ code: payments.failureCode })
      .from(payments)
      .where(eq(payments.invoiceId, invoice.id))
      .orderBy(desc(payments.createdAt)),
  );
  if (inv.status === "not_paid") {
    const config = await withTenant(orgId, (tx) =>
      loadEffectiveDunningConfig(tx, { businessId: b.biz.id, customerId: c.id }),
    );
    await applyDunningFinalAction({
      organizationId: orgId,
      businessId: b.biz.id,
      invoicePublicId: inv.publicId,
      subscriptionId: created.subscription.id,
      subscriptionPublicId: null,
      config,
    });
  }
  const after = await getSub(created.subscription.id);
  check(
    "fix 4: a revoked backup booked after a soft governing decline does not cancel",
    inv.dunningStatus === "exhausted" &&
      rows[0]?.code === "revocation_of_authorization" &&
      after.status === "active",
    `inv=${inv.dunningStatus}/${inv.dunningExhaustedCode} newest=${rows[0]?.code} sub=${after.status}`,
  );
}

// 5. next_renewal: no year-long hold after a term reset; pending charges are held too.
async function changeWith(token: string, toYearly: boolean) {
  const b = await newBiz({ failed_change_charge: "next_renewal" });
  const monthly = await noTrialPrice(b.biz.id, b.price.productId, "month");
  const yearly = await noTrialPrice(b.biz.id, b.price.productId, "year");
  const { c, pm } = await customerWithCard(b.biz.id, token);
  const created = await createSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: monthly, quantity: 1 }],
    defaultPaymentMethodId: pm!.id,
  });
  const before = created.subscription.currentPeriodEnd!;
  const out = await changeSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    subscriptionId: created.subscription.id,
    now: new Date(),
    changes: [
      toYearly
        ? { itemId: created.items[0]!.publicId, newPriceId: yearly.publicId }
        : { itemId: created.items[0]!.publicId, newQuantity: 3 },
    ],
    invoiceImmediately: true,
  });
  return { b, before, out, sub: await getSub(created.subscription.id) };
}
{
  const r = await changeWith("4000000000000341", true);
  const inv = await invoiceRow(r.out.prorationInvoice!.id);
  check(
    "fix 5: a failed charge after a term reset starts dunning, not a year-long hold",
    r.out.payment?.status === "failed" &&
      inv.dunningPause == null &&
      inv.nextAttemptAt != null &&
      inv.nextAttemptAt.getTime() < Date.now() + 30 * 86_400_000,
    `${inv.nextAttemptAt?.toISOString()} pause=${JSON.stringify(inv.dunningPause)}`,
  );
}
{
  const r = await changeWith("4000000000000101", false); // pending, refused later
  const pending = r.out.payment;
  if (pending?.status === "pending")
    await withTenant(orgId, (tx) =>
      settlePaymentFailed(tx, {
        organizationId: orgId,
        businessId: r.b.biz.id,
        paymentId: pending.id,
        errorCode: "insufficient_funds",
        retriable: true,
      }),
    );
  const inv = await invoiceRow(r.out.prorationInvoice!.id);
  check(
    "gap: a pending change charge that fails later is held until the term ends",
    pending?.status === "pending" &&
      inv.nextAttemptAt?.getTime() === r.sub.currentPeriodEnd?.getTime() &&
      inv.dunningPause != null,
    `${pending?.status} ${inv.nextAttemptAt?.toISOString()} vs ${r.sub.currentPeriodEnd?.toISOString()}`,
  );
}

// ── Second review ──────────────────────────────────────────────────────────────────
const pmRow = async (id: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(paymentMethods).where(eq(paymentMethods.id, id)).limit(1),
    )
  )[0]!;
const blockOf = async (pmId: string) =>
  (await presentationBlock({ organizationId: orgId, pm: await pmRow(pmId), now: new Date() }))
    ?.reason ?? null;

// A. New authority on the same instrument clears the block.
{
  const r = await revoked({ mandate_revoked: "request_new_mandate" });
  const pm = await pmOfSub(r.sub.id);
  const blocked = await blockOf(pm);
  await systemDb
    .update(paymentMethods)
    .set({ mandateStatus: "pending" })
    .where(eq(paymentMethods.id, pm));
  await applyMandateStatus(await pmRow(pm), { status: "active" });
  check(
    "A: a mandate that goes live again clears the revoked-mandate block",
    blocked === "mandate_revoked" &&
      (await blockOf(pm)) === null &&
      (await pmRow(pm)).authorizedAt != null,
    `before=${blocked} after=${await blockOf(pm)}`,
  );
  const r2 = await revoked({ mandate_revoked: "request_new_mandate" });
  const pm2 = await pmOfSub(r2.sub.id);
  // The same-card re-vault writes this stamp (payment-methods/service.ts); the test
  // gateway reports no fingerprint, so the stamp is set directly here.
  await systemDb
    .update(paymentMethods)
    .set({ authorizedAt: new Date() })
    .where(eq(paymentMethods.id, pm2));
  check("A: a re-authorised instrument is not blocked", (await blockOf(pm2)) === null);
}

// B. A revocation that arrives as a reversal of a settled debit.
async function revokedReversal(rules: Record<string, unknown>) {
  const b = await newBiz(rules, { dunningConfig: retainSmart });
  const monthly = await noTrialPrice(b.biz.id, b.price.productId, "month");
  const { c, pm } = await customerWithCard(b.biz.id, "tok_4242");
  const created = await createSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: monthly, quantity: 1 }],
    defaultPaymentMethodId: pm!.id,
  });
  const { invoice: paid } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    subscriptionId: created.subscription.id,
    currency: "USD",
    lines: [{ description: "Term", amountMinor: 1000n, kind: "one_time" }],
    collect: true,
    subscription: created.subscription,
  });
  const [payRow] = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, paid.id)).limit(1),
  );
  const rid = Math.random().toString(36).slice(2);
  await recordTransaction({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    type: "payment",
    status: "succeeded",
    amountMinor: 1000n,
    currency: "USD",
    gatewayKey: "tmtest",
    idAtGateway: `tmch_rev_${rid}`,
    invoiceId: paid.id,
    paymentId: payRow!.id,
  });
  await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_rev_${rid}`,
      type: "charge.failed",
      providerChargeId: `tmch_rev_${rid}`,
      occurredAt: new Date(),
      failureCode: "revocation_of_authorization",
      raw: { data: { reversal: true } },
    },
    { businessId: b.biz.id, payload: { id: `tmev_rev_${rid}` } },
  );
  return { b, sub: created.subscription, inv: await invoiceRow(paid.id), pm: pm!.id };
}
{
  const r = await revokedReversal({ mandate_revoked: "request_new_mandate" });
  await systemDb
    .update(invoices)
    .set({ dunningParkedAt: new Date(Date.now() - 400 * 86_400_000) })
    .where(eq(invoices.id, r.inv.id));
  const now = new Date();
  await runWithClockScope({ onlyBusinessId: r.b.biz.id, now }, () =>
    sweepExpiredParkedDunning(now),
  );
  check(
    "B: a reversed revoked debit is not presented again at the park deadline",
    r.inv.dunningStatus === "parked" && (await presentedOn(r.pm)).length === 1,
    `${r.inv.dunningStatus} presentations=${(await presentedOn(r.pm)).length}`,
  );
}
{
  const r = await revokedReversal({ mandate_revoked: "pause" });
  await resumeSubscriptionWithOptions({
    organizationId: orgId,
    businessId: r.b.biz.id,
    subscriptionId: r.sub.id,
    now: new Date(),
  });
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: new Date(Date.now() - 60_000) })
    .where(eq(subscriptions.id, r.sub.id));
  await renewSubscription(orgId, r.sub.id, new Date());
  check(
    "B: after a revoked reversal and a resume, the renewal does not charge the mandate",
    (await getSub(r.sub.id)).status !== "cancelled" && (await presentedOn(r.pm)).length === 1,
    `presentations=${(await presentedOn(r.pm)).length}`,
  );
}

// C. A stale exhaust code does not steer a later, decline-free exhaustion.
{
  const b = await newBiz({ mandate_revoked: "cancel_now" }, { dunningConfig: retainSmart });
  const monthly = await noTrialPrice(b.biz.id, b.price.productId, "month");
  const { c } = await customerWithCard(b.biz.id, null); // nothing to present at the deadline
  const created = await createSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: monthly, quantity: 1 }],
    autoCollection: "on",
  });
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    subscriptionId: created.subscription.id,
    currency: "USD",
    lines: [{ description: "Term", amountMinor: 1000n, kind: "one_time" }],
    collect: false,
    subscription: created.subscription,
  });
  // Exhausted on a revocation once, then back in dunning and parked.
  await systemDb
    .update(invoices)
    .set({
      status: "payment_due",
      dunningStatus: "parked",
      nextAttemptAt: null,
      dunningExhaustedCode: "revocation_of_authorization",
      dunningParkedAt: new Date(Date.now() - 400 * 86_400_000),
    })
    .where(eq(invoices.id, invoice.id));
  const now = new Date();
  await runWithClockScope({ onlyBusinessId: b.biz.id, now }, () => sweepExpiredParkedDunning(now));
  const inv = await invoiceRow(invoice.id);
  check(
    "C: a park that closes without a decline follows the end action, not a stale code",
    inv.dunningStatus === "exhausted" &&
      inv.dunningExhaustedCode === null &&
      (await getSub(created.subscription.id)).status === "active",
    `${inv.dunningStatus}/${inv.dunningExhaustedCode} sub=${(await getSub(created.subscription.id)).status}`,
  );
}

// D + E. A held change invoice: the events name the held date; a resume lifts the hold.
{
  const r = await changeWith("4000000000000341", false);
  const held = await invoiceRow(r.out.prorationInvoice!.id);
  // The payer's mail reads the retry date off `payment_failed`.
  const failedEvents = await withTenant(orgId, (tx) =>
    tx
      .select({ data: events.data })
      .from(events)
      .where(eq(events.type, "payment_failed"))
      .orderBy(desc(events.createdAt)),
  );
  const mine = failedEvents
    .map((e) => e.data as Record<string, Record<string, unknown> | unknown>)
    .find((d) => JSON.stringify(d).includes(held.publicId));
  const pay = (mine?.payment ?? {}) as Record<string, unknown>;
  const published = (pay.next_attempt_at ??
    (mine as Record<string, unknown> | undefined)?.next_attempt_at) as string | undefined;
  check(
    "E: payment_failed publishes the held retry date",
    published != null && new Date(published).getTime() === held.nextAttemptAt?.getTime(),
    `published=${published} written=${held.nextAttemptAt?.toISOString()}`,
  );
  await resumeDunning(orgId, r.b.biz.id, held.publicId);
  // The restored retry comes due, as the dunning pass would find it.
  await systemDb
    .update(invoices)
    .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
    .where(eq(invoices.id, held.id));
  await collectInvoice({
    organizationId: orgId,
    businessId: r.b.biz.id,
    invoice: await invoiceRow(held.id),
    subscription: r.sub,
  });
  const after = await invoiceRow(held.id);
  check(
    "D: after a resume, the next failure follows the schedule, not the term end",
    after.retryHoldUntil === null &&
      after.dunningPause == null &&
      after.nextAttemptAt != null &&
      after.nextAttemptAt < r.sub.currentPeriodEnd!,
    `hold=${after.retryHoldUntil?.toISOString()} next=${after.nextAttemptAt?.toISOString()}`,
  );
}

// Deliberate change: under follow_dunning, a deadline attempt that ends dunning runs the end action.
{
  const b = await newBiz(undefined, { dunningConfig: { mode: "smart" } });
  const s = await endedTrial(b, "4000000000000069"); // the conversion charge fails
  await renewSubscription(orgId, s.id, new Date());
  const inv = await newestInvoice(s.id);
  const [cRow] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.id, s.customerId)).limit(1),
  );
  const pmNew = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: b.biz.id,
    customer: cRow!,
    token: "4000000000000150",
  });
  await systemDb
    .update(subscriptions)
    .set({ defaultPaymentMethodId: pmNew.id })
    .where(eq(subscriptions.id, s.id));
  await systemDb
    .update(invoices)
    .set({
      status: "payment_due",
      dunningStatus: "parked",
      nextAttemptAt: null,
      dunningParkedAt: new Date(Date.now() - 400 * 86_400_000),
    })
    .where(eq(invoices.id, inv!.id));
  const now = new Date();
  await runWithClockScope({ onlyBusinessId: b.biz.id, now }, () => sweepExpiredParkedDunning(now));
  const invAfter = await invoiceRow(inv!.id);
  check(
    "sweep: under follow_dunning a terminal deadline decline runs the end action (cancel)",
    invAfter.dunningStatus === "exhausted" && (await getSub(s.id)).status === "cancelled",
    `${invAfter.status}/${invAfter.dunningStatus} sub=${(await getSub(s.id)).status}`,
  );
}

// ── Round 4 ──────────────────────────────────────────────────────────────────────
// 1. A reversed payment-request debit re-arms like a direct reversal.
async function reversedRequestDebit(rules?: Record<string, unknown>) {
  const b = await newBiz(rules, { dunningConfig: { mode: "smart" } });
  const monthly = await noTrialPrice(b.biz.id, b.price.productId, "month");
  const { c, pm } = await customerWithCard(b.biz.id, "tok_4242");
  const created = await createSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: monthly, quantity: 1 }],
    defaultPaymentMethodId: pm!.id,
  });
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    subscriptionId: created.subscription.id,
    currency: "USD",
    lines: [{ description: "Term", amountMinor: 1000n, kind: "one_time" }],
    collect: false,
    subscription: created.subscription,
  });
  const [bizRow] = await systemDb
    .select({ p: businesses.publicId })
    .from(businesses)
    .where(eq(businesses.id, b.biz.id))
    .limit(1);
  const res = json(
    await req("POST", `/v1/businesses/${bizRow!.p}/customers/${c.publicId}/payment_requests`, {
      invoices: [invoice.publicId],
      mode: "charge",
      payment_method: pm!.publicId,
    }),
  );
  const [prq] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentRequests).where(eq(paymentRequests.publicId, res.id)).limit(1),
  );
  await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_prq_${Math.random().toString(36).slice(2)}`,
      type: "charge.failed",
      providerChargeId: prq!.providerChargeId!,
      occurredAt: new Date(),
      failureCode: "revocation_of_authorization",
      failureRetriable: false,
      raw: { data: { reversal: true } },
    },
    { businessId: b.biz.id },
  );
  const kids = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, invoice.id)),
  );
  return { paidFirst: prq?.status, inv: await invoiceRow(invoice.id), kids, pm: pm!.id };
}
{
  const r = await reversedRequestDebit({ mandate_revoked: "request_new_mandate" });
  check(
    "1: a reversed request debit on a revoked mandate parks and blocks the mandate",
    r.inv.status === "payment_due" &&
      r.inv.dunningStatus === "parked" &&
      r.kids.some((k) => k.reversalCode === "revocation_of_authorization") &&
      (await blockOf(r.pm)) === "mandate_revoked",
    `req=${r.paidFirst} inv=${r.inv.status}/${r.inv.dunningStatus} next=${r.inv.nextAttemptAt?.toISOString()} block=${await blockOf(r.pm)}`,
  );
  const f = await reversedRequestDebit();
  check(
    "1: under follow_dunning a terminate-class reversal is not re-armed for the next day",
    f.inv.dunningStatus !== "in_progress" && f.inv.nextAttemptAt === null,
    `inv=${f.inv.status}/${f.inv.dunningStatus} next=${f.inv.nextAttemptAt?.toISOString()}`,
  );
}

// 2. A delayed activation event is not fresh authority after a revocation.
{
  const r = await revoked({ mandate_revoked: "request_new_mandate" });
  const pm = await pmOfSub(r.sub.id);
  await systemDb
    .update(paymentMethods)
    .set({ mandateStatus: "pending", mandateStatusAt: null })
    .where(eq(paymentMethods.id, pm));
  // The gateway says the mandate went live a day BEFORE the revoked attempt.
  await applyMandateStatus(
    await pmRow(pm),
    { status: "active" },
    new Date(Date.now() - 86_400_000),
  );
  check(
    "2: a delayed activation dated before the revocation does not clear the block",
    (await blockOf(pm)) === "mandate_revoked",
    `block=${await blockOf(pm)} authorized=${(await pmRow(pm)).authorizedAt?.toISOString()}`,
  );
}

await app.close();
let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log(`\n${checks.length} checks`);
console.log(pass ? "✅ SETTINGS-BILLING-RULES: PASS" : "❌ SETTINGS-BILLING-RULES: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
