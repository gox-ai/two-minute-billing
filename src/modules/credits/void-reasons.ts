/**
 * Why an operator voided a credit grant (0529): a closed list and an optional note (required
 * for `other`). Written in the void's transaction; one row per grant, append-only.
 */
import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/platform/db";
import { CREDIT_VOID_REASONS, creditGrantVoidReasons, type CreditVoidReason } from "@db/schema";
import { CreditRuleError } from "./service";
import { voidReasonIssue } from "./settings-rules";

export { voidReasonIssue };

export { CREDIT_VOID_REASONS, type CreditVoidReason };

export interface VoidReasonInput {
  reason: CreditVoidReason;
  note?: string | null;
  userId?: string | null;
}

export const voidReasonBody = z.object({
  reason: z.enum(CREDIT_VOID_REASONS).optional(),
  note: z.string().trim().min(1).max(500).optional(),
});

export async function recordVoidReason(
  tx: Tx,
  input: { organizationId: string; businessId: string; grantId: string } & VoidReasonInput,
): Promise<void> {
  const issue = voidReasonIssue(input);
  if (issue) throw new CreditRuleError(issue);
  await tx.insert(creditGrantVoidReasons).values({
    organizationId: input.organizationId,
    businessId: input.businessId,
    grantId: input.grantId,
    reason: input.reason,
    note: input.note ?? null,
    createdByUserId: input.userId ?? null,
  });
}

export interface VoidReasonView {
  reason: CreditVoidReason;
  note: string | null;
  created_at: string;
}

/** The void reason of each grant that has one, by grant id. */
export async function voidReasonsFor(
  tx: Tx,
  grantIds: readonly string[],
): Promise<Map<string, VoidReasonView>> {
  const out = new Map<string, VoidReasonView>();
  if (grantIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(creditGrantVoidReasons)
    .where(inArray(creditGrantVoidReasons.grantId, [...new Set(grantIds)]));
  for (const r of rows)
    out.set(r.grantId, { reason: r.reason, note: r.note, created_at: r.createdAt.toISOString() });
  return out;
}
