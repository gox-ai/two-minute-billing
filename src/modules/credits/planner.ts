/**
 * Credit grant drawdown (design G3 §3.3–3.4). Pure: shared by invoice finalisation, the
 * renewal estimate and the live balance, so a preview cannot differ from the booking.
 *
 * Two phases around the tax step:
 *  - `pre_tax`: promotional and `taxed_at_purchase` grants. They lower the tax base.
 *  - `post_tax`: `taxed_at_use` money grants. They pay the line and the tax charged on it,
 *    as money. No gross-up.
 * Order inside a phase: restore grants → priority asc → soonest expiry (none last) →
 * promotional before paid → oldest effective_at → id.
 *
 * Exact windows (G3b §3.4): a line may carry `slices` of its window. A reset-window grant
 * (`exactWindow`) draws only from slices inside its own window; other grants draw from any.
 */
import type { CreditApplicability, CreditTaxTreatment } from "@db/schema";
import { divHalfUp, stepsForMinor, type CreditUnitRate } from "./units";

export type GrantPhase = "pre_tax" | "post_tax";

export interface PlannerGrant {
  id: string;
  category: "paid" | "promotional";
  source: string;
  priority: number;
  effectiveAt: Date;
  expiresAt: Date | null;
  taxTreatment: CreditTaxTreatment | null;
  unitId: string | null;
  applicability: CreditApplicability;
  /** Units at grant, in the unit's smallest step. */
  amount: bigint;
  costBasisMinor: bigint;
  rate: CreditUnitRate;
  /** Σ movements. */
  remainingUnits: bigint;
  remainingFace: bigint;
  remainingCost: bigint;
  /** A reset-window plan grant: pays only usage inside [effectiveAt, expiresAt). */
  exactWindow?: boolean;
}

export interface LineSlice {
  window: { start: Date; end: Date };
  /** The slice's share of the line, before coupons. Σ = the line amount. */
  valueMinor: bigint;
}

export interface PlannerLine {
  key: string;
  kind: string;
  pricePublicId: string | null;
  adjustment?: string | null;
  /** What a grant may pay on this line in this phase. */
  valueMinor: bigint;
  /** The usage window the line bills; a grant must be live in it (§3.3). */
  window?: { start: Date; end: Date };
  /** The line's usage split at reset-window grant edges (G3b). */
  slices?: LineSlice[];
}

export interface GrantDraw {
  grantId: string;
  category: "paid" | "promotional";
  phase: GrantPhase;
  faceMinor: bigint;
  units: bigint;
  costMinor: bigint;
  byLine: Array<{ key: string; minor: bigint }>;
}

export interface GrantPhasePlan {
  draws: GrantDraw[];
  /** Line key → money the phase drew on it. */
  byLine: Map<string, bigint>;
  totalMinor: bigint;
  /** The input grants with this phase's draws taken off. */
  grants: PlannerGrant[];
}

/** Which phase a grant draws in. A custom-unit grant is never taxed at use (CHECK). */
export function grantPhase(g: Pick<PlannerGrant, "category" | "taxTreatment">): GrantPhase {
  return g.category === "paid" && g.taxTreatment === "taxed_at_use" ? "post_tax" : "pre_tax";
}

const time = (d: Date | null): number => (d ? d.getTime() : Number.POSITIVE_INFINITY);

export function compareGrants(a: PlannerGrant, b: PlannerGrant): number {
  const ra = a.source === "restore" ? 0 : 1;
  const rb = b.source === "restore" ? 0 : 1;
  if (ra !== rb) return ra - rb;
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ea = time(a.expiresAt);
  const eb = time(b.expiresAt);
  if (ea !== eb) return ea < eb ? -1 : 1;
  const ca = a.category === "promotional" ? 0 : 1;
  const cb = b.category === "promotional" ? 0 : 1;
  if (ca !== cb) return ca - cb;
  const fa = a.effectiveAt.getTime();
  const fb = b.effectiveAt.getTime();
  if (fa !== fb) return fa - fb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Live for usage in `window`: effective before it ends, not expired before it starts. */
export function grantEligible(
  g: Pick<PlannerGrant, "effectiveAt" | "expiresAt">,
  window: { start: Date; end: Date },
): boolean {
  return (
    g.effectiveAt.getTime() < window.end.getTime() &&
    (g.expiresAt === null || g.expiresAt.getTime() > window.start.getTime())
  );
}

/** A slice lies inside the grant's window. */
export function sliceInside(
  g: Pick<PlannerGrant, "effectiveAt" | "expiresAt">,
  w: { start: Date; end: Date },
): boolean {
  return (
    g.effectiveAt.getTime() <= w.start.getTime() &&
    (g.expiresAt === null || g.expiresAt.getTime() >= w.end.getTime())
  );
}

/** The slices scaled to `valueMinor` (the phase's value), the last taking the remainder. */
export function scaleSlices(slices: readonly LineSlice[], valueMinor: bigint): bigint[] {
  const total = slices.reduce((a, s) => a + (s.valueMinor > 0n ? s.valueMinor : 0n), 0n);
  const v = valueMinor > 0n ? valueMinor : 0n;
  const out = slices.map(() => 0n);
  if (!slices.length) return out;
  if (total === 0n) {
    out[out.length - 1] = v;
    return out;
  }
  let given = 0n;
  for (let i = 0; i < slices.length - 1; i++) {
    const w = slices[i]!.valueMinor > 0n ? slices[i]!.valueMinor : 0n;
    out[i] = (v * w) / total;
    given += out[i]!;
  }
  out[out.length - 1] = v - given;
  return out;
}

/** Usage lines only; never a true-up, never a pack line. */
export function grantCoversLine(
  g: Pick<PlannerGrant, "applicability">,
  line: Pick<PlannerLine, "kind" | "pricePublicId" | "adjustment">,
): boolean {
  if (line.kind !== "usage" || line.adjustment) return false;
  const a = g.applicability;
  if (!a || a.kind === "metered") return true;
  return (
    a.kind === "prices" && line.pricePublicId !== null && a.prices.includes(line.pricePublicId)
  );
}

/**
 * Units and cost for a draw of `faceMinor` money from `g`. The draw that takes the last of the
 * face takes the exact remaining units and cost, so a grant closes to 0/0/0. A partial draw
 * always leaves at least one unit, so no grant keeps money with no units. Cost is cumulative:
 * cost drawn so far = round_half_up(cost_basis × units drawn so far ÷ amount).
 */
export function drawFromGrant(
  g: PlannerGrant,
  faceMinor: bigint,
): { faceMinor: bigint; units: bigint; costMinor: bigint } {
  const face = faceMinor < g.remainingFace ? faceMinor : g.remainingFace;
  if (face <= 0n) return { faceMinor: 0n, units: 0n, costMinor: 0n };
  if (face === g.remainingFace)
    return { faceMinor: face, units: g.remainingUnits, costMinor: g.remainingCost };
  let units = stepsForMinor(face, g.rate);
  if (units >= g.remainingUnits) units = g.remainingUnits > 0n ? g.remainingUnits - 1n : 0n;
  let costMinor = 0n;
  if (g.costBasisMinor > 0n && g.amount > 0n) {
    const drawnBefore = g.costBasisMinor - g.remainingCost;
    const unitsAfter = g.amount - (g.remainingUnits - units);
    const cumulative = divHalfUp(g.costBasisMinor * (unitsAfter > 0n ? unitsAfter : 0n), g.amount);
    costMinor = cumulative - drawnBefore;
    if (costMinor < 0n) costMinor = 0n;
    if (costMinor > g.remainingCost) costMinor = g.remainingCost;
  }
  return { faceMinor: face, units, costMinor };
}

/**
 * Walk one phase's grants, in order, against the lines they cover. Each grant pays
 * min(its remaining face, the covered lines' remaining value), bounded by `capMinor` overall.
 * One draw per grant.
 */
export function planGrantApplication(input: {
  phase: GrantPhase;
  grants: readonly PlannerGrant[];
  lines: readonly PlannerLine[];
  capMinor?: bigint;
  window?: { start: Date; end: Date };
}): GrantPhasePlan {
  const left = new Map(input.lines.map((l) => [l.key, l.valueMinor > 0n ? l.valueMinor : 0n]));
  // Per-slice room, for lines that carry slices.
  const sliceLeft = new Map<string, bigint[]>();
  for (const l of input.lines)
    if (l.slices?.length) sliceLeft.set(l.key, scaleSlices(l.slices, l.valueMinor));
  let cap = input.capMinor ?? null;
  if (cap !== null && cap < 0n) cap = 0n;
  const byLine = new Map<string, bigint>();
  const draws: GrantDraw[] = [];
  const after = new Map<string, PlannerGrant>();
  const order = [...input.grants]
    .filter(
      (g) =>
        grantPhase(g) === input.phase &&
        g.remainingFace > 0n &&
        (!input.window || grantEligible(g, input.window)),
    )
    .sort(compareGrants);
  for (const g of order) {
    let room = g.remainingFace;
    const used: Array<{ key: string; minor: bigint }> = [];
    for (const line of input.lines) {
      if (room <= 0n || (cap !== null && cap <= 0n)) break;
      if (!grantCoversLine(g, line)) continue;
      if (line.window && !grantEligible(g, line.window)) continue;
      const lineLeft = left.get(line.key) ?? 0n;
      if (lineLeft <= 0n) continue;
      const pieces = sliceLeft.get(line.key);
      let take = 0n;
      if (pieces) {
        // Slice by slice: an exact-window grant only inside its window.
        for (const [i, s] of line.slices!.entries()) {
          let want = room - take;
          if (cap !== null && want > cap - take) want = cap - take;
          if (want <= 0n) break;
          if (pieces[i]! <= 0n || (g.exactWindow && !sliceInside(g, s.window))) continue;
          const t = pieces[i]! < want ? pieces[i]! : want;
          pieces[i] = pieces[i]! - t;
          take += t;
        }
      } else {
        take = lineLeft < room ? lineLeft : room;
        if (cap !== null && take > cap) take = cap;
      }
      if (take <= 0n) continue;
      left.set(line.key, lineLeft - take);
      room -= take;
      if (cap !== null) cap -= take;
      used.push({ key: line.key, minor: take });
    }
    const face = used.reduce((s, u) => s + u.minor, 0n);
    if (face <= 0n) continue;
    const d = drawFromGrant(g, face);
    for (const u of used) byLine.set(u.key, (byLine.get(u.key) ?? 0n) + u.minor);
    draws.push({ grantId: g.id, category: g.category, phase: input.phase, ...d, byLine: used });
    after.set(g.id, {
      ...g,
      remainingFace: g.remainingFace - d.faceMinor,
      remainingUnits: g.remainingUnits - d.units,
      remainingCost: g.remainingCost - d.costMinor,
    });
  }
  return {
    draws,
    byLine,
    totalMinor: draws.reduce((s, d) => s + d.faceMinor, 0n),
    grants: input.grants.map((g) => after.get(g.id) ?? g),
  };
}
