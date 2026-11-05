/**
 * Line slices (design G3b §3.4): a usage line's amount split at the edges of the customer's
 * reset-window grants, so each grant pays only its own window's usage. Only lines that a
 * reset-window grant edge falls inside are split; the invoice line itself is unchanged.
 * Weights are the usage quantity per piece (the line's own rate); Σ slices = the line amount.
 */
import type { Tx } from "@/platform/db";
import { readMeterUsage } from "@/modules/metering/read";
import type { LineSlice, PlannerGrant } from "./planner";
import { splitByWeights } from "./reset-windows";

type Edges = Pick<PlannerGrant, "effectiveAt" | "expiresAt" | "exactWindow">;

/** Reset-window grant edges strictly inside `w`, ascending. */
export function edgesInside(grants: readonly Edges[], w: { start: Date; end: Date }): Date[] {
  const s = w.start.getTime();
  const e = w.end.getTime();
  const out = new Set<number>();
  for (const g of grants) {
    if (!g.exactWindow) continue;
    for (const d of [g.effectiveAt, g.expiresAt])
      if (d && d.getTime() > s && d.getTime() < e) out.add(d.getTime());
  }
  return [...out].sort((a, b) => a - b).map((t) => new Date(t));
}

/**
 * Slices of one meter line: usage read once, split at `splitAt`. Weights fall back to each
 * piece's length when the meter has no usage to weigh by (or is a level meter).
 */
export async function meterLineSlices(
  tx: Tx,
  input: {
    customerId: string;
    meterId: string;
    group?: readonly string[] | null;
    window: { start: Date; end: Date };
    amountMinor: bigint;
    splitAt: Date[];
  },
): Promise<LineSlice[] | undefined> {
  if (!input.splitAt.length) return undefined;
  const points = [input.window.start, ...input.splitAt, input.window.end];
  const pieces = points.slice(0, -1).map((p, i) => ({ start: p, end: points[i + 1]! }));
  let weights: bigint[] | null = null;
  try {
    const u = await readMeterUsage(tx, {
      customerId: input.customerId,
      meterId: input.meterId,
      window: input.window,
      splitAt: input.splitAt,
    });
    const same = (g: string[]) =>
      !input.group || (g.length === input.group.length && g.every((v, i) => v === input.group![i]));
    weights = u.segments.map((seg) =>
      seg.rows.filter((r) => same(r.groupValues)).reduce((a, r) => a + r.quantity, 0n),
    );
    if (weights.length !== pieces.length || weights.every((w) => w <= 0n)) weights = null;
  } catch (e) {
    if ((e as Error).name !== "LevelMeterReadError") throw e;
  }
  weights ??= pieces.map((p) => BigInt(p.end.getTime() - p.start.getTime()));
  const values = splitByWeights(input.amountMinor > 0n ? input.amountMinor : 0n, weights);
  return pieces.map((p, i) => ({ window: p, valueMinor: values[i]! }));
}

/** The meter and group of an invoice line's rating, when it bills from a meter. */
function meterOf(rating: unknown): { meterId: string; group: string[] } | null {
  const r = rating as { meter?: unknown; group?: unknown } | null;
  if (!r || typeof r.meter !== "string") return null;
  return { meterId: r.meter, group: Array.isArray(r.group) ? (r.group as string[]) : [] };
}

/**
 * Invoice lines with `grantSlices` set on every meter usage line a reset-window grant edge
 * falls inside. Lines are returned in the same order; others are unchanged.
 */
export async function withGrantSlices<
  L extends {
    kind: string;
    adjustment?: string | null;
    amountMinor: bigint;
    periodStart: Date;
    periodEnd: Date;
    rating?: unknown;
    grantSlices?: LineSlice[];
  },
>(tx: Tx, customerId: string, lines: readonly L[], grants: readonly Edges[]): Promise<L[]> {
  if (!grants.some((g) => g.exactWindow)) return [...lines];
  const out: L[] = [];
  for (const l of lines) {
    const m = l.kind === "usage" && !l.adjustment ? meterOf(l.rating) : null;
    const window = { start: l.periodStart, end: l.periodEnd };
    const splitAt = m ? edgesInside(grants, window) : [];
    const slices =
      m && splitAt.length
        ? await meterLineSlices(tx, {
            customerId,
            meterId: m.meterId,
            group: m.group,
            window,
            amountMinor: l.amountMinor,
            splitAt,
          })
        : undefined;
    out.push(slices ? { ...l, grantSlices: slices } : l);
  }
  return out;
}

/** Unbilled usage lines (the live balance) with `slices` where a grant edge falls inside. */
export async function sliceUsageLines<
  U extends {
    meterId: string | null;
    window: { start: Date; end: Date };
    amountMinor: bigint;
    slices?: LineSlice[];
  },
>(tx: Tx, customerId: string, usage: readonly U[], grants: readonly Edges[]): Promise<U[]> {
  if (!grants.some((g) => g.exactWindow)) return [...usage];
  const out: U[] = [];
  for (const l of usage) {
    const splitAt = l.meterId ? edgesInside(grants, l.window) : [];
    const slices = splitAt.length
      ? await meterLineSlices(tx, {
          customerId,
          meterId: l.meterId!,
          window: l.window,
          amountMinor: l.amountMinor,
          splitAt,
        })
      : undefined;
    out.push(slices ? { ...l, slices } : l);
  }
  return out;
}
