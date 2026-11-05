// Typed helpers for the Subscriptions surface. The frozen '@/lib/api' owns the
// core `Subscription`/`SubscriptionItem` types and `getSubscription`/
// `listSubscriptions`; this module adds the lifecycle knowledge the deepened UI
// needs: dues snapshot fields, the derived `non_renewing` status, scheduled-
// cancellation detection, the change-estimate shape, and the plan→attached-
// charge resolution used by trigger_charge.
//
// Backend: src/api/subscription-routes.ts (serializeSubscription adds
// due_invoices_count / total_dues_minor / due_since + cancel_reason_code;
// apiSubscriptionStatus derives `non_renewing`).

import {
  apiGet,
  listAllApplicablePlans,
  listAllDifferentialPrices,
  type Subscription,
  type Price,
  type Product,
  type Applicability,
} from "@/lib/api";

/** Statuses on which lifecycle mutation ops (change, cancel, pause…) are legal. */
export const ACTIVE_LIKE_STATUSES = ["active", "in_trial", "non_renewing"] as const;

export function isActiveLike(status: string): boolean {
  return (ACTIVE_LIKE_STATUSES as readonly string[]).includes(status);
}

/**
 * Detail-only fields the backend serializes that the frozen `Subscription`
 * type does not name. All optional so this stays assignable from a plain
 * `Subscription`.
 */
/**
 * One destination of a term credit, with the credit TYPE that destination implies.
 * `adjustment` cancels a debt on a named invoice; `refundable` is spendable value
 * (`this_invoice` offsets the proration invoice, `balance` is kept); `bucket_restore` goes
 * back to the promotional / excess bucket and is never cashable; `stranded` reaches nobody.
 *
 * ⚠ Do not infer the kind from which amount is non-zero — one change can raise BOTH an
 * adjustment and a refundable note, which is precisely the case an inference mislabels.
 */
export interface CreditDestination {
  kind: "adjustment" | "refundable" | "bucket_restore" | "stranded";
  destination: "open_invoice" | "this_invoice" | "balance" | "payment_method" | "buckets" | "none";
  amount_minor: number;
  /** The printed invoice number an `adjustment` cancelled. */
  invoice?: string;
}

export interface SubscriptionExtras {
  /** Dues snapshot (detail GET only). */
  due_invoices_count?: number;
  total_dues_minor?: number;
  due_since?: string | null;
  cancel_reason_code?: string | null;
  /** Collected on this subscription's invoices, net of refunds (detail GET only). */
  revenue_to_date_minor?: number;
  revenue_paid_invoices_count?: number;
  revenue_since?: string | null;
  /** Upcoming renewals this subscription skips (ISO instants, soonest first). */
  skipped_renewals?: string[];
}

export type SubscriptionDetail = Subscription & SubscriptionExtras;

// ─── Skipped renewals ────────────────────────────────────────────────────────

/** One of the next renewals (up to 12). Empty list when the subscription cannot skip. */
export interface UpcomingRenewal {
  object: "upcoming_renewal";
  renewal_at: string;
  skipped: boolean;
  /** The skip's id while `skipped`. */
  renewal_skip: string | null;
  /** False within 48 hours of the renewal: skips and undos are closed. */
  changeable: boolean;
}

export interface RenewalSkip {
  object: "renewal_skip";
  id: string;
  renewal_at: string;
  status: "scheduled" | "applied" | "cancelled" | "void";
  source: "api" | "dashboard" | "portal";
  invoice: string | null;
  applied_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export const listUpcomingRenewals = (biz: string, sub: string) =>
  apiGet<{ object: "list"; data: UpcomingRenewal[] }>(
    `/v1/businesses/${biz}/subscriptions/${sub}/upcoming_renewals`,
  );

/** Every skip of the subscription, history included. */
export const listRenewalSkips = (biz: string, sub: string) =>
  apiGet<{ object: "list"; data: RenewalSkip[] }>(
    `/v1/businesses/${biz}/subscriptions/${sub}/renewal_skips`,
  );

/** The minimum commitment of the current term: owed, counted so far, and the shortfall. */
export interface SubscriptionCommitment {
  object: "commitment";
  amount_minor: number | null;
  currency: string;
  segments: Array<{ from: string; amount_minor: number }>;
  prorated_minor: number;
  counted_minor: number;
  shortfall_minor: number;
  term: { start: string; end: string } | null;
}
export const getSubscriptionCommitment = (biz: string, sub: string) =>
  apiGet<SubscriptionCommitment>(`/v1/businesses/${biz}/subscriptions/${sub}/commitment`);

/** Retrieve one subscription with items, discount, and the dues snapshot. */
export const getSubscriptionDetail = (biz: string, sub: string) =>
  apiGet<SubscriptionDetail>(`/v1/businesses/${biz}/subscriptions/${sub}`);

// ─── Change estimate (POST …/:sub/estimate — dry run, no writes) ─────────────

export interface SubscriptionChangeLine {
  item: string;
  price?: string;
  quantity?: number;
  unit_price_minor?: number;
}

export interface ChangeEstimate {
  object: "estimate";
  currency: string;
  /** Change estimate only: send both back on `/change` to book exactly these amounts. */
  priced_at?: string;
  quote?: string;
  /** The business's plan-change rules for this edit (change estimate only). */
  change_policy?: {
    direction: "upgrade" | "downgrade" | "same";
    timings: Array<"now" | "end_of_term">;
    default_timing: "now" | "end_of_term";
    blocked: { code: string; message: string } | null;
    /** The proration this estimate used: the request's, else the business rule. */
    prorate: boolean;
    /** Whether the change restarts the term: the request's `reset_term`, else the rule. */
    reset_term?: boolean;
    invoice_immediately: boolean;
    /** Where a credit this change leaves goes: the request's `downgrade_credit`, else the rule. */
    credit_handling?: "credit_balance" | "refund";
    /** What the change does with coupons: the request's `coupons`, else the rule. */
    coupons?: "keep" | "drop" | "keep_if_valid";
    /** The rule for a failed charge on this change (`failed_change_charge`). */
    on_charge_failure?: "start_dunning" | "next_renewal";
    /** The plan-credit rule for this direction; null when no moved plan grants credits. */
    plan_credits?: "full" | "prorated" | "next_window" | null;
    /** The allowance rule; null on a downgrade or when no meter allowance changes. */
    allowances?: "new_window" | "keep_used" | "prorated" | null;
  };
  lines: Array<{ description: string; amount_minor: number }>;
  subtotal_minor: number;
  /** Every discount off the subtotal — coupons/manual PLUS `promotional_discount_minor`. */
  discount_minor: number;
  tax_minor: number;
  /** `tax_minor` split into the rows the INVOICE will print — `CGST (9.00%)` + `SGST (9.00%)`,
   *  or `IGST (18.00%)`, or one plain row. Sums exactly to `tax_minor`. Render these instead
   *  of a single hardcoded "Tax" line: on an Indian invoice one row is not what the document
   *  says, and the buyer is later sent the split with nothing connecting it to the quote. */
  tax_lines?: Array<{ label: string; amount_minor: number }>;
  /**
   * THE MONEY THAT ACTUALLY MOVES — the proration invoice LESS the credit note it absorbs:
   * `(chargeBase − promo + chargeTax) − (creditBase + creditTax)`.
   *
   * ⚠ `subtotal_minor + tax_minor` does NOT equal this on a change that credits anything,
   * and must not be used to derive it. A change raises TWO documents; `tax_minor` describes
   * only the invoice, so the credit note's own tax is missing from that sum. Netting them
   * by hand is exactly the bug this field was fixed for (2026-08-30): a qty 60 → 59 downgrade
   * previewed as "₹7,234.24 chargeable immediately" when ₹887.36 was owed BACK.
   *
   * Negative means the customer is credited, not charged.
   */
  total_minor: number;
  /** true → `total_minor` > 0, charged now; false → nothing to collect (a credit, or zero). */
  immediate_charge: boolean;
  /**
   * Simulated customer-balance application — read-only preview.
   * POST-tax buckets ONLY (refundable + excess): the promotional bucket is applied
   * pre-tax and reported as `promotional_discount_minor`, already inside `total_minor`,
   * so counting it here too would subtract it twice.
   */
  credits_applied_minor?: number;
  /** The promotional draw seen from the balance side — same money as
   *  `promotional_discount_minor`, which is how the document states it. */
  promotional_credits_applied_minor?: number;
  /** The promotional slice as a PRE-TAX discount: inside `discount_minor`, already
   *  subtracted from `total_minor`. Render it ABOVE the tax row. */
  promotional_discount_minor?: number;
  refundable_credits_applied_minor?: number;
  excess_payments_applied_minor?: number;
  /** total_minor − credits_applied_minor, floored at 0 — what would actually be collected. */
  amount_due_minor?: number;
  /** Face value of the credit note this change issues — the unused time AND the tax
   *  originally charged on it, so it is larger than the credit lines' pre-tax sum. */
  credit_note_total_minor?: number;
  /** The slice of that note the proration invoice cannot absorb, which lands back on the
   *  customer's balance as refundable credit — "will be added back to the customer's
   *  account". Non-zero only on a downgrade. */
  refundable_credit_added_minor?: number;
  /** The part of that credit refunded to the card or bank payments (`downgrade_credit: refund`). */
  refunded_to_payment_method_minor?: number;
  /**
   * The slice of `credit_note_total_minor` spent cancelling what the customer STILL OWES on
   * the term's own invoices, before any of it can reach their balance. The debt is relieved,
   * not refunded — so the customer received this money, just not as spendable credit.
   *
   * ⚠ DO NOT compute the invoice's credit as `credit_note_total_minor − this`. It is right
   * only where every other leg is zero — true of the unpaid-term shape this was debugged
   * against (₹88,664.44 − ₹22,098.13 = ₹66,566.31), false as soon as a downgrade overflows to
   * the balance, a bucket-funded invoice returns slices, or either router strands a residue.
   * Two of those legs were not reported at all until `credit_stranded_minor` below, so the
   * subtraction could not be made correct client-side even in principle. Use
   * `credit_applied_to_this_invoice_minor`.
   *
   * Absent when the term is fully paid, which is every shape that existed before then, so
   * every pre-existing screen renders identically.
   *
   * ⚠ NO CONSUMER as of 2026-08-31 (f343eabc). The rail and confirm dialog read it for the
   * `Cleared unpaid invoices` add-back row; both ladders are now NET and the slice is narrated
   * from `credit_destinations[]`, which carries its KIND and the printed invoice number. Still
   * emitted and still asserted — it is public estimate contract and a real number — but render
   * from `credit_destinations` and read `dashboard/lib/credit-legs.ts` first.
   */
  credit_applied_to_open_invoices_minor?: number;
  /**
   * The slice of the note that offsets THIS invoice — `invoice_estimate.credits_applied`,
   * and the row the ladder subtracts:
   * `Invoice total → Credit applied → Total due now (amount_due_minor)`.
   *
   * The GROSS note sits outside the ladder, in the sentence beneath it: `amount_due` is
   * already net of `credits_applied`, with the gross kept separate in
   * `credit_note_estimates[]`.
   *
   * Distinct from `credits_applied_minor` — that is PRE-EXISTING balance and keeps its own row.
   */
  credit_applied_to_this_invoice_minor?: number;
  /** The invoice's OWN total — the ladder's top figure. ⚠ Not `subtotal_minor + tax_minor`:
   *  that subtotal is net of the credit lines and goes negative on a downgrade. */
  invoice_total_minor?: number;
  /** The invoice's PRE-TAX subtotal — the row above tax in a pure charges table. ⚠ Not
   *  `invoice_total_minor − tax_minor`: equal only while `promotional_discount_minor` is 0. */
  invoice_subtotal_minor?: number;
  /** Where every slice of the note went, typed, for the prose Credits section. Sums to
   *  `credit_note_total_minor`. */
  credit_destinations?: CreditDestination[];
  /** The unused window the credit is FOR, ISO instants. */
  credited_period_start?: string;
  credited_period_end?: string;
  /** Returned to the promotional / excess buckets: real value to the customer, but a bucket
   *  balance that cannot offset this invoice. */
  credit_returned_to_buckets_minor?: number;
  /** The slice that reaches nobody (routing `stranded` + distribution `unplaced`). Carried so
   *  the note accounts for 100% of the gross rather than leaving an unnamed remainder. */
  credit_stranded_minor?: number;
  /**
   * The next renewal invoice AS IT WILL LOOK AFTER this change — tax in, coupons applied,
   * and net of the credit this change hands forward. Drives the "Next invoice of … will be
   * raised on …" sentence and the "Renewal Charges" table behind it.
   *
   * ⚠ Use `next_renewal.amount_due_minor` for that sentence. Do NOT re-derive it by summing
   * `unit_price × quantity` over the form's rows: that is pre-tax and pre-coupon, and on an
   * 18%-GST subscription it understated the renewal by the entire tax amount (₹76,892 shown
   * where the true figure was ₹89,845.20). Null when there is no next term to bill.
   */
  next_renewal?: {
    date: string | null;
    lines: Array<{ description: string; amount_minor: number }>;
    subtotal_minor: number;
    discount_minor: number;
    tax_minor: number;
    tax_lines?: Array<{ label: string; amount_minor: number }>;
    /** `subtotal − discount + tax`. The identity DOES hold here — one document, no credit note. */
    total_minor: number;
    credits_applied_minor: number;
    amount_due_minor: number;
  } | null;
  /** true when this change resets the billing term (explicit or frequency-change auto-trigger). */
  term_reset?: boolean;
  /** New term end when term_reset is true; null if not applicable. */
  new_period_end?: string | null;
  /**
   * Set (to the ISO trial end) when the subscription is IN TRIAL: nothing is charged
   * now, and this estimate describes the invoice the trial-end conversion will raise.
   * `amount_due_minor` and the credit fields are 0; `total_minor` is the full
   * post-change composition billed at trial end. Null/absent otherwise.
   */
  due_at_trial_end?: string | null;
  /**
   * Reactivation only: set when the subscription continues its current term (a dunning
   * cancellation inside its term, same items). No invoice is raised; `amount_due_minor` is
   * what collecting the term's open invoice takes now (0 unless `collects_now`).
   */
  in_term_reactivation?: {
    current_period_end: string;
    invoice: { id: string; number: string | null; status: string; outstanding_minor: number };
    collects_now: boolean;
  } | null;
  /** Reactivation only: whether `term: continue` is possible for these items. */
  in_term_available?: boolean;
  /**
   * Present when this charge would be REFUSED by the buyer's mandate before it ever
   * reaches the gateway. Absent means no known obstacle, never "checked and fine" —
   * a customer with no mandate rail has no ceiling to exceed.
   */
  mandate_shortfall?: {
    ceiling_minor: number;
    amount_minor: number;
    currency: string;
    rail: string | null;
    /** What a fresh authorisation would register once this change is live. */
    reauthorized_ceiling_minor: number;
    /** True when re-authorising on THIS rail buys headroom AND an OTP per debit. */
    needs_authentication_even_if_raised: boolean;
  };
  /**
   * Invoices this edit will CREDIT that still have a debit live at the gateway. Crediting
   * does not cancel it, and on a card mandate nothing can — so it may still settle for a
   * debt the credit note has already cleared. The money is handled (booked, detached,
   * auto-refunded, alerted); this exists so the operator can spare the customer the detour
   * by having them release it from the portal first. Absent when there are none.
   */
  /**
   * `kind` distinguishes a debit WE dispatched to the rail from a checkout the BUYER
   * opened (portal "Pay now"). It decides which remedy the warning may offer: an
   * intent has no payments or transactions row, so the portal's release control cannot
   * see it — measured 2026-09-03 on INV-7824.
   */
  debits_in_flight?: { invoice: string; awaiting_buyer: boolean; kind: "payment" | "intent" }[];
}

// ─── Cancel estimate (POST …/:sub/cancel_estimate — dry run, no writes) ──────

/**
 * What a cancellation would cost, mirroring `CancelEstimate` in
 * src/modules/subscriptions/estimate.ts. Every amount is minor units in `currency`.
 *
 * The three `net_*` figures are what the dialog leads with. Note the deliberate
 * overlap: a refundable cancellation credit under `schedule_refund` is counted in
 * BOTH `net_credit_minor` (it is granted) and `net_refund_minor` (it then leaves as
 * cash), and `refundable_credits.includes_cancellation_credit_minor` is the amount
 * doing double duty — so the UI can explain it rather than appearing to double-count.
 */
export interface CancelEstimate {
  object: "cancel_estimate";
  currency: string;
  options: {
    cancel_option: "immediately" | "end_of_term" | "specific_date";
    cancel_at: string | null;
    credit_option: "none" | "prorate" | "full";
    unbilled_charges_option: "invoice" | "delete" | null;
    account_receivables_handling: "no_action" | "schedule_payment_collection" | "write_off";
    refundable_credits_handling: "no_action" | "schedule_refund";
  };
  effective_at: string;
  /** False when nothing moves today because the cancellation is deferred. */
  immediate: boolean;
  unbilled_charges: {
    /** `none` = no option set, so the charges are left stranded (also in `warnings`). */
    action: "invoice" | "delete" | "none";
    count: number;
    lines: Array<{ description: string; amount_minor: number }>;
    subtotal_minor: number;
    tax_minor: number;
    /** NET of `promotional_discount_minor`, as the invoice document reports it. */
    total_minor: number;
    /** POST-tax buckets only (refundable + excess). */
    credits_applied_minor: number;
    /** The pre-tax promotional slice, already subtracted from `total_minor`. */
    promotional_discount_minor: number;
    amount_due_minor: number;
    /** `delete` only: the amount thrown away, never billed. */
    discarded_minor: number;
  };
  cancellation_credit: {
    credit_option: "none" | "prorate" | "full";
    /** `adjustment` reduces the open term invoice; `split` returns bucket slices and mints a refundable CN. */
    delivery: "adjustment" | "split" | "none";
    invoice: string | null;
    /** The same invoice by DOCUMENT number (`INV-7835`); null until it is numbered. */
    invoice_number: string | null;
    base_minor: number;
    credit_minor: number;
    adjustment_minor: number;
    promotional_restore_minor: number;
    excess_restore_minor: number;
    refundable_credit_note_minor: number;
    /** What the customer actually receives, after caps and the idempotency check. */
    delivered_minor: number;
    /** A prior cancellation already credited this term — this one grants nothing further. */
    already_credited: boolean;
  };
  open_invoices: {
    handling: "no_action" | "schedule_payment_collection" | "write_off" | "void";
    /** `projected` marks the invoice the `invoice` unbilled option would create. */
    invoices: Array<{
      invoice: string | null;
      amount_due_minor: number;
      projected?: boolean;
      /** `void` only: why this invoice would be left open instead (money already on it). */
      void_blocked?: string;
    }>;
    total_due_minor: number;
    write_off_minor: number;
    /**
     * `void` only. Separate from `write_off_minor` because the two mean opposite things
     * about whether the revenue was ever owed — a write-off records a loss, a void
     * withdraws the document. Never add them together.
     */
    void_minor: number;
    collect_minor: number;
    /** Set when the largest single collection attempt exceeds the per-debit mandate ceiling. */
    mandate_shortfall?: {
      ceiling_minor: number;
      amount_minor: number;
      currency: string;
      rail: string | null;
      reauthorized_ceiling_minor: number;
      needs_authentication_even_if_raised: boolean;
    };
  };
  refundable_credits: {
    handling: "no_action" | "schedule_refund";
    credit_notes: Array<{ credit_note: string; available_minor: number }>;
    refund_minor: number;
    includes_cancellation_credit_minor: number;
  };
  net_collect_minor: number;
  net_refund_minor: number;
  net_credit_minor: number;
  /** Things that will NOT happen the way the option set implies. Empty = no discrepancy. */
  warnings: string[];
  /**
   * Invoices this cancellation is about to RELIEVE — its term credit, or an AR write-off
   * — that still have a debit live at the gateway. Absent when there are none.
   *
   * The same shape the CHANGE estimate carries (`Estimate.debits_in_flight`), because it
   * is the same race on the other lifecycle action: clearing the debt does not cancel the
   * debit, so the money can still arrive for a debt that no longer exists. `kind` decides
   * which remedy the warning may offer — a checkout the BUYER opened has no payments or
   * transactions row, so the portal's release control cannot see it (measured 2026-09-03
   * on INV-7826, where a ₹22,184.00 checkout was live through the whole cancellation).
   *
   * `schedule_payment_collection` is deliberately NOT covered — see the engine field.
   */
  debits_in_flight?: { invoice: string; awaiting_buyer: boolean; kind: "payment" | "intent" }[];
}

// ─── Plan ↔ addon applicability (CP-6 / CAT-4) ───────────────────────────────

export interface PlanAddonRule {
  plan: string; // plan PRODUCT id
  addon: string; // addon/charge PRODUCT id
  level: Applicability;
}

/**
 * Build the flat plan→addon applicability rule list the line builders consume.
 * Covers `addon` and `charge` products by default (mandatory charges must be
 * auto-included too). One request for the whole catalog.
 */
export async function listPlanAddonRules(
  biz: string,
  products: Product[],
  kinds: ReadonlyArray<"addon" | "charge"> = ["addon", "charge"],
): Promise<PlanAddonRule[]> {
  const rules: PlanAddonRule[] = [];
  const attachable = new Set(
    products
      .filter((p) => kinds.includes(p.kind as "addon") && p.active !== false)
      .map((p) => p.id),
  );
  const planIds = products.filter((p) => p.kind === "plan").map((p) => p.id);
  const all = await listAllApplicablePlans(biz).catch(() => null);
  for (const res of all?.data ?? []) {
    if (!attachable.has(res.item)) continue;
    if (res.applies_to_all) {
      for (const plan of planIds) rules.push({ plan, addon: res.item, level: "optional" });
    } else {
      for (const plan of res.plans)
        rules.push({ plan, addon: res.item, level: res.applicability[plan] ?? "optional" });
    }
  }
  return rules;
}

// ─── Plan-specific differential add-on pricing (CAT-7) ───────────────────────

// The pure lookup helper + its type live in `@/lib/differential` (client-safe);
// re-exported here so existing call sites keep working.
export { differentialAmount, type DifferentialRule } from "@/lib/differential";
import type { DifferentialRule } from "@/lib/differential";

/**
 * Build the flat differential-price rule list the line builders consume. The
 * backend already applies these when it charges/estimates; the list is only
 * used to render the correct per-line Amount preview. One request for the catalog.
 */
export async function listDifferentialRules(
  biz: string,
  products: Product[],
): Promise<DifferentialRule[]> {
  const addons = new Set(
    products.filter((p) => p.kind === "addon" && p.active !== false).map((p) => p.id),
  );
  const all = await listAllDifferentialPrices(biz).catch(() => null);
  return (all?.data ?? [])
    .filter((r) => addons.has(r.addon))
    .map((r) => ({
      addon: r.addon,
      plan: r.plan,
      currency: r.currency,
      interval: r.interval,
      amount_minor: r.amountMinor ?? null,
    }));
}

/** A charge-kind product attached to the subscription's plan (trigger_charge target). */
export interface AttachedCharge {
  product: Product;
  /** Best price row for display (plan-currency match preferred). */
  price: Price | null;
  applicability: Applicability;
}

/**
 * Resolve the charge-kind products attached to a plan product — the candidates
 * for POST …/:sub/trigger_charge. NOTE (backend gap): the applicable_plans GET
 * does not expose the CAT-4 `charge_on_event` config, so the UI cannot narrow
 * to on_demand items; the API rejects non-on-demand triggers with a 400 that we
 * surface as-is.
 */
export function attachedChargesForPlan(
  planProductId: string,
  rules: PlanAddonRule[],
  products: Product[],
  prices: Price[],
  planCurrency?: string,
): AttachedCharge[] {
  const productById = new Map(products.map((p) => [p.id, p]));
  const out: AttachedCharge[] = [];
  for (const r of rules) {
    if (r.plan !== planProductId) continue;
    const product = productById.get(r.addon);
    if (!product || product.kind !== "charge") continue;
    const candidates = prices.filter((p) => p.product === product.id && p.active !== false);
    const price = candidates.find((p) => p.currency === planCurrency) ?? candidates[0] ?? null;
    out.push({ product, price, applicability: r.level });
  }
  return out;
}
