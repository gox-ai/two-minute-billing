// The one display format for dates: "10 Nov 2026", "10 Nov 2026, 02:01",
// "12 Oct – 10 Nov 2026", axis ticks "12 Oct". Always in the business time zone
// (`tz`); UTC when absent. Months come from a fixed table: en-GB's short month is "Sept".
// Wrap a rendered date in `whitespace-nowrap` where it can wrap.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DateInput = string | number | Date | null | undefined;

type Parts = { y: number; m: number; d: number; time: string };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      // h23, not hour12:false — the latter renders midnight as `24:00` on some engines.
      hourCycle: "h23",
      timeZone: tz,
    });
    formatters.set(tz, f);
  }
  return f;
}

function parts(input: DateInput, tz?: string | null): Parts | null {
  if (input == null || input === "") return null;
  // A calendar date has no zone: "2026-10-12" is 12 Oct everywhere.
  const day = typeof input === "string" ? DATE_ONLY.exec(input) : null;
  if (day) return { y: Number(day[1]), m: Number(day[2]), d: Number(day[3]), time: "00:00" };
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  let raw: Intl.DateTimeFormatPart[];
  try {
    raw = formatter(tz || "UTC").formatToParts(date);
  } catch {
    // An unknown IANA zone throws instead of falling back.
    raw = formatter("UTC").formatToParts(date);
  }
  const p: Record<string, string> = {};
  for (const { type, value } of raw) p[type] = value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), time: `${p.hour}:${p.minute}` };
}

const dayMonth = (p: Parts) => `${p.d} ${MONTHS[p.m - 1]}`;

/** "10 Nov 2026"; "—" when absent. */
export function fmtDate(iso: DateInput, tz?: string | null): string {
  const p = parts(iso, tz);
  return p ? `${dayMonth(p)} ${p.y}` : "—";
}

/** "10 Nov 2026, 02:01"; "—" when absent. */
export function fmtDateTime(iso: DateInput, tz?: string | null): string {
  const p = parts(iso, tz);
  return p ? `${dayMonth(p)} ${p.y}, ${p.time}` : "—";
}

/** "12 Oct – 10 Nov 2026", or "12 Oct 2025 – 10 Nov 2026" across years. One end alone prints as a date. */
export function fmtRange(from: DateInput, to: DateInput, tz?: string | null): string {
  const a = parts(from, tz);
  const b = parts(to, tz);
  if (!a || !b) return a ? fmtDate(from, tz) : fmtDate(to, tz);
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `${dayMonth(b)} ${b.y}`;
  return a.y === b.y
    ? `${dayMonth(a)} – ${dayMonth(b)} ${b.y}`
    : `${dayMonth(a)} ${a.y} – ${dayMonth(b)} ${b.y}`;
}

/** Chart axis tick: "12 Oct". */
export function fmtAxisDate(iso: DateInput, tz?: string | null): string {
  const p = parts(iso, tz);
  return p ? dayMonth(p) : "—";
}
