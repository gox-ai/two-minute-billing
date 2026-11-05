/**
 * Timezone conversion for date ENTRY — the input-side mirror of `fmtDate`/`fmtDateTime`
 * in `lib/format.ts`, which owns the display side.
 *
 * THE RULE: the user always types and reads a **business-timezone** wall clock; the wire
 * and the database always carry **UTC**. Conversion happens exactly once, at the form
 * boundary, through `components/form/datetime-field.tsx` — never ad hoc in a call site.
 *
 * WHY THIS EXISTS. An `<input type="datetime-local">` yields a zone-LESS string like
 * `2026-08-21T00:00`. Passing that to `new Date(...)` resolves it against whatever clock
 * the interpreter happens to sit in:
 *   - in a server action → the **Node process's** zone,
 *   - in the browser     → the **viewer's** zone,
 * and neither is the business's. For an Asia/Kolkata business every dated write was
 * landing 5h30m from where the user pointed, which on a day-anchored business (see
 * `src/modules/subscriptions/billing-mode.ts`) is a different billing day entirely — a
 * wrong term end, a wrong proration boundary, a wrong scheduled-change date. Nothing
 * throws; the number is just wrong.
 *
 * The same applies in reverse to PREFILLS: deriving a `datetime-local` value from
 * `d.getHours()` (browser-local) or `d.toISOString().slice(0,16)` (UTC) shows the user a
 * different clock than the one their input posts back in.
 *
 * The offset math is the two-pass form proven in `src/platform/clock.ts`
 * (`startOfDayInTz`) and is duplicated rather than imported: that module pulls in
 * `AsyncLocalStorage` and drizzle, so it can never reach a client bundle. Keep the two in
 * step — `scripts/verify-dashboard-tz.ts` asserts they agree on the same instants.
 */

/** The zone to use when a surface genuinely has no single business (see lib/format.ts). */
export const DEFAULT_TZ = 'UTC'

/**
 * Legacy IANA name → modern name. **Must stay identical to `LEGACY_TO_MODERN` in
 * `src/platform/timezones.ts`** — the two packages cannot import each other, and
 * `pnpm verify:dashboard-tz` fails if the copies drift.
 *
 * `Intl.supportedValuesOf('timeZone')` reports the runtime's CANONICAL ids, and ICU still
 * canonicalizes ten zones to their pre-rename spelling (Node 22 / Chrome 148 both list
 * `Asia/Calcutta`, never `Asia/Kolkata`). We store and display the MODERN name only, so a
 * picker built from that list has to map through here first — otherwise the stored
 * `Asia/Kolkata` matched no row and the field read "not a known time zone".
 */
export const LEGACY_TO_MODERN: Readonly<Record<string, string>> = {
  // --- listed as canonical by ICU ---
  'Africa/Asmera': 'Africa/Asmara',
  'America/Godthab': 'America/Nuuk',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
  // --- accepted aliases, not listed ---
  'Asia/Ashkhabad': 'Asia/Ashgabat',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Macao': 'Asia/Macau',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Africa/Timbuktu': 'Africa/Bamako',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Rosario': 'America/Argentina/Cordoba',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Fort_Wayne': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Atka': 'America/Adak',
  'America/Porto_Acre': 'America/Rio_Branco',
  'Europe/Uzhgorod': 'Europe/Kyiv',
  'Europe/Zaporozhye': 'Europe/Kyiv',
  'Pacific/Yap': 'Pacific/Chuuk',
  'Pacific/Samoa': 'Pacific/Pago_Pago',
  'Pacific/Johnston': 'Pacific/Honolulu',
  'Pacific/Enderbury': 'Pacific/Kanton',
}

/** The modern spelling of `tz`, or `tz` unchanged when it already is one. */
export function toModernZone(tz: string): string {
  return LEGACY_TO_MODERN[tz] ?? tz
}

/** True when `Intl` accepts this zone id. */
export function isKnownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date())
    return true
  } catch {
    return false
  }
}

/**
 * Milliseconds `timeZone` is ahead of UTC at `date`. Reads the wall-clock fields in the
 * zone, treats them as if they were UTC, and subtracts the true instant.
 */
function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date)
  const m: Record<string, number> = {}
  for (const p of parts) if (p.type !== 'literal') m[p.type] = Number(p.value)
  // Intl can emit hour "24" at midnight; normalize to 0 (same as platform/clock.ts).
  const hour = m.hour === 24 ? 0 : m.hour!
  const asUTC = Date.UTC(m.year!, m.month! - 1, m.day!, hour, m.minute!, m.second!)
  // Compare against whole seconds — zone offsets are whole minutes, so the input's
  // milliseconds must not leak into the offset.
  return asUTC - (date.getTime() - date.getMilliseconds())
}

/** Split `2026-08-21T00:00[:ss]` or `2026-08-21` into calendar fields. Null if unparseable. */
function parseWallClock(local: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(local.trim())
  if (!m) return null
  return {
    y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
    h: Number(m[4] ?? 0), mi: Number(m[5] ?? 0), s: Number(m[6] ?? 0),
  }
}

/**
 * A business-timezone wall clock → the UTC instant it names.
 * `('2026-08-21T00:00', 'Asia/Kolkata')` → `2026-08-20T18:30:00.000Z`.
 *
 * DST-safe via two passes: the offset at the naive guess can differ from the offset at
 * the resulting instant (a spring-forward day), so the second pass corrects it. Returns
 * null on an unparseable value so callers can reject rather than silently coerce.
 */
export function wallClockToUtc(local: string, tz?: string | null): Date | null {
  const f = parseWallClock(local)
  if (!f) return null
  const zone = tz || DEFAULT_TZ
  const asUTC = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s)
  try {
    let out = new Date(asUTC - tzOffsetMs(new Date(asUTC), zone))
    out = new Date(asUTC - tzOffsetMs(out, zone))
    return Number.isNaN(out.getTime()) ? null : out
  } catch {
    // An unknown/malformed IANA zone throws rather than falling back.
    return new Date(asUTC)
  }
}

/** `wallClockToUtc` as the ISO string the API expects, or null. */
export function wallClockToUtcISO(local: string, tz?: string | null): string | null {
  return wallClockToUtc(local, tz)?.toISOString() ?? null
}

/**
 * A start-of-DAY wall clock → UTC. For `<input type="date">`, where the user picked a
 * calendar day and means that whole day in their business's zone.
 */
export function dateOnlyToUtcISO(yyyyMmDd: string, tz?: string | null): string | null {
  return wallClockToUtcISO(`${yyyyMmDd.trim().slice(0, 10)}T00:00:00`, tz)
}

/** The business-tz calendar/clock fields of a UTC instant, as strings. */
function fieldsIn(d: Date, zone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const m: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value
  if (m.hour === '24') m.hour = '00'
  return m
}

/**
 * A UTC instant → the `datetime-local` input value showing it in the business's zone.
 * `('2026-08-20T18:30:00Z', 'Asia/Kolkata')` → `2026-08-21T00:00`.
 * Empty string when absent/invalid, which is what an empty input wants.
 */
export function utcToWallClockValue(iso?: string | Date | null, tz?: string | null): string {
  if (!iso) return ''
  const d = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    const f = fieldsIn(d, tz || DEFAULT_TZ)
    return `${f.year}-${f.month}-${f.day}T${f.hour}:${f.minute}`
  } catch {
    return d.toISOString().slice(0, 16)
  }
}

/** A UTC instant → the `type="date"` input value for that day in the business's zone. */
export function utcToDateValue(iso?: string | Date | null, tz?: string | null): string {
  return utcToWallClockValue(iso, tz).slice(0, 10)
}

/** Today's date in the business's zone, as a `type="date"` value (for min/max bounds). */
export function todayInTz(tz?: string | null): string {
  return utcToDateValue(new Date(), tz)
}

/**
 * A short zone label for a form hint — `IST`, `GMT+5:30`, `UTC`. Shown next to a date
 * field so the user knows which clock they are typing in; without it a business-tz field
 * is indistinguishable from a browser-tz one, and the whole point is that they differ.
 */
export function tzLabel(tz?: string | null): string {
  const zone = tz || DEFAULT_TZ
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date())
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? zone
  } catch {
    return zone
  }
}

/**
 * Guard for server actions: a dated field must arrive ZONE-QUALIFIED (…Z or ±hh:mm),
 * because the client converts business-tz entry to UTC before posting. A bare
 * `2026-08-21T00:00` means some form skipped `DateTimeField` and `new Date()` would
 * resolve it in the server's zone — so reject it loudly instead of writing a silently
 * shifted instant. Returns the parsed Date, or null to fail the action.
 */
export function parseUtcFromForm(value: string | null | undefined): Date | null {
  if (!value) return null
  if (!isZoneQualified(value)) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Does this timestamp string name an absolute instant (…Z or ±hh:mm)? */
export function isZoneQualified(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim())
}

/**
 * The message a server action shows when a dated field arrives without a zone. Points at
 * the cause — a form that bypassed `DateTimeField` — because the value itself looks fine.
 */
export const NOT_UTC_MESSAGE =
  'Expected a UTC timestamp. This field must be submitted through DateTimeField, which converts business-timezone entry to UTC.'
