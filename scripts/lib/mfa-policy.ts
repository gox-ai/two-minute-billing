import { config } from "@/platform/config";

/**
 * Pin the MFA mandate OFF for a suite that is not about the MFA mandate (audit M3.1).
 *
 * ── WHY THIS IS NEEDED, AND WHY IT IS NOT A CHEAT ───────────────────────────────
 * `MFA_REQUIRED_ROLES=owner,admin` is a real deployment policy, and every suite reads the same
 * `.env`. `signup()` mints an OWNER, so the moment that setting is present, every suite that
 * authenticates as an operator session finds `/v1/*` refused with `mfa_enrollment_required` —
 * and it does not fail with "you must enrol", it fails as whatever the suite was actually
 * asserting. Measured the hour the setting went in: `verify:dashboard-credential` came back with
 * four failures including "the two orgs are distinguishable at all", which is nothing to do with
 * MFA and reads like a tenancy bug.
 *
 * So the choice is not "pin it off or test it properly" — it is "pin it off explicitly, or have
 * every session-driven suite silently become a test of the MFA policy". The policy itself is
 * covered by `verify:security` § M, which sets it ON and OFF in-process and asserts both.
 *
 * ── WHY PINNED RATHER THAN INHERITED ────────────────────────────────────────────
 * A suite whose result depends on an ambient environment variable passes or fails by accident of
 * how the machine happens to be configured. That is the same defect as a suite that reads global
 * state and passes only by accident of ordering. Pinning states the assumption in the file that
 * relies on it, so a standalone run and a `verify:all` run behave identically.
 *
 * Call it BEFORE building the app or creating fixtures. `config.MFA_REQUIRED_ROLES` is read on
 * every `roleRequiresMfa` call, so mutating the array is enough — there is no cached copy.
 */
export function pinMfaMandateOff(): void {
  config.MFA_REQUIRED_ROLES.length = 0;
}

/**
 * Enrol a confirmed second factor for a fixture operator, and sign them in with it.
 *
 * ── WHY `pinMfaMandateOff` IS NOT ENOUGH FOR EVERY SUITE ────────────────────────
 * The pin mutates `config` in the CALLING process. That is sufficient for a suite that builds
 * the app in-process with `buildApp`, because the guard then runs in that same process. It does
 * NOTHING for a suite that talks to a RUNNING server over HTTP: the policy is read by the
 * server, which loaded its own `.env`. Measured — `verify:dashboard-credential` still came back
 * `403/403` on "a session alone authenticates" with the pin in place, because the refusal was
 * happening in the API on :4300, not in the script.
 *
 * So HTTP suites do not suppress the policy, they COMPLY with it: the fixture operator enrols a
 * real TOTP factor. That is better than suppression anyway — it works whether the deployment
 * mandates MFA or not, so the suite stops depending on ambient configuration entirely.
 */
export async function enrolAndSignIn(input: {
  userId: string;
  email: string;
  password: string;
}): Promise<{ token: string; secret: string }> {
  const { startMfaEnrollment, confirmMfaEnrollment, login } =
    await import("@/modules/auth/service");
  const { totp } = await import("@/modules/auth/totp");
  const { secret } = await startMfaEnrollment({ userId: input.userId });
  await confirmMfaEnrollment({ userId: input.userId, code: totp(secret) });
  // The factor is confirmed, so `login` now REQUIRES the code. A code works once (0326), and
  // confirming spent this step's — sign in with the next step's, still inside the skew window.
  const { token } = await login(
    input.email,
    input.password,
    undefined,
    totp(secret, new Date(Date.now() + 30_000)),
  );
  return { token, secret };
}
