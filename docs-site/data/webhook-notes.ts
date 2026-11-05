/**
 * Customer-facing prose for the webhook reference. HAND-WRITTEN — the generator
 * (`scripts/gen-webhook-reference.ts`) supplies the facts and merges these in.
 *
 * Deliberately separate from the registry's own comments. Those are written for whoever
 * maintains the engine and cite internal functions, internal decisions and measurements
 * taken on a particular day; they survive into the generated file as `internal_note` so a
 * writer can see what the engineer knew, and nothing publishes them.
 *
 * Every family needs a summary — `pnpm gen:webhook-reference` fails without one, so a new
 * family cannot reach the published page unnamed. Individual events take one only where
 * the name genuinely does not carry the meaning; a summary that restates the event type is
 * noise, and most of these names say what they are.
 */

/** One or two sentences per resource family, keyed by the family in the generated file. */
export const FAMILY_SUMMARIES: Record<string, string> = {
  customer:
    "The payer's own record: created, changed, archived, and every movement of the promotional or excess credit held against their name.",
  payment_source:
    "A stored instrument belonging to a customer. These are the events that warn you an instrument will stop working before it does — expiry, an insufficient mandate, an outright refusal.",
  subscription:
    "The life of one subscription, from creation through each renewal to cancellation, including changes scheduled ahead of time and the reminders sent before they take effect.",
  invoice:
    "An invoice's progress from generated to paid, written off or voided, together with the dunning sequence that chases an unpaid one.",
  credit_note:
    "Credit issued against an invoice, and what became of it — applied to a balance, refunded to the payer, or voided.",
  payment:
    "An attempt to collect money and how it ended. `payment_authentication_required` is the one outcome that is neither success nor failure.",
  refund:
    "Money on its way back to the payer, reported twice: once when accepted, once when settled.",
  transaction:
    "A recorded movement of money that needs your attention, has been reconciled, or failed after it appeared to succeed.",
  dispute:
    "A chargeback opened by the payer's bank or card network, the money moving out and possibly back, and the case closing.",
  gateway_account:
    "A payment gateway connection on one of your businesses being added, changed or removed.",
  payment_intent:
    "A container for attempts at the gateway — either authorising a charge to capture later, or a zero-amount authorisation whose product is a stored instrument.",
  payment_attempt:
    "One individual try against the gateway inside an intent. A buyer who fails authentication twice before succeeding leaves three attempts, and none overwrite the earlier ones.",
  wallet: "Prepaid credit added to a customer's wallet.",
  receipt:
    "A numbered record of money received: one per payment, or one per payment on a payment request. Sent when the receipt gets its number, which is within seconds of the payment.",
  payment_request:
    "A request for several open invoices of one customer, paid by one charge or one link. Each invoice still gets its own payment and its own `payment_succeeded`, which names the request.",
  dunning_policy:
    "A named set of dunning settings that you assign to customers. A customer with no policy uses the business dunning settings.",
  coupon:
    "A discount in your catalogue being created or changed, and applied to or removed from a subscription.",
  coupon_set: "A batch of single-use codes for one coupon.",
  coupon_code: "An individual code within a set.",
  product_group: "A grouping of products in your catalogue.",
  product: "A product in your catalogue.",
  price:
    "A price on a product — the amount, currency and billing period a subscription is sold at.",
  attached_item:
    "An add-on or charge attached to a product so it is carried onto subscriptions of that product.",
  differential_price: "A price override that applies to one specific product-and-plan combination.",
  feature:
    "A capability in your catalogue that a plan can grant, such as single sign-on or a project limit. Use these events to refresh any entitlements your app caches.",
  plan_entitlement:
    "What a product grants for one feature. A change here alters the entitlements of every subscription on that product.",
  subscription_entitlement: "A per-subscription override of what its plan grants for one feature.",
  manual_discount:
    "A percentage or fixed-amount discount applied directly to a subscription without a coupon in the catalogue.",
  usage: "Metered usage recorded against a subscription, which later prices an invoice line.",
  meter: "A meter: what to count from your usage events, and how to add the values up.",
  usage_event:
    "Usage events you sent. We do not send one webhook for each event; this family reports on them in summary.",
  model_prices: "The AI model price list. Sent when a list price that your meters use changes.",
  credit_unit: "A unit of credit that you define, such as one credit worth USD 0.01.",
  credit_grant:
    "Credit that a customer holds, in money or in your credit unit. Invoices use it in a fixed order, and it can expire.",
  credit_hold:
    "An amount of credit that your app reserved before a call. We send these events only to an endpoint that lists them by name.",
  spend_limit:
    "A spend limit on a customer, a subscription or a usage property. Sent once per limit, subject and interval when spend reaches the limit.",
  customer_limit_tier:
    "A limit tier that a customer reached when its total paid amount grew. A tier never goes down after a refund.",
  usage_alert:
    "An alert on usage, spend, credit balance or credit runway. Each threshold triggers at most once per period and resolves once.",
  credit_auto_topup: "Automatic top-up: credit bought when the balance is low or on a schedule.",
  usage_threshold:
    "Usage invoiced during the period because the unbilled usage reached the amount that you set.",
};

/**
 * Only where the event type's name does not carry the meaning. Keyed by event type.
 */
export const EVENT_SUMMARIES: Record<string, string> = {
  model_prices_changed:
    "Sent once per price sync to each business whose meters used a changed model in the last 35 days. Each change gives the old and new price, the time the new price starts, and two flags: `bill_moves` (a live subscription bills that model from the list) and `cost_moves` (you have no cost of your own for it). Usage before the start time keeps the old price.",
  spend_limit_reached:
    "Carries the limit, the subject, the interval, the amount spent and when the interval resets. `mode` is `hard` (new requests are refused) or `soft` (notice only).",
  usage_alert_resolved:
    "The value moved back across a threshold, or the period ended (`reason: period_ended`). Each trigger has exactly one resolve.",
  credit_grant_applied:
    "Sent once for each invoice that used credit grants. It lists each grant and the amount that the invoice used.",
  credit_grant_restored:
    "A voided invoice gave its credit back. When the grant had expired, the credit comes back as a new grant that expires in 12 months.",
  usage_event_unmatched:
    "Sent at most once an hour when events arrived with a customer key that no customer has. Add the key to a customer and the events bill.",
  payment_source_expiring:
    "Sent ahead of the expiry date, while the instrument still works, so you can ask the customer to replace it before a renewal fails.",
  payment_source_expiry_reminder:
    "Sent on each lead day before a card expires, when the business sets lead days for card expiry (`reminder_config.card_expiring`). Carries `expires_at` and `lead_days`. Emitted once per card, expiry date and lead day. `payment_source_expiring` still fires once, when the card enters its expiry month.",
  payment_source_mandate_insufficient:
    "The instrument's authorised per-debit ceiling is below the next amount due on a subscription it is attached to. The ceiling is fixed when the instrument is authorised and cannot be raised in place — only a fresh authorisation from the customer replaces it, so this is a prompt to ask for one.",
  payment_source_invalidated:
    "The instrument was refused in a way that will not resolve on its own and has been marked unusable. Distinct from expiry: nothing ran out, it was declined.",
  subscription_trial_ending:
    "Sent on each of the business's lead days before a trial ends, with `lead_days` on the event.",
  subscription_renewal_reminder:
    "Sent on each of the business's lead days before a renewal (`reminder_config`), with `lead_days` on the event. Emitted once per subscription, renewal date and lead day, so it is safe to act on directly.",
  subscription_cancellation_reminder:
    "Sent on each of the business's lead days before a scheduled cancellation takes effect, with `lead_days` on the event.",
  subscription_pause_reminder:
    "Sent on each of the business's lead days before a scheduled pause (`reminder_config.pause`), with `pause_at`, `lead_days` and `scheduled_change` on the event. Off by default.",
  subscription_resume_reminder:
    "Sent on each of the business's lead days before a scheduled resume (`reminder_config.resume`), with `resume_at`, `lead_days` and `scheduled_change` on the event. Off by default.",
  invoice_payment_due_reminder:
    "Sent on each of the business's lead days before the due date of an open invoice that is not collected automatically (`reminder_config.payment_due`), with `due_at` and `lead_days` on the event. Off by default.",
  subscription_pre_debit_notification:
    "Advance notice of a mandate debit, carrying the amount, the date and the mandate reference. Required before every debit on some rails, and sent by the platform because the gateway does not send it.",
  refund_created:
    "The provider has ACCEPTED the refund. On cards and bank rails the money lands days later, so treat this as an instruction in flight rather than an outcome.",
  refund_settled:
    "The refund actually went through, confirmed by the provider. This is the one to pay out or notify on.",
  payment_authentication_required:
    "The debit was accepted but the rail has paused it pending the buyer's additional authentication. Neither a success nor a failure: the money moves only if the buyer authenticates, and nothing else will prompt them.",
  invoice_dunning_exhausted:
    "The retry sequence for an unpaid invoice has run out of attempts. No further collection will be tried automatically.",
  feature_archived:
    "The feature no longer grants anything: it leaves every subscription's entitlements and its checks answer `feature_archived`. Grants are kept, and reactivating the feature sends `feature_updated` with `active: true`.",
  plan_entitlement_set:
    "Sent when a grant is created or its value changes. The payload carries `value` and `previous_value`, which is null for a new grant.",
  subscription_entitlement_set:
    "Sent when an override is created or its value changes. The payload carries `value` and `previous_value`, which is null for a new override.",
  receipt_created:
    "Carries the receipt number, the amount received and what it was applied to. A receipt never changes after this event.",
  payment_request_payment_failed:
    "The charge for the request failed or was reversed. The request is open again and the customer was sent the link.",
  payment_request_paid:
    "Every invoice in the request is settled. Sent once, after the child `payment_succeeded` events.",
  transaction_late_failure:
    "A transaction that had been reported as successful was later reversed by the provider.",
};
