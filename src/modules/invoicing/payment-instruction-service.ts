/**
 * CRUD for the payment instructions a business prints on its invoices.
 *
 * The SELECTION rules — which of these reach a given invoice — live in
 * `./payment-instructions.ts` and are pure, so the settings screen can preview them.
 * This file only owns the rows.
 *
 * Shape follows `modules/custom-fields/service.ts`: `withTenant` for org RLS, a `publicId`
 * prefix, optimistic concurrency via `expectedVersion`, and archive-not-delete.
 */
import { and, asc, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { paymentInstructions } from "@db/schema";
import { VersionConflictError } from "@/api/helpers";
import { parseInstructionFields } from "./payment-instructions";

/** The two rails. */
export const PAYMENT_INSTRUCTION_KINDS = ["bank_transfer", "paypal"] as const;
export type PaymentInstructionKind = (typeof PAYMENT_INSTRUCTION_KINDS)[number];

/** How many label/value pairs one instruction may carry. */
export const MAX_INSTRUCTION_FIELDS = 12;

type Row = typeof paymentInstructions.$inferSelect;

export class PaymentInstructionError extends Error {}

export function serializePaymentInstruction(r: Row) {
  return {
    object: "payment_instruction",
    id: r.publicId,
    kind: r.kind,
    section_title: r.sectionTitle,
    section_id: r.sectionId,
    description: r.description,
    fields: parseInstructionFields(r.fields),
    // Empty array means "every invoice" — the same representation the resolver reads, so
    // a client never has to distinguish null from [].
    currencies: r.currencies ?? [],
    countries: r.countries ?? [],
    position: r.position,
    archived: r.archived,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    resource_version: r.resourceVersion,
  };
}

/**
 * Normalise a targeting list: trimmed, upper-cased, de-duplicated, blanks dropped.
 *
 * Stored normalised so the resolver's comparison is not the only thing standing between
 * a merchant typing "inr" and an instruction that silently never matches.
 */
function normalizeCodes(raw: string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return [...new Set(raw.map((c) => c.trim().toUpperCase()).filter(Boolean))];
}

function validateFields(fields: Array<{ label: string; value: string }> | undefined) {
  if (fields && fields.length > MAX_INSTRUCTION_FIELDS)
    throw new PaymentInstructionError(
      `At most ${MAX_INSTRUCTION_FIELDS} fields per payment instruction`,
    );
}

export async function createPaymentInstruction(input: {
  organizationId: string;
  businessId: string;
  kind: PaymentInstructionKind;
  sectionTitle: string;
  sectionId?: string | null;
  description?: string | null;
  fields?: Array<{ label: string; value: string }>;
  currencies?: string[];
  countries?: string[];
  position?: number;
}): Promise<Row> {
  validateFields(input.fields);
  return withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .insert(paymentInstructions)
      .values({
        publicId: publicId("pinst"),
        organizationId: input.organizationId,
        businessId: input.businessId,
        kind: input.kind,
        sectionTitle: input.sectionTitle,
        sectionId: input.sectionId ?? null,
        description: input.description ?? null,
        fields: input.fields ?? [],
        currencies: normalizeCodes(input.currencies) ?? [],
        countries: normalizeCodes(input.countries) ?? [],
        position: input.position ?? 0,
      })
      .returning();
    return row!;
  });
}

export async function listPaymentInstructions(
  organizationId: string,
  businessId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Row[]> {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(paymentInstructions)
      .where(
        opts.includeArchived
          ? eq(paymentInstructions.businessId, businessId)
          : and(
              eq(paymentInstructions.businessId, businessId),
              eq(paymentInstructions.archived, false),
            ),
      )
      .orderBy(asc(paymentInstructions.position), asc(paymentInstructions.createdAt)),
  );
}

export async function getPaymentInstruction(
  organizationId: string,
  businessId: string,
  pid: string,
): Promise<Row | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentInstructions)
      .where(
        and(eq(paymentInstructions.businessId, businessId), eq(paymentInstructions.publicId, pid)),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function updatePaymentInstruction(input: {
  organizationId: string;
  businessId: string;
  publicId: string;
  expectedVersion?: number;
  sectionTitle?: string;
  sectionId?: string | null;
  description?: string | null;
  fields?: Array<{ label: string; value: string }>;
  currencies?: string[];
  countries?: string[];
  position?: number;
  archived?: boolean;
}): Promise<Row | null> {
  validateFields(input.fields);
  return withTenant(input.organizationId, async (tx) => {
    const [current] = await tx
      .select()
      .from(paymentInstructions)
      .where(
        and(
          eq(paymentInstructions.businessId, input.businessId),
          eq(paymentInstructions.publicId, input.publicId),
        ),
      )
      .limit(1);
    if (!current) return null;
    if (input.expectedVersion !== undefined && current.resourceVersion !== input.expectedVersion)
      throw new VersionConflictError(input.expectedVersion, current.resourceVersion);

    // Only what was sent: a PATCH that omits `fields` must not blank the bank block.
    const set: Partial<Row> = {};
    if (input.sectionTitle !== undefined) set.sectionTitle = input.sectionTitle;
    if (input.sectionId !== undefined) set.sectionId = input.sectionId;
    if (input.description !== undefined) set.description = input.description;
    if (input.fields !== undefined) set.fields = input.fields;
    if (input.currencies !== undefined) set.currencies = normalizeCodes(input.currencies)!;
    if (input.countries !== undefined) set.countries = normalizeCodes(input.countries)!;
    if (input.position !== undefined) set.position = input.position;
    if (input.archived !== undefined) set.archived = input.archived;
    if (Object.keys(set).length === 0) return current;

    const [row] = await tx
      .update(paymentInstructions)
      .set(set)
      .where(eq(paymentInstructions.id, current.id))
      .returning();
    return row!;
  });
}

/**
 * Archive, never delete. An instruction that printed on an already-issued invoice stays
 * readable so that document can still be explained — the same rule
 * `custom_field_definitions` follows.
 */
export async function archivePaymentInstruction(
  organizationId: string,
  businessId: string,
  pid: string,
): Promise<Row | null> {
  return updatePaymentInstruction({
    organizationId,
    businessId,
    publicId: pid,
    archived: true,
  });
}
