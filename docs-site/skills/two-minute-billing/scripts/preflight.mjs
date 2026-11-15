#!/usr/bin/env node
// Preflight: which server, organization and mode does TMBILLING_API_KEY reach?
// Run with the project's env file so the key never enters the agent's context:
//   node --env-file=.env <skill>/scripts/preflight.mjs [--allow-live-read] [--json]
// Exit codes: 0 test key, ready · 1 config missing · 2 server or auth failed
//             3 live key that can write (refused) · 4 live read-only key (only with --allow-live-read)
// Node 20.6+, no dependencies. Prints the key's prefix only, never the key.

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const url = (process.env.TMBILLING_URL ?? "").replace(/\/$/, "");
const key = process.env.TMBILLING_API_KEY ?? "";

function done(code, report) {
  if (asJson) console.log(JSON.stringify({ ok: code === 0, exit: code, ...report }, null, 2));
  else {
    for (const [k, v] of Object.entries(report))
      console.log(`${k.padEnd(14)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  process.exit(code);
}

const missing = [!url && "TMBILLING_URL", !key && "TMBILLING_API_KEY"].filter(Boolean);
if (missing.length) {
  done(1, {
    result: "missing settings",
    missing,
    next: "Ask the user to add them to the project's untracked env file, then run this with --env-file.",
  });
}
if (!/^https?:\/\//.test(url))
  done(1, { result: "TMBILLING_URL must start with http:// or https://" });

const prefix = key.slice(0, key.indexOf("_", 3) + 1) || "(unknown)";
const headers = { Authorization: `Bearer ${key}` };

async function get(path) {
  const res = await fetch(`${url}${path}`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// The usual wrong value is the website or the dashboard: neither is the API.
const whereIsTheApi =
  "TMBILLING_URL must be the API host: https://api.twominutebilling.com on Cloud; on a " +
  "self-hosted install its own API host (http://localhost:4000 locally). The website and " +
  "the dashboard are not the API.";

let me;
try {
  me = await get("/v1/me");
} catch (e) {
  done(2, {
    result: "server not reachable",
    server: url,
    error: String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e),
    next:
      e?.cause?.code === "ENETUNREACH"
        ? "The name resolved to an address this machine cannot route to (often IPv6 with no IPv6 " +
          "route). Run with NODE_OPTIONS=--dns-result-order=ipv4first, or fix the resolver."
        : whereIsTheApi,
  });
}
if (me.status === 401)
  done(2, { result: "the key was refused (401)", server: url, key: `${prefix}…` });
if (me.status !== 200)
  done(2, { result: `unexpected answer ${me.status}`, server: url, next: whereIsTheApi });

// Servers before 2026-11 do not send `credential`; then the key prefix is the only signal.
const cred = me.body.credential ?? null;
const livemode =
  cred?.livemode ?? (prefix === "sk_test_" ? "test" : prefix === "sk_live_" ? "live" : "unknown");
const access = cred?.access ?? "unknown";

let businesses = [];
const list = await get("/v1/businesses").catch(() => null);
if (list?.status === 200) {
  businesses = (list.body.data ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    livemode: b.livemode,
    currency: b.default_currency,
  }));
}

const report = {
  server: url,
  organization: `${me.body.name} (${me.body.id})`,
  key: `${prefix}…`,
  mode: livemode,
  access,
  mode_source: cred ? "server" : "key prefix (older server)",
  businesses,
};
if (me.body.status === "restricted")
  report.warning = "The organization is read-only (status restricted): writes answer 403.";

if (livemode === "test") done(0, { result: "ready: test mode", ...report });
if (livemode === "live" && access === "read" && args.has("--allow-live-read")) {
  done(4, { result: "live, read-only: reads allowed, writes impossible", ...report });
}
if (livemode === "live" || livemode === "all") {
  done(3, {
    result: "refused: this key can change live data",
    ...report,
    next: "Use a sk_test_ key for setup. For a live audit, use a read-only live key with --allow-live-read.",
  });
}
done(2, { result: "could not tell the key's mode", ...report });
