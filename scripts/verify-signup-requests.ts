/**
 * verify:signup-requests — while sign-up is locked, the sign-up page takes access requests and
 * staff answer them with a one-time sign-up link (0405).
 *
 * Pins:
 *  - GET /auth/signup reports `requests` only on Cloud with sign-up locked,
 *  - a request is stored, emailed to the team and posted to the chat webhook; a repeat updates
 *    the open request, and a double submit is one request and one lead,
 *  - the request endpoint is 409 while sign-up is open and 403 on self-hosted,
 *  - a sign-up link creates the account for that address while sign-up stays locked, signs in,
 *    and works one time; a taken address does not spend it,
 *  - a dismissed request takes no link; only an open request can be dismissed.
 *
 *   pnpm verify:signup-requests
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { config } from "@/platform/config";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import {
  SignupRequestError,
  dismissSignupRequest,
  inviteSignupRequest,
} from "@/modules/auth/signup-requests";
import { memberships, organizations, signupRequests, users } from "@db/schema";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { pinMfaMandateOff } from "./lib/mfa-policy";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, !cond && detail !== undefined ? JSON.stringify(detail) : "");
}

const cfg = config as unknown as Record<string, string | undefined>;
const saved = { ...cfg };
cfg.TMBILLING_EDITION = "cloud";
cfg.SIGNUP_ENABLED = "FALSE";
cfg.SIGNUP_SANDBOX = "TRUE";
cfg.DASHBOARD_BASE_URL = "https://dash.example.com";
cfg.TURNSTILE_SECRET_KEY = undefined;
cfg.SIGNUP_REQUEST_NOTIFY_TO = "team@example.com";
pinMfaMandateOff();

const mail: OutboundEmail[] = [];
setMailer({
  kind: "console",
  target: null,
  async send(m: OutboundEmail) {
    mail.push(m);
    return { providerMessageId: `fake_${mail.length}`, status: "sent" as const };
  },
});

// A stand-in for the Google Chat incoming webhook.
const chat: { text?: string }[] = [];
const hook = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    chat.push(JSON.parse(body));
    res.end("{}");
  });
});
await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
cfg.LEAD_CHAT_WEBHOOK_URL = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;

const app = await buildApp({ logger: false });
await clearPublicRateLimits();
const j = (r: { body: string }) => JSON.parse(r.body);
const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object });
const stamp = Date.now();
const email = `ada+${stamp}@example.com`;
const request = {
  name: "Ada Example",
  email,
  company: `Request Co ${stamp}`,
  country: "IN",
  billing_volume: "10k_100k",
  gateway: "razorpay",
  message: "Monthly SaaS plans",
};
const openRows = () =>
  systemDb
    .select()
    .from(signupRequests)
    .where(and(eq(signupRequests.email, email), eq(signupRequests.status, "pending")));

// ——— §A the mode ————————————————————————————————————————————————————————
ok(
  "§A locked on Cloud: requests on",
  j(await app.inject({ url: "/auth/signup" })).requests === true,
);
cfg.SIGNUP_ENABLED = "TRUE";
ok("§A open: requests off", j(await app.inject({ url: "/auth/signup" })).requests === false);
ok("§A open: a request is 409", (await post("/auth/signup_requests", request)).statusCode === 409);
cfg.SIGNUP_ENABLED = "FALSE";
cfg.TMBILLING_EDITION = "self_hosted";
ok("§A self-hosted: requests off", j(await app.inject({ url: "/auth/signup" })).requests === false);
ok(
  "§A self-hosted: a request is 403",
  (await post("/auth/signup_requests", request)).statusCode === 403,
);
cfg.TMBILLING_EDITION = "cloud";

// ——— §B a request is stored and the team is told ————————————————————————————
mail.length = 0;
{
  const r = await post("/auth/signup_requests", request);
  ok("§B a request answers 202", r.statusCode === 202, r.body);
  const rows = await openRows();
  ok("§B one open request stored", rows.length === 1 && rows[0]!.company === request.company);
  ok(
    "§B the team gets one email, reply-to the person",
    mail.length === 1 && mail[0]!.to === "team@example.com" && !!mail[0]!.replyTo?.includes(email),
    mail.map((m) => m.to),
  );
  ok(
    "§B the chat webhook gets one post naming the person and company",
    chat.length === 1 &&
      !!chat[0]!.text?.includes(email) &&
      !!chat[0]!.text?.includes(request.company),
    chat,
  );
  // Unset, the lead channel falls back to the back-office alert channel.
  cfg.OPS_ALERT_WEBHOOK_URL = cfg.LEAD_CHAT_WEBHOOK_URL;
  cfg.LEAD_CHAT_WEBHOOK_URL = undefined;
  await post("/auth/signup_requests", { ...request, company: `Renamed ${stamp}` });
  ok(
    "§B with only OPS_ALERT_WEBHOOK_URL set, chat still gets the post",
    chat.length === 2,
    chat.length,
  );
  const again = await openRows();
  ok(
    "§B a repeat updates the open request",
    again.length === 1 && again[0]!.company === `Renamed ${stamp}`,
  );
  const bad = await post("/auth/signup_requests", { ...request, email: "not-an-email" });
  ok("§B a bad email is 400", bad.statusCode === 400);

  // A double submit: one request, one email, one chat post.
  const dup = { ...request, email: `eve+${stamp}@example.com` };
  const sent = { mail: mail.length, chat: chat.length };
  const both = await Promise.all([
    post("/auth/signup_requests", dup),
    post("/auth/signup_requests", dup),
  ]);
  const dupRows = await systemDb
    .select()
    .from(signupRequests)
    .where(eq(signupRequests.email, dup.email));
  ok(
    "§B a double submit answers 202 twice and stores one request",
    both.every((r) => r.statusCode === 202) && dupRows.length === 1,
    { codes: both.map((r) => r.statusCode), rows: dupRows.length },
  );
  ok(
    "§B a double submit tells the team one time",
    mail.length === sent.mail + 1 && chat.length === sent.chat + 1,
    { mail: mail.length - sent.mail, chat: chat.length - sent.chat },
  );
}
const [req] = await openRows();

// ——— §C the sign-up link ——————————————————————————————————————————————————
mail.length = 0;
await inviteSignupRequest(req!.publicId, "staff@example.com");
const token = /\/signup\/invite\/s\/(sgni_[A-Za-z0-9_-]+)/.exec(mail[0]?.text ?? "")?.[1] ?? "";
ok("§C the person gets an email with a sign-up link", mail[0]?.to === email && token.length > 10);
const [invited] = await systemDb
  .select()
  .from(signupRequests)
  .where(eq(signupRequests.id, req!.id));
ok(
  "§C the request is marked invited",
  invited?.status === "invited" && invited.invitedBy === "staff@example.com",
);
{
  const g = await app.inject({ url: `/auth/signup/invite?token=${token}` });
  ok(
    "§C the link reads back its address and answers",
    g.statusCode === 200 && j(g).email === email && j(g).company === `Renamed ${stamp}`,
    g.body,
  );
  const body = {
    token,
    password: "Long-Passphrase-71!",
    name: "Ada Example",
    organization_name: `Invited Co ${stamp}`,
    country: "IN",
    billing_volume: "10k_100k",
    gateway: "razorpay",
  };
  const r = await post("/auth/signup/invite", body);
  ok("§C the link creates the account while sign-up is locked", r.statusCode === 201, r.body);
  ok("§C and signs in", typeof j(r).token === "string");
  const [u] = await systemDb.select().from(users).where(eq(users.email, email));
  const [o] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.name, body.organization_name));
  const [m] = u
    ? await systemDb.select().from(memberships).where(eq(memberships.userId, u.id))
    : [];
  ok(
    "§C the user owns the new organization",
    !!o && m?.organizationId === o.id && m?.role === "owner",
  );
  const again = await post("/auth/signup/invite", body);
  ok("§C the link works one time", again.statusCode === 400, again.body);
  ok(
    "§C a spent link reads as not valid",
    (await app.inject({ url: `/auth/signup/invite?token=${token}` })).statusCode === 404,
  );
}

// ——— §D a taken address does not spend its link —————————————————————————————
mail.length = 0;
await post("/auth/signup_requests", { ...request, company: "Second" });
const [second] = await openRows();
await inviteSignupRequest(second!.publicId, "staff@example.com");
const token2 = /(sgni_[A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
{
  const r = await post("/auth/signup/invite", {
    token: token2,
    password: "Long-Passphrase-71!",
    name: "Ada",
    organization_name: "Dup",
    country: "IN",
    billing_volume: "none",
    gateway: "none",
  });
  ok(
    "§D an address with an account is refused",
    r.statusCode === 400 && /already/.test(j(r).error.message),
  );
  ok(
    "§D and the link is not spent",
    (await app.inject({ url: `/auth/signup/invite?token=${token2}` })).statusCode === 200,
  );
}

// ——— §E dismiss ——————————————————————————————————————————————————————————
const other = `bob+${stamp}@example.com`;
await post("/auth/signup_requests", { ...request, email: other });
const [bob] = await systemDb.select().from(signupRequests).where(eq(signupRequests.email, other));
const d = await dismissSignupRequest(bob!.publicId, "staff@example.com");
ok("§E an open request can be dismissed", d.status === "dismissed");
const twice = await dismissSignupRequest(bob!.publicId, "staff@example.com").catch((e) => e);
ok("§E a dismissed request cannot be dismissed again", twice instanceof SignupRequestError);
const inv = await inviteSignupRequest(bob!.publicId, "staff@example.com").catch((e) => e);
ok("§E a dismissed request takes no link", inv instanceof SignupRequestError);

await app.close();
hook.close();
Object.assign(cfg, saved);
await closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
