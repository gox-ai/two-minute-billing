"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { updateBusiness, type BusinessSettingsPatch } from "@/lib/api/business-settings";
import { toMinor } from "@/lib/money";

// Billing rules → the invoice rules (`invoice_rules_config`, 0486). Each page posts only its
// own keys; the engine merges them into the stored config.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function save(
  biz: string,
  rules: NonNullable<BusinessSettingsPatch["invoice_rules_config"]>,
  fd: FormData,
  label: string,
): Promise<ActionResult> {
  const body: BusinessSettingsPatch = { invoice_rules_config: rules };
  const ev = Number(str(fd, "expected_version"));
  if (Number.isInteger(ev) && ev > 0) body.expected_version = ev;
  const res = await updateBusiness(biz, body);
  revalidatePath(`/businesses/${biz}/settings`);
  if (res.ok) return actionOk(`${label} saved`);
  if (res.status === 409)
    return actionError(res.error ?? "Someone changed this business after you opened it.", {
      code: "conflict",
    });
  return actionError(res.error ?? `We could not save the ${label.toLowerCase()}.`);
}

/** `amount_<CUR>` fields in major units → minor units. Empty = no amount for that currency. */
function amountsFrom(fd: FormData, errors: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of str(fd, "currencies")
    .split(",")
    .filter((x) => /^[A-Z]{3}$/.test(x))) {
    const raw = str(fd, `amount_${c}`);
    if (!raw) continue;
    const major = Number(raw);
    const minor = Number.isFinite(major) ? toMinor(major, c) : NaN;
    if (!Number.isFinite(minor) || minor <= 0) errors[`amount_${c}`] = "Enter an amount above 0";
    else out[c] = minor;
  }
  return out;
}

/** Billing rules → Small invoices. */
export async function saveSmallInvoicesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const action = str(fd, "small_invoice_action");
  if (action !== "charge" && action !== "write_off")
    return actionError("Select what we do with a small invoice.");
  const errors: Record<string, string> = {};
  const thresholds = amountsFrom(fd, errors);
  if (action === "write_off" && Object.keys(thresholds).length === 0)
    errors[`amount_${str(fd, "currencies").split(",")[0] ?? ""}`] =
      "Enter a limit for at least one currency";
  if (Object.keys(errors).length) return actionError("Correct the highlighted fields.", { errors });
  return save(
    biz,
    { small_invoice_action: action, small_invoice_thresholds: thresholds },
    fd,
    "Small invoices",
  );
}

/** Billing rules → Payment terms: when we charge an auto-collected invoice with net terms. */
export async function saveChargeTimingAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const timing = str(fd, "charge_timing");
  if (timing !== "at_creation" && timing !== "on_due_date")
    return actionError("Select when we charge the invoice.");
  return save(biz, { charge_timing: timing }, fd, "Charge timing");
}
