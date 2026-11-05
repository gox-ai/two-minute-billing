import { readMetricSeries, type MetricSeriesResult, type SeriesPeriod } from "./query";
import type { Grain } from "./measures";

/**
 * `mrr_fx_impact` — the part of a converted MRR change that exchange rates explain.
 *
 * Derived at READ time from the stored `mrr` stock and the six movement flows, never stored:
 * which currency to convert into, and at which rates, is decided per answer, and the figure
 * must be built from exactly the converted cells the MRR line and the flows are read with, or
 * the waterfall is out by the rounding of two different conversions.
 *
 * Per period P, per currency c, with C(·) the answer's own conversion (a stock at its day's
 * rate, a flow day by day):
 *
 *   fx_c(P) = C(close_c) − C(open_c) − Σ± C(flow_c) − C_close(R_c)
 *   R_c     = close_c − open_c − Σ± flow_c            (native: what no stored flow explains)
 *
 * so `opening + new + expansion + reactivation − contraction − churn − paused + fx = closing`
 * to the minor unit whenever the native ledger itself reconciles (R = 0). R is removed at the
 * closing rate so a movement no flow measures (a `resume`) is never labelled FX. A
 * per-currency answer has no FX by definition and reads 0.
 */
export const FX_IMPACT_MEASURE = "mrr_fx_impact";

/** Every stored flow, signed as it moves MRR. */
const FLOWS = [
  ["mrr_new", 1n],
  ["mrr_expansion", 1n],
  ["mrr_reactivation", 1n],
  ["mrr_contraction", -1n],
  ["mrr_churn", -1n],
  ["mrr_paused", -1n],
] as const;

type DayConvert = NonNullable<Parameters<typeof readMetricSeries>[0]["convert"]>;

const dayBefore = (d: string): string => {
  const x = new Date(`${d}T00:00:00.000Z`);
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
};

/** period end → currency → value */
type ByCurrency = Map<string, Map<string, bigint>>;

function index(
  cells: ReadonlyArray<{ t: string; currency: string; value: bigint | null }>,
): ByCurrency {
  const out: ByCurrency = new Map();
  for (const c of cells) {
    if (c.value == null) continue;
    const row = out.get(c.t) ?? new Map<string, bigint>();
    row.set(c.currency, (row.get(c.currency) ?? 0n) + c.value);
    out.set(c.t, row);
  }
  return out;
}

export interface FxImpactInput {
  organizationId: string;
  businessIds: readonly string[];
  grain: Grain;
  periods: readonly SeriesPeriod[];
  /** The answer's currency. */
  currency: string | null;
  /** The last day every business has reached — see `readMetricSeries`. */
  through?: string;
  /** Present only for a converted answer; `dayConvert` when each day converts at its own rate. */
  convert?: { base: string; rates: Record<string, number>; dayConvert?: DayConvert };
}

/** The MRR book's currencies over the window — the set the `mrr` answer chooses from. */
export async function fxBookCurrencies(
  input: Pick<FxImpactInput, "organizationId" | "businessIds" | "grain" | "periods" | "through">,
): Promise<string[]> {
  const r = await readMetricSeries({ ...input, measure: "mrr" });
  return [...new Set(r.cells.map((c) => c.currency))];
}

export async function readFxImpact(input: FxImpactInput): Promise<MetricSeriesResult> {
  const { periods, convert } = input;
  const first = periods[0]!;
  const opening: SeriesPeriod = {
    start: dayBefore(first.start),
    end: dayBefore(first.start),
    label: "",
  };
  const withOpening = [opening, ...periods];
  const read = (measure: string, ps: readonly SeriesPeriod[], conv?: DayConvert) =>
    readMetricSeries({
      organizationId: input.organizationId,
      businessIds: input.businessIds,
      measure,
      grain: input.grain,
      periods: ps,
      ...(input.through ? { through: input.through } : {}),
      // Split by currency so a converted read keeps each cell's own currency.
      ...(conv ? { split: "currency", convert: conv } : {}),
    });

  const mrrNative = await read("mrr", withOpening);
  const stockMissing = new Set(mrrNative.missing);
  // A period needs its closing AND its opening stock; either unknown makes FX unknown.
  const measured = (i: number) =>
    !stockMissing.has(periods[i]!.end) && !stockMissing.has(withOpening[i]!.end);
  const missing = periods.filter((_, i) => !measured(i)).map((p) => p.end);

  // No conversion, no FX: zero wherever the book was measured.
  if (!convert) {
    const cells = input.currency
      ? periods.flatMap((p, i) =>
          measured(i)
            ? [{ t: p.end, currency: input.currency!, value: 0n, denominator: null }]
            : [],
        )
      : [];
    return { ...mrrNative, cells, missing, computedAt: mrrNative.computedAt };
  }

  const { base, rates, dayConvert } = convert;
  const toBase = (minor: bigint, ccy: string, day: string): bigint | null => {
    if (ccy === base) return minor;
    if (dayConvert) return dayConvert.toBase(minor, ccy, day);
    const rate = rates[ccy];
    return rate != null && rate > 0 ? BigInt(Math.round(Number(minor) / rate)) : null;
  };

  const flowReads = await Promise.all(FLOWS.map(([id]) => read(id, periods)));
  const nativeClose = index(mrrNative.cells);
  const nativeFlows = flowReads.map((r) => index(r.cells));

  // Converted exactly as the answer converts: day by day through `readMetricSeries`, or
  // per period and currency with today's rates, as `collapse` does at organization scope.
  let convClose: ByCurrency;
  let convFlows: ByCurrency[];
  const reads: MetricSeriesResult[] = [mrrNative, ...flowReads];
  if (dayConvert) {
    const [mrrConv, ...flowConv] = await Promise.all([
      read("mrr", withOpening, dayConvert),
      ...FLOWS.map(([id]) => read(id, periods, dayConvert)),
    ]);
    reads.push(mrrConv!, ...flowConv);
    const bySlice = (r: MetricSeriesResult) =>
      index((r.slices ?? []).map((s) => ({ t: s.t, currency: s.dimValue, value: s.value })));
    convClose = bySlice(mrrConv!);
    convFlows = flowConv.map(bySlice);
  } else {
    const convertAll = (m: ByCurrency): ByCurrency => {
      const out: ByCurrency = new Map();
      for (const [t, row] of m) {
        const conv = new Map<string, bigint>();
        for (const [ccy, v] of row) {
          const c = toBase(v, ccy, t);
          if (c != null) conv.set(ccy, c);
        }
        out.set(t, conv);
      }
      return out;
    };
    convClose = convertAll(nativeClose);
    convFlows = nativeFlows.map(convertAll);
  }

  const cells = periods.flatMap((p, i) => {
    if (!measured(i)) return [];
    const openT = withOpening[i]!.end;
    const ccys = new Set<string>();
    for (const m of [
      nativeClose.get(p.end),
      nativeClose.get(openT),
      ...nativeFlows.map((f) => f.get(p.end)),
    ])
      for (const c of m?.keys() ?? []) ccys.add(c);
    let fx = 0n;
    for (const ccy of ccys) {
      const get = (m: ByCurrency, t: string) => m.get(t)?.get(ccy) ?? 0n;
      let native = get(nativeClose, p.end) - get(nativeClose, openT);
      let conv = get(convClose, p.end) - get(convClose, openT);
      FLOWS.forEach(([, sign], k) => {
        native -= sign * get(nativeFlows[k]!, p.end);
        conv -= sign * get(convFlows[k]!, p.end);
      });
      // A currency with no rate is outside every converted figure, so outside FX too.
      const residual = native === 0n ? 0n : toBase(native, ccy, p.end);
      fx += conv - (residual ?? conv);
    }
    return [{ t: p.end, currency: base, value: fx, denominator: null }];
  });

  const at = reads.map((r) => r.computedAt).filter((d): d is Date => d != null);
  return {
    ...mrrNative,
    cells,
    missing,
    computedAt: at.length ? new Date(Math.min(...at.map((d) => d.getTime()))) : null,
  };
}
