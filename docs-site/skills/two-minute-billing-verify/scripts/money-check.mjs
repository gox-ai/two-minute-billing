#!/usr/bin/env node
// Money check: compare a real invoice with the figures the user's pricing says it must have.
// The script fetches the invoice itself, so the "actual" side can never be typed in by hand.
//   node --env-file=.env <skill>/scripts/money-check.mjs --expected expected.json \
//     (--invoice inv_… | --subscription sub_… | --session cosess_…) [--business biz_…] [--report out.json]
// --subscription checks its newest invoice; --session checks the invoice a checkout raised
// (a one-time purchase, or the first invoice of a new subscription).
// expected.json (minor units, integers; every field optional except total_minor):
//   { "currency": "USD", "total_minor": 2900, "subtotal_minor": 2900, "tax_minor": 0,
//     "document_level_discount_minor": 0, "credits_applied_minor": 0, "amount_due_minor": 0,
//     "status": "paid",
//     "lines": [ { "price": "pro-monthly-usd", "amount_minor": 2900, "quantity_decimal": "1" } ],
//     "taxes": [ { "name": "CGST", "rate_bps": 900, "amount_minor": 891 } ],
//     "metadata": { "order_id": "1042" } }
// "taxes" lists every tax line the invoice must carry (as GET /invoices/{id} returns them;
// rate_bps optional); an extra or a missing line differs. "metadata" checks only the keys given.
// Exit: 0 every field matches · 1 bad input or request, or no invoice yet (a subscription
//       not yet invoiced, a checkout session not yet completed) · 2 a field differs.
// Node 20.6+, no dependencies. Never prints the API key.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`money-check: ${msg}`);
  process.exit(1);
};

const url = (process.env.TMBILLING_URL ?? "").replace(/\/$/, "");
const key = process.env.TMBILLING_API_KEY ?? "";
const biz = opt("business") ?? process.env.TMBILLING_BUSINESS_ID;
if (!url || !key) fail("TMBILLING_URL and TMBILLING_API_KEY must be set (run with --env-file).");
if (!biz) fail("pass --business biz_… or set TMBILLING_BUSINESS_ID.");
const expectedPath = opt("expected");
if (!expectedPath) fail("pass --expected <file.json>.");

let expected;
try {
  expected = JSON.parse(readFileSync(expectedPath, "utf8"));
} catch (e) {
  fail(`cannot read ${expectedPath}: ${e.message}`);
}
if (expected.taxes !== undefined && !Array.isArray(expected.taxes))
  fail("expected.taxes must be an array of { name, rate_bps?, amount_minor }.");
for (const t of expected.taxes ?? [])
  if (!t?.name || !Number.isInteger(t.amount_minor))
    fail(`each expected tax needs a name and an integer amount_minor, got ${JSON.stringify(t)}.`);
if (!Number.isInteger(expected.total_minor))
  fail("expected.total_minor must be an integer (minor units).");
for (const [k, v] of Object.entries(expected)) {
  if (k.endsWith("_minor") && !Number.isInteger(v))
    fail(`expected.${k} must be an integer, got ${JSON.stringify(v)}.`);
}

async function get(path) {
  const res = await fetch(`${url}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) fail(`GET ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  return { text, body: JSON.parse(text) };
}

let invoiceId = opt("invoice");
const sub = opt("subscription");
const session = opt("session");
if ([invoiceId, sub, session].filter(Boolean).length !== 1)
  fail("pass one of --invoice inv_…, --subscription sub_… or --session cosess_….");
if (session) {
  const { body: s } = await get(
    `/v1/businesses/${biz}/checkout_sessions/${encodeURIComponent(session)}`,
  );
  invoiceId = s.resulting_invoice;
  if (!invoiceId)
    fail(
      `checkout session ${session} has no invoice yet (status ${s.status}). ` +
        "Complete the checkout first, then run this again.",
    );
} else if (!invoiceId) {
  const q = new URLSearchParams({ subscription: sub, limit: "1", "sort_by[desc]": "created_at" });
  const { body } = await get(`/v1/businesses/${biz}/invoices?${q}`);
  invoiceId = body.data?.[0]?.id;
  if (!invoiceId) fail(`subscription ${sub} has no invoice yet.`);
}

const { text, body: inv } = await get(`/v1/businesses/${biz}/invoices/${invoiceId}`);
const rows = [];
const check = (field, want, got) =>
  rows.push({ field, expected: want, actual: got ?? null, ok: want === got });

for (const [k, v] of Object.entries(expected)) {
  if (k === "lines" || k === "taxes" || k === "metadata") continue;
  check(k, v, inv[k]);
}
if (Array.isArray(expected.taxes)) {
  const actual = inv.taxes ?? [];
  check("taxes count", expected.taxes.length, actual.length);
  for (const [i, t] of expected.taxes.entries()) {
    const match = actual.filter(
      (a) => a.name === t.name && (t.rate_bps === undefined || a.rate_bps === t.rate_bps),
    );
    const label = `taxes[${i}] ${t.name}`;
    if (match.length !== 1) {
      rows.push({
        field: label,
        expected: "exactly one tax line",
        actual: `${match.length} lines`,
        ok: false,
      });
      continue;
    }
    check(`${label} amount_minor`, t.amount_minor, match[0].amount_minor);
  }
}
if (expected.metadata && typeof expected.metadata === "object") {
  for (const [k, v] of Object.entries(expected.metadata)) {
    const got = inv.metadata?.[k] ?? null;
    const ok = JSON.stringify(v) === JSON.stringify(got);
    rows.push({ field: `metadata.${k}`, expected: v, actual: got, ok });
  }
}
for (const [i, line] of (expected.lines ?? []).entries()) {
  const match = (inv.lines ?? []).filter((l) =>
    line.price ? l.price === line.price : l.description === line.description,
  );
  const label = `lines[${i}] ${line.price ?? line.description}`;
  if (match.length !== 1) {
    rows.push({
      field: label,
      expected: "exactly one line",
      actual: `${match.length} lines`,
      ok: false,
    });
    continue;
  }
  for (const [k, v] of Object.entries(line)) {
    if (k === "price" || k === "description") continue;
    check(`${label} ${k}`, v, match[0][k]);
  }
}

const ok = rows.every((r) => r.ok);
const report = {
  result: ok ? "match" : "differs",
  invoice: inv.id,
  number: inv.number ?? null,
  status: inv.status,
  currency: inv.currency,
  fetched_at: new Date().toISOString(),
  response_sha256: createHash("sha256").update(text).digest("hex"),
  rows,
};
for (const r of rows) {
  console.log(
    `${r.ok ? "ok  " : "DIFF"}  ${r.field.padEnd(40)} expected ${JSON.stringify(r.expected)}  actual ${JSON.stringify(r.actual)}`,
  );
}
console.log(
  `\n${ok ? "MATCH" : "DIFFERS"}: invoice ${inv.id} (${inv.status}, ${inv.currency}), sha256 ${report.response_sha256.slice(0, 16)}…`,
);
const out = opt("report");
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
process.exit(ok ? 0 : 2);
