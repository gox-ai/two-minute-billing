import { z } from "zod";

/**
 * Sync preferences, stored in `hubspot_connections.settings`. Every key has a default, so a row
 * written before a key existed reads as that default — `parseSettings` is the only reader.
 */

const FIELD_LIMIT = 15;

/** `to_remote` pushes ours over theirs, `to_local` pulls theirs over ours, `both` does each. */
export const fieldDirection = z.enum(["to_remote", "to_local", "both"]);

export const fieldMapping = z.object({
  /** A HubSpot property name, as discovered from the portal. */
  remote: z.string().min(1).max(200),
  /** One of `LOCAL_FIELDS[object]`, or `cf_<api_name>` for a custom field. */
  local: z.string().min(1).max(200),
  direction: fieldDirection.default("to_remote"),
});

export const matchRule = z.object({
  /** `email` | `company` | `cf_<api_name>` on the customer. */
  local: z.string().min(1).max(200),
  /** The HubSpot property compared against it. */
  remote: z.string().min(1).max(200),
});

export const SUBSCRIPTION_STATUSES = [
  "future",
  "in_trial",
  "active",
  "non_renewing",
  "paused",
  "cancelled",
] as const;

export const settingsSchema = z.object({
  customers: z
    .object({
      /** Which customers sync at all. */
      scope: z.enum(["all", "active_subscriptions"]).default("all"),
      /** Create the contact/company when no match is found; `false` links matches only. */
      createMissing: z.boolean().default(true),
      contactMatch: matchRule.default({ local: "email", remote: "email" }),
      /** Null: companies are not synced. */
      companyMatch: matchRule.nullable().default({ local: "email", remote: "domain" }),
      /** Several customers may share one company. Irreversible once on (enforced by the route). */
      multipleCustomersPerCompany: z.boolean().default(false),
      /** What a push does to a record that already existed in HubSpot. */
      onMatch: z.enum(["overwrite", "fill_empty", "link_only"]).default("fill_empty"),
      /** Write the billing address into the mapped custom fields instead of HubSpot's standard ones. */
      billingAddressViaCustomFields: z.boolean().default(false),
      contactFields: z.array(fieldMapping).max(FIELD_LIMIT).default([]),
      companyFields: z.array(fieldMapping).max(FIELD_LIMIT).default([]),
    })
    .prefault({}),
  updates: z
    .object({
      /** When a linked customer changes here. */
      localChange: z.enum(["overwrite_remote", "nothing"]).default("overwrite_remote"),
      /** When a linked contact/company changes in HubSpot. */
      remoteChange: z.enum(["overwrite_local", "nothing"]).default("overwrite_local"),
      /** Both sides changed since the last sync. */
      conflict: z.enum(["local_wins", "remote_wins", "flag"]).default("remote_wins"),
      /** Pull the billing address from HubSpot. Off by default: the billing address drives tax. */
      pullAddress: z.boolean().default(false),
      /** Pull the email from HubSpot. Off by default: invoices and payment emails go there. */
      pullEmail: z.boolean().default(false),
    })
    .prefault({}),
  deals: z
    .object({
      enabled: z.boolean().default(true),
      statuses: z
        .array(z.enum(SUBSCRIPTION_STATUSES))
        .default(["future", "in_trial", "active", "non_renewing"]),
      /** `link_or_create` finds a matching deal first; `create` always makes a new one. */
      mode: z.enum(["link_or_create", "create"]).default("link_or_create"),
      /** Deal property holding our subscription id (must be unique in the portal), if any. */
      subscriptionIdProperty: z.string().max(200).nullable().default(null),
      /** Also match the newest open deal on the linked contact. */
      matchByAssociation: z.boolean().default(true),
      onChange: z.enum(["update", "nothing"]).default("update"),
      amount: z.enum(["mrr", "arr", "next_billing_amount"]).default("mrr"),
      /** Tokens: {customer_id} {subscription_id} {customer_name} {company} {plan}. */
      nameFormat: z.string().min(1).max(200).default("{customer_id} {subscription_id}"),
      pipelineId: z.string().max(200).nullable().default(null),
      /** Subscription status → deal stage id in `pipelineId`. Unmapped statuses keep the stage. */
      stageMap: z.partialRecord(z.enum(SUBSCRIPTION_STATUSES), z.string().max(200)).default({}),
      fields: z.array(fieldMapping).max(FIELD_LIMIT).default([]),
      /** Deal → subscription: how a deal discount lands. */
      discountMode: z.enum(["price_override", "coupon", "ignore"]).default("price_override"),
      /** `dealtype` values that mean "edit the existing subscription" in a workflow action. */
      editDealTypes: z.array(z.string().max(200)).default(["existingbusiness"]),
      /** Show "Create subscription" on HubSpot records. */
      manualCreate: z.boolean().default(false),
    })
    .prefault({}),
  products: z
    .object({
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  invoices: z
    .object({
      /** Off by default: it needs a custom object, which only Enterprise portals have. */
      enabled: z.boolean().default(false),
      /** The portal's custom object that holds invoices, as its `objectTypeId` (`2-…`). */
      objectType: z
        .string()
        .regex(/^2-\d+$/)
        .nullable()
        .default(null),
    })
    .prefault({}),
});

export type HubSpotSettings = z.infer<typeof settingsSchema>;

/**
 * Internal property names the operator's invoice custom object carries. `invoice_id` (our id) is
 * required and should be unique; any other one the object lacks is left out of the push.
 */
export const INVOICE_PROPERTIES = [
  "invoice_id",
  "invoice_number",
  "invoice_status",
  "currency",
  "total",
  "amount_due",
  "amount_paid",
  "issue_date",
  "due_date",
  "invoice_url",
] as const;

/** Never throws: a row that fails validation reads as defaults (the route validates every write). */
export function parseSettings(raw: unknown): HubSpotSettings {
  const parsed = settingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

/** Deep-merge a partial update onto current settings, then validate the result. */
export function mergeSettings(current: HubSpotSettings, patch: unknown) {
  const p = (patch ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  for (const key of Object.keys(p)) {
    const v = p[key];
    merged[key] =
      v && typeof v === "object" && !Array.isArray(v)
        ? {
            ...(current as Record<string, Record<string, unknown>>)[key],
            ...(v as Record<string, unknown>),
          }
        : v;
  }
  return settingsSchema.safeParse(merged);
}

/**
 * Our fields a mapping may name, per HubSpot object. `cf_*` custom fields are added at read time.
 * A customer's `subscription_*` fields come from its current subscription (see `customerResolver`).
 */
export const LOCAL_FIELDS = {
  contacts: [
    "id",
    "email",
    "first_name",
    "last_name",
    "phone",
    "company",
    "locale",
    "preferred_currency",
    "auto_collection",
    "net_term_days",
    "vat_number",
    "billing_line1",
    "billing_city",
    "billing_state",
    "billing_zip",
    "billing_country",
    "mrr",
    "total_dues",
    "created_at",
    "subscription_id",
    "subscription_status",
    "subscription_plan_id",
    "subscription_plan_amount",
    "subscription_mrr",
    "subscription_currency",
  ],
  companies: [
    "id",
    "company",
    "email",
    "phone",
    "preferred_currency",
    "auto_collection",
    "net_term_days",
    "vat_number",
    "billing_line1",
    "billing_city",
    "billing_state",
    "billing_zip",
    "billing_country",
    "mrr",
    "total_dues",
    "subscription_id",
    "subscription_status",
    "subscription_plan_id",
    "subscription_plan_amount",
    "subscription_mrr",
    "subscription_currency",
  ],
  deals: [
    "id",
    "status",
    "plan",
    "plan_id",
    "plan_amount",
    "plan_quantity",
    "mrr",
    "arr",
    "next_billing_at",
    "next_billing_amount",
    "current_term_start",
    "current_term_end",
    "trial_end",
    "cancelled_at",
    "auto_collection",
    "billing_period",
    "currency",
    "coupon",
  ],
} as const;
