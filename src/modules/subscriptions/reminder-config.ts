/**
 * Per-business reminder lead times (0376), stored in `businesses.reminder_config`:
 *
 *   { trial_ending?: number[], renewal?: number[], renewal_yearly?: number[],
 *     cancellation?: number[], payment_due?: number[], pause?: number[], resume?: number[],
 *     card_expiring?: "expiry_month" | number[], changed_at?: { <kind>: ISO } }
 *
 * Each list is days before the target date, 1–90, at most 5 (3 for the optional kinds and
 * card expiry). An absent or malformed list resolves to the default, which is what the engine
 * did before the key existed, so an untouched business is unchanged. The optional kinds
 * (`payment_due`, `pause`, `resume`) take `[]` for Off, their default. `changed_at` is written by the server, never the API:
 * it is when that kind's list last changed, so a lead day that had already passed when the
 * list changed is not sent late (see `dueLeadDay`).
 *
 * Mandate pre-debit notices are not here: their lead time is set by the mandate rules.
 */

export const REMINDER_KINDS = [
  "trial_ending",
  "renewal",
  "renewal_yearly",
  "cancellation",
] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** Kinds that can be Off (`[]`): payment due before the due date, scheduled pause and resume. */
export const OPTIONAL_REMINDER_KINDS = ["payment_due", "pause", "resume"] as const;
export type OptionalReminderKind = (typeof OPTIONAL_REMINDER_KINDS)[number];

/** Card expiry notice: the status change in the expiry month (today), or lead days before. */
export const CARD_EXPIRY_MONTH = "expiry_month";
export type CardExpiringTiming = typeof CARD_EXPIRY_MONTH | number[];

/** Every kind that has a `changed_at` stamp. */
export type AnyReminderKind = ReminderKind | OptionalReminderKind | "card_expiring";
const ALL_KINDS: readonly AnyReminderKind[] = [
  ...REMINDER_KINDS,
  ...OPTIONAL_REMINDER_KINDS,
  "card_expiring",
];

export const MAX_OPTIONAL_LEAD_DAYS = 3;

export const MIN_LEAD_DAYS = 1;
export const MAX_LEAD_DAYS = 90;
export const MAX_LEAD_DAYS_PER_KIND = 5;

/**
 * The defaults. A year's charge needs weeks of notice (budget approval, a new PO, time to
 * cancel), and some consumer auto-renewal laws ask for it, so yearly renewals get 30.
 */
export const DEFAULT_REMINDER_LEAD_DAYS: Readonly<Record<ReminderKind, readonly number[]>> = {
  trial_ending: [3],
  renewal: [5],
  renewal_yearly: [30],
  cancellation: [5],
};

export type ReminderLeadDays = Record<ReminderKind, number[]>;

/**
 * What a business that a PERSON creates starts with. Engine defaults (above) stay as they
 * were, so existing businesses and API-created ones keep today's behaviour.
 */
export const NEW_BUSINESS_REMINDER_CONFIG = {
  card_expiring: [30, 7],
  payment_due: [3],
  pause: [7],
  resume: [7],
} as const;

/** The stored config for a new business: the recommended one when a person creates it. */
export function initialReminderConfig(creator: {
  hasOperator?: boolean;
}): Record<string, unknown> | undefined {
  if (creator.hasOperator !== true) return undefined;
  return Object.fromEntries(
    Object.entries(NEW_BUSINESS_REMINDER_CONFIG).map(([k, v]) => [k, [...v]]),
  );
}

export interface ReminderConfig {
  /** Per kind, distinct and sorted largest first. */
  leadDays: ReminderLeadDays;
  /** The kinds that can be Off: `[]` = Off. Distinct, largest first. */
  optional: Record<OptionalReminderKind, number[]>;
  /** `expiry_month` (the status change mails) or lead days before the card expires. */
  cardExpiring: CardExpiringTiming;
  /** When each kind's list last changed. Absent = never changed. */
  changedAt: Partial<Record<AnyReminderKind, Date>>;
}

interface StoredReminderConfig extends Partial<
  Record<ReminderKind | OptionalReminderKind, number[]>
> {
  card_expiring?: CardExpiringTiming;
  changed_at?: Partial<Record<AnyReminderKind, string>>;
}

/** The patch the settings API accepts. */
export type ReminderConfigPatch = Partial<Record<ReminderKind | OptionalReminderKind, number[]>> & {
  card_expiring?: CardExpiringTiming;
};

const DAY_MS = 86_400_000;

/** A valid list, distinct and sorted largest first; null when invalid. */
export function normalizeLeadDays(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((n) => Number.isInteger(n) && n >= MIN_LEAD_DAYS && n <= MAX_LEAD_DAYS)) return null;
  const out = [...new Set(v as number[])].sort((a, b) => b - a);
  return out.length <= MAX_LEAD_DAYS_PER_KIND ? out : null;
}

/** An optional kind's list: `[]` is Off; null when invalid. */
export function normalizeOptionalLeadDays(v: unknown): number[] | null {
  if (Array.isArray(v) && v.length === 0) return [];
  const out = normalizeLeadDays(v);
  return out && out.length <= MAX_OPTIONAL_LEAD_DAYS ? out : null;
}

/** The card expiry timing, or null when invalid. */
export function normalizeCardExpiring(v: unknown): CardExpiringTiming | null {
  if (v === CARD_EXPIRY_MONTH) return CARD_EXPIRY_MONTH;
  const out = normalizeLeadDays(v);
  return out && out.length <= MAX_OPTIONAL_LEAD_DAYS ? out : null;
}

function stored(raw: unknown): StoredReminderConfig {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as StoredReminderConfig) : {};
}

/** Takes the business ROW (Drizzle's camelCase `reminderConfig`), like the other resolvers. */
export function resolveReminderConfig(
  biz: { reminderConfig?: unknown } | null | undefined,
): ReminderConfig {
  const s = stored(biz?.reminderConfig);
  const leadDays = {} as ReminderLeadDays;
  for (const k of REMINDER_KINDS)
    leadDays[k] = normalizeLeadDays(s[k]) ?? [...DEFAULT_REMINDER_LEAD_DAYS[k]];
  const optional = {} as ReminderConfig["optional"];
  for (const k of OPTIONAL_REMINDER_KINDS) optional[k] = normalizeOptionalLeadDays(s[k]) ?? [];
  const changedAt: ReminderConfig["changedAt"] = {};
  for (const k of ALL_KINDS) {
    const at = s.changed_at?.[k];
    const d = typeof at === "string" ? new Date(at) : null;
    if (d && !Number.isNaN(d.getTime())) changedAt[k] = d;
  }
  return {
    leadDays,
    optional,
    cardExpiring: normalizeCardExpiring(s.card_expiring) ?? CARD_EXPIRY_MONTH,
    changedAt,
  };
}

/** One kind's resolved value, compared as text to see whether a write changed it. */
function resolvedKey(c: ReminderConfig, k: AnyReminderKind): string {
  if (k === "card_expiring") return String(c.cardExpiring);
  return (
    k in c.optional ? c.optional[k as OptionalReminderKind] : c.leadDays[k as ReminderKind]
  ).join(",");
}

/**
 * The stored value after a settings write. `patch` null resets every list to its default;
 * otherwise only the kinds it names change. `changed_at` moves for each kind whose
 * resolved list changed, so saving the same list again moves nothing.
 */
export function mergeReminderConfig(
  current: unknown,
  patch: ReminderConfigPatch | null,
  now: Date,
): StoredReminderConfig | null {
  const before = resolveReminderConfig({ reminderConfig: current });
  const s = stored(current);
  const next: StoredReminderConfig = {};
  const pick = <K extends keyof ReminderConfigPatch>(k: K) =>
    patch === null ? undefined : k in patch ? patch[k] : s[k];
  for (const k of REMINDER_KINDS) {
    const norm = normalizeLeadDays(pick(k));
    if (norm) next[k] = norm;
  }
  for (const k of OPTIONAL_REMINDER_KINDS) {
    const norm = normalizeOptionalLeadDays(pick(k));
    if (norm) next[k] = norm;
  }
  const card = normalizeCardExpiring(pick("card_expiring"));
  if (card) next.card_expiring = card;
  const after = resolveReminderConfig({ reminderConfig: next });
  const changedAt: Partial<Record<AnyReminderKind, string>> = { ...s.changed_at };
  for (const k of ALL_KINDS) {
    if (resolvedKey(after, k) !== resolvedKey(before, k)) changedAt[k] = now.toISOString();
  }
  if (Object.keys(changedAt).length > 0) next.changed_at = changedAt;
  return Object.keys(next).length > 0 ? next : null;
}

/** The API shape: every kind, resolved. */
export function serializeReminderConfig(biz: {
  reminderConfig?: unknown;
}): ReminderLeadDays & ReminderConfig["optional"] & { card_expiring: CardExpiringTiming } {
  const c = resolveReminderConfig(biz);
  return { ...c.leadDays, card_expiring: c.cardExpiring, ...c.optional };
}

/**
 * The lead day due now for a target date, or null.
 *
 * Only the smallest lead day already reached is due: the larger ones passed earlier, and a
 * late notice for each would repeat the same warning. A lead day that passed before its
 * list last changed (`changedAt`) is not sent either, when the target date was already
 * known then (`knownSince`, null = assume it was): the operator changed the timing for
 * dates still ahead, not for ones already gone.
 */
export function dueLeadDay(
  leadDays: readonly number[],
  target: Date,
  now: Date,
  guard: { changedAt?: Date; knownSince?: Date | null } = {},
): number | null {
  const remaining = target.getTime() - now.getTime();
  if (remaining <= 0) return null;
  const reached = leadDays.filter((d) => remaining <= d * DAY_MS);
  if (reached.length === 0) return null;
  const lead = Math.min(...reached);
  const { changedAt, knownSince } = guard;
  if (
    changedAt &&
    target.getTime() - lead * DAY_MS < changedAt.getTime() &&
    (!knownSince || knownSince.getTime() < changedAt.getTime())
  )
    return null;
  return lead;
}

/**
 * Was a reminder for `lead` (or a closer one) already sent? `sent` are the `lead_days` of
 * the events already emitted for this occurrence; null is an event from before 0376,
 * which was sent at `legacyLead`, the default of the day.
 */
export function leadAlreadySent(
  sent: ReadonlyArray<number | null>,
  lead: number,
  legacyLead: number,
): boolean {
  return sent.some((d) => (d ?? legacyLead) <= lead);
}
