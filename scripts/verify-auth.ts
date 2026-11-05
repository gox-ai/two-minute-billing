/**
 * Portal auth + RBAC verification:
 *  - signup creates org + owner user + session,
 *  - login with correct password works; wrong password rejected,
 *  - session resolves to the right user/org/role; logout invalidates it,
 *  - duplicate email rejected,
 *  - invite adds a user with a role; RBAC (legacyAllows) matches the role,
 *  - password is never stored in plaintext,
 *  - the shared password policy refuses short, common, sequential and email-derived
 *    passwords, consults an injectable breach lookup, and is actually reached by signup.
 *
 *   pnpm verify:auth
 */
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";
import {
  signup,
  login,
  resolveSession,
  logout,
  inviteUser,
  acceptInvite,
  loginWithGoogle,
  changePassword,
  AuthError,
} from "@/modules/auth/service";
import { legacyAllows } from "@/modules/auth/permissions";
import { rejectPassword, PASSWORD_MIN } from "@/modules/auth/password-policy";
import {
  sweepLoginAttempts,
  startMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
  MfaRequiredError,
  completeMfaLogin,
  mfaStatus,
} from "@/modules/auth/service";
import { totp } from "@/modules/auth/totp";
import { LIMITS } from "@/api/limits";
import { config } from "@/platform/config";
import { users, authTokens, loginAttempts, sessions, userMfa } from "@db/schema";

const uniq = Date.now().toString().slice(-8);
const checks: Array<[string, boolean]> = [];

// 1) signup
const s = await signup({
  email: `owner${uniq}@a.com`,
  password: "Sparrow-Lantern-9134",
  name: "Owner",
  organizationName: "Acme Inc",
});
checks.push(["signup returns session token", s.token.startsWith("sess_")]);
checks.push(["signup role = owner", s.user.role === "owner"]);
checks.push(["signup created org", s.user.organizationPublicId.startsWith("org_")]);

// 2) password is hashed, not plaintext
const [row] = await systemDb.select().from(users).where(eq(users.id, s.user.userId)).limit(1);
checks.push([
  "password not plaintext",
  !!row?.passwordHash &&
    !row.passwordHash.includes("Sparrow-Lantern-9134") &&
    row.passwordHash.startsWith("scrypt$"),
]);

// 3) login correct + wrong
const li = await login(`owner${uniq}@a.com`, "Sparrow-Lantern-9134");
checks.push(["login correct password", li.user.userId === s.user.userId]);
let wrongRejected = false;
try {
  await login(`owner${uniq}@a.com`, "wrongpassword");
} catch (e) {
  wrongRejected = e instanceof AuthError;
}
checks.push(["wrong password rejected", wrongRejected]);

// 4) session resolve + logout
const resolved = await resolveSession(li.token);
checks.push([
  "session resolves to user",
  resolved?.userId === s.user.userId && resolved?.role === "owner",
]);
await logout(li.token);
const afterLogout = await resolveSession(li.token);
checks.push(["logout invalidates session", afterLogout === null]);

// 5) duplicate email
let dupRejected = false;
try {
  await signup({ email: `owner${uniq}@a.com`, password: "anotherpass1", organizationName: "Dup" });
} catch (e) {
  dupRejected = e instanceof AuthError;
}
checks.push(["duplicate email rejected", dupRejected]);

// 6) invite + RBAC
//
// The inviter no longer chooses a password (0197): the invitee sets their own by spending
// an emailed single-use token. So the account exists but CANNOT be signed into until then,
// and this suite mints its own token to walk the accept step — the plaintext is never
// recoverable from the row, by design.
const opsUser = await inviteUser({
  organizationId: s.user.organizationId,
  email: `ops${uniq}@a.com`,
  role: "ops",
});
checks.push(["invited ops user", opsUser.role === "ops"]);

const [invitedRow] = await systemDb
  .select()
  .from(users)
  .where(eq(users.id, opsUser.userId))
  .limit(1);
checks.push(["invited user has NO password until they set one", invitedRow?.passwordHash === null]);
const beforeAccept = await login(`ops${uniq}@a.com`, "Sparrow-Lantern-9134")
  .then(() => true)
  .catch(() => false);
checks.push(["an unaccepted invite cannot log in", beforeAccept === false]);

const inviteToken = `invt_${randomBytes(32).toString("base64url")}`;
await systemDb.insert(authTokens).values({
  userId: opsUser.userId,
  tokenHash: createHash("sha256").update(inviteToken).digest("hex"),
  purpose: "invite",
  expiresAt: new Date(Date.now() + 3600_000),
});
const accepted = await acceptInvite(inviteToken, "Sparrow-Lantern-9134");
checks.push(["accepting the invite signs them in", accepted.user.role === "ops"]);
checks.push([
  "…and marks the address verified",
  Boolean(
    (await systemDb.select().from(users).where(eq(users.id, opsUser.userId)).limit(1))[0]
      ?.emailVerifiedAt,
  ),
]);
const replayed = await acceptInvite(inviteToken, "somethingelse123")
  .then(() => true)
  .catch(() => false);
checks.push(["the invite token cannot be spent twice", replayed === false]);

const opsLogin = await login(`ops${uniq}@a.com`, "Sparrow-Lantern-9134");
checks.push(["invited user can log in once accepted", opsLogin.user.role === "ops"]);

// 6b) settling an invite with GOOGLE instead of a password (2026-09-02)
//
// Setting a password is no longer mandatory for an invitee. `inviteUser` commits the
// membership immediately, so Google sign-in resolves the invited user by the address Google
// asserts — the backend already allowed this; the invite screen just never offered it.
//
// The assertion that matters is the LAST one. Signing in with Google leaves the emailed link
// unspent unless something spends it, and that link sets a password with no other proof of
// identity — so an unconsumed row here is a live takeover of an account already in use.
const gEmail = `google${uniq}@a.com`;
const gInvited = await inviteUser({
  organizationId: s.user.organizationId,
  email: gEmail,
  role: "ops",
});
const gToken = `invt_${randomBytes(32).toString("base64url")}`;
const gTokenHash = createHash("sha256").update(gToken).digest("hex");
await systemDb.insert(authTokens).values({
  userId: gInvited.userId,
  tokenHash: gTokenHash,
  purpose: "invite",
  expiresAt: new Date(Date.now() + 3600_000),
});
const gSignedIn = await loginWithGoogle({
  googleSub: `google-sub-${uniq}`,
  email: gEmail,
  emailVerified: true,
  name: "Google Invitee",
});
checks.push([
  "an invited user signs in with Google without ever setting a password",
  gSignedIn.user.role === "ops",
]);
const [gRow] = await systemDb.select().from(users).where(eq(users.id, gInvited.userId)).limit(1);
checks.push(["…and still holds NO password hash afterwards", gRow?.passwordHash === null]);
const [gTokenRow] = await systemDb
  .select()
  .from(authTokens)
  .where(eq(authTokens.tokenHash, gTokenHash))
  .limit(1);
checks.push([
  "…and the emailed invite link is SPENT, not left live",
  Boolean(gTokenRow?.consumedAt),
]);
const gReplay = await acceptInvite(gToken, "Sparrow-Lantern-9134")
  .then(() => true)
  .catch(() => false);
checks.push(["…so that link can no longer set a password on the account", gReplay === false]);

// 6c) a Google-only operator can SET a password, with no current one to give (2026-09-02)
//
// `changePassword` refused a NULL hash outright until today, so an invitee who settled with
// Google could never acquire a password — and § 6b just spent their invite token, so there was
// no other route left. This is now the only one, which is why it is asserted rather than assumed.
const gNewPw = "Kestrel-Harbour-7781";
const gSetPw = await changePassword({ userId: gInvited.userId, newPassword: gNewPw })
  .then(() => true)
  .catch(() => false);
checks.push(["a passwordless account sets a password with no current one", gSetPw]);
checks.push(["…and can then sign in with it", !!(await login(gEmail, gNewPw)).token]);
// The other direction still holds: once there IS a hash, a wrong current password is refused.
const gWrongCurrent = await changePassword({
  userId: gInvited.userId,
  currentPassword: "Not-The-Password-1",
  newPassword: "Something-Else-9912",
})
  .then(() => true)
  .catch(() => false);
checks.push(["…and from then on a WRONG current password is refused", gWrongCurrent === false]);

// RBAC matrix
checks.push(["owner can admin", legacyAllows("owner", "admin")]);
checks.push(["ops cannot admin", !legacyAllows("ops", "admin")]);
checks.push(["ops can ops", legacyAllows("ops", "ops")]);
checks.push(["developer cannot ops", !legacyAllows("developer", "ops")]);
checks.push([
  "manager can ops, not admin",
  legacyAllows("manager", "ops") && !legacyAllows("manager", "admin"),
]);

// ── the second factor (audit M3) ───────────────────────────────────────────────
{
  const mEmail = `mfa${uniq}@a.com`;
  const mPw = "Correct-Horse-Battery-9";
  const mu = await signup({
    email: mEmail,
    password: mPw,
    name: "MFA",
    organizationName: `MFA ${uniq}`,
  });

  // Nothing changes until someone opts in — MFA is not mandatory for anyone yet.
  checks.push(["M3: a user without MFA logs in unchanged", !!(await login(mEmail, mPw)).token]);

  const enrol = await startMfaEnrollment({ userId: mu.user.userId });
  checks.push([
    "M3: enrolment returns a scannable otpauth URI",
    enrol.otpauthUri.startsWith("otpauth://totp/"),
  ]);

  // UNCONFIRMED enrolment must NOT gate login. This is the check that stops a botched QR scan
  // locking someone out of their own account, which is why enrolment is two steps at all.
  checks.push([
    "M3: an UNCONFIRMED enrolment does not gate login",
    !!(await login(mEmail, mPw)).token,
  ]);

  let badConfirm = false;
  try {
    await confirmMfaEnrollment({ userId: mu.user.userId, code: "000000" });
  } catch (e) {
    badConfirm = e instanceof AuthError;
  }
  checks.push(["M3: confirming with a wrong code is refused", badConfirm]);

  const confirmed = await confirmMfaEnrollment({
    userId: mu.user.userId,
    code: totp(enrol.secret),
  });
  const recoveryCodes = confirmed.recoveryCodes ?? [];
  checks.push(["M3: confirming returns ten recovery codes", recoveryCodes.length === 10]);
  // A code is accepted once per 30-second step (0326). Clearing the recorded step stands in for
  // the clock moving on, so each check below can use the current code.
  const nextStep = () =>
    systemDb.update(userMfa).set({ lastUsedStep: null }).where(eq(userMfa.userId, mu.user.userId));
  await nextStep();

  // From here the password alone is not enough.
  let needsCode = false;
  try {
    await login(mEmail, mPw);
  } catch (e) {
    needsCode = e instanceof MfaRequiredError;
  }
  checks.push(["M3: after confirming, the password alone is refused", needsCode]);

  let wrongCode = false;
  try {
    await login(mEmail, mPw, {}, "000000");
  } catch (e) {
    wrongCode = e instanceof AuthError;
  }
  checks.push(["M3: a wrong code is refused", wrongCode]);

  await nextStep();
  checks.push([
    "M3: the right code signs in",
    !!(await login(mEmail, mPw, {}, totp(enrol.secret))).token,
  ]);

  // The CHALLENGE flow: the password's success is carried by a short-lived single-use token, so
  // the second step posts only the code and the password is never re-sent.
  let challenge = "";
  try {
    await login(mEmail, mPw);
  } catch (e) {
    if (e instanceof MfaRequiredError) challenge = e.challenge;
  }
  checks.push([
    "M3: a challenge is issued when the code is missing",
    challenge.startsWith("mfac_"),
  ]);

  let badChallengeCode = false;
  try {
    await completeMfaLogin(challenge, "000000");
  } catch (e) {
    badChallengeCode = e instanceof AuthError;
  }
  checks.push(["M3: a wrong code against the challenge is refused", badChallengeCode]);

  // A WRONG code must NOT spend the challenge — a mistyped digit deserves another try inside
  // the same window, and the lockout is what bounds the guessing.
  await nextStep();
  checks.push([
    "M3: …and does NOT spend the challenge",
    !!(await completeMfaLogin(challenge, totp(enrol.secret))).token,
  ]);

  let replayed = false;
  await nextStep();
  try {
    await completeMfaLogin(challenge, totp(enrol.secret));
  } catch (e) {
    replayed = e instanceof AuthError;
  }
  checks.push(["M3: a spent challenge cannot be replayed", replayed]);

  let bogus = false;
  try {
    await completeMfaLogin("mfac_not_a_real_token", totp(enrol.secret));
  } catch (e) {
    bogus = e instanceof AuthError;
  }
  checks.push(["M3: an unknown challenge is refused", bogus]);

  // A recovery code works ONCE — consumed by removal, so single-use is a property of the row.
  const rc = recoveryCodes[0]!;
  checks.push(["M3: a recovery code signs in", !!(await login(mEmail, mPw, {}, rc)).token]);
  let spent = false;
  try {
    await login(mEmail, mPw, {}, rc);
  } catch (e) {
    spent = e instanceof AuthError;
  }
  checks.push(["M3: …and cannot be used twice", spent]);

  // The secret is stored ENCRYPTED — a database dump must not yield working second factors.
  const [mfaRow] = await systemDb
    .select()
    .from(userMfa)
    .where(eq(userMfa.userId, mu.user.userId))
    .limit(1);
  checks.push([
    "M3: the TOTP secret is not stored in clear",
    !!mfaRow?.secretEnc && !mfaRow.secretEnc.includes(enrol.secret),
  ]);
  checks.push([
    "M3: …and a recovery code is only stored hashed",
    !!mfaRow && !JSON.stringify(mfaRow.recoveryCodesHashed).includes(rc.replace(/-/g, "")),
  ]);

  // ⚠ Disabling takes a SESSION AND NOTHING ELSE as of 2026-09-02 (our user's instruction).
  // What stood here was the opposite assertion — 'disabling without the password is refused' —
  // and its comment said why: a stolen session must not be able to remove the control that
  // exists because sessions get stolen. That is now an accepted risk, recorded in
  // .claude/SECURITY_TODO.md. Asserted in the new direction rather than deleted, so the
  // rollback is a fact this suite states out loud instead of a silent absence.
  const before = await mfaStatus(mu.user.userId);
  checks.push([
    "M3: status reports a confirmed factor and the codes left",
    before.confirmed && before.recoveryCodesLeft === 9,
  ]);

  await disableMfa({ userId: mu.user.userId });
  checks.push([
    "M3: disabling needs no password at all — a session is enough",
    !(await mfaStatus(mu.user.userId)).enrolled,
  ]);
  checks.push([
    "M3: after disabling, the password alone works again",
    !!(await login(mEmail, mPw)).token,
  ]);
  checks.push(["M3: …and status reports it gone", !(await mfaStatus(mu.user.userId)).enrolled]);
}

// ── the authentication audit trail (audit M5) ──────────────────────────────────
// The point of this table is that §9.1's alerts have data to run on and that an incident can
// be reconstructed afterwards. So the checks are about what is RECORDED, and about the one
// thing that must never be: the address in clear.
{
  const trailEmail = `trail${uniq}@a.com`;
  const trailPw = "Correct-Horse-Battery-9";
  const emailHash = createHash("sha256").update(trailEmail).digest("hex");
  const rowsFor = () =>
    systemDb.select().from(loginAttempts).where(eq(loginAttempts.emailHash, emailHash));

  const tu = await signup({
    email: trailEmail,
    password: trailPw,
    name: "Trail",
    organizationName: `Trail ${uniq}`,
  });

  // An unknown address: recorded, with no user attached.
  await login(`nobody${uniq}@a.com`, trailPw, { ip: "203.0.113.9", userAgent: "probe/1" }).catch(
    () => null,
  );
  const unknownHash = createHash("sha256").update(`nobody${uniq}@a.com`).digest("hex");
  const [unknown] = await systemDb
    .select()
    .from(loginAttempts)
    .where(eq(loginAttempts.emailHash, unknownHash));
  checks.push([
    "M5: an unknown address is recorded as unknown_user",
    unknown?.outcome === "unknown_user",
  ]);
  checks.push(["M5: …with no user attached", unknown?.userId === null]);
  checks.push(["M5: …and carries the address it came from", unknown?.ip === "203.0.113.9"]);

  // A wrong password against a KNOWN account.
  await login(trailEmail, "Wrong-Horse-Battery-9", { ip: "203.0.113.10" }).catch(() => null);
  const bad = (await rowsFor()).find((r) => r.outcome === "bad_password");
  checks.push(["M5: a wrong password is recorded as bad_password", !!bad]);
  checks.push(["M5: …attributed to the user", bad?.userId === tu.user.userId]);

  // Success, which is what makes "did anything succeed?" answerable.
  const okLogin = await login(trailEmail, trailPw, { ip: "203.0.113.11", userAgent: "browser/2" });
  const good = (await rowsFor()).find((r) => r.outcome === "success");
  checks.push(["M5: a SUCCESSFUL login is recorded too", !!good]);

  // The standard's own checklist row, previously unimplementable.
  const [after] = await systemDb.select().from(users).where(eq(users.id, tu.user.userId)).limit(1);
  checks.push(["M5: lastLoginAt is stamped", !!after?.lastLoginAt]);
  checks.push(["M5: lastLoginIp is stamped", after?.lastLoginIp === "203.0.113.11"]);

  // M7's residue: the session records where it began.
  const [sess] = await systemDb
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, createHash("sha256").update(okLogin.token).digest("hex")))
    .limit(1);
  checks.push(["M5: the session records its creation IP", sess?.createdIp === "203.0.113.11"]);
  checks.push(["M5: …and the user agent", sess?.userAgent === "browser/2"]);

  // THE ONE THAT MATTERS. A table listing every address anyone tried to sign in as would be
  // an account directory; hashing keeps the "same target, many attempts" query and removes it.
  const all = await rowsFor();
  checks.push([
    "M5: the address is never stored in clear",
    all.length > 0 && !JSON.stringify(all).includes(trailEmail),
  ]);

  // Retention (§9.3). Backdate one row past the window and sweep.
  await systemDb
    .update(loginAttempts)
    .set({ at: new Date(Date.now() - (config.LOGIN_ATTEMPT_RETENTION_DAYS + 1) * 86_400_000) })
    .where(and(eq(loginAttempts.emailHash, emailHash), eq(loginAttempts.outcome, "bad_password")));
  const swept = await sweepLoginAttempts();
  const remaining = await rowsFor();
  checks.push(["M5: the sweep drops rows past retention", swept.deleted >= 1]);
  checks.push([
    "M5: …and keeps the recent ones",
    remaining.some((r) => r.outcome === "success") &&
      !remaining.some((r) => r.outcome === "bad_password"),
  ]);
}

// ── password hashing format (audit L1) ─────────────────────────────────────────
// The self-describing format is the actual fix: it is what lets SCRYPT_COST_LOG2 be raised
// without invalidating a single stored password, so the cost is a config knob rather than a
// migration. These checks pin both halves of that — the new format, and the old one still
// working plus being upgraded in place.
{
  const N = 1 << config.SCRYPT_COST_LOG2;
  const [fresh] = await systemDb.select().from(users).where(eq(users.id, s.user.userId)).limit(1);
  checks.push([
    "hash records its own parameters",
    !!fresh?.passwordHash?.startsWith(`scrypt$${N}$8$1$`),
  ]);

  // A pre-L1 row: `salt:hash` hex at Node's defaults, written straight into the column.
  const legacyEmail = `legacy${uniq}@a.com`;
  const legacyPw = "Sparrow-Lantern-9134";
  const lg = await signup({
    email: legacyEmail,
    password: legacyPw,
    name: "Legacy",
    organizationName: "Legacy Ltd",
  });
  const legacySalt = randomBytes(16);
  const legacyHash = `${legacySalt.toString("hex")}:${scryptSync(legacyPw, legacySalt, 64).toString("hex")}`;
  await systemDb
    .update(users)
    .set({ passwordHash: legacyHash })
    .where(eq(users.id, lg.user.userId));

  const relogin = await login(legacyEmail, legacyPw);
  checks.push(["a pre-L1 salt:hash still verifies", relogin.user.userId === lg.user.userId]);

  const [upgraded] = await systemDb
    .select()
    .from(users)
    .where(eq(users.id, lg.user.userId))
    .limit(1);
  checks.push([
    "login upgrades a pre-L1 hash in place",
    !!upgraded?.passwordHash?.startsWith(`scrypt$${N}$`),
  ]);
  checks.push([
    "the upgraded hash still verifies",
    (await login(legacyEmail, legacyPw)).user.userId === lg.user.userId,
  ]);
}

// ── password policy (audit M4) ───────────────────────────────────────────────────
// The pure function, not the routes: it is the single place all five password-setting
// paths now agree on, so this is where the rules are worth pinning.
{
  const reject = (pw: string, email?: string) => rejectPassword(pw, email);

  // The third leg of the mirror. verify:form-validation §A holds src/api/limits.ts and
  // dashboard/lib/limits.ts to each other by parsing them as text, which cannot see this
  // module's constant — so the API table is checked against the rule that owns it here.
  checks.push([
    "policy: PASSWORD_MIN matches LIMITS.passwordMin",
    PASSWORD_MIN === LIMITS.passwordMin,
  ]);

  // Both sides of the floor, so moving PASSWORD_MIN cannot pass this suite by accident in
  // either direction. `Ab3-cde` satisfies every character class and is refused on length
  // alone; `Kq7-mvzp` is exactly the floor and accepted.
  checks.push(["policy: 7 chars refused", (await reject("Ab3-cde")) !== null]);
  checks.push(["policy: 8 chars accepted", (await reject("Kq7-mvzp")) === null]);
  checks.push([
    "policy: a long passphrase is still accepted",
    (await reject("Sparrow-Lantern-9134")) === null,
  ]);

  // §3.1's character classes, enforced ALONGSIDE the screening below rather than instead of
  // it. The pair matters: Password1! satisfies every composition rule ever written and is
  // refused by the blocklist, while a long passphrase satisfies the blocklist and is refused
  // here. Each catches what the other waves through.
  checks.push(["policy: no uppercase refused", (await reject("sparrow-lantern-9134")) !== null]);
  checks.push(["policy: no number refused", (await reject("Sparrow-Lantern-abcd")) !== null]);
  checks.push([
    "policy: no special character refused",
    (await reject("SparrowLantern9134")) !== null,
  ]);
  // One message, not one rule per round trip.
  const missingTwo = await reject("sparrowlanternnine");
  checks.push([
    "policy: a password missing two classes names both at once",
    !!missingTwo && missingTwo.includes("uppercase") && missingTwo.includes("special"),
  ]);

  // The point of a blocklist next to a length floor: this is 12 characters and would
  // sail past any length-only rule.
  checks.push([
    "policy: a COMMON 12-char password refused",
    (await reject("password1234")) !== null,
  ]);
  checks.push([
    "policy: repeated single character refused",
    (await reject("aaaaaaaaaaaaaa")) !== null,
  ]);
  checks.push(["policy: simple sequence refused", (await reject("abcdefghijklmn")) !== null]);

  // Local part only — the domain is deliberately not matched, or every password
  // containing the company name would be refused and people would append a digit.
  checks.push([
    "policy: email local part in password refused",
    (await reject("jshepherd-longpass", "jshepherd@example.com")) !== null,
  ]);
  checks.push([
    "policy: the DOMAIN is not matched",
    (await reject("example-Lantern-9134", "jshepherd@example.com")) === null,
  ]);

  // The breach lookup is injected, so the branch is covered without reaching
  // api.pwnedpasswords.com — a suite that does is slow, flaky, and fails offline.
  const hit = await rejectPassword("Sparrow-Lantern-9134", undefined, {
    breachCheckEnabled: true,
    breachLookup: async () => true,
  });
  checks.push(["policy: a breached password is refused when the check is ON", hit !== null]);

  const miss = await rejectPassword("Sparrow-Lantern-9134", undefined, {
    breachCheckEnabled: true,
    breachLookup: async () => false,
  });
  checks.push(["policy: an unbreached password passes with the check ON", miss === null]);

  // Fails OPEN: a thrown lookup must not stop someone setting a password.
  let openedOnError = false;
  try {
    openedOnError =
      (await rejectPassword("Sparrow-Lantern-9134", undefined, {
        breachCheckEnabled: true,
        breachLookup: async () => {
          throw new Error("HIBP unreachable");
        },
      })) === null;
  } catch {
    openedOnError = false;
  }
  checks.push(["policy: a FAILED breach lookup allows the password", openedOnError]);

  // And the service actually consults it — a policy nothing calls is a comment.
  let signupRefused = false;
  try {
    await signup({
      email: `weak${uniq}@a.com`,
      password: "password1234",
      name: "W",
      organizationName: "W Ltd",
    });
  } catch (e) {
    signupRefused = e instanceof AuthError;
  }
  checks.push(["policy: signup refuses a common password", signupRefused]);
}

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ AUTH + RBAC: PASS" : "❌ AUTH + RBAC: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
