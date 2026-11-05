import { eq } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { businesses, invoices } from "@db/schema";

/**
 * The FX snapshot a document carries (0228): `rate` units of the DOCUMENT's currency
 * per 1 unit of `base`.
 *
 * The convention — base USD, `1 USD = 94.953741 INR` → `{ rate: "94.953741", base:
 * "USD" }` on an INR document — is the direction `metrics/analytics.ts` already
 * divides by (`minor / rate`). A rate is a STRING all the way to the column: `Number("94.953741")` is where an exact rate becomes
 * 94.95374099999999.
 */
export interface IssueExchangeRate {
  rate: string;
  base: string;
}

/** The only two business columns this needs. */
export type ExchangeRateSource = Pick<
  typeof businesses.$inferSelect,
  "defaultCurrency" | "exchangeRates"
>;

/**
 * The rate to stamp on a document being issued in `currency`, or null.
 *
 * PURE — takes the business row's two columns so a caller that already holds the row
 * (`planSubscriptionPeriodInvoice` does) pays no second query.
 *
 * NULL means "no rate was recorded", and the three ways to get there are all honest:
 * the business has no default currency to measure against, it has no rate configured
 * for this currency, or the configured rate is unusable (zero, negative, non-numeric —
 * `exchange_rates` is operator-edited jsonb, so that is reachable). **Never 1** in
 * those cases: 1 asserts parity with the base currency, and asserting a rate we do not
 * have is the failure this snapshot exists to end. The one case that DOES store 1 is a
 * document in the business's own default currency, where the parity is a fact.
 */
export function resolveIssueRate(
  biz: ExchangeRateSource | null | undefined,
  currency: string,
): IssueExchangeRate | null {
  const base = biz?.defaultCurrency?.toUpperCase();
  if (!base) return null;
  const ccy = currency.toUpperCase();
  if (ccy === base) return { rate: "1", base };

  const rates = (biz?.exchangeRates ?? null) as Record<string, unknown> | null;
  const raw = rates?.[ccy];
  // jsonb numbers arrive as `number`; phase 2 (the ECB refresh) should write strings,
  // so both are accepted rather than making the reader depend on which wrote the row.
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  // `String(raw)` rather than `String(n)` when the source was already a string, so an
  // operator-entered rate reaches the column with the precision they typed.
  return { rate: typeof raw === "string" ? raw.trim() : String(raw), base };
}

/** `resolveIssueRate` for a caller that does not already hold the business row. */
export async function loadIssueRate(
  tx: Tx,
  businessId: string,
  currency: string,
): Promise<IssueExchangeRate | null> {
  const [biz] = await tx
    .select({
      defaultCurrency: businesses.defaultCurrency,
      exchangeRates: businesses.exchangeRates,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return resolveIssueRate(biz, currency);
}

/**
 * The FX snapshot of an invoice, for a document that REVERSES it (credit notes).
 *
 * A reversal must convert at the rate of the invoice it credits, not at today's: a
 * credit note stamped with a fresh rate would not net to zero against its own invoice
 * in a converted book, which is the one thing a credit note has to do there. Null when
 * the credited invoice carries no rate (pre-0228, or none configured) — inherited
 * faithfully, including the absence.
 */
export async function inheritedInvoiceRate(
  tx: Tx,
  invoiceId: string,
): Promise<{ exchangeRate: string | null; exchangeRateBase: string | null }> {
  const [row] = await tx
    .select({ rate: invoices.exchangeRate, base: invoices.exchangeRateBase })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  return { exchangeRate: row?.rate ?? null, exchangeRateBase: row?.base ?? null };
}

/** The column pair, ready to spread into an insert/update. */
export function exchangeRateColumns(fx: IssueExchangeRate | null) {
  return { exchangeRate: fx?.rate ?? null, exchangeRateBase: fx?.base ?? null };
}
