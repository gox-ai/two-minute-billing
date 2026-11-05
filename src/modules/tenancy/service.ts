// TYPE-ONLY: `modules/auth/service` imports THIS module, so a value import would close a
// runtime cycle. A type import is erased at compile time and cannot.
import type { Role } from "@/modules/auth/service";
import type { KeyPermissionMap } from "@/modules/auth/permissions";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { recordExchangeRateObservations } from "@/platform/fx/history";
import { publicId } from "@/platform/ids";
import {
  generateApiKey,
  hashApiKey,
  type ApiKeyKind,
  type KeyMode,
  type Livemode,
  type ApiKeyScope,
  type GeneratedApiKey,
} from "@/platform/api-key";
import { apiKeys, businesses, organizations, type BusinessCreditConfig } from "@db/schema";
import type { AnchorGranularity, ProrationGranularity } from "@db/schema/tenancy";
import { VersionConflictError } from "@/api/helpers";
import { InvalidTimezoneError, normalizeTimezone } from "@/platform/timezones";
import { WEEK_STARTS, type WeekStart } from "@/platform/business-calendar";
import { createLogger } from "@/platform/logger";

const log = createLogger("tenancy");

export class TenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenancyError";
  }
}

/**
 * `normalizeTimezone` as a TenancyError, so the API maps it to 400 like every other
 * business-settings validation. Returns the MODERN name to store — see
 * `src/platform/timezones.ts` for why legacy spellings are rewritten rather than kept.
 */
function timezoneToStore(tz: string): string {
  try {
    return normalizeTimezone(tz);
  } catch (e) {
    throw e instanceof InvalidTimezoneError ? new TenancyError(e.message) : e;
  }
}

/** A billing frequency a business allows for its prices. */
export interface BillingFrequency {
  interval: "day" | "week" | "month" | "year";
  count: number;
}

const VALID_INTERVALS = new Set(["day", "week", "month", "year"]);

/** Validate + de-duplicate a billing-frequency allow-list. Throws on bad input. */
export function normalizeBillingFrequencies(list: BillingFrequency[]): BillingFrequency[] {
  const seen = new Set<string>();
  const out: BillingFrequency[] = [];
  for (const f of list) {
    if (!VALID_INTERVALS.has(f.interval)) throw new TenancyError(`Invalid interval: ${f.interval}`);
    if (!Number.isInteger(f.count) || f.count < 1)
      throw new TenancyError(`Invalid frequency count: ${f.count}`);
    const key = `${f.interval}:${f.count}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ interval: f.interval, count: f.count });
  }
  return out;
}

/** True when `interval`×`count` is allowed by the business's frequency list (null list = allow all). */
export function isFrequencyAllowed(
  allowed: BillingFrequency[] | null | undefined,
  interval: string | null | undefined,
  count: number | null | undefined,
): boolean {
  if (!allowed || allowed.length === 0) return true; // no restriction configured
  if (!interval) return true; // one-time / non-recurring prices carry no interval
  const c = count ?? 1;
  return allowed.some((f) => f.interval === interval && f.count === c);
}

export interface CreateOrganizationResult {
  organization: typeof organizations.$inferSelect;
  apiKey: typeof apiKeys.$inferSelect;
  /** The raw secret — returned to the caller once, never stored. */
  secret: string;
}

/**
 * Create an organization (the tmbilling account) + its first API key, atomically.
 * The bootstrap key defaults to full access ('all': reaches test AND live
 * businesses) — it's the key the owner/dashboard operates with.
 *
 * It is minted `kind: 'dashboard'`, which is what makes the dashboard's traffic read
 * as an operator working in our UI rather than as an API integration everywhere
 * provenance is shown (events, audit logs, the invoice/credit-note channel). It is
 * also why it never appears in `listApiKeys` and cannot be revoked through the API —
 * see `db/schema/tenancy.ts` § apiKeys.
 */
export async function createOrganization(input: {
  name: string;
  livemode?: KeyMode;
  /** `locked` makes its live businesses refuse writes (0354). */
  liveAccess?: "locked" | "enabled";
  /** What enabled live mode: `plan:free` for a Cloud sign-up (0356). */
  liveAccessEnabledBy?: string | null;
  country?: string | null;
  signupAnswers?: Record<string, string> | null;
}): Promise<CreateOrganizationResult> {
  return systemDb.transaction((tx) => insertOrganization(tx, input));
}

/** `createOrganization` inside a caller's transaction: the org and its dashboard credential. */
export async function insertOrganization(
  tx: Tx,
  input: Parameters<typeof createOrganization>[0],
): Promise<CreateOrganizationResult> {
  const livemode = input.livemode ?? "all";
  const [organization] = await tx
    .insert(organizations)
    .values({
      publicId: publicId("org"),
      name: input.name,
      liveAccess: input.liveAccess ?? "enabled",
      ...(input.liveAccessEnabledBy
        ? { liveAccessEnabledBy: input.liveAccessEnabledBy, liveAccessEnabledAt: new Date() }
        : {}),
      country: input.country ?? null,
      signupAnswers: input.signupAnswers ?? null,
    })
    .returning();

  const key = generateApiKey(livemode);
  const [apiKey] = await tx
    .insert(apiKeys)
    .values({
      organizationId: organization!.id,
      publicId: publicId("key"),
      prefix: key.prefix,
      hashedKey: key.hashed,
      livemode,
      kind: "dashboard",
    })
    .returning();

  return { organization: organization!, apiKey: apiKey!, secret: key.raw };
}

type BusinessRow = typeof businesses.$inferSelect;
type TenantTx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * Insert the test twin of a live business: a copy of its settings that is independent
 * from here on. Numbering restarts at 1 and gateways do not carry over — the twin gets
 * the TM Test Gateway instead (see `provisionTestGateway`). Team alerts do not carry over
 * either: they mail real staff, and a twin would send a second, unmarked set.
 */
async function insertTestTwin(tx: TenantTx, live: BusinessRow): Promise<BusinessRow> {
  const {
    id,
    publicId: _publicId,
    livemode: _livemode,
    liveBusinessId: _liveBusinessId,
    liveBusinessMode: _liveBusinessMode,
    defaultGatewayAccountId: _defaultGateway,
    invoiceNextNumber: _invoiceNext,
    creditNoteNextNumber: _creditNoteNext,
    receiptNextNumber: _receiptNext,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    resourceVersion: _resourceVersion,
    teamAlertsConfig: _teamAlerts,
    ...settings
  } = live;
  const [row] = await tx
    .insert(businesses)
    .values({ ...settings, publicId: publicId("biz"), livemode: "test", liveBusinessId: id })
    .returning();
  return row!;
}

// TL-5: a test business is created with an enabled TM Test Gateway. Runs after the
// business row commits so the gateway service can see it.
async function provisionTestGateway(organizationId: string, businessId: string): Promise<void> {
  const { createGatewayAccount } = await import("@/modules/gateway/service");
  await createGatewayAccount({
    organizationId,
    businessId,
    gatewayKey: "tmtest",
    label: "TM Test Gateway",
    credentials: {},
  });
}

/**
 * Create a business under an organization: a LIVE row plus its TEST twin, in one
 * transaction. Returns the row for `livemode` (default live).
 */
export async function createBusiness(input: {
  organizationId: string;
  name: string;
  defaultCurrency: string;
  livemode?: Livemode;
  /** IANA timezone for day-anchored terms + reporting (default UTC). */
  timezone?: string;
  /** Billing mode — see businesses.anchor_granularity / proration_granularity. */
  anchorGranularity?: AnchorGranularity;
  prorationGranularity?: ProrationGranularity;
  /** Starting document customization (`initialDocumentConfig`); absent = engine defaults. */
  invoiceCustomization?: Record<string, unknown>;
  /** `billing_rules_config` to start with; omitted = today's behaviour. */
  billingRulesConfig?: Record<string, unknown>;
  /** The stored `reminder_config`; absent = engine defaults. Copied to the test twin. */
  reminderConfig?: Record<string, unknown>;
  /** Initial `storefront_config` (both twins). Absent = the resolver's defaults. */
  storefrontConfig?: Record<string, unknown>;
}): Promise<BusinessRow> {
  const { live, test } = await withTenant(input.organizationId, async (tx) => {
    const [live] = await tx
      .insert(businesses)
      .values({
        organizationId: input.organizationId,
        publicId: publicId("biz"),
        name: input.name,
        defaultCurrency: input.defaultCurrency.toUpperCase(),
        livemode: "live",
        ...(input.timezone ? { timezone: timezoneToStore(input.timezone) } : {}),
        ...(input.anchorGranularity ? { anchorGranularity: input.anchorGranularity } : {}),
        ...(input.prorationGranularity ? { prorationGranularity: input.prorationGranularity } : {}),
        ...(input.invoiceCustomization ? { invoiceCustomization: input.invoiceCustomization } : {}),
        ...(input.billingRulesConfig ? { billingRulesConfig: input.billingRulesConfig } : {}),
        ...(input.reminderConfig ? { reminderConfig: input.reminderConfig } : {}),
        ...(input.storefrontConfig ? { storefrontConfig: input.storefrontConfig } : {}),
      })
      .returning();
    return { live: live!, test: await insertTestTwin(tx, live!) };
  });
  await provisionTestGateway(input.organizationId, test.id);
  return input.livemode === "test" ? test : live;
}

/**
 * The test twin of a live business, created on first use for live businesses that
 * predate 0342. Idempotent: a concurrent caller loses the unique-index race and reads
 * the winner's row.
 */
export async function ensureTestTwin(
  organizationId: string,
  liveBusinessId: string,
): Promise<BusinessRow> {
  const result = await withTenant(organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.liveBusinessId, liveBusinessId))
      .limit(1);
    if (existing) return { twin: existing, created: false };
    const [live] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, liveBusinessId))
      .for("update")
      .limit(1);
    if (!live) throw new TenancyError("No such business");
    if (live.livemode !== "live") throw new TenancyError("A test business has no test mode");
    // Re-check under the parent's row lock: a concurrent caller may have committed first.
    const [raced] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.liveBusinessId, liveBusinessId))
      .limit(1);
    if (raced) return { twin: raced, created: false };
    return { twin: await insertTestTwin(tx, live), created: true };
  });
  if (result.created) await provisionTestGateway(organizationId, result.twin.id);
  return result.twin;
}

/** Live ↔ test public ids for each business, keyed by row id. Null where no twin exists. */
export async function businessPairs(
  organizationId: string,
): Promise<Map<string, { liveBusinessId: string | null; testBusinessId: string | null }>> {
  const rows = await withTenant(organizationId, async (tx) =>
    tx
      .select({
        id: businesses.id,
        publicId: businesses.publicId,
        liveBusinessId: businesses.liveBusinessId,
      })
      .from(businesses),
  );
  const byId = new Map(rows.map((r) => [r.id, r.publicId]));
  const pairs = new Map<string, { liveBusinessId: string | null; testBusinessId: string | null }>();
  for (const r of rows) pairs.set(r.id, { liveBusinessId: null, testBusinessId: null });
  for (const r of rows) {
    if (!r.liveBusinessId) continue;
    pairs.get(r.id)!.liveBusinessId = byId.get(r.liveBusinessId) ?? null;
    const parent = pairs.get(r.liveBusinessId);
    if (parent) parent.testBusinessId = r.publicId;
  }
  return pairs;
}

/** The organization's account state (0354, 0356): live-mode lock, read-only status and its reason. */
export async function accountStateOf(organizationId: string): Promise<{
  liveAccess: string;
  status: string;
  restrictedReason: string | null;
  overLimitSince: Date | null;
  /** ISO country from sign-up; null for organizations that predate 0354 or were invited. */
  country: string | null;
  /** The gateway named at sign-up (`SIGNUP_GATEWAYS`), or null. */
  signupGateway: string | null;
}> {
  const [o] = await systemDb
    .select({
      liveAccess: organizations.liveAccess,
      status: organizations.status,
      restrictedReason: organizations.restrictedReason,
      overLimitSince: organizations.overLimitSince,
      country: organizations.country,
      signupAnswers: organizations.signupAnswers,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const gateway = (o?.signupAnswers as { gateway?: unknown } | null | undefined)?.gateway;
  return {
    liveAccess: o?.liveAccess ?? "enabled",
    status: o?.status ?? "active",
    restrictedReason: o?.restrictedReason ?? null,
    overLimitSince: o?.overLimitSince ?? null,
    country: o?.country ?? null,
    signupGateway: typeof gateway === "string" ? gateway : null,
  };
}

/**
 * Make an organization read-only (`restricted`, with its reason) or restore it (`active`).
 * Account billing (0354, 0356).
 */
export async function setOrganizationStatus(
  organizationPublicId: string,
  status: "active" | "restricted",
  reason: "unpaid" | "over_limit" | null = null,
): Promise<typeof organizations.$inferSelect | null> {
  if (status === "restricted" && !reason)
    throw new Error("A read-only organization needs a reason");
  const [o] = await systemDb
    .update(organizations)
    .set({ status, restrictedReason: status === "active" ? null : reason })
    .where(eq(organizations.publicId, organizationPublicId))
    .returning();
  if (o) log.log("organization status set", { organizationId: o.publicId, status, reason });
  return o ?? null;
}

/** Turn live mode on (0354): the Free plan, a paid plan, or staff for an agreement. */
export async function enableLiveAccess(
  organizationPublicId: string,
  enabledBy: string,
): Promise<typeof organizations.$inferSelect | null> {
  const [o] = await systemDb
    .update(organizations)
    .set({ liveAccess: "enabled", liveAccessEnabledAt: new Date(), liveAccessEnabledBy: enabledBy })
    .where(eq(organizations.publicId, organizationPublicId))
    .returning();
  if (o) log.log("live access enabled", { organizationId: o.publicId, enabledBy });
  return o ?? null;
}

/**
 * Update an organization's editable fields — its name and its display timezone.
 *
 * `timezone` follows `updateBusiness`'s convention exactly: **absent** means "leave it
 * alone", while an explicit `null` or `''` clears it (→ UTC everywhere it is read). Any
 * other value goes through `timezoneToStore`, so only a valid MODERN IANA name is ever
 * persisted — an unvalidated typo would not error anywhere, it would just make every
 * org-scoped screen silently fall back to UTC forever.
 */
export async function updateOrganization(
  organizationId: string,
  patch: {
    name?: string;
    timezone?: string | null;
    /** The registered entity, for invoices a business issues under the organization. */
    legalName?: string | null;
    address?: unknown | null;
    taxRegistrationNumber?: string | null;
    /** Which currency analytics opens on. Converts nothing; only chooses what is shown first. */
    baseCurrency?: string | null;
    /** Sidebar logo URL; the route validates the scheme. */
    iconUrl?: string | null;
  },
): Promise<typeof organizations.$inferSelect | null> {
  const set: Partial<typeof organizations.$inferInsert> = {};
  if (patch.name != null) set.name = patch.name;
  if (patch.timezone !== undefined) {
    set.timezone =
      patch.timezone === null || patch.timezone === "" ? null : timezoneToStore(patch.timezone);
  }
  // Empty string CLEARS, as everywhere else here: a merchant deleting the field means "we
  // have no GSTIN", not "keep printing the old one on tomorrow's invoices".
  if (patch.legalName !== undefined) set.legalName = patch.legalName || null;
  if (patch.address !== undefined) set.address = patch.address;
  if (patch.taxRegistrationNumber !== undefined)
    set.taxRegistrationNumber = patch.taxRegistrationNumber || null;
  // Stored upper-case so a lookup never has to care how it was typed. Empty CLEARS, which
  // returns the account to "ask me" rather than to a guess.
  if (patch.baseCurrency !== undefined)
    set.baseCurrency = patch.baseCurrency ? patch.baseCurrency.toUpperCase() : null;
  if (patch.iconUrl !== undefined) set.iconUrl = patch.iconUrl || null;
  if (Object.keys(set).length === 0) {
    const [o] = await systemDb
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return o ?? null;
  }
  // Read before the write, so "did the reporting currency actually move" is answerable.
  const wantsRates = set.baseCurrency != null;
  const [before] = wantsRates
    ? await systemDb
        .select({ baseCurrency: organizations.baseCurrency })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1)
    : [];

  const [o] = await systemDb
    .update(organizations)
    .set(set)
    .where(eq(organizations.id, organizationId))
    .returning();

  if (o && wantsRates && before?.baseCurrency !== set.baseCurrency) {
    await queueOrganizationRateRefresh(organizationId);
  }
  return o ?? null;
}

/**
 * Fetch this account's reporting rates now rather than at the next cron.
 *
 * Choosing a reporting currency is what first makes the account's rate map WANTED:
 * `organizationRateTargets` skips an organization with no `base_currency`, so before this
 * moment no pass has ever fetched a rate for it. The refresh runs twice a day, so without
 * this the first roll-up an operator sees excludes everything billed in another currency
 * — for up to twenty hours, under a note that reads like a broken rate feed.
 *
 * Never throws. The rates are a reporting nicety and the cron fills them regardless, so an
 * unreachable queue must not fail the settings save — but it IS logged, because a silent
 * skip leaves an empty map with nothing to explain it.
 */
async function queueOrganizationRateRefresh(organizationId: string): Promise<void> {
  try {
    const { enqueue } = await import("@/platform/jobs");
    await enqueue("fx_refresh_rates", { organizationId });
  } catch (e) {
    log.warn("could not queue an exchange-rate refresh for this organization", {
      event: "fx_refresh_enqueue_failed",
      organizationId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Restate this business's stored analytics after its timezone moved.
 *
 * `metric_daily.period_end` is a LOCAL calendar date and each row's window is that date's
 * local midnights. Change the zone and every stored row is cut on a boundary the account no
 * longer uses — a month is out by the offset, and a day is out by up to a whole day either
 * side of the date line. The rows cannot be patched, only computed again.
 *
 * Never throws, for the same reason the rate refresh does not: recomputing analytics must
 * not be able to fail a settings save. It IS logged, because history left on the old
 * boundary with nothing to explain it is the worst of the three outcomes.
 */
async function queueMetricDailyRecompute(
  businessId: string,
  /** Present for a reporting-calendar change: re-cut only these coarse grains. */
  grains?: Array<"week" | "quarter" | "year">,
): Promise<void> {
  try {
    const { enqueue } = await import("@/platform/jobs");
    await enqueue("metric_daily_recompute", grains ? { businessId, grains } : { businessId });
  } catch (e) {
    log.warn("could not queue an analytics recompute after a timezone or calendar change", {
      event: "metric_daily_recompute_enqueue_failed",
      businessId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Update a business's settings (name, default currency, provider config). */
export async function updateBusiness(
  organizationId: string,
  businessPublicId: string,
  patch: {
    name?: string;
    defaultCurrency?: string;
    currencies?: string[] | null;
    exchangeRates?: Record<string, number> | null;
    billingFrequencies?: BillingFrequency[] | null;
    address?: unknown | null;
    contactEmail?: string | null;
    supportEmail?: string | null;
    phone?: string | null;
    website?: string | null;
    logoUrl?: string | null;
    // Brand Styles (0185) — see db/migrations/0185_brand_styles.sql.
    iconUrl?: string | null;
    faviconUrl?: string | null;
    brandColor?: string | null;
    /** 0238 — may a buyer type a coupon code on the hosted pages? */
    allowCustomerCoupons?: boolean;
    /** 0495 — coupon codes a buyer can enter on one checkout or subscription (1–10). */
    maxCustomerCouponCodes?: number;
    timezone?: string | null;
    /** Reporting calendar (0293): where analytics cuts weeks, quarters and years. */
    weekStart?: WeekStart;
    fiscalYearStartMonth?: number;
    taxRegistrationNumber?: string | null;
    /**
     * Whose identity heads this business's invoices — 'business' (default) or
     * 'organization'. See `db/schema/tenancy.ts`; the seller block follows it, brand and
     * contact do not.
     */
    invoiceIssuer?: "business" | "organization";
    /** Default HSN/SAC for this business's supplies (India GST); products may override. */
    defaultTaxCode?: string | null;
    invoicePrefix?: string;
    invoiceNextNumber?: number;
    defaultInvoiceNotes?: string | null;
    defaultDueDays?: number | null;
    dunningRetryDays?: number[] | null;
    dunningConfig?: unknown;
    /** Per-business mandate sizing (0221); null clears it back to the engine defaults. */
    mandateConfig?: unknown;
    /** Credits Flexibility (0219) — see db/schema/tenancy.ts and credits-flexibility.ts. */
    creditsFlexibility?: unknown;
    /** Credit grants, holds and blocking (0464); validated by `credits/settings.ts`. */
    creditConfig?: BusinessCreditConfig | null;
    createPendingInvoices?: boolean;
    autoClosePendingAfterDays?: number | null;
    invoiceRounding?: "none" | "nearest_unit";
    cardPaymentLimits?: Record<string, number> | null;
    /** 0454 — extra minutes before a period's usage closes (0–24). */
    usageCloseDelayMinutes?: number;
    defaultProrateOnChange?: boolean;
    defaultInvoiceImmediately?: boolean;
    /** 0246 — invoices inherit their subscription's PO number. */
    inheritSubscriptionPoNumber?: boolean;
    defaultCancelOption?: "immediately" | "end_of_term";
    defaultCreditOptionForCancel?: "prorate" | "full" | "none";
    defaultUnbilledOnCancel?: "no_action" | "invoice" | "delete";
    defaultArHandlingOnCancel?: "no_action" | "schedule_payment_collection" | "write_off" | "void";
    defaultRefundableCreditsOnCancel?: "no_action" | "schedule_refund";
    /** Per-event unbilled handling (0242); null clears it back to the resolver defaults. */
    unbilledChargesConfig?: unknown;
    /** Pause / resume defaults (0242); null clears it back to the resolver defaults. */
    pauseConfig?: unknown;
    billingRulesConfig?: unknown;
    /** Invoice rules (0486), already merged by the caller; null clears to the defaults. */
    invoiceRulesConfig?: unknown;
    /** Backdating window (0242); null clears it back to the permissive resolver defaults. */
    backdatingConfig?: unknown;
    /** Reminder lead days (0376), already merged by the caller; null = every default. */
    reminderConfig?: unknown;
    // 0243 sweep.
    viesValidationEnabled?: boolean;
    /** Buyer-surface preferences (0243); null clears to the resolver defaults. */
    storefrontConfig?: unknown;
    /** Chargeback policy (0244); null clears to the record-only defaults. */
    chargebackConfig?: unknown;
    /** Checkout field matrix (0245); null clears to today's per-field defaults. */
    checkoutFieldConfig?: unknown;
    /** Portal field matrix (0334); null clears to the defaults. */
    portalFieldConfig?: unknown;
    anchorGranularity?: AnchorGranularity;
    prorationGranularity?: ProrationGranularity;
    defaultTaxBehavior?: "exclusive" | "inclusive";
    /** Whole `tax_settings` value (0489), already merged by the route. */
    taxSettings?: Record<string, unknown>;
    /** Customer-facing email settings; see modules/emails/config.ts. null disables. */
    emailConfig?: unknown;
    /** Staff alerts and the daily digest (0489); see ops/team-alerts-config.ts. null = off. */
    teamAlertsConfig?: unknown;
    creditNotePrefix?: string;
    creditNoteNextNumber?: number;
    receiptPrefix?: string;
    /**
     * What the printed document shows (0239); null clears it back to the pre-0239
     * rendering. See modules/invoicing/customization.ts.
     */
    invoiceCustomization?: unknown;
    /** CP-0 OCC: throw VersionConflictError if the row's resource_version differs. */
    expectedVersion?: number;
  },
): Promise<typeof businesses.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    if (patch.expectedVersion !== undefined) {
      const [current] = await tx
        .select()
        .from(businesses)
        .where(eq(businesses.publicId, businessPublicId))
        .limit(1);
      if (!current) return null;
      if (Number(current.resourceVersion) !== patch.expectedVersion) {
        throw new VersionConflictError(patch.expectedVersion, Number(current.resourceVersion));
      }
    }
    const set: Partial<typeof businesses.$inferInsert> = {};
    if (patch.name != null) set.name = patch.name;
    if (patch.defaultCurrency != null) set.defaultCurrency = patch.defaultCurrency.toUpperCase();
    if (patch.currencies !== undefined)
      set.currencies =
        patch.currencies === null ? null : patch.currencies.map((c) => c.toUpperCase());
    if (patch.billingFrequencies !== undefined)
      set.billingFrequencies =
        patch.billingFrequencies === null
          ? null
          : normalizeBillingFrequencies(patch.billingFrequencies);
    if (patch.exchangeRates !== undefined)
      set.exchangeRates =
        patch.exchangeRates === null
          ? null
          : Object.fromEntries(
              Object.entries(patch.exchangeRates).map(([k, v]) => [k.toUpperCase(), v]),
            );
    if (patch.address !== undefined) set.address = patch.address;
    if (patch.contactEmail !== undefined) set.contactEmail = patch.contactEmail;
    if (patch.supportEmail !== undefined) set.supportEmail = patch.supportEmail;
    if (patch.phone !== undefined) set.phone = patch.phone;
    if (patch.website !== undefined) set.website = patch.website;
    if (patch.logoUrl !== undefined) set.logoUrl = patch.logoUrl;
    if (patch.iconUrl !== undefined) set.iconUrl = patch.iconUrl;
    if (patch.faviconUrl !== undefined) set.faviconUrl = patch.faviconUrl;
    if (patch.brandColor !== undefined) set.brandColor = patch.brandColor;
    if (patch.allowCustomerCoupons !== undefined)
      set.allowCustomerCoupons = patch.allowCustomerCoupons;
    if (patch.maxCustomerCouponCodes !== undefined)
      set.maxCustomerCouponCodes = patch.maxCustomerCouponCodes;
    if (patch.timezone !== undefined) {
      set.timezone =
        patch.timezone === null || patch.timezone === "" ? null : timezoneToStore(patch.timezone);
    }
    if (patch.weekStart !== undefined) {
      if (!(WEEK_STARTS as readonly string[]).includes(patch.weekStart))
        throw new TenancyError(`week_start must be one of ${WEEK_STARTS.join(", ")}.`);
      set.weekStart = patch.weekStart;
    }
    if (patch.fiscalYearStartMonth !== undefined) {
      const m = patch.fiscalYearStartMonth;
      if (!Number.isInteger(m) || m < 1 || m > 12)
        throw new TenancyError("fiscal_year_start_month must be a whole number from 1 to 12.");
      set.fiscalYearStartMonth = m;
    }
    if (patch.taxRegistrationNumber !== undefined)
      set.taxRegistrationNumber = patch.taxRegistrationNumber;
    if (patch.invoiceIssuer !== undefined) set.invoiceIssuer = patch.invoiceIssuer;
    if (patch.defaultTaxCode !== undefined) set.defaultTaxCode = patch.defaultTaxCode;
    if (patch.invoicePrefix != null) set.invoicePrefix = patch.invoicePrefix;
    if (patch.invoiceNextNumber != null) set.invoiceNextNumber = BigInt(patch.invoiceNextNumber);
    if (patch.defaultInvoiceNotes !== undefined)
      set.defaultInvoiceNotes = patch.defaultInvoiceNotes;
    if (patch.defaultDueDays !== undefined) set.defaultDueDays = patch.defaultDueDays;
    if (patch.dunningRetryDays !== undefined) set.dunningRetryDays = patch.dunningRetryDays;
    if (patch.dunningConfig !== undefined) set.dunningConfig = patch.dunningConfig;
    if (patch.mandateConfig !== undefined) set.mandateConfig = patch.mandateConfig;
    if (patch.creditsFlexibility !== undefined) set.creditsFlexibility = patch.creditsFlexibility;
    if (patch.creditConfig !== undefined) set.creditConfig = patch.creditConfig;
    if (patch.createPendingInvoices !== undefined)
      set.createPendingInvoices = patch.createPendingInvoices;
    if (patch.autoClosePendingAfterDays !== undefined)
      set.autoClosePendingAfterDays = patch.autoClosePendingAfterDays;
    if (patch.invoiceRounding !== undefined) set.invoiceRounding = patch.invoiceRounding;
    if (patch.cardPaymentLimits !== undefined)
      set.cardPaymentLimits =
        patch.cardPaymentLimits && Object.keys(patch.cardPaymentLimits).length
          ? patch.cardPaymentLimits
          : null;
    if (patch.usageCloseDelayMinutes !== undefined)
      set.usageCloseDelayMinutes = patch.usageCloseDelayMinutes;
    if (patch.defaultProrateOnChange !== undefined)
      set.defaultProrateOnChange = patch.defaultProrateOnChange;
    if (patch.defaultInvoiceImmediately !== undefined)
      set.defaultInvoiceImmediately = patch.defaultInvoiceImmediately;
    if (patch.inheritSubscriptionPoNumber !== undefined)
      set.inheritSubscriptionPoNumber = patch.inheritSubscriptionPoNumber;
    if (patch.defaultCancelOption !== undefined)
      set.defaultCancelOption = patch.defaultCancelOption;
    if (patch.defaultCreditOptionForCancel !== undefined)
      set.defaultCreditOptionForCancel = patch.defaultCreditOptionForCancel;
    if (patch.defaultUnbilledOnCancel !== undefined)
      set.defaultUnbilledOnCancel = patch.defaultUnbilledOnCancel;
    if (patch.defaultArHandlingOnCancel !== undefined)
      set.defaultArHandlingOnCancel = patch.defaultArHandlingOnCancel;
    if (patch.defaultRefundableCreditsOnCancel !== undefined)
      set.defaultRefundableCreditsOnCancel = patch.defaultRefundableCreditsOnCancel;
    if (patch.unbilledChargesConfig !== undefined)
      set.unbilledChargesConfig = patch.unbilledChargesConfig;
    if (patch.pauseConfig !== undefined) set.pauseConfig = patch.pauseConfig;
    if (patch.billingRulesConfig !== undefined) set.billingRulesConfig = patch.billingRulesConfig;
    if (patch.invoiceRulesConfig !== undefined) set.invoiceRulesConfig = patch.invoiceRulesConfig;
    if (patch.backdatingConfig !== undefined) set.backdatingConfig = patch.backdatingConfig;
    if (patch.reminderConfig !== undefined) set.reminderConfig = patch.reminderConfig;
    if (patch.viesValidationEnabled !== undefined)
      set.viesValidationEnabled = patch.viesValidationEnabled;
    if (patch.storefrontConfig !== undefined) set.storefrontConfig = patch.storefrontConfig;
    if (patch.chargebackConfig !== undefined) set.chargebackConfig = patch.chargebackConfig;
    if (patch.checkoutFieldConfig !== undefined)
      set.checkoutFieldConfig = patch.checkoutFieldConfig;
    if (patch.portalFieldConfig !== undefined) set.portalFieldConfig = patch.portalFieldConfig;
    // Billing mode: either axis may be patched alone, so validate the RESULTING pair
    // against the DB CHECK constraint here — a 400 naming the legal combinations beats
    // a raw constraint violation, and 'day' + 'exact' is not a legal mode.
    if (patch.anchorGranularity !== undefined || patch.prorationGranularity !== undefined) {
      const [current] = await tx
        .select({
          anchor: businesses.anchorGranularity,
          proration: businesses.prorationGranularity,
        })
        .from(businesses)
        .where(eq(businesses.publicId, businessPublicId))
        .limit(1);
      if (!current) return null;
      const anchor = patch.anchorGranularity ?? (current.anchor as AnchorGranularity);
      const proration = patch.prorationGranularity ?? (current.proration as ProrationGranularity);
      if (anchor === "day" && proration === "exact") {
        throw new TenancyError(
          "Invalid billing mode: day-anchored terms require whole_day proration. There is no " +
            "day+exact mode. Use instant+exact, which is millisecond-based. Or use instant+whole_day " +
            "or day+whole_day, which are day-based. day+whole_day uses the earlier definition.",
        );
      }
      set.anchorGranularity = anchor;
      set.prorationGranularity = proration;
    }
    if (patch.defaultTaxBehavior !== undefined) set.defaultTaxBehavior = patch.defaultTaxBehavior;
    if (patch.taxSettings !== undefined) set.taxSettings = patch.taxSettings;
    if (patch.emailConfig !== undefined) set.emailConfig = patch.emailConfig;
    if (patch.teamAlertsConfig !== undefined) set.teamAlertsConfig = patch.teamAlertsConfig;
    if (patch.creditNotePrefix != null) set.creditNotePrefix = patch.creditNotePrefix;
    if (patch.receiptPrefix != null) set.receiptPrefix = patch.receiptPrefix;
    if (patch.creditNoteNextNumber != null)
      set.creditNoteNextNumber = BigInt(patch.creditNoteNextNumber);
    // `!== undefined`, so an explicit null CLEARS the customization rather than being
    // ignored — the documented way back to the pre-0239 rendering.
    if (patch.invoiceCustomization !== undefined)
      set.invoiceCustomization = patch.invoiceCustomization;
    if (Object.keys(set).length === 0) {
      const [b] = await tx
        .select()
        .from(businesses)
        .where(eq(businesses.publicId, businessPublicId))
        .limit(1);
      return b ?? null;
    }
    /**
     * Read the zone BEFORE the write, so "did the reporting calendar actually move" is
     * answerable afterwards. Re-saving the same zone is the common case (the settings form
     * posts every field) and must enqueue nothing.
     */
    const [beforeTz] =
      set.timezone !== undefined ||
      set.weekStart !== undefined ||
      set.fiscalYearStartMonth !== undefined
        ? await tx
            .select({
              timezone: businesses.timezone,
              weekStart: businesses.weekStart,
              fiscalYearStartMonth: businesses.fiscalYearStartMonth,
            })
            .from(businesses)
            .where(eq(businesses.publicId, businessPublicId))
            .limit(1)
        : [];

    const [b] = await tx
      .update(businesses)
      .set(set)
      .where(eq(businesses.publicId, businessPublicId))
      .returning();
    if (b) {
      const { writeAuditLog } = await import("@/modules/audit/service");
      // Record the changed fields as the diff (LOG-3). resource_version is bumped
      // by the trigger, so it's excluded from the settings diff.
      const {
        resourceVersion: _rv,
        updatedAt: _ua,
        ...changedRaw
      } = set as Record<string, unknown>;
      // jsonb can't serialize BigInt (invoice/CN next-number counters) — store as number.
      const changed = Object.fromEntries(
        Object.entries(changedRaw).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]),
      );
      await writeAuditLog(
        {
          organizationId,
          businessId: b.id,
          action: "business.settings_update",
          resourceType: "business",
          resourceId: b.publicId,
          after: changed,
        },
        tx,
      );
      // An exchange-rate write is also an OBSERVATION: `exchange_rates` is overwritten in
      // place, so without this the previous value is gone. A default-currency change
      // counts too — every rate is re-quoted against the new base.
      if (set.exchangeRates !== undefined || set.defaultCurrency !== undefined) {
        await recordExchangeRateObservations(tx, {
          organizationId,
          businessId: b.id,
        });
      }
      if (set.timezone !== undefined && beforeTz && beforeTz.timezone !== set.timezone) {
        await queueMetricDailyRecompute(b.id);
      }
      // Stored week/quarter/year rows are keyed at period ends on the old calendar.
      const regrain: Array<"week" | "quarter" | "year"> = [];
      if (set.weekStart !== undefined && beforeTz && beforeTz.weekStart !== set.weekStart)
        regrain.push("week");
      if (
        set.fiscalYearStartMonth !== undefined &&
        beforeTz &&
        beforeTz.fiscalYearStartMonth !== set.fiscalYearStartMonth
      )
        regrain.push("quarter", "year");
      if (regrain.length > 0) await queueMetricDailyRecompute(b.id, regrain);
    }
    return b ?? null;
  });
}

/** Resolve a business by its public id within an organization (RLS-scoped). */
export async function getBusinessByPublicId(
  organizationId: string,
  businessPublicId: string,
): Promise<typeof businesses.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [b] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.publicId, businessPublicId))
      .limit(1);
    return b ?? null;
  });
}

/**
 * Resolve a business by its INTERNAL id (RLS-scoped).
 *
 * For callers holding a `business_id` rather than a public id, which need the row to read
 * a business-level convention (timezone, `anchor_granularity`) rather than to render the
 * business itself.
 */
export async function getBusinessById(
  organizationId: string,
  businessId: string,
): Promise<typeof businesses.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    return b ?? null;
  });
}

/**
 * List an organization's businesses (newest first). No explicit org filter —
 * RLS scopes the rows to `app.org_id` set by withTenant().
 */
export async function listBusinesses(
  organizationId: string,
): Promise<Array<typeof businesses.$inferSelect>> {
  return withTenant(organizationId, async (tx) =>
    tx.select().from(businesses).orderBy(desc(businesses.createdAt)),
  );
}

export interface AuthContext {
  organization: typeof organizations.$inferSelect;
  /**
   * The authenticating key's row id, or `null` when the credential was an operator
   * SESSION. Nullable since 0198: the dashboard authenticates as the signed-in person
   * rather than as a shared org key, so there is no key row behind those requests.
   */
  apiKeyId: string | null;
  /** The authenticating key's public id (`key_…`) — the event `actor` for an `api` key. */
  apiKeyPublicId: string | null;
  /** Mode of the authenticating key: test/live keys are sandbox-partitioned; 'all' reaches both. */
  keyLivemode: KeyMode;
  /**
   * What the authenticating KEY may do — 'read' or 'write' (audit H1.3). Null for an operator
   * session, whose reach is decided by the person's role instead.
   */
  apiKeyScope: ApiKeyScope | null;
  /**
   * `api` (an integration's key) or `system` (the dashboard's bootstrap credential).
   * `authenticate` reads this to decide the request's provenance.
   */
  apiKeyKind: ApiKeyKind;
  /**
   * Set when the credential was an operator session. Carries the person, so the
   * request's actor is known without a second session lookup — and, more importantly,
   * so the ORGANIZATION came from the session rather than from a key.
   */
  /**
   * The signed-in person, when the credential was a SESSION (0198). `role` is what
   * `requirePerm` checks (audit H1) — an API key has no role, and deliberately so: keys are
   * not people, and scoping them is its own piece of work.
   */
  operator?: {
    userId: string;
    email: string;
    role: Role;
    /** `role_…` when `role` is `custom`. */
    customRoleId?: string | null;
    permissions: ReadonlySet<string>;
  };
  /** The key's per-resource map (0391). Null = by `apiKeyScope`. Null for a session. */
  apiKeyPermissions: KeyPermissionMap | null;
}

/**
 * Mint a fresh API key for an existing organization. Secret returned once.
 *
 * Writes through `withTenant`, NOT `systemDb`, which is outside
 * any tenant transaction, and "writes made through `systemDb` are NOT
 * tracked" is a documented blind spot of the idempotency side-effects tracker
 * (`platform/db.ts`, § Known limits): `withTenant` is what stamps the in-flight
 * `idempotency_keys` row `side_effects`, atomically with the write it describes.
 * `POST /v1/api_keys` is an idempotency-keyed route that mints a LIVE credential, so
 * an untracked insert is the one shape that must not exist there — if any step after
 * it ever threw, the record would be deleted as "clean" and the client's retry would
 * re-execute and mint a SECOND credential. Nothing can throw between the insert and
 * the send today; this makes that a property of the code rather than of the current
 * line ordering.
 *
 * RLS permits it unchanged: `api_keys`' `org_isolation` policy
 * (`db/migrations/0001_rls_policies.sql`) checks
 * `organization_id = current_setting('app.org_id')`, which `withTenant` sets to this
 * same `organizationId`, and `tmbilling_app` holds INSERT on the table. This differs
 * from `createOrganization` above, which genuinely needs the base handle: it mints
 * the org's first key in the same transaction that CREATES the org, so there is no
 * tenant to scope to yet.
 */
export async function createApiKey(
  organizationId: string,
  livemode: KeyMode = "test",
  /**
   * Defaults to `api` and the public route never passes anything else: a `dashboard`
   * credential is minted with the organization, or by `scripts/create-api-key.ts`
   * when a reset DB needs the dashboard pointed at a fresh one. Letting the API mint
   * one would hand a caller a credential whose writes are attributed to an operator
   * in our UI — a way to file its own actions as a person's.
   */
  kind: ApiKeyKind = "api",
  /**
   * What the key may do (audit H1.3). Defaults to 'write' so every existing caller — the
   * importer, the seed, the fixtures — keeps the reach it had; a read key is opted into.
   */
  scope: ApiKeyScope = "write",
  /**
   * What the key is FOR. Trailing and optional so every existing caller — the seed, the
   * importer, ten verify scripts — keeps working unchanged. An unnamed key stays legal and
   * renders as an em dash; naming one for the caller would assert something nobody said.
   */
  name: string | null = null,
  /** 0374: null = never expires. The route refuses a time in the past. */
  expiresAt: Date | null = null,
  /** 0391: per-resource map; null = by scope. The caller sets `scope` to match. */
  permissions: KeyPermissionMap | null = null,
): Promise<{ apiKey: typeof apiKeys.$inferSelect; secret: string }> {
  const key = generateApiKey(livemode);
  const apiKey = await withTenant(organizationId, (tx) =>
    insertApiKey(tx, organizationId, key, { livemode, kind, scope, name, expiresAt, permissions }),
  );
  return { apiKey, secret: key.raw };
}

/**
 * The insert and its `api_key.create` audit row, inside the caller's transaction. Self-host
 * bootstrap passes a secret the operator chose; every other caller a generated one.
 */
export async function insertApiKey(
  tx: Tx,
  organizationId: string,
  key: Pick<GeneratedApiKey, "prefix" | "hashed">,
  opts: {
    livemode: KeyMode;
    kind: ApiKeyKind;
    scope: ApiKeyScope;
    name: string | null;
    expiresAt: Date | null;
    permissions?: KeyPermissionMap | null;
  },
): Promise<typeof apiKeys.$inferSelect> {
  const [row] = await tx
    .insert(apiKeys)
    .values({
      organizationId,
      publicId: publicId("key"),
      prefix: key.prefix,
      hashedKey: key.hashed,
      ...opts,
    })
    .returning();
  await auditApiKey(tx, row!, "api_key.create", null, apiKeyAuditView(row!));
  return row!;
}

/**
 * What an audit row may say about a key. The prefix identifies it; the secret and its hash
 * never leave `api_keys`.
 */
function apiKeyAuditView(k: typeof apiKeys.$inferSelect) {
  return {
    id: k.publicId,
    name: k.name,
    prefix: k.prefix,
    livemode: k.livemode,
    kind: k.kind,
    scope: k.scope,
    permissions: k.permissions ?? null,
    expires_at: k.expiresAt?.toISOString() ?? null,
  };
}

/**
 * Change a key's name or permission map (0391). Only `kind='api'` keys; any other answers null.
 * A map sets `scope` to match it; `permissions: null` returns the key to its scope.
 */
export async function updateApiKey(
  organizationId: string,
  keyPublicId: string,
  patch: { name?: string | null; permissions?: KeyPermissionMap | null; scope?: ApiKeyScope },
): Promise<typeof apiKeys.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [old] = await tx
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.organizationId, organizationId),
          eq(apiKeys.publicId, keyPublicId),
          eq(apiKeys.kind, "api"),
        ),
      )
      .for("update")
      .limit(1);
    if (!old) return null;
    const [updated] = await tx
      .update(apiKeys)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.permissions !== undefined ? { permissions: patch.permissions } : {}),
        ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
      })
      .where(eq(apiKeys.id, old.id))
      .returning();
    await auditApiKey(
      tx,
      updated!,
      "api_key.update",
      apiKeyAuditView(old),
      apiKeyAuditView(updated!),
    );
    return updated!;
  });
}

async function auditApiKey(
  tx: Tx,
  k: typeof apiKeys.$inferSelect,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  // Dynamic for the same reason as in `updateBusiness`.
  const { writeAuditLog } = await import("@/modules/audit/service");
  await writeAuditLog(
    {
      organizationId: k.organizationId,
      action,
      resourceType: "api_key",
      resourceId: k.publicId,
      before,
      after,
    },
    tx,
  );
}

/**
 * List an organization's API keys (newest first). Never exposes the hashed key.
 *
 * `system` keys are excluded: this list is the org's own API credentials, and the
 * dashboard's bootstrap key is not one of them — showing it would invite an
 * operator to revoke the credential their dashboard is talking to.
 */
export async function listApiKeys(
  organizationId: string,
): Promise<Array<typeof apiKeys.$inferSelect>> {
  return systemDb
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.kind, "api")))
    .orderBy(desc(apiKeys.createdAt));
}

/**
 * Revoke a key (idempotent). Returns the key row, or null if it isn't in the org.
 *
 * A `system` key answers null — the same as a key from another org — so the route
 * 404s. It is invisible to `listApiKeys` for the same reason, and the two must
 * agree: a credential you cannot see is a credential you cannot revoke by id.
 */
export async function revokeApiKey(
  organizationId: string,
  keyPublicId: string,
): Promise<typeof apiKeys.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [revoked] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.organizationId, organizationId),
          eq(apiKeys.publicId, keyPublicId),
          eq(apiKeys.kind, "api"),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning();
    if (revoked) {
      // A credential going away explains every 401 that follows it.
      log.info("api key revoked", { apiKey: keyPublicId, organizationId });
      // Only the first revoke is audited; a retry changes nothing.
      await auditApiKey(tx, revoked, "api_key.revoke", null, {
        prefix: revoked.prefix,
        revoked_at: revoked.revokedAt!.toISOString(),
      });
      return revoked;
    }
    const [existing] = await tx
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.organizationId, organizationId),
          eq(apiKeys.publicId, keyPublicId),
          eq(apiKeys.kind, "api"),
        ),
      )
      .limit(1);
    return existing ?? null;
  });
}

/** The old key's overlap after a rotation: 0 (expire now) up to 7 days. */
export const ROTATION_OVERLAP_MAX_SECONDS = 7 * 24 * 3600;
export const ROTATION_OVERLAP_DEFAULT_SECONDS = 24 * 3600;

/** A rotation the caller can correct. Routes map it to a 400. */
export class ApiKeyRotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyRotationError";
  }
}

/**
 * Replace a key: mint a new one with the same name, mode and scope, and let the old one
 * keep working for `overlapSeconds` so integrations can switch without downtime.
 *
 * The old key's expiry only ever moves EARLIER (`LEAST`): rotating a key that already
 * expires tomorrow with a 7-day overlap must not give it 6 more days. Only `kind='api'`
 * keys rotate; any other kind answers null (a 404), the same as revoke.
 */
export async function rotateApiKey(
  organizationId: string,
  keyPublicId: string,
  overlapSeconds: number = ROTATION_OVERLAP_DEFAULT_SECONDS,
): Promise<{
  apiKey: typeof apiKeys.$inferSelect;
  secret: string;
  previous: typeof apiKeys.$inferSelect;
} | null> {
  if (
    !Number.isInteger(overlapSeconds) ||
    overlapSeconds < 0 ||
    overlapSeconds > ROTATION_OVERLAP_MAX_SECONDS
  ) {
    throw new ApiKeyRotationError(
      `overlap_seconds must be a whole number from 0 to ${ROTATION_OVERLAP_MAX_SECONDS}`,
    );
  }
  return withTenant(organizationId, async (tx) => {
    // Locked, so two concurrent rotations of one key serialize on it.
    const [old] = await tx
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.organizationId, organizationId),
          eq(apiKeys.publicId, keyPublicId),
          eq(apiKeys.kind, "api"),
        ),
      )
      .for("update")
      .limit(1);
    if (!old) return null;
    if (old.revokedAt) {
      throw new ApiKeyRotationError(
        "We could not rotate the API key. It is revoked. Create a new key.",
      );
    }
    if (old.expiresAt && old.expiresAt.getTime() <= Date.now()) {
      throw new ApiKeyRotationError(
        "We could not rotate the API key. It has expired. Create a new key.",
      );
    }

    const key = generateApiKey(old.livemode as KeyMode);
    const [fresh] = await tx
      .insert(apiKeys)
      .values({
        organizationId,
        publicId: publicId("key"),
        name: old.name,
        prefix: key.prefix,
        hashedKey: key.hashed,
        livemode: old.livemode,
        kind: old.kind,
        scope: old.scope,
        // The map travels with the rotation: a rotation grants nothing new.
        permissions: old.permissions,
      })
      .returning();
    const overlap = sql.raw(String(overlapSeconds));
    const [previous] = await tx
      .update(apiKeys)
      .set({
        expiresAt: sql`LEAST(COALESCE(${apiKeys.expiresAt}, 'infinity'::timestamptz), now() + make_interval(secs => ${overlap}))`,
      })
      .where(eq(apiKeys.id, old.id))
      .returning();

    log.info("api key rotated", {
      apiKey: old.publicId,
      replacedBy: fresh!.publicId,
      organizationId,
      overlapSeconds,
    });
    await auditApiKey(tx, fresh!, "api_key.create", null, {
      ...apiKeyAuditView(fresh!),
      rotated_from: old.publicId,
    });
    await auditApiKey(
      tx,
      previous!,
      "api_key.rotate",
      { expires_at: old.expiresAt?.toISOString() ?? null },
      {
        expires_at: previous!.expiresAt?.toISOString() ?? null,
        replaced_by: fresh!.publicId,
        overlap_seconds: overlapSeconds,
      },
    );
    return { apiKey: fresh!, secret: key.raw, previous: previous! };
  });
}

/** How often one key's `last_used_at` may be written (B12). */
export const LAST_USED_WINDOW_MS = 5 * 60_000;
const lastUsedWrites = new Map<string, number>();

/**
 * Record that a key authenticated a request. Fire-and-forget: the request never waits for it,
 * and a failed write is logged, never thrown. The in-process throttle skips the query inside
 * the window; the conditional UPDATE bounds it across processes.
 */
export function markApiKeyUsed(apiKeyId: string): void {
  const now = Date.now();
  const prev = lastUsedWrites.get(apiKeyId);
  if (prev !== undefined && now - prev < LAST_USED_WINDOW_MS) return;
  // Bounded by the number of live keys; the clear is only a backstop.
  if (lastUsedWrites.size >= 50_000) lastUsedWrites.clear();
  lastUsedWrites.set(apiKeyId, now);
  void Promise.resolve()
    .then(() => writeApiKeyLastUsed(apiKeyId))
    .catch((e: unknown) => {
      lastUsedWrites.delete(apiKeyId);
      log.warn("could not record api key last use", { apiKeyId, error: String(e) });
    });
}

/** The conditional write behind `markApiKeyUsed`. True when it moved the timestamp. */
export async function writeApiKeyLastUsed(apiKeyId: string): Promise<boolean> {
  const window = sql.raw(String(LAST_USED_WINDOW_MS / 1000));
  const rows = await systemDb
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiKeys.id, apiKeyId),
        or(
          isNull(apiKeys.lastUsedAt),
          lt(apiKeys.lastUsedAt, sql`now() - make_interval(secs => ${window})`),
        ),
      ),
    )
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/** Resolve a raw API key to its organization, or null if invalid, revoked or expired. */
export async function authenticateApiKey(raw: string): Promise<AuthContext | null> {
  const hashed = hashApiKey(raw);
  const [row] = await systemDb
    .select({
      organization: organizations,
      apiKeyId: apiKeys.id,
      apiKeyPublicId: apiKeys.publicId,
      keyLivemode: apiKeys.livemode,
      apiKeyKind: apiKeys.kind,
      apiKeyScope: apiKeys.scope,
      apiKeyPermissions: apiKeys.permissions,
    })
    .from(apiKeys)
    .innerJoin(organizations, eq(apiKeys.organizationId, organizations.id))
    .where(
      and(
        eq(apiKeys.hashedKey, hashed),
        isNull(apiKeys.revokedAt),
        // An expired key reads exactly like a revoked one: no row, so the same 401.
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`)),
      ),
    )
    .limit(1);

  return row
    ? {
        organization: row.organization,
        apiKeyId: row.apiKeyId,
        apiKeyPublicId: row.apiKeyPublicId,
        keyLivemode: row.keyLivemode as KeyMode,
        apiKeyKind: row.apiKeyKind as ApiKeyKind,
        apiKeyScope: row.apiKeyScope as ApiKeyScope,
        apiKeyPermissions: row.apiKeyPermissions ?? null,
      }
    : null;
}
