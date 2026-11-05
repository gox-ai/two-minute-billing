// Typed fetchers for customer SEGMENTS — saved, named populations.
//
// ⚠️ Not saved list views. A **view** (`./list-views.ts`) narrows a list screen; a
// **segment** names a population and is what a metric is compared across; an
// **attribute** is what a segment is a predicate over. The three words are kept apart
// everywhere — see `src/modules/segments/README.md`.
import { apiGet, apiWrite, type Customer } from "@/lib/api";

/** One `field[op]=value` triple, the same grammar the customer list and the URL use. */
export interface SegmentFilter {
  field: string;
  op: string;
  value: string;
}

export interface Segment {
  object: "customer_segment";
  id: string;
  name: string;
  description: string | null;
  filters: SegmentFilter[];
  /** Ships with the product: present on every business, read-only, not a stored row. */
  is_starter: boolean;
  starter_key: string | null;
  created_at: string | null;
  updated_at: string | null;
  /**
   * Whether THIS business can answer the segment — a segment filtering on MRR cannot on a book
   * billed in several currencies. Absent on an engine that predates it, which reads as usable.
   */
  answerable?: boolean;
  /** The engine's sentence for why not, when `answerable` is false. */
  refusal?: string | null;
}

/** One attribute a segment may filter on, as the builder needs to render it. */
export interface SegmentAttribute {
  field: string;
  label: string;
  group: string;
  kind: "text" | "enum" | "bool" | "number" | "date";
  ops: string[];
  options: Array<{ value: string; label: string }> | null;
  hint: string | null;
}

/**
 * The per-customer figures the segment table renders. Not on the customer row itself:
 * the engine folds them in one grouped query per page.
 *
 * `statuses` counts subscriptions by API status, so `non_renewing` appears here exactly
 * as it does on the subscriptions list. `mrr` maps ISO code → integer MINOR UNITS, and
 * it is a map because a customer can hold subscriptions in more than one currency.
 */
export interface SegmentCustomerFacts {
  statuses: Record<string, number>;
  mrr: Record<string, number>;
  /** The last one-time order (ISO), or null. */
  last_order_at?: string | null;
}

export type SegmentCustomer = Customer & { segment_facts?: SegmentCustomerFacts };

interface SegmentList {
  object: "list";
  data: Segment[];
  total: number;
}

interface SegmentAttributeList {
  object: "list";
  data: SegmentAttribute[];
  total: number;
}

export interface SegmentPopulation {
  object: "list";
  data: SegmentCustomer[];
  has_more: boolean;
  next_cursor: string | null;
  /** The whole filtered set, not the page. */
  total: number | null;
  segment: string | null;
  /** ISO code → integer minor units. A MAP, always: currencies are not addable. */
  mrr_by_currency: Record<string, number>;
}

export const listSegments = (biz: string) =>
  apiGet<SegmentList>(`/v1/businesses/${biz}/customer_segments`);

export const listSegmentAttributes = (biz: string) =>
  apiGet<SegmentAttributeList>(`/v1/businesses/${biz}/customer_segments/attributes`);

export const getSegmentPopulation = (
  biz: string,
  seg: string,
  opts: { limit?: number; startingAfter?: string } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.limit != null) qs.set("limit", String(opts.limit));
  if (opts.startingAfter) qs.set("starting_after", opts.startingAfter);
  const q = qs.toString();
  return apiGet<SegmentPopulation>(
    `/v1/businesses/${biz}/customer_segments/${seg}/customers${q ? `?${q}` : ""}`,
  );
};

/**
 * The population an UNSAVED filter set names — the screen's one data path.
 *
 * The chips on screen ARE these filters, so selecting a saved segment and editing one
 * chip are the same request with one parameter different. `total` is the whole filtered
 * set (the engine counts it), never the page.
 */
export const previewSegment = (
  biz: string,
  filters: SegmentFilter[],
  opts: { limit?: number; startingAfter?: string } = {},
) => {
  const qs = new URLSearchParams();
  for (const f of filters) qs.set(`${f.field}[${f.op}]`, f.value);
  if (opts.limit != null) qs.set("limit", String(opts.limit));
  if (opts.startingAfter) qs.set("starting_after", opts.startingAfter);
  const q = qs.toString();
  return apiGet<SegmentPopulation>(
    `/v1/businesses/${biz}/customer_segments/preview${q ? `?${q}` : ""}`,
  );
};

export const createSegment = (
  biz: string,
  draft: {
    name: string;
    description?: string | null;
    filters: SegmentFilter[];
    starter_key?: string | null;
  },
) => apiWrite(`/v1/businesses/${biz}/customer_segments`, draft, "POST");

export const deleteSegment = (biz: string, seg: string) =>
  apiWrite(`/v1/businesses/${biz}/customer_segments/${seg}`, {}, "DELETE");
