"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { toMinor } from "@/lib/money";
import { updateBusiness } from "@/lib/api/business-settings";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/**
 * Billing rules → Short payments and declined refunds (2.12, 2.15). Posts
 * `shortfall:<CUR>` amounts in major units (blank = off) and `declined_refund`.
 */
export async function saveCollectionRulesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const writeOff: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("shortfall:")) continue;
    const cur = k.slice("shortfall:".length).toUpperCase();
    const raw = String(v).trim();
    if (!raw) continue;
    const major = Number(raw);
    const minor = Number.isFinite(major) ? toMinor(major, cur) : NaN;
    if (!/^[A-Z]{3}$/.test(cur) || !Number.isSafeInteger(minor) || minor < 1)
      errors.shortfall = `Enter an amount for ${cur} that is more than zero, or leave it blank.`;
    else writeOff[cur] = minor;
  }
  const pct = Number(str(fd, "shortfall_max_percent"));
  if (!Number.isInteger(pct) || pct < 1 || pct > 10)
    errors.shortfall_max_percent = "Enter a whole number of percent from 1 to 10.";
  if (Object.values(writeOff).some((m) => m > 100_000))
    errors.shortfall =
      "Enter an amount of 100,000 minor units or less (1,000.00 in most currencies).";
  if (Object.keys(errors).length) return actionError("Correct the highlighted fields.", { errors });
  const declined = str(fd, "declined_refund");
  if (declined !== "block" && declined !== "issue_credit")
    return actionError("Select what happens to a declined refund.");
  const version = Number(str(fd, "expected_version"));
  const res = await updateBusiness(biz, {
    billing_rules_config: {
      partial_payment_write_off: writeOff,
      partial_payment_write_off_max_percent: pct,
      declined_refund: declined,
    },
    ...(Number.isInteger(version) && version > 0 ? { expected_version: version } : {}),
  });
  revalidatePath(`/businesses/${biz}/settings`);
  if (res.ok) return actionOk("Billing rules saved.");
  if (res.status === 409)
    return actionError(res.error ?? "Someone changed this business after you opened it.", {
      code: "conflict",
    });
  return actionError(res.error ?? "We could not save the billing rules.");
}
