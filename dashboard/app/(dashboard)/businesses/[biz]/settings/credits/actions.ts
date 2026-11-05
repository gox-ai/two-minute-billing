"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { updateCreditConfig } from "@/lib/api/credits";

const minor = z.number().int().min(0);
const currencyMap = <T extends z.ZodType>(v: T) => z.record(z.string().regex(/^[A-Z]{3}$/), v);

const configSchema = z
  .object({
    hold_default_seconds: z
      .number({ message: "Enter the hold time in seconds." })
      .int("Enter whole seconds.")
      .min(1, "Enter 1 second or more.")
      .max(86_400, "Enter 86,400 seconds (24 hours) or fewer."),
    in_flight_share_bps: z
      .number({ message: "Enter a percentage." })
      .int()
      .min(1, "Enter a percentage from 0.01 to 100.")
      .max(10_000, "Enter a percentage from 0.01 to 100."),
    blocking_enabled: z.boolean(),
    on_exhausted_default: z.enum(["block", "bill"]),
    overdraft_limit_minor: currencyMap(minor),
    top_up_limits: currencyMap(
      z.object({ min_minor: minor.nullable().optional(), max_minor: minor.nullable().optional() }),
    ),
    grant_limits: currencyMap(
      z.object({
        max_minor: minor.nullable().optional(),
        alert_above_minor: minor.nullable().optional(),
      }),
    ),
    default_tax_treatment: z.enum(["taxed_at_purchase", "taxed_at_use"]).nullable(),
    credit_scope: z
      .union([
        z.object({ kind: z.literal("meters"), meters: z.array(z.string()) }),
        z.object({ kind: z.literal("prices"), prices: z.array(z.string()).min(1) }),
      ])
      .nullable(),
  })
  .superRefine((c, ctx) => {
    if (c.credit_scope?.kind === "meters" && c.credit_scope.meters.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["credit_scope"],
        message: "Select one or more meters, or select every usage line.",
      });
    for (const [cur, l] of Object.entries(c.top_up_limits))
      if (l.min_minor != null && l.max_minor != null && l.min_minor > l.max_minor)
        ctx.addIssue({
          code: "custom",
          path: [`top_up_${cur}`],
          message: `The minimum for ${cur} must not be more than the maximum.`,
        });
  });

/** Settings → Credits: writes `businesses.credit_config` whole. */
export async function saveCreditConfigAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  await requirePermission("credits:manage", "ops");
  const biz = String(fd.get("biz") ?? "");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  let raw: unknown;
  try {
    raw = JSON.parse(String(fd.get("config") ?? ""));
  } catch {
    return actionError("We could not read the settings. Reload the page.");
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      const key = String(i.path[0] ?? "_form");
      errors[key] ??= i.message;
    }
    return actionError("Correct the highlighted fields.", { errors });
  }
  const version = Number(fd.get("expected_version") ?? "") || undefined;
  const res = await updateCreditConfig(biz, parsed.data, version);
  revalidatePath(`/businesses/${biz}/settings/credits`);
  revalidatePath(`/businesses/${biz}/settings`);
  if (!res.ok)
    return actionError(res.error ?? "We could not save the credit settings.", {
      requestId: res.requestId,
      ...(res.status === 409 ? { code: "conflict" as const } : {}),
    });
  return actionOk("Credit settings saved.");
}
