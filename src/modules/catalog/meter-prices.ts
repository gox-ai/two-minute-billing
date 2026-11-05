import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { meters, priceRates, type prices } from "@db/schema";
import type { Tx } from "@/platform/db";
import { fixed12FromNumeric, formatFixed12 } from "@/platform/fixed";
import { meterPriceIssues, type MeterPriceInput, type MeterTier } from "./pricing";

/** A meter price refused by `meterPriceIssues` or a meter lookup; 400 with the field. */
export class MeterPriceError extends Error {
  readonly statusCode = 400;
  constructor(
    message: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = "MeterPriceError";
  }
}

/** One rate-card row as the API takes it. */
export interface PriceRateInput {
  match: Record<string, string>;
  unitAmountDecimal?: string | null;
  tiers?: MeterTier[] | null;
  /** model_price_list: percent over the price's markup base, in place of a fixed rate. */
  markupPercent?: string | null;
}

/** The meter a new price bills from, by key (or id). Archived meters cannot be priced. */
export async function meterForPrice(
  tx: Tx,
  businessId: string,
  ref: string,
): Promise<typeof meters.$inferSelect> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const [m] = await tx
    .select()
    .from(meters)
    .where(
      and(
        eq(meters.businessId, businessId),
        isUuid ? or(eq(meters.key, ref), eq(meters.id, ref)) : eq(meters.key, ref),
      ),
    )
    .limit(1);
  if (!m) throw new MeterPriceError(`No such meter: ${ref}`, "meter");
  if (m.status !== "active")
    throw new MeterPriceError(
      `The meter ${m.key} is archived. You cannot add a price to an archived meter.`,
      "meter",
    );
  return m;
}

/** Throw the first `meterPriceIssues` entry as a 400 naming its field. */
export function assertMeterPrice(p: MeterPriceInput, groupBy: readonly string[]): void {
  const issue = meterPriceIssues(p, groupBy)[0];
  if (issue) throw new MeterPriceError(issue.message, issue.field);
}

/** Replace a price's rate card. Rows keep the input order, so the first is the oldest. */
export async function replacePriceRates(
  tx: Tx,
  input: { organizationId: string; businessId: string; priceId: string; rates: PriceRateInput[] },
): Promise<void> {
  await tx
    .delete(priceRates)
    .where(and(eq(priceRates.businessId, input.businessId), eq(priceRates.priceId, input.priceId)));
  if (input.rates.length === 0) return;
  // created_at steps 1 µs per row, so the input order is the age order ("oldest wins" on a
  // tie): uuid_v7 is not monotonic inside one millisecond.
  await tx.insert(priceRates).values(
    input.rates.map((r, i) => ({
      organizationId: input.organizationId,
      businessId: input.businessId,
      priceId: input.priceId,
      match: r.match,
      unitAmountDecimal: r.unitAmountDecimal ?? null,
      tiers: r.tiers ?? null,
      markupPercent: r.markupPercent ?? null,
      createdAt: sql`app_now() + ${i} * interval '1 microsecond'`,
    })),
  );
}

/** What the API shows for a meter price beyond the price row: its meter key and rate card. */
export interface MeterPriceView {
  meter: string;
  rates: Array<{
    match: Record<string, string>;
    unit_amount_decimal: string | null;
    tiers: MeterTier[] | null;
    markup_percent: string | null;
  }>;
}

/** `MeterPriceView` for every meter price in `rows`, keyed by price id. Two queries. */
export async function meterPriceViews(
  tx: Tx,
  rows: ReadonlyArray<Pick<typeof prices.$inferSelect, "id" | "meterId">>,
): Promise<Map<string, MeterPriceView>> {
  const out = new Map<string, MeterPriceView>();
  const metered = rows.filter((r) => r.meterId);
  if (metered.length === 0) return out;
  const meterRows = await tx
    .select({ id: meters.id, key: meters.key })
    .from(meters)
    .where(inArray(meters.id, [...new Set(metered.map((r) => r.meterId!))]));
  const keyOf = new Map(meterRows.map((m) => [m.id, m.key]));
  const rates = await tx
    .select()
    .from(priceRates)
    .where(
      inArray(
        priceRates.priceId,
        metered.map((r) => r.id),
      ),
    )
    .orderBy(asc(priceRates.createdAt), asc(priceRates.id));
  for (const r of metered) {
    out.set(r.id, {
      meter: keyOf.get(r.meterId!) ?? "",
      rates: rates
        .filter((x) => x.priceId === r.id)
        .map((x) => ({
          match: x.match,
          unit_amount_decimal:
            x.unitAmountDecimal != null
              ? formatFixed12(fixed12FromNumeric(x.unitAmountDecimal))
              : null,
          tiers: (x.tiers as MeterTier[] | null) ?? null,
          markup_percent:
            x.markupPercent != null ? formatFixed12(fixed12FromNumeric(x.markupPercent)) : null,
        })),
    });
  }
  return out;
}
