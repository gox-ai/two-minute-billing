/**
 * The full refund of a credit pack line (0529): the note credits the whole line, used credits
 * too. The unused cost is voided as before (`voidPackUnitsForCreditNote`); the credit note's
 * credit adjustment (contra-revenue) takes back the revenue of the used part: that usage is written off.
 *
 * Decided rule: the used credits are first drawn again from the customer's other grants, and
 * only the rest is written off. An active pack in a unit with no rate gets that re-draw (0530,
 * `redrawForFullRefund`). Any other pack has none, so its full refund is refused while another
 * live grant in the same unit has credit left: the result then never differs from the rule.
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { creditGrants } from "@db/schema";
import { fullRefundable, grantRemaining, type PackLineCredit } from "./service";

export async function fullPackRefundRefusal(
  tx: Tx,
  input: { packs: Array<{ pack: PackLineCredit; amountMinor: bigint; valueMinor: bigint }> },
): Promise<string | null> {
  if (input.packs.length === 0)
    return "We could not create the credit note. A full refund is for a credit pack line. Select the pack line, or credit without a full refund.";
  for (const { pack } of input.packs) {
    const g = pack.grant;
    // Nothing used: a full refund is the unused part. A re-draw takes the used part.
    if (pack.unusedCostMinor >= g.costBasisMinor || fullRefundable(g)) continue;
    const others = await tx
      .select({ id: creditGrants.id })
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.customerId, g.customerId),
          eq(creditGrants.status, "active"),
          eq(creditGrants.currency, g.currency),
          ne(creditGrants.id, g.id),
          g.unitId ? eq(creditGrants.unitId, g.unitId) : isNull(creditGrants.unitId),
        ),
      );
    if (others.length === 0) continue;
    const left = await grantRemaining(
      tx,
      others.map((o) => o.id),
    );
    if ([...left.values()].some((r) => r.units > 0n))
      return "We could not create the credit note. The customer has other credit in this unit, and a full refund cannot take the used credits from it yet. Credit the unused part only.";
  }
  return null;
}
