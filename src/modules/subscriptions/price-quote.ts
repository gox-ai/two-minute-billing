import { createHash } from "node:crypto";
import type { Estimate } from "./estimate";

/**
 * Preview → apply pricing lock, shared by the portal plan change and `POST …/change`.
 *
 * An unused-time credit shrinks every second, so an apply priced at its own instant books
 * 1–2 minor units less than the preview showed. A preview returns `priced_at` and a `quote`
 * (a hash of every amount it shows); the apply re-prices at `priced_at` when it is recent
 * and refuses when the quote moved.
 */

/** How long a preview's pricing instant can be re-used on apply. */
export const QUOTE_TTL_MS = 15 * 60_000;

/** The preview's instant when it is recent enough; else undefined (price now). Never in the future. */
export function quotedInstant(
  pricedAt: string | undefined,
  now: Date = new Date(),
): Date | undefined {
  if (!pricedAt) return undefined;
  const t = new Date(pricedAt).getTime();
  const n = now.getTime();
  if (!Number.isFinite(t) || t > n + 5_000 || n - t > QUOTE_TTL_MS) return undefined;
  return new Date(t);
}

/** Every amount a preview shows, as one value: apply refuses when any of them moved. */
export function quoteOf(amounts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(amounts)).digest("hex").slice(0, 32);
}

/** The quote of a change estimate: every figure the change screen shows. */
export function estimateQuote(est: Estimate): string {
  // Sorted, so the order rows come back in never reads as a moved amount.
  const lines = est.lines.map((l) => JSON.stringify([l.description, l.amount_minor])).sort();
  return quoteOf([
    lines,
    est.subtotal_minor,
    est.discount_minor,
    est.tax_minor,
    est.total_minor,
    est.amount_due_minor ?? null,
    est.credits_applied_minor ?? null,
    est.credit_note_total_minor ?? null,
    est.invoice_total_minor ?? null,
    est.next_renewal?.total_minor ?? null,
    est.new_period_end,
  ]);
}

/** The 409 text when the quote moved. Shared so the portal and the API say the same. */
export const QUOTE_MOVED_MESSAGE =
  "The price changed after you looked at it. Check the new price and confirm again.";
