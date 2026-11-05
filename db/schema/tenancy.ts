import {
  pgTable,
  uuid,
  text,
  char,
  jsonb,
  bigint,
  integer,
  smallint,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import type { BusinessCreditConfig } from "./credits";
import { sql } from "drizzle-orm";

/**
 * The account hierarchy (multi-tenancy):
 *
 *   Organization  → the account that uses tmbilling. Holds API keys.
 *                   `organization_id` is the HARD isolation boundary (RLS).
 *     └─ Business  → an org has many; each is independent (own catalog,
 *                    branding, customers, payment-provider config).
 *          └─ Customer → Subscription   (added in Phase 1)
 */

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // org_…
    name: text("name").notNull(),
    /**
     * `active` | `restricted`. Anything but `active` makes the organization READ-ONLY
     * (`authenticate`), set by account billing (0354). Its own billing clock is untouched, so its
     * customers keep being billed.
     */
    status: text("status").notNull().default("active"),
    /**
     * Why it is read-only (0356): `unpaid` (its plan is unpaid; lifted when paid) or `over_limit`
     * (staff approved it after the org billed more than its plan covers; lifted by staff or by a
     * plan that covers its volume). Each rule lifts only its own reason. NULL while `active`.
     */
    restrictedReason: text("restricted_reason"),
    /** When this calendar month's live volume first passed the plan's limit; NULL within it (0356). */
    overLimitSince: timestamp("over_limit_since", { withTimezone: true }),
    /**
     * Is this organization the PLATFORM's own — i.e. us, not a customer?
     *
     * The only thing that separates a tmbilling operator from a tenant. Every route under
     * `/v1/ops/*` is platform-global by design (the estate-wide clock, error and
     * invariant surfaces), and before 0196 the sole gate was "the key's mode is 'all'" —
     * which `createOrganization` grants to every organization at signup. See
     * `requirePlatformOps`.
     *
     * Defaults FALSE and is never backfilled, so the gate fails closed.
     */
    isPlatform: boolean("is_platform").notNull().default(false),
    /**
     * Which currency an analytics screen opens on (0268).
     *
     * Money is held per currency and never summed across them, so every money question on a
     * multi-currency book has no default and can only refuse, naming the options. Correct,
     * and a poor way to open a page. This answers "which one did you mean" once.
     *
     * It converts nothing and makes nothing summable — it only chooses what is shown first,
     * and an explicit `currency=` on a request still wins. NULL is a real state: an
     * organization that has never chosen still gets the refusal, and defaulting it would
     * silently label a figure with a currency nobody picked.
     */
    baseCurrency: char("base_currency", { length: 3 }),
    /**
     * Rates against `baseCurrency`, as `{"USD": 83.2}` — read as **1 base = rate x other**,
     * so an amount in USD becomes `amount / rate`. The same convention and the same shape as
     * `businesses.exchangeRates`, which is quoted against the BUSINESS's default and therefore
     * cannot answer an account-wide question.
     *
     * A currency with no rate is EXCLUDED from a converted total and named, never zeroed and
     * never converted at a guess.
     */
    exchangeRates: jsonb("exchange_rates"),
    /**
     * Per-currency provenance for `exchangeRates` (0269), in exactly the shape
     * `businesses.exchangeRateSources` uses:
     * `{ USD: { source: 'auto'|'manual', updated_at: ISO|null, provider: 'ecb'|null,
     *           last_error: string|null } }`
     *
     * The FX refresher maintains the `auto` currencies on the same twice-daily pass that
     * refreshes the business rates. A currency holding a rate with no entry here reads as
     * `manual` and is never overwritten.
     */
    exchangeRateSources: jsonb("exchange_rate_sources"),
    /**
     * The REGISTERED entity, for invoices issued under the organization rather than the
     * business (`businesses.invoice_issuer`). Separate from `name`, which is what the
     * operator calls the account in our UI: the entity on a tax document is "GoX
     * Technologies Pvt. Ltd.", the account is "GoX". Null falls back to `name`.
     */
    legalName: text("legal_name"),
    /** Same jsonb shape as `businesses.address`, so one renderer serves both. */
    address: jsonb("address"),
    taxRegistrationNumber: text("tax_registration_number"), // GSTIN / VAT id
    /** Square logo for the dashboard sidebar (0322); an https URL, like `businesses.icon_url`. */
    iconUrl: text("icon_url"),
    /**
     * API requests allowed per minute, per API key of this organization (#6).
     *
     * NULL = the deployment default (`RATE_LIMIT_PER_MINUTE`), which is what every
     * organization gets until someone raises or lowers it deliberately. Stored per
     * ORG rather than per key so a limit is a commercial decision about an account,
     * while the counter it feeds is per key so one runaway integration cannot lock an
     * operator out of the dashboard.
     *
     * 0 is a meaningful value: it blocks the organization's API traffic outright,
     * which is a softer tool than revoking every key. Enforced by a CHECK ≥ 0.
     */
    rateLimitPerMinute: integer("rate_limit_per_minute"),
    /**
     * 0450: usage ingest requests per second, shared by every key of the org (a batch is one
     * request). NULL = `USAGE_INGEST_RATE_PER_SECOND`. 0 stops ingest. CHECK ≥ 0.
     */
    ingestRateLimitPerSecond: integer("ingest_rate_limit_per_second"),
    /**
     * IANA timezone for ORG-SCOPED screens — the org-level mirror of
     * `businesses.timezone` below (same shape: nullable text, no default).
     *
     * NULL = UTC, which is exactly what `/ops`, `/audit` and `/developer` rendered
     * before this column existed, so every org that never sets one is unchanged.
     *
     * It is a DISPLAY preference and nothing else. No billing arithmetic reads it:
     * term boundaries, whole-day proration and calendar analytics all key off the
     * BUSINESS zone, because an organization spans many businesses and no single
     * zone can anchor their billing days. Validated + normalized to the modern IANA
     * spelling by `src/platform/timezones.ts`, same as the business column.
     */
    timezone: text("timezone"),
    /**
     * "Require two-factor authentication" (0329). Members without 2FA keep access until the end
     * of the day, in `timezone`, `mfaGraceDays` after `mfaRequiredSince`; then the API refuses
     * their session. API keys are unaffected. `src/modules/auth/org-two-factor.ts` owns the rule.
     */
    requireMfa: boolean("require_mfa").notNull().default(false),
    mfaRequiredSince: timestamp("mfa_required_since", { withTimezone: true }),
    /** FK to users(id) ON DELETE SET NULL lives in the SQL; declaring it here would cycle the imports. */
    mfaRequiredBy: uuid("mfa_required_by"),
    mfaGraceDays: integer("mfa_grace_days").notNull().default(7),
    /**
     * Org overrides of the deployment's session lifetimes and MFA roles (0482). Stricter only:
     * the effective value is the shorter window / the union of roles. NULL = the deployment's.
     * `src/modules/auth/session-policy.ts` owns the rule.
     */
    sessionIdleMinutes: integer("session_idle_minutes"),
    sessionAbsoluteTtlHours: integer("session_absolute_ttl_hours"),
    mfaRequiredRoles: text("mfa_required_roles").array(),
    /**
     * Live-mode lock (0354): `locked` | `enabled`. `locked` refuses writes to the org's LIVE
     * businesses (`authenticate`). Since 0356 nothing locks automatically: a sign-up starts
     * `enabled` on the Free plan, and `locked` is a staff tool only.
     */
    liveAccess: text("live_access").notNull().default("enabled"),
    liveAccessEnabledAt: timestamp("live_access_enabled_at", { withTimezone: true }),
    /**
     * What enabled it: `plan:free`, `plan:<subscription>`, or the staff email (an agreement).
     * NULL on an organization made before sign-up, which is also an agreement.
     */
    liveAccessEnabledBy: text("live_access_enabled_by"),
    /** ISO country from sign-up (0354). */
    country: char("country", { length: 2 }),
    /** The sign-up form's optional answers: `{ billing_volume, gateway }` (0354). */
    signupAnswers: jsonb("signup_answers"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("organizations_public_id_uq").on(t.publicId)],
);

/**
 * A business is an independent billing unit under an organization. Customers,
 * catalog, and payment-provider configuration all hang off a business.
 */
export const businesses = pgTable(
  "businesses",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // biz_…
    name: text("name").notNull(),
    // Test businesses are sandboxes: test API keys only reach test businesses,
    // live keys only live ones ('all' keys reach both). Immutable after creation.
    livemode: text("livemode").notNull().default("live"), // live | test
    /**
     * Test mode of a live business (0342). Set on the TEST row and points at its live
     * twin; null on live rows and on legacy standalone test businesses. The twin starts
     * as a copy of live's settings and is independent after that.
     */
    liveBusinessId: uuid("live_business_id"),
    // Constant 'live' so the FK below can reference (id, livemode): the twin's parent
    // must BE a live business. Never read by application code.
    liveBusinessMode: text("live_business_mode").generatedAlwaysAs(sql`'live'::text`),
    /**
     * Test businesses only (0406): staff override of the customer / subscription limit.
     * Null = the edition default (`tenancy/test-limits.ts`); 0 = no limit.
     */
    testCustomerLimit: integer("test_customer_limit"),
    testSubscriptionLimit: integer("test_subscription_limit"),
    // A business bills in its own default currency (others allowed per price).
    defaultCurrency: char("default_currency", { length: 3 }).notNull(), // required (0499)
    // Currencies this business transacts in (ISO-4217 codes). Drives the currency
    // pickers in the dashboard; null = no restriction (any ISO currency).
    currencies: jsonb("currencies"), // string[] | null
    // Manual reporting FX rates keyed by currency: 1 default_currency = rate ×
    // that currency. Used ONLY to convert dashboard/report roll-ups to the
    // default currency — never to rate or settle charges.
    exchangeRates: jsonb("exchange_rates"), // Record<string, number> | null
    /**
     * Per-currency PROVENANCE for `exchangeRates` (0229) — where each rate came from and
     * when it last moved:
     * `{ INR: { source: 'auto'|'manual', updated_at: ISO|null, provider: 'ecb'|null,
     *           last_error: string|null } }`
     *
     * A currency ABSENT from this map is `manual`, which is what every rate written before
     * 0229 is. Kept beside `exchangeRates` rather than folded into it so that metrics, the
     * importer, `serializeBusiness` and the 0228 invoice stamp all keep reading the shape
     * they already read — see the migration for the full argument.
     */
    exchangeRateSources: jsonb("exchange_rate_sources"),
    // Allowed billing frequencies for this business's prices. Array of { interval,
    // count } where interval is day|week|month|year — e.g. daily = {day,1}, 14 days =
    // {day,14}, monthly = {month,1}, yearly = {year,1}, 10 years = {year,10}. Enforced
    // in createPrice. null = no restriction (any interval/count). Drives the catalog
    // price pickers.
    billingFrequencies: jsonb("billing_frequencies"), // Array<{ interval: string; count: number }> | null
    // Default gateway account for the router when >1 account matches (GW-2).
    // Payment-provider config now lives in gateway_accounts (C1).
    defaultGatewayAccountId: uuid("default_gateway_account_id"),
    status: text("status").notNull().default("active"),
    // Profile (appears on invoices / emails / portal).
    address: jsonb("address"), // { line1, line2, city, state, postal_code, country }
    contactEmail: text("contact_email"),
    supportEmail: text("support_email"),
    phone: text("phone"),
    website: text("website"),
    // Brand Styles (0185) — the identity a business shows ITS OWN customers, on the
    // hosted portal, hosted checkout, billing email and invoice documents. Three
    // images because they are different shapes: a wide wordmark, a square mark for
    // where a wordmark cannot fit, and the browser tab. Consumers fall back
    // logo → icon → initials, so a business with only one of them still works.
    logoUrl: text("logo_url"),
    iconUrl: text("icon_url"),
    faviconUrl: text("favicon_url"),
    // `#RRGGBB`. Maps to `--primary` (the accent — links and marks, never a button
    // fill) on the STOREFRONT document only; the operator dashboard's identity is
    // ours, not the tenant's.
    brandColor: text("brand_color"),
    /**
     * May a BUYER type a coupon code on the hosted pages (checkout + portal)? 0238.
     *
     * Off by default and left off for every existing business: a promo box on a signup
     * page invites code-hunting, which is the merchant's conversion decision, not ours.
     *
     * It gates the SURFACE, not the coupon. A code a buyer enters is still subject to
     * everything the coupon carries — `valid_from`, `redeem_by`, `max_redemptions`, and
     * the CAT-2 item constraints — so a merchant who wants a code limited to one segment
     * limits it on the coupon, and should not rely on this flag to hide it.
     */
    allowCustomerCoupons: boolean("allow_customer_coupons").notNull().default(false),
    // 0495: coupon codes a buyer can enter on one checkout or one subscription (1–10).
    maxCustomerCouponCodes: smallint("max_customer_coupon_codes").notNull().default(1),
    timezone: text("timezone"),
    /**
     * Reporting calendar (0293) — where analytics cuts weeks, quarters and years. Never a
     * billing input. See `src/platform/business-calendar.ts`.
     */
    weekStart: text("week_start").notNull().default("sunday"),
    /** 1–12; 1 is the calendar year. */
    fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
    // Billing mode, as TWO independent granularities. One flag cannot express the
    // three combinations that mean anything:
    //   instant + exact      → millisecond-based (our default)
    //   instant + whole_day  → whole-day proration off an exact anchor
    //   day     + whole_day  → day-based throughout
    // 'day' + 'exact' is incoherent and is rejected at the write layer.
    //
    // anchorGranularity — where a term STARTS. 'instant': the exact creation instant.
    // 'day': floored to the start of the day in `timezone`, and the term END is
    // reported inclusively (…T23:59:59.999).
    anchorGranularity: text("anchor_granularity").notNull().default("instant"), // instant | day; see AnchorGranularity
    // prorationGranularity — how mid-term credits/charges are measured. 'exact': by
    // elapsed time. 'whole_day': by whole billing days, where a billing day runs from
    // the term start's time-of-day (for day-anchored terms that is local midnight).
    prorationGranularity: text("proration_granularity").notNull().default("exact"), // exact | whole_day
    taxRegistrationNumber: text("tax_registration_number"), // GSTIN / VAT id
    /**
     * Whose name, address and tax id head the invoice — 'business' (default, and exactly
     * the old behaviour) or 'organization'. Several businesses billing under one
     * registered company is the common Indian shape: the GSTIN belongs to the entity, and
     * a buyer claiming input tax credit needs the invoice to name it.
     *
     * Brand and contact stay with the BUSINESS either way — logo, support email, website,
     * timezone. Those are presentation, not legal identity, and a shared entity does not
     * mean a shared support desk.
     */
    invoiceIssuer: text("invoice_issuer").notNull().default("business"), // business | organization
    // Default HSN/SAC classification for everything this business sells — India's GST
    // tax invoice must carry one per line. Most SaaS businesses sell one kind of service
    // and set only this; `products.tax_code` overrides it per product. Nullable because
    // the code is jurisdiction-specific and a non-India business has nothing to put here.
    defaultTaxCode: text("default_tax_code"),
    // Default price type for new prices. Seeds `prices.tax_behavior`; the price
    // still decides for itself.
    defaultTaxBehavior: text("default_tax_behavior").notNull().default("exclusive"), // exclusive | inclusive
    /**
     * Tax settings (0489): price type per currency, seller tax id per destination country and
     * the rounding rule. NULL / absent key = today's behaviour. Resolver: resolveTaxSettings.
     */
    taxSettings: jsonb("tax_settings"),
    /** Staff alerts and the daily digest (0489). NULL = none. Resolver: resolveTeamAlertsConfig. */
    teamAlertsConfig: jsonb("team_alerts_config"),
    // Invoice configuration: prefix + per-business sequential number.
    invoicePrefix: text("invoice_prefix").notNull().default("INV"),
    invoiceNextNumber: bigint("invoice_next_number", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    defaultInvoiceNotes: text("default_invoice_notes"),
    // Fallback Net-D terms when neither subscription nor customer sets one.
    defaultDueDays: integer("default_due_days"),
    // Dunning retry offsets in days after a failed charge (null = engine default [1,3,5,7]).
    dunningRetryDays: jsonb("dunning_retry_days"),
    // Structured dunning config (E3/INV-3): { retries: [{after_days}], final_action:
    // { invoice: not_paid|void|write_off, subscription: cancel|retain } }. When set,
    // its retries override dunning_retry_days; null = derive from dunning_retry_days
    // + default final action (invoice not_paid, subscription cancel).
    dunningConfig: jsonb("dunning_config"),
    // Credits Flexibility (0219) — whether, and up to how much, REFUNDABLE credits and
    // EXCESS payments auto-apply to an invoice. Four slots (kind × invoice class), each
    // { mode: auto|none|limit, limit_minor? }:
    //   { "refundable": { "recurring": {…}, "one_time": {…} },
    //     "excess":     { "recurring": {…}, "one_time": {…} } }
    // NULL / absent / malformed → auto-apply, unlimited, everywhere — the behaviour every
    // business had before this column existed. Promotional credit is deliberately NOT
    // covered. Resolved by resolveCreditsFlexibility
    // (src/modules/customers/credits-flexibility.ts).
    creditsFlexibility: jsonb("credits_flexibility"),
    // Customer-facing billing emails (opt-in): { enabled, fromName?, fromAddress?,
    // replyTo?, types?: { <email_type>: bool } }. NULL / absent → disabled (no emails
    // sent), so importing/existing businesses stay silent until a merchant turns it on.
    // Resolved by resolveEmailConfig (src/modules/emails/config.ts).
    //
    // This is sender IDENTITY (who the mail claims to be from). Transport — which relay
    // actually carries it — is smtp_config below. They are separate because a merchant
    // chooses the identity but the relay constrains it: a From address the relay will not
    // authorise is a bounce, not a preference.
    emailConfig: jsonb("email_config"),
    // Mandate sizing (F-45 follow-up): { headroom_bps?, rail_ceiling_cap_minor? }. NULL /
    // absent / malformed key → the platform default (MANDATE_HEADROOM_BPS = 35_000n i.e.
    // 3.5×, and SMALLEST_RAIL_CEILING_CAP_MINOR, NPCI's UPI Autopay cap). Mirrors
    // dunning_config: a nested settings object with a pure resolver
    // (resolveMandateHeadroomConfig, src/modules/payment-methods/service.ts) that gives
    // every absent or malformed key a documented default, so no existing business's
    // mandate ceilings change until it sets one.
    mandateConfig: jsonb("mandate_config"),
    // Per-business SMTP transport, non-secret half: { enabled, host, port, encryption,
    // username }. NULL / enabled:false → this business falls back to the deployment-wide
    // MAILER_PROVIDER. `encryption` is tls | starttls | none (see SmtpEncryption in
    // src/providers/mailer/smtp.ts for why it is not a `secure` boolean).
    // Resolved by resolveSmtpConfig (src/modules/emails/smtp-config.ts).
    smtpConfig: jsonb("smtp_config"),
    // The secret half: encryptCredentials({ password }) from platform/secrets, same
    // envelope and rotation path as gateway_accounts.credentials_enc. Split from
    // smtp_config so the dashboard can render host/port/username without holding a key,
    // and so a config read is never a decrypt.
    smtpCredentialsEnc: text("smtp_credentials_enc"),
    // Per-business Amazon SES transport, non-secret half: { enabled, region, accessKeyId,
    // configurationSet }. The API alternative to smtp_config above — a business configures
    // one or the other, never both at once (enforced by businesses_mail_transport_ck).
    // NULL / enabled:false → falls back to the deployment-wide MAILER_PROVIDER.
    // Resolved by resolveSesConfig (src/modules/emails/ses-config.ts).
    sesConfig: jsonb("ses_config"),
    // The secret half: encryptCredentials({ secretAccessKey }) — same envelope
    // and rotation path as smtp_credentials_enc and gateway_accounts.credentials_enc, so
    // `pnpm gateway:rotate-credentials` covers SES keys with no second mechanism.
    sesCredentialsEnc: text("ses_credentials_enc"),
    // Pending invoices (E2/INV-1): business default for subscriptions.create_pending_invoices,
    // and how many days after the period an open pending invoice auto-closes (null = never).
    createPendingInvoices: boolean("create_pending_invoices").notNull().default(false),
    autoClosePendingAfterDays: integer("auto_close_pending_after_days"),
    // Invoice round-off (E6/INV-5): none | nearest_unit (round the post-tax total to
    // the nearest whole currency unit, booking the delta to a `rounding` line).
    invoiceRounding: text("invoice_rounding").notNull().default("none"),
    /**
     * `{ "<CUR>": <minor> }` (0482): above the amount an invoice in that currency is not paid
     * by card. NULL or an absent currency = no limit. Resolver: `invoicing/card-limit.ts`.
     */
    cardPaymentLimits: jsonb("card_payment_limits"),
    // H1 (SET-1..3) billing-rule defaults consumed by E/F when the request omits them.
    // Change defaults (E proration):
    // Post-H (#8): defaults reverted to pre-H "do nothing extra" behavior —
    // NOT NULL DEFAULT true silently turned free operations into billed ones.
    // Both behaviors stay available as explicit per-business overrides.
    defaultProrateOnChange: boolean("default_prorate_on_change").notNull().default(false),
    defaultInvoiceImmediately: boolean("default_invoice_immediately").notNull().default(false),

    /**
     * Whether an invoice inherits its subscription's `po_number` (0246).
     *
     * Correct behaviour — a PO on a subscription exists so its invoices carry it. It is
     * a COLUMN rather than just the behaviour because turning it
     * on changes a printed document for a business that changed nothing, and a PO
     * appearing on invoices that never had one can break a buyer's reconciliation.
     *
     * DEFAULT true, and 0246's migration sets every business that existed at that point to
     * false. So new businesses inherit and existing ones keep their old output until
     * someone flips them. Read by `poInheritanceEnabled` (modules/invoicing/service.ts).
     */
    inheritSubscriptionPoNumber: boolean("inherit_subscription_po_number").notNull().default(true),
    // Cancel defaults (F): cancel_option + credit + unbilled handling.
    defaultCancelOption: text("default_cancel_option").notNull().default("immediately"), // immediately | end_of_term
    defaultCreditOptionForCancel: text("default_credit_option_for_cancel")
      .notNull()
      .default("none"), // none | prorate | full (none = no auto-credit)
    defaultUnbilledOnCancel: text("default_unbilled_on_cancel").notNull().default("no_action"), // no_action | invoice | delete
    /**
     * The other two halves of cancel-time money handling (0242). Both have been accepted
     * PER CALL since F — `account_receivables_handling` / `refundable_credits_handling` on
     * POST …/cancel, honoured by applyCancelMoneyHandling — with no business default, so
     * every caller had to restate the merchant's policy.
     *
     * Defaults are the fallback the service already applies (`?? "no_action"`): retain
     * as unpaid, retain credits.
     */
    defaultArHandlingOnCancel: text("default_ar_handling_on_cancel").notNull().default("no_action"), // no_action | schedule_payment_collection | write_off | void
    defaultRefundableCreditsOnCancel: text("default_refundable_credits_on_cancel")
      .notNull()
      .default("no_action"), // no_action | schedule_refund
    /**
     * Invoice-now vs retain-as-unbilled, per lifecycle event (0242). We had one boolean,
     * `defaultInvoiceImmediately`, resolved by
     * defaultInvoiceImmediately() for adds / changes / one-time charges. Cancel and resume
     * already carry their own option, so this blob governs only the events that still
     * share that flag. Resolver: resolveUnbilledChargesConfig.
     *
     * ⚠️ Unrelated to `createPendingInvoices` above, despite reading alike — that one is
     * renewal-pending for usage collection and is read only in renewal.ts.
     */
    unbilledChargesConfig: jsonb("unbilled_charges_config"),
    /**
     * Pause / resume defaults (0242). The operations are shipped and core but were driven
     * entirely by per-call arguments, so two integrations against one business could pause
     * differently. Seven keys plus an advisory `locked` list (a default can be marked
     * locked against override; the list is stored so it is expressible, and is inert until
     * enforcement lands). Resolver: resolvePauseConfig.
     */
    pauseConfig: jsonb("pause_config"),
    /**
     * Billing rules (0481): trial-end action, a date-specific cancel's final period,
     * required reasons, a failed change charge, new-customer auto-collection and a revoked
     * mandate. NULL / absent key → today's behaviour. Resolver: resolveBillingRulesConfig.
     */
    billingRulesConfig: jsonb("billing_rules_config"),
    /**
     * Invoice rules (0486): small invoices and charge timing under net terms.
     * NULL / absent key → today's behaviour.
     * Resolver: resolveInvoiceRulesConfig.
     */
    invoiceRulesConfig: jsonb("invoice_rules_config"),
    /**
     * Backdating window (0242). Backdating works and is UNBOUNDED — the long-standing
     * "backdate window not enforced" gap, and the one correctness item in this set:
     * an unbounded backdate can post an invoice into a closed period.
     *
     * Defaults are permissive on purpose (everything allowed, no cut-off day) so the
     * column cannot retroactively refuse a backdate that succeeded before it existed.
     * Resolver: resolveBackdatingConfig.
     */
    backdatingConfig: jsonb("backdating_config"),
    /**
     * 0243 sweep. Each default is what the engine does today, so an untouched business is
     * unchanged.
     */
    /** `voidInvoice` raises no credit note today. */
    defaultCreditNoteOnVoid: boolean("default_credit_note_on_void").notNull().default(false),
    /**
     * Phrased positively on purpose: a column whose TRUE value means "do less" reads
     * wrong at every call site. True = validate, which is
     * today's behaviour (`modules/customers/vies.ts`). The point is the escape hatch — VIES
     * is third-party and goes down.
     */
    viesValidationEnabled: boolean("vies_validation_enabled").notNull().default(true),
    /**
     * Scale a fixed-amount coupon by the term fraction. False = today's behaviour, so
     * this adds a setting, not a fix.
     *
     * ⚠️ Fixes only the merchant-loss half. A proration invoice still decrements
     * `remaining_periods`, so a multi-month coupon can be spent early by plan changes —
     * open, no setting behind it. See docs/PROGRESS.md.
     */
    prorateFixedAmountCoupons: boolean("prorate_fixed_amount_coupons").notNull().default(false),
    /**
     * What the checkout and portal DO: zero-value lines, PO-number collection, and the
     * default return/cancel URLs the mint currently requires on every call. Resolver:
     * resolveStorefrontConfig.
     */
    storefrontConfig: jsonb("storefront_config"),
    /**
     * What happens to invoices and subscriptions when a chargeback lands (0244). We
     * already ingest disputes with a full lifecycle and ledger-accurate postings and act
     * on none of them; this is the policy. Every default is record-only, i.e. today.
     *
     * The invoice action applies to LOST only, and the only value is a DOCUMENTARY credit
     * note (`createRefundedCreditNote`, which books no ledger entries) — marking the
     * invoice Not Paid is absent because it would resurrect AR with no matching
     * entry. Reasons in full: db/migrations/0244_chargeback_management.sql.
     *
     * Resolver: resolveChargebackConfig.
     */
    chargebackConfig: jsonb("chargeback_config"),
    /**
     * Which checkout fields show, hide, or are required (0245). THREE states — richer
     * variants would need a value channel or a shipping address we do not have. Keys are
     * `<section>.<field>`; defaults are NOT uniform (line1, city, state_code, postal_code,
     * country mandatory since 0334; the rest show). Country is never `hide`.
     *
     * This is also the AVS capability: making `billing.postal_code` mandatory is what
     * switches on ZIP verification, since AVS is checked gateway-side. See
     * db/migrations/0245_checkout_fields_and_avs.sql.
     *
     * Resolver: resolveCheckoutFieldConfig.
     */
    checkoutFieldConfig: jsonb("checkout_field_config"),
    /**
     * Which billing-detail fields the buyer portal shows, hides, requires or shows
     * read-only (0334). NULL = the portal form's old requiredness. Hidden and read-only
     * keys keep the stored value on a portal save.
     *
     * Resolver: resolvePortalFieldConfig.
     */
    portalFieldConfig: jsonb("portal_field_config"),
    // What the printed invoice / credit note SHOWS (0239): field toggles, titles,
    // seller-address format, signature, business-wide credit-note note, and the
    // dynamic-prefix half of numbering. NULL / absent / malformed key → exactly what the
    // renderers did before this column existed, via the pure resolver
    // resolveInvoiceCustomization (src/modules/invoicing/customization.ts).
    //
    // Governs the DOCUMENT only. `serialize.ts` is untouched: hiding the customer id on
    // the PDF must not remove it from the API resource.
    invoiceCustomization: jsonb("invoice_customization"),
    /** Metadata key rules strict mode per entity (0332). NULL = off for both. */
    metadataRulesConfig: jsonb("metadata_rules_config"),
    /**
     * Reminder lead days per kind (0376): { trial_ending, renewal, renewal_yearly,
     * cancellation: number[], changed_at }. NULL / absent / malformed list → the default
     * (3, 5, 30, 5), which is what every business had before. Resolver: resolveReminderConfig.
     */
    reminderConfig: jsonb("reminder_config"),
    /** Credit grants and holds (0464). NULL / absent key → the API's default. */
    creditConfig: jsonb("credit_config").$type<BusinessCreditConfig>(),
    // SET-3 credit-note numbering (mirrors invoice_prefix/next_number).
    creditNotePrefix: text("credit_note_prefix").notNull().default("CN"),
    creditNoteNextNumber: bigint("credit_note_next_number", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    // 0454: extra minutes (0–24) before a period's usage closes, for apps that buffer events.
    usageCloseDelayMinutes: smallint("usage_close_delay_minutes").notNull().default(0),
    // 0476: origins allowed to call the embeddable usage widget (CORS).
    usageWidgetOrigins: text("usage_widget_origins")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // 0477: set when the first limit, alert, auto top-up or threshold is created; until then
    // ingest skips the usage-control dirty mark.
    usageControlsActive: boolean("usage_controls_active").notNull().default(false),
    // Receipt numbering (0387): one series per business, batch-numbered.
    receiptPrefix: text("receipt_prefix").notNull().default("RCPT"),
    receiptNextNumber: bigint("receipt_next_number", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    uniqueIndex("businesses_public_id_uq").on(t.publicId),
    index("businesses_org_idx").on(t.organizationId),
    // Not a uniqueness rule of its own (`id` is already the PK) — it exists so other
    // tables can FK to (id, livemode) and have Postgres itself enforce "this row's
    // livemode is the one its business actually has". See webhook_endpoints below.
    unique("businesses_id_livemode_uq").on(t.id, t.livemode),
    // One test twin per live business; deleting the live business deletes its twin.
    uniqueIndex("businesses_live_business_uq").on(t.liveBusinessId),
    foreignKey({
      name: "businesses_live_business_fk",
      columns: [t.liveBusinessId, t.liveBusinessMode],
      foreignColumns: [t.id, t.livemode],
    }).onDelete("cascade"),
  ],
);

/**
 * Billing-mode axes, declared next to the columns they type so tenancy (which writes
 * them) and subscriptions (which reads them) share one definition. The legal pairs are
 * enforced by the businesses_billing_mode_ck CHECK constraint; the behavior each pair
 * produces is documented in src/modules/subscriptions/billing-mode.ts.
 */
export type AnchorGranularity = "instant" | "day";
export type ProrationGranularity = "exact" | "whole_day";

/**
 * API keys authenticate an organization (org-level; a key can reach all of the
 * org's businesses). We store only a hash of the secret; the raw key is shown
 * once at creation. `prefix` is a non-secret display fragment.
 *
 * `kind` splits the two things a credential can be, because they must not read
 * the same way in the audit trail:
 *  - `api`       — a key the organization minted for its own integrations. Its
 *                  requests are third-party API traffic: `source='api'`,
 *                  `actor=<key_…>`, and it is what `GET /v1/api_keys` lists.
 *  - `dashboard` — the bootstrap credential created with the organization, which
 *                  our own dashboard operates with. Attributing its requests to a
 *                  key id would file every click an operator makes as an API
 *                  integration call, so it reports as `source='dashboard'` with the
 *                  SIGNED-IN USER as the actor (`src/platform/auth.ts` resolves the
 *                  forwarded `tmb_session`), and it is hidden from the org's
 *                  API-key list and cannot be revoked through the API — revoking it
 *                  would lock the dashboard out of the org.
 * There is exactly one dashboard credential per organization today (minted by
 * `createOrganization`); nothing mints a second one over the API.
 *
 * `livemode` is `test | live | all`, and `all` — the ONE credential that crosses the
 * test/live partition — is confined to `kind='dashboard'`
 * by `api_keys_mode_kind_ck`. Our dashboard has to span both partitions because it is
 * one UI over the whole organization; an integration never does, and an `sk_all_` key
 * in a customer's hands is a partition breach waiting for a code path to make it.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // key_…
    /**
     * What this key is FOR, chosen at mint time. Nullable because every key minted before
     * 0248 was never named, and not unique because two keys legitimately share a name while
     * one is being rotated out.
     */
    name: text("name"),
    prefix: text("prefix").notNull(),
    hashedKey: text("hashed_key").notNull(),
    livemode: text("livemode").notNull().default("test"), // test | live
    kind: text("kind").notNull().default("api"), // api | system
    /**
     * What the key may DO: 'read' (GET, plus the handful of genuinely non-mutating POSTs) or
     * 'write' (everything the organization can do). Audit H1.3.
     *
     * Defaults to 'write' because every key minted before this existed had full privilege, and
     * a migration must not narrow a live integration into failure. New keys choose.
     */
    scope: text("scope").notNull().default("write"), // read | write
    /** Written by `markApiKeyUsed` at most once per key per LAST_USED_WINDOW_MS. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** 0374: null = never. Past it, auth refuses the key exactly as it refuses a revoked one. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /**
     * 0391: `{resource: "read" | "write"}`. NULL = by `scope`, as every key before 0391.
     * When set, `scope` is `write` if any value is `write`, so the method wall stays correct.
     */
    permissions: jsonb("permissions").$type<Record<string, "read" | "write">>(),
  },
  (t) => [
    uniqueIndex("api_keys_public_id_uq").on(t.publicId),
    uniqueIndex("api_keys_hashed_key_uq").on(t.hashedKey),
    index("api_keys_org_idx").on(t.organizationId),
  ],
);

/**
 * Where an organization wants outbound webhooks delivered. An endpoint may be
 * scoped to one business (`business_id` set → only that business's events);
 * null = every business in the endpoint's own partition, plus org-level events.
 *
 * `livemode` is the endpoint's PARTITION, and it is not optional. Before it existed,
 * an org-wide endpoint received both partitions' events — so a production consumer
 * saw a test business's renewals, including everything Time Travel manufactures, as
 * if they were real.
 *
 * Two rules keep it honest:
 *  - scoped endpoint → livemode is DERIVED from the business, never taken from the
 *    caller (same rule as gateway_accounts). The composite FK below is what makes
 *    that structural rather than a convention: (business_id, livemode) has to be a
 *    pair that exists in `businesses`, so no code path can write a mismatch. NULL
 *    business_id makes the FK vacuously true, which is exactly what an org-wide
 *    endpoint needs.
 *  - an endpoint's partition is fixed at creation, like a business's. Re-scoping is
 *    allowed only within the same partition (`src/api/routes.ts`).
 *
 * The column default is `test` so a path that forgets to set it fails SAFE — an
 * endpoint that misses test events is noticed on the next event; one that quietly
 * receives live ones is not.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // whe_…
    url: text("url").notNull(),
    signingSecret: text("signing_secret").notNull(),
    enabled: text("enabled").notNull().default("true"),
    livemode: text("livemode").notNull().default("test"), // test | live
    // WH-1: per-endpoint event subscriptions. null = all events; else a list of
    // registry event types this endpoint receives.
    eventTypes: jsonb("event_types").$type<string[] | null>(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("webhook_endpoints_public_id_uq").on(t.publicId),
    index("webhook_endpoints_org_idx").on(t.organizationId),
    foreignKey({
      name: "webhook_endpoints_business_livemode_fk",
      columns: [t.businessId, t.livemode],
      foreignColumns: [businesses.id, businesses.livemode],
    }).onDelete("cascade"),
  ],
);
