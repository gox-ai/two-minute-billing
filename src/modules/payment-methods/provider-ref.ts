import type { paymentMethods } from "@db/schema";
import type { ProviderPaymentMethodRef } from "@/providers/types";

type Pm = typeof paymentMethods.$inferSelect;

/**
 * The stored method as the adapter sees it: display plus the mandate we hold for it, so an
 * adapter can check the rail, currency and ceiling without a gateway read.
 */
export function providerPaymentMethodRef(
  pm: Pick<
    Pm,
    | "providerPaymentMethodId"
    | "type"
    | "last4"
    | "issuerCountry"
    | "mandateMaxAmountMinor"
    | "mandateCurrency"
    | "mandateRail"
    | "mandateStatus"
    | "mandateExpiresAt"
    | "mandateReference"
  >,
  providerKey: string,
): ProviderPaymentMethodRef {
  const mandate = {
    ...(pm.mandateMaxAmountMinor != null ? { maxAmountMinor: pm.mandateMaxAmountMinor } : {}),
    ...(pm.mandateCurrency ? { currency: pm.mandateCurrency.toUpperCase() } : {}),
    ...(pm.mandateRail ? { rail: pm.mandateRail } : {}),
    ...(pm.mandateStatus ? { status: pm.mandateStatus } : {}),
    ...(pm.mandateExpiresAt ? { expiresAt: pm.mandateExpiresAt } : {}),
    ...(pm.mandateReference ? { reference: pm.mandateReference } : {}),
  };
  return {
    providerKey: providerKey as ProviderPaymentMethodRef["providerKey"],
    providerPaymentMethodId: pm.providerPaymentMethodId,
    // The method's OWN type — hardcoding 'card' mislabels a UPI Autopay mandate
    // or a bank debit to any adapter that branches on it.
    display: {
      type: pm.type as ProviderPaymentMethodRef["display"]["type"],
      last4: pm.last4 ?? undefined,
      ...(pm.issuerCountry ? { issuerCountry: pm.issuerCountry } : {}),
    },
    ...(Object.keys(mandate).length ? { mandate } : {}),
  };
}
