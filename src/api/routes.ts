import {
  MAX_FOOTER_NOTE_CHARS,
  httpUrlOrNull,
  withoutLegacyEmailKeys,
} from "@/modules/emails/config";
import { COMMON_TEMPLATE_VARS } from "@/modules/emails/templates";
import { getTestBusinessUsage } from "@/modules/tenancy/test-limits";
import { initialDocumentConfig } from "@/modules/invoicing/customization";
import {
  CHARGE_TIMINGS,
  SMALL_INVOICE_ACTIONS,
  mergeInvoiceRulesConfig,
  resolveInvoiceRulesConfig,
  serializeInvoiceRulesConfig,
} from "@/modules/invoicing/invoice-rules-config";
import { isValidCountry } from "@/platform/geo";
import {
  VAT_PREFIX_ISO,
  MAX_SELLER_TAX_ID_LENGTH,
  MAX_SELLER_TAX_IDS,
  TAX_ROUNDINGS,
  mergeTaxSettings,
  serializeTaxSettings,
} from "@/modules/tax/settings";
import { resolveTeamAlertsConfig, serializeTeamAlertsConfig } from "@/modules/team-alerts/config";
import { syncTeamAlertRecipients } from "@/modules/team-alerts/recipients";
import { checkField } from "@/modules/emails/template-lang";
import {
  initialStorefrontConfig,
  PORTAL_LINK_ERROR_HTML_MAX,
} from "@/modules/checkout/storefront-config";
import { resolveCheckoutFieldConfig } from "@/modules/checkout/field-config";
import {
  addressFieldLocksFor,
  addressFieldLockViolation,
  resolvePortalFieldConfig,
  withAddressFieldLocks,
  NO_ADDRESS_FIELD_LOCKS,
  type AddressFieldLocks,
} from "@/modules/checkout/address-field-rules";
import { liveTaxRegimes } from "@/modules/tax/service";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { dunningConfigObject } from "./dunning-config-schema";
// Aliased: this file also has its own pre-existing local `httpUrl` (below,
// used only by default_return_url/default_cancel_url) — out of scope here,
// left as-is. New fields use the shared one from limits.ts.
import { LIMITS, httpUrl as sharedHttpUrl, redirectUrl as sharedRedirectUrl } from "./limits";
import { authenticate } from "@/platform/auth";
import { newApiKeyRefusedFor } from "@/modules/auth/org-two-factor";
import { idempotency, idempotencyOnSend, idempotentNoStore } from "@/platform/idempotency";
import { ImageUploadError, MAX_IMAGE_BYTES } from "@/platform/image-upload";
import {
  type BrandImageOwner,
  ObjectStoreNotConfiguredError,
  allowedTypesFor,
  isObjectStoreConfigured,
  uploadBrandImage,
} from "@/platform/object-store";
import {
  createBusiness,
  listBusinesses,
  createApiKey,
  listApiKeys,
  updateApiKey,
  revokeApiKey,
  rotateApiKey,
  ApiKeyRotationError,
  ROTATION_OVERLAP_DEFAULT_SECONDS,
  ROTATION_OVERLAP_MAX_SECONDS,
  updateOrganization,
  updateBusiness,
  getBusinessByPublicId,
  TenancyError,
  businessPairs,
  ensureTestTwin,
} from "@/modules/tenancy/service";
import {
  VersionConflictError,
  requirePerm,
  callerHolds,
  missingPermission,
  badRequest,
  refusedByRateLimit,
  parseListQuery,
  listResponse,
  noMemberPermission,
} from "./helpers";
import { UPLOAD_WINDOW_MS, UPLOAD_LIMIT_MESSAGE } from "@/platform/rate-limit";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "@/platform/list-query";
import {
  currencyRateStates,
  setCurrencyRateSource,
  removeCurrency,
  ExchangeRateError,
} from "@/modules/tenancy/exchange-rates";
import { normalizeTimezone } from "@/platform/timezones";
import { WEEK_STARTS } from "@/platform/business-calendar";
import {
  LEGACY_CHARGES_ON_RESUME,
  withoutLegacyChargesOnResume,
} from "@/modules/subscriptions/pause-config";
import {
  AUTO_COLLECTION_VALUES,
  CHANGE_GATES,
  CHANGE_PRORATIONS,
  CHANGE_TIMING_RULES,
  FAILED_CHANGE_CHARGES,
  MANDATE_REVOKED_ACTIONS,
  SPECIFIC_DATE_FINAL_PERIODS,
  TRIAL_END_ACTIONS,
  PLAN_CREDIT_UPGRADES,
  PLAN_CREDIT_DOWNGRADES,
  PLAN_CREDIT_FIRST_WINDOWS,
  PLAN_CREDIT_PAUSES,
  PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS,
  ALLOWANCE_UPGRADES,
  initialBillingRulesConfig,
  mergeBillingRulesConfig,
  serializeBillingRules,
} from "@/modules/subscriptions/billing-rules-config";
import { creditScopeMissing } from "@/modules/credits/scope";
import {
  EXCESS_PAYMENT_ACTIONS,
  INVOICE_ORDERS,
  SEVERAL_DUE_INVOICES,
} from "@/modules/payments/application-config";
import {
  DOWNGRADE_CREDITS,
  PLAN_CHANGE_COUPONS,
  PLAN_CHANGE_TERMS,
  REACTIVATION_CHARGES,
  resolveLifecycleConfig,
  serializeLifecycleConfig,
} from "@/modules/subscriptions/lifecycle-config";
import {
  DECLINED_REFUND_OUTCOMES,
  MAX_WRITE_OFF_MINOR,
  WRITE_OFF_PERCENT,
  resolveCollectionRulesConfig,
  serializeCollectionRulesConfig,
  withInitialCollectionRules,
} from "@/modules/subscriptions/collection-rules-config";
import {
  CARD_EXPIRY_MONTH,
  MAX_LEAD_DAYS,
  MAX_LEAD_DAYS_PER_KIND,
  MAX_OPTIONAL_LEAD_DAYS,
  MIN_LEAD_DAYS,
  initialReminderConfig,
  mergeReminderConfig,
  serializeReminderConfig,
} from "@/modules/subscriptions/reminder-config";
import { businessWallClock } from "@/platform/clock";
import { registerCatalogRoutes } from "./catalog-routes";
import { registerCustomerRoutes } from "./customer-routes";
import { registerPaymentMethodRoutes } from "./payment-method-routes";
import { registerSubscriptionRoutes } from "./subscription-routes";
import { registerInvoiceRoutes } from "./invoice-routes";
import { registerTaxRoutes } from "./tax-routes";
import { registerRefundRoutes } from "./refund-routes";
import { registerCouponRoutes } from "./coupon-routes";
import { registerCatalogStatsRoutes } from "./catalog-stats-routes";
import { registerWalletRoutes } from "./wallet-routes";
import { registerTeamAlertRoutes } from "./team-alert-routes";
import { registerCreditNoteRoutes } from "./credit-note-routes";
import { registerEntitlementRoutes } from "./entitlement-routes";
import { registerPortalRoutes } from "./portal-routes";
import { registerCustomerPortalRoutes } from "./customer-portal-routes";
import { registerPortalCreditRoutes } from "./portal-credit-routes";
import { registerCheckoutRoutes } from "./checkout-routes";
import { registerPaymentLinkRoutes } from "./payment-link-routes";
import { registerMetricsRoutes } from "./metrics-routes";
import { registerAnalyticsRoutes } from "./analytics-routes";
import { registerAuthRoutes } from "./auth-routes";
import { registerWebhookRoutes } from "./webhook-routes";
import { registerEmailWebhookRoutes } from "./email-webhook-routes";
import { registerEventRoutes } from "./events-routes";
import { registerGatewayRoutes } from "./gateway-routes";
import { registerDeclineRuleRoutes } from "./decline-rule-routes";
import { addressRefinement } from "./address-validation";
import { registerGeoRoutes } from "./geo-routes";
import { registerDisputeRoutes } from "./dispute-routes";
import { registerEmailRoutes } from "./email-routes";
import { registerTmtestRoutes } from "./tmtest-routes";
import { registerTransactionRoutes } from "./transaction-routes";
import { registerPaymentIntentRoutes } from "./payment-intent-routes";
import { registerAuditRoutes } from "./audit-routes";
import { registerRequestLogRoutes } from "./request-log-routes";
import { registerCommentRoutes } from "./comment-routes";
import { registerUsageRoutes } from "./usage-routes";
import { registerUsageViewRoutes } from "./usage-view-routes";
import { registerUsageEventRoutes } from "./usage-event-routes";
import { registerCreditHoldRoutes } from "./credit-hold-routes";
import { registerMeterRoutes } from "./meter-routes";
import { registerModelPriceRoutes } from "./model-price-routes";
import { registerCreditRoutes } from "./credits-routes";
import { registerRateChangePreviewRoutes } from "./rate-change-preview-routes";
import { registerUsageWidgetRoutes } from "./usage-widget-routes";
import { registerUsageControlRoutes } from "./usage-control-routes";
import { registerPortalUsageControlRoutes } from "./portal-usage-control-routes";
import { registerUsageBillingRoutes } from "./usage-billing-routes";
import { permissionDef } from "@/modules/auth/permissions";
import {
  businessCreditConfigSchema,
  toBusinessCreditConfig,
} from "@/modules/credits/customer-settings";
import { registerListViewRoutes } from "./list-view-routes";
import { registerReportDashboardRoutes } from "./report-dashboard-routes";
import { registerSegmentRoutes } from "./segment-routes";
import { registerTransferRoutes } from "./transfer-routes";
import { registerTimeTravelRoutes } from "./time-travel-routes";
import { registerCustomFieldRoutes } from "./custom-field-routes";
import { registerMetadataRuleRoutes } from "./metadata-rule-routes";
import { registerPaymentInstructionRoutes } from "./payment-instruction-routes";
import { registerReasonCodeRoutes } from "./reason-code-routes";
import { registerDunningPolicyRoutes } from "./dunning-policy-routes";
import { registerReceiptRoutes } from "./receipt-routes";
import { registerPaymentRequestRoutes } from "./payment-request-routes";
import { registerHubSpotRoutes } from "./hubspot-routes";
import { registerIntegrationRoutes } from "./integration-routes";
import { registerHubSpotConflictRoutes } from "./hubspot-conflict-routes";
import { registerHubSpotAppRoutes } from "./hubspot-app-routes";
import {
  createEndpoint,
  EndpointValidationError,
  requeueFailed,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
  deleteEndpoint,
  rotateSecret,
  listDeliveriesPage,
  httpStatusFilterError,
  WEBHOOK_DELIVERY_FILTER_OPS,
  WEBHOOK_DELIVERY_FILTER_KINDS,
  WEBHOOK_DELIVERY_SORT_FIELDS,
  redeliverDelivery,
  redeliverLatest,
  type RedeliverResult,
  RedeliverConflictError,
  testSendEndpoint,
} from "@/modules/webhooks/endpoints";
import { isEventType, type EventType } from "@/modules/events/registry";
import type {
  apiKeys as apiKeysTable,
  webhookEndpoints as webhookEndpointsTable,
  businesses as businessesTable,
} from "@db/schema";
import { openapiDocument } from "./openapi";
import { registerRoleRoutes } from "./role-routes";
import {
  apiKeyGrant,
  keyMapError,
  missingForGrant,
  scopeForMap,
  type KeyPermissionMap,
} from "@/modules/auth/permissions";
import { withPermissions } from "./openapi-permissions";
import { routePermissions } from "./permission-registry";
import { config } from "@/platform/config";
import { checkPublicUrl } from "@/platform/egress";
import { effectiveLiveAccess, effectiveOrganizationStatus } from "@/platform/edition";
import { acceptedAndIgnored, parseRequest, roundTripped } from "./strict-params";

const DOCS_HTML = `<!doctype html>
<html>
  <head>
    <title>tmbilling API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <!-- RELATIVE, not "/openapi.json". This page is served at <base>/docs, and behind a
         reverse proxy <base> is not the origin root — production serves it under a path
         prefix. A root-absolute URL then sends the browser to <origin>/openapi.json,
         which is not this API, and Scalar renders "Document 'api-1' could not be loaded"
         with an otherwise working page. "./openapi.json" resolves against whatever path
         the BROWSER actually loaded, so it is correct at the root and under any prefix,
         with nothing to configure. Safe because /docs and /openapi.json are siblings and
         Fastify does not match a trailing slash, so the base can only ever be <base>/. -->
    <script id="api-reference" data-url="./openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;

const createBusinessBody = z.object({
  name: z.string().min(1).max(200),
  // Required: every business has a default currency (0499).
  default_currency: z.string().length(3),
  // test = sandbox business; defaults to the creating key's mode ('all' → live).
  livemode: z.enum(["live", "test"]).optional(),
});

const createEndpointBody = z.object({
  url: sharedHttpUrl(),
  // Optional business scope (biz_… public id): deliver only that business's events.
  business: z.string().max(LIMITS.id).optional(),
  // The endpoint's test/live partition. Omit it and it is RESOLVED, never guessed:
  // from the business when `business` is set, else from the calling key's mode. Only
  // an org-wide endpoint created with a full-access ('all') key has to state it —
  // that is the one case where nothing in the request implies an answer.
  livemode: z.enum(["live", "test"]).optional(),
  // WH-1: subscribe to specific event types (null/omitted = all events).
  event_types: z.array(z.string()).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});
const updateEndpointBody = z.object({
  enabled: z.boolean().optional(),
  url: sharedHttpUrl().optional(),
  // Set to a biz_… id to scope, or null to receive all events again. The business must
  // be in the endpoint's own partition — `livemode` is immutable after creation.
  business: z.string().max(LIMITS.id).nullable().optional(),
  event_types: z.array(z.string()).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});
const testSendBody = z.object({ type: z.string().max(LIMITS.code) });

/** Reject any event_types entry that isn't a registered event type. */
function invalidEventTypes(types: string[] | null | undefined): string[] {
  return (types ?? []).filter((t) => !isEventType(t));
}
const bizAddress = z
  .object({
    line1: z.string().max(200).nullable().optional(),
    line2: z.string().max(200).nullable().optional(),
    line3: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    state: z.string().max(100).nullable().optional(),
    state_code: z.string().max(10).nullable().optional(),
    postal_code: z.string().max(20).nullable().optional(),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/, "Must be 2 letters (ISO 3166-1 alpha-2)")
      .nullable()
      .optional(),
    phone: z.string().max(50).nullable().optional(),
  })
  .superRefine(addressRefinement);

/**
 * Numbering, presentation half (0239): `<prefix><sep1><dynamic><sep2><counter>`. The
 * prefix and the counter themselves stay as their own top-level columns
 * (`invoice_prefix` / `invoice_next_number`) because they are written on the billing path
 * and read under a lock; only the FORMAT lives here.
 *
 * No `reset` keys, deliberately — see NumberingConfig in
 * `src/modules/invoicing/customization.ts` for why a resetting counter breaks
 * `invoices_business_number_uq`.
 */
const numberingSchema = z
  .object({
    dynamic_prefix: z
      .enum([
        "none",
        "yyyy",
        "fy",
        "mmyyyy",
        "mm-yyyy",
        "yyyymm",
        "yyyy-mm",
        "ddmmyyyy",
        "dd-mm-yyyy",
        "yyyymmdd",
        "yyyy-mm-dd",
        "mmddyyyy",
        "mm-dd-yyyy",
      ])
      .optional(),
    separator1: z.enum(["none", "hyphen"]).optional(),
    separator2: z.enum(["none", "hyphen"]).optional(),
    increment: z.number().int().min(1).max(1000).optional(),
    // 1–12, applied by the resolver rather than here so an absent key and a cleared
    // column resolve identically. Defaults to the CALENDAR year: this product sells into
    // India (April), the US (October federal, mostly calendar in practice) and the EU
    // (mostly calendar), and no single default is correct for all three.
    fiscal_year_start_month: z.number().int().min(1).max(12).optional(),
  })
  .optional();

/**
 * The document-customization object. Shape mirrors `StoredCustomization` in
 * `src/modules/invoicing/customization.ts`; that module's resolver — not this schema —
 * owns the DEFAULTS, so an absent key here and a malformed key in an old row resolve to
 * the same thing.
 *
 * The signature caption and the notes are plain-text capped strings on purpose: a
 * merchant-editable markup blob rendered into a customer-facing document is an injection
 * surface.
 */
const invoiceCustomizationSchema = z.object({
  common: z
    .object({
      address_format: z.enum(["expanded", "single_line", "custom"]).optional(),
      custom_address: z.string().max(2000).nullable().optional(),
      show_customer_id: z.boolean().optional(),
      show_subscription_id: z.boolean().optional(),
      show_customer_info: z.boolean().optional(),
      show_shipping_info: z.boolean().optional(),
      show_payment_stub: z.boolean().optional(),
      show_exchange_rate: z.boolean().optional(),
    })
    .optional(),
  signature: z
    .object({
      // Same validator as logo_url / icon_url, and restricted with them (0246) — the
      // renderer fetches it with `loadLogo`, so it has the same read path and the same
      // reasons.
      image_url: sharedHttpUrl().nullable().optional(),
      caption: z.string().max(500).nullable().optional(),
      // Which bottom corner it sits in; the block is pinned to the foot of the page.
      position: z.enum(["bottom_right", "bottom_left"]).optional(),
    })
    .optional(),
  invoice: z
    .object({
      title: z.enum(["invoice", "tax_invoice"]).optional(),
      show_status: z.boolean().optional(),
      show_billing_period: z.boolean().optional(),
      show_next_billing: z.boolean().optional(),
      show_credit_note_number: z.boolean().optional(),
      show_custom_fields: z.boolean().optional(),
      numbering: numberingSchema,
    })
    .optional(),
  credit_note: z
    .object({
      title: z.enum(["credit_note", "refund"]).optional(),
      show_status: z.boolean().optional(),
      show_service_period: z.boolean().optional(),
      show_invoice_date: z.boolean().optional(),
      notes: z.string().max(2000).nullable().optional(),
      numbering: numberingSchema,
    })
    .optional(),
  receipt: z.object({ numbering: numberingSchema }).optional(),
});

// Declared ABOVE `updateOrgBody`, which now reuses it: the organization stores the
// same address shape as the business, so one validator serves both and a forward
// reference would be a `z.lazy` with nothing to gain.
const updateOrgBody = z.object({
  name: z.string().min(1).max(200).optional(),
  /**
   * The REGISTERED entity, printed on invoices a business issues under the organization
   * (`businesses.invoice_issuer`). Declared here or zod strips it silently and the field
   * saves while doing nothing — the same trap the timezone note below describes.
   *
   * `bizAddress` is reused deliberately: the same jsonb shape the business column stores,
   * so one validator and one renderer serve both.
   */
  legal_name: z.string().max(200).nullable().optional(),
  address: bizAddress.nullable().optional(),
  tax_registration_number: z.string().max(64).nullable().optional(),
  /**
   * Which currency analytics opens on (0268). Three letters, stored upper-case; null or ''
   * clears it back to "ask me", which is a real state rather than a missing one.
   *
   * Declared here because zod SILENTLY STRIPS unknown keys — a field absent from this object
   * is dropped before the route ever sees it, and the setting would appear to save while
   * changing nothing.
   */
  base_currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "A currency is three letters, e.g. INR.")
    .nullable()
    .optional(),
  /**
   * The organization's display timezone (0216) — the org mirror of the business column.
   *
   * VALIDATED HERE, not just in the service, for two reasons. First, zod SILENTLY STRIPS
   * unknown keys: a `timezone` absent from this object would be dropped before the route
   * ever saw it, and the setting would appear to save while doing nothing. Second, an
   * invalid zone must be a 400 rather than a stored value — `Intl` throws on an unknown
   * zone and every formatter in the dashboard catches and falls back to UTC, so
   * `Asia/Calcuta` would persist and then silently render as UTC forever.
   *
   * `normalizeTimezone` is the same gate the business column uses: it rejects fixed
   * offsets (`+05:30` — no daylight-saving rule) and bare abbreviations (`IST` — claimed
   * by three countries), both of which a plain `Intl` round trip accepts.
   *
   * `''` and `null` both mean "clear it" (→ UTC), matching `timezone` on the business
   * body; the picker posts `''` when nothing is selected.
   */
  timezone: z
    .string()
    .max(64)
    .refine((v) => v === "" || isValidTimezone(v), {
      message: "Not a valid IANA time zone name. Use a name such as 'Asia/Kolkata' or 'UTC'",
    })
    .nullable()
    .optional(),
  /** Square logo for the dashboard sidebar; the same validator as the business `icon_url`. */
  icon_url: sharedHttpUrl().nullable().optional(),
});

/** True when `normalizeTimezone` would accept this zone (see `platform/timezones.ts`). */
function isValidTimezone(tz: string): boolean {
  try {
    normalizeTimezone(tz);
    return true;
  } catch {
    return false;
  }
}
/**
 * The seller's own address — it prints on every invoice and credit note.
 *
 * It used to cap string lengths and check the country was two uppercase letters,
 * which meant `XX` was a valid country and `hello` a valid postal code. `state_code`
 * is new here: the settings screen had `state` as free text with no code at all, so
 * the seller's region was never expressed in the form tax resolution can read.
 */
// ISO 4217-shaped: exactly 3 uppercase letters. `.length(3)` alone let a lowercase
// or digit-bearing code through — the dashboard already uppercases before sending,
// so this only rejects genuinely malformed codes from direct API callers.
const CURRENCY_RE = /^[A-Z]{3}$/;
const currencyCode = z.string().regex(CURRENCY_RE, "Must be 3 uppercase letters (ISO 4217)");

/**
 * Exported ONLY so a unit test can assert it accepts every key `resolveEmailConfig`
 * consumes. Zod strips unknown keys, so a field the engine reads but this schema omits is
 * silently discarded on write — `footerNote` shipped that way, with the settings screen
 * still showing what the merchant had typed. See `emailConfigWriteSchemaIsComplete`.
 */
/**
 * One Credits Flexibility slot: what to do with a credit bucket on one invoice class.
 * `limit_minor` is integer MINOR UNITS and is required by `mode: 'limit'` — refused
 * rather than defaulted, because the resolver reads a limit with no amount as unlimited
 * and a merchant who asked for a cap must not get "no cap" instead.
 */
const creditsFlexibilitySlot = z
  .object({
    mode: z.enum(["auto", "none", "limit"]),
    limit_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  })
  .refine((s) => s.mode !== "limit" || (s.limit_minor != null && s.limit_minor >= 0), {
    message: "limit_minor is required when mode is 'limit'",
    path: ["limit_minor"],
  });
/** The two invoice classes, configured separately, for one credit kind. */
const creditsFlexibilityKind = z.object({
  recurring: creditsFlexibilitySlot.optional(),
  one_time: creditsFlexibilitySlot.optional(),
});

/**
 * One currency's rate source (0229). `manual` carries the rate; `auto` must NOT, because
 * a rate sent alongside `auto` would be silently discarded by the next refresh — a field
 * that appears to be accepted and then overwritten is worse than a rejected one.
 */
export const currencyRateBody = z.union([
  z.object({
    source: z.literal("manual"),
    // A string keeps the operator's own precision (`94.9537410`); a number is accepted
    // because JSON clients naturally send one.
    rate: z.union([z.string().min(1).max(40), z.number().positive().finite()]),
  }),
  z.object({ source: z.literal("auto"), rate: z.undefined().optional() }),
]);

const portalFieldState = z.enum(["show", "hide", "mandatory", "read_only"]).optional();

/** A business's address field locks: which keys its live tax setup forces to `mandatory`. */
async function addressFieldLocksByBusiness(
  organizationId: string,
  businessIds: readonly string[],
): Promise<Map<string, AddressFieldLocks>> {
  const regimes = await liveTaxRegimes(organizationId, businessIds);
  return new Map([...regimes].map(([id, r]) => [id, addressFieldLocksFor(r)]));
}

/** One kind's reminder lead days: whole days before the date, distinct. */
const reminderLeadDaysSchema = z
  .array(z.number().int().min(MIN_LEAD_DAYS).max(MAX_LEAD_DAYS))
  .min(1)
  .max(MAX_LEAD_DAYS_PER_KIND)
  .refine((v) => new Set(v).size === v.length, "Each lead day must be different.");

/** An optional reminder kind: `[]` is Off. */
const optionalLeadDaysSchema = z
  .array(z.number().int().min(MIN_LEAD_DAYS).max(MAX_LEAD_DAYS))
  .max(MAX_OPTIONAL_LEAD_DAYS)
  .refine((v) => new Set(v).size === v.length, "Each lead day must be different.");

const USAGE_CLOSE_DELAY_MESSAGE = "Enter a whole number of minutes from 0 to 24.";

export const updateBusinessBody = z.object({
  name: z.string().min(1).max(200).optional(),
  default_currency: currencyCode.optional(),
  // Currencies this business transacts in; null = unrestricted.
  currencies: z.array(currencyCode).min(1).max(50).nullable().optional(),
  // Reporting FX: 1 default_currency = rate × key currency. Reporting-only.
  exchange_rates: z.record(currencyCode, z.number().positive().finite()).nullable().optional(),
  // "Setup Billing Frequency": allowed price frequencies; null = unrestricted.
  billing_frequencies: z
    .array(
      z.object({
        interval: z.enum(["day", "week", "month", "year"]),
        count: z.number().int().min(1).max(120),
      }),
    )
    .max(50)
    .nullable()
    .optional(),
  // Profile
  address: bizAddress.nullable().optional(),
  contact_email: z.string().email().max(320).nullable().optional(),
  support_email: z.string().email().max(320).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  website: sharedHttpUrl().nullable().optional(),
  // Brand Styles (0185). Three images because they are different shapes — wide
  // wordmark, square mark, browser tab — and consumers fall back logo → icon →
  // initials rather than stretching one into another's slot.
  //
  /**
   * Scheme-restricted to http(s) as of 0246 (SR-2026-016 Finding 3). It was NOT, on the
   * grounds that `loadLogo` (`modules/invoicing/invoice-pdf.ts`) branches on
   * `url.startsWith("data:")` to inline a logo into the PDF. Three things were then
   * measured, and together they made the restriction safe:
   *
   *  · every `data:` logo in the database — 22 of them — belongs to ONE org, "Invoice PDF
   *    Org", livemode=test, every value exactly 182 bytes: the `verify:invoice-pdf`
   *    fixture. No merchant has one.
   *  · that fixture writes with a DIRECT `.set({ logoUrl })`, not through this body, so it
   *    is unaffected by anything here and needed no change.
   *  · a production SVG logo — the reason `loadLogo` learned to rasterise at all —
   *    arrives over https, not as a `data:` URL. Restricting the scheme does not touch it.
   *
   * `loadLogo` KEEPS its `data:` branch, deliberately: existing rows and the fixture still
   * resolve, and it is the read side. This is the write side, and it stops new ones.
   *
   * An https SVG is still ACCEPTED by this field — it is a valid http(s) URL — but as of
   * 2026-09-09 it no longer prints: `loadLogo` refuses SVG rather than rasterising it, so
   * such a logo renders on the portal, checkout and email and leaves the invoice PDF with
   * no letterhead. Uploads refuse SVG outright (`platform/image-upload.ts`, SR-2026-015).
   * The field is not narrowed to reject it because the value is also used by surfaces that
   * CAN render one; the settings copy tells a merchant to use PNG or JPEG.
   */
  logo_url: sharedHttpUrl().nullable().optional(),
  icon_url: sharedHttpUrl().nullable().optional(),
  favicon_url: sharedHttpUrl().nullable().optional(),
  // `#RRGGBB` only. Not a free string: this value is interpolated into a CSS custom
  // property on the hosted pages and into inline style on an email, so anything that
  // is not a literal hex colour is either broken output or an injection vector.
  brand_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex color, e.g. #FF6700")
    .nullable()
    .optional(),
  /**
   * May a BUYER type a coupon code on this business's hosted checkout and portal? 0238.
   * Not nullable: it is a real yes/no, and `null` would be a third state the hosted pages
   * would have to invent a meaning for.
   */
  allow_customer_coupons: z.boolean().optional(),
  /** 0495: coupon codes a buyer can enter on one checkout or subscription. Operator discounts do not count. */
  max_customer_coupon_codes: z.number().int().min(1).max(10).optional(),
  timezone: z.string().max(64).nullable().optional(),
  // Reporting calendar (0293). Changing either re-cuts the stored week/quarter/year analytics.
  week_start: z.enum(WEEK_STARTS).optional(),
  fiscal_year_start_month: z.number().int().min(1).max(12).optional(),
  tax_registration_number: z.string().max(64).nullable().optional(),
  /**
   * Whose identity heads this business's invoices. 'organization' prints the registered
   * entity's name, address and tax id instead of this business's — the common shape when
   * several businesses bill under one company and the GSTIN belongs to the entity.
   */
  invoice_issuer: z.enum(["business", "organization"]).optional(),
  // Default HSN/SAC for everything this business sells (India GST). Length-capped
  // rather than pattern-matched: the code set is jurisdictional and revised by
  // notification, so a regex would reject a valid future code until a redeploy.
  default_tax_code: z.string().max(20).nullable().optional(),
  // Invoice configuration
  invoice_prefix: z.string().trim().min(1, "Must not be blank").max(20).optional(),
  invoice_next_number: z.number().int().positive().optional(),
  default_invoice_notes: z.string().max(2000).nullable().optional(),
  default_due_days: z.number().int().min(0).max(365).nullable().optional(),
  // Dunning retry offsets (days after a failed charge), 1..8 entries of 1..90.
  dunning_retry_days: z.array(z.number().int().min(1).max(90)).min(1).max(8).nullable().optional(),
  // Pending invoices (E2): business default + auto-close window.
  create_pending_invoices: z.boolean().optional(),
  auto_close_pending_after_days: z.number().int().min(0).max(365).nullable().optional(),
  // Invoice round-off (E6).
  invoice_rounding: z.enum(["none", "nearest_unit"]).optional(),
  // Card limit per currency (0482), minor units; above it an invoice is not paid by card.
  // null clears every limit.
  card_payment_limits: z
    .record(currencyCode, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
    .nullable()
    .optional(),
  // Extra wait (0454) before a period's usage closes; renewal reads it.
  usage_close_delay_minutes: z
    .number(USAGE_CLOSE_DELAY_MESSAGE)
    .int(USAGE_CLOSE_DELAY_MESSAGE)
    .min(0, USAGE_CLOSE_DELAY_MESSAGE)
    .max(24, USAGE_CLOSE_DELAY_MESSAGE)
    .optional(),
  /**
   * Credits Flexibility (0219) — whether, and up to how much, REFUNDABLE credits and
   * EXCESS payments auto-apply to an invoice. Four independent slots: credit kind ×
   * invoice class, each `{ mode, limit_minor? }`. Absent slots resolve to auto-apply,
   * unlimited (`resolveCreditsFlexibility`), so a partial object is legal and means
   * "leave the rest alone"; `null` resets the whole setting to the default.
   *
   * `limit_minor` is REQUIRED when `mode` is `'limit'` — a limit with no amount is not a
   * setting, and accepting it would land a row the resolver has to read as unlimited.
   * Promotional credit is deliberately absent: it is pre-tax, non-refundable and already
   * capped at the discounted subtotal.
   */
  credits_flexibility: z
    .object({
      refundable: creditsFlexibilityKind.optional(),
      excess: creditsFlexibilityKind.optional(),
    })
    .nullable()
    .optional(),
  // Credit grants and holds (0464); replaced whole, null = every default. Needs `credits:manage`.
  credit_config: businessCreditConfigSchema.nullable().optional(),
  // Structured dunning config (E3): retries + final action on exhaustion.
  // Every member is optional — a caller may set the toggles alone (e.g. switch
  // dunning off) without restating a schedule; resolveDunningConfig fills the rest
  // from DEFAULT_DUNNING_CONFIG. `null` still resets the whole config.
  // The settings screen re-sends the STORED object with its edits merged in.
  dunning_config: roundTripped(dunningConfigObject).nullable().optional(),
  /**
   * Per-business mandate sizing (0221). Absent/null = the engine defaults in
   * `DEFAULT_MANDATE_HEADROOM_CONFIG`; the resolver documents each one. Only a merchant
   * whose ladder needs a different ceiling has to set it, so an unset business behaves
   * exactly as it did before the column existed.
   */
  mandate_config: z
    .object({
      headroom_bps: z.number().int().positive().optional(),
      rail_ceiling_cap_minor: z.number().int().positive().optional(),
    })
    .nullable()
    .optional(),
  // H1 (SET-1..3) billing-rule defaults consumed by E/F.
  default_prorate_on_change: z.boolean().optional(),
  default_invoice_immediately: z.boolean().optional(),
  default_cancel_option: z.enum(["immediately", "end_of_term"]).optional(),
  default_credit_option_for_cancel: z.enum(["prorate", "full", "none"]).optional(),
  // 'no_action' is the column default and was missing here, so a business could
  // never be set back to it once moved off (openapi.ts already listed all three).
  default_unbilled_on_cancel: z.enum(["no_action", "invoice", "delete"]).optional(),
  /**
   * The other two halves of the cancel screen (0242). POST …/cancel has accepted both
   * per call since F; these are the business defaults it falls back to when omitted.
   * Every value the cancel route's own enums accept is listed here — the
   * `default_unbilled_on_cancel` comment two lines up records what happens when one is
   * left out: it becomes unreachable, and the screen shows a default the engine cannot
   * produce.
   */
  default_ar_handling_on_cancel: z
    .enum(["no_action", "schedule_payment_collection", "write_off", "void"])
    .optional(),
  default_refundable_credits_on_cancel: z.enum(["no_action", "schedule_refund"]).optional(),
  /**
   * Invoice-now vs retain-as-unbilled per lifecycle event (0242).
   * Absent/null → `resolveUnbilledChargesConfig` defaults, which are today's behaviour —
   * and those defaults are NOT uniform: `on_change` and `on_one_time_charge` inherit
   * `default_invoice_immediately` (whose column default is false, i.e. defer), while the
   * rest are invoice_immediately. See the resolver.
   *
   * THREE keys. Five candidates were dropped for two different reasons:
   * `on_term_extend` / `on_advance_charge` / `on_future_to_active` name operations this
   * engine does not have, and `on_reactivate` / `on_trial_to_active` name real operations
   * with no invoice-now-vs-defer decision point to read a preference (reactivation has no
   * such concept; trial conversion bills inside the renewal engine). Both classes would
   * have been controls reaching nothing.
   * Cancel and resume are NOT here: they already have their own option elsewhere on this
   * body and on their routes, and a second place to say the same thing is a second place
   * to disagree.
   */
  unbilled_charges_config: z
    .object({
      on_create: z.enum(["invoice_immediately", "add_to_unbilled"]).optional(),
      on_change: z.enum(["invoice_immediately", "add_to_unbilled"]).optional(),
      on_one_time_charge: z.enum(["invoice_immediately", "add_to_unbilled"]).optional(),
    })
    .nullable()
    .optional(),
  /**
   * Pause / resume defaults (0242). Absent/null →
   * `resolvePauseConfig` defaults, which are what the operations resolve to today.
   *
   * `locked` is the "prevent overriding" list. The pause and resume routes refuse an
   * explicit value that differs from a locked default (`lockedOverrides`); scheduled,
   * chargeback and portal pauses are not gated.
   */
  pause_config: z
    .object({
      // `specific_date` / `billing_cycles` are per-call only: their meaning depends on a
      // `pause_date` / `skip_billing_cycles` a site default cannot carry, so as a default
      // they would throw rather than do nothing. Duration and resume-timing are absent
      // entirely — the engine has no parameter for either (Rule 0).
      pause_option: z.enum(["immediately", "end_of_term"]).optional(),
      unbilled_on_pause: z.enum(["retain", "invoice"]).optional(),
      dunning_on_pause: z.enum(["continue", "stop"]).optional(),
      // Spelled as ResumeChargesHandling. `next_renewal` is a deprecated alias, stored as
      // what it always meant: add_to_unbilled_charges.
      charges_on_resume: z
        .enum(["invoice_immediately", "add_to_unbilled_charges", LEGACY_CHARGES_ON_RESUME])
        .transform((v) => (v === LEGACY_CHARGES_ON_RESUME ? "add_to_unbilled_charges" : v))
        .optional(),
      // The engine's own `UnpaidInvoicesHandling` literals. A private vocabulary here is
      // where the next add_to_unbilled-style mismatch would hide; display wording lives
      // on the screen's labels instead.
      unpaid_invoices_on_resume: z.enum(["no_action", "schedule_payment_collection"]).optional(),
      locked: z.array(z.string().max(40)).max(8).nullable().optional(),
    })
    .nullable()
    .optional(),
  /**
   * Billing rules (0481). Keys left out keep their stored value; null resets every key.
   * The read returns the RESOLVED values.
   */
  billing_rules_config: z
    .object({
      trial_end_action: z.enum(TRIAL_END_ACTIONS).optional(),
      specific_date_cancel_final_period: z.enum(SPECIFIC_DATE_FINAL_PERIODS).optional(),
      required_reasons: z
        .object({
          cancel_subscription: z.boolean().optional(),
          void_invoice: z.boolean().optional(),
          create_credit_note: z.boolean().optional(),
          refund: z.boolean().optional(),
        })
        .optional(),
      failed_change_charge: z.enum(FAILED_CHANGE_CHARGES).optional(),
      upgrade_proration: z.enum(CHANGE_PRORATIONS).optional(),
      downgrade_proration: z.enum(CHANGE_PRORATIONS).optional(),
      upgrade_gate: z.enum(CHANGE_GATES).optional(),
      downgrade_gate: z.enum(CHANGE_GATES).optional(),
      // null = not saved: each source keeps its own default (change-policy.ts).
      upgrade_timing: z.enum(CHANGE_TIMING_RULES).nullable().optional(),
      downgrade_timing: z.enum(CHANGE_TIMING_RULES).nullable().optional(),
      new_customer_auto_collection: z.enum(AUTO_COLLECTION_VALUES).optional(),
      mandate_revoked: z.enum(MANDATE_REVOKED_ACTIONS).optional(),
      // Subscription lifecycle (lifecycle-config.ts).
      plan_change_term: z.enum(PLAN_CHANGE_TERMS).optional(),
      plan_change_coupons: z.enum(PLAN_CHANGE_COUPONS).optional(),
      downgrade_credit: z.enum(DOWNGRADE_CREDITS).optional(),
      reactivation_charges: z.enum(REACTIVATION_CHARGES).optional(),
      // Collection rules (2.12, 2.15): shortfall write-off per currency, declined refunds.
      partial_payment_write_off: z
        .record(
          z.string().regex(/^[A-Z]{3}$/, "Use an upper-case three-letter currency code."),
          z.number().int().min(1).max(MAX_WRITE_OFF_MINOR),
        )
        .optional(),
      partial_payment_write_off_max_percent: z
        .number()
        .int()
        .min(WRITE_OFF_PERCENT.min)
        .max(WRITE_OFF_PERCENT.max)
        .optional(),
      declined_refund: z.enum(DECLINED_REFUND_OUTCOMES).optional(),
      // Payment application (2.51, 2.66, 2.69).
      payment_application: z
        .object({
          several_due_invoices: z.enum(SEVERAL_DUE_INVOICES).optional(),
          invoice_order: z.enum(INVOICE_ORDERS).optional(),
          excess_payment: z.enum(EXCESS_PAYMENT_ACTIONS).optional(),
        })
        .optional(),
      // Credit and allowance resets (design-G3b § 6).
      plan_credits: z
        .object({
          on_upgrade: z.enum(PLAN_CREDIT_UPGRADES).optional(),
          on_downgrade: z.enum(PLAN_CREDIT_DOWNGRADES).optional(),
          first_window: z.enum(PLAN_CREDIT_FIRST_WINDOWS).optional(),
          on_pause: z.enum(PLAN_CREDIT_PAUSES).optional(),
          on_cancel_at_period_end: z.enum(PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS).optional(),
        })
        .optional(),
      allowances: z.object({ on_upgrade: z.enum(ALLOWANCE_UPGRADES).optional() }).optional(),
    })
    .nullable()
    .optional(),
  /**
   * Invoice rules (0486): small invoices, charge timing. Keys left
   * out keep their stored value; null resets every key. The read returns the RESOLVED values.
   */
  invoice_rules_config: z
    .object({
      small_invoice_action: z.enum(SMALL_INVOICE_ACTIONS).optional(),
      small_invoice_thresholds: z
        .record(
          z.string().regex(/^[A-Za-z]{3}$/),
          z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        )
        .optional(),
      charge_timing: z.enum(CHARGE_TIMINGS).optional(),
    })
    .nullable()
    .optional(),
  /**
   * Backdating window (0242). Absent/null →
   * `resolveBackdatingConfig` defaults, which are fully permissive, so the column cannot
   * retroactively refuse a backdate that succeeded before it existed.
   *
   * `cutoff_day_of_month` is capped at 10 for a real reason: the day is meant to sit
   * inside the window where the previous month's books are still open. `null` means no
   * restriction and must stay reachable.
   */
  backdating_config: z
    .object({
      enabled: z.boolean().optional(),
      // Only the operations that accept a past-dated instant (`start_date`, `at`,
      // `cancel_at`, a checkout's `reactivate_from`). One-time charges take no backdate.
      allowed_actions: z
        .array(z.enum(["create", "change", "cancel", "reactivate"]))
        .max(4)
        .optional(),
      cutoff_day_of_month: z.number().int().min(1).max(10).nullable().optional(),
      allow_past_invoice_date_on_create: z.boolean().optional(),
      allow_past_invoice_date_on_change: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  /**
   * Reminder lead days (0376). A kind left out keeps its list; null resets every kind to
   * the default. Mandate pre-debit notices are not configurable.
   */
  reminder_config: z
    .object({
      trial_ending: reminderLeadDaysSchema.optional(),
      renewal: reminderLeadDaysSchema.optional(),
      renewal_yearly: reminderLeadDaysSchema.optional(),
      cancellation: reminderLeadDaysSchema.optional(),
      // `[]` is Off. Up to 3 lead days before the card expires, or the expiry month (default).
      card_expiring: z
        .union([z.literal(CARD_EXPIRY_MONTH), optionalLeadDaysSchema.min(1)])
        .optional(),
      payment_due: optionalLeadDaysSchema.optional(),
      pause: optionalLeadDaysSchema.optional(),
      resume: optionalLeadDaysSchema.optional(),
    })
    .nullable()
    .optional(),
  // ── 0243 sweep ─────────────────────────────────────────────────────────────
  // Each default is today's behaviour.
  /** Positive polarity — TRUE enables validation; see the schema comment. */
  vies_validation_enabled: z.boolean().optional(),
  /**
   * What a chargeback does to invoices and subscriptions (0244).
   * Absent/null → `resolveChargebackConfig` defaults, which are record-only = today.
   *
   * The invoice action is LOST-only and its one value is a DOCUMENTARY credit note.
   * Marking the invoice Not Paid is deliberately not accepted: it would resurrect AR with
   * no matching ledger entry. A credit note at INITIATION is not accepted either — at
   * initiation the money may still be with us, and a win would reinstate it.
   * Full reasoning: db/migrations/0244_chargeback_management.sql.
   */
  /**
   * Which checkout fields show, hide, or are required (0245, Checkout & Portal → Fields).
   * Absent/null → `resolveCheckoutFieldConfig` defaults, which are today's zod contract
   * FIELD BY FIELD and therefore not uniform: `billing.line1` and `billing.country` are
   * mandatory, everything else shows.
   *
   * THREE states only: `read_only` needs a pre-populated value the mint
   * does not carry, and `hidden_parameter` needs a caller-supplied value channel.
   * `shipping.address` switches the whole shipping section, not one field.
   *
   * ⚠️ This is also the AVS control. Making `billing.postal_code` mandatory is what turns
   * on ZIP verification — AVS is checked gateway-side, so requiring the field IS the
   * setting.
   */
  checkout_field_config: z
    .object({
      "customer.first_name": z.enum(["show", "hide", "mandatory"]).optional(),
      "customer.last_name": z.enum(["show", "hide", "mandatory"]).optional(),
      "customer.email": z.enum(["show", "hide", "mandatory"]).optional(),
      "customer.phone": z.enum(["show", "hide", "mandatory"]).optional(),
      "customer.company": z.enum(["show", "hide", "mandatory"]).optional(),
      "customer.tax_registration_number": z.enum(["show", "hide", "mandatory"]).optional(),
      "billing.line1": z.enum(["show", "hide", "mandatory"]).optional(),
      "billing.line2": z.enum(["show", "hide", "mandatory"]).optional(),
      "billing.line3": z.enum(["show", "hide", "mandatory"]).optional(),
      "billing.city": z.enum(["show", "hide", "mandatory"]).optional(),
      "billing.state": z.enum(["show", "hide", "mandatory"]).optional(),
      "billing.state_code": z.enum(["show", "hide", "mandatory"]).optional(),
      "billing.postal_code": z.enum(["show", "hide", "mandatory"]).optional(),
      "billing.country": z.enum(["show", "hide", "mandatory"]).optional(),
      "invoice.po_number": z.enum(["show", "hide", "mandatory"]).optional(),
      // Section switch for the shipping address (0360). Default `hide`.
      "shipping.address": z.enum(["show", "hide", "mandatory"]).optional(),
    })
    .nullable()
    .optional(),
  /**
   * The buyer portal's billing-details matrix (0334). Absent/null → `resolvePortalFieldConfig`
   * defaults. `hide` and `read_only` keys keep the customer's stored value on a portal save.
   * `billing.country` accepts `hide` here only to refuse it with a clear 400.
   */
  portal_field_config: z
    .object({
      "customer.first_name": portalFieldState,
      "customer.last_name": portalFieldState,
      "customer.phone": portalFieldState,
      "customer.company": portalFieldState,
      "customer.tax_registration_number": portalFieldState,
      "billing.line1": portalFieldState,
      "billing.line2": portalFieldState,
      "billing.line3": portalFieldState,
      "billing.city": portalFieldState,
      "billing.state": portalFieldState,
      "billing.state_code": portalFieldState,
      "billing.postal_code": portalFieldState,
      "billing.country": portalFieldState,
    })
    .nullable()
    .optional(),
  chargeback_config: z
    .object({
      on_lost_invoice: z.enum(["credit_note", "no_action"]).optional(),
      on_initiated_subscription: z
        .enum([
          "cancel_immediately",
          "cancel_end_of_term",
          "pause_indefinitely",
          "pause_end_of_term",
          "no_action",
        ])
        .optional(),
      on_lost_subscription: z
        .enum([
          "cancel_immediately",
          "cancel_end_of_term",
          "pause_indefinitely",
          "pause_end_of_term",
          "no_action",
        ])
        .optional(),
      cascade_to_other_subscriptions: z.boolean().optional(),
      stop_collecting_all: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  // NOT accepted: `default_credit_note_on_void` and `prorate_fixed_amount_coupons`. Both
  // columns exist (0243) and both have engine support written and tested, but neither is
  // WIRED, so accepting them would let an integration set a preference nothing honours —
  // the same reason nine keys were withdrawn from 0242. Blockers, both real:
  //  · void → a credit note on void would DOUBLE-CREDIT AR: `voidInvoice` already mirrors
  //    every ledger entry, and `issueAdjustmentCreditNote` posts its own independent
  //    reversal. Needs a ledger-free documentary credit note first.
  //  · coupon proration → a change invoice can carry a FULL-price one-time line beside
  //    prorated ones (`chargeIsOneTime` → `newFullMinor`), so there is no correct
  //    invoice-level term fraction. Needs per-line factors, and a decision on how a
  //    whole-invoice fixed coupon splits across a mixed invoice.
  /**
   * What the checkout and portal do. Absent/null →
   * `resolveStorefrontConfig` defaults. The two URLs are the mint's fallback; it requires
   * them per call today, so null keeps that contract.
   */
  storefront_config: z
    .object({
      hide_zero_value_lines: z.boolean().optional(),
      collect_po_number: z.boolean().optional(),
      // Scheme-restricted: zod 4's `.url()` accepts `javascript:` and `data:` (verified),
      // and while the providers reject those themselves — these are handed to Stripe /
      // PayPal / RazorPay, never navigated by us — a clear 400 here beats an opaque
      // provider error later. `resolveStorefrontConfig` enforces the same rule on READ, so
      // a row written before this cannot resurface either.
      // Redirect targets, so the permissive helper: a merchant whose checkout returns
      // into a mobile app sets a custom scheme here, same as the per-call fields.
      default_return_url: sharedRedirectUrl().nullable().optional(),
      default_cancel_url: sharedRedirectUrl().nullable().optional(),
      // Portal self-service permissions (2026-09-09). Each gates a portal route that
      // ALREADY WORKS — download, pay, remove-payment-method — and all three default TRUE,
      // so an unconfigured business behaves exactly as it does today. Further portal
      // rules are deliberately absent: they would gate actions for which no portal route
      // exists, and a control reaching nothing is what CLAUDE.md rule 0 forbids.
      allow_invoice_download: z.boolean().optional(),
      allow_invoice_payment: z.boolean().optional(),
      allow_remove_payment_method: z.boolean().optional(),
      // Buyer-initiated cancellation. Defaults OFF and `end_of_term` — see
      // `modules/checkout/storefront-config.ts` on why this default is the opposite of the
      // three above and still the same rule.
      allow_cancel_subscription: z.boolean().optional(),
      cancel_timing: z.enum(["immediately", "end_of_term"]).optional(),
      // Pause/resume is ONE key: splitting them would let a merchant offer pause without
      // resume, trapping a buyer in a state they cannot leave.
      allow_pause_resume: z.boolean().optional(),
      allow_reactivate: z.boolean().optional(),
      allow_skip_renewal: z.boolean().optional(),
      skip_renewal_limit: z.number().int().min(1).max(12).optional(),
      // Rich text the portal shows when a buyer cannot get in. Sanitised on read by
      // `resolveStorefrontConfig`; null or absent keeps the default copy.
      portal_link_error_html: z.string().max(PORTAL_LINK_ERROR_HTML_MAX).nullable().optional(),
      // One-time purchases: keep the buyer's payment method? `ask` lets the buyer decide.
      one_time_save_payment_method: z.enum(["never", "always", "ask"]).optional(),
      // Portal usage view: usage on by default, the projection off.
      portal_show_usage: z.boolean().optional(),
      portal_show_usage_projection: z.boolean().optional(),
      // One-page checkout (storefront Phase 1).
      checkout_layout: z.enum(["steps", "one_page"]).optional(),
      wallets_first: z.boolean().optional(),
      recurring_consent: z.boolean().optional(),
      require_terms: z.boolean().optional(),
      // Shown to buyers as links, so http(s) only.
      terms_url: sharedHttpUrl().nullable().optional(),
      privacy_url: sharedHttpUrl().nullable().optional(),
      marketing_consent: z.boolean().optional(),
      bot_check_after_failures: z.number().int().min(1).max(20).nullable().optional(),
      // Portal plan changes (storefront Phase 2). Which plans and add-ons show is each
      // product's `enabled_in_portal`.
      allow_plan_changes: z.boolean().optional(),
      seat_changes: z.enum(["off", "increase", "both"]).optional(),
      seat_min: z.number().int().min(1).max(100000).nullable().optional(),
      seat_max: z.number().int().min(1).max(100000).nullable().optional(),
      allow_addon_changes: z.boolean().optional(),
      shorter_period: z.enum(["always", "never", "after_12_months"]).optional(),
      charge_upgrade: z.enum(["business_default", "now", "next_invoice"]).optional(),
      change_statuses: z
        .array(z.enum(["active", "in_trial", "paused"]))
        .max(3)
        .optional(),
      allow_cancel_scheduled_change: z.boolean().optional(),
      // Portal cancel flow (storefront Phase 3). Unset = today: an optional reason, no offers.
      cancel_reason: z.enum(["off", "optional", "required"]).optional(),
      retention_pause: z.boolean().optional(),
      retention_pause_months: z.number().int().min(1).max(12).nullable().optional(),
      retention_pause_choice: z.boolean().optional(),
      retention_downgrade_price: z.string().max(LIMITS.id).min(1).nullable().optional(),
      retention_coupon: z.string().max(200).min(1).nullable().optional(),
      retention_contact_url: sharedHttpUrl().nullable().optional(),
      retention_offer_once: z.boolean().optional(),
      // Portal access (storefront Phase 4). Unset = today: links only, built-in lifetimes.
      portal_email_code: z.boolean().optional(),
      portal_link_hours: z.number().int().min(1).max(24).nullable().optional(),
      portal_email_link_days: z.number().int().min(1).max(14).nullable().optional(),
      portal_session_hours: z.number().int().min(1).max(168).nullable().optional(),
      portal_hide_cancelled_subscriptions: z.boolean().optional(),
      portal_hide_zero_invoices: z.boolean().optional(),
      portal_hide_voided_invoices: z.boolean().optional(),
      // Single-action links (Phase 4b). All on = today's links; off = the link opens the portal home.
      portal_actions: z
        .object({
          pay_invoice: z.boolean().optional(),
          update_card: z.boolean().optional(),
          change_plan: z.boolean().optional(),
          cancel: z.boolean().optional(),
        })
        .optional(),
      portal_return_url: sharedHttpUrl()
        .refine((u) => u.startsWith("https://"), "portal_return_url must be an https URL")
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  // Billing mode, as two independent granularities. Legal pairs: instant+exact
  // (millisecond-based), instant+whole_day and day+whole_day (both day-based).
  // day+exact is rejected.
  anchor_granularity: z.enum(["instant", "day"]).optional(),
  proration_granularity: z.enum(["exact", "whole_day"]).optional(),
  // Default price type new prices inherit.
  default_tax_behavior: z.enum(["exclusive", "inclusive"]).optional(),
  // Tax settings (0489), stored in `tax_settings`. Maps are sent whole; null clears one.
  tax_behavior_by_currency: z
    .record(currencyCode, z.enum(["inclusive", "exclusive"]))
    .nullable()
    .optional(),
  seller_tax_ids: z
    .record(
      z.string().regex(/^[A-Z]{2}$/, "Must be 2 uppercase letters (ISO 3166-1)"),
      z.string().trim().max(MAX_SELLER_TAX_ID_LENGTH),
    )
    .refine((m) => Object.keys(m).length <= MAX_SELLER_TAX_IDS, {
      message: `At most ${MAX_SELLER_TAX_IDS} countries`,
    })
    // A key must match `customers.country`, which holds ISO codes: the VAT prefixes UK and
    // EL never would, so they are refused with the code to use.
    .superRefine((m, ctx) => {
      for (const cc of Object.keys(m)) {
        const iso = VAT_PREFIX_ISO[cc];
        if (iso || !isValidCountry(cc))
          ctx.addIssue({
            code: "custom",
            path: [cc],
            message: iso
              ? `Use the ISO country code ${iso}, not ${cc}`
              : `"${cc}" is not a valid ISO 3166-1 alpha-2 country code`,
          });
      }
    })
    .nullable()
    .optional(),
  tax_rounding: z.enum(TAX_ROUNDINGS).optional(),
  // Customer-facing billing emails. Opt-in: absent/null config sends nothing.
  email_config: z
    .object({
      enabled: z.boolean(),
      fromName: z.string().max(120).nullable().optional(),
      // Envelope From. Zod strips unknown keys, so a field missing here is not merely
      // undocumented — it is silently discarded on write, and the mail goes out as the
      // deployment default while the settings screen shows what the merchant typed.
      fromAddress: z.string().email().max(320).nullable().optional(),
      replyTo: z.string().email().max(320).nullable().optional(),
      // Copy recipients on every send. Capped at 10 here AND in resolveEmailConfig — the
      // schema rejects an over-long list loudly, the resolver truncates whatever is already
      // stored, so a row written before the cap cannot fan one invoice out to hundreds.
      cc: z.array(z.string().email().max(320)).max(10).nullable().optional(),
      bcc: z.array(z.string().email().max(320)).max(10).nullable().optional(),
      subjectPrefix: z.string().trim().max(40).nullable().optional(),
      // The business footer, used by every email without its own. Capped at the same length
      // `resolveEmailConfig` truncates to, so an over-long one is refused loudly rather than
      // silently cut on the next read — and checked like a template field, since it renders
      // like one: it may only use the variables every email has.
      footerNote: z
        .string()
        .trim()
        .max(MAX_FOOTER_NOTE_CHARS)
        .nullable()
        .optional()
        .superRefine((v, ctx) => {
          if (!v) return;
          for (const i of checkField("footer", v, COMMON_TEMPLATE_VARS))
            if (i.severity === "error")
              ctx.addIssue({
                code: "custom",
                message: `Footer: ${i.message.replace("in this email", "in every email")}`,
              });
        }),
      // Per-email attachment rules. Listed for the reason the comments above give: zod
      // strips an unlisted key, and the merchant's switch would silently do nothing.
      // Keys outside EMAIL_DOCUMENT are dropped by `resolveEmailConfig`.
      attachments: z
        .record(
          z.string(),
          z.object({
            pdf: z.boolean(),
            skipZeroPdf: z.boolean(),
            skipZeroSend: z.boolean(),
          }),
        )
        .optional(),
      types: z.record(z.string(), z.boolean()).optional(),
      // Attach the numbered receipt PDF to the payment confirmation email (0387). Off unless true.
      attachReceiptPdf: z.boolean().optional(),
      // Where email links go. `merchant_url` needs an http(s) `merchantUrl`.
      linkTarget: z.enum(["portal", "merchant_url"]).optional(),
      merchantUrl: z
        .string()
        .trim()
        .max(2048)
        .refine(
          (v) => httpUrlOrNull(v) !== null,
          "Enter a URL that starts with http:// or https://.",
        )
        .nullable()
        .optional(),
      // Retired keys (`LEGACY_EMAIL_CONFIG_KEYS`): accepted so a stored copy sent back is
      // not refused, and never stored.
      attachInvoicePdf: acceptedAndIgnored(),
      attachDocumentPdf: acceptedAndIgnored(),
    })
    .refine((c) => c.linkTarget !== "merchant_url" || !!c.merchantUrl, {
      message: "Enter the URL for email links.",
      path: ["merchantUrl"],
    })
    .transform((c) => withoutLegacyEmailKeys(c))
    .nullable()
    .optional(),
  // Team alerts (0489): staff mail about overdue invoices, failed webhooks and a daily digest.
  // null turns every alert off.
  team_alerts_config: z
    .object({
      recipients: z.array(z.string().trim().toLowerCase().email().max(320)).max(10),
      overdue: z
        .object({
          enabled: z.boolean(),
          thresholds: z.record(currencyCode, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
        })
        .optional(),
      webhook_failures: z.object({ enabled: z.boolean() }).optional(),
      daily_digest: z.object({ enabled: z.boolean() }).optional(),
      large_grants: z.object({ enabled: z.boolean() }).optional(),
    })
    .refine((c) => !c.overdue?.enabled || Object.keys(c.overdue.thresholds).length > 0, {
      message: "Enter an amount for at least one currency.",
      path: ["overdue", "thresholds"],
    })
    .refine(
      (c) =>
        c.recipients.length > 0 ||
        !(
          c.overdue?.enabled ||
          c.webhook_failures?.enabled ||
          c.daily_digest?.enabled ||
          c.large_grants?.enabled
        ),
      { message: "Enter at least one email address.", path: ["recipients"] },
    )
    .nullable()
    .optional(),
  credit_note_prefix: z.string().trim().min(1, "Must not be blank").max(20).optional(),
  credit_note_next_number: z.number().int().positive().optional(),
  // Receipt numbering (0387). The counter is not settable: receipts are numbered by a batch job.
  receipt_prefix: z.string().trim().min(1, "Must not be blank").max(20).optional(),
  /**
   * What the printed invoice / credit note SHOWS (0239). Governs the DOCUMENT, never this
   * resource: hiding the customer id on the PDF must not drop `customer_id` from an
   * integration's payload.
   *
   * Every key is optional and the whole object is nullable — sending `null` clears the
   * customization and returns the business to the pre-0239 rendering. Unknown keys are
   * stripped by zod, so a client cannot smuggle a field the resolver would ignore into
   * the stored jsonb (`mail-transport-deferred`: zod silently strips, and that is the
   * behaviour we want here).
   */
  // Re-sent whole by the document-settings screens, stored keys included.
  invoice_customization: roundTripped(invoiceCustomizationSchema).nullable().optional(),
  /**
   * Whether invoices inherit their subscription's PO number (0246).
   *
   * Exposed so the setting is reachable: 0246's migration pinned every business that
   * existed at that point to `false` to keep printed documents unchanged, and this is how
   * a merchant turns it on once their buyers expect the PO to appear. New businesses
   * default to `true`.
   */
  inherit_subscription_po_number: z.boolean().optional(),
  // CP-0 optimistic concurrency: reject the write if the row has moved on.
  expected_version: z.number().int().positive().optional(),
});

/**
 * Upload a brand image: `POST /v1/businesses/:biz/brand_images`.
 *
 * Base64 in a JSON body rather than `multipart/form-data`, deliberately. Multipart would
 * need a new body parser, and every route-level convention this API relies on — the
 * `idempotency` preHandler, `requirePerm`, the OpenAPI generation, the request-body
 * validation gate — is built around a parsed JSON body. One upload route is not worth a
 * second request shape that all four of those have to learn. The cost is base64's 33%
 * inflation, paid once per logo change.
 *
 * `content_type` is accepted and NOT trusted: `uploadBrandImage` reads the leading bytes
 * and logs a mismatch. It exists so a mismatch is visible, not so a caller can declare
 * what a file is.
 */
const brandImageBody = z.object({
  asset: z.enum(["logo", "icon", "favicon", "signature"]),
  // Capped at the base64 length of MAX_IMAGE_BYTES so an oversized upload is refused
  // before it is decoded, rather than after allocating the decoded buffer. The route's
  // own `bodyLimit` refuses even earlier, before the body is read at all.
  data: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4),
  content_type: z.string().max(128).optional(),
});

/** The organization has a sidebar logo only, so its upload takes `icon` alone. */
const orgBrandImageBody = brandImageBody.extend({ asset: z.enum(["icon"]) });

/**
 * Upload and answer 201, or map the two refusals: 503 when this deployment has no object
 * storage (ours), 400 when the file is not an allowed image for that asset (theirs).
 */
/**
 * Count one brand image upload against the person (on a session) and the organization. An
 * API key has no person, so only the organization's counter applies to it.
 */
function refusedBrandUpload(
  req: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply,
): Promise<boolean> {
  return refusedByRateLimit(
    req,
    reply,
    {
      scope: "brand_image_upload",
      keys: [
        {
          kind: "user",
          value: req.operatorUserId,
          limit: config.RATE_LIMIT_BRAND_UPLOADS_PER_USER,
        },
        {
          kind: "organization",
          value: req.organization?.id,
          limit: config.RATE_LIMIT_BRAND_UPLOADS_PER_ORG,
        },
      ],
      windowMs: UPLOAD_WINDOW_MS,
    },
    UPLOAD_LIMIT_MESSAGE,
  );
}

async function storeBrandImage(
  reply: import("fastify").FastifyReply,
  owner: BrandImageOwner,
  body: z.infer<typeof brandImageBody>,
) {
  try {
    const stored = await uploadBrandImage({
      owner,
      asset: body.asset,
      buffer: Buffer.from(body.data, "base64"),
      declaredType: body.content_type ?? null,
    });
    return reply.code(201).send({
      object: "brand_image",
      asset: body.asset,
      url: stored.url,
      content_type: stored.contentType,
      bytes: stored.bytes,
    });
  } catch (e) {
    if (e instanceof ObjectStoreNotConfiguredError) {
      // Says the feature is off, not which variables are unset; `e.message` names them
      // and goes to our log.
      return reply.code(503).send({
        error: { type: "api_error", message: "Image uploads are not enabled on this deployment." },
      });
    }
    if (e instanceof ImageUploadError)
      return reply.code(400).send({ error: { type: "invalid_request_error", message: e.message } });
    throw e;
  }
}

function badBody(reply: import("fastify").FastifyReply, err?: z.ZodError) {
  return badRequest(reply, err ?? "The request body must be a JSON object");
}

/**
 * Save-time private-target check for image URLs the PDF renderer fetches — the same
 * guard webhook endpoints use, so a bad address fails here, not at render time. Our
 * own CDN is exempt: a self-hosted object store may sit on a private network.
 */
async function imageUrlRefusal(
  what: string,
  urls: Record<string, string | null | undefined>,
): Promise<string | null> {
  const cdn = config.CDN_URL ? `${config.CDN_URL.replace(/\/+$/, "")}/` : null;
  for (const [field, url] of Object.entries(urls)) {
    if (!url || (cdn && url.startsWith(cdn))) continue;
    if (await checkPublicUrl(url))
      return `We could not save the ${what}. The ${field} URL points to a private or reserved network address. Use a public address.`;
  }
  return null;
}

/**
 * The organization as `/v1/me` and `PATCH /v1/organization` both return it.
 *
 * One function on purpose: the two used to build the object inline, so adding a field
 * to one and not the other was a one-line mistake — and a PATCH that echoes back a
 * payload missing the field it just saved reads exactly like a write that was dropped.
 */
export function serializeOrganization(o: {
  publicId: string;
  name: string;
  timezone: string | null;
  legalName?: string | null;
  address?: unknown;
  taxRegistrationNumber?: string | null;
  baseCurrency?: string | null;
  iconUrl?: string | null;
  liveAccess?: string | null;
  status?: string | null;
}) {
  return {
    object: "organization",
    id: o.publicId,
    name: o.name,
    // Null is the honest value: it means "not set", and every consumer renders UTC.
    timezone: o.timezone,
    // The registered entity, for businesses that issue invoices under the organization.
    // Optional on the input type because `req.organization` is a narrower auth-time row
    // than the full record the PATCH returns; absent reads as "not set", like null.
    legal_name: o.legalName ?? null,
    address: o.address ?? null,
    tax_registration_number: o.taxRegistrationNumber ?? null,
    /** Null means "not chosen" — analytics then refuses and names the options. */
    base_currency: o.baseCurrency ?? null,
    icon_url: o.iconUrl ?? null,
    /** `locked` | `enabled`. `locked` (staff only since 0356) refuses live-business writes (0354). Self-hosted: always `enabled`. */
    live_access: effectiveLiveAccess(o.liveAccess),
    /** `active`, or `restricted`: read-only, its plan unpaid (0354) or staff-approved over its limit (0356). Self-hosted: always `active`. */
    status: effectiveOrganizationStatus(o.status),
  };
}

type BusinessPair = { liveBusinessId: string | null; testBusinessId: string | null };

function serializeBusiness(
  b: typeof businessesTable.$inferSelect,
  locks: AddressFieldLocks = NO_ADDRESS_FIELD_LOCKS,
  pair: BusinessPair | undefined = undefined,
) {
  return {
    object: "business",
    id: b.publicId,
    name: b.name,
    livemode: b.livemode, // 'live' | 'test'
    // The other mode of the same business. On a live row, `test_business_id` is null until
    // test mode is first opened (POST /v1/businesses/:biz/test_mode). Both are null on a
    // legacy standalone test business.
    live_business_id: pair?.liveBusinessId ?? null,
    test_business_id: pair?.testBusinessId ?? null,
    default_currency: b.defaultCurrency,
    currencies: (b.currencies as string[] | null) ?? null,
    exchange_rates: (b.exchangeRates as Record<string, number> | null) ?? null,
    /**
     * The same rates RESOLVED with their provenance (0229) — one row per currency, each
     * saying whether it is maintained by hand or refreshed from a provider, when the rate
     * we hold was published, and why the last refresh failed if it did.
     *
     * Reported alongside `exchange_rates` rather than replacing it: that map is read by
     * metrics, the importer and every existing consumer, and changing its shape to carry
     * provenance would break all of them for a field most do not need.
     */
    currency_rates: currencyRateStates(b).map((r) => ({
      currency: r.currency,
      rate: r.rate,
      source: r.source,
      updated_at: r.updatedAt,
      provider: r.provider,
      last_error: r.lastError,
    })),
    billing_frequencies:
      (b.billingFrequencies as Array<{ interval: string; count: number }> | null) ?? null,
    status: b.status,
    address: b.address ?? null,
    contact_email: b.contactEmail,
    support_email: b.supportEmail,
    phone: b.phone,
    website: b.website,
    logo_url: b.logoUrl,
    icon_url: b.iconUrl,
    favicon_url: b.faviconUrl,
    brand_color: b.brandColor,
    allow_customer_coupons: b.allowCustomerCoupons,
    max_customer_coupon_codes: b.maxCustomerCouponCodes,
    timezone: b.timezone,
    week_start: b.weekStart,
    fiscal_year_start_month: b.fiscalYearStartMonth,
    tax_registration_number: b.taxRegistrationNumber,
    invoice_issuer: b.invoiceIssuer,
    default_tax_code: b.defaultTaxCode,
    invoice_prefix: b.invoicePrefix,
    invoice_next_number: Number(b.invoiceNextNumber),
    default_invoice_notes: b.defaultInvoiceNotes,
    default_due_days: b.defaultDueDays,
    dunning_retry_days: b.dunningRetryDays ?? null,
    create_pending_invoices: b.createPendingInvoices,
    auto_close_pending_after_days: b.autoClosePendingAfterDays,
    invoice_rounding: b.invoiceRounding,
    card_payment_limits: (b.cardPaymentLimits as Record<string, number> | null) ?? null,
    usage_close_delay_minutes: b.usageCloseDelayMinutes,
    credits_flexibility: b.creditsFlexibility ?? null,
    credit_config: b.creditConfig ?? null,
    dunning_config: b.dunningConfig ?? null,
    mandate_config: b.mandateConfig ?? null,
    default_prorate_on_change: b.defaultProrateOnChange,
    default_invoice_immediately: b.defaultInvoiceImmediately,
    inherit_subscription_po_number: b.inheritSubscriptionPoNumber,
    default_cancel_option: b.defaultCancelOption,
    default_credit_option_for_cancel: b.defaultCreditOptionForCancel,
    default_unbilled_on_cancel: b.defaultUnbilledOnCancel,
    default_ar_handling_on_cancel: b.defaultArHandlingOnCancel,
    default_refundable_credits_on_cancel: b.defaultRefundableCreditsOnCancel,
    unbilled_charges_config: b.unbilledChargesConfig ?? null,
    pause_config: withoutLegacyChargesOnResume(b.pauseConfig ?? null),
    billing_rules_config: {
      ...serializeBillingRules(b),
      ...serializeLifecycleConfig(resolveLifecycleConfig(b)),
      ...serializeCollectionRulesConfig(resolveCollectionRulesConfig(b)),
    },
    invoice_rules_config: serializeInvoiceRulesConfig(resolveInvoiceRulesConfig(b)),
    backdating_config: b.backdatingConfig ?? null,
    reminder_config: serializeReminderConfig(b),
    vies_validation_enabled: b.viesValidationEnabled,
    storefront_config: b.storefrontConfig ?? null,
    chargeback_config: b.chargebackConfig ?? null,
    checkout_field_config: b.checkoutFieldConfig ?? null,
    /** Resolved (every key), with tax-locked keys already `mandatory`. */
    portal_field_config: withAddressFieldLocks(resolvePortalFieldConfig(b), locks),
    /** Keys the live tax setup forces to `mandatory` on both matrices. */
    address_field_locks: locks,
    anchor_granularity: b.anchorGranularity,
    proration_granularity: b.prorationGranularity,
    default_tax_behavior: b.defaultTaxBehavior,
    ...serializeTaxSettings(b.taxSettings),
    email_config: withoutLegacyEmailKeys(b.emailConfig ?? null),
    /** Resolved: every key present, off when unset. */
    team_alerts_config: serializeTeamAlertsConfig(resolveTeamAlertsConfig(b)),
    credit_note_prefix: b.creditNotePrefix,
    credit_note_next_number: Number(b.creditNoteNextNumber),
    receipt_prefix: b.receiptPrefix,
    receipt_next_number: Number(b.receiptNextNumber),
    invoice_customization: b.invoiceCustomization ?? null,
    created_at: b.createdAt,
    updated_at: b.updatedAt,
    resource_version: Number(b.resourceVersion),
  };
}

/** What the caller may hand out: a member's keys, or the presenting key's own grant. */
function granterPermissions(req: FastifyRequest): ReadonlySet<string> {
  if (req.hasOperator) return req.operatorPermissions ?? new Set();
  return new Set(apiKeyGrant(req.apiKeyScope ?? "read", req.apiKeyPermissions ?? null));
}

/** "Grant only what you hold" for a key's scope and map. Replies 403 and returns true when refused. */
function refusedKeyGrant(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: "read" | "write",
  map: KeyPermissionMap | null,
): boolean {
  const missing = missingForGrant(granterPermissions(req), scope, map);
  if (missing.length === 0) return false;
  void reply.code(403).send({
    error: {
      type: "permission_error",
      code: "permission_escalation",
      message: `We could not create the API key with this access. It includes permissions that you do not have: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}. Select less access.`,
      missing,
    },
  });
  return true;
}

/** Validate a requested permission map. Null when absent; a string is the 400 message. */
function parseKeyMap(raw: unknown): KeyPermissionMap | null | string {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "permissions must be an object";
  const err = keyMapError(raw as Record<string, unknown>);
  return err ?? (raw as KeyPermissionMap);
}

/** API key view — NEVER includes the hashed key or the raw secret. */
function serializeApiKey(k: typeof apiKeysTable.$inferSelect) {
  return {
    object: "api_key",
    id: k.publicId,
    name: k.name ?? null,
    prefix: k.prefix,
    livemode: k.livemode,
    scope: k.scope,
    /** 0391: `{resource: "read" | "write"}`, or null when the key works by its scope. */
    permissions: k.permissions ?? null,
    last_used_at: k.lastUsedAt,
    created_at: k.createdAt,
    revoked_at: k.revokedAt,
    expires_at: k.expiresAt,
  };
}

/** `bizPublicIds` maps internal business uuid → biz_… public id. */
function serializeEndpoint(
  e: typeof webhookEndpointsTable.$inferSelect,
  bizPublicIds: Map<string, string>,
) {
  return {
    object: "webhook_endpoint",
    id: e.publicId,
    url: e.url,
    business: e.businessId ? (bizPublicIds.get(e.businessId) ?? null) : null,
    enabled: e.enabled === "true",
    livemode: e.livemode,
    event_types: e.eventTypes ?? null,
    description: e.description ?? null,
    created_at: e.createdAt,
  };
}

/** Registers the versioned public API. Grows as each resource lands. */
/** Resend and test-send POST to the subscriber inline: a limit per endpoint and per organization. */
function refusedWebhookSend(req: FastifyRequest, reply: FastifyReply, endpointId: string) {
  return refusedByRateLimit(
    req,
    reply,
    {
      scope: "webhook_send",
      keys: [
        {
          kind: "resource",
          value: endpointId,
          limit: config.RATE_LIMIT_WEBHOOK_SENDS_PER_ENDPOINT,
        },
        {
          kind: "organization",
          value: req.organization!.id,
          limit: config.RATE_LIMIT_WEBHOOK_SENDS_PER_ORG,
        },
      ],
    },
    "You sent too many webhook test or resend requests. Wait a minute and try again.",
  );
}

export async function registerRoutes(app: FastifyInstance) {
  // API reference: machine-readable spec + interactive docs (both public).
  //
  // `servers` is overridden per DEPLOYMENT rather than baked into the spec module. The
  // static value there is "http://localhost:4000", which is right for local dev and is
  // what `sdk:generate` freezes into `sdk/openapi.json` — a build artifact that must stay
  // deterministic, so it is deliberately NOT config-derived. What a reader of the LIVE
  // docs needs is different: `servers` is what Scalar builds its "Shell / Curl" client
  // snippets and its try-it requests from, so serving the local-dev value told everyone
  // reading the production reference to call localhost. WEBHOOK_BASE_URL is already
  // defined as "the public base URL this API is reachable at" (the same value
  // `buildNotificationUrl` hands gateways), and it carries the reverse proxy's path
  // prefix when there is one.
  const publicSpec = config.WEBHOOK_BASE_URL
    ? {
        ...openapiDocument,
        servers: [
          {
            url: config.WEBHOOK_BASE_URL.replace(/\/+$/, ""),
            description: "this deployment",
          },
        ],
      }
    : openapiDocument;
  // Annotated on first read: the permission registry is complete once the app has booted.
  let annotated: typeof publicSpec | null = null;
  app.get(
    "/openapi.json",
    async () => (annotated ??= withPermissions(publicSpec, routePermissions())),
  );
  app.get("/docs", async (_req, reply) => reply.type("text/html").send(DOCS_HTML));

  // Authenticated identity check — proves Bearer API-key auth end to end.
  app.get(
    "/v1/me",
    { preHandler: [authenticate, noMemberPermission("the caller's own credential")] },
    async (req) => {
      return serializeOrganization(req.organization!);
    },
  );

  // Create a business under the authenticated organization.
  app.post(
    "/v1/businesses",
    // 'manager', not 'admin': `createBusiness` in dashboard/app/actions.ts is manager-gated, and
    // a route stricter than the screen that offers it is a button that always fails.
    {
      preHandler: [authenticate, requirePerm("businesses:create"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = parseRequest(createBusinessBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      // A test/live key stamps (and may only create) businesses of its own mode.
      const keyMode = req.keyLivemode!;
      const livemode = parsed.data.livemode ?? (keyMode === "all" ? "live" : keyMode);
      if (keyMode !== "all" && livemode !== keyMode) {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: `A ${keyMode} key cannot create a ${livemode} business`,
          },
        });
      }
      const business = await createBusiness({
        organizationId: req.organization!.id,
        name: parsed.data.name,
        defaultCurrency: parsed.data.default_currency,
        livemode,
        // A person gets the recommended document settings; a key keeps the engine defaults.
        invoiceCustomization: initialDocumentConfig(req),
        // A person gets today's billing rules pinned; a key keeps the resolver defaults.
        billingRulesConfig: withInitialCollectionRules(initialBillingRulesConfig(req), req),
        // A business a signed-in person creates starts with the recommended reminders; a key
        // (any kind) keeps the engine defaults.
        reminderConfig: initialReminderConfig(req),
        // A business a signed-in person creates starts with the recommended checkout
        // settings; a key (any kind) keeps the engine defaults.
        storefrontConfig: initialStorefrontConfig(req),
      });
      const pairs = await businessPairs(req.organization!.id);
      return reply.code(201).send(serializeBusiness(business, undefined, pairs.get(business.id)));
    },
  );

  // List the organization's businesses (test/live keys only see their own mode).
  app.get(
    "/v1/businesses",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req) => {
      const rows = await listBusinesses(req.organization!.id);
      const visible =
        req.keyLivemode === "all" ? rows : rows.filter((b) => b.livemode === req.keyLivemode);
      const locks = await addressFieldLocksByBusiness(
        req.organization!.id,
        visible.map((b) => b.id),
      );
      const pairs = await businessPairs(req.organization!.id);
      return {
        object: "list",
        data: visible.map((b) => serializeBusiness(b, locks.get(b.id), pairs.get(b.id))),
      };
    },
  );

  // Fetch a single business (mode-scoped like the list).
  app.get(
    "/v1/businesses/:biz",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const bizPid = (req.params as { biz: string }).biz;
      const rows = await listBusinesses(req.organization!.id);
      const b = rows.find(
        (r) =>
          r.publicId === bizPid && (req.keyLivemode === "all" || r.livemode === req.keyLivemode),
      );
      if (!b)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such business: ${bizPid}` },
        });
      const locks = await addressFieldLocksByBusiness(req.organization!.id, [b.id]);
      const pairs = await businessPairs(req.organization!.id);
      return serializeBusiness(b, locks.get(b.id), pairs.get(b.id));
    },
  );

  // The test mode of a live business: returns its test twin, creating it on first call
  // (businesses created before twins existed have none yet). Same permission as creating
  // a business, because the first call does.
  app.post(
    "/v1/businesses/:biz/test_mode",
    {
      preHandler: [authenticate, requirePerm("test_mode:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const bizPid = (req.params as { biz: string }).biz;
      const live = await getBusinessByPublicId(req.organization!.id, bizPid);
      if (!live)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such business: ${bizPid}` },
        });
      if (live.livemode !== "live")
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: `${bizPid} is a test business. Test mode is opened from a live business.`,
          },
        });
      const twin = await ensureTestTwin(req.organization!.id, live.id);
      const locks = await addressFieldLocksByBusiness(req.organization!.id, [twin.id]);
      const pairs = await businessPairs(req.organization!.id);
      return serializeBusiness(twin, locks.get(twin.id), pairs.get(twin.id));
    },
  );

  // Update the organization (settings).
  app.patch(
    "/v1/organization",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = parseRequest(updateOrgBody, req.body ?? {});
      if (!parsed.success) return badBody(reply, parsed.error);
      const d = parsed.data;
      const urlRefusal = await imageUrlRefusal("organization", { icon_url: d.icon_url });
      if (urlRefusal) return badRequest(reply, urlRefusal);
      let org;
      try {
        org = await updateOrganization(req.organization!.id, {
          name: d.name,
          // Spread, not `timezone: d.timezone`: the service distinguishes "absent"
          // (leave it alone) from an explicit null/'' (clear it → UTC), and passing
          // `undefined` for a key the caller never sent would be the same value but a
          // different intent to read at a glance.
          ...(d.timezone !== undefined ? { timezone: d.timezone } : {}),
          // Spread for the same reason as `timezone`: absent means "leave it", an
          // explicit null or '' means "clear it".
          ...(d.legal_name !== undefined ? { legalName: d.legal_name } : {}),
          ...(d.address !== undefined ? { address: d.address } : {}),
          ...(d.tax_registration_number !== undefined
            ? { taxRegistrationNumber: d.tax_registration_number }
            : {}),
          // Spread for the same reason as the others: absent leaves it, explicit null clears.
          ...(d.base_currency !== undefined ? { baseCurrency: d.base_currency } : {}),
          ...(d.icon_url !== undefined ? { iconUrl: d.icon_url } : {}),
        });
      } catch (e) {
        // Unreachable while the zod refinement above stands, but the service is the
        // thing that actually decides what gets stored — a validation that lives only
        // in the route is one refactor away from being gone.
        if (e instanceof TenancyError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        throw e;
      }
      return serializeOrganization(org!);
    },
  );

  // Update a business (settings: name, default currency, provider config).
  app.patch(
    "/v1/businesses/:biz",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const bizPid = (req.params as { biz: string }).biz;
      const parsed = parseRequest(updateBusinessBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      // Credit settings belong to `credits:manage` (design G3 §7), not only `settings:manage`.
      if (d.credit_config !== undefined && !callerHolds(req, "credits:manage"))
        return missingPermission(reply, permissionDef("credits:manage")!, !!req.hasOperator);
      const urlRefusal = await imageUrlRefusal("business", {
        logo_url: d.logo_url,
        icon_url: d.icon_url,
        favicon_url: d.favicon_url,
        "invoice_customization.signature.image_url": d.invoice_customization?.signature?.image_url,
      });
      if (urlRefusal) return badRequest(reply, urlRefusal);
      if (
        d.checkout_field_config?.["billing.country"] === "hide" ||
        d.portal_field_config?.["billing.country"] === "hide"
      ) {
        return badRequest(
          reply,
          "Billing country cannot be hidden. The country sets the region list and the postal code format.",
        );
      }
      // Save-time tax guard (0334): the runtime forces these keys anyway; refusing here
      // stops the settings screen from showing a state that does not apply.
      let locks: AddressFieldLocks | undefined;
      const bizRow = await getBusinessByPublicId(req.organization!.id, bizPid);
      if (bizRow) {
        locks = (await addressFieldLocksByBusiness(req.organization!.id, [bizRow.id])).get(
          bizRow.id,
        );
        const violation =
          (d.checkout_field_config != null &&
            locks &&
            addressFieldLockViolation(
              resolveCheckoutFieldConfig({ checkoutFieldConfig: d.checkout_field_config }),
              locks,
            )) ||
          (d.portal_field_config != null &&
            locks &&
            addressFieldLockViolation(
              resolvePortalFieldConfig({ portalFieldConfig: d.portal_field_config }),
              locks,
            ));
        if (violation) return badRequest(reply, violation);
        // 2.48: plan → dunning policy assignments must name this business's plans and policies.
        if (d.dunning_config?.plan_policies) {
          const { planPoliciesViolation } = await import("@/modules/dunning-policies/service");
          const { error, cleaned } = await planPoliciesViolation(
            req.organization!.id,
            bizRow.id,
            d.dunning_config.plan_policies,
            (bizRow.dunningConfig as { plan_policies?: unknown } | null)?.plan_policies,
          );
          if (error) return badRequest(reply, error);
          d.dunning_config.plan_policies = cleaned;
        }
        // Credit scope (2.55): every named price or meter must exist in this business.
        const scope = d.credit_config?.credit_scope;
        if (scope) {
          const missing = await creditScopeMissing(req.organization!.id, bizRow.id, scope);
          if (missing) return badRequest(reply, missing);
        }
      }
      let b;
      try {
        b = await updateBusiness(req.organization!.id, bizPid, {
          name: d.name,
          defaultCurrency: d.default_currency,
          currencies: d.currencies,
          exchangeRates: d.exchange_rates,
          billingFrequencies: d.billing_frequencies,
          address: d.address,
          contactEmail: d.contact_email,
          supportEmail: d.support_email,
          phone: d.phone,
          website: d.website,
          logoUrl: d.logo_url,
          iconUrl: d.icon_url,
          faviconUrl: d.favicon_url,
          brandColor: d.brand_color,
          allowCustomerCoupons: d.allow_customer_coupons,
          maxCustomerCouponCodes: d.max_customer_coupon_codes,
          timezone: d.timezone,
          weekStart: d.week_start,
          fiscalYearStartMonth: d.fiscal_year_start_month,
          taxRegistrationNumber: d.tax_registration_number,
          // Absent means "leave it": the column is NOT NULL with a default, so passing
          // undefined through would be fine, but the spread keeps intent readable
          // alongside the optional fields around it.
          ...(d.invoice_issuer !== undefined ? { invoiceIssuer: d.invoice_issuer } : {}),
          defaultTaxCode: d.default_tax_code,
          invoicePrefix: d.invoice_prefix,
          invoiceNextNumber: d.invoice_next_number,
          defaultInvoiceNotes: d.default_invoice_notes,
          defaultDueDays: d.default_due_days,
          dunningRetryDays: d.dunning_retry_days,
          createPendingInvoices: d.create_pending_invoices,
          autoClosePendingAfterDays: d.auto_close_pending_after_days,
          invoiceRounding: d.invoice_rounding,
          cardPaymentLimits: d.card_payment_limits,
          usageCloseDelayMinutes: d.usage_close_delay_minutes,
          creditsFlexibility: d.credits_flexibility,
          ...(d.credit_config !== undefined
            ? { creditConfig: toBusinessCreditConfig(d.credit_config) }
            : {}),
          dunningConfig: d.dunning_config,
          mandateConfig: d.mandate_config,
          defaultProrateOnChange: d.default_prorate_on_change,
          defaultInvoiceImmediately: d.default_invoice_immediately,
          defaultCancelOption: d.default_cancel_option,
          defaultCreditOptionForCancel: d.default_credit_option_for_cancel,
          defaultUnbilledOnCancel: d.default_unbilled_on_cancel,
          defaultArHandlingOnCancel: d.default_ar_handling_on_cancel,
          defaultRefundableCreditsOnCancel: d.default_refundable_credits_on_cancel,
          unbilledChargesConfig: d.unbilled_charges_config,
          pauseConfig: d.pause_config,
          billingRulesConfig:
            d.billing_rules_config === undefined || d.billing_rules_config === null
              ? d.billing_rules_config
              : mergeBillingRulesConfig(bizRow?.billingRulesConfig, d.billing_rules_config),
          invoiceRulesConfig:
            d.invoice_rules_config === undefined || d.invoice_rules_config === null
              ? d.invoice_rules_config
              : mergeInvoiceRulesConfig(bizRow?.invoiceRulesConfig, d.invoice_rules_config),
          backdatingConfig: d.backdating_config,
          // Merged with the stored lists, and `changed_at` stamped per changed kind.
          reminderConfig:
            d.reminder_config !== undefined && bizRow
              ? mergeReminderConfig(
                  bizRow.reminderConfig,
                  d.reminder_config,
                  await businessWallClock(bizRow.id),
                )
              : undefined,
          viesValidationEnabled: d.vies_validation_enabled,
          storefrontConfig: d.storefront_config,
          chargebackConfig: d.chargeback_config,
          checkoutFieldConfig: d.checkout_field_config,
          portalFieldConfig: d.portal_field_config,
          anchorGranularity: d.anchor_granularity,
          prorationGranularity: d.proration_granularity,
          defaultTaxBehavior: d.default_tax_behavior,
          taxSettings: mergeTaxSettings(bizRow?.taxSettings, d),
          emailConfig: d.email_config,
          teamAlertsConfig: d.team_alerts_config,
          creditNotePrefix: d.credit_note_prefix,
          creditNoteNextNumber: d.credit_note_next_number,
          receiptPrefix: d.receipt_prefix,
          invoiceCustomization: d.invoice_customization,
          inheritSubscriptionPoNumber: d.inherit_subscription_po_number,
          expectedVersion: d.expected_version,
        });
      } catch (e) {
        if (e instanceof VersionConflictError)
          return reply.code(409).send({ error: { type: "conflict_error", message: e.message } });
        throw e;
      }
      if (!b)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such business: ${bizPid}` },
        });
      // New outside addresses get a confirmation mail; removed ones must confirm again.
      if (d.team_alerts_config !== undefined)
        await syncTeamAlertRecipients({
          organizationId: req.organization!.id,
          businessId: b.id,
          businessName: b.name,
          before: resolveTeamAlertsConfig(bizRow).recipients,
          after: resolveTeamAlertsConfig(b).recipients,
        });
      const pairs = await businessPairs(req.organization!.id);
      return serializeBusiness(b, locks, pairs.get(b.id));
    },
  );

  /**
   * Whether this deployment can store uploaded images at all.
   *
   * Exists so the dashboard can render a file picker only when one would work — CLAUDE.md
   * rule 0: never ship a control that does nothing. Object storage is optional
   * deployment config, so on a deployment without a bucket the brand editor must offer
   * the URL field alone rather than an upload button that 503s on click.
   *
   * It reports the boolean and NOT which settings are unset: that is our deployment's
   * configuration, and the caller is an operator of their own organization, not of this
   * deployment. The variable names are in the log and in the 503's message to us.
   */
  app.get(
    "/v1/brand_images/capability",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async () => ({
      object: "brand_image_capability",
      upload_enabled: isObjectStoreConfigured(),
      // Per asset, because `logo` and `signature` are narrower than the rest — they get
      // embedded in the invoice PDF, which cannot carry GIF or WebP. Reported rather than
      // restated in the dashboard so the file picker's filter cannot drift from what this
      // API will actually accept.
      accepts: {
        logo: allowedTypesFor("logo"),
        icon: allowedTypesFor("icon"),
        favicon: allowedTypesFor("favicon"),
        signature: allowedTypesFor("signature"),
        product: allowedTypesFor("product"),
      },
    }),
  );

  /**
   * Store a brand image and return the URL to save on the business.
   *
   * Two steps on purpose, rather than accepting bytes on `PATCH /v1/businesses/:biz`:
   * uploading is not editing the business. The upload succeeds or fails on its own, the
   * caller sees the URL before committing to it, and a failed patch does not lose the
   * file. It also keeps `logo_url` a URL in every path — which is what let the field be
   * scheme-restricted (SR-2026-016 Finding 3) instead of also accepting `data:`.
   *
   * The three failures are deliberately different statuses, because they are three
   * different people's problem:
   *   400 — the file is not an allowed image for THAT asset (the merchant's, and fixable
   *         by them; a logo takes PNG/JPEG only, an icon also takes GIF/WebP)
   *   413 — it is too large (also theirs; fastify refuses it before we read the body)
   *   503 — this deployment has no object storage (ours, and nothing they can do)
   */
  app.post(
    "/v1/businesses/:biz/brand_images",
    {
      // The default 1 MB body limit would refuse a 5 MB image's base64 (≈6.7 MB) as a
      // malformed request. Raised HERE and not globally: every other route in this API
      // takes a small JSON document, and one that accepts an image should not lift the
      // ceiling for all of them.
      bodyLimit: 8 * 1024 * 1024,
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const bizPid = (req.params as { biz: string }).biz;
      const parsed = parseRequest(brandImageBody, req.body ?? {});
      if (!parsed.success) return badBody(reply, parsed.error);

      // Resolve the business before touching the bytes: an upload against someone else's
      // business must not reach the bucket, and the public id becomes part of the key.
      const biz = await getBusinessByPublicId(req.organization!.id, bizPid);
      if (!biz || (req.keyLivemode !== "all" && biz.livemode !== req.keyLivemode))
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such business: ${bizPid}` },
        });

      if (await refusedBrandUpload(req, reply)) return;
      return storeBrandImage(reply, { kind: "business", publicId: biz.publicId }, parsed.data);
    },
  );

  /**
   * Store the ORGANIZATION's sidebar logo and return the URL to save with
   * `PATCH /v1/organization { icon_url }`. The business route's contract, `icon` only.
   */
  app.post(
    "/v1/organization/brand_images",
    {
      bodyLimit: 8 * 1024 * 1024,
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = parseRequest(orgBrandImageBody, req.body ?? {});
      if (!parsed.success) return badBody(reply, parsed.error);
      if (await refusedBrandUpload(req, reply)) return;
      return storeBrandImage(
        reply,
        { kind: "organization", publicId: req.organization!.publicId },
        parsed.data,
      );
    },
  );

  /**
   * Set ONE currency's exchange-rate source — the "Manage currency" dialog.
   *
   * A per-currency sub-resource rather than another field on `PATCH /businesses/:biz`,
   * because that is the shape of the decision: an operator switches INR to auto without
   * saying anything about EUR, and folding it into the whole-business patch would make a
   * partial `exchange_rates` map ambiguous between "leave the others" and "delete them".
   *
   * `source: "auto"` attempts one provider fetch INLINE so the response carries the rate
   * the screen is about to show. A fetch failure is not a 4xx/5xx: the currency is
   * recorded as auto, the previous rate stands, and `last_error` in the response says why
   * it did not move — the caller can tell an updated rate from a kept one by reading
   * `updated_at` and `last_error`, rather than being told "OK" and guessing.
   */
  /**
   * The business's currencies as a resource: the base currency, then every configured or
   * rated one. A thin read over the same state `GET /businesses/:biz` reports.
   */
  const currencyRows = (b: typeof businessesTable.$inferSelect) => {
    const base = b.defaultCurrency?.toUpperCase() ?? null;
    const enabled = ((b.currencies as string[] | null) ?? []).map((c) => c.toUpperCase());
    const rows = currencyRateStates(b).map((r) => ({
      object: "currency" as const,
      currency: r.currency,
      is_base: false,
      enabled: enabled.includes(r.currency),
      rate: r.rate,
      source: r.source as string | null,
      updated_at: r.updatedAt,
      provider: r.provider,
      last_error: r.lastError,
    }));
    return base
      ? [
          {
            object: "currency" as const,
            currency: base,
            is_base: true,
            enabled: true,
            rate: null,
            source: null,
            updated_at: null,
            provider: null,
            last_error: null,
          },
          ...rows,
        ]
      : rows;
  };

  // Customer / subscription usage of a test business against its limit.
  app.get(
    "/v1/businesses/:biz/test_limits",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const { biz: bizPid } = req.params as { biz: string };
      const business = await getBusinessByPublicId(req.organization!.id, bizPid);
      if (!business)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such business: ${bizPid}` },
        });
      const usage = await getTestBusinessUsage(req.organization!.id, business.id);
      if (!usage)
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: "Limits apply only to test businesses.",
          },
        });
      return { object: "test_limits", ...usage };
    },
  );

  app.get(
    "/v1/businesses/:biz/currencies",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const { biz: bizPid } = req.params as { biz: string };
      const business = await getBusinessByPublicId(req.organization!.id, bizPid);
      if (!business)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such business: ${bizPid}` },
        });
      return { object: "list", data: currencyRows(business) };
    },
  );

  app.get(
    "/v1/businesses/:biz/currencies/:currency",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const { biz: bizPid, currency } = req.params as { biz: string; currency: string };
      const business = await getBusinessByPublicId(req.organization!.id, bizPid);
      if (!business)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such business: ${bizPid}` },
        });
      const row = currencyRows(business).find((r) => r.currency === currency.toUpperCase());
      if (!row)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such currency: ${currency}` },
        });
      return row;
    },
  );

  app.put(
    "/v1/businesses/:biz/currencies/:currency",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const { biz: bizPid, currency } = req.params as { biz: string; currency: string };
      const parsed = parseRequest(currencyRateBody, req.body ?? {});
      if (!parsed.success) return badBody(reply, parsed.error);
      const business = await getBusinessByPublicId(req.organization!.id, bizPid);
      if (!business)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such business: ${bizPid}` },
        });
      try {
        const state = await setCurrencyRateSource({
          organizationId: req.organization!.id,
          businessId: business.id,
          currency,
          source: parsed.data.source,
          rate: parsed.data.rate,
          now: new Date(),
        });
        return {
          object: "currency_rate",
          currency: state.currency,
          rate: state.rate,
          source: state.source,
          updated_at: state.updatedAt,
          provider: state.provider,
          last_error: state.lastError,
        };
      } catch (e) {
        if (e instanceof ExchangeRateError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        throw e;
      }
    },
  );

  /**
   * Stop transacting in a currency — the `⋯ → Remove` on the currencies screen.
   *
   * Drops the currency from the enabled list AND deletes its rate and provenance. Both,
   * because either half alone leaves a lie behind: an orphaned rate the daily refresh
   * keeps updating and no screen shows, or a sellable currency with nothing to convert it
   * by. Existing prices and invoices in that currency are untouched — an invoice's own
   * `exchange_rate` snapshot keeps converting after the live rate is gone, which is what
   * stamping it was for.
   */
  app.delete(
    "/v1/businesses/:biz/currencies/:currency",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const { biz: bizPid, currency } = req.params as { biz: string; currency: string };
      const business = await getBusinessByPublicId(req.organization!.id, bizPid);
      if (!business)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such business: ${bizPid}` },
        });
      try {
        const { currency: removed } = await removeCurrency({
          organizationId: req.organization!.id,
          businessId: business.id,
          currency,
          now: new Date(),
        });
        return { object: "currency_rate", currency: removed, deleted: true };
      } catch (e) {
        if (e instanceof ExchangeRateError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        throw e;
      }
    },
  );

  // Outbound webhook endpoints (org-level, optionally scoped to one business).
  /** uuid → biz_… public-id map for endpoint serialization. */
  const bizIdMap = async (orgId: string) =>
    new Map((await listBusinesses(orgId)).map((b) => [b.id, b.publicId]));

  /**
   * Load an endpoint the caller's key is allowed to reach, else null.
   *
   * An endpoint's `livemode` is a partition, not a label: a test credential must not be
   * able to rotate a live endpoint's secret, redirect its URL, delete it, read its
   * delivery log or fire a test POST at the customer's production consumer. Answering
   * 404 rather than 403 is the same non-leaking answer the business partition gives
   * (`platform/auth.ts`) — key mode never reveals the other partition's ids.
   */
  const reachableEndpoint = async (req: FastifyRequest, id: string) => {
    const e = await getEndpoint(req.organization!.id, id);
    if (!e) return null;
    if (req.keyLivemode !== "all" && e.livemode !== req.keyLivemode) return null;
    return e;
  };
  const noSuchEndpoint = (reply: FastifyReply, id: string) =>
    reply.code(404).send({
      error: { type: "invalid_request_error", message: `No such webhook endpoint: ${id}` },
    });

  app.post(
    "/v1/webhook_endpoints",
    {
      preHandler: [authenticate, requirePerm("webhooks:manage"), idempotency],
      onSend: idempotencyOnSend,
      // Returns the signing secret: the request log never stores this response.
      config: { requestLog: "no_response" },
    },
    async (req, reply) => {
      const parsed = parseRequest(createEndpointBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      let businessId: string | null = null;
      // The endpoint's partition. Resolved in this order, never guessed:
      //   1. scoped to a business → the business's livemode, and a contradicting
      //      `livemode` in the body is an error rather than something we quietly ignore
      //      (same "derived, never taken from the caller" rule as gateway_accounts);
      //   2. org-wide + explicit `livemode` → that, provided the key may reach it;
      //   3. org-wide, no `livemode` → the calling key's own mode.
      // Which leaves exactly one combination with no answer — org-wide with a
      // full-access key — and that one is a 400 rather than an invented default.
      let livemode: "test" | "live";
      if (parsed.data.business) {
        const b = await getBusinessByPublicId(req.organization!.id, parsed.data.business);
        if (!b)
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              message: `No such business: ${parsed.data.business}`,
            },
          });
        businessId = b.id;
        livemode = b.livemode as "test" | "live";
        if (parsed.data.livemode && parsed.data.livemode !== livemode) {
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              message: `livemode comes from the business and you cannot override it. ${parsed.data.business} is ${livemode}`,
            },
          });
        }
      } else if (parsed.data.livemode) {
        livemode = parsed.data.livemode;
      } else if (req.keyLivemode === "test" || req.keyLivemode === "live") {
        livemode = req.keyLivemode;
      } else {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: "livemode is required for an org-wide endpoint created with a full-access key",
          },
        });
      }
      // A test credential must not arrange delivery of live events (and vice versa) —
      // that is the partition, not a preference. A full-access key reaches both.
      if (req.keyLivemode !== "all" && livemode !== req.keyLivemode) {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: `A ${req.keyLivemode} key cannot create a ${livemode} webhook endpoint`,
          },
        });
      }
      const badTypes = invalidEventTypes(parsed.data.event_types);
      if (badTypes.length)
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: `Unknown event types: ${badTypes.join(", ")}`,
          },
        });
      let created;
      try {
        created = await createEndpoint({
          organizationId: req.organization!.id,
          url: parsed.data.url,
          businessId,
          livemode,
          eventTypes: parsed.data.event_types ?? null,
          description: parsed.data.description ?? null,
        });
      } catch (err) {
        if (err instanceof EndpointValidationError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: err.message } });
        throw err;
      }
      const { endpoint, secret } = created;
      return reply.code(201).send({
        object: "webhook_endpoint",
        id: endpoint.publicId,
        url: endpoint.url,
        business: parsed.data.business ?? null,
        livemode: endpoint.livemode,
        event_types: endpoint.eventTypes ?? null,
        description: endpoint.description ?? null,
        signing_secret: secret,
        enabled: endpoint.enabled === "true",
        created_at: endpoint.createdAt,
      });
    },
  );

  app.get(
    "/v1/webhook_endpoints",
    { preHandler: [authenticate, requirePerm("webhooks:view")] },
    async (req, reply) => {
      const q = (req.query ?? {}) as { limit?: string; starting_after?: string };
      // Paging is opt-in: without `limit`/`starting_after` the full list comes back as before.
      const paged = q.limit != null || q.starting_after != null;
      let limit = DEFAULT_LIST_LIMIT;
      if (q.limit != null) {
        const n = Number(q.limit);
        if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT)
          return badRequest(reply, `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
        limit = n;
      }
      const [rows, bizIds] = await Promise.all([
        listEndpoints(req.organization!.id),
        bizIdMap(req.organization!.id),
      ]);
      // Mode-scoped like every other list: a test key must not even enumerate the live
      // partition's endpoints. A full-access key (the dashboard) sees both.
      const visible =
        req.keyLivemode === "all" ? rows : rows.filter((e) => e.livemode === req.keyLivemode);
      if (!paged) return { object: "list", data: visible.map((e) => serializeEndpoint(e, bizIds)) };
      // An org holds a handful of endpoints, so this pages in memory. An unknown cursor
      // degrades to the first page, like every keyset list.
      const after = q.starting_after
        ? visible.findIndex((e) => e.publicId === q.starting_after)
        : -1;
      const rest = visible.slice(after + 1);
      const page = rest.slice(0, limit);
      const hasMore = rest.length > limit;
      return {
        object: "list",
        data: page.map((e) => serializeEndpoint(e, bizIds)),
        has_more: hasMore,
        next_cursor: hasMore ? page[page.length - 1]!.publicId : null,
        total: after < 0 ? visible.length : null,
      };
    },
  );

  app.get(
    "/v1/webhook_endpoints/:id",
    { preHandler: [authenticate, requirePerm("webhooks:view")] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const e = await reachableEndpoint(req, id);
      if (!e) return noSuchEndpoint(reply, id);
      // Same shape as a list row: the signing secret is shown only at create and rotate.
      return serializeEndpoint(e, await bizIdMap(req.organization!.id));
    },
  );

  // Enable/disable, change URL, or re-scope an endpoint to a business.
  app.patch(
    "/v1/webhook_endpoints/:id",
    {
      preHandler: [authenticate, requirePerm("webhooks:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const parsed = parseRequest(updateEndpointBody, req.body ?? {});
      if (!parsed.success) return badBody(reply, parsed.error);
      const existing = await reachableEndpoint(req, id);
      if (!existing) return noSuchEndpoint(reply, id);
      let businessId: string | null | undefined;
      if (parsed.data.business === null) businessId = null;
      else if (parsed.data.business !== undefined) {
        const b = await getBusinessByPublicId(req.organization!.id, parsed.data.business);
        if (!b)
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              message: `No such business: ${parsed.data.business}`,
            },
          });
        // Re-scoping stays inside the endpoint's own partition: `livemode` is immutable
        // after creation (like a business's), so an endpoint that has been receiving
        // sandbox traffic can never be moved onto the live stream by an edit.
        if (b.livemode !== existing.livemode) {
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              message: `Cannot re-scope a ${existing.livemode} endpoint to a ${b.livemode} business. livemode is immutable. Create a new endpoint`,
            },
          });
        }
        businessId = b.id;
      }
      const badTypes = invalidEventTypes(parsed.data.event_types);
      if (badTypes.length)
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: `Unknown event types: ${badTypes.join(", ")}`,
          },
        });
      let e;
      try {
        e = await updateEndpoint(req.organization!.id, id, {
          enabled: parsed.data.enabled,
          url: parsed.data.url,
          businessId,
          eventTypes: parsed.data.event_types,
          description: parsed.data.description,
        });
      } catch (err) {
        if (err instanceof EndpointValidationError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: err.message } });
        throw err;
      }
      if (!e)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such webhook endpoint: ${id}` },
        });
      return serializeEndpoint(e, await bizIdMap(req.organization!.id));
    },
  );

  app.delete(
    "/v1/webhook_endpoints/:id",
    {
      preHandler: [authenticate, requirePerm("webhooks:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!(await reachableEndpoint(req, id))) return noSuchEndpoint(reply, id);
      const ok = await deleteEndpoint(req.organization!.id, id);
      if (!ok) return noSuchEndpoint(reply, id);
      return { object: "webhook_endpoint", id, deleted: true };
    },
  );

  // Rotate the signing secret — returned once.
  app.post(
    "/v1/webhook_endpoints/:id/rotate_secret",
    {
      preHandler: [authenticate, requirePerm("webhooks:manage"), idempotency],
      onSend: idempotencyOnSend,
      config: { requestLog: "no_response" },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!(await reachableEndpoint(req, id))) return noSuchEndpoint(reply, id);
      const r = await rotateSecret(req.organization!.id, id);
      if (!r) return noSuchEndpoint(reply, id);
      return {
        ...serializeEndpoint(r.endpoint, await bizIdMap(req.organization!.id)),
        signing_secret: r.secret,
      };
    },
  );

  // Delivery attempt log for an endpoint.
  app.get(
    "/v1/webhook_endpoints/:id/deliveries",
    { preHandler: [authenticate, requirePerm("webhooks:view")] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!(await reachableEndpoint(req, id))) return noSuchEndpoint(reply, id);
      const parsed = parseListQuery(req, reply, {
        filterOps: WEBHOOK_DELIVERY_FILTER_OPS,
        filterKinds: WEBHOOK_DELIVERY_FILTER_KINDS,
        sortFields: WEBHOOK_DELIVERY_SORT_FIELDS,
        includeDeleted: "none",
      });
      if (!parsed) return;
      for (const f of parsed.filters) {
        if (f.field !== "http_status") continue;
        const problem = httpStatusFilterError(f.op, f.value);
        if (problem)
          return badRequest(reply, `Invalid value for 'http_status[${f.op}]': ${problem}`);
      }
      // 100 by default: the page size this list had before it paginated.
      const page = await listDeliveriesPage(req.organization!.id, id, {
        ...parsed,
        limit: parsed.limit ?? 100,
      });
      if (!page) return noSuchEndpoint(reply, id);
      return listResponse(page, (r) => ({
        object: "webhook_delivery",
        id: r.delivery.id,
        event: r.eventPublicId,
        event_type: r.eventType,
        status: r.delivery.status,
        attempts: r.delivery.attempts,
        last_attempt_at: r.delivery.lastAttemptAt,
        next_attempt_at: r.delivery.nextAttemptAt,
        last_response_status: r.delivery.lastResponseStatus,
        last_error: r.delivery.lastError,
        created_at: r.delivery.createdAt,
      }));
    },
  );

  /**
   * The wire shape of a synchronous resend: what the delivery row now says, plus the ONE attempt
   * we just made.
   *
   * `attempt` is live-only — nothing about it is persisted (see `DeliveryTranscript`), so this
   * response is the only place it will ever exist. A caller that wants a history of attempts has
   * `attempts` and `last_response_status` on the delivery, which is what the durable record has
   * always held.
   */
  const serializeRedelivery = (r: RedeliverResult) => ({
    object: "webhook_delivery",
    id: r.delivery.id,
    status: r.delivery.status,
    attempts: r.delivery.attempts,
    next_attempt_at: r.delivery.nextAttemptAt,
    last_response_status: r.delivery.lastResponseStatus,
    attempt: {
      outcome: r.transcript.outcome,
      latency_ms: r.transcript.latencyMs,
      error: r.transcript.error,
      request: r.transcript.request,
      response: r.transcript.response,
    },
  });

  /**
   * WH-2: resend a past delivery. SYNCHRONOUS since 2026-09-02 — it calls the subscriber inline
   * and answers with the outcome plus this attempt's transcript, so an operator pressing Resend
   * learns whether their receiver works now instead of being told it was queued.
   *
   * Hence 200, not the 202 it used to answer: 202 means "accepted, will happen later", which
   * would now be false. The delivery row is still written and still settled by the shared
   * `attemptDelivery`, so a crash mid-POST leaves it for the clock exactly as before.
   */
  app.post(
    "/v1/webhook_endpoints/:id/deliveries/:del/redeliver",
    {
      preHandler: [authenticate, requirePerm("webhooks:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const { id, del } = req.params as { id: string; del: string };
      if (!(await reachableEndpoint(req, id))) return noSuchEndpoint(reply, id);
      if (await refusedWebhookSend(req, reply, id)) return;
      try {
        const result = await redeliverDelivery(req.organization!.id, id, del);
        if (!result)
          return reply.code(404).send({
            error: {
              type: "invalid_request_error",
              message: `No such delivery ${del} for endpoint ${id}`,
            },
          });
        return reply.code(200).send(serializeRedelivery(result));
      } catch (e) {
        if (e instanceof RedeliverConflictError)
          return reply.code(409).send({ error: { type: "conflict_error", message: e.message } });
        throw e;
      }
    },
  );

  /**
   * One-click "is this endpoint working again?" — redeliver its most recent delivery.
   *
   * The per-delivery route above needs a delivery id, which means going and finding one; that is
   * right from the Deliveries list and useless as a health check after fixing a receiver.
   *
   * A brand-new endpoint with no history is NOT an error — it is the common case on a freshly
   * added endpoint — so it answers 409 with a message the operator can act on, distinct from the
   * 404 for an endpoint that does not exist.
   */
  /**
   * Requeue every failed delivery on this endpoint. The replay goes through the outbox rather
   * than inline, so this answers immediately with a count instead of holding the request open
   * for one POST per dead delivery.
   */
  app.post(
    "/v1/webhook_endpoints/:id/redeliver_failed",
    {
      preHandler: [authenticate, requirePerm("webhooks:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await reachableEndpoint(req, id))) return noSuchEndpoint(reply, id);
      if (await refusedWebhookSend(req, reply, id)) return;
      const result = await requeueFailed(req.organization!.id, id);
      if (!result) return noSuchEndpoint(reply, id);
      return reply.code(200).send({ object: "webhook_requeue", endpoint: id, ...result });
    },
  );

  app.post(
    "/v1/webhook_endpoints/:id/redeliver_latest",
    {
      preHandler: [authenticate, requirePerm("webhooks:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await reachableEndpoint(req, id))) return noSuchEndpoint(reply, id);
      if (await refusedWebhookSend(req, reply, id)) return;
      try {
        const result = await redeliverLatest(req.organization!.id, id);
        if (result === null) return noSuchEndpoint(reply, id);
        if (result === "no_deliveries") {
          return reply.code(409).send({
            error: {
              type: "conflict_error",
              message: `Endpoint ${id} has no deliveries yet. It receives only the events that occur after its creation, so there is nothing to resend.`,
            },
          });
        }
        return reply.code(200).send(serializeRedelivery(result));
      } catch (e) {
        if (e instanceof RedeliverConflictError)
          return reply.code(409).send({ error: { type: "conflict_error", message: e.message } });
        throw e;
      }
    },
  );

  // WH-3: send a canned sample payload for {type} and return the receiver's status.
  app.post(
    "/v1/webhook_endpoints/:id/test",
    {
      preHandler: [authenticate, requirePerm("webhooks:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const parsed = parseRequest(testSendBody, req.body ?? {});
      if (!parsed.success) return badBody(reply, parsed.error);
      if (!isEventType(parsed.data.type))
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: `Unknown event type: ${parsed.data.type}`,
          },
        });
      if (!(await reachableEndpoint(req, id))) return noSuchEndpoint(reply, id);
      if (await refusedWebhookSend(req, reply, id)) return;
      const result = await testSendEndpoint(
        req.organization!.id,
        id,
        parsed.data.type as EventType,
      );
      if (!result) return noSuchEndpoint(reply, id);
      return {
        object: "webhook_test",
        endpoint: id,
        type: parsed.data.type,
        response_status: result.responseStatus,
        latency_ms: result.latencyMs,
        delivered: result.responseStatus >= 200 && result.responseStatus < 300,
      };
    },
  );

  // API keys (org-level). Managed from the dashboard with the org's system credential.
  //
  // The list is the org's OWN integration keys (`kind='api'`). The system credential the
  // dashboard authenticates with is not one of them: `listApiKeys` filters it out and
  // `revokeApiKey` refuses it (404), so the surface can't offer an operator a Revoke
  // button that would lock their dashboard out of the org. `POST` only ever mints
  // `kind='api'` — see `createApiKey`.
  app.get(
    "/v1/api_keys",
    { preHandler: [authenticate, requirePerm("api_keys:view")] },
    async (req) => {
      const rows = await listApiKeys(req.organization!.id);
      return { object: "list", data: rows.map(serializeApiKey) };
    },
  );

  /**
   * RESOLVED (2026-08-04, 🔶 security) — the trade-off this comment used to describe is
   * gone, not reversed. The route stays protected (a retry must never mint a SECOND live
   * credential the caller cannot see), and `config: idempotentNoStore` stops the raw
   * `sk_…` from being persisted: `api_keys` keeps only `hashed_key`, so without the flag
   * `idempotency_keys.response_body` — plain `jsonb` — became the credential's only
   * plaintext home and quietly repealed "shown once".
   *
   * What a retry of this route now gets: NOT a second key, and NOT the secret. The
   * handler is not re-executed; the caller receives a 409 `response_not_replayable`
   * carrying `created: true` and `original_response_status: 201`, i.e. "it worked, the
   * key exists, the secret cannot be shown again — list the keys, and mint a fresh one
   * with a new Idempotency-Key if you need a usable secret." See
   * `platform/idempotency.ts`'s `idempotentNoStore` / `notStoredReplay` for the reasoning
   * behind answering 409 rather than a secret-less 201.
   *
   * `/v1/webhook_endpoints` and `…/rotate_secret` return a secret too and deliberately do
   * NOT take the flag: `webhook_endpoints.signing_secret` (db/schema/tenancy.ts) is
   * already stored in the clear in the same RLS scope because we need it to HMAC every
   * delivery, so storing the response body adds no new plaintext home — and a normal
   * replay is genuinely useful there.
   */
  // 'developer', not 'admin': the dashboard's Developers page is developer-gated and is where
  // keys are minted and revoked, so anything stricter here is a button that always fails.
  //
  // ⚠ Worth an explicit PRODUCT answer rather than silence: an API key currently carries full
  // organization privilege, so "a developer may mint a key" reads as "a developer may grant
  // themselves everything". Read/write scopes narrow that a great deal — a read key is a
  // different proposition from a write key — but who may mint a WRITE key is still a question.
  app.post(
    "/v1/api_keys",
    {
      preHandler: [authenticate, requirePerm("api_keys:manage"), idempotency],
      onSend: idempotencyOnSend,
      config: idempotentNoStore,
    },
    async (req, reply) => {
      // An organization that requires 2FA refuses a new key to a member without it (0329).
      if (
        req.operatorUserId &&
        (await newApiKeyRefusedFor(req.operatorUserId, req.organization!.id))
      ) {
        return reply.code(403).send({
          error: {
            type: "two_factor_setup_required",
            message: `${req.organization!.name} requires two-factor authentication. Set it up to create new API keys. Your existing keys keep working.`,
          },
        });
      }
      // Values are validated one by one below; this only refuses keys the route has not got.
      const keys = parseRequest(
        z.object({
          livemode: z.unknown().optional(),
          scope: z.unknown().optional(),
          name: z.unknown().optional(),
          expires_at: z.unknown().optional(),
          permissions: z.unknown().optional(),
        }),
        req.body ?? {},
      );
      if (!keys.success) return badRequest(reply, keys.error);
      const raw = (req.body as { livemode?: string } | undefined)?.livemode;
      const livemode = raw === "live" || raw === "all" ? raw : "test";
      // Scope (audit H1.3). Anything other than an explicit "read" mints a write key, so a
      // typo cannot silently produce a credential that is weaker than the caller believes —
      // a read key that was meant to be a write key fails loudly on first use, which is the
      // right direction for a mistake to fall.
      const rawScope = (req.body as { scope?: string } | undefined)?.scope;
      if (rawScope !== undefined && rawScope !== "read" && rawScope !== "write") {
        return reply.code(400).send({
          error: { type: "invalid_request_error", message: "scope must be 'read' or 'write'" },
        });
      }
      const map = parseKeyMap((req.body as { permissions?: unknown } | undefined)?.permissions);
      if (typeof map === "string") return badRequest(reply, map);
      // A map decides the scope, so the method wall agrees with it.
      if (map && rawScope !== undefined && rawScope !== scopeForMap(map)) {
        return badRequest(
          reply,
          `scope "${rawScope}" does not agree with permissions. Leave scope out, or send "${scopeForMap(map)}".`,
        );
      }
      const scope = map ? scopeForMap(map) : rawScope === "read" ? "read" : "write";
      // Grant only what you hold (D2): a member without full access cannot mint a full key.
      if (refusedKeyGrant(req, reply, scope, map)) return;
      // What the key is for. Optional — an unnamed key is legal, and a blank string means
      // the operator left the box empty, which is "unnamed", not a name of "". Bounded at
      // LIMITS.name like every other name column; over-length is a 400 rather than a silent
      // truncation, because a key someone cannot recognise is the problem this field exists
      // to solve.
      const rawName = (req.body as { name?: unknown } | undefined)?.name;
      if (rawName !== undefined && rawName !== null && typeof rawName !== "string") {
        return reply.code(400).send({
          error: { type: "invalid_request_error", message: "name must be a string" },
        });
      }
      const trimmedName = typeof rawName === "string" ? rawName.trim() : "";
      if (trimmedName.length > LIMITS.name) {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: `name must be at most ${LIMITS.name} characters`,
          },
        });
      }
      const name = trimmedName === "" ? null : trimmedName;
      // Optional expiry (0374): an ISO 8601 time in the future, or null/absent for never.
      const rawExpiry = (req.body as { expires_at?: unknown } | undefined)?.expires_at;
      let expiresAt: Date | null = null;
      if (rawExpiry !== undefined && rawExpiry !== null) {
        const parsedExpiry = z.string().datetime({ offset: true }).safeParse(rawExpiry);
        if (!parsedExpiry.success) {
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              message: "expires_at must be an ISO 8601 date-time, for example 2027-01-31T00:00:00Z",
            },
          });
        }
        expiresAt = new Date(parsedExpiry.data);
        if (expiresAt.getTime() <= Date.now()) {
          return reply.code(400).send({
            error: { type: "invalid_request_error", message: "expires_at must be in the future" },
          });
        }
      }
      // No key mints a full-access key any more, not even another full-access one.
      // This route only ever mints `kind='api'`, and `api_keys_mode_kind_ck` confines
      // `livemode='all'` — the single mode-crossing credential — to `kind='dashboard'`:
      // our own UI is one surface over a whole
      // organization and genuinely spans both partitions; an integration never does.
      // Without this the request would reach the CHECK and come back as a 500.
      if (livemode === "all") {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message:
              'livemode "all" is reserved for the dashboard credential. Mint a test or live key',
          },
        });
      }
      const { apiKey, secret } = await createApiKey(
        req.organization!.id,
        livemode,
        "api",
        scope,
        name,
        expiresAt,
        map,
      );
      return reply.code(201).send({ ...serializeApiKey(apiKey), secret }); // secret shown once
    },
  );

  // Rotation (0374): a new key with the same name, mode and scope; the old key keeps working
  // for `overlap_seconds` (default 24 hours, 0 = stop now). Same storage rule as the mint: the
  // secret is never kept in the idempotency record, so a retry answers 409, not a second key.
  // Same 2FA gate as the mint too, because a rotation hands out a new credential.
  app.post(
    "/v1/api_keys/:id/rotate",
    {
      preHandler: [authenticate, requirePerm("api_keys:manage"), idempotency],
      onSend: idempotencyOnSend,
      config: idempotentNoStore,
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (
        req.operatorUserId &&
        (await newApiKeyRefusedFor(req.operatorUserId, req.organization!.id))
      ) {
        return reply.code(403).send({
          error: {
            type: "two_factor_setup_required",
            message: `${req.organization!.name} requires two-factor authentication. Set it up to rotate API keys. Your existing keys keep working.`,
          },
        });
      }
      const parsed = parseRequest(
        z.object({
          overlap_seconds: z
            .number()
            .int()
            .nonnegative()
            .max(ROTATION_OVERLAP_MAX_SECONDS)
            .optional(),
        }),
        req.body ?? {},
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const rotated = await rotateApiKey(
          req.organization!.id,
          id,
          parsed.data.overlap_seconds ?? ROTATION_OVERLAP_DEFAULT_SECONDS,
        );
        if (!rotated)
          return reply.code(404).send({
            error: { type: "invalid_request_error", message: `No such API key: ${id}` },
          });
        return reply.code(201).send({
          ...serializeApiKey(rotated.apiKey),
          secret: rotated.secret, // shown once
          previous_key: serializeApiKey(rotated.previous),
        });
      } catch (e) {
        if (e instanceof ApiKeyRotationError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // NO re-authentication on REVOKE. Revocation is the action someone takes when they think a
  // key has leaked, and the whole value of it is being instant — putting a re-authentication in
  // front of it adds friction at the exact moment friction is most expensive. Destroying a
  // credential is fail-safe in the direction that matters.
  //
  // ⚠ As of 2026-09-02 MINTING carries no re-authentication either: `requireStepUp` was removed
  // from every route on our user's instruction (audit M3.3 rolled back — docs/PROGRESS.md). The
  // asymmetry this comment used to describe is gone; the reasoning is kept because
  // `checkout-routes.ts` and `customer-portal-routes.ts` both cite it, and it is still why
  // revoke should never grow one back.
  app.post(
    "/v1/api_keys/:id/revoke",
    {
      preHandler: [authenticate, requirePerm("api_keys:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const row = await revokeApiKey(req.organization!.id, id);
      if (!row)
        return reply
          .code(404)
          .send({ error: { type: "invalid_request_error", message: `No such API key: ${id}` } });
      return serializeApiKey(row);
    },
  );

  // Change a key's name or access (0391). Same "grant only what you hold" rule as the mint.
  app.patch(
    "/v1/api_keys/:id",
    {
      preHandler: [authenticate, requirePerm("api_keys:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const parsed = parseRequest(
        z.object({
          name: z.string().max(LIMITS.name).nullable().optional(),
          permissions: z.unknown().optional(),
          scope: z.enum(["read", "write"]).optional(),
        }),
        req.body ?? {},
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      const [current] = (await listApiKeys(req.organization!.id)).filter((k) => k.publicId === id);
      if (!current)
        return reply
          .code(404)
          .send({ error: { type: "invalid_request_error", message: `No such API key: ${id}` } });
      const body = req.body as { permissions?: unknown };
      let patch: Parameters<typeof updateApiKey>[2] = {};
      if (parsed.data.name !== undefined) {
        const n = parsed.data.name?.trim() ?? "";
        patch.name = n === "" ? null : n;
      }
      if ("permissions" in (body ?? {}) || parsed.data.scope) {
        const map =
          "permissions" in (body ?? {}) ? parseKeyMap(body.permissions) : current.permissions;
        if (typeof map === "string") return badRequest(reply, map);
        if (map && parsed.data.scope && parsed.data.scope !== scopeForMap(map))
          return badRequest(reply, "scope does not agree with permissions. Leave scope out.");
        const scope = map
          ? scopeForMap(map)
          : (parsed.data.scope ?? (current.scope as "read" | "write"));
        if (refusedKeyGrant(req, reply, scope, map)) return;
        patch = { ...patch, permissions: map, scope };
      }
      const row = await updateApiKey(req.organization!.id, id, patch);
      if (!row)
        return reply
          .code(404)
          .send({ error: { type: "invalid_request_error", message: `No such API key: ${id}` } });
      return serializeApiKey(row);
    },
  );

  await registerRoleRoutes(app);

  // Catalog (products + prices), customers, and payment methods — under a business.
  await registerCatalogRoutes(app);
  await registerCustomerRoutes(app);
  await registerPaymentMethodRoutes(app);
  await registerSubscriptionRoutes(app);
  await registerInvoiceRoutes(app);
  await registerTaxRoutes(app);
  await registerRefundRoutes(app);
  await registerCouponRoutes(app);
  await registerCatalogStatsRoutes(app);
  await registerWalletRoutes(app);
  await registerTeamAlertRoutes(app);
  await registerCreditNoteRoutes(app);
  await registerEntitlementRoutes(app);
  await registerPortalRoutes(app);
  await registerCustomerPortalRoutes(app);
  await registerPortalCreditRoutes(app);
  await registerCheckoutRoutes(app);
  await registerPaymentLinkRoutes(app);
  await registerMetricsRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerAuthRoutes(app);
  await registerWebhookRoutes(app);
  // SES delivery feedback over SNS. Separate registration because it needs its own raw
  // body parser for `text/plain` — SNS posts JSON under that content type.
  await registerEmailWebhookRoutes(app);
  await registerEventRoutes(app);
  await registerGatewayRoutes(app);
  await registerDeclineRuleRoutes(app);
  await registerGeoRoutes(app);
  await registerDisputeRoutes(app);
  await registerEmailRoutes(app);
  await registerTmtestRoutes(app);
  await registerTransactionRoutes(app);
  await registerPaymentIntentRoutes(app);
  await registerAuditRoutes(app);
  await registerRequestLogRoutes(app);
  await registerCommentRoutes(app);
  await registerUsageRoutes(app);
  await registerUsageViewRoutes(app);
  await registerUsageEventRoutes(app);
  await registerCreditHoldRoutes(app);
  await registerMeterRoutes(app);
  await registerModelPriceRoutes(app);
  await registerCreditRoutes(app);
  await registerRateChangePreviewRoutes(app);
  await registerUsageWidgetRoutes(app);
  await registerUsageControlRoutes(app);
  await registerPortalUsageControlRoutes(app);
  await registerUsageBillingRoutes(app);
  await registerListViewRoutes(app);
  await registerReportDashboardRoutes(app);
  await registerSegmentRoutes(app);
  await registerTransferRoutes(app);
  await registerTimeTravelRoutes(app);
  await registerCustomFieldRoutes(app);
  await registerMetadataRuleRoutes(app);
  await registerPaymentInstructionRoutes(app);
  await registerReasonCodeRoutes(app);
  await registerDunningPolicyRoutes(app);
  await registerReceiptRoutes(app);
  await registerPaymentRequestRoutes(app);
  await registerHubSpotRoutes(app);
  await registerIntegrationRoutes(app);
  await registerHubSpotConflictRoutes(app);
  await registerHubSpotAppRoutes(app);
}
