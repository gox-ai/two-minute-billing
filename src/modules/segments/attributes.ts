import { CUSTOMER_FILTER_OPS, CUSTOMER_FILTER_KINDS } from "@/modules/customers/service";
import type { FilterKind } from "@/platform/list-query";

/**
 * The ATTRIBUTE surface a segment may be a predicate over.
 *
 * ⚠️ Vocabulary. "Attribute" is the word for one of these, everywhere. A saved filter
 * over a LIST is a **view** (`list_views`); a saved population is a **segment** (this
 * module); a stored dimension of a report is an **attribute** (`metrics/reports`), and
 * so is a filterable customer field here. Three words, three things — see
 * `db/schema/segments.ts` for why they may not be swapped.
 *
 * There is exactly ONE filtering path over customers, and this is a view onto it, not a
 * second one: the authority is `CUSTOMER_FILTER_OPS`/`CUSTOMER_FILTER_KINDS`, the same
 * maps the customer list route validates a request against and the same ones
 * `list-views/entities.ts` validates a saved view against. Nothing below re-declares an
 * operator or a kind; the registry adds only what a machine cannot infer — a human
 * label, a grouping, and the closed option set for an enum.
 */

/** A segment attribute as the filter builder needs to render it. */
export interface SegmentAttribute {
  /** The field id, which MUST exist in `CUSTOMER_FILTER_OPS`. */
  field: string;
  label: string;
  /** Which fieldset the builder files it under. */
  group: "Lifecycle" | "Revenue" | "Location" | "Billing" | "Tax" | "Identity";
  kind: FilterKind;
  ops: readonly string[];
  /** Closed vocabulary for an enum, so the builder offers values instead of a text box. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** Shown under the control when the attribute has a trap worth stating. */
  hint?: string;
}

/**
 * Attributes that DO NOT EXIST, and the reason, so a refusal is a sentence somebody can
 * act on rather than "invalid filter".
 *
 * Each of these is a question an operator plausibly asks and the stored data cannot
 * answer. Naming them here is the difference between "we thought of this and here is
 * why not" and a dead end — and it is what stops the alternative, which is answering
 * slowly by reconstructing the book per segment on every read.
 */
export const REFUSED_ATTRIBUTES: Record<string, string> = {
  ltv: "we store no lifetime value for each customer. `customer_lifetime_value` is a ratio for the full book (average revenue ÷ churn rate). On a customer row, it would show the same figure for every customer",
  lifetime_value: "we store no lifetime value for each customer. See `ltv`",
  total_paid:
    "we store no paid-to-date total for each customer. We would have to add up every transaction of the customer on every read",
  plan: "a plan is a property of the SUBSCRIPTION, not of the customer. 'Customers on Pro' and 'subscriptions on Pro' are different questions, and one filter cannot mean both. Filter by `subscription_billing_period_unit` for the cycle, or segment the subscriptions list instead",
  usage:
    "usage has no single total: meters count different things. Filter by `last_usage_at` or `days_since_last_usage` instead",
  health_score: "we store no health or engagement score",
  last_login_at: "the engine records no customer sign-in. A portal session is not a sign-in",
};

/**
 * The curated surface the filter builder renders.
 *
 * A SUBSET of the full allow-list on purpose. The API accepts every field
 * `CUSTOMER_FILTER_OPS` knows (including the business's own `cf_*` custom fields), so
 * nothing here caps what a caller can save; this list is what a screen can offer
 * without becoming a wall of forty-five rows, two thirds of which are address parts.
 */
export const SEGMENT_ATTRIBUTES: readonly SegmentAttribute[] = buildAttributes();

function attr(
  field: string,
  label: string,
  group: SegmentAttribute["group"],
  extra: { options?: SegmentAttribute["options"]; hint?: string } = {},
): SegmentAttribute {
  const ops = CUSTOMER_FILTER_OPS[field];
  const kind = CUSTOMER_FILTER_KINDS[field];
  // Load-time, not request-time. A field renamed in the customers module would
  // otherwise become a control that renders, posts, and 400s — the exact shape of
  // "shipped a control that does nothing". Crashing at boot is the cheap ending.
  if (!ops || !kind) {
    throw new Error(
      `Segment attribute '${field}' is not in CUSTOMER_FILTER_OPS. The customer list is the ` +
        `only filtering path over customers; an attribute it does not know cannot be offered.`,
    );
  }
  return { field, label, group, kind, ops, ...extra };
}

function buildAttributes(): SegmentAttribute[] {
  return [
    // ── Lifecycle ────────────────────────────────────────────────────────────
    attr("subscription_status", "Subscription status", "Lifecycle", {
      options: [
        { value: "active", label: "Active" },
        { value: "in_trial", label: "In trial" },
        { value: "cancelled", label: "Cancelled" },
        { value: "paused", label: "Paused" },
        { value: "future", label: "Future" },
      ],
      // ⚠️ `non_renewing` is absent on purpose and it is NOT an oversight. This filter
      // is an EXISTS over the STORED `subscriptions.status`, a column that never holds
      // that value — it is derived at the API boundary. Offering it would return an
      // empty page for a state the list beside it prints on screen. Ask it through
      // `non_renewing_subscription_count` instead, which counts the derived status.
      hint: "Matches a customer who has ANY subscription in that state. For non-renewing subscriptions, use the non-renewing count.",
    }),
    attr("subscription_count", "Subscriptions (any status)", "Lifecycle"),
    attr("active_subscription_count", "Active subscriptions", "Lifecycle"),
    attr("in_trial_subscription_count", "Trialing subscriptions", "Lifecycle"),
    attr("non_renewing_subscription_count", "Non-renewing subscriptions", "Lifecycle"),
    attr("cancelled_subscription_count", "Cancelled subscriptions", "Lifecycle"),
    attr("paused_subscription_count", "Paused subscriptions", "Lifecycle"),
    attr("subscription_cancelled_at", "Subscription cancelled", "Lifecycle", {
      hint: "Matches a customer who cancelled any subscription in the window. It does not mean that the customer left.",
    }),
    attr("created_at", "Signed up", "Lifecycle"),

    // ── Revenue ──────────────────────────────────────────────────────────────
    attr("mrr", "Current MRR", "Revenue", {
      hint: "The sum over active and trialing subscriptions, in minor units. A segment that uses it must resolve to one currency.",
    }),
    attr("currency", "Currency", "Revenue"),
    attr("credit_balance", "Credit balance", "Revenue", {
      hint: "Credit the customer still holds, at face value, in minor units.",
    }),
    attr("credit_runway_days", "Credit runway (days)", "Revenue", {
      hint: "How many days the credit lasts at the average use of the last 7 days. Empty when the customer used no credit in that time.",
    }),
    attr("next_credit_expiry_at", "Next credit expiry", "Revenue"),
    attr("last_credit_purchase_at", "Last credit purchase", "Revenue"),
    attr("order_count", "Orders", "Revenue", {
      hint: "One-time orders: invoices with no subscription and a one-time line that is not a credit pack.",
    }),
    attr("first_order_at", "First order", "Revenue"),
    attr("last_order_at", "Last order", "Revenue"),
    attr("days_since_last_order", "Days since last order", "Revenue", {
      hint: "Empty for a customer who never placed an order.",
    }),
    attr("last_usage_at", "Last usage", "Revenue"),
    attr("days_since_last_usage", "Days since last usage", "Revenue", {
      hint: "Empty for a customer who never sent usage.",
    }),
    attr("payment_method_count", "Payment methods on file", "Revenue", {
      hint: "Saved payment methods, any status. 0 = none on file.",
    }),
    attr("subscription_billing_period_unit", "Billing cycle", "Revenue", {
      options: [
        { value: "day", label: "Daily" },
        { value: "week", label: "Weekly" },
        { value: "month", label: "Monthly" },
        { value: "year", label: "Annually" },
      ],
    }),
    attr("has_unpaid_invoices", "Has unpaid invoices", "Revenue", {
      options: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ],
    }),
    attr("has_used_discount", "Coupon or discount used", "Revenue", {
      options: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ],
      hint: "Any coupon or manual discount that was ever applied to one of their subscriptions. This includes removed and exhausted discounts.",
    }),

    // ── Location ─────────────────────────────────────────────────────────────
    attr("country", "Country", "Location"),
    attr("address_state_code", "State / region", "Location"),
    attr("address_city", "City", "Location"),

    // ── Billing ──────────────────────────────────────────────────────────────
    attr("auto_collection", "Auto-collection", "Billing", {
      options: [
        { value: "on", label: "On" },
        { value: "off", label: "Off" },
      ],
    }),
    attr("net_term_days", "Net terms (days)", "Billing"),
    attr("payment_method_type", "Payment method", "Billing"),
    attr("payment_method_status", "Payment method status", "Billing"),

    // ── Tax ──────────────────────────────────────────────────────────────────
    attr("tax_exempt", "Tax exempt", "Tax", {
      options: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ],
    }),
    attr("vat_number", "VAT number", "Tax"),

    // ── Identity ─────────────────────────────────────────────────────────────
    attr("email", "Email", "Identity"),
    attr("company", "Company", "Identity"),
    attr("locale", "Locale", "Identity"),
  ];
}

/** Attribute ids the builder offers, for a quick membership test. */
export const SEGMENT_ATTRIBUTE_FIELDS = new Set(SEGMENT_ATTRIBUTES.map((a) => a.field));

/**
 * The refusal message for an attribute we do not have.
 *
 * Names the attribute AND says why — a named reason is a next step ("so segment on the
 * subscriptions list instead"), where "unsupported filter" is a dead end. Falls back to
 * listing what does exist, which is the only useful answer to a typo.
 */
export function refusalFor(field: string, known: readonly string[]): string {
  const reason = REFUSED_ATTRIBUTES[field];
  if (reason) return `You cannot segment customers by '${field}': ${reason}.`;
  return (
    `You cannot segment customers by '${field}': it is not a stored customer attribute. ` +
    `Stored attributes are: ${[...known].sort().join(", ")}.`
  );
}
