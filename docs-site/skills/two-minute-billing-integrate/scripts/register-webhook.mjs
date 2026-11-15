#!/usr/bin/env node
// Register a webhook endpoint and put its signing secret straight into the project's env file,
// so the secret never passes through the terminal or the agent's context.
//   node --env-file=.env <skill>/scripts/register-webhook.mjs --url https://app.example.com/webhooks/billing \
//     --env-file-out .env [--business biz_…] [--events invoice_paid,payment_failed] [--json]
// --business defaults to TMBILLING_BUSINESS_ID. No --events: the endpoint gets every event.
// It appends TMBILLING_WEBHOOK_SECRET=… to the --env-file-out file and prints only the endpoint
// id, URL and events. It refuses before it creates anything when that file is tracked by git or
// already holds TMBILLING_WEBHOOK_SECRET, when the URL is not https (http is allowed for
// localhost, 127.0.0.1 and [::1] only), and when the key is not a test key (GET /v1/me).
// Exit: 0 created, secret written · 1 bad input or request · 2 refused: the env file is
//       tracked or already has a secret · 3 not a test key.
// Node 20.6+, no dependencies. Never prints the API key or the signing secret.

import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const asJson = argv.includes("--json");
const fail = (msg, code = 1) => {
  console.error(`register-webhook: ${msg}`);
  process.exit(code);
};
const warn = (msg) => console.error(`register-webhook: warning: ${msg}`);

const url = (process.env.TMBILLING_URL ?? "").replace(/\/$/, "");
const key = process.env.TMBILLING_API_KEY ?? "";
if (!url || !key) fail("TMBILLING_URL and TMBILLING_API_KEY must be set (run with --env-file).");
const target = opt("url");
const outArg = opt("env-file-out");
const biz = opt("business") ?? process.env.TMBILLING_BUSINESS_ID;
if (!target) fail("pass --url https://<your app>/<webhook path>.");
if (!outArg) fail("pass --env-file-out <the project's untracked env file, e.g. .env>.");
if (!biz) fail("pass --business biz_… or set TMBILLING_BUSINESS_ID.");
const events = opt("events")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (opt("events") !== undefined && !events?.length) fail("--events is empty.");

let u;
try {
  u = new URL(target);
} catch {
  fail(`not a URL: ${target}`);
}
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback))
  fail("the URL must be https (http only for localhost, 127.0.0.1 or [::1]).");

// The env file: never a tracked one, never one that already holds a secret.
const out = resolve(outArg);
const SECRET_LINE = /^\s*(export\s+)?TMBILLING_WEBHOOK_SECRET\s*=/m;
if (existsSync(out) && SECRET_LINE.test(readFileSync(out, "utf8")))
  fail(
    `${outArg} already has TMBILLING_WEBHOOK_SECRET. Delete the old endpoint and that line ` +
      "first, or keep the endpoint you have.",
    2,
  );
const git = (args) =>
  spawnSync("git", args, { cwd: dirname(out), encoding: "utf8", stdio: "pipe" });
const tracked = git(["ls-files", "--error-unmatch", "--", basename(out)]);
if (tracked.error) warn(`git not found: make sure ${outArg} is never committed.`);
else if (tracked.status === 0)
  fail(`${outArg} is tracked by git. Use an untracked env file (and add it to .gitignore).`, 2);
else if (tracked.status === 1 && git(["check-ignore", "-q", "--", basename(out)]).status === 1)
  warn(`${outArg} is not in .gitignore: add it, so the secret is never committed.`);
try {
  accessSync(existsSync(out) ? out : dirname(out), constants.W_OK);
} catch {
  fail(`cannot write ${outArg}.`);
}

async function call(method, path, body) {
  const headers = { Authorization: `Bearer ${key}` };
  if (method !== "GET")
    Object.assign(headers, { "Content-Type": "application/json", "Idempotency-Key": randomUUID() });
  let res;
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
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

const me = await call("GET", "/v1/me");
const mode = me.credential?.livemode ?? (key.startsWith("sk_test_") ? "test" : "other");
if (mode !== "test")
  fail(`refused: this key's mode is "${mode}". Register test endpoints with a test key.`, 3);

const endpoint = await call("POST", "/v1/webhook_endpoints", {
  url: target,
  business: biz,
  ...(events ? { event_types: events } : {}),
});
const line = `TMBILLING_WEBHOOK_SECRET=${endpoint.signing_secret}\n`;
try {
  if (existsSync(out)) {
    const text = readFileSync(out, "utf8");
    appendFileSync(out, (text && !text.endsWith("\n") ? "\n" : "") + line);
  } else writeFileSync(out, line, { mode: 0o600 });
} catch (e) {
  fail(
    `endpoint ${endpoint.id} was created, but ${outArg} could not be written (${e.message}). ` +
      `Rotate its secret (POST /v1/webhook_endpoints/${endpoint.id}/rotate_secret) or delete it.`,
  );
}

const report = {
  endpoint: endpoint.id,
  url: endpoint.url,
  business: endpoint.business,
  mode: endpoint.livemode,
  events: endpoint.event_types ?? "all",
  secret: `written to ${outArg} as TMBILLING_WEBHOOK_SECRET`,
};
if (asJson) console.log(JSON.stringify({ ok: true, ...report }, null, 2));
else
  for (const [k, v] of Object.entries(report))
    console.log(`${k.padEnd(9)} ${Array.isArray(v) ? v.join(", ") : v}`);
