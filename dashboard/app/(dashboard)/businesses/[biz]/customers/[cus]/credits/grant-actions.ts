"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { apiWrite } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";
import { stepsFromUnits, VOID_REASON_OPTIONS, zeroOrMoreMessage } from "@/lib/credit-settings";
import { removeCustomerOverdraftLimit, setCustomerOverdraftLimit } from "@/lib/api/credit-settings";

const creditsPath = (biz: string, cus: string) => `/businesses/${biz}/customers/${cus}/credits`;
const REASONS = VOID_REASON_OPTIONS.map((o) => o.value) as [string, ...string[]];

const voidSchema = z
  .object({
    biz: z.string().min(1),
    cus: z.string().min(1),
    grant: z.string().min(1),
    reason: z.enum(REASONS, { message: "Select a reason." }),
    note: z.string().trim().max(500, "Enter 500 characters or fewer.").optional(),
    /** "on" for a paid grant: the dialog asks only for a void with no refund. */
    paid: z.string().optional(),
    without_refund: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.paid === "on" && v.without_refund !== "on")
      ctx.addIssue({
        code: "custom",
        path: ["without_refund"],
        message:
          "Select Void without a refund. To give money back, create a credit note on the invoice.",
      });
    if (v.reason === "other" && !v.note)
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "Enter a note for the reason Other.",
      });
  });

/** Void a grant with the reason the operator selected. A paid grant: with no refund only. */
export async function voidGrantWithReasonAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const parsed = parseForm(voidSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const res = await apiWrite(
    `/v1/businesses/${encodeURIComponent(d.biz)}/customers/${encodeURIComponent(d.cus)}/credit_grants/${encodeURIComponent(d.grant)}/void`,
    {
      reason: d.reason,
      ...(d.note ? { note: d.note } : {}),
      ...(d.paid === "on" ? { without_refund: true } : {}),
    },
    "POST",
  );
  revalidatePath(creditsPath(d.biz, d.cus));
  if (!res.ok)
    return actionError(res.error ?? "We could not void the credit grant.", {
      requestId: res.requestId,
    });
  return actionOk("Credit grant voided.");
}

const overdraftSchema = z.object({
  biz: z.string().min(1),
  cus: z.string().min(1),
  unit: z.string().min(1),
  decimals: z.coerce.number().int().min(0).max(4),
  /** Empty = remove the customer's own limit. */
  limit: z.string().trim().optional(),
});

/** Set or remove a customer's own overdraft limit in a unit. */
export async function saveCustomerOverdraftAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const parsed = parseForm(overdraftSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  if (!d.limit) {
    const res = await removeCustomerOverdraftLimit(d.biz, d.cus, d.unit);
    revalidatePath(creditsPath(d.biz, d.cus));
    if (!res.ok)
      return actionError(res.error ?? "We could not remove the overdraft limit.", {
        requestId: res.requestId,
      });
    return actionOk("Overdraft limit removed.");
  }
  const steps = stepsFromUnits(d.limit, d.decimals);
  if (steps === null)
    return actionError("Correct the highlighted fields.", {
      errors: { limit: zeroOrMoreMessage(d.decimals) },
    });
  const res = await setCustomerOverdraftLimit(d.biz, d.cus, d.unit, steps);
  revalidatePath(creditsPath(d.biz, d.cus));
  if (!res.ok)
    return actionError(res.error ?? "We could not save the overdraft limit.", {
      requestId: res.requestId,
    });
  return actionOk("Overdraft limit saved.");
}
