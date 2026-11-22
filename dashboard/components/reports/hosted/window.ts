/**
 * The window a checkout or portal report is quoted over: business-zone civil days, inclusive.
 * Plain data, not a "use client" module: the page resolves it on the server and the picker
 * only writes `?range=`.
 */
import { todayInBusinessZone } from "@/components/reports/cancellations/window";
import { fmtRange } from "@/lib/format-date";

export const HOSTED_RANGES = [
  { id: "7d", label: "Last 7 days" },
  { id: "28d", label: "Last 28 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
] as const;

export const DEFAULT_HOSTED_RANGE = "28d";

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) =>
  iso(new Date(new Date(`${day}T00:00:00.000Z`).getTime() + n * DAY_MS));

export interface HostedWindow {
  rangeId: string;
  start: string;
  end: string;
}

export function resolveHostedWindow(
  rangeId: string,
  timezone: string | null | undefined,
  now = new Date(),
): HostedWindow {
  const today = todayInBusinessZone(timezone, now);
  const id = HOSTED_RANGES.some((r) => r.id === rangeId) ? rangeId : DEFAULT_HOSTED_RANGE;
  const monthStart = `${today.slice(0, 7)}-01`;
  if (id === "this_month") return { rangeId: id, start: monthStart, end: today };
  if (id === "last_month") {
    const end = addDays(monthStart, -1);
    return { rangeId: id, start: `${end.slice(0, 7)}-01`, end };
  }
  const n = id === "7d" ? 7 : id === "90d" ? 90 : 28;
  return { rangeId: id, start: addDays(today, -(n - 1)), end: today };
}

export const spanLabel = (start: string, end: string, tz: string | null) =>
  fmtRange(start, end, tz);
