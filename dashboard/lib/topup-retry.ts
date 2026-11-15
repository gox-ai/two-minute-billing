// The retry schedule of a declined automatic top-up (`credit_config.auto_topup_retries`,
// `auto_topup_retry_hours`, `auto_topup_retry_hours_by_method`): the form's conversion to
// the API body, its checks and its sentences. Pure, relative imports only.

/** The API's default and limits. */
export const TOPUP_RETRY_DEFAULT_HOURS: readonly number[] = [4, 12];
export const TOPUP_RETRY_MAX_DELAYS = 4;
export const TOPUP_RETRY_WINDOW_HOURS = 72;

export const TOPUP_RETRY_METHODS = ["card", "bank_debit"] as const;
export type TopupRetryMethod = (typeof TOPUP_RETRY_METHODS)[number];
export type TopupRetryByMethod = Partial<Record<TopupRetryMethod, number[]>>;

/** How a sentence names each kind. */
export const TOPUP_RETRY_METHOD_NAME: Record<TopupRetryMethod, string> = {
  card: "cards",
  bank_debit: "bank debits",
};

/** The three stored keys, as the API returns them. */
export interface TopupRetryStored {
  auto_topup_retries?: boolean;
  auto_topup_retry_hours?: number[];
  auto_topup_retry_hours_by_method?: TopupRetryByMethod;
}

/** The keys with the API's defaults filled in. */
export interface TopupRetryResolved {
  /** False also for a stored empty list: the engine then makes one try only. */
  auto_topup_retries: boolean;
  auto_topup_retry_hours: number[];
  auto_topup_retry_hours_by_method: TopupRetryByMethod;
}

export function resolveTopupRetry(c: TopupRetryStored | null | undefined): TopupRetryResolved {
  const hours = c?.auto_topup_retry_hours ?? [...TOPUP_RETRY_DEFAULT_HOURS];
  return {
    auto_topup_retries: c?.auto_topup_retries !== false && hours.length > 0,
    auto_topup_retry_hours: hours,
    auto_topup_retry_hours_by_method: c?.auto_topup_retry_hours_by_method ?? {},
  };
}

/** "1 hour", "4 hours", "1,000 hours". */
export const hoursLabel = (h: number) =>
  `${h.toLocaleString("en-US")} ${h === 1 ? "hour" : "hours"}`;

/** "4 hours, then 12 hours". */
export const hoursList = (hours: readonly number[]) => hours.map(hoursLabel).join(", then ");

/** The tries a decline on this kind of method gets: its own list, else the business list. */
export function topupTriesFor(c: TopupRetryResolved, method: TopupRetryMethod | null): number {
  if (!c.auto_topup_retries) return 1;
  const own = method ? c.auto_topup_retry_hours_by_method[method] : undefined;
  return (own ?? c.auto_topup_retry_hours).length + 1;
}

/**
 * The tries of a declined top-up when every kind of payment method has the same number;
 * null when a kind has its own number, because a run does not say which kind it charged.
 */
export function topupMaxTries(c: TopupRetryResolved): number | null {
  const all = [null, ...TOPUP_RETRY_METHODS].map((m) => topupTriesFor(c, m));
  return all.every((n) => n === all[0]) ? all[0]! : null;
}

/** "at once, after 4 hours, then 12 hours later". */
function triesClause(hours: readonly number[]): string {
  if (hours.length === 1) return `at once, then after ${hoursLabel(hours[0]!)}`;
  const later = hours.slice(1).map((h) => `${hoursLabel(h)} later`);
  later[later.length - 1] = `then ${later[later.length - 1]}`;
  return ["at once", `after ${hoursLabel(hours[0]!)}`, ...later].join(", ");
}

/** The summary value: "3 tries: at once, after 4 hours, then 12 hours later". */
export function retryScheduleLine(hours: readonly number[]): string {
  return hours.length === 0 ? "1 try" : `${hours.length + 1} tries: ${triesClause(hours)}`;
}

/** What the schedule does, for the note under the editor. One sentence per array entry. */
export function retryConsequence(enabled: boolean, hours: readonly number[]): string[] {
  if (!enabled || hours.length === 0)
    return ["We try one time. A declined payment disables the automatic top-up at once."];
  const total = hours.reduce((a, h) => a + h, 0);
  return [
    `We try ${hours.length + 1} times: ${triesClause(hours)}.`,
    ...(hours.length > 1 ? [`The last try is ${hoursLabel(total)} after the first.`] : []),
    "If the last try is declined, we disable the automatic top-up.",
    "A decline that a new try cannot change (for example, a closed card) disables it at once.",
  ];
}

/** Why a list of delays is refused, or null. `who` names a kind: "for cards". */
export function retryHoursIssue(hours: readonly number[], who = ""): string | null {
  const w = who ? ` ${who}` : "";
  if (hours.some((h) => !Number.isInteger(h) || h < 1))
    return `Enter each delay${w} as a whole number of hours, 1 or more.`;
  if (hours.length > TOPUP_RETRY_MAX_DELAYS)
    return `Enter ${TOPUP_RETRY_MAX_DELAYS} delays or fewer${w}. An automatic top-up tries ${TOPUP_RETRY_MAX_DELAYS + 1} times at most.`;
  const total = hours.reduce((a, h) => a + h, 0);
  if (total > TOPUP_RETRY_WINDOW_HOURS)
    return `The delays${w} must add up to ${TOPUP_RETRY_WINDOW_HOURS} hours or less. They add up to ${hoursLabel(total)}.`;
  return null;
}

/** "4, 12" → [4, 12]. NaN marks an entry that is not a number. */
export function parseHoursText(text: string): number[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => (/^\d+$/.test(s) ? Number(s) : NaN));
}

/** The retry fields as typed. */
export interface TopupRetryDraft {
  enabled: boolean;
  /** One entry per row of the schedule. No rows = the default schedule. */
  hours: string[];
  /** A comma-separated list per kind. Blank = the business schedule. */
  card: string;
  bank_debit: string;
}

export function topupRetryDraft(c: TopupRetryResolved): TopupRetryDraft {
  return {
    enabled: c.auto_topup_retries,
    hours: c.auto_topup_retry_hours.map(String),
    card: (c.auto_topup_retry_hours_by_method.card ?? []).join(", "),
    bank_debit: (c.auto_topup_retry_hours_by_method.bank_debit ?? []).join(", "),
  };
}

/** The error keys: the list, one row of it, and one kind of method. */
export const RETRY_HOURS_KEY = "auto_topup_retry_hours";
export const retryRowKey = (i: number) => `${RETRY_HOURS_KEY}_${i}`;
export const retryMethodKey = (m: TopupRetryMethod) => `${RETRY_HOURS_KEY}_${m}`;

const sameList = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The keys to send. A key whose value did not change is left out, and the API keeps what it
 * has: a business that never set a schedule stays on the default. With retries off the
 * schedule is not read, so its stored value stays.
 */
export function topupRetryBody(
  d: TopupRetryDraft,
  saved: TopupRetryResolved,
): { ok: true; value: TopupRetryStored } | { ok: false; errors: Record<string, string> } {
  const value: TopupRetryStored = {};
  if (d.enabled !== saved.auto_topup_retries) value.auto_topup_retries = d.enabled;
  if (!d.enabled) return { ok: true, value };

  const errors: Record<string, string> = {};
  const typed = d.hours.map((t) => (/^\d+$/.test(t.trim()) ? Number(t.trim()) : NaN));
  const hours = typed.length ? typed : [...TOPUP_RETRY_DEFAULT_HOURS];
  const issue = retryHoursIssue(hours);
  if (issue) {
    errors[RETRY_HOURS_KEY] = issue;
    // Mark the rows at fault. A fault of the whole list (count, total) marks every row.
    const badRow = (h: number) => !Number.isInteger(h) || h < 1;
    const whole = !typed.some(badRow);
    typed.forEach((h, i) => {
      if (whole || badRow(h)) errors[retryRowKey(i)] = issue;
    });
  } else if (!sameList(hours, saved.auto_topup_retry_hours)) value.auto_topup_retry_hours = hours;

  const stored = saved.auto_topup_retry_hours_by_method;
  const next: TopupRetryByMethod = {};
  for (const m of TOPUP_RETRY_METHODS) {
    const list = parseHoursText(d[m]);
    if (list.length === 0) {
      // An empty list set through the API (no new try for this kind) stays as it is.
      if (stored[m]?.length === 0) next[m] = [];
      continue;
    }
    const bad = retryHoursIssue(list, `for ${TOPUP_RETRY_METHOD_NAME[m]}`);
    if (bad) errors[retryMethodKey(m)] = bad;
    else next[m] = list;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const changed = TOPUP_RETRY_METHODS.some((m) =>
    next[m] && stored[m] ? !sameList(next[m], stored[m]) : next[m] !== stored[m],
  );
  if (changed) value.auto_topup_retry_hours_by_method = next;
  return { ok: true, value };
}

/** What a declined payment does, in a few words: a fact row on the customer's page. */
export function declinedPaymentLine(c: TopupRetryResolved): string {
  if (!c.auto_topup_retries) return "We disable the automatic top-up";
  const n = topupMaxTries(c);
  return n == null ? "We try again" : `We try again, ${n} tries in total`;
}

/** The same, as a help line that names where the schedule is. */
export function retryPointer(c: TopupRetryResolved): string {
  return c.auto_topup_retries
    ? `If a payment is declined: ${declinedPaymentLine(c).replace(/^We/, "we")}. The retry schedule is in Settings → Credits.`
    : "If a payment is declined, we disable the automatic top-up. To try again after a decline, enable 'Try a declined automatic top-up again' in Settings → Credits.";
}
