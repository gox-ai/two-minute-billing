/**
 * Proves the idempotency middleware is race-safe on several axes:
 *
 *  A) CONCURRENCY — fire N concurrent writes with the SAME Idempotency-Key and
 *     assert exactly ONE side effect (one row created), never duplicates: the
 *     property the unique (org,key) + onConflictDoNothing design guarantees.
 *
 *  B) EARLY RETURN (availability) — a write route that replies BEFORE its
 *     idempotency record is written must not double-send, must not crash the
 *     process, and must not poison the key.
 *
 *  D) POST-SIDE-EFFECT FAILURE (money safety) — a non-2xx raised AFTER the request
 *     already wrote something durable must NOT free the key. Dropping the record
 *     there makes the client's retry RE-EXECUTE instead of replay, which on a
 *     billing path charges the card twice. A non-2xx that wrote nothing must still
 *     free the key (axis B). The two are told apart by the record's own status,
 *     stamped inside the writing transaction — never guessed from the status code.
 *
 *     The bug axis B locks down (2026-08-03): `idempotencyOnSend` awaits a
 *     `withTenant` write, so between `reply.send()` and the real `writeHead` the
 *     reply is not yet `sent`. A handler that replied through a helper and then
 *     `return`ed BARE resolves inside that window, and Fastify's `wrap-thenable`
 *     — seeing `payload === undefined && reply.sent === false` — starts a SECOND
 *     send. The second `safeWriteHead` throws `ERR_HTTP_HEADERS_SENT` from a
 *     promise reaction: unhandled, so the API process DIES. Any authenticated
 *     caller could trigger it (bogus business id, or a non-all-mode key on an
 *     all-mode-only route) with an `Idempotency-Key` header → DoS.
 *
 *  COVERAGE (money safety) — the axes above only exercise routes that ALREADY carry
 *     the middleware, so a write route that should have it and doesn't is invisible to
 *     all of them. The `COVERAGE` section pins the two `…/items` routes by name: they
 *     were the only subscription writes shipped without it, and a duplicate POST there
 *     double-added AND double-charged (measured before the 2026-08-03 fix: items
 *     1→2→3, invoices 1→2→3 for one retried request).
 *
 *  F) STALE-KEY REAP (2026-08-03) — a process that dies mid-request used to leave its
 *     record at `in_progress`/`side_effects` FOREVER, 409-ing every later retry with no
 *     way out short of manual DB surgery (safe — it never re-executes — but stuck).
 *     `in_progress` (nothing durable written) is now reclaimed for a fresh attempt once
 *     its `locked_at` is older than `IDEMPOTENCY_STALE_MS`; `side_effects` (a write
 *     landed before the crash) is NEVER freed for re-execution, only converted to a
 *     terminal `failed` that explains why. F1 proves RED (a freshly-locked row still
 *     409s) then GREEN (the identical row, once stale, is reclaimed and the retry
 *     succeeds) for the recovery case; F2 proves a stale `side_effects` row is never
 *     re-executed; F3 proves a fresh `in_progress` row still 409s (the reaper does not
 *     weaken real concurrency protection).
 *
 *   pnpm verify:idempotency-race
 *
 * Runs entirely IN-PROCESS (app.inject) — it never touches a running dev server.
 * The `uncaughtException` / `unhandledRejection` listeners below are what turn the
 * crash into an observable assertion instead of a dead process.
 */
import type { FastifyRequest } from "fastify";
import { eq, and, sql } from "drizzle-orm";
// Section E's coverage check reads the route sources back, so a write route added
// later cannot ship without the middleware pair (see E6).
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildApp } from "@/index";
import { runBillingClockTickOnce } from "@/platform/jobs";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createApiKey, revokeApiKey } from "@/modules/tenancy/service";
import {
  businesses,
  idempotencyKeys,
  subscriptions,
  subscriptionItems,
  invoices,
  creditNotes,
  customers,
  unbilledCharges,
  payments,
  apiKeys,
} from "@db/schema";

// Axis D probes need the real middleware pair on a route whose failure mode we control.
import { authenticate } from "@/platform/auth";
import { noMemberPermission } from "@/api/helpers";
import {
  idempotency,
  idempotencyOnSend,
  idempotentNoStore,
  IDEMPOTENCY_STALE_MS,
  reapStaleIdempotencyKeys,
} from "@/platform/idempotency";
import { createBusiness } from "@/modules/tenancy/service";

const crashes: Array<Error & { code?: string }> = [];
process.on("uncaughtException", (e) => crashes.push(e as Error));
process.on("unhandledRejection", (e) => crashes.push(e as Error));

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
}

const app = await buildApp({ logger: false });

// A probe route with the exact broken shape, registered before `ready`: an async
// onSend hook (like idempotencyOnSend) that keeps the reply un-`sent` while the
// handler replies and then returns BARE. Nothing here awaits the reply, so this
// isolates the `platform/reply-guard.ts` net itself — before the guard existed this
// route killed the process.
app.post(
  "/__probe/double_send",
  {
    onSend: (_req, _reply, payload, done) => {
      setTimeout(() => done(null, payload), 25);
    },
  },
  async (_req, reply) => {
    reply.code(418).send({ probe: "early return, bare return" });
    return;
  },
);

// Same stale-`reply.sent` gate one stage earlier: a preHandler that replies and
// bare-returns used to let the HANDLER run anyway (silently doing the write while the
// caller saw only the hook's error). The guard must skip the handler instead.
let probeHandlerRan = false;
app.post(
  "/__probe/prehandler_bare",
  {
    preHandler: async (_req, reply) => {
      reply.code(401).send({ error: { type: "authentication_error", message: "probe" } });
    },
    onSend: (_req, _reply, payload, done) => {
      setTimeout(() => done(null, payload), 25);
    },
  },
  async () => {
    probeHandlerRan = true;
    return { ok: true };
  },
);

// ── axis D probes: real middleware, controlled failure ────────────────────────
//
// A 500 raised AFTER a durable write is the case no status code can identify, and
// no production route fails on demand. These three carry the REAL
// `[authenticate, idempotency]` + `idempotencyOnSend` pair, so what they prove is
// the middleware's behaviour, not a mock's:
//   write_then_500     — writes, then throws  → record must survive as `failed`
//   fail_before_write  — throws immediately   → record must be DELETED (key free)
//   read_then_404      — reads, then 404s     → record must be DELETED (a read is
//                        not a side effect; if it counted, every early return would
//                        poison its key again)
// `probeExecutions` counts real handler entries — the direct evidence that a retry
// replays instead of re-running.
let probeExecutions = 0;
const idemRoute = {
  preHandler: [authenticate, noMemberPermission("test probe route"), idempotency],
  onSend: idempotencyOnSend,
};

app.post("/__probe/write_then_500", idemRoute, async (req) => {
  probeExecutions += 1;
  // A genuine durable write on a real table, through the normal service path.
  await createBusiness({
    organizationId: req.organization!.id,
    name: `Probe Side Effect ${probeExecutions}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  throw new Error("exploded AFTER writing — the client cannot know what happened");
});

let cleanFailExecutions = 0;
app.post("/__probe/fail_before_write", idemRoute, async () => {
  cleanFailExecutions += 1;
  throw new Error("exploded BEFORE writing anything");
});

app.post("/__probe/read_then_404", idemRoute, async (req, reply) => {
  const orgUuid = req.organization!.id;
  await withTenant(orgUuid, async (tx) => tx.select().from(businesses).limit(1));
  return reply.code(404).send({ error: { type: "not_found", message: "probe: read, then 404" } });
});

// ── axis G probes: the no-store opt-out, as a matched RED/GREEN pair ───────────
//
// Two routes with the SAME handler minting the SAME kind of one-time secret. The only
// difference is `config: idempotentNoStore`, so whatever differs in the stored row is
// caused by the flag and nothing else. The RED twin is the regression reproduced live —
// it is not a pre-fix memory, it runs in this process.
let noStoreExecutions = 0;
const mintSecret = async (req: FastifyRequest) => {
  noStoreExecutions += 1;
  const { apiKey, secret } = await createApiKey(req.organization!.id, "test");
  return { object: "api_key", id: apiKey.publicId, prefix: apiKey.prefix, secret };
};
app.post("/__probe/mint_secret", idemRoute, mintSecret);
app.post("/__probe/mint_secret_nostore", { ...idemRoute, config: idempotentNoStore }, mintSecret);

// The `failed` half of the opt-out: a no-store route that WRITES and then throws must
// still be un-re-executable, must still store no body, and its replay must report the
// original FAILURE — never "already created".
//
// It writes through `createBusiness` (a `withTenant` write, the same one axis D proves is
// tracked) rather than `createApiKey`. That was originally forced: `createApiKey` went
// through the BASE `db` handle — one of the documented blind spots in `platform/db.ts` —
// so its write was never stamped `side_effects` and this probe would have read as clean.
// `createApiKey` now writes through `withTenant` too (2026-08-04), so either would do;
// `createBusiness` stays because what is under test here is the no-store marker on the
// `failed` path, not which table the write landed in.
let noStoreFailExecutions = 0;
app.post(
  "/__probe/nostore_write_then_500",
  { ...idemRoute, config: idempotentNoStore },
  async (req) => {
    noStoreFailExecutions += 1;
    await createBusiness({
      organizationId: req.organization!.id,
      name: `No-Store Side Effect ${noStoreFailExecutions}`,
      defaultCurrency: "USD",
      livemode: "test",
    });
    throw new Error("exploded AFTER writing — its response body may have carried a secret");
  },
);

// ── A. concurrency: one key → one effect ──────────────────────────────────────
const org = await createOrganization({ name: "Race Org" });
const orgId = org.organization.id;

const N = 12;
const key = `race-key-${org.organization.publicId}`;
const body = JSON.stringify({ name: "Race Biz", default_currency: "USD" });

// Fire N concurrent identical POSTs with the same Idempotency-Key.
const results = await Promise.all(
  Array.from({ length: N }, () =>
    app.inject({
      method: "POST",
      url: "/v1/businesses",
      headers: {
        authorization: `Bearer ${org.secret}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      payload: body,
    }),
  ),
);

const codes = results.map((r) => r.statusCode).sort();
const created = codes.filter((c) => c === 201).length;
const conflicts = codes.filter((c) => c === 409).length;
const other = codes.filter((c) => c !== 201 && c !== 409).length;

// The decisive check: how many rows actually got created?
const rows = await withTenant(orgId, (tx) =>
  // A create writes the live row and its test twin; the side effect is the live row.
  tx
    .select()
    .from(businesses)
    .where(and(eq(businesses.name, "Race Biz"), eq(businesses.livemode, "live"))),
);

console.log(`responses: ${created}×201, ${conflicts}×409, ${other}×other`);
console.log(`businesses actually created: ${rows.length} (MUST be 1)`);

// All 201 responses must reference the SAME business id (replays are consistent).
const ids = new Set(
  results.filter((r) => r.statusCode === 201).map((r) => (JSON.parse(r.body) as { id: string }).id),
);
console.log(`distinct business ids in 201 responses: ${ids.size}`);

check("concurrency — exactly one side effect", rows.length === 1, `${rows.length} business row(s)`);
check(
  "concurrency — every 201 points at the same row",
  ids.size === 1,
  `${ids.size} distinct id(s)`,
);
check(
  "concurrency — only 201/409 responses",
  other === 0 && created + conflicts === N,
  `${created}×201 ${conflicts}×409 ${other}×other`,
);

// ── B. early returns must not double-send ─────────────────────────────────────
console.log("");
const { secret: allKey } = { secret: org.secret }; // bootstrap key is all-mode
const { secret: testKey } = await createApiKey(orgId, "test");

const H = (k: string, idem?: string) => ({
  authorization: `Bearer ${k}`,
  "content-type": "application/json",
  ...(idem ? { "idempotency-key": idem } : {}),
});

/** Inject, then drain timers/IO so a LATE double-send surfaces before we assert. */
async function send(
  method: "POST" | "DELETE",
  url: string,
  k: string,
  idem: string | undefined,
  payload: unknown,
) {
  const before = crashes.length;
  const res = await app.inject({ method, url, headers: H(k, idem), payload: payload as object });
  await new Promise((r) => setTimeout(r, 300));
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  return {
    status: res.statusCode,
    body: parsed,
    headers: res.headers,
    newCrashes: crashes.length - before,
  };
}

async function post(url: string, k: string, idem: string | undefined, payload: unknown) {
  return send("POST", url, k, idem, payload);
}

/**
 * DELETE has no body, so it must NOT carry `content-type: application/json` —
 * Fastify rejects that combination with a 400 before any route code runs.
 */
async function del(url: string, k: string, idem?: string) {
  const before = crashes.length;
  const headers: Record<string, string> = {
    authorization: `Bearer ${k}`,
    ...(idem ? { "idempotency-key": idem } : {}),
  };
  const res = await app.inject({ method: "DELETE", url, headers });
  await new Promise((r) => setTimeout(r, 300));
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  return {
    status: res.statusCode,
    body: parsed,
    headers: res.headers,
    newCrashes: crashes.length - before,
  };
}

const crashDetail = (n: number) =>
  n === 0
    ? "no uncaught error"
    : `${n} UNCAUGHT: ${crashes.at(-1)?.code ?? ""} ${crashes.at(-1)?.message}`;

/**
 * Compare a replayed body against the original by VALUE, not by serialization.
 * `idempotency_keys.response_body` is `jsonb`, and Postgres jsonb does not preserve
 * object key order — it normalizes (keys sorted by length, then bytewise). So a
 * faithful replay of `{object, invoiced, invoice}` comes back as
 * `{object, invoice, invoiced}`: identical to every JSON consumer, but not
 * string-equal. Asserting on JSON.stringify here reports a replay bug that isn't one.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

async function keyRow(k: string) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.organizationId, orgId), eq(idempotencyKeys.key, k)))
      .limit(1);
    return row ?? null;
  });
}

/**
 * A fixture that failed to create used to poison every case below it: the ids came back
 * `undefined`, every later call 404'd, and the run then HUNG on a lookup by an undefined
 * public id rather than throwing — stalling the whole of `verify:all` behind this suite.
 * (That is exactly how commit 3ab3c78 landed here: it retired `customer.name`, this file
 * still sent it, the create 400'd, and 25 assertions failed for one reason.) Fail loudly
 * at the source instead.
 */
function requireFixtures(fixtures: Record<string, string | undefined>) {
  const missing = Object.entries(fixtures)
    .filter(([, id]) => !id)
    .map(([k]) => k);
  if (missing.length > 0) {
    /**
     * PRINT AND EXIT — never `throw`. This file installs `uncaughtException` and
     * `unhandledRejection` listeners that PUSH INTO `crashes` (that is how it counts
     * double-sends), so a top-level throw is swallowed: nothing prints, nothing closes the
     * app or the pool, and the open Postgres handles keep the event loop alive FOREVER.
     *
     * That is not hypothetical. It is exactly what made L6 look unfixable: enforcing
     * `Idempotency-Key` turned these keyless fixture calls into 400s, every id became
     * `undefined`, this guard threw, the throw was swallowed, and the suite HUNG. Three
     * separate investigations read that hang as a defect in the idempotency middleware. The
     * server was answering the keyless write in 36ms the whole time.
     *
     * A gate that hangs is worse than one that fails: a failure names itself.
     */
    console.error(`\n❌ fixture setup failed — no id returned for: ${missing.join(", ")}`);
    console.error("   (a 4xx on a fixture call, most likely — run with L6SEND tracing to see it)");
    process.exit(1);
  }
}

// Fixtures — a TEST business (so a test-mode key can reach it) + customer + price.
const biz = (
  await post("/v1/businesses", allKey, "fx-1", {
    name: "Race Co",
    default_currency: "USD",
    livemode: "test",
  })
).body as { id: string };
const product = (await post(`/v1/businesses/${biz.id}/products`, allKey, "fx-2", { name: "Pro" }))
  .body as { id: string };
const price = (
  await post(`/v1/businesses/${biz.id}/prices`, allKey, "fx-3", {
    product: product.id,
    model: "flat",
    currency: "USD",
    amount_minor: 4900,
    interval: "month",
  })
).body as { id: string };
const customer = (
  await post(`/v1/businesses/${biz.id}/customers`, allKey, "fx-4", {
    email: "race@a.com",
    first_name: "Race",
  })
).body as { id: string };
await post(`/v1/businesses/${biz.id}/customers/${customer.id}/payment_methods`, allKey, "fx-5", {
  token: "tok_4242",
});
requireFixtures({ business: biz.id, product: product.id, price: price.id, customer: customer.id });
console.log(`fixtures: biz=${biz.id} price=${price.id} customer=${customer.id}`);
console.log("");

const subUrl = `/v1/businesses/${biz.id}/customers/${customer.id}/subscriptions`;
const subBody = { items: [{ price: price.id, quantity: 1 }] };

// B1. 404 — resolveBusiness() replies, the handler `return`s bare (observed crash).
{
  const r = await post(
    "/v1/businesses/biz_does_not_exist/customers/cus_nope/subscriptions",
    allKey,
    "race_404",
    subBody,
  );
  check(
    "404 unknown business (resolveBusiness + bare return) — no crash",
    r.newCrashes === 0,
    crashDetail(r.newCrashes),
  );
  check(
    "404 unknown business — clean 404 envelope",
    r.status === 404 &&
      String((r.body.error as Record<string, string>)?.message).startsWith("No such business"),
    `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`,
  );
  check(
    "404 unknown business — no idempotency record stored",
    (await keyRow("race_404")) === null,
    "no row",
  );
}

// B2. 403 — requireAll() replies, the handler `return`s bare (non-all-mode key).
{
  const r = await post(`/v1/businesses/${biz.id}/transfer_configurations`, testKey, "race_403", {
    destination_business: biz.id,
  });
  check(
    "403 all-mode-only route (requireAll + bare return) — no crash",
    r.newCrashes === 0,
    crashDetail(r.newCrashes),
  );
  check(
    "403 all-mode-only route — clean 403 envelope",
    r.status === 403,
    `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`,
  );
  check(
    "403 all-mode-only route — no idempotency record stored",
    (await keyRow("race_403")) === null,
    "no row",
  );
}

// B3. 404 raised INSIDE the handler and `return`ed (safe shape — regression guard).
{
  const r = await post(
    `/v1/businesses/${biz.id}/customers/cus_nope/subscriptions`,
    allKey,
    "race_404b",
    subBody,
  );
  check(
    "404 unknown customer (returned reply) — no crash, clean 404",
    r.newCrashes === 0 && r.status === 404,
    `${r.status}, ${crashDetail(r.newCrashes)}`,
  );
  check(
    "404 unknown customer — no idempotency record stored",
    (await keyRow("race_404b")) === null,
    "no row",
  );
}

// B4. 400 — zod body failure via `return badRequest(...)`.
{
  const r = await post(subUrl, allKey, "race_400", { items: "nope" });
  check(
    "400 invalid body (badRequest) — no crash, clean 400",
    r.newCrashes === 0 && r.status === 400,
    `${r.status}, ${crashDetail(r.newCrashes)}`,
  );
  check(
    "400 invalid body — no idempotency record stored",
    (await keyRow("race_400")) === null,
    "no row",
  );
}

// B5. the 2xx path must still be fully idempotent (locked decision #5).
{
  const ok = await post(subUrl, allKey, "race_2xx", subBody);
  check(
    "2xx write — created",
    ok.status === 201 && ok.newCrashes === 0,
    `${ok.status}, ${crashDetail(ok.newCrashes)}`,
  );
  const row = await keyRow("race_2xx");
  check(
    "2xx write — record stored as completed",
    row?.status === "completed" && row?.responseStatus === 201,
    `status=${row?.status} response_status=${row?.responseStatus}`,
  );

  const replay = await post(subUrl, allKey, "race_2xx", subBody);
  check(
    "2xx write — same key + same payload replays the stored response",
    replay.status === 201 &&
      replay.headers["idempotent-replayed"] === "true" &&
      replay.body.id === ok.body.id,
    `${replay.status} replayed=${replay.headers["idempotent-replayed"]} same_id=${replay.body.id === ok.body.id}`,
  );

  const mismatch = await post(subUrl, allKey, "race_2xx", {
    items: [{ price: price.id, quantity: 7 }],
  });
  check(
    "409 key reused with a different payload — no crash, clean 409",
    mismatch.status === 409 && mismatch.newCrashes === 0,
    `${mismatch.status}, ${crashDetail(mismatch.newCrashes)}`,
  );
  check(
    "409 mismatch — the stored completed record survives",
    (await keyRow("race_2xx"))?.status === "completed",
    "still completed",
  );
}

// B6. retry safety — a key burnt on an early return must still work afterwards.
{
  const retry = await post(subUrl, allKey, "race_404", subBody);
  check(
    "retry safety — key from the 404 early return is NOT poisoned",
    retry.status === 201 && retry.newCrashes === 0,
    `${retry.status} ${JSON.stringify(retry.body).slice(0, 80)}`,
  );
  check(
    "retry safety — the retry stored its own completed record",
    (await keyRow("race_404"))?.status === "completed",
    "completed",
  );

  const retry403 = await post(
    `/v1/businesses/${biz.id}/transfer_configurations`,
    allKey,
    "race_403",
    { destination_business: biz.id },
  );
  check(
    "retry safety — key from the 403 early return is NOT poisoned (not 409)",
    retry403.status !== 409 && retry403.newCrashes === 0,
    `${retry403.status}, ${crashDetail(retry403.newCrashes)}`,
  );
}

// B7. the reply-guard net itself: a handler that replies then returns bare while an
// async onSend hook is still running must NOT double-send.
{
  const before = crashes.length;
  const res = await app.inject({ method: "POST", url: "/__probe/double_send", payload: {} });
  await new Promise((r) => setTimeout(r, 300));
  const n = crashes.length - before;
  check(
    "reply-guard net — bare return under an async onSend hook does not double-send",
    n === 0 && res.statusCode === 418,
    `${res.statusCode}, ${crashDetail(n)}`,
  );
}

// B8. a preHandler that replies then bare-returns must not let the handler run.
{
  const before = crashes.length;
  const res = await app.inject({ method: "POST", url: "/__probe/prehandler_bare", payload: {} });
  await new Promise((r) => setTimeout(r, 300));
  const n = crashes.length - before;
  check(
    "reply-guard net — a preHandler that replied stops the route handler",
    res.statusCode === 401 && probeHandlerRan === false && n === 0,
    `${res.statusCode} handler_ran=${probeHandlerRan}, ${crashDetail(n)}`,
  );
}

// ── COVERAGE. subscription items — add/remove are MONEY writes, so both need the pair ─
//
// `POST …/items` raises a proration charge and `DELETE …/items/:item` issues a credit
// note. Until 2026-08-03 these were the only subscription write routes WITHOUT the
// `idempotency` preHandler + `idempotencyOnSend`, so a retried client request
// double-added and double-CHARGED (`subscription_items` has only a partial unique
// index — auto-included mandatory items — so nothing else stopped it). Locked
// decision #5 is "idempotency everywhere"; these checks are the lock.
console.log("");
{
  const addonProduct = (
    await post(`/v1/businesses/${biz.id}/products`, allKey, "fx-6", {
      name: "Seats Addon",
      kind: "addon",
      addon_applies_to_all: true,
    })
  ).body as { id: string };
  const addonPrice = (
    await post(`/v1/businesses/${biz.id}/prices`, allKey, "fx-7", {
      product: addonProduct.id,
      model: "flat",
      currency: "USD",
      amount_minor: 2500,
      interval: "month",
    })
  ).body as { id: string };
  // A SECOND addon price so C1b's deferred add is independent of C1's invoiced one —
  // re-adding the same price to one subscription is a different scenario (duplicate
  // item) and would confound both cases.
  const addonPriceDeferred = (
    await post(`/v1/businesses/${biz.id}/prices`, allKey, "fx-8", {
      product: addonProduct.id,
      model: "flat",
      currency: "USD",
      amount_minor: 1700,
      interval: "month",
    })
  ).body as { id: string };
  const itemSub = (await post(subUrl, allKey, "items_sub_setup", subBody)).body as { id: string };
  requireFixtures({
    addon_price: addonPrice.id,
    deferred_price: addonPriceDeferred.id,
    subscription: itemSub.id,
  });
  console.log(
    `items fixtures: addon_price=${addonPrice.id} deferred_price=${addonPriceDeferred.id} subscription=${itemSub.id}`,
  );

  // Internal ids, so the counts below come from the tables rather than the responses.
  const { subUuid, cusUuid } = await withTenant(orgId, async (tx) => {
    const [s] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.publicId, itemSub.id))
      .limit(1);
    const [c] = await tx
      .select()
      .from(customers)
      .where(eq(customers.publicId, customer.id))
      .limit(1);
    return { subUuid: s!.id, cusUuid: c!.id };
  });
  const countItems = async (priceUuid?: string) =>
    withTenant(
      orgId,
      async (tx) =>
        (
          await tx
            .select()
            .from(subscriptionItems)
            .where(eq(subscriptionItems.subscriptionId, subUuid))
        ).filter((r) => (priceUuid ? r.priceId === priceUuid : true)).length,
    );
  const countInvoices = async () =>
    withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(invoices).where(eq(invoices.subscriptionId, subUuid))).length,
    );
  const countCreditNotes = async () =>
    withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(creditNotes).where(eq(creditNotes.customerId, cusUuid))).length,
    );
  const countUnbilled = async () =>
    withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(unbilledCharges).where(eq(unbilledCharges.subscriptionId, subUuid)))
          .length,
    );

  const itemsBefore = await countItems();
  const invBefore = await countInvoices();

  // C1. POST …/items twice with the SAME key + payload → ONE item, ONE charge.
  //
  // `invoice_immediately: true` is EXPLICIT, and has to be. Omitting it used to invoice
  // unconditionally, but the option now resolves `businesses.default_invoice_immediately`
  // (which ships false), so an omitting caller queues an unbilled charge instead and this
  // case silently stopped testing the invoice path — the assertion below read
  // `invoices 1→1` and failed. The invoice branch is the one where a replay costs real
  // money (it invoices AND collects), so it is the branch this case keeps. C1b covers
  // the deferred default.
  const addBody = { price: addonPrice.id, quantity: 1, invoice_immediately: true };
  const addUrl = `/v1/businesses/${biz.id}/subscriptions/${itemSub.id}/items`;
  const add1 = await post(addUrl, allKey, "items_add", addBody);
  const itemsAfter1 = await countItems();
  const invAfter1 = await countInvoices();
  const add2 = await post(addUrl, allKey, "items_add", addBody);
  const itemsAfter2 = await countItems();
  const invAfter2 = await countInvoices();
  console.log(
    `POST items: call1=${add1.status} call2=${add2.status} replayed=${add2.headers["idempotent-replayed"] ?? "no"}`,
  );
  console.log(
    `  items on subscription: before=${itemsBefore} after 1st=${itemsAfter1} after 2nd=${itemsAfter2} (MUST stay ${itemsAfter1})`,
  );
  console.log(
    `  invoices on subscription: before=${invBefore} after 1st=${invAfter1} after 2nd=${invAfter2} (MUST stay ${invAfter1})`,
  );

  check(
    "POST items — first call adds exactly one item",
    add1.status === 201 && itemsAfter1 === itemsBefore + 1,
    `${add1.status}, items ${itemsBefore}→${itemsAfter1}`,
  );
  check(
    "POST items — first call raised exactly one charge",
    invAfter1 === invBefore + 1,
    `invoices ${invBefore}→${invAfter1}`,
  );
  check(
    "POST items — duplicate key + payload does NOT double-add",
    itemsAfter2 === itemsAfter1,
    `items ${itemsAfter1}→${itemsAfter2}`,
  );
  check(
    "POST items — duplicate key + payload does NOT double-charge",
    invAfter2 === invAfter1,
    `invoices ${invAfter1}→${invAfter2}`,
  );
  check(
    "POST items — the duplicate replays the stored 201 response",
    add2.status === add1.status &&
      add2.headers["idempotent-replayed"] === "true" &&
      add2.body.id === add1.body.id,
    `${add2.status} replayed=${add2.headers["idempotent-replayed"]} same_id=${add2.body.id === add1.body.id}`,
  );
  check(
    "POST items — record stored as completed",
    (await keyRow("items_add"))?.status === "completed",
    `status=${(await keyRow("items_add"))?.status}`,
  );

  // C1b. the DEFERRED default: omit `invoice_immediately` and the add queues an
  // unbilled charge rather than invoicing. That branch became the DEFAULT on 2026-08-19
  // and arrived with no idempotency cover at all — a retried request that double-books
  // an unbilled charge is a double-charge deferred to the next renewal, which is the
  // same money a day later. Same shape as C1: one item, one charge, replayed response.
  const defBody = { price: addonPriceDeferred.id, quantity: 1 };
  const defItemsBefore = await countItems();
  const defUnbilledBefore = await countUnbilled();
  const defInvBefore = await countInvoices();
  const def1 = await post(addUrl, allKey, "items_add_deferred", defBody);
  const defItemsAfter1 = await countItems();
  const defUnbilledAfter1 = await countUnbilled();
  const def2 = await post(addUrl, allKey, "items_add_deferred", defBody);
  const defItemsAfter2 = await countItems();
  const defUnbilledAfter2 = await countUnbilled();
  const defInvAfter = await countInvoices();
  console.log(
    `POST items (deferred): call1=${def1.status} call2=${def2.status} replayed=${def2.headers["idempotent-replayed"] ?? "no"}`,
  );
  console.log(
    `  items: before=${defItemsBefore} after 1st=${defItemsAfter1} after 2nd=${defItemsAfter2} (MUST stay ${defItemsAfter1})`,
  );
  console.log(
    `  unbilled charges: before=${defUnbilledBefore} after 1st=${defUnbilledAfter1} after 2nd=${defUnbilledAfter2} (MUST stay ${defUnbilledAfter1})`,
  );

  check(
    "POST items (deferred) — first call adds exactly one item",
    def1.status === 201 && defItemsAfter1 === defItemsBefore + 1,
    `${def1.status}, items ${defItemsBefore}→${defItemsAfter1}`,
  );
  check(
    "POST items (deferred) — first call queues exactly one unbilled charge",
    defUnbilledAfter1 === defUnbilledBefore + 1,
    `unbilled ${defUnbilledBefore}→${defUnbilledAfter1}`,
  );
  check(
    "POST items (deferred) — omitting invoice_immediately raises NO invoice",
    defInvAfter === defInvBefore,
    `invoices ${defInvBefore}→${defInvAfter}`,
  );
  check(
    "POST items (deferred) — the response says the charge was queued, not that nothing was owed",
    Array.isArray((def1.body as { unbilled_charges?: unknown[] }).unbilled_charges) &&
      (def1.body as { unbilled_charges: unknown[] }).unbilled_charges.length === 1 &&
      (def1.body as { proration_invoice: unknown }).proration_invoice === null,
    `unbilled_charges=${JSON.stringify((def1.body as { unbilled_charges?: unknown[] }).unbilled_charges)} proration_invoice=${JSON.stringify((def1.body as { proration_invoice?: unknown }).proration_invoice)}`,
  );
  check(
    "POST items (deferred) — duplicate key + payload does NOT double-add",
    defItemsAfter2 === defItemsAfter1,
    `items ${defItemsAfter1}→${defItemsAfter2}`,
  );
  check(
    "POST items (deferred) — duplicate key + payload does NOT double-book the charge",
    defUnbilledAfter2 === defUnbilledAfter1,
    `unbilled ${defUnbilledAfter1}→${defUnbilledAfter2}`,
  );
  check(
    "POST items (deferred) — the duplicate replays the stored 201 response",
    def2.status === def1.status &&
      def2.headers["idempotent-replayed"] === "true" &&
      def2.body.id === def1.body.id,
    `${def2.status} replayed=${def2.headers["idempotent-replayed"]} same_id=${def2.body.id === def1.body.id}`,
  );

  // C2. same key, DIFFERENT payload → 409, matching /change.
  const addMismatch = await post(addUrl, allKey, "items_add", {
    price: addonPrice.id,
    quantity: 9,
  });
  check(
    "POST items — key reused with a different payload → 409",
    addMismatch.status === 409 && addMismatch.newCrashes === 0,
    `${addMismatch.status}, ${crashDetail(addMismatch.newCrashes)}`,
  );

  // C3. DELETE …/items/:item twice with the same key → credits ONCE.
  const itemId = add1.body.id as string;
  const delUrl = `/v1/businesses/${biz.id}/subscriptions/${itemSub.id}/items/${itemId}`;
  const cnBefore = await countCreditNotes();
  const itemsPreDelete = await countItems();
  const del1 = await del(delUrl, allKey, "items_del");
  const cnAfter1 = await countCreditNotes();
  const itemsAfterDel1 = await countItems();
  const del2 = await del(delUrl, allKey, "items_del");
  const cnAfter2 = await countCreditNotes();
  const itemsAfterDel2 = await countItems();
  console.log(
    `DELETE items: call1=${del1.status} ${JSON.stringify(del1.body).slice(0, 200)} call2=${del2.status} replayed=${del2.headers["idempotent-replayed"] ?? "no"}`,
  );
  console.log(
    `  items on subscription: before=${itemsPreDelete} after 1st=${itemsAfterDel1} after 2nd=${itemsAfterDel2}`,
  );
  console.log(
    `  credit notes for customer: before=${cnBefore} after 1st=${cnAfter1} after 2nd=${cnAfter2} (MUST stay ${cnAfter1})`,
  );

  check(
    "DELETE items — first call removes the item",
    del1.status === 200 && itemsAfterDel1 === itemsPreDelete - 1,
    `${del1.status}, items ${itemsPreDelete}→${itemsAfterDel1}`,
  );
  check(
    "DELETE items — duplicate key credits exactly ONCE",
    cnAfter2 === cnAfter1,
    `credit notes ${cnAfter1}→${cnAfter2}`,
  );
  check(
    "DELETE items — the duplicate replays the stored response instead of 404-ing",
    del2.status === del1.status && del2.headers["idempotent-replayed"] === "true",
    `${del2.status} replayed=${del2.headers["idempotent-replayed"]}`,
  );
  check(
    "DELETE items — record stored as completed",
    (await keyRow("items_del"))?.status === "completed",
    `status=${(await keyRow("items_del"))?.status}`,
  );

  // C4. the reply-guard inheritance: a 404 raised BEFORE the write, under the new
  // async onSend, must reply once, cleanly, and must NOT burn the key.
  const bogusBiz = await post(
    "/v1/businesses/biz_nope/subscriptions/sub_nope/items",
    allKey,
    "items_404_biz",
    addBody,
  );
  check(
    "POST items — 404 bogus business with an Idempotency-Key: clean, no crash",
    bogusBiz.status === 404 && bogusBiz.newCrashes === 0,
    `${bogusBiz.status}, ${crashDetail(bogusBiz.newCrashes)}`,
  );
  check(
    "POST items — 404 bogus business stores no idempotency record",
    (await keyRow("items_404_biz")) === null,
    "no row",
  );

  // An unknown item id is a `SubscriptionError` → 400 (not 404); either way it is a
  // pre-write early return, which is the shape that used to kill the process.
  const bogusItem = await del(
    `/v1/businesses/${biz.id}/subscriptions/${itemSub.id}/items/si_does_not_exist`,
    allKey,
    "items_400_item",
  );
  check(
    "DELETE items — unknown item with an Idempotency-Key: clean 400, no crash",
    bogusItem.status === 400 && bogusItem.newCrashes === 0,
    `${bogusItem.status}, ${crashDetail(bogusItem.newCrashes)}`,
  );
  check(
    "DELETE items — unknown item stores no idempotency record",
    (await keyRow("items_400_item")) === null,
    "no row",
  );

  const bogusDelBiz = await del(
    `/v1/businesses/biz_nope/subscriptions/${itemSub.id}/items/${itemId}`,
    allKey,
    "items_404_delbiz",
  );
  check(
    "DELETE items — 404 bogus business (resolveBusiness) with a key: clean, no record",
    bogusDelBiz.status === 404 &&
      bogusDelBiz.newCrashes === 0 &&
      (await keyRow("items_404_delbiz")) === null,
    `${bogusDelBiz.status}, ${crashDetail(bogusDelBiz.newCrashes)}`,
  );

  // C5. no key at all → REFUSED. The header was optional by design until L6; it is now
  // required, and the refusal must name itself so a caller can tell "add this header" from
  // "your body is wrong". A bare 400 would leave them guessing.
  const noKeyAdd = await post(addUrl, allKey, undefined, addBody);
  check(
    "POST items — NO Idempotency-Key is REFUSED (L6)",
    noKeyAdd.status === 400,
    `${noKeyAdd.status}`,
  );
  check(
    "POST items — …and the refusal names itself as idempotency_required",
    (noKeyAdd.body as { error?: { type?: string } })?.error?.type === "idempotency_required",
    JSON.stringify(noKeyAdd.body).slice(0, 90),
  );
}

// ── D. a failure AFTER a durable write must not free the key ──────────────────
//
// Before 2026-08-03 `idempotencyOnSend` deleted the record on ANY non-2xx. Right for
// a pre-write early return (axis B), catastrophic once money had moved: the client's
// retry RE-EXECUTED. These checks pin the three-way split — clean failure frees the
// key, dirty failure is stored and replayed, 2xx unchanged.
console.log("");
{
  // D1. write, then throw. The record must SURVIVE, as `failed`.
  const e1 = probeExecutions;
  const f1 = await post("/__probe/write_then_500", allKey, "race_dirty_500", { probe: 1 });
  const row1 = await keyRow("race_dirty_500");
  console.log(
    `post-write 500: ${f1.status} record=${row1?.status ?? "NO ROW"} response_status=${row1?.responseStatus ?? "-"}`,
  );
  check(
    "post-write 500 — clean 500 envelope, no crash",
    f1.status === 500 && f1.newCrashes === 0,
    `${f1.status}, ${crashDetail(f1.newCrashes)}`,
  );
  check(
    "post-write 500 — the handler ran once",
    probeExecutions === e1 + 1,
    `${probeExecutions - e1} execution(s)`,
  );
  check(
    "post-write 500 — record KEPT as failed with its response (used to be deleted)",
    row1?.status === "failed" && row1?.responseStatus === 500,
    `status=${row1?.status ?? "NO ROW"} response_status=${row1?.responseStatus ?? "-"}`,
  );

  // D2. the retry. THE money check: replay, never a second execution.
  const f2 = await post("/__probe/write_then_500", allKey, "race_dirty_500", { probe: 1 });
  check(
    "post-write 500 — the retry does NOT re-execute the handler",
    probeExecutions === e1 + 1,
    `${probeExecutions - e1} execution(s) in total (MUST be 1)`,
  );
  check(
    "post-write 500 — the retry replays the stored failure",
    f2.status === 500 && f2.headers["idempotent-replayed"] === "true",
    `${f2.status} replayed=${f2.headers["idempotent-replayed"] ?? "no"}`,
  );
  const effects = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(businesses)
          .where(
            and(
              eq(businesses.name, `Probe Side Effect ${e1 + 1}`),
              eq(businesses.livemode, "live"),
            ),
          )
      ).length,
  );
  check(
    "post-write 500 — the side effect happened exactly ONCE",
    effects === 1,
    `${effects} row(s)`,
  );

  // D3. a 5xx that wrote NOTHING must still free the key (axis B through a 500).
  const c1 = cleanFailExecutions;
  const g1 = await post("/__probe/fail_before_write", allKey, "race_clean_500", { probe: 2 });
  check(
    "pre-write 500 — clean 500 and no idempotency record stored",
    g1.status === 500 && (await keyRow("race_clean_500")) === null,
    `${g1.status}, row=${(await keyRow("race_clean_500")) ? "PRESENT" : "none"}`,
  );
  const g2 = await post("/__probe/fail_before_write", allKey, "race_clean_500", { probe: 2 });
  check(
    "pre-write 500 — the key is NOT poisoned: the retry runs again",
    g2.status === 500 && cleanFailExecutions === c1 + 2,
    `${g2.status}, ${cleanFailExecutions - c1} execution(s)`,
  );

  // D4. a tenant READ is not a side effect — otherwise every early return that looks
  // something up (i.e. all of them) would poison its key.
  const h1 = await post("/__probe/read_then_404", allKey, "race_read_404", { probe: 3 });
  check(
    "read-then-404 — a read-only tenant transaction stores no record",
    h1.status === 404 && (await keyRow("race_read_404")) === null,
    `${h1.status}, row=${(await keyRow("race_read_404")) ? "PRESENT" : "none"}`,
  );

  // D5. the real money path: a card that hard-declines. `POST …/subscriptions`
  // charges the first period BEFORE it answers, so the 402 arrives after a gateway
  // attempt (and the invoice/ledger writes it then compensates). A retry must replay,
  // not ask the gateway again.
  const decliner = (
    await post(`/v1/businesses/${biz.id}/customers`, allKey, "fx-9", {
      email: "declined@race.com",
      first_name: "Declined",
    })
  ).body as { id: string };
  // `4000000000000341` vaults fine and fails every charge — a hard-decline PAN
  // (…0002) never vaults, so the route would stop at "no chargeable payment method"
  // (a pre-write 400) and never reach the gateway at all.
  await post(`/v1/businesses/${biz.id}/customers/${decliner.id}/payment_methods`, allKey, "fx-10", {
    token: "tok_4000000000000341",
  });
  const declineUrl = `/v1/businesses/${biz.id}/customers/${decliner.id}/subscriptions`;
  const d1 = await post(declineUrl, allKey, "race_402", subBody);
  const declineRow = await keyRow("race_402");
  console.log(
    `declined create: ${d1.status} record=${declineRow?.status ?? "NO ROW"} ${JSON.stringify(d1.body).slice(0, 110)}`,
  );
  check(
    "402 declined create — the payment path was reached (402)",
    d1.status === 402,
    `${d1.status}`,
  );
  check(
    "402 declined create — record KEPT as failed (a charge was attempted)",
    declineRow?.status === "failed" && declineRow?.responseStatus === 402,
    `status=${declineRow?.status ?? "NO ROW"} response_status=${declineRow?.responseStatus ?? "-"}`,
  );
  const d2 = await post(declineUrl, allKey, "race_402", subBody);
  check(
    "402 declined create — the retry replays instead of charging again",
    d2.status === 402 && d2.headers["idempotent-replayed"] === "true",
    `${d2.status} replayed=${d2.headers["idempotent-replayed"] ?? "no"}`,
  );
}

// ── E. COVERAGE II — the 2026-08-03 sweep of the remaining 71 write routes ─────
//
// The axes above only exercise routes that ALREADY carry the pair, so an unprotected
// write route is invisible to every one of them. Section C pinned the two `…/items`
// routes by name after they double-charged; the audit that followed found 71 MORE
// write registrations of 127 with neither hook — locked decision #5 ("idempotency
// everywhere") held on 56 routes and nowhere else.
//
// E1–E4 pin the four highest money-risk ones by NAME and by TABLE COUNT: a duplicate
// request must leave one charge, one payment, one billable term, one discount removal.
// E6 is the structural lock — it re-derives the coverage figure from the source so a
// new write route cannot ship without the pair, which is the only check here that
// keeps working for routes nobody thought to add a fixture for.
console.log("");
{
  const eSub = (await post(subUrl, allKey, "e_sub_setup", subBody)).body as { id: string };
  const { eSubUuid, eCusUuid } = await withTenant(orgId, async (tx) => {
    const [s] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.publicId, eSub.id))
      .limit(1);
    const [c] = await tx
      .select()
      .from(customers)
      .where(eq(customers.publicId, customer.id))
      .limit(1);
    return { eSubUuid: s!.id, eCusUuid: c!.id };
  });
  const eInvoices = async () =>
    withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(invoices).where(eq(invoices.subscriptionId, eSubUuid))).length,
    );
  const eCharges = async () =>
    withTenant(
      orgId,
      async (tx) =>
        (
          await tx
            .select()
            .from(unbilledCharges)
            .where(eq(unbilledCharges.subscriptionId, eSubUuid))
        ).length,
    );

  // E1. POST …/subscriptions/:sub/charges with `invoice_now` — the direct twin of the
  // `…/items` bug: it writes an ad-hoc charge, invoices it AND collects it in one
  // request. A retried duplicate charged the card a second time.
  const chargeUrl = `/v1/businesses/${biz.id}/subscriptions/${eSub.id}/charges`;
  const chargeBody = { description: "Onboarding fee", amount_minor: 15_000, invoice_now: true };
  const invBefore = await eInvoices();
  const c1 = await post(chargeUrl, allKey, "e_charge_now", chargeBody);
  const invAfter1 = await eInvoices();
  const c2 = await post(chargeUrl, allKey, "e_charge_now", chargeBody);
  const invAfter2 = await eInvoices();
  console.log(
    `POST charges (invoice_now): call1=${c1.status} call2=${c2.status} replayed=${c2.headers["idempotent-replayed"] ?? "no"}`,
  );
  console.log(`  call1 body: ${JSON.stringify(c1.body)}`);
  console.log(`  call2 body: ${JSON.stringify(c2.body)}`);
  console.log(
    `  invoices on subscription: before=${invBefore} after 1st=${invAfter1} after 2nd=${invAfter2} (MUST stay ${invAfter1})`,
  );
  check(
    "POST charges — first call invoices exactly one charge",
    c1.status === 201 && invAfter1 === invBefore + 1,
    `${c1.status}, invoices ${invBefore}→${invAfter1}`,
  );
  check(
    "POST charges — duplicate key does NOT raise a second invoice",
    invAfter2 === invAfter1,
    `invoices ${invAfter1}→${invAfter2}`,
  );
  const sameBody = deepEqual(c1.body, c2.body);
  check(
    "POST charges — the duplicate replays the stored 201",
    c2.status === 201 && c2.headers["idempotent-replayed"] === "true" && sameBody,
    `${c2.status} replayed=${c2.headers["idempotent-replayed"] ?? "no"} same_body=${sameBody}`,
  );
  check(
    "POST charges — record stored as completed",
    (await keyRow("e_charge_now"))?.status === "completed",
    `status=${(await keyRow("e_charge_now"))?.status ?? "NO ROW"}`,
  );

  // E1b. the unbilled variant (no `invoice_now`) — one row, not two.
  const unbilledBody = { description: "Setup help", amount_minor: 2_500 };
  const chBefore = await eCharges();
  const u1 = await post(chargeUrl, allKey, "e_charge_unbilled", unbilledBody);
  const chAfter1 = await eCharges();
  const u2 = await post(chargeUrl, allKey, "e_charge_unbilled", unbilledBody);
  const chAfter2 = await eCharges();
  console.log(
    `  unbilled charges: before=${chBefore} after 1st=${chAfter1} after 2nd=${chAfter2} (MUST stay ${chAfter1})`,
  );
  check(
    "POST charges (unbilled) — first call writes exactly one charge",
    u1.status === 201 && chAfter1 === chBefore + 1,
    `${u1.status}, charges ${chBefore}→${chAfter1}`,
  );
  check(
    "POST charges (unbilled) — duplicate key does NOT write a second charge",
    chAfter2 === chAfter1,
    `charges ${chAfter1}→${chAfter2}`,
  );
  check(
    "POST charges (unbilled) — the duplicate replays the same charge id",
    u2.headers["idempotent-replayed"] === "true" && u2.body.id === u1.body.id,
    `same_id=${u2.body.id === u1.body.id}`,
  );

  // E1c. pre-write early return on a NEWLY protected route: replies once, no crash,
  // and does not burn the key (inherits the reply-guard + three-way finalize).
  const chargeBogus = await post(
    `/v1/businesses/biz_nope/subscriptions/${eSub.id}/charges`,
    allKey,
    "e_charge_404",
    chargeBody,
  );
  check(
    "POST charges — 404 bogus business replies once, no crash",
    chargeBogus.status === 404 && chargeBogus.newCrashes === 0,
    `${chargeBogus.status}, ${crashDetail(chargeBogus.newCrashes)}`,
  );
  check(
    "POST charges — 404 bogus business stores no idempotency record",
    (await keyRow("e_charge_404")) === null,
    "no row",
  );
  const chargeNoSub = await post(
    `/v1/businesses/${biz.id}/subscriptions/sub_nope/charges`,
    allKey,
    "e_charge_404b",
    chargeBody,
  );
  check(
    "POST charges — 404 unknown subscription replies once and frees the key",
    chargeNoSub.status === 404 &&
      chargeNoSub.newCrashes === 0 &&
      (await keyRow("e_charge_404b")) === null,
    `${chargeNoSub.status}, ${crashDetail(chargeNoSub.newCrashes)}`,
  );

  // E2. POST …/invoices/:inv/pay — records an offline payment against the ledger.
  // A duplicate used to post a SECOND payment, over-paying the invoice.
  const payInv = (
    await post(`/v1/businesses/${biz.id}/invoices`, allKey, "e_pay_inv", {
      customer: customer.id,
      lines: [{ description: "Manual", amount_minor: 5_000 }],
    })
  ).body as { id: string };
  const countPayments = async (invPublicId: string) =>
    withTenant(orgId, async (tx) => {
      const [inv] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.publicId, invPublicId))
        .limit(1);
      return inv
        ? (await tx.select().from(payments).where(eq(payments.invoiceId, inv.id))).length
        : -1;
    });
  const payUrl = `/v1/businesses/${biz.id}/invoices/${payInv.id}/pay`;
  const payBody = { amount_minor: 5_000, method: "bank_transfer" };
  const payBefore = await countPayments(payInv.id);
  const p1 = await post(payUrl, allKey, "e_pay", payBody);
  const payAfter1 = await countPayments(payInv.id);
  const p2 = await post(payUrl, allKey, "e_pay", payBody);
  const payAfter2 = await countPayments(payInv.id);
  console.log(
    `POST invoice pay: call1=${p1.status} call2=${p2.status} replayed=${p2.headers["idempotent-replayed"] ?? "no"}`,
  );
  console.log(
    `  payments on invoice: before=${payBefore} after 1st=${payAfter1} after 2nd=${payAfter2} (MUST stay ${payAfter1})`,
  );
  check(
    "POST invoice pay — first call records exactly one payment",
    p1.status === 200 && payAfter1 === payBefore + 1,
    `${p1.status}, payments ${payBefore}→${payAfter1}`,
  );
  check(
    "POST invoice pay — duplicate key does NOT record a second payment",
    payAfter2 === payAfter1,
    `payments ${payAfter1}→${payAfter2}`,
  );
  check(
    "POST invoice pay — the duplicate replays the stored response",
    p2.headers["idempotent-replayed"] === "true",
    `replayed=${p2.headers["idempotent-replayed"] ?? "no"}`,
  );

  // E3. POST …/subscriptions/:sub/reactivate — restarting a canceled sub BILLS the new
  // term, so a duplicate raised a second term invoice and charged for it.
  const reSub = (await post(subUrl, allKey, "e_re_setup", subBody)).body as { id: string };
  await post(`/v1/businesses/${biz.id}/subscriptions/${reSub.id}/cancel`, allKey, "e_re_cancel", {
    cancel_option: "immediately",
  });
  const reSubUuid = await withTenant(orgId, async (tx) => {
    const [s] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.publicId, reSub.id))
      .limit(1);
    return s!.id;
  });
  const reInvoices = async () =>
    withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(invoices).where(eq(invoices.subscriptionId, reSubUuid))).length,
    );
  const reUrl = `/v1/businesses/${biz.id}/subscriptions/${reSub.id}/reactivate`;
  const reBefore = await reInvoices();
  const r1 = await post(reUrl, allKey, "e_reactivate", {});
  const reAfter1 = await reInvoices();
  const r2 = await post(reUrl, allKey, "e_reactivate", {});
  const reAfter2 = await reInvoices();
  console.log(
    `POST reactivate: call1=${r1.status} ${JSON.stringify(r1.body).slice(0, 160)} call2=${r2.status} replayed=${r2.headers["idempotent-replayed"] ?? "no"}`,
  );
  console.log(
    `  invoices on subscription: before=${reBefore} after 1st=${reAfter1} after 2nd=${reAfter2} (MUST stay ${reAfter1})`,
  );
  check(
    "POST reactivate — first call bills exactly one new term",
    r1.status === 200 && reAfter1 === reBefore + 1,
    `${r1.status}, invoices ${reBefore}→${reAfter1}`,
  );
  check(
    "POST reactivate — duplicate key does NOT bill a second term",
    reAfter2 === reAfter1,
    `invoices ${reAfter1}→${reAfter2}`,
  );
  check(
    "POST reactivate — the duplicate replays instead of re-running",
    r2.headers["idempotent-replayed"] === "true",
    `replayed=${r2.headers["idempotent-replayed"] ?? "no"}`,
  );

  // E4. DELETE …/subscriptions/:sub/discount — removing a discount re-prices the sub.
  // The second call has nothing left to remove, so without the pair it 400s where the
  // caller expected its original 200; with it, the retry replays the real answer.
  const cpn = (
    await post(`/v1/businesses/${biz.id}/coupons`, allKey, "e_cpn", {
      name: "Ten Off",
      discount_type: "percentage",
      discount_percentage: 10,
      duration_type: "forever",
      applies_to: "all",
    })
  ).body as { id: string };
  const discSub = (await post(subUrl, allKey, "e_disc_setup", subBody)).body as { id: string };
  await post(
    `/v1/businesses/${biz.id}/subscriptions/${discSub.id}/discount`,
    allKey,
    "e_disc_add",
    { coupon: cpn.id },
  );
  const discUrl = `/v1/businesses/${biz.id}/subscriptions/${discSub.id}/discount`;
  const g1 = await del(discUrl, allKey, "e_disc_del");
  const g2 = await del(discUrl, allKey, "e_disc_del");
  console.log(
    `DELETE discount: call1=${g1.status} call2=${g2.status} replayed=${g2.headers["idempotent-replayed"] ?? "no"}`,
  );
  check("DELETE discount — first call removes it", g1.status === 200, `${g1.status}`);
  check(
    "DELETE discount — duplicate key replays the 200 instead of failing",
    g2.status === g1.status && g2.headers["idempotent-replayed"] === "true",
    `${g2.status} replayed=${g2.headers["idempotent-replayed"] ?? "no"}`,
  );

  // E5. the swept routes enforce the header too (L6). This check used to assert the
  // opposite — that the header stayed OPTIONAL so adding the hook pair could not become a
  // breaking change for the dashboard, the SDK or any existing caller. That protection did
  // its job: by the time L6 landed, all three already minted keys, which is what made
  // enforcement a one-line change rather than a migration.
  const noKeyCharge = await post(chargeUrl, allKey, undefined, {
    description: "No key",
    amount_minor: 100,
  });
  check(
    "swept routes — NO Idempotency-Key is REFUSED (L6)",
    noKeyCharge.status === 400,
    `${noKeyCharge.status}`,
  );

  // E6. THE STRUCTURAL LOCK. Re-derive coverage from the source: every write
  // registration in src/api must carry BOTH hooks, or be one of the documented
  // non-violations below. This is what stops route #128 from shipping without them.
  //
  // Exempt, with the reason each is not a violation:
  //  - auth-routes: pre-tenant (signup/login/logout/change_password/invite). No
  //    `req.organization` and no buyer session, so `requestOrgId` returns null and the
  //    middleware no-ops — the pair would be decoration.
  //  - /auth/members/:id (PATCH, DELETE) and /auth/members/:id/resend_invite: the same
  //    pre-tenant reason. They authenticate a DASHBOARD USER via `requireUser`, which
  //    sets neither `req.organization` nor a buyer session, so `idempotency` returns at
  //    its `if (!orgId) return` before touching the database. Verified, not assumed.
  //    The first two are also idempotent in themselves — assigning the same role twice
  //    and removing an already-removed member both reach the state the caller asked for,
  //    the same argument /auth/mfa/disable is exempt under.
  //    ⚠️ `resend_invite` is NOT idempotent and this exemption does not pretend it is:
  //    it sends a real email, so a double-tap sends two, and no throttle was found on
  //    `resendMemberInvite`. It is exempt because the pair CANNOT help on a pre-tenant
  //    route, not because the hazard is absent. The fix, if it is worth one, is a
  //    per-member send throttle in the service — where /portal/v1/request_link's
  //    one-link-per-minute rule lived — or moving the route under a tenant-scoped path.
  //    Tracked rather than papered over.
  //  - /portal/v1/session: the entry-credential exchange (0193). Unauthenticated by
  //    necessity — the caller has no session yet, that being the point — so the same
  //    null-tenant reason applies. It is also the one route that needs no generic
  //    replay guard, because it HAS a stronger one: the access token is single-use,
  //    enforced in the UPDATE's own WHERE clause, so a replayed request is refused by
  //    the mechanism rather than by a stored response.
  //  - /portal/v1/logout: naturally idempotent. Logging out twice is logging out, and
  //    the second call finds no session token to clear.
  //  - /estimate, /subscription_estimate, /cancel_estimate, /reactivate_estimate:
  //    POST-shaped READS. They
  //    compute a quote and write nothing, so there is no side effect to deduplicate.
  //    (POST rather than GET because an option set does not fit a query string —
  //    `cancel_estimate` takes the whole five-option cancellation payload.)
  //  - /v1/analytics/query: a POST-shaped READ, same category as /estimate. It answers a
  //    board's worth of measures in one round trip and writes nothing, so there is no side
  //    effect to deduplicate. POST rather than GET because a list of up to 24 questions, each
  //    with its own window and split, does not fit a query string.
  //  - /emails/templates/:type/preview and /emails/smtp/test-connection: POST-shaped
  //    PROBES, same category as /estimate. `previewTemplate` renders a template and
  //    `testSmtpConnection` opens a connection to report whether it works; neither
  //    writes, so there is no side effect to deduplicate. They are also inherently
  //    repeatable — the whole point of a connection test is running it again.
  //  - /transfer_configurations/preview: a POST-shaped READ, same category as /estimate. It
  //    plans a transfer field by field and writes nothing. POST because the request is the
  //    run's own body (sections, numbering, twins), which does not fit a query string.
  //  - /auth/switch_organization: the same shape as /login. Its side effect IS a session
  //    token, and minting a second one is precisely what a retry legitimately means; there
  //    is no money write and nothing to deduplicate.
  //  - /auth/forgot_password: unauthenticated, and deliberately answers identically whether
  //    or not the account exists (enumeration). There is no authenticated caller to supply a
  //    key, and its protection is rate limiting rather than replay.
  //  - /auth/reset_password and /auth/accept_invite: same STRONGER guard as
  //    /portal/v1/session above — the token is single-use, spent in the UPDATE's own WHERE
  //    clause (`isNull(consumedAt)` + `.returning()`), so a replay is refused by the
  //    mechanism itself rather than by a stored response. Verified in auth/service.ts.
  //  - /auth/signup/confirm (0354): the same — the sign-up token is single-use, spent in the
  //    consuming UPDATE's WHERE (`isNull(consumedAt)`), so a replay is refused by the mechanism.
  //  - /auth/team_alerts/confirm (0495): the same — the confirmation token is single-use,
  //    cleared by the confirming UPDATE (`status = 'pending'` in its WHERE).
  //  - /auth/login/mfa: the second half of /login, and guarded the same STRONGER way as
  //    reset/accept above — the challenge is single-use and spent in the consuming UPDATE's
  //    own WHERE, so a replay is refused by the mechanism rather than by a stored response.
  //    Its side effect is a session token, and minting another is what a retry legitimately
  //    means.
  //  - /auth/mfa/enroll and /auth/mfa/recovery_codes: mint fresh material by design (a setup
  //    secret; a set of recovery codes). Each call REPLACES the previous one, so a stored
  //    replay would hand back material that no longer works — actively wrong.
  //  - /auth/mfa/confirm: spends the pending setup in its own guarded UPDATE, so a replay is
  //    refused by the mechanism. /auth/mfa/disable is a DELETE by another name, and
  //    /auth/mfa/recovery_codes/acknowledge stamps a timestamp; both reach the same state twice.
  //  - /auth/step_up: stamps a timestamp on the caller's own session. Running it twice leaves
  //    the same state — re-authenticated — and the side effect is deliberately repeatable,
  //    since the whole point is refreshing a window that expires.
  //  - /checkout/v1/coupon (POST + DELETE): the buyer's own coupon box, and the exemption
  //    is the ROUTE's own documented decision (see checkout-routes.ts) rather than an
  //    oversight this list is papering over. They are idempotent by construction — adding a
  //    code already on the page is a no-op, so is removing one that is not there — and an
  //    Idempotency-Key would actively HARM: a buyer who mistypes, gets a 400, fixes the typo
  //    and retries under the same key would be replayed the first attempt's failure. Both
  //    answer with the re-priced view, so the page's own state is the acknowledgement.
  //  - /auth/me/release_notes_seen: the what's-new highwater for the signed-in person. Both
  //    exemption reasons at once — pre-tenant (`requireUser` sets no `req.organization` and no
  //    buyer session, so `idempotency` returns at its `if (!orgId) return`), and idempotent in
  //    itself, because it SETS a count rather than incrementing one. A UI badge, no money.
  //  - /auth/me/product_tour_seen (0500): the same shape — pre-tenant, and a guarded UPDATE
  //    on `product_tour_seen_at IS NULL`, so a replay is a no-op.
  //  - /auth/me (PATCH), /auth/me/avatar, /auth/sessions/* (0327): the person's own profile
  //    and sessions — pre-tenant like release_notes_seen, and each SETS or DELETES a state
  //    (a name, a photo URL, a session gone), so a replay lands on the same place.
  //  - /auth/mfa/reset/cancel (0328): unauthenticated like reset_password, and guarded the same
  //    way — the cancel is a guarded UPDATE on `cancelled_at IS NULL`, and a repeat answers
  //    success with `already_cancelled`, so a replay lands on the same state.
  //  - Passkeys (0330): every ceremony is guarded by a single-use challenge spent in its own
  //    guarded UPDATE, so a replay is refused by the mechanism (the `*/options` routes mint that
  //    challenge, like /auth/mfa/enroll mints a secret). Rename SETS a name and the two DELETEs
  //    land on the same state twice, all pre-tenant like the rest of /auth/*.
  //  - /auth/signup_requests and /auth/signup/invite (0405): pre-tenant like /auth/signup, so the
  //    pair would no-op. A repeat request upserts the one open request per address (partial
  //    unique index) and tells the team only when the answers changed; the invite token is
  //    spent in the consuming UPDATE's WHERE (`isNull(consumedAt)`), so a replay is refused.
  //  - /portal/v1/login/request and /portal/v1/login/verify: the buyer's email-code sign-in.
  //    Unauthenticated like /portal/v1/session (no tenant, so the pair would no-op). A new
  //    request spends the open code and mints one, capped at 5 an hour per address; verify
  //    spends the code in its consuming UPDATE's WHERE (`isNull(usedAt)`), so a replay is refused.
  //  - /subscriptions/count: a read sent as POST because its filter sets do not fit a query
  //    string. It writes nothing, so there is nothing to replay.
  const exempt = new Set([
    "POST /auth/signup",
    "POST /auth/login",
    "POST /auth/logout",
    "POST /auth/switch_organization",
    "POST /auth/forgot_password",
    "POST /auth/login/mfa",
    "POST /auth/mfa/enroll",
    "POST /auth/step_up",
    "POST /auth/me/release_notes_seen",
    "POST /auth/me/product_tour_seen",
    "PATCH /auth/me",
    "POST /auth/me/avatar",
    "DELETE /auth/me/avatar",
    "DELETE /auth/sessions/:id",
    "POST /auth/sessions/revoke_others",
    "POST /checkout/v1/coupon",
    "DELETE /checkout/v1/coupon",
    // A public payment link: no credential, so no tenant to scope a stored response to,
    // and each open is MEANT to mint a fresh checkout. A replay is one more session,
    // bounded by the per-address limit on the route.
    "POST /checkout/v1/links/:plink/open",
    "POST /auth/mfa/confirm",
    "POST /auth/mfa/disable",
    "POST /auth/mfa/recovery_codes",
    "POST /auth/mfa/recovery_codes/acknowledge",
    "POST /auth/reset_password",
    "POST /auth/signup/confirm",
    "POST /auth/team_alerts/confirm",
    "POST /auth/signup_requests",
    "POST /auth/signup/invite",
    "POST /auth/mfa/reset/cancel",
    "POST /auth/accept_invite",
    "POST /auth/change_password",
    "POST /auth/invite",
    "PATCH /auth/members/:id",
    "DELETE /auth/members/:id",
    "POST /auth/members/:id/resend_invite",
    // 0498: the invitee answers their own pending invite. Pre-tenant like the rest of /auth/*,
    // and each lands on one end state: a replay finds no pending row and changes nothing.
    "POST /auth/invitations/:organization/accept",
    "POST /auth/invitations/:organization/decline",
    // 0329: dashboard /auth/* writes that SET a value (on/off, revoked), so a replay lands on it.
    "POST /auth/organization/security/require_two_factor",
    "POST /auth/organization/security/session_policy",
    "DELETE /auth/trusted_browsers/:id",
    "POST /auth/trusted_browsers/forget_all",
    // 0330: passkeys — see the note above.
    "POST /auth/login/mfa/passkey-options",
    "POST /auth/login/mfa/passkey",
    "POST /auth/passkey/options",
    "POST /auth/passkey/verify",
    "POST /auth/mfa/passkeys/options",
    "POST /auth/mfa/passkeys",
    "PATCH /auth/mfa/passkeys/:id",
    "DELETE /auth/mfa/passkeys/:id",
    "DELETE /auth/mfa/totp",
    "POST /portal/v1/session",
    "POST /portal/v1/logout",
    "POST /portal/v1/login/request",
    "POST /portal/v1/login/verify",
    "POST /v1/businesses/:biz/subscriptions/:sub/estimate",
    "POST /v1/businesses/:biz/subscriptions/:sub/cancel_estimate",
    "POST /v1/businesses/:biz/customers/:cus/subscription_estimate",
    "POST /v1/businesses/:biz/subscriptions/:sub/reactivate_estimate",
    "POST /v1/businesses/:biz/unbilled_charges/invoice_now_estimate",
    "POST /v1/businesses/:biz/emails/templates/:type/preview",
    "POST /v1/businesses/:biz/emails/smtp/test-connection",
    "POST /v1/businesses/:biz/transfer_configurations/preview",
    // Re-rates a draft rate card over closed periods; a READ ONLY transaction.
    "POST /v1/businesses/:biz/prices/:price/rate_change_preview",
    "POST /v1/analytics/query",
    "POST /v1/businesses/:biz/subscriptions/count",
    // Usage ingest: every event carries its own `key`, deduped per business in
    // usage_event_dedup (verify:usage-events), so a retried request counts each event once.
    "POST /v1/businesses/:biz/usage_events",
    "POST /v1/businesses/:biz/usage_events/batch",
  ]);
  const apiDir = new URL("../src/api/", import.meta.url);
  const REG = /\b(?:app|fastify|server)\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(/;
  const unprotected: string[] = [];
  let writeRoutes = 0;
  for (const file of (await readdir(apiDir))
    .filter((f) => f.endsWith("-routes.ts") || f === "routes.ts")
    .sort()) {
    const lines = (await readFile(new URL(file, apiDir), "utf8")).split("\n");
    const regs: Array<{ line: number; method: string }> = [];
    lines.forEach((l, i) => {
      const m = l.match(REG);
      if (m) regs.push({ line: i + 1, method: m[1]!.toUpperCase() });
    });
    regs.forEach((r, idx) => {
      if (r.method === "GET") return;
      writeRoutes++;
      // The registration's own options object ends where the next registration begins.
      const win = lines
        .slice(r.line - 1, idx + 1 < regs.length ? regs[idx + 1]!.line - 1 : lines.length)
        .join("\n");
      // All three literal forms. `oxfmt` owns formatting in this repo and rewrites
      // string quotes as it reformats; with only `'` and `` ` `` here, a reformatted
      // route file resolved EVERY path to "?", so no id could match an exemption and
      // every documented exemption was reported as an unprotected write route. The
      // coverage number stayed right while the verdict was pure noise — which is the
      // failure mode that teaches people to ignore a guard.
      const routePath =
        (win.match(/\(\s*'([^']+)'/) ??
          win.match(/\(\s*"([^"]+)"/) ??
          win.match(/\(\s*`([^`]+)`/))?.[1] ?? "?";
      const id = `${r.method} ${routePath}`;
      if (exempt.has(id)) return;
      const hasPre = /preHandler:\s*\[[^\]]*\bidempotency\b/.test(win);
      const hasOnSend = /onSend:\s*idempotencyOnSend/.test(win);
      // One without the other is worse than neither: a preHandler that records an
      // in-progress row with no onSend to finalize it wedges the key at 409 forever.
      if (!hasPre || !hasOnSend)
        unprotected.push(`${file}:${r.line} ${id}${hasPre !== hasOnSend ? " (ASYMMETRIC)" : ""}`);
    });
  }
  console.log(
    `coverage: ${writeRoutes} write registrations, ${exempt.size} documented exemptions, ${unprotected.length} unprotected`,
  );
  check(
    "COVERAGE — every write route in src/api carries the idempotency pair",
    unprotected.length === 0,
    unprotected.length === 0
      ? `${writeRoutes - exempt.size} protected`
      : `MISSING:\n     ${unprotected.join("\n     ")}`,
  );
}

// ── F. stale-key reap — a crashed process must not permanently poison a key ────
//
// Before 2026-08-03 a process dying mid-request left its record at `in_progress` or
// `side_effects` FOREVER — safe (a retry could only ever 409, never re-execute), but
// unrecoverable short of manual DB surgery. `locked_at` existed on the row already,
// unused; it is now the staleness clock (`IDEMPOTENCY_STALE_MS`, 5 minutes — well
// past `stripe-node`'s 80s `DEFAULT_TIMEOUT`, the longest documented gateway round
// trip in this codebase). The two statuses recover OPPOSITELY: `in_progress` (no
// durable write) is reclaimed for a fresh attempt; `side_effects` (a write landed) is
// NEVER freed for re-execution, only converted to a terminal `failed`.
//
// `testFingerprint` mirrors `platform/idempotency.ts`'s private `fingerprint()`
// exactly, so a seeded row's `request_fingerprint` matches what a REAL retry of the
// same request computes — a genuine crash-recovery retry always resends the same
// method/url/body, so this is the realistic case, not a shortcut.
console.log("");
function testFingerprint(method: string, url: string, payload: unknown): string {
  const b = payload ? JSON.stringify(payload) : "";
  return createHash("sha256").update(`${method}:${url}:${b}`).digest("hex");
}
const staleLockedAt = () => new Date(Date.now() - IDEMPOTENCY_STALE_MS - 60_000);

// F1. stale `in_progress` — RED then GREEN. Same row, same key, same retry; the
// ONLY thing that changes between the two calls is how long ago `locked_at` was, so
// the reap (not some other difference) is what is being proven.
{
  const staleKey = "stale_in_progress_recovery";
  const seedFp = testFingerprint("POST", "/v1/businesses", {
    name: "Stale Recovery Biz",
    default_currency: "USD",
  });
  const rowId = await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(idempotencyKeys)
      .values({
        organizationId: orgId,
        key: staleKey,
        requestFingerprint: seedFp,
        status: "in_progress",
        lockedAt: new Date(),
      })
      .returning();
    return row!.id;
  });

  // RED — freshly locked (indistinguishable from a genuinely live request): must
  // 409, exactly the permanently-stuck state the bug left behind.
  const red = await post("/v1/businesses", allKey, staleKey, {
    name: "Stale Recovery Biz",
    default_currency: "USD",
  });
  check(
    "F1 RED — a freshly-locked in_progress row still 409s (no premature reap)",
    red.status === 409 && red.newCrashes === 0,
    `${red.status}, ${crashDetail(red.newCrashes)}`,
  );
  check(
    "F1 RED — the row is untouched (still in_progress, not yet reaped)",
    (await keyRow(staleKey))?.status === "in_progress",
    `status=${(await keyRow(staleKey))?.status}`,
  );

  // Simulate the crash being old enough to be dead: push `locked_at` behind the
  // staleness cutoff. Nothing else about the row changes.
  await withTenant(orgId, async (tx) =>
    tx
      .update(idempotencyKeys)
      .set({ lockedAt: staleLockedAt() })
      .where(eq(idempotencyKeys.id, rowId)),
  );

  // GREEN — now stale: the identical retry is reclaimed and actually runs.
  const green = await post("/v1/businesses", allKey, staleKey, {
    name: "Stale Recovery Biz",
    default_currency: "USD",
  });
  check(
    "F1 GREEN — a stale in_progress row is reclaimed and the retry succeeds",
    green.status === 201 && green.newCrashes === 0,
    `${green.status}, ${crashDetail(green.newCrashes)}`,
  );
  const recovered = await keyRow(staleKey);
  check(
    "F1 GREEN — the reclaimed row finalizes normally as completed",
    recovered?.status === "completed" && recovered?.responseStatus === 201,
    `status=${recovered?.status} response_status=${recovered?.responseStatus}`,
  );
  const madeIt = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(businesses)
      .where(and(eq(businesses.name, "Stale Recovery Biz"), eq(businesses.livemode, "live"))),
  );
  check(
    "F1 GREEN — the reclaimed request actually created the business (not a phantom 201)",
    madeIt.length === 1,
    `${madeIt.length} row(s)`,
  );
}

// F2. stale `side_effects` — a durable write landed before the (simulated) crash.
// This must NEVER be freed for re-execution: money safety outranks convenience here.
{
  const sideKey = "stale_side_effects_orphan";
  const payload = { probe: "orphan" };
  const seedFp = testFingerprint("POST", "/__probe/write_then_500", payload);
  // Seed the row exactly as `withTenant` would have left it: a real write already
  // landed (`side_effects`), but the process died before `idempotencyOnSend` could
  // finalize it — locked long enough ago to look dead.
  await withTenant(orgId, async (tx) =>
    tx.insert(idempotencyKeys).values({
      organizationId: orgId,
      key: sideKey,
      requestFingerprint: seedFp,
      status: "side_effects",
      lockedAt: staleLockedAt(),
    }),
  );

  const before = probeExecutions;
  const r1 = await post("/__probe/write_then_500", allKey, sideKey, payload);
  check(
    "F2 — a stale side_effects row is NEVER re-executed",
    probeExecutions === before,
    `${probeExecutions - before} execution(s) (MUST be 0)`,
  );
  check(
    "F2 — the retry gets a clear terminal answer instead of a bare in-flight 409",
    r1.status === 409 &&
      String((r1.body.error as Record<string, string> | undefined)?.type) === "idempotency_error",
    `${r1.status} ${JSON.stringify(r1.body).slice(0, 140)}`,
  );
  const row1 = await keyRow(sideKey);
  check(
    "F2 — the row is converted to a terminal failed, never freed for re-execution",
    row1?.status === "failed" && row1?.responseStatus === 409,
    `status=${row1?.status} response_status=${row1?.responseStatus}`,
  );

  // A further retry must replay the SAME terminal answer — still zero executions.
  const r2 = await post("/__probe/write_then_500", allKey, sideKey, payload);
  check(
    "F2 — a further retry replays the same terminal answer, still no execution",
    probeExecutions === before && r2.status === 409 && r2.headers["idempotent-replayed"] === "true",
    `${probeExecutions - before} execution(s), ${r2.status} replayed=${r2.headers["idempotent-replayed"] ?? "no"}`,
  );
}

// F3. a FRESH (non-stale) in_progress row must still 409 — the reaper must not
// weaken real concurrency protection for a request that is genuinely still running.
{
  const freshKey = "fresh_in_progress_still_blocks";
  const seedFp = testFingerprint("POST", "/v1/businesses", {
    name: "Fresh Lock Biz",
    default_currency: "USD",
  });
  await withTenant(orgId, async (tx) =>
    tx.insert(idempotencyKeys).values({
      organizationId: orgId,
      key: freshKey,
      requestFingerprint: seedFp,
      status: "in_progress",
      lockedAt: new Date(),
    }),
  );
  const r = await post("/v1/businesses", allKey, freshKey, {
    name: "Fresh Lock Biz",
    default_currency: "USD",
  });
  check(
    "F3 — a fresh (non-stale) in_progress row still 409s",
    r.status === 409 && r.newCrashes === 0,
    `${r.status}, ${crashDetail(r.newCrashes)}`,
  );
  check(
    "F3 — the fresh row is left untouched",
    (await keyRow(freshKey))?.status === "in_progress",
    `status=${(await keyRow(freshKey))?.status}`,
  );
}

// F4. the scheduled sweep itself (`platform/jobs.ts` calls this every clock tick).
// It is deliberately cross-organization (like `reapStuckTransfers`) — a platform-wide
// maintenance pass, not a tenant request — so the property worth proving is not
// "stays inside one org" but the two ways it could act IMPROPERLY: missing a stale
// row in some OTHER org (leaving that org's caller stuck), or over-reaching onto a
// fresh row anywhere (breaking someone's still-live request). One extra org, one
// stale row and one fresh row in each, checks both directions at once.
{
  const org2 = await createOrganization({ name: "Race Org 2 (sweep reach)" });
  const org2Id = org2.organization.id;
  const staleHere = "sweep_stale_org1";
  const sideHere = "sweep_side_org1";
  const freshHere = "sweep_fresh_org1";
  const staleOther = "sweep_stale_org2";
  const freshOther = "sweep_fresh_org2";
  await withTenant(orgId, async (tx) => {
    await tx.insert(idempotencyKeys).values({
      organizationId: orgId,
      key: staleHere,
      requestFingerprint: "x",
      status: "in_progress",
      lockedAt: staleLockedAt(),
    });
    await tx.insert(idempotencyKeys).values({
      organizationId: orgId,
      key: sideHere,
      requestFingerprint: "x",
      status: "side_effects",
      lockedAt: staleLockedAt(),
    });
    await tx.insert(idempotencyKeys).values({
      organizationId: orgId,
      key: freshHere,
      requestFingerprint: "x",
      status: "in_progress",
      lockedAt: new Date(),
    });
  });
  await withTenant(org2Id, async (tx) => {
    await tx.insert(idempotencyKeys).values({
      organizationId: org2Id,
      key: staleOther,
      requestFingerprint: "x",
      status: "in_progress",
      lockedAt: staleLockedAt(),
    });
    await tx.insert(idempotencyKeys).values({
      organizationId: org2Id,
      key: freshOther,
      requestFingerprint: "x",
      status: "in_progress",
      lockedAt: new Date(),
    });
  });

  const result = await reapStaleIdempotencyKeys(new Date());
  console.log(`scheduled sweep: freed=${result.freed} orphaned=${result.orphaned}`);

  const rowIn = (org: string, k: string) =>
    withTenant(org, async (tx) => {
      const [row] = await tx
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, k))
        .limit(1);
      return row ?? null;
    });

  check(
    "F4 — sweep freed the stale in_progress row in THIS org (deleted, not marked)",
    (await rowIn(orgId, staleHere)) === null,
    `row=${(await rowIn(orgId, staleHere)) ? "PRESENT" : "none"}`,
  );
  check(
    "F4 — sweep orphaned the stale side_effects row in THIS org to a terminal failed",
    (await rowIn(orgId, sideHere))?.status === "failed",
    `status=${(await rowIn(orgId, sideHere))?.status}`,
  );
  check(
    "F4 — sweep left the FRESH in_progress row in THIS org untouched",
    (await rowIn(orgId, freshHere))?.status === "in_progress",
    `status=${(await rowIn(orgId, freshHere))?.status}`,
  );
  check(
    "F4 — sweep also reached the stale row in the OTHER organization (no under-reach)",
    (await rowIn(org2Id, staleOther)) === null,
    `row=${(await rowIn(org2Id, staleOther)) ? "PRESENT" : "none"}`,
  );
  check(
    "F4 — sweep left the fresh row in the OTHER organization untouched (no over-reach)",
    (await rowIn(org2Id, freshOther))?.status === "in_progress",
    `status=${(await rowIn(org2Id, freshOther))?.status}`,
  );
}

// F5. a time-travel tick passes a SIMULATED instant; the reaper must still judge on the real
// clock. On the simulated one, every live key in every org looked stale: in_progress rows
// were deleted (a duplicate could run again) and side_effects rows were orphaned.
{
  const liveIn = "travel_live_in_progress";
  const liveSide = "travel_live_side_effects";
  await withTenant(orgId, async (tx) => {
    for (const [key, status] of [
      [liveIn, "in_progress"],
      [liveSide, "side_effects"],
    ] as const)
      await tx.insert(idempotencyKeys).values({
        organizationId: orgId,
        key,
        requestFingerprint: "x",
        status,
        lockedAt: new Date(),
      });
  });
  await runBillingClockTickOnce(() => {}, new Date(Date.now() + 30 * 86_400_000));
  const statusOf = (k: string) =>
    withTenant(orgId, async (tx) => {
      const [row] = await tx
        .select({ status: idempotencyKeys.status })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, k))
        .limit(1);
      return row?.status ?? "none";
    });
  const [inNow, sideNow] = [await statusOf(liveIn), await statusOf(liveSide)];
  check(
    "F5 — a tick 30 days in the simulated future leaves live in_progress and side_effects keys alone",
    inNow === "in_progress" && sideNow === "side_effects",
    `in_progress row=${inNow}, side_effects row=${sideNow}`,
  );
}

// ── G. no-store routes: stay idempotent, stop storing the secret ───────────────
//
// The 2026-08-04 sweep protected `POST /v1/api_keys`, and `idempotencyOnSend` persists
// `responseBody` verbatim into a plain `jsonb` column. `api_keys` stores only
// `hashed_key` — the raw `sk_…` is shown once, on purpose — so a keyed create made
// `idempotency_keys.response_body` the credential's ONLY plaintext home: a secret-at-rest
// downgrade (same RLS tenant scope, so never a cross-tenant leak) that quietly repealed
// "shown once". `config: idempotentNoStore` removes the trade-off instead of reversing it:
// the route stays protected, and the body is replaced by a secret-free marker.
//
// The three properties that must hold TOGETHER — any two without the third is a bug:
//   1. a retry still mints NO second credential (that is why the route is protected),
//   2. the stored row contains no secret (that is the regression being closed),
//   3. the retry's answer distinguishes "already created, secret is gone" from "your
//      request failed", or an operator retries forever and never learns a key exists.
console.log("");
const beforeG = checks.length;
console.log(`sections A–F: ${beforeG} assertions, ${checks.filter((c) => !c.ok).length} failed`);

/** GET with a bearer key — the direct proof a minted secret really authenticates. */
async function get(url: string, k: string) {
  const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${k}` } });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  return { status: res.statusCode, body: parsed };
}

/** Count this org's api_keys rows — the count-based proof that a retry mints nothing. */
const apiKeyCount = () =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(apiKeys).where(eq(apiKeys.organizationId, orgId))).length,
  );

/**
 * Does this secret appear ANYWHERE in the org's idempotency_keys table? Cast the whole
 * `jsonb` column to text and substring-match, rather than inspecting the one field we
 * expect: the leak we are closing would also be a leak inside a nested object, or inside
 * a `url` that embeds the token, and a field-name check would miss both.
 */
async function secretStoredAnywhere(secret: string) {
  return withTenant(orgId, async (tx) => {
    const rows = await tx
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.organizationId, orgId),
          sql`${idempotencyKeys.responseBody}::text LIKE ${"%" + secret + "%"}`,
        ),
      );
    return rows.map((r) => r.key);
  });
}

// G1. RED — the regression, reproduced live. Identical handler, flag absent: the raw
// secret the caller got back is sitting in `response_body` in the clear.
{
  const redKey = "nostore_RED_probe";
  const r = await post("/__probe/mint_secret", allKey, redKey, { probe: "red" });
  const redSecret = String(r.body.secret ?? "");
  check(
    "G1 RED — a protected route WITHOUT the flag returns its secret",
    r.status === 200 && redSecret.startsWith("sk_"),
    `${r.status} secret=${redSecret ? `${redSecret.slice(0, 11)}…` : "MISSING"}`,
  );
  const leaked = await secretStoredAnywhere(redSecret);
  check(
    "G1 RED — …and that raw secret IS persisted in idempotency_keys (the regression)",
    leaked.length === 1 && leaked[0] === redKey,
    `found in ${leaked.length} row(s): ${leaked.join(",")}`,
  );
  const row = await keyRow(redKey);
  check(
    "G1 RED — the stored body is the real response, secret field and all",
    typeof (row?.responseBody as Record<string, unknown> | null)?.secret === "string",
    `secret field ${typeof (row?.responseBody as Record<string, unknown> | null)?.secret}`,
  );

  // Clean up after ourselves: this probe deliberately persisted a LIVE credential in the
  // clear to prove the regression, so scrub the row and revoke the key rather than leaving
  // a usable plaintext secret behind in whatever database the suite ran against.
  await withTenant(orgId, async (tx) =>
    tx
      .update(idempotencyKeys)
      .set({ responseBody: { redacted_by: "verify-idempotency-race G1" } })
      .where(eq(idempotencyKeys.id, row!.id)),
  );
  await revokeApiKey(orgId, String(r.body.id));
  check(
    "G1 RED — the probe leaves no live plaintext credential behind (test hygiene)",
    (await secretStoredAnywhere(redSecret)).length === 0,
    `${(await secretStoredAnywhere(redSecret)).length} row(s) still contain it`,
  );
}

// G2. GREEN — same handler, same secret shape, flag present. The caller still gets a
// usable secret in its ACTUAL HTTP response; the stored copy is gone.
{
  const greenKey = "nostore_GREEN_probe";
  const before = noStoreExecutions;
  const r = await post("/__probe/mint_secret_nostore", allKey, greenKey, { probe: "green" });
  const greenSecret = String(r.body.secret ?? "");
  check(
    "G2 GREEN — the caller still receives the secret in its own HTTP response",
    r.status === 200 && greenSecret.startsWith("sk_"),
    `${r.status} secret=${greenSecret ? `${greenSecret.slice(0, 11)}…` : "MISSING"}`,
  );
  check(
    "G2 GREEN — the secret is absent from EVERY stored response body",
    (await secretStoredAnywhere(greenSecret)).length === 0,
    `${(await secretStoredAnywhere(greenSecret)).length} row(s) contain it (MUST be 0)`,
  );

  // The row itself is finalized exactly as any other 2xx would be — only the body differs.
  const row = await keyRow(greenKey);
  const stored = row?.responseBody as Record<string, unknown> | null;
  check(
    "G2 GREEN — the row is still a normal terminal `completed` with the REAL status",
    row?.status === "completed" && row?.responseStatus === 200,
    `status=${row?.status} response_status=${row?.responseStatus}`,
  );
  check(
    "G2 GREEN — the stored body is the secret-free marker, not the response",
    stored?.__idempotency_response_not_stored === true &&
      stored?.original_response_status === 200 &&
      !("secret" in (stored ?? {})),
    `${JSON.stringify(stored)}`,
  );

  // Property 1: the retry does not re-execute. Property 3: it says so, clearly.
  const replay = await post("/__probe/mint_secret_nostore", allKey, greenKey, { probe: "green" });
  const err = (replay.body.error ?? {}) as Record<string, unknown>;
  check(
    "G2 GREEN — the retry does NOT re-execute the handler (no second credential)",
    noStoreExecutions === before + 1,
    `${noStoreExecutions - before} execution(s) (MUST be 1)`,
  );
  check(
    "G2 GREEN — the retry is a 409 marked as a replay, not a silent 2xx",
    replay.status === 409 && replay.headers["idempotent-replayed"] === "true",
    `${replay.status} replayed=${replay.headers["idempotent-replayed"] ?? "no"}`,
  );
  check(
    'G2 GREEN — the retry says "already created" (created:true + the original 2xx), not "failed"',
    err.code === "response_not_replayable" &&
      err.created === true &&
      err.original_response_status === 200,
    `code=${String(err.code)} created=${String(err.created)} original=${String(err.original_response_status)}`,
  );
  check(
    "G2 GREEN — the retry never re-shares the secret",
    !JSON.stringify(replay.body).includes(greenSecret),
    "secret absent from the replay body",
  );
}

// G3. THE REAL ROUTE: `POST /v1/api_keys`. Everything above is a probe; this is the
// credential the regression was actually about.
let realSecret = "";
{
  const mintKey = "nostore_api_keys_real";
  const before = await apiKeyCount();
  const r = await post("/v1/api_keys", allKey, mintKey, { livemode: "test" });
  realSecret = String(r.body.secret ?? "");
  check(
    "G3 — POST /v1/api_keys with an Idempotency-Key still returns 201 + the secret",
    r.status === 201 && realSecret.startsWith("sk_test_"),
    `${r.status} secret=${realSecret ? `${realSecret.slice(0, 13)}…` : "MISSING"}`,
  );

  // THE DB PROOF.
  check(
    "G3 — the raw secret is absent from idempotency_keys.response_body",
    (await secretStoredAnywhere(realSecret)).length === 0,
    `${(await secretStoredAnywhere(realSecret)).length} row(s) contain it (MUST be 0)`,
  );

  // …and the caller's copy is real: it authenticates, and it names the key that exists.
  const authed = await get("/v1/api_keys", realSecret);
  const listed = (authed.body.data as Array<{ id: string }> | undefined) ?? [];
  check(
    "G3 — the minted secret still WORKS for auth (only the stored copy is redacted)",
    authed.status === 200 && listed.some((k) => k.id === r.body.id),
    `${authed.status}, ${listed.length} key(s) listed, target present=${listed.some((k) => k.id === r.body.id)}`,
  );

  // Property 1 on the real route, by table count.
  const replay = await post("/v1/api_keys", allKey, mintKey, { livemode: "test" });
  const after = await apiKeyCount();
  const err = (replay.body.error ?? {}) as Record<string, unknown>;
  check(
    "G3 — the same key twice mints exactly ONE credential",
    after === before + 1,
    `api_keys ${before} → ${after} (MUST be +1)`,
  );
  check(
    "G3 — the retry gets 409 response_not_replayable with created:true + original 201",
    replay.status === 409 &&
      err.code === "response_not_replayable" &&
      err.created === true &&
      err.original_response_status === 201,
    `${replay.status} code=${String(err.code)} created=${String(err.created)} original=${String(err.original_response_status)}`,
  );
  check(
    "G3 — the retry does not leak the secret either",
    !JSON.stringify(replay.body).includes(realSecret),
    "secret absent",
  );

  // The fingerprint 409 must be UNAFFECTED — and tellably different from the replay 409.
  const mismatch = await post("/v1/api_keys", allKey, mintKey, { livemode: "all" });
  const merr = (mismatch.body.error ?? {}) as Record<string, unknown>;
  check(
    "G3 — a DIFFERENT payload on the same key still 409s as a fingerprint mismatch",
    mismatch.status === 409 &&
      merr.code === undefined &&
      String(merr.message).includes("different request payload"),
    `${mismatch.status} ${String(merr.message).slice(0, 60)}`,
  );
  check(
    "G3 — the mismatch minted nothing and left the row terminal",
    (await apiKeyCount()) === after && (await keyRow(mintKey))?.status === "completed",
    `count=${await apiKeyCount()} status=${(await keyRow(mintKey))?.status}`,
  );
}

// G4. A pre-write early return on a no-store route must NOT poison the key — the
// asymmetry the flag must not disturb. A test-mode key asking for an `all` key 400s
// before `createApiKey` runs, so the row must be DELETED and the key stay free.
{
  const freeKey = "nostore_pre_write_400";
  const before = await apiKeyCount();
  const bad = await post("/v1/api_keys", testKey, freeKey, { livemode: "all" });
  check(
    "G4 — pre-write 400 on a no-store route replies once, mints nothing",
    bad.status === 400 && bad.newCrashes === 0 && (await apiKeyCount()) === before,
    `${bad.status}, ${crashDetail(bad.newCrashes)}, count unchanged=${(await apiKeyCount()) === before}`,
  );
  check(
    "G4 — no idempotency record stored (the key is NOT spent)",
    (await keyRow(freeKey)) === null,
    "no row",
  );
  const reuse = await post("/v1/api_keys", testKey, freeKey, { livemode: "test" });
  check(
    "G4 — the same key is reusable afterwards and mints normally",
    reuse.status === 201 && String(reuse.body.secret ?? "").startsWith("sk_test_"),
    `${reuse.status}`,
  );
  check(
    "G4 — …and that mint stored no secret either",
    (await secretStoredAnywhere(String(reuse.body.secret))).length === 0,
    `${(await secretStoredAnywhere(String(reuse.body.secret))).length} row(s)`,
  );
}

// G5. The `failed` half: a no-store route that WROTE and then threw. It must keep its
// row (never re-executable), store no body, and replay the ORIGINAL FAILURE — a
// `created: true` here would tell an operator a credential exists when the attempt died.
{
  const failKey = "nostore_write_then_500";
  const before = noStoreFailExecutions;
  const r1 = await post("/__probe/nostore_write_then_500", allKey, failKey, { probe: "fail" });
  const row = await keyRow(failKey);
  const stored = row?.responseBody as Record<string, unknown> | null;
  check(
    "G5 — a post-write 500 on a no-store route keeps its record as `failed`",
    row?.status === "failed" && row?.responseStatus === 500,
    `status=${row?.status} response_status=${row?.responseStatus}`,
  );
  check(
    "G5 — the failed row stores the marker, not the response body",
    stored?.__idempotency_response_not_stored === true && stored?.original_response_status === 500,
    `${JSON.stringify(stored)}`,
  );

  const r2 = await post("/__probe/nostore_write_then_500", allKey, failKey, { probe: "fail" });
  const err = (r2.body.error ?? {}) as Record<string, unknown>;
  check(
    "G5 — the retry is NOT re-executed",
    noStoreFailExecutions === before + 1,
    `${noStoreFailExecutions - before} execution(s) (MUST be 1)`,
  );
  check(
    "G5 — the retry replays the ORIGINAL failure status with created:false",
    r2.status === r1.status &&
      r2.status === 500 &&
      err.created === false &&
      err.original_response_status === 500,
    `${r1.status}→${r2.status} created=${String(err.created)} original=${String(err.original_response_status)}`,
  );
}

// G6. The opt-out must be OPT-IN. A normal route's 2xx replay is still byte-for-value
// the real response — the flag must not have leaked into the default path.
{
  const normalKey = "nostore_optin_control";
  const first = await post("/v1/businesses", allKey, normalKey, {
    name: "Opt-In Control Co",
    default_currency: "USD",
  });
  const row = await keyRow(normalKey);
  const stored = row?.responseBody as Record<string, unknown> | null;
  check(
    "G6 — an ordinary protected route still stores its REAL body (no marker)",
    stored?.__idempotency_response_not_stored === undefined && stored?.id === first.body.id,
    `marker absent=${stored?.__idempotency_response_not_stored === undefined}`,
  );
  const replay = await post("/v1/businesses", allKey, normalKey, {
    name: "Opt-In Control Co",
    default_currency: "USD",
  });
  check(
    "G6 — …and still replays it as a 2xx, value-identical (locked decision #5 intact)",
    replay.status === 201 &&
      replay.headers["idempotent-replayed"] === "true" &&
      deepEqual(replay.body, first.body),
    `${replay.status} replayed=${replay.headers["idempotent-replayed"] ?? "no"} equal=${deepEqual(replay.body, first.body)}`,
  );
}

// G7. Nothing in this run wrote a secret anywhere it should not be. A whole-table sweep
// for the ONE secret we know the value of, across every row of every status — the check
// that would catch a future code path storing it somewhere G2/G3 do not look.
{
  const anywhere = await secretStoredAnywhere(realSecret);
  check(
    "G7 — a full idempotency_keys scan finds the api-key secret in NO row",
    anywhere.length === 0,
    `${anywhere.length} row(s): ${anywhere.join(",") || "none"}`,
  );
}
console.log(`section G: ${checks.length - beforeG} assertions (A–F ${beforeG} unchanged)`);

await app.close();

const failed = checks.filter((c) => !c.ok);
console.log("");
if (crashes.length) {
  console.log(
    `💥 ${crashes.length} uncaught error(s) — in production each one KILLS the API process:`,
  );
  for (const c of crashes.slice(0, 3)) console.log(`   ${c.code ?? ""} ${c.message}`);
  console.log("");
}
console.log(
  failed.length === 0
    ? "✅ IDEMPOTENCY RACE: PASS (one key → one effect; early returns reply once and free the key)"
    : `❌ IDEMPOTENCY RACE: FAIL (${failed.length}/${checks.length})\n${failed.map((f) => `   - ${f.name}`).join("\n")}`,
);
await closeDb();
process.exit(failed.length === 0 && crashes.length === 0 ? 0 : 1);
