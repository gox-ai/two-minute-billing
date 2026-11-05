// Client-safe helpers for deriving time-series + breakdowns from list data.
// (No server-only imports, so chart components can share the types.)

export interface SeriesPoint {
  label: string
  value: number
}

// `dailySeries`/`dayKey`/`labelFor` lived here and bucketed chart days by the **UTC** day,
// with UTC axis labels. Nothing imported them — `SeriesPoint` was the only live export —
// so they were removed rather than corrected, in 2026-07-31's business-timezone sweep.
//
// If a daily series is needed again, bucket by the BUSINESS day: an Asia/Kolkata business
// has day boundaries at 18:30Z, so a UTC bucket puts everything between 00:00 and 05:30
// IST in the previous day's column — a chart that disagrees with the dates in the table
// beside it. Take the day with `utcToDateValue(iso, tz)` from `lib/tz.ts` and label it with
// `fmtDate(iso, tz)` from `lib/format.ts`; both take the zone from `useBusinessTz()`.
