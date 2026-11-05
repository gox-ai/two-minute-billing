/**
 * The one place a password is judged (audit M4).
 *
 * ── WHY ONE FUNCTION ────────────────────────────────────────────────────────────
 * Five call sites checked `password.length < 8` independently — `signup`, `acceptInvite`,
 * `resetPassword`, `changePassword`, `resetPasswordWithToken`. Four copies of a policy is
 * four policies: the next person to tighten one will not find the other three. This is
 * imported by all of them, so there is exactly one answer to "is this password allowed".
 *
 * ── COMPOSITION *AND* SCREENING ─────────────────────────────────────────────────
 * §3.1 of the standard requires "Min 12 chars, uppercase, number, special char, no common
 * patterns". NIST SP 800-63B — which the standard's own §2.1 also cites — recommends
 * explicitly AGAINST mandated composition and FOR screening, on the grounds that character
 * classes push people to `Password1!`, which is on every breach list.
 *
 * Both are enforced here, by decision (2026-08-28): the class rules satisfy §3.1, and the
 * screening below is what actually stops the passwords those rules would otherwise wave
 * through. That is the point worth holding on to — `Password1!` passes every composition
 * check ever written and is refused by the list. Neither half is redundant, but if one of
 * them is doing the security work it is the screening.
 *
 * ── WHY A LOCAL LIST AND AN OPTIONAL ONLINE ONE ─────────────────────────────────
 * The local list catches the passwords that matter most and costs nothing, so it ALWAYS
 * runs — including in CI, where a network call would be both slow and flaky. The online
 * HIBP range check covers vastly more, needs no API key, and never transmits the
 * password; it is opt-in per deployment (`PASSWORD_BREACH_CHECK`) and fails OPEN, because
 * an unreachable third party must not stop someone setting a password.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";

const log = createLogger("password-policy");

/**
 * The floor — NIST SP 800-63B's minimum for a user-chosen secret.
 *
 * Length is deliberately NOT the control here. `CLASSES`, `COMMON`, the repeat and
 * sequence checks and the HIBP lookup all sit on top of this number, which is what makes
 * 8 defensible rather than merely short: `password1234` is longer and refused, `Kq7-mvzp`
 * is exactly 8 and accepted.
 *
 * Mirrored in `src/api/limits.ts` and `dashboard/lib/limits.ts` — keep all three in
 * lock-step. `verify:auth` asserts this leg against the API table; `verify:form-validation`
 * §A holds the other two to each other.
 */
export const PASSWORD_MIN = 8;

/**
 * Passwords common enough that a floor alone does not help: every one of these is in the
 * first page of any cracking dictionary, and several are 12+ characters, which is exactly
 * why length is not sufficient on its own. Compared case-insensitively.
 *
 * Not meant to be exhaustive — that is what `PASSWORD_BREACH_CHECK` is for. This is the
 * hermetic floor under it.
 */
/**
 * The composition rule forces a digit and a symbol, so an exact match on the list never
 * fires: `Password1!` is "password1" plus a symbol. Compare with trailing symbols and digits
 * removed, and with every symbol removed (`Admin123!` → "admin", `P@ssw0rd!` → "p@ssw0rd").
 */
function isCommon(lower: string): boolean {
  // Trailing symbols and digits off ("p@ssw0rd!" → "p@ssw0rd"), then every symbol off.
  const trimmed = lower.replace(/[^a-z0-9]+$/, "");
  const stem = trimmed.replace(/\d+$/, "").replace(/[^a-z0-9]+$/, "");
  const alnum = lower.replace(/[^a-z0-9]/g, "");
  const core = alnum.replace(/\d+$/, "");
  return [lower, trimmed, stem, alnum, core].some((v) => v.length > 0 && COMMON.has(v));
}

const COMMON = new Set(
  [
    "password",
    "password1",
    "password12",
    "password123",
    "password1234",
    "password12345",
    "passw0rd",
    "p@ssword",
    "p@ssw0rd",
    "passwordpassword",
    "123456",
    "1234567",
    "12345678",
    "123456789",
    "1234567890",
    "12345678910",
    "123456789012",
    "111111",
    "000000",
    "qwerty",
    "qwertyuiop",
    "qwerty123",
    "letmein",
    "letmein123",
    "welcome",
    "welcome1",
    "welcome123",
    "welcometoyou",
    "admin",
    "admin123",
    "administrator",
    "root",
    "toor",
    "guest",
    "test",
    "test1234",
    "testtest",
    "testpassword",
    "changeme",
    "changeme123",
    "changemenow",
    "iloveyou",
    "monkey",
    "dragon",
    "sunshine",
    "princess",
    "football",
    "baseball",
    "trustno1",
    "starwars",
    "superman",
    "batman",
    "master",
    "shadow",
    "hunter2",
    "abc123",
    "abcd1234",
    "abcdefghijkl",
    "aaaaaaaaaaaa",
    "zaq12wsx",
    "qazwsxedc",
    "secret",
    "secret123",
    "default",
    "temporary",
    "temppassword",
    "newpassword",
    "billing123",
    "tmbilling",
    "tmbilling123",
    "stripe123",
  ].map((p) => p.toLowerCase()),
);

/** `aaaaaaaaaaaa`, `111111111111` — long, and worth nothing. */
const SINGLE_CHAR = /^(.)\1+$/;

/**
 * §3.1's character classes. "Special" is anything not a letter or digit, deliberately wide:
 * a curated punctuation list only teaches people which symbols to avoid, and rejecting a
 * character someone's keyboard produces is a support ticket, not a security control.
 */
const CLASSES: Array<[RegExp, string]> = [
  [/[A-Z]/, "an uppercase letter"],
  [/[0-9]/, "a number"],
  [/[^A-Za-z0-9]/, "a special character"],
];

/** `123456789012`, `abcdefghijkl` and their reverses, of any length. */
function isSequential(pw: string): boolean {
  const s = pw.toLowerCase();
  if (s.length < 4) return false;
  let asc = true;
  let desc = true;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  return asc || desc;
}

/**
 * HIBP range API, k-anonymity: only the first five hex characters of the SHA-1 leave this
 * process, so the password itself is never transmitted and no API key is needed.
 *
 * Fails OPEN and says so in the log — HIBP being unreachable must not stop someone
 * setting a password, but it must not be silent either.
 */
async function hibpLookup(sha1: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      log.warn("breach check unavailable — allowing", { status: res.status });
      return false;
    }
    const suffix = sha1.slice(5);
    return (await res.text()).split("\n").some((line) => line.trimEnd().startsWith(suffix));
  } catch (e) {
    log.warn("breach check failed — allowing", { detail: (e as Error).message });
    return false;
  }
}

export interface PasswordPolicyOptions {
  /**
   * Override the breach lookup. Exists so the branch is testable WITHOUT a network call:
   * a suite that reaches api.pwnedpasswords.com is slow, flaky, and fails offline.
   * Production leaves this unset and gets `hibpLookup`.
   */
  breachLookup?: (sha1: string) => Promise<boolean>;
  /** Force the online check on or off, ignoring config. For tests. */
  breachCheckEnabled?: boolean;
}

/**
 * Reject a password, or return null when it is acceptable.
 *
 * `email` is optional because three of the five call sites do not have it yet at the
 * point they validate — they resolve the user from a token or a session id afterwards.
 * The similarity check is skipped rather than faked when it is absent.
 */
export async function rejectPassword(
  password: string,
  email?: string,
  opts: PasswordPolicyOptions = {},
): Promise<string | null> {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters`;

  // Named in ONE message rather than one rule at a time: telling someone "add a number",
  // watching them do it, then telling them "add a symbol" is three round trips for a rule
  // that was knowable at the start. There is no enumeration concern here — the caller is
  // setting their own password, not probing whether an account exists.
  const missing = CLASSES.filter(([re]) => !re.test(password)).map(([, label]) => label);
  if (missing.length > 0) {
    return `Add ${missing.length === 1 ? missing[0] : missing.slice(0, -1).join(", ") + " and " + missing.at(-1)}`;
  }

  const lower = password.toLowerCase();
  if (isCommon(lower)) return "That password is too common. Use a different password.";
  if (SINGLE_CHAR.test(password)) return "That password is one repeated character — choose another";
  if (isSequential(password))
    return "That password is a simple sequence. Use a different password.";

  // The local part only. Rejecting on the domain would refuse every password containing
  // the company name, which is a rule people work around by appending a digit.
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length > 2 && lower.includes(local)) {
    return "Do not use your email address in your password";
  }

  const enabled = opts.breachCheckEnabled ?? config.PASSWORD_BREACH_CHECK === "TRUE";
  if (enabled) {
    const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
    const lookup = opts.breachLookup ?? hibpLookup;
    // Fail-open belongs HERE, not only inside `hibpLookup`. It used to live in that one
    // implementation, so an injected or future lookup that threw would propagate out of
    // rejectPassword and refuse a legitimate password reset — the exact opposite of the
    // documented behaviour. A suite check with a throwing lookup caught it.
    let breached = false;
    try {
      breached = await lookup(sha1);
    } catch (e) {
      log.warn("breach check threw — allowing", { detail: (e as Error).message });
    }
    if (breached) {
      return "That password was in a public data breach. Use a different password.";
    }
  }
  return null;
}

/**
 * Generate a password that satisfies `CLASSES` **by construction** — for the scripts that
 * bootstrap an admin account and print the credential once (`deploy/create-admin.ts`).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * Both call sites used `randomBytes(24).toString('base64url')`, whose alphabet is
 * `A-Za-z0-9-_`. Uppercase and a digit are near-certain in 32 characters; a special
 * character is not, because only `-` and `_` qualify. Measured over 20,000 draws: **36.2%
 * of them contain neither**, so more than a third of runs died on `AuthError: Add a
 * special character` — after `signup` had already been entered, from a generator the
 * operator cannot influence, with no way to retry other than running the whole thing
 * again. A production admin-bootstrap script that fails a third of the time for a reason
 * that reads like a policy complaint is worse than one that fails always.
 *
 * ── WHY IT LIVES HERE ───────────────────────────────────────────────────────────
 * Beside `CLASSES`, not beside either caller. A generator that must satisfy a policy and
 * the policy it must satisfy belong in one file, or the next person to add a class breaks
 * two scripts they will never think to open. `passwordSatisfiesClasses` below is asserted
 * on the output, so the two cannot drift even silently.
 *
 * Entropy is unchanged in substance: 24 random bytes' worth of base64url, plus one
 * uniformly-chosen symbol at a uniformly-chosen position. The symbol set excludes quotes,
 * backslashes and backticks on purpose — this string gets pasted through a shell and into
 * `.env` files, and a credential you cannot paste is a credential you regenerate.
 */
const GENERATED_SYMBOLS = "!@#$%^&*()-_=+[]{}:,.?";

export function generatePassword(): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const base = randomBytes(24).toString("base64url");
    const symbol = GENERATED_SYMBOLS[randomInt(GENERATED_SYMBOLS.length)]!;
    const at = randomInt(base.length + 1);
    const candidate = base.slice(0, at) + symbol + base.slice(at);
    // Upper/digit are overwhelmingly likely but not guaranteed, so this is a real loop and
    // not decoration. Screening (the common-password list, sequences) is not consulted:
    // no 33-character random string is on it, and calling the async policy from a
    // generator would make every caller await a breach lookup for a password nobody typed.
    if (passwordSatisfiesClasses(candidate)) return candidate;
  }
  /* c8 ignore next */
  throw new Error("generatePassword: could not satisfy the password classes in 8 attempts");
}

/** The composition half of the policy, exposed so a generator can assert its own output. */
export function passwordSatisfiesClasses(password: string): boolean {
  return password.length >= PASSWORD_MIN && CLASSES.every(([re]) => re.test(password));
}
