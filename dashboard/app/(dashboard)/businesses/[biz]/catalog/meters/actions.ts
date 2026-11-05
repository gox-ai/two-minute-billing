"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";
import {
  archiveMeter,
  createMeter,
  sendUsageEvent,
  updateMeter,
  type MeterPriceList,
  type MeterWrite,
} from "@/lib/api/meters";
import {
  MAX_GROUP_BY,
  MAX_LIMIT_DIMENSIONS,
  METER_AGGREGATIONS,
  canRecur,
  isPropertyName,
  needsUniqueProperty,
  needsValueProperty,
} from "@/lib/meters";

const metersPath = (biz: string) => `/businesses/${biz}/catalog/meters`;

const property = z
  .string()
  .trim()
  .max(100)
  .refine((v) => v === "" || isPropertyName(v), {
    message: "Use only letters, digits, dots, dashes or underscores.",
  });

/** `[{property, values: "a, b"}]` → `{property: ["a", "b"]}`. */
const filtersFromForm = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (!raw) return {} as Record<string, string[]>;
    let rows: Array<{ property?: string; values?: string }>;
    try {
      rows = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: "We could not read the filters. Reload the page." });
      return z.NEVER;
    }
    const out: Record<string, string[]> = {};
    for (const r of rows) {
      const p = (r.property ?? "").trim();
      const values = (r.values ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (!p && !values.length) continue;
      if (!p || !isPropertyName(p) || !values.length) {
        ctx.addIssue({
          code: "custom",
          message: "Each filter needs a property name and at least one value.",
        });
        return z.NEVER;
      }
      out[p] = values;
    }
    return out;
  });

/** A JSON list of property names from a rows editor: at most `max`, each once. */
const propertyListFromForm = (max: number, what: string) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw) return [] as string[];
      let list: string[];
      try {
        list = (JSON.parse(raw) as string[]).map((s) => String(s).trim()).filter(Boolean);
      } catch {
        ctx.addIssue({ code: "custom", message: `We could not read the ${what} list.` });
        return z.NEVER;
      }
      if (list.length > max || list.some((p) => !isPropertyName(p))) {
        ctx.addIssue({
          code: "custom",
          message: `Enter at most ${max} property names. Use only letters, digits, dots, dashes or underscores.`,
        });
        return z.NEVER;
      }
      if (new Set(list).size !== list.length) {
        ctx.addIssue({
          code: "custom",
          message: "Each property can be in the list one time only.",
        });
        return z.NEVER;
      }
      return list;
    });
const groupByFromForm = propertyListFromForm(MAX_GROUP_BY, "group by");
const limitDimensionsFromForm = propertyListFromForm(MAX_LIMIT_DIMENSIONS, "limit property");

/** The Cost section's mapping: "" = not mapped (event cost only). */
const priceListFromForm = z
  .string()
  .optional()
  .transform((raw, ctx): MeterPriceList | null => {
    if (!raw) return null;
    let m: MeterPriceList;
    try {
      m = JSON.parse(raw);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "We could not read the cost settings. Reload the page.",
      });
      return z.NEVER;
    }
    for (const k of ["provider_key", "model_key", "token_type_key"] as const) {
      const v = m[k];
      if (v != null && v !== "" && !isPropertyName(v)) {
        ctx.addIssue({
          code: "custom",
          message: "Use only letters, digits, dots, dashes or underscores in a property name.",
        });
        return z.NEVER;
      }
    }
    if (!m.token_type && !m.token_type_key) {
      ctx.addIssue({
        code: "custom",
        message: "Select the token type, or the property that holds it.",
      });
      return z.NEVER;
    }
    return m;
  });

/** Cost fields (design G1b § 5.3). They do not change what the meter counts, so a locked meter takes them. */
function costBody(d: {
  cost_present?: string;
  price_list: MeterPriceList | null;
  cost_currency?: string;
}) {
  if (d.cost_present !== "1") return {};
  return {
    price_list: d.price_list,
    cost_currency: d.cost_currency ? d.cost_currency.toUpperCase() : null,
  };
}

const meterSchema = z
  .object({
    biz: z.string().min(1),
    meter: z.string().optional(),
    locked: z.string().optional(),
    expected_version: z.coerce.number().int().optional(),
    name: z.string().trim().min(1, "Enter a name.").max(200, "Enter 200 characters or fewer."),
    key: z
      .string()
      .trim()
      .max(100)
      .refine((v) => v === "" || /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v), {
        message: "Use only letters, digits, dots, dashes or underscores. Do not use spaces.",
      })
      .optional(),
    event_name: z.string().trim().max(200).optional(),
    aggregation: z.enum(METER_AGGREGATIONS).optional(),
    value_property: property.optional(),
    unique_property: property.optional(),
    recurring: z.string().optional(),
    time_unit: z.enum(["hour", "day"]).optional(),
    filters: filtersFromForm,
    group_by: groupByFromForm,
    limit_dimensions: limitDimensionsFromForm,
    cost_present: z.string().optional(),
    price_list: priceListFromForm,
    cost_currency: z
      .string()
      .trim()
      .optional()
      .refine((v) => !v || /^[A-Za-z]{3}$/.test(v), { message: "Select a currency." }),
  })
  .superRefine((v, ctx) => {
    if (v.locked === "1") return;
    if (!v.event_name)
      ctx.addIssue({ code: "custom", path: ["event_name"], message: "Enter the event name." });
    const agg = v.aggregation ?? "sum";
    if (needsValueProperty(agg) && !v.value_property)
      ctx.addIssue({
        code: "custom",
        path: ["value_property"],
        message: "Enter the property that holds the value.",
      });
    if (needsUniqueProperty(agg) && !v.unique_property)
      ctx.addIssue({
        code: "custom",
        path: ["unique_property"],
        message: "Enter the property to count.",
      });
  });

function meterBody(d: z.infer<typeof meterSchema>): MeterWrite {
  const agg = d.aggregation ?? "sum";
  return {
    name: d.name,
    event_name: d.event_name,
    aggregation: agg,
    value_property: needsValueProperty(agg) ? d.value_property || null : null,
    unique_property: needsUniqueProperty(agg) ? d.unique_property || null : null,
    recurring: canRecur(agg) && d.recurring === "on",
    time_unit: agg === "weighted_sum" ? (d.time_unit ?? "hour") : null,
    filters: d.filters,
    group_by: d.group_by,
    limit_dimensions: d.limit_dimensions,
  };
}

export async function createMeterAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("meters:manage", "manager");
  const parsed = parseForm(meterSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const res = await createMeter(d.biz, {
    ...(d.key ? { id: d.key } : {}),
    ...meterBody(d),
    ...costBody(d),
  });
  revalidatePath(metersPath(d.biz));
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "That meter ID is already in use.", {
        errors: { key: res.error ?? "That meter ID is already in use." },
      });
    return actionError(res.error ?? "We could not create the meter.", {
      requestId: res.requestId,
      ...(res.param ? { errors: { [res.param]: res.error ?? "" } } : {}),
    });
  }
  const key = (res.data as { id?: string } | undefined)?.id ?? d.key;
  return actionOk(`Meter ${d.name} created.`, key ? `${metersPath(d.biz)}/${key}` : undefined);
}

export async function updateMeterAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("meters:manage", "manager");
  const parsed = parseForm(meterSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  if (!d.meter) return actionError("The meter ID is missing. Reload the page.");
  // A meter with usage takes a name change only (design G1a § 3.1).
  const body: MeterWrite = {
    // Limit properties change no count, so they stay editable after usage.
    ...(d.locked === "1" ? { name: d.name, limit_dimensions: d.limit_dimensions } : meterBody(d)),
    ...costBody(d),
  };
  if (d.expected_version) body.expected_version = d.expected_version;
  const res = await updateMeter(d.biz, d.meter, body);
  revalidatePath(`${metersPath(d.biz)}/${d.meter}`);
  revalidatePath(metersPath(d.biz));
  if (!res.ok)
    return actionError(res.error ?? "We could not change the meter.", { requestId: res.requestId });
  return actionOk("Meter saved.", `${metersPath(d.biz)}/${d.meter}`);
}

export async function archiveMeterAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("meters:manage", "manager");
  const biz = String(fd.get("biz") ?? "");
  const meter = String(fd.get("meter") ?? "");
  if (!biz || !meter) return actionError("The meter ID is missing. Reload the page.");
  const res = await archiveMeter(biz, meter);
  revalidatePath(`${metersPath(biz)}/${meter}`);
  revalidatePath(metersPath(biz));
  if (!res.ok)
    return actionError(res.error ?? "We could not archive the meter.", {
      requestId: res.requestId,
    });
  return actionOk("Meter archived.");
}

const testEventSchema = z.object({
  biz: z.string().min(1),
  meter: z.string().min(1),
  event_name: z.string().min(1),
  customer: z
    .string()
    .trim()
    .min(1, "Enter a usage key or a customer ID.")
    .max(255, "Enter 255 characters or fewer."),
  properties: z.string().optional(),
});

/** Posts one real event, keyed `test_<random>`, so it bills like any other event. */
export async function sendTestEventAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("usage_events:manage", "ops");
  const parsed = parseForm(testEventSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  let properties: Record<string, string> = {};
  try {
    const raw = JSON.parse(d.properties || "{}") as Record<string, string>;
    properties = Object.fromEntries(
      Object.entries(raw)
        .map(([k, v]) => [k, String(v).trim()] as const)
        .filter(([, v]) => v !== ""),
    );
  } catch {
    return actionError("We could not read the properties. Reload the page.");
  }
  const key = `test_${crypto.randomUUID().replace(/-/g, "").slice(0, 21)}`;
  const res = await sendUsageEvent(d.biz, {
    key,
    customer: d.customer,
    event_name: d.event_name,
    properties,
  });
  revalidatePath(`${metersPath(d.biz)}/${d.meter}`);
  if (!res.ok)
    return actionError(res.error ?? "We could not send the event.", {
      requestId: res.requestId,
    });
  const ev = (res.data as { event?: { customer?: string | null } } | undefined)?.event;
  return actionOk(
    ev && ev.customer === null
      ? `Event ${key} sent. No customer has this usage key, so the event is unmatched.`
      : `Event ${key} sent.`,
  );
}
