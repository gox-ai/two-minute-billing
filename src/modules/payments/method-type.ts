/**
 * `payments.method_type` (0397): which method type paid, in our vocabulary
 * (`METHOD_TYPES`). Written at every insert that books a gateway attempt.
 */
import { eq } from "drizzle-orm";
import { paymentMethods } from "@db/schema";
import type { Tx } from "@/platform/db";
import { METHOD_TYPES, type MethodType } from "@/providers/method-types";
import type { ChargeResult } from "@/providers/types";

const KNOWN: ReadonlySet<string> = new Set(METHOD_TYPES);

/** Names outside the vocabulary that still have one answer. Anything else stays unknown. */
const ALIASES: Readonly<Record<string, MethodType>> = {
  // A device wallet carries a card.
  apple_pay: "card",
  google_pay: "card",
  cash_app_pay: "wallet",
  // Legacy stored type for ACH.
  ach_debit: "us_bank_account",
};

export function toMethodType(v: string | null | undefined): MethodType | null {
  if (!v) return null;
  if (KNOWN.has(v)) return v as MethodType;
  return ALIASES[v] ?? null;
}

/**
 * What the gateway said was used, else the saved method's type. A gateway answer outside
 * the vocabulary gives null: the saved type could be wrong for that payment.
 */
export function methodTypeOf(
  result: Pick<ChargeResult, "methodUsed"> | null | undefined,
  saved: { type: string } | null | undefined,
): MethodType | null {
  if (result?.methodUsed) return toMethodType(result.methodUsed);
  return toMethodType(saved?.type);
}

/** `methodTypeOf` when only the saved method's id is at hand. Reads it only if needed. */
export async function methodTypeFor(
  tx: Tx,
  result: Pick<ChargeResult, "methodUsed"> | null | undefined,
  paymentMethodId: string | null | undefined,
): Promise<MethodType | null> {
  if (result?.methodUsed || !paymentMethodId) return methodTypeOf(result, null);
  const [pm] = await tx
    .select({ type: paymentMethods.type })
    .from(paymentMethods)
    .where(eq(paymentMethods.id, paymentMethodId))
    .limit(1);
  return methodTypeOf(null, pm);
}
