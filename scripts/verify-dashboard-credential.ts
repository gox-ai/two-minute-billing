/**
 * Gate: the dashboard's ORGANIZATION comes from the signed-in operator's session, never
 * from an API key (0198).
 *
 * The defect this locks out was silent and fail-open. The dashboard authenticated with
 * one `kind='dashboard'` key from server env, and THAT key chose the organization; the
 * session was read only to name the actor. An operator in two organizations could
 * switch, watch the entire UI change, and go on reading and writing the key's tenant —
 * `/auth/me` said org B, every `/v1/*` call answered with org A's rows, status 200.
 *
 * Both halves are checked, because either one alone can regress:
 *   §A the dashboard stops sending a key at all (source)
 *   §B the engine resolves the org from the session, even against a key (behaviour)
 *
 * Run: pnpm tsx scripts/verify-dashboard-credential.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";
import { memberships, organizations } from "@db/schema";
import { signup } from "@/modules/auth/service";
import { enrolAndSignIn } from "./lib/mfa-policy";
import { createBusiness } from "@/modules/tenancy/service";
import { buildApp } from "@/index";

/**
 * The API is booted IN-PROCESS on an ephemeral port, the way 32 other HTTP suites here
 * already do it (`verify-bola.ts:72`). It used to drive an EXTERNAL server at
 * `TMBILLING_API_URL ?? http://localhost:4000`, which broke the suite two ways and gated
 * nothing in the one place it was supposed to:
 *
 *  · IN CI it is a hard error, not a skip. CI starts no API — `.github/workflows/ci.yml`
 *    runs `verify:all --shard i/5` against a Postgres service and nothing else — so every
 *    `fetch` here died with ECONNREFUSED. The suite is listed in `CORE`, so the shard
 *    carrying it fails outright. That went unnoticed because CI only runs for a PR whose
 *    HEAD is `development`; on every other branch all three jobs skip.
 *  · LOCALLY it fails on FIXTURES THE API CANNOT SEE. The external server is bound to
 *    whatever database it was started with, while this suite writes its orgs through `db`.
 *    Under `pnpm verify:all:fresh` — the documented way to run the gate without truncating
 *    your dev database — those are two different databases, and the first
 *    `switch_organization` returns 403 for a session the server has never heard of.
 *
 * Booting the app here binds the API and the fixtures to ONE `DATABASE_URL` by
 * construction, which also retires the "cannot be sharded onto a private database"
 * exception in `scripts/verify-all.sh`. `TMBILLING_API_URL` is deliberately NOT honoured:
 * pointing this at a deployed API is what produced the 403 above.
 */
const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const API = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

let failures = 0;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

// ── §A the dashboard no longer holds a key ─────────────────────────────────────
console.log("\n§A  the dashboard sends no API key");
{
  // Comments explain at length what the key USED to do, so match code, not prose.
  const codeOf = (file: string) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  const code = codeOf("dashboard/lib/api.ts");
  check("no Authorization header is sent", !/Authorization\s*:/.test(code));
  check("the session cookie IS forwarded", /tmb_session=/.test(code));

  // Swept over the WHOLE dashboard tree, not just lib/api.ts. This check used to read
  // that one file, and the two route handlers that stream the invoice PDF and printable
  // HTML went on sending `Bearer ${TMBILLING_API_KEY}` for three days underneath a
  // passing gate: they are the same defect (org from env, not from the login) in a file
  // the gate never opened. Any server file reading the key is a regression, wherever it
  // lives. The `Authorization:` half stays scoped to lib/api.ts — the storefront's portal
  // routes legitimately send a buyer's portal token in that header.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && /process\.env\.TMBILLING_API_KEY/.test(codeOf(full)))
        offenders.push(full);
    }
  };
  walk("dashboard");
  check(
    "no TMBILLING_API_KEY is read anywhere in dashboard/",
    offenders.length === 0,
    offenders.length ? offenders.join(", ") : "swept dashboard/**/*.ts(x)",
  );
}

// ── setup: an operator who belongs to TWO organizations ────────────────────────
// Everything here is minted by the suite. It used to look up the seeded login
// and throw "run pnpm seed first" on any database that had not been seeded — so the gate
// died on whether some OTHER command had run, which is the same class of defect the
// fresh-org comment below already records.
//
// ⚠️ This is an HTTP gate, so it has a constraint no amount of self-provisioning removes:
// the rows it writes through `db` must be visible to the API it calls at $TMBILLING_API_URL.
// Point `DATABASE_URL` at an isolated verify database while the server serves the dev one
// and setup succeeds, then `switch_organization` answers 403 — the membership it is
// checking was written somewhere the server cannot see. Run it against the server's own
// database (that is what a bare `pnpm verify:dashboard-credential` does), not under the
// isolated-DB harness the pure-engine suites use.
const stamp = Date.now();
const LOGIN = { email: `gate-operator-${stamp}@repro.dev`, password: "Sparrow-Lantern-9134" };

// Org A: the operator's home. It gets a BUSINESS because §B proves the org switch by
// showing `/v1/businesses` returns different rows on either side — two empty orgs both
// answer `[]` and the check would pass on nothing.
const home = await signup({
  email: LOGIN.email,
  password: LOGIN.password,
  name: "Gate Operator",
  organizationName: `Credential Gate Home ${stamp}`,
});
const operator = { id: home.user.userId };
// Org A's OWN key, so §B can build a genuinely CROSS-ORG credential pair. Without it the only
// key in scope belongs to the same org as the session, which is what made the old precedence
// assertion unfalsifiable.
const homeOrgKey = home.dashboardKeySecret;
const [orgA] = await systemDb
  .select()
  .from(organizations)
  .where(eq(organizations.id, home.user.organizationId))
  .limit(1);
await createBusiness({
  organizationId: orgA!.id,
  name: `Gate Home Biz ${stamp}`,
  defaultCurrency: "USD",
  livemode: "test",
});

// Org B: a FRESH org, so the suite carries its own key rather than depending on one
// happening to be in the environment. §C used to skip silently when it wasn't.
const OTHER = `Credential Gate Org ${stamp}`;
const created = await signup({
  email: `gate-${stamp}@repro.dev`,
  password: "Sparrow-Lantern-9134",
  name: "Gate Owner",
  organizationName: OTHER,
});
const otherOrgKey = created.dashboardKeySecret;
const [orgB] = await systemDb
  .select()
  .from(organizations)
  .where(eq(organizations.id, created.user.organizationId))
  .limit(1);
const [member] = await systemDb
  .select()
  .from(memberships)
  .where(and(eq(memberships.userId, operator.id), eq(memberships.organizationId, orgB!.id)))
  .limit(1);
if (!member)
  await systemDb
    .insert(memberships)
    .values({ userId: operator.id, organizationId: orgB!.id, role: "admin" });

// Compliant with the MFA mandate whether or not this deployment enables it — an HTTP suite
// cannot suppress the policy, because the server reads its own .env. See lib/mfa-policy.ts.
const { token: sessionA } = await enrolAndSignIn({
  userId: home.user.userId,
  email: LOGIN.email,
  password: LOGIN.password,
});
async function switchTo(token: string, org: string) {
  const res = await fetch(`${API}/auth/switch_organization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `tmb_session=${token}` },
    body: JSON.stringify({ organization: org }),
  });
  const t = /tmb_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  if (!t) throw new Error(`switch failed: ${res.status}`);
  return t;
}
const orgFor = async (headers: Record<string, string>) => {
  const res = await fetch(`${API}/v1/businesses`, { headers });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { data?: unknown[] } };
};

// ── §B the engine resolves the org from the session ────────────────────────────
console.log("\n§B  the session decides the organization");
{
  // Read org A BEFORE switching away from it: `switchOrganization` deletes the old
  // session row, so a token captured earlier is already revoked by the time the second
  // switch returns. That rotation is deliberate — don't "fix" it by keeping both alive.
  const inA = await switchTo(sessionA, orgA!.publicId);
  const a = await orgFor({ cookie: `tmb_session=${inA}` });

  const inB = await switchTo(inA, orgB!.publicId);
  const b = await orgFor({ cookie: `tmb_session=${inB}` });
  check(
    "a session alone authenticates",
    a.status === 200 && b.status === 200,
    `${a.status}/${b.status}`,
  );
  check(
    "switching organizations changes the data",
    JSON.stringify(a.body.data) !== JSON.stringify(b.body.data),
  );

  // A session and a key for the SAME org. This is the shape the dashboard sends, and the
  // answer must be that org either way.
  //
  // ⚠ This was labelled "a session beats another org's key" and called load-bearing. It was
  // neither: `otherOrgKey` belongs to org B and the session had just been switched to org B, so
  // BOTH credentials named the same tenant — the session path and the key path return
  // byte-identical data, and the assertion could not fail whichever one `authenticate` chose.
  // Kept, honestly labelled, as a smoke test; the real precedence case is below.
  const both = await orgFor({
    cookie: `tmb_session=${inB}`,
    Authorization: `Bearer ${otherOrgKey}`,
  });
  check(
    "a session and its OWN org's key agree",
    JSON.stringify(both.body.data) === JSON.stringify(b.body.data),
    "same-org pair",
  );

  // ── THE ACTUAL PRECEDENCE BRANCH ──────────────────────────────────────────────
  // A session for org B carried alongside a key for org A. `authenticate` resolves this by
  // IGNORING the session and letting the key decide, logging `session_org_mismatch` — and
  // until now nothing asserted it, on either side.
  //
  // The direction matters and is not arbitrary. A cookie is AMBIENT: the browser attaches it
  // and a proxy forwards whatever it was handed. The key was presented deliberately. If the
  // ambient credential could redirect a key-authorised call, a planted session would divert
  // an integration's writes — and its customers' data — into the session holder's
  // organization. So the answer must be org A's data, NOT org B's.
  const crossed = await orgFor({
    cookie: `tmb_session=${inB}`,
    Authorization: `Bearer ${homeOrgKey}`,
  });
  check(
    "a foreign session does NOT redirect a key-authorised call",
    JSON.stringify(crossed.body.data) === JSON.stringify(a.body.data),
    `expected org A's data (the key's org); got ${JSON.stringify(crossed.body.data) === JSON.stringify(b.body.data) ? "org B's — the session won" : "neither"}`,
  );
  // And the two orgs really do differ, or the line above proves nothing. This is the control
  // whose absence made the original assertion vacuous.
  check(
    "…and the two orgs are distinguishable at all",
    JSON.stringify(a.body.data) !== JSON.stringify(b.body.data),
  );
}

// ── §C integrations are untouched ──────────────────────────────────────────────
console.log("\n§C  API keys still work for integrations");
{
  const viaKey = await orgFor({ Authorization: `Bearer ${otherOrgKey}` });
  check("a key alone still authenticates", viaKey.status === 200, String(viaKey.status));
  const bad = await orgFor({ Authorization: "Bearer sk_test_definitely_invalid" });
  check("an invalid key is still refused", bad.status === 401, String(bad.status));
  // A dead session must not lock out a caller whose key is fine.
  const stale = await orgFor({
    cookie: "tmb_session=sess_expired",
    Authorization: `Bearer ${otherOrgKey}`,
  });
  check("a dead session falls through to the key", stale.status === 200, String(stale.status));
}

// Take BOTH fixture orgs with us. A gate that leaves a tenant behind on every run turns
// a dev estate into thousands of orgs, which is how the platform flag got lost here —
// and this suite now mints its home org too, so it would leak twice as fast.
await systemDb.delete(organizations).where(eq(organizations.id, orgB!.id));
await systemDb.delete(organizations).where(eq(organizations.id, orgA!.id));

console.log(failures === 0 ? "\n✅ dashboard credential OK\n" : `\n❌ ${failures} failure(s)\n`);
await app.close();
await closeDb();
process.exit(failures === 0 ? 0 : 1);
