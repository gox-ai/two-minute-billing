/**
 * Cancellation analytics — who left, why, and what it cost.
 *
 * The population is the subscriptions list's own WHERE (`subscriptionListConditions`) over the
 * caller's filters, so every figure agrees with the list a drill-down opens.
 *
 * MRR lost is the ledger's, not `subscriptions.mrr` (zeroed at cancellation): the net of the
 * subscription's `churn` movements within a day of `canceled_at`, floored at zero. Netting is
 * load-bearing — a trial that churned its trial MRR and was then compensated back to zero nets
 * to nothing, and it is not a paying loss.
 *
 * Money is reported per currency and, in the business's default currency, converted at the rate
 * held on the cancellation day. A row no rate reaches is left out of the converted figures and
 * counted in `unconverted`.
 */
import { and, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { mrrMovements, products, subscriptions, customers } from "@db/schema";
import { loadRateTimeline } from "@/platform/fx/history";
import { billingModeFor } from "@/modules/subscriptions/billing-mode";
import { resolvePlanProductIds } from "./plan-of";
import { reportableCustomer } from "./reportable";
import {
  subscriptionListConditions,
  type SubscriptionListFilters,
} from "@/modules/subscriptions/service";

/**
 * What kind of subscription left. Only `paying` lost revenue; `no_mrr` had none when it ended —
 * a free plan, a pause or full discount, or history the ledger holds no churn for.
 */
export type CancellationKind = "paying" | "trial_not_converted" | "no_mrr";

/**
 * Why a PAYING subscription stopped. The first three are involuntary — the customer did not
 * choose to leave.
 */
export type CancellationCause =
  | "payment_failed"
  | "no_payment_method"
  | "chargeback"
  | "term_ended"
  /** No payment-related system reason was recorded — not proof of a choice on imported rows. */
  | "voluntary";

export const INVOLUNTARY_CAUSES: ReadonlySet<CancellationCause> = new Set([
  "payment_failed",
  "no_payment_method",
  "chargeback",
]);

/** The engine's own `cancel_reason` values; anything else in that column is a merchant's words. */
const SYSTEM_REASONS = new Set([
  "not_paid",
  "no_card",
  "trial_ended",
  "cancel_at_period_end",
  "billing_cycles_exhausted",
]);

export function causeOf(systemReason: string | null): CancellationCause {
  if (systemReason === "not_paid") return "payment_failed";
  if (systemReason === "no_card") return "no_payment_method";
  if (systemReason?.startsWith("Chargeback")) return "chargeback";
  if (systemReason === "billing_cycles_exhausted") return "term_ended";
  return "voluntary";
}

/** The `churn_kind` slice of churned MRR — the same split this report makes. */
export function churnKindOf(systemReason: string | null): "involuntary" | "voluntary" {
  return INVOLUNTARY_CAUSES.has(causeOf(systemReason)) ? "involuntary" : "voluntary";
}

/** The merchant's reason: the code, else free text an import left in the system column. */
export function merchantReasonOf(code: string | null, systemReason: string | null): string | null {
  if (code) return code;
  if (systemReason && !SYSTEM_REASONS.has(systemReason) && !systemReason.startsWith("Chargeback"))
    return systemReason;
  return null;
}

/** Tenure at cancellation, in whole months since the subscription started. */
export const TENURE_BANDS = [
  { key: "lt_1m", label: "Under 1 month", maxMonths: 1 },
  { key: "1_3m", label: "1–3 months", maxMonths: 3 },
  { key: "3_6m", label: "3–6 months", maxMonths: 6 },
  { key: "6_12m", label: "6–12 months", maxMonths: 12 },
  { key: "12_24m", label: "1–2 years", maxMonths: 24 },
  { key: "24m_plus", label: "2 years or more", maxMonths: Infinity },
] as const;

function tenureBand(startedAt: Date | null, canceledAt: Date): string | null {
  if (!startedAt) return null;
  const months =
    (canceledAt.getUTCFullYear() - startedAt.getUTCFullYear()) * 12 +
    (canceledAt.getUTCMonth() - startedAt.getUTCMonth()) -
    (canceledAt.getUTCDate() < startedAt.getUTCDate() ? 1 : 0);
  return TENURE_BANDS.find((b) => months < b.maxMonths)!.key;
}

export interface Money {
  /** Converted into `currency` of the report; excludes rows no rate reached. */
  mrr_lost_minor: number;
  mrr_lost_by_currency: Record<string, number>;
}

export interface CancellationGroup extends Money {
  count: number;
}

export interface CancellationAnalytics {
  currency: string;
  timezone: string;
  totals: CancellationGroup & {
    paying: number;
    involuntary: number;
    /** Paying cancellations whose loss no exchange rate could convert. */
    unconverted: number;
  };
  kinds: Array<CancellationGroup & { kind: CancellationKind }>;
  causes: Array<CancellationGroup & { cause: CancellationCause; involuntary: boolean }>;
  /** Paying cancellations only; `reason: null` is none recorded. */
  reasons: Array<CancellationGroup & { reason: string | null }>;
  tenure: Array<CancellationGroup & { band: string; label: string }>;
  buckets: Array<{
    start: string;
    end: string;
    count: number;
    paying: number;
    mrr_lost_minor: number;
    involuntary_mrr_lost_minor: number;
  }>;
  top_losses: Array<{
    subscription: string;
    customer: string | null;
    customer_name: string | null;
    plan: string | null;
    canceled_at: string;
    currency: string;
    mrr_lost_minor: number;
    converted_mrr_lost_minor: number | null;
    cause: CancellationCause;
    reason: string | null;
  }>;
}

const TOP_LOSSES = 10;
const DAY_MS = 86_400_000;

interface Row {
  id: string;
  publicId: string;
  canceledAt: Date;
  day: string;
  startedAt: Date | null;
  activatedAt: Date | null;
  cancelReason: string | null;
  cancelReasonCode: string | null;
  currency: string;
  customerPublicId: string | null;
  customerName: string | null;
}

export async function computeCancellationAnalytics(
  organizationId: string,
  businessId: string,
  input: {
    /** The list's filters: they define the population exactly as the drill-down list does. */
    filters: NonNullable<SubscriptionListFilters["filters"]>;
    /** Inclusive civil-day bounds in the business timezone, as `canceled_at[between]` reads them. */
    buckets?: ReadonlyArray<{ start: string; end: string }>;
  },
): Promise<CancellationAnalytics> {
  return withTenant(organizationId, async (tx) => {
    const mode = await billingModeFor(tx, businessId);
    const conds = await subscriptionListConditions(
      tx,
      businessId,
      { filters: input.filters },
      mode,
    );
    const rows = (await tx
      .select({
        id: subscriptions.id,
        publicId: subscriptions.publicId,
        canceledAt: subscriptions.canceledAt,
        day: sql<string>`to_char(${subscriptions.canceledAt} at time zone ${mode.timezone}, 'YYYY-MM-DD')`,
        startedAt: subscriptions.startedAt,
        activatedAt: subscriptions.activatedAt,
        cancelReason: subscriptions.cancelReason,
        cancelReasonCode: subscriptions.cancelReasonCode,
        currency: subscriptions.currency,
        customerPublicId: customers.publicId,
        customerName: sql<
          string | null
        >`coalesce(${customers.company}, ${customers.name}, ${customers.email})`,
      })
      .from(subscriptions)
      .leftJoin(customers, sql`${subscriptions.customerId} = ${customers.id}`)
      .where(
        and(
          ...conds,
          sql`${subscriptions.canceledAt} is not null`,
          reportableCustomer(subscriptions.customerId),
        ),
      )) as Row[];

    // The loss per subscription: its churn movements within a day of the cancellation.
    const lost = new Map<string, { minor: bigint; plan: string | null }>();
    for (let i = 0; i < rows.length; i += 1000) {
      const ids = rows.slice(i, i + 1000).map((r) => r.id);
      const moves = await tx
        .select({
          subscriptionId: mrrMovements.subscriptionId,
          occurredAt: mrrMovements.occurredAt,
          delta: mrrMovements.deltaMinor,
          plan: products.name,
        })
        .from(mrrMovements)
        .leftJoin(products, sql`${mrrMovements.planProductId} = ${products.id}`)
        .where(
          and(inArray(mrrMovements.subscriptionId, ids), sql`${mrrMovements.reason} = 'churn'`),
        );
      const at = new Map(rows.slice(i, i + 1000).map((r) => [r.id, r.canceledAt.getTime()]));
      for (const m of moves) {
        const c = at.get(m.subscriptionId);
        if (c == null || Math.abs(m.occurredAt.getTime() - c) > DAY_MS) continue;
        const prev = lost.get(m.subscriptionId);
        lost.set(m.subscriptionId, {
          minor: (prev?.minor ?? 0n) - m.delta,
          plan: prev?.plan ?? m.plan ?? null,
        });
      }
    }

    const timeline = await loadRateTimeline(tx, businessId);
    const base = timeline.base;
    const toBase = (minor: bigint, ccy: string, at: Date): bigint | null => {
      if (ccy.toUpperCase() === base) return minor;
      const rate = Number(timeline.rateAt(ccy.toUpperCase(), at));
      return Number.isFinite(rate) && rate > 0 ? BigInt(Math.round(Number(minor) / rate)) : null;
    };

    const group = () => ({ count: 0, base: 0n, byCcy: new Map<string, bigint>() });
    type G = ReturnType<typeof group>;
    const add = (g: G, minor: bigint, converted: bigint | null, ccy: string) => {
      g.count++;
      if (minor > 0n) g.byCcy.set(ccy, (g.byCcy.get(ccy) ?? 0n) + minor);
      if (converted != null) g.base += converted;
    };
    const out = (g: G): CancellationGroup => ({
      count: g.count,
      mrr_lost_minor: Number(g.base),
      mrr_lost_by_currency: Object.fromEntries([...g.byCcy].map(([c, v]) => [c, Number(v)])),
    });

    const total = group();
    const kinds = new Map<CancellationKind, G>();
    const causes = new Map<CancellationCause, G>();
    const reasons = new Map<string | null, G>();
    const tenure = new Map<string, G>(TENURE_BANDS.map((b) => [b.key, group()]));
    const buckets = (input.buckets ?? []).map((b) => ({ ...b, all: 0, paying: group(), inv: 0n }));
    const top: CancellationAnalytics["top_losses"] = [];
    let paying = 0;
    let involuntary = 0;
    let unconverted = 0;

    for (const r of rows) {
      const loss = lost.get(r.id);
      const minor = loss && loss.minor > 0n ? loss.minor : 0n;
      const ccy = r.currency.toUpperCase();
      const converted = minor > 0n ? toBase(minor, ccy, r.canceledAt) : 0n;
      const kind: CancellationKind =
        minor > 0n ? "paying" : r.activatedAt == null ? "trial_not_converted" : "no_mrr";
      add(total, minor, converted, ccy);
      if (!kinds.has(kind)) kinds.set(kind, group());
      add(kinds.get(kind)!, minor, converted, ccy);

      const bucket = buckets.find((b) => r.day >= b.start && r.day <= b.end);
      if (bucket) bucket.all++;
      if (kind !== "paying") continue;

      paying++;
      if (converted == null) unconverted++;
      const cause = causeOf(r.cancelReason);
      if (INVOLUNTARY_CAUSES.has(cause)) involuntary++;
      if (!causes.has(cause)) causes.set(cause, group());
      add(causes.get(cause)!, minor, converted, ccy);
      const reason = merchantReasonOf(r.cancelReasonCode, r.cancelReason);
      if (!reasons.has(reason)) reasons.set(reason, group());
      add(reasons.get(reason)!, minor, converted, ccy);
      const band = tenureBand(r.startedAt, r.canceledAt);
      if (band) add(tenure.get(band)!, minor, converted, ccy);
      if (bucket) {
        add(bucket.paying, minor, converted, ccy);
        if (INVOLUNTARY_CAUSES.has(cause) && converted != null) bucket.inv += converted;
      }
      top.push({
        subscription: r.publicId,
        customer: r.customerPublicId,
        customer_name: r.customerName,
        plan: loss?.plan ?? null,
        canceled_at: r.canceledAt.toISOString(),
        currency: ccy,
        mrr_lost_minor: Number(minor),
        converted_mrr_lost_minor: converted == null ? null : Number(converted),
        cause,
        reason,
      });
    }

    top.sort((a, b) => (b.converted_mrr_lost_minor ?? -1) - (a.converted_mrr_lost_minor ?? -1));
    const largest = top.slice(0, TOP_LOSSES);
    // An imported churn carries no plan; the subscription's own plan item still names it.
    const unnamed = largest.filter((t) => t.plan == null);
    if (unnamed.length > 0) {
      const idOf = new Map(rows.map((r) => [r.publicId, r.id]));
      const planIds = await resolvePlanProductIds(
        tx,
        unnamed.map((t) => idOf.get(t.subscription)!),
      );
      const productIds = [...new Set([...planIds.values()].filter((v): v is string => v != null))];
      const names = productIds.length
        ? new Map(
            (
              await tx
                .select({ id: products.id, name: products.name })
                .from(products)
                .where(inArray(products.id, productIds))
            ).map((p) => [p.id, p.name]),
          )
        : new Map<string, string>();
      for (const t of unnamed) {
        const pid = planIds.get(idOf.get(t.subscription)!);
        t.plan = pid ? (names.get(pid) ?? null) : null;
      }
    }
    const byLoss = <T extends CancellationGroup>(a: T, b: T) =>
      b.mrr_lost_minor - a.mrr_lost_minor || b.count - a.count;

    return {
      currency: base,
      timezone: mode.timezone,
      totals: { ...out(total), paying, involuntary, unconverted },
      kinds: [...kinds].map(([kind, g]) => ({ kind, ...out(g) })).sort(byLoss),
      causes: [...causes]
        .map(([cause, g]) => ({ cause, involuntary: INVOLUNTARY_CAUSES.has(cause), ...out(g) }))
        .sort(byLoss),
      reasons: [...reasons].map(([reason, g]) => ({ reason, ...out(g) })).sort(byLoss),
      tenure: TENURE_BANDS.map((b) => ({
        band: b.key,
        label: b.label,
        ...out(tenure.get(b.key)!),
      })),
      buckets: buckets.map((b) => ({
        start: b.start,
        end: b.end,
        count: b.all,
        paying: b.paying.count,
        mrr_lost_minor: Number(b.paying.base),
        involuntary_mrr_lost_minor: Number(b.inv),
      })),
      top_losses: largest,
    };
  });
}
