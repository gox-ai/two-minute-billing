/**
 * The money price of usage beyond the credits of a unit with no rate (0530). The meter's own
 * usage price wins over the unit's overage price (`unitPoliciesFor`, `pickOveragePrice`).
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { rowsOf } from "@/modules/metering/usage-sql";
import { pickOveragePrice } from "./settings-rules";
import { unitPoliciesFor } from "./unit-policies";

/**
 * What bills the units that credits do not cover. `meter`: the meter's own usage price (a
 * rate, not an event amount) on a live subscription of the customer; the period invoice rates
 * the uncovered quantity with it. `unit`: the unit's overage price per credit.
 */
export type OveragePrice =
  | { basis: "meter"; priceId: string; subscriptionId: string }
  | { basis: "unit"; overageMinorPerUnitE12: bigint };

/**
 * The money price of usage beyond the credits, for a customer. Null = no price: such usage
 * is never billed in money.
 */
export async function overagePriceFor(
  tx: Tx,
  input: { businessId: string; unitId: string; meterId: string; customerId?: string | null },
): Promise<OveragePrice | null> {
  const [own] = input.customerId
    ? rowsOf<{ price_id: string; subscription_id: string }>(
        await tx.execute(sql`
          select p.id as price_id, s.id as subscription_id
          from subscriptions s
          join subscription_items si on si.subscription_id = s.id
          join prices p on p.id = si.price_id
          where s.customer_id = ${input.customerId} and s.status in ('active', 'in_trial')
            and s.deleted_at is null and p.meter_id = ${input.meterId}
            and coalesce(si.price_snapshot ->> 'amountSource', p.amount_source) = 'rate'
          order by s.created_at, s.id, si.id limit 1`),
      )
    : [];
  const unitPrice =
    (await unitPoliciesFor(tx, [input.unitId])).get(input.unitId)?.overageMinorPerUnitE12 ?? null;
  const pick = pickOveragePrice({ meterUsagePrice: !!own, unitOverageMinorPerUnitE12: unitPrice });
  if (pick === "meter_price")
    return { basis: "meter", priceId: own!.price_id, subscriptionId: own!.subscription_id };
  if (pick === "unit_overage") return { basis: "unit", overageMinorPerUnitE12: unitPrice! };
  return null;
}
