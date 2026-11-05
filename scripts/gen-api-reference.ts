/**
 * Generate the published API reference: one MDC page per endpoint, under
 * `docs-site/content/help/40.developers/50.api-reference/`, plus
 * `docs-site/data/api-stats.json` — the one place the site reads its endpoint counts from.
 *
 * The OpenAPI document (`sdk/openapi.json`) is the authority on the API surface —
 * the same file the typed SDK is generated from. Nothing here invents a field or
 * renames one. Example VALUES are synthesized from each schema (by property name,
 * format and id prefix) because the spec carries almost none; every key in an
 * example is a key the spec declares.
 *
 * Each endpoint renders through `::api-operation` (docs-site/app/components/content/api/):
 * prose and parameter tables in the `#docs` slot, the curl request and the JSON
 * responses in `#request` / `#response`, which the component pins in a right pane.
 *
 * WHY generated markdown rather than a component reading the spec at render time:
 * Docus builds navigation, search and the sidebar from the content tree, so an
 * endpoint that is not a file is an endpoint the reader cannot search for or link to.
 *
 * The output directory is REPLACED on every run. Nothing in it may be hand-edited
 * — including through Studio, which is why every file carries its own warning.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SPEC_PATH = join(root, "sdk", "openapi.json");
export const OUT_DIR = join(
  root,
  "docs-site",
  "content",
  "help",
  "40.developers",
  "50.api-reference",
);
export const STATS_PATH = join(root, "docs-site", "data", "api-stats.json");
const WEBHOOKS_DATA = join(root, "docs-site", "data", "webhooks.json");

// ── The spec, narrowed to what a reference page needs ─────────────────────────

export type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  required?: string[];
  items?: JsonSchema;
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  example?: unknown;
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  minimum?: number;
  maximum?: number;
  /** Set by `deref`: the component a `$ref` pointed at. */
  "x-name"?: string;
};

export type Parameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
};

type MediaType = { schema?: JsonSchema };
type RawResponse = { description?: string; content?: Record<string, MediaType> };

export type RawOperation = {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, MediaType> };
  responses?: Record<string, RawResponse>;
  security?: unknown[];
  deprecated?: boolean;
};

export type Spec = {
  info: { title: string; version: string; description?: string };
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, RawOperation>>;
  components?: { schemas?: Record<string, JsonSchema> };
};

export const METHODS = ["get", "post", "put", "patch", "delete"] as const;
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

let spec: Spec;
export function loadSpec(): Spec {
  spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as Spec;
  return spec;
}

// ── Internal codes ────────────────────────────────────────────────────────────

/**
 * Internal tracking that must never reach a reader: work-item ids "(SUB-9)", audit
 * ids "audit H1.3", migration numbers "(0193)" / "pre-0321" / "in 0321", and links
 * into the private engineering docs "(docs/GUIDE.md §3.4)". The spec is cleaned at
 * its source; this is the safety net at emit time, and verify:api-docs greps the
 * output with the same pattern.
 */
export const INTERNAL_CODE =
  /\s*\((?:audit [A-Z]\d+(?:\.\d+)*|(?!UTC|GMT|ISO)[A-Z]{2,5}-\d{1,3}[a-z]?(?:[,/] ?[A-Z]{2,5}-\d{1,3}[a-z]?)*|(?:migration )?0\d{3}|docs\/[\w./-]+(?: §[\d.]+)?)\)|\s*\baudit [A-Z]\d+(?:\.\d+)+|\bpre-0\d{3}\b|\s+in 0\d{3}\b|\s*\bmigration 0\d{3}\b/g;

export function stripInternal(text: string | undefined): string {
  return (text ?? "").replace(INTERNAL_CODE, (m) => (m.trim().startsWith("pre-") ? "earlier" : ""));
}

// ── Schema helpers ────────────────────────────────────────────────────────────

export function deref(schema: JsonSchema | undefined, depth = 0): JsonSchema | undefined {
  if (!schema || depth > 12) return schema;
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    const target = spec.components?.schemas?.[name];
    if (!target) return { type: "object" };
    const { $ref: _drop, ...rest } = schema;
    return { ...deref(target, depth + 1), "x-name": name, ...rest };
  }
  // `allOf` here is only ever an intersection of object schemas; flatten it so the
  // table shows fields rather than the word "allOf".
  if (schema.allOf?.length) {
    const merged: JsonSchema = { type: "object", properties: {}, required: [] };
    for (const part of schema.allOf) {
      const r = deref(part, depth + 1);
      Object.assign(merged.properties!, r?.properties ?? {});
      merged.required!.push(...(r?.required ?? []));
      merged["x-name"] ??= r?.["x-name"];
    }
    const { allOf: _drop, ...rest } = schema;
    return { ...merged, ...rest, properties: merged.properties, required: merged.required };
  }
  return schema;
}

/** The first non-null branch of a union: what an example should show. */
function primary(schema: JsonSchema | undefined): JsonSchema | undefined {
  const s = deref(schema);
  const branches = s?.oneOf ?? s?.anyOf;
  if (!branches?.length) return s;
  const pick = branches.find((b) => deref(b)?.type !== "null") ?? branches[0];
  return { ...deref(pick), description: s?.description ?? deref(pick)?.description };
}

function baseType(s: JsonSchema): string | undefined {
  if (Array.isArray(s.type)) return s.type.find((t) => t !== "null");
  return s.type ?? (s.properties ? "object" : undefined);
}

function typeLabel(schema: JsonSchema | undefined): string {
  const s = deref(schema);
  if (!s) return "any";
  if (s.oneOf?.length || s.anyOf?.length) {
    return [...new Set((s.oneOf ?? s.anyOf ?? []).map((p) => typeLabel(p)))].join(" | ");
  }
  const base = Array.isArray(s.type)
    ? s.type.join(" | ")
    : (s.type ?? (s.properties ? "object" : "any"));
  if (base === "array") return `array of ${typeLabel(s.items)}`;
  if (s.format === "date-time") return "string · ISO-8601";
  return base;
}

// ── Example values ────────────────────────────────────────────────────────────

/** Catalogue ids are slugs the merchant chooses, never prefixed ids. */
const CATALOGUE_SLUG: Record<string, string> = {
  prod: "pro",
  price: "pro-monthly-usd",
  cpn: "welcome-10",
  pgrp: "default",
  cpset: "launch-codes",
};

/** Prose placeholder `prod_…` for a catalogue id → its slug shape, e.g. `pro`. */
function slugPlaceholders(text: string): string {
  return text.replace(
    /`?\b(prod|price|cpn|pgrp|cpset)_…`?/g,
    (_m, p: string) => `\`${CATALOGUE_SLUG[p]}\``,
  );
}

/** Same-shape fake id: never a real record. */
const fakeId = (prefix: string) => CATALOGUE_SLUG[prefix] ?? `${prefix}_XXXXXXXXXXXX01`;

/** A placeholder id in spec prose or examples: `cus_…`, `seg_…`. */
const ID_HINT = /\b([a-z][a-z0-9]{1,7})_(?:…|\.\.\.)/;

/** Collection segment or field name → public id prefix (src/platform/ids.ts callers). */
const ID_PREFIX: Record<string, string> = {
  business: "biz",
  businesses: "biz",
  biz: "biz",
  organization: "org",
  customer: "cus",
  customers: "cus",
  cus: "cus",
  subscription: "sub",
  subscriptions: "sub",
  sub: "sub",
  invoice: "inv",
  invoices: "inv",
  inv: "inv",
  credit_note: "cn",
  credit_notes: "cn",
  cn: "cn",
  payment_method: "pm",
  payment_methods: "pm",
  pm: "pm",
  transaction: "txn",
  transactions: "txn",
  txn: "txn",
  payment: "pay",
  payments: "pay",
  pay: "pay",
  payment_intent: "pi",
  payment_intents: "pi",
  pi: "pi",
  tax_regions: "txg",
  txg: "txg",
  state_registrations: "txs",
  txs: "txs",
  customer_segments: "seg",
  segment: "seg",
  seg: "seg",
  scheduled_changes: "sch",
  sch: "sch",
  contacts: "con",
  con: "con",
  gateway_accounts: "gwa",
  gateway_account: "gwa",
  gwa: "gwa",
  payment_links: "plink",
  plink: "plink",
  reason_codes: "rsn",
  rsn: "rsn",
  product: "prod",
  products: "prod",
  prod: "prod",
  price: "price",
  prices: "price",
  plan: "price",
  coupon: "cpn",
  coupons: "cpn",
  cpn: "cpn",
  product_group: "pgrp",
  product_groups: "pgrp",
  grp: "pgrp",
  coupon_sets: "cpset",
  coupon_set: "cpset",
  portal_sessions: "psess",
  checkout_sessions: "cosess",
  webhook_endpoints: "whe",
  webhook_endpoint: "whe",
  list_views: "lv",
  report_dashboards: "dash",
  tiles: "dtile",
  tile: "dtile",
  comments: "cmt",
  unbilled_charges: "uch",
  events: "evt",
  event: "evt",
  evt: "evt",
  features: "feat",
  feature: "feat",
  entitlements: "ent",
  custom_fields: "cfd",
  users: "usr",
  user: "usr",
  items: "si",
  item: "si",
  differential_prices: "dprice",
  payment_instructions: "pinst",
  metadata_rules: "mkr",
  rule: "mkr",
  transfers: "txn",
  deliveries: "whd",
  del: "whd",
  usages: "ur",
  api_keys: "key",
  emails: "em",
  disputes: "dsp",
  custom_field_definitions: "cfd",
  metadata_key_rules: "mkr",
  refund: "re",
  refunds: "re",
};

const NAME_BY_HINT: [RegExp, string][] = [
  [/customer|contact/, "Maya Castillo"],
  [/coupon|discount/, "Welcome 10% off"],
  [/price/, "Pro monthly"],
  [/product|plan|catalog/, "Pro"],
  [/segment/, "Enterprise customers"],
  [/dashboard|report/, "Revenue overview"],
  [/view/, "Active subscriptions"],
  [/webhook/, "Billing events"],
  [/field/, "Region"],
  [/reason/, "Too expensive"],
  [/feature|entitlement/, "Seats"],
  [/group/, "Core plans"],
  [/tax/, "Standard rate"],
  [/business|organi[sz]ation|tenant/, "Brightwater Analytics"],
  [/country/, "United States"],
  [/measure|analytics/, "MRR"],
];

const STRING_BY_NAME: [RegExp, string | ((hint: string) => string)][] = [
  [/(^|_)email$|installed_by|created_by|updated_by/, "maya@example.com"],
  [/customer_name|contact_name|full_name|holder_name/, "Maya Castillo"],
  [/^first_name$/, "Maya"],
  [/^last_name$/, "Castillo"],
  [/^(company|company_name|legal_name|business_name)$/, "Brightwater Analytics"],
  [/(^|_)currency$|^currency_code$/, "USD"],
  [/(^|_)country(_code)?$/, "US"],
  [/^(state|state_code|subdivision|subdivision_code)$/, "CA"],
  [/^city$/, "San Francisco"],
  [/^(line1|address_line1|street)$/, "500 Market Street"],
  [/^(line2|address_line2)$/, "Suite 400"],
  [/^(postal_code|zip|zip_code)$/, "94105"],
  [/phone/, "+1 415 555 0100"],
  [/(^|_)timezone$|^time_zone$/, "America/Los_Angeles"],
  [/^(locale|language)$/, "en"],
  [/image_url|logo_url/, "https://example.com/logo.png"],
  [/redirect_url|return_url|success_url|cancel_url/, "https://example.com/thanks"],
  [/(^|_)url$/, "https://example.com/webhooks/billing"],
  [/^po_number$/, "PO-1001"],
  [/^(number|invoice_number)$/, "INV-1001"],
  [/vat_number|tax_id|tax_number|gstin|registration_number/, "EU123456789"],
  [/exchange_rate$|^rate$/, "0.920000"],
  [/_base$/, "USD"],
  [/^(gateway|provider)$/, "stripe"],
  [/^brand$/, "visa"],
  [/^role$/, "admin"],
  [/^subject$/, "Your invoice from Brightwater Analytics"],
  [/^heading$/, "Thanks for your business"],
  [/notes$/, "Thank you for your business."],
  [/^id$/, "3f6c1b9e-8a2d-4c5e-9f10-2b7d4e6a8c01"],
  [/^host$/, "smtp.example.com"],
  [/^region$/, "us-east-1"],
  [/^address$/, "maya@example.com"],
  [/^code_prefix$/, "LAUNCH"],
  [/^html$/, "<p>Hello Maya</p>"],
  [/^text$/, "Hello Maya"],
  [/^method$/, "POST"],
  [/^local_id$/, "cus_XXXXXXXXXXXX01"],
  [/^remote_id$/, "51234567890"],
  [/^remote_property$/, "email"],
  [/^(ours|theirs)$/, "maya@example.com"],
  [/^email_id$/, "em_XXXXXXXXXXXX01"],
  [/^resource_id$/, "sub_XXXXXXXXXXXX01"],
  [/^reference_id$/, "cus_XXXXXXXXXXXX01/pm_XXXXXXXXXXXX01"],
  [/^(report_key|reconciles_with)$/, "mrr"],
  [/^dataset$/, "invoices"],
  [/^attached_item$/, "extra-seat"],
  [/^family$/, "authentication"],
  [/^error_id$/, "stripe.code.expired_card"],
  [/^section_title$/, "Bank transfer"],
  [
    /^data$/,
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ],
  [/^field$/, "email"],
  [/^data_type$/, "text"],
  [/^entity(_type)?$/, "customer"],
  [/^interval$|_unit$/, "month"],
  [/^unit$/, "seat"],
  [/^model$/, "flat"],
  [/^tax_behavior$/, "exclusive"],
  [/^sku$/, "PRO-M"],
  [/^reference$/, "REF-1001"],
  [/domain$/, "example.com"],
  [/fingerprint/, "fp_XXXXXXXXXXXX01"],
  [/trace_id|request_id/, "3f6c1b9e-8a2d-4c5e-9f10-2b7d4e6a8c01"],
  [/^value$/, "West"],
  [/^status$/, "active"],
  [/tax_code/, "998314"],
  [/^(api_name|feature_key|key)$/, "seats"],
  [/^(label|title|display_name|name|invoice_name)$/, (hint) => nameFor(hint)],
  [/^description$/, "Everything a growing team needs."],
  [/^(reason|comment|note|notes|body|message|memo)$/, "Requested by the customer."],
  [/(^|_)code$/, "welcome-10"],
  [/secret/, "whsec_XXXXXXXXXXXX01"],
  [/(^|_)(token|session)$/, "tok_XXXXXXXXXXXX01"],
  [/^password$/, "correct-horse-battery-staple"],
  [/^query$|^search$|^q$/, "ada"],
  [/^(slug|handle)$/, "pro-monthly"],
  [/color|colour/, "#2563eb"],
];

function nameFor(hint: string): string {
  const h = snake(hint);
  return NAME_BY_HINT.find(([re]) => re.test(h))?.[1] ?? "Example";
}

function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Ellipsis placeholders in the spec become same-shape fakes; anything else stays. */
function fromSpecExample(example: unknown): unknown {
  if (typeof example !== "string") return example;
  if (!example.includes("…") && !example.includes("...")) return example;
  const id = ID_HINT.exec(example);
  return id ? fakeId(id[1]!) : undefined;
}

function idFor(name: string, s: JsonSchema, hint: string): string | undefined {
  const fromText = ID_HINT.exec(s.description ?? "");
  if (fromText) return fakeId(fromText[1]!);
  const key = name.replace(/_ids?$/, "");
  if (name === "id") {
    // `linked_payment` → payment → pay: the longest known suffix of the owner.
    const parts = snake(hint.split(" ")[0] ?? "")
      .replace(/_create$|_update$/, "")
      .split("_");
    for (let i = 0; i < parts.length; i++) {
      const prefix = ID_PREFIX[parts.slice(i).join("_")];
      if (prefix) return fakeId(prefix);
    }
    return undefined;
  }
  if (/_ids?$/.test(name) || ID_PREFIX[name]) {
    if (key === "coupon" || name === "coupon_ids") return CATALOGUE_SLUG.cpn;
    // `test_business_id` → business: try the longest known suffix.
    const parts = key.split("_");
    for (let i = 0; i < parts.length; i++) {
      const prefix = ID_PREFIX[parts.slice(i).join("_")];
      if (prefix) return fakeId(prefix);
    }
  }
  return undefined;
}

/** Prose that lists values — "One of `a`, `b`" — names a valid first value. */
function valueFromProse(description = ""): string | undefined {
  const listed = /`([a-z][a-z0-9_.]*)`\s*(?:,|\bor\b|\|)\s*`[a-z]/.exec(description);
  const eg = /\be\.g\.,?\s+[`"]?([A-Za-z0-9][\w.\- ]*?)[`"]?(?=[,;)]|\.?\s|\.?$)/.exec(description);
  return listed?.[1] ?? eg?.[1];
}

function stringFor(name: string, s: JsonSchema, hint: string): string {
  const id = idFor(name, s, hint);
  if (id) return id;
  if (/cursor|next_offset/.test(name)) return "eyJvZmZzZXQiOjEwfQ";
  switch (s.format) {
    case "date-time":
      return /end|next|due|expir|renew|until|to$/.test(name)
        ? "2026-04-14T09:30:00Z"
        : "2026-03-14T09:30:00Z";
    case "date":
      return /end|due|expir|until|to$/.test(name) ? "2026-04-14" : "2026-03-14";
    case "email":
      return "maya@example.com";
    case "uri":
      return "https://example.com/webhooks/billing";
    case "uuid":
      return "3f6c1b9e-8a2d-4c5e-9f10-2b7d4e6a8c01";
  }
  const listed = valueFromProse(s.description);
  if (listed) return listed;
  const rule = STRING_BY_NAME.find(([re]) => re.test(name));
  if (rule) return typeof rule[1] === "function" ? rule[1](hint) : rule[1];
  if (/_at$/.test(name)) return "2026-03-14T09:30:00Z";
  return name ? name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "example";
}

function numberFor(name: string, s: JsonSchema): number {
  const clamp = (v: number) => Math.min(s.maximum ?? Infinity, Math.max(s.minimum ?? -Infinity, v));
  if (/_bps$/.test(name)) return clamp(1000);
  if (/_minor$|(^|_)(amount|price|total|subtotal|balance)(_|$)/.test(name)) {
    return /discount|tax|withholding|credits_applied|refunded|excess|promotional|written_off|amount_due|fee/.test(
      name,
    )
      ? 0
      : clamp(2900);
  }
  if (/attempt/.test(name)) return clamp(0);
  if (/quantity|^qty$|count$|^count$|_periods?$|interval_count|version/.test(name)) return clamp(1);
  if (/_days$|^days$|(^|_)day$/.test(name)) return clamp(14);
  if (/^limit$|page_size|per_page/.test(name)) return clamp(10);
  if (/month/.test(name)) return clamp(1);
  if (/year/.test(name)) return clamp(2026);
  if (/position|index|order|offset/.test(name)) return clamp(0);
  if (/rate$|percent/.test(name)) return clamp(baseType(s) === "integer" ? 10 : 0.92);
  return clamp(1);
}

type Mode = "request" | "response";

/** Optional request fields worth showing beside the required ones. */
const COMMON_OPTIONAL = new Set([
  "email",
  "first_name",
  "last_name",
  "company",
  "name",
  "description",
  "amount_minor",
  "interval",
  "quantity",
  "currency",
  "reason_code",
  "url",
  "enabled_events",
  "label",
]);

/** A response field that is usually empty in a healthy record: show it as null. */
const USUALLY_NULL =
  /^(voided|cancelled|canceled|deleted|archived|paused|resumed|written_off|refunded|failed|deprecated)(_|$)|_reason$|reason_code$|^error|_error$|^last_error/;

/**
 * An example value for one schema.
 *
 * Request examples carry the required fields plus a few common optional ones —
 * something a reader can paste. Response examples carry every field to depth 1, then
 * required-only, so a list of invoices stays readable.
 */
export function sample(
  raw: JsonSchema | undefined,
  mode: Mode,
  name = "",
  hint = "",
  depth = 0,
): unknown {
  const s = primary(raw);
  if (!s) return null;
  const hintHere = [s["x-name"] ?? "", hint].join(" ").trim();
  if (s.const !== undefined) return s.const;
  if (s.example !== undefined) {
    const ex = fromSpecExample(s.example);
    if (ex !== undefined) return ex;
  }
  if (mode === "response" && s.nullable && (USUALLY_NULL.test(name) || /cursor|note$/.test(name)))
    return null;
  if (name === "object" && baseType(s) === "string") {
    const owner = s.enum?.[0] ?? snake(hint.split(" ")[0] ?? "");
    return /_list$|^list$/.test(String(owner)) ? "list" : owner || "object";
  }
  const enumValues = s.enum?.filter((v) => v !== null);
  if (enumValues?.length) {
    // A healthy record reads better than the first lifecycle state ("future").
    if (name === "status" && enumValues.includes("active") && s.default === undefined)
      return "active";
    return s.default ?? enumValues[0];
  }
  if (s.default !== undefined && s.default !== null) return s.default;

  switch (baseType(s)) {
    case "string":
      return stringFor(name, s, hintHere);
    case "integer":
    case "number":
      return numberFor(name, s);
    case "boolean":
      return false;
    case "array": {
      if (depth > 4) return [];
      const singular = name.replace(/_ids$/, "_id").replace(/ies$/, "y").replace(/s$/, "");
      const item = sample(s.items, mode, singular, `${singular} ${hintHere}`, depth + 1);
      const empty =
        item === null ||
        (typeof item === "object" && !Array.isArray(item) && !Object.keys(item).length);
      return empty ? [] : [item];
    }
    case "object":
    case undefined: {
      if (!s.properties) {
        if (/metadata/.test(name)) return { crm_id: "acct-1001" };
        if (/custom_fields/.test(name)) return { cf_region: "West" };
        if (/rates/.test(name)) return { EUR: 0.92 };
        return {};
      }
      if (depth > 4) return {};
      return objectSample(s, mode, hintHere, depth);
    }
    default:
      return null;
  }
}

function objectSample(s: JsonSchema, mode: Mode, hint: string, depth: number) {
  const props = Object.entries(s.properties ?? {}).filter(([, p]) => {
    const d = deref(p);
    return mode === "request" ? !d?.readOnly : !d?.writeOnly;
  });
  const required = new Set(s.required ?? []);
  let keep: [string, JsonSchema][];
  if (mode === "request") {
    const optional = props
      .filter(([k, p]) => !required.has(k) && COMMON_OPTIONAL.has(k) && !deref(p)?.deprecated)
      .slice(0, depth === 0 ? 3 : 2);
    keep = props.filter(([k]) => required.has(k) || optional.some(([o]) => o === k));
    // No required field and no common one: show two plain fields rather than `{}`.
    if (!keep.length) {
      keep = props
        .filter(([k, p]) => {
          const t = baseType(primary(p) ?? {});
          return k !== "id" && !deref(p)?.deprecated && t !== "object" && t !== "array";
        })
        .slice(0, 2);
    }
  } else if (depth <= 1) {
    keep = props;
  } else {
    keep = required.size ? props.filter(([k]) => required.has(k)) : props.slice(0, 6);
  }
  const out: Record<string, unknown> = {};
  for (const [key, prop] of keep) out[key] = sample(prop, mode, key, hint, depth + 1);
  return out;
}

const ERROR_TYPE: Record<string, string> = {
  "400": "invalid_request_error",
  "401": "authentication_error",
  "402": "payment_error",
  "403": "permission_error",
  "404": "invalid_request_error",
  "409": "conflict_error",
  "422": "invalid_request_error",
  "429": "rate_limit_error",
};

function responseExample(status: string, description: string, schema: JsonSchema, hint: string) {
  const s = deref(schema);
  if (s?.["x-name"] === "Error") {
    const type = /idempoten/i.test(description)
      ? "idempotency_error"
      : (ERROR_TYPE[status] ?? (status.startsWith("5") ? "api_error" : "invalid_request_error"));
    const message =
      firstSentence(stripInternal(description)).replace(/`/g, "") || "Request failed.";
    return { error: { type, message } };
  }
  return sample(schema, "response", "", hint);
}

// ── Markdown emitters ─────────────────────────────────────────────────────────

/**
 * Escape what MDC reads as syntax.
 *
 * The spec's prose says `sub_<nano>` and `<id>` meaning those literally — and MDC
 * parses each as a Vue component and drops the text. Escaping happens OUTSIDE code
 * spans only, because inside them an entity renders as its own source. A line
 * opening with `#name` would start a new component slot, so it is escaped too.
 */
function mdcSafe(text: string): string {
  let out = "";
  let inCode = false;
  for (const ch of slugPlaceholders(stripInternal(text))) {
    if (ch === "`") {
      inCode = !inCode;
      out += ch;
    } else if (!inCode && ch === "<") out += "&lt;";
    else if (!inCode && ch === ">") out += "&gt;";
    else out += ch;
  }
  return out.replace(/^#(?=[A-Za-z])/gm, "\\#").replace(/^::/gm, "\\::");
}

/** Markdown's table cell delimiter, and a newline, both break a row. */
function cell(text: string | undefined): string {
  return mdcSafe(
    (text ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\s*\n\s*/g, " ")
      .trim(),
  );
}

function yamlString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * URL segment: the verb and its object, cut at the first clause boundary.
 * Deliberately NOT the title logic below: these URLs are published and linked, so they stay put.
 */
function operationSlug(summary: string): string {
  const head = summary.split(/\s*[(—:,–]|\s+-\s+/)[0] ?? summary;
  // Trim AFTER the cut: a route ending in `-` does not match its file.
  return slug(head).slice(0, 48).replace(/-+$/, "");
}

/** A summary up to this long keeps its colon clause in the title. */
const SUMMARY_TITLE_MAX = 60;

/** The first " — ", " – ", " - " or ": " outside parentheses. */
function clauseBreak(s: string): { at: number; len: number; colon: boolean } | undefined {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === ":" && s[i + 1] === " ") return { at: i, len: 2, colon: true };
    else if (depth === 0 && /^ [—–-] /.test(s.slice(i, i + 3)))
      return { at: i, len: 3, colon: false };
  }
  return undefined;
}

const balanced = (s: string) => (s.match(/\(/g)?.length ?? 0) === (s.match(/\)/g)?.length ?? 0);

/**
 * "Create a subscription (bills active subs in advance)" → title + lede.
 * Splits only at a dash clause, a colon in a long summary, or ONE trailing parenthetical —
 * never at a comma or an inner "(…)": those cut "Void (release) an authorized, unconsumed
 * intent" in half. A one-word head keeps the whole summary.
 */
export function splitSummary(summary: string): { title: string; lede: string } {
  const whole = { title: summary, lede: "" };
  let head: string;
  let rest: string;
  const brk = clauseBreak(summary);
  if (brk && !(brk.colon && summary.length <= SUMMARY_TITLE_MAX)) {
    head = summary.slice(0, brk.at);
    rest = summary.slice(brk.at + brk.len);
  } else {
    const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(summary);
    if (!m || !balanced(m[1]!)) return whole;
    head = m[1]!;
    rest = m[2]!;
  }
  head = head.trim();
  rest = rest.trim();
  if (!rest || !/\s/.test(head)) return whole;
  return {
    title: head,
    lede: rest.charAt(0).toUpperCase() + rest.slice(1) + (/[.!?]$/.test(rest) ? "" : "."),
  };
}

/** Frontmatter is not rendered as markdown, so backticks would print literally. */
function plain(text: string): string {
  return cell(text)
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** The first sentence — never a hard character cut mid-word. */
function firstSentence(text: string, max = 200): string {
  const flat = (text ?? "").replace(/\s*\n\s*/g, " ").trim();
  if (!flat) return "";
  const stop = /(?<![A-Z]|e\.g|i\.e|vs|etc)\.\s/.exec(flat);
  const sentence = stop ? flat.slice(0, stop.index + 1) : flat;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "") + "…";
}

const sameText = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

// ── Search snippets ───────────────────────────────────────────────────────────
// The site appends " | Two Minute Billing" to every <title>, so a page part of 39 characters
// keeps the whole title within 60. Descriptions aim at 140–160 characters: what the call does,
// where it lives, then facts from the spec. No brand filler, and never the title restated.
const SEO_TITLE_MAX = 39;
const SEO_DESC_MIN = 140;
const SEO_DESC_MAX = 160;

/** Cut at a word boundary, never mid-word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[\s,;:–-]+$/, "") + "…";
}

/** Where a title can end and still name a whole thing: a comma, or before a modifier. */
const MODIFIER =
  /,\s+|\s+(?=(?:for|on|with|from|into|in|across|via|without|that|whose|while|per|at|as|to|under|until|against)\s)/gi;
const DANGLING = /[\s,;:/&↔-]+$|\s+(?:and|or|the|a|an)$/i;
/** A complete title may run past the budget by this much rather than lose its meaning. */
const SEO_TITLE_SLACK = 6;

/** The longest prefix ending at a modifier, within `max`, of at least `minWords` words. */
function cutAt(text: string, max: number, minWords = 3): string {
  let best = "";
  for (const m of text.matchAll(MODIFIER)) {
    // "Add, deduct, or set …": a comma inside a list of verbs is not a place to stop.
    if (/^(?:and|or)\s/.test(text.slice(m.index + m[0].length))) continue;
    let head = text.slice(0, m.index);
    while (DANGLING.test(head)) head = head.replace(DANGLING, "");
    if (head.length <= max && head.split(/\s+/).length >= minWords && head.length > best.length)
      best = head;
  }
  return best;
}

/**
 * The title, made to fit: parentheses and articles go first, then a trailing modifier, then
 * a little slack. Never an ellipsis or a cut word. `whole` is false when a modifier was dropped.
 */
function shorten(title: string, max: number): { text: string; whole: boolean } {
  const bare = title
    .replace(/\s*\([^()]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (bare.length <= max) return { text: bare, whole: true };
  const lean = bare.replace(/(?<=\S\s)(?:a|an|the)\s+/gi, "");
  if (lean.length <= max) return { text: lean, whole: true };
  const cut = cutAt(lean, max);
  if (cut) return { text: cut, whole: false };
  if (lean.length <= max + SEO_TITLE_SLACK) return { text: lean, whole: true };
  const loose = cutAt(lean, max + SEO_TITLE_SLACK);
  return loose ? { text: loose, whole: false } : { text: lean, whole: true };
}

/** "Create a coupon set – Catalog API", or the title alone when the pair is too long. */
export function seoTitle(title: string, resource: string): string {
  const paired = `${title} – ${resource} API`;
  if (paired.length <= SEO_TITLE_MAX) return paired;
  const api = `${title} API`;
  if (!/\bAPI\b/.test(title) && api.length <= SEO_TITLE_MAX) return api;
  if (title.length <= SEO_TITLE_MAX) return title;
  const short = shorten(title, SEO_TITLE_MAX);
  // A short remainder names its resource, as the paired form does: "Reactivate – Subscriptions API".
  const pairedShort = `${short.text} – ${resource} API`;
  if (pairedShort.length <= SEO_TITLE_MAX) return pairedShort;
  if (short.text.length > SEO_TITLE_MAX) {
    // Still long: verb and object, with the resource naming the rest ("Get event – Webhooks API").
    const verb = cutAt(short.text, SEO_TITLE_MAX, 2);
    if (verb && `${verb} – ${resource} API`.length <= SEO_TITLE_MAX)
      return `${verb} – ${resource} API`;
  }
  const withApi = `${short.text} API`;
  return short.whole && !/\bAPI\b/.test(short.text) && withApi.length <= SEO_TITLE_MAX
    ? withApi
    : short.text;
}

/** Sentences joined in order while they fit; a part that would overflow is skipped. */
export function seoDescription(parts: string[]): string {
  const sentences = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/[.!?…]$/.test(p) ? p : `${p}.`));
  let out = clip(sentences[0] ?? "", SEO_DESC_MAX);
  for (const next of sentences.slice(1)) {
    if (out.length >= SEO_DESC_MIN) break;
    if (`${out} ${next}`.length <= SEO_DESC_MAX) out = `${out} ${next}`;
  }
  return out;
}

/** Plain text for a meta tag: `<name>` placeholders read as `{name}`, like path parameters. */
function metaText(text: string): string {
  return plain(text)
    .replace(/<([^<>]+)>/g, "{$1}")
    .replace(/[<>]/g, "");
}

/** A sentence too long for a snippet keeps its first clause when that still reads alone. */
function firstClause(sentence: string): string {
  if (sentence.length <= SEO_DESC_MAX - 40) return sentence;
  const m = /^(.{60,}?)(?:;|\s[\u2014\u2013]\s|,\s(?:so|and|but|which)\s)/.exec(sentence);
  return m ? `${m[1]!.trim()}.` : sentence;
}

/** A sentence that says what the call is for, not a note about one of its parameters. */
const purposeful = (s: string) => /^[A-Z0-9]/.test(s) && s.split(/\s+/).length >= 4;

const lowerFirst = (s: string) =>
  /^[A-Z][a-z]*(?=[\s,/]|$)/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;

/** "a, b and c" — the first `max` names, or undefined past that. */
function nameList(names: string[], max: number): string | undefined {
  if (!names.length || names.length > max) return undefined;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Meta description for one operation, built only from what the spec says about it. */
function operationSnippet(op: Operation, title: string, lead: string): string {
  const purpose = [lead, firstSentence(op.description)]
    .map(metaText)
    .map(firstClause)
    .find(purposeful);
  const call = `${op.method} ${op.path}`;
  const required = nameList(deref(op.body)?.required ?? [], 4);
  const query = nameList(
    op.params.filter((p) => p.in === "query").map((p) => p.name),
    5,
  );
  const ok = op.responses.find((r) => r.status.startsWith("2"));
  const okText = ok?.description ?? "";
  // A list's fields are its items' fields.
  const body = deref(ok?.content?.["application/json"]?.schema);
  const list = baseType(deref(body?.properties?.data) ?? {}) === "array";
  const shape = list ? deref(deref(body?.properties?.data)?.items) : body;
  const fields = shape?.["x-name"] === "Error" ? [] : Object.keys(shape?.properties ?? {});
  const returns = /^(?:The|A|An|Every|One)\s/.test(okText)
    ? `Returns ${lowerFirst(metaText(okText))}`
    : fields.length
      ? `${list ? "Each result has" : "Returns"} ${fields.slice(0, 4).join(", ")}${fields.length > 4 ? " and more" : ""}`
      : "";
  return seoDescription([
    purpose ?? `${call}: ${lowerFirst(metaText(title))}`,
    purpose ? call : "",
    required ? `Requires ${required}` : "",
    query ? `Query parameters: ${query}` : "",
    returns,
    op.idempotent ? "Send an Idempotency-Key so a retry is safe" : "",
    op.internal
      ? /not by API clients/i.test(purpose ?? "")
        ? ""
        : "Not called by API clients"
      : op.authenticated
        ? "Authenticate with a bearer API key"
        : "No API key needed",
    nameList(
      op.responses.map((r) => r.status),
      6,
    )
      ? `Status codes: ${nameList(
          op.responses.map((r) => r.status),
          6,
        )}`
      : "",
    "Request and response examples",
  ]);
}

/** Field rows, flattened one level so nested objects still read. */
function fieldRows(
  schema: JsonSchema,
  mode: Mode,
  prefix = "",
  depth = 0,
  nestOnly?: string,
): string[] {
  const s = deref(schema);
  if (!s?.properties) return [];
  const required = new Set(s.required ?? []);
  const rows: string[] = [];
  for (const [name, raw] of Object.entries(s.properties)) {
    const field = deref(raw);
    if (mode === "request" ? field?.readOnly : field?.writeOnly) continue;
    const enums = field?.enum?.length
      ? ` One of ${field.enum.map((v) => `\`${String(v)}\``).join(", ")}.`
      : "";
    const def =
      field?.default !== undefined ? ` Defaults to \`${JSON.stringify(field.default)}\`.` : "";
    const desc = cell(stripInternal(field?.description ?? "") + enums + def) || "—";
    rows.push(
      mode === "request"
        ? `| \`${prefix}${name}\` | \`${typeLabel(raw)}\` | ${required.has(name) ? "**yes**" : "no"} | ${desc} |`
        : `| \`${prefix}${name}\` | \`${typeLabel(raw)}\` | ${desc} |`,
    );
    // One level of nesting: past that the shape is one the reader has already met.
    if (depth < 1 && (!nestOnly || nestOnly === name)) {
      const nested = baseType(field ?? {}) === "array" ? deref(field?.items) : field;
      if (nested?.properties) rows.push(...fieldRows(nested, mode, `${prefix}${name}.`, depth + 1));
    }
  }
  return rows;
}

// ── Operations ────────────────────────────────────────────────────────────────

export type Operation = {
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  deprecated: boolean;
  params: Parameter[];
  body?: JsonSchema;
  bodyRequired: boolean;
  authenticated: boolean;
  /** Not for API clients: an infra probe, or a route the spec says another system calls. */
  internal: boolean;
  idempotent: boolean;
  responses: { status: string; description: string; content?: Record<string, MediaType> }[];
  file: string;
};

/**
 * The spec has no `x-internal`. It marks these two ways: an unauthenticated route outside
 * `/v1` (health and probes), and a description saying who calls it instead of API clients.
 */
function isInternal(path: string, raw: RawOperation): boolean {
  const open = Array.isArray(raw.security) && raw.security.length === 0;
  return (open && !path.startsWith("/v1/")) || /\bnot by API clients\b/.test(raw.description ?? "");
}

export function collectOperations(): Operation[] {
  const ops: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const raw = item[method];
      if (!raw) continue;
      const params = raw.parameters ?? [];
      ops.push({
        method: method.toUpperCase(),
        path,
        tag: raw.tags?.[0] ?? "Other",
        summary: stripInternal(raw.summary ?? `${method.toUpperCase()} ${path}`).trim(),
        description: stripInternal(raw.description ?? "").trim(),
        deprecated: raw.deprecated === true,
        params,
        body: raw.requestBody?.content?.["application/json"]?.schema,
        bodyRequired: raw.requestBody?.required === true,
        authenticated: !(Array.isArray(raw.security) && raw.security.length === 0),
        internal: isInternal(path, raw),
        idempotent: method !== "get" && params.some((p) => p.name === IDEMPOTENCY_HEADER),
        responses: Object.entries(raw.responses ?? {}).map(([status, r]) => ({
          status,
          description: r?.description ?? "",
          content: r?.content,
        })),
        file: "",
      });
    }
  }
  return ops;
}

/** The example value for a path or query parameter. */
function paramValue(p: Parameter, path: string): string {
  const s = primary(p.schema) ?? {};
  const enumValue = s.enum?.find((v) => v !== null);
  if (enumValue !== undefined) return String(enumValue);
  const hinted = ID_HINT.exec(p.description ?? "");
  if (hinted) return fakeId(hinted[1]!);
  if (p.name === "id") {
    const segs = path.split("/");
    const owner = segs[segs.indexOf("{id}") - 1] ?? "";
    return ID_PREFIX[owner] ? fakeId(ID_PREFIX[owner]!) : "XXXXXXXXXXXX01";
  }
  if (ID_PREFIX[p.name]) return fakeId(ID_PREFIX[p.name]!);
  if (p.name === "code")
    return /currenc/.test(path) ? "USD" : /countr/.test(path) ? "US" : "expired_card";
  if (p.name === "currency") return "USD";
  if (p.name === "gateway") return "stripe";
  if (p.name === "address") return "ada%40example.com";
  if (p.name === "key" || p.name === "feature") return "seats";
  if (p.name === "limit") return "10";
  const listed = valueFromProse(p.description);
  if (listed) return listed;
  const v = sample(s, "request", p.name);
  return encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v));
}

function shellQuote(json: string): string {
  return json.replace(/'/g, "'\\''");
}

export function requestExample(op: Operation): { curl: string; body?: unknown } {
  let p = op.path;
  for (const param of op.params.filter((x) => x.in === "path")) {
    p = p.replace(`{${param.name}}`, paramValue(param, op.path));
  }
  const query = op.params
    .filter((x) => x.in === "query" && (x.required || x.name === "limit"))
    .map((x) => `${x.name}=${paramValue(x, op.path)}`);
  const url = `"$TMBILLING_URL${p}${query.length ? `?${query.join("&")}` : ""}"`;

  const lines = [op.method === "GET" ? `curl ${url}` : `curl -X ${op.method} ${url}`];
  if (op.authenticated) lines.push(`-H "Authorization: Bearer $TMBILLING_API_KEY"`);
  for (const h of op.params.filter((x) => x.in === "header" && x.required)) {
    if (h.name === IDEMPOTENCY_HEADER) continue;
    lines.push(`-H "${h.name}: $${h.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}"`);
  }
  if (op.idempotent) lines.push(`-H "${IDEMPOTENCY_HEADER}: $(uuidgen)"`);
  let body: unknown;
  if (op.body) {
    body = sample(op.body, "request", "", `${resourceHint(op.path)}`);
    lines.push(`-H "Content-Type: application/json"`);
    const json = JSON.stringify(body, null, 2).replace(/\n/g, "\n  ");
    lines.push(`-d '${shellQuote(json)}'`);
  }
  return { curl: lines.join(" \\\n  "), body };
}

/** The resource a path addresses, for naming examples: `/…/products/{prod}` → "products". */
function resourceHint(path: string): string {
  const segs = path.split("/").filter((s) => s && !s.startsWith("{") && s !== "v1");
  return segs.slice(-2).reverse().join(" ");
}

const REASON: Record<string, string> = {
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "204": "No Content",
  "400": "Bad Request",
  "401": "Unauthorized",
  "402": "Payment Required",
  "403": "Forbidden",
  "404": "Not Found",
  "409": "Conflict",
  "410": "Gone",
  "412": "Precondition Failed",
  "413": "Payload Too Large",
  "415": "Unsupported Media Type",
  "422": "Unprocessable Entity",
  "423": "Locked",
  "429": "Too Many Requests",
  "500": "Internal Server Error",
  "501": "Not Implemented",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
};

const BINARY_SAMPLE: Record<string, string> = {
  "application/pdf": "Content-Type: application/pdf\n\n%PDF-1.7 (binary document)",
  "text/csv": "Content-Type: text/csv\n\n(CSV rows, one per record, with a header row)",
  "text/html": "Content-Type: text/html\n\n<!doctype html>\n<html>(the rendered document)</html>",
};

type ResponseBlock = { status: string; lang: string; code: string };

/** Every documented status that has a body to show; 2xx first. */
export function responseBlocks(op: Operation): ResponseBlock[] {
  const blocks: ResponseBlock[] = [];
  const ordered = [...op.responses].sort(
    (a, b) =>
      Number(!a.status.startsWith("2")) - Number(!b.status.startsWith("2")) ||
      a.status.localeCompare(b.status),
  );
  for (const r of ordered) {
    const label = `${r.status} ${REASON[r.status] ?? ""}`.trim();
    const json = r.content?.["application/json"]?.schema;
    if (json) {
      const ex = responseExample(r.status, r.description, json, resourceHint(op.path));
      blocks.push({ status: label, lang: "json", code: JSON.stringify(ex, null, 2) });
      continue;
    }
    const other = Object.keys(r.content ?? {}).find((c) => BINARY_SAMPLE[c]);
    if (other) blocks.push({ status: label, lang: "text", code: BINARY_SAMPLE[other]! });
    else if (r.status === "204") blocks.push({ status: label, lang: "text", code: "(empty body)" });
  }
  return blocks;
}

const GENERATED_NOTE =
  "<!-- GENERATED by scripts/gen-api-reference.ts from sdk/openapi.json. Do not edit — " +
  "including in Studio; the next build replaces this file. -->";

/** Sidebar label: the verb plus the shortest faithful name, so it does not truncate. */
const NAV_MAX = 24;
function navTitle(method: string, title: string, full = false): string {
  let short = title.replace(/(?<=\S\s)(?:a|an|the)\s+/gi, "").replace(/\s*\([^)]*\)/g, "");
  if (!full && short.length > NAV_MAX) {
    // "Stop dunning for invoice" → "Stop dunning": the verb and its object.
    const m =
      /^(\S+\s+\S+.*?)\s+(?:for|on|of|to|in|with|from|into|under|until|against|as|and|by|&)\s/i.exec(
        short,
      );
    if (m?.[1] && m[1].length <= NAV_MAX) short = m[1];
  }
  // A word cut keeps more room: two words and an ellipsis name nothing.
  if (!full && short.length > NAV_MAX + 8) {
    short =
      short
        .slice(0, NAV_MAX + 8)
        .replace(/\s+\S*$/, "")
        .replace(/[\s,;:/&↔-]+$/, "")
        .replace(/\s+(?:for|on|of|to|in|with|from|into|and|that|the|a|an|or|by|as|are|is)$/i, "") +
      "…";
  }
  return `${method} · ${short}`;
}

function table(header: string[], rows: string[]): string[] {
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows, ""];
}

function operationPage(op: Operation, nav: string, resource: string, seoName?: string): string {
  const { title, lede } = splitSummary(op.summary);
  let lead = lede;
  let body = op.description;
  if (!lead && body) {
    const first = firstSentence(body);
    lead = first;
    // The header already says it; the body keeps the rest unless formatting would be lost.
    if (!first.endsWith("…") && !/[`*]/.test(first)) body = body.slice(first.length).trim();
  }
  if (sameText(lead, title)) lead = "";

  const out: string[] = ["---", `title: ${yamlString(title)}`];
  out.push(`description: ${yamlString(plain(lead))}`);
  out.push("seo:");
  // Two operations in one resource can share a summary; the method keeps their titles apart.
  out.push(`  title: ${yamlString(seoTitle(seoName ?? title, resource))}`);
  out.push(`  description: ${yamlString(operationSnippet(op, title, lead))}`);
  out.push("navigation:");
  out.push(`  title: ${yamlString(nav)}`);
  if (op.internal) {
    // Documented for completeness, kept out of search: server/routes/sitemap.xml.ts honours
    // `sitemap`, and @nuxtjs/robots copies `robots` to `seo.robots`.
    out.push("sitemap: false");
    out.push('robots: "noindex, follow"');
  }
  out.push("---", "", GENERATED_NOTE, "");

  out.push(`::api-operation{method="${op.method}" path="${op.path}"}`);
  out.push("#docs");
  if (op.deprecated) {
    out.push(":::warning");
    out.push("This endpoint is deprecated. It keeps working within its API version.");
    out.push(":::", "");
  }
  if (body) out.push(mdcSafe(body), "");

  for (const [heading, where] of [
    ["Path parameters", "path"],
    ["Query parameters", "query"],
    ["Headers", "header"],
  ] as const) {
    const params = op.params.filter((p) => p.in === where);
    if (!params.length) continue;
    out.push(`## ${heading}`, "");
    out.push(
      ...table(
        ["Parameter", "Type", "Required", "Description"],
        params.map(
          (p) =>
            `| \`${p.name}\` | \`${typeLabel(p.schema)}\` | ${p.required ? "**yes**" : "no"} | ${cell(stripInternal(p.description)) || "—"} |`,
        ),
      ),
    );
  }

  if (op.body) {
    const rows = fieldRows(op.body, "request");
    if (rows.length) {
      out.push("## Body", "");
      out.push(`The request body is ${op.bodyRequired ? "**required**" : "optional"}.`, "");
      out.push(...table(["Field", "Type", "Required", "Description"], rows));
    }
  }

  const ok = op.responses.find(
    (r) => r.status.startsWith("2") && r.content?.["application/json"]?.schema,
  );
  const okSchema = deref(ok?.content?.["application/json"]?.schema);
  if (ok && okSchema && okSchema["x-name"] !== "Error") {
    // A list's fields are its items' fields; anything else stays top-level.
    const rows = fieldRows(okSchema, "response", "", 0, "data");
    if (rows.length) {
      out.push("## Response", "");
      out.push(...table(["Field", "Type", "Description"], rows));
    }
  }

  if (op.responses.length) {
    out.push("## Status codes", "");
    out.push(
      ...table(
        ["Status", "Meaning"],
        op.responses.map(
          (r) => `| \`${r.status}\` | ${cell(stripInternal(r.description)) || "—"} |`,
        ),
      ),
    );
  }

  out.push("#request");
  out.push("```bash [Request]");
  out.push(requestExample(op).curl);
  out.push("```", "");

  const blocks = responseBlocks(op);
  if (blocks.length) {
    out.push("#response");
    if (blocks.length > 1) out.push(":::code-group");
    for (const b of blocks) out.push(`\`\`\`${b.lang} [${b.status}]`, b.code, "```");
    if (blocks.length > 1) out.push(":::");
  }
  out.push("::", "");
  return out.join("\n");
}

// ── Build ─────────────────────────────────────────────────────────────────────

function main() {
  loadSpec();
  const declared = spec.tags ?? [];
  const byTag = new Map<string, Operation[]>();
  for (const op of collectOperations()) {
    const list = byTag.get(op.tag) ?? [];
    list.push(op);
    byTag.set(op.tag, list);
  }

  // Declared tag order first, then anything tagged without being declared.
  const order = declared.map((t) => t.name);
  const tagNames = [...byTag.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // `defaultOpen: false` keeps this tree folded in the sidebar.
  writeFileSync(
    join(OUT_DIR, ".navigation.yml"),
    "title: API Reference\nicon: i-lucide-code\ndefaultOpen: false\n",
  );

  let pages = 0;
  const tagSummaries: string[] = [];

  tagNames.forEach((tagName, tagIndex) => {
    const ops = (byTag.get(tagName) ?? []).sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        METHODS.indexOf(a.method.toLowerCase() as never) -
          METHODS.indexOf(b.method.toLowerCase() as never),
    );
    const dir = join(OUT_DIR, `${String(tagIndex + 1).padStart(2, "0")}.${slug(tagName)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".navigation.yml"), `title: ${tagName}\n`);

    // A slug per operation, deduplicated: two operations can share a summary.
    const seen = new Map<string, number>();
    ops.forEach((op) => {
      const base = operationSlug(op.summary) || slug(`${op.method}-${op.path}`);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      op.file = n === 1 ? base : `${base}-${n}`;
    });

    const tagDescription = stripInternal(declared.find((t) => t.name === tagName)?.description);
    const rows = ops.map(
      (op) =>
        `| \`${op.method}\` | [\`${op.path}\`](/help/developers/api-reference/${slug(tagName)}/${op.file}) | ${cell(splitSummary(op.summary).title)} |`,
    );

    writeFileSync(
      join(dir, "index.md"),
      [
        "---",
        `title: ${yamlString(tagName)}`,
        `description: ${yamlString(plain(firstSentence(tagDescription)) || `${ops.length} endpoints.`)}`,
        "seo:",
        `  title: ${yamlString(clip(`${tagName} API reference`, SEO_TITLE_MAX))}`,
        `  description: ${yamlString(
          seoDescription([
            plain(firstSentence(tagDescription)) ||
              `The ${tagName} resource in the Two Minute Billing REST API`,
            `${ops.length} ${tagName} endpoints, each with a request and a response example`,
            ops.some((o) => o.method.toUpperCase() !== "GET") &&
            ops.every((o) => o.method.toUpperCase() === "GET" || o.idempotent)
              ? "Every write takes an Idempotency-Key"
              : "",
            ops.every((o) => o.authenticated) ? "Authenticate with a bearer API key" : "",
            `${ops.filter((o) => o.method === "GET").length} reads and ${ops.filter((o) => o.method !== "GET").length} writes`,
          ]),
        )}`,
        "---",
        "",
        GENERATED_NOTE,
        "",
        mdcSafe(tagDescription),
        "",
        "## Endpoints",
        "",
        ...table(["Method", "Endpoint", "Description"], rows),
      ].join("\n"),
    );

    // Shortened sidebar labels must stay distinct within a resource.
    const navs = ops.map((op) => navTitle(op.method, splitSummary(op.summary).title));
    const navCount = new Map<string, number>();
    for (const n of navs) navCount.set(n, (navCount.get(n) ?? 0) + 1);
    const titleCount = new Map<string, number>();
    for (const op of ops) {
      const t = splitSummary(op.summary).title;
      titleCount.set(t, (titleCount.get(t) ?? 0) + 1);
    }
    // Search titles must differ too: same summary → the method, or else the path's last word.
    const seoNames = ops.map((op) => {
      const t = splitSummary(op.summary).title;
      if (titleCount.get(t)! < 2) return undefined;
      const same = ops.filter((o) => splitSummary(o.summary).title === t);
      if (same.filter((o) => o.method === op.method).length === 1) return `${op.method} ${t}`;
      const seg =
        op.path
          .split("/")
          .filter((x) => x && !x.startsWith("{"))
          .pop() ?? "";
      return `${t}: ${seg.replace(/[-_]/g, " ")}`;
    });
    ops.forEach((op, i) => {
      const nav =
        navCount.get(navs[i]!)! > 1
          ? navTitle(op.method, splitSummary(op.summary).title, true)
          : navs[i]!;
      writeFileSync(
        join(dir, `${String(i + 1).padStart(2, "0")}.${op.file}.md`),
        operationPage(op, nav, tagName, seoNames[i]),
      );
      pages++;
    });

    tagSummaries.push(
      `| [${tagName}](/help/developers/api-reference/${slug(tagName)}) | ${ops.length} |`,
    );
  });

  writeFileSync(
    join(OUT_DIR, "index.md"),
    [
      "---",
      'title: "API reference"',
      `description: ${yamlString(`${pages} endpoints across ${tagNames.length} resources, generated from the OpenAPI ${spec.info.version} specification.`)}`,
      "seo:",
      '  title: "Subscription billing API reference"',
      `  description: ${yamlString(
        seoDescription([
          `The Two Minute Billing REST API: ${pages} endpoints across ${tagNames.length} resources, each with a request and a response example`,
          `Generated from the OpenAPI ${spec.info.version} document`,
        ]),
      )}`,
      "---",
      "",
      GENERATED_NOTE,
      "",
      `${pages} endpoints across ${tagNames.length} resources, generated from the OpenAPI ${spec.info.version} document the typed SDK is built from.`,
      "",
      "Every example reads the base URL and key from your shell: set `TMBILLING_URL` to your deployment and `TMBILLING_API_KEY` to a key from **Settings → API keys**. Writes send a fresh `Idempotency-Key`, so a retried request never runs twice.",
      "",
      mdcSafe(spec.info.description ?? ""),
      "",
      "## Resources",
      "",
      ...table(["Resource", "Endpoints"], tagSummaries),
    ].join("\n"),
  );

  // One source for every count the site prints. Webhook events come from the
  // engine's registry, which gen-webhook-reference.ts writes before this runs.
  const webhooks = existsSync(WEBHOOKS_DATA)
    ? (JSON.parse(readFileSync(WEBHOOKS_DATA, "utf8")) as { event_count?: number })
    : {};
  mkdirSync(dirname(STATS_PATH), { recursive: true });
  writeFileSync(
    STATS_PATH,
    JSON.stringify(
      { endpoints: pages, resources: tagNames.length, webhook_events: webhooks.event_count ?? 0 },
      null,
      2,
    ) + "\n",
  );

  console.log(
    `gen-api-reference: ${pages} endpoint pages across ${tagNames.length} resources → ${OUT_DIR}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
