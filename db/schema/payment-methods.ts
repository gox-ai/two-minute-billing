import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";

/**
 * A vaulted payment method. The card itself lives at the provider (PCI SAQ-A);
 * we store only the provider tokens + non-secret display fields.
 */
export const paymentMethods = pgTable(
  "payment_methods",
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
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // pm_…
    providerKey: text("provider_key").notNull(), // stripe | razorpay | paypal | mock
    providerCustomerId: text("provider_customer_id").notNull(),
    providerPaymentMethodId: text("provider_payment_method_id").notNull(),
    type: text("type").notNull(), // card | upi | wallet | ...
    brand: text("brand"),
    last4: text("last4"),
    expMonth: integer("exp_month"),
    expYear: integer("exp_year"),
    // Lifecycle status (C6): valid | expiring | expired | invalid | pending_verification.
    status: text("status").notNull().default("valid"),
    // Collection role (C6): primary | backup | none (removed from collection). Replaces the old is_default flag.
    role: text("role").notNull().default("backup"),
    // The gateway account that vaulted this method — charges follow it (GW-2).
    gatewayAccountId: uuid("gateway_account_id"),
    // ── The mandate this instrument was registered under (0179) ──────────────
    // Populated from what the PROVIDER reports at vault time, never from the
    // ceiling we requested — see `ProviderMandate` in src/providers/types.ts.
    // All null for a plain card-on-file with no mandate rail.
    //
    // ⚠️ A null `mandate_max_amount_minor` means UNKNOWN, not unlimited. The
    // charge-time pre-flight skips the check rather than assuming headroom.
    mandateMaxAmountMinor: bigint("mandate_max_amount_minor", { mode: "bigint" }),
    mandateCurrency: text("mandate_currency"),
    /**
     * Where the INSTRUMENT was issued (ISO-3166-1 alpha-2, upper case).
     *
     * RBI's e-mandate and AFA rules bind cards issued in India, so this is what makes
     * "is this an Indian card" a fact rather than the currency-shaped guess it was.
     * NULL means UNKNOWN, never "not India" — see migration 0250 and
     * `debitNeedsBuyerAuthentication`, which only lets a KNOWN foreign issuer suppress
     * a claim and never lets an unknown one create silence.
     */
    issuerCountry: text("issuer_country"),
    /**
     * ⚠️ A CAPABILITY, NOT AN ORIGIN. RazorPay's `card.international` is documented as a
     * "card usage restriction — supports international transactions". It does NOT say
     * where the instrument was issued; `issuerCountry` does.
     */
    supportsInternational: boolean("supports_international"),
    /** `consumer` | `business`, verbatim — the gateways disagree on spelling. */
    instrumentSubType: text("instrument_sub_type"),
    /**
     * Whether the instrument can do recurring at all (RazorPay `card.flows.recurring`).
     * A mandate on one that cannot is a renewal that never collects.
     */
    supportsRecurring: boolean("supports_recurring"),
    /** `credit` | `debit` | `prepaid` | … as the gateway spells it, lower-cased. */
    instrumentFunding: text("instrument_funding"),
    /** The issuing bank / PSP as the gateway NAMES it — the three spell it differently. */
    issuerName: text("issuer_name"),
    /**
     * The same underlying instrument across customers and accounts. Stripe only: it
     * fingerprints bank accounts and SEPA debits as well as cards. RazorPay has no
     * equivalent and PayPal's v3 schema has no such field.
     */
    instrumentFingerprint: text("instrument_fingerprint"),
    /** Whether the CARD can do 3DS at all — card-shaped by nature, named so. */
    threeDSecureSupported: boolean("three_d_secure_supported"),
    /** Provider-native rail: razorpay `upi` | `card` | `emandate` | `nach`. */
    mandateRail: text("mandate_rail"),
    /** Provider-reported state; only `confirmed` can be debited off-session. */
    mandateStatus: text("mandate_status"),
    /** When the event that set `mandate_status` happened; an older event is not applied (0395). */
    mandateStatusAt: timestamp("mandate_status_at", { withTimezone: true }),
    mandateExpiresAt: timestamp("mandate_expires_at", { withTimezone: true }),
    mandateReference: text("mandate_reference"),
    // Free-form annotations; imported rows carry { source, source_id, gateway_account_id }.
    metadata: jsonb("metadata"),
    /**
     * What the gateway said about the address and CVC when this card was vaulted or
     * charged (0245). We sent the address all along and never read the verdict back, so an
     * AVS-driven decline could not be explained to a merchant.
     *
     * NULL means the gateway told us nothing — deliberately distinct from a pass or a
     * fail, the same distinction `vat_number_status: 'not_validated'` draws on customers.
     * Text, not an enum: the three rails spell their verdicts differently
     * (pass/fail/unavailable/unchecked) and a new rail should not need a migration.
     */
    avsLine1Check: text("avs_line1_check"),
    avsPostalCheck: text("avs_postal_check"),
    cvcCheck: text("cvc_check"),
    /** When those verdicts were captured — without it a stale check reads as current. */
    avsCheckedAt: timestamp("avs_checked_at", { withTimezone: true }),
    /**
     * When the card's number or expiry last changed on this row (a re-vault, or a card
     * updater event). A do-not-retry decline blocks re-presenting the card until then
     * (`presentationBlock`); null means never changed since it was saved.
     */
    credentialsChangedAt: timestamp("credentials_changed_at", { withTimezone: true }),
    /**
     * When the payer last gave authority on this instrument again (0481): a re-vault that
     * moved the row onto a new token, or a mandate going live. Clears a revoked-mandate
     * block (`representment.ts`).
     */
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    /**
     * The add-card call's `collect_open_invoices` (0502), read again when a mandate on
     * this method goes live. Null = the business rule (`collect_on_payment_method_update`).
     */
    collectOpenInvoices: boolean("collect_open_invoices"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("payment_methods_public_id_uq").on(t.publicId),
    // One row per provider-side instrument (0183). Two paths vault the SAME token by
    // design — the buyer's browser completing the add-card, and the setup-intent
    // webhook harvest for the buyer who never came back — and without this a UPI
    // mandate landed twice, 15s apart. `persistVaultedPaymentMethod` reads first and
    // refreshes what it finds; this is what makes a genuine race a no-op too.
    uniqueIndex("payment_methods_provider_pm_uq").on(
      t.customerId,
      t.providerKey,
      t.providerPaymentMethodId,
    ),
    index("payment_methods_customer_idx").on(t.customerId),
    // The card-expiry sweep's candidates (0348).
    index("payment_methods_expiry_sweep_idx")
      .on(t.expYear, t.expMonth)
      .where(sql`status IN ('valid', 'expiring')`),
    index("payment_methods_mandate_sweep_idx")
      .on(t.mandateExpiresAt)
      .where(sql`status IN ('valid', 'expiring') AND mandate_expires_at IS NOT NULL`),
  ],
);

/**
 * One provider-side customer per (customer × provider × gateway account) —
 * created on first need, then REUSED. Without this every ensureCustomer call
 * minted a brand-new Stripe/PayPal customer (visible as duplicate customers in
 * the provider dashboard, and it broke SetupIntent completion).
 */
export const providerCustomers = pgTable(
  "provider_customers",
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
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(), // stripe | razorpay | paypal | tmtest
    /** Null for legacy env-configured providers (no gateway_accounts row). */
    gatewayAccountId: uuid("gateway_account_id"),
    providerCustomerId: text("provider_customer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    // One mapping per customer × provider × gateway account (nulls distinct is
    // fine: legacy env-provider rows are keyed by provider_key alone in practice).
    uniqueIndex("provider_customers_scope_uq").on(t.customerId, t.providerKey, t.gatewayAccountId),
    index("provider_customers_org_idx").on(t.organizationId),
    index("provider_customers_customer_idx").on(t.customerId),
  ],
);
