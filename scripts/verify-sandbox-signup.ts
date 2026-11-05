/**
 * verify:sandbox-signup — self-serve sign-up and the sandbox lock (0354).
 *
 * What it pins:
 *  - sign-up is refused while SIGNUP_ENABLED is off,
 *  - a password sign-up answers the same 202 for a new and a known address, mails the right
 *    message to each, and creates nothing until the link is spent (single use),
 *  - a Google sign-up needs a valid, unexpired, untampered ticket, and an unknown Google
 *    address reaches sign-up only while sign-up is on,
 *  - a sign-up (SIGNUP_SANDBOX) starts on the Free plan with live mode on (0356): its live
 *    business takes writes with no plan,
 *  - a staff lock refuses writes to its live businesses with `live_access_required`, while
 *    reads, test mode and a test→live transfer still work,
 *  - enabling live access lifts the lock; other orgs are unaffected.
 *
 *   pnpm verify:sandbox-signup
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { config } from "@/platform/config";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { createOrganization, enableLiveAccess } from "@/modules/tenancy/service";
import { GoogleSignupRequired, loginWithGoogle } from "@/modules/auth/service";
import { signGoogleSignupTicket } from "@/modules/auth/signup";
import { authTokens, memberships, organizations, users } from "@db/schema";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, !cond && detail !== undefined ? JSON.stringify(detail) : "");
}

const cfg = config as unknown as Record<string, string | undefined>;
const saved = {
  TMBILLING_EDITION: cfg.TMBILLING_EDITION,
  SIGNUP_ENABLED: cfg.SIGNUP_ENABLED,
  SIGNUP_SANDBOX: cfg.SIGNUP_SANDBOX,
  DASHBOARD_BASE_URL: cfg.DASHBOARD_BASE_URL,
  TURNSTILE_SECRET_KEY: cfg.TURNSTILE_SECRET_KEY,
};
// Sign-up and the sandbox lock are Cloud only; verify:edition pins the self-hosted side.
cfg.TMBILLING_EDITION = "cloud";
cfg.DASHBOARD_BASE_URL = "https://dash.example.com";
cfg.TURNSTILE_SECRET_KEY = undefined;

const mail: OutboundEmail[] = [];
setMailer({
  kind: "console",
  target: null,
  async send(m: OutboundEmail) {
    mail.push(m);
    return { providerMessageId: `fake_${mail.length}`, status: "sent" as const };
  },
});

const app = await buildApp({ logger: false });
await clearPublicRateLimits();
const j = (r: { body: string }) => JSON.parse(r.body);
const stamp = Date.now();
const profile = {
  name: "Ada Example",
  organization_name: `Sandbox Co ${stamp}`,
  country: "IN",
  billing_volume: "10k_100k",
  gateway: "razorpay",
};
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: payload as object, headers });

// ——— §A closed by default ————————————————————————————————————————————————
cfg.SIGNUP_ENABLED = "FALSE";
{
  const r = await post("/auth/signup", {
    ...profile,
    email: `a${stamp}@example.com`,
    password: "Long-Passphrase-71!",
  });
  ok("§A sign-up is refused while SIGNUP_ENABLED is off", r.statusCode === 403);
  const g = await app.inject({ method: "GET", url: "/auth/signup" });
  ok("§A GET /auth/signup says it is off", j(g).enabled === false);
}
cfg.SIGNUP_ENABLED = "TRUE";
cfg.SIGNUP_SANDBOX = "TRUE";

// ——— §B password sign-up: mail only, nothing created ——————————————————————
const email = `ada+${stamp}@example.com`;
let link = "";
{
  mail.length = 0;
  const r = await post("/auth/signup", { ...profile, email, password: "Long-Passphrase-71!" });
  ok("§B a new address answers 202", r.statusCode === 202, r.body);
  ok("§B one email, to that address", mail.length === 1 && mail[0]!.to === email);
  link = /\/signup\/confirm\/s\/(sgnp_[A-Za-z0-9_-]+)/.exec(mail[0]?.text ?? "")?.[1] ?? "";
  ok("§B the email carries a confirmation link", link.length > 10);
  const [u] = await systemDb.select().from(users).where(eq(users.email, email));
  ok("§B no user exists before the link is used", !u);
  const [o] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.name, profile.organization_name));
  ok("§B no organization exists before the link is used", !o);
}

// ——— §C a known address: same answer, different mail ——————————————————————
const known = await createOrganization({ name: `Known ${stamp}` });
const knownEmail = `known+${stamp}@example.com`;
await systemDb
  .insert(users)
  .values({ publicId: `usr_known${stamp}`, email: knownEmail, name: "Known" });
{
  mail.length = 0;
  const before = (await systemDb.select().from(authTokens).where(eq(authTokens.purpose, "signup")))
    .length;
  const r = await post("/auth/signup", {
    ...profile,
    email: knownEmail,
    password: "Long-Passphrase-71!",
  });
  ok(
    "§C a known address answers the same 202",
    r.statusCode === 202 &&
      r.body === JSON.stringify({ object: "signup", status: "confirmation_sent" }),
    r.body,
  );
  ok(
    "§C it is emailed 'already have an account'",
    mail.length === 1 && /already have/.test(mail[0]!.subject),
  );
  const after = (await systemDb.select().from(authTokens).where(eq(authTokens.purpose, "signup")))
    .length;
  ok("§C no pending sign-up is stored for it", after === before);
}

// ——— §D a weak password is refused before any lookup ——————————————————————
{
  const r = await post("/auth/signup", {
    ...profile,
    email: `weak${stamp}@example.com`,
    password: "short",
  });
  ok("§D a short password answers 400", r.statusCode === 400);
}

// ——— §E spending the link creates an organization on the Free plan and signs in —————————————
let session = "";
let orgPid = "";
{
  const r = await post("/auth/signup/confirm", { token: link });
  ok(
    "§E the link answers 201 with a session",
    r.statusCode === 201 && typeof j(r).token === "string",
    r.body,
  );
  session = j(r).token;
  const [u] = await systemDb.select().from(users).where(eq(users.email, email));
  ok("§E the user exists, verified", !!u?.emailVerifiedAt);
  const [m] = u
    ? await systemDb.select().from(memberships).where(eq(memberships.userId, u.id))
    : [];
  const [o] = m
    ? await systemDb.select().from(organizations).where(eq(organizations.id, m.organizationId))
    : [];
  orgPid = o?.publicId ?? "";
  ok(
    "§E they own a new organization",
    m?.role === "owner" && o?.name === profile.organization_name,
  );
  ok(
    "§E the organization starts on the Free plan, live mode on",
    o?.liveAccess === "enabled" && o.liveAccessEnabledBy === "plan:free",
    o,
  );
  ok(
    "§E country and answers are stored",
    o?.country === "IN" && (o?.signupAnswers as { gateway?: string })?.gateway === "razorpay",
  );
  const again = await post("/auth/signup/confirm", { token: link });
  ok("§E the link works one time only", again.statusCode === 400);
  const bad = await post("/auth/signup/confirm", { token: "sgnp_nope" });
  ok("§E an unknown token is refused", bad.statusCode === 400);
}

// ——— §F Google sign-up ————————————————————————————————————————————————
{
  const gEmail = `goog+${stamp}@example.com`;
  const ticket = signGoogleSignupTicket({
    sub: `g-${stamp}`,
    email: gEmail,
    name: "G",
    picture: null,
  });
  const tampered = ticket.replace(/\.(.)/, (_m, c: string) => `.${c === "A" ? "B" : "A"}`);
  const t = await post("/auth/signup", {
    ...profile,
    organization_name: `G Co ${stamp}`,
    google_ticket: tampered,
  });
  ok("§F a tampered ticket is refused", t.statusCode === 400);
  const r = await post("/auth/signup", {
    ...profile,
    organization_name: `G Co ${stamp}`,
    google_ticket: ticket,
  });
  ok(
    "§F a valid ticket signs up at once",
    r.statusCode === 201 && typeof j(r).token === "string",
    r.body,
  );
  const [u] = await systemDb.select().from(users).where(eq(users.email, gEmail));
  ok(
    "§F the user is bound to the Google account",
    u?.googleSub === `g-${stamp}` && !u?.passwordHash,
  );
  const dup = await post("/auth/signup", {
    ...profile,
    organization_name: `G2 ${stamp}`,
    google_ticket: ticket,
  });
  ok("§F the same Google account cannot sign up twice", dup.statusCode === 400);

  let routed = false;
  try {
    await loginWithGoogle({
      googleSub: `new-${stamp}`,
      email: `new+${stamp}@example.com`,
      emailVerified: true,
    });
  } catch (e) {
    routed = e instanceof GoogleSignupRequired;
  }
  ok("§F an unknown Google address is sent to sign-up while it is on", routed);
  cfg.SIGNUP_ENABLED = "FALSE";
  let invited = false;
  try {
    await loginWithGoogle({
      googleSub: `new2-${stamp}`,
      email: `new2+${stamp}@example.com`,
      emailVerified: true,
    });
  } catch (e) {
    invited = !(e instanceof GoogleSignupRequired);
  }
  ok("§F …and stays invite-only while it is off", invited);
  cfg.SIGNUP_ENABLED = "TRUE";
}

// ——— §G live mode with no plan; then the staff lock ———————————————————————————————
const S = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${session}`,
  "idempotency-key": crypto.randomUUID(),
  ...extra,
});
const biz = await post("/v1/businesses", { name: "Free Biz", default_currency: "INR" }, S());
ok("§G a new sign-up can create a business", biz.statusCode === 201, biz.body);
const liveId = j(biz).livemode === "live" ? j(biz).id : j(biz).live_business_id;
const testId = j(biz).livemode === "test" ? j(biz).id : j(biz).test_business_id;
{
  const free = await post(
    `/v1/businesses/${liveId}/customers`,
    { email: "first-buyer@example.com" },
    S(),
  );
  ok("§G a new sign-up makes a live write with no plan", free.statusCode === 201, free.body);
  // Nothing locks automatically any more; a staff lock still works.
  await systemDb
    .update(organizations)
    .set({ liveAccess: "locked" })
    .where(eq(organizations.publicId, orgPid));
  const me = await app.inject({ method: "GET", url: "/v1/me", headers: S() });
  ok("§G /v1/me reports live_access locked", j(me).live_access === "locked", me.body);
  const w = await post(`/v1/businesses/${liveId}/customers`, { email: "buyer@example.com" }, S());
  ok(
    "§G a write to the live business is refused",
    w.statusCode === 403 && j(w).error?.code === "live_access_required",
    w.body,
  );
  const rd = await app.inject({
    method: "GET",
    url: `/v1/businesses/${liveId}/customers`,
    headers: S(),
  });
  ok("§G reading the live business still works", rd.statusCode === 200);
  const tw = await post(`/v1/businesses/${testId}/customers`, { email: "buyer@example.com" }, S());
  ok("§G test mode works in full", tw.statusCode === 201, tw.body);
  const tr = await post(
    `/v1/businesses/${testId}/transfer_configurations`,
    { destination_business: liveId, sections: ["catalog"] },
    S(),
  );
  ok("§G the test catalogue can still be copied to live", tr.statusCode < 300, tr.body);
}

// ——— §H the Enterprise override lifts the lock ——————————————————————————————
{
  await enableLiveAccess(orgPid, "staff@example.com");
  const [o] = await systemDb.select().from(organizations).where(eq(organizations.publicId, orgPid));
  ok(
    "§H enabling records who and when",
    o?.liveAccess === "enabled" &&
      o.liveAccessEnabledBy === "staff@example.com" &&
      !!o.liveAccessEnabledAt,
  );
  const w2 = await post(`/v1/businesses/${liveId}/customers`, { email: "buyer@example.com" }, S());
  ok("§H once enabled, live writes work", w2.statusCode === 201, w2.body);
}

// ——— §I everyone else is unaffected ————————————————————————————————————————
{
  ok("§I an org made any other way is enabled", known.organization.liveAccess === "enabled");
  cfg.SIGNUP_SANDBOX = "FALSE";
  const ticket = signGoogleSignupTicket({
    sub: `h-${stamp}`,
    email: `self+${stamp}@example.com`,
    name: null,
    picture: null,
  });
  const r = await post("/auth/signup", {
    ...profile,
    organization_name: `Self ${stamp}`,
    google_ticket: ticket,
  });
  const [o] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.name, `Self ${stamp}`));
  ok(
    "§I with SIGNUP_SANDBOX off, a sign-up is an agreement: live mode, no plan",
    r.statusCode === 201 && o?.liveAccess === "enabled" && o.liveAccessEnabledBy === null,
  );
}

Object.assign(cfg, saved);
setMailer(null);
await clearPublicRateLimits();
await app.close();
await closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "❌ SANDBOX-SIGNUP: FAIL" : "✅ SANDBOX-SIGNUP: PASS");
process.exit(fail ? 1 : 0);
