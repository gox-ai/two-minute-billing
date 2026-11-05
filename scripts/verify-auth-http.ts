/**
 * HTTP auth flow through the real server (in-process): signup → cookie → /auth/me,
 * login, logout invalidates, RBAC 403 on invite by a non-admin.
 *
 *   pnpm verify:auth-http
 */
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { signup } from "@/modules/auth/service";
import { systemDb, closeDb } from "@/platform/db";
import { users, authTokens } from "@db/schema";
import { pinMfaMandateOff } from "./lib/mfa-policy";

// Not a test of the MFA mandate — see scripts/lib/mfa-policy.ts. Must precede any fixture.
pinMfaMandateOff();

const app = await buildApp({ logger: false });
const uniq = Date.now().toString().slice(-8);
const checks: Array<[string, boolean]> = [];

const j = (r: { body: string }) => JSON.parse(r.body);
const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const sc = r.headers["set-cookie"];
  const raw = Array.isArray(sc) ? sc[0] : (sc as string);
  return raw?.split(";")[0] ?? "";
};

// Self-serve signup is closed by default (audit H2/M9), so the account comes from the SERVICE
// — the same way the importer and the seed create one — and the HTTP surface below is
// exercised through `login`, which is the flow an operator actually uses.
const email = `o${uniq}@a.com`;
const password = "Sparrow-Lantern-91344";
await signup({ email, password, organizationName: "Acme" });

const closedSignup = await app.inject({
  method: "POST",
  url: "/auth/signup",
  payload: { email: `other-${uniq}@a.com`, password, organization_name: "Acme Two" },
});
checks.push(["the signup route is closed (403)", closedSignup.statusCode === 403]);

const su = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
const cookie = cookieOf(su);
checks.push(
  ["login 200", su.statusCode === 200],
  ["login sets cookie", cookie.startsWith("tmb_session=")],
  ["login owner", j(su).user.role === "owner"],
);

// me with cookie
const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
checks.push(["me 200 with cookie", me.statusCode === 200 && j(me).role === "owner"]);

// me without cookie → 401
const meNo = await app.inject({ method: "GET", url: "/auth/me" });
checks.push(["me 401 without cookie", meNo.statusCode === 401]);

// invite ops user (owner can). NO password in the body — the invitee chooses their own
// through the emailed link (0197), so an invited account cannot be signed into yet.
const inv = await app.inject({
  method: "POST",
  url: "/auth/invite",
  headers: { cookie },
  payload: { email: `ops${uniq}@a.com`, role: "ops" },
});
checks.push(["owner invites ops 201", inv.statusCode === 201]);

// Walk the acceptance, because everything below needs a session for that user. The token
// is minted here rather than read from the mail: only its hash is stored, by design.
const [invited] = await systemDb
  .select()
  .from(users)
  .where(eq(users.email, `ops${uniq}@a.com`))
  .limit(1);
checks.push([
  "invited user cannot sign in before accepting",
  (
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: `ops${uniq}@a.com`, password: "Sparrow-Lantern-91344" },
    })
  ).statusCode === 401,
]);
const inviteToken = `invt_${randomBytes(32).toString("base64url")}`;
await systemDb.insert(authTokens).values({
  userId: invited!.id,
  tokenHash: createHash("sha256").update(inviteToken).digest("hex"),
  purpose: "invite",
  expiresAt: new Date(Date.now() + 3600_000),
});
const accept = await app.inject({
  method: "POST",
  url: "/auth/accept_invite",
  payload: { token: inviteToken, password: "Sparrow-Lantern-91344" },
});
checks.push(["accepting the invite returns a session", accept.statusCode === 200]);

// ops logs in, tries to invite → 403
const opsLogin = await app.inject({
  method: "POST",
  url: "/auth/login",
  payload: { email: `ops${uniq}@a.com`, password: "Sparrow-Lantern-91344" },
});
const opsCookie = cookieOf(opsLogin);
const opsInvite = await app.inject({
  method: "POST",
  url: "/auth/invite",
  headers: { cookie: opsCookie },
  payload: { email: `x${uniq}@a.com`, role: "ops" },
});
checks.push(["ops invite forbidden 403", opsInvite.statusCode === 403]);

// wrong password → 401
const bad = await app.inject({
  method: "POST",
  url: "/auth/login",
  payload: { email: `o${uniq}@a.com`, password: "nope" },
});
checks.push(["wrong password 401", bad.statusCode === 401]);

// logout → me 401
await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
const meAfter = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
checks.push(["logout invalidates session", meAfter.statusCode === 401]);

await app.close();
let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ AUTH HTTP: PASS" : "❌ AUTH HTTP: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
