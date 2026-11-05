// Meters, usage events and customer usage keys. Server-only (imports the API client).
// Shapes follow design G1a § 5 and `serializeMeter` / `serializeUsageKey`
// (src/modules/metering/meters.ts).
import {
  apiGet,
  apiGetOrNull,
  apiWrite,
  listQuery,
  type ListParams,
  type PagedList,
} from "@/lib/api";
import type { MeterAggregation } from "@/lib/meters";

interface List<T> {
  object: "list";
  data: T[];
}

export interface Meter {
  object: "meter";
  /** The slug id (stored as `key`): unique per business, fixed after create. */
  id: string;
  name: string;
  event_name: string;
  aggregation: MeterAggregation;
  value_property: string | null;
  unique_property: string | null;
  recurring: boolean;
  time_unit: "hour" | "day" | null;
  /** An event counts only when every listed property has one of its values. */
  filters: Record<string, Array<string | number | boolean>>;
  /** ≤ 5 property names, in order. */
  group_by: string[];
  /** ≤ 3 properties a spend limit may be scoped by (0475). */
  limit_dimensions: string[];
  status: "active" | "archived";
  /** Maps the meter to the model price list (design G1b § 6.1). Null = not mapped. */
  price_list?: MeterPriceList | null;
  /** Currency of event `cost`. */
  cost_currency?: string | null;
  /** True once the meter has a counted event or a price: only `name` can change. */
  locked: boolean;
  /** Matched events on this meter that no subscription bills. */
  not_billed_event_count?: number | null;
  created_at: string;
  updated_at?: string;
  resource_version?: number;
}

/** Which model price list key a meter's events price from. A fixed value or a property name. */
export interface MeterPriceList {
  provider?: string | null;
  provider_key?: string | null;
  /** The property that holds the model. Default "model". */
  model_key?: string | null;
  token_type?: string | null;
  token_type_key?: string | null;
}

export interface MeterWrite {
  /** Create only: the slug id. Omit and the API makes one from the name. */
  id?: string;
  name?: string;
  event_name?: string;
  aggregation?: MeterAggregation;
  value_property?: string | null;
  unique_property?: string | null;
  recurring?: boolean;
  time_unit?: "hour" | "day" | null;
  filters?: Record<string, string[]>;
  group_by?: string[];
  limit_dimensions?: string[];
  price_list?: MeterPriceList | null;
  cost_currency?: string | null;
  expected_version?: number;
}

export type UsageEventStatus = "matched" | "unmatched" | "voided";

export interface UsageEvent {
  object: "usage_event";
  id: string;
  /** The sender's idempotency key. */
  key: string;
  /** `cus_…`, or null while no usage key matches. */
  customer: string | null;
  customer_key: string;
  event_name: string;
  timestamp: string;
  /** When we received it. */
  created_at: string;
  properties: Record<string, string | number | boolean>;
  /** Major-unit decimal strings. */
  amount: string | null;
  cost: string | null;
  currency: string | null;
  status: UsageEventStatus;
  /** Keys of the meters it counts toward. */
  meters: string[];
  /** e.g. `no_meter`, `currency_mismatch`. */
  flags: string[];
  voided_at: string | null;
  void_reason: string | null;
}

export interface UsageEventInput {
  key: string;
  customer: string;
  event_name: string;
  timestamp?: string;
  properties?: Record<string, string | number | boolean>;
}

export interface UsageKey {
  object: "usage_key";
  key: string;
  customer?: string;
  created_at: string;
}

const b = (biz: string) => `/v1/businesses/${biz}`;

/** Every meter, archived included. Paged by id on the API; a business has few, so read them all. */
export async function listMeters(biz: string): Promise<List<Meter>> {
  const data: Meter[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ limit: "100", ...(after ? { starting_after: after } : {}) });
    const res: PagedList<Meter> = await apiGet<PagedList<Meter>>(`${b(biz)}/meters?${q}`);
    data.push(...res.data);
    if (!res.has_more || !res.next_cursor) break;
    after = res.next_cursor;
  }
  return { object: "list", data };
}

export const getMeter = (biz: string, meter: string) =>
  apiGetOrNull<Meter>(`${b(biz)}/meters/${encodeURIComponent(meter)}`);

export const createMeter = (biz: string, body: MeterWrite) =>
  apiWrite(`${b(biz)}/meters`, body, "POST");

export const updateMeter = (biz: string, meter: string, body: MeterWrite) =>
  apiWrite(`${b(biz)}/meters/${encodeURIComponent(meter)}`, body, "PATCH");

export const archiveMeter = (biz: string, meter: string) =>
  apiWrite(`${b(biz)}/meters/${encodeURIComponent(meter)}/archive`, {}, "POST");

/** One page of usage events. Filters: `customer`, `customer_key`, `meter`, `key`, `status`. */
export function listUsageEvents(
  biz: string,
  scope: {
    meter?: string;
    customer?: string;
    customer_key?: string;
    status?: UsageEventStatus;
  },
  params: ListParams = {},
): Promise<PagedList<UsageEvent>> {
  const q = listQuery({ ...params, scope: { ...params.scope, ...scope } });
  return apiGet<PagedList<UsageEvent>>(`${b(biz)}/usage_events${q ? `?${q}` : ""}`);
}

/** Events received in the last 24 hours that count toward a meter; null when unread. */
export async function countMeterEventsLastDay(biz: string, meter: string): Promise<number | null> {
  const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const page = await listUsageEvents(
    biz,
    { meter },
    { limit: 1, filters: [{ field: "received", op: "gte", value: String(since) }] },
  ).catch(() => null);
  return page?.total ?? null;
}

export const sendUsageEvent = (biz: string, event: UsageEventInput) =>
  apiWrite(`${b(biz)}/usage_events`, event, "POST");

export const voidUsageEvent = (
  biz: string,
  body: { key: string; timestamp?: string; reason?: string },
) => apiWrite(`${b(biz)}/usage_events/void`, body, "POST");

export const listUsageKeys = (biz: string, cus: string) =>
  apiGet<List<UsageKey>>(`${b(biz)}/customers/${cus}/usage_keys`);

export const addUsageKey = (biz: string, cus: string, key: string) =>
  apiWrite(`${b(biz)}/customers/${cus}/usage_keys`, { key }, "POST");

export const removeUsageKey = (biz: string, cus: string, key: string) =>
  apiWrite(`${b(biz)}/customers/${cus}/usage_keys/remove`, { key }, "POST");
