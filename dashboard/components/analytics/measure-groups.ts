import type { AnalyticsMeasure } from "@/lib/analytics-api";

/**
 * A scannable grouping for the measure rail, derived from what a measure actually
 * IS — `kind` × `unit`, both real fields off `listMeasures()` — rather than a
 * hand-maintained taxonomy that drifts from the catalogue as measures are added.
 */
export function measureGroup(m: AnalyticsMeasure): string {
  if (m.kind === "flow" && m.unit === "money") return "What moved it";
  if (m.kind === "stock" && m.unit === "money") return "Recurring revenue";
  if (m.unit === "count") return "Accounts";
  return "Other";
}

const GROUP_ORDER = ["Recurring revenue", "What moved it", "Accounts", "Other"];

export function groupMeasures(
  measures: AnalyticsMeasure[],
): Array<{ group: string; measures: AnalyticsMeasure[] }> {
  const by = new Map<string, AnalyticsMeasure[]>();
  for (const m of measures) {
    const g = measureGroup(m);
    if (!by.has(g)) by.set(g, []);
    by.get(g)!.push(m);
  }
  return GROUP_ORDER.filter((g) => by.has(g)).map((g) => ({ group: g, measures: by.get(g)! }));
}
