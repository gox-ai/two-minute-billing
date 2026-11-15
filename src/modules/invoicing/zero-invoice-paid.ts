import type { Tx } from "@/platform/db";
import type { EmitEventInput } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  loadBillingRulesRow,
  resolveBillingRulesConfig,
  type ZeroInvoicePaidEvent,
} from "@/modules/subscriptions/billing-rules-config";

/**
 * `zero_invoice_paid_event`: does a new invoice with a total of zero send `invoice_paid`?
 * `oneOff` is the invoice's source (a one-time sale, a manual invoice, a credit purchase or an
 * automatic top-up), never `subscription_id IS NULL`: an ad-hoc charge can carry a subscription.
 */
export function zeroInvoiceSendsPaid(rule: ZeroInvoicePaidEvent, oneOff: boolean): boolean {
  return rule === "all" || (rule === "one_off" && oneOff);
}

/**
 * The `invoice_paid` (amount 0) for an invoice issued paid with a total of zero, or null when the
 * business's rule leaves it out. Call it once, where the invoice is first issued, so an invoice
 * issued before the rule changed never gets one.
 */
export async function zeroInvoicePaidEvent(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    oneOff: boolean;
    invoice: { publicId: string; currency: string };
  },
): Promise<EmitEventInput | null> {
  const row = await loadBillingRulesRow(input.organizationId, input.businessId, tx);
  if (!zeroInvoiceSendsPaid(resolveBillingRulesConfig(row).zeroInvoicePaidEvent, input.oneOff))
    return null;
  return {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type: "invoice_paid",
    data: buildEventData("invoice_paid", {
      id: input.invoice.publicId,
      amount_minor: 0,
      currency: input.invoice.currency,
    }),
  };
}
