/**
 * verify:settings-dunning-p2 — dunning and collection settings (Part B phase 2, slice F).
 *
 *   2.17 dunning end action (cancel now · term end · pause · stop charging · keep)
 *   2.59 adaptive retry cadence per decline type
 *   2.48 retry schedule per payment method kind, and a dunning policy per plan
 *   2.12 shortfall write-off on a recorded part payment
 *   2.15 declined refund: block or issue credit
 *
 * Each option must change behaviour; unset must behave as before.
 *
 *   pnpm verify:settings-dunning-p2
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  resumeSubscriptionWithOptions,
  SubscriptionError,
} from "@/modules/subscriptions/service";
import { applyDunningFinalAction } from "@/modules/subscriptions/dunning";
import { createPaymentRequest, chargePaymentRequest } from "@/modules/payment-requests/service";
import { applyRequestChargeRefund } from "@/modules/payment-requests/gateway-hooks";
import { runTransfer } from "@/modules/transfer/service";
import { readFileSync } from "node:fs";
import {
  collectInvoice,
  CollectionInFlightError,
  createInvoiceFromLines,
  dunningNotHeldSql,
} from "@/modules/invoicing/service";
import { recordOfflinePayment } from "@/modules/invoicing/ops";
import { refundPayment, RefundError } from "@/modules/refunds/service";
import { reverseRefund } from "@/modules/refunds/settlement";
import { bucketBalance, REFUNDABLE_CREDIT } from "@/modules/customers/balances-read";
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import {
  DEFAULT_DUNNING_CONFIG,
  dunningMethodKind,
  nextOfflineReminderAt,
  nextParkedReminderAt,
  planFailureRearm,
  resolveDunningConfig,
  retryDaysForMethod,
  type FailureRearm,
} from "@/modules/subscriptions/dunning-schedule";
import { DEFAULT_ADAPTIVE_CADENCE } from "@/modules/subscriptions/adaptive-schedule";
import {
  resolveCollectionRulesConfig,
  shortfallToWriteOff,
  withInitialCollectionRules,
} from "@/modules/subscriptions/collection-rules-config";
import {
  businesses,
  creditNotes,
  events,
  invoices,
  payments,
  paymentRequests,
  refunds,
  subscriptions,
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
const org = await createOrganization({ name: "Dunning Settings Co" });
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

const DAY = 86_400_000;
const at = (d: Date | null | undefined) => d?.toISOString() ?? "null";
const same = (a: FailureRearm, b: FailureRearm) => JSON.stringify(a) === JSON.stringify(b);

async function newBiz(
  set: { dunningConfig?: unknown; billingRulesConfig?: unknown } = {},
): Promise<{
  biz: { id: string; publicId: string };
  product: { id: string; publicId: string };
  price: Awaited<ReturnType<typeof createPrice>>;
}> {
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Dunning P2",
    defaultCurrency: "USD",
    livemode: "test",
  });
  if (Object.keys(set).length)
    await systemDb.update(businesses).set(set).where(eq(businesses.id, biz.id));
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
  });
  return { biz, product, price };
}

async function customer(bizId: string, token: string) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `d${Math.random().toString(36).slice(2)}@example.com`,
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: bizId,
    customer: c,
    token,
  });
  return { c, pm };
}

const invoiceRow = async (id: string) =>
  (
    await withTenant(orgId, (tx) => tx.select().from(invoices).where(eq(invoices.id, id)).limit(1))
  )[0]!;
const subRow = async (id: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1),
    )
  )[0]!;

/** An active subscription with an unpaid invoice whose dunning has just been exhausted. */
async function exhausted(
  b: Awaited<ReturnType<typeof newBiz>>,
  prep?: (subId: string) => Promise<void>,
) {
  const { c, pm } = await customer(b.biz.id, "4000000000009995");
  const created = await createSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: b.price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
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
  if (prep) await prep(created.subscription.id);
  await systemDb.update(invoices).set({ attemptCount: 20 }).where(eq(invoices.id, invoice.id));
  await collectInvoice({
    organizationId: orgId,
    businessId: b.biz.id,
    invoice: await invoiceRow(invoice.id),
    subscription: created.subscription,
  });
  const inv = await invoiceRow(invoice.id);
  const config = await withTenant(orgId, (tx) =>
    loadEffectiveDunningConfig(tx, {
      businessId: b.biz.id,
      customerId: c.id,
      subscriptionId: created.subscription.id,
    }),
  );
  await applyDunningFinalAction({
    organizationId: orgId,
    businessId: b.biz.id,
    invoicePublicId: inv.publicId,
    subscriptionId: created.subscription.id,
    subscriptionPublicId: null,
    config,
  });
  return { sub: await subRow(created.subscription.id), inv, c };
}

// ── Resolvers: unset and malformed resolve to today ──────────────────────────────────
{
  const d = resolveDunningConfig(null);
  check(
    "unset → end action cancel, no method schedules, coded cadence",
    d.finalAction.subscription === "cancel" &&
      Object.keys(d.retriesByMethod).length === 0 &&
      JSON.stringify(d.adaptiveCadence) === JSON.stringify(DEFAULT_ADAPTIVE_CADENCE),
  );
  const bad = resolveDunningConfig({
    dunningConfig: {
      final_action: { invoice: "not_paid", subscription: "Pause" },
      retries_by_method: { bank_debit: [1, 2, 3, 4, 5, 6, 7], card: "x" },
      adaptive_cadence: { transient_hours: [0], generic_days: [1, 2], funds_max_retries: 99 },
    },
  });
  check(
    "malformed values fall back key by key; bank debit capped at 5",
    bad.finalAction.subscription === "cancel" &&
      bad.retriesByMethod.bank_debit?.length === 5 &&
      bad.retriesByMethod.card === undefined &&
      bad.adaptiveCadence.transientHours.join() === "4,24,72" &&
      bad.adaptiveCadence.genericDays.join() === "1,2" &&
      bad.adaptiveCadence.fundsMaxRetries === 4,
    JSON.stringify(bad),
  );
  check(
    "method kinds: card, bank debits by type and by rail, others none",
    dunningMethodKind("card") === "card" &&
      dunningMethodKind("sepa_debit") === "bank_debit" &&
      dunningMethodKind("us_bank_account") === "bank_debit" &&
      dunningMethodKind("upi", "emandate") === "bank_debit" &&
      dunningMethodKind("upi", "upi") === null &&
      dunningMethodKind("paypal") === null,
  );
  const cr = resolveCollectionRulesConfig(null);
  check(
    "collection rules unset → no write-off, declined refund blocked",
    Object.keys(cr.partialPaymentWriteOff).length === 0 && cr.declinedRefund === "block",
  );
  check(
    "a person's new business issues credit; a key's keeps today's",
    resolveCollectionRulesConfig({
      billingRulesConfig: withInitialCollectionRules(
        { trial_end_action: "activate" },
        {
          hasOperator: true,
        },
      ),
    }).declinedRefund === "issue_credit" &&
      withInitialCollectionRules(undefined, { hasOperator: false }) === undefined,
  );
}

// ── 2.59 / 2.48 pure planner: unset reproduces today exactly ─────────────────────────
{
  const now = new Date("2026-11-03T08:00:00Z");
  const due = new Date("2026-11-01T00:00:00Z");
  const codes = [
    "insufficient_funds",
    "processing_error",
    "card_declined",
    "do_not_honor",
    "expired_card",
    "fraudulent",
    "revocation_of_authorization",
    "mandate_expired",
    undefined,
  ];
  let identical = 0;
  let total = 0;
  for (const mode of ["fixed", "smart"] as const)
    for (const adaptiveTiming of [false, true])
      for (const parkHardDeclines of [false, true])
        for (const declineCode of codes)
          for (const newAttemptCount of [1, 2, 3, 4, 5])
            for (const [methodType, mandateRail] of [
              ["card", null],
              ["sepa_debit", null],
              ["upi", "upi"],
              ["card", "emandate"],
            ] as const) {
              const base = {
                dunningStatus: "in_progress",
                currentNextAttemptAt: null,
                autoCollectOn: true,
                retriable:
                  declineCode === "insufficient_funds" || declineCode === "processing_error",
                newAttemptCount,
                retryDays: [1, 3, 5, 7],
                now,
                mode,
                declineCode,
                parkHardDeclines,
                dueDate: due,
                mandateRail,
                adaptiveTiming,
                timezone: "UTC",
              };
              const before = planFailureRearm(base);
              const after = planFailureRearm({
                ...base,
                methodType,
                retriesByMethod: DEFAULT_DUNNING_CONFIG.retriesByMethod,
                adaptiveCadence: DEFAULT_DUNNING_CONFIG.adaptiveCadence,
              });
              total++;
              if (same(before, after)) identical++;
            }
  check(
    `unset settings plan every failure as today (${identical}/${total})`,
    identical === total && total > 0,
  );

  const plan = (over: Partial<Parameters<typeof planFailureRearm>[0]>) =>
    planFailureRearm({
      dunningStatus: "in_progress",
      currentNextAttemptAt: null,
      autoCollectOn: true,
      retriable: true,
      newAttemptCount: 1,
      retryDays: [1, 3, 5, 7],
      now,
      dueDate: due,
      ...over,
    });
  const nextOf = (r: FailureRearm) => (r.action === "retry" ? r.nextAttempt : null);
  const byMethod = { card: [4, 8], bank_debit: [6, 10] };
  check(
    "2.48: a card follows the card schedule",
    at(nextOf(plan({ methodType: "card", retriesByMethod: byMethod }))) ===
      at(new Date(due.getTime() + 4 * DAY)),
  );
  check(
    "2.48: a SEPA debit follows the bank-debit schedule",
    at(nextOf(plan({ methodType: "sepa_debit", retriesByMethod: byMethod }))) ===
      at(new Date(due.getTime() + 6 * DAY)),
  );
  check(
    "2.48: UPI keeps the business schedule",
    at(
      nextOf(
        plan({
          methodType: "upi",
          mandateRail: "upi",
          retryDays: [5, 9],
          retriesByMethod: byMethod,
        }),
      ),
    ) === at(new Date(due.getTime() + 5 * DAY)),
  );
  // NACH spacing: never sooner than 3 days after the return, even if the schedule says 1.
  check(
    "2.48: an e-mandate bank-debit schedule keeps the 3-day scheme spacing",
    at(
      nextOf(
        plan({
          methodType: "card",
          mandateRail: "emandate",
          retriesByMethod: { bank_debit: [1, 2] },
        }),
      ),
    ) === at(new Date(now.getTime() + 3 * DAY)),
  );
  check(
    "2.48: the e-mandate network cap still cuts a bank-debit schedule (2 retries)",
    plan({
      methodType: "card",
      mandateRail: "emandate",
      newAttemptCount: 3,
      retriesByMethod: { bank_debit: [3, 6, 9, 12, 15] },
    }).action === "exhausted",
  );

  const smart = { mode: "smart" as const, adaptiveTiming: true, timezone: "UTC" };
  const transient = nextOf(
    plan({
      ...smart,
      declineCode: "processing_error",
      adaptiveCadence: { ...DEFAULT_ADAPTIVE_CADENCE, transientHours: [1, 2] },
    }),
  );
  check(
    "2.59: transient faults follow the configured hours",
    at(transient) === at(new Date(now.getTime() + 3_600_000)),
    at(transient),
  );
  const fundsFixed = nextOf(
    plan({
      ...smart,
      declineCode: "insufficient_funds",
      adaptiveCadence: { ...DEFAULT_ADAPTIVE_CADENCE, fundsGapDays: 2 },
    }),
  );
  check(
    "2.59: insufficient funds every 2 days at 10:00 instead of the payday",
    at(fundsFixed) === "2026-11-05T10:00:00.000Z",
    at(fundsFixed),
  );
  const fundsDefault = nextOf(plan({ ...smart, declineCode: "insufficient_funds" }));
  check(
    "2.59: unset insufficient funds still retries on the payday (the 15th)",
    at(fundsDefault) === "2026-11-15T10:00:00.000Z",
    at(fundsDefault),
  );
  check(
    "2.59: the maximum insufficient-funds retries ends retrying",
    plan({
      ...smart,
      declineCode: "insufficient_funds",
      newAttemptCount: 2,
      adaptiveCadence: { ...DEFAULT_ADAPTIVE_CADENCE, fundsMaxRetries: 1 },
    }).action === "exhausted" &&
      plan({ ...smart, declineCode: "insufficient_funds", newAttemptCount: 2 }).action === "retry",
  );
  check(
    "2.59: a shorter generic cadence parks after its last retry",
    plan({
      ...smart,
      parkHardDeclines: true,
      declineCode: "card_declined",
      newAttemptCount: 2,
      adaptiveCadence: { ...DEFAULT_ADAPTIVE_CADENCE, genericDays: [1] },
    }).action === "parked" &&
      plan({ ...smart, parkHardDeclines: true, declineCode: "card_declined", newAttemptCount: 2 })
        .action === "retry",
  );

  const cfg = resolveDunningConfig({
    dunningConfig: { retries_by_method: { offline: [{ after_days: 10 }] } },
  });
  check(
    "2.48: offline invoices are reminded on the offline schedule",
    at(nextOfflineReminderAt(cfg, due, now, { hasSubscription: true })) ===
      at(new Date(due.getTime() + 10 * DAY)) &&
      at(nextOfflineReminderAt(DEFAULT_DUNNING_CONFIG, due, now, { hasSubscription: true })) ===
        at(new Date(due.getTime() + 3 * DAY)),
  );
}

// ── 2.17 dunning end action, end to end ──────────────────────────────────────────────
const endAction = (subscription: string, extra: Record<string, unknown> = {}) => ({
  dunningConfig: { final_action: { invoice: "not_paid", subscription, ...extra } },
});
{
  const unset = await exhausted(await newBiz());
  check(
    "end action unset → cancelled now (today)",
    unset.inv.dunningStatus === "exhausted" && unset.sub.status === "cancelled",
    `${unset.inv.status}/${unset.inv.dunningStatus} sub=${unset.sub.status}`,
  );
  const termEnd = await exhausted(await newBiz(endAction("cancel_at_term_end")));
  check(
    "cancel at term end → active, cancels at period end",
    termEnd.sub.status === "active" && termEnd.sub.cancelAtPeriodEnd === true,
    `sub=${termEnd.sub.status} atEnd=${termEnd.sub.cancelAtPeriodEnd}`,
  );
  const paused = await exhausted(await newBiz(endAction("pause")));
  check("pause → paused", paused.sub.status === "paused", `sub=${paused.sub.status}`);
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: paused.sub.businessId,
    invoicePublicId: paused.inv.publicId,
  });
  check(
    "pause: a later payment leaves it paused (the merchant resumes it)",
    (await subRow(paused.sub.id)).status === "paused",
  );
  const r1 = await resumeSubscriptionWithOptions({
    organizationId: orgId,
    businessId: paused.sub.businessId,
    subscriptionId: paused.sub.id,
    now: new Date(),
  });
  let secondRefused = false;
  await systemDb
    .update(subscriptions)
    .set({ status: "paused" })
    .where(eq(subscriptions.id, paused.sub.id));
  const both = await Promise.all(
    [0, 1].map(() =>
      resumeSubscriptionWithOptions({
        organizationId: orgId,
        businessId: paused.sub.businessId,
        subscriptionId: paused.sub.id,
        now: new Date(),
      }).catch((e) => {
        if (e instanceof SubscriptionError) secondRefused = true;
        return null;
      }),
    ),
  );
  check(
    "manual resume works; of two racing resumes one is refused",
    r1.subscription.status === "active" && both.filter((x) => x).length === 1 && secondRefused,
  );
  const atEnd = await exhausted(await newBiz(endAction("pause")), (subId) =>
    systemDb
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(subscriptions.id, subId))
      .then(() => undefined),
  );
  check(
    "a subscription set to cancel at term end is not paused by dunning",
    atEnd.sub.status === "active" && atEnd.sub.cancelAtPeriodEnd === true,
    `sub=${atEnd.sub.status}`,
  );

  const stop = await exhausted(await newBiz(endAction("stop_charging")));
  check(
    "keep and stop charging → active with auto-collection off",
    stop.sub.status === "active" && stop.sub.autoCollection === "off",
    `sub=${stop.sub.status} ac=${stop.sub.autoCollection}`,
  );
  const keep = await exhausted(await newBiz(endAction("retain")));
  check(
    "keep and continue billing → active, auto-collection untouched",
    keep.sub.status === "active" && keep.sub.autoCollection !== "off",
  );
}

// ── 2.48 plan policies ───────────────────────────────────────────────────────────────
{
  const b = await newBiz({ dunningConfig: { retries: [{ after_days: 2 }] } });
  const mk = async (code: string, days: number, extra: Record<string, unknown> = {}) =>
    json(
      await req("POST", `/v1/businesses/${b.biz.publicId}/dunning_policies`, {
        name: code,
        code,
        config: { retries: [{ after_days: days }], ...extra },
      }),
    ).id as string;
  const planPol = await mk("plan-pol", 9, { minimum_amounts: { USD: 5000 } });
  const custPol = await mk("cust-pol", 11);
  const bad1 = await req("PATCH", `/v1/businesses/${b.biz.publicId}`, {
    dunning_config: { plan_policies: { "no-such-plan": planPol } },
  });
  const bad2 = await req("PATCH", `/v1/businesses/${b.biz.publicId}`, {
    dunning_config: { plan_policies: { [b.product.publicId]: "dpol_missing" } },
  });
  check(
    "plan policies: an unknown plan or policy is refused",
    bad1.statusCode === 400 && bad2.statusCode === 400,
  );
  const ok = await req("PATCH", `/v1/businesses/${b.biz.publicId}`, {
    dunning_config: {
      retries: [{ after_days: 2 }],
      plan_policies: { [b.product.publicId]: planPol },
    },
  });
  check("plan policies: a valid map saves", ok.statusCode === 200, ok.payload.slice(0, 200));

  const { c } = await customer(b.biz.id, "tok_4242");
  const created = await createSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: b.price, quantity: 1 }],
  });
  const load = (subscriptionId?: string) =>
    withTenant(orgId, (tx) =>
      loadEffectiveDunningConfig(tx, { businessId: b.biz.id, customerId: c.id, subscriptionId }),
    );
  check(
    "plan policies: a subscription on the plan runs the plan's policy",
    (await load(created.subscription.id)).retryDays.join() === "9" &&
      (await load()).retryDays.join() === "2",
  );
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
  const held = await withTenant(orgId, (tx) =>
    tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.id, invoice.id), dunningNotHeldSql())),
  );
  check(
    "plan policies: the plan policy's minimum holds the invoice in the scan",
    held.length === 0,
  );

  const assign = await req("PATCH", `/v1/businesses/${b.biz.publicId}/customers/${c.publicId}`, {
    dunning_policy: custPol,
  });
  check(
    "plan policies: the customer policy is assigned",
    assign.statusCode === 200,
    assign.payload.slice(0, 200),
  );
  check(
    "plan policies: the customer's own policy comes first",
    (await load(created.subscription.id)).retryDays.join() === "11",
  );
  const arch = await req(
    "POST",
    `/v1/businesses/${b.biz.publicId}/dunning_policies/${planPol}/archive`,
  );
  check(
    "plan policies: a policy a plan uses cannot be archived",
    arch.statusCode === 409,
    arch.payload.slice(0, 200),
  );
}

// ── 2.48 no retry while a debit is pending ───────────────────────────────────────────
{
  const b = await newBiz();
  const { c, pm } = await customer(b.biz.id, "4000000000000101");
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    currency: "USD",
    lines: [{ description: "Debit", amountMinor: 1000n, kind: "one_time" }],
    collect: false,
  });
  void pm;
  await collectInvoice({
    organizationId: orgId,
    businessId: b.biz.id,
    invoice: await invoiceRow(invoice.id),
  }).catch(() => null);
  let refused = false;
  try {
    await collectInvoice({
      organizationId: orgId,
      businessId: b.biz.id,
      invoice: await invoiceRow(invoice.id),
    });
  } catch (e) {
    refused = e instanceof CollectionInFlightError;
  }
  const rows = await withTenant(orgId, (tx) =>
    tx.select({ s: payments.status }).from(payments).where(eq(payments.invoiceId, invoice.id)),
  );
  check(
    "no second attempt while a debit is pending",
    rows.length === 1 && rows[0]!.s === "pending" && (refused || rows.length === 1),
    `rows=${rows.map((r) => r.s).join(",")} refused=${refused}`,
  );
}

// ── 2.12 shortfall write-off ─────────────────────────────────────────────────────────
async function partPay(rules: unknown, paidMinor: number, totalMinor = 1000n) {
  const b = await newBiz(rules ? { billingRulesConfig: rules } : {});
  const { c } = await customer(b.biz.id, "tok_4242");
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    currency: "USD",
    lines: [{ description: "Service", amountMinor: totalMinor, kind: "one_time" }],
    collect: false,
  });
  const res = await recordOfflinePayment({
    organizationId: orgId,
    businessId: b.biz.id,
    invoicePublicId: invoice.publicId,
    amountMinor: paidMinor,
  });
  const notes = await withTenant(orgId, (tx) =>
    tx
      .select({ total: creditNotes.totalMinor, reason: creditNotes.reasonCode })
      .from(creditNotes)
      .where(eq(creditNotes.invoiceId, invoice.id)),
  );
  const ar = await withTenant(orgId, (tx) =>
    tx.execute(sql`select coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
      from ledger_entries where business_id = ${b.biz.id} and account = 'accounts_receivable'`),
  );
  return {
    inv: res.invoice,
    notes,
    ar: BigInt((ar as unknown as Array<{ bal: string }>)[0]?.bal ?? 0),
  };
}
{
  const unset = await partPay(null, 950);
  check(
    "2.12 unset: a 50 shortfall keeps the invoice open; amount_due_minor stays net of credits only (today)",
    unset.inv.status !== "paid" && unset.notes.length === 0 && unset.inv.amountDueMinor === 1000n,
    unset.inv.status,
  );
  const within = await partPay(
    { partial_payment_write_off: { USD: 100 }, partial_payment_write_off_max_percent: 10 },
    950,
  );
  check(
    "2.12: a 50 shortfall within 100 is written off and the invoice is paid",
    within.inv.status === "paid" &&
      within.notes.length === 1 &&
      within.notes[0]!.total === 50n &&
      within.notes[0]!.reason === "payment_shortfall" &&
      within.inv.writtenOff === false,
    `${within.inv.status} notes=${JSON.stringify(within.notes, (_, v) => (typeof v === "bigint" ? String(v) : v))}`,
  );
  check("2.12: receivables net to zero after the write-off", within.ar === 0n, String(within.ar));
  const over = await partPay(
    { partial_payment_write_off: { USD: 100 }, partial_payment_write_off_max_percent: 10 },
    850,
  );
  check(
    "2.12: a 150 shortfall over 100 keeps the invoice open",
    over.inv.status !== "paid" && over.notes.length === 0,
  );
  const otherCur = await partPay({ partial_payment_write_off: { EUR: 100 } }, 950);
  check("2.12: a tolerance in another currency does not apply", otherCur.inv.status !== "paid");
}

// ── 2.12 per call: `shortfall` on POST …/invoices/:inv/pay ──────────────────────────
async function partPayApi(rules: unknown, paidMinor: number, extra: object) {
  const b = await newBiz(rules ? { billingRulesConfig: rules } : {});
  const { c } = await customer(b.biz.id, "tok_4242");
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    currency: "USD",
    lines: [{ description: "Service", amountMinor: 1000n, kind: "one_time" }],
    collect: false,
  });
  const r = await req("POST", `/v1/businesses/${b.biz.publicId}/invoices/${invoice.publicId}/pay`, {
    amount_minor: paidMinor,
    ...extra,
  });
  const [row] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1),
  );
  const notes = await withTenant(orgId, (tx) =>
    tx
      .select({ total: creditNotes.totalMinor })
      .from(creditNotes)
      .where(eq(creditNotes.invoiceId, invoice.id)),
  );
  const pays = await withTenant(orgId, (tx) =>
    tx.select({ id: payments.id }).from(payments).where(eq(payments.invoiceId, invoice.id)),
  );
  return { status: r.statusCode, body: json(r), inv: row!, notes, pays: pays.length };
}
{
  const tol = {
    partial_payment_write_off: { USD: 100 },
    partial_payment_write_off_max_percent: 10,
  };
  const leave = await partPayApi(tol, 950, { shortfall: "leave_due" });
  check(
    "2.12 per call: leave_due keeps a 50 shortfall due although the rule writes it off",
    leave.status === 200 && leave.inv.status !== "paid" && leave.notes.length === 0,
    `${leave.status} ${leave.inv.status} notes=${leave.notes.length}`,
  );
  const omitted = await partPayApi(tol, 950, {});
  check(
    "2.12 per call: omitted = the rule (50 written off, invoice paid)",
    omitted.status === 200 && omitted.inv.status === "paid" && omitted.notes[0]?.total === 50n,
    `${omitted.status} ${omitted.inv.status}`,
  );
  const within = await partPayApi(null, 950, { shortfall: "write_off" });
  check(
    "2.12 per call: write_off with no limit for the currency is refused, nothing recorded",
    within.status === 400 && within.pays === 0 && within.notes.length === 0,
    `${within.status} pays=${within.pays}`,
  );
  const over = await partPayApi(tol, 850, { shortfall: "write_off" });
  check(
    "2.12 per call: write_off never exceeds the amount cap (150 over 100: 400, nothing recorded)",
    over.status === 400 && over.pays === 0 && over.notes.length === 0,
    `${over.status} pays=${over.pays}`,
  );
  const pct = await partPayApi(
    { partial_payment_write_off: { USD: 100 }, partial_payment_write_off_max_percent: 2 },
    950,
    { shortfall: "write_off" },
  );
  check(
    "2.12 per call: write_off never exceeds the percent cap (50 over 2% of 1000: 400)",
    pct.status === 400 && pct.pays === 0,
    `${pct.status} pays=${pct.pays}`,
  );
  const ok = await partPayApi(tol, 950, { shortfall: "write_off" });
  check(
    "2.12 per call: write_off within the limit writes off 50 and pays the invoice",
    ok.status === 200 && ok.inv.status === "paid" && ok.notes[0]?.total === 50n,
    `${ok.status} ${ok.inv.status}`,
  );
  const bad = await partPayApi(tol, 950, { shortfall: "forgive" });
  check("2.12 per call: an unknown shortfall value is a 400", bad.status === 400 && bad.pays === 0);
}

// ── 2.15 declined refund ─────────────────────────────────────────────────────────────
async function declinedRefund(
  rule: string | null,
  onDecline?: "block" | "issue_credit",
  viaApi = false,
) {
  const b = await newBiz(rule ? { billingRulesConfig: { declined_refund: rule } } : {});
  const { c } = await customer(b.biz.id, "tok_4242");
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    currency: "USD",
    lines: [{ description: "Service", amountMinor: 1000n, kind: "one_time" }],
    collect: true,
  });
  const [pay] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "succeeded")))
      .limit(1),
  );
  // An amount ending in 17: the test gateway accepts it and leaves it pending.
  const refId = viaApi
    ? (json(
        await req("POST", `/v1/businesses/${b.biz.publicId}/payments/${pay!.publicId}/refund`, {
          amount_minor: 517,
          ...(onDecline ? { on_decline: onDecline } : {}),
        }),
      ).id as string)
    : (
        await refundPayment({
          organizationId: orgId,
          businessId: b.biz.id,
          paymentPublicId: pay!.publicId,
          amountMinor: 517,
          ...(onDecline ? { onDecline } : {}),
        })
      ).publicId;
  // Read back as the webhook would: the decline sees only what the row stores.
  const [row] = await withTenant(orgId, (tx) =>
    tx.select().from(refunds).where(eq(refunds.publicId, refId)).limit(1),
  );
  const reversed = await reverseRefund(row!, {
    failureCode: "refund_declined",
    gatewayConfirmed: true,
  });
  const credit = await withTenant(orgId, (tx) => bucketBalance(tx, c.id, REFUNDABLE_CREDIT, "USD"));
  const notes = await withTenant(orgId, (tx) =>
    tx
      .select({ status: creditNotes.status, total: creditNotes.totalMinor })
      .from(creditNotes)
      .where(eq(creditNotes.invoiceId, invoice.id)),
  );
  const [ev] = await withTenant(orgId, (tx) =>
    tx
      .select({ data: events.data })
      .from(events)
      .where(and(eq(events.businessId, b.biz.id), eq(events.type, "refund_failed")))
      .orderBy(desc(events.createdAt))
      .limit(1),
  );
  let secondRefused = false;
  try {
    await refundPayment({
      organizationId: orgId,
      businessId: b.biz.id,
      paymentPublicId: pay!.publicId,
      amountMinor: 600,
    });
  } catch (e) {
    secondRefused = e instanceof RefundError;
  }
  let thirdOk = false;
  try {
    await refundPayment({
      organizationId: orgId,
      businessId: b.biz.id,
      paymentPublicId: pay!.publicId,
      amountMinor: 400,
    });
    thirdOk = true;
  } catch {
    thirdOk = false;
  }
  return { reversed, credit, notes, ev, secondRefused, thirdOk, stored: row?.onDecline ?? null };
}
{
  const unset = await declinedRefund(null);
  check(
    "2.15 unset: a declined refund gives no credit (today)",
    unset.reversed && unset.credit === 0n && unset.notes.every((n) => n.status === "refunded"),
    `reversed=${unset.reversed} credit=${unset.credit}`,
  );
  const credit = await declinedRefund("issue_credit");
  check(
    "2.15 issue credit: the declined 517 becomes an open refundable credit note",
    credit.reversed &&
      credit.credit === 517n &&
      credit.notes.some((n) => n.status === "refund_due" && n.total === 517n),
    `credit=${credit.credit} notes=${credit.notes.map((n) => `${n.status}:${n.total}`).join(",")}`,
  );
  check(
    "2.15 issue credit: refund_failed reports the credit",
    (credit.ev?.data as { refund?: { credited_minor?: number } } | undefined)?.refund
      ?.credited_minor === 517,
    JSON.stringify(credit.ev?.data),
  );
  check(
    "2.15 issue credit: the payment cannot be refunded over the credit (600 refused, 400 allowed)",
    credit.secondRefused && credit.thirdOk,
  );
}
{
  const asked = await declinedRefund(null, "issue_credit", true);
  check(
    "2.15 per call: on_decline=issue_credit on the route is stored and gives credit (rule unset)",
    asked.stored === "issue_credit" &&
      asked.reversed &&
      asked.credit === 517n &&
      asked.notes.some((n) => n.status === "refund_due" && n.total === 517n),
    `stored=${asked.stored} credit=${asked.credit}`,
  );
  const blocked = await declinedRefund("issue_credit", "block");
  check(
    "2.15 per call: on_decline=block gives no credit although the rule issues credit",
    blocked.stored === "block" && blocked.reversed && blocked.credit === 0n,
    `stored=${blocked.stored} credit=${blocked.credit}`,
  );
  const omitted = await declinedRefund("issue_credit", undefined, true);
  check(
    "2.15 per call: omitted stores null and follows the rule (credit 517)",
    omitted.stored === null && omitted.credit === 517n,
    `stored=${omitted.stored} credit=${omitted.credit}`,
  );
}

// ── Review fixes ─────────────────────────────────────────────────────────────────────
// R1: the write-off is bounded by a percent of the invoice and never hits a credit purchase.
{
  const big = { partial_payment_write_off: { USD: 50000 } };
  const instalment = await partPay(big, 40000, 80000n);
  check(
    "R1: a 400-of-800 instalment stays open (shortfall over 2% of the invoice)",
    instalment.inv.status !== "paid" && instalment.notes.length === 0,
  );
  const token = await partPay(big, 1, 40000n);
  check("R1: a 1-minor payment does not settle the invoice", token.inv.status !== "paid");
  const onePct = await partPay(big, 99000, 100000n);
  check(
    "R1: a 1% shortfall within the amount is written off",
    onePct.inv.status === "paid" && onePct.notes[0]?.total === 1000n,
  );
  const cfg = resolveCollectionRulesConfig({ billingRulesConfig: big });
  check(
    "R1: a credit purchase is never written off",
    shortfallToWriteOff(
      cfg,
      { currency: "USD", totalMinor: 100000n, purpose: "credit_purchase" },
      10n,
    ) === 0n &&
      shortfallToWriteOff(cfg, { currency: "USD", totalMinor: 100000n, purpose: null }, 10n) ===
        10n,
  );
  const created = json(
    await req("POST", "/v1/businesses", { default_currency: "USD", name: "Bounds" }),
  );
  const r = await Promise.all([
    req("PATCH", `/v1/businesses/${created.id}`, {
      billing_rules_config: { partial_payment_write_off: { USD: 100001 } },
    }),
    req("PATCH", `/v1/businesses/${created.id}`, {
      billing_rules_config: { partial_payment_write_off_max_percent: 11 },
    }),
  ]);
  check(
    "R1: the API caps the amount and the percent",
    r.every((x) => x.statusCode === 400),
  );
}

// R6: a retried refund pays out the declined refund's credit, never both. 400 settles at
// once; the bank returns it later (reverseRefund handles succeeded refunds too).
{
  const b = await newBiz({ billingRulesConfig: { declined_refund: "issue_credit" } });
  const { c } = await customer(b.biz.id, "tok_4242");
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    currency: "USD",
    lines: [{ description: "Service", amountMinor: 1000n, kind: "one_time" }],
    collect: true,
  });
  const [pay] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "succeeded")))
      .limit(1),
  );
  const first = await refundPayment({
    organizationId: orgId,
    businessId: b.biz.id,
    paymentPublicId: pay!.publicId,
    amountMinor: 400,
  });
  const [row] = await withTenant(orgId, (tx) =>
    tx.select().from(refunds).where(eq(refunds.publicId, first.publicId)).limit(1),
  );
  await reverseRefund(row!, { failureCode: "refund_declined", gatewayConfirmed: true });
  let tooMuch = false;
  try {
    await refundPayment({
      organizationId: orgId,
      businessId: b.biz.id,
      paymentPublicId: pay!.publicId,
      amountMinor: 600,
    });
  } catch (e) {
    tooMuch = e instanceof RefundError;
  }
  await refundPayment({
    organizationId: orgId,
    businessId: b.biz.id,
    paymentPublicId: pay!.publicId,
    amountMinor: 400,
  });
  const live = await withTenant(orgId, (tx) =>
    tx
      .select({ amount: refunds.amountMinor })
      .from(refunds)
      .where(and(eq(refunds.paymentId, pay!.id), sql`${refunds.status} <> 'failed'`)),
  );
  const out = live.reduce((t, r) => t + r.amount, 0n);
  const credit = await withTenant(orgId, (tx) => bucketBalance(tx, c.id, REFUNDABLE_CREDIT, "USD"));
  check(
    "R6: declined 400 then retried 400 → 400 out in total and no credit left",
    tooMuch && out === 400n && credit === 0n,
    `tooMuch=${tooMuch} out=${out} credit=${credit}`,
  );
}

// R7: a revoked-mandate pause that cannot apply falls back to the configured end action.
{
  const b = await newBiz({
    ...endAction("stop_charging"),
    billingRulesConfig: { mandate_revoked: "pause" },
  });
  const { c, pm } = await customer(b.biz.id, "tok_4242");
  const created = await createSubscription({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: b.price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
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
  await systemDb
    .update(invoices)
    .set({
      status: "not_paid",
      dunningStatus: "exhausted",
      dunningExhaustedCode: "revocation_of_authorization",
    })
    .where(eq(invoices.id, invoice.id));
  await systemDb
    .update(subscriptions)
    .set({ status: "in_trial" })
    .where(eq(subscriptions.id, created.subscription.id));
  const config = await withTenant(orgId, (tx) =>
    loadEffectiveDunningConfig(tx, { businessId: b.biz.id, customerId: c.id }),
  );
  await applyDunningFinalAction({
    organizationId: orgId,
    businessId: b.biz.id,
    invoicePublicId: invoice.publicId,
    subscriptionId: created.subscription.id,
    subscriptionPublicId: null,
    config,
  });
  check(
    "R7: revoked-mandate pause on a trial falls back to stop charging",
    (await subRow(created.subscription.id)).autoCollection === "off",
  );
}

// R8: reactivation and parked reminders follow the plan policy and the method schedule.
{
  const cfg = resolveDunningConfig({
    dunningConfig: { retries_by_method: { card: [{ after_days: 6 }] } },
  });
  const parked = new Date("2027-01-01T00:00:00Z");
  check(
    "R8: a parked card invoice is reminded on the card schedule",
    at(nextParkedReminderAt(cfg, parked, parked, retryDaysForMethod(cfg, "card"))) ===
      "2027-01-07T00:00:00.000Z" &&
      at(nextParkedReminderAt(cfg, parked, parked)) === "2027-01-02T00:00:00.000Z",
  );
  const src = readFileSync("src/modules/subscriptions/reactivate.ts", "utf8");
  check(
    "R8: every reactivation config read passes the subscription",
    (src.match(/loadEffectiveDunningConfig\(/g) ?? []).length > 0 &&
      (src.match(/loadEffectiveDunningConfig\(tx, \{[^}]*subscriptionId/g) ?? []).length ===
        (src.match(/loadEffectiveDunningConfig\(/g) ?? []).length &&
      !/retryDays: cfg\.retryDays|nextRetryAt\(1, now, cfg\.retryDays\)/.test(src),
  );
}

// R9: switching instrument mid-dunning does not end dunning early.
{
  const now = new Date("2026-11-03T08:00:00Z");
  const due = new Date("2026-11-01T00:00:00Z");
  const base = {
    dunningStatus: "in_progress",
    currentNextAttemptAt: null,
    autoCollectOn: true,
    retriable: true,
    retryDays: [1, 3, 5, 7],
    now,
    dueDate: due,
    retriesByMethod: { card: [1, 2, 3, 4, 5, 6, 7, 8], bank_debit: [10, 20, 30] },
  };
  const switched = planFailureRearm({
    ...base,
    newAttemptCount: 6,
    methodType: "sepa_debit",
    priorMethods: Array.from({ length: 5 }, () => ({ type: "card", rail: null })),
  });
  const bankOnly = planFailureRearm({
    ...base,
    newAttemptCount: 4,
    methodType: "sepa_debit",
    priorMethods: Array.from({ length: 3 }, () => ({ type: "sepa_debit", rail: null })),
  });
  check(
    "R9: a bank debit added at attempt 6 of an 8-slot card schedule keeps retrying",
    switched.action === "retry" && bankOnly.action === "exhausted",
    `switched=${switched.action} bankOnly=${bankOnly.action}`,
  );
}

// R10: a stale plan entry never blocks a save; transfers keep the destination's map.
{
  const b = await newBiz();
  await systemDb
    .update(businesses)
    .set({ dunningConfig: { plan_policies: { "gone-plan": "dpol_gone" } } })
    .where(eq(businesses.id, b.biz.id));
  const save = await req("PATCH", `/v1/businesses/${b.biz.publicId}`, {
    dunning_config: { enabled: true, plan_policies: { "gone-plan": "dpol_gone" } },
  });
  const [row] = await systemDb
    .select({ c: businesses.dunningConfig })
    .from(businesses)
    .where(eq(businesses.id, b.biz.id));
  check(
    "R10: an unchanged stale plan entry is dropped and the save succeeds",
    save.statusCode === 200 &&
      Object.keys((row?.c as { plan_policies?: object } | null)?.plan_policies ?? {}).length === 0,
    save.payload.slice(0, 200),
  );
  const dest = await newBiz();
  await systemDb
    .update(businesses)
    .set({ dunningConfig: { retries: [{ after_days: 4 }], plan_policies: { plan: "dpol_src" } } })
    .where(eq(businesses.id, b.biz.id));
  await runTransfer({
    organizationId: orgId,
    sourceBusinessId: b.biz.id,
    destinationBusinessId: dest.biz.id,
  });
  const [d] = await systemDb
    .select({ c: businesses.dunningConfig })
    .from(businesses)
    .where(eq(businesses.id, dest.biz.id));
  const dc = d?.c as { retries?: unknown[]; plan_policies?: unknown } | null;
  check(
    "R10: a transfer copies the dunning settings but not the plan policies",
    dc?.retries?.length === 1 && dc.plan_policies === undefined,
    JSON.stringify(dc),
  );
}

// Re-review 9: with no method schedule, a switch of instrument changes nothing.
{
  const now = new Date("2026-11-04T08:00:00Z");
  const due = new Date("2026-11-01T00:00:00Z");
  const base = {
    dunningStatus: "in_progress",
    currentNextAttemptAt: null,
    autoCollectOn: true,
    retriable: true,
    retryDays: [1, 3, 5, 7],
    now,
    dueDate: due,
    retriesByMethod: {},
    methodType: "upi",
    mandateRail: "upi",
  };
  const cards = [
    { type: "card", rail: null },
    { type: "card", rail: null },
  ];
  const same = [3, 4, 5].every(
    (n) =>
      JSON.stringify(planFailureRearm({ ...base, newAttemptCount: n, priorMethods: cards })) ===
      JSON.stringify(planFailureRearm({ ...base, newAttemptCount: n })),
  );
  const third = planFailureRearm({ ...base, newAttemptCount: 3, priorMethods: cards });
  check(
    "9: no method schedule → a card-to-UPI switch keeps today's slots and exhaustion",
    same &&
      third.action === "retry" &&
      at(third.nextAttempt) === at(new Date(due.getTime() + 5 * DAY)) &&
      planFailureRearm({ ...base, newAttemptCount: 5, priorMethods: cards }).action === "exhausted",
  );
}

// Re-review 6: credit only for a confirmed failure; a spent credit keeps its claim.
{
  const b = await newBiz({ billingRulesConfig: { declined_refund: "issue_credit" } });
  const { c } = await customer(b.biz.id, "tok_4242");
  const paidInvoice = async () => {
    const { invoice } = await createInvoiceFromLines({
      organizationId: orgId,
      businessId: b.biz.id,
      customerId: c.id,
      currency: "USD",
      lines: [{ description: "Service", amountMinor: 1000n, kind: "one_time" }],
      collect: true,
    });
    const [pay] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(payments)
        .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "succeeded")))
        .limit(1),
    );
    return { invoice, pay: pay! };
  };
  const refundRow = async (payPublicId: string, amount: number) => {
    const r = await refundPayment({
      organizationId: orgId,
      businessId: b.biz.id,
      paymentPublicId: payPublicId,
      amountMinor: amount,
    });
    return (
      await withTenant(orgId, (tx) =>
        tx.select().from(refunds).where(eq(refunds.publicId, r.publicId)).limit(1),
      )
    )[0]!;
  };
  const notFound = await paidInvoice();
  await reverseRefund(await refundRow(notFound.pay.publicId, 400), {
    failureCode: "refund_not_created",
  });
  const notesNF = await withTenant(orgId, (tx) =>
    tx
      .select({ status: creditNotes.status })
      .from(creditNotes)
      .where(eq(creditNotes.invoiceId, notFound.invoice.id)),
  );
  check(
    "6: a refund we could not find gives no credit (block path)",
    notesNF.every((n) => n.status === "refunded"),
    notesNF.map((n) => n.status).join(","),
  );

  const spent = await paidInvoice();
  await reverseRefund(await refundRow(spent.pay.publicId, 400), {
    failureCode: "refund_declined",
    gatewayConfirmed: true,
  });
  await systemDb
    .update(creditNotes)
    .set({ allocatedMinor: 400n })
    .where(and(eq(creditNotes.invoiceId, spent.invoice.id), eq(creditNotes.status, "refund_due")));
  let fullRefused = false;
  try {
    await refundPayment({
      organizationId: orgId,
      businessId: b.biz.id,
      paymentPublicId: spent.pay.publicId,
      amountMinor: 1000,
    });
  } catch (e) {
    fullRefused = e instanceof RefundError;
  }
  let restOk = false;
  try {
    await refundPayment({
      organizationId: orgId,
      businessId: b.biz.id,
      paymentPublicId: spent.pay.publicId,
      amountMinor: 600,
    });
    restOk = true;
  } catch {
    restOk = false;
  }
  check(
    "6: a reopened credit spent elsewhere still claims capacity (1000 refused, 600 allowed)",
    fullRefused && restOk,
    `fullRefused=${fullRefused} restOk=${restOk}`,
  );
}

// Third review 9: an offline-only schedule does not turn on the switch rule.
{
  const now = new Date("2026-11-04T08:00:00Z");
  const due = new Date("2026-11-01T00:00:00Z");
  const base = {
    dunningStatus: "in_progress",
    currentNextAttemptAt: null,
    autoCollectOn: true,
    retriable: true,
    retryDays: [1, 3, 5, 7],
    now,
    dueDate: due,
    methodType: "upi",
    mandateRail: "upi",
  };
  const cards = [
    { type: "card", rail: null },
    { type: "card", rail: null },
  ];
  check(
    "9: only an offline schedule → a card-to-UPI switch keeps today's slots",
    [3, 4, 5].every(
      (n) =>
        JSON.stringify(
          planFailureRearm({
            ...base,
            newAttemptCount: n,
            priorMethods: cards,
            retriesByMethod: { offline: [10] },
          }),
        ) === JSON.stringify(planFailureRearm({ ...base, newAttemptCount: n })),
    ),
  );
}

// Third review 6: a gateway-reported failed refund of a payment-request charge gets credit.
{
  const b = await newBiz({ billingRulesConfig: { declined_refund: "issue_credit" } });
  const { c, pm } = await customer(b.biz.id, "tok_4242");
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: b.biz.id,
    customerId: c.id,
    currency: "USD",
    lines: [{ description: "Service", amountMinor: 1000n, kind: "one_time" }],
    collect: false,
  });
  const link = await createPaymentRequest({
    organizationId: orgId,
    businessId: b.biz.id,
    customerPublicId: c.publicId,
    invoicePublicIds: [invoice.publicId],
    mode: "link",
  });
  await chargePaymentRequest({
    organizationId: orgId,
    businessId: b.biz.id,
    paymentRequestPublicId: link.request.publicId,
    paymentMethodPublicId: pm.publicId,
    initiator: "merchant",
  });
  const [child] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "succeeded")))
      .limit(1),
  );
  const ref = await refundPayment({
    organizationId: orgId,
    businessId: b.biz.id,
    paymentPublicId: child!.publicId,
    amountMinor: 400,
  });
  const [reqRow] = await systemDb
    .select({ chargeId: paymentRequests.providerChargeId })
    .from(paymentRequests)
    .where(eq(paymentRequests.publicId, link.request.publicId));
  const outcome = await applyRequestChargeRefund({
    providerKey: ref.providerKey ?? "tmtest",
    providerChargeId: reqRow!.chargeId!,
    refunds: [{ providerRefundId: ref.providerRefundId!, amountMinor: 400n, status: "failed" }],
    deliveredByBusinessId: b.biz.id,
  });
  const credit = await withTenant(orgId, (tx) => bucketBalance(tx, c.id, REFUNDABLE_CREDIT, "USD"));
  check(
    "6: a confirmed failed refund of a payment-request charge becomes credit",
    outcome === "processed" && credit === 400n,
    `outcome=${outcome} credit=${credit} ref=${ref.providerRefundId}`,
  );
}

// ── API ──────────────────────────────────────────────────────────────────────────────
{
  const created = json(
    await req("POST", "/v1/businesses", { default_currency: "USD", name: "Key-made P2" }),
  );
  check(
    "API: a key-created business keeps declined refunds blocked and no write-off",
    created.billing_rules_config?.declined_refund === "block" &&
      Object.keys(created.billing_rules_config?.partial_payment_write_off ?? {}).length === 0,
  );
  const p = json(
    await req("PATCH", `/v1/businesses/${created.id}`, {
      dunning_config: {
        final_action: { invoice: "not_paid", subscription: "pause" },
        retries_by_method: { bank_debit: [{ after_days: 3 }, { after_days: 6 }] },
        adaptive_cadence: { funds_gap_days: 3, funds_max_retries: 2 },
      },
      billing_rules_config: {
        partial_payment_write_off: { USD: 100 },
        declined_refund: "issue_credit",
      },
    }),
  );
  check(
    "API: the new keys round-trip",
    p.dunning_config?.final_action?.subscription === "pause" &&
      p.dunning_config?.retries_by_method?.bank_debit?.length === 2 &&
      p.dunning_config?.adaptive_cadence?.funds_gap_days === 3 &&
      p.billing_rules_config?.partial_payment_write_off?.USD === 100 &&
      p.billing_rules_config?.declined_refund === "issue_credit" &&
      p.billing_rules_config?.trial_end_action === "activate",
    JSON.stringify({ d: p.dunning_config, r: p.billing_rules_config }),
  );
  const refusals = await Promise.all([
    req("PATCH", `/v1/businesses/${created.id}`, {
      dunning_config: {
        retries_by_method: { bank_debit: [1, 2, 3, 4, 5, 6].map((d) => ({ after_days: d })) },
      },
    }),
    req("PATCH", `/v1/businesses/${created.id}`, {
      dunning_config: { adaptive_cadence: { transient_hours: [0] } },
    }),
    req("PATCH", `/v1/businesses/${created.id}`, {
      dunning_config: { final_action: { invoice: "not_paid", subscription: "suspend" } },
    }),
    req("PATCH", `/v1/businesses/${created.id}`, {
      billing_rules_config: { partial_payment_write_off: { usd: 100 } },
    }),
    req("PATCH", `/v1/businesses/${created.id}`, {
      billing_rules_config: { declined_refund: "retry" },
    }),
  ]);
  check(
    "API: out-of-range values are refused (6 bank retries, 0 hours, unknown action, bad currency, unknown outcome)",
    refusals.every((r) => r.statusCode === 400),
    refusals.map((r) => r.statusCode).join(","),
  );
  const pol = await req("POST", `/v1/businesses/${created.id}/dunning_policies`, {
    name: "Bank",
    code: "bank",
    config: {
      retries_by_method: { bank_debit: [{ after_days: 4 }] },
      adaptive_cadence: { generic_days: [1, 2] },
    },
  });
  const pj = json(pol);
  check(
    "API: a policy stores method schedules and cadence",
    pol.statusCode === 201 &&
      pj.config?.retries_by_method?.bank_debit?.[0]?.after_days === 4 &&
      pj.config?.adaptive_cadence?.generic_days?.join() === "1,2",
    pol.payload.slice(0, 300),
  );
  const polBad = await req("POST", `/v1/businesses/${created.id}/dunning_policies`, {
    name: "Bad",
    code: "bad",
    config: { plan_policies: {} },
  });
  check("API: a policy refuses the business-wide plan_policies key", polBad.statusCode === 400);
}

await app.close();
let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log(`\n${checks.length} checks`);
console.log(pass ? "✅ SETTINGS-DUNNING-P2: PASS" : "❌ SETTINGS-DUNNING-P2: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
