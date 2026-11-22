/**
 * An invoice's dunning journey: every collection attempt so far, the dunning events around
 * them, and what the engine will do next if each retry fails.
 *
 * The projection runs `planFailureRearm` forward with the invoice's own last decline, the
 * business's resolved config and the instrument's rail, so it is the engine's answer rather
 * than the settings screen's. It is a forecast: a different decline, a new card or a manual
 * collect changes it.
 */
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import {
  auditLogs,
  countries,
  customers,
  events,
  invoices,
  paymentMethods,
  payments,
  subscriptions,
  transactions,
} from "@db/schema";
import {
  dunningAppliesTo,
  dunningPeriodEndsAt,
  networkRetryCap,
  retryRailOf,
  parkedDunningDeadline,
  planFailureRearm,
  type DunningConfig,
  dunningAnchor,
} from "@/modules/subscriptions/dunning-schedule";
import { dunningHoldFor, isAutoCollectOn } from "./service";
import { RAIL_LIMIT_CODE, RAIL_SPACING_CODE } from "./representment";
import { isOurRequestFault } from "@/providers/decline-codes";
import { creationEvents } from "@/modules/events/provenance";

export type JourneyTrigger =
  | "billing_clock"
  | "dashboard"
  | "portal"
  | "new_payment_method"
  | "offline"
  | "api"
  /** The buyer paid on hosted checkout. */
  | "checkout"
  /** A gateway notification completed it; `actor` is the gateway key. */
  | "webhook"
  /** An AI agent over OAuth/MCP. */
  | "mcp";

/**
 * Who started a collection attempt, from its trace and the audit rows of the same request.
 * Says nothing (null) when nothing recorded it, rather than guessing "the API".
 */
export function attributeAttempt(
  trace: string | null,
  providerKey: string,
  rows: { actor: string; source: string; action: string }[],
): { trigger: JourneyTrigger | null; actor: string | null } {
  if (trace?.startsWith("job-")) return { trigger: "billing_clock", actor: null };
  if (rows.some((a) => a.action === "customer.add_payment_method"))
    return { trigger: "new_payment_method", actor: null };
  // A delivery (or its replay) runs in its own trace: the gateway's notice completed it.
  if (trace?.startsWith("hook-") || trace?.startsWith("replay-"))
    return { trigger: "webhook", actor: providerKey };
  const row = rows[0];
  if (!row) return { trigger: null, actor: null };
  if (row.actor.startsWith("psess_") || row.source === "portal")
    return { trigger: "portal", actor: null };
  if (row.actor.startsWith("cosess_") || row.source === "checkout")
    return { trigger: "checkout", actor: null };
  if (row.source === "dashboard" || row.source === "assistant")
    return { trigger: "dashboard", actor: row.actor };
  if (row.source === "scheduled_job") return { trigger: "billing_clock", actor: null };
  if (row.source === "webhook") return { trigger: "webhook", actor: row.actor || providerKey };
  if (row.source === "mcp") return { trigger: "mcp", actor: null };
  if (row.source === "api") return { trigger: "api", actor: null };
  return { trigger: null, actor: null };
}

export type Attribution = { trigger: JourneyTrigger | null; actor: string | null };

/** Traces that name their own trigger need no audit rows. */
const SELF_ATTRIBUTED = /^(job|hook|replay)-/;

/**
 * Who started each transaction, for a whole page: ONE query on the audit rows of every trace.
 * The result lines up with `txns`.
 */
export async function attributeTransactions(
  organizationId: string,
  txns: { traceId: string | null; gatewayKey: string | null }[],
): Promise<Attribution[]> {
  const traces = [
    ...new Set(
      txns.map((t) => t.traceId).filter((t): t is string => !!t && !SELF_ATTRIBUTED.test(t)),
    ),
  ];
  const byTrace = new Map<string, { actor: string; source: string; action: string }[]>();
  if (traces.length > 0) {
    const rows = await withTenant(organizationId, (tx) =>
      tx
        .select({
          traceId: auditLogs.traceId,
          actor: auditLogs.actor,
          source: auditLogs.source,
          action: auditLogs.action,
        })
        .from(auditLogs)
        .where(inArray(auditLogs.traceId, traces))
        .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id)),
    );
    for (const r of rows) {
      const list = byTrace.get(r.traceId!) ?? [];
      list.push(r);
      byTrace.set(r.traceId!, list);
    }
  }
  return txns.map((t) =>
    attributeAttempt(t.traceId, t.gatewayKey ?? "", (t.traceId && byTrace.get(t.traceId)) || []),
  );
}

/** Who started one transaction. Null trigger when nothing recorded it. */
export async function attributeTransaction(
  organizationId: string,
  txn: { traceId: string | null; gatewayKey: string | null },
): Promise<Attribution> {
  return (await attributeTransactions(organizationId, [txn]))[0]!;
}

/**
 * Who started the charge that paid: the first succeeded payment transaction found by its own
 * id, its payment, or its payment request. Null trigger when there is none.
 */
export async function attributePayingTransaction(
  organizationId: string,
  by: {
    transactionId?: string | null;
    paymentId?: string | null;
    paymentRequestId?: string | null;
  },
): Promise<Attribution> {
  const match = [
    by.transactionId ? eq(transactions.id, by.transactionId) : null,
    by.paymentId ? eq(transactions.paymentId, by.paymentId) : null,
    by.paymentRequestId ? eq(transactions.paymentRequestId, by.paymentRequestId) : null,
  ].filter((c) => c !== null);
  if (match.length === 0) return { trigger: null, actor: null };
  const [txn] = await withTenant(organizationId, (tx) =>
    tx
      .select({ traceId: transactions.traceId, gatewayKey: transactions.gatewayKey })
      .from(transactions)
      .where(
        and(or(...match), eq(transactions.type, "payment"), eq(transactions.status, "succeeded")),
      )
      .orderBy(asc(transactions.createdAt), asc(transactions.id))
      .limit(1),
  );
  return txn ? attributeTransaction(organizationId, txn) : { trigger: null, actor: null };
}

/**
 * Who created each payment intent, from its creation event, for a whole page (ONE query).
 * Keyed by the intent's public id; an intent with no event is absent.
 */
export async function attributeIntents(
  organizationId: string,
  intents: { publicId: string; gatewayKey: string | null }[],
): Promise<Map<string, Attribution>> {
  const created = await creationEvents(
    organizationId,
    "payment_intent",
    intents.map((i) => i.publicId),
  );
  const out = new Map<string, Attribution>();
  for (const i of intents) {
    const e = created.get(i.publicId);
    if (!e) continue;
    out.set(
      i.publicId,
      attributeAttempt(e.traceId, i.gatewayKey ?? "", [
        { actor: e.actor ?? "", source: e.source, action: e.type },
      ]),
    );
  }
  return out;
}

export interface JourneyAttempt {
  kind: "attempt";
  at: Date;
  payment: string;
  status: string;
  amountMinor: bigint;
  currency: string;
  paymentMethod: {
    brand: string | null;
    last4: string | null;
    type: string;
    rail: string | null;
  } | null;
  failureCode: string | null;
  failureMessage: string | null;
  /** False when our own pre-flight refused it: nothing was sent to the gateway or network. */
  presented: boolean;
  trigger: JourneyTrigger | null;
  actor: string | null;
  /** The transaction booked for it; null when nothing reached a gateway. */
  transaction: string | null;
  /**
   * Whether it used a slot of the retry schedule. Manual collections and portal payments
   * don't (`collectInvoice.manualAttempt`); the clock and a new payment method's charge do.
   */
  counted: boolean;
  /** Offline payments: the method recorded (cash, cheque, bank transfer…). */
  offlineMethod: string | null;
}

export interface JourneyEvent {
  kind: "event";
  at: Date;
  type: string;
  actor: string | null;
}

export type JourneyStep =
  | { kind: "retry"; at: Date }
  | { kind: "hold"; at: Date; until: Date; reason: "parked" | "network_limit" }
  /** Parked because a gateway refused OUR request: no deadline and no final action. */
  | { kind: "hold"; at: Date; until: null; reason: "parked_for_ops" }
  | { kind: "deadline_attempt"; at: Date }
  | {
      kind: "final_action";
      at: Date;
      invoice: DunningConfig["finalAction"]["invoice"];
      subscription: DunningConfig["finalAction"]["subscription"] | null;
    };

export interface DunningJourney {
  history: Array<JourneyAttempt | JourneyEvent>;
  /** Null when nothing more will happen automatically (paid, voided, stopped, send-invoice…). */
  projection: JourneyStep[] | null;
  /** Why there is no projection, when there is none. */
  projectionNote:
    | "settled"
    | "stopped"
    | "exhausted"
    | "auto_collect_off"
    | "dunning_off"
    | "customer_excluded"
    | "below_minimum"
    | null;
  periodEndsAt: Date | null;
}

const JOURNEY_EVENTS = [
  "invoice_dunning_started",
  "invoice_dunning_reminder",
  "invoice_dunning_exhausted",
  "invoice_paid",
  "invoice_not_paid",
  "invoice_voided",
  "invoice_written_off",
];
const JOURNEY_AUDIT = ["invoice.pause_dunning", "invoice.stop_dunning", "invoice.record_payment"];
const NOT_PRESENTED_PROVIDER = "none";
const MAX_STEPS = 16;

export async function getDunningJourney(input: {
  organizationId: string;
  business: {
    id: string;
    dunningConfig?: unknown;
    dunningRetryDays?: unknown;
    timezone?: string | null;
  };
  invoicePublicId: string;
  now?: Date;
}): Promise<DunningJourney | null> {
  const now = input.now ?? new Date();
  return withTenant(input.organizationId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.businessId, input.business.id),
          eq(invoices.publicId, input.invoicePublicId),
        ),
      )
      .limit(1);
    if (!inv) return null;
    const cfg = await loadEffectiveDunningConfig(tx, {
      businessId: input.business.id,
      customerId: inv.customerId,
      subscriptionId: inv.subscriptionId,
    });

    const pays = await tx
      .select({
        pay: payments,
        brand: paymentMethods.brand,
        last4: paymentMethods.last4,
        type: paymentMethods.type,
        rail: paymentMethods.mandateRail,
        issuerCountry: paymentMethods.issuerCountry,
      })
      .from(payments)
      .leftJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
      .where(eq(payments.invoiceId, inv.id))
      .orderBy(asc(payments.createdAt));
    const txns = pays.length
      ? await tx
          .select({
            paymentId: transactions.paymentId,
            publicId: transactions.publicId,
            type: transactions.type,
            traceId: transactions.traceId,
            retriable: transactions.retriable,
          })
          .from(transactions)
          .where(
            inArray(
              transactions.paymentId,
              pays.map((p) => p.pay.id),
            ),
          )
      : [];
    // One payment can carry an authorization and a payment row; the payment is the attempt.
    const traceOf = new Map<string | null, (typeof txns)[number]>();
    for (const t of txns)
      if (!traceOf.has(t.paymentId) || t.type === "payment") traceOf.set(t.paymentId, t);
    const traces = txns.map((t) => t.traceId).filter((t): t is string => !!t);
    const audits = await tx
      .select({
        at: auditLogs.createdAt,
        actor: auditLogs.actor,
        source: auditLogs.source,
        action: auditLogs.action,
        traceId: auditLogs.traceId,
        resourceId: auditLogs.resourceId,
      })
      .from(auditLogs)
      .where(
        traces.length ? inArray(auditLogs.traceId, traces) : eq(auditLogs.resourceId, inv.publicId),
      );
    const invoiceAudits = traces.length
      ? await tx
          .select({
            at: auditLogs.createdAt,
            actor: auditLogs.actor,
            source: auditLogs.source,
            action: auditLogs.action,
            traceId: auditLogs.traceId,
            resourceId: auditLogs.resourceId,
          })
          .from(auditLogs)
          .where(eq(auditLogs.resourceId, inv.publicId))
      : audits;
    const evs = await tx
      .select({ at: events.createdAt, type: events.type, actor: events.actor })
      .from(events)
      .where(
        and(
          eq(events.resourceType, "invoice"),
          eq(events.resourceId, inv.publicId),
          inArray(events.type, JOURNEY_EVENTS),
        ),
      )
      .orderBy(asc(events.createdAt));

    const attribution = (
      payId: string,
      at: Date,
      providerKey: string,
    ): { trigger: JourneyTrigger | null; actor: string | null } => {
      const trace = traceOf.get(payId)?.traceId ?? null;
      if (providerKey.startsWith("offline")) {
        const rec = invoiceAudits.find(
          (a) =>
            a.action === "invoice.record_payment" &&
            Math.abs(a.at.getTime() - at.getTime()) < 5_000,
        );
        return {
          trigger: "offline",
          actor:
            rec && (rec.source === "dashboard" || rec.source === "assistant") ? rec.actor : null,
        };
      }
      if (trace?.startsWith("job-")) return { trigger: "billing_clock", actor: null };
      const byTrace = trace ? audits.filter((a) => a.traceId === trace) : [];
      // A refusal booked before any gateway call has no transaction; the request that made
      // it wrote its audit row on the invoice within the same moment.
      const rows = byTrace.length
        ? byTrace
        : invoiceAudits.filter((a) => Math.abs(a.at.getTime() - at.getTime()) < 5_000);
      return attributeAttempt(trace, providerKey, rows);
    };

    const withCounted = (a: { trigger: JourneyTrigger | null; actor: string | null }) => ({
      ...a,
      counted: a.trigger === "billing_clock" || a.trigger === "new_payment_method",
    });

    const history: Array<JourneyAttempt | JourneyEvent> = [
      ...pays.map(({ pay, brand, last4, type, rail }): JourneyAttempt => ({
        kind: "attempt",
        at: pay.createdAt,
        payment: pay.publicId,
        status: pay.status,
        amountMinor: pay.amountMinor,
        currency: pay.currency,
        paymentMethod: type ? { brand, last4, type, rail } : null,
        failureCode: pay.failureCode,
        failureMessage: pay.failureMessage,
        presented: pay.providerKey !== NOT_PRESENTED_PROVIDER,
        transaction: traceOf.get(pay.id)?.publicId ?? null,
        offlineMethod: pay.providerKey.startsWith("offline")
          ? (pay.providerChargeId ?? null)
          : null,
        ...withCounted(attribution(pay.id, pay.createdAt, pay.providerKey)),
      })),
      ...evs.map((e): JourneyEvent => ({ kind: "event", at: e.at, type: e.type, actor: e.actor })),
      ...invoiceAudits
        // The offline payment row itself says it was recorded.
        .filter((a) => JOURNEY_AUDIT.includes(a.action) && a.action !== "invoice.record_payment")
        .map((a): JourneyEvent => ({
          kind: "event",
          at: a.at,
          type: a.action,
          actor: a.source === "dashboard" || a.source === "assistant" ? a.actor : null,
        })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());

    const periodEndsAt = dunningPeriodEndsAt(cfg, dunningAnchor(inv));
    const base = { history, periodEndsAt };

    if (inv.status === "paid" || inv.status === "voided")
      return { ...base, projection: null, projectionNote: "settled" };
    if (inv.dunningStatus === "stopped")
      return { ...base, projection: null, projectionNote: "stopped" };
    if (inv.status === "not_paid")
      return { ...base, projection: null, projectionNote: "exhausted" };

    const sub = inv.subscriptionId
      ? (
          await tx
            .select({ status: subscriptions.status, autoCollection: subscriptions.autoCollection })
            .from(subscriptions)
            .where(eq(subscriptions.id, inv.subscriptionId))
            .limit(1)
        )[0]
      : undefined;
    const [cust] = await tx
      .select({ autoCollection: customers.autoCollection })
      .from(customers)
      .where(eq(customers.id, inv.customerId))
      .limit(1);
    if (!isAutoCollectOn(sub?.autoCollection ?? null, cust?.autoCollection))
      return { ...base, projection: null, projectionNote: "auto_collect_off" };
    if (
      !dunningAppliesTo(cfg, {
        hasSubscription: !!inv.subscriptionId,
        subscriptionStatus: sub?.status ?? null,
        purpose: inv.purpose,
      })
    )
      return { ...base, projection: null, projectionNote: "dunning_off" };
    const hold = await dunningHoldFor(tx, inv, cfg);
    if (hold) return { ...base, projection: null, projectionNote: hold };

    const finalAction = (at: Date): JourneyStep => ({
      kind: "final_action",
      at,
      invoice: cfg.finalAction.invoice,
      subscription: inv.subscriptionId ? cfg.finalAction.subscription : null,
    });

    // The newest refusal, read once: it decides a request-fault park and the forecast.
    const failed = [...pays].reverse().find((p) => p.pay.status === "failed");
    const requestFault = isOurRequestFault({
      code: failed?.pay.failureCode,
      message: failed?.pay.failureMessage,
    });
    const opsHold = (at: Date): JourneyStep => ({
      kind: "hold",
      at,
      until: null,
      reason: "parked_for_ops",
    });

    if (inv.dunningStatus === "parked" && requestFault)
      return { ...base, projectionNote: null, projection: [opsHold(inv.dunningParkedAt ?? now)] };
    if (inv.dunningStatus === "parked") {
      const until = parkedDunningDeadline(cfg, inv.dunningParkedAt ?? inv.dueDate ?? inv.createdAt);
      return {
        ...base,
        projectionNote: null,
        projection: [
          { kind: "hold", at: inv.dunningParkedAt ?? now, until, reason: "parked" },
          { kind: "deadline_attempt", at: until },
          finalAction(until),
        ],
      };
    }
    if (!inv.nextAttemptAt) return { ...base, projection: null, projectionNote: null };

    // Forecast from the latest attempt: its decline, its instrument and that rail's cap.
    const lastCode = failed?.pay.failureCode ?? undefined;
    const retriable = failed ? (traceOf.get(failed.pay.id)?.retriable ?? true) : true;
    const rail = retryRailOf(failed ? { ...failed, mandateRail: failed.rail } : null);
    const issuerZones = failed?.issuerCountry
      ? ((
          await tx
            .select({ z: countries.timezones })
            .from(countries)
            .where(eq(countries.code, failed.issuerCountry))
            .limit(1)
        )[0]?.z ?? null)
      : null;
    const cap = networkRetryCap(rail, failed?.issuerCountry);
    let presentedOnRail = failed
      ? pays.filter(
          (p) =>
            p.pay.paymentMethodId === failed.pay.paymentMethodId &&
            p.pay.status === "failed" &&
            p.pay.providerKey !== NOT_PRESENTED_PROVIDER &&
            p.pay.failureCode !== RAIL_LIMIT_CODE &&
            p.pay.failureCode !== RAIL_SPACING_CODE,
        ).length
      : 0;

    const steps: JourneyStep[] = [];
    // Earlier failed instruments, then each projected attempt on the latest one.
    const priorMethods = pays
      .filter((p) => p.pay.status === "failed")
      .map((p) => ({ type: p.type ?? null, rail: p.rail ?? null }));
    let at = inv.nextAttemptAt;
    let attemptCount = inv.attemptCount;
    for (let i = 0; i < MAX_STEPS; i++) {
      const isDeadline = periodEndsAt != null && at.getTime() >= periodEndsAt.getTime();
      if (cap != null && presentedOnRail >= 1 + cap) {
        // The network limit is spent: nothing more is presented, and the period decides the end.
        const end = periodEndsAt && periodEndsAt > at ? periodEndsAt : at;
        if (end > at) steps.push({ kind: "hold", at, until: end, reason: "network_limit" });
        steps.push(finalAction(end));
        break;
      }
      steps.push(isDeadline ? { kind: "deadline_attempt", at } : { kind: "retry", at });
      presentedOnRail++;
      attemptCount++;
      const plan = planFailureRearm({
        dunningStatus: "in_progress",
        currentNextAttemptAt: null,
        autoCollectOn: true,
        retriable,
        newAttemptCount: attemptCount,
        retryDays: cfg.retryDays,
        now: at,
        mode: cfg.mode,
        declineCode: lastCode,
        skipRetriesForHardFailures: cfg.skipRetriesForHardFailures,
        parkHardDeclines: cfg.parkHardDeclines,
        dunningApplies: true,
        periodEndsAt,
        dueDate: dunningAnchor(inv),
        mandateRail: rail,
        issuerCountry: failed?.issuerCountry ?? null,
        adaptiveTiming: cfg.adaptiveTiming,
        timezone: input.business.timezone ?? null,
        issuerZones,
        methodType: failed?.type ?? null,
        retriesByMethod: cfg.retriesByMethod,
        adaptiveCadence: cfg.adaptiveCadence,
        priorMethods: [...priorMethods],
        requestFault,
      });
      priorMethods.push({ type: failed?.type ?? null, rail });
      if (plan.action === "retry") {
        at = plan.nextAttempt;
        continue;
      }
      if (plan.action === "parked" && requestFault) {
        steps.push(opsHold(at));
      } else if (plan.action === "parked") {
        const until = parkedDunningDeadline(cfg, at);
        steps.push(
          { kind: "hold", at, until, reason: "parked" },
          { kind: "deadline_attempt", at: until },
          finalAction(until),
        );
      } else if (plan.action === "exhausted") {
        steps.push(finalAction(at));
      }
      break;
    }
    return { ...base, projection: steps, projectionNote: null };
  });
}

export function serializeDunningJourney(j: DunningJourney) {
  const iso = (d: Date) => d.toISOString();
  return {
    object: "dunning_journey",
    period_ends_at: j.periodEndsAt ? iso(j.periodEndsAt) : null,
    history: j.history.map((h) =>
      h.kind === "attempt"
        ? {
            kind: "attempt",
            at: iso(h.at),
            payment: h.payment,
            status: h.status,
            amount_minor: Number(h.amountMinor),
            currency: h.currency,
            payment_method: h.paymentMethod,
            failure_code: h.failureCode,
            failure_message: h.failureMessage,
            presented: h.presented,
            trigger: h.trigger,
            actor: h.actor,
            transaction: h.transaction,
            counted: h.counted,
            offline_method: h.offlineMethod,
          }
        : { kind: "event", at: iso(h.at), type: h.type, actor: h.actor },
    ),
    projection:
      j.projection?.map((s) =>
        s.kind === "hold"
          ? { kind: s.kind, at: iso(s.at), until: s.until ? iso(s.until) : null, reason: s.reason }
          : s.kind === "final_action"
            ? { kind: s.kind, at: iso(s.at), invoice: s.invoice, subscription: s.subscription }
            : { kind: s.kind, at: iso(s.at) },
      ) ?? null,
    projection_note: j.projectionNote,
  };
}
