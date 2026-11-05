import { and, eq, inArray, isNull } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { customers, hubspotLinks, subscriptions } from "@db/schema";
import { HubSpotApiError, type HubSpotClient } from "../client";
import { HubSpotAuthError } from "../oauth";
import type { SyncContext } from "./context";
import { heldLocalIds, HELD_MESSAGE } from "./conflicts";
import {
  associateContactCompany,
  buildProperties,
  createProperties,
  LIVE_STATUSES,
  matchedWrite,
  matchValue,
  noMatchMessage,
  noValueMessage,
  OBJECTS,
  pushCustomer,
  pushObject,
  sharedCompanyMessage,
  terminalFailure,
  type Customer,
  type Link,
  type MatchRule,
  type RemoteRecord,
  type RemoteType,
  type Resolved,
} from "./customers";
import { customerResolver, type FieldResolver } from "./fields";
import { propertiesHash, upsertLink, type SyncOutcome } from "./links";

/**
 * Many customers at once: one IN search per object and ≤100 values, batch create / update /
 * read, one batch association call. Same rules and outcomes as `pushCustomer`; any record a
 * batch call cannot place goes through the single-record path for that object instead.
 */

/** HubSpot's cap on batch inputs and on IN values. */
export const BATCH_LIMIT = 100;
const SEARCH_PAGE = 200;
const SEARCH_MAX = 10_000;

export type CustomerResult = { outcomes: SyncOutcome[] } | { error: unknown };

interface Item {
  customer: Customer;
  links: Link[];
  resolve: FieldResolver;
  held: Set<RemoteType>;
  contact?: Resolved;
  company?: Resolved;
  error?: unknown;
}

/** One object's pending write for one customer. */
interface Plan {
  item: Item;
  properties: Record<string, string>;
  hash: string;
  value?: string;
}

const base = (c: Customer, type: RemoteType) =>
  ({ localType: "customer", localRef: c.publicId, remoteType: type }) as const;

const chunks = <T>(xs: T[], n = BATCH_LIMIT) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** The duplicate-unique refusal, with the value, so the one input holding it can be set aside. */
function duplicateValue(err: HubSpotApiError): { prop: string; value: string } | null {
  if (err.status !== 400) return null;
  const m = /propertyName=([^,}\s]+), value=([^}]*)\}[\s\S]*already has that value/.exec(
    err.message,
  );
  return m ? { prop: m[1]!, value: m[2]! } : null;
}

/** Input keys a batch error names: `objectWriteTraceId` on create, `ids` on update. */
function namedInputs(errors: unknown): string[] {
  const out: string[] = [];
  for (const e of (errors as Array<{ context?: Record<string, unknown> }> | undefined) ?? []) {
    for (const k of ["objectWriteTraceId", "ids"]) {
      const v = e?.context?.[k];
      if (Array.isArray(v)) out.push(...v.map(String));
    }
  }
  return out;
}

const existingId = (message: string | undefined) =>
  /Existing ID:\s*(\d+)/i.exec(message ?? "")?.[1] ?? null;

/**
 * Batch create or update. Returns the HubSpot id per input key; keys missing from the map
 * failed and belong to the single-record path. A 409 naming the holder comes back in `existing`.
 */
async function batchWrite(
  client: HubSpotClient,
  object: string,
  op: "create" | "update",
  inputs: Array<{ key: string; id?: string; properties: Record<string, string>; match?: string }>,
  matchProp?: string,
): Promise<{ ids: Map<string, string>; existing: Map<string, string> }> {
  const ids = new Map<string, string>();
  const existing = new Map<string, string>();
  let pending = inputs;
  for (let round = 0; pending.length > 0 && round < 5; round++) {
    let res: {
      results?: Array<{
        id: string;
        objectWriteTraceId?: string;
        properties?: Record<string, string>;
      }>;
      errors?: Array<{ message?: string; context?: Record<string, unknown> }>;
    } | null;
    try {
      res = await client.request("POST", `/crm/v3/objects/${object}/batch/${op}`, {
        inputs: pending.map((p) =>
          op === "create"
            ? { properties: p.properties, objectWriteTraceId: p.key }
            : { id: p.id, properties: p.properties },
        ),
      });
    } catch (err) {
      if (!(err instanceof HubSpotApiError)) throw err;
      // Set aside the inputs the refusal names, then send the rest again.
      const dup = duplicateValue(err);
      const named = new Set(namedInputs((err.body as { errors?: unknown })?.errors));
      if (dup) for (const p of pending) if (p.properties[dup.prop] === dup.value) named.add(p.key);
      if (op === "update") for (const p of pending) if (named.has(p.id!)) named.add(p.key);
      const one = existingId(err.message);
      if (err.status === 409 && one && pending.length === 1) existing.set(pending[0]!.key, one);
      const rest = pending.filter((p) => !named.has(p.key));
      if (rest.length === pending.length) return { ids, existing };
      pending = rest;
      continue;
    }
    const byKey = new Map(pending.map((p) => [p.key, p]));
    const byMatch = new Map(pending.map((p) => [p.match, p]));
    for (const r of res?.results ?? []) {
      const p =
        op === "update"
          ? pending.find((x) => x.id === String(r.id))
          : ((r.objectWriteTraceId && byKey.get(r.objectWriteTraceId)) ??
            (matchProp ? byMatch.get(r.properties?.[matchProp]?.trim().toLowerCase()) : undefined));
      if (p && r.id) ids.set(p.key, String(r.id));
    }
    for (const e of res?.errors ?? []) {
      const holder = existingId(e.message);
      if (!holder) continue;
      for (const k of namedInputs([e])) if (byKey.has(k)) existing.set(k, holder);
    }
    break;
  }
  return { ids, existing };
}

/** Records whose `property` is one of `values` (lowercased), first hit per value. */
async function searchIn(
  client: HubSpotClient,
  type: RemoteType,
  property: string,
  values: string[],
  read: string[],
): Promise<Map<string, RemoteRecord>> {
  const found = new Map<string, RemoteRecord>();
  let after: string | undefined;
  let seen = 0;
  do {
    const page = await client.request<{
      results?: RemoteRecord[];
      paging?: { next?: { after?: string } };
    }>("POST", `/crm/v3/objects/${OBJECTS[type]}/search`, {
      filterGroups: [{ filters: [{ propertyName: property, operator: "IN", values }] }],
      properties: [...new Set([property, ...read])],
      limit: SEARCH_PAGE,
      ...(after ? { after } : {}),
    });
    for (const r of page?.results ?? []) {
      const key = r.properties?.[property]?.trim().toLowerCase();
      if (key && !found.has(key)) found.set(key, r);
    }
    seen += page?.results?.length ?? 0;
    after = page?.paging?.next?.after;
  } while (after && seen + SEARCH_PAGE <= SEARCH_MAX);
  return found;
}

/** Every customer link to these companies, with the holder's public id. */
async function companyHolders(ctx: SyncContext, companyIds: string[]) {
  const { conn } = ctx;
  if (companyIds.length === 0) return [];
  return withTenant(conn.organizationId, (tx) =>
    tx
      .select({
        remoteId: hubspotLinks.remoteId,
        localId: hubspotLinks.localId,
        publicId: customers.publicId,
      })
      .from(hubspotLinks)
      .leftJoin(customers, eq(customers.id, hubspotLinks.localId))
      .where(
        and(
          eq(hubspotLinks.connectionId, conn.id),
          eq(hubspotLinks.localType, "customer"),
          eq(hubspotLinks.remoteType, "company"),
          inArray(hubspotLinks.remoteId, companyIds),
        ),
      ),
  ).then((rows) => rows.map((r) => ({ ...r, publicId: r.publicId ?? "another customer" })));
}

export async function pushCustomers(
  ctx: SyncContext,
  customerIds: string[],
): Promise<Map<string, CustomerResult>> {
  const { conn, settings } = ctx;
  const s = settings.customers;
  const results = new Map<string, CustomerResult>();

  const loaded = await withTenant(conn.organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(customers)
      .where(and(inArray(customers.id, customerIds), eq(customers.businessId, conn.businessId)));
    const links = await tx
      .select()
      .from(hubspotLinks)
      .where(
        and(
          eq(hubspotLinks.connectionId, conn.id),
          eq(hubspotLinks.localType, "customer"),
          inArray(hubspotLinks.localId, customerIds),
        ),
      );
    let live: Set<string> | null = null;
    if (s.scope === "active_subscriptions") {
      const subs = await tx
        .selectDistinct({ id: subscriptions.customerId })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.businessId, conn.businessId),
            inArray(subscriptions.customerId, customerIds),
            isNull(subscriptions.deletedAt),
            inArray(subscriptions.status, LIVE_STATUSES),
          ),
        );
      live = new Set(subs.map((r) => r.id));
    }
    return { rows, links, live };
  });
  const heldContacts = await heldLocalIds(conn, "contact", customerIds);
  const heldCompanies = await heldLocalIds(conn, "company", customerIds);

  const byId = new Map(loaded.rows.map((c) => [c.id, c]));
  const items: Item[] = [];
  for (const id of customerIds) {
    const customer = byId.get(id);
    if (!customer) {
      results.set(id, {
        outcomes: [
          { action: "skipped", localType: "customer", message: "Customer no longer exists" },
        ],
      });
      continue;
    }
    if (loaded.live && !loaded.live.has(id)) {
      results.set(id, {
        outcomes: [
          {
            action: "skipped",
            localType: "customer",
            localRef: customer.publicId,
            message: "Only customers with an active subscription sync",
          },
        ],
      });
      continue;
    }
    const held = new Set<RemoteType>();
    if (heldContacts.has(id)) held.add("contact");
    if (heldCompanies.has(id)) held.add("company");
    items.push({
      customer,
      links: loaded.links.filter((l) => l.localId === id),
      resolve: customerResolver(conn, customer),
      held,
    });
  }

  // Two customers matching the same record: the later one runs alone after the batch, so it
  // sees the first one's link (the company-sharing guard, fill_empty over what we just wrote).
  const deferred: Item[] = [];
  const taken = { contact: new Set<string>(), company: new Set<string>() };
  const batched: Item[] = [];
  for (const item of items) {
    let clash = false;
    for (const type of ["contact", "company"] as const) {
      const rule = type === "contact" ? s.contactMatch : s.companyMatch;
      if (!rule || item.held.has(type) || item.links.some((l) => l.remoteType === type)) continue;
      const v = (await matchValue(rule.local, item.customer, type, item.resolve))?.toLowerCase();
      if (!v) continue;
      if (taken[type].has(v)) clash = true;
      taken[type].add(v);
    }
    (clash ? deferred : batched).push(item);
  }

  await pushType(ctx, batched, "contact");
  if (s.companyMatch) await pushType(ctx, batched, "company");
  await associate(ctx.client, batched);

  for (const item of batched) {
    if (item.error !== undefined) {
      results.set(item.customer.id, { error: item.error });
      continue;
    }
    // Links last, as in the single path: a failure above leaves nothing half-linked.
    for (const type of ["contact", "company"] as const) {
      const r = item[type];
      if (r?.remoteId && r.hash !== undefined)
        await upsertLink(conn, {
          localType: "customer",
          localId: item.customer.id,
          remoteType: type,
          remoteId: r.remoteId,
          hash: r.hash,
          written: r.written,
        });
    }
    results.set(item.customer.id, {
      outcomes: [item.contact!.outcome, ...(item.company ? [item.company.outcome] : [])],
    });
  }

  for (const item of deferred) {
    try {
      results.set(item.customer.id, { outcomes: await pushCustomer(ctx, item.customer.id) });
    } catch (err) {
      if (err instanceof HubSpotAuthError) throw err;
      results.set(item.customer.id, { error: err });
    }
  }
  return results;
}

/** Record a failure the way the single path would: a terminal company error costs only the company. */
function fail(item: Item, type: RemoteType, err: unknown) {
  if (err instanceof HubSpotAuthError) throw err;
  const terminal = type === "company" ? terminalFailure(item.customer, type, err) : null;
  if (terminal) item.company = terminal;
  else item.error = err;
}

/** The single-record path for one object of one customer. */
async function single(ctx: SyncContext, item: Item, type: RemoteType) {
  try {
    const link = item.links.find((l) => l.remoteType === type) ?? null;
    item[type] = await pushObject(ctx, item.customer, type, link, item.resolve);
  } catch (err) {
    fail(item, type, err);
  }
}

async function pushType(ctx: SyncContext, all: Item[], type: RemoteType) {
  const { client, settings } = ctx;
  const s = settings.customers;
  const rule = (type === "contact" ? s.contactMatch : s.companyMatch) as MatchRule;
  const object = OBJECTS[type];

  const linked: Array<Plan & { remoteId: string }> = [];
  const toMatch: Plan[] = [];
  const fallback: Item[] = [];

  for (const item of all) {
    if (item.error !== undefined) continue;
    const c = item.customer;
    const link = item.links.find((l) => l.remoteType === type) ?? null;
    if (item.held.has(type)) {
      item[type] = {
        outcome: {
          ...base(c, type),
          action: "skipped",
          remoteId: link?.remoteId,
          message: HELD_MESSAGE,
        },
        remoteId: link?.remoteId,
      };
      continue;
    }
    try {
      const properties = await buildProperties(ctx, c, type, item.resolve);
      const hash = propertiesHash(properties);
      if (link) {
        const skip = (message: string): Resolved => ({
          outcome: { ...base(c, type), action: "skipped", remoteId: link.remoteId, message },
          remoteId: link.remoteId,
        });
        if (link.lastPushedHash === hash) item[type] = skip("No changes");
        else if (settings.updates.localChange !== "overwrite_remote")
          item[type] = skip("Updates to HubSpot are off");
        // One id per batch call: a shared company's second customer goes alone.
        else if (linked.some((p) => p.remoteId === link.remoteId)) fallback.push(item);
        else linked.push({ item, properties, hash, remoteId: link.remoteId });
        continue;
      }
      const value = await matchValue(rule.local, c, type, item.resolve);
      if (!value) {
        item[type] = {
          outcome: { ...base(c, type), action: "skipped", message: noValueMessage(rule, type) },
        };
        continue;
      }
      toMatch.push({ item, properties, hash, value });
    } catch (err) {
      fail(item, type, err);
    }
  }

  // Linked records: one batch update. Anything it cannot place (a 404, a duplicate) goes alone.
  for (const part of chunks(linked)) {
    const { ids } = await batchWrite(
      client,
      object,
      "update",
      part.map((p) => ({ key: p.item.customer.id, id: p.remoteId, properties: p.properties })),
    );
    for (const p of part) {
      if (!ids.has(p.item.customer.id)) {
        fallback.push(p.item);
        continue;
      }
      p.item[type] = {
        outcome: { ...base(p.item.customer, type), action: "updated", remoteId: p.remoteId },
        remoteId: p.remoteId,
        hash: p.hash,
        written: p.properties,
      };
    }
  }

  // Unlinked: one IN search per ≤100 values.
  const matched: Array<Plan & { found: RemoteRecord }> = [];
  const missing: Plan[] = [];
  for (const part of chunks(toMatch)) {
    let found: Map<string, RemoteRecord>;
    try {
      found = await searchIn(
        client,
        type,
        rule.remote,
        [...new Set(part.map((p) => p.value!.toLowerCase()))],
        [...new Set(part.flatMap((p) => Object.keys(p.properties)))],
      );
    } catch (err) {
      if (!(err instanceof HubSpotApiError)) throw err;
      fallback.push(...part.map((p) => p.item));
      continue;
    }
    for (const p of part) {
      const hit = found.get(p.value!.toLowerCase());
      if (hit) matched.push({ ...p, found: hit });
      else missing.push(p);
    }
  }

  // Missing: batch create, or skip when creating is off. A 409 naming the holder is a match.
  const created: Plan[] = [];
  if (!s.createMissing) {
    for (const p of missing)
      p.item[type] = {
        outcome: {
          ...base(p.item.customer, type),
          action: "skipped",
          message: noMatchMessage(type),
        },
      };
  } else created.push(...missing);
  for (const part of chunks(created)) {
    const inputs = part.map((p, i) => ({
      key: String(i),
      properties: createProperties(type, rule, p.properties, p.value!),
      match: p.value!.toLowerCase(),
    }));
    const { ids, existing } = await batchWrite(client, object, "create", inputs, rule.remote);
    part.forEach((p, i) => {
      const id = ids.get(String(i));
      const holder = existing.get(String(i));
      if (id)
        p.item[type] = {
          outcome: { ...base(p.item.customer, type), action: "created", remoteId: id },
          remoteId: id,
          hash: p.hash,
          fresh: true,
          written: inputs[i]!.properties,
        };
      else if (holder) matched.push({ ...p, found: { id: holder } });
      else fallback.push(p.item);
    });
  }

  // Matched an existing record: the sharing guard, then `onMatch`.
  let writable = matched;
  if (type === "company" && !s.multipleCustomersPerCompany) {
    const holders = await companyHolders(
      ctx,
      matched.map((m) => m.found.id),
    );
    writable = [];
    for (const m of matched) {
      const h = holders.find((x) => x.remoteId === m.found.id && x.localId !== m.item.customer.id);
      if (!h) {
        writable.push(m);
        continue;
      }
      m.item[type] = {
        outcome: {
          ...base(m.item.customer, type),
          action: "skipped",
          remoteId: m.found.id,
          message: sharedCompanyMessage(h.publicId),
        },
      };
    }
  }
  if (s.onMatch === "fill_empty") {
    const unread = writable.filter((m) => !m.found.properties);
    for (const part of chunks(unread)) {
      try {
        const res = await client.request<{ results?: RemoteRecord[] }>(
          "POST",
          `/crm/v3/objects/${object}/batch/read`,
          {
            inputs: part.map((m) => ({ id: m.found.id })),
            properties: [...new Set(part.flatMap((m) => Object.keys(m.properties)))],
          },
        );
        const byId = new Map((res?.results ?? []).map((r) => [String(r.id), r]));
        for (const m of part) m.found.properties = byId.get(m.found.id)?.properties;
      } catch (err) {
        if (!(err instanceof HubSpotApiError)) throw err;
      }
    }
  }
  const writes: Array<{
    m: (typeof writable)[number];
    write: Record<string, string>;
    note: string;
  }> = [];
  for (const m of writable) {
    if (s.onMatch === "fill_empty" && !m.found.properties) {
      fallback.push(m.item);
      continue;
    }
    const { write, note } = matchedWrite(s.onMatch, m.properties, m.found.properties ?? {});
    writes.push({ m, write, note });
  }
  const toWrite = writes.filter((w) => Object.keys(w.write).length > 0);
  const written = new Set<string>();
  for (const part of chunks(toWrite)) {
    const { ids } = await batchWrite(
      client,
      object,
      "update",
      part.map((w) => ({ key: w.m.item.customer.id, id: w.m.found.id, properties: w.write })),
    );
    for (const k of ids.keys()) written.add(k);
  }
  for (const { m, write, note } of writes) {
    const wrote = Object.keys(write).length > 0;
    if (wrote && !written.has(m.item.customer.id)) {
      fallback.push(m.item);
      continue;
    }
    m.item[type] = {
      outcome: {
        ...base(m.item.customer, type),
        action: "updated",
        remoteId: m.found.id,
        message: note,
      },
      remoteId: m.found.id,
      hash: m.hash,
      fresh: true,
      written: write,
    };
  }

  for (const item of fallback) await single(ctx, item, type);
}

/** Contact ↔ company for every customer linked afresh on either side; one call per 100. */
async function associate(client: HubSpotClient, items: Item[]) {
  const pairs = items.filter(
    (i) =>
      i.error === undefined &&
      i.contact?.remoteId &&
      i.company?.remoteId &&
      (i.contact.fresh || i.company.fresh),
  );
  for (const part of chunks(pairs)) {
    let ok = false;
    try {
      const res = await client.request<{ errors?: unknown[] }>(
        "POST",
        "/crm/v4/associations/contacts/companies/batch/associate/default",
        {
          inputs: part.map((i) => ({
            from: { id: i.contact!.remoteId },
            to: { id: i.company!.remoteId },
          })),
        },
      );
      ok = !res?.errors?.length;
    } catch (err) {
      if (!(err instanceof HubSpotApiError)) throw err;
    }
    if (ok) continue;
    // Associating is idempotent: redo the chunk one pair at a time.
    for (const i of part) {
      try {
        await associateContactCompany(client, i.contact!.remoteId!, i.company!.remoteId!);
      } catch (err) {
        if (err instanceof HubSpotAuthError) throw err;
        i.error = err;
      }
    }
  }
}
