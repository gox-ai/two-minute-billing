import { isOrder } from "@/modules/metrics/daily/order-predicate";
import { and, desc, eq, inArray, sql, type Column, type SQL } from "drizzle-orm";
import { deleteCustomerRequestLogs } from "@/modules/request-log/service";
import { afterCommit, withTenant, type Tx } from "@/platform/db";
import { restateReportingForBusiness } from "@/modules/metrics/reportable";
import { assertTestBusinessRoom } from "@/modules/tenancy/test-limits";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import {
  clampLimit,
  countExpr,
  filterConditions,
  keysetCondition,
  kindsFromSpecs,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  searchCondition,
  splitMulti,
  isJsonArrayValue,
  existsFieldCondition,
  existsDateCondition,
  type VirtualFilter,
  toPage,
  type FilterKind,
  type FilterSpec,
  type ListFilter,
  type ListPage,
  cappedTotal,
  TOTAL_CAP,
} from "@/platform/list-query";

import { createLogger } from "@/platform/logger";

/**
 * Routine customer CRUD is NOT logged here: every mutation already writes an audit
 * row and emits a `customer_*` event, and a third copy in the log stream would be
 * noise that buries the lines that matter. What is logged is erasure — the one
 * action whose purpose is to destroy data, and the one that cannot be undone or
 * reconstructed from the record it just scrubbed.
 */
const log = createLogger("customers");
import { businessTimezone } from "@/platform/business-tz";
import { publicId } from "@/platform/ids";
import { requireStateCode } from "@/platform/geo";
import { emitEvent } from "@/modules/events/emit";
import type { TaxTreatment } from "@/modules/tax/service";
import { buildEventData } from "@/modules/events/registry";
import { deriveEffectiveCurrency } from "@/modules/customers/serialize";
import { accountHolderNameSql } from "@/modules/customers/name-sql";
import { apiStatusSql } from "@/modules/subscriptions/status-sql";
import { businessNow } from "@/platform/clock";
import {
  customers,
  subscriptions,
  paymentMethods,
  invoices,
  contacts,
  businesses,
  gatewayAccounts,
  appliedCoupons,
  type CustomerCreditSettings,
} from "@db/schema";
import { VersionConflictError } from "@/api/helpers";
import { getTaxIdValidator } from "@/modules/customers/tax-id";
import { enforceMetadataRules, type MetadataRuleScope } from "@/modules/metadata-rules/service";
import {
  validateAndCoerce as coerceCustomFields,
  customFieldFilterSet,
  type CustomFieldDefinitionRow,
} from "@/modules/custom-fields/service";
import { writeAuditLog, eraseAuditSnapshotsForResource } from "@/modules/audit/service";
import { auditSnapshot, changedFields } from "@/modules/audit/snapshot";
import { effectivePatch } from "@/platform/effective-patch";
import { listPaymentMethods, detachPaymentMethod } from "@/modules/payment-methods/service";
import {
  deleteShippingAddressesForPii,
  legacyShippingMirror,
  setDefaultShippingFromLegacy,
} from "./addresses";

export class CustomerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerError";
  }
}

// `null` is allowed alongside `undefined` on every sub-field: an update REPLACES
// the whole address, and applyAddress coerces both to a null column, so callers
// may either omit a blank field or send it explicitly as null. See addressBody
// (src/api/customer-routes.ts) for why rejecting null was a trap.
export interface CustomerAddress {
  line1?: string | null;
  line2?: string | null;
  line3?: string | null;
  city?: string | null;
  state?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  country?: string | null;
  // Contact sub-fields on the billing address (CP-2).
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  phone?: string | null;
}

/** Fields common to create + update (everything but identity/archive). */
export interface CustomerFields {
  email?: string | null;
  /**
   * ⚠️ `name` is DEPRECATED and deliberately absent — a customer is named by
   * `firstName`/`lastName`/`company` (see `./names.ts`). The API rejects it with a
   * 400 rather than accepting-and-ignoring, so a caller that still sends it finds
   * out. `GET` still emits a derived `name` for reading.
   */
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  phone?: string | null;
  currency?: string | null;
  locale?: string | null;
  autoCollection?: "on" | "off";
  netTermDays?: number;
  invoiceNotes?: string | null;
  address?: CustomerAddress | null;
  shippingAddress?: Record<string, unknown> | null;
  taxExempt?: boolean;
  /** false = no automatic billing emails to this customer. */
  emailNotifications?: boolean;
  /** true = dunning does not start, and makes no attempt or reminder, for this customer. */
  dunningExcluded?: boolean;
  /** true = an internal or test account, left out of every metric (0482). */
  excludeFromReporting?: boolean;
  /** Copies of this customer's document emails (0486). */
  billingCcEmails?: string[];
  billingBccEmails?: string[];
  /** Named dunning policy (internal id, 0386); null = the business dunning config. */
  dunningPolicyId?: string | null;
  vatNumber?: string | null;
  withholdingRateBps?: number;
  /** Credit policy override and overdraft limit (0464); null = the business's settings. */
  creditSettings?: CustomerCreditSettings | null;
  /**
   * How this customer is treated within their region's regime: `default` (resolve from
   * place of supply) or one of the region-gated special treatments — `sez_igst`,
   * `sez_zero_rated`, `export_igst`, `export_zero_rated`, `reverse_charge`. The region
   * decides which are offerable (`allowed_tax_treatments` on the tax region).
   */
  taxTreatment?: TaxTreatment;
  /** 0489: null = each price decides; set = every taxed line is this. */
  taxBehavior?: "inclusive" | "exclusive" | null;
  /** The customer's own registration number (GSTIN for India). */
  taxRegistrationNumber?: string | null;
  metadata?: Record<string, unknown> | null;
  // Custom-field values (SET-4). Keys may be `cf_<name>` or bare `<name>`; validated
  // + coerced against this business's custom_field_definitions for `customer`.
  customFields?: Record<string, unknown> | null;
  /** Hosted checkout only: it collects no custom fields, so Required ones are not enforced. */
  skipRequiredCustomFields?: boolean;
  /** How this business's metadata key rules apply to the write. Default `enforce`. */
  metadataRules?: MetadataRuleScope;
  // Explicit public id — used ONLY by the id-stable migration importer
  // ([[id-stable-migration]]) to carry the imported customer id verbatim so
  // downstream repos' stored vendorCustomerId keeps matching. Normal creates
  // omit it and get a fresh `cus_<nano>`.
  publicId?: string | null;
}

function applyAddress(
  set: Partial<typeof customers.$inferInsert>,
  a: CustomerAddress | null | undefined,
) {
  if (a === undefined) return;
  set.addressLine1 = a?.line1 ?? null;
  set.addressLine2 = a?.line2 ?? null;
  set.addressLine3 = a?.line3 ?? null;
  set.city = a?.city ?? null;
  set.state = a?.state ?? null;
  // `state_code` is the PLACE OF SUPPLY the tax engine matches on, so it is
  // validated and folded to canonical here rather than stored as typed. An
  // unrecognised code is rejected (400) instead of quietly resolving no place of
  // supply and taxing the customer at zero; the non-ISO Indian variants (OD, TS,
  // CG, UK) fold onto ISO so imported customers match locally-configured rates.
  set.stateCode = requireStateCode(a?.country, a?.stateCode);
  set.postalCode = a?.postalCode ?? null;
  set.country = a?.country?.toUpperCase() ?? null;
  set.billingFirstName = a?.firstName ?? null;
  set.billingLastName = a?.lastName ?? null;
  set.billingCompany = a?.company ?? null;
  set.billingPhone = a?.phone ?? null;
}

export async function createCustomer(
  input: { organizationId: string; businessId: string } & CustomerFields,
): Promise<typeof customers.$inferSelect> {
  return withTenant(input.organizationId, async (tx) => {
    const values: typeof customers.$inferInsert = {
      organizationId: input.organizationId,
      businessId: input.businessId,
      publicId: input.publicId ?? publicId("cus"),
      email: input.email ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      company: input.company ?? null,
      phone: input.phone ?? null,
      currency: input.currency?.toUpperCase() ?? null,
      locale: input.locale ?? null,
      autoCollection: input.autoCollection ?? "on",
      netTermDays: input.netTermDays ?? 0,
      invoiceNotes: input.invoiceNotes ?? null,
      shippingAddress: legacyShippingMirror(input.shippingAddress),
      taxExempt: input.taxExempt ?? false,
      emailNotifications: input.emailNotifications ?? true,
      dunningExcluded: input.dunningExcluded ?? false,
      dunningExcludedAt: input.dunningExcluded ? businessNow(input.businessId) : null,
      excludeFromReporting: input.excludeFromReporting ?? false,
      billingCcEmails: input.billingCcEmails ?? [],
      billingBccEmails: input.billingBccEmails ?? [],
      dunningPolicyId: input.dunningPolicyId ?? null,
      vatNumber: input.vatNumber ?? null,
      withholdingRateBps: input.withholdingRateBps ?? 0,
      creditSettings: input.creditSettings ?? null,
      taxTreatment: input.taxTreatment ?? "default",
      taxBehavior: input.taxBehavior ?? null,
      taxRegistrationNumber: input.taxRegistrationNumber ?? null,
      metadata: input.metadata ?? null,
    };
    applyAddress(values, input.address);
    await assertTestBusinessRoom(tx, input.businessId, "customers");
    await enforceMetadataRules(tx, input.businessId, "customer", input.metadata ?? null, {
      mode: "create",
      scope: input.metadataRules,
    });
    values.customFields = await coerceCustomFields(
      tx,
      input.businessId,
      "customer",
      input.customFields,
      { mode: "create", skipRequired: input.skipRequiredCustomFields },
    );
    let [c] = await tx.insert(customers).values(values).returning();
    if (values.shippingAddress != null) {
      await setDefaultShippingFromLegacy(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: c!.id,
        raw: values.shippingAddress,
      });
      [c] = await tx.select().from(customers).where(eq(customers.id, c!.id)).limit(1);
    }
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "customer_created",
      data: buildEventData(
        "customer_created",
        { id: c!.publicId, email: c!.email },
        c!.resourceVersion,
      ),
    });
    // `beforeFull: null` is what marks this a CREATION: it makes the snapshot row
    // exist with a null before-side, so the Activity Log shows the new record's full
    // body instead of a diff against nothing.
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "customer.create",
        resourceType: "customer",
        resourceId: c!.publicId,
        after: auditSnapshot(c!),
        beforeFull: null,
        afterFull: auditSnapshot(c!),
      },
      tx,
    );
    return c!;
  });
}

/**
 * Every customer of a business, unpaginated. **Internal use only** (verify
 * scripts, batch jobs that must see every row) — the API list route uses
 * `listCustomersPage`, because a 50k-customer business must not be serialized
 * into one response.
 */
export async function listCustomers(
  organizationId: string,
  businessId: string,
  opts?: { includeArchived?: boolean },
): Promise<Array<typeof customers.$inferSelect>> {
  return withTenant(organizationId, async (tx) => {
    const base = eq(customers.businessId, businessId);
    const where = opts?.includeArchived ? base : and(base, eq(customers.active, true));
    return tx.select().from(customers).where(where).orderBy(desc(customers.createdAt));
  });
}

// ── Paginated list (see docs/GUIDE.md §3.4 for the shared contract) ────────────

/**
 * A sub-field of the untyped `shipping_address` jsonb blob, as text.
 *
 * `jsonb_typeof` guards the extraction because the column has no shape contract: the
 * migration importer writes the source object verbatim through the service (bypassing
 * the route's zod), so whatever ever landed there is still there. The key is cast to
 * `text` so Postgres can pick `jsonb ->> text` instead of weighing it against
 * `jsonb ->> integer` for an untyped parameter.
 *
 * ⚠️ Must agree with `normalizeShippingAddress` (`./serialize.ts`) — the same reason
 * `name` filters through `accountHolderNameSql`: a filter reading a key the serializer
 * renamed returns an empty page for a value the list is showing on screen. That is why
 * `postal_code` below also has to look at an imported `zip`.
 */
const shippingField = (key: string): SQL =>
  sql`(CASE WHEN jsonb_typeof(${customers.shippingAddress}) = 'object' THEN ${customers.shippingAddress} ->> ${key}::text END)`;

/**
 * Filterable columns, keyed by their public (API) name.
 *
 * The key is the name `serializeCustomer` emits for that value, so a filter and the
 * field an operator reads back in the response are the same thing. Where the response
 * NESTS the value (`address.city`, `shipping_address.country`) the key is that path
 * flattened with `_`: the query grammar is `<field>[<op>]`, so a field id cannot itself
 * carry brackets (`parseListQuery` matches `^[a-z_]+$`).
 */
/**
 * How many of this customer's subscriptions sit in one API status.
 *
 * ⚠️ Counts `apiStatusSql`, NOT `subscriptions.status`. `non_renewing` is derived at the
 * API boundary and is a value the column never holds, so counting the stored column
 * would answer 0 for every customer while the list beside it renders "Non-renewing" on
 * their rows — the same defect the subscriptions `status` FILTER had before that
 * expression existed. One definition, in `subscriptions/status-sql.ts`.
 *
 * Correlated on `subscriptions_customer_idx` (verified against the live schema, not the
 * schema file). Do not add a count over a table whose `customer_id` is unindexed: this
 * runs once per candidate row.
 */
const subscriptionCountSql = (status: string): SQL => sql`(
  SELECT count(*)::int FROM ${subscriptions}
  WHERE ${subscriptions.customerId} = ${customers.id} AND ${apiStatusSql} = ${status})`;

/**
 * What this customer's live subscriptions earn per month, in MINOR UNITS — the column
 * `FILTERS.mrr` registers so the field and its operators are known.
 *
 * ⚠️ IT SUMS ACROSS CURRENCIES, so it never reaches a query: `customerFilterConditions`
 * replaces it per business with `mrrColumn`, which converts to the default currency (or
 * compares in one pinned currency). See `mrrColumn`.
 *
 * `active` and `in_trial` only, matching `getCurrencyWeightsForCustomers` below —
 * `mrr` is 0 on every other status by design (migration 0160).
 */
const liveMrrSql: SQL = sql`(
  SELECT coalesce(sum(${subscriptions.mrr}), 0)::bigint FROM ${subscriptions}
  WHERE ${subscriptions.customerId} = ${customers.id}
    AND ${subscriptions.status} IN ('active', 'in_trial'))`;

/**
 * `mrr` as a filter compares in ONE currency, never across several.
 *
 * Unpinned, each live subscription's MRR is converted into the business's default currency
 * with the business's stored rates — `round(mrr / rate)` per subscription, the rule every
 * converted report uses — and summed per customer, so "≥ 25,000" means "≥ 250.00 of the default
 * currency" whatever a customer is billed in. Pinned (`currency is X`), it compares natively in
 * X and counts only X's subscriptions. The filter value is minor units of whichever currency
 * that is. A held currency with no usable rate is refused by name: counting it at par, or
 * dropping it, would both put the wrong customers in the list without saying so.
 *
 * Rates are the business's CURRENT ones, so membership can move when a rate does.
 */
export class CustomerFilterRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerFilterRefusedError";
  }
}

/** The one currency an `mrr` filter is pinned to: `currency is X`, or `in` with one value. */
const mrrPin = (filters: readonly ListFilter[] | undefined): string | null => {
  // A one-member JSON array (`["USD"]`) pins like the bare `USD` does.
  const oneJson = (v: string) => isJsonArrayValue(v) && splitMulti(v).length === 1;
  const f = filters?.find(
    (x) =>
      x.field === "currency" &&
      (x.op === "is" || (x.op === "in" && (oneJson(x.value) || !x.value.includes(",")))),
  );
  if (!f) return null;
  return (isJsonArrayValue(f.value) ? splitMulti(f.value)[0]! : f.value).trim().toUpperCase();
};

const usableRate = (raw: unknown): string | null => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? String(raw).trim() : null;
};

/** What an `mrr` comparison needs to know about a business's book. */
export interface MrrFilterBook {
  base: string;
  rates: Record<string, unknown>;
  /** The currencies its live subscriptions carry. */
  live: string[];
}

export async function mrrFilterBook(tx: Tx, businessId: string): Promise<MrrFilterBook> {
  const [b] = await tx
    .select({ base: businesses.defaultCurrency, rates: businesses.exchangeRates })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const rows = await tx
    .selectDistinct({ currency: subscriptions.currency })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.businessId, businessId),
        sql`${subscriptions.status} IN ('active', 'in_trial')`,
      ),
    );
  return {
    base: (b?.base ?? "USD").toUpperCase(),
    rates: (b?.rates as Record<string, unknown> | null) ?? {},
    live: [
      ...new Set(rows.map((r) => r.currency?.toUpperCase()).filter((c): c is string => !!c)),
    ].sort(),
  };
}

/** Why an `mrr` filter cannot be answered on this book, or null when it can. */
export function mrrFilterRefusal(
  filters: readonly ListFilter[] | undefined,
  book: MrrFilterBook,
): string | null {
  if (!filters?.some((f) => f.field === "mrr") || mrrPin(filters)) return null;
  const missing = book.live.filter((c) => c !== book.base && usableRate(book.rates[c]) == null);
  if (missing.length === 0) return null;
  return (
    `A filter on 'mrr' compares values in the default currency of the business (${book.base}). There is no ` +
    `usable exchange rate for ${missing.join(", ")}. Set one in the business settings, or add a ` +
    `'currency' filter to compare in one currency.`
  );
}

function mrrColumn(filters: readonly ListFilter[] | undefined, book: MrrFilterBook): SQL {
  const live = sql`${subscriptions.customerId} = ${customers.id} AND ${subscriptions.status} IN ('active', 'in_trial')`;
  const pin = mrrPin(filters);
  if (pin) {
    return sql`(SELECT coalesce(sum(${subscriptions.mrr}), 0)::bigint FROM ${subscriptions}
      WHERE ${live} AND upper(${subscriptions.currency}) = ${pin})`;
  }
  const refusal = mrrFilterRefusal(filters, book);
  if (refusal) throw new CustomerFilterRefusedError(refusal);
  const arms = book.live
    .filter((c) => c !== book.base)
    .map((c) => sql`WHEN ${c} THEN ${usableRate(book.rates[c])}::numeric`);
  // The currencies were read in this transaction; one appearing since would read NULL here and
  // drop out of the sum, which is why the refusal above runs first rather than a fallback.
  const rate = sql`CASE upper(${subscriptions.currency}) WHEN ${book.base} THEN 1::numeric ${sql.join(arms, sql` `)} END`;
  return sql`(SELECT coalesce(sum(round(${subscriptions.mrr}::numeric / ${rate})), 0)::bigint
    FROM ${subscriptions} WHERE ${live})`;
}

const FILTERS: Record<string, FilterSpec> = {
  id: { column: customers.publicId, kind: "text" },
  email: { column: customers.email, kind: "text" },
  // The DERIVED holder name, not the deprecated column — otherwise filtering by the
  // name a list shows returns an empty page. `first_name`/`last_name`/`company`
  // remain available for filtering one component exactly.
  name: { column: accountHolderNameSql, kind: "text" },
  first_name: { column: customers.firstName, kind: "text" },
  last_name: { column: customers.lastName, kind: "text" },
  company: { column: customers.company, kind: "text" },
  phone: { column: customers.phone, kind: "text" },
  currency: { column: customers.currency, kind: "enum" },
  // `text`, not `enum`: a locale is `en-US`, and `starts_with=en` ("everyone we mail in
  // English") is the question operators actually ask of it.
  locale: { column: customers.locale, kind: "text" },
  auto_collection: { column: customers.autoCollection, kind: "enum" },
  net_term_days: { column: customers.netTermDays, kind: "number" },
  invoice_notes: { column: customers.invoiceNotes, kind: "text" },

  // ── Billing address (serialized under `address`) ──────────────────────────────
  // `country` keeps its bare name: it shipped as a filter before the rest of this
  // block existed and callers' saved queries carry it. It is the same column
  // `address.country` serializes from, and there is deliberately no `address_country`
  // alias — two ids for one column is how a saved segment and a filter panel end up
  // disagreeing about which is canonical.
  country: { column: customers.country, kind: "enum" },
  address_line1: { column: customers.addressLine1, kind: "text" },
  address_line2: { column: customers.addressLine2, kind: "text" },
  address_line3: { column: customers.addressLine3, kind: "text" },
  address_city: { column: customers.city, kind: "text" },
  address_state: { column: customers.state, kind: "text" },
  // The canonical subdivision CODE the tax engine resolves place of supply on
  // (`requireStateCode`), so it is a closed vocabulary — no substring operators.
  address_state_code: { column: customers.stateCode, kind: "enum" },
  address_postal_code: { column: customers.postalCode, kind: "text" },
  // The billing address's own contact block (CP-2) — distinct from the customer's
  // `first_name`/`last_name`/`company`/`phone` above, which is why both are filterable.
  address_first_name: { column: customers.billingFirstName, kind: "text" },
  address_last_name: { column: customers.billingLastName, kind: "text" },
  address_company: { column: customers.billingCompany, kind: "text" },
  address_phone: { column: customers.billingPhone, kind: "text" },

  // ── Shipping address (one jsonb blob; see `shippingField`) ────────────────────
  shipping_address_city: { column: shippingField("city"), kind: "text" },
  shipping_address_state: { column: shippingField("state"), kind: "text" },
  shipping_address_country: { column: shippingField("country"), kind: "enum" },
  shipping_address_postal_code: {
    column: sql`coalesce(${shippingField("postal_code")}, ${shippingField("zip")})`,
    kind: "text",
  },

  // ── Tax ──────────────────────────────────────────────────────────────────────
  tax_exempt: { column: customers.taxExempt, kind: "bool" },
  email_notifications: { column: customers.emailNotifications, kind: "bool" },
  dunning_excluded: { column: customers.dunningExcluded, kind: "bool" },
  exclude_from_reporting: { column: customers.excludeFromReporting, kind: "bool" },
  tax_treatment: { column: customers.taxTreatment, kind: "enum" },
  // The customer's OWN registration number (GSTIN); `vat_number` is the separate
  // EU/VIES id with its own validation lifecycle. Both are filterable because the
  // question a migration audit asks is "who is missing one" — `is_present=false`.
  tax_registration_number: { column: customers.taxRegistrationNumber, kind: "text" },
  vat_number: { column: customers.vatNumber, kind: "text" },
  vat_number_status: { column: customers.vatNumberStatus, kind: "enum" },
  vat_validated_at: { column: customers.vatValidatedAt, kind: "date" },
  withholding_rate_bps: { column: customers.withholdingRateBps, kind: "number" },

  // ── Billing anchor + lifecycle ───────────────────────────────────────────────
  billing_date: { column: customers.billingDate, kind: "number" },
  billing_date_mode: { column: customers.billingDateMode, kind: "enum" },
  pii_cleared: { column: customers.piiCleared, kind: "enum" },
  created_at: { column: customers.createdAt, kind: "date" },
  updated_at: { column: customers.updatedAt, kind: "date" },

  // ── Subscription counts ──────────────────────────────────────────────────────
  // Numeric, so they take the full comparison family — "customers with more than one
  // active subscription", "customers with zero", not just presence. `subscription_status`
  // below already answers presence; these answer HOW MANY, a different question.
  // Every subscription the customer has ever held, whatever its status.
  subscription_count: {
    column: sql`(SELECT count(*)::int FROM ${subscriptions} WHERE ${subscriptions.customerId} = ${customers.id})`,
    kind: "number",
  },
  active_subscription_count: { column: subscriptionCountSql("active"), kind: "number" },
  non_renewing_subscription_count: { column: subscriptionCountSql("non_renewing"), kind: "number" },
  in_trial_subscription_count: { column: subscriptionCountSql("in_trial"), kind: "number" },
  future_subscription_count: { column: subscriptionCountSql("future"), kind: "number" },
  cancelled_subscription_count: { column: subscriptionCountSql("cancelled"), kind: "number" },
  paused_subscription_count: { column: subscriptionCountSql("paused"), kind: "number" },
  // Every saved payment method, whatever its status: "customers with no backup"
  // is `payment_method_count[lt]=2`. Removing a method deletes its row.
  payment_method_count: {
    column: sql`(SELECT count(*)::int FROM ${paymentMethods} WHERE ${paymentMethods.customerId} = ${customers.id})`,
    kind: "number",
  },

  // ── Recurring revenue ────────────────────────────────────────────────────────
  mrr: { column: liveMrrSql, kind: "number" },

  // ── Credits (face value, minor units; remaining = Σ movements) ───────────────
  credit_balance: {
    column: sql`(SELECT coalesce(sum(m.face_minor), 0) FROM credit_grant_movements m
      JOIN credit_grants g ON g.id = m.grant_id
      WHERE g.customer_id = ${customers.id} AND g.status = 'active')`,
    kind: "number",
  },
  // Days the balance lasts at the last 7 days' average use; null with no use in that time.
  credit_runway_days: {
    column: sql`(SELECT CASE WHEN used > 0 THEN round(bal * 7.0 / used, 1) END FROM (
      SELECT coalesce(sum(m.face_minor) FILTER (WHERE g.status = 'active'), 0) AS bal,
        coalesce(-sum(m.face_minor) FILTER (WHERE m.kind = 'draw'
          AND m.created_at > now() - interval '7 days'), 0) AS used
      FROM credit_grant_movements m JOIN credit_grants g ON g.id = m.grant_id
      WHERE g.customer_id = ${customers.id}) s)`,
    kind: "number",
  },
  next_credit_expiry_at: {
    column: sql`(SELECT min(g.expires_at) FROM credit_grants g
      WHERE g.customer_id = ${customers.id} AND g.status = 'active' AND g.expires_at IS NOT NULL
        AND (SELECT sum(m.face_minor) FROM credit_grant_movements m WHERE m.grant_id = g.id) > 0)`,
    kind: "date",
  },
  // ── Usage (folded events) ────────────────────────────────────────────────────
  last_usage_at: {
    column: sql`(SELECT max(r.bucket_start) FROM usage_rollups r WHERE r.customer_id = ${customers.id})`,
    kind: "date",
  },
  // Whole days since the last usage; null for a customer who never sent any.
  days_since_last_usage: {
    column: sql`(SELECT floor(extract(epoch FROM now() - max(r.bucket_start)) / 86400)::int
      FROM usage_rollups r WHERE r.customer_id = ${customers.id})`,
    kind: "number",
  },
  // ── One-time orders (`metrics/daily/order-measures.ts` `isOrder`) ──────────────
  order_count: {
    column: sql`(SELECT count(*)::int FROM invoices i WHERE i.customer_id = ${customers.id} AND ${isOrder()})`,
    kind: "number",
  },
  first_order_at: {
    column: sql`(SELECT min(i.created_at) FROM invoices i WHERE i.customer_id = ${customers.id} AND ${isOrder()})`,
    kind: "date",
  },
  last_order_at: {
    column: sql`(SELECT max(i.created_at) FROM invoices i WHERE i.customer_id = ${customers.id} AND ${isOrder()})`,
    kind: "date",
  },
  // Whole days since the last order; null for a customer who never placed one.
  days_since_last_order: {
    column: sql`(SELECT floor(extract(epoch FROM now() - max(i.created_at)) / 86400)::int
      FROM invoices i WHERE i.customer_id = ${customers.id} AND ${isOrder()})`,
    kind: "number",
  },
  last_credit_purchase_at: {
    column: sql`(SELECT max(g.created_at) FROM credit_grants g
      WHERE g.customer_id = ${customers.id} AND g.source IN ('purchase', 'auto_top_up')
        AND g.status IN ('active', 'expired'))`,
    kind: "date",
  },
};

/** EXISTS (…) over a table carrying `customer_id`. Every FK used below is indexed. */
const relatedExists =
  (table: typeof subscriptions | typeof paymentMethods | typeof invoices, fk: Column) =>
  (inner: SQL) =>
    sql`EXISTS (SELECT 1 FROM ${table} WHERE ${fk} = ${customers.id} AND ${inner})`;

const subscriptionExists = relatedExists(subscriptions, subscriptions.customerId);
const paymentMethodExists = relatedExists(paymentMethods, paymentMethods.customerId);
const invoiceExists = relatedExists(invoices, invoices.customerId);

/**
 * A payment method holding a specific ROLE. `is_present` through this answers "has a
 * primary/backup at all" — an operator asking that wants either the rail the customer
 * actually pays with, or the customers who have no fallback.
 *
 * Read off `role`, not `is_default`: that field is literally `role === 'primary'`, kept
 * on the API for integrators, and the engine's own `/assign_role` speaks roles.
 */
const pmWithRoleExists = (role: string) => (inner: SQL) =>
  sql`EXISTS (SELECT 1 FROM ${paymentMethods}
    WHERE ${paymentMethods.customerId} = ${customers.id}
      AND ${paymentMethods.role} = ${role} AND ${inner})`;

/**
 * The gateway ACCOUNT a stored instrument belongs to, addressed by its public id.
 *
 * `payment_methods.gateway_account_id` is an internal uuid, so filtering on it directly
 * would ask an operator for a value no screen ever shows them. The join is to one row
 * on an indexed primary key, and gateway accounts are a handful per business.
 */
const pmGatewayAccountExists = (inner: SQL) =>
  sql`EXISTS (SELECT 1 FROM ${paymentMethods}
    JOIN ${gatewayAccounts} ON ${gatewayAccounts.id} = ${paymentMethods.gatewayAccountId}
    WHERE ${paymentMethods.customerId} = ${customers.id} AND ${inner})`;

/**
 * Still owed. `pending` is excluded because such an invoice is still ACCRETING lines
 * (metered usage mid-period) and nobody has been asked to pay it yet — counting it as
 * unpaid reports a debt to the operator that does not exist. The status vocabulary
 * lives in `modules/invoicing/status.ts`.
 */
const UNPAID_INVOICE_STATUSES = ["posted", "payment_due", "not_paid"] as const;

/**
 * Virtual filter fields: resolved with an EXISTS sub-query instead of a column, so
 * they cannot live in `FILTERS` (which is what `filterConditions` drives). The
 * dashboard's segments ("With Active Subscriptions", "Without a Payment Method") need
 * them to mean something beyond the page that happens to be loaded.
 *
 * `kind` is what `parseListQuery` validates the VALUE against, and it also selects the
 * operator table: `enum` is exactly the set an EXISTS can answer (equality, set
 * membership, presence), `bool` for the ones that are only ever a yes/no.
 *
 * Every sub-query joins on an INDEXED `customer_id` (`subscriptions_customer_idx`,
 * `payment_methods_customer_idx`, `invoices_customer_idx`). Do not add a virtual field
 * whose FK is unindexed — that turns one filter into a sequential scan per row.
 */

const VIRTUAL_FILTERS: Record<string, VirtualFilter> = {
  subscription_status: {
    kind: "enum",
    condition: (op, v) => existsFieldCondition(subscriptionExists, subscriptions.status, op, v),
  },
  /**
   * The cycle length of a subscription the customer holds — `day` | `week` | `month` |
   * `year`. "Customers on annual plans" is a question about the customer, and the
   * interval lives only on the subscription, so an EXISTS is the only honest shape.
   *
   * The UNIT, not the interval: `billing_period` is the multiplier (2 months, 3 weeks)
   * and a filter that folded the two would answer "annual" for a 12-month plan on one
   * book and not on another, depending purely on how the plan was entered.
   */
  subscription_billing_period_unit: {
    kind: "enum",
    condition: (op, v) =>
      existsFieldCondition(subscriptionExists, subscriptions.billingPeriodUnit, op, v),
  },
  /**
   * When a subscription of theirs was cancelled — the only DATE-kind virtual field, so
   * it goes through `existsDateCondition` rather than the text comparison the rest of
   * this map uses. That is what makes `in_last` mean the same 30 days here as it does
   * on `created_at`, business zone included.
   *
   * "Has ANY subscription cancelled in the window" is the semantics, so a customer who
   * cancelled one of three matches. That is the right answer for a churn-follow-up
   * list and the wrong one for "customers who have left" — which is
   * `active_subscription_count[is]=0`, a different question with its own filter.
   */
  subscription_cancelled_at: {
    kind: "date",
    condition: (op, v, tz) =>
      existsDateCondition(subscriptionExists, subscriptions.canceledAt, op, v, tz),
  },
  // `is_present` on either of these answers "has any payment method at all", which is
  // the question the "Without a Payment Method" segment asks.
  payment_method_type: {
    kind: "enum",
    condition: (op, v) => existsFieldCondition(paymentMethodExists, paymentMethods.type, op, v),
  },
  payment_method_status: {
    kind: "enum",
    condition: (op, v) => existsFieldCondition(paymentMethodExists, paymentMethods.status, op, v),
  },
  /**
   * ── The stored instrument ──────────────────────────────────────────────────────
   * Every one of these is an EXISTS over `payment_methods` on the indexed
   * `payment_methods_customer_idx`, so "has ANY method matching" is the semantics — and
   * its negation therefore includes the customer with no method at all, which is what
   * `existsFieldCondition`'s docblock settles for the whole family.
   *
   * `enum` throughout, including the two expiry numbers: `existsFieldCondition` compares
   * `lower(col::text)`, so it answers equality and set membership but not ranges. That
   * is honest for "expiring in 09" or "one of 2026,2027"; a real "expires before"
   * needs a numeric EXISTS path and is deliberately NOT faked with a text comparison,
   * which would sort "9" after "10".
   */
  payment_method_id: {
    kind: "enum",
    condition: (op, v) => existsFieldCondition(paymentMethodExists, paymentMethods.publicId, op, v),
  },
  payment_method_gateway: {
    kind: "enum",
    condition: (op, v) =>
      existsFieldCondition(paymentMethodExists, paymentMethods.providerKey, op, v),
  },
  /** Card type — Visa / Mastercard / RuPay, not card-vs-bank. */
  payment_method_brand: {
    kind: "enum",
    condition: (op, v) => existsFieldCondition(paymentMethodExists, paymentMethods.brand, op, v),
  },
  payment_method_last4: {
    kind: "enum",
    condition: (op, v) => existsFieldCondition(paymentMethodExists, paymentMethods.last4, op, v),
  },
  payment_method_exp_month: {
    kind: "enum",
    condition: (op, v) => existsFieldCondition(paymentMethodExists, paymentMethods.expMonth, op, v),
  },
  payment_method_exp_year: {
    kind: "enum",
    condition: (op, v) => existsFieldCondition(paymentMethodExists, paymentMethods.expYear, op, v),
  },
  /**
   * Holds a saved card that expires within ninety days — the `cards_expiring` measure's own
   * rule (`metrics/daily/payment-method-measures.ts`): a card is good to the last instant of
   * the month it prints, and status does not enter. So the list behind that figure is exactly
   * the customers holding those cards.
   */
  /**
   * A paying customer: at least one active or non-renewing, non-deleted subscription earning MRR
   * now (> 0). The Paying customers figure's own population; `renewing` narrows it to the ones
   * that will be charged again.
   */
  paying: {
    kind: "bool",
    condition: (op, v) => {
      if (op !== "is") return undefined;
      const pays = sql`EXISTS (SELECT 1 FROM ${subscriptions}
        WHERE ${subscriptions.customerId} = ${customers.id}
          AND ${apiStatusSql} IN ('active', 'non_renewing')
          AND ${notDeleted()}
          AND ${subscriptions.mrr} > 0)`;
      return v === "true" ? pays : sql`NOT ${pays}`;
    },
  },
  /**
   * A renewing, paying customer: at least one ACTIVE, non-deleted subscription earning MRR now
   * (> 0) — one that will be charged again. Non-renewing ones end at term and never charge
   * again, so they are out, as are trials, free plans and cancelled books.
   */
  renewing: {
    kind: "bool",
    condition: (op, v) => {
      if (op !== "is") return undefined;
      const pays = sql`EXISTS (SELECT 1 FROM ${subscriptions}
        WHERE ${subscriptions.customerId} = ${customers.id}
          AND ${apiStatusSql} = 'active'
          AND ${notDeleted()}
          AND ${subscriptions.mrr} > 0)`;
      return v === "true" ? pays : sql`NOT ${pays}`;
    },
  },
  /**
   * A renewing customer whose next charge cannot succeed: at least one ACTIVE subscription
   * earning MRR (> 0) that collects automatically (non-renewing ones never charge again), and no payment method that still works —
   * none at all, or every one expired (by status or printed date) or invalid. A working
   * backup rules the customer out. Offline (auto-collection off) customers need no method,
   * so they never count.
   */
  cannot_be_charged: {
    kind: "bool",
    condition: (op, v) => {
      if (op !== "is") return undefined;
      const expires = sql`(make_timestamptz(${paymentMethods.expYear}, ${paymentMethods.expMonth}, 1, 0, 0, 0, 'UTC') + interval '1 month')`;
      const stuck = sql`(EXISTS (SELECT 1 FROM ${subscriptions}
          WHERE ${subscriptions.customerId} = ${customers.id}
            AND ${apiStatusSql} = 'active'
            AND ${notDeleted()}
            AND ${subscriptions.mrr} > 0
            AND coalesce(${subscriptions.autoCollection}, ${customers.autoCollection}) = 'on')
        AND NOT EXISTS (SELECT 1 FROM ${paymentMethods}
          WHERE ${paymentMethods.customerId} = ${customers.id}
            AND ${paymentMethods.status} NOT IN ('expired', 'invalid')
            AND NOT (${paymentMethods.expYear} IS NOT NULL
              AND ${paymentMethods.expMonth} IS NOT NULL
              AND ${expires} <= now())))`;
      return v === "true" ? stuck : sql`NOT ${stuck}`;
    },
  },
  payment_method_expiring: {
    kind: "bool",
    condition: (op, v) => {
      if (op !== "is") return undefined;
      const expires = sql`(make_timestamptz(${paymentMethods.expYear}, ${paymentMethods.expMonth}, 1, 0, 0, 0, 'UTC') + interval '1 month' - interval '1 microsecond')`;
      const held = sql`EXISTS (SELECT 1 FROM ${paymentMethods}
        WHERE ${paymentMethods.customerId} = ${customers.id}
          AND ${paymentMethods.expYear} IS NOT NULL
          AND ${paymentMethods.expMonth} IS NOT NULL
          AND ${expires} >= now()
          AND ${expires} <= now() + interval '90 days')`;
      return v === "true" ? held : sql`NOT ${held}`;
    },
  },
  payment_method_issuer_country: {
    kind: "enum",
    condition: (op, v) =>
      existsFieldCondition(paymentMethodExists, paymentMethods.issuerCountry, op, v),
  },
  /** Bank account type — `instrument_sub_type` is where that fact lives for us. */
  payment_method_sub_type: {
    kind: "enum",
    condition: (op, v) =>
      existsFieldCondition(paymentMethodExists, paymentMethods.instrumentSubType, op, v),
  },
  payment_method_role: {
    kind: "enum",
    condition: (op, v) => existsFieldCondition(paymentMethodExists, paymentMethods.role, op, v),
  },
  payment_method_gateway_account: {
    kind: "enum",
    condition: (op, v) =>
      existsFieldCondition(pmGatewayAccountExists, gatewayAccounts.publicId, op, v),
  },
  /** The rail the customer actually pays with, and the one they fall back to. */
  primary_payment_method_type: {
    kind: "enum",
    condition: (op, v) =>
      existsFieldCondition(pmWithRoleExists("primary"), paymentMethods.type, op, v),
  },
  backup_payment_method_type: {
    kind: "enum",
    condition: (op, v) =>
      existsFieldCondition(pmWithRoleExists("backup"), paymentMethods.type, op, v),
  },
  /**
   * Invoice status. Distinct from `has_unpaid_invoices` below, which asks one
   * fixed question over a fixed status SET; this one takes the caller's status, so
   * "customers with a voided invoice" and "customers who have never been invoiced"
   * (`is_present=false`) become reachable.
   */
  invoice_status: {
    kind: "enum",
    condition: (op, v) => existsFieldCondition(invoiceExists, invoices.status, op, v),
  },
  has_unpaid_invoices: {
    kind: "bool",
    // Not routed through `existsFieldCondition`: the predicate is a fixed status set
    // rather than a caller-supplied value, so the only operator is `is` and the VALUE
    // decides which way the EXISTS points.
    condition: (op, v) => {
      if (op !== "is") return undefined;
      const statuses = sql.join(
        UNPAID_INVOICE_STATUSES.map((s) => sql`${s}`),
        sql`, `,
      );
      const unpaid = invoiceExists(sql`${invoices.status} IN (${statuses})`);
      return v === "true" ? unpaid : sql`NOT ${unpaid}`;
    },
  },
  /**
   * Has EVER had a coupon or manual discount applied to any of their subscriptions — any
   * status, so a removed or exhausted one still counts. Same `is`-only shape as above.
   */
  has_used_discount: {
    kind: "bool",
    condition: (op, v) => {
      if (op !== "is") return undefined;
      const used = sql`EXISTS (SELECT 1 FROM ${appliedCoupons}
        JOIN ${subscriptions} ON ${subscriptions.id} = ${appliedCoupons.subscriptionId}
        WHERE ${subscriptions.customerId} = ${customers.id})`;
      return v === "true" ? used : sql`NOT ${used}`;
    },
  },
};

/** field → operators it accepts; the route validates the request against this. */
export const CUSTOMER_FILTER_OPS: Record<string, readonly string[]> = {
  ...opsFromSpecs(FILTERS),
  ...opsFromSpecs(VIRTUAL_FILTERS),
};

/**
 * field → kind, so the route rejects a malformed VALUE with a 400 naming the shape
 * (`created_at[on]=31/08/2026`, `net_term_days[between]=30`) instead of letting it
 * reach Postgres as a cast error — a 500 on a caller typo.
 */
export const CUSTOMER_FILTER_KINDS: Record<string, FilterKind> = {
  ...kindsFromSpecs(FILTERS),
  ...kindsFromSpecs(VIRTUAL_FILTERS),
};

/**
 * The business's own `cf_<api_name>` fields as filter specs, operators and kinds.
 *
 * Per-business and created at runtime, so they cannot live in the static maps above —
 * which `modules/list-views/entities.ts` reads and must keep meaning exactly what it
 * meant. A caller merges this over them for the request it is serving.
 *
 * It lives in this module because this module owns WHICH jsonb column holds a
 * customer's values; the route owns only the request. Both halves come from ONE
 * definitions read: the route loads the rows (it needs `ops`/`kinds` before
 * `parseListQuery` can validate a `cf_*` filter) and hands them to `listCustomersPage`
 * as `customFieldDefs`. A second read inside the service could disagree with the first
 * if a definition were created between them, and would double the queries on every
 * list page.
 */
export function customerCustomFieldFilterSet(defs: CustomFieldDefinitionRow[]) {
  return customFieldFilterSet(defs, customers.customFields);
}

/**
 * Sortable columns. `created_at` is the indexed keyset fast path; every other sort
 * pays an offset cursor, so only columns cheap to order within one business's
 * partition belong here — `id` is index-served (`customers_biz_public_id_uq`), the
 * rest are single-column sorts over rows the filters have already narrowed.
 */
const SORTS = {
  created_at: customers.createdAt,
  updated_at: customers.updatedAt,
  id: customers.publicId,
  name: accountHolderNameSql,
  email: customers.email,
  company: customers.company,
} as const;

export type CustomerSortField = keyof typeof SORTS;
export const CUSTOMER_SORT_FIELDS = Object.keys(SORTS) as CustomerSortField[];

export interface CustomerListFilters {
  includeArchived?: boolean;
  /**
   * The business's `customer` custom-field definitions, loaded once by the route (see
   * `customerCustomFieldFilterSet`). Absent means no `cf_*` filter applies — the right
   * answer for a caller that never validated the query against them.
   */
  customFieldDefs?: CustomFieldDefinitionRow[];
  search?: string;
  filters?: ListFilter[];
  sortField?: string;
  sortDesc?: boolean;
  startingAfter?: string;
  limit?: number;
}

/**
 * One page of a business's customers — what the API list route serves.
 *
 * Keyset on `(created_at DESC, public_id DESC)` for the default sort (index
 * `customers_business_created_idx`), so page N costs page 1 and a concurrent
 * insert can't make a row appear twice. Another sort falls back to an offset
 * cursor — correct, and only paid for when the operator re-sorts. `total` is the
 * filtered count, computed for the first page only.
 */
/**
 * Every WHERE term a customer list request implies — the business scope, the archive
 * rule, the free-text search, the column filters and the EXISTS-backed ones.
 *
 * Extracted so a second reader can ask a DIFFERENT question of the SAME population.
 * `customerSegmentTotals` below sums MRR over a segment; had it rebuilt these terms it
 * would have been a second filtering path over customers, and the first time the two
 * disagreed the screen would show a total that did not match the rows under it.
 * Behaviour is unchanged from when this lived inline in `listCustomersPage`: same
 * expressions, same order, same zone.
 */
/**
 * A substring search as the ids it matches, when there are at most `TOTAL_CAP` of them.
 *
 * Left as six `ILIKE`s beside a newest-first `LIMIT`, the planner walks the created-at index
 * hoping to fill a page early; a term matching ten of a million customers then reads the whole
 * business (37 s under load, D4). Resolved first through the trigram index, the page sorts only
 * the matches. A term matching more keeps the plain condition, where that walk is cheap.
 */
async function narrowSearch(tx: Tx, businessId: string, search: SQL): Promise<SQL> {
  // A prepared statement switches to a generic plan after five runs, and a generic plan cannot
  // see the pattern, so it gives up the trigram index for a full scan (23 s under load, D4).
  await tx.execute(sql`set local plan_cache_mode = force_custom_plan`);
  const hits = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.businessId, businessId), search))
    .limit(TOTAL_CAP + 1);
  if (hits.length > TOTAL_CAP) return search;
  return hits.length
    ? inArray(
        customers.id,
        hits.map((h) => h.id),
      )
    : sql`false`;
}

async function customerFilterConditions(
  tx: Tx,
  businessId: string,
  f: CustomerListFilters,
): Promise<SQL[]> {
  const conds: SQL[] = [eq(customers.businessId, businessId)];
  if (!f.includeArchived) conds.push(eq(customers.active, true));
  const search = searchCondition(
    [
      customers.publicId,
      customers.email,
      customers.firstName,
      customers.lastName,
      customers.company,
      customers.phone,
    ],
    f.search,
  );
  if (search) conds.push(await narrowSearch(tx, businessId, search));
  // Date filters bucket by the BUSINESS day, not the UTC day (business-tz.ts).
  const tz = await businessTimezone(tx, businessId);
  // `cf_*` specs go through the SAME call and the same zone, so a custom field of a
  // given kind filters exactly like a real column of that kind. Keys cannot collide:
  // an `api_name` may not itself start with `cf_` (custom-fields/service.ts) and no
  // static field above does.
  const cfSpecs = f.customFieldDefs?.length
    ? customerCustomFieldFilterSet(f.customFieldDefs).specs
    : undefined;
  // `mrr` depends on the business's currencies and rates, so its column is built here.
  const mrrSpec: Record<string, FilterSpec> = f.filters?.some((x) => x.field === "mrr")
    ? { mrr: { column: mrrColumn(f.filters, await mrrFilterBook(tx, businessId)), kind: "number" } }
    : {};
  conds.push(...filterConditions({ ...FILTERS, ...mrrSpec, ...cfSpecs }, f.filters, tz));
  // The EXISTS-backed fields are not in FILTERS, so filterConditions cannot see them.
  for (const filter of f.filters ?? []) {
    const virtual = VIRTUAL_FILTERS[filter.field];
    if (!virtual) continue;
    // `tz` matters only to a `date`-kind virtual field; the enum/bool ones ignore it.
    const c = virtual.condition(filter.op, filter.value, tz);
    if (c) conds.push(c);
  }
  return conds;
}

/**
 * The customer ids a filter set matches, as a subquery — for a reader that joins its own
 * facts to a population (segment analytics) rather than listing it. The same conditions the
 * list and `customerSegmentTotals` use, so the three can never disagree about who is in it.
 */
export async function customerPopulationSql(
  tx: Tx,
  businessId: string,
  f: CustomerListFilters,
): Promise<SQL> {
  const where = and(...(await customerFilterConditions(tx, businessId, f)))!;
  return sql`select ${customers.id} from ${customers} where ${where}`;
}

/**
 * How many customers a filter set matches, and what they earn per month — BY
 * CURRENCY.
 *
 * ⚠️ Never one money figure. `subscriptions.mrr` is minor units of each
 * subscription's own currency, so one number over a mixed book adds cents to paise.
 * The breakdown is returned instead and the caller decides what it can honestly
 * print; `modules/segments` refuses to print a total at all when more than one
 * currency is present and the segment did not pin one.
 *
 * The count is over CUSTOMERS matching the filters; the MRR is over their live
 * subscriptions, so a customer with no active subscription contributes a head and no
 * money. Both come off the same conditions the list rows do.
 */
export async function customerSegmentTotals(
  organizationId: string,
  businessId: string,
  f: CustomerListFilters = {},
): Promise<{ customers: number; mrrByCurrency: Record<string, number> }> {
  return withTenant(organizationId, async (tx) => {
    const where = and(...(await customerFilterConditions(tx, businessId, f)))!;
    const [head] = await tx.select({ n: countExpr }).from(customers).where(where);
    const rows = await tx
      .select({
        currency: subscriptions.currency,
        mrr: sql<string>`coalesce(sum(${subscriptions.mrr}), 0)::text`,
      })
      .from(subscriptions)
      .where(
        and(
          sql`${subscriptions.customerId} IN (SELECT ${customers.id} FROM ${customers} WHERE ${where})`,
          sql`${subscriptions.status} IN ('active', 'in_trial')`,
        ),
      )
      .groupBy(subscriptions.currency);
    const mrrByCurrency: Record<string, number> = {};
    for (const r of rows) {
      if (!r.currency) continue;
      // Integer minor units throughout — `sum()` over bigint comes back as a string
      // precisely so it is never silently widened into a float on the way here.
      mrrByCurrency[r.currency] = Number(r.mrr);
    }
    return { customers: head?.n ?? 0, mrrByCurrency };
  });
}

export async function listCustomersPage(
  organizationId: string,
  businessId: string,
  f: CustomerListFilters = {},
): Promise<ListPage<typeof customers.$inferSelect>> {
  const limit = clampLimit(f.limit);
  const sortField = (f.sortField ?? "created_at") as CustomerSortField;
  const descending = f.sortDesc ?? true;
  const keyset = sortField === "created_at";

  return withTenant(organizationId, async (tx) => {
    const conds = await customerFilterConditions(tx, businessId, f);

    // The total covers the filtered set, before the cursor narrows it.
    const filterWhere = and(...conds)!;
    let total: number | null = null;
    if (!f.startingAfter) {
      total = await cappedTotal(
        tx,
        tx
          .select({ one: sql`1` })
          .from(customers)
          .where(filterWhere),
      );
    }

    const { keysetId, offset } = parseCursor(f.startingAfter);
    const pageConds = [...conds];
    if (keyset && keysetId) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${customers.createdAt}::text`,
          publicId: customers.publicId,
        })
        .from(customers)
        .where(and(eq(customers.businessId, businessId), eq(customers.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        customers.createdAt,
        customers.publicId,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.publicId } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }

    const rows = await tx
      .select()
      .from(customers)
      .where(and(...pageConds))
      .orderBy(...pageOrder(SORTS[sortField], customers.publicId, descending, keyset))
      .limit(limit + 1)
      .offset(keyset ? 0 : offset);

    return toPage(rows, limit, { keyset, offset, keyOf: (r) => r.publicId, total });
  });
}

/** Edit a customer's mutable fields. Only provided fields change; address null clears it. */
export async function updateCustomer(
  input: {
    organizationId: string;
    businessId: string;
    customerPublicId: string;
    expectedVersion?: number;
  } & CustomerFields,
): Promise<typeof customers.$inferSelect | null> {
  const set: Partial<typeof customers.$inferInsert> = {};
  if (input.email !== undefined) set.email = input.email;
  if (input.firstName !== undefined) set.firstName = input.firstName;
  if (input.lastName !== undefined) set.lastName = input.lastName;
  if (input.company !== undefined) set.company = input.company;
  if (input.phone !== undefined) set.phone = input.phone;
  if (input.currency !== undefined) set.currency = input.currency?.toUpperCase() ?? null;
  if (input.locale !== undefined) set.locale = input.locale;
  if (input.autoCollection !== undefined) set.autoCollection = input.autoCollection;
  if (input.netTermDays !== undefined) set.netTermDays = input.netTermDays;
  if (input.invoiceNotes !== undefined) set.invoiceNotes = input.invoiceNotes;
  if (input.shippingAddress !== undefined)
    set.shippingAddress = legacyShippingMirror(input.shippingAddress);
  if (input.taxExempt !== undefined) set.taxExempt = input.taxExempt;
  if (input.emailNotifications !== undefined) set.emailNotifications = input.emailNotifications;
  // Turning it off shifts the invoices in dunning by the exclusion's length (below).
  if (input.dunningExcluded !== undefined) set.dunningExcluded = input.dunningExcluded;
  if (input.dunningPolicyId !== undefined) set.dunningPolicyId = input.dunningPolicyId;
  if (input.excludeFromReporting !== undefined)
    set.excludeFromReporting = input.excludeFromReporting;
  if (input.billingCcEmails !== undefined) set.billingCcEmails = input.billingCcEmails;
  if (input.billingBccEmails !== undefined) set.billingBccEmails = input.billingBccEmails;
  if (input.vatNumber !== undefined) {
    set.vatNumber = input.vatNumber;
    // Editing the VAT number invalidates any prior validation (CUST-4).
    set.vatNumberStatus = "not_validated";
    set.vatValidatedAt = null;
  }
  if (input.withholdingRateBps !== undefined) set.withholdingRateBps = input.withholdingRateBps;
  if (input.creditSettings !== undefined) set.creditSettings = input.creditSettings;
  if (input.taxTreatment !== undefined) set.taxTreatment = input.taxTreatment;
  if (input.taxBehavior !== undefined) set.taxBehavior = input.taxBehavior;
  if (input.taxRegistrationNumber !== undefined)
    set.taxRegistrationNumber = input.taxRegistrationNumber;
  if (input.metadata !== undefined) set.metadata = input.metadata;
  applyAddress(set, input.address);
  return withTenant(input.organizationId, async (tx) => {
    const [current] = await tx
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.businessId, input.businessId),
          eq(customers.publicId, input.customerPublicId),
        ),
      )
      .limit(1);
    if (!current) return null;
    if (input.expectedVersion !== undefined && current.resourceVersion !== input.expectedVersion) {
      throw new VersionConflictError(input.expectedVersion, current.resourceVersion);
    }
    // GDPR: once personal data is cleared, PII must never be re-populated (CUST-7
    // review fix). Non-PII commercial fields may still be edited.
    if (current.piiCleared === "cleared") {
      const pii = new Set([
        "email",
        "name",
        "firstName",
        "lastName",
        "company",
        "phone",
        "shippingAddress",
        "vatNumber",
        "metadata",
        "addressLine1",
        "addressLine2",
        "addressLine3",
        "city",
        "state",
        "stateCode",
        "postalCode",
        "country",
        "billingFirstName",
        "billingLastName",
        "billingCompany",
        "billingPhone",
      ]);
      if (Object.keys(set).some((k) => pii.has(k)))
        throw new CustomerError(
          "You cannot set personal data on a customer whose data is cleared (GDPR)",
        );
    }
    await enforceMetadataRules(tx, input.businessId, "customer", input.metadata, {
      mode: "update",
      existing: current.metadata as Record<string, unknown> | null,
      scope: input.metadataRules,
    });
    if (input.customFields !== undefined) {
      const cf = await coerceCustomFields(tx, input.businessId, "customer", input.customFields, {
        mode: "update",
        existing: current.customFields as Record<string, unknown> | null,
      });
      if (cf !== undefined) set.customFields = cf;
    }
    // A re-save of the same values is not an edit: no write, no audit row, no event.
    const edit = effectivePatch(set, current);
    // Re-sending the same VAT number must not throw away its validation.
    if (!("vatNumber" in edit)) {
      delete edit.vatNumberStatus;
      delete edit.vatValidatedAt;
    }
    if (Object.keys(edit).length === 0) return current;
    // Exclusion freezes dunning time: lifting it pushes every remaining step later by
    // how long it lasted.
    let liftShiftMs = 0;
    if ("dunningExcluded" in edit) {
      const at = businessNow(input.businessId);
      edit.dunningExcludedAt = edit.dunningExcluded ? at : null;
      if (!edit.dunningExcluded && current.dunningExcludedAt)
        liftShiftMs = Math.max(0, at.getTime() - current.dunningExcludedAt.getTime());
    }
    let [c] = await tx
      .update(customers)
      .set(edit)
      .where(
        and(
          eq(customers.businessId, input.businessId),
          eq(customers.publicId, input.customerPublicId),
        ),
      )
      .returning();
    if (c && liftShiftMs > 0) await shiftHeldDunning(tx, c.id, input.businessId, liftShiftMs);
    // Stored analytics include or exclude this customer only once restated.
    if (c && "excludeFromReporting" in edit) {
      const restate = () =>
        restateReportingForBusiness({
          organizationId: input.organizationId,
          businessId: input.businessId,
          customerId: c!.id,
        });
      if (!afterCommit(restate)) void restate();
    }
    if (c && "shippingAddress" in edit) {
      // The legacy field writes the address book's default; the mirror is re-derived.
      await setDefaultShippingFromLegacy(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: c.id,
        raw: edit.shippingAddress,
      });
      [c] = await tx.select().from(customers).where(eq(customers.id, c.id)).limit(1);
    }
    if (c) {
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "customer_updated",
        data: buildEventData(
          "customer_updated",
          { id: c.publicId, email: c.email },
          c.resourceVersion,
        ),
      });
      // Billing-info touched? emit the dedicated event too (plan §A3).
      const billingKeys = [
        "addressLine1",
        "addressLine2",
        "city",
        "state",
        "postalCode",
        "country",
        "shippingAddress",
        "vatNumber",
        "taxExempt",
        "company",
      ] as const;
      if (billingKeys.some((k) => k in edit)) {
        await emitEvent(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          type: "customer_billing_info_updated",
          data: buildEventData(
            "customer_billing_info_updated",
            { id: c.publicId },
            c.resourceVersion,
          ),
        });
      }
      // ONE audit row for the update, not one per event. The two events above are a
      // webhook-shaping concern (a subscriber may care about billing info alone);
      // the audit record answers "who changed what", and the changed fields say
      // which it was — the reader gets "auto_collection on → off" either way. The
      // diff is derived from the two snapshots so it can never disagree with them.
      const beforeFull = auditSnapshot(current);
      const afterFull = auditSnapshot(c);
      const changed = changedFields(beforeFull, afterFull);
      await writeAuditLog(
        {
          organizationId: input.organizationId,
          businessId: input.businessId,
          action: "customer.update",
          resourceType: "customer",
          resourceId: c.publicId,
          before: changed.before,
          after: changed.after,
          beforeFull,
          afterFull,
        },
        tx,
      );
    }
    return c ?? null;
  });
}

/**
 * Move the customer's invoices in dunning later by `ms`, the length of a lifted exclusion:
 * the stored retry/reminder instants, a parked invoice's anchor, a standing pause, and
 * `dunning_held_ms`, which moves every step derived from the due date.
 */
async function shiftHeldDunning(tx: Tx, customerId: string, businessId: string, ms: number) {
  const by = sql`(${ms}::bigint * interval '1 millisecond')`;
  const pause = invoices.dunningPause;
  await tx
    .update(invoices)
    .set({
      nextAttemptAt: sql`${invoices.nextAttemptAt} + ${by}`,
      dunningNextReminderAt: sql`${invoices.dunningNextReminderAt} + ${by}`,
      dunningParkedAt: sql`case when ${invoices.dunningStatus} = 'parked'
        then coalesce(${invoices.dunningParkedAt}, ${invoices.dueDate}, ${invoices.createdAt}) + ${by}
        else ${invoices.dunningParkedAt} end`,
      dunningPause: sql`case when ${pause} is null then null else ${pause} || jsonb_build_object(
        'until', (${pause} ->> 'until')::timestamptz + ${by},
        'next_attempt_at', (${pause} ->> 'next_attempt_at')::timestamptz + ${by}) end`,
      dunningHeldMs: sql`${invoices.dunningHeldMs} + ${ms}::bigint`,
    })
    .where(
      and(
        eq(invoices.customerId, customerId),
        eq(invoices.businessId, businessId),
        eq(invoices.status, "payment_due"),
        inArray(invoices.dunningStatus, ["in_progress", "parked"]),
      ),
    );
}

/** Soft-archive (active=false) or restore (active=true) a customer. */
export async function setCustomerActive(
  organizationId: string,
  businessId: string,
  customerPublicId: string,
  active: boolean,
): Promise<typeof customers.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [c] = await tx
      .update(customers)
      .set({ active })
      .where(and(eq(customers.businessId, businessId), eq(customers.publicId, customerPublicId)))
      .returning();
    if (c) {
      const type = active ? "customer_restored" : "customer_archived";
      await emitEvent(tx, {
        organizationId,
        businessId,
        type,
        data: buildEventData(type, { id: c.publicId }, c.resourceVersion),
      });
      // No full snapshot: the row is fetched and updated in one statement, so there
      // is no before-state to snapshot without a second read purely for the audit.
      // The changed field IS the whole change here, and the reader loses nothing —
      // unlike `customer.update`, where the context is the point.
      await writeAuditLog(
        {
          organizationId,
          businessId,
          action: active ? "customer.restore" : "customer.archive",
          resourceType: "customer",
          resourceId: c.publicId,
          before: { active: !active },
          after: { active },
        },
        tx,
      );
    }
    return c ?? null;
  });
}

export async function getCustomerByPublicId(
  organizationId: string,
  businessId: string,
  customerPublicId: string,
): Promise<typeof customers.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [c] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.businessId, businessId), eq(customers.publicId, customerPublicId)))
      .limit(1);
    return c ?? null;
  });
}

/** Load a customer row by its internal id (RLS-scoped to the org). */
export async function getCustomerById(
  organizationId: string,
  customerId: string,
): Promise<typeof customers.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [c] = await tx.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    return c ?? null;
  });
}

/**
 * The currency this customer is actually billed in: their explicit
 * `customers.currency`, else the currency of their live subscriptions, else null.
 *
 * WHY IT IS NOT JUST `customers.currency`. That column is optional and is null far
 * more often than not — the API accepts a customer without one and the migration
 * importer never writes it. Every caller that needed a currency therefore fell
 * straight through to the BUSINESS default, which on a multi-currency business is
 * frequently not the currency this buyer owes anything in.
 *
 * Measured 2026-08-14 on the INR rails rehearsal, against a business whose default is
 * USD and whose only INR gateway is RazorPay. A customer with one ₹66,025 INR
 * subscription and no `customers.currency`:
 *   • the portal offered a USD-shaped gateway list, with RazorPay (INR-only) ABSENT —
 *     the one gateway that could collect their invoice was unreachable; and
 *   • the add-card flow registered the RazorPay mandate in **USD**, so RazorPay
 *     Checkout told the buyer "US$1 now, up to US$1,000/month" on an INR-only account,
 *     and `deriveMandateCeiling` found no USD subscriptions and fell back to the
 *     currency-blind constant instead of sizing the mandate from the ₹66,025 plan.
 *
 * Same explicit-then-live-subscriptions rule the customers list and detail already
 * serialize as `effective_currency`, sharing `deriveEffectiveCurrency` so the buyer's
 * view, the operator's view and the mandate cannot drift apart.
 */
export async function resolveCustomerCurrency(
  organizationId: string,
  customer: { id: string; currency: string | null },
): Promise<string | null> {
  if (customer.currency) return customer.currency;
  const { currencyWeight } = await getCustomerFinancials(organizationId, customer.id);
  return deriveEffectiveCurrency(null, currencyWeight);
}

/**
 * Read-only financials for a customer (CP-2): per-currency `customer_balance`
 * (what we owe them, derived from the ledger) + per-currency MRR (sum of active
 * subscriptions' cached MRR). Keyed by currency code.
 */
export async function getCustomerFinancials(
  organizationId: string,
  customerId: string,
): Promise<{
  balances: Record<string, number>;
  mrr: Record<string, number>;
  /** Per-currency weight over LIVE subscriptions, including trials with no MRR yet
   *  — feeds `deriveEffectiveCurrency` (customers/serialize.ts). */
  currencyWeight: Record<string, number>;
}> {
  return withTenant(organizationId, async (tx) => {
    // D1 balance split: the spendable balance is the sum of the three credit
    // buckets (promotional + refundable + excess), all credit-normal liabilities.
    const balRows = (await tx.execute(sql`
      select currency,
             coalesce(sum(case when direction = 'credit' then amount_minor else -amount_minor end), 0) as bal
      from ledger_entries
      where customer_id = ${customerId}
        and account in ('promotional_credit_balance', 'refundable_credit_balance', 'excess_payment_balance')
      group by currency
    `)) as unknown as Array<{ currency: string; bal: string | number }>;
    const balances: Record<string, number> = {};
    for (const r of balRows) balances[r.currency] = Number(r.bal);

    /**
     * EVERY status, not just the live ones — and the status decides what the row
     * contributes.
     *
     * `currencyWeight` exists to answer "what does this customer transact in?", and
     * filtering it to `active`/`in_trial` made that answer VANISH the moment their last
     * subscription was cancelled. Measured 2026-09-03 on `cus_XXXXXXXXXXXXXXXXXXXXXX01`
     * immediately after a cancel: the customer held ₹9,661.13 of refundable credit from
     * the cancellation's own note, `resolveCustomerCurrency` returned NULL, the dashboard
     * fell through to the business default (USD), and the tile read the USD bucket and
     * rendered **$0.00** over money we owe. The same fallback preselects USD in the
     * add-charge / manage-credits / excess-payment dialogs, minting balances the
     * customer's own invoices can never consume — the customer page's own docblock
     * describes that failure as FIXED, and it was, for as long as a live subscription
     * pinned the currency. A cancelled customer holding a refundable note is precisely
     * who needs it visible.
     *
     * A cancelled subscription therefore contributes its CURRENCY at weight 0 — the same
     * shape a trial already had ("pins the currency but has no MRR yet") — so a live
     * subscription in another currency still outranks it, and `mrr` below is untouched:
     * counting a cancelled subscription's cached MRR would corrupt a headline metric.
     * Keep this predicate identical to `getCurrencyWeightsForCustomers`, which the LIST
     * uses; the two are deliberately the same read.
     */
    const mrrRows = await tx
      .select({
        currency: subscriptions.currency,
        mrr: subscriptions.mrr,
        status: subscriptions.status,
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.customerId, customerId), notDeleted()));
    const mrr: Record<string, number> = {};
    // Tracked separately from `mrr`: a trialing subscription pins the customer's
    // currency but has no MRR yet, so it must count here while staying out of the
    // MRR map.
    const currencyWeight: Record<string, number> = {};
    for (const r of mrrRows) {
      const live = r.status === "active" || r.status === "in_trial";
      // The key must exist even at 0 — that is what makes a cancelled subscription pin
      // the currency without contributing weight.
      currencyWeight[r.currency] =
        (currencyWeight[r.currency] ?? 0) + (live ? Number(r.mrr ?? 0) : 0);
      if (!live || r.mrr == null) continue;
      mrr[r.currency] = (mrr[r.currency] ?? 0) + Number(r.mrr);
    }
    return { balances, mrr, currencyWeight };
  });
}

/**
 * `currencyWeight` for MANY customers in ONE query — the batched twin of the
 * `currencyWeight` `getCustomerFinancials` returns for a single customer.
 *
 * WHY IT EXISTS. The customers LIST serializes `effective_currency`, which is
 * DERIVED from an aggregate over that customer's live subscriptions. Reusing the
 * detail path per row would issue one aggregate per customer — an N+1 across a
 * page of up to `clampLimit()` rows. This is a single `GROUP BY (customer, currency)`
 * over the whole page's ids; the route zips the result onto the rows and feeds it to
 * the SAME `deriveEffectiveCurrency` the detail path uses, so the two cannot drift.
 *
 * The predicate is deliberately identical to `getCustomerFinancials`: only
 * `active`/`in_trial` subscriptions count, and a TRIAL contributes a key with weight
 * 0 (it pins the currency but has no MRR yet) — `coalesce(sum(mrr), 0)` on a group
 * whose rows are all-null gives exactly the `Number(r.mrr ?? 0)` accumulation there.
 *
 * Tenant-scoped like its neighbours: `withTenant` sets `app.org_id`, and RLS policy
 * `org_isolation` on `subscriptions` (migration 0009) filters to that organization —
 * so a foreign customer id in `customerIds` matches nothing. The ids themselves come
 * from an already business-scoped page.
 */
export async function getCurrencyWeightsForCustomers(
  organizationId: string,
  customerIds: string[],
): Promise<Record<string, Record<string, number>>> {
  if (customerIds.length === 0) return {};
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({
        customerId: subscriptions.customerId,
        currency: subscriptions.currency,
        // sum() over a bigint column returns numeric (a string over the wire);
        // typed as string rather than letting drizzle's bigint mapper near it.
        // Only a LIVE subscription contributes MRR; every other status contributes its
        // currency at 0. Identical arithmetic to the detail path's accumulation — see the
        // docblock there for the cancelled-customer measurement that forced it.
        weight: sql<string>`coalesce(sum(case when ${subscriptions.status} in ('active','in_trial') then ${subscriptions.mrr} end), 0)`,
      })
      .from(subscriptions)
      .where(and(inArray(subscriptions.customerId, customerIds), notDeleted()))
      .groupBy(subscriptions.customerId, subscriptions.currency);
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) (out[r.customerId] ??= {})[r.currency] = Number(r.weight);
    return out;
  });
}

/**
 * Validate a customer's VAT/tax-id via the configured `TaxIdValidator` (CUST-4;
 * noop by default) and record the resulting `vat_number_status` + timestamp.
 *
 * 0243 escape hatch: `businesses.vies_validation_enabled` (default true) lets a
 * merchant switch this off when VIES — a third-party EU service that goes down —
 * is blocking sales. OFF skips the lookup entirely (no network call) and resets
 * the status to `not_validated`, never `undetermined`.
 *
 * Those two are NOT interchangeable: `undetermined` is what `vies.ts` returns when
 * it TRIED and the member state couldn't confirm — a live verdict about the number.
 * `not_validated` is "no check was performed", which is also the truth here — and,
 * critically, it clears out a STALE `invalid`/`valid`/`undetermined` from before the
 * flag was flipped off. Leaving an old verdict in place would let a lookup that
 * hasn't run in weeks keep presenting itself as current fact.
 */
export async function validateCustomerVat(
  organizationId: string,
  businessId: string,
  customerPublicId: string,
): Promise<typeof customers.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [c] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.businessId, businessId), eq(customers.publicId, customerPublicId)))
      .limit(1);
    if (!c) return null;
    const [biz] = await tx
      .select({ viesValidationEnabled: businesses.viesValidationEnabled })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    const status =
      biz?.viesValidationEnabled === false
        ? "not_validated"
        : await getTaxIdValidator().validate({ country: c.country, vatNumber: c.vatNumber });
    const [updated] = await tx
      .update(customers)
      .set({
        vatNumberStatus: status,
        vatValidatedAt: status === "not_validated" ? null : new Date(),
      })
      .where(eq(customers.id, c.id))
      .returning();
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "customer_updated",
      data: buildEventData(
        "customer_updated",
        { id: updated!.publicId, vat_number_status: status },
        updated!.resourceVersion,
      ),
    });
    return updated!;
  });
}

/**
 * Set a customer's calendar billing anchor (CUST-5). `mode='manually_set'` uses
 * `billingDate` (1–31); `using_defaults` clears it (anchor = subscription start).
 * Consumed by subscription create when no sub-level anchor is given.
 */
export async function changeBillingDate(
  organizationId: string,
  businessId: string,
  customerPublicId: string,
  input: { billingDate?: number | null; billingDateMode: "using_defaults" | "manually_set" },
): Promise<typeof customers.$inferSelect | null> {
  if (input.billingDateMode === "manually_set") {
    if (input.billingDate == null || input.billingDate < 1 || input.billingDate > 31)
      throw new CustomerError("manually_set requires billing_date between 1 and 31");
  }
  const billingDate = input.billingDateMode === "manually_set" ? input.billingDate! : null;
  return withTenant(organizationId, async (tx) => {
    const [before] = await tx
      .select({ billingDate: customers.billingDate, billingDateMode: customers.billingDateMode })
      .from(customers)
      .where(and(eq(customers.businessId, businessId), eq(customers.publicId, customerPublicId)))
      .limit(1);
    const [updated] = await tx
      .update(customers)
      .set({ billingDate, billingDateMode: input.billingDateMode })
      .where(and(eq(customers.businessId, businessId), eq(customers.publicId, customerPublicId)))
      .returning();
    if (!updated) return null;
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "customer_updated",
      data: buildEventData(
        "customer_updated",
        {
          id: updated.publicId,
          billing_date: billingDate,
          billing_date_mode: updated.billingDateMode,
        },
        updated.resourceVersion,
      ),
    });
    // Audited separately from `customer.update` because it is its own operation with
    // its own route and its own consequence — it moves when this customer is billed.
    // Folding it into a generic update would bury that.
    await writeAuditLog(
      {
        organizationId,
        businessId,
        action: "customer.change_billing_date",
        resourceType: "customer",
        resourceId: updated.publicId,
        before: {
          billing_date: before?.billingDate ?? null,
          billing_date_mode: before?.billingDateMode ?? null,
        },
        after: { billing_date: billingDate, billing_date_mode: updated.billingDateMode },
      },
      tx,
    );
    return updated;
  });
}

/**
 * GDPR erasure (CUST-7): irreversibly scrub the customer's PII, detach +
 * gateway-delete their payment sources, and mark `pii_cleared`. Money records
 * (ledger, invoices, payments) are LEFT INTACT — only personal data is removed.
 */
export async function clearPersonalData(
  organizationId: string,
  businessId: string,
  customerPublicId: string,
): Promise<typeof customers.$inferSelect | null> {
  const cust = await getCustomerByPublicId(organizationId, businessId, customerPublicId);
  if (!cust) return null;

  // 1) Detach each vaulted instrument. `detachPaymentMethod` owns the gateway-side
  //    delete (best-effort — a gateway that can't delete must not block erasure);
  //    this loop used to duplicate that call, which silently no-op'd because no real
  //    adapter implemented `deletePaymentMethod` at the time.
  const pms = await listPaymentMethods(organizationId, cust.id);
  for (const pm of pms) {
    await detachPaymentMethod(organizationId, cust.id, pm.publicId);
  }

  // 2) Scrub PII columns; keep ledger/invoices/payments intact.
  return withTenant(organizationId, async (tx) => {
    // Additional contacts hold the same data subject's name/email/phone — scrub
    // them too (CUST-7 review fix). email is NOT NULL, so it becomes '[cleared]'.
    await tx
      .update(contacts)
      .set({ firstName: null, lastName: null, email: "[cleared]", phone: null })
      .where(eq(contacts.customerId, cust.id));
    await deleteShippingAddressesForPii(tx, cust.id);
    const [c] = await tx
      .update(customers)
      .set({
        email: null,
        name: "[cleared]",
        firstName: null,
        lastName: null,
        company: null,
        phone: null,
        addressLine1: null,
        addressLine2: null,
        addressLine3: null,
        city: null,
        state: null,
        stateCode: null,
        postalCode: null,
        country: null,
        billingFirstName: null,
        billingLastName: null,
        billingCompany: null,
        billingPhone: null,
        shippingAddress: null,
        vatNumber: null,
        vatNumberStatus: "not_validated",
        vatValidatedAt: null,
        metadata: null,
        piiCleared: "cleared",
      })
      .where(eq(customers.id, cust.id))
      .returning();

    // 3) Drop the audit SNAPSHOT bodies for this customer and their subscriptions
    //    (0149). The audit log stores full record snapshots so the Activity Log can
    //    show a change in the context of the whole record — and a customer snapshot
    //    carries exactly the name, email and address the two updates above just
    //    scrubbed. Erasure that stopped at the live row would leave that PII
    //    readable on every audit detail page.
    //
    //    Only the BODIES go. The audit ROWS are append-only by GRANT and are never
    //    touched: who did what, when, from where, and which fields moved all
    //    survive, so the erasure does not blind the audit trail — the affected
    //    diffs simply lose their surrounding context.
    let snapshotsErased = await eraseAuditSnapshotsForResource(
      organizationId,
      "customer",
      cust.publicId,
      tx,
    );
    const subs = await tx
      .select({ publicId: subscriptions.publicId })
      .from(subscriptions)
      .where(eq(subscriptions.customerId, cust.id));
    for (const s of subs) {
      snapshotsErased += await eraseAuditSnapshotsForResource(
        organizationId,
        "subscription",
        s.publicId,
        tx,
      );
    }

    // 4) The API request log rows linked to this customer: their bodies carry the same data.
    const requestLogsErased = await deleteCustomerRequestLogs(tx, organizationId, cust.publicId);

    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "customer_updated",
      data: buildEventData(
        "customer_updated",
        { id: c!.publicId, pii_cleared: "cleared" },
        c!.resourceVersion,
      ),
    });
    // Audited, and it must be: this is the one action whose whole purpose is to
    // destroy data, so the record that it happened — and how much it removed — is
    // the only thing left to reconcile against. `snapshots_erased` is counted
    // rather than assumed: "erased 0" and "erasure failed" must not look alike.
    // No snapshot of its own — capturing the record it just scrubbed would put the
    // PII straight back.
    await writeAuditLog(
      {
        organizationId,
        businessId,
        action: "customer.clear_personal_data",
        resourceType: "customer",
        resourceId: c!.publicId,
        before: { pii_cleared: cust.piiCleared },
        after: {
          pii_cleared: "cleared",
          snapshots_erased: snapshotsErased,
          request_logs_erased: requestLogsErased,
        },
      },
      tx,
    );
    // Irreversible and compliance-relevant. The audit row is the tenant's record;
    // this is the operational one — and `snapshotsErased` is counted rather than
    // assumed, so "erased 0" and "erasure failed" cannot look alike here either.
    log.info("customer personal data erased", {
      event: "customer_pii_erased",
      customer: c!.publicId,
      businessId,
      paymentMethodsDetached: pms.length,
      snapshotsErased,
      requestLogsErased,
      subscriptions: subs.length,
    });
    return c!;
  });
}
