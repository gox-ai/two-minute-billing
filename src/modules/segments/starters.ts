import type { CustomerSegmentFilter } from "@db/schema";

/**
 * The STARTER LIBRARY: ten populations every business has on day one.
 *
 * An empty segment list teaches nobody what the feature is for, and the first thing an
 * operator does with an empty one is guess at the grammar. These are defined in code
 * rather than seeded as rows so that a business created tomorrow has them, a starter
 * cannot be half-deleted, and improving a definition is a code change rather than a
 * data migration. They are read-only; "Duplicate" copies one into a stored segment the
 * operator then owns and can edit (`starter_key` records where it came from).
 *
 * ── Every filter below resolves against a real stored attribute ──────────────
 * Each one is a triple the customer list route would accept verbatim
 * (`?<field>[<op>]=<value>`). Nothing here is aspirational: a starter whose predicate
 * the engine could not answer would be a saved segment that 400s the first time
 * somebody clicks it, which is worse than not shipping it.
 *
 * ── Two thresholds are numbers, and they are stated, not hidden ──────────────
 * `high_mrr` and `low_mrr` compare MINOR UNITS of the business's DEFAULT currency: every
 * live subscription is converted at the business's stored rate before comparing (see
 * `mrrColumn` in modules/customers), so 25,000 is 250.00 of the default currency for every
 * customer, whatever they are billed in. The screen formats the threshold in that
 * currency. A book holding a currency with no rate refuses them, naming it.
 */
export interface StarterSegment {
  /** Stable key. Also the public id, as `seg_starter_<key>`. */
  key: string;
  name: string;
  description: string;
  filters: CustomerSegmentFilter[];
}

/** A public id that cannot collide with a stored one: `publicId('seg')` is `seg_<nano24>`. */
export const starterPublicId = (key: string) => `seg_starter_${key}`;

export const STARTER_SEGMENTS: readonly StarterSegment[] = [
  {
    key: "active",
    name: "Active customers",
    description: "Holds at least one active subscription.",
    filters: [{ field: "active_subscription_count", op: "gt", value: "0" }],
  },
  {
    key: "trialing",
    name: "Trialing",
    description: "Holds at least one subscription still in its trial.",
    filters: [{ field: "in_trial_subscription_count", op: "gt", value: "0" }],
  },
  {
    key: "delinquent",
    name: "Delinquent",
    description: "Has an invoice that is posted, payment due or not paid.",
    filters: [{ field: "has_unpaid_invoices", op: "is", value: "true" }],
  },
  {
    key: "cancelled",
    name: "Cancelled customers",
    /**
     * Nothing live AND something cancelled — not "has a cancelled subscription", which
     * would sweep in a growing customer who moved plans. This is the population that
     * has actually left.
     */
    description: "Every subscription of theirs has ended.",
    filters: [
      { field: "active_subscription_count", op: "is", value: "0" },
      { field: "in_trial_subscription_count", op: "is", value: "0" },
      { field: "cancelled_subscription_count", op: "gt", value: "0" },
    ],
  },
  {
    key: "annual_plans",
    name: "Annual plans",
    description: "Holds a subscription that bills on a yearly cycle.",
    filters: [{ field: "subscription_billing_period_unit", op: "is", value: "year" }],
  },
  {
    key: "high_mrr",
    name: "High MRR",
    description: "Earning 250 a month or more, in the business's default currency.",
    filters: [{ field: "mrr", op: "gte", value: "25000" }],
  },
  {
    key: "low_mrr",
    name: "Low MRR",
    /** Paying but small. Zero is not "low revenue", it is no revenue — a different list. */
    description: "Paying, but under 50 a month, in the business's default currency.",
    filters: [
      { field: "mrr", op: "gt", value: "0" },
      { field: "mrr", op: "lt", value: "5000" },
    ],
  },
  {
    key: "multi_subscription",
    name: "Multi-subscription",
    description: "Holds more than one active subscription.",
    filters: [{ field: "active_subscription_count", op: "gt", value: "1" }],
  },
  {
    key: "low_credit",
    name: "Low credit balance",
    /** Runway, not an amount: 100 credits is a lot for one customer and nothing for another. */
    description: "Credit runs out within 7 days at the use of the last 7 days.",
    filters: [{ field: "credit_runway_days", op: "lt", value: "7" }],
  },
  {
    key: "credits_expiring",
    name: "Credits expiring soon",
    description: "Holds credit that expires in the next 30 days.",
    filters: [{ field: "next_credit_expiry_at", op: "in_next", value: "30" }],
  },
  {
    key: "usage_stopped",
    name: "Usage stopped",
    /** For a usage business nothing gets cancelled: silence is the churn signal. */
    description: "Sent usage before, but none in the last 30 days.",
    filters: [{ field: "days_since_last_usage", op: "gte", value: "30" }],
  },
  {
    key: "repeat_buyers",
    name: "Repeat buyers",
    description: "Placed two or more one-time orders.",
    filters: [{ field: "order_count", op: "gte", value: "2" }],
  },
  {
    key: "one_time_buyers",
    name: "One-time buyers",
    description: "Placed exactly one one-time order.",
    filters: [{ field: "order_count", op: "is", value: "1" }],
  },
  {
    key: "lapsed_buyers",
    name: "No order in 90 days",
    description: "Placed an order before, but none in the last 90 days.",
    filters: [{ field: "days_since_last_order", op: "gte", value: "90" }],
  },
  {
    key: "recent_signups",
    name: "Recent signups",
    /** Relative, so a saved definition does not rot into a fixed date next quarter. */
    description: "Created in the last 90 days.",
    filters: [{ field: "created_at", op: "in_last", value: "90" }],
  },
  {
    key: "recently_cancelled",
    name: "Recently cancelled",
    description: "Cancelled a subscription in the last 30 days.",
    filters: [{ field: "subscription_cancelled_at", op: "in_last", value: "30" }],
  },
];

export const STARTER_BY_KEY = new Map(STARTER_SEGMENTS.map((s) => [s.key, s]));
export const STARTER_BY_PUBLIC_ID = new Map(
  STARTER_SEGMENTS.map((s) => [starterPublicId(s.key), s]),
);
