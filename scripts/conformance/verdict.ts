/**
 * The suite's verdict, as pure functions: measured rows against `known-gaps.json`, the
 * coverage gate against the gateway catalog, and `live-proof-pending.json` against it too.
 */
import type { Exclusion, KnownGapEntry, PendingMethods } from "@/providers/conformance";

export interface MeasuredRow {
  gateway: string;
  id: string;
  outcome: "pass" | "fail" | "na";
  detail?: string;
}

export interface Verdict {
  /** Failing rows that are not known gaps. */
  unexpected: MeasuredRow[];
  /** Failing rows that are known gaps. */
  known: MeasuredRow[];
  /** Known gaps that no longer fail (passing, n/a, or no such row): remove them. */
  stale: Array<{ gateway: string; row: string; now: "pass" | "na" | "absent" }>;
}

export function compareWithKnownGaps(
  rows: MeasuredRow[],
  gaps: Record<string, Record<string, KnownGapEntry>>,
  gateways: string[],
): Verdict {
  const unexpected: MeasuredRow[] = [];
  const known: MeasuredRow[] = [];
  for (const r of rows) {
    if (r.outcome !== "fail") continue;
    (gaps[r.gateway]?.[r.id] ? known : unexpected).push(r);
  }
  const stale: Verdict["stale"] = [];
  for (const g of gateways)
    for (const row of Object.keys(gaps[g] ?? {})) {
      const m = rows.find((r) => r.gateway === g && r.id === row);
      if (!m) stale.push({ gateway: g, row, now: "absent" });
      else if (m.outcome !== "fail") stale.push({ gateway: g, row, now: m.outcome });
    }
  return { unexpected, known, stale };
}

/** Every catalog gateway has fixtures or a stated exclusion, and the files agree. */
export function coverageProblems(input: {
  catalog: string[];
  fixtures: string[];
  gapKeys: string[];
  exclusions: Record<string, Exclusion>;
}): string[] {
  const out: string[] = [];
  const has = (list: string[], k: string) => list.includes(k);
  for (const k of input.catalog) {
    const fx = has(input.fixtures, k);
    const ex = input.exclusions[k];
    if (fx && ex) out.push(`${k}: has a fixture module AND an exclusion — remove the exclusion`);
    if (!fx && !ex)
      out.push(`${k}: no conformance fixture module and no stated reason in exclusions.json`);
    if (ex && !ex.reason?.trim()) out.push(`${k}: the exclusion states no reason`);
    if (fx && !has(input.gapKeys, k))
      out.push(`${k}: add "${k}": {} to known-gaps.json (its fixture module exists)`);
  }
  for (const k of input.gapKeys)
    if (!has(input.fixtures, k))
      out.push(`${k}: listed in known-gaps.json but has no fixture module`);
  for (const k of Object.keys(input.exclusions))
    if (!has(input.catalog, k))
      out.push(`${k}: excluded but not in the gateway catalog — remove it`);
  return out;
}

/**
 * Every `live-proof-pending.json` entry names a catalog gateway and a method the flag can
 * withhold there. A typo would otherwise hide nothing and say nothing.
 */
export function pendingMethodProblems(
  pending: PendingMethods,
  withholdable: (gateway: string) => string[] | null,
): string[] {
  const out: string[] = [];
  for (const [gw, methods] of Object.entries(pending)) {
    const known = withholdable(gw);
    if (!known) {
      out.push(`live-proof-pending.json: "${gw}" is not a gateway in the catalog`);
      continue;
    }
    for (const [m, e] of Object.entries(methods)) {
      if (!known.includes(m))
        out.push(
          `live-proof-pending.json: ${gw} has no method "${m}" (it has: ${known.join(", ")})`,
        );
      if (!e?.reason?.trim() || !e?.planRef?.trim())
        out.push(`live-proof-pending.json: ${gw}.${m} needs a reason and a planRef`);
    }
  }
  return out;
}
