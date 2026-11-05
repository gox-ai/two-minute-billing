/**
 * Who tells the payer about a debit before it happens, and how long that takes.
 *
 * One rule for the renewal reminder (`reminders.ts` § 4) and the automatic credit top-up, so
 * the two can never disagree about who notifies.
 */
import { achAuthorizationIsOurs } from "@/providers/gateway-catalog";
import { ACH_VARYING_AMOUNT_NOTICE_DAYS } from "./ach-authorization";
import { gatewayNotifiesPayerOf, preDebitRule, type PaymentProvider } from "@/providers/types";
import type { paymentMethods } from "@db/schema";

type Pm = Pick<typeof paymentMethods.$inferSelect, "type" | "mandateRail" | "providerKey"> & {
  mandateCurrency?: string | null;
};
type Adapter = Pick<PaymentProvider, "key" | "capabilities" | "notifyUpcomingDebit">;

/**
 * - `gateway`: the gateway sends the notice (`capabilities.preDebitNotice` lists the method).
 * - `ours`: a mandate rail with no gateway notice, or an ACH debit we hold the authorization
 *   for. We mail the notice.
 * - `gateway_notifies`: the gateway mails the payer itself (`gatewayNotifiesPayer`), in the
 *   mandate's currency (`gatewayNotifiesPayerCurrencies`: Cashfree's notice is INR only).
 * - `none`: no notice is owed (a card on file, no mandate).
 */
export type NoticeDuty = "gateway" | "ours" | "gateway_notifies" | "none";

/**
 * An ACH debit whose authorization we hold: our notice, at least 10 days ahead of a varying
 * amount (Reg E 12 CFR 1005.10(d)(1)).
 */
export function ownsAchNotice(pm: Pm): boolean {
  return pm.type === "us_bank_account" && achAuthorizationIsOurs(pm.providerKey);
}

export function noticeDutyFor(pm: Pm, adapter: Adapter | null): NoticeDuty {
  const cap = adapter?.capabilities.preDebitNotice;
  if (adapter?.notifyUpcomingDebit && (cap?.methods as string[] | undefined)?.includes(pm.type))
    return "gateway";
  if (!pm.mandateRail && !ownsAchNotice(pm)) return "none";
  if (adapter && gatewayNotifiesPayerOf(adapter.capabilities, pm.type, pm.mandateCurrency))
    return "gateway_notifies";
  return "ours";
}

/** Our own notice: 24 h legal lead, plus margin for a late tick. */
export const OWN_NOTICE_LEAD_HOURS = 26;
/** Our own ACH notice: 10 days (an automatic top-up's amount varies), plus the same margin. */
export const ACH_NOTICE_LEAD_HOURS = ACH_VARYING_AMOUNT_NOTICE_DAYS * 24 + 2;

/** Hours from our own notice to the debit on this instrument. */
export function ownNoticeLeadHours(pm: Pm): number {
  return ownsAchNotice(pm) ? ACH_NOTICE_LEAD_HOURS : OWN_NOTICE_LEAD_HOURS;
}

/**
 * Worst case from a gateway notice to an executable debit, per adapter and instrument. Longer
 * than `minLeadHours`: Cashfree names an IST date T+1…T+7 and debits in the next UPI window, so a
 * late-evening notice waits well past 27 h (49 h keeps a day of margin). PayU (its integration
 * support, 2026-11-02): a card notice goes lead + 2 h ahead and the debit can slip to the end of
 * the IST day (27 h); UPI needs 25 h and can move 3.5 h past NPCI's blocked hours (31 h). `*` is
 * any other instrument. A new notice gateway adds its row here.
 */
const GATEWAY_WORST_CASE_LEAD_HOURS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  cashfree: { "*": 49 },
  payu: { card: 27, upi: 31, "*": 31 },
};

/**
 * Hours from sending the notice to the earliest debit, at worst. Plans a threshold and the
 * send time only: a gateway debit is gated on the stored `pre_debit_notices.executable_after`.
 * 0 when no notice is owed. A gateway without a row (tmtest) uses its configured lead.
 */
export function noticeLeadHours(pm: Pm, adapter: Adapter | null): number {
  const duty = noticeDutyFor(pm, adapter);
  if (duty === "ours") return ownNoticeLeadHours(pm);
  if (duty !== "gateway") return 0;
  const cap = adapter!.capabilities.preDebitNotice!;
  const row = GATEWAY_WORST_CASE_LEAD_HOURS[adapter!.key];
  return Math.max(row?.[pm.type] ?? row?.["*"] ?? 0, preDebitRule(cap, pm.type).minLeadHours);
}
