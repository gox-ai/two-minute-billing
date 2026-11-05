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

/**
 * TM Billing Test Gateway persistence (C4 / GW-4). These are the *gateway's* own
 * tables — the vault, the charge ledger, and the async webhook queue — kept
 * separate from the engine's tables so tmtest behaves like a real external
 * gateway (its state survives restarts). Platform-global (no RLS), like
 * `provider_events`; accessed only through the tmtest adapter via the base
 * connection (it is a cross-tenant, gateway-side store, not tenant data).
 */

export const tmtestVault = pgTable(
  "tmtest_vault",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    vaultId: text("vault_id").notNull(), // tmpm_… (the provider payment-method id)
    token: text("token").notNull(),
    instrument: text("instrument").notNull(), // normalized PAN driving behavior
    last4: text("last4"),
    expMonth: integer("exp_month"),
    expYear: integer("exp_year"),
    status: text("status").notNull().default("valid"), // valid | expiring | expired
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("tmtest_vault_vault_id_uq").on(t.vaultId)],
);

export const tmtestCharges = pgTable(
  "tmtest_charges",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    chargeId: text("charge_id").notNull(), // tmch_… — the id_at_gateway
    businessId: uuid("business_id").notNull(),
    vaultId: text("vault_id"),
    kind: text("kind").notNull().default("charge"), // charge | refund
    parentChargeId: text("parent_charge_id"), // for refunds
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    status: text("status").notNull(), // succeeded | failed | requires_action | pending
    errorCode: text("error_code"),
    // Gateway-side idempotency (a real gateway dedups; so must the test gateway):
    // the caller's key on charge; a separate key for an intent's capture.
    idempotencyKey: text("idempotency_key"),
    consumeIdempotencyKey: text("consume_idempotency_key"),
    /**
     * The embedded-checkout descriptor a `checkout`-mode intent was born with
     * (`BuyerAuthorization.checkout`: keyId / orderId / customerId / recurring / method).
     *
     * A column rather than a re-derivation, because those params come from the CREATE
     * call — the provider customer, the chosen rail — and `createIntent` is
     * idempotency-keyed: a replayed key must hand back the SAME descriptor, and by then
     * the original input is gone. Without somewhere to keep them, the RazorPay-style
     * `checkout` mode of `BuyerAuthorization` was the one mode tmtest could not
     * simulate, so nothing in CI ever exercised it.
     */
    checkoutParams: jsonb("checkout_params").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tmtest_charges_charge_id_uq").on(t.chargeId),
    index("tmtest_charges_business_idx").on(t.businessId),
  ],
);

export const tmtestOutbound = pgTable(
  "tmtest_outbound",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    businessId: uuid("business_id").notNull(),
    eventId: text("event_id").notNull(), // tmev_… — stable id for inbound dedup
    eventType: text("event_type").notNull(), // charge.succeeded | charge.failed | charge.refunded
    payload: jsonb("payload").notNull(),
    signature: text("signature").notNull(),
    deliverAfter: timestamp("deliver_after", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tmtest_outbound_event_id_uq").on(t.eventId),
    index("tmtest_outbound_pending_idx").on(t.deliverAfter),
  ],
);
