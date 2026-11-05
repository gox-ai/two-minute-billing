/**
 * `businesses.credit_config` and `customers.credit_settings` (0464) as the API takes them.
 * Absent keys take the defaults in `policy.ts`; a PATCH replaces the object whole, null clears it.
 */
import { z } from "zod";
import type { BusinessCreditConfig, CustomerCreditSettings } from "@db/schema";
import { MAX_HOLD_SECONDS } from "./policy";

const currency = z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code in capitals");
const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const businessCreditConfigSchema = z
  .object({
    hold_default_seconds: z.number().int().min(1).max(MAX_HOLD_SECONDS).optional(),
    in_flight_share_bps: z.number().int().min(1).max(10_000).optional(),
    blocking_enabled: z.boolean().optional(),
    on_exhausted_default: z.enum(["block", "bill"]).optional(),
    overdraft_limit_minor: z.record(currency, minor).optional(),
    top_up_limits: z
      .record(
        currency,
        z
          .object({
            min_minor: minor.nullable().optional(),
            max_minor: minor.nullable().optional(),
          })
          .strict()
          .refine((l) => l.min_minor == null || l.max_minor == null || l.min_minor <= l.max_minor, {
            message: "min_minor must not be more than max_minor",
          }),
      )
      .optional(),
    // Free grants: refused above `max_minor`; audited and alerted above `alert_above_minor`.
    grant_limits: z
      .record(
        currency,
        z
          .object({
            max_minor: minor.nullable().optional(),
            alert_above_minor: minor.nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    default_tax_treatment: z.enum(["taxed_at_purchase", "taxed_at_use"]).nullable().optional(),
    // Credit scope (2.55): grants scoped to all usage pay only these prices or meters.
    credit_scope: z
      .union([
        z
          .object({
            kind: z.literal("prices"),
            prices: z.array(z.string().min(1).max(100)).min(1).max(100),
          })
          .strict(),
        z
          .object({
            kind: z.literal("meters"),
            meters: z.array(z.string().min(1).max(100)).min(1).max(100),
          })
          .strict(),
      ])
      .nullable()
      .optional(),
  })
  .strict();

export const customerCreditSettingsSchema = z
  .object({
    on_exhausted: z.enum(["block", "bill"]).nullable().optional(),
    overdraft_limit_minor: z.record(currency, minor).optional(),
    override_expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();

/** Drop null limit bounds so the stored shape matches `BusinessCreditConfig`. */
export function toBusinessCreditConfig(
  v: z.infer<typeof businessCreditConfigSchema> | null,
): BusinessCreditConfig | null {
  if (!v) return null;
  const { top_up_limits, grant_limits, ...rest } = v;
  return {
    ...rest,
    ...(grant_limits
      ? {
          grant_limits: Object.fromEntries(
            Object.entries(grant_limits).map(([cur, l]) => [
              cur,
              {
                ...(l.max_minor != null ? { max_minor: l.max_minor } : {}),
                ...(l.alert_above_minor != null ? { alert_above_minor: l.alert_above_minor } : {}),
              },
            ]),
          ),
        }
      : {}),
    ...(top_up_limits
      ? {
          top_up_limits: Object.fromEntries(
            Object.entries(top_up_limits).map(([cur, l]) => [
              cur,
              {
                ...(l.min_minor != null ? { min_minor: l.min_minor } : {}),
                ...(l.max_minor != null ? { max_minor: l.max_minor } : {}),
              },
            ]),
          ),
        }
      : {}),
  };
}

export function toCustomerCreditSettings(
  v: z.infer<typeof customerCreditSettingsSchema> | null,
): CustomerCreditSettings | null {
  return v ? { ...v } : null;
}
