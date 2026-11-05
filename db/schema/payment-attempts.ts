import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { paymentIntents } from "./payment-intents";

/**
 * One ATTEMPT against a gateway inside a payment intent (0170).
 *
 * A payment intent is a CONTAINER of attempts: each attempt keeps its own id, status
 * and gateway transaction id, and the intent's timeline is ordered by them.
 * Ours was one flat row: a buyer who failed 3DS twice before succeeding
 * overwrote the row twice and we kept only the last outcome. This is where the other
 * tries live.
 *
 * NOT the same thing as `transactions`. A transaction is the MONEY record (linked from
 * here via `transactions.payment_attempt_id`, 0172); an attempt exists for zero-amount
 * `setup` intents too, where no money moves and no transaction is written.
 */
export const paymentAttempts = pgTable(
  "payment_attempts",
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
    // CASCADE: an attempt has no meaning without its intent.
    paymentIntentId: uuid("payment_intent_id")
      .notNull()
      .references(() => paymentIntents.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // pia_…
    // 1-based, so attempts read "Attempt 1 / Attempt 2". Unique per intent, so a
    // double-submit collides instead of writing two rows claiming the same number.
    attemptNumber: integer("attempt_number").notNull(),
    // inited | requires_action | authorized | consumed | failed | voided
    status: text("status").notNull().default("inited"),
    // No FK, matching payment_intents.paymentMethodId: a vaulted method can be deleted
    // while the attempt that used it stays as history.
    paymentMethodId: uuid("payment_method_id"),
    // Stripe `seti_…`/`pi_…`, PayPal order id, Razorpay payment id. Per ATTEMPT — a
    // retry gets a new id at most gateways, which is what the flat intent row kept
    // overwriting.
    idAtGateway: text("id_at_gateway"),
    // What the gateway said paid when it read the browser's result (`google_pay`), raw.
    // Consume books it when the capture names no method (0398).
    methodUsed: text("method_used"),
    errorCode: text("error_code"),
    errorText: text("error_text"),
    // Correlation key into `gateway_request_logs`. ⚠️ DELIBERATELY NOT A FOREIGN KEY:
    // that table is PLATFORM-GLOBAL with no RLS (see gateway.ts / modules/ops/gateway-log.ts)
    // because adapters run outside tenant transactions, so an FK from this RLS-protected
    // table would put referential integrity — and a cross-tenant existence oracle —
    // across the isolation boundary. Correlate by id only: `spanId` is this attempt (it
    // spans requests: a later void joins it), `traceId` the request or job that made it.
    traceId: text("trace_id"),
    spanId: text("span_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("payment_attempts_public_id_uq").on(t.publicId),
    // Attempts of one intent, in order — and the uniqueness behind the "Attempt N" label.
    uniqueIndex("payment_attempts_intent_number_uq").on(t.paymentIntentId, t.attemptNumber),
    // Keyset pagination for the list route (GUIDE §3.4), same shape as payment_intents.
    index("payment_attempts_business_created_idx").on(
      t.businessId,
      t.createdAt.desc(),
      t.publicId.desc(),
    ),
    // Every gateway call belonging to this attempt (see traceId above).
    index("payment_attempts_trace_idx").on(t.traceId),
    index("payment_attempts_span_idx")
      .on(t.spanId)
      .where(sql`span_id is not null`),
  ],
);
