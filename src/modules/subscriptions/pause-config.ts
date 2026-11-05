/**
 * Pause / resume defaults — what a pause or a resume does when the CALL does not say.
 *
 * Five defaults across the pair: three that shape the pause (when, what happens to
 * unbilled charges, what happens to
 * dunning) and two that shape the resume (what to do about the resumed period's charge,
 * what to do about invoices still unpaid).
 *
 * ── What this governs, and what it deliberately does not ─────────────────────
 * These are DEFAULTS for an omitted argument, nothing more. `pauseSubscriptionWithOptions`
 * and `resumeSubscriptionWithOptions` keep their per-call parameters and an explicit
 * argument always wins — the operations were shipped and core long before this column
 * existed, and two integrations against one business pausing differently is the gap being
 * closed, not the API.
 *
 * ── A value whose meaning needs a per-call argument cannot be a site default ─
 * `pause_option` stores `immediately | end_of_term` only. The route accepts two more and
 * both are per-call ONLY:
 *   · `specific_date` needs a `pause_date`, and a business default has nowhere to carry one
 *     — `pauseSubscriptionWithOptions` throws "specific_date pause requires pause_date", so
 *     storing it would BREAK every pause that omits the option. Worse than a no-op control.
 *   · `billing_cycles` needs `skip_billing_cycles`; a stored "N cycles" with no N would
 *     resolve to a silent one-cycle pause.
 * Nothing is lost: both remain reachable on the call, which is where the date or the count
 * can actually be supplied.
 *
 * ── Two questions are deliberately ABSENT (Rule 0) ──────────────────────────
 * A pause DURATION and a resume TIMING are the obvious next two questions. Neither has an
 * engine parameter to feed, so storing them would be a setting that changes nothing:
 * `resumeSubscriptionWithOptions` has no timing argument — it resumes as of `now` — and
 * duration is expressed by the caller's own `pause_date` / `skip_billing_cycles`, so
 * "indefinite" is just "pass neither"
 * and a stored "until a date" has no date to use. Tracked in docs/PROGRESS.md as
 * controls we lack the parameter for, not silently dropped.
 *
 * ── `locked` is enforced on operator calls ───────────────────────────────────
 * A merchant can LOCK a default so a per-call argument cannot override it. The pause and
 * resume API routes (dashboard + API keys) refuse an explicit value that differs from a
 * locked default — see {@link lockedOverrides}. Sending the default itself is allowed.
 * NOT checked here, deliberately: scheduled pauses and resumes (checked when scheduled),
 * chargeback-policy pauses (a business rule of their own) and the buyer portal, whose
 * pause options live in `storefront_config`. The list is sanitised to the five known keys.
 *
 * ── Shape and style ─────────────────────────────────────────────────────────
 * Modelled on `resolveCreditsFlexibility` (`modules/customers/credits-flexibility.ts`) and
 * `resolveInvoiceCustomization` (`modules/invoicing/customization.ts`): one nullable jsonb
 * column on `businesses`, a PURE resolver, a docblock per field naming its default, and
 * the house rule that **only an explicit VALID value opts out**. Null, absent, or a
 * hand-edited value outside the literal union resolves to the default — checked against
 * the union, never against truthiness.
 *
 * Every default here is the engine's real fallback, so a business that never opens the
 * screen gets exactly what an omitted argument does.
 *
 * ── The wiring contract ─────────────────────────────────────────────────────
 * Every resolved value is one of the engine's own literals, so a call site passes it
 * through verbatim. The one translation is on READ: the retired `next_renewal` resolves to
 * `add_to_unbilled_charges` (see {@link ChargesOnResume}).
 */

/**
 * When the pause takes effect, minus the two values that need a per-call argument —
 * see the header: `specific_date` needs a
 * `pause_date` a site default cannot carry (`pauseSubscriptionWithOptions` throws
 * "specific_date pause requires pause_date" without one), and `billing_cycles` needs a
 * cycle count. Both stay fully available per call.
 */
export type PauseTiming = "immediately" | "end_of_term";

/** What happens to charges accrued but not yet invoiced when the pause lands. */
export type UnbilledOnPause = "retain" | "invoice";

/** Whether payment retries keep running on the subscription's open invoices while paused. */
export type DunningOnPause = "continue" | "stop";

/**
 * How an out-of-term resume bills its new term. Spelled as `ResumeChargesHandling`
 * (`./service.ts`), so the wiring is a pass-through. There is no "don't charge" member:
 * billing is in advance, so an uncharged new term would be a free one.
 */
export type ChargesOnResume = "invoice_immediately" | "add_to_unbilled_charges";

/** Retired stored value, read as `add_to_unbilled_charges` (the next invoice carries it). Never written. */
export const LEGACY_CHARGES_ON_RESUME = "next_renewal";

/** A stored `pause_config` with the retired `charges_on_resume` spelled as what it resolves to — for serializing. */
export function withoutLegacyChargesOnResume(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const cfg = raw as Record<string, unknown>;
  return cfg.charges_on_resume === LEGACY_CHARGES_ON_RESUME
    ? { ...cfg, charges_on_resume: "add_to_unbilled_charges" }
    : raw;
}

/**
 * What to do with invoices still unpaid when the subscription comes back.
 *
 * Spelled as `UnpaidInvoicesHandling` (`./service.ts`) and the resume route's zod — the
 * screen keeps its own friendlier wording as the LABELS, exactly as
 * `default_ar_handling_on_cancel` already does for the same two answers on the
 * cancellation page.
 */
export type UnpaidInvoicesOnResume = "no_action" | "schedule_payment_collection";

/** The five configurable keys, in the stored jsonb's snake_case — also the `locked` vocabulary. */
export const PAUSE_CONFIG_KEYS = [
  "pause_option",
  "unbilled_on_pause",
  "dunning_on_pause",
  "charges_on_resume",
  "unpaid_invoices_on_resume",
] as const;

export type PauseConfigKey = (typeof PAUSE_CONFIG_KEYS)[number];

/**
 * The resolved config, camelCase for engine use (like `CreditsFlexibilityConfig` and
 * `InvoiceCustomization`). Every field is present and valid — callers never have to
 * re-check a stored value.
 */
export interface PauseConfig {
  /**
   * Default `immediately` — `POST …/pause`'s own zod default for `pause_option`. A real
   * choice (pause now vs at term end); the two date/count-bearing values are per-call only.
   */
  pauseOption: PauseTiming;
  /**
   * Default `retain`. `pauseSubscriptionWithOptions` only touches unbilled charges when
   * `unbilledChargesHandling` is passed, so an omitted argument leaves them standing.
   */
  unbilledOnPause: UnbilledOnPause;
  /**
   * Default `continue`. `pauseSubscriptionWithOptions` acts only on
   * `dunningHandling === 'stop'` (service.ts:3492); with the argument omitted nothing calls
   * `stopDunning`, so retries keep running. `PauseSubscriptionDialog` preselects the same.
   *
   * 0242 originally documented this as `stop`, which is not what the engine does.
   * Defaulting to it would have halted collection on the open invoices of every business
   * that never opened the screen.
   */
  dunningOnPause: DunningOnPause;
  /**
   * Default `invoice_immediately`. Applies only to an OUT-OF-TERM resume (the term ended
   * while paused), which restarts the term at the resume and must bill it. An in-term
   * resume continues the term already invoiced and charges nothing either way.
   */
  chargesOnResume: ChargesOnResume;
  /**
   * Default `no_action` — pass nothing. `resumeSubscriptionWithOptions` collects only on
   * `'schedule_payment_collection'`; omitted leaves open invoices open.
   */
  unpaidInvoicesOnResume: UnpaidInvoicesOnResume;
  /**
   * Defaults to `[]`. The keys the merchant has marked as not overridable per call; enforced
   * by {@link lockedOverrides}. Sanitised to {@link PAUSE_CONFIG_KEYS}, de-duplicated, and
   * ordered as `PAUSE_CONFIG_KEYS` is, so two equivalent stored lists resolve equal.
   */
  locked: readonly PauseConfigKey[];
}

/**
 * What a business that has configured nothing gets. `businesses.pause_config` is jsonb
 * with no column default, so this resolves for every business that has never saved the
 * Pause & resume form — i.e. all of them on the day this ships.
 *
 * Each is what the engine does with the argument omitted.
 */
export const DEFAULT_PAUSE_CONFIG: PauseConfig = {
  pauseOption: "immediately",
  unbilledOnPause: "retain",
  dunningOnPause: "continue",
  chargesOnResume: "invoice_immediately",
  unpaidInvoicesOnResume: "no_action",
  locked: [],
};

/** The stored jsonb shape (snake_case). Every member optional and `unknown` — the row may be hand-edited. */
interface StoredPauseConfig {
  pause_option?: unknown;
  unbilled_on_pause?: unknown;
  dunning_on_pause?: unknown;
  charges_on_resume?: unknown;
  unpaid_invoices_on_resume?: unknown;
  locked?: unknown;
}

/** Only a value IN the union opts out of the default. Not truthiness — `''`, `0` and `'Immediately'` are all malformed. */
function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/**
 * The `locked` list, reduced to known keys.
 *
 * Filtered rather than rejected as a whole: one unrecognised entry (a renamed key, an
 * importer's guess) must not throw away the locks that ARE meaningful. Built by walking
 * `PAUSE_CONFIG_KEYS` so the result is de-duplicated and in a stable order regardless of
 * how the row was written.
 */
function resolveLocked(raw: unknown): readonly PauseConfigKey[] {
  if (!Array.isArray(raw)) return DEFAULT_PAUSE_CONFIG.locked;
  const seen = new Set(raw.filter((v): v is string => typeof v === "string"));
  return PAUSE_CONFIG_KEYS.filter((k) => seen.has(k));
}

/**
 * Resolve a business's effective pause / resume defaults. Pure — no DB access; a null,
 * absent or malformed stored value resolves to {@link DEFAULT_PAUSE_CONFIG}.
 *
 * Takes the business ROW (Drizzle's camelCase `pauseConfig`), like every other resolver in
 * this family, so a caller that already holds the row needs no second read.
 */
export function resolvePauseConfig(biz: { pauseConfig?: unknown } | null | undefined): PauseConfig {
  const raw = (biz?.pauseConfig ?? null) as StoredPauseConfig | null;
  // A jsonb column can legally hold a scalar or an array; only an object has keys.
  const cfg = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  return {
    pauseOption: pick(
      cfg?.pause_option,
      ["immediately", "end_of_term"],
      DEFAULT_PAUSE_CONFIG.pauseOption,
    ),
    unbilledOnPause: pick(
      cfg?.unbilled_on_pause,
      ["retain", "invoice"],
      DEFAULT_PAUSE_CONFIG.unbilledOnPause,
    ),
    dunningOnPause: pick(
      cfg?.dunning_on_pause,
      ["continue", "stop"],
      DEFAULT_PAUSE_CONFIG.dunningOnPause,
    ),
    chargesOnResume: pick(
      cfg?.charges_on_resume === LEGACY_CHARGES_ON_RESUME
        ? "add_to_unbilled_charges"
        : cfg?.charges_on_resume,
      ["invoice_immediately", "add_to_unbilled_charges"],
      DEFAULT_PAUSE_CONFIG.chargesOnResume,
    ),
    unpaidInvoicesOnResume: pick(
      cfg?.unpaid_invoices_on_resume,
      ["no_action", "schedule_payment_collection"],
      DEFAULT_PAUSE_CONFIG.unpaidInvoicesOnResume,
    ),
    locked: resolveLocked(cfg?.locked),
  };
}

/** Labels for refusal messages; they match the Pause and resume settings screen. */
const LOCK_LABELS: Record<PauseConfigKey, string> = {
  pause_option: "When to pause",
  unbilled_on_pause: "Unbilled charges on pause",
  dunning_on_pause: "Retries on pause",
  charges_on_resume: "Charges on resume",
  unpaid_invoices_on_resume: "Unpaid invoices on resume",
};

/**
 * The per-call values, in the API's own vocabulary. Absent = the caller did not say, which
 * is never an override. `unbilled_charges_handling` maps onto the stored union:
 * `no_action` = retain, `invoice` = invoice, `delete` has no stored twin, so it always differs.
 */
export interface PauseCallOptions {
  pause_option?: string;
  unbilled_charges_handling?: string;
  dunning_handling?: string;
  charges_handling?: string;
  unpaid_invoices_handling?: string;
}

/** Locked keys the call explicitly sets to something other than the business default. */
export function lockedOverrides(cfg: PauseConfig, call: PauseCallOptions): PauseConfigKey[] {
  const unbilled =
    call.unbilled_charges_handling === undefined
      ? undefined
      : call.unbilled_charges_handling === "no_action"
        ? "retain"
        : call.unbilled_charges_handling;
  const asked: Partial<Record<PauseConfigKey, string>> = {
    pause_option: call.pause_option,
    unbilled_on_pause: unbilled,
    dunning_on_pause: call.dunning_handling,
    charges_on_resume: call.charges_handling,
    unpaid_invoices_on_resume: call.unpaid_invoices_handling,
  };
  const effective: Record<PauseConfigKey, string> = {
    pause_option: cfg.pauseOption,
    unbilled_on_pause: cfg.unbilledOnPause,
    dunning_on_pause: cfg.dunningOnPause,
    charges_on_resume: cfg.chargesOnResume,
    unpaid_invoices_on_resume: cfg.unpaidInvoicesOnResume,
  };
  return cfg.locked.filter((k) => asked[k] !== undefined && asked[k] !== effective[k]);
}

/** The 400 message for {@link lockedOverrides}' result. `verb` is "pause" or "resume". */
export function lockedOverrideMessage(verb: "pause" | "resume", keys: PauseConfigKey[]): string {
  const names = keys.map((k) => LOCK_LABELS[k]).join(", ");
  return `We could not ${verb} the subscription. This business locks these settings: ${names}. Remove them from the request, or change them in Settings → Billing rules → Pause and resume.`;
}
