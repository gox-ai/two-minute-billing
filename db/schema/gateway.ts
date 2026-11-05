import {
  pgTable,
  uuid,
  text,
  char,
  boolean,
  timestamp,
  jsonb,
  bigint,
  integer,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, businesses } from "./tenancy";

/**
 * A configured payment gateway account for a business (C1 / GW-1).
 *
 * One business can hold several — e.g. "Stripe US" (USD) and "RazorPay IN" (INR)
 * — and the router (GW-2) picks one per charge by currency × method type.
 * Credentials are stored **encrypted** (`credentials_enc`, AES-256-GCM via
 * `src/platform/secrets.ts`) and are write-only through the API — never echoed.
 */
export const gatewayAccounts = pgTable(
  "gateway_accounts",
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
    publicId: text("public_id").notNull(), // gwa_…
    gatewayKey: text("gateway_key").notNull(), // tmtest | stripe | paypal | razorpay
    label: text("label").notNull(), // "Stripe US", "TM Test"
    livemode: boolean("livemode").notNull().default(false),
    /**
     * `livemode` restated in businesses' own `live`/`test` vocabulary, GENERATED so
     * Postgres — not app code — keeps it in sync (0222). Exists solely so the composite
     * FK below has a `text` column to reference: `businesses.livemode` is `text`, this
     * table's `livemode` is `boolean` (existing call sites read it that way), and a
     * composite FK needs matching types on both sides. Nothing reads this column and
     * nothing can write to it directly — Postgres rejects any INSERT/UPDATE that
     * targets a GENERATED ALWAYS column — so it can never itself drift out of sync.
     */
    livemodeMode: text("livemode_mode").generatedAlwaysAs(
      sql`(case when "livemode" then 'live' else 'test' end)`,
    ),
    credentialsEnc: text("credentials_enc").notNull(), // AES-256-GCM(JSON)
    currencies: jsonb("currencies").$type<string[] | null>(), // null = all
    methodTypes: jsonb("method_types").$type<string[] | null>(), // null = all
    /**
     * "International payments" (0480). Read only for a gateway with `internationalSwitch` in
     * its catalogue entry: off = the account routes its domestic currency only. New accounts
     * start off; accounts that existed before 0480 were backfilled on.
     */
    internationalEnabled: boolean("international_enabled").notNull().default(false),
    status: text("status").notNull().default("active"), // active | disabled
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("gateway_accounts_public_id_uq").on(t.publicId),
    index("gateway_accounts_business_idx").on(t.businessId),
    // Structural backstop (0222) for "a gateway account's livemode matches its
    // business's" — the same rule webhook_endpoints already gets from Postgres via
    // 0152's FK. Every app-level path already derives livemode from the business;
    // this catches the fifth path (a hand-corrupted row, a future migration, an
    // admin script) that had no backstop until now. `business_id` is NOT NULL here,
    // so unlike webhook_endpoints this FK is never vacuously satisfied.
    foreignKey({
      name: "gateway_accounts_business_livemode_fk",
      columns: [t.businessId, t.livemodeMode],
      foreignColumns: [businesses.id, businesses.livemode],
    }).onDelete("cascade"),
  ],
);

/**
 * Outbound gateway-activity log: one row
 * per HTTP request the billing engine makes to a payment gateway (charge,
 * refund, vault, oauth, health-check, …).
 *
 * PLATFORM-GLOBAL (no RLS), mirroring `provider_events` in db/schema/platform.ts:
 * adapters run OUTSIDE tenant transactions (the ALS gateway-log context carries
 * `business_id`/`gateway_account_id`, not an org-scoped tx), so this table is
 * written via the base connection and the service layer org-guards every read.
 *
 * Secrets are REDACTED at capture time (src/providers/http.ts): auth headers,
 * card/secret body fields, and query-string secrets never reach this table.
 * Bodies are truncated to 16KB.
 */
export const gatewayRequestLogs = pgTable(
  "gateway_request_logs",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    businessId: uuid("business_id"),
    gatewayAccountId: uuid("gateway_account_id"),
    gatewayKey: text("gateway_key").notNull(), // tmtest | stripe | paypal | razorpay
    method: text("method").notNull(), // GET | POST | …
    url: text("url").notNull(), // query-string secrets masked
    status: integer("status"), // null = network error (no response)
    durationMs: integer("duration_ms"),
    operation: text("operation"), // charge | refund | ensure_customer | vault | health_check | oauth_token | normalize_webhook | …
    source: text("source"), // api | dashboard | scheduled_job | migration | system
    actor: text("actor"),
    requestHeaders: jsonb("request_headers"), // redacted
    requestBody: jsonb("request_body"), // redacted, truncated 16KB
    responseHeaders: jsonb("response_headers"), // redacted
    responseBody: jsonb("response_body"), // redacted, truncated 16KB
    error: text("error"), // set when the request threw (network error / timeout)
    // Correlates this outbound call with everything else the same request/job did.
    // Taken from the ambient trace context; null for calls made outside one.
    traceId: text("trace_id"),
    // One unit of work inside the trace (an invoice collection), so a transaction can
    // reach its own calls when a billing-clock run shares one trace across many charges.
    spanId: text("span_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("gateway_request_logs_business_created_idx").on(t.businessId, t.createdAt.desc()),
    // Pull every gateway call belonging to one traced operation.
    index("gateway_request_logs_trace_idx").on(t.traceId),
    // One attempt's or one collection's calls; a span can cross requests.
    index("gateway_request_logs_span_idx")
      .on(t.spanId)
      .where(sql`span_id is not null`),
  ],
);

/**
 * A merchant's own answer for ONE gateway decline (#69 stage 3).
 *
 * Retry behaviour used to be un-overridable per error: hardness came from one global
 * `skip_retries_for_hard_failures` boolean and everything else was a code change.
 *
 * ⚠️ `declineRuleId` is the STABLE id authored in `providers/decline-codes.ts`, and there
 * is deliberately no foreign key: the rules live in code, so a deploy that removes one
 * must not fail a merchant's writes. An id that no longer resolves is a real state —
 * `declineRuleById` returns undefined and the override is ignored.
 *
 * `gatewayAccountId` NULL means EVERY account of this business, which is the common case.
 * Both partial unique indexes exist because a plain UNIQUE over a nullable column would
 * admit unlimited NULL duplicates: in Postgres NULL is distinct from NULL.
 *
 * Every column past the key is nullable and means "leave the built-in answer alone", so a
 * merchant changing only the hardness does not thereby freeze our copy as theirs.
 */
export const declineRuleOverrides = pgTable(
  "decline_rule_overrides",
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
    gatewayAccountId: uuid("gateway_account_id").references(() => gatewayAccounts.id, {
      onDelete: "cascade",
    }),
    /**
     * Exactly ONE of these is set (enforced by a CHECK, 0234). A rule-level override names
     * one matching rule; a code-level one covers every rule that produces that canonical
     * code.
     */
    declineRuleId: text("decline_rule_id"),
    declineCode: text("decline_code"),
    /** NULL = keep the rule's own answer. */
    retriable: boolean("retriable"),
    message: text("message"),
    exposedToPayer: boolean("exposed_to_payer"),
    /** The signed-in operator, not an org key — see 0150/0151 on dashboard attribution. */
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("decline_rule_overrides_biz_rule_uq")
      .on(t.businessId, t.declineRuleId)
      .where(sql`gateway_account_id IS NULL`),
    uniqueIndex("decline_rule_overrides_acct_rule_uq")
      .on(t.businessId, t.gatewayAccountId, t.declineRuleId)
      .where(sql`gateway_account_id IS NOT NULL`),
    // Code-level rows carry a NULL `decline_rule_id`, and Postgres treats NULLs as
    // distinct — which is why they need their own indexes rather than falling into the
    // two above, and why all four are partial.
    uniqueIndex("decline_rule_overrides_biz_code_uq")
      .on(t.businessId, t.declineCode)
      .where(sql`decline_code IS NOT NULL AND gateway_account_id IS NULL`),
    uniqueIndex("decline_rule_overrides_acct_code_uq")
      .on(t.businessId, t.gatewayAccountId, t.declineCode)
      .where(sql`decline_code IS NOT NULL AND gateway_account_id IS NOT NULL`),
    index("decline_rule_overrides_biz_idx").on(t.businessId),
  ],
);

/**
 * How far `pollSettlements` has read each account's settlement report (0361). Its own table
 * so a poll does not bump `gateway_accounts.resource_version`. No row = never polled.
 */
export const gatewaySettlementCursors = pgTable("gateway_settlement_cursors", {
  gatewayAccountId: uuid("gateway_account_id")
    .primaryKey()
    .references(() => gatewayAccounts.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  polledUntil: timestamp("polled_until", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`app_now()`)
    .notNull(),
});
