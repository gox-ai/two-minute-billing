"use server";

import {
  getCustomer,
  listSubscriptions,
  listInvoices,
  listPaymentMethods,
  getRenewalEstimate,
  listCustomerExcessPayments,
  type Customer,
  type ExcessPayment,
  type Subscription,
  type Invoice,
  type PaymentMethod,
  type RenewalEstimate,
} from "@/lib/api";
import { requirePermission } from "@/lib/session";

export interface CustomerVolatileData {
  customer: Customer;
  subs: Subscription[];
  invoices: Invoice[];
  pms: PaymentMethod[];
  /** subscription id -> renewal estimate, keyed like the page's own Map (JSON can't carry a Map). */
  renewalEstimates: Record<string, RenewalEstimate>;
  /** Payments still holding excess credit — the Balances card's refund list. */
  excessPayments: ExcessPayment[];
}

export type RefreshCustomerResult =
  | { ok: true; data: CustomerVolatileData }
  | { ok: false; error: string };

/**
 * Re-reads balance/credits, payment methods, and subscription+invoice state — the
 * facts the buyer portal can change without the operator touching this screen.
 * Static profile fields, addresses and metadata are never re-fetched here.
 */
export async function refreshCustomerVolatileAction(
  biz: string,
  cus: string,
): Promise<RefreshCustomerResult> {
  await requirePermission("customers:manage", "manager"); // same gate as the page itself

  let customer: Customer, subs, invoices, pms, excess;
  try {
    [customer, subs, invoices, pms, excess] = await Promise.all([
      getCustomer(biz, cus),
      // The whole list: the card pages it, and the figures sum it.
      listSubscriptions(biz, cus, { limit: 1000 }),
      listInvoices(biz, cus),
      listPaymentMethods(biz, cus),
      listCustomerExcessPayments(biz, cus).catch(() => ({ data: [] as ExcessPayment[] })),
    ]);
  } catch {
    return { ok: false, error: "We could not reload this customer." };
  }

  // Post-tax renewal amounts, same fan-out the page's initial load does — best
  // effort per subscription, never erroring the whole refresh.
  const renewalEstimates: Record<string, RenewalEstimate> = {};
  await Promise.all(
    subs.data
      .filter((s) => ["active", "in_trial"].includes(s.status))
      .map(async (s) => {
        const r = await getRenewalEstimate(biz, s.id).catch(() => null);
        if (r?.estimate) renewalEstimates[s.id] = r.estimate;
      }),
  );

  return {
    ok: true,
    data: {
      customer,
      subs: subs.data,
      invoices: invoices.data,
      pms: pms.data,
      renewalEstimates,
      excessPayments: excess.data,
    },
  };
}
