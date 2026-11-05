/**
 * Operator identity (0194): multi-organization membership, password reset, and the
 * Google sign-in contract.
 *
 * Driven over REAL HTTP through the built app wherever the subject is a response, for
 * the same reason `verify-security.ts` is: a status code and a `Set-Cookie` are what
 * clients actually see, and a unit test on the service would pass with a route unwired.
 *
 * Covered:
 *  - § A a user in two orgs lands somewhere DETERMINISTIC, and `last_organization_id`
 *        is remembered rather than re-guessed
 *  - § A0 an invite to an existing account (0498) is pending: not switchable, never a sign-in
 *        landing, and the inviting org sees only what it typed until the person accepts or declines
 *  - § B switching validates membership — the whole of SR-2026-008 Issue #4 — and
 *        rotates the session token, so the pre-switch value stops working
 *  - § C forgot-password is a uniform 200 for known, unknown and malformed addresses,
 *        which is what stops it being the enumeration oracle SR-2026-010 describes
 *  - § D a reset token is single-use, time-bounded, and revokes EVERY session
 *  - § E Google sign-in is invite-only and refuses an unverified address; the id-token
 *        claim checks reject a token minted for another application
 *  - § H second factor (0326): Google is a first factor only, a code works once (even in
 *        parallel), recovery codes are salted and spendable once in either format, and
 *        turning 2FA off signs out the other sessions
 *  - § I profile + sessions (0327): the name is validated, a non-image photo is refused, the
 *        session list is the caller's own, no one can delete another person's session, and
 *        "sign out other browsers" spares the caller
 *  - § J security trail (0328): every change is recorded and announced (never with a code or
 *        token in either), a mail outage fails nothing, the "someone may have your password"
 *        alert fires once a day at most, and a support 2FA reset is refused when it should be,
 *        cancellable from its link, and completed only when due and not cancelled
 *  - § K organization 2FA + trusted browsers (0329): turning the requirement on needs your own
 *        2FA and a repeat changes nothing; in grace you work, past the deadline `/v1/*` and the
 *        team routes refuse you while the allowlist answers; a late joiner gets their own
 *        deadline; new API keys are refused, old ones work; one reminder per deadline; a
 *        trusted browser skips the code (never as 2FA), expires, is per-person, and is forgotten
 *        on password change, 2FA off and "sign out other browsers"
 *  - § L passkeys (0330): the first passkey turns 2FA on with recovery codes; registration and
 *        assertions cannot be replayed; user verification is required; a passkey finishes the
 *        second step or signs in alone (as 2FA); another origin, RP ID or person's passkey is
 *        refused; a counter regression is refused and recorded, a synced 0/0 passkey is not;
 *        the last method needs confirmation, honours an organization's rule, and turns 2FA off
 *  - § M step-up on 2FA management (2026-11-04, audit P2-PASSKEY): enrol, disable, recovery
 *        codes, passkey add/remove and app removal refuse a stale session with
 *        `step_up_required` and work after `/auth/step_up`; a sign-in counts as a step-up (a
 *        trusted-browser skip and an org switch do not refresh it); a member blocked by the
 *        organization's 2FA deadline can still enrol; unrelated routes are not gated
 *  - § F team management (2026-08-30): who may list/change/remove, no self-edit, no cross-org
 *        reach, a role change biting on the target's EXISTING session, an audit trail
 *        attributed to the person, and owner senior to admin
 *
 *   pnpm verify:auth-identity
 */
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import {
  users,
  memberships,
  sessions,
  organizations,
  authTokens,
  auditLogs,
  userMfa,
  securityEvents,
  mfaResetRequests,
  userPasskeys,
} from "@db/schema";
import {
  signup,
  inviteUser,
  login,
  loginWithGoogle,
  listMemberships,
  switchOrganization,
  resetPasswordWithToken,
  changeMemberRole,
  removeMember,
  acceptInvite,
  acceptMembershipInvite,
  AuthError,
  MfaRequiredError,
  startMfaEnrollment,
  confirmMfaEnrollment,
  verifyMfaForLogin,
  regenerateRecoveryCodes,
  acknowledgeRecoveryCodes,
  mfaStatus,
  resolveSession,
  completeMfaLogin,
  hasConfirmedMfa,
  updateProfile,
} from "@/modules/auth/service";
import { safePicture } from "@/api/google-oauth";
import { flushSecurityMail, recordSecurityEvent } from "@/modules/auth/security-events";
import { requestMfaReset, sweepMfaResets, MfaResetRefusedError } from "@/modules/auth/mfa-reset";
import {
  sendOrgMfaDeadlineReminders,
  twoFactorStanding,
  setOrganizationRequireMfa,
  standingInOrganization,
} from "@/modules/auth/org-two-factor";
import { passkeyRp } from "@/modules/auth/passkeys";
import { trustedBrowsers, orgMfaReminders } from "@db/schema";
import { changePassword, disableMfa, revokeOtherSessions } from "@/modules/auth/service";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { totp } from "@/modules/auth/totp";
import { createHash, randomBytes, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { config } from "@/platform/config";
import { setObjectStoreDriverForTests } from "@/platform/object-store";
import { pinMfaMandateOff } from "./lib/mfa-policy";

// Not a test of the MFA mandate — see scripts/lib/mfa-policy.ts. Must precede any fixture.
pinMfaMandateOff();

const app = await buildApp({ logger: false });
const checks: Array<[string, boolean, string?]> = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);

const uniq = randomBytes(4).toString("hex");
// Was 'correct horse battery staple' — a genuinely strong passphrase, and §3.1's
// composition rules refuse it for want of a capital and a digit. That is NIST SP 800-63B's
// objection to mandated classes, made concrete in our own fixtures: the rule rejects the
// good password and accepts Password1!, which the blocklist then has to catch. Both halves
// are enforced by decision (2026-08-28); this is what the class half costs.
const PASSWORD = "Correct-Horse-Battery-9";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** This suite exhausts credential limits; leave the shared buckets as we found them. */
const clearCounters = () =>
  systemDb.execute(sql`
    delete from public_rate_limit_counters
    where bucket like 'login:%' or bucket like 'signup:%'
       or bucket like 'forgot_password:%' or bucket like 'reset_password:%'
  `);
await clearCounters();

// ── § A · a user in two organizations ────────────────────────────────────────────
const email = `multi-${uniq}@example.com`;
const first = await signup({ email, password: PASSWORD, organizationName: `Alpha ${uniq}` });
const second = await signup({
  email: `owner2-${uniq}@example.com`,
  password: PASSWORD,
  organizationName: `Beta ${uniq}`,
});
// The account has a name and a sign-in history that Beta must not see before consent.
const realName = `Real Person ${uniq}`;
await systemDb
  .update(users)
  .set({ name: realName, lastLoginAt: new Date("2026-01-02T03:04:05Z") })
  .where(eq(users.email, email));
const inviteMail: OutboundEmail[] = [];
setMailer({
  kind: "console" as const,
  target: null,
  async send(m: OutboundEmail) {
    inviteMail.push(m);
    return { providerMessageId: `fake_${inviteMail.length}`, status: "sent" as const };
  },
});
// The same person invited into a second org — the path that makes a user multi-org.
const invitedInBeta = await inviteUser({
  organizationId: second.user.organizationId,
  email,
  role: "ops",
  name: "Typed By Inviter",
  dashboardBaseUrl: "https://dashboard.example.com",
});

const [multiUser] = await systemDb.select().from(users).where(eq(users.email, email)).limit(1);

// ── § A0 · an invite to an EXISTING account is pending until that person accepts (0498) ──
{
  const betaCookie = { cookie: `tmb_session=${second.token}` };
  const ownCookie = { cookie: `tmb_session=${first.token}` };
  ok(
    "§A0 the invite response does not carry the account's own id",
    invitedInBeta.userPublicId !== multiUser!.publicId &&
      invitedInBeta.userPublicId.startsWith("usr_"),
  );
  const mail = inviteMail.find((m) => m.to === email);
  ok(
    "§A0 the account gets an accept link that is not a password link",
    !!mail && String(mail.text).includes("/invitations") && !String(mail.text).includes("invt_"),
    mail?.subject,
  );
  ok(
    "§A0 a pending invite is not in the switcher",
    (await listMemberships(multiUser!.id, first.user.organizationId)).length === 1,
  );
  let switchRefused = false;
  try {
    await switchOrganization(first.token, second.user.organizationPublicId);
  } catch (e) {
    switchRefused = e instanceof AuthError;
  }
  ok("§A0 switching into the pending org is refused", switchRefused);
  const pendingLogin = await login(email, PASSWORD);
  ok(
    "§A0 sign-in never lands in the pending org",
    pendingLogin.user.organizationId === first.user.organizationId,
  );
  await systemDb
    .update(users)
    .set({ lastOrganizationId: second.user.organizationId })
    .where(eq(users.id, multiUser!.id));
  ok(
    "§A0 …even when it is the remembered org",
    (await login(email, PASSWORD)).user.organizationId === first.user.organizationId,
  );

  const team = await app.inject({ method: "GET", url: "/auth/members", headers: betaCookie });
  const row = (JSON.parse(team.body).data as Array<Record<string, unknown>>).find(
    (r) => r.email === email,
  );
  ok("§A0 the inviting org lists the invite as invited", row?.status === "invited");
  ok(
    "§A0 …with only what the inviter typed: no real name, avatar or sign-in",
    row?.name === "Typed By Inviter" &&
      row?.avatar_url === null &&
      row?.last_login_at === null &&
      row?.mfa_enabled === false,
    JSON.stringify(row),
  );
  ok(
    "§A0 …under the invite id, never the account's id",
    row?.id === invitedInBeta.userPublicId && !String(team.body).includes(multiUser!.publicId),
  );
  ok(
    "§A0 the account's own id does not address the pending row",
    (
      await app.inject({
        method: "POST",
        url: `/auth/members/${multiUser!.publicId}/resend_invite`,
        headers: betaCookie,
      })
    ).statusCode === 400,
  );
  const resent = await app.inject({
    method: "POST",
    url: `/auth/members/${invitedInBeta.userPublicId}/resend_invite`,
    headers: betaCookie,
  });
  ok("§A0 a pending invite can be resent", resent.statusCode === 200);
  ok(
    "§A0 no invite link is minted for an existing account",
    (
      await systemDb
        .select()
        .from(authTokens)
        .where(and(eq(authTokens.userId, multiUser!.id), eq(authTokens.purpose, "invite")))
    ).length === 0,
  );

  // The invitee sees it, and only their own session can accept it.
  const listed = await app.inject({ method: "GET", url: "/auth/invitations", headers: ownCookie });
  const invites = JSON.parse(listed.body).data as Array<{ organization: { id: string } }>;
  ok(
    "§A0 the invitee lists the pending invite",
    invites.length === 1 && invites[0]!.organization.id === second.user.organizationPublicId,
  );
  ok(
    "§A0 another person cannot accept it",
    (
      await app.inject({
        method: "POST",
        url: `/auth/invitations/${second.user.organizationPublicId}/accept`,
        headers: betaCookie,
        payload: {},
      })
    ).statusCode === 404,
  );
  ok(
    "§A0 an anonymous caller cannot accept it",
    (
      await app.inject({
        method: "POST",
        url: `/auth/invitations/${second.user.organizationPublicId}/accept`,
        payload: {},
      })
    ).statusCode === 401,
  );
  const accepted = await app.inject({
    method: "POST",
    url: `/auth/invitations/${second.user.organizationPublicId}/accept`,
    headers: ownCookie,
    payload: {},
  });
  ok("§A0 the invitee accepts with their own session", accepted.statusCode === 200);
  const after = (
    JSON.parse(
      (await app.inject({ method: "GET", url: "/auth/members", headers: betaCookie })).body,
    ).data as Array<Record<string, unknown>>
  ).find((r) => r.email === email);
  ok(
    "§A0 once accepted, the org sees the account as it is",
    after?.status === "active" && after?.name === realName && after?.id === multiUser!.publicId,
  );
  await systemDb.update(users).set({ lastOrganizationId: null }).where(eq(users.id, multiUser!.id));
}

// Declining removes the pending row and leaves the account alone.
{
  const declOrg = await signup({
    email: `decliner-org-${uniq}@example.com`,
    password: PASSWORD,
    organizationName: `Decline ${uniq}`,
  });
  await inviteUser({ organizationId: declOrg.user.organizationId, email, role: "manager" });
  const declined = await app.inject({
    method: "POST",
    url: `/auth/invitations/${declOrg.user.organizationPublicId}/decline`,
    headers: { cookie: `tmb_session=${first.token}` },
    payload: {},
  });
  ok("§A0 the invitee can decline", declined.statusCode === 200);
  const rows = await systemDb
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, multiUser!.id),
        eq(memberships.organizationId, declOrg.user.organizationId),
      ),
    );
  ok("§A0 …which removes the pending row", rows.length === 0);
}

// Cancelling a pending invite removes the row, never the account.
{
  const cancelOrg = await signup({
    email: `canceller-org-${uniq}@example.com`,
    password: PASSWORD,
    organizationName: `Cancel ${uniq}`,
  });
  const inv = await inviteUser({
    organizationId: cancelOrg.user.organizationId,
    email,
    role: "developer",
  });
  const cancelled = await app.inject({
    method: "DELETE",
    url: `/auth/members/${inv.userPublicId}`,
    headers: { cookie: `tmb_session=${cancelOrg.token}`, "content-type": "application/json" },
    payload: {},
  });
  ok("§A0 the inviting org can cancel a pending invite", cancelled.statusCode === 200);
  const [still] = await systemDb.select().from(users).where(eq(users.email, email)).limit(1);
  ok("§A0 …and the existing account survives", still?.id === multiUser!.id);
}
const orgs = await listMemberships(multiUser!.id, first.user.organizationId);
ok("§A the user holds two memberships", orgs.length === 2);
ok("§A exactly one is flagged current", orgs.filter((o) => o.current).length === 1);
ok(
  "§A roles are per-organization, not global",
  orgs.some((o) => o.role === "owner") && orgs.some((o) => o.role === "ops"),
);

// Deterministic landing. Before 0194 this was `LIMIT 1` with no ORDER BY, so two logins
// by the same person could open different organizations.
const l1 = await login(email, PASSWORD);
const l2 = await login(email, PASSWORD);
ok(
  "§A two logins open the SAME organization",
  l1.user.organizationPublicId === l2.user.organizationPublicId,
);
const [afterLogin] = await systemDb
  .select()
  .from(users)
  .where(eq(users.id, multiUser!.id))
  .limit(1);
ok(
  "§A last_organization_id is recorded",
  afterLogin?.lastOrganizationId === l1.user.organizationId,
);

// ── § B · switching, and the membership check ────────────────────────────────────
{
  const target = orgs.find((o) => o.organizationId !== l1.user.organizationId)!;
  const switched = await switchOrganization(l1.token, target.organizationPublicId);
  ok(
    "§B the session moves to the requested org",
    switched.user.organizationPublicId === target.organizationPublicId,
  );
  ok("§B the role follows the ORG, not the user", switched.user.role === target.role);

  // Rotation. Changing which tenant a credential acts in is a privilege change, so the
  // old bearer value must stop working — otherwise anyone holding a copy follows the
  // user into the new organization.
  const stale = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { cookie: `tmb_session=${l1.token}` },
  });
  ok("§B the PRE-switch token is dead", stale.statusCode === 401);
  const fresh = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { cookie: `tmb_session=${switched.token}` },
  });
  ok("§B the post-switch token works", fresh.statusCode === 200);

  // THE FINDING. A team switch must not accept any team id and move the caller into
  // it. An org the user does not belong to must
  // not be reachable, even though it exists and its public id is perfectly guessable.
  const outsider = await signup({
    email: `outsider-${uniq}@example.com`,
    password: PASSWORD,
    organizationName: `Gamma ${uniq}`,
  });
  let refused = false;
  try {
    await switchOrganization(switched.token, outsider.user.organizationPublicId);
  } catch (e) {
    refused = e instanceof AuthError;
  }
  ok("§B switching into a NON-MEMBER organization is refused", refused);
  // …and the refusal did not disturb the session it was attempted from.
  const intact = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { cookie: `tmb_session=${switched.token}` },
  });
  ok("§B a refused switch leaves the session where it was", intact.statusCode === 200);

  // Over HTTP too — the route, not just the service.
  const httpRefusal = await app.inject({
    method: "POST",
    url: "/auth/switch_organization",
    headers: { cookie: `tmb_session=${switched.token}` },
    payload: { organization: outsider.user.organizationPublicId },
  });
  ok("§B the route answers 403, not 200", httpRefusal.statusCode === 403);
  ok(
    "§B the refusal names no organization",
    !String(httpRefusal.body).includes(outsider.user.organizationPublicId),
  );
}

// ── § C · forgot-password reveals nothing ────────────────────────────────────────
{
  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/auth/forgot_password", payload });
  const known = await post({ email });
  const unknown = await post({ email: `nobody-${uniq}@example.com` });
  const malformed = await post({ email: "not-an-address" });
  ok("§C a KNOWN address answers 200", known.statusCode === 200);
  ok("§C an UNKNOWN address answers the same 200", unknown.statusCode === known.statusCode);
  // Even a malformed body. A 400 would say "that is not an address we would ever hold",
  // which is a weaker oracle than the real one but an oracle nonetheless.
  ok("§C a MALFORMED address answers the same 200", malformed.statusCode === known.statusCode);
  ok(
    "§C all three bodies are byte-identical",
    known.body === unknown.body && known.body === malformed.body,
  );
}

// ── § D · the reset token ────────────────────────────────────────────────────────
{
  const [u] = await systemDb.select().from(users).where(eq(users.email, email)).limit(1);
  // Two live sessions, so the revocation below has something to prove.
  const sessionA = await login(email, PASSWORD);
  const sessionB = await login(email, PASSWORD);
  ok(
    "§D two sessions are live before the reset",
    (
      await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { cookie: `tmb_session=${sessionA.token}` },
      })
    ).statusCode === 200 &&
      (
        await app.inject({
          method: "GET",
          url: "/auth/me",
          headers: { cookie: `tmb_session=${sessionB.token}` },
        })
      ).statusCode === 200,
  );

  // Minted directly: the emailed link is the delivery mechanism, not the subject here.
  const token = `prst_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId: u!.id,
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + config.PASSWORD_RESET_TTL_MINUTES * 60_000),
  });

  const NEW = "A-Completely-Different-7";
  const done = await app.inject({
    method: "POST",
    url: "/auth/reset_password",
    payload: { token, new_password: NEW },
  });
  ok("§D the reset succeeds", done.statusCode === 200);

  // SINGLE-USE — enforced in the consuming UPDATE's own WHERE clause, so a replay finds
  // no row rather than racing a read-then-write.
  const replay = await app.inject({
    method: "POST",
    url: "/auth/reset_password",
    payload: { token, new_password: NEW },
  });
  ok("§D the token cannot be spent twice", replay.statusCode === 400);

  ok("§D the new password works", Boolean(await login(email, NEW).catch(() => null)));
  ok("§D the OLD password does not", (await login(email, PASSWORD).catch(() => null)) === null);

  // A reset is what someone does when they believe another party is in their account.
  // Every session goes, including any the attacker holds.
  ok(
    "§D EVERY pre-reset session is revoked",
    (
      await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { cookie: `tmb_session=${sessionA.token}` },
      })
    ).statusCode === 401 &&
      (
        await app.inject({
          method: "GET",
          url: "/auth/me",
          headers: { cookie: `tmb_session=${sessionB.token}` },
        })
      ).statusCode === 401,
  );

  // An expired token is refused, with the same message a spent one gets.
  const stale = `prst_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId: u!.id,
    tokenHash: hash(stale),
    expiresAt: new Date(Date.now() - 1000),
  });
  const expired = await app.inject({
    method: "POST",
    url: "/auth/reset_password",
    payload: { token: stale, new_password: NEW },
  });
  ok("§D an expired token is refused", expired.statusCode === 400);
  ok("§D expired and spent are indistinguishable", expired.body === replay.body);
}

// ── § E · Google sign-in is invite-only ──────────────────────────────────────────
{
  // An address Google would happily authenticate, with no membership here. Invite-only
  // means this is a refusal, not a signup.
  let refusedUnknown = false;
  try {
    await loginWithGoogle({
      googleSub: `sub-unknown-${uniq}`,
      email: `stranger-${uniq}@example.com`,
      emailVerified: true,
    });
  } catch (e) {
    refusedUnknown = e instanceof AuthError;
  }
  ok("§E an unknown address is REFUSED, not provisioned", refusedUnknown);
  const [created] = await systemDb
    .select()
    .from(users)
    .where(eq(users.email, `stranger-${uniq}@example.com`))
    .limit(1);
  ok("§E …and no user was created as a side effect", !created);

  // Unverified address cannot claim an existing account: an unverified email on a
  // Google account is a self-asserted string, and honouring it would let whoever sets
  // one take over the operator who really owns that address.
  let refusedUnverified = false;
  try {
    await loginWithGoogle({ googleSub: `sub-unverified-${uniq}`, email, emailVerified: false });
  } catch (e) {
    refusedUnverified = e instanceof AuthError;
  }
  ok("§E an UNVERIFIED Google address cannot claim an account", refusedUnverified);

  // The happy path: an invited operator, verified, links on first sign-in.
  const sub = `sub-good-${uniq}`;
  const signedIn = await loginWithGoogle({
    googleSub: sub,
    email,
    emailVerified: true,
    name: "Multi User",
  });
  ok("§E an invited operator signs in", Boolean(signedIn.token));
  const [linked] = await systemDb.select().from(users).where(eq(users.email, email)).limit(1);
  ok("§E the google_sub is linked", linked?.googleSub === sub);
  ok("§E the address is marked verified", Boolean(linked?.emailVerifiedAt));

  // The Google photo (0331): stored on sign-in, shown only without an upload, never stale.
  const pic = `https://lh3.googleusercontent.com/a/photo-${uniq}=s96-c`;
  const me = async (token: string) =>
    JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: "/auth/me",
          headers: { cookie: `tmb_session=${token}` },
        })
      ).body,
    ) as { avatar_url?: string | null; avatar_source?: string | null };
  const withPic = await loginWithGoogle({
    googleSub: sub,
    email,
    emailVerified: true,
    picture: pic,
  });
  const [picRow] = await systemDb.select().from(users).where(eq(users.email, email)).limit(1);
  ok("§E a Google sign-in with a picture stores it", picRow?.googlePictureUrl === pic);
  const m1 = await me(withPic.token);
  ok(
    "§E /auth/me shows the Google photo with source google",
    m1.avatar_url === pic && m1.avatar_source === "google",
    JSON.stringify(m1),
  );
  const uploadedUrl = `https://assets.example.com/user_assets/${uniq}.png`;
  await updateProfile(picRow!.id, { avatarUrl: uploadedUrl });
  const m2 = await me(withPic.token);
  ok(
    "§E an uploaded photo wins over the Google one",
    m2.avatar_url === uploadedUrl && m2.avatar_source === "upload",
    JSON.stringify(m2),
  );
  const del = await app.inject({
    method: "DELETE",
    url: "/auth/me/avatar",
    headers: { cookie: `tmb_session=${withPic.token}`, "content-type": "application/json" },
    payload: "{}",
  });
  const afterDel = JSON.parse(del.body) as { avatar_url?: string; avatar_source?: string };
  ok(
    "§E removing the upload falls back to the Google photo",
    del.statusCode === 200 && afterDel.avatar_url === pic && afterDel.avatar_source === "google",
    `${del.statusCode} ${del.body.slice(0, 200)}`,
  );
  const noPic = await loginWithGoogle({ googleSub: sub, email, emailVerified: true });
  const [clearedRow] = await systemDb.select().from(users).where(eq(users.email, email)).limit(1);
  const m3 = await me(noPic.token);
  ok(
    "§E a later Google sign-in without a picture clears it",
    clearedRow?.googlePictureUrl === null && m3.avatar_url === null && m3.avatar_source === null,
    JSON.stringify(m3),
  );
  ok(
    "§E a non-https picture is ignored",
    safePicture("http://lh3.googleusercontent.com/a/x") === null &&
      safePicture("javascript:alert(1)") === null &&
      safePicture(42) === null &&
      safePicture(pic) === pic,
  );

  // Identity is the SUB, not the address. A different Google account claiming the same
  // address is refused rather than silently re-bound — that is what a takeover looks like.
  let refusedRebind = false;
  try {
    await loginWithGoogle({ googleSub: `sub-attacker-${uniq}`, email, emailVerified: true });
  } catch (e) {
    refusedRebind = e instanceof AuthError;
  }
  ok("§E a DIFFERENT Google account cannot claim a linked address", refusedRebind);

  // The availability probe is a deployment fact and nothing more.
  const probe = await app.inject({ method: "GET", url: "/auth/google" });
  ok("§E the availability probe answers", probe.statusCode === 200);
  ok("§E …and reports the configured state", typeof JSON.parse(probe.body).enabled === "boolean");
  // Unconfigured deployments must refuse the exchange rather than half-working.
  if (!JSON.parse(probe.body).enabled) {
    const ex = await app.inject({
      method: "POST",
      url: "/auth/google/exchange",
      payload: { code: "x" },
    });
    ok("§E unconfigured ⇒ the exchange 404s", ex.statusCode === 404);
  }
}

// ── § F · team management (2026-08-30) ─────────────────────────────────────────────────
//
// The Team screen could invite and nothing else. These are the three writes that make it
// an access-control surface, driven over HTTP because the guards are what is being tested
// and a service-level test would pass with a route left unwired.
{
  const owner = await signup({
    email: `team-owner-${uniq}@example.com`,
    password: PASSWORD,
    organizationName: `Delta ${uniq}`,
  });
  const orgId = owner.user.organizationId;
  const ownerCookie = { cookie: `tmb_session=${owner.token}` };

  // Two shapes of member: one who has never accepted (no credential at all) and one who
  // already works elsewhere, so is signable-in from the moment they are added.
  const pendingEmail = `team-pending-${uniq}@example.com`;
  const pending = await inviteUser({ organizationId: orgId, email: pendingEmail, role: "manager" });
  const elsewhere = await signup({
    email: `team-active-${uniq}@example.com`,
    password: PASSWORD,
    organizationName: `Epsilon ${uniq}`,
  });
  await inviteUser({ organizationId: orgId, email: elsewhere.user.email, role: "ops" });
  // An existing account joins only once it accepts (0498).
  await acceptMembershipInvite({
    userId: elsewhere.user.userId,
    userPublicId: elsewhere.user.userPublicId,
    email: elsewhere.user.email,
    organizationPublicId: owner.user.organizationPublicId,
  });
  /**
   * …and their session is SWITCHED INTO Delta. Logging in is not enough: `login` opens
   * their remembered org (Epsilon, where they are owner), so a session straight from it
   * would pass the admin checks below on the strength of a role held somewhere else —
   * which is a test asserting the opposite of what it means to.
   */
  const activeLogin = await switchOrganization(
    (await login(elsewhere.user.email, PASSWORD)).token,
    owner.user.organizationPublicId,
  );
  ok("§F the fixture session is scoped to THIS org as ops", activeLogin.user.role === "ops");
  const activeCookie = { cookie: `tmb_session=${activeLogin.token}` };

  const list = async (headers: Record<string, string>) =>
    app.inject({ method: "GET", url: "/auth/members", headers });
  const listed = await list(ownerCookie);
  ok("§F the member list answers 200", listed.statusCode === 200);
  const rows = JSON.parse(listed.body).data as Array<Record<string, unknown>>;
  ok("§F it holds every membership", rows.length === 3);
  ok("§F exactly one row is flagged is_self", rows.filter((r) => r.is_self).length === 1);
  ok("§F …and it is the caller", rows.find((r) => r.is_self)?.email === owner.user.email);

  // The status is derived from the CREDENTIAL, not the membership: someone who already
  // has an account has nothing to accept, they just switch organization.
  ok(
    "§F a member with no credential reads as invited",
    rows.find((r) => r.email === pendingEmail)?.status === "invited",
  );
  ok(
    "§F a member who already had an account reads as active",
    rows.find((r) => r.email === elsewhere.user.email)?.status === "active",
  );
  ok(
    "§F the uuid never appears on the wire",
    rows.every((r) => typeof r.id === "string" && (r.id as string).startsWith("usr_")),
  );

  // A non-admin sees none of it, and can do none of it. The ops member holds a valid
  // session in this org — the refusal is about the ROLE, which is the whole point.
  ok("§F a non-admin cannot list the team", (await list(activeCookie)).statusCode === 403);
  ok(
    "§F …nor change a role",
    (
      await app.inject({
        method: "PATCH",
        url: `/auth/members/${pending.userPublicId}`,
        headers: activeCookie,
        payload: { role: "ops" },
      })
    ).statusCode === 403,
  );
  ok(
    "§F …nor remove anyone",
    (
      await app.inject({
        method: "DELETE",
        url: `/auth/members/${pending.userPublicId}`,
        headers: activeCookie,
      })
    ).statusCode === 403,
  );
  ok(
    "§F …nor resend an invite",
    (
      await app.inject({
        method: "POST",
        url: `/auth/members/${pending.userPublicId}/resend_invite`,
        headers: activeCookie,
      })
    ).statusCode === 403,
  );
  ok("§F an unauthenticated caller gets 401", (await list({})).statusCode === 401);

  // A role change lands, and lands IMMEDIATELY on the target's existing session —
  // `resolveSession` re-reads the membership on every request, so there is no cached role
  // to invalidate. If that is ever "optimised" into the session row this check fails.
  const patched = await app.inject({
    method: "PATCH",
    url: `/auth/members/${elsewhere.user.userPublicId}`,
    headers: ownerCookie,
    payload: { role: "developer" },
  });
  ok("§F a role change answers 200", patched.statusCode === 200);
  ok("§F …and reports the new role", JSON.parse(patched.body).role === "developer");
  const meAfter = await app.inject({ method: "GET", url: "/auth/me", headers: activeCookie });
  ok(
    "§F the target session sees the new role on its NEXT request",
    JSON.parse(meAfter.body).role === "developer",
  );
  ok(
    "§F an unknown role is refused at the edge",
    (
      await app.inject({
        method: "PATCH",
        url: `/auth/members/${elsewhere.user.userPublicId}`,
        headers: ownerCookie,
        payload: { role: "superuser" },
      })
    ).statusCode === 400,
  );

  // Your own role is not yours to change. This is the rule that keeps an organization
  // administrable — a sole owner demoting themselves would lock it outright.
  const self = await app.inject({
    method: "PATCH",
    url: `/auth/members/${owner.user.userPublicId}`,
    headers: ownerCookie,
    payload: { role: "ops" },
  });
  ok("§F you cannot change your OWN role", self.statusCode === 400);
  ok("§F …and the refusal says why", /your own role/i.test(String(self.body)));
  ok(
    "§F you cannot remove YOURSELF",
    (
      await app.inject({
        method: "DELETE",
        url: `/auth/members/${owner.user.userPublicId}`,
        headers: ownerCookie,
      })
    ).statusCode === 400,
  );

  // Cross-org. An admin of Delta must not reach a member of Epsilon, whose public id is
  // perfectly guessable — the same class of hole as SR-2026-008 Issue #4 in §B.
  const outsiderOrg = await signup({
    email: `team-outsider-${uniq}@example.com`,
    password: PASSWORD,
    organizationName: `Zeta ${uniq}`,
  });
  const foreign = await app.inject({
    method: "PATCH",
    url: `/auth/members/${outsiderOrg.user.userPublicId}`,
    headers: ownerCookie,
    payload: { role: "ops" },
  });
  ok("§F a member of ANOTHER org is not reachable", foreign.statusCode === 400);
  ok(
    "§F …and the refusal confirms nothing about them",
    !String(foreign.body).includes(outsiderOrg.user.email),
  );
  const [outsiderStill] = await systemDb
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, outsiderOrg.user.userId),
        eq(memberships.organizationId, outsiderOrg.user.organizationId),
      ),
    )
    .limit(1);
  ok("§F …and their role is untouched", outsiderStill?.role === "owner");

  // Resend is for an OUTSTANDING invite only. For someone who already holds a credential
  // there is nothing to accept, and offering it would be a second admin-triggered path to
  // set a password on an existing account.
  const before = await systemDb
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.userId, pending.userId), eq(authTokens.purpose, "invite")));
  const resent = await app.inject({
    method: "POST",
    url: `/auth/members/${pending.userPublicId}/resend_invite`,
    headers: ownerCookie,
  });
  ok("§F an invite can be resent", resent.statusCode === 200);
  const after = await systemDb
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.userId, pending.userId), eq(authTokens.purpose, "invite")));
  ok(
    "§F …which mints a FRESH single-use token",
    after.length === before.length + 1,
    // The counts, because "false" alone does not distinguish "no token was minted" from
    // "the old one was replaced" from "two were minted" — three different defects.
    `${before.length} invite token(s) before, ${after.length} after`,
  );
  ok(
    "§F resending to an accepted member is refused",
    (
      await app.inject({
        method: "POST",
        url: `/auth/members/${elsewhere.user.userPublicId}/resend_invite`,
        headers: ownerCookie,
      })
    ).statusCode === 400,
  );
  /**
   * THE REQUEST THE DASHBOARD ACTUALLY MAKES. Every check above used `app.inject` with no
   * payload, which sends no content-type — a request no browser makes. The dashboard's
   * `fetch` declares `application/json`, and Fastify refuses that with an EMPTY body
   * ("Body cannot be empty when content-type is set to 'application/json'"), so both
   * bodiless writes — Resend invite and Remove — were dead in the browser while this suite
   * was green. The fix is the house convention (`apiWrite` has always sent `{}`); these two
   * checks are what keeps a future "why are we posting an empty object" tidy-up from
   * silently breaking them again.
   */
  ok(
    "§F a bodiless POST as the DASHBOARD sends it (json + `{}`)",
    (
      await app.inject({
        method: "POST",
        url: `/auth/members/${pending.userPublicId}/resend_invite`,
        headers: { ...ownerCookie, "content-type": "application/json" },
        payload: {},
      })
    ).statusCode === 200,
  );
  ok(
    "§F …and an empty body under that header is what Fastify refuses",
    (
      await app.inject({
        method: "POST",
        url: `/auth/members/${pending.userPublicId}/resend_invite`,
        headers: { ...ownerCookie, "content-type": "application/json" },
        payload: "",
      })
    ).statusCode === 400,
  );

  // Removal. The membership goes, and so does the session — belt and braces, since
  // `resolveSession` already returns null without a membership.
  const removed = await app.inject({
    method: "DELETE",
    url: `/auth/members/${elsewhere.user.userPublicId}`,
    headers: ownerCookie,
  });
  ok("§F a removal answers 200", removed.statusCode === 200);
  const gone = await systemDb
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.userId, elsewhere.user.userId), eq(memberships.organizationId, orgId)),
    );
  ok("§F the membership is gone", gone.length === 0);
  ok(
    "§F their session in that org stops working",
    (await app.inject({ method: "GET", url: "/auth/me", headers: activeCookie })).statusCode ===
      401,
  );
  const [stillAUser] = await systemDb
    .select()
    .from(users)
    .where(eq(users.id, elsewhere.user.userId))
    .limit(1);
  ok(
    "§F the USER survives — they belong to another org and own audit history",
    stillAUser !== undefined,
  );
  ok(
    "§F …and their OTHER membership is untouched",
    (await systemDb.select().from(memberships).where(eq(memberships.userId, elsewhere.user.userId)))
      .length === 1,
  );

  // THE INVARIANT, at the service level. Unreachable through the routes (the caller is
  // always a second admin), so it is exercised directly with a non-admin actor — which is
  // what a CLI or a support tool would look like. The point is that the refusal belongs to
  // the service, not to one route's guard list.
  let refusedLastAdmin = false;
  try {
    await changeMemberRole({
      organizationId: orgId,
      actorUserId: pending.userId, // a manager: holds no admin permission
      actorEmail: pendingEmail,
      targetPublicId: owner.user.userPublicId,
      role: "ops",
    });
  } catch (e) {
    refusedLastAdmin = e instanceof AuthError && /at least one owner or admin/i.test(e.message);
  }
  ok("§F the LAST administrator cannot be demoted", refusedLastAdmin);
  let refusedLastAdminRemoval = false;
  try {
    await removeMember({
      organizationId: orgId,
      actorUserId: pending.userId,
      actorEmail: pendingEmail,
      targetPublicId: owner.user.userPublicId,
    });
  } catch (e) {
    refusedLastAdminRemoval =
      e instanceof AuthError && /at least one owner or admin/i.test(e.message);
  }
  ok("§F …nor removed", refusedLastAdminRemoval);

  // Owner is senior to admin (2026-11-04): only an owner grants, changes or removes the role.
  const mintSession = async (role: string, tag: string) => {
    const inv = await inviteUser({
      organizationId: orgId,
      email: `team-${tag}-${uniq}@example.com`,
      role,
    });
    const tok = `invt_${randomBytes(32).toString("base64url")}`;
    await systemDb.insert(authTokens).values({
      userId: inv.userId,
      tokenHash: hash(tok),
      purpose: "invite",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return {
      publicId: inv.userPublicId,
      cookie: `tmb_session=${(await acceptInvite(tok, PASSWORD)).token}`,
    };
  };
  const admin = await mintSession("admin", "admin");
  const owner2 = await mintSession("owner", "owner2");
  const adminCookie = { cookie: admin.cookie, "content-type": "application/json" };
  const ownerOnly = (r: { statusCode: number; body: string }) =>
    r.statusCode === 403 && JSON.parse(r.body).error?.code === "owner_required";
  ok(
    "§F an admin cannot change an owner's role",
    ownerOnly(
      await app.inject({
        method: "PATCH",
        url: `/auth/members/${owner2.publicId}`,
        headers: adminCookie,
        payload: { role: "ops" },
      }),
    ),
  );
  ok(
    "§F an admin cannot remove an owner",
    ownerOnly(
      await app.inject({
        method: "DELETE",
        url: `/auth/members/${owner2.publicId}`,
        headers: adminCookie,
        payload: {},
      }),
    ),
  );
  ok(
    "§F an admin cannot give the owner role",
    ownerOnly(
      await app.inject({
        method: "PATCH",
        url: `/auth/members/${pending.userPublicId}`,
        headers: adminCookie,
        payload: { role: "owner" },
      }),
    ),
  );
  ok(
    "§F …nor invite an owner",
    ownerOnly(
      await app.inject({
        method: "POST",
        url: "/auth/invite",
        headers: adminCookie,
        payload: { email: `team-owner3-${uniq}@example.com`, role: "owner" },
      }),
    ),
  );
  ok(
    "§F an admin still changes a non-owner",
    (
      await app.inject({
        method: "PATCH",
        url: `/auth/members/${pending.userPublicId}`,
        headers: adminCookie,
        payload: { role: "ops" },
      })
    ).statusCode === 200,
  );
  const [owner2Row] = await systemDb
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, orgId), eq(users.publicId, owner2.publicId)))
    .limit(1);
  ok("§F the refused writes left the owner as owner", owner2Row?.role === "owner");
  ok(
    "§F an owner can change another owner's role",
    (
      await app.inject({
        method: "PATCH",
        url: `/auth/members/${owner2.publicId}`,
        headers: ownerCookie,
        payload: { role: "admin" },
      })
    ).statusCode === 200,
  );
  ok(
    "§F an owner can give the owner role",
    (
      await app.inject({
        method: "PATCH",
        url: `/auth/members/${owner2.publicId}`,
        headers: ownerCookie,
        payload: { role: "owner" },
      })
    ).statusCode === 200,
  );
  ok(
    "§F an owner can remove another owner",
    (
      await app.inject({
        method: "DELETE",
        url: `/auth/members/${owner2.publicId}`,
        headers: { ...ownerCookie, "content-type": "application/json" },
        payload: {},
      })
    ).statusCode === 200,
  );

  // Every one of these is an operator-privilege change, so every one leaves a trail
  // attributed to the PERSON — not to 'system', and not to the dashboard's API key.
  const trail = await withTenant(orgId, (tx) =>
    tx.select().from(auditLogs).where(eq(auditLogs.organizationId, orgId)),
  );
  const actions = new Set(trail.map((r) => r.action));
  ok("§F the invite is audited", actions.has("team.invite"));
  ok("§F the role change is audited", actions.has("team.role_change"));
  ok("§F the removal is audited", actions.has("team.remove"));
  ok("§F the resend is audited", actions.has("team.resend_invite"));
  ok("§F the acceptance is audited", actions.has("team.accept_invite"));
  ok(
    '§F the actor is the admin, not "system"',
    trail
      .filter((r) => r.action.startsWith("team.") && r.action !== "team.invite")
      .every((r) =>
        [owner.user.email, `team-admin-${uniq}@example.com`, elsewhere.user.email].includes(
          r.actor,
        ),
      ),
  );
}

// ── § G · the What's-new highwater (0237) ────────────────────────────────────────
//
// The engine stores an OPAQUE integer: the release notes are markdown files in the
// dashboard's repo, so this side can never check the value means anything. What is
// worth gating is the part that is ours — NULL on a fresh account (which the dashboard
// reads as "caught up", and is the only reason a new operator is not met by the whole
// archive), that the write SETS rather than increments, and that it is bounded.
{
  const hw = await signup({
    email: `hw-${uniq}@example.com`,
    password: PASSWORD,
    organizationName: `HW ${uniq}`,
  });
  const cookie = `tmb_session=${hw.token}`;
  const me = async () =>
    (
      JSON.parse(
        (await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).body,
      ) as { release_notes_seen_count: number | null }
    ).release_notes_seen_count;
  const mark = (count: unknown) =>
    app.inject({
      method: "POST",
      url: "/auth/me/release_notes_seen",
      headers: { cookie },
      payload: { count },
    });

  // The whole point of NULL. A DEFAULT of 0 here would announce every historical note to
  // somebody who joined today, which is the failure this column is shaped to avoid.
  ok("§G a fresh account starts NULL, not 0", (await me()) === null);

  ok("§G marking answers 200", (await mark(19)).statusCode === 200);
  ok("§G the highwater is readable on /auth/me", (await me()) === 19);

  // It SETS. That is what lets /whats-new mark on EVERY visit without drifting upward,
  // and what makes a double-click harmless.
  await mark(19);
  ok("§G marking twice is not cumulative", (await me()) === 19);

  // It may go DOWN. A note deleted from the repo shrinks the total, and refusing to
  // follow it would leave a badge that can never clear.
  await mark(3);
  ok("§G the highwater may move backwards", (await me()) === 3);

  ok("§G a negative count is refused", (await mark(-1)).statusCode === 400);
  ok("§G a non-integer count is refused", (await mark(1.5)).statusCode === 400);
  ok("§G a non-numeric count is refused", (await mark("19")).statusCode === 400);
  // Bounded on purpose: an unbounded integer would let a client store a value no future
  // note count can reach, permanently silencing its own badge.
  ok("§G an absurd count is refused", (await mark(10 ** 9)).statusCode === 400);
  ok("§G a refused write leaves the highwater alone", (await me()) === 3);

  const anon = await app.inject({
    method: "POST",
    url: "/auth/me/release_notes_seen",
    payload: { count: 1 },
  });
  ok("§G an anonymous caller is refused", anon.statusCode === 401);
}

// ── § G2 · the product tour is offered once per person (0500) ───────────────────────────────
{
  const pt = await signup({
    email: `tour-${uniq}@example.com`,
    password: PASSWORD,
    organizationName: `Tour ${uniq}`,
  });
  const cookie = `tmb_session=${pt.token}`;
  const seen = async () =>
    (
      JSON.parse(
        (await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).body,
      ) as { product_tour_seen: boolean }
    ).product_tour_seen;
  const mark = () =>
    app.inject({ method: "POST", url: "/auth/me/product_tour_seen", headers: { cookie } });

  ok("§G2 a new person has not seen the tour", (await seen()) === false);
  ok("§G2 marking answers 200", (await mark()).statusCode === 200);
  ok("§G2 the tour reads as seen", (await seen()) === true);
  const [first] = await systemDb
    .select({ at: users.productTourSeenAt })
    .from(users)
    .where(eq(users.id, pt.user.userId));
  await mark();
  const [second] = await systemDb
    .select({ at: users.productTourSeenAt })
    .from(users)
    .where(eq(users.id, pt.user.userId));
  ok("§G2 a replay keeps the first time", first?.at?.getTime() === second?.at?.getTime());
  const anon = await app.inject({ method: "POST", url: "/auth/me/product_tour_seen" });
  ok("§G2 an anonymous caller is refused", anon.statusCode === 401);
}

// ── § H · second factor: every door, one-use codes, recovery codes (0326) ─────────────────────
{
  const hEmail = `mfa-doors-${uniq}@example.com`;
  const h = await signup({ email: hEmail, password: PASSWORD, organizationName: `MFA ${uniq}` });
  const uid = h.user.userId;
  // A code is accepted once per 30-second step. Clearing the recorded step stands in for the
  // clock moving on, so a check can use the current code again.
  const nextStep = () =>
    systemDb.update(userMfa).set({ lastUsedStep: null }).where(eq(userMfa.userId, uid));
  const cookieToken = (h: string | string[] | undefined) =>
    ([] as string[])
      .concat(h ?? [])
      .map((c) => /tmb_session=([^;]+)/.exec(c)?.[1])
      .find(Boolean);
  const mfaRow = async () =>
    (await systemDb.select().from(userMfa).where(eq(userMfa.userId, uid)).limit(1))[0];

  const setup = await startMfaEnrollment({ userId: uid });
  ok("§H starting setup writes nothing to user_mfa", !(await mfaRow()));
  ok("§H …and status shows the setup pending", (await mfaStatus(uid)).setupPending);

  // An expired setup cannot be confirmed — the secret was only ever held for 15 minutes.
  await systemDb
    .update(authTokens)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(and(eq(authTokens.userId, uid), eq(authTokens.purpose, "mfa_setup")));
  let expired = false;
  try {
    await confirmMfaEnrollment({ userId: uid, code: totp(setup.secret) });
  } catch (e) {
    expired = e instanceof AuthError && /expired/i.test(e.message);
  }
  ok("§H an expired setup is refused", expired);

  const fresh = await startMfaEnrollment({ userId: uid });
  const confirmed = await confirmMfaEnrollment({ userId: uid, code: totp(fresh.secret) });
  const codes = confirmed.recoveryCodes ?? [];
  ok("§H confirming returns ten recovery codes", codes.length === 10);
  ok(
    "§H …in the 16-character grouped format",
    codes.every((c) => /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(c)),
    codes[0],
  );
  const row = await mfaRow();
  ok(
    "§H …stored salted (scrypt), never in clear",
    !!row &&
      row.recoveryCodesHashed.every((x) => x.startsWith("rc1$")) &&
      !JSON.stringify(row.recoveryCodesHashed).includes(codes[0]!.replace(/-/g, "")),
  );
  ok("§H new codes start unsaved", !(await mfaStatus(uid)).recoveryCodesSaved);

  // ── the same code twice ──
  ok(
    "§H the code that confirmed setup cannot sign in again",
    !(await verifyMfaForLogin(uid, totp(fresh.secret))).ok,
  );
  await nextStep();
  const code = totp(fresh.secret);
  const raced = await Promise.all([verifyMfaForLogin(uid, code), verifyMfaForLogin(uid, code)]);
  ok(
    "§H the same code sent twice in parallel is accepted once",
    raced.filter((r) => r.ok).length === 1,
    JSON.stringify(raced),
  );

  // ── recovery codes ──
  const first = codes[0]!;
  const used = await verifyMfaForLogin(uid, first.toLowerCase());
  ok(
    "§H a recovery code works, typed in lower case",
    used.ok && used.method === "recovery_code" && used.recoveryCodesLeft === 9,
    JSON.stringify(used),
  );
  ok("§H …and only once", !(await verifyMfaForLogin(uid, first)).ok);
  const twoAtOnce = await Promise.all([
    verifyMfaForLogin(uid, codes[1]!),
    verifyMfaForLogin(uid, codes[2]!),
  ]);
  ok(
    "§H two different codes spent at once both stick",
    twoAtOnce.every((r) => r.ok) && (await mfaStatus(uid)).recoveryCodesLeft === 7,
  );

  // A code minted before 0326 (8 characters, bare SHA-256) must keep working.
  await systemDb
    .update(userMfa)
    .set({
      recoveryCodesHashed: sql`array_append(${userMfa.recoveryCodesHashed}, ${hash("ABCDEFGH")})`,
    })
    .where(eq(userMfa.userId, uid));
  const legacy = await verifyMfaForLogin(uid, "abcd-efgh");
  ok("§H an old-format recovery code still signs in", legacy.ok, JSON.stringify(legacy));
  ok("§H …and only once", !(await verifyMfaForLogin(uid, "ABCD-EFGH")).ok);

  const regenerated = await regenerateRecoveryCodes(uid);
  ok("§H regenerating returns ten new codes", regenerated.length === 10);
  ok("§H …and the old set stops working", !(await verifyMfaForLogin(uid, codes[3]!)).ok);
  ok("§H …while a new one works", (await verifyMfaForLogin(uid, regenerated[0]!)).ok);
  await acknowledgeRecoveryCodes(uid);
  ok("§H acknowledging marks the codes saved", (await mfaStatus(uid)).recoveryCodesSaved);

  // ── Google is a first factor only ──
  const sub = `g-mfa-${uniq}`;
  await systemDb.update(users).set({ googleSub: sub }).where(eq(users.id, uid));
  const sessionsBefore = (await systemDb.select().from(sessions).where(eq(sessions.userId, uid)))
    .length;
  let googleChallenge: MfaRequiredError | null = null;
  try {
    await loginWithGoogle({ googleSub: sub, email: hEmail, emailVerified: true });
  } catch (e) {
    if (e instanceof MfaRequiredError) googleChallenge = e;
  }
  ok(
    "§H Google sign-in with 2FA on gets a challenge, not a session",
    !!googleChallenge && googleChallenge.authMethod === "google",
  );
  ok(
    "§H …and mints no session row",
    (await systemDb.select().from(sessions).where(eq(sessions.userId, uid))).length ===
      sessionsBefore,
  );
  await nextStep();
  const finish = await app.inject({
    method: "POST",
    url: "/auth/login/mfa",
    payload: { challenge: googleChallenge?.challenge ?? "", code: totp(fresh.secret) },
  });
  ok("§H the Google challenge finishes at /auth/login/mfa", finish.statusCode === 200, finish.body);
  const tokenA = cookieToken(finish.headers["set-cookie"]);
  const [rowA] = await systemDb
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hash(tokenA ?? "")))
    .limit(1);
  ok(
    "§H …and the session records google + the second factor",
    rowA?.authMethod === "google" && !!rowA.mfaAt,
    JSON.stringify({ m: rowA?.authMethod, at: rowA?.mfaAt }),
  );

  const passwordChallenge = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: hEmail, password: PASSWORD },
  });
  const pc = JSON.parse(passwordChallenge.body) as {
    object?: string;
    auth_method?: string;
    email?: string;
  };
  ok(
    "§H the password door answers a challenge naming the person and method",
    pc.object === "mfa_challenge" && pc.auth_method === "password" && pc.email === hEmail,
    passwordChallenge.body,
  );

  // ── turning it off signs out the other browsers ──
  await nextStep();
  const b = await login(hEmail, PASSWORD, {}, totp(fresh.secret));
  const off = await app.inject({
    method: "POST",
    url: "/auth/mfa/disable",
    headers: { cookie: `tmb_session=${tokenA}`, "content-type": "application/json" },
    payload: {},
  });
  ok("§H disable answers 200", off.statusCode === 200, off.body);
  ok(
    "§H …signs out the OTHER session",
    !(await resolveSession(b.token)) &&
      (JSON.parse(off.body) as { signed_out_sessions?: number }).signed_out_sessions! >= 1,
  );
  ok("§H …and keeps the caller's", !!(await resolveSession(tokenA ?? "")));
  ok("§H …and the factor is gone", !(await mfaStatus(uid)).confirmed);
}

// ── § I · the person's own profile and sessions (0327) ───────────────────────────
{
  const iEmail = `profile-${uniq}@example.com`;
  const otherEmail = `profile-other-${uniq}@example.com`;
  await signup({ email: iEmail, password: PASSWORD, organizationName: `Profile ${uniq}` });
  await signup({ email: otherEmail, password: PASSWORD, organizationName: `Other ${uniq}` });
  const mine = await login(iEmail, PASSWORD, { userAgent: "verify-a" });
  const mine2 = await login(iEmail, PASSWORD, { userAgent: "verify-b" });
  const mine3 = await login(iEmail, PASSWORD, { userAgent: "verify-c" });
  const theirs = await login(otherEmail, PASSWORD);
  const as = (token: string) => ({
    cookie: `tmb_session=${token}`,
    "content-type": "application/json",
  });

  const renamed = await app.inject({
    method: "PATCH",
    url: "/auth/me",
    headers: as(mine.token),
    payload: { name: "  Ada Lovelace  ", theme: "dark" },
  });
  const me = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { cookie: `tmb_session=${mine.token}` },
  });
  const meBody = JSON.parse(me.body) as { name?: string; theme?: string; avatar_url?: unknown };
  ok(
    "§I PATCH /auth/me saves a trimmed name and the theme",
    renamed.statusCode === 200 && meBody.name === "Ada Lovelace" && meBody.theme === "dark",
    me.body,
  );
  ok("§I /auth/me carries avatar_url", "avatar_url" in meBody);

  const tooLong = await app.inject({
    method: "PATCH",
    url: "/auth/me",
    headers: as(mine.token),
    payload: { name: "x".repeat(256) },
  });
  const control = await app.inject({
    method: "PATCH",
    url: "/auth/me",
    headers: as(mine.token),
    payload: { name: "Ada\u0000" },
  });
  const badTheme = await app.inject({
    method: "PATCH",
    url: "/auth/me",
    headers: as(mine.token),
    payload: { theme: "neon" },
  });
  const unknownKey = await app.inject({
    method: "PATCH",
    url: "/auth/me",
    headers: as(mine.token),
    payload: { email: "x@example.com" },
  });
  ok(
    "§I the name is validated: length, control characters, theme, unknown keys",
    [tooLong, control, badTheme, unknownKey].every((r) => r.statusCode === 400),
    [tooLong, control, badTheme, unknownKey].map((r) => r.statusCode).join(","),
  );
  const cleared = await app.inject({
    method: "PATCH",
    url: "/auth/me",
    headers: as(mine.token),
    payload: { name: "" },
  });
  ok(
    "§I an empty name clears it",
    (JSON.parse(cleared.body) as { name?: unknown }).name === null,
    cleared.body,
  );

  // Rejected on its leading bytes before any storage call, so this runs with or without R2.
  const notImage = await app.inject({
    method: "POST",
    url: "/auth/me/avatar",
    headers: as(mine.token),
    payload: {
      data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64"),
      content_type: "image/png",
    },
  });
  ok(
    "§I a photo that is not an allowed image is refused",
    [400, 503].includes(notImage.statusCode),
    `${notImage.statusCode} ${notImage.body}`,
  );
  const [afterBad] = await systemDb.select().from(users).where(eq(users.email, iEmail)).limit(1);
  ok("§I …and nothing is saved", afterBad?.avatarUrl === null);

  const list = await app.inject({
    method: "GET",
    url: "/auth/sessions",
    headers: { cookie: `tmb_session=${mine.token}` },
  });
  const rows = (
    JSON.parse(list.body) as {
      data: Array<{ id: string; current: boolean; user_agent: string | null }>;
    }
  ).data;
  // Four: signup opens one too.
  ok(
    "§I the session list holds this person's four, this one first",
    rows.length === 4 && rows[0]!.current && rows.filter((r) => r.current).length === 1,
    list.body,
  );
  const [theirRow] = await systemDb
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hash(theirs.token)))
    .limit(1);
  ok("§I …and none of another person's", !rows.some((r) => r.id === theirRow!.id));

  const crossDelete = await app.inject({
    method: "DELETE",
    url: `/auth/sessions/${theirRow!.id}`,
    headers: { cookie: `tmb_session=${mine.token}` },
  });
  ok(
    "§I deleting ANOTHER person's session by id is refused",
    crossDelete.statusCode === 404,
    crossDelete.body,
  );
  ok("§I …and their session survives", !!(await resolveSession(theirs.token)));
  const selfDelete = await app.inject({
    method: "DELETE",
    url: `/auth/sessions/${rows[0]!.id}`,
    headers: { cookie: `tmb_session=${mine.token}` },
  });
  ok(
    "§I this browser cannot be deleted through the list",
    selfDelete.statusCode === 404 && !!(await resolveSession(mine.token)),
  );
  const badId = await app.inject({
    method: "DELETE",
    url: "/auth/sessions/not-a-uuid",
    headers: { cookie: `tmb_session=${mine.token}` },
  });
  ok("§I a malformed id is a 404, not a 500", badId.statusCode === 404, `${badId.statusCode}`);

  const two = rows.find((r) => r.user_agent === "verify-b")!;
  const one = await app.inject({
    method: "DELETE",
    url: `/auth/sessions/${two.id}`,
    headers: { cookie: `tmb_session=${mine.token}` },
  });
  ok(
    "§I signing out one other browser ends exactly that one",
    one.statusCode === 200 &&
      !(await resolveSession(mine2.token)) &&
      !!(await resolveSession(mine3.token)),
  );

  const others = await app.inject({
    method: "POST",
    url: "/auth/sessions/revoke_others",
    headers: as(mine.token),
    payload: {},
  });
  ok(
    "§I revoke_others signs out the rest and spares the caller",
    others.statusCode === 200 &&
      (JSON.parse(others.body) as { signed_out_sessions?: number }).signed_out_sessions === 2 &&
      !(await resolveSession(mine3.token)) &&
      !!(await resolveSession(mine.token)),
    others.body,
  );
  ok("§I …and another person's session is untouched", !!(await resolveSession(theirs.token)));
}

// ── § M · upload limits and deleting a replaced photo ─────────────────────────────
// A fake object store records puts and deletes, so this never touches a real bucket.
{
  const R2 = [
    "R2_ACCOUNT_ID",
    "R2_BUCKET_NAME",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "CDN_URL",
    "R2_KEY_PREFIX",
    "RATE_LIMIT_ENABLED",
  ] as const;
  const cfg = config as unknown as Record<string, unknown>;
  const savedCfg = Object.fromEntries(R2.map((k) => [k, cfg[k]]));
  Object.assign(cfg, {
    R2_ACCOUNT_ID: "acct",
    R2_BUCKET_NAME: "verify-bucket",
    R2_ACCESS_KEY_ID: "ak",
    R2_SECRET_ACCESS_KEY: "sk",
    CDN_URL: "https://assets.example.com",
    R2_KEY_PREFIX: "verify",
    RATE_LIMIT_ENABLED: "TRUE",
  });
  const putKeys: string[] = [];
  const deletedKeys: string[] = [];
  setObjectStoreDriverForTests({
    sender: async (put) => void putKeys.push(put.Key),
    deleter: async (del) => void deletedKeys.push(del.Key),
  });
  try {
    const mEmail = `upload-${uniq}@example.com`;
    const m2Email = `upload-two-${uniq}@example.com`;
    await signup({ email: mEmail, password: PASSWORD, organizationName: `Upload ${uniq}` });
    await signup({ email: m2Email, password: PASSWORD, organizationName: `Upload two ${uniq}` });
    const one = await login(mEmail, PASSWORD);
    const two = await login(m2Email, PASSWORD);
    // 1×1 PNG.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const upload = (token: string) =>
      app.inject({
        method: "POST",
        url: "/auth/me/avatar",
        headers: { cookie: `tmb_session=${token}`, "content-type": "application/json" },
        payload: { data: png, content_type: "image/png" },
      });

    const first = await upload(one.token);
    const second = await upload(one.token);
    ok(
      "§M an avatar upload is stored",
      first.statusCode === 201 && putKeys.length === 2,
      `${first.statusCode} ${first.body}`,
    );
    ok(
      "§M replacing the photo deletes the previous object, and only that one",
      second.statusCode === 201 && deletedKeys.length === 1 && deletedKeys[0] === putKeys[0],
      JSON.stringify({ putKeys, deletedKeys }),
    );

    const statuses: number[] = [];
    for (let i = 0; i < config.RATE_LIMIT_AVATAR_UPLOADS_PER_USER - 2; i++)
      statuses.push((await upload(one.token)).statusCode);
    const putsBefore = putKeys.length;
    const over = await upload(one.token);
    ok(
      `§M upload ${config.RATE_LIMIT_AVATAR_UPLOADS_PER_USER + 1} in an hour is refused with 429`,
      statuses.every((c) => c === 201) && over.statusCode === 429 && !!over.headers["retry-after"],
      `${statuses.join(",")} → ${over.statusCode} ${over.body}`,
    );
    ok(
      "§M …with the upload message, not the generic one",
      (JSON.parse(over.body) as { error?: { message?: string } }).error?.message ===
        "You uploaded too many images in one hour. Try again later.",
      over.body,
    );
    ok("§M …and the refused upload stores nothing", putKeys.length === putsBefore);
    const otherPerson = await upload(two.token);
    ok(
      "§M the counter is per person: someone else can still upload",
      otherPerson.statusCode === 201,
      otherPerson.body,
    );

    // A photo that came from Google is not ours: removing the upload must delete only the upload.
    const [twoRow] = await systemDb.select().from(users).where(eq(users.email, m2Email)).limit(1);
    const googlePic = "https://lh3.googleusercontent.com/a/verify-google-photo=s96-c";
    await systemDb
      .update(users)
      .set({ googlePictureUrl: googlePic })
      .where(eq(users.id, twoRow!.id));
    const deletesBefore = deletedKeys.length;
    const removed = await app.inject({
      method: "DELETE",
      url: "/auth/me/avatar",
      headers: { cookie: `tmb_session=${two.token}`, "content-type": "application/json" },
      payload: "{}",
    });
    ok(
      "§M removing an uploaded photo deletes that object and falls back to Google",
      removed.statusCode === 200 &&
        deletedKeys.length === deletesBefore + 1 &&
        (JSON.parse(removed.body) as { avatar_source?: string }).avatar_source === "google",
      `${removed.statusCode} ${removed.body}`,
    );
    const again = await app.inject({
      method: "DELETE",
      url: "/auth/me/avatar",
      headers: { cookie: `tmb_session=${two.token}`, "content-type": "application/json" },
      payload: "{}",
    });
    ok(
      "§M removing when only the Google photo is left deletes nothing",
      again.statusCode === 200 && deletedKeys.length === deletesBefore + 1,
      JSON.stringify(deletedKeys),
    );
    ok(
      "§M no delete ever named a Google URL or another owner's folder",
      deletedKeys.every((k) => k.startsWith("verify/user_assets/usr_")),
      JSON.stringify(deletedKeys),
    );
  } finally {
    setObjectStoreDriverForTests(null);
    Object.assign(cfg, savedCfg);
  }
}

// ── § J · the security trail, its notices, and the support 2FA reset (0328) ─────────────────
{
  const captured: OutboundEmail[] = [];
  const capture = {
    kind: "console" as const,
    target: null,
    async send(m: OutboundEmail) {
      captured.push(m);
      return { providerMessageId: `fake_${captured.length}`, status: "sent" as const };
    },
  };
  setMailer(capture);
  const cfg = config as { DASHBOARD_BASE_URL?: string; SUPPORT_EMAIL?: string };
  const savedBase = cfg.DASHBOARD_BASE_URL;
  const savedSupport = cfg.SUPPORT_EMAIL;
  cfg.DASHBOARD_BASE_URL = "https://dash.example.com";
  cfg.SUPPORT_EMAIL = "help@example.com";
  // The per-account credential meter allows 5 per window; this section makes more than that.
  const clearMeters = () =>
    systemDb.execute(sql`
      delete from public_rate_limit_counters
      where bucket like 'change_password:%' or bucket like 'mfa_reset_cancel:%' or bucket like 'login:%'
    `);
  await clearMeters();

  const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
  const ctx = { ip: "203.0.113.7", userAgent: UA };
  const as = (token: string) => ({
    cookie: `tmb_session=${token}`,
    "content-type": "application/json",
    "user-agent": UA,
  });
  const secrets: string[] = []; // every code, secret and token this section handles
  const mailsTo = async (to: string, subject: RegExp) => {
    await flushSecurityMail();
    return captured.filter((m) => m.to === to && subject.test(m.subject));
  };
  const eventsOf = (userId: string) =>
    systemDb
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.userId, userId))
      .orderBy(securityEvents.at);
  const kindsOf = async (userId: string) => (await eventsOf(userId)).map((e) => e.kind);

  const jEmail = `sec-${uniq}@example.com`;
  const j = await signup({ email: jEmail, password: PASSWORD, organizationName: `Sec ${uniq}` });
  const uid = j.user.userId;
  const sess = await login(jEmail, PASSWORD, ctx);
  const other = await login(jEmail, PASSWORD, ctx);
  const nextStep = () =>
    systemDb.update(userMfa).set({ lastUsedStep: null }).where(eq(userMfa.userId, uid));

  // Turning it on, through the routes, so the request's browser reaches the trail and the mail.
  const enroll = async () => {
    const r = await app.inject({
      method: "POST",
      url: "/auth/mfa/enroll",
      headers: as(sess.token),
      payload: {},
    });
    return (JSON.parse(r.body) as { secret: string }).secret;
  };
  const secret1 = await enroll();
  secrets.push(secret1);
  const on = await app.inject({
    method: "POST",
    url: "/auth/mfa/confirm",
    headers: as(sess.token),
    payload: { code: totp(secret1) },
  });
  const firstCodes = (JSON.parse(on.body) as { recovery_codes?: string[] }).recovery_codes ?? [];
  secrets.push(...firstCodes);
  const [enabled] = (await eventsOf(uid)).filter((e) => e.kind === "two_factor_enabled");
  ok(
    "§J turning 2FA on is recorded with the request's address and browser",
    on.statusCode === 200 && enabled?.ip === "127.0.0.1" && enabled?.userAgent === UA,
    `${on.statusCode} ${enabled?.ip} ${enabled?.userAgent}`,
  );
  const onMail = await mailsTo(jEmail, /^Two-factor authentication is on$/);
  ok(
    "§J …and announced: when, which browser, and what to do if it wasn't you",
    onMail.length === 1 &&
      /When: .+ UTC/.test(onMail[0]!.text) &&
      onMail[0]!.text.includes("Browser: Chrome on macOS") &&
      onMail[0]!.text.includes("Did you not do this?") &&
      onMail[0]!.text.includes("help@example.com"),
    onMail[0]?.text,
  );

  await nextStep();
  const secret2 = await enroll();
  secrets.push(secret2);
  await clearMeters();
  await app.inject({
    method: "POST",
    url: "/auth/mfa/confirm",
    headers: as(sess.token),
    payload: { code: totp(secret2) },
  });
  ok(
    "§J changing the app is its own event",
    (await kindsOf(uid)).includes("authenticator_changed"),
  );
  ok(
    "§J …and its own notice",
    (await mailsTo(jEmail, /^New authenticator app for two-factor authentication$/)).length === 1,
  );

  const regen = await app.inject({
    method: "POST",
    url: "/auth/mfa/recovery_codes",
    headers: as(sess.token),
    payload: {},
  });
  const codes = (JSON.parse(regen.body) as { recovery_codes?: string[] }).recovery_codes ?? [];
  secrets.push(...codes);
  ok(
    "§J new recovery codes are recorded and announced",
    (await kindsOf(uid)).includes("recovery_codes_generated") &&
      (await mailsTo(jEmail, /^New recovery codes for your account$/)).length === 1,
  );

  // A mail outage must not fail the change it was announcing.
  setMailer({
    kind: "console",
    target: null,
    async send() {
      throw new Error("relay down");
    },
  });
  await clearMeters();
  const regenDown = await app.inject({
    method: "POST",
    url: "/auth/mfa/recovery_codes",
    headers: as(sess.token),
    payload: {},
  });
  secrets.push(
    ...((JSON.parse(regenDown.body) as { recovery_codes?: string[] }).recovery_codes ?? []),
  );
  await flushSecurityMail();
  ok(
    "§J a mail outage fails nothing: the codes are replaced and the event recorded",
    regenDown.statusCode === 201 &&
      (await kindsOf(uid)).filter((k) => k === "recovery_codes_generated").length === 2,
    `${regenDown.statusCode}`,
  );
  setMailer(capture);
  const liveCodes =
    (JSON.parse(regenDown.body) as { recovery_codes?: string[] }).recovery_codes ?? [];

  // A recovery code finishing a sign-in.
  const pw = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { "user-agent": UA },
    payload: { email: jEmail, password: PASSWORD },
  });
  const challenge = (JSON.parse(pw.body) as { challenge?: string }).challenge ?? "";
  secrets.push(challenge);
  const viaCode = await app.inject({
    method: "POST",
    url: "/auth/login/mfa",
    headers: { "user-agent": UA },
    payload: { challenge, code: liveCodes[0] },
  });
  const used = (await eventsOf(uid)).find((e) => e.kind === "recovery_code_used");
  ok(
    "§J a recovery code at sign-in is recorded with how many remain",
    viaCode.statusCode === 200 &&
      used?.metadata.remaining === 9 &&
      used?.metadata.context === "sign_in",
    JSON.stringify(used?.metadata),
  );
  const usedMail = await mailsTo(jEmail, /^Someone used a recovery code to sign in$/);
  ok(
    "§J …and the notice says how many are left",
    usedMail.length === 1 && usedMail[0]!.text.includes("You have 9 recovery codes left."),
    usedMail[0]?.text,
  );

  // Wrong second-step codes: four say nothing, the fifth warns, and the warning is once a day.
  const challenge2 = await (async () => {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "user-agent": UA },
      payload: { email: jEmail, password: PASSWORD },
    });
    return (JSON.parse(r.body) as { challenge?: string }).challenge ?? "";
  })();
  secrets.push(challenge2);
  const wrong = async (n: number) => {
    for (let i = 0; i < n; i++) {
      try {
        await completeMfaLogin(challenge2, "000000", ctx);
      } catch {
        /* expected */
      }
    }
  };
  await wrong(4);
  ok("§J four wrong codes raise no alert", !(await kindsOf(uid)).includes("mfa_failed_alert"));
  await wrong(1);
  await flushSecurityMail();
  const alerts = () => mailsTo(jEmail, /^Someone tried to sign in to your account$/);
  const firstAlert = await alerts();
  ok(
    "§J the fifth warns that someone may have the password",
    firstAlert.length === 1 && firstAlert[0]!.text.includes("entered your password correctly"),
    firstAlert[0]?.text,
  );
  await wrong(3);
  ok(
    "§J …at most once a day",
    (await alerts()).length === 1 &&
      (await kindsOf(uid)).filter((k) => k === "mfa_failed_alert").length === 1,
  );
  // Leave the lockout counter where the wrong codes put it from mattering to what follows.
  await systemDb
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null })
    .where(eq(users.id, uid));

  await clearMeters();
  const signedOut = await app.inject({
    method: "POST",
    url: "/auth/sessions/revoke_others",
    headers: as(sess.token),
    payload: {},
  });
  const revoked = (await eventsOf(uid)).find((e) => e.kind === "sessions_revoked");
  ok(
    "§J signing out other browsers is recorded, with how many",
    signedOut.statusCode === 200 &&
      typeof revoked?.metadata.signed_out === "number" &&
      revoked.metadata.signed_out >= 1,
    JSON.stringify(revoked?.metadata),
  );
  ok("§J …the other session is gone", !(await resolveSession(other.token)));

  await clearMeters();
  const NEWPW = "Another-Horse-Battery-7";
  const changed = await app.inject({
    method: "POST",
    url: "/auth/change_password",
    headers: as(sess.token),
    payload: { current_password: PASSWORD, new_password: NEWPW },
  });
  ok(
    "§J a password change is recorded and announced",
    changed.statusCode === 200 &&
      (await kindsOf(uid)).includes("password_changed") &&
      (await mailsTo(jEmail, /^New password on your tmbilling account$/)).length === 1,
    `${changed.statusCode} ${changed.body}`,
  );

  await clearMeters();
  const off = await app.inject({
    method: "POST",
    url: "/auth/mfa/disable",
    headers: as(sess.token),
    payload: {},
  });
  ok(
    "§J turning 2FA off is recorded and announced",
    off.statusCode === 200 &&
      (await kindsOf(uid)).includes("two_factor_disabled") &&
      (await mailsTo(jEmail, /^Two-factor authentication is disabled$/)).length === 1,
  );

  // A reset link, spent.
  const resetToken = `prst_${randomBytes(24).toString("base64url")}`;
  secrets.push(resetToken);
  await systemDb.insert(authTokens).values({
    userId: uid,
    tokenHash: hash(resetToken),
    purpose: "password_reset",
    expiresAt: new Date(Date.now() + 600_000),
  });
  await resetPasswordWithToken(resetToken, PASSWORD, ctx);
  ok(
    "§J a password reset is recorded and announced",
    (await kindsOf(uid)).includes("password_reset") &&
      (await mailsTo(jEmail, /^Password reset on your tmbilling account$/)).length === 1,
  );

  // A Google-only account adding its first password.
  const gEmail = `sec-google-${uniq}@example.com`;
  const g = await signup({ email: gEmail, password: PASSWORD, organizationName: `SecG ${uniq}` });
  const gSess = await login(gEmail, PASSWORD);
  await systemDb.update(users).set({ passwordHash: null }).where(eq(users.id, g.user.userId));
  await clearMeters();
  await app.inject({
    method: "POST",
    url: "/auth/change_password",
    headers: as(gSess.token),
    payload: { new_password: NEWPW },
  });
  ok(
    "§J a first password on a Google-only account is 'added', not 'changed'",
    (await kindsOf(g.user.userId)).includes("password_added") &&
      (await mailsTo(gEmail, /^Password added to your tmbilling account$/)).length === 1,
  );

  // Metadata that could carry a credential is refused at the door.
  await recordSecurityEvent(uid, "mfa_failed", ctx, {
    code: "123456",
    challenge: "mfac_x",
    recovery_code: "AAAA",
    first_factor: "password",
  });
  const [probe] = (await eventsOf(uid)).filter((e) => e.kind === "mfa_failed").slice(-1);
  ok(
    "§J credential-shaped metadata keys are dropped",
    !!probe && Object.keys(probe.metadata).join(",") === "first_factor",
    JSON.stringify(probe?.metadata),
  );

  // ── the support reset ──
  const refusal = async (email: string) => {
    try {
      await requestMfaReset({ email, proof: "test", requestedBy: "verify", commit: true });
      return null;
    } catch (e) {
      return e instanceof MfaResetRefusedError ? e.reason : String(e);
    }
  };
  ok(
    "§J a reset is refused for an unknown address",
    (await refusal(`nobody-${uniq}@example.com`)) === "unknown_account",
  );
  ok("§J …and for an account without 2FA", (await refusal(gEmail)) === "no_two_factor");

  // Three people with 2FA: one reset not yet due, one due, one due but cancelled.
  const withTwoFactor = async (label: string) => {
    const r = await signup({
      email: `sec-${label}-${uniq}@example.com`,
      password: PASSWORD,
      organizationName: `Sec${label} ${uniq}`,
    });
    const s = await startMfaEnrollment({ userId: r.user.userId });
    secrets.push(s.secret);
    const c = await confirmMfaEnrollment({ userId: r.user.userId, code: totp(s.secret) });
    secrets.push(...(c.recoveryCodes ?? []));
    await systemDb
      .update(userMfa)
      .set({ lastUsedStep: null })
      .where(eq(userMfa.userId, r.user.userId));
    return { email: `sec-${label}-${uniq}@example.com`, userId: r.user.userId, secret: s.secret };
  };
  const notDue = await withTwoFactor("notdue");
  const due = await withTwoFactor("due");
  const cancelled = await withTwoFactor("cancelled");

  const before = await systemDb
    .select()
    .from(mfaResetRequests)
    .where(eq(mfaResetRequests.userId, notDue.userId));
  const dry = await requestMfaReset({
    email: notDue.email,
    proof: "test",
    requestedBy: "verify",
    commit: false,
  });
  const afterDry = await systemDb
    .select()
    .from(mfaResetRequests)
    .where(eq(mfaResetRequests.userId, notDue.userId));
  ok("§J a dry run writes nothing", !dry.filed && before.length === 0 && afterDry.length === 0);

  const cancelTokenFrom = async (to: string) => {
    const [m] = await mailsTo(to, /will disable two-factor authentication soon/);
    const t = /\/two-factor-reset\/s\/(mfrc_[A-Za-z0-9_-]+)/.exec(m?.text ?? "")?.[1] ?? "";
    secrets.push(t);
    return t;
  };
  for (const p of [notDue, due, cancelled]) {
    await requestMfaReset({
      email: p.email,
      proof: "signed in with Google on a known browser",
      requestedBy: "verify",
      commit: true,
    });
  }
  ok(
    "§J a second open reset for the same person is refused",
    (await refusal(notDue.email)) === "already_pending",
  );
  const [stored] = await systemDb
    .select()
    .from(mfaResetRequests)
    .where(eq(mfaResetRequests.userId, notDue.userId));
  const notDueToken = await cancelTokenFrom(notDue.email);
  ok(
    "§J the email carries a cancel link; only the token's sha256 is stored",
    notDueToken.startsWith("mfrc_") && stored?.cancelTokenHash === hash(notDueToken),
  );
  ok(
    "§J the reset takes effect after the configured wait",
    !!stored &&
      Math.abs(
        stored.effectiveAt.getTime() -
          stored.requestedAt.getTime() -
          config.MFA_RESET_WAIT_DAYS * 86_400_000,
      ) < 5000,
  );

  // The pending reset is shown where the person will look: the code step and the 2FA card.
  const nd = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: notDue.email, password: PASSWORD },
  });
  const ndBody = JSON.parse(nd.body) as {
    reset_effective_at?: string | null;
    support_email?: string | null;
    reset_wait_days?: number;
    challenge?: string;
  };
  secrets.push(ndBody.challenge ?? "");
  ok(
    "§J the sign-in code step learns of the pending reset and whom to ask",
    ndBody.reset_effective_at === stored?.effectiveAt.toISOString() &&
      ndBody.support_email === "help@example.com" &&
      ndBody.reset_wait_days === config.MFA_RESET_WAIT_DAYS,
    nd.body,
  );

  const cancelReq = (token: string) =>
    app.inject({
      method: "POST",
      url: "/auth/mfa/reset/cancel",
      headers: { "user-agent": UA },
      payload: { token },
    });
  const cancelledToken = await cancelTokenFrom(cancelled.email);
  const c1 = await cancelReq(cancelledToken);
  const c2 = await cancelReq(cancelledToken);
  ok(
    "§J cancelling works",
    c1.statusCode === 200 &&
      (JSON.parse(c1.body) as { already_cancelled?: boolean }).already_cancelled === false,
    c1.body,
  );
  ok(
    "§J …a repeat click is still success",
    c2.statusCode === 200 &&
      (JSON.parse(c2.body) as { already_cancelled?: boolean }).already_cancelled === true,
    c2.body,
  );
  ok(
    "§J …and the cancel is recorded",
    (await kindsOf(cancelled.userId)).includes("mfa_reset_cancelled"),
  );
  const unknown = await cancelReq(`mfrc_${randomBytes(24).toString("base64url")}`);
  const wrongShape = await cancelReq("not-a-token");
  ok(
    "§J an unknown token is a 404",
    unknown.statusCode === 404 && wrongShape.statusCode === 404,
    `${unknown.statusCode} ${wrongShape.statusCode}`,
  );

  // Make two of them due, then sweep.
  const dueToken = await cancelTokenFrom(due.email);
  const past = new Date(Date.now() - 60_000);
  await systemDb
    .update(mfaResetRequests)
    .set({ effectiveAt: past })
    .where(eq(mfaResetRequests.userId, due.userId));
  await systemDb
    .update(mfaResetRequests)
    .set({ effectiveAt: past })
    .where(eq(mfaResetRequests.userId, cancelled.userId));
  const dueSessA = await login(due.email, PASSWORD, ctx, totp(due.secret));
  await systemDb.update(userMfa).set({ lastUsedStep: null }).where(eq(userMfa.userId, due.userId));
  const dueSessB = await login(due.email, PASSWORD, ctx, totp(due.secret));
  await sweepMfaResets(new Date());
  await flushSecurityMail();
  const [dueRow] = await systemDb
    .select()
    .from(mfaResetRequests)
    .where(eq(mfaResetRequests.userId, due.userId));
  const [cancelledRow] = await systemDb
    .select()
    .from(mfaResetRequests)
    .where(eq(mfaResetRequests.userId, cancelled.userId));
  const [notDueRow] = await systemDb
    .select()
    .from(mfaResetRequests)
    .where(eq(mfaResetRequests.userId, notDue.userId));
  ok(
    "§J the sweep completes a due reset: 2FA off",
    !!dueRow?.completedAt && !(await hasConfirmedMfa(due.userId)),
  );
  ok(
    "§J …every session signed out",
    !(await resolveSession(dueSessA.token)) && !(await resolveSession(dueSessB.token)),
  );
  ok(
    "§J …recorded once as a support reset, not as a self-serve turn-off",
    (await kindsOf(due.userId)).includes("mfa_reset_completed") &&
      !(await kindsOf(due.userId)).includes("two_factor_disabled"),
  );
  ok(
    "§J …and the person is told",
    (await mailsTo(due.email, /^Support disabled two-factor authentication$/)).length === 1,
  );
  ok(
    "§J a cancelled reset is never completed, due or not",
    !cancelledRow?.completedAt && (await hasConfirmedMfa(cancelled.userId)),
  );
  ok(
    "§J a reset not yet due is left alone",
    !notDueRow?.completedAt && (await hasConfirmedMfa(notDue.userId)),
  );
  const late = await cancelReq(dueToken);
  ok(
    "§J a completed reset cannot be cancelled (409)",
    late.statusCode === 409,
    `${late.statusCode} ${late.body}`,
  );
  await sweepMfaResets(new Date());
  ok(
    "§J a second sweep does nothing more",
    (await kindsOf(due.userId)).filter((k) => k === "mfa_reset_completed").length === 1,
  );

  // Nothing secret in the trail, or in any notice.
  const people = [uid, g.user.userId, notDue.userId, due.userId, cancelled.userId];
  const trail = JSON.stringify((await Promise.all(people.map((p) => eventsOf(p)))).flat());
  const leaked = secrets.filter((x) => x && trail.includes(x));
  ok(
    "§J no code, secret or token ever lands in security_events",
    leaked.length === 0,
    leaked.join(","),
  );
  await flushSecurityMail();
  const mailed = captured.map((m) => m.text + m.html).join("\n");
  const inMail = secrets.filter((x) => x && !x.startsWith("mfrc_") && mailed.includes(x));
  ok(
    "§J …or in any notice (a reset's own cancel link excepted)",
    inMail.length === 0,
    inMail.join(","),
  );

  setMailer(null);
  cfg.DASHBOARD_BASE_URL = savedBase;
  cfg.SUPPORT_EMAIL = savedSupport;
  await clearMeters();
}

// ── § K · organization "Require 2FA" and trusted browsers (0329) ─────────────────────────
{
  const captured: OutboundEmail[] = [];
  setMailer({
    kind: "console" as const,
    target: null,
    async send(m: OutboundEmail) {
      captured.push(m);
      return { providerMessageId: `fake_${captured.length}`, status: "sent" as const };
    },
  });
  const clearMeters = () =>
    systemDb.execute(sql`
      delete from public_rate_limit_counters
      where bucket like 'change_password:%' or bucket like 'login:%'
    `);
  await clearMeters();
  const ctx = { ip: "203.0.113.9", userAgent: "verify-auth-identity §K" };
  const as = (token: string) => ({
    cookie: `tmb_session=${token}`,
    "content-type": "application/json",
  });
  const mailsTo = async (to: string, subject: RegExp) => {
    await flushSecurityMail();
    return captured.filter((m) => m.to === to && subject.test(m.subject));
  };
  const freshStep = (userId: string) =>
    systemDb.update(userMfa).set({ lastUsedStep: null }).where(eq(userMfa.userId, userId));
  const enrol = async (userId: string) => {
    const s = await startMfaEnrollment({ userId });
    await confirmMfaEnrollment({ userId, code: totp(s.secret) });
    await freshStep(userId);
    return s.secret;
  };
  const get = (url: string, token: string) =>
    app.inject({ method: "GET", url, headers: { cookie: `tmb_session=${token}` } });
  const typeOf = (body: string) => (JSON.parse(body) as { error?: { type?: string } }).error?.type;

  // The organization, its owner, and members who joined BEFORE the requirement.
  const owner = await signup({
    email: `k-owner-${uniq}@example.com`,
    password: PASSWORD,
    organizationName: `K ${uniq}`,
  });
  const orgId = owner.user.organizationId;
  const ownerSess = await login(`k-owner-${uniq}@example.com`, PASSWORD, ctx);
  const joinMember = async (tag: string, role: "developer" | "admin", joinedAt?: Date) => {
    const email = `k-${tag}-${uniq}@example.com`;
    const r = await signup({ email, password: PASSWORD, organizationName: `K-${tag} ${uniq}` });
    await systemDb.insert(memberships).values({
      organizationId: orgId,
      userId: r.user.userId,
      role,
      ...(joinedAt ? { createdAt: joinedAt, acceptedAt: joinedAt } : {}),
    });
    await systemDb
      .update(users)
      .set({ lastOrganizationId: orgId })
      .where(eq(users.id, r.user.userId));
    return { email, userId: r.user.userId };
  };
  const longAgo = new Date(Date.now() - 60 * 86_400_000);
  const dev = await joinMember("dev", "developer", longAgo);
  const adm = await joinMember("adm", "admin", longAgo);
  const devSess = await login(dev.email, PASSWORD, ctx);
  const admSess = await login(adm.email, PASSWORD, ctx);
  ok(
    "§K members' sessions open the organization",
    devSess.user.organizationId === orgId && admSess.user.organizationId === orgId,
  );

  // A key minted before the requirement, to prove existing keys keep working.
  const mint = (token: string) =>
    app.inject({
      method: "POST",
      url: "/v1/api_keys",
      headers: { ...as(token), "idempotency-key": `k-${randomBytes(8).toString("hex")}` },
      // A map the developer holds: a full read key also reads ops- and admin-level data, which
      // a developer may no longer grant (grant only what you hold, 0391).
      payload: { livemode: "test", permissions: { settings: "read" } },
    });
  const before = await mint(devSess.token);
  const oldKey =
    (JSON.parse(before.body) as { secret?: string; key?: string }).secret ??
    (JSON.parse(before.body) as { key?: string }).key;
  ok(
    "§K a key can be minted before the requirement",
    before.statusCode < 300 && !!oldKey,
    `${before.statusCode} ${before.body.slice(0, 200)}`,
  );

  const toggle = (token: string, enabled: boolean) =>
    app.inject({
      method: "POST",
      url: "/auth/organization/security/require_two_factor",
      headers: as(token),
      payload: { enabled },
    });

  // Turning it on needs your own 2FA.
  const refused = await toggle(ownerSess.token, true);
  ok(
    "§K turning it on without your own 2FA is refused (409)",
    refused.statusCode === 409 && typeOf(refused.body) === "two_factor_setup_required",
    refused.body,
  );
  ok(
    "§K …and changes nothing",
    !(await systemDb.select().from(organizations).where(eq(organizations.id, orgId)))[0]!
      .requireMfa,
  );
  await enrol(owner.user.userId);
  const nonAdmin = await toggle(devSess.token, true);
  ok("§K a non-admin cannot turn it on", nonAdmin.statusCode === 403);
  const onRes = await toggle(ownerSess.token, true);
  const onBody = JSON.parse(onRes.body) as { changed?: boolean; notified?: number };
  ok("§K the owner turns it on", onRes.statusCode === 200 && onBody.changed === true, onRes.body);
  ok(
    "§K both members without 2FA are emailed",
    onBody.notified === 2 && (await mailsTo(dev.email, /now requires two-factor/)).length === 1,
  );
  const [orgOn] = await systemDb.select().from(organizations).where(eq(organizations.id, orgId));
  const again = await toggle(ownerSess.token, true);
  const [orgAgain] = await systemDb.select().from(organizations).where(eq(organizations.id, orgId));
  ok(
    "§K turning it on again is a no-op: nobody's grace restarts",
    (JSON.parse(again.body) as { changed?: boolean }).changed === false &&
      orgAgain!.mfaRequiredSince!.getTime() === orgOn!.mfaRequiredSince!.getTime(),
  );
  ok(
    "§K …and sends no second email",
    (await mailsTo(dev.email, /now requires two-factor/)).length === 1,
  );

  // Inside the grace period: everything works, and the standing says when.
  const meGrace = JSON.parse((await get("/auth/me", devSess.token)).body) as {
    organization_two_factor?: { required: boolean; blocked: boolean; deadline_day: string | null };
  };
  ok(
    "§K in grace: /auth/me says required, not blocked, with a deadline",
    meGrace.organization_two_factor?.required === true &&
      meGrace.organization_two_factor.blocked === false &&
      !!meGrace.organization_two_factor.deadline_day,
  );
  ok("§K in grace: /v1/* answers", (await get("/v1/businesses", devSess.token)).statusCode === 200);
  const graceMint = await mint(devSess.token);
  ok(
    "§K in grace: a NEW API key is refused (403 two_factor_setup_required)",
    graceMint.statusCode === 403 && typeOf(graceMint.body) === "two_factor_setup_required",
    graceMint.body,
  );
  const ownerMint = await mint(ownerSess.token);
  ok(
    "§K …while a member WITH 2FA still mints one",
    ownerMint.statusCode < 300,
    ownerMint.body.slice(0, 200),
  );

  // Turning 2FA off is refused while the organization requires it.
  const off = await app.inject({
    method: "POST",
    url: "/auth/mfa/disable",
    headers: as(ownerSess.token),
    payload: {},
  });
  ok(
    "§K turning your own 2FA off is refused while required (409)",
    off.statusCode === 409 && typeOf(off.body) === "organization_requires_two_factor",
    off.body,
  );
  ok("§K …and it stays on", await hasConfirmedMfa(owner.user.userId));

  // Past the deadline.
  await systemDb
    .update(organizations)
    .set({ mfaRequiredSince: new Date(Date.now() - 30 * 86_400_000) })
    .where(eq(organizations.id, orgId));
  const blockedV1 = await get("/v1/businesses", devSess.token);
  ok(
    "§K past the deadline: /v1/* answers 403 two_factor_required",
    blockedV1.statusCode === 403 && typeOf(blockedV1.body) === "two_factor_required",
    blockedV1.body,
  );
  const meBlocked = JSON.parse((await get("/auth/me", devSess.token)).body) as {
    organization_two_factor?: { blocked: boolean };
  };
  ok(
    "§K …/auth/me still answers, and says blocked",
    meBlocked.organization_two_factor?.blocked === true,
  );
  const allow = await Promise.all(
    ["/auth/mfa", "/auth/sessions", "/auth/organizations", "/auth/trusted_browsers"].map((u) =>
      get(u, devSess.token),
    ),
  );
  ok(
    "§K …the allowlist answers (mfa, sessions, organizations, trusted browsers)",
    allow.every((r) => r.statusCode === 200),
    allow.map((r) => r.statusCode).join(","),
  );
  const team = await get("/auth/members", admSess.token);
  ok(
    "§K …a blocked ADMIN cannot manage the team",
    team.statusCode === 403 && typeOf(team.body) === "two_factor_required",
    team.body,
  );
  ok(
    "§K …the owner, who has 2FA, can",
    (await get("/auth/members", ownerSess.token)).statusCode === 200,
  );
  const keyCall = await app.inject({
    method: "GET",
    url: "/v1/businesses",
    headers: { authorization: `Bearer ${oldKey}` },
  });
  ok("§K …an existing API key keeps working", keyCall.statusCode === 200, `${keyCall.statusCode}`);
  // Setting it up lifts the block on the same session.
  await enrol(dev.userId);
  ok(
    "§K setting up 2FA lifts the block at once",
    (await get("/v1/businesses", devSess.token)).statusCode === 200,
  );

  // A member who joins after the requirement started gets the rest of the day they joined.
  const late = await joinMember("late", "developer");
  const lateSess = await login(late.email, PASSWORD, ctx);
  const meLate = JSON.parse((await get("/auth/me", lateSess.token)).body) as {
    organization_two_factor?: { blocked: boolean; deadline_day: string | null };
  };
  const today = new Date().toISOString().slice(0, 10);
  ok(
    "§K a late joiner's deadline is the day they joined, not the old grace",
    meLate.organization_two_factor?.deadline_day === today &&
      meLate.organization_two_factor.blocked === false,
    JSON.stringify(meLate.organization_two_factor),
  );
  const [orgPast] = await systemDb.select().from(organizations).where(eq(organizations.id, orgId));
  ok(
    "§K …and tomorrow they are blocked",
    twoFactorStanding({
      org: orgPast!,
      joinedAt: new Date(),
      satisfied: false,
      now: new Date(Date.now() + 2 * 86_400_000),
    }).blocked,
  );

  // One reminder per member and deadline: deadline tomorrow (UTC org), run the sweep twice.
  await systemDb
    .update(organizations)
    .set({ mfaRequiredSince: new Date(Date.now() - (orgPast!.mfaGraceDays - 1) * 86_400_000) })
    .where(eq(organizations.id, orgId));
  await sendOrgMfaDeadlineReminders(new Date());
  await sendOrgMfaDeadlineReminders(new Date());
  ok(
    "§K the deadline reminder is sent once, however often the sweep runs",
    (await mailsTo(adm.email, /Enable 2FA by tomorrow/)).length === 1,
  );
  ok(
    "§K …a member who set it up gets none",
    (await mailsTo(dev.email, /Enable 2FA by/)).length === 0,
  );
  const rows = await systemDb
    .select()
    .from(orgMfaReminders)
    .where(eq(orgMfaReminders.userId, adm.userId));
  ok("§K …and the claim row exists exactly once", rows.length === 1);

  // Turning it off restores everyone at once.
  const offReq = await toggle(ownerSess.token, false);
  ok("§K turning it off", offReq.statusCode === 200);
  ok(
    "§K …and a member without 2FA is back in",
    (await get("/v1/businesses", admSess.token)).statusCode === 200,
  );

  // ── trusted browsers ──
  const tEmail = `k-trust-${uniq}@example.com`;
  const t = await signup({ email: tEmail, password: PASSWORD, organizationName: `K-T ${uniq}` });
  const tSecret = await enrol(t.user.userId);
  const challengeFor = async (email: string, extra: Record<string, unknown> = {}) => {
    try {
      await login(email, PASSWORD, { ...ctx, ...extra });
      return null;
    } catch (e) {
      return e instanceof MfaRequiredError ? e.challenge : "refused";
    }
  };
  const trust = async () => {
    const ch = await challengeFor(tEmail);
    await freshStep(t.user.userId);
    const r = await completeMfaLogin(ch!, totp(tSecret), ctx, { trustBrowser: true });
    return r.trustedBrowser!.token;
  };
  const tb = await trust();
  ok("§K ticking the box returns a trusted-browser token", /^tb_/.test(tb));
  const [stored] = await systemDb
    .select()
    .from(trustedBrowsers)
    .where(eq(trustedBrowsers.userId, t.user.userId));
  ok(
    "§K …only its hash is stored",
    !!stored && stored.tokenHash === hash(tb) && !JSON.stringify(stored).includes(tb),
  );
  const skipped = await login(tEmail, PASSWORD, { ...ctx, trustedBrowserToken: tb });
  ok("§K a trusted browser skips the code", !!skipped.token);
  const [skRow] = await systemDb
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hash(skipped.token)));
  ok(
    "§K …but the session is NOT a 2FA confirmation (no mfa_at)",
    !!skRow && skRow.mfaAt === null && skRow.authMethod === "password+trusted_browser",
    JSON.stringify({ m: skRow?.mfaAt, a: skRow?.authMethod }),
  );
  ok("§K …and NOT a step-up either (no step_up_at)", !!skRow && skRow.stepUpAt === null);
  const viaRoute = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { "content-type": "application/json", "x-tmb-trusted-browser": tb },
    payload: { email: tEmail, password: PASSWORD },
  });
  ok(
    "§K …through the route too, via the forwarded header",
    (JSON.parse(viaRoute.body) as { object?: string }).object === "session",
    viaRoute.body.slice(0, 120),
  );

  // Another person's cookie does not skip for you.
  const u = await signup({
    email: `k-other-${uniq}@example.com`,
    password: PASSWORD,
    organizationName: `K-U ${uniq}`,
  });
  await enrol(u.user.userId);
  ok(
    "§K user A's trusted cookie does not skip the code for user B",
    (await challengeFor(`k-other-${uniq}@example.com`, { trustedBrowserToken: tb }))?.startsWith(
      "mfac_",
    ) === true,
  );

  // Not offered after a recovery code.
  const codes = await regenerateRecoveryCodes(t.user.userId);
  const ch2 = await challengeFor(tEmail);
  const viaRecovery = await completeMfaLogin(ch2!, codes[0]!, ctx, { trustBrowser: true });
  ok("§K a recovery code never buys a trusted browser", viaRecovery.trustedBrowser === undefined);

  // Expiry.
  await systemDb
    .update(trustedBrowsers)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(trustedBrowsers.tokenHash, hash(tb)));
  ok(
    "§K an expired trusted browser asks again",
    (await challengeFor(tEmail, { trustedBrowserToken: tb }))?.startsWith("mfac_") === true,
  );

  // Listing, and forgetting someone else's.
  const tb2 = await trust();
  const tSess = await login(tEmail, PASSWORD, { ...ctx, trustedBrowserToken: tb2 });
  const list = await app.inject({
    method: "GET",
    url: "/auth/trusted_browsers",
    headers: { cookie: `tmb_session=${tSess.token}`, "x-tmb-trusted-browser": tb2 },
  });
  const listed = (JSON.parse(list.body) as { data: Array<{ id: string; current: boolean }> }).data;
  ok(
    "§K the list shows the live one, marked as this browser",
    listed.length === 1 && listed[0]!.current === true,
    list.body.slice(0, 200),
  );
  const foreign = await app.inject({
    method: "DELETE",
    url: `/auth/trusted_browsers/${listed[0]!.id}`,
    headers: { cookie: `tmb_session=${ownerSess.token}` },
  });
  ok("§K nobody can forget someone else's trusted browser (404)", foreign.statusCode === 404);

  // Forgotten on: password change, sign out of other browsers, 2FA off.
  await changePassword({
    userId: t.user.userId,
    currentPassword: PASSWORD,
    newPassword: `${PASSWORD}x`,
    keepSessionToken: tSess.token,
  });
  const liveAfterPw = await systemDb
    .select()
    .from(trustedBrowsers)
    .where(
      and(eq(trustedBrowsers.userId, t.user.userId), sql`${trustedBrowsers.revokedAt} is null`),
    );
  ok("§K a password change forgets every trusted browser", liveAfterPw.length === 0);
  await changePassword({
    userId: t.user.userId,
    currentPassword: `${PASSWORD}x`,
    newPassword: PASSWORD,
    keepSessionToken: tSess.token,
  });
  const tb3 = await trust();
  await revokeOtherSessions(t.user.userId, tSess.token, ctx);
  ok(
    '§K "sign out of other browsers" forgets them too',
    (await challengeFor(tEmail, { trustedBrowserToken: tb3 }))?.startsWith("mfac_") === true,
  );
  await trust();
  await disableMfa({ userId: t.user.userId, keepSessionToken: tSess.token, ctx });
  const liveAfterOff = await systemDb
    .select()
    .from(trustedBrowsers)
    .where(
      and(eq(trustedBrowsers.userId, t.user.userId), sql`${trustedBrowsers.revokedAt} is null`),
    );
  ok("§K turning 2FA off forgets them", liveAfterOff.length === 0);
  const kinds = (
    await systemDb.select().from(securityEvents).where(eq(securityEvents.userId, t.user.userId))
  ).map((e) => e.kind);
  ok(
    "§K trusting and forgetting are on the security trail",
    kinds.includes("trusted_browser_added") && kinds.includes("trusted_browsers_forgotten"),
  );
  const trail = JSON.stringify(
    await systemDb.select().from(securityEvents).where(eq(securityEvents.userId, t.user.userId)),
  );
  ok("§K …and no trusted-browser token is in it", ![tb, tb2, tb3].some((x) => trail.includes(x)));

  setMailer(null);
  await flushSecurityMail();
  await clearMeters();
}

// ── § L · passkeys (0330) ────────────────────────────────────────────────────────────────
{
  const captured: OutboundEmail[] = [];
  setMailer({
    kind: "console" as const,
    target: null,
    async send(m: OutboundEmail) {
      captured.push(m);
      return { providerMessageId: `fake_${captured.length}`, status: "sent" as const };
    },
  });
  const clearMeters = () =>
    systemDb.execute(sql`
      delete from public_rate_limit_counters
      where bucket like 'change_password:%' or bucket like 'login:%'
    `);
  await clearMeters();

  const rp = passkeyRp();
  const ORIGIN = rp.origins[0]!;
  const MAC_CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
  const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();

  // Minimal CBOR: unsigned/negative ints, byte strings, text strings, maps. Enough for
  // `fmt: none` attestation and a COSE EC2 key — nothing else is ever encoded here.
  const cborHead = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const cbor = (v: unknown): Buffer => {
    if (typeof v === "number") return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
    if (typeof v === "string")
      return Buffer.concat([cborHead(3, Buffer.byteLength(v)), Buffer.from(v)]);
    if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
    if (v instanceof Map) {
      const parts: Buffer[] = [cborHead(5, v.size)];
      for (const [k, val] of v) parts.push(cbor(k), cbor(val));
      return Buffer.concat(parts);
    }
    throw new Error("cbor: unsupported");
  };

  /** A software passkey: an ES256 key pair, a credential id, a signature counter. */
  const authenticator = (opts: { synced?: boolean } = {}) => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const credId = randomBytes(32);
    let counter = 0;
    let userHandle: string | null = null;
    // BE|BS for a synced passkey, which also always reports counter 0.
    const flagsFor = (uv: boolean, at: boolean) =>
      0x01 | (uv ? 0x04 : 0) | (opts.synced ? 0x18 : 0) | (at ? 0x40 : 0);
    const clientData = (type: string, challenge: string, origin: string) =>
      Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    return {
      id: b64u(credId),
      setCounter: (n: number) => (counter = n),
      create(
        options: { challenge: string; user: { id: string } },
        o: { origin?: string; rpId?: string; uv?: boolean } = {},
      ) {
        userHandle = options.user.id;
        const cose = cbor(
          new Map<number, unknown>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, Buffer.from(jwk.x, "base64url")],
            [-3, Buffer.from(jwk.y, "base64url")],
          ]),
        );
        const count = Buffer.alloc(4);
        const authData = Buffer.concat([
          sha(o.rpId ?? rp.rpID),
          Buffer.from([flagsFor(o.uv ?? true, true)]),
          count,
          Buffer.alloc(16), // AAGUID: none
          Buffer.from([credId.length >> 8, credId.length & 0xff]),
          credId,
          cose,
        ]);
        const attestationObject = cbor(
          new Map<string, unknown>([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", authData],
          ]),
        );
        return {
          id: b64u(credId),
          rawId: b64u(credId),
          type: "public-key",
          response: {
            clientDataJSON: b64u(
              clientData("webauthn.create", options.challenge, o.origin ?? ORIGIN),
            ),
            attestationObject: b64u(attestationObject),
            transports: ["internal"],
          },
          clientExtensionResults: {},
          authenticatorAttachment: "platform",
        };
      },
      get(challenge: string, o: { origin?: string; rpId?: string; counter?: number } = {}) {
        if (!opts.synced) counter = o.counter ?? counter + 1;
        const count = Buffer.alloc(4);
        count.writeUInt32BE(opts.synced ? 0 : counter);
        const authData = Buffer.concat([
          sha(o.rpId ?? rp.rpID),
          Buffer.from([flagsFor(true, false)]),
          count,
        ]);
        const cd = clientData("webauthn.get", challenge, o.origin ?? ORIGIN);
        const signature = cryptoSign("sha256", Buffer.concat([authData, sha(cd)]), privateKey);
        return {
          id: b64u(credId),
          rawId: b64u(credId),
          type: "public-key",
          response: {
            clientDataJSON: b64u(cd),
            authenticatorData: b64u(authData),
            signature: b64u(signature),
            userHandle,
          },
          clientExtensionResults: {},
          authenticatorAttachment: "platform",
        };
      },
    };
  };

  const post = (url: string, payload: unknown, token?: string, ua = MAC_CHROME) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        "user-agent": ua,
        ...(token ? { cookie: `tmb_session=${token}` } : {}),
      },
      payload: payload as Record<string, unknown>,
    });
  const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>;
  const sessionFrom = (r: { headers: Record<string, unknown> }) =>
    /tmb_session=([^;]+)/.exec(String(r.headers["set-cookie"] ?? ""))?.[1] ?? "";
  const sessionRow = async (token: string) =>
    (
      await systemDb
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, hash(token)))
        .limit(1)
    )[0];

  const email = `l-pk-${uniq}@example.com`;
  const person = await signup({ email, password: PASSWORD, organizationName: `L ${uniq}` });
  const uid = person.user.userId;
  const s1 = await login(email, PASSWORD);
  const s2 = await login(email, PASSWORD); // an "other browser", to prove turning off signs it out

  // Registration: the first passkey turns 2FA on and mints recovery codes.
  const pk = authenticator();
  const regOpts = json(await post("/auth/mfa/passkeys/options", {}, s1.token));
  ok(
    "§L registration options carry a challenge and require user verification",
    typeof regOpts.handle === "string" &&
      regOpts.options?.authenticatorSelection?.userVerification === "required" &&
      regOpts.options?.authenticatorSelection?.residentKey === "required",
  );
  const regRes = pk.create(regOpts.options);
  const added = await post(
    "/auth/mfa/passkeys",
    { handle: regOpts.handle, response: regRes },
    s1.token,
  );
  const addedBody = json(added);
  ok(
    "§L the first passkey turns 2FA on",
    added.statusCode === 201 && addedBody.confirmed === true,
    added.body,
  );
  ok(
    "§L …and returns 10 recovery codes once",
    Array.isArray(addedBody.recovery_codes) && addedBody.recovery_codes.length === 10,
  );
  ok(
    "§L …with no authenticator app",
    addedBody.authenticatorApp === false && (await hasConfirmedMfa(uid)),
  );
  ok(
    "§L the suggested name comes from the device",
    addedBody.passkey?.name === "Chrome on macOS",
    addedBody.passkey?.name,
  );
  const replayReg = await post(
    "/auth/mfa/passkeys",
    { handle: regOpts.handle, response: regRes },
    s1.token,
  );
  ok(
    "§L a registration cannot be replayed (challenge spent)",
    replayReg.statusCode === 400 && json(replayReg).error?.reason === "expired",
  );

  // A registration without user verification is refused.
  const noUv = authenticator();
  const noUvOpts = json(await post("/auth/mfa/passkeys/options", {}, s1.token));
  const noUvRes = await post(
    "/auth/mfa/passkeys",
    { handle: noUvOpts.handle, response: noUv.create(noUvOpts.options, { uv: false }) },
    s1.token,
  );
  ok(
    "§L a passkey that skips the fingerprint/face/PIN check is refused",
    noUvRes.statusCode === 400,
    noUvRes.body,
  );

  // Sign-in second step offers the passkey, not a code.
  let challenge = "";
  try {
    await login(email, PASSWORD);
  } catch (e) {
    if (e instanceof MfaRequiredError) {
      challenge = e.challenge;
      ok(
        "§L the second step names the passkey and offers no app",
        e.methods.passkeyNames[0] === "Chrome on macOS" && !e.methods.authenticatorApp,
      );
    }
  }
  ok("§L a password sign-in still stops at the second step", challenge.startsWith("mfac_"));
  ok("§L with no app, no 6-digit code is accepted", !(await verifyMfaForLogin(uid, "123456")).ok);

  const stepOpts = json(await post("/auth/login/mfa/passkey-options", { challenge }));
  ok(
    "§L the second step's options list only this person's passkey",
    stepOpts.options?.allowCredentials?.length === 1 &&
      stepOpts.options.allowCredentials[0].id === pk.id,
  );
  const assertion = pk.get(stepOpts.options.challenge);
  const stepDone = await post("/auth/login/mfa/passkey", {
    challenge,
    handle: stepOpts.handle,
    response: assertion,
  });
  const stepSession = sessionFrom(stepDone);
  const stepRow = stepSession ? await sessionRow(stepSession) : undefined;
  ok(
    "§L a passkey finishes the second step",
    stepDone.statusCode === 200 && !!stepRow,
    stepDone.body,
  );
  ok("§L …and the session counts as 2FA", !!stepRow?.mfaAt && stepRow.authMethod === "password");
  const replayStep = await post("/auth/login/mfa/passkey", {
    challenge,
    handle: stepOpts.handle,
    response: assertion,
  });
  ok("§L a passkey assertion cannot be replayed", replayStep.statusCode !== 200);

  // Discoverable sign-in: no email, no password.
  const signInOpts = json(await post("/auth/passkey/options", {}));
  ok(
    "§L passkey sign-in options name no credential (the browser chooses)",
    (signInOpts.options?.allowCredentials ?? []).length === 0,
  );
  const signedIn = await post("/auth/passkey/verify", {
    handle: signInOpts.handle,
    response: pk.get(signInOpts.options.challenge),
  });
  const pkSession = sessionFrom(signedIn);
  const pkRow = pkSession ? await sessionRow(pkSession) : undefined;
  ok("§L a passkey signs in on its own", signedIn.statusCode === 200 && !!pkRow, signedIn.body);
  ok(
    "§L …recorded as a passkey sign-in that counts as 2FA",
    pkRow?.authMethod === "passkey" && !!pkRow?.mfaAt,
  );

  // Wrong origin / wrong RP ID: a phishing page's assertion is worthless.
  const evilOrigin = json(await post("/auth/passkey/options", {}));
  const evilO = await post("/auth/passkey/verify", {
    handle: evilOrigin.handle,
    response: pk.get(evilOrigin.options.challenge, { origin: "https://billing.evil.example" }),
  });
  ok("§L an assertion made on another origin is refused", evilO.statusCode === 400, evilO.body);
  const evilRp = json(await post("/auth/passkey/options", {}));
  const evilR = await post("/auth/passkey/verify", {
    handle: evilRp.handle,
    response: pk.get(evilRp.options.challenge, { rpId: "evil.example" }),
  });
  ok("§L an assertion for another RP ID is refused", evilR.statusCode === 400, evilR.body);

  // Counter regression: a cloned authenticator. Checked after the signature, then recorded.
  const cloneOpts = json(await post("/auth/passkey/options", {}));
  const clone = await post("/auth/passkey/verify", {
    handle: cloneOpts.handle,
    response: pk.get(cloneOpts.options.challenge, { counter: 1 }),
  });
  ok("§L a counter that went backwards is refused", clone.statusCode === 400, clone.body);
  const regression = await systemDb
    .select()
    .from(securityEvents)
    .where(
      and(eq(securityEvents.userId, uid), eq(securityEvents.kind, "passkey_counter_regression")),
    );
  ok("§L …and recorded on the security trail", regression.length === 1);
  pk.setCounter(10);

  // A synced passkey (always counter 0) works every time; adding it is "a method added".
  const synced = authenticator({ synced: true });
  const syncOpts = json(await post("/auth/mfa/passkeys/options", {}, s1.token));
  const syncAdd = await post(
    "/auth/mfa/passkeys",
    { handle: syncOpts.handle, response: synced.create(syncOpts.options), name: "Pixel 8" },
    s1.token,
  );
  const syncBody = json(syncAdd);
  ok(
    "§L a second passkey is added without new recovery codes",
    syncAdd.statusCode === 201 &&
      syncBody.recovery_codes === null &&
      syncBody.passkey?.name === "Pixel 8",
  );
  ok("§L …and it is marked synced", syncBody.passkey?.backedUp === true);
  let syncedOk = 0;
  for (let i = 0; i < 2; i++) {
    const o = json(await post("/auth/passkey/options", {}));
    if (
      (
        await post("/auth/passkey/verify", {
          handle: o.handle,
          response: synced.get(o.options.challenge),
        })
      ).statusCode === 200
    )
      syncedOk++;
  }
  ok("§L a synced passkey (counter always 0) signs in repeatedly", syncedOk === 2);

  // Rename: yours only.
  const syncedId = syncBody.passkey.id as string;
  const renamed = await app.inject({
    method: "PATCH",
    url: `/auth/mfa/passkeys/${syncedId}`,
    headers: { cookie: `tmb_session=${s1.token}`, "content-type": "application/json" },
    payload: { name: "  Work   phone " },
  });
  ok(
    "§L a passkey can be renamed (whitespace tidied)",
    renamed.statusCode === 200 && json(renamed).name === "Work phone",
    renamed.body,
  );
  await signup({
    email: `l-stranger-${uniq}@example.com`,
    password: PASSWORD,
    organizationName: `L2 ${uniq}`,
  });
  const strangerSess = await login(`l-stranger-${uniq}@example.com`, PASSWORD);
  const foreignRename = await app.inject({
    method: "PATCH",
    url: `/auth/mfa/passkeys/${syncedId}`,
    headers: { cookie: `tmb_session=${strangerSess.token}`, "content-type": "application/json" },
    payload: { name: "mine now" },
  });
  ok("§L nobody can rename someone else's passkey (404)", foreignRename.statusCode === 404);
  const foreignDelete = await app.inject({
    method: "DELETE",
    url: `/auth/mfa/passkeys/${syncedId}?confirm_turn_off=true`,
    headers: { cookie: `tmb_session=${strangerSess.token}` },
  });
  ok("§L …or remove it (404)", foreignDelete.statusCode === 404);

  // Another person's passkey cannot finish your second step.
  const strangerPk = authenticator();
  const sOpts = json(await post("/auth/mfa/passkeys/options", {}, strangerSess.token));
  await post(
    "/auth/mfa/passkeys",
    { handle: sOpts.handle, response: strangerPk.create(sOpts.options) },
    strangerSess.token,
  );
  let ch2 = "";
  try {
    await login(email, PASSWORD);
  } catch (e) {
    if (e instanceof MfaRequiredError) ch2 = e.challenge;
  }
  const crossOpts = json(await post("/auth/login/mfa/passkey-options", { challenge: ch2 }));
  const cross = await post("/auth/login/mfa/passkey", {
    challenge: ch2,
    handle: crossOpts.handle,
    response: strangerPk.get(crossOpts.options.challenge),
  });
  ok(
    "§L someone else's passkey cannot finish your second step",
    cross.statusCode === 404,
    cross.body,
  );

  // An authenticator app beside passkeys is "a method added"; removing it keeps 2FA on.
  const appSetup = await startMfaEnrollment({ userId: uid });
  const appConfirm = await confirmMfaEnrollment({ userId: uid, code: totp(appSetup.secret) });
  ok(
    "§L adding the app beside a passkey keeps the recovery codes",
    appConfirm.recoveryCodes === null && !appConfirm.replaced,
  );
  ok(
    "§L …and the status shows both",
    (await mfaStatus(uid)).authenticatorApp && (await mfaStatus(uid)).passkeys.length === 2,
  );
  const appGone = await app.inject({
    method: "DELETE",
    url: "/auth/mfa/totp",
    headers: { cookie: `tmb_session=${s1.token}` },
  });
  ok(
    "§L removing the app keeps 2FA on through the passkeys",
    appGone.statusCode === 200 &&
      json(appGone).confirmed === true &&
      json(appGone).authenticatorApp === false,
    appGone.body,
  );

  // The org gate counts a passkey-only person as having 2FA, and refuses their last removal.
  const turnedOn = await setOrganizationRequireMfa({
    organizationId: person.user.organizationId,
    actorUserId: uid,
    enabled: true,
  });
  ok("§L a passkey-only owner can require 2FA for the organization", turnedOn.changed);
  const standing = await standingInOrganization(uid, person.user.organizationId);
  ok(
    "§L …and counts as satisfying it",
    standing.required && standing.satisfied && !standing.blocked,
  );
  const pkId = (await mfaStatus(uid)).passkeys.find((p) => p.name === "Chrome on macOS")!.id;
  await app.inject({
    method: "DELETE",
    url: `/auth/mfa/passkeys/${syncedId}`,
    headers: { cookie: `tmb_session=${s1.token}` },
  });
  const lastWhileRequired = await app.inject({
    method: "DELETE",
    url: `/auth/mfa/passkeys/${pkId}?confirm_turn_off=true`,
    headers: { cookie: `tmb_session=${s1.token}` },
  });
  ok(
    "§L the last method cannot be removed while the organization requires 2FA",
    lastWhileRequired.statusCode === 409 &&
      json(lastWhileRequired).error?.type === "organization_requires_two_factor",
    lastWhileRequired.body,
  );
  await setOrganizationRequireMfa({
    organizationId: person.user.organizationId,
    actorUserId: uid,
    enabled: false,
  });

  // The last method: refused without confirm_turn_off; with it, 2FA turns off like disableMfa.
  const kinds = (
    await systemDb.select().from(securityEvents).where(eq(securityEvents.userId, uid))
  ).map((e) => e.kind);
  ok(
    "§L adding and removing passkeys is on the security trail",
    kinds.includes("two_factor_enabled") &&
      kinds.includes("two_factor_method_added") &&
      kinds.includes("two_factor_method_removed"),
  );
  const noConfirm = await app.inject({
    method: "DELETE",
    url: `/auth/mfa/passkeys/${pkId}`,
    headers: { cookie: `tmb_session=${s1.token}` },
  });
  ok(
    "§L removing the last method needs explicit confirmation (409)",
    noConfirm.statusCode === 409 && json(noConfirm).error?.type === "last_two_factor_method",
    noConfirm.body,
  );
  const off = await app.inject({
    method: "DELETE",
    url: `/auth/mfa/passkeys/${pkId}?confirm_turn_off=true`,
    headers: { cookie: `tmb_session=${s1.token}` },
  });
  ok(
    "§L …with it, 2FA turns off",
    off.statusCode === 200 && json(off).confirmed === false && !(await hasConfirmedMfa(uid)),
    off.body,
  );
  ok(
    "§L …and other browsers are signed out",
    !(await resolveSession(s2.token)) && !!(await resolveSession(s1.token)),
  );
  const left = await systemDb.select().from(userPasskeys).where(eq(userPasskeys.userId, uid));
  ok("§L …and no passkey is left behind", left.length === 0);
  const afterOff = json(await post("/auth/passkey/options", {}));
  const deadPk = await post("/auth/passkey/verify", {
    handle: afterOff.handle,
    response: pk.get(afterOff.options.challenge),
  });
  ok(
    "§L a removed passkey no longer signs in (404 so the browser forgets it)",
    deadPk.statusCode === 404,
    deadPk.body,
  );
  await flushSecurityMail();
  ok(
    "§L the person is emailed when a passkey is added",
    captured.some((m) => m.to === email && /^New passkey on your account$/.test(m.subject)),
  );
  const trail = JSON.stringify(
    await systemDb.select().from(securityEvents).where(eq(securityEvents.userId, uid)),
  );
  ok(
    "§L no ceremony challenge lands on the security trail",
    ![regOpts.options.challenge, stepOpts.options.challenge].some((c) => trail.includes(c)),
  );

  // ── § M · step-up on 2FA management (2026-11-04, audit P2-PASSKEY) ──
  {
    const as = (token: string) => ({
      cookie: `tmb_session=${token}`,
      "content-type": "application/json",
    });
    const call = (
      method: "POST" | "DELETE" | "GET" | "PATCH",
      url: string,
      token: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        headers: as(token),
        ...(method === "GET" ? {} : { payload: (payload ?? {}) as Record<string, unknown> }),
      });
    const staleAt = () => new Date(Date.now() - (config.STEP_UP_WINDOW_MINUTES + 1) * 60_000);
    const makeStale = (token: string) =>
      systemDb
        .update(sessions)
        .set({ stepUpAt: staleAt() })
        .where(eq(sessions.tokenHash, hash(token)));
    const refused = (r: { statusCode: number; body: string }) => {
      if (r.statusCode !== 403) return false;
      const e = (JSON.parse(r.body) as { error?: { type?: string; code?: string } }).error;
      return e?.type === "step_up_required" && e.code === "step_up_required";
    };
    const stepUpWith = (token: string, body: Record<string, string>) =>
      call("POST", "/auth/step_up", token, body);
    await clearMeters();

    const mEmail = `m-su-${uniq}@example.com`;
    const mp = await signup({ email: mEmail, password: PASSWORD, organizationName: `M ${uniq}` });
    const mUid = mp.user.userId;
    const ms = await login(mEmail, PASSWORD);
    const msRow = await sessionRow(ms.token);
    ok("§M a sign-in stamps the session as stepped up", !!msRow?.stepUpAt);
    ok(
      "§M …and GET /auth/step_up reports it fresh",
      json(await call("GET", "/auth/step_up", ms.token)).fresh === true,
    );
    const firstEnrol = await call("POST", "/auth/mfa/enroll", ms.token);
    ok(
      "§M a freshly signed-in person can start their first factor",
      firstEnrol.statusCode === 201,
      firstEnrol.body,
    );

    // Stale: every management route refuses, before it reads its body.
    await makeStale(ms.token);
    const gated: Array<[string, () => ReturnType<typeof call>]> = [
      ["POST /auth/mfa/enroll", () => call("POST", "/auth/mfa/enroll", ms.token)],
      ["POST /auth/mfa/disable", () => call("POST", "/auth/mfa/disable", ms.token)],
      ["POST /auth/mfa/recovery_codes", () => call("POST", "/auth/mfa/recovery_codes", ms.token)],
      [
        "POST /auth/mfa/passkeys/options",
        () => call("POST", "/auth/mfa/passkeys/options", ms.token),
      ],
      [
        "POST /auth/mfa/passkeys",
        () => call("POST", "/auth/mfa/passkeys", ms.token, { handle: "x", response: {} }),
      ],
      [
        "DELETE /auth/mfa/passkeys/:id",
        () => call("DELETE", "/auth/mfa/passkeys/00000000-0000-0000-0000-000000000000", ms.token),
      ],
      ["DELETE /auth/mfa/totp", () => call("DELETE", "/auth/mfa/totp", ms.token)],
    ];
    for (const [name, run] of gated) {
      const r = await run();
      ok(
        `§M a stale session is refused ${name} with step_up_required`,
        refused(r),
        `${r.statusCode} ${r.body}`,
      );
    }
    // Not management: still a session and nothing else.
    ok(
      "§M …GET /auth/mfa is not gated",
      (await call("GET", "/auth/mfa", ms.token)).statusCode === 200,
    );
    ok("§M …nor GET /auth/me", (await call("GET", "/auth/me", ms.token)).statusCode === 200);
    ok(
      "§M …nor GET /v1/businesses",
      (await call("GET", "/v1/businesses", ms.token)).statusCode === 200,
    );
    ok(
      "§M …nor PATCH /auth/mfa/passkeys/:id (rename)",
      !refused(
        await call("PATCH", "/auth/mfa/passkeys/00000000-0000-0000-0000-000000000000", ms.token, {
          name: "x",
        }),
      ),
    );

    // Step up with the password (no 2FA yet), then the setup goes through.
    ok(
      "§M a wrong password does not step up",
      (await stepUpWith(ms.token, { password: "Wrong-Horse-Battery-9" })).statusCode === 400,
    );
    ok(
      "§M the correct password steps up",
      (await stepUpWith(ms.token, { password: PASSWORD })).statusCode === 200,
    );
    const enrolled = json(await call("POST", "/auth/mfa/enroll", ms.token));
    const mConfirm = await call("POST", "/auth/mfa/confirm", ms.token, {
      code: totp(String(enrolled.secret)),
    });
    ok(
      "§M …then enrol + confirm turn 2FA on",
      mConfirm.statusCode === 200 && (await hasConfirmedMfa(mUid)),
      mConfirm.body,
    );
    ok(
      "§M …and recovery codes can be replaced",
      (await call("POST", "/auth/mfa/recovery_codes", ms.token)).statusCode === 201,
    );
    const mpk = authenticator();
    const mOpts = await call("POST", "/auth/mfa/passkeys/options", ms.token);
    const mAdd = await call("POST", "/auth/mfa/passkeys", ms.token, {
      handle: json(mOpts).handle,
      response: mpk.create(json(mOpts).options),
    });
    ok(
      "§M …and a passkey can be added",
      mOpts.statusCode === 200 && mAdd.statusCode === 201,
      mAdd.body,
    );

    // Enrolled now: the step-up must be the CODE, and it re-opens removal and disable.
    await clearMeters();
    await makeStale(ms.token);
    await systemDb.update(userMfa).set({ lastUsedStep: null }).where(eq(userMfa.userId, mUid));
    ok(
      "§M an enrolled person cannot step up with the password",
      (await stepUpWith(ms.token, { password: PASSWORD })).statusCode === 400,
    );
    ok(
      "§M …and can with their code",
      (await stepUpWith(ms.token, { code: totp(String(enrolled.secret)) })).statusCode === 200,
    );
    const pkGone = await call("DELETE", `/auth/mfa/passkeys/${json(mAdd).passkey.id}`, ms.token);
    ok("§M …then a passkey can be removed", pkGone.statusCode === 200, pkGone.body);
    const mOff = await call("POST", "/auth/mfa/disable", ms.token);
    ok(
      "§M …and 2FA can be disabled",
      mOff.statusCode === 200 && !(await hasConfirmedMfa(mUid)),
      mOff.body,
    );

    // An organization switch is not a sign-in: it carries the stamp, it does not refresh it.
    const swEmail = `m-sw-${uniq}@example.com`;
    const swA = await signup({
      email: swEmail,
      password: PASSWORD,
      organizationName: `M-A ${uniq}`,
    });
    const swB = await signup({
      email: `m-swb-${uniq}@example.com`,
      password: PASSWORD,
      organizationName: `M-B ${uniq}`,
    });
    await systemDb.insert(memberships).values({
      organizationId: swB.user.organizationId,
      userId: swA.user.userId,
      role: "developer",
    });
    const swSess = await login(swEmail, PASSWORD);
    await makeStale(swSess.token);
    const [orgB] = await systemDb
      .select()
      .from(organizations)
      .where(eq(organizations.id, swB.user.organizationId));
    const switched = await switchOrganization(swSess.token, orgB!.publicId);
    ok(
      "§M an organization switch does not refresh a stale step-up",
      refused(await call("POST", "/auth/mfa/enroll", switched.token)),
    );

    // The organization requires 2FA and the deadline has passed: the member must still enrol.
    const ownEmail = `m-own-${uniq}@example.com`;
    const own = await signup({
      email: ownEmail,
      password: PASSWORD,
      organizationName: `M-O ${uniq}`,
    });
    const os = await startMfaEnrollment({ userId: own.user.userId });
    await confirmMfaEnrollment({ userId: own.user.userId, code: totp(os.secret) });
    await setOrganizationRequireMfa({
      organizationId: own.user.organizationId,
      actorUserId: own.user.userId,
      enabled: true,
    });
    const memEmail = `m-mem-${uniq}@example.com`;
    const mem = await signup({
      email: memEmail,
      password: PASSWORD,
      organizationName: `M-M ${uniq}`,
    });
    await systemDb.insert(memberships).values({
      organizationId: own.user.organizationId,
      userId: mem.user.userId,
      role: "developer",
      // The 2FA grace period runs from acceptance (0498), so backdate both.
      createdAt: new Date(Date.now() - 60 * 86_400_000),
      acceptedAt: new Date(Date.now() - 60 * 86_400_000),
    });
    await systemDb
      .update(users)
      .set({ lastOrganizationId: own.user.organizationId })
      .where(eq(users.id, mem.user.userId));
    await systemDb
      .update(organizations)
      .set({ mfaRequiredSince: new Date(Date.now() - 30 * 86_400_000) })
      .where(eq(organizations.id, own.user.organizationId));
    const memSess = await login(memEmail, PASSWORD);
    ok(
      "§M a member past the organization's 2FA deadline is blocked",
      json(await call("GET", "/auth/me", memSess.token)).organization_two_factor?.blocked === true,
    );
    const blockedEnrol = await call("POST", "/auth/mfa/enroll", memSess.token);
    ok(
      "§M …and straight after sign-in can still start setup (no step-up prompt)",
      blockedEnrol.statusCode === 201,
      blockedEnrol.body,
    );
    const blockedPk = await call("POST", "/auth/mfa/passkeys/options", memSess.token);
    ok("§M …or add a passkey", blockedPk.statusCode === 200, blockedPk.body);
    await makeStale(memSess.token);
    ok(
      "§M …a stale blocked session is asked to step up, not locked out",
      refused(await call("POST", "/auth/mfa/enroll", memSess.token)) &&
        (await stepUpWith(memSess.token, { password: PASSWORD })).statusCode === 200 &&
        (await call("POST", "/auth/mfa/enroll", memSess.token)).statusCode === 201,
    );
    await clearMeters();
  }

  setMailer(null);
  await flushSecurityMail();
  await clearMeters();
}

await clearCounters();
await app.close();
let pass = true;
for (const [n, c, detail] of checks) {
  // The detail rides on FAILURES only: on a passing line it is noise, and on a failing
  // one it is usually the entire finding.
  console.log(`  ${c ? "✓" : "✗"} ${n}${!c && detail ? ` — ${detail}` : ""}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ AUTH IDENTITY: PASS" : "❌ AUTH IDENTITY: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
