/**
 * Live credit balance (design G3 §3.5): derived on every read, never stored. Grants left after a
 * simulated drawdown of unbilled usage, less open holds. An estimate; the invoice is the truth.
 */
import { resolveGrantScopes } from "./scope";
import { isExactWindowGrant } from "./reset-windows";
import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { MONEY_RATE, stepsForMinor } from "./units";
import { planGrantApplication, type PlannerGrant, type PlannerLine } from "./planner";
import type {
  BusinessCreditConfig,
  CreditApplicability,
  CreditOnExhausted,
  CreditTaxTreatment,
  CustomerCreditSettings,
} from "@db/schema";
import { ratedUnbilledUsage, type UnbilledUsageLine } from "./usage";
import { sliceUsageLines } from "./slices";

export interface BalanceGrant {
  id: string;
  publicId: string;
  unitId: string | null;
  unitKey: string | null;
  unit: { minorPerUnitE12: bigint; decimals: number } | null;
  category: "paid" | "promotional";
  priority: number;
  source: string;
  sourceRef: string | null;
  effectiveAt: Date;
  expiresAt: Date | null;
  applicability: CreditApplicability;
  taxTreatment: CreditTaxTreatment | null;
  onExhausted: CreditOnExhausted | null;
  amount: bigint;
  costBasisMinor: bigint;
  unitsLeft: bigint;
  faceLeft: bigint;
  costLeft: bigint;
}

export interface BalanceSnapshot {
  grants: BalanceGrant[];
  openHoldsMinor: bigint;
  openHoldCount: number;
}

/**
 * Active grants with what is left (Σ movements) and the open holds, in one statement: the two
 * partial indexes `credit_grants_customer_live_idx` and `credit_holds_customer_held_idx`.
 */
export async function loadBalanceSnapshot(
  tx: Tx,
  input: { customerId: string; currency: string; now: Date },
): Promise<BalanceSnapshot> {
  const cur = input.currency.toUpperCase();
  const rows = (await tx.execute(sql`
    with g as (
      select g.id, g.public_id, g.unit_id, u.key as unit_key, u.minor_per_unit_e12, u.decimals,
        g.category, g.priority, g.source, g.source_ref, g.effective_at, g.expires_at, g.applicability,
        g.tax_treatment, g.on_exhausted, g.amount::text as amount, g.cost_basis_minor::text as cost_basis,
        coalesce(m.units, 0)::text as units_left, coalesce(m.face, 0)::text as face_left,
        coalesce(m.cost, 0)::text as cost_left
      from credit_grants g left join credit_units u on u.id = g.unit_id
      left join lateral (
        select sum(units) as units, sum(face_minor) as face, sum(cost_minor) as cost
        from credit_grant_movements where grant_id = g.id
      ) m on true
      where g.customer_id = ${input.customerId} and g.currency = ${cur} and g.status = 'active'
    ), h as (
      select coalesce(sum(amount_minor), 0)::text as held, count(*)::int as n
      from credit_holds
      where customer_id = ${input.customerId} and status = 'held' and currency = ${cur}
        and expires_at > ${input.now.toISOString()}::timestamptz
    )
    select 'h' as kind, null as id, null as public_id, null as unit_id, null as unit_key,
      null as minor_per_unit_e12, null as decimals, null as category, null as priority,
      null as source, null as source_ref, null as effective_at, null as expires_at, null as applicability,
      null as tax_treatment, null as on_exhausted, null as amount, null as cost_basis,
      h.held as units_left, h.n::text as face_left, null as cost_left
    from h
    union all
    select 'g', g.id::text, g.public_id, g.unit_id::text, g.unit_key, g.minor_per_unit_e12::text,
      g.decimals, g.category, g.priority, g.source, g.source_ref, g.effective_at, g.expires_at, g.applicability,
      g.tax_treatment, g.on_exhausted, g.amount, g.cost_basis, g.units_left, g.face_left, g.cost_left
    from g`)) as unknown as Array<Record<string, unknown>>;
  let openHoldsMinor = 0n;
  let openHoldCount = 0;
  const grants: BalanceGrant[] = [];
  for (const r of rows) {
    if (r.kind === "h") {
      openHoldsMinor = BigInt(r.units_left as string);
      openHoldCount = Number(r.face_left);
      continue;
    }
    grants.push({
      id: r.id as string,
      publicId: r.public_id as string,
      unitId: (r.unit_id as string | null) ?? null,
      unitKey: (r.unit_key as string | null) ?? null,
      unit:
        r.minor_per_unit_e12 != null
          ? {
              minorPerUnitE12: BigInt(r.minor_per_unit_e12 as string),
              decimals: Number(r.decimals),
            }
          : null,
      category: r.category as "paid" | "promotional",
      priority: Number(r.priority),
      source: r.source as string,
      sourceRef: (r.source_ref as string | null) ?? null,
      effectiveAt: new Date(r.effective_at as string),
      expiresAt: r.expires_at ? new Date(r.expires_at as string) : null,
      applicability: (r.applicability as CreditApplicability) ?? { kind: "metered" },
      taxTreatment: (r.tax_treatment as CreditTaxTreatment | null) ?? null,
      onExhausted: (r.on_exhausted as CreditOnExhausted | null) ?? null,
      amount: BigInt(r.amount as string),
      costBasisMinor: BigInt(r.cost_basis as string),
      unitsLeft: BigInt(r.units_left as string),
      faceLeft: BigInt(r.face_left as string),
      costLeft: BigInt(r.cost_left as string),
    });
  }
  return {
    grants: await resolveGrantScopes(tx, { customerId: input.customerId }, grants),
    openHoldsMinor,
    openHoldCount,
  };
}

/** Whether a grant may pay a usage line for this price (public id) and window (§3.3). */
export function grantApplies(
  g: Pick<BalanceGrant, "applicability" | "effectiveAt" | "expiresAt">,
  line: { pricePublicId: string; window: { start: Date; end: Date } },
): boolean {
  if (g.effectiveAt.getTime() >= line.window.end.getTime()) return false;
  if (g.expiresAt && g.expiresAt.getTime() <= line.window.start.getTime()) return false;
  if (g.applicability?.kind === "prices")
    return (g.applicability.prices ?? []).includes(line.pricePublicId);
  // An unresolved meter scope covers nothing (`resolveGrantScopes` runs first).
  return g.applicability?.kind !== "meters";
}

export function toPlanner(g: BalanceGrant): PlannerGrant {
  return {
    id: g.id,
    category: g.category,
    source: g.source,
    priority: g.priority,
    effectiveAt: g.effectiveAt,
    expiresAt: g.expiresAt,
    taxTreatment: g.taxTreatment,
    unitId: g.unitId,
    applicability: g.applicability,
    amount: g.amount,
    costBasisMinor: g.costBasisMinor,
    rate: g.unit ?? MONEY_RATE,
    remainingUnits: g.unitsLeft,
    remainingFace: g.faceLeft,
    remainingCost: g.costLeft,
    exactWindow: isExactWindowGrant(g.source, g.sourceRef),
  };
}

/**
 * Simulated drawdown of unbilled usage through the invoice's planner (§3.4): the pre-tax phase,
 * then the post-tax phase on what is left plus its tax at `postTaxRateBps`. Money per grant.
 */
export function simulateDrawdown(
  grants: BalanceGrant[],
  lines: Array<Pick<UnbilledUsageLine, "pricePublicId" | "window" | "amountMinor" | "slices">>,
  postTaxRateBps = 0,
): Map<string, bigint> {
  const planned = grants.filter((g) => g.faceLeft > 0n).map(toPlanner);
  const usage: PlannerLine[] = lines.map((l, i) => ({
    key: String(i),
    kind: "usage",
    pricePublicId: l.pricePublicId,
    valueMinor: l.amountMinor > 0n ? l.amountMinor : 0n,
    window: l.window,
    ...(l.slices ? { slices: l.slices } : {}),
  }));
  const pre = planGrantApplication({ phase: "pre_tax", grants: planned, lines: usage });
  const post = planGrantApplication({
    phase: "post_tax",
    grants: pre.grants,
    lines: usage.map((l) => {
      const left = l.valueMinor - (pre.byLine.get(l.key) ?? 0n);
      return { ...l, valueMinor: left + (left * BigInt(postTaxRateBps)) / 10_000n };
    }),
  });
  const drawn = new Map<string, bigint>();
  for (const d of [...pre.draws, ...post.draws])
    drawn.set(d.grantId, (drawn.get(d.grantId) ?? 0n) + d.faceMinor);
  return drawn;
}

export interface LiveBalance {
  currency: string;
  grantsMinor: bigint;
  unbilledUsageMinor: bigint;
  openHoldsMinor: bigint;
  openHoldCount: number;
  balanceMinor: bigint;
  /** Unbilled usage no grant covers. Bills on the invoice; under `block` it uses the overdraft. */
  uncoveredUsageMinor: bigint;
  overdraftLimitMinor: bigint;
  /** balance − uncovered usage + overdraft limit: what a blocking check may still spend. */
  availableMinor: bigint;
  availableUnits: Array<{ unit: string; units: bigint }>;
  grants: BalanceGrant[];
  usage: UnbilledUsageLine[];
}

/** Overdraft limit for a currency: the customer's, else the business's, else 0 (C2). */
export function overdraftLimit(
  biz: BusinessCreditConfig | null | undefined,
  cust: CustomerCreditSettings | null | undefined,
  currency: string,
): bigint {
  const c = cust?.overdraft_limit_minor?.[currency];
  if (c != null) return BigInt(c);
  const b = biz?.overdraft_limit_minor?.[currency];
  return b != null ? BigInt(b) : 0n;
}

/** When a plan grant renews (its window end); null for other grants and rolled-over credit. */
export function grantRenewsAt(g: Pick<BalanceGrant, "source" | "sourceRef" | "expiresAt">) {
  if (g.source !== "plan_cycle" || !g.expiresAt || !g.sourceRef) return null;
  return /:(w|cycle):/.test(g.sourceRef) ? g.expiresAt.toISOString() : null;
}

/** Whether a grant is live at `now` (in its window). */
export const liveAt = (g: Pick<BalanceGrant, "effectiveAt" | "expiresAt">, now: Date) =>
  g.effectiveAt.getTime() <= now.getTime() &&
  (!g.expiresAt || g.expiresAt.getTime() > now.getTime());

/**
 * The §3.5 balance. `usage` may be passed in when the caller already rated it (the access check).
 */
export async function liveBalance(
  tx: Tx,
  input: {
    customerId: string;
    currency: string;
    now: Date;
    businessConfig: BusinessCreditConfig | null;
    customerSettings: CustomerCreditSettings | null;
    usage?: UnbilledUsageLine[];
    snapshot?: BalanceSnapshot;
    /** Rate usage even with no grant (a blocking check spends the overdraft on it). */
    rateUsage?: boolean;
    /** Rate usage up to here instead of `now` (events may carry a timestamp up to 5 min ahead). */
    usageAsOf?: Date;
  },
): Promise<LiveBalance> {
  const currency = input.currency.toUpperCase();
  // A caller that passes its snapshot granted the due windows before taking it.
  if (!input.snapshot) {
    const { ensureCreditWindows } = await import("./credit-clock");
    await ensureCreditWindows(tx, { customerId: input.customerId, now: input.now });
  }
  const snap =
    input.snapshot ??
    (await loadBalanceSnapshot(tx, { customerId: input.customerId, currency, now: input.now }));
  const rated =
    input.usage ??
    (snap.grants.length || input.rateUsage
      ? await ratedUnbilledUsage(tx, {
          customerId: input.customerId,
          currency,
          asOf: input.usageAsOf ?? input.now,
        })
      : []);
  // Split at reset-window grant edges, as the invoice does (G3b §3.4).
  const usage = await sliceUsageLines(tx, input.customerId, rated, snap.grants.map(toPlanner));
  const drawn = simulateDrawdown(snap.grants, usage);
  let grantsMinor = 0n;
  let covered = 0n;
  const perUnit = new Map<string, bigint>();
  for (const g of snap.grants) {
    if (!liveAt(g, input.now)) continue;
    grantsMinor += g.faceLeft;
    const d = drawn.get(g.id) ?? 0n;
    covered += d;
    const key = g.unitKey ?? currency;
    const unitsDrawn = d >= g.faceLeft ? g.unitsLeft : stepsForMinor(d, g.unit ?? MONEY_RATE);
    const unitsLeft = g.unitsLeft - (unitsDrawn > g.unitsLeft ? g.unitsLeft : unitsDrawn);
    perUnit.set(key, (perUnit.get(key) ?? 0n) + unitsLeft);
  }
  const balanceMinor = grantsMinor - covered - snap.openHoldsMinor;
  const od = overdraftLimit(input.businessConfig, input.customerSettings, currency);
  const usageMinor = usage.reduce((a, l) => a + (l.amountMinor > 0n ? l.amountMinor : 0n), 0n);
  const drawnAll = [...drawn.values()].reduce((a, d) => a + d, 0n);
  const uncovered = usageMinor > drawnAll ? usageMinor - drawnAll : 0n;
  return {
    currency,
    grantsMinor,
    unbilledUsageMinor: covered,
    openHoldsMinor: snap.openHoldsMinor,
    openHoldCount: snap.openHoldCount,
    balanceMinor,
    uncoveredUsageMinor: uncovered,
    overdraftLimitMinor: od,
    availableMinor: balanceMinor - uncovered + od,
    availableUnits: [...perUnit.entries()].map(([unit, units]) => ({ unit, units })),
    grants: snap.grants,
    usage,
  };
}
