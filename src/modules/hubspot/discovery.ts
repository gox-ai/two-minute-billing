import type { HubSpotClient } from "./client";

export const DISCOVERABLE = ["contacts", "companies", "deals", "products"] as const;
export type DiscoverableObject = (typeof DISCOVERABLE)[number];

export interface DiscoveredProperty {
  name: string;
  label: string;
  type: string | null;
  fieldType: string | null;
  group: string | null;
  unique: boolean;
  /** False for calculated and read-only properties: pickable as a source, never as a target. */
  writable: boolean;
  options: Array<{ label: string; value: string }>;
}

/**
 * The portal's own properties for one object — they differ between any two merchants.
 * `object` is a standard object name or a custom object's `objectTypeId`.
 */
export async function listProperties(
  client: HubSpotClient,
  object: DiscoverableObject | `2-${string}`,
): Promise<DiscoveredProperty[]> {
  const body = await client.request<{ results?: unknown[] }>(
    "GET",
    `/crm/v3/properties/${encodeURIComponent(object)}`,
  );
  const rows = Array.isArray(body?.results) ? body.results : [];
  return rows
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r.name === "string" && r.hidden !== true)
    .map((r) => ({
      name: r.name as string,
      label: typeof r.label === "string" && r.label ? r.label : (r.name as string),
      type: typeof r.type === "string" ? r.type : null,
      fieldType: typeof r.fieldType === "string" ? r.fieldType : null,
      group: typeof r.groupName === "string" ? r.groupName : null,
      unique: r.hasUniqueValue === true,
      writable:
        r.calculated !== true &&
        (r.modificationMetadata as Record<string, unknown> | undefined)?.readOnlyValue !== true,
      options: Array.isArray(r.options)
        ? (r.options as Array<Record<string, unknown>>)
            .filter((o) => typeof o.value === "string")
            .map((o) => ({ label: String(o.label ?? o.value), value: o.value as string }))
        : [],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export interface DiscoveredPipeline {
  id: string;
  label: string;
  stages: Array<{ id: string; label: string; closed: boolean }>;
}

export async function listDealPipelines(client: HubSpotClient): Promise<DiscoveredPipeline[]> {
  const body = await client.request<{ results?: unknown[] }>("GET", "/crm/v3/pipelines/deals");
  const rows = Array.isArray(body?.results) ? body.results : [];
  return rows.map((r) => {
    const p = r as Record<string, unknown>;
    const stages = Array.isArray(p.stages) ? (p.stages as Array<Record<string, unknown>>) : [];
    return {
      id: String(p.id),
      label: String(p.label ?? p.id),
      stages: stages
        .filter((s) => s.archived !== true)
        .sort((a, b) => Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0))
        .map((s) => ({
          id: String(s.id),
          label: String(s.label ?? s.id),
          closed: (s.metadata as Record<string, unknown> | undefined)?.isClosed === "true",
        })),
    };
  });
}

export interface DiscoveredObject {
  /** `objectTypeId`, e.g. `2-1234567`: what `invoices.objectType` stores. */
  id: string;
  name: string;
  label: string;
}

/** The portal's custom objects (Enterprise only), for the invoice object picker. */
export async function listCustomObjects(client: HubSpotClient): Promise<DiscoveredObject[]> {
  const body = await client.request<{ results?: unknown[] }>("GET", "/crm/v3/schemas");
  const rows = Array.isArray(body?.results) ? body.results : [];
  return rows
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r.objectTypeId === "string" && r.archived !== true)
    .map((r) => {
      const labels = (r.labels ?? {}) as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name : (r.objectTypeId as string);
      return {
        id: r.objectTypeId as string,
        name,
        label: typeof labels.plural === "string" && labels.plural ? labels.plural : name,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
