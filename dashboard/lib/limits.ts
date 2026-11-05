/**
 * Input length bounds for dashboard forms — the mirror of `src/api/limits.ts`.
 *
 * ── WHY A MIRROR AND NOT AN IMPORT ──────────────────────────────────────────────
 * The dashboard is a separate TypeScript project: its `include` covers `dashboard/**`
 * and its only path alias is `@/*` → the dashboard root. Reaching into `src/api/` would
 * mean widening both, which changes how the Next build resolves every module — a real
 * change to buy one constant table.
 *
 * ── SO THE AGREEMENT IS CHECKED, NOT ASSERTED ───────────────────────────────────
 * `pnpm verify:form-validation` §A parses BOTH files and fails if any number differs.
 * That matters more than the duplication it permits. SR-2026-014 §2.2 is the case in
 * point: a report claimed a "frontend/backend mismatch" in length limits, and the v1.1
 * revision found there had been no backend limit at all — the two halves were described
 * as related and were not. A comment saying "keep these in sync" is the same promise
 * with nothing behind it.
 *
 * ── WHAT THESE ARE AND ARE NOT ──────────────────────────────────────────────────
 * These are USABILITY controls. The security control is the server's, and it is already
 * in place: every string the API accepts is bounded (W5) and gated at budget 0. A field
 * without `maxLength` here is a user who pastes 10,000 characters and only finds out
 * after a round trip — not an exposure.
 */

export const LIMITS = {
  /** A reference to another resource — public ids, catalog slugs, provider tokens. */
  id: 200,
  /** RFC 5321. */
  email: 254,
  url: 2000,
  /** NIST SP 800-63B / OWASP. */
  password: 128,
  /**
   * FLOOR, not a ceiling. Mirrors PASSWORD_MIN in src/modules/auth/password-policy.ts —
   * keep the two in lock-step, which is what verify:form-validation §A holds together.
   */
  passwordMin: 8,
  name: 255,
  code: 100,
  description: 2000,
  notes: 5000,
  addressLine: 200,
  city: 100,
  state: 100,
  stateCode: 10,
  postalCode: 20,
  personName: 100,
  company: 200,
  phone: 50,
} as const;

/** A new or changed coupon code. Mirrors `COUPON_CODE_RE` in src/api/limits.ts. */
export const COUPON_CODE_RE = /^[A-Za-z0-9_-]+$/;
