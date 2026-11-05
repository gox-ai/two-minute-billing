/**
 * Gateway AVS/CVC verdict (0245). NOT on the shared `PaymentMethod` type, so it is
 * narrowed here rather than widening that type for a field only Stripe reports.
 *
 * In its own file, not `lib/api/gateways.ts`, because a THIRD surface needs it and that
 * one is a client component: the customer page's payment-method card moved into
 * `customer-volatile.tsx` so Refresh can reload it. `lib/api/gateways.ts` reaches
 * `next/headers` through `@/lib/api`, so importing the value from there would drag the
 * server chain into the browser bundle. `gateways.ts` re-exports both names, so its own
 * callers are unchanged — the point stands that one narrowing beats three.
 */
export type PaymentMethodAvsCheck = {
  line1: string | null;
  postal_code: string | null;
  cvc: string | null;
  checked_at: string | null;
};

export function avsCheckOf(pm: unknown): PaymentMethodAvsCheck | null {
  return (pm as { avs_check?: PaymentMethodAvsCheck | null })?.avs_check ?? null;
}
