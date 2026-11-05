import { and, eq, or } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { localDatePartsInTz } from "@/platform/clock";
import { portalEntryUrl } from "@/modules/emails/portal-link";
import { paidTotals } from "@/modules/invoicing/service";
import { serializeInvoice } from "@/modules/invoicing/serialize";
import { businesses, hubspotLinks, invoices } from "@db/schema";
import { HubSpotApiError, type HubSpotClient } from "../client";
import { listProperties } from "../discovery";
import { missingInvoiceScopes } from "../oauth";
import { INVOICE_PROPERTIES } from "../settings";
import type { PushHandler, SyncContext } from "./context";
import { pushCustomer } from "./customers";
import { toHubSpot, type FieldValue } from "./fields";
import { propertiesHash, upsertLink, type SyncOutcome } from "./links";

type Invoice = typeof invoices.$inferSelect;
type ObjectType = `2-${string}`;

/** Our id: the match key on a retry, so a lost link never duplicates the record. */
const ID_PROPERTY = INVOICE_PROPERTIES[0];

const enc = encodeURIComponent;

/** Writable properties of the object → their HubSpot type. Read once per pass (one client per pass). */
const objectProps = new WeakMap<HubSpotClient, Map<string, Promise<Map<string, string | null>>>>();

function propertiesOf(client: HubSpotClient, objectType: ObjectType) {
  let perClient = objectProps.get(client);
  if (!perClient) objectProps.set(client, (perClient = new Map()));
  let p = perClient.get(objectType);
  if (!p) {
    p = listProperties(client, objectType).then(
      (props) => new Map(props.filter((x) => x.writable).map((x) => [x.name, x.type])),
    );
    perClient.set(objectType, p);
    p.catch(() => perClient.delete(objectType));
  }
  return p;
}

async function load(conn: SyncContext["conn"], invoiceId: string) {
  return withTenant(conn.organizationId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.businessId, conn.businessId)))
      .limit(1);
    if (!inv) return null;
    const paid = (await paidTotals(tx, [inv.id])).get(inv.id) ?? 0n;
    const [biz] = await tx
      .select({ timezone: businesses.timezone })
      .from(businesses)
      .where(eq(businesses.id, conn.businessId))
      .limit(1);
    const owners = [
      and(eq(hubspotLinks.localType, "invoice"), eq(hubspotLinks.localId, inv.id)),
      and(eq(hubspotLinks.localType, "customer"), eq(hubspotLinks.localId, inv.customerId)),
    ];
    if (inv.subscriptionId)
      owners.push(
        and(
          eq(hubspotLinks.localType, "subscription"),
          eq(hubspotLinks.localId, inv.subscriptionId),
        ),
      );
    const links = await tx
      .select()
      .from(hubspotLinks)
      .where(and(eq(hubspotLinks.connectionId, conn.id), or(...owners)));
    return { inv, paid, timezone: biz?.timezone ?? "UTC", links };
  });
}

/** `paid` with `written_off` set reads as written off: the money did not arrive. */
const statusOf = (inv: Invoice) => (inv.writtenOff ? "written_off" : inv.status);

function localDay(d: Date, tz: string): string {
  const p = localDatePartsInTz(d, tz);
  return `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Each value in the type its property was created with; a text property gets readable text. */
function render(v: FieldValue | null, type: string | null | undefined): string {
  if (!v) return "";
  if (v.kind === "date" && type !== "date" && type !== "datetime") return v.value;
  return toHubSpot(v, type);
}

function values(inv: Invoice, paid: bigint, tz: string): Record<string, FieldValue | null> {
  const s = serializeInvoice(inv, { paidMinor: paid });
  const money = (minor: number): FieldValue => ({
    kind: "money",
    minor: BigInt(minor),
    currency: inv.currency,
  });
  const text = (value: string): FieldValue => ({ kind: "text", value });
  const portal = portalEntryUrl();
  return {
    [ID_PROPERTY]: text(inv.publicId),
    invoice_number: inv.number ? text(inv.number) : null,
    invoice_status: text(statusOf(inv)),
    currency: text(inv.currency),
    total: money(s.total_minor),
    amount_due: money(s.amount_due_minor),
    amount_paid: money(s.amount_paid_minor),
    issue_date: { kind: "date", value: localDay(inv.finalizedAt ?? inv.createdAt, tz) },
    due_date: inv.dueDate ? { kind: "date", value: localDay(inv.dueDate, tz) } : null,
    // The buyer's portal, never an operator screen. It has no per-invoice page.
    invoice_url: portal ? text(`${portal}?tab=invoices`) : null,
  };
}

interface Targets {
  contact: string | null;
  company: string | null;
  deal: string | null;
}

/** Associate to each target; a refusal (no association defined on the object) is a note, not a failure. */
async function associate(
  client: HubSpotClient,
  objectType: ObjectType,
  id: string,
  targets: Targets,
  notes: string[],
) {
  for (const [object, to, label] of [
    ["contacts", targets.contact, "contact"],
    ["companies", targets.company, "company"],
    ["deals", targets.deal, "deal"],
  ] as const) {
    if (!to) continue;
    try {
      await client.request(
        "PUT",
        `/crm/v4/objects/${enc(objectType)}/${enc(id)}/associations/default/${object}/${enc(to)}`,
      );
    } catch (err) {
      if (!(err instanceof HubSpotApiError) || err.retryable) throw err;
      notes.push(`We could not associate the invoice with its ${label}: ${err.message}`);
    }
  }
}

/** False when the record is gone in HubSpot. */
async function patch(
  client: HubSpotClient,
  path: string,
  properties: Record<string, string>,
): Promise<boolean> {
  try {
    await client.request("PATCH", path, { properties });
    return true;
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 404) return false;
    throw err;
  }
}

/** HubSpot's 409 on create names the record that already holds the unique value. */
function conflictId(err: unknown): string | null {
  if (!(err instanceof HubSpotApiError) || err.status !== 409) return null;
  return /Existing ID:\s*(\d+)/i.exec(err.message)?.[1] ?? null;
}

/**
 * Invoice → a record of the portal's invoice custom object, associated to the customer's
 * contact and company and the subscription's deal. HubSpot's own invoice object is not
 * writable by a public app, and its "paid" cannot be set through the API.
 */
export const pushInvoice: PushHandler = async (ctx, invoiceId) => {
  const { client, conn, settings } = ctx;
  const s = settings.invoices;
  const loaded = await load(conn, invoiceId);
  if (!loaded)
    return [{ action: "skipped", localType: "invoice", message: "Invoice no longer exists" }];

  const { inv, paid, timezone } = loaded;
  let links = loaded.links;
  const link = links.find((l) => l.localType === "invoice" && l.remoteType === "invoice") ?? null;
  const base = { localType: "invoice", localRef: inv.publicId, remoteType: "invoice" } as const;
  const skip = (message: string): SyncOutcome[] => [
    { ...base, action: "skipped", remoteId: link?.remoteId, message },
  ];

  if (!s.enabled) return skip("Invoice sync is off");
  if (!s.objectType) return skip("Select the HubSpot object for invoices");
  const objectType = s.objectType as ObjectType;
  const missing = missingInvoiceScopes(conn.scopes ?? []);
  if (missing.length > 0)
    return skip(
      `HubSpot did not give access to custom objects (${missing.join(", ")}). Connect HubSpot again to sync invoices. Custom objects need HubSpot Enterprise.`,
    );
  if (inv.status === "pending") return skip("Draft invoices do not sync");

  let types: Map<string, string | null>;
  try {
    types = await propertiesOf(client, objectType);
  } catch (err) {
    if (err instanceof HubSpotApiError && (err.status === 403 || err.status === 404))
      return skip(
        `We could not read the HubSpot object ${objectType} (${err.status}). Select the invoice object again, or connect HubSpot again.`,
      );
    throw err;
  }
  if (!types.has(ID_PROPERTY))
    return skip(
      `The HubSpot object has no writable "${ID_PROPERTY}" property. Add it in HubSpot, then sync again.`,
    );

  // The customer first, so the invoice has a contact and company to be associated with.
  const outcomes: SyncOutcome[] = [];
  const notes: string[] = [];
  const target = (localType: string, remoteType: string) =>
    links.find((l) => l.localType === localType && l.remoteType === remoteType)?.remoteId ?? null;
  if (!target("customer", "contact")) {
    try {
      for (const o of await pushCustomer(ctx, inv.customerId)) {
        if (o.action === "skipped") notes.push(o.message ?? "customer skipped");
        else outcomes.push(o);
      }
    } catch (err) {
      if (!(err instanceof HubSpotApiError) || err.retryable) throw err;
      notes.push(`We could not push the customer: ${err.message}`);
    }
    links = (await load(conn, invoiceId))?.links ?? links;
  }
  const targets: Targets = {
    contact: target("customer", "contact"),
    company: target("customer", "company"),
    deal: target("subscription", "deal"),
  };

  const all = values(inv, paid, timezone);
  const properties: Record<string, string> = {};
  const absent: string[] = [];
  for (const name of INVOICE_PROPERTIES) {
    if (types.has(name)) properties[name] = render(all[name] ?? null, types.get(name));
    else absent.push(name);
  }
  if (absent.length > 0)
    notes.push(`Left out ${absent.join(", ")}: the HubSpot object does not have these properties`);
  const hash = propertiesHash({
    ...properties,
    "~contact": targets.contact ?? "",
    "~company": targets.company ?? "",
    "~deal": targets.deal ?? "",
  });
  const say = (main?: string) => [main, ...notes].filter(Boolean).join("; ") || undefined;
  const done = (o: Omit<SyncOutcome, "localType">) => [...outcomes, { ...base, ...o }];
  const records = `/crm/v3/objects/${enc(objectType)}`;
  const finish = async (remoteId: string) => {
    await associate(client, objectType, remoteId, targets, notes);
    await upsertLink(conn, {
      localType: "invoice",
      localId: inv.id,
      remoteType: "invoice",
      remoteId,
      hash,
    });
  };

  try {
    if (link) {
      if (link.lastPushedHash === hash)
        return done({ action: "skipped", remoteId: link.remoteId, message: "No changes" });
      if (await patch(client, `${records}/${enc(link.remoteId)}`, properties)) {
        await finish(link.remoteId);
        return done({ action: "updated", remoteId: link.remoteId, message: say() });
      }
      // Deleted in HubSpot since we linked it: match again.
    }

    const found = await client.request<{ results?: Array<{ id: string }> }>(
      "POST",
      `${records}/search`,
      {
        filterGroups: [
          { filters: [{ propertyName: ID_PROPERTY, operator: "EQ", value: inv.publicId }] },
        ],
        properties: [ID_PROPERTY],
        limit: 1,
      },
    );
    let match = found?.results?.[0]?.id ?? null;
    if (!match) {
      try {
        const made = await client.request<{ id?: string }>("POST", records, { properties });
        if (!made?.id)
          throw new HubSpotApiError("HubSpot returned no invoice record id", 502, true, made);
        // Linked before associating: a failure below retries against this record, never a duplicate.
        await upsertLink(conn, {
          localType: "invoice",
          localId: inv.id,
          remoteType: "invoice",
          remoteId: made.id,
          hash: null,
        });
        await finish(made.id);
        return done({ action: "created", remoteId: made.id, message: say() });
      } catch (err) {
        // A unique `invoice_id` already holds this id (search lags writes): that record is the match.
        match = conflictId(err);
        if (!match) throw err;
      }
    }
    await patch(client, `${records}/${enc(match)}`, properties);
    await finish(match);
    return done({
      action: "updated",
      remoteId: match,
      message: say(`Linked to an existing HubSpot record (matched on ${ID_PROPERTY})`),
    });
  } catch (err) {
    // The grant or the portal's tier no longer covers custom objects: say so once, do not retry.
    if (err instanceof HubSpotApiError && err.status === 403)
      return [
        ...outcomes,
        {
          ...base,
          action: "skipped",
          remoteId: link?.remoteId,
          message: `HubSpot refused access to the invoice object: ${err.message}. Connect HubSpot again. Custom objects need HubSpot Enterprise.`,
        },
      ];
    throw err;
  }
};
