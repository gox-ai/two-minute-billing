import { notPlatformOrg } from "@/modules/tenancy/platform-org";
import { and, eq, gte, lt } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { buyerClientErrors } from "@db/schema";
import { buyerTextLeaks } from "./buyer-error-leak";

/** Rows older than this are deleted by `sweepBuyerClientErrors`. */
export const BUYER_CLIENT_ERROR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** The same text again in one session inside this window is the same error: no new row. */
export const BUYER_CLIENT_ERROR_DEDUPE_MS = 5_000;

export interface BuyerClientErrorScope {
  surface: "checkout" | "portal";
  sessionPublicId: string;
  organizationId: string;
  businessId: string;
  customerId: string | null;
}

export interface BuyerClientErrorInput {
  text: string;
  step?: string | null;
  page?: string | null;
  gateway?: string | null;
  type?: string | null;
  code?: string | null;
  decline_code?: string | null;
  gateway_message?: string | null;
  field_error?: boolean;
}

/** Record one report. Returns false when it repeats the session's last report. */
export async function recordBuyerClientError(
  scope: BuyerClientErrorScope,
  input: BuyerClientErrorInput,
  now: Date = new Date(),
): Promise<{ recorded: boolean; leak: boolean }> {
  const fieldError = input.field_error === true;
  const leak = buyerTextLeaks(input.text, { fieldError });
  const [repeat] = await systemDb
    .select({ id: buyerClientErrors.id })
    .from(buyerClientErrors)
    .where(
      and(
        eq(buyerClientErrors.sessionPublicId, scope.sessionPublicId),
        eq(buyerClientErrors.text, input.text),
        gte(buyerClientErrors.createdAt, new Date(now.getTime() - BUYER_CLIENT_ERROR_DEDUPE_MS)),
      ),
    )
    .limit(1);
  if (repeat) return { recorded: false, leak };
  await systemDb.insert(buyerClientErrors).values({
    ...scope,
    createdAt: now,
    step: input.step ?? null,
    page: input.page ?? null,
    gateway: input.gateway ?? null,
    gatewayType: input.type ?? null,
    gatewayCode: input.code ?? null,
    declineCode: input.decline_code ?? null,
    gatewayMessage: input.gateway_message ?? null,
    text: input.text,
    fieldError,
    leak,
  });
  return { recorded: true, leak };
}

/** Retention. Runs in the `sweep_buyer_rejections` clock pass. */
export async function sweepBuyerClientErrors(now: Date): Promise<{ deleted: number }> {
  const deleted = await systemDb
    .delete(buyerClientErrors)
    .where(
      and(
        lt(buyerClientErrors.createdAt, new Date(now.getTime() - BUYER_CLIENT_ERROR_RETENTION_MS)),
        notPlatformOrg(buyerClientErrors.organizationId),
      ),
    )
    .returning({ id: buyerClientErrors.id });
  return { deleted: deleted.length };
}
