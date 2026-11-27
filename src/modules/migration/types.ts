import type { IssueSnapshot } from "@/modules/invoicing/import";
export type { IssueSnapshot };
/**
 * A migration SOURCE provides normalized data from an external billing system
 * (a billing platform's API, a JSON export, …). The import logic is
 * source-agnostic; each source maps its API shapes into these.
 *
 * Money is integer MINOR units (JS number — safe for realistic amounts).
 * Optional list methods = capabilities: a source that can't provide a resource
 * simply omits the method and the importer skips that resource.
 */

/**
 * The source's OWN row timestamps, carried verbatim onto the imported row.
 *
 * Without these every imported record reads as created the moment the import
 * ran: a five-year-old customer shows up as new, catalog items all share one
 * timestamp, and "sort by created" is meaningless right after a migration. The
 * importer writes them straight into `created_at` / `updated_at`. The CP-0
 * `bump_row_version` trigger yields to an explicitly-set `updated_at` (migration
 * 0144) precisely so an import can state a row's real last-change time.
 *
 * Both are optional — a source that can't report them leaves the row at its
 * import time, which is the honest fallback.
 */
export interface SourceTimestamps {
  createdAt?: Date;
  updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// Catalog

export interface SourceProductGroup extends SourceTimestamps {
  sourceId: string;
  name: string;
  description?: string;
}

export type SourceProductKind = "plan" | "addon" | "charge";

export interface SourceProduct extends SourceTimestamps {
  sourceId: string;
  groupSourceId?: string;
  kind: SourceProductKind;
  name: string;
  externalName?: string;
  description?: string;
  /** Unit of measure, e.g. "seat". */
  unit?: string;
  metered?: boolean;
  /** false → import archived (active=false). */
  active?: boolean;
  metadata?: Record<string, unknown>;
}

export type SourcePriceModel = "flat" | "per_unit" | "tiered" | "volume" | "stairstep";

export interface SourcePriceTier {
  /** Upper quantity bound of this tier (null = infinity). */
  upTo: number | null;
  /** Per-unit amount for tiered/volume tiers. */
  unitAmountMinor?: number;
  /** Flat amount for stairstep bands. */
  flatAmountMinor?: number;
}

export interface SourcePrice extends SourceTimestamps {
  sourceId: string;
  productSourceId: string;
  model: SourcePriceModel;
  /** flat/per_unit amount; undefined for tiered models. */
  amountMinor?: number;
  currency: string;
  /** undefined → one-time price (charges). */
  interval?: "day" | "week" | "month" | "year";
  intervalCount?: number;
  tiers?: SourcePriceTier[];
  trialPeriod?: number;
  trialPeriodUnit?: "day" | "week" | "month" | "year";
  freeQuantity?: number;
  /** Fixed number of billing cycles (null/undefined = forever). */
  billingCycles?: number;
  name?: string;
  externalName?: string;
  description?: string;
  active?: boolean;
  metadata?: Record<string, unknown>;
  /** The source's price type, when it has one. Absent → exclusive. */
  taxBehavior?: "inclusive" | "exclusive";
}

export interface SourceAttachedAddon {
  planProductSourceId: string;
  addonProductSourceId: string;
  applicability: "mandatory" | "recommended" | "optional";
  /** Source attached_item.quantity → our attached_items.default_quantity. */
  defaultQuantity?: number;
  /** Source attached_item.billing_cycles (null = no cap). */
  billingCycles?: number | null;
  /**
   * When the attachment charges, already normalized to OUR vocabulary by the
   * source adapter (the source's enum is wider — e.g. contract_termination has no
   * equivalent here and is dropped rather than silently mapped to something else).
   */
  chargeOnEvent?: "subscription_creation" | "trial_start" | "activation" | "on_demand";
  /** Source attached_item.charge_once. */
  chargeOnce?: boolean;
}

export interface SourceDifferentialPrice {
  /** The addon PRICE this differential applies to (source: item_price_id). */
  addonPriceSourceId: string;
  /** The plan PRODUCT under which the addon gets this amount (source: parent_item_id). */
  planProductSourceId: string;
  amountMinor: number;
  currency: string;
  interval?: "day" | "week" | "month" | "year";
}

export interface SourceCatalog {
  groups: SourceProductGroup[];
  products: SourceProduct[];
  prices: SourcePrice[];
  attachedAddons: SourceAttachedAddon[];
  differentialPrices: SourceDifferentialPrice[];
}

// ---------------------------------------------------------------------------
// Coupons

export interface SourceCoupon extends SourceTimestamps {
  sourceId: string;
  /** Redemption code (a source may reuse the coupon id as the code). */
  code: string;
  name?: string;
  kind: "percentage" | "fixed_amount";
  percentOffBps?: number;
  amountOffMinor?: number;
  currency?: string;
  durationType: "once" | "forever" | "repeating";
  durationInPeriods?: number;
  maxRedemptions?: number;
  /** Lifetime redemption count at the source — preserved so limits keep working. */
  timesRedeemed?: number;
  redeemBy?: Date;
  /** false → imported archived (expired/archived at the source). */
  active?: boolean;
  metadata?: Record<string, unknown>;
  /** CAT-2: invoice_amount (default) | each_specified_item. */
  applyOn?: "invoice_amount" | "each_specified_item";
  /** CAT-2: per-item-kind constraints (product ids are slug ids). */
  itemConstraints?: Array<{
    itemKind: "plan" | "addon" | "charge";
    constraintType: "all" | "specific" | "none";
    productIds?: string[];
  }>;
}

export interface SourceCouponSetCode {
  code: string;
  redeemed: boolean;
}

export interface SourceCouponSet {
  sourceId: string;
  couponSourceId: string;
  name: string;
  /** Exact code strings (+ redeemed state) — codes must round-trip verbatim. */
  codes: SourceCouponSetCode[];
}

// ---------------------------------------------------------------------------
// Customers

/**
 * An EXISTING vaulted payment method at the provider. During migration we link
 * these tokens directly (no re-vaulting) so the next renewal can charge — the
 * card already lives at the provider and the tokens stay valid when tmbilling
 * uses the same provider account. We only ever store tokens (PCI SAQ-A).
 */
export interface SourcePaymentMethod extends SourceTimestamps {
  sourceId?: string; // source's own payment-source id (idempotency key when set)
  provider: string; // 'stripe' | 'razorpay' | 'paypal' | 'tmtest'
  providerCustomerId: string; // existing provider customer id (e.g. cus_…)
  providerPaymentMethodId: string; // existing token (e.g. pm_… / card_… / src_…)
  type?: string; // default 'card'
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  /**
   * The instrument's lifecycle state, in OUR vocabulary
   * (valid | expiring | expired | invalid | pending_verification).
   *
   * Carried because an unchargeable card is still worth importing: a portal showing
   * "Visa ••1006 — expired" tells the customer what to fix, where an empty payment-methods
   * page tells them nothing. Collection is unaffected — every selection path filters on
   * `status = 'valid'`.
   */
  status?: string;
  isPrimary?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * A payment source's STATE at the source, independent of whether we can link it.
 *
 * Distinct from both `SourcePaymentMethod` (only the *portable* ones, and only the
 * `valid`/`expiring` ones) and `SourceNonPortablePaymentMethod` (only the unlinkable
 * ones). Neither answers "what does the source believe about this card right now?", and
 * for a parallel run that is the question that matters: the shadow charges a simulated
 * instrument chosen to behave the way the customer's real card behaves, so it needs the
 * card's STATUS and explicitly does not care whether the token is portable — a valid
 * card on a gateway we cannot map still deserves a succeeding instrument.
 *
 * Reported, never imported: no token is carried here on purpose.
 */
export interface SourcePaymentSourceState {
  sourceId: string;
  customerSourceId: string;
  /** Source vocabulary (e.g. valid | expiring | expired | invalid | pending_verification). */
  status: string;
  /** The source's raw gateway name — NOT normalized, since portability is irrelevant here. */
  gateway: string;
  type?: string;
  /** Whether the source treats this as the customer's default. */
  isPrimary: boolean;
}

/** A payment source we can NOT link (unknown gateway / source-owned vault). */
export interface SourceNonPortablePaymentMethod {
  sourceId: string;
  customerSourceId: string;
  gateway: string;
  type?: string;
  last4?: string;
  reason: string;
}

export interface SourceAddress {
  line1?: string;
  line2?: string;
  line3?: string;
  city?: string;
  state?: string;
  stateCode?: string;
  postalCode?: string;
  country?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  phone?: string;
}

export interface SourceContact {
  sourceId?: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  label?: string;
  enabled?: boolean;
  sendAccountEmail?: boolean;
  sendBillingEmail?: boolean;
}

export interface SourceCustomer extends SourceTimestamps {
  sourceId: string;
  email?: string;
  // No `name`: `customers.name` is deprecated (see `modules/customers/names.ts`) and
  // The source has no `customer.name` to map from — adapters must not
  // SYNTHESISE one as `company ?? "first last"`, duplicating the three fields
  // below and giving the importer a fourth name to disagree with itself about.
  firstName?: string;
  lastName?: string;
  company?: string;
  phone?: string;
  currency?: string;
  locale?: string;
  autoCollection?: "on" | "off";
  netTermDays?: number;
  invoiceNotes?: string;
  taxExempt?: boolean;
  vatNumber?: string;
  billingAddress?: SourceAddress;
  shippingAddress?: Record<string, unknown>;
  /** Per-customer calendar billing anchor (day-of-month) when the source pins one. */
  billingDate?: number;
  billingDateMode?: "using_defaults" | "manually_set";
  contacts?: SourceContact[];
  /** All portable vaulted payment methods (primary flagged). */
  paymentMethods?: SourcePaymentMethod[];
  /** Promotional-credit balances per currency (minor units). */
  promoCreditBalances?: Array<{ currency: string; amountMinor: number }>;
  active?: boolean;
  metadata?: Record<string, unknown>;
  /** Source custom fields (bare api_name → value); imported as customer custom-field definitions + values. */
  customFields?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Subscriptions

export type SourceSubStatus =
  | "active"
  | "trialing"
  | "future"
  | "paused"
  | "canceled"
  | "non_renewing";

export interface SourceSubscriptionItem {
  priceSourceId: string;
  kind?: SourceProductKind;
  quantity: number;
  /** Per-item negotiated price override (≠ catalog amount), minor units. */
  unitPriceMinor?: number;
  freeQuantity?: number;
  billingCycles?: number;
}

export interface SourceAppliedCoupon {
  couponSourceId: string;
  /** Periods left for a repeating coupon (undefined = derive from coupon duration). */
  remainingPeriods?: number;
  /** How many periods the coupon has already applied at the source (`applied_count`). */
  timesApplied?: number;
}

/**
 * A subscription-level **discount** — the source's `subscription.discounts[]`.
 *
 * Distinct from `SourceAppliedCoupon`: a *coupon* is a catalog object shared
 * across subscriptions, while a *discount* is a standalone, self-contained
 * reduction attached to one subscription with no catalog row behind it. It maps
 * onto our `applied_coupons` row with `source='manual'`, `coupon_id=null` and the
 * self-contained `manual_*` columns (the same shape `applyManualDiscount` writes).
 *
 * Dropping these is a **billing** error, not a reporting one: a `forever`
 * fixed-amount discount worth the full subscription value makes the source bill 0, and an
 * import without it bills the customer the full amount at renewal.
 */
export interface SourceSubscriptionDiscount {
  /** Source `discount.id` — the idempotency key for the import record. */
  sourceId: string;
  kind: "percentage" | "fixed_amount";
  /** percentage only — basis points (source `percentage: 10.5` → 1050). */
  percentOffBps?: number;
  /** fixed_amount only — minor units (source `amount`). */
  amountOffMinor?: number;
  currency?: string;
  durationType: "forever" | "limited_period" | "one_time";
  /** limited_period: source `period` (total), before `applied_count` is deducted. */
  periods?: number;
  /**
   * Source `period_unit` — the UNIT `periods` is counted in (day/week/month/year).
   *
   * Captured but NOT yet consumed for billing. Our `applied_coupons.total_periods` /
   * `remaining_periods` count BILLING PERIODS, so the two agree only while the
   * discount's unit matches the subscription's cadence. "12 months" on a monthly plan
   * is 12 billing periods; on a YEARLY plan the source means one, and we would apply
   * twelve — twelve years of discount. The importer logs that mismatch loudly
   * (`mapSubscriptionDiscounts`) so a real import measures whether the book contains
   * any before the conversion changes anyone's billing.
   */
  periodUnit?: "day" | "week" | "month" | "year";
  /** How many periods the discount has already applied (source `applied_count`). */
  timesApplied?: number;
  /** Source `invoice_name` — the label the customer sees on the invoice. */
  label?: string;
  /**
   * Source `apply_on`. `invoice_amount` discounts the whole invoice (what our
   * manual-discount row expresses). `specific_item_price` discounts ONE item
   * price only — we have no manual-row equivalent, so the importer REFUSES it
   * rather than silently widening it to the whole invoice (which would
   * over-discount). See the migration README.
   */
  applyOn?: "invoice_amount" | "specific_item_price";
  /** `specific_item_price` only — the item price the discount is scoped to. */
  itemPriceSourceId?: string;
  createdAt?: Date;
}

export interface SourceSubscription extends SourceTimestamps {
  sourceId: string;
  customerSourceId: string;
  items: SourceSubscriptionItem[];
  appliedCoupons?: SourceAppliedCoupon[];
  /** Subscription-level standalone discounts (source `discounts[]`). */
  discounts?: SourceSubscriptionDiscount[];
  status: SourceSubStatus;
  currency: string;
  /** When the current (already-paid) term ends — tmbilling takes over here. */
  currentTermEnd: Date;
  currentTermStart?: Date;
  trialStart?: Date;
  trialEnd?: Date;
  startDate?: Date; // scheduled start (future subs)
  startedAt?: Date;
  activatedAt?: Date;
  canceledAt?: Date;
  cancelReason?: string;
  pauseDate?: Date;
  resumeDate?: Date;
  remainingBillingCycles?: number;
  poNumber?: string;
  netTermDays?: number;
  autoCollection?: "on" | "off";
  invoiceNotes?: string;
  metadata?: Record<string, unknown>;
  /** Source custom fields (bare api_name → value); imported as subscription custom-field definitions + values. */
  customFields?: Record<string, unknown> | null;
}

export interface SourceUnbilledCharge {
  sourceId: string;
  subscriptionSourceId: string;
  customerSourceId?: string;
  description: string;
  amountMinor: number;
  currency: string;
}

/** Open-period usage for metered items (history is settled via invoices). */
export interface SourceUsageRecord {
  sourceId: string;
  subscriptionSourceId: string;
  priceSourceId: string;
  quantity: number;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// History (archival, Option A)

// Invoice statuses: the source vocabulary matches
// ours 1:1 (posted/payment_due/not_paid are all collectible/open AR).
export type SourceInvoiceStatus =
  | "paid"
  | "posted"
  | "payment_due"
  | "not_paid"
  | "voided"
  | "pending";

/**
 * Finalized-but-still-owed: the invoices that make up open AR.
 *
 * The one definition, shared by the importer (what `--no-history` still brings), the
 * reconciler (what it expects to find) and the open-AR balance check. They used to
 * each spell the list out, so an edit to one silently disagreed with the others — and
 * a disagreement between "what the import kept" and "what the reconcile expects" reads
 * as a data mismatch rather than as the definition drift it is.
 *
 * `pending` is NOT here: it is unfinalized at the source and never imported at all.
 */
export const OPEN_INVOICE_STATUSES: readonly SourceInvoiceStatus[] = [
  "posted",
  "payment_due",
  "not_paid",
];

export interface SourceInvoiceLine {
  sourceId?: string;
  description: string;
  /** Source price this line rated (resolved to ours when imported). */
  priceSourceId?: string;
  quantity: number;
  unitAmountMinor: number;
  /** GROSS, before any discount — the source's `line_items[].amount`. */
  amountMinor: number;
  /**
   * Discount attributed to this line across BOTH stages — the source's
   * `line_items[].discount_amount`. Lands in `invoice_line_items.discount_minor` (0169).
   */
  discountMinor?: number;
  /**
   * The per-stage split behind `discountMinor` — the source's `line_item_discounts[]` entries for
   * this line. `item_level` shares are already inside the invoice's `subtotalMinor`;
   * `document_level` ones are not. Imported into `invoice_line_discounts`.
   */
  discounts?: Array<{
    scope: "item_level" | "document_level";
    amountMinor: number;
    couponSourceId?: string;
  }>;
  periodStart?: Date;
  periodEnd?: Date;
  /**
   * Our `invoice_line_items.kind`. Omitted → derived from priceSourceId
   * (recurring when it resolves, else one_time). Set explicitly for the
   * synthetic `tax` / `discount` lines that make the document add up:
   * total = Σ(charge lines) − Σ(discount lines) + Σ(tax lines).
   */
  kind?: "recurring" | "proration" | "usage" | "one_time" | "discount" | "tax" | "rounding";
}

export interface SourceInvoice {
  sourceId: string;
  customerSourceId: string;
  subscriptionSourceId?: string;
  /** Source's human invoice number — kept verbatim so references stay valid. */
  number?: string;
  status: SourceInvoiceStatus;
  currency: string;
  subtotalMinor: number;
  totalMinor: number;
  /** Remaining collectible (open invoices); 0 for settled. */
  amountDueMinor: number;
  /** Written off at the source; > 0 marks the imported invoice written off. */
  writeOffMinor?: number;
  /** What the source document froze at issue — see `IssueSnapshot`. */
  issue?: IssueSnapshot;
  date: Date;
  dueDate?: Date;
  paidAt?: Date;
  periodStart?: Date;
  periodEnd?: Date;
  /**
   * The source document's own FX rate and the currency it was measured against
   * (0228) — the source's `invoice.exchange_rate` + `base_currency_code`.
   *
   * Imported verbatim so a migrated book can still convert its history at
   * issue-time rates; absent → our column stays null, which is the honest value
   * (we do NOT substitute today's rate onto an archival row).
   *
   * Direction: units of the DOCUMENT's currency per 1 unit of `base_currency_code` —
   * the same direction as ours, so this is a straight copy. A USD-base book reports
   * `exchange_rate: 1` for USD invoices and ~95 for INR ones; the reciprocal would value
   * a ₹940 invoice at USD 89,407.
   *
   * The rate differs between invoices (95.11455 vs 95.38054) because it refreshes daily,
   * which is why it belongs on the document rather than a live table read.
   */
  exchangeRate?: number | string;
  exchangeRateBase?: string;
  lines: SourceInvoiceLine[];
  /**
   * Tax charged on the document, itemized per jurisdiction/rate. Imported as
   * `kind: 'tax'` line items — without these the invoice total would not
   * reconcile against its lines (the source's `sub_total` excludes tax).
   */
  taxes?: Array<{ name: string; description?: string; amountMinor: number; rate?: number }>;
  /**
   * Discounts on the document (coupons, ad-hoc, promotional credits).
   *
   * ⚠️ Only the DOCUMENT-level ones become negative `kind: 'discount'` line items.
   * `subtotalMinor` is the source's `sub_total`, which already has item-level discounts
   * taken off it, so importing an item-level discount as a line too would subtract it
   * twice and the document would not add up. `entityType` is what decides — pass it
   * through `discountScope`. The per-line attribution for BOTH stages travels on
   * `SourceInvoiceLine.discounts` instead.
   */
  discounts?: Array<{
    description: string;
    amountMinor: number;
    couponSourceId?: string;
    entityType?: string;
  }>;
  /**
   * Where the source's dunning ladder had already got to on this invoice.
   *
   * Without it an imported open invoice starts at `attempt_count = 0` (the column
   * default), so a customer the source has already failed three times restarts our
   * ladder from scratch and cancels ~16 days late. In a parallel run that reads as a
   * cancellation bug in this engine when it is purely an import gap — so it must be
   * carried, not inferred.
   *
   * Source: `dunning_attempts[]` (its `attempt` field is 0-indexed, so the COUNT
   * is the array length), `next_retry_at`, `dunning_status`.
   */
  dunning?: {
    /** Attempts already made. 0/absent = never attempted. */
    attemptCount: number;
    /** When the source will next retry, if it is mid-ladder. */
    nextAttemptAt?: Date;
    /** Source vocabulary; ours is null | in_progress | success | exhausted | stopped | parked. */
    status?: string;
  };
  /** Raw source payload, archived verbatim in metadata. */
  rawPayload?: unknown;
}

export interface SourceCreditNote {
  sourceId: string;
  customerSourceId: string;
  invoiceSourceId: string;
  type: "adjustment" | "refundable";
  status: string; // source vocabulary, kept in metadata
  /** When the source voided it. A voided note imports as voided, never as refunded. */
  voidedAt?: Date;
  totalMinor: number;
  /** Still-refundable balance → opening customer_balance credit at cutover. */
  amountAvailableMinor: number;
  /** Portion consumed by invoice allocations (distinct from refunds). */
  amountAllocatedMinor?: number;
  /** Portion already refunded to the customer at the source. */
  amountRefundedMinor?: number;
  currency: string;
  reason?: string;
  date: Date;
  lines?: Array<{ description: string; amountMinor: number }>;
  /** Per-invoice allocation history → credit_note_allocations rows. */
  allocations?: Array<{ invoiceSourceId: string; amountMinor: number; date?: Date }>;
  /** Refund transactions drawn from this CN → archival transaction-log rows. */
  linkedRefunds?: Array<{
    transactionSourceId: string;
    amountMinor: number;
    date?: Date;
    gateway?: string;
    gatewayTransactionId?: string;
  }>;
  rawPayload?: unknown;
}

export interface SourceTransaction {
  sourceId: string;
  /** Last change at the source. The row's `created_at` comes from `date` below. */
  updatedAt?: Date;
  customerSourceId?: string;
  /** Gateway attempt type. Only payment/refund rows also book money. */
  type: "payment" | "refund" | "authorization" | "payment_reversal";
  /** Engine money-status — drives payments/refunds booking. */
  status: "succeeded" | "failed" | "pending";
  /** Gateway-log status, in OUR vocabulary (in_progress|succeeded|voided|failed|timeout|needs_attention|late_failed). */
  gatewayStatus?: string;
  errorCode?: string;
  errorText?: string;
  amountMinor: number;
  currency: string;
  /** Normalized tmbilling provider key ('stripe' | 'razorpay' | 'paypal'), or undefined if the
   *  source gateway can't be charged/refunded through our adapters (import still archives the
   *  transaction; provider_key/provider_charge_id land null-equivalent so refunds fail loudly). */
  gateway?: string;
  /** Underlying gateway reference (e.g. Stripe ch_…/pi_…) — only meaningful when `gateway` is set. */
  gatewayTransactionId?: string;
  date: Date;
  /** Invoices this transaction settled (payment) or reversed against (refund). */
  linkedInvoices?: Array<{ invoiceSourceId: string; appliedAmountMinor: number }>;
  /** For refunds: the source id of the payment transaction being refunded. */
  refundedTransactionSourceId?: string;
  rawPayload?: unknown;
}

export interface SourceEvent {
  sourceId: string;
  eventType: string;
  occurredAt: Date;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Inventory (pre-import discovery / scope report)

export interface SourceInventory {
  source: string;
  site?: string;
  /** Resource → count (or count-by-sub-key map for status/gateway breakdowns). */
  counts: Record<string, number | Record<string, number>>;
  currencies: string[];
  /** Payment sources by gateway, split portable vs non-portable. */
  paymentSources: {
    byGateway: Record<string, number>;
    portable: number;
    nonPortable: number;
    nonPortableDetails: SourceNonPortablePaymentMethod[];
  };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Site-level configuration (currencies + FX). Only structural config the source
// API exposes: currencies and FX. Gateway config, dunning rules, invoice numbering,
// email templates and tax registration are not imported. The gateway accounts
// in USE are still recoverable — see MigrationSource.listGatewayAccounts().
export interface SourceSiteConfig {
  baseCurrency: string;
  /** All enabled currency codes (base + additional), uppercased. */
  currencies: string[];
  /** Manual FX rates keyed by currency code: 1 baseCurrency = rate × currency. */
  exchangeRates: Record<string, number>;
}

// ---------------------------------------------------------------------------
// The source interface

/**
 * A payment gateway the source site actually transacts on. Credentials are NEVER
 * available (no billing provider exposes another system's gateway API keys), so
 * an imported account is a *placeholder*: it records which gateway + which
 * gateway account the source's cards and charges belong to, so the operator can
 * paste credentials once and have every imported card/refund resolve correctly.
 */
export interface SourceGatewayAccount {
  /** Source's gateway account id (e.g. gw_…). */
  sourceId: string;
  /** Normalized to our provider keys: stripe | razorpay | paypal. */
  gatewayKey: string;
  /** Source's raw gateway name, kept for the operator's benefit. */
  sourceGatewayName: string;
  /** Currencies observed transacting on this account (null = unknown). */
  currencies?: string[] | null;
  /** How many payment sources / transactions referenced it (for the report). */
  paymentSourceCount?: number;
  transactionCount?: number;
}

/**
 * An outbound webhook endpoint configured at the source. Imported DISABLED on
 * purpose: (a) the source never reveals its signing secret so ours is freshly
 * minted and the receiver would reject our payloads anyway, and (b) enabling it
 * at import time would start POSTing live traffic to a third party the moment
 * the migration finishes. The operator reviews, re-keys, then enables.
 */
export interface SourceWebhookEndpoint {
  sourceId: string;
  url: string;
  name?: string;
  /** null = subscribed to everything. */
  eventTypes?: string[] | null;
  /** Whether it was enabled AT THE SOURCE (recorded, not honored). */
  enabledAtSource: boolean;
}

export interface MigrationSource {
  readonly name: string; // 'stripe' | 'json' | 'fixture' | …
  listCatalog(): Promise<SourceCatalog>;
  /**
   * `ids` narrows the fetch to just those customer source ids — for
   * `--billable-only` (via `dropCustomersWithoutSubscriptions`), so a live import
   * doesn't page through every churned customer's record (and payment methods)
   * just to discard them locally. A source that ignores the hint just returns
   * everything, which is safe — only slower. Callers must still re-filter locally.
   */
  listCustomers(opts?: { ids?: string[] }): Promise<SourceCustomer[]>;
  /**
   * `statuses` narrows the fetch to just those subscription statuses — for
   * `--billable-only`, so a live import doesn't page through every cancelled
   * subscription in the book just to discard it locally. A source that ignores
   * the hint just returns everything, which is safe — only slower. Callers must
   * still re-filter locally: a source may accept the param and silently ignore it.
   */
  /**
   * `ids` narrows to named subscriptions. Without it a partial import pages the source's
   * ENTIRE subscription history — 30,300 rows on a large book — to select 34. As with the
   * history reads, a source may ignore it, so callers still filter locally.
   */
  listSubscriptions(opts?: {
    statuses?: SourceSubStatus[];
    ids?: string[];
  }): Promise<SourceSubscription[]>;
  /** Site-level currency + FX configuration (optional; absent → not cloned). */
  readSiteConfig?(): Promise<SourceSiteConfig>;
  // Optional capabilities:
  listCoupons?(): Promise<{ coupons: SourceCoupon[]; couponSets: SourceCouponSet[] }>;
  /** `subscriptionIds` narrows to those subscriptions; callers still filter locally. */
  listUnbilledCharges?(opts?: { subscriptionIds?: string[] }): Promise<SourceUnbilledCharge[]>;
  listUsageRecords?(opts?: { subscriptionIds?: string[] }): Promise<SourceUsageRecord[]>;
  /**
   * `openOnly` narrows to invoices still collectable. It exists so a
   * `--no-history` import can still bring the OPEN ones: they carry the AR baseline
   * and, via `SourceInvoice.dunning`, the in-flight ladder position. A source that
   * ignores the flag just returns everything, which is safe — only slower.
   */
  /**
   * `customerIds` narrows the read to those customers. A partial import needs it: the
   * unscoped call pages the SOURCE'S ENTIRE HISTORY — on a large book 65,813 invoices and
   * 47,965 transactions to keep ~571 — and materialises all of it before the caller
   * filters. That is slow, and it is an out-of-memory risk long before it is a slow one.
   *
   * A source that cannot filter server-side may ignore it and return everything; callers
   * must still filter locally, and a source adapter may do both for exactly
   * that reason.
   */
  listInvoices?(opts?: { openOnly?: boolean; customerIds?: string[] }): Promise<SourceInvoice[]>;
  listCreditNotes?(opts?: { customerIds?: string[] }): Promise<SourceCreditNote[]>;
  listTransactions?(opts?: { customerIds?: string[] }): Promise<SourceTransaction[]>;
  listEvents?(): Promise<SourceEvent[]>;
  /**
   * Payment sources that exist at the source but cannot be linked (reported, not
   * imported). `customerIds` narrows to the retained scope (`--billable-only`'s
   * `dropCustomersWithoutSubscriptions`) — without it, a card belonging to a
   * customer this import is dropping would still get reported, which is both an
   * inaccurate warning (that customer was never imported) and an unscoped fetch.
   */
  listNonPortablePaymentMethods?(opts?: {
    customerIds?: string[];
  }): Promise<SourceNonPortablePaymentMethod[]>;
  /**
   * EVERY payment source's state, portable or not; never used by the importer. Added for
   * the shadow run (removed) to choose a simulated instrument per customer; its live
   * caller today is `scripts/lib/inr-cutover-preflight-run.ts`. ⚠️ ALWAYS pass
   * `customerIds` — without it this is a full-site walk of `customers` and
   * `payment_sources`, paced at 400ms/page on live.
   */
  listPaymentSourceStates?(opts?: { customerIds?: string[] }): Promise<SourcePaymentSourceState[]>;
  /**
   * Gateway accounts the source transacts on (credential-less placeholders).
   * `includeHistory` (default true) mirrors `ImportOptions.includeHistory`: a source
   * that must walk its whole transaction history to derive this (e.g. a source whose API lists no gateway accounts) may narrow to cheaper, already-fetched
   * data when it is false. A source that ignores the hint just returns everything,
   * which is safe — only slower.
   */
  listGatewayAccounts?(opts?: { includeHistory?: boolean }): Promise<SourceGatewayAccount[]>;
  /** Outbound webhook endpoints configured at the source. */
  listWebhookEndpoints?(): Promise<SourceWebhookEndpoint[]>;
  inventory?(): Promise<SourceInventory>;
}

/**
 * Which stage of the two-stage discount waterfall a discount belongs to:
 *
 *   subtotal = Σ line amounts − Σ(ITEM-level discounts)
 *   total    = subtotal − Σ(DOCUMENT-level discounts) + tax
 *
 * Matches on the `item_level` PREFIX so `item_level_coupon` stays item-level instead of
 * defaulting to document-level and being subtracted twice. Scope is not attribution: a
 * document-level discount can still be attributed to a line.
 */
export function discountScope(
  entityOrDiscountType: string | null | undefined,
): "item_level" | "document_level" {
  return String(entityOrDiscountType ?? "").startsWith("item_level")
    ? "item_level"
    : "document_level";
}
