import { and, asc, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { reasonCodes } from "@db/schema";
// Aliased: `publicId` is also a parameter name on the update/delete helpers.
import { publicId as newPublicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";

const log = createLogger("reason-codes");

/**
 * Reason codes — the merchant-managed list of reasons an
 * operator picks from when cancelling a subscription or issuing a refund.
 *
 * These definitions drive what the UI OFFERS. They never constrain what is
 * stored: the chosen value persists as plain text on the entity, so imported and
 * API-supplied codes outside this list stay valid. See db/schema/reason-codes.ts.
 */

export type ReasonCodeAppliesTo = "subscription_cancellation" | "refund";

export const REASON_CODE_APPLIES_TO: readonly ReasonCodeAppliesTo[] = [
  "subscription_cancellation",
  "refund",
];

/**
 * Offered when a business has defined nothing for `subscription_cancellation`.
 *
 * These seven were previously hard-coded in the dashboard's cancel dialog. Keeping
 * them as a FALLBACK rather than seeding rows means an existing business behaves
 * exactly as before until someone customizes the list, and a business that
 * deliberately deletes every code doesn't get them silently resurrected —
 * `listReasonCodes` reports whether it fell back.
 */
export const DEFAULT_CANCELLATION_REASONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "pricing_high", label: "Pricing was high" },
  { code: "pausing_will_return", label: "Pausing, will come back" },
  { code: "complicated_to_use", label: "Complicated to use" },
  { code: "product_has_issues", label: "Product has issues" },
  { code: "product_unsatisfactory", label: "Product was unsatisfactory" },
  { code: "trying_out", label: "Was just trying out" },
  { code: "other", label: "Other" },
];

export class ReasonCodeError extends Error {}
export class ReasonCodeConflictError extends Error {}

/** Machine codes are lowercase snake_case so they read cleanly in reports. */
const CODE_RE = /^[a-z0-9][a-z0-9_]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export function normalizeCode(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

export async function listReasonCodes(
  organizationId: string,
  businessId: string,
  appliesTo?: ReasonCodeAppliesTo,
) {
  return withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(reasonCodes)
      .where(
        appliesTo
          ? and(eq(reasonCodes.businessId, businessId), eq(reasonCodes.appliesTo, appliesTo))
          : eq(reasonCodes.businessId, businessId),
      )
      .orderBy(asc(reasonCodes.appliesTo), asc(reasonCodes.position), asc(reasonCodes.code)),
  );
}

/**
 * The list a picker should offer: enabled codes only, in position order, falling
 * back to the built-in defaults when the business has defined none.
 * `isFallback` lets the UI say so instead of pretending these are configured.
 */
export async function resolveOfferedReasons(
  organizationId: string,
  businessId: string,
  appliesTo: ReasonCodeAppliesTo,
): Promise<{ reasons: Array<{ code: string; label: string }>; isFallback: boolean }> {
  const rows = (await listReasonCodes(organizationId, businessId, appliesTo)).filter(
    (r) => r.enabled,
  );
  if (rows.length > 0) {
    return { reasons: rows.map((r) => ({ code: r.code, label: r.label })), isFallback: false };
  }
  if (appliesTo === "subscription_cancellation") {
    return { reasons: [...DEFAULT_CANCELLATION_REASONS], isFallback: true };
  }
  return { reasons: [], isFallback: true };
}

export async function createReasonCode(input: {
  organizationId: string;
  businessId: string;
  appliesTo: ReasonCodeAppliesTo;
  code: string;
  label: string;
  position?: number;
  enabled?: boolean;
}) {
  const code = normalizeCode(input.code);
  if (!CODE_RE.test(code)) {
    throw new ReasonCodeError(
      "Code must be lowercase letters, numbers and underscores (2–64 characters)",
    );
  }
  const label = input.label.trim();
  if (!label) throw new ReasonCodeError("Label is required");

  return withTenant(input.organizationId, async (tx) => {
    const existing = await tx
      .select({ id: reasonCodes.id })
      .from(reasonCodes)
      .where(
        and(
          eq(reasonCodes.businessId, input.businessId),
          eq(reasonCodes.appliesTo, input.appliesTo),
          eq(reasonCodes.code, code),
        ),
      )
      .limit(1);
    if (existing.length > 0)
      throw new ReasonCodeConflictError(`Reason code already exists: ${code}`);

    // Append to the end unless an explicit position was given.
    let position = input.position;
    if (position == null) {
      const rows = await tx
        .select({ position: reasonCodes.position })
        .from(reasonCodes)
        .where(
          and(
            eq(reasonCodes.businessId, input.businessId),
            eq(reasonCodes.appliesTo, input.appliesTo),
          ),
        );
      position = rows.reduce((max, r) => Math.max(max, r.position), -1) + 1;
    }

    const [row] = await tx
      .insert(reasonCodes)
      .values({
        publicId: newPublicId("rsn"),
        organizationId: input.organizationId,
        businessId: input.businessId,
        appliesTo: input.appliesTo,
        code,
        label,
        position,
        enabled: input.enabled ?? true,
      })
      .returning();
    return row!;
  });
}

export async function updateReasonCode(
  organizationId: string,
  businessId: string,
  publicId: string,
  patch: { label?: string; position?: number; enabled?: boolean },
) {
  const set: Partial<typeof reasonCodes.$inferInsert> = {};
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label) throw new ReasonCodeError("Label is required");
    set.label = label;
  }
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;

  return withTenant(organizationId, async (tx) => {
    if (Object.keys(set).length === 0) {
      const [row] = await tx
        .select()
        .from(reasonCodes)
        .where(and(eq(reasonCodes.businessId, businessId), eq(reasonCodes.publicId, publicId)))
        .limit(1);
      return row ?? null;
    }
    const [row] = await tx
      .update(reasonCodes)
      .set(set)
      .where(and(eq(reasonCodes.businessId, businessId), eq(reasonCodes.publicId, publicId)))
      .returning();
    return row ?? null;
  });
}

/**
 * Hard delete. Safe because the code is stored as text on the entity, not as a
 * foreign key — records already carrying it keep their value, and the picker
 * simply stops offering it. Disable instead when you want to keep the label
 * available for display.
 */
export async function deleteReasonCode(
  organizationId: string,
  businessId: string,
  publicId: string,
): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .delete(reasonCodes)
      .where(and(eq(reasonCodes.businessId, businessId), eq(reasonCodes.publicId, publicId)))
      .returning({ id: reasonCodes.id });
    log.log("reason code deleted", {
      reasonCode: publicId,
      businessId: businessId,
      found: rows.length > 0,
    });
    return rows.length > 0;
  });
}
