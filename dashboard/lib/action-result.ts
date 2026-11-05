import { z } from "zod";
import { COUPON_CODE_RE, LIMITS } from "@/lib/limits";

/**
 * Standard return shape for form server actions used with <ActionForm>.
 * A create returns `redirectTo` (via actionOk) so the form can land on the new record.
 */
export interface ActionResult {
  ok: boolean;
  /** Toasted on completion (success or error). */
  message?: string;
  /** Per-field validation errors, keyed by input name. */
  errors?: Record<string, string>;
  /** 'conflict' → the toast offers a Reload action (CP-0 optimistic concurrency).
   *  'step_up_required' → the caller asks the operator to confirm their identity, then retries. */
  code?: "conflict" | "step_up_required";
  /** A success with a caveat the operator must see (the action stood, a side-effect didn't). */
  warning?: boolean;
  /** Success only: the record the action created — the form lands there. */
  redirectTo?: string;
  /** Failure only: the engine's `Request-Id`; the toast links to that request log row. */
  requestId?: string;
}

export const actionOk = (message?: string, redirectTo?: string): ActionResult => ({
  ok: true,
  message,
  ...(redirectTo ? { redirectTo } : {}),
});
export const actionError = (message: string, extra?: Partial<ActionResult>): ActionResult => ({
  ok: false,
  message,
  ...extra,
});

/** Flatten a ZodError into { field: firstMessage } for inline display. */
export function zodFieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** Parse a FormData against a schema → { data } | ActionResult with field errors. */
export function parseForm<T extends z.ZodType>(
  schema: T,
  formData: FormData,
): { data: z.infer<T>; error?: never } | { data?: never; error: ActionResult } {
  const raw: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("$")) continue; // framework internals
    raw[k] = v;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: {
        ok: false,
        message: "Correct the highlighted fields.",
        errors: zodFieldErrors(parsed.error),
      },
    };
  }
  return { data: parsed.data };
}

/** Slug shape the catalog/coupon engine accepts for a user-supplied id/code — mirrors
 *  `SLUG_RE` in `src/api/catalog-routes.ts`. Keep the two in sync. Case-PRESERVING: the
 *  engine widened to mixed case in 2026-08 (imported ids are mixed case), and
 *  this mirror stayed lowercase-only, so the dashboard rejected ids the API accepts. */
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A required slug id/code field (product/price/coupon ids), matching the engine's shape. */
export function slugField(label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(100, `${label} must be 100 characters or fewer`)
    .regex(
      SLUG_RE,
      `${label} must start with a letter or number, using only letters, numbers, dot, underscore or dash`,
    );
}

/** A required coupon code: stricter than a slug — no dots, no leading-character rule. */
export function couponCodeField(label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(LIMITS.code, `${label} must be ${LIMITS.code} characters or fewer`)
    .regex(COUPON_CODE_RE, `${label} must use only letters, digits, underscores or hyphens`);
}

/**
 * Coerce a form string into an integer, applying min/max with a field-specific message.
 * `''`/absent → `undefined` (never `NaN`) — a money/quantity field stays optional at the
 * schema level; callers add a `.refine` for "required when model X" business rules.
 */
export function numberFromForm(opts: { min?: number; max?: number; message?: string } = {}) {
  const { min, max, message } = opts;
  return z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const s = v.trim();
      if (s === "") return undefined;
      const n = Number(s);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: "custom", message: message ?? "Enter a whole number" });
        return z.NEVER;
      }
      if (min !== undefined && n < min) {
        ctx.addIssue({ code: "custom", message: message ?? `Must be at least ${min}` });
        return z.NEVER;
      }
      if (max !== undefined && n > max) {
        ctx.addIssue({ code: "custom", message: message ?? `Must be at most ${max}` });
        return z.NEVER;
      }
      return n;
    });
}
