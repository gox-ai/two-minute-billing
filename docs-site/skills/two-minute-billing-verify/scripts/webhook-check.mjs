#!/usr/bin/env node
// Webhook check: prove the app's local webhook route verifies signatures and tolerates repeats.
// No tunnel needed: it posts straight to the route on this machine.
//   node --env-file=.env <skill>/scripts/webhook-check.mjs --url http://localhost:3000/webhooks/billing [--type customer_updated]
// Sends three requests:
//   1. a bad signature             → must answer 401
//   2. a correctly signed event    → must answer 2xx
//   3. the same event again        → must answer 2xx (a repeat is normal; the handler dedupes on the id)
// Exit: 0 all three pass · 1 bad input · 2 a step failed. Only loopback URLs are accepted.
// Node 20.6+, no dependencies. Reads TMBILLING_WEBHOOK_SECRET; never prints it.

import { createHmac, randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`webhook-check: ${msg}`);
  process.exit(1);
};

const target = opt("url");
const secret = process.env.TMBILLING_WEBHOOK_SECRET ?? "";
if (!target) fail("pass --url http://localhost:<port>/<webhook path>.");
if (!secret) fail("TMBILLING_WEBHOOK_SECRET is not set (run with --env-file).");
let u;
try {
  u = new URL(target);
} catch {
  fail(`not a URL: ${target}`);
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
  fail(
    "only a loopback URL (localhost, 127.0.0.1, [::1]) is accepted, so this never posts to a real server.",
  );
}

// A type most handlers ignore, so the check proves the signature path without side effects.
const eventType = opt("type") ?? "customer_updated";
const id = `evt_check_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const raw = JSON.stringify({
  object: "event",
  id,
  event_type: eventType,
  occurred_at: new Date().toISOString(),
  api_version: "2026-06-20",
  source: "api",
  user: null,
  content: {},
});
const sign = (body) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

async function post(signature) {
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tmbilling-Signature": signature,
        "Tmbilling-Event-Id": id,
      },
      body: raw,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    return res.status;
  } catch (e) {
    fail(`could not reach ${target}: ${e?.cause?.code ?? e.message}. Is the app running?`);
  }
}

const steps = [];
const bad = await post("sha256=" + "0".repeat(64));
steps.push({ step: "bad signature is refused", want: "401", got: bad, ok: bad === 401 });
const good = await post(sign(raw));
steps.push({
  step: "signed event is accepted",
  want: "2xx",
  got: good,
  ok: good >= 200 && good < 300,
});
const again = await post(sign(raw));
steps.push({
  step: "repeat of the same event is accepted",
  want: "2xx",
  got: again,
  ok: again >= 200 && again < 300,
});

for (const s of steps)
  console.log(`${s.ok ? "ok  " : "FAIL"}  ${s.step.padEnd(40)} want ${s.want}, got ${s.got}`);
const ok = steps.every((s) => s.ok);
if (!ok && bad >= 200 && bad < 300)
  console.log("\nThe route accepted a forged event: it does not check the signature.");
if (!ok && good === 401)
  console.log(
    "\nThe route refused a correct signature: check it hashes the RAW body, before any JSON parser.",
  );
console.log(`\n${ok ? "PASS" : "FAIL"}: ${target} (event type ${eventType}, id ${id})`);
process.exit(ok ? 0 : 2);
