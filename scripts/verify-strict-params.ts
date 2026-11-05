/**
 * Unknown request keys are refused (`API_UNKNOWN_PARAMS=reject`), named by path, and the
 * free-form carve-outs still take anything — and the one external integration keeps
 * getting back every field it reads.
 *
 *  A. Every request shape the external integration sends today, key for key, is
 *     accepted — none answers `Unknown parameter` — and each response carries the fields
 *     that integration reads, with the type and unit it expects (ISO 8601 strings, integer
 *     minor units, public ids as bare strings, `cf_*` flattened onto the object).
 *  A2. The semantics it relies on: an end-of-term cancel leaves the subscription live,
 *     a deferred reactivate raises no charge, `applied.removed` names the removed price,
 *     `email[is]` is exact, `status[is]` filters, a keyed create replays byte-identical,
 *     and credential mints (portal, checkout) work twice with fresh keys.
 *  A3. The outbound events it handles, delivered through the real outbox path: envelope
 *     (`id`, `event_type`, ISO `occurred_at`, signature header) and the `content.*` keys
 *     it reads to find the customer, subscription, payment and payment source.
 *  B. Unknown keys → 400 `Unknown parameter: <path>`: top level, nested object, array item,
 *     zod-parsed query; the old `.strict()` body names its key the same way.
 *  C. Carve-outs: metadata / custom_fields values, top-level `cf_*`, round-tripped settings
 *     objects.
 *  D. `API_UNKNOWN_PARAMS=warn` accepts the same request and ignores the key, as before.
 *  F. Value bounds: new coupon codes, item quantities, money amounts and usage quantities.
 *
 *   pnpm verify:strict-params
 */
import { createServer } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { config } from "@/platform/config";
import { createOrganization, getBusinessByPublicId } from "@/modules/tenancy/service";
import { createCoupon } from "@/modules/coupons/service";
import { inviteUser, signup } from "@/modules/auth/service";
import { pinMfaMandateOff } from "./lib/mfa-policy";
import { createEndpoint } from "@/modules/webhooks/endpoints";
import { attemptDelivery, signPayload } from "@/modules/webhooks/outbox";
import { sampleEventData } from "@/modules/events/registry";
import { events, webhookDeliveries, webhookEndpoints } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean, detail?: string) => {
  checks.push([n, c]);
  if (!c && detail) console.log(`    ${n}: ${detail}`);
};
/**
 * A field the integration reads that the engine has never sent. Tolerated on its side (it
 * falls back), so it is reported on every run rather than failed; once one closes, the line
 * says so and it belongs in `ok`.
 */

// The integration refuses a portal or checkout session with no `url`, so the url is part
// of the contract under test; a deployment serving it always sets this.
const mutableConfig = config as { PORTAL_BASE_URL?: string };
mutableConfig.PORTAL_BASE_URL ??= "https://portal.example.com";

// Receiver for the outbound events (A3). Records the raw body so the signature can be
// checked against exactly the bytes that were signed.
const received: Array<{ headers: Record<string, unknown>; raw: string }> = [];
const receiver = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    received.push({ headers: req.headers, raw });
    res.writeHead(200).end("ok");
  });
});
await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
const hookUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook`;

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const org = await createOrganization({ name: "Strict Params Co" });
const orgId = org.organization.id;
const endpoint = await createEndpoint({ organizationId: orgId, url: hookUrl, livemode: "test" });

let idem = 0;
type Res = { status: number; body: Record<string, any>; raw: string };
async function call(method: string, path: string, body?: unknown, key?: string): Promise<Res> {
  const r = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${org.secret}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "idempotency-key": key ?? `strict-${Date.now()}-${++idem}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {}, raw: text };
}
const msg = (r: Res) => String(r.body?.error?.message ?? "");
const unknownParam = (r: Res) => r.status === 400 && /Unknown parameter/.test(msg(r));
const shape = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
/** A: accepted — and, unless a business rule says otherwise, 2xx. */
const accepted = (name: string, r: Res) => {
  ok(`${name}: no unknown parameter`, !unknownParam(r), shape(r));
  ok(`${name}: 2xx`, r.status >= 200 && r.status < 300, shape(r));
  return r;
};

// ── Field contract ──────────────────────────────────────────────────────────
// `kind` is required-and-non-null; `kind?` is present-but-nullable. Presence matters even
// for nullable fields: the integration stores these objects verbatim, and a key that
// vanishes reads downstream as "this vendor has no such concept".
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
function isKind(v: unknown, kind: string): boolean {
  switch (kind) {
    case "iso":
      return typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
    case "int":
      return Number.isInteger(v);
    case "array":
      return Array.isArray(v);
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    default:
      return typeof v === kind;
  }
}
function fields(
  name: string,
  obj: unknown,
  spec: Record<string, string>,
  report: (n: string, c: boolean, d?: string) => void = ok,
) {
  const bad: string[] = [];
  if (!obj || typeof obj !== "object") bad.push(`not an object: ${JSON.stringify(obj)}`);
  else
    for (const [path, want] of Object.entries(spec)) {
      const nullable = want.endsWith("?");
      const kind = nullable ? want.slice(0, -1) : want;
      let cur: any = obj;
      let present = true;
      for (const seg of path.split(".")) {
        if (cur == null || typeof cur !== "object" || !(seg in cur)) {
          present = false;
          break;
        }
        cur = cur[seg];
      }
      if (!present) bad.push(`${path} missing`);
      else if (cur === null) {
        if (!nullable) bad.push(`${path} is null`);
      } else if (!isKind(cur, kind)) bad.push(`${path}: want ${kind}, got ${JSON.stringify(cur)}`);
    }
  report(`${name}: ${Object.keys(spec).length} fields`, bad.length === 0, bad.join("; "));
}

const CUSTOMER = {
  id: "string",
  email: "string?",
  first_name: "string?",
  last_name: "string?",
  auto_collection: "string",
};
/** Every subscription field the integration maps; all timestamps ISO, money minor units. */
const SUBSCRIPTION = {
  id: "string",
  status: "string",
  currency: "string",
  customer: "string",
  metadata: "object?",
  current_period_start: "iso?",
  current_period_end: "iso?",
  trial_start: "iso?",
  trial_end: "iso?",
  billing_period: "int?",
  billing_period_unit: "string?",
  next_billing_at: "iso?",
  cancel_at_period_end: "boolean?",
  canceled_at: "iso?",
  cancel_reason: "string?",
  cancel_reason_code: "string?",
  start_date: "iso?",
  started_at: "iso?",
  activated_at: "iso?",
  remaining_billing_cycles: "int?",
  auto_collection: "string?",
  create_pending_invoices: "boolean?",
  net_term_days: "int?",
  po_number: "string?",
  invoice_notes: "string?",
  mrr: "int?",
  due_invoices_count: "int?",
  total_dues_minor: "int?",
  due_since: "iso?",
  created_at: "iso",
  updated_at: "iso",
  resource_version: "int?",
};
const ITEM = {
  price: "string",
  quantity: "int",
  product_kind: "string",
  unit_price_minor: "int?",
  free_quantity: "int?",
  billing_cycles: "int?",
};
const INVOICE = {
  id: "string",
  status: "string",
  customer: "string",
  subscription: "string?",
  currency: "string",
  total_minor: "int",
  amount_paid_minor: "int",
  amount_due_minor: "int",
  created_at: "iso",
};
const TRANSACTION = {
  id: "string",
  type: "string",
  status: "string",
  amount_minor: "int",
  currency: "string",
  gateway_key: "string?",
  payment_method: "object?",
};
const PORTAL = {
  id: "string",
  token: "string",
  url: "string",
  expires_at: "iso",
  access_expires_at: "iso",
};
const CHECKOUT = {
  id: "string",
  mode: "string",
  token: "string",
  url: "string",
  expires_at: "iso",
};

const fieldsMissing = (o: any, keys: string[]) =>
  `absent: ${keys.filter((k) => !(o && typeof o === "object" && k in o)).join(", ") || "none"}`;
function subscriptionFields(name: string, s: Record<string, any>, withItems = true) {
  fields(name, s, SUBSCRIPTION);
  if (!withItems) return;
  ok(
    `${name}: items is a non-empty array`,
    Array.isArray(s?.items) && s.items.length > 0,
    JSON.stringify(s?.items),
  );
  (s?.items ?? []).forEach((it: unknown, i: number) => fields(`${name}: items[${i}]`, it, ITEM));
}
const flatCf = (name: string, o: Record<string, any>, key: string, want: string) =>
  ok(
    `${name}: custom field flattened as ${key}`,
    o?.[key] === want,
    JSON.stringify(o).slice(0, 300),
  );

// ── Fixtures ────────────────────────────────────────────────────────────────
const biz = await call("POST", "/v1/businesses", {
  name: "Strict Biz",
  default_currency: "USD",
  livemode: "test",
});
const B = `/v1/businesses/${biz.body.id}`;
const plan = await call("POST", `${B}/products`, { name: "Pro" });
const price = await call("POST", `${B}/prices`, {
  product: plan.body.id,
  model: "flat",
  currency: "USD",
  amount_minor: 3000,
  interval: "month",
});
const addon = await call("POST", `${B}/products`, {
  name: "Extra seat",
  kind: "addon",
  addon_applies_to_all: true,
});
const addonPrice = await call("POST", `${B}/prices`, {
  product: addon.body.id,
  model: "flat",
  currency: "USD",
  amount_minor: 500,
  interval: "month",
});
const coupon = await call("POST", `${B}/coupons`, {
  code: "WELCOME10",
  kind: "percentage",
  percent_off_bps: 1000,
  duration_type: "forever",
});
await call("POST", `${B}/custom_field_definitions`, {
  entity_type: "customer",
  api_name: "signedup_from",
  label: "Signed up from",
  data_type: "string",
});
ok(
  "fixtures created",
  [biz, plan, price, addon, addonPrice, coupon].every((r) => r.status < 300),
  [biz, plan, price, addon, addonPrice, coupon].map(shape).join(" | "),
);
const P = price.body.id as string;
const AP = addonPrice.body.id as string;

// ── A. The external integration's request shapes and the fields it reads ────
const defs = accepted(
  "GET custom_field_definitions?limit",
  await call("GET", `${B}/custom_field_definitions?limit=100`),
);
{
  const rows: Array<Record<string, any>> = defs.body.data ?? [];
  // It reads `entity ?? entity_type` and `api_name ?? apiName`, keeping `customer` rows.
  const names = rows
    .filter((d) => `${d.entity ?? d.entity_type}` === "customer")
    .map((d) => d.api_name ?? d.apiName);
  ok(
    "custom field definitions: data[] carries entity + api_name",
    names.includes("signedup_from"),
    shape(defs),
  );
}

const email = "buyer@example.com";
const cusBody = {
  email,
  currency: "USD",
  address: { country: "US" },
  first_name: "Ada",
  last_name: "Lovelace",
  company: "Analytical Engines",
  custom_fields: { signedup_from: "web" },
};
const cusKey = `strict-cus-${Date.now()}`;
const cus = accepted("POST customers", await call("POST", `${B}/customers`, cusBody, cusKey));
fields("POST customers", cus.body, CUSTOMER);
flatCf("POST customers", cus.body, "cf_signedup_from", "web");
const C = cus.body.id as string;
{
  // A permanent create key: the same key + body replays the SAME customer, byte for byte.
  const again = await call("POST", `${B}/customers`, cusBody, cusKey);
  // Same object, not the same bytes: the stored replay comes back with its keys reordered.
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon((v as any)[k])]),
          )
        : v;
  ok(
    "customer create replay: same key + body → same status, same object",
    again.status === cus.status &&
      JSON.stringify(canon(again.body)) === JSON.stringify(canon(cus.body)),
    `${shape(again)} vs ${shape(cus)}`,
  );
}
// Look-alike addresses the exact match must not return.
await call("POST", `${B}/customers`, { email: "abuyer@example.com" });
await call("POST", `${B}/customers`, { email: "buyer.alt@example.com" });

const sub = accepted(
  "POST subscriptions (coupon_ids, trial_days, metadata)",
  await call("POST", `${B}/customers/${C}/subscriptions`, {
    items: [{ price: P, quantity: 1, unit_price_minor: 3000 }],
    coupon_ids: ["WELCOME10"],
    trial_days: 14,
    auto_collection: "off",
    metadata: { core_destination: "gs", nested: { any: ["thing"] } },
  }),
);
// Mapped directly when it carries items (it does), so every mapped field is read off it.
{
  const {
    customer: _c,
    due_invoices_count: _d,
    total_dues_minor: _t,
    due_since: _s,
    ...sent
  } = SUBSCRIPTION;
  fields("POST subscriptions", sub.body, sent);
  ok(
    "POST subscriptions: items carry price + quantity + unit_price_minor",
    (sub.body.items ?? []).length > 0 &&
      sub.body.items.every(
        (i: any) =>
          typeof i.price === "string" && Number.isInteger(i.quantity) && "unit_price_minor" in i,
      ),
    JSON.stringify(sub.body.items),
  );
  const top = ["customer", "due_invoices_count", "total_dues_minor", "due_since"];
  ok(
    `POST subscriptions: ${top.join(", ")}`,
    top.every((k) => k in sub.body) && sub.body.customer === C,
    fieldsMissing(sub.body, top),
  );
  const item = ["product_kind", "free_quantity", "billing_cycles"];
  const it0 = sub.body.items?.[0] ?? {};
  ok(
    `POST subscriptions: items[].${item.join(", ")} (plan item is product_kind plan)`,
    item.every((k) => k in it0) && it0.product_kind === "plan",
    fieldsMissing(it0, item),
  );
}
const S1 = sub.body.id as string;

const s1 = accepted("GET subscription", await call("GET", `${B}/subscriptions/${S1}`));
subscriptionFields("GET subscription", s1.body);
ok(
  "GET subscription: customer is the bare public id",
  s1.body.customer === C,
  String(s1.body.customer),
);
ok(
  "GET subscription: metadata round-trips",
  s1.body.metadata?.core_destination === "gs",
  JSON.stringify(s1.body.metadata),
);
ok(
  "GET subscription: in trial — trial_* set, next_billing_at set",
  s1.body.status === "in_trial" &&
    !!s1.body.trial_start &&
    !!s1.body.trial_end &&
    !!s1.body.next_billing_at,
  shape(s1),
);
{
  const planItem = (s1.body.items ?? []).find((i: any) => i.price === P);
  ok(
    "GET subscription: plan item — price id, product_kind plan, unit_price_minor in minor units",
    planItem?.product_kind === "plan" &&
      planItem?.unit_price_minor === 3000 &&
      planItem?.quantity === 1,
    JSON.stringify(planItem),
  );
}

const gc = accepted("GET customer", await call("GET", `${B}/customers/${C}`));
fields("GET customer", gc.body, CUSTOMER);
flatCf("GET customer", gc.body, "cf_signedup_from", "web");
ok(
  "GET customer: names as sent",
  gc.body.first_name === "Ada" && gc.body.last_name === "Lovelace" && gc.body.email === email,
  shape(gc),
);

const byEmail = accepted(
  "GET customers?email[is]&limit",
  await call("GET", `${B}/customers?email[is]=${encodeURIComponent(email)}&limit=2`),
);
ok(
  "email[is] is an exact match (look-alikes excluded)",
  byEmail.body.data?.length === 1 && byEmail.body.data[0].id === C,
  shape(byEmail),
);
fields("GET customers?email[is]: data[0]", byEmail.body.data?.[0], CUSTOMER);

const sub2 = await call("POST", `${B}/customers/${C}/subscriptions`, {
  items: [{ price: P, quantity: 1 }],
  auto_collection: "off",
});
const S2 = sub2.body.id as string;
const cancel1 = accepted(
  "POST cancel (at_period_end + reason)",
  await call("POST", `${B}/subscriptions/${S1}/cancel`, {
    at_period_end: true,
    cancel_reason_code: "too_expensive",
    cancel_reason: "Budget",
  }),
);
ok(
  "cancel at_period_end on a trial: still live, not cancelled",
  cancel1.body.status !== "cancelled" &&
    (cancel1.body.status === "non_renewing" || cancel1.body.cancel_at_period_end === true),
  shape(cancel1),
);
accepted(
  "POST cancel (cancel_option + credit_option_for_current_term_charges)",
  await call("POST", `${B}/subscriptions/${S2}/cancel`, {
    at_period_end: false,
    cancel_option: "immediately",
    credit_option_for_current_term_charges: "prorate",
  }),
);
const invoicesOf = async (s: string) =>
  ((await call("GET", `${B}/invoices?subscription=${s}&limit=100`)).body.data ?? []) as Array<
    Record<string, any>
  >;
const s2InvoicesBefore = await invoicesOf(S2);
const react = accepted(
  "POST reactivate (charges_handling + trial_end)",
  await call("POST", `${B}/subscriptions/${S2}/reactivate`, {
    charges_handling: "add_to_unbilled_charges",
    trial_end: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  }),
);
{
  const after = await invoicesOf(S2);
  const before = new Set(s2InvoicesBefore.map((i) => i.id));
  const raised = after.filter((i) => !before.has(i.id) && Number(i.total_minor) !== 0);
  ok(
    "reactivate add_to_unbilled_charges: no invoice charge raised",
    raised.length === 0,
    JSON.stringify(raised.map((i) => [i.id, i.status, i.total_minor])),
  );
  const live = await call("GET", `${B}/subscriptions/${S2}`);
  ok(
    "reactivate: subscription is live again",
    ["active", "in_trial"].includes(live.body.status),
    `${shape(react)} → ${live.body.status}`,
  );
}
const pr = accepted("GET price", await call("GET", `${B}/prices/${encodeURIComponent(P)}`));
fields("GET price", pr.body, { amount_minor: "int" });
ok(
  "GET price: amount_minor is the list price in minor units",
  pr.body.amount_minor === 3000,
  shape(pr),
);
const pmsEmpty = accepted(
  "GET payment_methods",
  await call("GET", `${B}/customers/${C}/payment_methods`),
);
ok(
  "GET payment_methods: data[] (empty for no card)",
  Array.isArray(pmsEmpty.body.data),
  shape(pmsEmpty),
);

const live = await call("POST", `${B}/customers/${C}/subscriptions`, {
  items: [{ price: P, quantity: 1 }],
  auto_collection: "off",
});
const S3 = live.body.id as string;
const changeBody = {
  mode: "change",
  subscription: S3,
  items: [{ price: P, quantity: 1 }],
  coupons: ["WELCOME10"],
  replace_items_list: true,
  reset_term: true,
  metadata: { core_destination: "gds" },
};
const co = accepted(
  "POST checkout_sessions (change, coupons, replace_items_list, reset_term, metadata)",
  await call("POST", `${B}/checkout_sessions`, changeBody),
);
fields("POST checkout_sessions", co.body, CHECKOUT);
{
  // Minted per attempt with a fresh key: a second mint for the same change must work.
  const co2 = await call("POST", `${B}/checkout_sessions`, changeBody);
  ok(
    "checkout mint twice with fresh keys: both 2xx, distinct tokens",
    co2.status < 300 && !!co2.body.token && co2.body.token !== co.body.token,
    shape(co2),
  );
}
accepted(
  "PATCH subscription metadata",
  await call("PATCH", `${B}/subscriptions/${S3}`, { metadata: { core_destination: "gs" } }),
);
const pc = accepted(
  "PATCH customer (email, names)",
  await call("PATCH", `${B}/customers/${C}`, {
    email: "buyer2@example.com",
    first_name: "Ada",
    last_name: "King",
  }),
);
fields("PATCH customer", pc.body, CUSTOMER);
ok("PATCH customer: email changed", pc.body.email === "buyer2@example.com", shape(pc));
const portalEmail = accepted(
  "POST portal_sessions (link_kind)",
  await call("POST", `${B}/customers/${C}/portal_sessions`, { link_kind: "email" }),
);
fields("POST portal_sessions (email)", portalEmail.body, PORTAL);
const portalApi = accepted(
  "POST portal_sessions ({})",
  await call("POST", `${B}/customers/${C}/portal_sessions`, {}),
);
fields("POST portal_sessions ({})", portalApi.body, PORTAL);
{
  const linkMs = (r: Res) => Date.parse(r.body.access_expires_at) - Date.now();
  ok(
    "portal link_kind email outlives the default link by days",
    linkMs(portalEmail) > 86_400_000 && linkMs(portalApi) < 86_400_000,
    `${portalEmail.body.access_expires_at} vs ${portalApi.body.access_expires_at}`,
  );
  ok(
    "portal mint twice with fresh keys: distinct tokens",
    portalApi.body.token !== portalEmail.body.token,
  );
}
const ufi1 = accepted(
  "POST update_for_items (add, metadata, prorate, invoice_immediately)",
  await call("POST", `${B}/subscriptions/${S3}/update_for_items`, {
    items: [
      { price: P, quantity: 1 },
      { price: AP, quantity: 1 },
    ],
    metadata: { core_destination: "gs" },
    prorate: false,
    invoice_immediately: false,
  }),
);
// Mapped straight into the stored subscription, so it must be the full object with items.
subscriptionFields("POST update_for_items", ufi1.body);
fields("POST update_for_items: applied", ufi1.body, {
  applied: "object",
  "applied.removed": "array",
});
const ufi2 = accepted(
  "POST update_for_items (mandatory_items_to_remove)",
  await call("POST", `${B}/subscriptions/${S3}/update_for_items`, {
    items: [{ price: P, quantity: 1 }],
    mandatory_items_to_remove: [AP],
    prorate: false,
    invoice_immediately: false,
  }),
);
subscriptionFields("POST update_for_items (remove)", ufi2.body);
ok(
  "update_for_items: applied.removed names the removed PRICE id",
  Array.isArray(ufi2.body.applied?.removed) && ufi2.body.applied.removed.includes(AP),
  JSON.stringify(ufi2.body.applied),
);
ok(
  "update_for_items: removed price is gone from items",
  !(ufi2.body.items ?? []).some((i: any) => i.price === AP),
  JSON.stringify(ufi2.body.items),
);
const invs = await call("GET", `${B}/invoices?subscription=${S3}&limit=5`);
const inv = invs.body.data?.[0]?.id as string | undefined;
ok("an invoice to read", !!inv, shape(invs));
const gi = accepted("GET invoice", await call("GET", `${B}/invoices/${inv}`));
fields("GET invoice", gi.body, INVOICE);
ok(
  "GET invoice: customer + subscription are bare public ids",
  gi.body.customer === C && gi.body.subscription === S3,
  shape(gi),
);
const txnsOffline = accepted(
  "GET transactions?invoice&limit",
  await call("GET", `${B}/transactions?invoice=${encodeURIComponent(inv ?? "")}&limit=20`),
);
ok("GET transactions: data[]", Array.isArray(txnsOffline.body.data), shape(txnsOffline));
const paidOffline = accepted(
  "GET invoices?subscription&status[is]&limit",
  await call("GET", `${B}/invoices?subscription=${S3}&status%5Bis%5D=paid&limit=2`),
);
ok(
  "status[is]=paid excludes an unpaid invoice",
  paidOffline.body.data?.length === 0 && (invs.body.data?.length ?? 0) > 0,
  `${shape(paidOffline)} of ${invs.body.data?.length}`,
);
const subsOf = accepted(
  "GET subscriptions?customer&limit",
  await call("GET", `${B}/subscriptions?customer=${C}&limit=100`),
);
{
  const rows: Array<Record<string, any>> = subsOf.body.data ?? [];
  ok(
    "GET subscriptions?customer: all of this customer's",
    rows.length === 3 && rows.every((r) => r.customer === C),
    shape(subsOf),
  );
  // List rows are read for id + status only; the full object is re-read by id.
  rows.forEach((r, i) =>
    fields(`GET subscriptions?customer: data[${i}]`, r, { id: "string", status: "string" }),
  );
}

// A card-paying customer: the paid-invoice, transaction and payment-method reads.
let paidTxn: Record<string, any> | null = null;
const payer = await call("POST", `${B}/customers`, { email: "payer@example.com", currency: "USD" });
const CP = payer.body.id as string;
const vault = await call("POST", `${B}/customers/${CP}/payment_methods`, { token: "tok_4242" });
ok("card vaulted", vault.status < 300, shape(vault));
const pms = accepted(
  "GET payment_methods (card)",
  await call("GET", `${B}/customers/${CP}/payment_methods`),
);
fields("GET payment_methods: data[0]", pms.body.data?.[0], {
  status: "string",
  gateway_account: "string?",
});
const paidSub = await call("POST", `${B}/customers/${CP}/subscriptions`, {
  items: [{ price: P, quantity: 1 }],
});
ok(
  "card subscription created and active",
  paidSub.status < 300 && paidSub.body.status === "active",
  shape(paidSub),
);
const SP = paidSub.body.id as string;
{
  const all = await invoicesOf(SP);
  const paid = await call("GET", `${B}/invoices?subscription=${SP}&status%5Bis%5D=paid&limit=2`);
  ok(
    "status[is]=paid selects the paid invoice",
    paid.body.data?.length >= 1 && paid.body.data.every((i: any) => i.status === "paid"),
    `${shape(paid)} of ${all.length}`,
  );
  const pinv = paid.body.data?.[0]?.id as string | undefined;
  const g = await call("GET", `${B}/invoices/${pinv}`);
  fields("GET invoice (paid)", g.body, INVOICE);
  ok(
    "paid invoice: amount_paid_minor = total_minor, amount_due_minor 0",
    g.body.amount_paid_minor === g.body.total_minor &&
      g.body.amount_due_minor === 0 &&
      g.body.total_minor > 0,
    shape(g),
  );
  const t = await call(
    "GET",
    `${B}/transactions?invoice=${encodeURIComponent(pinv ?? "")}&limit=20`,
  );
  const txns: Array<Record<string, any>> = t.body.data ?? [];
  const pay = txns.find((x) => x.type === "payment");
  fields("GET transactions (paid): the payment", pay, TRANSACTION);
  fields("GET transactions (paid): gateway + card", pay, {
    gateway_key: "string",
    "payment_method.brand": "string",
    "payment_method.last4": "string",
  });
  ok(
    "paid transaction: settled status is `succeeded`",
    pay?.status === "succeeded",
    JSON.stringify(pay),
  );
  paidTxn = pay ?? null;
  ok(
    "GET transactions: instrument.type / instrument.mandate_rail (a card reports type card)",
    !!pay &&
      pay.instrument?.type === "card" &&
      "mandate_rail" in (pay.instrument ?? {}) &&
      typeof pay.payment_method?.brand === "string",
    JSON.stringify(pay?.instrument),
  );
}
{
  // The term-end cancel on a live, billed subscription — the integration's cancel button.
  const c = await call("POST", `${B}/subscriptions/${SP}/cancel`, { at_period_end: true });
  ok(
    "cancel at_period_end on an active sub: non_renewing + cancel_at_period_end, not cancelled",
    c.status < 300 && c.body.status === "non_renewing" && c.body.cancel_at_period_end === true,
    shape(c),
  );
  // A text/plain body is refused before the route runs, so it cannot act as an empty body.
  const plain = await fetch(`${base}${B}/subscriptions/${SP}/remove_scheduled_cancellation`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${org.secret}`,
      "content-type": "text/plain",
      "idempotency-key": `strict-plain-${Date.now()}`,
    },
    body: JSON.stringify({ billing_cycles: "x" }),
  });
  const plainBody = (await plain.json()) as { error?: { type?: string; message?: string } };
  ok(
    "text/plain body on a write route → 415 in the error envelope",
    plain.status === 415 && plainBody.error?.type === "invalid_request_error",
    `${plain.status} ${JSON.stringify(plainBody)}`,
  );
  const still = await call("GET", `${B}/subscriptions/${SP}`);
  ok(
    "the refused text/plain call changed nothing",
    still.body.status === "non_renewing",
    shape(still),
  );
  const badJson = await call("POST", `${B}/subscriptions/${SP}/remove_scheduled_cancellation`, {
    billing_cycles: "x",
  });
  ok("the same bytes as JSON are validated → 400", badJson.status === 400, shape(badJson));
  const back = await call("POST", `${B}/subscriptions/${SP}/remove_scheduled_cancellation`, {});
  ok(
    "remove_scheduled_cancellation: active again",
    back.status < 300 && back.body.status === "active",
    shape(back),
  );
}
// A charge that fails at signup: the payment_failed the integration mails about.
const decliner = await call("POST", `${B}/customers`, {
  email: "decliner@example.com",
  currency: "USD",
});
await call("POST", `${B}/customers/${decliner.body.id}/payment_methods`, {
  token: "tok_4000000000000341",
});
const declined = await call("POST", `${B}/customers/${decliner.body.id}/subscriptions`, {
  items: [{ price: P, quantity: 1 }],
});
ok("declining card: create refused", declined.status === 402, shape(declined));

// ── A3. The outbound events the integration handles ─────────────────────────
{
  const pending = await systemDb
    .select({ d: webhookDeliveries, e: events, ep: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(events, eq(events.id, webhookDeliveries.eventId))
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(
      and(
        eq(webhookDeliveries.organizationId, orgId),
        inArray(webhookDeliveries.status, ["pending"]),
      ),
    );
  // A worker attached to this database may claim some first; it POSTs to the same receiver.
  for (const row of pending) {
    await attemptDelivery({
      delivery: row.d,
      event: row.e,
      endpoint: row.ep,
      now: new Date(),
      timeoutMs: 5000,
    });
  }
  const total = (
    await systemDb
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.organizationId, orgId))
  ).length;
  for (let i = 0; i < 50 && received.length < total; i++)
    await new Promise((r) => setTimeout(r, 100));
  ok(
    `events delivered to the receiver (${received.length}/${total})`,
    received.length >= total && total > 0,
  );

  const bodies = received.map((r) => ({ ...r, evt: JSON.parse(r.raw) as Record<string, any> }));
  const bad = bodies.filter(
    (b) =>
      b.headers["tmbilling-signature"] !== signPayload(endpoint.secret, b.raw) ||
      b.headers["tmbilling-event-id"] !== b.evt.id,
  );
  ok(
    "every event: Tmbilling-Signature = sha256 HMAC of the raw body, Tmbilling-Event-Id = id",
    bad.length === 0,
    bad.map((b) => b.evt.event_type).join(","),
  );
  const envBad = bodies.filter(
    (b) =>
      typeof b.evt.id !== "string" ||
      typeof b.evt.event_type !== "string" ||
      !isKind(b.evt.occurred_at, "iso") ||
      !isKind(b.evt.content, "object"),
  );
  ok(
    "every event: id, event_type, ISO occurred_at, content object",
    envBad.length === 0,
    envBad.map((b) => b.raw.slice(0, 200)).join(" | "),
  );

  const byType = new Map<string, Array<Record<string, any>>>();
  for (const b of bodies)
    byType.set(b.evt.event_type, [...(byType.get(b.evt.event_type) ?? []), b.evt]);
  console.log(`    events seen: ${[...byType.keys()].sort().join(", ")}`);

  // Types the integration acts on, and whether this replay must produce each.
  const SUB_EVENTS = [
    "subscription_created",
    "subscription_started",
    "subscription_activated",
    "subscription_changed",
    "subscription_reactivated",
    "subscription_renewed",
    "subscription_canceled",
    "subscription_cancel_scheduled",
    "subscription_scheduled_cancellation_removed",
  ];
  const MUST = [
    "subscription_created",
    "subscription_changed",
    "subscription_reactivated",
    "subscription_canceled",
    "subscription_cancel_scheduled",
    "subscription_scheduled_cancellation_removed",
    "payment_succeeded",
    "payment_source_added",
    "customer_updated",
  ];
  for (const t of MUST) ok(`event produced: ${t}`, byType.has(t), [...byType.keys()].join(","));

  for (const t of SUB_EVENTS)
    (byType.get(t) ?? []).forEach((e, i) =>
      fields(`${t}[${i}]: content.subscription.id`, e.content, {
        subscription: "object",
        "subscription.id": "string",
      }),
    );
  for (const t of ["payment_succeeded", "payment_failed"])
    (byType.get(t) ?? []).forEach((e, i) => {
      fields(`${t}[${i}]: content.payment`, e.content, {
        payment: "object",
        "payment.id": "string",
        "payment.amount_minor": "int",
        "payment.status": "string",
      });
      // The customer is found via content.customer.id, else through the invoice.
      const invoiceRef = e.content?.payment?.invoice ?? e.content?.invoice?.id ?? null;
      ok(
        `${t}[${i}]: names its invoice or its customer`,
        typeof invoiceRef === "string" || typeof e.content?.customer?.id === "string",
        JSON.stringify(e.content).slice(0, 300),
      );
    });
  (byType.get("payment_succeeded") ?? []).forEach((e, i) =>
    fields(`payment_succeeded[${i}]: content.payment.invoice`, e.content, {
      "payment.invoice": "string",
    }),
  );
  {
    // It picks the transaction whose id equals content.payment.id, else falls back.
    const e = (byType.get("payment_succeeded") ?? []).find(
      (x) => x.content?.payment?.invoice === paidTxn?.invoice,
    );
    ok(
      "payment_succeeded: content.payment.id is the transaction's reference_payment",
      !!e && e.content.payment.id === paidTxn?.reference_payment,
      JSON.stringify(e?.content?.payment),
    );
  }
  for (const t of ["payment_source_added", "payment_source_updated", "payment_source_expired"])
    (byType.get(t) ?? []).forEach((e, i) => {
      fields(`${t}[${i}]: content.payment_source`, e.content, {
        payment_source: "object",
        "payment_source.id": "string",
        "payment_source.type": "string",
        "payment_source.status": "string",
        "payment_source.brand": "string?",
        "payment_source.last4": "string?",
        "payment_source.exp_month": "int?",
        "payment_source.exp_year": "int?",
      });
      ok(
        `${t}[${i}]: names its customer (payment_source.customer or customer.id)`,
        typeof (e.content?.customer?.id ?? e.content?.payment_source?.customer) === "string",
        JSON.stringify(e.content).slice(0, 300),
      );
    });
  (byType.get("customer_updated") ?? []).forEach((e, i) =>
    fields(`customer_updated[${i}]: content.customer.id`, e.content, {
      customer: "object",
      "customer.id": "string",
    }),
  );
  ok(
    "customer_updated after the email edit carries the NEW address",
    (byType.get("customer_updated") ?? []).some(
      (e) => e.content?.customer?.id === C && e.content?.customer?.email === "buyer2@example.com",
    ),
  );
  ok(
    "test-send payload is marked content.test = true",
    sampleEventData("subscription_created").test === true,
  );
}

// ── B. Unknown keys are refused by name ─────────────────────────────────────
const top = await call("POST", `${B}/customers`, { email: "x@example.com", nickname: "x" });
ok(
  "top-level unknown key → 400 Unknown parameter: nickname",
  top.status === 400 &&
    msg(top) === "Unknown parameter: nickname" &&
    top.body.error?.type === "invalid_request_error",
  shape(top),
);
const nested = await call("POST", `${B}/customers`, {
  email: "y@example.com",
  address: { country: "US", zipcode: "1" },
});
ok(
  "nested unknown key names its path",
  msg(nested) === "Unknown parameter: address.zipcode",
  shape(nested),
);
const item = await call("POST", `${B}/customers/${C}/subscriptions`, {
  items: [{ price: P, qty: 2 }],
  auto_collection: "off",
});
ok(
  "array item unknown key names its index",
  msg(item) === "Unknown parameter: items[0].qty",
  shape(item),
);
const many = await call("POST", `${B}/customers`, { email: "z@example.com", a: 1, b: 2 });
ok("several unknown keys are all named", msg(many) === "Unknown parameter: a, b", shape(many));
const renamed = await call("PATCH", `${B}/subscriptions/${S3}`, { payment_source_id: "pm_x" });
ok(
  "a renamed param's old name is unknown",
  msg(renamed) === "Unknown parameter: payment_source_id",
  shape(renamed),
);
const q = await call(
  "GET",
  `${B}/subscriptions/${S3}/renewal_estimate?include_delayed_charges=true&verbose=1`,
);
ok("zod-parsed query: unknown key → 400", msg(q) === "Unknown parameter: verbose", shape(q));
const lq = await call("GET", `${B}/customers?emial[is]=a`);
ok("list query: unknown filter still refused", lq.status === 400, shape(lq));
const applied = await call("POST", `${B}/invoices/${inv}/apply_credits`, { bogus: true });
ok(
  "a .strict() body names its key the same way",
  msg(applied) === "Unknown parameter: bogus",
  shape(applied),
);
const noCreate = await call("GET", `${B}/customers?email[is]=x%40example.com`);
ok("a refused create wrote nothing", noCreate.body.data?.length === 0, shape(noCreate));

// ── C. Carve-outs ───────────────────────────────────────────────────────────
const cf = await call("POST", `${B}/customers`, {
  email: "cf@example.com",
  cf_signedup_from: "partner",
  metadata: { anything: { deeply: { nested: true } } },
  custom_fields: { signedup_from: "web" },
});
ok("cf_* top level + free-form metadata + custom_fields accepted", cf.status < 300, shape(cf));
const settings = await call("PATCH", B, {
  dunning_config: { mode: "fixed", stored_by_an_older_release: 1 },
});
ok(
  "a round-tripped settings object keeps its stored keys",
  settings.status === 200,
  shape(settings),
);
const settingsTop = await call("PATCH", B, { dunning: { mode: "fixed" } });
ok(
  "business PATCH top level is still strict",
  msg(settingsTop) === "Unknown parameter: dunning",
  shape(settingsTop),
);

// ── E. Request shape: operator bodies, list sizes, query and path input ──────
// Team writes: an unknown field (`is_admin`) used to be dropped silently.
pinMfaMandateOff();
const owner = await signup({
  email: `strict-owner-${Date.now()}@example.com`,
  password: "Correct-Horse-Battery-9",
  organizationName: "Strict Team Co",
});
const teammate = await inviteUser({
  organizationId: owner.user.organizationId,
  email: `strict-mate-${Date.now()}@example.com`,
  role: "developer",
});
async function asOwner(method: string, path: string, body: unknown): Promise<Res> {
  const r = await fetch(base + path, {
    method,
    headers: {
      cookie: `tmb_session=${owner.token}`,
      "content-type": "application/json",
      "idempotency-key": `strict-op-${++idem}`,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {}, raw: text };
}
const invite = await asOwner("POST", "/auth/invite", {
  email: `strict-admin-${Date.now()}@example.com`,
  role: "developer",
  is_admin: true,
});
ok(
  "POST /auth/invite: is_admin → 400 Unknown parameter",
  msg(invite) === "Unknown parameter: is_admin",
  shape(invite),
);
const roleChange = await asOwner("PATCH", `/auth/members/${teammate.userPublicId}`, {
  role: "developer",
  is_admin: true,
});
ok(
  "PATCH /auth/members/:id: is_admin → 400 Unknown parameter",
  msg(roleChange) === "Unknown parameter: is_admin",
  shape(roleChange),
);

// items[] is capped at LIMITS.lineItems (500).
const tooManySubItems = await call("POST", `${B}/customers/${C}/subscriptions`, {
  items: Array.from({ length: 501 }, () => ({ price: P })),
  auto_collection: "off",
});
ok(
  "subscription create: 501 items → 400",
  tooManySubItems.status === 400 && /<=500/.test(msg(tooManySubItems)),
  shape(tooManySubItems),
);
const tooManyNoteItems = await call("POST", `${B}/credit_notes`, {
  invoice: inv ?? "inv_missing",
  kind: "adjustment",
  items: Array.from({ length: 501 }, () => ({ description: "x", amount_minor: 1 })),
});
ok(
  "credit note create: 501 items → 400",
  tooManyNoteItems.status === 400 && /<=500/.test(msg(tooManyNoteItems)),
  shape(tooManyNoteItems),
);

// A repeated query key is a 400 unless the route reads it as a list.
const repeated = await call("GET", `${B}/customers?limit=1&limit=2`);
ok(
  "repeated query key → 400",
  repeated.status === 400 && /occurs more than one time/.test(msg(repeated)),
  shape(repeated),
);
const orgEvents = await call("GET", "/v1/events?type=customer_created&type=invoice_paid");
ok("/v1/events still takes a repeated type", orgEvents.status === 200, shape(orgEvents));
const bizEvents = await call("GET", `${B}/events?type=customer_created&type=invoice_paid`);
ok("business events still take a repeated type", bizEvents.status === 200, shape(bizEvents));
const buckets = await call(
  "GET",
  `${B}/cancellation_analytics?start=2026-01-01&end=2026-03-31&bucket=2026-01-01,2026-01-31&bucket=2026-02-01,2026-02-28`,
);
ok("cancellation_analytics still takes a repeated bucket", buckets.status === 200, shape(buckets));
const nul = await call("GET", `${B}/invoices/inv_x%00`);
ok("NUL in a path id → 400, not 500", nul.status === 400, shape(nul));
const proto = await call("GET", `${B}/customers?constructor[is]=x`);
ok("filter on `constructor` → 400, not 500", proto.status === 400, shape(proto));

{
  // An empty body with no content type still reaches the route.
  const empty = await call("POST", `${B}/subscriptions/${SP}/remove_scheduled_cancellation`);
  ok("an empty body with no content type is not a 415", empty.status !== 415, shape(empty));
  // Inbound gateway webhooks keep their own parsers, text/plain included.
  const hook = await fetch(`${base}/v1/gateway_webhooks/stripe?id=gwa_missing`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  ok("a gateway webhook with text/plain is not a 415", hook.status !== 415, String(hook.status));
}

// ── F. Value bounds: coupon codes, quantities, money ────────────────────────
// A new coupon code is letters, digits, `_` and `-`; a stored one (imported) still works.
for (const bad of ["SPRING.20", "TWO WORDS", "<b>x</b>"]) {
  const r = await call("POST", `${B}/coupons`, {
    code: bad,
    kind: "percentage",
    percent_off_bps: 500,
  });
  ok(
    `coupon create: code ${JSON.stringify(bad)} → 400`,
    r.status === 400 && /code/.test(msg(r)),
    shape(r),
  );
}
const goodCode = await call("POST", `${B}/coupons`, {
  code: "Spring_20-x",
  kind: "percentage",
  percent_off_bps: 500,
});
ok("coupon create: letters, digits, _ and - → 201", goodCode.status === 201, shape(goodCode));
const legacyBiz = await getBusinessByPublicId(orgId, biz.body.id as string);
await createCoupon({
  organizationId: orgId,
  businessId: legacyBiz!.id,
  code: "LEGACY.CODE",
  kind: "percentage",
  percentOffBps: 500,
});
const legacyGet = await call("GET", `${B}/coupons/LEGACY.CODE`);
ok(
  "coupon: a stored code outside the rule still reads",
  legacyGet.status === 200,
  shape(legacyGet),
);
const legacyPatch = await call("PATCH", `${B}/coupons/LEGACY.CODE`, { name: "Legacy" });
ok("coupon: …and its other fields still change", legacyPatch.status === 200, shape(legacyPatch));
const badSetCodes = await call("POST", `${B}/coupon_sets/set_missing/codes`, { codes: ["A.B"] });
ok("coupon set codes: a code with a dot → 400", badSetCodes.status === 400, shape(badSetCodes));

// Quantity: at most 1,000,000 units of one item.
const seatPrice = await call("POST", `${B}/prices`, {
  product: plan.body.id,
  model: "per_unit",
  currency: "USD",
  amount_minor: 100,
  interval: "month",
});
const overQty = await call("POST", `${B}/customers/${C}/subscriptions`, {
  items: [{ price: seatPrice.body.id, quantity: 1_000_001 }],
  auto_collection: "off",
});
ok(
  "subscription create: quantity 1,000,001 → 400",
  overQty.status === 400 && /quantity/.test(msg(overQty)),
  shape(overQty),
);
const overLinkQty = await call("POST", `${B}/payment_links`, {
  name: "Too many seats",
  items: [{ price: seatPrice.body.id, quantity: 1_000_001 }],
});
ok(
  "payment link: quantity 1,000,001 → 400",
  overLinkQty.status === 400 && /quantity/.test(msg(overLinkQty)),
  shape(overLinkQty),
);

// Money and usage: at most 10^12.
const TOO_BIG = 1_000_000_000_001;
const overLine = await call("POST", `${B}/invoices`, {
  customer: C,
  lines: [{ description: "Too big", amount_minor: TOO_BIG }],
});
ok(
  "invoice create: amount_minor 10^12 + 1 → 400",
  overLine.status === 400 && /amount_minor/.test(msg(overLine)),
  shape(overLine),
);
const overIntent = await call("POST", `${B}/payment_intents`, {
  payment_method: "pm_missing",
  amount_minor: TOO_BIG,
  currency: "USD",
});
ok(
  "payment intent: amount_minor 10^12 + 1 → 400 naming the field",
  overIntent.status === 400 && /amount_minor/.test(msg(overIntent)),
  shape(overIntent),
);
const overUsage = await call("POST", `${B}/subscriptions/${S1}/usage`, {
  item: "si_missing",
  quantity: TOO_BIG,
});
ok(
  "usage: quantity 10^12 + 1 → 400, before the item lookup",
  overUsage.status === 400 && /quantity/.test(msg(overUsage)),
  shape(overUsage),
);

// ── D. Kill switch ──────────────────────────────────────────────────────────
const mutable = config as { API_UNKNOWN_PARAMS: "reject" | "warn" };
mutable.API_UNKNOWN_PARAMS = "warn";
const warned = await call("POST", `${B}/customers`, { email: "warn@example.com", nickname: "w" });
mutable.API_UNKNOWN_PARAMS = "reject";
ok(
  "warn mode accepts and ignores the unknown key",
  warned.status < 300 && !("nickname" in warned.body),
  shape(warned),
);
const again = await call("POST", `${B}/customers`, { email: "warn2@example.com", nickname: "w" });
ok("back to reject", unknownParam(again), shape(again));

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length} failed`,
);
await app.close();
receiver.close();
await closeDb();
process.exit(failed === 0 ? 0 : 1);
