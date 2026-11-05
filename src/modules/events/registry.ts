/**
 * Event registry — the single source of truth for every domain event type the
 * platform can emit (Phase A / plan §A1).
 *
 * `emitEvent`'s `type` parameter is narrowed to `EventType`, so the compiler
 * rejects any event string not listed here — this is deliberate: it forces every
 * new mutation to register its event type rather than inventing an ad-hoc string.
 *
 * The registry also exposes payload helpers so the delivered `data` envelope has
 * a consistent shape across every event: `{ <resource_type>: { …, resource_version } }`.
 */
export const EVENT_TYPES = [
  // customer
  "customer_created",
  "customer_updated",
  "customer_archived",
  "customer_restored",
  "customer_contact_added",
  "customer_contact_updated",
  "customer_contact_removed",
  "customer_shipping_address_added",
  "customer_shipping_address_updated",
  "customer_shipping_address_archived",
  "customer_billing_info_updated",
  "customer_promotional_credits_added",
  "customer_promotional_credits_deducted",
  "customer_excess_payment_recorded",
  "customer_credits_restored",
  // payment_source
  "payment_source_added",
  "payment_source_updated",
  "payment_source_deleted",
  "payment_source_expiring",
  // A lead-day notice before a card's printed expiry (`reminder_config.card_expiring`), one
  // per (card, expiry, lead day). `payment_source_expiring` still fires once, on the status.
  "payment_source_expiry_reminder",
  /**
   * The instrument cannot carry the subscription it is attached to: its registered
   * per-debit mandate ceiling is BELOW the next amount that will be collected.
   *
   * Emitted when a subscription is created, because that is the moment the gap opens and
   * nobody is watching. A mandate is sized once, at VAULT time, and in the ordinary signup
   * order — vault the card, THEN create the subscription — that is the moment least is
   * known, so the ceiling can be the fallback while the renewal it must carry is larger.
   * Nothing re-sizes it afterwards, and a registered ceiling cannot be raised in place:
   * only a fresh authorisation replaces it, which only the BUYER can give. Measured on the
   * dev book 2026-09-04: 33 of 200 INR mandates on customers with a live subscription were
   * already below their own renewal.
   *
   * Sibling of `payment_source_expiring` and deliberately shaped like it — a proactive
   * warning about an instrument that still works today and will stop, where the remedy is
   * the customer's to apply and the business wants to ask before the failure, not after.
   */
  "payment_source_mandate_insufficient",
  "payment_source_expired",
  "payment_source_role_changed",
  // A hard decline that will not fix itself, so the instrument is marked unusable.
  // Distinct from `payment_source_expired`: nothing ran out, it was refused. Added
  // because `setPaymentMethodStatus(…, 'invalid')` changed the row and told nobody —
  // no webhook, and therefore no email, for the one payment-method state the customer
  // actually has to act on.
  "payment_source_invalidated",
  // subscription
  "subscription_created",
  "subscription_started",
  "subscription_activated",
  "subscription_changed",
  "subscription_change_scheduled",
  "subscription_scheduled_change_removed",
  "subscription_renewed",
  "subscription_renewal_skipped",
  "subscription_skip_scheduled",
  "subscription_scheduled_skip_removed",
  "subscription_trial_ending",
  "subscription_cancel_scheduled",
  "subscription_scheduled_cancellation_removed",
  "subscription_canceled",
  "subscription_paused",
  "subscription_pause_scheduled",
  "subscription_resumed",
  "subscription_resumption_scheduled",
  "subscription_reactivated",
  // Soft delete. Distinct from `subscription_canceled`: nothing ended, nothing was
  // credited and no term closed — the subscription simply stopped being visible, and an
  // integrator holding a mirror of it should drop the row rather than mark it churned.
  "subscription_deleted",
  // Time-relative reminders, emitted by runRemindersPass N days ahead of the thing
  // they warn about. They are events rather than a private email-only scan because the
  // events log is what dedupes them (one per subscription per occurrence) and because a
  // merchant integrating over webhooks wants the same warning we email about.
  "subscription_renewal_reminder",
  "subscription_cancellation_reminder",
  // Before a SCHEDULED pause / resume (`reminder_config.pause` / `resume`).
  "subscription_pause_reminder",
  "subscription_resume_reminder",
  // NPCI/RBI: the payer must be told >=24h before every mandate debit, with the
  // amount, date and mandate reference. RazorPay exposes no notification endpoint on
  // the custom recurring API, so the engine sends it (operator ask 2).
  "subscription_pre_debit_notification",
  // invoice
  "invoice_generated",
  "invoice_pending_created",
  "invoice_closed",
  "invoice_updated",
  "invoice_paid",
  "invoice_payment_due",
  // Before the due date of an invoice the customer pays (`reminder_config.payment_due`).
  // Not `invoice_payment_due`, which is the overdue notice.
  "invoice_payment_due_reminder",
  "invoice_not_paid",
  "invoice_voided",
  "invoice_written_off",
  "invoice_deleted",
  "invoice_dunning_started",
  "invoice_dunning_exhausted",
  "invoice_dunning_stopped",
  /**
   * A PARKED invoice's reminder rung. Not a retry and not a failure — nothing was
   * attempted — so it is its own event rather than a second `payment_failed`, which would
   * tell every downstream consumer a charge had just been refused when none was made.
   */
  "invoice_dunning_reminder",
  // credit note
  "credit_note_created",
  "credit_note_allocated",
  "credit_note_refunded",
  "credit_note_refund_reversed",
  "credit_note_voided",
  // payment / transaction
  "payment_initiated",
  "payment_succeeded",
  "payment_failed",
  "refund_created",
  // `refund_created` fires when the provider ACCEPTS a refund; on cards and bank rails that
  // is days before the money lands. `refund_settled` is the confirmation, raised by the
  // provider webhook that says it went through. Two events because they are two facts, and
  // a subscriber that pays out or notifies on the first would be acting on an instruction
  // rather than an outcome.
  "refund_settled",
  "refund_failed",
  // An accepted debit that the RAIL has paused for the buyer's additional-factor
  // authentication (RBI/NPCI, above ₹15,000). Not a failure and not a success: the
  // money moves only if the buyer authenticates, and nothing else in the system will
  // tell them to. See `debitNeedsBuyerAuthentication`.
  "payment_authentication_required",
  "transaction_needs_attention",
  "transaction_reconciled",
  "transaction_late_failure",
  // dispute / chargeback
  "dispute_created",
  "dispute_funds_withdrawn",
  "dispute_funds_reinstated",
  "dispute_won",
  "dispute_lost",
  "dispute_closed",
  // gateway config
  "gateway_account_created",
  "gateway_account_updated",
  "gateway_account_deleted",
  // payment intents (3DS + zero-amount vault setup) and the ATTEMPTS inside them.
  // An intent is a container: `payment_intent_*` is about the container's lifecycle,
  // `payment_attempt_*` about one try against the gateway (the "Attempt N" card).
  "payment_intent_created",
  "payment_intent_authorized",
  "payment_intent_expired",
  "payment_intent_consumed",
  "payment_intent_failed",
  "payment_intent_voided",
  "payment_attempt_created",
  "payment_attempt_failed",
  // wallet (until D merges it into balances)
  "wallet_topped_up",
  // receipt: numbered proof of money received (0387). Emitted when the receipt is numbered.
  "receipt_created",
  // payment request: several open invoices of one customer, paid by one charge or link (0388)
  "payment_request_created",
  "payment_request_paid",
  "payment_request_payment_failed",
  "payment_request_canceled",
  "payment_request_expired",
  // dunning policy: a named per-invoice dunning configuration (0386)
  "dunning_policy_created",
  "dunning_policy_updated",
  "dunning_policy_archived",
  // coupon / catalog
  "coupon_created",
  "coupon_updated",
  "coupon_archived",
  "coupon_applied",
  "coupon_removed",
  "coupon_set_created",
  "coupon_set_codes_added",
  "coupon_code_archived",
  "product_group_created",
  "product_group_updated",
  "product_group_archived",
  "product_created",
  "product_updated",
  "product_archived",
  "price_created",
  "price_updated",
  "price_archived",
  "attached_item_created",
  "attached_item_updated",
  "attached_item_deleted",
  "differential_price_set",
  "differential_price_deleted",
  // entitlements: a feature, a plan's grant, a per-subscription override. `_set` is an
  // upsert that changed the value; `previous_value` is null on the first grant.
  "feature_created",
  "feature_updated",
  "feature_archived",
  "plan_entitlement_set",
  "subscription_entitlement_set",
  // manual discount (couponless % / amount discount applied directly to a subscription)
  "manual_discount_applied",
  "manual_discount_removed",
  // usage
  "usage_recorded",
  // meters and usage events
  "meter_created",
  "meter_updated",
  "meter_archived",
  // Unmatched usage events received in the last hour, one per business per hour.
  "usage_event_unmatched",
  // The AI model price list changed for a key this business uses. One per business per sync.
  "model_prices_changed",
  // credit units and grants (design G3 §7); `credit_grant_applied` is one per invoice
  "credit_unit_created",
  "credit_unit_updated",
  "credit_unit_archived",
  "credit_grant_created",
  "credit_grant_applied",
  "credit_grant_expired",
  "credit_grant_voided",
  "credit_grant_restored",
  // a pending (sold, unpaid) grant became active when its invoice was paid
  "credit_grant_activated",
  // credit holds: written to the outbox only when an endpoint lists them (design G3 C5)
  "credit_hold_created",
  "credit_hold_captured",
  "credit_hold_released",
  "credit_hold_expired",
  // usage controls (design G5 §5): limits, tiers, alerts, automatic top-up, threshold invoices
  "spend_limit_reached",
  "customer_limit_tier_reached",
  "usage_alert_triggered",
  "usage_alert_resolved",
  "credit_auto_topup_scheduled",
  "credit_auto_topup_succeeded",
  "credit_auto_topup_failed",
  "credit_auto_topup_skipped",
  "credit_auto_topup_threshold_low",
  "usage_threshold_reached",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Runtime guard — is this string a registered event type? (used by validation + verify). */
export function isEventType(value: string): value is EventType {
  return EVENT_TYPE_SET.has(value);
}

/**
 * Known resource-type prefixes an event type can start with. Since event types
 * are snake_case (ADR-009) and resource types themselves contain underscores
 * (e.g. `payment_source`, `credit_note`), we can't just split on the first `_` —
 * we match the longest known resource type that prefixes the event type.
 */
const RESOURCE_TYPES = [
  "payment_request",
  "dunning_policy",
  "receipt",
  "payment_source",
  "credit_note",
  "gateway_account",
  "payment_attempt",
  "payment_intent",
  "coupon_set",
  "coupon_code",
  "product_group",
  "attached_item",
  "manual_discount",
  "differential_price",
  "plan_entitlement",
  "subscription_entitlement",
  "feature",
  "subscription",
  "customer",
  "invoice",
  "payment",
  "refund",
  "transaction",
  "wallet",
  "coupon",
  "product",
  "price",
  "usage",
  "usage_event",
  "meter",
  "model_prices",
  "credit_hold",
  "credit_unit",
  "credit_grant",
  "spend_limit",
  "customer_limit_tier",
  "usage_alert",
  "credit_auto_topup",
  "usage_threshold",
].sort((a, b) => b.length - a.length);

/**
 * The resource family an event concerns — derived via longest-prefix match
 * against `RESOURCE_TYPES` (`invoice_paid` → `invoice`, `payment_source_added`
 * → `payment_source`, `customer_contact_added` → `customer`). This is also the
 * key used inside the `data` envelope, so it stays consistent everywhere.
 */
export function resourceTypeOf(type: EventType): string {
  for (const resource of RESOURCE_TYPES) {
    if (type === resource || type.startsWith(`${resource}_`)) return resource;
  }
  return type;
}

/**
 * Build the consistent `data` envelope for an event: the resource object nested
 * under its resource-type key, with `resource_version` folded in when known.
 *   buildEventData('invoice_paid', { id: 'inv_1', total_minor: 8000 }, 42)
 *   → { invoice: { id: 'inv_1', total_minor: 8000, resource_version: 42 } }
 * Extra top-level keys (e.g. `offline`, `amount_minor`) can be merged via `extra`.
 */
export function buildEventData(
  type: EventType,
  resource: Record<string, unknown>,
  resourceVersion?: number | null,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const key = resourceTypeOf(type);
  return {
    [key]: {
      ...resource,
      ...(resourceVersion != null ? { resource_version: resourceVersion } : {}),
    },
    ...(extra ?? {}),
  };
}

/** Sample resource id per resource type — used by test-send fixtures (WH-3). */
const SAMPLE_IDS: Record<string, string> = {
  customer: "cus_sample0000000000000000",
  payment_source: "pm_sample00000000000000000",
  subscription: "sub_sample0000000000000000",
  invoice: "inv_sample0000000000000000",
  dispute: "dsp_sample0000000000000000",
  credit_note: "cn_sample00000000000000000",
  payment: "txn_sample0000000000000000",
  refund: "txn_sample0000000000000000",
  transaction: "txn_sample0000000000000000",
  gateway_account: "gwa_sample0000000000000000",
  payment_intent: "pi_sample000000000000000000",
  payment_attempt: "pia_sample00000000000000000",
  wallet: "cus_sample0000000000000000",
  coupon: "sample-coupon",
  coupon_set: "sample-coupon-set",
  coupon_code: "SAMPLE-CODE",
  product_group: "sample-group",
  product: "sample-product",
  price: "sample-price",
  attached_item: "sample-attached-item",
  differential_price: "dprice_sample000000000000",
  feature: "feat_sample0000000000000000",
  plan_entitlement: "ent_sample00000000000000000",
  subscription_entitlement: "sent_sample0000000000000000",
  manual_discount: "disc_sample0000000000000000",
  usage: "ur_sample00000000000000000",
  credit_hold: "chd_sample0000000000000000",
  usage_event: "sample-event-key",
  meter: "sample-meter",
  model_prices: "01960000-0000-7000-8000-000000000000",
  credit_unit: "sample-unit",
  credit_grant: "cgr_sample0000000000000000",
  receipt: "rcpt_sample000000000000000",
  payment_request: "preq_sample000000000000000",
  dunning_policy: "dpol_sample000000000000000",
  spend_limit: "slim_sample000000000000000",
  customer_limit_tier: "sltr_sample000000000000000",
  usage_alert: "ualt_sample000000000000000",
  credit_auto_topup: "atu_sample0000000000000000",
  usage_threshold: "sub_sample0000000000000000",
};

/** A representative sample id for an event type's resource (test-send fixtures). */
export function sampleResourceId(type: EventType): string {
  return SAMPLE_IDS[resourceTypeOf(type)] ?? "sample";
}

/**
 * A canned sample payload for an event type — used by the webhook test-send op
 * (WH-3) so a merchant can validate their endpoint without waiting for a real
 * event. Carries `test: true` so receivers can distinguish it.
 */
export function sampleEventData(type: EventType): Record<string, unknown> {
  const id = sampleResourceId(type);
  return { ...buildEventData(type, { id }, 1), test: true };
}
