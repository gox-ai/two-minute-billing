/**
 * NPCI's presentation caps, mirrored for the dashboard.
 *
 * The authority is `NETWORK_RETRY_CAP` in
 * `src/modules/subscriptions/dunning-schedule.ts`; the dashboard cannot import engine
 * modules, so this is a hand-copy — and `test/unit/network-retry-cap.test.ts` pins the
 * two together, because a settings screen quoting a cap the engine does not enforce is
 * worse than one that says nothing.
 *
 * The rails genuinely differ, so this cannot collapse to one number: UPI Autopay is
 * 1 execution + 3 retries (NPCI, from Aug 2025, enforced by rejection), while NACH is
 * 1 presentation + 2 re-presentations (NPCI/NACH/OC No.010/2023-24, enforced by a
 * return-rate penalty).
 */
export const NETWORK_RETRY_CAP: Readonly<Record<string, number>> = {
  upi: 3,
  emandate: 2,
  nach: 2,
  bank_transfer: 2,
}

/** The smallest cap across the Indian mandate rails — what a shared schedule must meet. */
export const STRICTEST_NETWORK_RETRY_CAP = Math.min(...Object.values(NETWORK_RETRY_CAP))
