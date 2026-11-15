/**
 * The copy form's choices, from a stored run. A plain module: the server page seeds the form
 * for "Repeat" (`?repeat=<id>`), and a client module's export would reach it as a reference.
 */
import type { ConflictPolicy, PlanRequest, TransferJob, TransferSection } from "@/lib/api/transfer";

/** Choices to start the form from: a past run ("Repeat") or the plan being changed. */
export interface TransferSeed {
  dest: string;
  sections: TransferSection[];
  invoicePrefix?: string;
  creditNotePrefix?: string;
  withTwins?: boolean;
  policy?: Partial<Record<TransferSection, ConflictPolicy>>;
  clearFirst?: boolean;
  /** Items left out of the plan being changed; kept while the destination stays the same. */
  exclude?: string[];
}

/** The sections a clear-first deletes in the destination. */
export const CLEARABLE: TransferSection[] = ["catalog", "coupons", "tax_rates"];

/** The form's choices from a stored run. */
export function seedOf(
  j: Pick<
    TransferJob,
    "destination_business" | "sections" | "wipe_destination" | "options" | "conflict_policy"
  >,
): TransferSeed {
  const n = j.options?.numbering;
  return {
    dest: j.destination_business,
    sections: j.sections,
    invoicePrefix: n?.invoicePrefix,
    creditNotePrefix: n?.creditNotePrefix,
    withTwins: !!j.options?.include_test_twins,
    policy: j.conflict_policy ?? undefined,
    clearFirst: j.wipe_destination,
  };
}

/** The plan request that reproduces a stored run, with the items to leave out. */
export function requestOf(run: Parameters<typeof seedOf>[0], exclude: string[]): PlanRequest {
  const s = seedOf(run);
  return {
    destination_business: s.dest,
    sections: s.sections,
    ...(s.policy ? { conflict_policy: s.policy } : {}),
    ...(s.invoicePrefix || s.creditNotePrefix
      ? {
          numbering: {
            ...(s.invoicePrefix ? { invoice_prefix: s.invoicePrefix } : {}),
            ...(s.creditNotePrefix ? { credit_note_prefix: s.creditNotePrefix } : {}),
          },
        }
      : {}),
    ...(s.withTwins ? { include_test_twins: true } : {}),
    ...(s.clearFirst ? { wipe_destination: true } : {}),
    exclude,
  };
}
