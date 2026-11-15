/**
 * `mid_term_coupons`: which mid-term invoices of a subscription take its coupons.
 *
 * A mid-term invoice sits inside the current period, so a coupon on it draws that period's
 * fixed-amount allowance and spends no period (`settlePeriodDiscount`). MRR is not touched.
 * A plan change (`changeSubscription`) always took the coupons and is not routed here.
 */
import type { Tx } from "@/platform/db";
import {
  loadBillingRulesRow,
  resolveBillingRulesConfig,
  type MidTermCoupons,
} from "./billing-rules-config";

/**
 * What raised the invoice:
 *  - `unbilled`: it bills queued unbilled charges,
 *  - `edit`: a subscription edit (term change),
 *  - `charge`: a charge invoiced at once (item add, activation, attached item, ad-hoc charge).
 */
export type MidTermInvoiceSource = "unbilled" | "edit" | "charge";

export function midTermCouponsApply(rule: MidTermCoupons, source: MidTermInvoiceSource): boolean {
  if (rule === "all") return true;
  return rule === "unbilled_and_edits" && source !== "charge";
}

/** The business's rule, resolved for one invoice source. */
export async function midTermCouponsFor(
  organizationId: string,
  businessId: string,
  source: MidTermInvoiceSource,
  tx?: Tx,
): Promise<boolean> {
  const row = await loadBillingRulesRow(organizationId, businessId, tx);
  return midTermCouponsApply(resolveBillingRulesConfig(row).midTermCoupons, source);
}
