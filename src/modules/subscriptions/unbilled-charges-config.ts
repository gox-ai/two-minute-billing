/**
 * Unbilled Charges — invoice-now vs retain-as-unbilled, decided independently for
 * each of three lifecycle events.
 *
 * ── Three events ───────────────────────────────────────────────────────────────
 * This resolver covers only the three events this engine has a DECISION POINT for —
 * a call site that reads a business default rather than always doing one fixed
 * thing:
 *
 *   on_create · on_change · on_one_time_charge
 *
 * Five keys were considered and dropped, all on the same Rule 0 ground (CLAUDE.md:
 * never ship a control that reaches no backend field):
 *
 *   · `on_term_extend`, `on_future_to_active`, `on_advance_charge` — ZERO engine
 *     references anywhere outside this settings surface. There is no term-extension,
 *     advance-charge or future→active operation for them to govern.
 *   · `on_reactivate` — `reactivateSubscriptionWithOptions` (`./service.ts`) has no
 *     invoice-immediately concept at all; it returns `{ subscription, billable, isTrial }`
 *     and never consults a business default. Wiring this in would mean adding new
 *     plumbing to that function, not reading a setting that already exists.
 *   · `on_trial_to_active` — trial conversion happens inside the renewal engine
 *     (`./renewal.ts`), which bills the new period unconditionally. Same story.
 *
 * All five stay recorded in `docs/PROGRESS.md` as missing call-site work, not as
 * keys here — a key comes back only once a real decision point exists behind it.
 *
 * ── What this deliberately does NOT govern ─────────────────────────────────────
 * · CANCEL — `businesses.defaultUnbilledOnCancel` plus the cancel route's own
 *   per-call `unbilled_charges_option`. Cancel keeps its own separate control.
 * · RESUME — `ResumeChargesHandling` (`modules/subscriptions/service.ts`). Same
 *   reasoning: already its own option, already per call.
 * · REACTIVATION and TRIAL→ACTIVE — always invoice immediately today (see above);
 *   not a business-configurable choice yet.
 * A key here for any of these would be a second place to say the same thing, which
 * is a second place to disagree.
 * · `businesses.createPendingInvoices` / `autoClosePendingAfterDays` — a DIFFERENT
 *   axis despite the similar name: whether RENEWAL invoices are raised in `pending`
 *   state for usage collection, read only in `modules/subscriptions/renewal.ts`. The
 *   settings page renders both, in separate sections, precisely so this is not
 *   conflated in the copy.
 *
 * ── Defaults are NOT uniform, and two of them INHERIT ──────────────────────────
 * Checked each event against the actual code rather than assuming "today's
 * behaviour" is one value:
 *
 *   · `on_create` — `src/api/subscription-routes.ts`'s create handler resolves
 *     `invoiceFirstPeriodNow` from `resolveUnbilledChargesConfig(business).onCreate`
 *     (previously `parsed.data.invoice_immediately !== false`, true when omitted).
 *     Default: fixed `invoice_immediately`.
 *   · `on_change`, `on_one_time_charge` — both wired through
 *     `defaultInvoiceImmediately(org, biz, event)` (`./proration.ts`), called from
 *     `changeSubscription` (same file) and from the item-add / one-time-charge path
 *     in `./items.ts`. That function now selects `unbilledChargesConfig` alongside
 *     `businesses.defaultInvoiceImmediately` and returns
 *     `resolveUnbilledChargesConfig(biz)[event] === "invoice_immediately"` — so this
 *     resolver IS the mechanism, not just documentation of it. `defaultInvoiceImmediately`
 *     is a column whose own DB default is `false` (`db/schema/tenancy.ts`, changed
 *     deliberately post-H: "NOT NULL DEFAULT true silently turned free operations
 *     into billed ones"). So an untouched business defers both today, and these two
 *     keys INHERIT that column instead of hardcoding a default — see
 *     `inheritedOption` below. Inheriting also honours a merchant who already set
 *     the older flag, which a fixed default would silently discard.
 *
 * An explicit valid value on the key itself still overrides inheritance; only an
 * absent/null/malformed key inherits.
 *
 * ── Shape and style ─────────────────────────────────────────────────────────────
 * Modelled on `resolveCreditsFlexibility` (`modules/customers/credits-flexibility.ts`)
 * and `resolveInvoiceCustomization` (`modules/invoicing/customization.ts`): one
 * nullable jsonb column (`businesses.unbilledChargesConfig`), a PURE resolver, a
 * docblock per field naming its default, and the house rule that **only an explicit
 * valid value opts out of the default** — null, absent, or a hand-edited/malformed
 * stored value all resolve to the documented default (fixed or inherited). A stored
 * row still carrying a withdrawn key (`on_reactivate`, `on_trial_to_active`, or any
 * of the three never-shipped ones — e.g. from a client built against an earlier
 * draft of this API) is simply ignored: the resolved object has exactly the three
 * keys above, always.
 */

/** What a lifecycle event does with the charge it produces. */
export type UnbilledChargeOption = "invoice_immediately" | "add_to_unbilled";

/** The three events this engine has a decision point for. See the file docblock. */
export type UnbilledChargeEvent = "on_create" | "on_change" | "on_one_time_charge";

export interface UnbilledChargesConfig {
  /** A new item/charge attached mid-term. Fixed default `invoice_immediately`. */
  onCreate: UnbilledChargeOption;
  /**
   * An existing item's price/quantity changed mid-term. INHERITS
   * `businesses.defaultInvoiceImmediately` when unset — that column defaults to
   * `false`, so an untouched business resolves to `add_to_unbilled` here.
   */
  onChange: UnbilledChargeOption;
  /**
   * A one-time / ad-hoc charge is added. INHERITS `businesses.defaultInvoiceImmediately`
   * when unset, same as `onChange`.
   */
  onOneTimeCharge: UnbilledChargeOption;
}

/**
 * The default config for a business with NO `unbilled_charges_config` AND no
 * `default_invoice_immediately` override — i.e. every column at its own DB default.
 * `onChange` / `onOneTimeCharge` read `add_to_unbilled` here because that is what
 * `default_invoice_immediately`'s DB default (`false`) resolves to; a business that
 * has set that older flag to `true` resolves those two keys differently — see
 * {@link resolveUnbilledChargesConfig}, which is the function to call, not this
 * constant, whenever a real business row is in hand.
 */
export const DEFAULT_UNBILLED_CHARGES_CONFIG: UnbilledChargesConfig = {
  onCreate: "invoice_immediately",
  onChange: "add_to_unbilled",
  onOneTimeCharge: "add_to_unbilled",
};

/**
 * The stored jsonb shape (snake_case, like `dunning_config`). Every key optional.
 * Deliberately has no `on_reactivate` / `on_trial_to_active` (or the three keys that
 * were never shipped): a row carrying one is a client built against an earlier
 * contract, and its value is ignored rather than typed, matching
 * {@link resolveUnbilledChargesConfig}'s behaviour of returning exactly the three
 * live keys regardless of what else the stored blob contains.
 */
interface StoredUnbilledChargesConfig {
  on_create?: unknown;
  on_change?: unknown;
  on_one_time_charge?: unknown;
}

/**
 * `businesses.defaultInvoiceImmediately` as the option `on_change` / `on_one_time_charge`
 * inherit. Only an exact boolean `true` selects `invoice_immediately`; anything else —
 * `false`, absent, `null`, a stray string from a hand-edited row — resolves to
 * `add_to_unbilled`, which is also that column's own DB default. Mirrors the `?? false`
 * fallback `defaultInvoiceImmediately()` (`./proration.ts`) already applies.
 */
function inheritedOption(defaultInvoiceImmediately: unknown): UnbilledChargeOption {
  return defaultInvoiceImmediately === true ? "invoice_immediately" : "add_to_unbilled";
}

/**
 * One event's stored value against a given fallback. Only an explicit
 * `'invoice_immediately'` or `'add_to_unbilled'` opts out of `fallback`; everything
 * else — absent, misspelt, a boolean, a hand-edited row — resolves to it. `fallback`
 * is either the fixed default or, for the two inheriting keys, {@link inheritedOption}'s
 * result — so an explicit value on the key always wins over inheritance.
 */
function resolveOption(raw: unknown, fallback: UnbilledChargeOption): UnbilledChargeOption {
  return raw === "invoice_immediately" || raw === "add_to_unbilled" ? raw : fallback;
}

/**
 * Resolve a business's effective Unbilled Charges config. Pure; a null / absent /
 * malformed stored value resolves to the documented default for each key — fixed for
 * `onCreate`, inherited from `defaultInvoiceImmediately` for `onChange` /
 * `onOneTimeCharge`. The returned object always has exactly these three keys, no
 * matter what a stored blob carries alongside them.
 */
export function resolveUnbilledChargesConfig(
  biz: { unbilledChargesConfig?: unknown; defaultInvoiceImmediately?: unknown } | null | undefined,
): UnbilledChargesConfig {
  const raw = (biz?.unbilledChargesConfig ?? null) as StoredUnbilledChargesConfig | null;
  const inherited = inheritedOption(biz?.defaultInvoiceImmediately);
  return {
    onCreate: resolveOption(raw?.on_create, "invoice_immediately"),
    onChange: resolveOption(raw?.on_change, inherited),
    onOneTimeCharge: resolveOption(raw?.on_one_time_charge, inherited),
  };
}

/**
 * `option` as the boolean shape `defaultInvoiceImmediately()` (`./proration.ts`) and
 * every `invoiceImmediately` call-site parameter already use, so a caller resolving
 * through this config can hand the result straight to existing signatures.
 */
export function isInvoiceImmediately(option: UnbilledChargeOption): boolean {
  return option === "invoice_immediately";
}
