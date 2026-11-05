import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";

/**
 * Payment intents (C7 / GW-7) — on-session 3DS and off-session challenge flows.
 * The engine creates an intent, the buyer completes any challenge (gateway
 * callback → authorized), then a subscribe/collect call consumes it (capture)
 * instead of charging directly.
 *
 * Since 0170/0171 this is a CONTAINER, not a leaf: the per-try detail lives in
 * `payment_attempts`, and `purpose` widens the object to cover zero-amount vault
 * SetupIntents (`seti_…`), which are the majority of real intents at the gateway
 * and were previously unrepresentable here.
 */
export const paymentIntents = pgTable(
  "payment_intents",
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
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    publicId: text("public_id").notNull(), // pi_…
    // inited | in_progress | authorized | consumed | expired | voided
    // NOTE: there is deliberately no `failed`. A refused authorization leaves the
    // INTENT open (`inited`) and marks its current ATTEMPT `failed` — that pairing
    // is what `retryPaymentIntent` requires to mint attempt N+1.
    status: text("status").notNull().default("inited"),
    // payment — collect an amount (the original, only meaning)
    // setup   — authorise + vault a payment method at amount 0 (Stripe `seti_…`)
    purpose: text("purpose").notNull().default("payment"),
    // ZERO IS LEGAL, and expected when purpose = 'setup'. There has never been a CHECK
    // constraint here; the positive-only rule lives in the route's zod schema.
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    // Ceiling for any single FUTURE debit under a mandate this intent registers (0174),
    // in minor units of `currency`. Set for purpose = 'setup' only — a `payment` intent
    // registers no mandate, so NULL is its correct value. Read by mandate rails
    // (RazorPay e-mandate/UPI/card) and ignored by adapters without the concept.
    // Persisted rather than kept in the request because
    // `retryPaymentIntent` registers a NEW mandate from this row alone — without the
    // column the retry would silently fall back to the adapter's default cap.
    maxAmountMinor: bigint("max_amount_minor", { mode: "bigint" }),
    /** Setup only: what the registration also collects as the first invoice's payment (0403). */
    firstChargeMinor: bigint("first_charge_minor", { mode: "bigint" }),
    /** Who took that payment: `booked` (first invoice) or `refunded` (setup refund) (0403). */
    firstChargeClaim: text("first_charge_claim"),
    currency: char("currency", { length: 3 }),
    gatewayAccountId: uuid("gateway_account_id"),
    paymentMethodId: uuid("payment_method_id"),
    intentAtGateway: text("intent_at_gateway"), // the gateway's intent id
    nextAction: jsonb("next_action"),
    // Denormalised count of `payment_attempts` rows, for the intent list.
    // Denormalised because the list is keyset-paginated and a correlated COUNT
    // per row is the per-row subquery GUIDE §3.4 forbids; the attempt writer bumps it in
    // the same tx. Starts at 0: an intent exists before its first attempt.
    attemptCount: integer("attempt_count").notNull().default(0),
    // Status of the NEWEST attempt, denormalised for the same reason as `attempt_count`
    // above: the list is keyset-paginated and cannot afford a per-row read of
    // `payment_attempts`. It exists because the intent's own status cannot express a
    // refusal (see the NOTE on `status`) — without it, a list row whose attempt the
    // gateway declined is indistinguishable from one a buyer is still working through.
    // NULL means NO ATTEMPT YET, not unknown. `writeAttemptStatus` is the only writer.
    lastAttemptStatus: text("last_attempt_status"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /**
     * The first moment this intent reached `authorized` — i.e. the gateway actually
     * HELD the buyer's money for it. Never cleared, never moved (the writers stamp it
     * with `coalesce(authorized_at, now())`), so it records that a hold once existed
     * rather than the current state.
     *
     * WHY A COLUMN. `status` cannot answer this after the fact. Both a released hold
     * and an intent that never authorized at all end up `expired` with their attempts
     * `failed`, so "expired with money outstanding and no `payment_reversal`" matches
     * every abandoned checkout as well as every genuinely stranded authorization —
     * which is why the abandoned-hold ops invariant could not be written at all until
     * now, and why recording the abandonment as a `needs_attention` transaction was
     * rejected instead: that would assert a gateway interaction that never happened.
     *
     * Distinct from `voided_at` above, which says the hold was deliberately released.
     * The pair is what the invariant reads: authorized, expired, and nothing recording
     * a release means the buyer's money lapsed at the gateway with nobody told.
     */
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    // Cancelled on purpose (buyer abandoned, merchant voided) — the state `expires_at`
    // could not express, since a timeout and a cancellation are not the same event.
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    // What the intent is FOR. Nullable — a `setup` intent has neither. No FK, matching
    // transactions.invoiceId: the gateway-side record outlives what it references.
    invoiceId: uuid("invoice_id"),
    subscriptionId: uuid("subscription_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("payment_intents_public_id_uq").on(t.publicId),
    index("payment_intents_business_idx").on(t.businessId),
    index("payment_intents_expiry_idx").on(t.status, t.expiresAt),
    // Keyset pagination for the list route (GUIDE §3.4), same shape as invoices.
    index("payment_intents_business_created_idx").on(
      t.businessId,
      t.createdAt.desc(),
      t.publicId.desc(),
    ),
    // "Every intent for this invoice / subscription" — the detail pages' read, same
    // shape as transactions_invoice_idx.
    index("payment_intents_invoice_idx").on(t.invoiceId),
    index("payment_intents_subscription_idx").on(t.subscriptionId),
    // The inbound `intent.*` webhook correlation (0173). An authorized-but-unconsumed
    // intent has no `transactions` row, so this column — not `id_at_gateway` — is the
    // only handle a gateway callback about an intent gives us. Partial on NOT NULL in
    // SQL (drizzle's builder has no `.where()` here, and the snapshot is stale at 0096
    // anyway — the migration is hand-written).
    index("payment_intents_gateway_intent_idx").on(t.intentAtGateway),
  ],
);
