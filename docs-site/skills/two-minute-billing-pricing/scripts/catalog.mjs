#!/usr/bin/env node
// Catalog as code: plan the changes billing.catalog.json asks for, and make them with --apply.
//   node --env-file=.env <skill>/scripts/catalog.mjs [billing.catalog.json] [--apply] [--json]
// Creates what is missing (business, credit units, meters, products, prices, features,
// entitlements, tax regions, coupons, coupon sets), in that order, then sets the business
// settings the file lists. It changes what the API can change: an entitlement value, a credit
// unit's name, a meter's credit cost, a price field the price PATCH takes (amount, trial, grants_credit, rates,
// tax_behavior, ...), a tax region and its components, a coupon's caps and names, and a setting.
// A price edit applies to NEW subscriptions only; live ones keep their terms. A field the API
// cannot change is a CONFLICT: a price's product, type, model, currency, interval or meter, a
// product's kind, a credit unit's currency, minor_per_unit or decimals once a grant used it, a
// redeemed coupon's discount, and a coupon set's coupon. Give new terms a new id.
// A price field the file leaves out is not compared, except the ones that mean "none" when
// absent (a trial, grants_credit, rates, ...): there, a stored value is planned for removal.
// Nothing is ever deleted: `archived: true` archives a coupon, a coupon set or a tax region.
// It checks the key is a test key first (GET /v1/me) and refuses anything else.
// Exit: 0 planned, applied or nothing to change · 1 bad input or request
//       2 CONFLICT (nothing applied) · 3 not a test key.
// Node 20.6+, no dependencies. Never prints the API key.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const asJson = argv.includes("--json");
const file = argv.find((a) => !a.startsWith("--")) ?? "billing.catalog.json";
const fail = (msg, code = 1) => {
  console.error(`catalog: ${msg}`);
  process.exit(code);
};

const url = (process.env.TMBILLING_URL ?? "").replace(/\/$/, "");
const key = process.env.TMBILLING_API_KEY ?? "";
if (!url || !key) fail("TMBILLING_URL and TMBILLING_API_KEY must be set (run with --env-file).");

let catalog;
try {
  catalog = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  fail(`cannot read ${file}: ${e.message}`);
}

// Shape and closed values, checked before any request.
const ENUMS = {
  "products[].kind": ["plan", "addon", "charge"],
  "prices[].type": ["recurring", "one_time"],
  "prices[].tax_behavior": ["inclusive", "exclusive"],
};
const problems = [];
if (!catalog.business?.name || !catalog.business?.default_currency)
  problems.push("business needs name and default_currency");
for (const k of ["products", "prices"])
  if (!Array.isArray(catalog[k])) problems.push(`${k} must be an array`);
if (catalog.credit_units !== undefined && !Array.isArray(catalog.credit_units))
  problems.push("credit_units must be an array");
for (const u of catalog.credit_units ?? [])
  for (const f of ["id", "name", "currency", "minor_per_unit"])
    if (u[f] === undefined) problems.push(`credit unit ${u.id ?? "?"}: ${f} is required`);
// minor_per_unit: null is a unit with no money rate (credits are counted, not priced).
for (const m of catalog.meters ?? [])
  if (m.credit_cost !== undefined && m.credit_cost !== null) {
    const c = m.credit_cost;
    if (!c.unit || c.credits_per_unit === undefined)
      problems.push(`meter ${m.id}: credit_cost needs unit and credits_per_unit`);
    for (const o of c.overrides ?? [])
      if (!o.product === !o.subscription || o.credits_per_unit === undefined)
        problems.push(
          `meter ${m.id}: a credit_cost override needs product or subscription, and credits_per_unit`,
        );
  }
for (const p of catalog.products ?? []) {
  if (!p.id || !p.name) problems.push(`product ${p.id ?? "?"}: id and name are required`);
  if (p.kind !== undefined && !ENUMS["products[].kind"].includes(p.kind))
    problems.push(`product ${p.id}: kind must be ${ENUMS["products[].kind"].join(" | ")}`);
}
for (const p of catalog.prices ?? []) {
  for (const f of ["id", "product", "model", "currency"])
    if (p[f] === undefined) problems.push(`price ${p.id ?? "?"}: ${f} is required`);
  if (p.type !== undefined && !ENUMS["prices[].type"].includes(p.type))
    problems.push(`price ${p.id}: type must be ${ENUMS["prices[].type"].join(" | ")}`);
  if (p.tax_behavior !== undefined && !ENUMS["prices[].tax_behavior"].includes(p.tax_behavior))
    problems.push(`price ${p.id}: tax_behavior must be inclusive | exclusive`);
  if (p.amount_minor !== undefined && !Number.isInteger(p.amount_minor))
    problems.push(`price ${p.id}: amount_minor must be an integer (minor units)`);
  if (p.type === "one_time" && p.interval !== undefined)
    problems.push(`price ${p.id}: a one_time price has no interval`);
}
for (const k of ["coupons", "coupon_sets", "tax_regions"])
  if (catalog[k] !== undefined && !Array.isArray(catalog[k]))
    problems.push(`${k} must be an array`);
const oneOf = (label, v, list) => {
  if (v !== undefined && !list.includes(v)) problems.push(`${label} must be ${list.join(" | ")}`);
};
for (const c of catalog.coupons ?? []) {
  const label = `coupon ${c.code ?? "?"}`;
  if (!c.code || !c.kind) problems.push(`${label}: code and kind are required`);
  oneOf(`${label}: kind`, c.kind, ["percentage", "fixed_amount"]);
  oneOf(`${label}: duration_type`, c.duration_type, ["once", "forever", "repeating"]);
  oneOf(`${label}: apply_on`, c.apply_on, ["invoice_amount", "each_specified_item"]);
  oneOf(`${label}: per_customer_limit_by`, c.per_customer_limit_by, ["customer", "email"]);
  if (c.kind === "percentage" && !(c.percent_off_bps >= 1 && c.percent_off_bps <= 10000))
    problems.push(`${label}: percent_off_bps must be 1 to 10000 (10000 = 100%)`);
  if (c.kind === "fixed_amount" && (!Number.isInteger(c.amount_off_minor) || !c.currency))
    problems.push(
      `${label}: a fixed_amount coupon needs amount_off_minor (minor units) and currency`,
    );
  if (c.duration_type === "repeating" && !c.duration_in_periods)
    problems.push(`${label}: a repeating coupon needs duration_in_periods`);
  for (const f of ["redeem_by", "valid_from"])
    if (c[f] != null && Number.isNaN(Date.parse(c[f])))
      problems.push(`${label}: ${f} must be an ISO date-time, for example 2027-01-31T23:59:59Z`);
}
for (const s of catalog.coupon_sets ?? [])
  for (const f of ["id", "coupon", "name", "count"])
    if (s[f] === undefined) problems.push(`coupon set ${s.id ?? "?"}: ${f} is required`);
for (const r of catalog.tax_regions ?? []) {
  const label = `tax region ${r.country ?? "?"}`;
  if (!/^[A-Za-z]{2}$/.test(r.country ?? "")) problems.push(`${label}: country must be 2 letters`);
  oneOf(`${label}: regime`, r.regime, ["gst", "vat", "sales_tax", "flat"]);
  oneOf(`${label}: price_type`, r.price_type, ["exclusive", "inclusive"]);
  if (r.components !== undefined && !Array.isArray(r.components))
    problems.push(`${label}: components must be an array`);
  for (const c of r.components ?? []) {
    if (!c.name || !Number.isInteger(c.rate_bps) || c.rate_bps < 0 || c.rate_bps > 10000)
      problems.push(`${label}: each component needs a name and rate_bps 0 to 10000 (900 = 9%)`);
    oneOf(`${label}: component ${c.name} applies_to`, c.applies_to, ["intra", "inter", "both"]);
    // Place of supply exists only under GST; the API refuses intra/inter elsewhere.
    if ((r.regime ?? "flat") !== "gst" && (c.applies_to ?? "both") !== "both")
      problems.push(`${label}: only a gst region can have intra or inter components`);
  }
}
// Business settings: keys the business PATCH takes. Keys left out stay as they are.
const SETTINGS_PLAIN = [
  "allow_customer_coupons",
  "max_customer_coupon_codes",
  "tax_registration_number",
  "invoice_issuer",
  "default_tax_code",
  "default_tax_behavior",
  "timezone",
  "default_due_days",
  "default_invoice_notes",
  "support_email",
];
// The PATCH replaces these objects whole, so the script sends the stored object with the file's keys on top.
const SETTINGS_WHOLE = ["address", "credit_config", "dunning_config"];
// The PATCH merges this one key by key; its object values merge one level down.
const SETTINGS_RULES = "billing_rules_config";
const settings = catalog.settings ?? {};
if (typeof settings !== "object" || Array.isArray(settings))
  problems.push("settings must be an object");
for (const [k, v] of Object.entries(settings)) {
  if (k === SETTINGS_RULES || SETTINGS_WHOLE.includes(k)) {
    if (!v || typeof v !== "object" || Array.isArray(v))
      problems.push(`settings.${k} must be an object`);
  } else if (!SETTINGS_PLAIN.includes(k))
    problems.push(
      `settings.${k} is not a setting this script manages. It manages: ${[SETTINGS_RULES, ...SETTINGS_WHOLE, ...SETTINGS_PLAIN].join(", ")}`,
    );
}
if (problems.length) fail(`${file} is not valid:\n  ${problems.join("\n  ")}`);

async function call(method, path, body) {
  const headers = { Authorization: `Bearer ${key}` };
  if (method !== "GET") headers["Idempotency-Key"] = randomUUID();
  // A DELETE has no body, and a JSON content type with no body is a 400.
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    fail(`${method} ${path} failed: ${e?.cause?.code ?? e?.message ?? e}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    fail(
      `${method} ${path} answered ${res.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 300)}`,
    );
  return json;
}
// Every page of a list.
async function listAll(path) {
  const out = [];
  let after;
  for (;;) {
    const q = new URLSearchParams({ include_archived: "true" });
    if (after) q.set("starting_after", after);
    const page = await call("GET", `${path}?${q}`);
    out.push(...(page.data ?? []));
    if (!page.has_more || !page.data?.length) return out;
    after = page.data[page.data.length - 1].id;
  }
}

const me = await call("GET", "/v1/me");
const mode = me.credential?.livemode ?? (key.startsWith("sk_test_") ? "test" : "other");
if (mode !== "test")
  fail(`refused: this key's mode is "${mode}". Build the catalog with a test key.`, 3);

const steps = [];
const conflicts = [];
const step = (what, run) => steps.push({ what, run });

// The business: found by name among test businesses. A missing one is created first, and
// everything below it then plans as new.
const businesses = (await call("GET", "/v1/businesses")).data ?? [];
const found = businesses.find((b) => b.name === catalog.business.name && b.livemode === "test");
// A name that matches none of these is a NEW business, so a typo must not pass quietly.
const otherTests = found ? [] : businesses.filter((b) => b.livemode === "test").map((b) => b.name);
let biz = found?.id;
if (!found) {
  step(`+ business "${catalog.business.name}" (${catalog.business.default_currency})`, async () => {
    biz = (await call("POST", "/v1/businesses", catalog.business)).id;
  });
}

// Credit units list by cursor, archived ones included.
async function listUnits() {
  const out = [];
  let after;
  for (;;) {
    const q = new URLSearchParams({ limit: "100" });
    if (after) q.set("starting_after", after);
    const page = await call("GET", `/v1/businesses/${biz}/credit_units?${q}`);
    out.push(...(page.data ?? []));
    if (!page.has_more || !page.next_cursor) return out;
    after = page.next_cursor;
  }
}
const units = new Map(
  biz && catalog.credit_units?.length ? (await listUnits()).map((u) => [u.id, u]) : [],
);
const meters = new Map(
  biz ? (await listAll(`/v1/businesses/${biz}/meters`)).map((m) => [m.id, m]) : [],
);
const products = new Map(
  biz ? (await listAll(`/v1/businesses/${biz}/products`)).map((p) => [p.id, p]) : [],
);
const prices = new Map(
  biz ? (await listAll(`/v1/businesses/${biz}/prices`)).map((p) => [p.id, p]) : [],
);
const features = new Set(
  biz ? ((await call("GET", `/v1/businesses/${biz}/features`)).data ?? []).map((f) => f.key) : [],
);

const show = (v) => JSON.stringify(v ?? null);
const differs = (label, f, want, have) => {
  if (want !== undefined && have !== undefined && String(want) !== String(have))
    conflicts.push(`${label}: ${f} is ${show(have)}, file says ${show(want)}`);
};
/** "60", "60.0" and 60 are one rate. */
const decimal = (v) => {
  if (v == null || v === "") return null;
  const t = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? t.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : t;
};
/** Key order does not matter; arrays keep theirs. */
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter((k) => v[k] !== undefined)
            .map((k) => [k, canon(v[k])]),
        )
      : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
/** grants_credit with the defaults the engine stores, so the file and the price compare. */
function grantShape(g, stored) {
  if (g == null) return null;
  const common = {
    kind: g.kind,
    unit: g.unit ?? null,
    amount: g.amount,
    priority: g.priority ?? 50,
    applicability: g.applicability ?? { kind: "metered" },
    on_exhausted: g.on_exhausted ?? null,
  };
  if (g.kind === "pack")
    return {
      ...common,
      category: "paid",
      expires_after: g.expires_after ?? null,
      // Absent: the business default, which only the stored price knows.
      tax_treatment: g.tax_treatment ?? stored?.tax_treatment ?? null,
    };
  const roll = g.rollover?.mode === "carry" ? g.rollover : null;
  const every = g.reset?.every;
  return {
    ...common,
    rollover: roll
      ? {
          mode: "carry",
          percent: roll.percent ?? 100,
          cap: roll.cap ?? null,
          expire_after_cycles:
            roll.expire_after_cycles === undefined ? 1 : roll.expire_after_cycles,
        }
      : { mode: "none" },
    reset:
      !g.reset || every === "term"
        ? null
        : every === "never"
          ? { every }
          : { every, count: g.reset.count ?? 1, anchor: g.reset.anchor ?? "subscription" },
    first_window: g.first_window ?? null,
  };
}
const rateShape = (rows) =>
  (rows ?? []).map((r) => ({
    match: r.match ?? {},
    unit_amount_decimal: decimal(r.unit_amount_decimal),
    tiers: r.tiers ?? null,
    markup_percent: decimal(r.markup_percent),
  }));
/** A unit's amount is in its smallest step: 5000 at 1 decimal is 500 credits. */
const unitDecimals = (id) =>
  units.get(id)?.decimals ?? catalog.credit_units?.find((u) => u.id === id)?.decimals ?? 0;
const wholeUnits = (amount, decimals) => {
  if (!decimals || !Number.isInteger(amount)) return String(amount);
  const t = (amount / 10 ** decimals).toFixed(decimals);
  return t.replace(/\.?0+$/, "");
};
const amountText = (amount, unit) => {
  const d = unit ? unitDecimals(unit) : 0;
  return d
    ? `${wholeUnits(amount, d)} ${unit} (amount ${amount})`
    : `${amount} ${unit ?? "minor units"}`;
};
const grantText = (g) => {
  if (!g) return "no credits";
  const parts = [`credits ${amountText(g.amount, g.unit)} ${g.kind}`];
  if (g.reset?.every && g.reset.every !== "term")
    parts.push(`reset every ${g.reset.count > 1 ? `${g.reset.count} ` : ""}${g.reset.every}`);
  if (g.first_window) parts.push(`first window ${g.first_window}`);
  if (g.rollover?.mode === "carry") parts.push(`rollover ${g.rollover.percent ?? 100}%`);
  if (g.on_exhausted) parts.push(`on exhausted ${g.on_exhausted}`);
  return parts.join(", ");
};

for (const u of catalog.credit_units ?? []) {
  const have = units.get(u.id);
  const rate = u.minor_per_unit === null ? null : String(u.minor_per_unit);
  const body = { ...u, minor_per_unit: rate };
  if (!have) {
    step(
      `+ credit unit ${u.id} (${u.currency}, ${rate === null ? "no money rate" : `${rate} minor per unit`}, ${u.decimals ?? 0} decimals)`,
      () => call("POST", `/v1/businesses/${biz}/credit_units`, body),
    );
    continue;
  }
  const patch = {};
  for (const f of ["name", "plural_name"])
    if (u[f] !== undefined && u[f] !== have[f]) patch[f] = u[f];
  // Fixed once a grant used the unit; before that the API still takes them.
  const fixed = {
    currency: [u.currency?.toUpperCase(), have.currency],
    minor_per_unit: [decimal(u.minor_per_unit), decimal(have.minor_per_unit)],
    decimals: [u.decimals ?? 0, have.decimals],
  };
  // Not locked: editable at any time. Absent in the file = leave as is; null clears the overage.
  if (u.overage_minor_per_unit !== undefined) {
    const want = decimal(u.overage_minor_per_unit);
    if (want !== decimal(have.overage_minor_per_unit)) patch.overage_minor_per_unit = want;
  }
  if (
    u.overdraft_limit !== undefined &&
    Number(u.overdraft_limit) !== Number(have.overdraft_limit ?? 0)
  )
    patch.overdraft_limit = u.overdraft_limit;
  if (
    u.negative_balance_at_reset !== undefined &&
    u.negative_balance_at_reset !== (have.negative_balance_at_reset ?? "carry")
  )
    patch.negative_balance_at_reset = u.negative_balance_at_reset;
  for (const [f, [want, got]] of Object.entries(fixed)) {
    if (String(want) === String(got)) continue;
    if (have.locked)
      conflicts.push(
        `credit unit ${u.id}: ${f} is ${show(got)}, file says ${show(want)} (a grant uses the unit)`,
      );
    else patch[f] = body[f];
  }
  if (Object.keys(patch).length)
    step(
      `~ credit unit ${u.id}: ${Object.entries(patch)
        .map(([f, v]) => `${f} ${show(have[f])} → ${show(v)}`)
        .join(", ")}`,
      () => call("PATCH", `/v1/businesses/${biz}/credit_units/${u.id}`, patch),
    );
}
for (const m of catalog.meters ?? []) {
  const { credit_cost: _, ...body } = m;
  if (!meters.has(m.id))
    step(`+ meter ${m.id}`, () => call("POST", `/v1/businesses/${biz}/meters`, body));
}
for (const p of catalog.products) {
  const have = products.get(p.id);
  if (!have) {
    step(`+ product ${p.id}${p.kind ? ` (${p.kind})` : ""}`, () =>
      call("POST", `/v1/businesses/${biz}/products`, p),
    );
  } else differs(`product ${p.id}`, "kind", p.kind, have.kind);
}
// The price PATCH cannot change these.
const FIXED = [
  "product",
  "type",
  "model",
  "currency",
  "interval",
  "interval_count",
  "meter",
  "amount_source",
  "quantity_divisor",
  "usage_aggregation",
  "usage_recurring",
  "usage_time_unit",
];
// The price PATCH takes these. Left out of the file = "none" for the ones in ABSENT_IS_NONE.
const EDITABLE = [
  "name",
  "external_name",
  "description",
  "amount_minor",
  "tiers",
  "unit_amount_decimal",
  "markup_percent",
  "markup_base",
  "rates",
  "package_size",
  "free_units",
  "percentage_bps",
  "minimum_amount_minor",
  "bill_usage_monthly",
  "commitment_amount_minor",
  "grants_credit",
  "trial_period",
  "trial_period_unit",
  "trial_end_action",
  "billing_cycles",
  "free_quantity",
  "portal_min_quantity",
  "portal_max_quantity",
  "invoice_notes",
  "show_description_in_invoices",
  "show_description_in_quotes",
  "tax_code",
  "sku",
  "accounting_code",
  "accounting_category_code",
  "is_taxable",
  "tax_behavior",
  "metadata",
];
const ABSENT_IS_NONE = new Set([
  "grants_credit",
  "trial_period",
  "trial_period_unit",
  "trial_end_action",
  "billing_cycles",
  "free_quantity",
  "minimum_amount_minor",
  "commitment_amount_minor",
  "rates",
]);
const DECIMALS = new Set(["unit_amount_decimal", "markup_percent", "quantity_divisor"]);
/** The value to compare, or undefined when the file says nothing about the field. */
function wanted(price, have, f) {
  const v = price[f];
  if (v === undefined && !ABSENT_IS_NONE.has(f)) return undefined;
  if (f === "grants_credit") return grantShape(v, have.grants_credit);
  if (f === "rates") return rateShape(v);
  if (f === "trial_period") return v || null;
  if (DECIMALS.has(f)) return decimal(v);
  return v ?? null;
}
function stored(have, f) {
  if (f === "grants_credit") return grantShape(have.grants_credit, have.grants_credit);
  if (f === "rates") return rateShape(have.rates);
  if (f === "trial_period") return have.trial_period || null;
  if (DECIMALS.has(f)) return decimal(have[f]);
  return have[f] ?? null;
}
/** The terms a user reviews: amount, period, trial, usage rate, credits. */
function terms(p) {
  const t = [p.model, p.type ?? "recurring", p.currency];
  if (p.amount_minor !== undefined) t.push(String(p.amount_minor));
  if (p.interval) t.push(`per ${p.interval_count ?? 1} ${p.interval}`);
  if (p.meter) t.push(`meter ${p.meter}`);
  if (p.unit_amount_decimal !== undefined) t.push(`rate ${p.unit_amount_decimal}`);
  if (p.rates?.length) t.push(`${p.rates.length} rate card row(s)`);
  if (p.trial_period) t.push(`trial ${p.trial_period} ${p.trial_period_unit ?? "day"}`);
  if (p.grants_credit) t.push(grantText(p.grants_credit));
  if (p.tax_behavior) t.push(`tax ${p.tax_behavior}`);
  return t.join(", ");
}
for (const price of catalog.prices) {
  const have = prices.get(price.id);
  if (!have) {
    step(`+ price ${price.id} (${terms(price)})`, () =>
      call("POST", `/v1/businesses/${biz}/prices`, price),
    );
    continue;
  }
  const label = `price ${price.id}`;
  for (const f of FIXED) {
    if (price[f] === undefined) continue;
    const want = DECIMALS.has(f) ? decimal(price[f]) : price[f];
    const got = DECIMALS.has(f) ? decimal(have[f]) : have[f];
    differs(label, f, want, got);
  }
  const patch = {};
  const lines = [];
  for (const f of EDITABLE) {
    const want = wanted(price, have, f);
    if (want === undefined) continue;
    const got = stored(have, f);
    if (same(want, got)) continue;
    patch[f] = price[f] === undefined ? (f === "rates" ? [] : null) : price[f];
    lines.push(
      f === "grants_credit"
        ? `grants_credit: ${grantText(have.grants_credit)} → ${grantText(price.grants_credit)}`
        : `${f} ${show(got)} → ${show(want)}`,
    );
  }
  if (lines.length)
    step(`~ ${label}: ${lines.join("; ")} (new subscriptions only)`, () =>
      call("PATCH", `/v1/businesses/${biz}/prices/${price.id}`, patch),
    );
}
// Meter credit costs: after products, as an override names one. Left out of the file = none.
const costOf = (c) =>
  c && {
    unit: c.unit,
    credits_per_unit: decimal(c.credits_per_unit),
    overrides: (c.overrides ?? [])
      .map((o) => ({
        product: o.product,
        subscription: o.subscription,
        credits_per_unit: decimal(o.credits_per_unit),
      }))
      // The API lists overrides in its own order; compare them as a set.
      .sort((x, y) => (x.product ?? x.subscription).localeCompare(y.product ?? y.subscription)),
  };
for (const m of catalog.meters ?? []) {
  const want = costOf(m.credit_cost);
  const have = costOf(meters.get(m.id)?.credit_cost);
  if (JSON.stringify(canon(want ?? null)) === JSON.stringify(canon(have ?? null))) continue;
  if (want)
    step(
      `${have ? "~" : "+"} meter ${m.id}: credit cost ${want.credits_per_unit} ${want.unit} per unit${want.overrides.length ? `, ${want.overrides.length} override(s)` : ""}`,
      () =>
        call("PUT", `/v1/businesses/${biz}/meters/${m.id}/credit_cost`, {
          unit: want.unit,
          credits_per_unit: want.credits_per_unit,
          overrides: want.overrides,
        }),
    );
  else
    step(
      `~ meter ${m.id}: remove credit cost (${have.credits_per_unit} ${have.unit} per unit)`,
      () => call("DELETE", `/v1/businesses/${biz}/meters/${m.id}/credit_cost`),
    );
}
for (const f of catalog.features ?? []) {
  if (!features.has(f.key))
    step(`+ feature ${f.key} (${f.type})`, () => call("POST", `/v1/businesses/${biz}/features`, f));
}
const granted = new Map();
for (const e of catalog.entitlements ?? []) {
  if (!granted.has(e.product)) {
    const list = products.has(e.product)
      ? await call("GET", `/v1/businesses/${biz}/products/${e.product}/entitlements`)
      : { data: [] };
    granted.set(e.product, new Map((list.data ?? []).map((x) => [x.feature, x.value])));
  }
  const have = granted.get(e.product).get(e.feature);
  if (have === e.value) continue;
  step(
    have === undefined
      ? `+ ${e.product} grants ${e.feature} = ${e.value}`
      : `~ ${e.product} ${e.feature}: ${have} → ${e.value} (applies to current subscribers)`,
    () =>
      call("POST", `/v1/businesses/${biz}/products/${e.product}/entitlements`, {
        feature: e.feature,
        value: e.value,
      }),
  );
}

// ——— tax regions: found by country ————————————————————————————————————————————
const REGION_CREATE = [
  "regime",
  "price_type",
  "home_state_code",
  "registration_label",
  "registration_number",
];
const REGION_EDITABLE = [
  ...REGION_CREATE,
  "collect_registration_number",
  "reverse_charge_enabled",
  "show_reverse_charge_note",
  "reverse_charge_note",
  "sez_igst_enabled",
  "sez_igst_note",
  "sez_zero_rated_enabled",
  "sez_zero_rated_note",
  "export_igst_enabled",
  "export_igst_note",
  "export_zero_rated_enabled",
  "export_zero_rated_note",
];
const pick = (o, keys) =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const componentShape = (rows) =>
  (rows ?? []).map((c) => ({
    name: c.name.trim(),
    rate_bps: c.rate_bps,
    applies_to: c.applies_to ?? "both",
  }));
const componentText = (rows) =>
  rows.length
    ? componentShape(rows)
        .map(
          (c) =>
            `${c.name} ${c.rate_bps / 100}%${c.applies_to === "both" ? "" : ` ${c.applies_to}`}`,
        )
        .join(", ")
    : "no components";
const regionValue = (f, v) =>
  f === "home_state_code" && typeof v === "string" ? v.toUpperCase() : (v ?? null);
let regions = [];
if (biz && catalog.tax_regions?.length) {
  regions = (await call("GET", `/v1/businesses/${biz}/tax_regions`)).data ?? [];
  // Two profiles can hold the same country: the default profile's region is the one meant.
  const countries = regions.map((r) => r.country);
  if (new Set(countries).size !== countries.length) {
    const profiles = (await call("GET", `/v1/businesses/${biz}/tax_profiles`)).data ?? [];
    const main = profiles.find((p) => p.is_default)?.id;
    regions = regions.filter(
      (r) => r.tax_profile_id === main || countries.filter((c) => c === r.country).length === 1,
    );
  }
}
for (const r of catalog.tax_regions ?? []) {
  const country = r.country.toUpperCase();
  const have = regions.find((x) => x.country === country);
  const label = `tax region ${country}`;
  if (!have) {
    const terms = [r.regime ?? "flat", r.price_type ?? "exclusive"];
    if (r.home_state_code) terms.push(`home state ${r.home_state_code}`);
    if (r.registration_number) terms.push(`registration ${r.registration_number}`);
    if (r.archived) terms.push("archived");
    step(`+ ${label} (${terms.join(", ")}): ${componentText(r.components ?? [])}`, async () => {
      const made = await call("POST", `/v1/businesses/${biz}/tax_regions`, {
        country,
        ...pick(r, REGION_CREATE),
      });
      const rest = pick(
        r,
        REGION_EDITABLE.filter((f) => !REGION_CREATE.includes(f)),
      );
      if (Object.keys(rest).length)
        await call("PATCH", `/v1/businesses/${biz}/tax_regions/${made.id}`, rest);
      if (r.components?.length)
        await call("PUT", `/v1/businesses/${biz}/tax_regions/${made.id}/components`, {
          components: r.components,
        });
      if (r.archived) await call("DELETE", `/v1/businesses/${biz}/tax_regions/${made.id}`);
    });
    continue;
  }
  const patch = {};
  const lines = [];
  for (const f of REGION_EDITABLE) {
    if (r[f] === undefined) continue;
    const want = regionValue(f, r[f]);
    const got = regionValue(f, have[f]);
    if (same(want, got)) continue;
    patch[f] = r[f];
    lines.push(`${f} ${show(got)} → ${show(want)}`);
  }
  if (r.archived !== undefined && r.archived === have.enabled) {
    patch.enabled = !r.archived;
    lines.push(r.archived ? "archive (no tax on new invoices)" : "restore");
  }
  // The default vector only; state overrides stay as they are.
  const stored = have.components.filter((c) => c.state_code == null);
  const compsChanged =
    r.components !== undefined && !same(componentShape(r.components), componentShape(stored));
  if (compsChanged)
    lines.push(`components ${componentText(stored)} → ${componentText(r.components)}`);
  if (lines.length)
    step(`~ ${label}: ${lines.join("; ")}`, async () => {
      // Regime first: the components are checked against it.
      if (Object.keys(patch).length)
        await call("PATCH", `/v1/businesses/${biz}/tax_regions/${have.id}`, patch);
      if (compsChanged)
        await call("PUT", `/v1/businesses/${biz}/tax_regions/${have.id}/components`, {
          components: r.components,
        });
    });
}

// ——— coupons: found by code ————————————————————————————————————————————————
// The discount itself; the API freezes it once the coupon is redeemed.
const COUPON_RULES = [
  "kind",
  "percent_off_bps",
  "amount_off_minor",
  "currency",
  "duration_type",
  "duration_in_periods",
  "apply_on",
];
const COUPON_EDITABLE = [
  "name",
  "invoice_name",
  "redeem_by",
  "valid_from",
  "max_redemptions",
  "max_redemptions_per_customer",
  "per_customer_limit_by",
  "metadata",
];
const couponValue = (f, v) => {
  if (v == null) return null;
  if (f === "currency") return String(v).toUpperCase();
  if (f === "redeem_by" || f === "valid_from") return new Date(v).toISOString();
  return v;
};
const scopeShape = (rows) =>
  (rows ?? [])
    .map((k) => ({
      item_kind: k.item_kind,
      constraint_type: k.constraint_type,
      product_ids: [...(k.product_ids ?? [])].sort(),
      price_ids: [...(k.price_ids ?? [])].sort(),
      billing_periods: (k.billing_periods ?? [])
        .map((p) => `${p.interval_count ?? 1} ${p.interval}`)
        .sort(),
    }))
    .sort((a, b) => a.item_kind.localeCompare(b.item_kind));
/** Once redeemed, a coupon's scope may only grow: name what the file would take away. */
function scopeShrinks(stored, wantRows) {
  const want = new Map(scopeShape(wantRows).map((k) => [k.item_kind, k]));
  const lost = [];
  for (const s of scopeShape(stored)) {
    const w = want.get(s.item_kind);
    if (s.constraint_type === "none") continue;
    if (!w || w.constraint_type === "none") lost.push(s.item_kind);
    else if (s.constraint_type === "all" && w.constraint_type !== "all") lost.push(s.item_kind);
    else if (
      w.constraint_type === "specific" &&
      [...s.product_ids, ...s.price_ids].some(
        (id) => ![...w.product_ids, ...w.price_ids].includes(id),
      )
    )
      lost.push(s.item_kind);
    else if (
      w.billing_periods.length &&
      (!s.billing_periods.length || s.billing_periods.some((p) => !w.billing_periods.includes(p)))
    )
      lost.push(`${s.item_kind} billing periods`);
  }
  return lost;
}
function discountText(c) {
  const off =
    c.kind === "percentage"
      ? `${c.percent_off_bps / 100}% off`
      : `${c.amount_off_minor} ${String(c.currency).toUpperCase()} off`;
  const t = [off];
  const d = c.duration_type ?? "once";
  t.push(d === "repeating" ? `for ${c.duration_in_periods} periods` : d);
  if (c.apply_on === "each_specified_item") t.push("on specified items");
  if (c.max_redemptions) t.push(`max ${c.max_redemptions} redemptions`);
  if (c.max_redemptions_per_customer) t.push(`max ${c.max_redemptions_per_customer} per customer`);
  if (c.redeem_by) t.push(`until ${c.redeem_by}`);
  return t.join(", ");
}
const coupons = new Map(
  biz && catalog.coupons?.length
    ? ((await call("GET", `/v1/businesses/${biz}/coupons?include_archived=true`)).data ?? []).map(
        (c) => [c.code, c],
      )
    : [],
);
for (const c of catalog.coupons ?? []) {
  const have = coupons.get(c.code);
  const label = `coupon ${c.code}`;
  const { archived, ...body } = c;
  if (!have) {
    step(`+ ${label} (${discountText(c)}${archived ? ", archived" : ""})`, async () => {
      await call("POST", `/v1/businesses/${biz}/coupons`, body);
      if (archived)
        await call("DELETE", `/v1/businesses/${biz}/coupons/${encodeURIComponent(c.code)}`);
    });
    continue;
  }
  const patch = {};
  const lines = [];
  const redeemed = have.times_redeemed > 0;
  for (const f of [...COUPON_RULES, ...COUPON_EDITABLE]) {
    if (c[f] === undefined) continue;
    const want = couponValue(f, c[f]);
    const got = couponValue(f, have[f]);
    if (same(want, got)) continue;
    if (redeemed && COUPON_RULES.includes(f)) {
      conflicts.push(
        `${label}: ${f} is ${show(got)}, file says ${show(want)} (redeemed ${have.times_redeemed} time(s), so the discount is fixed)`,
      );
      continue;
    }
    patch[f] = c[f];
    lines.push(`${f} ${show(got)} → ${show(want)}`);
  }
  if (
    c.item_constraints !== undefined &&
    !same(scopeShape(c.item_constraints), scopeShape(have.item_constraints))
  ) {
    const lost = redeemed ? scopeShrinks(have.item_constraints, c.item_constraints) : [];
    if (lost.length)
      conflicts.push(
        `${label}: item_constraints take away ${lost.join(", ")} (redeemed ${have.times_redeemed} time(s), so the scope can only grow)`,
      );
    else {
      patch.item_constraints = c.item_constraints;
      lines.push("item_constraints changed");
    }
  }
  if (archived !== undefined && archived === have.active) {
    patch.active = !archived;
    lines.push(archived ? "archive (no new redemptions)" : "restore");
  }
  if (lines.length)
    step(`~ ${label}: ${lines.join("; ")}`, () =>
      call("PATCH", `/v1/businesses/${biz}/coupons/${encodeURIComponent(c.code)}`, patch),
    );
}

// ——— coupon sets: found by id ——————————————————————————————————————————————
const couponSets = new Map(
  biz && catalog.coupon_sets?.length
    ? (
        (await call("GET", `/v1/businesses/${biz}/coupon_sets?include_archived=true`)).data ?? []
      ).map((s) => [s.id, s])
    : [],
);
for (const s of catalog.coupon_sets ?? []) {
  const have = couponSets.get(s.id);
  const label = `coupon set ${s.id}`;
  const { archived, ...body } = s;
  if (!have) {
    step(
      `+ ${label} (${s.count} codes for coupon ${s.coupon}${archived ? ", archived" : ""})`,
      async () => {
        await call("POST", `/v1/businesses/${biz}/coupon_sets`, body);
        if (archived) await call("DELETE", `/v1/businesses/${biz}/coupon_sets/${s.id}`);
      },
    );
    continue;
  }
  differs(label, "coupon", s.coupon, have.coupon);
  const isArchived = have.archived_at != null;
  if (archived === false && isArchived)
    conflicts.push(`${label}: it is archived, and an archived set cannot be restored`);
  const patch = pick(
    s,
    ["name", "metadata"].filter((f) => s[f] !== undefined && !same(s[f], have[f] ?? null)),
  );
  const lines = Object.keys(patch).map((f) => `${f} ${show(have[f])} → ${show(s[f])}`);
  const more = s.count - have.total_count;
  if (more < 0)
    conflicts.push(
      `${label}: count is ${have.total_count}, file says ${s.count} (codes are never deleted)`,
    );
  else if (more > 0 && !isArchived)
    lines.push(`count ${have.total_count} → ${s.count} (${more} new codes)`);
  if (archived && !isArchived) lines.push("archive (its unredeemed codes are archived)");
  if (lines.length)
    step(`~ ${label}: ${lines.join("; ")}`, async () => {
      const path = `/v1/businesses/${biz}/coupon_sets/${s.id}`;
      if (Object.keys(patch).length) await call("PATCH", path, patch);
      if (more > 0 && !isArchived)
        await call("POST", `${path}/codes`, { count: more, ...pick(s, ["code_prefix"]) });
      if (archived && !isArchived) await call("DELETE", path);
    });
}

// ——— business settings: last, as credit_config can name the prices above ———————————
if (Object.keys(settings).length) {
  const stored = biz ? await call("GET", `/v1/businesses/${biz}`) : {};
  const patch = {};
  const lines = [];
  const was = (v) => (biz ? `${show(v)} → ` : "");
  for (const [k, v] of Object.entries(settings)) {
    if (SETTINGS_PLAIN.includes(k)) {
      if (same(v, stored[k] ?? null)) continue;
      patch[k] = v;
      lines.push(`${k} ${was(stored[k])}${show(v)}`);
      continue;
    }
    const base = stored[k] ?? {};
    const changed = {};
    for (const [sub, want] of Object.entries(v)) {
      const got = base[sub];
      // A nested rules object (plan_credits, ...) compares, and is sent, key by key.
      if (k === SETTINGS_RULES && want && typeof want === "object" && !Array.isArray(want)) {
        const inner = {};
        for (const [leaf, w] of Object.entries(want)) {
          if (same(w, got?.[leaf] ?? null)) continue;
          inner[leaf] = w;
          lines.push(`${k}.${sub}.${leaf} ${was(got?.[leaf])}${show(w)}`);
        }
        if (Object.keys(inner).length) changed[sub] = inner;
        continue;
      }
      if (same(want, got ?? null)) continue;
      changed[sub] = want;
      lines.push(`${k}.${sub} ${was(got)}${show(want)}`);
    }
    if (!Object.keys(changed).length) continue;
    patch[k] = k === SETTINGS_RULES ? changed : { ...(stored[k] ?? {}), ...changed };
  }
  lines.forEach((line, i) =>
    step(
      `~ setting ${line}`,
      // One PATCH carries every setting; the other lines only list it.
      i === 0 ? () => call("PATCH", `/v1/businesses/${biz}`, patch) : async () => {},
    ),
  );
}

const report = (result, extra = {}) => ({
  result,
  business: biz ?? null,
  new_business: !found,
  other_test_businesses: otherTests,
  changes: steps.map((s) => s.what),
  conflicts,
  ...extra,
});
const finish = (code, result, extra) => {
  if (asJson) console.log(JSON.stringify(report(result, extra), null, 2));
  process.exit(code);
};

if (!asJson) {
  console.log(biz ? `Business ${biz} (test)\n` : `Business "${catalog.business.name}" is new\n`);
  if (otherTests.length)
    console.log(
      `! NEW BUSINESS: no test business is named "${catalog.business.name}", so --apply ` +
        `CREATES one.\n  Test businesses on this key: ${otherTests.map((n) => `"${n}"`).join(", ")}.` +
        `\n  To use one of them, put its exact name in business.name.\n`,
    );
  for (const s of steps) console.log(s.what);
  for (const c of conflicts) console.log(`! CONFLICT ${c}`);
  if (!steps.length && !conflicts.length) console.log("Nothing to change.");
}
if (conflicts.length) {
  if (!asJson)
    console.log(
      "\nThe API cannot change these fields. Give the new terms a new id, and move customers to it.",
    );
  finish(2, "conflict");
}
if (!steps.length) finish(0, "nothing to change");
if (!apply) {
  if (!asJson)
    console.log(`\nPlan only: ${steps.length} change(s). Run with --apply to make them.`);
  finish(0, "plan");
}
for (const s of steps) {
  await s.run();
  if (!asJson) console.log(`done ${s.what}`);
}
if (!found && !asJson) console.log(`\nCreated ${biz}. Set TMBILLING_BUSINESS_ID=${biz}.`);
finish(0, "applied");
