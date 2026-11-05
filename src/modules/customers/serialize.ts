import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { customers, contacts, subscriptions } from "@db/schema";
import {
  PROMOTIONAL_CREDIT,
  REFUNDABLE_CREDIT,
  EXCESS_PAYMENT,
} from "@/modules/customers/balances-read";
import { getPaymentRoleIds } from "@/modules/payment-methods/serialize";
import { flattenForApi } from "@/modules/custom-fields/service";
import { createLogger } from "@/platform/logger";
import { holderName } from "@/modules/customers/names";
import { dunningPolicyPublicIds } from "@/modules/dunning-policies/effective";
import type { CollectedRevenue } from "@/modules/payments/revenue";

const log = createLogger("customers");

type BucketBalances = Record<string, { promotional: number; refundable: number; excess: number }>;
/**
 * Optional derived blocks for `serializeCustomer`. Every field is independently
 * optional and each gates ONLY its own output key, because the callers differ in
 * what they can afford to load: the detail/snapshot paths resolve everything for
 * one customer, while the LIST route resolves `effectiveCurrency` alone (one
 * batched aggregate for the page) and must NOT emit `balances`/`mrr` — an empty
 * `balances: []` reads as "this customer has no credit", which is a lie, not a
 * gap.
 */
type Financials = {
  /** Public id of the customer's dunning policy (null = business config). Key gates output. */
  dunningPolicy?: string | null;
  balances?: BucketBalances;
  mrr?: Record<string, number>;
  roles?: { primary: string | null; backup: string | null };
  /** See `effective_currency` on serializeCustomer. Derived, never stored. */
  effectiveCurrency?: string | null;
  /** `collectedRevenue` (payments/revenue.ts); detail GET only — a sum over every payment. */
  lifetimeRevenue?: CollectedRevenue[];
};

/**
 * The currency this customer actually transacts in: their explicit preference if
 * set, else the currency of their live subscriptions (highest MRR wins when a
 * customer somehow has several). Null when there is nothing to derive from — the
 * caller then falls back to the business default.
 *
 * Exists because `customers.currency` is NULL for most customers (we never derive
 * it on write), and consumers were falling straight through to the BUSINESS default. That showed an INR-only
 * customer their credits as `$0.00` and — worse — preselected USD in the
 * add-charge / manage-credits / wallet-top-up forms, which would mint balances in
 * a currency the customer's invoices can never consume.
 */
export function deriveEffectiveCurrency(
  explicit: string | null,
  mrrByCurrency: Record<string, number>,
): string | null {
  if (explicit) return explicit;
  const ranked = Object.entries(mrrByCurrency).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return ranked[0]?.[0] ?? null;
}

/** The canonical address keys, shared by billing and shipping. */
const ADDRESS_KEYS = [
  "line1",
  "line2",
  "line3",
  "city",
  "state",
  "state_code",
  "postal_code",
  "country",
  "first_name",
  "last_name",
  "company",
  "phone",
] as const;

/**
 * Coerce a stored `shipping_address` JSONB blob to the canonical address shape.
 *
 * The column is untyped `jsonb` and, until the route was tightened, anything could
 * land in it — in particular the importer writes the source shape verbatim
 * (`createCustomer` service path, bypassing route validation), which spells the
 * postcode **`zip`** and carries `object` / `validation_status` noise. Normalizing on
 * READ means every consumer sees one shape regardless of vintage, with no backfill.
 *
 * Returns null when there is nothing meaningful, so `shipping_address` is absent
 * rather than an object full of nulls.
 */
export function normalizeShippingAddress(raw: unknown): Record<string, string | null> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
  const out: Record<string, string | null> = {};
  for (const k of ADDRESS_KEYS) out[k] = str(src[k]);
  // Some importers call it `zip`; ours is `postal_code`.
  out.postal_code ??= str(src.zip);
  return Object.values(out).some((v) => v !== null) ? out : null;
}

/**
 * The billing address off the customer's own COLUMNS (shipping is a jsonb blob, hence
 * the separate normalizer above). Same rule as its sibling: null only when there is
 * nothing meaningful, i.e. every field is null.
 *
 * This used to be `c.addressLine1 ? {…} : null`. `line1` was a serviceable proxy for
 * "is there an address" right up until a country-only address became a real and useful
 * state — which is exactly what an API-provisioned customer has, and what India GST
 * needs, since the tax engine resolves the rate from `country` alone. The gate meant a
 * customer carrying `country: 'IN'` reported `"address": null` on every read while the
 * row had the country and the engine correctly charged 18%.
 *
 * ⚠️ The read was not the expensive half. The operator edit form prefills from THIS
 * value, so an empty object rendered an empty country select — and because
 * `applyAddress` REPLACES the whole address, saving that form posted `country: null`
 * and wiped the country, silently switching GST off for that customer. Do not
 * reintroduce a single-field gate here.
 *
 * ⚠️ And do not "fix" the write path. The write works, the tax works: only the read
 * lied. This is the inverse of the original ₹0 tax bug, which looked right and was
 * wrong; this looked wrong and was right.
 */
export function billingAddress(
  c: typeof customers.$inferSelect,
): Record<string, string | null> | null {
  const out: Record<string, string | null> = {
    line1: c.addressLine1,
    line2: c.addressLine2,
    line3: c.addressLine3,
    city: c.city,
    state: c.state,
    state_code: c.stateCode,
    postal_code: c.postalCode,
    country: c.country,
    first_name: c.billingFirstName,
    last_name: c.billingLastName,
    company: c.billingCompany,
    phone: c.billingPhone,
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

/** Per-currency `balances[]` from the three-bucket read model. */
export function serializeBalances(b: BucketBalances) {
  return Object.entries(b).map(([currency_code, v]) => ({
    currency_code,
    promotional_credits: v.promotional,
    refundable_credits: v.refundable,
    excess_payments: v.excess,
  }));
}

export function serializeCustomer(c: typeof customers.$inferSelect, extra?: Financials) {
  return {
    object: "customer",
    id: c.publicId,
    email: c.email,
    /**
     * DERIVED, read-only (deprecated 2026-08-23). `customers.name` used to be a real
     * writable column of its own; it is no longer read or written anywhere. This key
     * survives only so existing readers keep getting a flat display string, and it is
     * now `first last` → `company` → null — exactly `accountHolderName` minus the
     * email fallback, because echoing an email address in a field called `name` is how
     * a caller ends up printing one. Sending `name` to a write route is a 400.
     */
    name: holderName(c),
    first_name: c.firstName,
    last_name: c.lastName,
    company: c.company,
    phone: c.phone,
    currency: c.currency,
    /**
     * DERIVED, read-only: the currency to actually transact with — `currency` when
     * the operator set one, else the live subscriptions' currency. Present on every
     * read that resolves it (detail, snapshot AND list). Null = nothing to derive
     * from; fall back to the business default. Never write this back to `currency`.
     *
     * Gated on the KEY being present, not on `extra` being present: the list route
     * supplies this and nothing else.
     */
    ...(extra && "effectiveCurrency" in extra
      ? { effective_currency: extra.effectiveCurrency ?? null }
      : {}),
    locale: c.locale,
    auto_collection: c.autoCollection,
    net_term_days: c.netTermDays,
    // Credit policy override and overdraft limit (0464); null = the business's settings.
    credit_settings: c.creditSettings ?? null,
    invoice_notes: c.invoiceNotes,
    address: billingAddress(c),
    shipping_address: normalizeShippingAddress(c.shippingAddress),
    tax_exempt: c.taxExempt,
    email_notifications: c.emailNotifications,
    dunning_excluded: c.dunningExcluded,
    exclude_from_reporting: c.excludeFromReporting,
    // Copies of the customer's document emails (0486).
    billing_cc_emails: c.billingCcEmails ?? [],
    billing_bcc_emails: c.billingBccEmails ?? [],
    ...(extra && "dunningPolicy" in extra ? { dunning_policy: extra.dunningPolicy ?? null } : {}),
    vat_number: c.vatNumber,
    vat_number_status: c.vatNumberStatus,
    vat_validated_at: c.vatValidatedAt,
    billing_date: c.billingDate,
    billing_date_mode: c.billingDateMode,
    pii_cleared: c.piiCleared,
    withholding_rate_bps: c.withholdingRateBps,
    tax_treatment: c.taxTreatment,
    tax_behavior: c.taxBehavior ?? null,
    tax_registration_number: c.taxRegistrationNumber,
    // Marketing opt-in from checkout (0479). Null = never asked.
    marketing_opt_in: c.marketingOptIn ?? null,
    marketing_opt_in_at: c.marketingOptInAt ?? null,
    metadata: c.metadata,
    custom_fields: c.customFields ?? null,
    ...flattenForApi(c.customFields as Record<string, unknown> | null),
    active: c.active,
    ...(extra?.balances && extra.mrr
      ? { mrr: extra.mrr, balances: serializeBalances(extra.balances) }
      : {}),
    ...(extra?.lifetimeRevenue ? { lifetime_revenue: extra.lifetimeRevenue } : {}),
    ...(extra?.roles
      ? {
          primary_payment_source_id: extra.roles.primary,
          backup_payment_source_id: extra.roles.backup,
        }
      : {}),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    resource_version: c.resourceVersion,
  };
}

/**
 * Full-snapshot loader for event content (BLUEPRINT §11 Part B). Loads a
 * customer row by public id plus its balances/mrr/roles, returning the
 * serialized object, or null if not found. `tx` must be the caller's
 * RLS-scoped transaction.
 *
 * Balances/MRR are read directly against `tx` (not via `balances-read.ts`'s
 * `getCustomerBalances`/`getCustomerMrr`, which each open their own
 * `withTenant` transaction) so the snapshot reflects the in-flight write that
 * triggered this event, not a possibly-stale committed view.
 *
 * `businessId` is REQUIRED (Bugs #11): customer public ids are unique per
 * BUSINESS, not per organization, and `tx`'s RLS scope is the organization — so
 * `where public_id = $1 limit 1` alone could return another business's customer.
 */
/**
 * A customer's PUBLIC id from its internal one — the ref an event payload has to carry.
 *
 * `deriveResourceId` hands whatever it finds to `loadCustomerSnapshot`, which matches on
 * `customers.public_id`. An internal uuid put in an event payload therefore resolves to
 * nothing, silently, exactly like the missing key does. Mirrors
 * `loadPaymentMethodCustomerPublicId` in `payment-methods/serialize.ts`.
 */
export async function loadCustomerPublicId(tx: Tx, customerId: string): Promise<string | null> {
  const [row] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return row?.publicId ?? null;
}

export async function loadCustomerSnapshot(
  tx: Tx,
  cusPublicId: string,
  businessId: string,
): Promise<Record<string, unknown> | null> {
  const [c] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.publicId, cusPublicId)))
    .limit(1);
  if (!c) return null;

  const balanceRows = (await tx.execute(sql`
    select currency, account,
           coalesce(sum(case when direction = 'credit' then amount_minor else -amount_minor end), 0)::bigint as bal
    from ledger_entries
    where customer_id = ${c.id}
      and account in (${PROMOTIONAL_CREDIT}, ${REFUNDABLE_CREDIT}, ${EXCESS_PAYMENT})
    group by currency, account
  `)) as unknown as Array<{ currency: string; account: string; bal: string | number }>;
  const balances: BucketBalances = {};
  const slot = (cur: string) => (balances[cur] ??= { promotional: 0, refundable: 0, excess: 0 });
  for (const r of balanceRows) {
    const bal = Number(r.bal);
    if (bal === 0) continue;
    const s = slot(r.currency);
    if (r.account === PROMOTIONAL_CREDIT) s.promotional = Math.max(0, bal);
    else if (r.account === REFUNDABLE_CREDIT) s.refundable = Math.max(0, bal);
    else if (r.account === EXCESS_PAYMENT) s.excess = Math.max(0, bal);
  }

  const mrrRows = await tx
    .select({ currency: subscriptions.currency, mrr: subscriptions.mrr })
    .from(subscriptions)
    .where(
      sql`${subscriptions.customerId} = ${c.id} and ${subscriptions.status} in ('active','in_trial')`,
    );
  const mrr: Record<string, number> = {};
  // Currency weights are kept SEPARATE from `mrr`: a trialing subscription has no
  // MRR yet but still pins the customer's currency, so it must count here even
  // though it is (correctly) absent from the MRR map.
  const currencyWeight: Record<string, number> = {};
  for (const r of mrrRows) {
    currencyWeight[r.currency] = (currencyWeight[r.currency] ?? 0) + Number(r.mrr ?? 0);
    if (r.mrr == null) continue;
    mrr[r.currency] = (mrr[r.currency] ?? 0) + Number(r.mrr);
  }

  // Roles are read under a savepoint of this transaction — best-effort for event-snapshot
  // purposes; never throws (falls back to nulls).
  let roles: { primary: string | null; backup: string | null } = { primary: null, backup: null };
  try {
    roles = await getPaymentRoleIds(c.organizationId, c.id, tx);
  } catch (e) {
    // Still usable without roles — but say so, or a snapshot silently missing the
    // primary/backup method reads as "none set" rather than "we couldn't look".
    log.warn("payment roles unavailable for customer snapshot", {
      customer: c.publicId,
      error: (e as Error)?.message,
    });
  }

  const policyRefs = await dunningPolicyPublicIds(tx, [c.dunningPolicyId]);
  return serializeCustomer(c, {
    dunningPolicy: c.dunningPolicyId ? (policyRefs.get(c.dunningPolicyId) ?? null) : null,
    balances,
    mrr,
    roles,
    effectiveCurrency: deriveEffectiveCurrency(c.currency, currencyWeight),
  });
}

export function serializeContact(c: typeof contacts.$inferSelect) {
  return {
    object: "contact",
    id: c.publicId,
    first_name: c.firstName,
    last_name: c.lastName,
    email: c.email,
    phone: c.phone,
    label: c.label,
    enabled: c.enabled,
    send_account_email: c.sendAccountEmail,
    send_billing_email: c.sendBillingEmail,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    resource_version: c.resourceVersion,
  };
}
