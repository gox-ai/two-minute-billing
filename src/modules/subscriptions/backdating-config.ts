/**
 * Backdating window — how far into the past a subscription or invoice operation may be
 * recorded.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Backdating already works and is COMPLETELY UNBOUNDED: `start_date` on subscription
 * create and `at` on change accept any past instant (`api/subscription-routes.ts`);
 * `docs/PARITY.md` records the gap as "backdate window not enforced". An unbounded
 * backdate can post an invoice into a CLOSED accounting period — where the tax rates and
 * the Net-D terms were different and the books are already filed — and nothing in the
 * engine notices.
 *
 * The shape is built around the accounting close rather than around the API: permitted
 * ACTIONS, a cut-off DAY of the
 * month by which the prior period must be sealed, and separate consent for a past INVOICE
 * date on creation vs on change (a backdated invoice is generated immediately, so it is a
 * bigger decision than a backdated subscription event).
 *
 * ── The permissive-default rule, and why it is load-bearing here ──────────────
 * Modelled on `resolveCreditsFlexibility` (`modules/customers/credits-flexibility.ts`)
 * and `resolveInvoiceCustomization` (`modules/invoicing/customization.ts`): one nullable
 * jsonb column on `businesses` (migration 0242), a PURE resolver, a docblock per field
 * naming its default, and the house rule that **only an explicit VALID value opts out**.
 *
 * Every default below is FULLY PERMISSIVE — backdating on, all five actions, no cut-off,
 * past invoice dates allowed on both paths — because this config must never retroactively
 * refuse a backdate that succeeded before the column existed. `backdating_config` has no
 * column default, so the businesses this resolves for are exactly the ones that have never
 * saved the form, i.e. all of them on the day it ships. Tightening is the merchant's
 * explicit act.
 *
 * That is also why a MALFORMED value resolves to the permissive default and never to a
 * value that would refuse work: a hand-edited row that failed to express a restriction has
 * not made a decision.
 *
 * ── Everything is a CALENDAR DAY question, in the BUSINESS timezone ───────────
 * The cut-off is a day of the month, so it can only be answered where the seller's books
 * are kept — not in UTC. `businesses.timezone` supplies it, exactly as invoice numbering
 * resolves its dynamic prefix (`modules/invoicing/customization.ts`). Same reasoning
 * decides what counts as a backdate at all: an earlier calendar DAY, not an earlier
 * instant, so a client whose clock is a second behind ours does not have its "now"
 * refused.
 *
 * ── Enforcement lives at the routes, not here ─────────────────────────────────
 * {@link isBackdateAllowed} is pure and calls nothing. The guard at the `start_date` /
 * `at` call sites feeds it and turns a refusal into a 400 — `code` and `message` are
 * shaped for `{ error: { type: 'invalid_request_error', code, message } }`.
 */

/**
 * The operations a merchant may permit or refuse independently — the four this engine can
 * backdate: `start_date` (create), `at` (change), `cancel_at` (cancel) and a checkout's
 * `reactivate_from` (reactivate). A one-time charge's `period_start` / `period_end` describe
 * the service window, not a charge date, so it has no entry.
 */
export type BackdatableAction = "create" | "change" | "cancel" | "reactivate";
export const BACKDATABLE_ACTIONS: readonly BackdatableAction[] = [
  "create",
  "change",
  "cancel",
  "reactivate",
];

/**
 * The permitted range for the cut-off day. The reason is real rather than
 * cosmetic: the day is meant to fall inside the window where the PREVIOUS period's books
 * are still open, and a close that has not happened by the 10th is not a close.
 */
export const MIN_BACKDATING_CUTOFF_DAY = 1;
export const MAX_BACKDATING_CUTOFF_DAY = 10;

export interface BackdatingConfig {
  /**
   * Default **true** — today's behaviour. False refuses every past-dated operation
   * outright, whatever `allowedActions` says.
   */
  enabled: boolean;
  /**
   * Which operations may carry a past date. Default **all three**.
   *
   * An explicitly EMPTY list is honoured (the merchant unchecked everything, which with
   * `enabled: true` refuses every backdate); a list whose every entry is unrecognisable is
   * malformed and takes the default. See {@link resolveBackdatingConfig}.
   */
  allowedActions: readonly BackdatableAction[];
  /**
   * The day of the month by which the previous period's books are sealed, 1..10, or
   * **null** — the default — for no restriction at all.
   */
  cutoffDayOfMonth: number | null;
  /**
   * Whether a subscription created with a past start date may raise an invoice dated in
   * the past. Default **true**.
   */
  allowPastInvoiceDateOnCreate: boolean;
  /**
   * The same consent for a change applied at a past instant. Separate from the create
   * flag because the two are decided by different people in practice — signup backfill
   * vs a mid-term correction. Default **true**.
   */
  allowPastInvoiceDateOnChange: boolean;
}

/** Fully permissive: exactly what the engine did before migration 0242. */
export const DEFAULT_BACKDATING_CONFIG: BackdatingConfig = {
  enabled: true,
  allowedActions: BACKDATABLE_ACTIONS,
  cutoffDayOfMonth: null,
  allowPastInvoiceDateOnCreate: true,
  allowPastInvoiceDateOnChange: true,
};

/** The stored jsonb shape (snake_case, every member optional and unknown). */
interface StoredBackdatingConfig {
  enabled?: unknown;
  allowed_actions?: unknown;
  cutoff_day_of_month?: unknown;
  allow_past_invoice_date_on_create?: unknown;
  allow_past_invoice_date_on_change?: unknown;
}

/**
 * A boolean with an explicit fallback. `typeof === 'boolean'`, never truthiness: every
 * flag here defaults to TRUE, so `!!raw` on an absent key would silently tighten the
 * window for every business that has not saved the form.
 */
function flag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * The cut-off day. Only an integer in 1..10 opts out of "no restriction"; 0, 31, `"abc"`,
 * NaN, a float and a negative all resolve to `null`.
 *
 * A numeric string is accepted because an importer or a hand-written row may carry one,
 * and the direction of failure is the point: an out-of-range value must never become a
 * value that refuses work.
 */
function cutoffDay(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n >= MIN_BACKDATING_CUTOFF_DAY && n <= MAX_BACKDATING_CUTOFF_DAY
    ? n
    : null;
}

/**
 * The permitted actions, filtered to names this engine knows.
 *
 * Four cases, and the third is the subtle one:
 *   · not an array           → the default (all three). Absent or hand-mangled.
 *   · an array, some known   → those, deduped and in canonical order.
 *   · an array, none known   → the default. `["subscription_create"]` is a failed attempt
 *                              to express a restriction, not a decision to refuse
 *                              everything, and reading it as the latter would refuse work.
 *                              This branch is now REACHABLE from real data: a row saved
 *                              while the config still offered `reactivate` / `one_time`
 *                              can hold nothing this engine recognises, and it must
 *                              resolve to permissive rather than to "refuse all".
 *   · an EMPTY array         → empty. This one IS explicit: the dashboard posts `[]` when
 *                              the merchant unchecks every box.
 */
function allowedActions(raw: unknown): readonly BackdatableAction[] {
  if (!Array.isArray(raw)) return DEFAULT_BACKDATING_CONFIG.allowedActions;
  if (raw.length === 0) return [];
  const posted = new Set(raw.filter((a): a is string => typeof a === "string"));
  const known = BACKDATABLE_ACTIONS.filter((a) => posted.has(a));
  return known.length > 0 ? known : DEFAULT_BACKDATING_CONFIG.allowedActions;
}

/**
 * Resolve a business's effective backdating window. Pure; a null / absent / malformed
 * stored value resolves to {@link DEFAULT_BACKDATING_CONFIG}, which is precisely what the
 * routes did before this column existed.
 */
export function resolveBackdatingConfig(
  biz: { backdatingConfig?: unknown } | null | undefined,
): BackdatingConfig {
  const raw = (biz?.backdatingConfig ?? null) as StoredBackdatingConfig | null;
  const d = DEFAULT_BACKDATING_CONFIG;
  return {
    enabled: flag(raw?.enabled, d.enabled),
    allowedActions: allowedActions(raw?.allowed_actions),
    cutoffDayOfMonth: cutoffDay(raw?.cutoff_day_of_month),
    allowPastInvoiceDateOnCreate: flag(
      raw?.allow_past_invoice_date_on_create,
      d.allowPastInvoiceDateOnCreate,
    ),
    allowPastInvoiceDateOnChange: flag(
      raw?.allow_past_invoice_date_on_change,
      d.allowPastInvoiceDateOnChange,
    ),
  };
}

// ── The predicate ───────────────────────────────────────────────────────────

export type BackdateRefusalCode =
  | "backdating_disabled"
  | "backdating_action_not_allowed"
  | "backdating_past_invoice_date_not_allowed"
  | "backdating_cutoff_passed"
  | "backdating_period_closed";

/** Allow, or refuse with an API error `code` and a message fit for a 400 body. */
export type BackdateDecision =
  | { allowed: true }
  | { allowed: false; code: BackdateRefusalCode; message: string };

const ALLOWED: BackdateDecision = { allowed: true };

const refuse = (code: BackdateRefusalCode, message: string): BackdateDecision => ({
  allowed: false,
  code,
  message,
});

/** Human wording for a refusal message. */
const ACTION_PHRASE: Record<BackdatableAction, string> = {
  create: "creating a subscription with a past start date",
  change: "applying a subscription change at a past date",
  cancel: "cancelling a subscription at a past date",
  reactivate: "reactivating a subscription from a past date",
};

interface CalendarDay {
  y: number;
  m: number;
  d: number;
}

/**
 * Y/M/D as they read in `timezone`. `Intl` rather than the `Date` getters, which answer in
 * the host's zone — a worker in UTC would put an Indian business on the wrong calendar day
 * for five and a half hours of every day, and this whole file is a calendar-day question.
 *
 * `en-CA` gives ISO-ordered parts, so the split is positional. An unknown or absent zone
 * falls back to UTC rather than throwing: a bad timezone string must not decide whether an
 * operation is refused.
 */
function calendarDayIn(at: Date, timezone: string): CalendarDay {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  let iso: string;
  try {
    iso = format(timezone);
  } catch {
    iso = format("UTC");
  }
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/** Months since year 0, so "the previous month" is plain subtraction across a year end. */
const monthIndex = (c: CalendarDay) => c.y * 12 + (c.m - 1);

/**
 * May `action` be recorded at `target`, given `now`?
 *
 * PURE, and deliberately called from nowhere — the guard at the `start_date` / `at` call
 * sites owns enforcement. Everything it needs is already in hand there: the business row
 * (config + timezone), the API-boundary instant from `businessWallClock`, and whether the
 * operation raises an invoice.
 *
 * ── What counts as a backdate ─────────────────────────────────────────────────
 * An earlier CALENDAR DAY in the business timezone. `target` later today, or in the
 * future, is not a backdate and is always allowed by this predicate — future-dating is a
 * different feature with its own rules.
 *
 * ── The cut-off day's exact semantics ─────────────────────────────────────────
 * `cutoffDayOfMonth` says when the PREVIOUS period's books are sealed. So, with a
 * cut-off set:
 *   · a target in the CURRENT month is always allowed — that period is still open;
 *   · a target in the IMMEDIATELY PRECEDING month is allowed only while today's day of
 *     the month is ≤ the cut-off day. Once the month has passed that day, that period is
 *     sealed and it is refused;
 *   · a target OLDER than the immediately preceding month is always refused. That hard
 *     cap is deliberate — do not re-litigate it. It is the only coherent
 *     reading: a merchant who says "last month closes on the 10th" cannot also mean a
 *     period that closed a year ago is open, and allowing it would refuse last month
 *     while accepting last January.
 * With `cutoffDayOfMonth: null` — the default — none of this applies and a backdate
 * reaches back as far as the caller asks.
 */
export function isBackdateAllowed(input: {
  config: BackdatingConfig;
  action: BackdatableAction;
  /** The past instant the caller asked for: `start_date`, `at`, `cancel_at`, invoice date. */
  target: Date;
  /** "Business now" — `businessWallClock(businessId)` at the API boundary. */
  now: Date;
  /** `businesses.timezone`. Null / unknown falls back to UTC. */
  businessTimezone?: string | null;
  /**
   * Whether granting this backdate would produce an invoice DATED in the past. Required
   * rather than optional so a guard cannot forget it and silently under-enforce; consulted
   * only for `create` and `change`, the two paths migration 0242 gives a flag.
   *
   * At the create route this is `invoice_immediately !== false && !hasTrial`; at the
   * change route it is whether the change books a proration invoice now.
   */
  raisesPastDatedInvoice: boolean;
}): BackdateDecision {
  const { config, action, target, now } = input;

  // A date we cannot reason about is not a date we refuse work over. Both routes build
  // these from a zod `.datetime()` string, so this is unreachable through the API.
  if (Number.isNaN(target.getTime()) || Number.isNaN(now.getTime())) return ALLOWED;

  const tz = input.businessTimezone?.trim() || "UTC";
  const t = calendarDayIn(target, tz);
  const n = calendarDayIn(now, tz);
  const tMonth = monthIndex(t);
  const nMonth = monthIndex(n);

  // Not a backdate: same calendar day, or later.
  if (tMonth > nMonth || (tMonth === nMonth && t.d >= n.d)) return ALLOWED;

  if (!config.enabled) {
    return refuse("backdating_disabled", "backdating is not permitted for this business");
  }

  if (!config.allowedActions.includes(action)) {
    return refuse(
      "backdating_action_not_allowed",
      `${ACTION_PHRASE[action]} is not permitted for this business`,
    );
  }

  if (action === "create" && input.raisesPastDatedInvoice && !config.allowPastInvoiceDateOnCreate) {
    return refuse(
      "backdating_past_invoice_date_not_allowed",
      "this business does not permit a past invoice date on subscription creation. The backdated signup would invoice its first period immediately",
    );
  }
  if (action === "change" && input.raisesPastDatedInvoice && !config.allowPastInvoiceDateOnChange) {
    return refuse(
      "backdating_past_invoice_date_not_allowed",
      "this business does not permit a past invoice date on a subscription change. The backdated change would raise its proration invoice immediately",
    );
  }

  const cutoff = config.cutoffDayOfMonth;
  if (cutoff !== null) {
    const period = `${t.y}-${String(t.m).padStart(2, "0")}`;
    if (tMonth < nMonth - 1) {
      return refuse(
        "backdating_period_closed",
        `${period} is a closed accounting period. Backdating can reach only the previous month`,
      );
    }
    // Only the PREVIOUS month is gated by the day; the current one is still open however
    // late in the month it is.
    if (tMonth === nMonth - 1 && n.d > cutoff) {
      return refuse(
        "backdating_cutoff_passed",
        `${period} closed on day ${cutoff} of the month. Today is day ${n.d}, and that period no longer accepts backdated entries`,
      );
    }
  }

  return ALLOWED;
}
