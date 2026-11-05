import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { customers, hubspotLinks, subscriptions } from "@db/schema";
import { HubSpotApiError, type Connection, type HubSpotClient, droppedNote } from "../client";
import type { HubSpotSettings } from "../settings";
import type { PushHandler, SyncContext } from "./context";
import { customerResolver, mappedProperties, type FieldResolver } from "./fields";
import { propertiesHash, upsertLink, type SyncOutcome } from "./links";
import { heldRemoteTypes, HELD_MESSAGE } from "./conflicts";

export type Customer = typeof customers.$inferSelect;
export type Link = typeof hubspotLinks.$inferSelect;
export type RemoteType = "contact" | "company";
export type RemoteRecord = { id: string; properties?: Record<string, string | null> };
export type MatchRule = NonNullable<HubSpotSettings["customers"]["companyMatch"]>;

export const OBJECTS = { contact: "contacts", company: "companies" } as const;

/** Stored statuses that count as a live subscription; `active` covers non-renewing too. */
export const LIVE_STATUSES = ["active", "in_trial", "future"];

/** A pending link write, applied once every HubSpot call for the customer has succeeded. */
export interface Resolved {
  outcome: SyncOutcome;
  remoteId?: string;
  hash?: string;
  /** Linked in this push (new, or re-matched after a delete): needs the association. */
  fresh?: boolean;
  /** What HubSpot now holds from us, for the pull's change detection. */
  written?: Record<string, string>;
}

/** Customer → Contact and (when company matching is on) Company, associated to each other. */
export const pushCustomer: PushHandler = async (ctx, customerId) => {
  const { conn, settings } = ctx;
  const loaded = await withTenant(conn.organizationId, async (tx) => {
    const [customer] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.businessId, conn.businessId)))
      .limit(1);
    if (!customer) return null;
    const links = await tx
      .select()
      .from(hubspotLinks)
      .where(
        and(
          eq(hubspotLinks.connectionId, conn.id),
          eq(hubspotLinks.localType, "customer"),
          eq(hubspotLinks.localId, customerId),
        ),
      );
    let live = true;
    if (settings.customers.scope === "active_subscriptions") {
      const [sub] = await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.businessId, conn.businessId),
            eq(subscriptions.customerId, customerId),
            isNull(subscriptions.deletedAt),
            inArray(subscriptions.status, LIVE_STATUSES),
          ),
        )
        .limit(1);
      live = !!sub;
    }
    return { customer, links, live };
  });
  if (!loaded)
    return [{ action: "skipped", localType: "customer", message: "Customer no longer exists" }];

  const { customer, links, live } = loaded;
  if (!live)
    return [
      {
        action: "skipped",
        localType: "customer",
        localRef: customer.publicId,
        message: "Only customers with an active subscription sync",
      },
    ];

  const resolve = customerResolver(conn, customer);
  const linkOf = (t: RemoteType) => links.find((l) => l.remoteType === t) ?? null;
  // An open conflict holds that object in both directions until someone decides.
  const held = await heldRemoteTypes(conn, "customer", customer.id);
  const push = (t: RemoteType): Promise<Resolved> =>
    held.has(t)
      ? Promise.resolve({
          outcome: {
            action: "skipped",
            localType: "customer",
            localRef: customer.publicId,
            remoteType: t,
            remoteId: linkOf(t)?.remoteId,
            message: HELD_MESSAGE,
          },
          remoteId: linkOf(t)?.remoteId,
        })
      : pushObject(ctx, customer, t, linkOf(t), resolve);

  const contact = await push("contact");
  const company = settings.customers.companyMatch
    ? await guardTerminal(customer, "company", () => push("company"))
    : null;

  const contactId = contact.remoteId;
  const companyId = company?.remoteId;
  if (contactId && companyId && (contact.fresh || company?.fresh)) {
    await associateContactCompany(ctx.client, contactId, companyId);
  }

  // Links last: a failure above leaves nothing half-linked, and the retry matches afresh.
  for (const [type, r] of [
    ["contact", contact],
    ["company", company],
  ] as const) {
    if (r?.remoteId && r.hash !== undefined)
      await upsertLink(conn, {
        localType: "customer",
        localId: customer.id,
        remoteType: type,
        remoteId: r.remoteId,
        hash: r.hash,
        written: r.written,
      });
  }
  return [contact.outcome, ...(company ? [company.outcome] : [])];
};

export function associateContactCompany(
  client: HubSpotClient,
  contactId: string,
  companyId: string,
) {
  return client.request(
    "PUT",
    `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/default/companies/${encodeURIComponent(companyId)}`,
  );
}

/** The hash a push would store for the contact or company, so a pull can tell whether ours moved. */
export async function customerPushHash(
  ctx: SyncContext,
  customer: Customer,
  type: RemoteType,
): Promise<string> {
  return propertiesHash(
    await buildProperties(ctx, customer, type, customerResolver(ctx.conn, customer)),
  );
}

/** A terminal 4xx on the company must not cost the contact its link; retryable errors still throw. */
async function guardTerminal(
  customer: Customer,
  type: RemoteType,
  fn: () => Promise<Resolved>,
): Promise<Resolved> {
  try {
    return await fn();
  } catch (err) {
    const failed = terminalFailure(customer, type, err);
    if (failed) return failed;
    throw err;
  }
}

/** The company's outcome for a terminal 4xx; null for anything worth retrying. */
export function terminalFailure(
  customer: Customer,
  type: RemoteType,
  err: unknown,
): Resolved | null {
  if (!(err instanceof HubSpotApiError) || err.retryable) return null;
  return {
    outcome: {
      action: "failed",
      localType: "customer",
      localRef: customer.publicId,
      remoteType: type,
      message: err.message,
    },
  };
}

function emailDomain(email: string | null | undefined): string | null {
  const at = email?.trim().toLowerCase().split("@");
  return at && at.length === 2 && at[1] ? at[1] : null;
}

/** The customer's side of a match rule, or null when the customer has no value for it. */
export async function matchValue(
  local: string,
  customer: Customer,
  type: RemoteType,
  resolve: FieldResolver,
) {
  if (local === "email") {
    const email = customer.email?.trim().toLowerCase() || null;
    return type === "company" ? emailDomain(email) : email;
  }
  // The whole address, for a company property that holds one customer's email.
  if (local === "email_address") return customer.email?.trim().toLowerCase() || null;
  if (local === "company") return customer.company?.trim() || null;
  const v = (await resolve([local])).get(local);
  return v && (v.kind === "text" || v.kind === "number") ? String(v.value) : null;
}

const MATCH_LABEL: Record<string, string> = {
  email: "email",
  email_address: "email address",
  company: "company name",
};

function address(customer: Customer, type: RemoteType): Record<string, string | null | undefined> {
  const line2 = [customer.addressLine2, customer.addressLine3].filter(Boolean).join(", ");
  return type === "contact"
    ? {
        address: [customer.addressLine1, line2].filter(Boolean).join(", "),
        city: customer.city,
        state: customer.state,
        zip: customer.postalCode,
        country: customer.country,
      }
    : {
        address: customer.addressLine1,
        address2: line2,
        city: customer.city,
        state: customer.state,
        zip: customer.postalCode,
        country: customer.country,
      };
}

/** Everything we write to the object: standard properties, the address, then the mappings. */
export async function buildProperties(
  ctx: SyncContext,
  customer: Customer,
  type: RemoteType,
  resolve: FieldResolver,
): Promise<Record<string, string>> {
  const s = ctx.settings.customers;
  const standard: Record<string, string | null | undefined> =
    type === "contact"
      ? {
          email: customer.email?.trim().toLowerCase(),
          firstname: customer.firstName,
          lastname: customer.lastName,
          phone: customer.phone,
          company: customer.company,
        }
      : { name: customer.company, domain: emailDomain(customer.email) };
  if (!s.billingAddressViaCustomFields) Object.assign(standard, address(customer, type));

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(standard))
    if (v != null && v.trim() !== "") out[k] = v.trim();
  const mapped = await mappedProperties(
    ctx.client,
    ctx.conn,
    OBJECTS[type],
    type === "contact" ? s.contactFields : s.companyFields,
    resolve,
  );
  return { ...out, ...mapped };
}

async function search(
  client: HubSpotClient,
  type: RemoteType,
  property: string,
  value: string,
  read: string[],
) {
  const res = await client.request<{ results?: RemoteRecord[] }>(
    "POST",
    `/crm/v3/objects/${OBJECTS[type]}/search`,
    {
      filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
      properties: [...new Set([property, ...read])],
      limit: 1,
    },
  );
  return res?.results?.[0] ?? null;
}

/** Why a customer with no value for the rule is skipped. */
export function noValueMessage(rule: MatchRule, type: RemoteType): string {
  const what = MATCH_LABEL[rule.local] ?? rule.local;
  const label = type === "company" && rule.local === "email" ? "email domain" : what;
  return `Customer has no ${label} to match a ${type} on`;
}

export const noMatchMessage = (type: RemoteType) =>
  `No matching ${type} in HubSpot, and creating missing records is off`;

export const sharedCompanyMessage = (holder: string) =>
  `This company is already linked to ${holder}. Enable "Let several customers share one company" to link it to more than one customer.`;

/** What a create sends: the match property too, so the next search finds what we made. */
export function createProperties(
  type: RemoteType,
  rule: MatchRule,
  properties: Record<string, string>,
  value: string,
): Record<string, string> {
  const create = { ...properties, [rule.remote]: properties[rule.remote] ?? value };
  if (type === "company" && !create.name) create.name = value;
  return create;
}

/** First link to a record that already existed: `onMatch` decides what we write. */
export function matchedWrite(
  onMatch: HubSpotSettings["customers"]["onMatch"],
  properties: Record<string, string>,
  current: Record<string, string | null | undefined>,
): { write: Record<string, string>; note: string } {
  if (onMatch === "overwrite")
    return { write: properties, note: "Linked to an existing record and overwrote its properties" };
  if (onMatch === "link_only")
    return { write: {}, note: "Linked to an existing record without changing it" };
  const write: Record<string, string> = {};
  for (const [k, v] of Object.entries(properties))
    if (current[k] == null || current[k] === "") write[k] = v;
  const n = Object.keys(write).length;
  return {
    write,
    note: `Linked to an existing record. Filled ${n} empty ${n === 1 ? "property" : "properties"}`,
  };
}

/** Another customer already holds this company. */
async function companyTakenBy(conn: Connection, companyId: string, customerId: string) {
  return withTenant(conn.organizationId, async (tx) => {
    const [row] = await tx
      .select({ localId: hubspotLinks.localId })
      .from(hubspotLinks)
      .where(
        and(
          eq(hubspotLinks.connectionId, conn.id),
          eq(hubspotLinks.localType, "customer"),
          eq(hubspotLinks.remoteType, "company"),
          eq(hubspotLinks.remoteId, companyId),
          ne(hubspotLinks.localId, customerId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const [c] = await tx
      .select({ publicId: customers.publicId })
      .from(customers)
      .where(eq(customers.id, row.localId))
      .limit(1);
    return c?.publicId ?? "another customer";
  });
}

/** HubSpot's 409 on create names the record that already holds the unique value. */
function conflictId(err: unknown): string | null {
  if (!(err instanceof HubSpotApiError) || err.status !== 409) return null;
  return /Existing ID:\s*(\d+)/i.exec(err.message)?.[1] ?? null;
}

export async function pushObject(
  ctx: SyncContext,
  customer: Customer,
  type: RemoteType,
  link: Link | null,
  resolve: FieldResolver,
): Promise<Resolved> {
  const { client, conn, settings } = ctx;
  const s = settings.customers;
  const rule = (type === "contact" ? s.contactMatch : s.companyMatch) as MatchRule;
  const base = { localType: "customer", localRef: customer.publicId, remoteType: type } as const;
  const path = (id: string) => `/crm/v3/objects/${OBJECTS[type]}/${encodeURIComponent(id)}`;

  const properties = await buildProperties(ctx, customer, type, resolve);
  const hash = propertiesHash(properties);

  if (link) {
    if (link.lastPushedHash === hash)
      return {
        outcome: { ...base, action: "skipped", remoteId: link.remoteId, message: "No changes" },
        remoteId: link.remoteId,
      };
    if (settings.updates.localChange !== "overwrite_remote")
      return {
        outcome: {
          ...base,
          action: "skipped",
          remoteId: link.remoteId,
          message: "Updates to HubSpot are off",
        },
        remoteId: link.remoteId,
      };
    try {
      const w = await client.writeProperties("PATCH", path(link.remoteId), properties);
      return {
        outcome: {
          ...base,
          action: "updated",
          remoteId: link.remoteId,
          message: droppedNote(w.dropped),
        },
        remoteId: link.remoteId,
        hash,
        written: w.written,
      };
    } catch (err) {
      // Deleted in HubSpot since we linked it: match again.
      if (!(err instanceof HubSpotApiError && err.status === 404)) throw err;
    }
  }

  const value = await matchValue(rule.local, customer, type, resolve);
  if (!value)
    return { outcome: { ...base, action: "skipped", message: noValueMessage(rule, type) } };

  let found = await search(client, type, rule.remote, value, Object.keys(properties));

  if (!found) {
    if (!s.createMissing)
      return {
        outcome: { ...base, action: "skipped", message: noMatchMessage(type) },
      };
    const create = createProperties(type, rule, properties, value);
    try {
      const w = await client.writeProperties<{ id?: string }>(
        "POST",
        `/crm/v3/objects/${OBJECTS[type]}`,
        create,
      );
      const made = w.result;
      if (!made?.id) throw new HubSpotApiError(`HubSpot returned no ${type} id`, 502, true, made);
      return {
        outcome: { ...base, action: "created", remoteId: made.id, message: droppedNote(w.dropped) },
        remoteId: made.id,
        hash,
        fresh: true,
        written: w.written,
      };
    } catch (err) {
      // Search lags creation by a few seconds; a 409 means the record exists after all.
      const existing = conflictId(err);
      if (!existing) throw err;
      found = { id: existing };
    }
  }

  if (type === "company" && !s.multipleCustomersPerCompany) {
    const holder = await companyTakenBy(conn, found.id, customer.id);
    if (holder)
      return {
        outcome: {
          ...base,
          action: "skipped",
          remoteId: found.id,
          message: sharedCompanyMessage(holder),
        },
      };
  }

  const current =
    s.onMatch !== "fill_empty"
      ? {}
      : (found.properties ??
        (
          await client.request<RemoteRecord>(
            "GET",
            `${path(found.id)}?properties=${Object.keys(properties).map(encodeURIComponent).join(",")}`,
          )
        )?.properties ??
        {});
  let { write, note } = matchedWrite(s.onMatch, properties, current);
  if (Object.keys(write).length > 0) {
    const w = await client.writeProperties("PATCH", path(found.id), write);
    write = w.written;
    const left = droppedNote(w.dropped);
    if (left) note = `${note}. ${left}`;
  }
  return {
    outcome: { ...base, action: "updated", remoteId: found.id, message: note },
    remoteId: found.id,
    hash,
    fresh: true,
    written: write,
  };
}
