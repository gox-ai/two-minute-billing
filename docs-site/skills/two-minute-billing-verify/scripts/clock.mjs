#!/usr/bin/env node
// Move a TEST business's clock with Time Travel, so renewals, trial ends and dunning run now.
//   node --env-file=.env <skill>/scripts/clock.mjs status
//   node --env-file=.env <skill>/scripts/clock.mjs start [--at 2026-11-01T00:00:00Z]   (default: now)
//   node --env-file=.env <skill>/scripts/clock.mjs advance (--by 1m|14d|36h | --to <ISO>)
//   node --env-file=.env <skill>/scripts/clock.mjs stop [--wipe]   (keeps test data unless --wipe)
// Options: --business biz_… (default TMBILLING_BUSINESS_ID).
// It checks the key is a test key first (GET /v1/me) and refuses anything else.
// Exit: 0 done · 1 bad input or request · 3 not a test key.
// Node 20.6+, no dependencies. Never prints the API key.

import { randomUUID } from "node:crypto";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const fail = (msg, code = 1) => {
  console.error(`clock: ${msg}`);
  process.exit(code);
};

const url = (process.env.TMBILLING_URL ?? "").replace(/\/$/, "");
const key = process.env.TMBILLING_API_KEY ?? "";
const biz = opt("business") ?? process.env.TMBILLING_BUSINESS_ID;
if (!url || !key) fail("TMBILLING_URL and TMBILLING_API_KEY must be set (run with --env-file).");
if (!biz) fail("pass --business biz_… or set TMBILLING_BUSINESS_ID.");
if (!["status", "start", "advance", "stop"].includes(cmd))
  fail("command: status | start | advance | stop");

async function call(method, path, body) {
  const headers = { Authorization: `Bearer ${key}` };
  if (method !== "GET")
    Object.assign(headers, { "Content-Type": "application/json", "Idempotency-Key": randomUUID() });
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    // A long advance runs every renewal in the interval before it answers.
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    fail(
      `${method} ${path} answered ${res.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 300)}`,
    );
  return json;
}

const me = await call("GET", "/v1/me");
const mode = me.credential?.livemode ?? (key.startsWith("sk_test_") ? "test" : "other");
if (mode !== "test")
  fail(`refused: this key's mode is "${mode}". Time Travel here needs a test key.`, 3);

const base = `/v1/businesses/${biz}/time_travel`;
const show = (tm, extra = {}) =>
  console.log(
    JSON.stringify(
      {
        status: tm.status,
        simulated_now: tm.simulated_now,
        genesis_time: tm.genesis_time,
        ...extra,
      },
      null,
      2,
    ),
  );

function addInterval(fromIso, by) {
  const m = /^(\d+)(h|d|w|m|y)$/.exec(by ?? "");
  if (!m) fail(`--by must look like 36h, 14d, 2w, 1m or 1y; got ${by}`);
  const n = Number(m[1]);
  const d = new Date(fromIso);
  if (m[2] === "h") d.setUTCHours(d.getUTCHours() + n);
  if (m[2] === "d") d.setUTCDate(d.getUTCDate() + n);
  if (m[2] === "w") d.setUTCDate(d.getUTCDate() + 7 * n);
  if (m[2] === "m") d.setUTCMonth(d.getUTCMonth() + n);
  if (m[2] === "y") d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString();
}

if (cmd === "status") show(await call("GET", base));

if (cmd === "start") {
  const at = opt("at") ?? new Date().toISOString();
  show(await call("POST", `${base}/start`, { genesis_time: new Date(at).toISOString() }));
}

if (cmd === "advance") {
  const now = await call("GET", base);
  if (now.status === "not_enabled" || !now.simulated_now)
    fail("Time Travel is not started. Run: clock.mjs start");
  const to = opt("to")
    ? new Date(opt("to")).toISOString()
    : addInterval(now.simulated_now, opt("by"));
  if (!(new Date(to) > new Date(now.simulated_now)))
    fail(`target ${to} is not after the simulated now ${now.simulated_now}.`);
  const r = await call("POST", `${base}/advance`, { to_time: to });
  show(r, { from: r.from, to: r.to, steps: r.steps });
}

if (cmd === "stop") {
  const wipe = rest.includes("--wipe");
  const r = await call("POST", `${base}/stop`, { wipe });
  show(r, {
    wiped: r.wiped,
    note: wipe ? "test customers and transactions deleted" : "test data kept",
  });
}
