/**
 * A realistic request body for each operation Billy can prepare, built from the operation's
 * request schema in `sdk/openapi.json`, and a stubbed read route that names every record.
 */
import { readFileSync } from "node:fs";
import type { RouteResult } from "@/modules/assistant-tools/route-call";

type Schema = Record<string, unknown>;
type Body = Record<string, unknown>;

const spec = JSON.parse(
  readFileSync(new URL("../../../sdk/openapi.json", import.meta.url), "utf8"),
) as {
  paths: Record<string, Record<string, Schema>>;
  components: { schemas: Record<string, Schema> };
};

const deref = (s: Schema | undefined): Schema | undefined => {
  let x = s;
  for (let i = 0; x?.$ref && i < 10; i++)
    x = spec.components.schemas[String(x.$ref).split("/").pop()!];
  return x;
};

/** Ids the stubbed reads give a name to. */
export const NAMED: Record<string, string> = {
  cus_T1: "Halyard Analytics",
  inv_T1: "INV-0042",
  cn_T1: "CN-0007",
  price_T1: "Pro Monthly",
  cpn_T1: "Launch offer",
  prod_T1: "Pro",
  mtr_T1: "API calls",
  cu_T1: "tokens",
  pm_T1: "Visa ending 4242",
  si_T1: "Pro plan",
  addr_T1: "Warehouse",
  dpol_T1: "Standard dunning",
  con_T1: "Test Contact",
};

const ID_FOR: Record<string, string> = {
  customer: "cus_T1",
  invoice: "inv_T1",
  invoices: "inv_T1",
  invoice_ids: "inv_T1",
  invoice_id: "inv_T1",
  credit_note: "cn_T1",
  price: "price_T1",
  prices: "price_T1",
  price_ids: "price_T1",
  coupon_ids: "cpn_T1",
  product_ids: "prod_T1",
  meters: "mtr_T1",
  unit: "cu_T1",
  payment_method: "pm_T1",
  payment_method_id: "pm_T1",
  item: "si_T1",
  removes: "si_T1",
  shipping_address_id: "addr_T1",
  dunning_policy: "dpol_T1",
  subscription: "sub_T1",
  resource_id: "inv_T1",
  object: "inv_T1",
};

/** Objects the schema leaves open, filled as the API documents them. */
const OPEN: Record<string, Body> = {
  schedule: { every: "week", weekday: 1 },
  overdraft_limit_minor: { INR: 50000 },
  match: { model: "large-v2", token_type: "input" },
  metadata: { plan: "gold" },
  custom_fields: { region: "west" },
  address: { line1: "12 Harbour Road", city: "Pune", postal_code: "411001", country: "IN" },
  shipping_address: { line1: "12 Harbour Road", city: "Pune", country: "IN" },
  client_result: { status: "succeeded" },
  applicability: { kind: "prices", prices: ["price_T1"] },
  changes: { item: "si_T1", price: "price_T1", quantity: 2 },
  adds: { price: "price_T1", quantity: 1 },
};

const DATEY = /(^|_)(at|date|until|end|from|by|timestamp|start)$|^(trial_end|billing_anchor)$/;

function sample(key: string, raw: Schema | undefined, depth = 0): unknown {
  const s = deref(raw);
  if (!s || depth > 5) return "Text";
  const alt = (s.anyOf ?? s.oneOf) as Schema[] | undefined;
  if (alt) return sample(key, alt.find((x) => deref(x)?.type !== "null") ?? alt[0], depth);
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.type === "boolean") return true;
  if (s.type === "integer" || s.type === "number") {
    if (key.endsWith("_minor") || key === "amount" || key === "allocation_amount") return 150000;
    if (key.endsWith("_bps")) return 1250;
    if (
      key !== "billing_date" &&
      (DATEY.test(key) || /unix seconds/i.test(String(s.description ?? "")))
    )
      return 1797638400;
    if (key === "weekday") return 1;
    if (key === "billing_date") return 5;
    return 3;
  }
  if (s.type === "array") {
    const items = deref(s.items as Schema);
    if (OPEN[key] && !items?.properties) return [OPEN[key]];
    return [sample(key, items, depth + 1)];
  }
  if (s.type === "object" || s.properties) {
    const props = s.properties as Record<string, Schema> | undefined;
    if (!props || !Object.keys(props).length) return OPEN[key] ?? { note: "value" };
    return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, sample(k, v, depth + 1)]));
  }
  // `id` is a new record's own id at the top, a credit note inside `credit_notes`.
  if (key === "id") return depth > 0 ? "cn_T1" : "new_record_1";
  if (ID_FOR[key]) return ID_FOR[key];
  if (key === "currency") return "INR";
  if (s.format === "date-time" || DATEY.test(key)) return "2026-12-31T18:30:00Z";
  if (s.format === "email") return "billing@example.com";
  if (s.format === "uri" || key.endsWith("_url")) return "https://example.com/done";
  if (key === "markup_percent") return "20";
  if (key === "unit_amount_decimal") return "0.002";
  return "Text";
}

/** The request schema of an operation, matching `{param}` names loosely. */
export function requestSchema(operation: string): Schema | undefined {
  const [method, path] = operation.split(" ");
  const want = `/v1/businesses/{biz}/${path}`.replace(/\{\w+\}/g, "{}");
  for (const [p, item] of Object.entries(spec.paths))
    if (p.replace(/\{\w+\}/g, "{}") === want) {
      const op = item[method!.toLowerCase()] as Schema | undefined;
      const body = (op?.requestBody as Schema | undefined)?.content as
        | Record<string, Schema>
        | undefined;
      return deref(body?.["application/json"]?.schema as Schema) ?? {};
    }
  return undefined;
}

/** A body with every field the schema lists. */
export function sampleBody(operation: string): Body {
  const s = requestSchema(operation);
  const props = (s?.properties ?? {}) as Record<string, Schema>;
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, sample(k, v)]));
}

export function sampleParams(operation: string): Record<string, string> {
  return Object.fromEntries(
    [...operation.matchAll(/\{(\w+)\}/g)].map(([, p]) => [
      p!,
      {
        cus: "cus_T1",
        sub: "sub_T1",
        inv: "inv_T1",
        cn: "cn_T1",
        item: "si_T1",
        con: "con_T1",
        addr: "addr_T1",
      }[p!] ?? `${p}_T1`,
    ]),
  );
}

/** Every enum and boolean in a schema, by `parent.child` path. */
export function choiceFields(operation: string): Array<{ path: string[]; values: unknown[] }> {
  const out: Array<{ path: string[]; values: unknown[] }> = [];
  const walk = (s: Schema | undefined, path: string[]) => {
    const x = deref(s);
    if (!x || path.length > 3) return;
    if (Array.isArray(x.enum)) out.push({ path, values: x.enum });
    else if (x.type === "boolean") out.push({ path, values: [true, false] });
    else if (x.properties)
      for (const [k, v] of Object.entries(x.properties as Record<string, Schema>))
        walk(v, [...path, k]);
  };
  for (const [k, v] of Object.entries(
    (requestSchema(operation)?.properties ?? {}) as Record<string, Schema>,
  ))
    walk(v, [k]);
  return out;
}

const RECORDS: Record<string, Body> = {
  "customers/cus_T1": { name: "Halyard Analytics", currency: "INR" },
  "subscriptions/sub_T1": {
    currency: "INR",
    customer: "cus_T1",
    items: [{ id: "si_T1", product_name: "Pro plan" }],
  },
  "invoices/inv_T1": { number: "INV-0042", currency: "INR", customer: "cus_T1" },
  "credit_notes/cn_T1": { number: "CN-0007", currency: "INR" },
  "payment_requests/preq_T1": { currency: "INR", customer: "cus_T1" },
  "prices/price_T1": { name: "Pro Monthly" },
  "coupons/cpn_T1": { name: "Launch offer", code: "LAUNCH" },
  "products/prod_T1": { name: "Pro" },
  "meters/mtr_T1": { name: "API calls" },
  "credit_units/cu_T1": { plural_name: "tokens", decimals: 0 },
  "customers/cus_T1/payment_methods/pm_T1": { brand: "visa", last4: "4242" },
  "dunning_policies/dpol_T1": { name: "Standard dunning" },
  "customers/cus_T1/contacts": {
    data: [{ id: "con_T1", first_name: "Test", last_name: "Contact" }],
  },
  "customers/cus_T1/shipping_addresses": { data: [{ id: "addr_T1", label: "Warehouse" }] },
};

/** The read route, stubbed: each record above, else 404. */
export const stubGet = async (rel: string): Promise<RouteResult> =>
  (RECORDS[rel]
    ? { status: 200, body: RECORDS[rel] }
    : { status: 404, body: { error: { message: "No such record" } } }) as RouteResult;
