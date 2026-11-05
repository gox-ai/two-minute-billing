import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  bigint,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { prices } from "./catalog";
import { customers } from "./customers";
import { subscriptions } from "./subscriptions";
import { invoices } from "./invoices";

/**
 * Hosted-checkout sessions (#10d) — short-lived bearer tokens an operator (or
 * API) mints so a BUYER can subscribe to a chosen price at /checkout/<token>,
 * without the org API key ever reaching the buyer's browser. Mirrors
 * `portal_sessions`: only a SHA-256 hash of the token is stored, never the
 * token itself. Adds the price/quantity to subscribe to plus the result
 * pointers (customer + subscription) captured once the flow completes.
 *
 * Two modes (#10b):
 *  - `create` (default) — subscribe a NEW customer to the session's items.
 *  - `change`  — change an EXISTING subscription (upgrade/downgrade, add/adjust
 *    items, apply coupons). `subscription_id` is the target and is required;
 *    the customer is fixed by that subscription at mint time, so the buyer
 *    can never bind a different one.
 *
 * The item list lives in `checkout_session_items` (0..n), and `coupon_codes`
 * holds the codes to apply. Both are validated AT MINT — a bogus price or
 * coupon 404s when the page is created, not on completion. A change session may
 * legitimately carry NO items (a coupon-only page is a valid flow), so the item
 * list is not required in that mode.
 */
/**
 * A reusable public payment link (E2, 0345). Each visit mints its own checkout session —
 * subscription if any price recurs, purchase otherwise — so a session's one-buyer rules hold.
 */
export const paymentLinks = pgTable(
  "payment_links",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // plink_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** false = archived: the public page refuses it. */
    active: boolean("active").notNull().default(true),
    showOnPricingPage: boolean("show_on_pricing_page").notNull().default(false),
    redirectUrl: text("redirect_url"),
    cancelUrl: text("cancel_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("payment_links_public_id_uq").on(t.publicId),
    index("payment_links_business_idx").on(t.businessId, t.createdAt),
  ],
);

/** A payment link's lines. min/max quantity and `optional` are the buyer's room to change (E3). */
export const paymentLinkItems = pgTable(
  "payment_link_items",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    paymentLinkId: uuid("payment_link_id")
      .notNull()
      .references(() => paymentLinks.id, { onDelete: "cascade" }),
    priceId: uuid("price_id")
      .notNull()
      .references(() => prices.id),
    quantity: integer("quantity").notNull().default(1),
    minQuantity: integer("min_quantity"),
    maxQuantity: integer("max_quantity"),
    optional: boolean("optional").notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("payment_link_items_link_price_uq").on(t.paymentLinkId, t.priceId)],
);

export const checkoutSessions = pgTable(
  "checkout_sessions",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    // create | change | purchase — what completing this session does (see the doc above).
    mode: text("mode").notNull().default("create"),
    /** Coupon codes to apply on completion. Resolved at mint. */
    couponCodes: jsonb("coupon_codes").$type<string[]>().notNull().default([]),
    // 0495: the codes in `couponCodes` the buyer entered on the page.
    customerCouponCodes: jsonb("customer_coupon_codes").$type<string[]>().notNull().default([]),
    /** mode='change' only: the existing subscription being changed. */
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "cascade",
    }),
    /**
     * mode='change' only. False (the default) means upsert:
     * listed items are applied, unlisted ones left alone. True means the posted list is
     * the WHOLE subscription and unlisted non-plan items are removed on completion.
     *
     * Needed because removal cannot be inferred from an item list: a buyer deselecting a
     * destination posts a list that merely omits it, which under upsert keeps billing it.
     */
    replaceItemsList: boolean("replace_items_list").notNull().default(false),
    /** mode='change' only: restart the term at the change date. */
    resetTerm: boolean("reset_term").notNull().default(false),
    /** mode='change' on a CANCELLED subscription: completing reactivates it (0279). */
    reactivate: boolean("reactivate").notNull().default(false),
    /** When the reactivated term starts; null = at completion. Never in the future. */
    reactivateFrom: timestamp("reactivate_from", { withTimezone: true }),
    /** mode='change': the session's coupons REPLACE the subscription's, not add to them. */
    replaceCouponList: boolean("replace_coupon_list").notNull().default(false),
    /** Where the hosted page sends the buyer after completing, and on cancel. */
    redirectUrl: text("redirect_url"),
    cancelUrl: text("cancel_url"),
    /** Caller's opaque context, returned on retrieve. Never interpreted. */
    passThruContent: text("pass_thru_content"),
    /**
     * Create mode: buyer details the operator knew at mint (0320) — `{ email?,
     * tax_registration_number?, address? }`, snake_case. Only prefills the details step;
     * the buyer's own submit is what writes the customer.
     */
    prefill: jsonb("prefill"),
    /**
     * Metadata to write onto the resulting subscription on completion. Deferred intent,
     * exactly like `couponCodes` and `replaceItemsList` above.
     *
     * Applied only AFTER the item operations succeed, which is the point: a plan change
     * here commits asynchronously (hosted page, buyer authenticates), so the metadata
     * that explains a change must not be written before the change is paid for. A
     * core-destination switch is the motivating case — metadata alone would serve a
     * destination nobody paid for, items alone would bill for one nobody is served.
     *
     * NULL ≠ `{}`. Null says this checkout has no opinion; `{}` says set it to empty.
     * Collapsing them would make every checkout clear its subscription's metadata.
     */
    metadata: jsonb("metadata"),
    // open | completed | expired — the lifecycle of the checkout.
    /**
     * The `pi_…` setup intent this session began, when it began one.
     *
     * It exists so the WEBHOOK can finish a checkout the buyer cannot come back to. On the
     * netbanking e-mandate rail RazorPay never returns the payer (its auth-link endpoint
     * ignores `callback_url`), so `harvestSetupIntent` vaults the instrument and this is the
     * only thread back to the session that was waiting for it.
     */
    setupPaymentIntent: text("setup_payment_intent"),
    status: text("status").notNull().default("open"),
    publicId: text("public_id").notNull(), // cosess_…
    tokenHash: text("token_hash").notNull(),
    /** API key public id that minted the session (audit trail). */
    createdBy: text("created_by"),
    // Populated once the buyer is captured / the flow completes.
    resultingCustomerId: uuid("resulting_customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    resultingSubscriptionId: uuid("resulting_subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    /** The customer was fixed at mint (a known customer buying more): the page cannot rewrite them. */
    customerPinned: boolean("customer_pinned").notNull().default(false),
    /** mode='purchase': the invoice the purchase raised. Voided if the buyer does not pay. */
    resultingInvoiceId: uuid("resulting_invoice_id").references(() => invoices.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** First time the buyer reached the payment step (`/setup` or `/complete`). Set once. */
    paymentStartedAt: timestamp("payment_started_at", { withTimezone: true }),
    /** First time the page was shown to the buyer (0478). Set once. */
    firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }),
    /** First time the buyer sent their details (0478). Set once. */
    detailsSubmittedAt: timestamp("details_submitted_at", { withTimezone: true }),
    /** Completion attempts that reached the gateway, and how many of them failed (0478). */
    paymentAttemptCount: integer("payment_attempt_count").notNull().default(0),
    paymentFailureCount: integer("payment_failure_count").notNull().default(0),
    /** The newest failure's message, for the conversion report. Not shown to the buyer. */
    lastPaymentFailure: text("last_payment_failure"),
    /** `steps` | `one_page` — the layout the buyer first saw (0478). */
    layout: text("layout"),
    /** `mobile` | `tablet` | `desktop`, from the buyer's browser (0478). */
    deviceClass: text("device_class"),
    /** The recurring-charge sentence the buyer agreed to, as shown (0479). */
    recurringConsentText: text("recurring_consent_text"),
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
    consentIp: text("consent_ip"),
    /** The consent answers sent with `/setup`, for a webhook-completed checkout (0494). */
    setupConsent: jsonb("setup_consent").$type<{
      answer: {
        recurring?: boolean;
        recurring_text?: string;
        terms?: boolean;
        marketing?: boolean;
      };
      ip: string | null;
      at: string;
    }>(),
    /** Abandoned-checkout reminders sent (E6, 0346), and when the last one went. */
    reminderCount: integer("reminder_count").notNull().default(0),
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    /** SHA-256 of the token a reminder links with; it opens the same session. */
    resumeTokenHash: text("resume_token_hash"),
    /** The payment link this checkout was opened from (0345). */
    paymentLinkId: uuid("payment_link_id").references(() => paymentLinks.id, {
      onDelete: "set null",
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("checkout_sessions_public_id_uq").on(t.publicId),
    uniqueIndex("checkout_sessions_token_hash_uq").on(t.tokenHash),
    index("checkout_sessions_org_idx").on(t.organizationId),
    index("checkout_sessions_business_idx").on(t.businessId),
    index("checkout_sessions_subscription_idx").on(t.subscriptionId),
  ],
);

/**
 * The items a checkout session will subscribe to (create) or upsert onto the
 * target subscription (change).
 *
 * A child table rather than JSON so each row keeps a real FK to `prices`
 * (a deleted price can't leave a danging reference) and the order the operator
 * specified survives (`position`). Rows are written once at mint and never
 * updated — the buyer cannot change what they were sent to buy.
 */
export const checkoutSessionItems = pgTable(
  "checkout_session_items",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    checkoutSessionId: uuid("checkout_session_id")
      .notNull()
      .references(() => checkoutSessions.id, { onDelete: "cascade" }),
    priceId: uuid("price_id")
      .notNull()
      .references(() => prices.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(1),
    /** Preserves the caller's ordering; item 0 is the primary (plan) line. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("checkout_session_items_session_idx").on(t.checkoutSessionId),
    index("checkout_session_items_org_idx").on(t.organizationId),
    uniqueIndex("checkout_session_items_session_price_uq").on(t.checkoutSessionId, t.priceId),
  ],
);
