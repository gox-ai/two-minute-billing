#!/usr/bin/env node
// Go-live audit, read-only. Two passes:
//   1. snapshot (test key):   node --env-file=.env go-live-audit.mjs snapshot [--out billing-snapshot.json]
//      Records the test business's catalog and its live twin's id.
//   2. audit (read-only LIVE key in TMBILLING_LIVE_READ_KEY):
//                             node --env-file=.env go-live-audit.mjs audit [--snapshot billing-snapshot.json]
//      Refuses unless GET /v1/me says the key is live AND read-only, so it cannot change anything.
// Exit: 0 no FAIL · 1 bad input or request · 2 at least one FAIL · 3 wrong kind of key.
// Node 20.6+, no dependencies. Never prints a key.

import { readFileSync, writeFileSync } from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};
const fail = (msg, code = 1) => {
  console.error(`go-live-audit: ${msg}`);
  process.exit(code);
};
const url = (process.env.TMBILLING_URL ?? "").replace(/\/$/, "");
if (!url) fail("TMBILLING_URL is not set (run with --env-file).");
if (!["snapshot", "audit"].includes(cmd)) fail("command: snapshot | audit");

function client(key) {
  const get = async (path) => {
    const res = await fetch(`${url}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
  const all = async (path) => {
    const out = [];
    let after;
    for (let page = 0; page < 50; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await get(`${path}${sep}limit=100${after ? `&starting_after=${after}` : ""}`);
      if (r.status !== 200) return { status: r.status, data: out };
      out.push(...(r.body.data ?? []));
      if (!r.body.has_more || !r.body.data?.length) break;
      after = r.body.data.at(-1).id;
    }
    return { status: 200, data: out };
  };
  return { get, all };
}

async function whoami(key, want) {
  const me = await client(key).get("/v1/me");
  if (me.status !== 200)
    fail(`GET /v1/me answered ${me.status}: the key was refused or the server is not reachable.`);
  const c = me.body.credential;
  if (!c)
    fail(
      "this server does not report the key's mode (GET /v1/me has no credential). Update the server first.",
      3,
    );
  if (want === "test" && c.livemode !== "test")
    fail(`snapshot needs a test key; this key is ${c.livemode}.`, 3);
  if (want === "live-read" && !(c.livemode === "live" && c.access === "read")) {
    fail(
      `audit needs a read-only live key in TMBILLING_LIVE_READ_KEY; this key is ${c.livemode}/${c.access}.`,
      3,
    );
  }
  return me.body;
}

if (cmd === "snapshot") {
  const key = process.env.TMBILLING_API_KEY ?? "";
  const biz = opt("business", process.env.TMBILLING_BUSINESS_ID);
  if (!key || !biz)
    fail("TMBILLING_API_KEY and TMBILLING_BUSINESS_ID (or --business) must be set.");
  await whoami(key, "test");
  const c = client(key);
  const b = await c.get(`/v1/businesses/${biz}`);
  if (b.status !== 200) fail(`GET business ${biz} answered ${b.status}.`);
  const products = await c.all(`/v1/businesses/${biz}/products`);
  const prices = await c.all(`/v1/businesses/${biz}/prices`);
  const snapshot = {
    taken_at: new Date().toISOString(),
    test_business: biz,
    live_business: b.body.live_business_id,
    products: products.data.map((p) => p.id),
    prices: prices.data
      .filter((p) => p.active !== false)
      .map((p) => ({ id: p.id, currency: p.currency })),
  };
  const out = opt("out", "billing-snapshot.json");
  writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `Wrote ${out}: ${snapshot.products.length} products, ${snapshot.prices.length} active prices; live business ${snapshot.live_business}.`,
  );
  process.exit(0);
}

// audit
const key = process.env.TMBILLING_LIVE_READ_KEY ?? "";
if (!key)
  fail(
    "TMBILLING_LIVE_READ_KEY is not set. Ask the user to create a read-only live key and add it to the env file.",
  );
const me = await whoami(key, "live-read");
const snap = JSON.parse(readFileSync(opt("snapshot", "billing-snapshot.json"), "utf8"));
const live = snap.live_business;
if (!live) fail("the snapshot has no live business id.");
const c = client(key);
const rows = [];
const add = (level, check, detail) => rows.push({ level, check, detail });

if (me.status === "restricted")
  add(
    "FAIL",
    "organization can write",
    "read-only (unpaid plan or over its limit): live writes answer 403",
  );
else add("PASS", "organization can write", "active");
if (me.live_access === "locked")
  add("FAIL", "live mode open", "live mode is locked for this organization: contact support");

const biz = await c.get(`/v1/businesses/${live}`);
if (biz.status !== 200) add("FAIL", "live business", `GET answered ${biz.status}`);
else add("PASS", "live business", `${biz.body.name} (${biz.body.default_currency})`);

const gw = await c.all(`/v1/businesses/${live}/gateway_accounts`);
const catalog = (await c.get("/v1/gateways")).body.data ?? [];
const active = gw.data.filter((g) => !g.status || g.status === "active");
if (gw.status !== 200) add("FAIL", "payment gateway", `GET answered ${gw.status}`);
else if (!active.length)
  add("FAIL", "payment gateway", "no active gateway account on the live business");
else {
  add(
    "PASS",
    "payment gateway",
    active.map((g) => `${g.gateway_key}${g.default ? " (default)" : ""}`).join(", "),
  );
  const covered = new Set();
  for (const g of active) {
    const cur = g.currencies ?? catalog.find((x) => x.key === g.gateway_key)?.currencies ?? [];
    for (const x of cur) covered.add(String(x).toUpperCase());
  }
  const needed = [...new Set(snap.prices.map((p) => p.currency.toUpperCase()))];
  const missing = needed.filter((x) => covered.size && !covered.has(x));
  if (missing.length)
    add(
      "FAIL",
      "gateway covers every price currency",
      `no active gateway takes ${missing.join(", ")}`,
    );
  else add("PASS", "gateway covers every price currency", needed.join(", "));
}

const lp = new Set((await c.all(`/v1/businesses/${live}/products`)).data.map((p) => p.id));
const lpr = new Set((await c.all(`/v1/businesses/${live}/prices`)).data.map((p) => p.id));
const mp = snap.products.filter((id) => !lp.has(id));
const mpr = snap.prices.filter((p) => !lpr.has(p.id)).map((p) => p.id);
if (mp.length || mpr.length)
  add(
    "FAIL",
    "catalog copied to live",
    `missing products [${mp.join(", ")}] prices [${mpr.join(", ")}]`,
  );
else
  add(
    "PASS",
    "catalog copied to live",
    `${snap.products.length} products, ${snap.prices.length} prices`,
  );

const hooks = (await c.all("/v1/webhook_endpoints")).data.filter(
  (h) => h.enabled !== false && h.livemode === "live" && (!h.business || h.business === live),
);
if (!hooks.length)
  add("FAIL", "live webhook endpoint", "none: the app will not learn about payments");
else if (hooks.some((h) => !String(h.url).startsWith("https://")))
  add("FAIL", "live webhook endpoint", "a live endpoint is not https");
else add("PASS", "live webhook endpoint", hooks.map((h) => h.url).join(", "));

const smtp = await c.get(`/v1/businesses/${live}/emails/smtp`);
if (smtp.status === 200 && smtp.body.delivers === false)
  add("WARN", "customer emails", "emails are not delivered (no sending set up)");
else if (smtp.status === 200)
  add(
    "PASS",
    "customer emails",
    `${smtp.body.effective_transport ?? "set"} from ${smtp.body.effective_from_address ?? "?"}`,
  );

const tax = await c.all(`/v1/businesses/${live}/tax_profiles`);
if (tax.status === 200 && !tax.data.some((t) => t.active !== false))
  add("WARN", "tax", "no tax profile: invoices carry no tax. Confirm that is right for the user.");
else if (tax.status === 200) add("PASS", "tax", `${tax.data.length} tax profile(s)`);

const dun = await c.all(`/v1/businesses/${live}/dunning_policies`);
if (dun.status === 200 && !dun.data.length)
  add("WARN", "failed-payment retries", "no dunning policy: the defaults apply");
else if (dun.status === 200)
  add("PASS", "failed-payment retries", `${dun.data.length} policy(ies)`);

for (const r of rows) console.log(`${r.level.padEnd(4)}  ${r.check.padEnd(36)} ${r.detail}`);
const fails = rows.filter((r) => r.level === "FAIL").length;
console.log(
  `\n${fails ? `${fails} FAIL` : "No FAIL"} · ${rows.filter((r) => r.level === "WARN").length} WARN · live business ${live}`,
);
process.exit(fails ? 2 : 0);
