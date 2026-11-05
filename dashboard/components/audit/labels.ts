/**
 * P4 — shared vocabulary for the audit drill-in: what an `action` means in
 * English, and which event a given audit row is the operator-side of.
 *
 * Kept in one file because the Activity Log card and the audit detail page must
 * agree: if the card pairs `invoice.void` with `invoice_voided` but the page calls
 * it something else, the same act reads as two different things.
 */

/**
 * `action` → the verb phrase for the prose summary. Only actions we actually write
 * are listed (grep `writeAuditLog` in src/); an unknown action falls back to a
 * humanised form of the action string rather than a made-up sentence.
 */
const ACTION_PHRASE: Record<string, string> = {
  "business.settings_update": "updated the business settings",
  "invoice.update": "edited invoice details",
  "invoice.void": "voided the invoice",
  "invoice.close": "closed the pending invoice",
  "invoice.collect": "attempted collection on the invoice",
  "invoice.write_off": "wrote the invoice off as bad debt",
  "invoice.record_payment": "recorded an offline payment on the invoice",
  "invoice.regenerate": "regenerated the voided invoice",
  "invoice.stop_dunning": "stopped dunning the invoice",
  "invoice.pause_dunning": "paused dunning on the invoice",
  "credit_note.create": "issued a credit note",
  "credit_note.refund": "refunded the credit note",
  "credit_note.record_refund": "recorded an offline refund on the credit note",
  "credit_note.void": "voided the credit note",
  "subscription.cancel": "cancelled the subscription",
  "subscription.change": "changed the subscription",
  "subscription.pause": "paused the subscription",
  "subscription.resume": "resumed the subscription",
  "price.create": "created the price",
  "price.update": "updated the price",
  "price.archive": "archived the price",
  "price.restore": "restored the price",
  "product.create": "created the product",
  "product.update": "updated the product",
  "product.archive": "archived the product",
  "product.restore": "restored the product",
  "product_group.create": "created the product group",
  "product_group.update": "updated the product group",
  "product_group.archive": "archived the product group",
  "product_group.restore": "restored the product group",
  "coupon.create": "created the coupon",
  "coupon.update": "updated the coupon",
  "coupon.archive": "archived the coupon",
  "coupon.restore": "restored the coupon",
  "coupon_set.create": "created the coupon set",
  "coupon_set.rename": "renamed the coupon set",
  "coupon_set.update": "updated the coupon set",
  "coupon_set.archive": "archived the coupon set",
  "coupon_set.add_codes": "added codes to the coupon set",
  "coupon_set.archive_code": "archived a code in the coupon set",
  "coupon_set.delete_unused_codes": "deleted the unused codes in the coupon set",
  "transfer.run": "ran a data transfer",
  // Team / RBAC (2026-08-30). Operator-privilege changes, and the reason they are audited at
  // all: who can reach the org is the one fact nobody should have to reconstruct.
  "team.invite": "invited a teammate",
  "team.role_change": "changed a teammate's role",
  "team.remove": "removed a teammate from the organization",
  "team.resend_invite": "resent a teammate's invite",
  "team.accept_invite": "accepted an invite to the organization",
  "team.decline_invite": "declined an invite to the organization",
};

/**
 * Actors that are not a person and not a credential, and so have a name instead of an
 * identifier. Anything else is shown as-is — an operator's email is already their name.
 *
 *  - `dashboard`     — a request from this UI that arrived without a resolvable
 *                      session, so we know WHERE it came from but not WHO. The
 *                      ordinary case names the person; this is the honest fallback,
 *                      never a placeholder human.
 *  - `system`        — no human and no request: seeds, verify runs.
 *  - `billing_clock` — the durable clock's own passes (renewals, dunning, retries).
 */
const NAMED_ACTORS: Record<string, string> = {
  dashboard: "Dashboard",
  system: "System",
  billing_clock: "Billing clock",
};

/**
 * How to render an `actor`. `mono` is true only for opaque identifiers — an api key
 * id is a token you may need to match character-for-character, whereas "System" and a
 * person's email are words and read worse in a monospace face.
 */
export function actorLabel(actor: string | null | undefined): { text: string; mono: boolean } {
  if (!actor) return { text: "—", mono: false };
  const named = NAMED_ACTORS[actor];
  if (named) return { text: named, mono: false };
  return { text: actor, mono: actor.startsWith("key_") };
}

/** `invoice.void` → "Invoice void" (the title when we have no better name). */
export function humaniseAction(action: string): string {
  return action.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** The verb phrase for the prose summary, or a humanised fallback. */
export function actionPhrase(action: string): string {
  return ACTION_PHRASE[action] ?? `performed ${humaniseAction(action).toLowerCase()}`;
}

/** Initialisms that must not read as words ("PO number", not "Po number"). */
const ACRONYMS = new Set(["po", "id", "ip", "url", "cn", "tds", "api"]);

/**
 * `amount_due_minor` → "Amount due (minor units)"; `poNumber` → "PO number".
 *
 * Both cases are real: the ops added in P4 build snake_case diffs, while
 * `invoice.update` spreads the Drizzle patch object and so carries camelCase
 * column keys. Neither should reach the reader raw.
 *
 * Money is left as an integer with the unit named, deliberately: a diff carries no
 * reliable currency (only some actions include one), and rendering `9000` as
 * "$90.00" when the invoice is in JPY would be a lie. See CLAUDE.md — minor units,
 * never a guessed exponent.
 */
export function fieldLabel(field: string): string {
  const isMinor = field.endsWith("_minor") || /Minor$/.test(field);
  const words = field
    .replace(/_minor$/, "")
    .replace(/Minor$/, "")
    // camelCase / PascalCase → separate words, then normalise both spellings.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  const label = words.join(" ").replace(/^[a-z]/, (c) => c.toUpperCase());
  return isMinor ? `${label} (minor units)` : label;
}

/**
 * How the same act appears in the two streams. Used to MERGE the Activity Log:
 * an audit row and its event describe one action, so showing both would double
 * every void.
 *
 * Not every audit action has an event (`invoice.update` is audited-not-evented on
 * purpose — no webhook subscriber can act on a PO-number change) and not every
 * event has an audit row (a scheduled renewal has no actor). Both cases render as
 * a single row; only the pairs collapse.
 */
export const EVENT_TYPE_FOR_ACTION: Record<string, string> = {
  "invoice.void": "invoice_voided",
  "invoice.close": "invoice_closed",
  "invoice.write_off": "invoice_written_off",
  "invoice.stop_dunning": "invoice_dunning_stopped",
  "invoice.pause_dunning": "invoice_dunning_stopped",
  "credit_note.create": "credit_note_created",
  "credit_note.refund": "credit_note_refunded",
  "credit_note.record_refund": "credit_note_refunded",
  "credit_note.void": "credit_note_voided",
  "subscription.cancel": "subscription_canceled",
};

/**
 * Render one diff value for display. Objects/arrays are JSON — an address snapshot
 * genuinely is a structure — but scalars stay scalars so a status transition reads
 * as `posted → voided` and not as two quoted blobs.
 */
export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return value.length === 0 ? "(empty)" : value;
  return JSON.stringify(value, null, 2);
}

export interface DiffField {
  field: string;
  before: unknown;
  after: unknown;
  /** true when only one side carries the field (a set or a clear, not a change). */
  oneSided: boolean;
}

/**
 * The field-by-field diff, in a stable order: `before`'s keys first (so a status
 * transition leads), then fields only `after` has.
 *
 * UNCHANGED FIELDS ARE DROPPED. `writeAuditLog` receives changed-field diffs, but
 * some call sites include a stable field for context (`invoice.record_payment`
 * carries the method); showing "status: paid → paid" would train the reader to
 * skim past the row that matters.
 */
export function diffFields(before: unknown, after: unknown): DiffField[] {
  const b = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === "object" ? after : {}) as Record<string, unknown>;
  const keys = [...Object.keys(b), ...Object.keys(a).filter((k) => !(k in b))];
  const out: DiffField[] = [];
  for (const field of keys) {
    const inB = field in b;
    const inA = field in a;
    if (inB && inA && JSON.stringify(b[field]) === JSON.stringify(a[field])) continue;
    out.push({ field, before: b[field] ?? null, after: a[field] ?? null, oneSided: !inB || !inA });
  }
  return out;
}

// ── 0149: the prose layer ─────────────────────────────────────────────────────
// The audit detail leads with a sentence naming the resource ("Subscription
// activated.") and then lists each field change as its own sentence, choosing the
// verb from the SHAPE of the change:
//
//   trial_end changed from 17-Aug-2026 23:59:59 to 04-Aug-2026 00:00:00
//   status modified from in trial to active
//   current_term_start set as 04-Aug-2026 00:00:00
//   subscription_items modified
//   Increased due_invoices_count from 0 to 1
//
// The value of doing it this way rather than shipping only a table: a reader
// scanning "what happened" reads sentences far faster than they read a grid, and
// the verb itself carries information the grid has to be decoded to yield (a SET is
// not a CHANGE, an increase is not a decrease). The table stays — it is better for
// reconciling numbers — so the page offers both.

/**
 * Fields excluded from the PROSE, never from the diff.
 *
 * `resource_version` and `updated_at` move on every single write, so listing them
 * would put two lines nobody reads at the top of every summary and bury the one
 * that matters. They stay in the table and in the contextual diff, where they are
 * legitimately useful for ordering two changes.
 */
const PROSE_NOISE = new Set(["resource_version", "updated_at", "resourceVersion", "updatedAt"]);

/** A number, or a string holding one — money arrives as a minor-unit string. */
function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** `in_trial` → `in trial`, so a status reads as words rather than as a column. */
function readable(v: unknown): string {
  const s = formatDiffValue(v);
  return typeof v === "string" && /^[a-z0-9]+(_[a-z0-9]+)+$/.test(v) ? v.replace(/_/g, " ") : s;
}

export interface ChangeSentence {
  /** The leading word(s) rendered in mono — the field, or the verb for a delta. */
  field: string;
  /** The rest of the sentence. Values are already humanised. */
  rest: string;
  /** Values to render in mono inside `rest`, in order of appearance. */
  values: string[];
  /** 'increase' | 'decrease' for a numeric move — lets the UI mark direction. */
  direction?: "increase" | "decrease";
}

/**
 * One field change as a sentence, the verb chosen from the shape of the change.
 *
 * Returns null for a field that belongs in the diff but not in the summary (see
 * `PROSE_NOISE`), so callers can `.filter(Boolean)` rather than knowing the rule.
 */
export function changeSentence(f: DiffField): ChangeSentence | null {
  if (PROSE_NOISE.has(f.field)) return null;
  const label = fieldLabel(f.field);
  const isStructure = (v: unknown) => v !== null && typeof v === "object";

  // A structure changed: naming it is all a sentence usefully can do — the shape of
  // the change is what the diff below is for.
  if (isStructure(f.before) || isStructure(f.after)) {
    return { field: label, rest: "modified", values: [] };
  }

  // One-sided: a SET or a CLEAR, not a change. Distinguishing them matters — "set as
  // 04-Aug" and "changed from nothing to 04-Aug" read the same but only one is true
  // of a field that never existed.
  const hadBefore = f.before !== null && f.before !== undefined;
  const hasAfter = f.after !== null && f.after !== undefined;
  if (!hadBefore && hasAfter) {
    return { field: label, rest: "set as {0}", values: [readable(f.after)] };
  }
  if (hadBefore && !hasAfter) {
    return { field: label, rest: "cleared (was {0})", values: [readable(f.before)] };
  }
  if (!hadBefore && !hasAfter) return null;

  // Numeric: the DIRECTION is the headline, so it leads the sentence.
  const nb = asNumber(f.before);
  const na = asNumber(f.after);
  if (nb !== null && na !== null && nb !== na) {
    return {
      field: na > nb ? "Increased" : "Decreased",
      rest: `${label} from {0} to {1}`,
      values: [String(f.before), String(f.after)],
      direction: na > nb ? "increase" : "decrease",
    };
  }

  return {
    field: label,
    rest: "changed from {0} to {1}",
    values: [readable(f.before), readable(f.after)],
  };
}

/**
 * The headline: the resource, then what happened to it.
 *
 * `noun` is rendered as a LINK to the record (the anchor is how you get from the
 * audit entry to the thing it changed), so it is kept separate from the verb
 * rather than baked into one string.
 *
 * Unknown actions fall back to the humanised action and the resource type, never to
 * an invented sentence — an action we forgot to label must read as slightly clumsy,
 * not as something it isn't.
 */
const ACTION_HEADLINE: Record<string, string> = {
  "customer.create": "created.",
  "customer.update": "updated.",
  "customer.archive": "archived.",
  "customer.restore": "restored.",
  "customer.change_billing_date": "billing date changed.",
  "customer.clear_personal_data": "personal data erased (GDPR).",
  "customer.add_payment_method": "payment method added.",
  "customer.remove_payment_method": "payment method removed.",
  "customer.payment_method_role": "payment method role changed.",
  "subscription.create": "created.",
  "subscription.activate": "activated.",
  "subscription.renew": "renewed.",
  "subscription.change": "changed.",
  "subscription.update": "updated.",
  "subscription.cancel": "cancelled.",
  "subscription.pause": "paused.",
  "subscription.resume": "resumed.",
  "subscription.reactivate": "reactivated.",
  "subscription.remove_scheduled_cancellation": "scheduled cancellation removed.",
  "subscription.change_term_end": "term end changed.",
  "subscription.change_trial_end": "trial end changed.",
  "subscription.end_trial": "trial ended.",
  subscription_cancel_scheduled: "cancellation scheduled.",
  "invoice.update": "details edited.",
  "invoice.void": "voided.",
  "invoice.close": "closed.",
  "invoice.collect": "collection attempted.",
  "invoice.write_off": "written off as bad debt.",
  "invoice.record_payment": "offline payment recorded.",
  "invoice.regenerate": "regenerated.",
  "invoice.stop_dunning": "dunning stopped.",
  "invoice.pause_dunning": "dunning paused.",
  "credit_note.create": "issued.",
  "credit_note.refund": "refunded.",
  "credit_note.record_refund": "offline refund recorded.",
  "credit_note.void": "voided.",
  "business.settings_update": "settings updated.",
  "transfer.run": "data transfer run.",
  "mandatory_addon.skipped": "mandatory addon skipped.",
};

/** `customer` → `Customer`; the noun the headline's link wraps. */
export function resourceNoun(resourceType: string | null): string {
  if (!resourceType) return "Record";
  return resourceType.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function actionHeadline(
  action: string,
  resourceType: string | null,
): { noun: string; verb: string } {
  const noun = resourceNoun(resourceType);
  const verb = ACTION_HEADLINE[action];
  if (verb) return { noun, verb };
  // Strip the resource prefix so `coupon.expire` reads "Coupon expire." and not
  // "Coupon coupon expire." — the noun already carries it.
  const tail = action.includes(".") ? action.slice(action.indexOf(".") + 1) : action;
  return { noun, verb: `${tail.replace(/_/g, " ")}.` };
}
