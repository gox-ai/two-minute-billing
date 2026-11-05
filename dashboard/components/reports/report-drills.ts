/**
 * Where a bucket row on a report drills to — the DEFINITION, with no imports, so the
 * engine's own gate can execute these triples against the database instead of trusting
 * that the dashboard builds the ones it was meant to.
 *
 * A drill is expressed in the list grammar every layer already shares —
 * `field / op / value` — because nothing may translate it on the way to the endpoint. A
 * filter that needed translating would drift from what the list accepts, and the first
 * symptom is a drill-down showing the wrong rows under a figure someone trusts.
 */

/** One filter, verbatim: the API takes `?<field>[<op>]=<value>`, the URL `filter=f:o:v`. */
export interface DrillFilter {
  field: string;
  op: string;
  value: string;
}

/** A destination: which list, narrowed how. */
export interface DrillTarget {
  entity: "invoices" | "transactions";
  filters: DrillFilter[];
}

/**
 * The ageing ladder's rungs, in ladder order — the same strings as `AR_AGING_BUCKETS` in
 * `src/modules/invoicing/ar-aging.ts`, which is both what the receivables report prints and
 * the vocabulary the `ar_bucket` filter compares against. Equality with the engine's ladder
 * is asserted by `pnpm verify:bucket-drilldowns`, so a rung cannot be renamed on one side.
 *
 * The en dash is the report's own character. A hyphen here would match nothing.
 */
export const AR_AGING_BUCKET_LABELS = [
  "Current",
  "1–30 days",
  "31–60 days",
  "61–90 days",
  "91–120 days",
  "121–150 days",
  "151–180 days",
  "181–365 days",
  "365+ days",
] as const;

/**
 * The invoice population the receivables ladder counts: unpaid, not written off.
 *
 * Carried in the drill rather than folded into `ar_bucket`, so the list states the whole
 * definition the figure came from — visible as pills, and editable. `ar_bucket` stays a
 * filter about ageing alone; one filter that silently narrowed on three things is how two
 * screens start disagreeing about what "overdue" means.
 */
const RECEIVABLE: DrillFilter[] = [
  { field: "status", op: "in", value: "posted,payment_due,not_paid" },
  { field: "written_off", op: "is", value: "false" },
];

/** The report's half-open window, as the engine serves it. */
export interface DrillWindow {
  start?: string;
  end?: string;
}

/** A day (`YYYY-MM-DD`) from an instant — the finest boundary the list's date ops take. */
const day = (iso: string) => iso.slice(0, 10);

/**
 * A decline-code row: the failed attempts of one type carrying one code, inside the
 * report's window.
 *
 * The `Unspecified` bucket is a NULL code, not a code spelled that way, so it drills as
 * `error_code[is_present]=false` — the one operator that can name an absence. Without it
 * the largest bucket on a gateway that returns bare failures would be the one row a reader
 * could not open.
 *
 * No window means no honest destination: the row stays plain text rather than opening the
 * whole log under a figure that covered a year.
 */
function errorDrill(
  type: "payment" | "refund",
  group: string,
  window: DrillWindow,
): DrillTarget | null {
  if (!window.start || !window.end) return null;
  return {
    entity: "transactions",
    filters: [
      { field: "type", op: "is", value: type },
      { field: "status", op: "is_not", value: "succeeded" },
      group === UNSPECIFIED_ERROR
        ? { field: "error_code", op: "is_present", value: "false" }
        : { field: "error_code", op: "is", value: group },
      { field: "occurred_at", op: "on_or_after", value: day(window.start) },
      // Half-open: the end day is excluded, so `before` and never `on_or_before`.
      { field: "occurred_at", op: "before", value: day(window.end) },
    ],
  };
}

/** The bucket the error summaries file a failure with no code under. */
export const UNSPECIFIED_ERROR = "Unspecified";

/**
 * Report key → destination for one of its bucket rows.
 *
 * Keyed on the report KEY and not on its bucketing family, which the envelope does not
 * carry: a report added to a family and not listed here renders as plain text, which is the
 * safe direction to be wrong in.
 */
const DRILLS: Record<string, (group: string, window: DrillWindow) => DrillTarget | null> = {
  total_receivables: (group) => ({
    entity: "invoices",
    filters: [...RECEIVABLE, { field: "ar_bucket", op: "is", value: group }],
  }),
  receivables_aging_summary: (group) => ({
    entity: "invoices",
    filters: [...RECEIVABLE, { field: "ar_bucket", op: "is", value: group }],
  }),
  // Every invoice carrying a dunning state, over the whole book — the summary applies no
  // window, so the drill carries none either.
  dunning_status_summary: (group) => ({
    entity: "invoices",
    filters: [{ field: "dunning_status", op: "is", value: group }],
  }),
  payment_error_summary: (group, window) => errorDrill("payment", group, window),
  refund_error_summary: (group, window) => errorDrill("refund", group, window),
};

/** The reports whose bucket rows have a destination at all. */
export const DRILLABLE_BUCKET_REPORTS = Object.keys(DRILLS);

/** Where one bucket row leads, or null when nothing can express it honestly. */
export function bucketDrill(
  reportKey: string,
  group: string,
  window: DrillWindow = {},
): DrillTarget | null {
  return DRILLS[reportKey]?.(group, window) ?? null;
}
