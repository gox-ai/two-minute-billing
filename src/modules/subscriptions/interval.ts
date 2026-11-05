export type Interval = "day" | "week" | "month" | "year";

/** Add a billing interval to a date (UTC). */
export function addInterval(date: Date, unit: Interval, count: number): Date {
  const d = new Date(date);
  switch (unit) {
    case "day":
      d.setUTCDate(d.getUTCDate() + count);
      break;
    case "week":
      d.setUTCDate(d.getUTCDate() + 7 * count);
      break;
    case "month": {
      // Clamp to avoid JS month rollover (Jan 31 + 1mo would become Mar 3):
      // advance off day-1, then set the day to min(origDay, lastDayOfTargetMonth).
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + count);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      break;
    }
    case "year": {
      // Same clamp (Feb 29 + 1yr → Feb 28 in a non-leap year).
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCFullYear(d.getUTCFullYear() + count);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      break;
    }
  }
  return d;
}

/** Month-family term of 2+ months: the only cadence monthly usage billing is allowed on. */
export function supportsMonthlyUsage(
  unit: string | null | undefined,
  count: number | null,
): boolean {
  const n = count ?? 1;
  return (unit === "month" && n >= 2) || (unit === "year" && n >= 1);
}
