/**
 * Input length bounds for the public API (W5).
 *
 * ── WHY ONE TABLE ───────────────────────────────────────────────────────────────
 * SR-2026-014 Finding 8 asks for exactly this: "Define a single shared table of field
 * limits and reference it from every input rather than repeating values." The version
 * of that finding written against the frontend blamed a "frontend/backend mismatch" and
 * the v1.1 revision corrected it — there WAS no backend limit to be mismatched with,
 * which made it worse rather than milder. Both halves import from here so neither can
 * be the one that forgot.
 *
 * ── WHY THESE NUMBERS ───────────────────────────────────────────────────────────
 * Each is chosen to be larger than any legitimate value and small enough that a
 * megabyte cannot be stored, rendered into a shared list, or fed to scrypt. Where a
 * standard exists it wins over taste: 254 for an address is RFC 5321, 128 for a
 * password is the NIST/OWASP ceiling.
 *
 * A bound that is too tight is a support ticket; a bound that is absent is the finding.
 * When unsure, prefer generous over none.
 */
import { z } from "zod";
import { MAX_AMOUNT_MAGNITUDE } from "@/platform/fixed";

export const LIMITS = {
  /**
   * A reference to another resource — our own public ids (`cus_…`, `price_…`), a
   * user-chosen catalog slug (capped at 100 by `SLUG_RE`), or a PROVIDER's token.
   * Generous because the last of those is not ours to predict: a Stripe setup token or
   * a PayPal approval id is opaque and has grown before.
   */
  id: 200,
  /** RFC 5321's maximum address length. */
  email: 254,
  /** Comfortably past any real link; short of a data: URI smuggled through a URL field. */
  url: 2000,
  /**
   * NIST SP 800-63B / OWASP. The ceiling matters more here than most: scrypt's cost
   * scales with input length and several password routes are UNAUTHENTICATED, which is
   * the CPU-amplification question SEC-004 turns on.
   */
  password: 128,
  /**
   * FLOOR, not a ceiling — the one entry in this table that is a minimum, so read the
   * name and not the position. Mirrors `PASSWORD_MIN` in
   * `src/modules/auth/password-policy.ts`, which owns the rule, and
   * `dashboard/lib/limits.ts`, which `verify:form-validation` §A holds to this number.
   *
   * A literal rather than an import because §A parses these files as TEXT — an imported
   * identifier here would not read as a number and the parity check would go quiet, which
   * is worse than a duplicated 12. `verify:auth` asserts the third leg.
   */
  passwordMin: 8,
  /** A person, business or product name. Matches the widest such column we have. */
  name: 255,
  /** A short human code — coupon codes, reason codes, tax codes. */
  code: 100,
  /** Line items in one request (subscription items, credit note lines). */
  lineItems: 500,
  /** A sentence or two shown next to the thing it describes. */
  description: 2000,
  /** Operator prose: invoice notes, internal comments, cancellation reasons. */
  notes: 5000,
  /** One line of a postal address. */
  addressLine: 200,

  /**
   * The rest of a postal address. These values are NOT invented here — they are copied
   * from `portalMeBody` in `customer-portal-routes.ts`, which already had them.
   *
   * That body carries a comment saying it is "kept in lock-step with the operator edit
   * (addressBody in customer-routes.ts)", and it was not: the buyer-facing copy bounded
   * every field and the operator-facing one bounded none. Two schemas described as
   * matching, drifting quietly — the same shape of defect as the sanitizer comment in
   * SR-2026-015 Finding 4. Importing from here is what makes the claim true rather
   * than aspirational.
   */
  city: 100,
  state: 100,
  stateCode: 10,
  postalCode: 20,
  personName: 100,
  company: 200,
  phone: 50,

  /** Units of one subscription item. Integers only; `.int().positive()` stays at the call site. */
  quantity: 1000000,
  /** One money amount (minor units) or one usage quantity: 10^12. */
  amountMinor: MAX_AMOUNT_MAGNITUDE,
} as const;

/**
 * A coupon code a buyer types. Checked only where a code is SET — apply and lookup take
 * any stored code, because imported codes may predate this rule.
 */
export const COUPON_CODE_RE = /^[A-Za-z0-9_-]+$/;
export const couponCodeField = () =>
  z
    .string()
    .min(1)
    .max(LIMITS.code)
    .regex(
      COUPON_CODE_RE,
      "code may contain only letters, digits, underscores (_) and hyphens (-)",
    );

/**
 * A reference to another resource. `.min(1)` because an empty id is never a lookup, it
 * is a caller who forgot to send the field and would otherwise get a confusing 404.
 */
export const refId = () => z.string().min(1).max(LIMITS.id);

/** An email address, bounded to the RFC length. */
export const emailField = () => z.string().email().max(LIMITS.email);

/**
 * A URL we will store and later put in front of someone — a return URL, a webhook
 * endpoint, a merchant logo.
 *
 * **Scheme-restricted, which `z.string().url()` alone is not.** Zod's `.url()` accepts
 * anything `new URL()` parses, and that includes `javascript:` and `data:`. Neither has
 * any business in a field we hand back to a browser: a `javascript:` URL in an `<a
 * href>` is script execution, and a `data:text/html` one is a same-origin document an
 * attacker wrote. The fields that reach an `<img src>` are harmless today, but "the
 * absence of a vulnerable sink today is not a control" (SR-2026-016 Finding 3), and the
 * sink is one refactor away from existing.
 */
export const httpUrl = () =>
  z
    .string()
    .url()
    .max(LIMITS.url)
    .refine((v) => /^https?:\/\//i.test(v), { message: "URL must use http or https" });

/**
 * A URL a BUYER'S BROWSER will be sent to — `return_url`, `cancel_url`, redirects.
 *
 * Deliberately more permissive than `httpUrl()`, and the difference is the point. A
 * checkout that finishes inside a mobile app returns to a custom scheme
 * (`myapp://billing/done`), which is a legitimate redirect target and not something we
 * get to refuse: it was accepted before these fields were validated at all, so
 * narrowing them to http(s) turned a working integration into a 400 for no security
 * gain. That regression is what this helper exists to avoid.
 *
 * What it DOES refuse is the set that can execute in the page that follows the
 * redirect — `javascript:`, `data:`, `vbscript:`, plus `file:`/`blob:` which have no
 * business being a return target. That is the actual content of SR-2026-016 Finding 3;
 * "http(s) only" was a broader rule than the finding needed.
 *
 * A DENY list rather than an allow list, because the space of legitimate app schemes is
 * open-ended (one per merchant app) while the dangerous set is small, known and closed.
 */
const EXECUTABLE_SCHEMES = ["javascript:", "data:", "vbscript:", "file:", "blob:"] as const;

export const redirectUrl = () =>
  z
    .string()
    .url()
    .max(LIMITS.url)
    .refine((v) => !EXECUTABLE_SCHEMES.some((bad) => v.trim().toLowerCase().startsWith(bad)), {
      message: "URL must not use a javascript:, data:, vbscript:, file: or blob: scheme",
    });

/**
 * Free-form key/value metadata.
 *
 * Bounded on THREE axes, because capping the values alone still admits a request with
 * fifty thousand keys. The serialized-size cap is the one that actually protects storage
 * — the key/value caps are there so a single enormous entry is rejected with a message
 * naming the field rather than a size nobody can act on.
 */
export const metadataField = () =>
  z
    .record(z.string().max(64), z.unknown())
    .refine((m) => Object.keys(m).length <= 50, { message: "metadata is limited to 50 keys" })
    .refine((m) => JSON.stringify(m).length <= 16_000, {
      message: "metadata is limited to 16KB serialized",
    });

/**
 * What a gateway's browser SDK handed back for a `next_action.mode: 'sdk'` challenge,
 * passed to the adapter as it is. Opaque strings: a payment nonce or a signed response
 * is a few KB at most.
 */
export const clientResultField = () =>
  z
    .record(z.string().min(1).max(64), z.string().max(8000))
    .refine((m) => Object.keys(m).length <= 20, {
      message: "client_result is limited to 20 keys",
    });

/** The buyer accepted the ACH authorization text with this version (`ach_authorization`). */
export const achAuthorizationField = () =>
  z.object({ text_version: z.string().min(1).max(64), accepted: z.literal(true) });
