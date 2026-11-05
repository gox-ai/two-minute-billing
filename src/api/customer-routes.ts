import { listExcessPayments } from "@/modules/refunds/excess";
import { resolveBillingRulesConfig } from "@/modules/subscriptions/billing-rules-config";
import {
  customerCreditSettingsSchema,
  toCustomerCreditSettings,
} from "@/modules/credits/customer-settings";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { LIMITS, metadataField } from "./limits";
import { authenticate } from "@/platform/auth";
import { isIsoCurrency } from "@/platform/currency";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  createCustomer,
  updateCustomer,
  setCustomerActive,
  listCustomersPage,
  customerCustomFieldFilterSet,
  CUSTOMER_FILTER_OPS,
  CUSTOMER_FILTER_KINDS,
  CUSTOMER_SORT_FIELDS,
  getCustomerByPublicId,
  getCustomerFinancials,
  getCurrencyWeightsForCustomers,
  validateCustomerVat,
  changeBillingDate,
  clearPersonalData,
  CustomerError,
  type CustomerFields,
  CustomerFilterRefusedError,
} from "@/modules/customers/service";
import { collectPayment, CollectError } from "@/modules/customers/collect";
import {
  listContacts,
  createContact,
  updateContact,
  deleteContact,
  ContactError,
} from "@/modules/customers/contacts";
import {
  archiveShippingAddress,
  createShippingAddress,
  listShippingAddresses,
  restoreShippingAddress,
  serializeShippingAddress,
  ShippingAddressError,
  updateShippingAddress,
  type ShippingAddressFields,
} from "@/modules/customers/addresses";
import {
  getCustomerBalances,
  addPromotionalCredits,
  deductPromotionalCredits,
  setPromotionalCredits,
  recordExcessPayment,
  BalanceError,
} from "@/modules/customers/balances";
import {
  listPromotionalCreditMovements,
  getPromotionalCreditMovement,
  serializePromotionalCreditMovement,
  PROMO_MOVEMENT_FILTER_OPS,
  PROMO_MOVEMENT_FILTER_KINDS,
} from "@/modules/customers/promotional-credits";
import { PROMOTIONAL_CREDIT_TYPES } from "@db/schema";
import { OFFLINE_REFUND_METHODS } from "@/modules/credit-notes/service";
import { isUniqueViolation } from "@/modules/catalog/service";
import { getPaymentRoleIds } from "@/modules/payment-methods/service";
import {
  serializeCustomer,
  serializeContact,
  deriveEffectiveCurrency,
} from "@/modules/customers/serialize";
import { CustomFieldError, filterDefinitions } from "@/modules/custom-fields/service";
import { TAX_TREATMENTS } from "@/modules/tax/service";
import { addressRefinement } from "@/api/address-validation";
import {
  resolveBusiness,
  badRequest,
  notFound,
  conflict,
  parseListQuery,
  listResponse,
  VersionConflictError,
  requirePerm,
  callerHolds,
  missingPermission,
} from "./helpers";
import { permissionDef } from "@/modules/auth/permissions";
import { cfKeys, parseRequest } from "./strict-params";
import { withTenant } from "@/platform/db";
import { dunningPolicyPublicIds } from "@/modules/dunning-policies/effective";
import { DunningPolicyError, resolveDunningPolicyRef } from "@/modules/dunning-policies/service";
import { collectedRevenue } from "@/modules/payments/revenue";

// Digits, spaces and + ( ) - . — enough for any international format, no more.
// Mirrors `PHONE_RE` in dashboard/components/customers/address-fields.tsx; keep
// the two in lock-step. Empty string is allowed through (it means "no phone" on
// an optional field) — the regex only fires on a non-empty value.
const PHONE_RE = /^\+?[\d\s().-]{6,20}$/;
const phoneField = z
  .string()
  .max(50)
  .refine((v) => v === "" || PHONE_RE.test(v), {
    message: "Enter a valid phone number",
  });

// Lenient on purpose: VAT/GST formats vary wildly by country (letters, digits,
// spaces, hyphens, dots), and this is validated for REAL against the tax
// authority by validateCustomerVat — this is just a guard against pasted junk
// (URLs, emoji, control characters), not a format authority.
const vatNumberField = z
  .string()
  .max(50)
  .refine((v) => v === "" || /^[A-Za-z0-9][A-Za-z0-9 .-]{0,49}$/.test(v), {
    message: "Enter a valid VAT/GST number. Use only letters, digits, spaces and hyphens",
  });

// Every sub-field is `nullable` as well as `optional`: an update REPLACES the
// whole address (applyAddress), which already coerces both `null` and `undefined`
// to a null column, so the two mean the same thing here and rejecting one of them
// is a trap. It bit the operator "Edit billing address" drawer, which posts every
// blank input as null (nullableField) and so 400'd unless all 12 fields were
// filled. `min(1)`/`length(2)` still reject "" — null clears, empty string is a
// mistake. Keep in lock-step with portalMeBody (customer-portal-routes.ts).
const addressBody = z.object({
  line1: z.string().max(LIMITS.addressLine).min(1).nullable().optional(),
  line2: z.string().max(LIMITS.addressLine).nullable().optional(),
  line3: z.string().max(LIMITS.addressLine).nullable().optional(),
  city: z.string().max(LIMITS.city).nullable().optional(),
  state: z.string().max(LIMITS.state).nullable().optional(),
  state_code: z.string().max(LIMITS.stateCode).nullable().optional(),
  postal_code: z.string().max(LIMITS.postalCode).nullable().optional(),
  country: z.string().length(2).nullable().optional(),
  first_name: z.string().max(LIMITS.personName).nullable().optional(),
  last_name: z.string().max(LIMITS.personName).nullable().optional(),
  company: z.string().max(LIMITS.company).nullable().optional(),
  phone: phoneField.nullable().optional(),
});

/**
 * The same object with cross-field checks (country ↔ state_code ↔ postal_code ↔
 * phone). Kept separate from `addressBody` because `superRefine` returns a
 * ZodEffects, which cannot be `.extend()`ed — shipping_address extends first and
 * refines after.
 */
const validatedAddressBody = addressBody.superRefine(addressRefinement);

const customerFieldsBody = {
  email: z.string().max(LIMITS.email).email(),
  first_name: z.string().max(100),
  last_name: z.string().max(100),
  company: z.string().max(200),
  phone: phoneField,
  currency: z.string().length(3),
  locale: z.string().max(20),
  auto_collection: z.enum(["on", "off"]),
  net_term_days: z.number().int().min(0).max(365),
  invoice_notes: z.string().max(2000),
  address: validatedAddressBody,
  // Structured, not an untyped blob: this used to be `z.record(z.unknown())`, so any
  // shape at all could be written and the dashboard had nothing to build a form
  // against. `zip` is accepted as an alias for `postal_code` and folded into it
  // by `toShippingAddress`.
  shipping_address: addressBody
    .extend({ zip: z.string().max(LIMITS.postalCode).nullable().optional() })
    .superRefine(addressRefinement),
  tax_exempt: z.boolean(),
  email_notifications: z.boolean(),
  dunning_excluded: z.boolean(),
  // Internal or test account: left out of every metric and report (0482).
  exclude_from_reporting: z.boolean(),
  // Copies of the customer's document emails (invoices, receipts, credit notes; 0486).
  billing_cc_emails: z.array(z.string().max(LIMITS.email).email()).max(10),
  billing_bcc_emails: z.array(z.string().max(LIMITS.email).email()).max(10),
  // Named dunning policy (`dpol_…`); null = the business dunning config.
  dunning_policy: z.string().min(1).max(64).nullable(),
  vat_number: vatNumberField,
  withholding_rate_bps: z.number().int().min(0).max(10000),
  // Region-gated tax treatment. The enum is the full set; which values a given customer
  // may actually take depends on their region's `allowed_tax_treatments`.
  tax_treatment: z.enum(TAX_TREATMENTS),
  // 0489: null = each price decides; set = every taxed line is inclusive or exclusive.
  tax_behavior: z.enum(["inclusive", "exclusive"]).nullable(),
  tax_registration_number: z.string().max(50).nullable(),
  // Free-form key/value bag, deliberately untyped: the conventional `metadata`
  // shape — arbitrary caller-defined keys for the integrator's own bookkeeping,
  // never rendered as a dashboard form (there is no fixed set of keys to build one
  // against). Left as `record(unknown)` on purpose; do NOT tighten this into a form
  // shape — see `custom_fields` below for the admin-DEFINED equivalent instead.
  metadata: metadataField(),
  // Custom fields (SET-4). Either a nested object or top-level `cf_<name>` keys
  // — the latter are collected from the raw body in the handler.
  // Also deliberately untyped here: the real per-field shape is admin-DEFINED
  // (CustomFieldDefinition.data_type/required/enum_options, set in Settings →
  // Custom Fields) and re-checked field-by-field downstream by
  // `validateAndCoerce` (modules/custom-fields/service.ts), which knows those
  // definitions and this route does not. A fixed zod shape here could only ever
  // be wrong for someone else's definitions.
  custom_fields: metadataField(),
};

// A caller-chosen customer id: URL-safe, unique within the business.
const CUSTOMER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;

const createCustomerBody = z
  .object({
    id: z
      .string()
      .regex(CUSTOMER_ID_RE, "id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$")
      .optional(),
    email: customerFieldsBody.email.optional(),
    first_name: customerFieldsBody.first_name.optional(),
    last_name: customerFieldsBody.last_name.optional(),
    company: customerFieldsBody.company.optional(),
    phone: customerFieldsBody.phone.optional(),
    currency: customerFieldsBody.currency.optional(),
    locale: customerFieldsBody.locale.optional(),
    auto_collection: customerFieldsBody.auto_collection.optional(),
    net_term_days: customerFieldsBody.net_term_days.optional(),
    invoice_notes: customerFieldsBody.invoice_notes.optional(),
    address: customerFieldsBody.address.optional(),
    shipping_address: customerFieldsBody.shipping_address.optional(),
    tax_exempt: customerFieldsBody.tax_exempt.optional(),
    email_notifications: customerFieldsBody.email_notifications.optional(),
    dunning_excluded: customerFieldsBody.dunning_excluded.optional(),
    exclude_from_reporting: customerFieldsBody.exclude_from_reporting.optional(),
    billing_cc_emails: customerFieldsBody.billing_cc_emails.optional(),
    billing_bcc_emails: customerFieldsBody.billing_bcc_emails.optional(),
    dunning_policy: customerFieldsBody.dunning_policy.optional(),
    vat_number: customerFieldsBody.vat_number.optional(),
    withholding_rate_bps: customerFieldsBody.withholding_rate_bps.optional(),
    credit_settings: customerCreditSettingsSchema.nullable().optional(),
    tax_treatment: customerFieldsBody.tax_treatment.optional(),
    tax_behavior: customerFieldsBody.tax_behavior.optional(),
    tax_registration_number: customerFieldsBody.tax_registration_number.optional(),
    metadata: customerFieldsBody.metadata.optional(),
    custom_fields: customerFieldsBody.custom_fields.optional(),
  })
  .catchall(cfKeys); // top-level cf_<name> custom fields

const updateCustomerBody = z
  .object({
    email: customerFieldsBody.email.nullable().optional(),
    first_name: customerFieldsBody.first_name.nullable().optional(),
    last_name: customerFieldsBody.last_name.nullable().optional(),
    company: customerFieldsBody.company.nullable().optional(),
    phone: customerFieldsBody.phone.nullable().optional(),
    currency: customerFieldsBody.currency.nullable().optional(),
    locale: customerFieldsBody.locale.nullable().optional(),
    auto_collection: customerFieldsBody.auto_collection.optional(),
    net_term_days: customerFieldsBody.net_term_days.optional(),
    invoice_notes: customerFieldsBody.invoice_notes.nullable().optional(),
    address: validatedAddressBody.nullable().optional(),
    shipping_address: customerFieldsBody.shipping_address.nullable().optional(),
    tax_exempt: customerFieldsBody.tax_exempt.optional(),
    email_notifications: customerFieldsBody.email_notifications.optional(),
    dunning_excluded: customerFieldsBody.dunning_excluded.optional(),
    exclude_from_reporting: customerFieldsBody.exclude_from_reporting.optional(),
    billing_cc_emails: customerFieldsBody.billing_cc_emails.optional(),
    billing_bcc_emails: customerFieldsBody.billing_bcc_emails.optional(),
    dunning_policy: customerFieldsBody.dunning_policy.optional(),
    vat_number: customerFieldsBody.vat_number.nullable().optional(),
    withholding_rate_bps: customerFieldsBody.withholding_rate_bps.optional(),
    credit_settings: customerCreditSettingsSchema.nullable().optional(),
    tax_treatment: customerFieldsBody.tax_treatment.optional(),
    tax_behavior: customerFieldsBody.tax_behavior.optional(),
    tax_registration_number: customerFieldsBody.tax_registration_number.optional(),
    metadata: customerFieldsBody.metadata.nullable().optional(),
    custom_fields: customerFieldsBody.custom_fields.nullable().optional(),
    active: z.boolean().optional(),
    expected_version: z.number().int().nonnegative().optional(),
  })
  .catchall(cfKeys);

/**
 * Collect top-level `cf_<name>` params from the raw body and merge
 * with any nested `custom_fields` object. Returns undefined when neither is present
 * (so update leaves the column untouched).
 */
function collectCustomFields(
  rawBody: unknown,
  nested: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  const out: Record<string, unknown> = {};
  if (rawBody && typeof rawBody === "object") {
    for (const [k, v] of Object.entries(rawBody as Record<string, unknown>)) {
      if (k.startsWith("cf_")) out[k] = v;
    }
  }
  if (nested && typeof nested === "object") Object.assign(out, nested);
  if (nested === null && Object.keys(out).length === 0) return null; // explicit clear
  return Object.keys(out).length ? out : undefined;
}

/**
 * Shipping address → the canonical stored shape. Folds the `zip` alias into
 * `postal_code` and drops everything empty, so a form that posts all-blank inputs
 * stores null (no address) instead of an object of nulls.
 */
function toShippingAddress(
  a: z.infer<typeof customerFieldsBody.shipping_address> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (a === undefined) return undefined;
  if (a === null) return null;
  const { zip, ...rest } = a;
  const merged: Record<string, unknown> = { ...rest, postal_code: rest.postal_code ?? zip ?? null };
  for (const [k, v] of Object.entries(merged)) {
    if (v === "" || v === undefined) merged[k] = null;
  }
  return Object.values(merged).some((v) => v !== null) ? merged : null;
}

/** Map the wire address body to the service address shape. */
function toAddress(a: z.infer<typeof addressBody> | null | undefined) {
  if (a === undefined) return undefined;
  if (a === null) return null;
  return {
    line1: a.line1,
    line2: a.line2,
    line3: a.line3,
    city: a.city,
    state: a.state,
    stateCode: a.state_code,
    postalCode: a.postal_code,
    country: a.country,
    firstName: a.first_name,
    lastName: a.last_name,
    company: a.company,
    phone: a.phone,
  };
}

/**
 * `name` was our own flat display column — last in every precedence chain, collected by
 * no form, and (measured 2026-08-23) populated in this codebase almost exclusively by seed
 * scripts. It is deprecated: a customer is named by `first_name`/`last_name`/`company`.
 *
 * Writes are REJECTED rather than ignored. Both bodies accept extra `cf_*` keys — the
 * `cf_<name>` custom-field params are read off the raw body — so simply deleting the
 * key from the schema would accept the request and drop the value on the floor, which
 * is how an integrator ends up with nameless customers and no error to explain them.
 * `GET` still returns a derived `name`, so read paths are unaffected.
 */
function rejectDeprecatedName(reply: FastifyReply, body: unknown): boolean {
  if (body && typeof body === "object" && "name" in body) {
    badRequest(
      reply,
      "`name` is no longer accepted on a customer: use `first_name`, `last_name` and/or `company`. " +
        "The `name` field is still returned on reads, derived from those.",
    );
    return true;
  }
  return false;
}

/** Map a parsed create/update body to the service CustomerFields shape. */
function toFields(
  d: z.infer<typeof createCustomerBody> | z.infer<typeof updateCustomerBody>,
): CustomerFields {
  return {
    email: d.email,
    firstName: d.first_name,
    lastName: d.last_name,
    company: d.company,
    phone: d.phone,
    currency: d.currency,
    locale: d.locale,
    autoCollection: d.auto_collection,
    netTermDays: d.net_term_days,
    invoiceNotes: d.invoice_notes,
    address: toAddress(d.address),
    shippingAddress: toShippingAddress(d.shipping_address),
    taxExempt: d.tax_exempt,
    emailNotifications: d.email_notifications,
    dunningExcluded: d.dunning_excluded,
    excludeFromReporting: d.exclude_from_reporting,
    billingCcEmails: d.billing_cc_emails,
    billingBccEmails: d.billing_bcc_emails,
    vatNumber: d.vat_number,
    withholdingRateBps: d.withholding_rate_bps,
    ...(d.credit_settings !== undefined
      ? { creditSettings: toCustomerCreditSettings(d.credit_settings) }
      : {}),
    taxTreatment: d.tax_treatment,
    taxBehavior: d.tax_behavior,
    taxRegistrationNumber: d.tax_registration_number,
    metadata: d.metadata,
  };
}

const contactBody = z.object({
  first_name: z.string().max(100).nullable().optional(),
  last_name: z.string().max(100).nullable().optional(),
  email: z.string().max(LIMITS.email).email(),
  phone: phoneField.nullable().optional(),
  label: z.string().max(100).nullable().optional(),
  enabled: z.boolean().optional(),
  send_account_email: z.boolean().optional(),
  send_billing_email: z.boolean().optional(),
});

/** The `dunning_policy` ref for one customer read. */
async function dunningPolicyExtra(
  organizationId: string,
  c: { dunningPolicyId: string | null },
): Promise<{ dunningPolicy: string | null }> {
  if (!c.dunningPolicyId) return { dunningPolicy: null };
  const refs = await withTenant(organizationId, (tx) =>
    dunningPolicyPublicIds(tx, [c.dunningPolicyId]),
  );
  return { dunningPolicy: refs.get(c.dunningPolicyId) ?? null };
}

/** A book entry: the shipping address fields plus a label and the default flag. */
const shippingAddressBody = addressBody
  .extend({
    label: z.string().max(100).nullable().optional(),
    is_default: z.boolean().optional(),
  })
  .superRefine(addressRefinement);

function toShippingAddressFields(
  d: Partial<z.infer<typeof shippingAddressBody>>,
): ShippingAddressFields {
  return {
    label: d.label,
    firstName: d.first_name,
    lastName: d.last_name,
    company: d.company,
    phone: d.phone,
    line1: d.line1,
    line2: d.line2,
    line3: d.line3,
    city: d.city,
    state: d.state,
    stateCode: d.state_code,
    postalCode: d.postal_code,
    country: d.country,
  };
}

export async function registerCustomerRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/customers",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      if (rejectDeprecatedName(reply, req.body)) return;
      const parsed = parseRequest(createCustomerBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      // Credit settings belong to `credits:manage` (design G3 §7), not only `customers:manage`.
      if (parsed.data.credit_settings !== undefined && !callerHolds(req, "credits:manage"))
        return missingPermission(reply, permissionDef("credits:manage")!, !!req.hasOperator);
      const chosenId = parsed.data.id;
      if (chosenId && (await getCustomerByPublicId(req.organization!.id, business.id, chosenId)))
        return conflict(reply, `A customer with id ${chosenId} already exists`);
      try {
        const dunningPolicyId = await resolveDunningPolicyRef(
          req.organization!.id,
          business.id,
          parsed.data.dunning_policy,
        );
        const fields = toFields(parsed.data);
        const c = await createCustomer({
          organizationId: req.organization!.id,
          businessId: business.id,
          ...fields,
          // Omitted → the business's default for new customers (billing_rules_config).
          autoCollection:
            fields.autoCollection ?? resolveBillingRulesConfig(business).newCustomerAutoCollection,
          dunningPolicyId,
          customFields: collectCustomFields(req.body, parsed.data.custom_fields),
          ...(chosenId ? { publicId: chosenId } : {}),
        });
        return reply
          .code(201)
          .send(serializeCustomer(c, await dunningPolicyExtra(req.organization!.id, c)));
      } catch (e) {
        if (e instanceof CustomFieldError) return badRequest(reply, e.message);
        if (e instanceof DunningPolicyError) return badRequest(reply, e.message);
        // Lost a race to the same id.
        if (chosenId && isUniqueViolation(e))
          return conflict(reply, `A customer with id ${chosenId} already exists`);
        throw e;
      }
    },
  );

  /**
   * List customers — paginated, filtered and sorted **server-side** (§3.4 of
   * docs/GUIDE.md is the shared contract):
   *
   *   ?limit=50&starting_after=<opaque cursor from next_cursor>
   *   ?q=<free text over id/email/name/company/phone>
   *   ?sort_by[desc]=created_at   (also sort_by[asc]=id|updated_at|name|email|company)
   *   ?email[is]=  ?company[contains]=  ?created_at[in_last]=7
   *   ?auto_collection[is]=off  ?tax_exempt[is]=true  ?net_term_days[gt]=0
   *   ?address_city[is]=  ?address_state_code[in]=TN,KA  ?locale[starts_with]=en
   *   ?subscription_status[not_in]=active,in_trial   (virtual, EXISTS-backed)
   *   ?payment_method_type[is_present]=false  ?has_unpaid_invoices[is]=true
   *   ?cf_plan_tier[is]=gold  ?cf_seats[gt]=10   (the business's own custom fields)
   *   ?include_archived=true
   *
   * `CUSTOMER_FILTER_OPS`/`CUSTOMER_FILTER_KINDS` (modules/customers/service.ts) are the
   * complete list of ~40 filterable fields and their operators — the route does not
   * restate them, so the two can't drift. The business's `cf_<api_name>` fields are
   * merged over them per request, since they are admin-defined at runtime.
   */
  app.get(
    "/v1/businesses/:biz/customers",
    { preHandler: [authenticate, requirePerm("customers:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      // ONE definitions read per request. The ops/kinds are needed HERE, before parsing
      // can accept a `cf_*` filter; the SQL specs are needed inside the list query. So the
      // rows travel down to the service rather than being read again there — two reads
      // could disagree if a definition were created between them.
      const customFieldDefs = await filterDefinitions(
        req.organization!.id,
        business.id,
        "customer",
      );
      const cf = customerCustomFieldFilterSet(customFieldDefs);
      const q = parseListQuery(req, reply, {
        includeDeleted: "honoured",
        // Merged over the static maps, never replacing them: those are also what saved
        // views validate against (modules/list-views/entities.ts).
        filterOps: { ...CUSTOMER_FILTER_OPS, ...cf.ops },
        // Without the kinds a malformed value (`billing_date[between]=5`, a `31/08/2026`
        // date) reaches Postgres and surfaces as a 500 rather than a 400 naming the shape.
        filterKinds: { ...CUSTOMER_FILTER_KINDS, ...cf.kinds },
        sortFields: CUSTOMER_SORT_FIELDS,
        bareParams: ["include_archived"],
      });
      if (!q) return;
      let page: Awaited<ReturnType<typeof listCustomersPage>>;
      try {
        page = await listCustomersPage(req.organization!.id, business.id, {
          ...q,
          // A deleted customer IS an archived one (DELETE archives), so both flags widen alike.
          includeArchived:
            (req.query as { include_archived?: string }).include_archived === "true" ||
            q.includeDeleted,
          customFieldDefs,
        });
      } catch (e) {
        // An `mrr` filter this book cannot convert — named, never answered at par.
        if (e instanceof CustomerFilterRefusedError) return badRequest(reply, e.message);
        throw e;
      }
      // `effective_currency` is derived from an aggregate over each customer's live
      // subscriptions, so the detail path's per-customer resolve would be an N+1 here.
      // ONE grouped aggregate for the whole page, zipped on below — the page costs a
      // constant +1 query no matter how many rows it holds. Balances/MRR stay OFF the
      // list: they'd need a second aggregate and nothing on the list renders them.
      const weights = await getCurrencyWeightsForCustomers(
        req.organization!.id,
        page.data.map((c) => c.id),
      );
      const policyRefs = await withTenant(req.organization!.id, (tx) =>
        dunningPolicyPublicIds(
          tx,
          page.data.map((c) => c.dunningPolicyId),
        ),
      );
      return listResponse(page, (c) =>
        serializeCustomer(c, {
          effectiveCurrency: deriveEffectiveCurrency(c.currency, weights[c.id] ?? {}),
          dunningPolicy: c.dunningPolicyId ? (policyRefs.get(c.dunningPolicyId) ?? null) : null,
        }),
      );
    },
  );

  app.get(
    "/v1/businesses/:biz/customers/:cus",
    { preHandler: [authenticate, requirePerm("customers:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const c = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!c) return notFound(reply, `No such customer: ${cusId}`);
      const [financials, balances, roles, lifetimeRevenue] = await Promise.all([
        getCustomerFinancials(req.organization!.id, c.id),
        getCustomerBalances(req.organization!.id, c.id),
        getPaymentRoleIds(req.organization!.id, c.id),
        collectedRevenue(req.organization!.id, { customerId: c.id }),
      ]);
      return serializeCustomer(c, {
        ...(await dunningPolicyExtra(req.organization!.id, c)),
        balances,
        mrr: financials.mrr,
        roles,
        lifetimeRevenue,
        effectiveCurrency: deriveEffectiveCurrency(c.currency, financials.currencyWeight),
      });
    },
  );

  /** Payments still holding part of this customer's excess credit — what can be refunded. */
  app.get(
    "/v1/businesses/:biz/customers/:cus/excess_payments",
    { preHandler: [authenticate, requirePerm("credits:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const c = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!c) return notFound(reply, `No such customer: ${cusId}`);
      const rows = await listExcessPayments(req.organization!.id, business.id, c.id);
      return {
        object: "list",
        data: rows.map((r) => ({
          object: "excess_payment",
          payment: r.paymentPublicId,
          invoice: r.invoicePublicId,
          currency: r.currency,
          payment_amount_minor: Number(r.paymentAmountMinor),
          held_minor: Number(r.heldMinor),
          refundable_minor: Number(r.refundableMinor),
          gateway: r.gateway,
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  );

  // Edit a customer and/or archive-restore (active). Optimistic concurrency via expected_version.
  app.patch(
    "/v1/businesses/:biz/customers/:cus",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      if (rejectDeprecatedName(reply, req.body)) return;
      const parsed = parseRequest(updateCustomerBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      // Credit settings belong to `credits:manage` (design G3 §7), not only `customers:manage`.
      if (parsed.data.credit_settings !== undefined && !callerHolds(req, "credits:manage"))
        return missingPermission(reply, permissionDef("credits:manage")!, !!req.hasOperator);
      const cusId = (req.params as { cus: string }).cus;
      const orgId = req.organization!.id;
      try {
        const dunningPolicyId = await resolveDunningPolicyRef(
          orgId,
          business.id,
          parsed.data.dunning_policy,
        );
        let c = await updateCustomer({
          organizationId: orgId,
          businessId: business.id,
          customerPublicId: cusId,
          expectedVersion: parsed.data.expected_version,
          ...toFields(parsed.data),
          dunningPolicyId,
          customFields: collectCustomFields(req.body, parsed.data.custom_fields),
        });
        if (!c) return notFound(reply, `No such customer: ${cusId}`);
        if (parsed.data.active !== undefined) {
          c = (await setCustomerActive(orgId, business.id, cusId, parsed.data.active)) ?? c;
        }
        return serializeCustomer(c, await dunningPolicyExtra(orgId, c));
      } catch (e) {
        if (e instanceof VersionConflictError) return conflict(reply, e.message);
        if (e instanceof CustomFieldError) return badRequest(reply, e.message);
        if (e instanceof DunningPolicyError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Archive a customer (soft — active=false; existing subscriptions keep working).
  app.delete(
    "/v1/businesses/:biz/customers/:cus",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const c = await setCustomerActive(req.organization!.id, business.id, cusId, false);
      if (!c) return notFound(reply, `No such customer: ${cusId}`);
      return serializeCustomer(c);
    },
  );

  // ── Balances (D1 / CUST-2): promotional credits + excess payments ──────────
  const promoCreditBody = z.object({
    action: z.enum(["add", "deduct", "set"]),
    amount_minor: z.number().int().min(0),
    currency: z.string().length(3).refine(isIsoCurrency, "currency must be an ISO 4217 code"),
    description: z.string().max(500).optional(),
    credit_type: z.enum(PROMOTIONAL_CREDIT_TYPES).optional(),
    reference: z.string().max(500).optional(),
  });

  app.post(
    "/v1/businesses/:biz/customers/:cus/promotional_credits",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      const parsed = parseRequest(promoCreditBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { action, amount_minor, currency, description, credit_type, reference } = parsed.data;
      try {
        const args = {
          organizationId: req.organization!.id,
          businessId: business.id,
          customer: cust,
          amountMinor: amount_minor,
          currency,
          description,
          creditType: credit_type,
          reference,
        };
        const r =
          action === "add"
            ? await addPromotionalCredits(args)
            : action === "deduct"
              ? await deductPromotionalCredits(args)
              : await setPromotionalCredits(args);
        return reply.code(200).send({
          object: "promotional_credit",
          customer: cust.publicId,
          currency: currency.toUpperCase(),
          balance_minor: Number(r.balance),
          // Only when annotated, so an unannotated call answers exactly as before.
          ...(credit_type !== undefined || reference !== undefined
            ? {
                movement: r.movementId,
                credit_type: credit_type ?? "general",
                reference: reference ?? null,
              }
            : {}),
        });
      } catch (e) {
        if (e instanceof BalanceError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /** Movement history of the promotional-credit balance (ledger-derived), newest first. */
  app.get(
    "/v1/businesses/:biz/customers/:cus/promotional_credits",
    { preHandler: [authenticate, requirePerm("credits:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      const q = parseListQuery(req, reply, {
        filterOps: PROMO_MOVEMENT_FILTER_OPS,
        filterKinds: PROMO_MOVEMENT_FILTER_KINDS,
        sortFields: [],
      });
      if (!q) return;
      const page = await listPromotionalCreditMovements(
        req.organization!.id,
        business.id,
        cust.id,
        {
          limit: q.limit,
          startingAfter: q.startingAfter,
          filters: q.filters,
        },
      );
      return listResponse(page, (m) => serializePromotionalCreditMovement(cust.publicId, m));
    },
  );

  app.get(
    "/v1/businesses/:biz/customers/:cus/promotional_credits/:id",
    { preHandler: [authenticate, requirePerm("credits:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus, id } = req.params as { cus: string; id: string };
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!cust) return notFound(reply, `No such customer: ${cus}`);
      const m = await getPromotionalCreditMovement(req.organization!.id, business.id, cust.id, id);
      if (!m) return notFound(reply, `No such promotional credit movement: ${id}`);
      return serializePromotionalCreditMovement(cust.publicId, m);
    },
  );

  app.post(
    "/v1/businesses/:biz/customers/:cus/record_excess_payment",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      const parsed = parseRequest(
        z.object({
          amount_minor: z.number().int().positive(),
          currency: z.string().length(3),
          description: z.string().max(500).optional(),
          // How the money arrived. Any of the three also records an offline transaction.
          date: z.string().datetime({ offset: true }).optional(),
          method: z.enum(OFFLINE_REFUND_METHODS).optional(),
          reference: z.string().max(100).optional(),
        }),
        req.body,
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { date, method, reference } = parsed.data;
      const t = date !== undefined || method !== undefined || reference !== undefined;
      try {
        const r = await recordExcessPayment({
          organizationId: req.organization!.id,
          businessId: business.id,
          customer: cust,
          amountMinor: parsed.data.amount_minor,
          currency: parsed.data.currency,
          description: parsed.data.description,
          transaction: t
            ? {
                date: date ? new Date(date) : undefined,
                paymentMethod: method ?? "other",
                referenceNumber: reference,
              }
            : undefined,
        });
        return reply.code(200).send({
          object: "excess_payment",
          customer: cust.publicId,
          currency: parsed.data.currency.toUpperCase(),
          balance_minor: Number(r.balance),
          ...(t ? { transaction: r.transactionPublicId } : {}),
        });
      } catch (e) {
        if (e instanceof BalanceError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // ── Ad-hoc collect (D3) ────────────────────────────────────────────────────
  app.post(
    "/v1/businesses/:biz/customers/:cus/collect_payment",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      const parsed = parseRequest(
        z.object({
          amount_minor: z.number().int().positive().optional(),
          currency: z.string().length(3).optional(),
          invoice_ids: z.array(z.string().min(1)).optional(),
          payment_method_id: z.string().max(LIMITS.id).min(1).optional(),
          invoice_allocations: z
            .array(
              z.object({
                invoice_id: z.string().min(1).max(LIMITS.id),
                allocation_amount: z.number().int().positive().optional(),
              }),
            )
            .min(1)
            .optional(),
        }),
        req.body ?? {},
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      // A money budget is currency-scoped (can't span currencies).
      if (parsed.data.amount_minor != null && !parsed.data.currency)
        return badRequest(reply, "currency is required when amount_minor is set");
      try {
        const r = await collectPayment({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerPublicId: cusId,
          amountMinor: parsed.data.amount_minor,
          currency: parsed.data.currency,
          invoiceIds: parsed.data.invoice_ids,
          paymentMethodId: parsed.data.payment_method_id,
          invoiceAllocations: parsed.data.invoice_allocations?.map((a) => ({
            invoiceId: a.invoice_id,
            amountMinor: a.allocation_amount,
          })),
        });
        if (!r) return notFound(reply, `No such customer: ${cusId}`);
        return reply.code(200).send({ object: "collect_payment", ...r });
      } catch (e) {
        if (e instanceof CollectError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // ── VAT validation (D4) ─────────────────────────────────────────────────────
  app.post(
    "/v1/businesses/:biz/customers/:cus/validate_vat",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const c = await validateCustomerVat(req.organization!.id, business.id, cusId);
      if (!c) return notFound(reply, `No such customer: ${cusId}`);
      return {
        object: "customer",
        id: c.publicId,
        vat_number: c.vatNumber,
        vat_number_status: c.vatNumberStatus,
        vat_validated_at: c.vatValidatedAt,
      };
    },
  );

  // ── Calendar billing anchor (D5) ──────────────────────────────────────────────
  app.post(
    "/v1/businesses/:biz/customers/:cus/change_billing_date",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const parsed = parseRequest(
        z.object({
          billing_date: z.number().int().min(1).max(31).nullable().optional(),
          billing_date_mode: z.enum(["using_defaults", "manually_set"]),
        }),
        req.body,
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const c = await changeBillingDate(req.organization!.id, business.id, cusId, {
          billingDate: parsed.data.billing_date,
          billingDateMode: parsed.data.billing_date_mode,
        });
        if (!c) return notFound(reply, `No such customer: ${cusId}`);
        return {
          object: "customer",
          id: c.publicId,
          billing_date: c.billingDate,
          billing_date_mode: c.billingDateMode,
        };
      } catch (e) {
        if (e instanceof CustomerError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // ── GDPR clear personal data (D6) ─────────────────────────────────────────────
  app.post(
    "/v1/businesses/:biz/customers/:cus/clear_personal_data",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const c = await clearPersonalData(req.organization!.id, business.id, cusId);
      if (!c) return notFound(reply, `No such customer: ${cusId}`);
      return { object: "customer", id: c.publicId, pii_cleared: c.piiCleared };
    },
  );

  // ── Additional Contacts (CP-3) ────────────────────────────────────────────
  app.get(
    "/v1/businesses/:biz/customers/:cus/contacts",
    { preHandler: [authenticate, requirePerm("customers:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      const rows = await listContacts(req.organization!.id, cust.id);
      return { object: "list", data: rows.map(serializeContact) };
    },
  );

  app.post(
    "/v1/businesses/:biz/customers/:cus/contacts",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      const parsed = parseRequest(contactBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      try {
        const c = await createContact({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: cust.id,
          firstName: d.first_name,
          lastName: d.last_name,
          email: d.email,
          phone: d.phone,
          label: d.label,
          enabled: d.enabled,
          sendAccountEmail: d.send_account_email,
          sendBillingEmail: d.send_billing_email,
        });
        return reply.code(201).send(serializeContact(c));
      } catch (e) {
        if (e instanceof ContactError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.patch(
    "/v1/businesses/:biz/customers/:cus/contacts/:con",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      const conId = (req.params as { con: string }).con;
      const parsed = parseRequest(contactBody.partial(), req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      try {
        const c = await updateContact({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: cust.id,
          contactPublicId: conId,
          firstName: d.first_name,
          lastName: d.last_name,
          email: d.email,
          phone: d.phone,
          label: d.label,
          enabled: d.enabled,
          sendAccountEmail: d.send_account_email,
          sendBillingEmail: d.send_billing_email,
        });
        if (!c) return notFound(reply, `No such contact: ${conId}`);
        return serializeContact(c);
      } catch (e) {
        if (e instanceof ContactError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/customers/:cus/contacts/:con",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      const conId = (req.params as { con: string }).con;
      const ok = await deleteContact(req.organization!.id, business.id, cust.id, conId);
      if (!ok) return notFound(reply, `No such contact: ${conId}`);
      return reply.code(200).send({ object: "contact", id: conId, deleted: true });
    },
  );

  // ── Shipping address book (0360) ──────────────────────────────────────────
  app.get(
    "/v1/businesses/:biz/customers/:cus/shipping_addresses",
    { preHandler: [authenticate, requirePerm("customers:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      const q = req.query as { include_archived?: string };
      const rows = await listShippingAddresses(req.organization!.id, cust.id, {
        includeArchived: q.include_archived === "true",
      });
      return {
        object: "list",
        data: rows.map((r) => serializeShippingAddress(r, cust.publicId)),
      };
    },
  );

  app.post(
    "/v1/businesses/:biz/customers/:cus/shipping_addresses",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      const parsed = parseRequest(shippingAddressBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await createShippingAddress({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: cust.id,
          fields: toShippingAddressFields(parsed.data),
          makeDefault: parsed.data.is_default,
        });
        return reply.code(201).send(serializeShippingAddress(row, cust.publicId));
      } catch (e) {
        if (e instanceof ShippingAddressError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.patch(
    "/v1/businesses/:biz/customers/:cus/shipping_addresses/:addr",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus: cusId, addr: addrId } = req.params as { cus: string; addr: string };
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      const parsed = parseRequest(shippingAddressBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await updateShippingAddress({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: cust.id,
          addressPublicId: addrId,
          fields: toShippingAddressFields(parsed.data),
          isDefault: parsed.data.is_default,
        });
        if (!row) return notFound(reply, `No such shipping address: ${addrId}`);
        return serializeShippingAddress(row, cust.publicId);
      } catch (e) {
        if (e instanceof ShippingAddressError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/customers/:cus/shipping_addresses/:addr/archive",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus: cusId, addr: addrId } = req.params as { cus: string; addr: string };
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      try {
        const row = await archiveShippingAddress({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: cust.id,
          addressPublicId: addrId,
        });
        if (!row) return notFound(reply, `No such shipping address: ${addrId}`);
        return serializeShippingAddress(row, cust.publicId);
      } catch (e) {
        if (e instanceof ShippingAddressError)
          return reply
            .code(e.status)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        throw e;
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/customers/:cus/shipping_addresses/:addr/restore",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus: cusId, addr: addrId } = req.params as { cus: string; addr: string };
      const cust = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!cust) return notFound(reply, `No such customer: ${cusId}`);
      try {
        const row = await restoreShippingAddress({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: cust.id,
          addressPublicId: addrId,
        });
        if (!row) return notFound(reply, `No such shipping address: ${addrId}`);
        return serializeShippingAddress(row, cust.publicId);
      } catch (e) {
        if (e instanceof ShippingAddressError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );
}
