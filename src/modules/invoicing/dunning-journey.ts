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
import { and, asc, eq, inArray } from "drizzle-orm";
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
  parkedDunningDeadline,
  planFailureRearm,
  type DunningConfig,
  dunningAnchor,
} from "@/modules/subscriptions/dunning-schedule";
import { dunningHoldFor, isAutoCollectOn } from "./service";
import { RAIL_LIMIT_CODE, RAIL_SPACING_CODE } from "./representment";

export type JourneyTrigger =
  | "billing_clock"
  | "dashboard"
  | "portal"
  | "new_payment_method"
  | "offline"
  | "api";

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
        return { trigger: "offline", actor: rec?.source === "dashboard" ? rec.actor : null };
      }
      if (trace?.startsWith("job-")) return { trigger: "billing_clock", actor: null };
      const byTrace = trace ? audits.filter((a) => a.traceId === trace) : [];
      // A refusal booked before any gateway call has no transaction; the request that made
      // it wrote its audit row on the invoice within the same moment.
      const rows = byTrace.length
        ? byTrace
        : invoiceAudits.filter((a) => Math.abs(a.at.getTime() - at.getTime()) < 5_000);
      if (rows.some((a) => a.action === "customer.add_payment_method"))
        return { trigger: "new_payment_method", actor: null };
      const row = rows[0];
      if (!row) return { trigger: trace ? "api" : null, actor: null };
      if (row.actor.startsWith("psess_")) return { trigger: "portal", actor: null };
      if (row.source === "dashboard") return { trigger: "dashboard", actor: row.actor };
      if (row.source === "scheduled_job") return { trigger: "billing_clock", actor: null };
      return { trigger: "api", actor: null };
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
          actor: a.source === "dashboard" ? a.actor : null,
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
    const failed = [...pays].reverse().find((p) => p.pay.status === "failed");
    const lastCode = failed?.pay.failureCode ?? undefined;
    const retriable = failed ? (traceOf.get(failed.pay.id)?.retriable ?? true) : true;
    const rail = failed?.rail ?? null;
    const issuerZones = failed?.issuerCountry
      ? ((
          await tx
            .select({ z: countries.timezones })
            .from(countries)
            .where(eq(countries.code, failed.issuerCountry))
            .limit(1)
        )[0]?.z ?? null)
      : null;
    const cap = networkRetryCap(rail);
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
        adaptiveTiming: cfg.adaptiveTiming,
        timezone: input.business.timezone ?? null,
        issuerZones,
        methodType: failed?.type ?? null,
        retriesByMethod: cfg.retriesByMethod,
        adaptiveCadence: cfg.adaptiveCadence,
        priorMethods: [...priorMethods],
      });
      priorMethods.push({ type: failed?.type ?? null, rail });
      if (plan.action === "retry") {
        at = plan.nextAttempt;
        continue;
      }
      if (plan.action === "parked") {
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
          ? { kind: s.kind, at: iso(s.at), until: iso(s.until), reason: s.reason }
          : s.kind === "final_action"
            ? { kind: s.kind, at: iso(s.at), invoice: s.invoice, subscription: s.subscription }
            : { kind: s.kind, at: iso(s.at) },
      ) ?? null,
    projection_note: j.projectionNote,
  };
}
