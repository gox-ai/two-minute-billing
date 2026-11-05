import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { holderName } from "@/modules/customers/names";
import { apiSubscriptionStatus } from "@/modules/subscriptions/serialize";
import { customers, hubspotLinks, subscriptions } from "@db/schema";
import { HubSpotApiError, droppedNote, type Connection } from "../client";
import type { HubSpotSettings } from "../settings";
import type { PushHandler, SyncContext } from "./context";
import { pushCustomer } from "./customers";
import { mappedProperties, subscriptionResolver, toHubSpot, type FieldResolver } from "./fields";
import { propertiesHash, upsertLink, type SyncOutcome } from "./links";
import { heldRemoteTypes, HELD_MESSAGE } from "./conflicts";

type Subscription = typeof subscriptions.$inferSelect;
type Customer = typeof customers.$inferSelect;
type Status = HubSpotSettings["deals"]["statuses"][number];
type Deal = { id: string; properties?: Record<string, string | null> };
interface Targets {
  contact: string | null;
  company: string | null;
}

const DEALS = "/crm/v3/objects/deals";
const enc = encodeURIComponent;

const STATUS_LABEL: Record<Status, string> = {
  future: "Future",
  in_trial: "In trial",
  active: "Active",
  non_renewing: "Non-renewing",
  paused: "Paused",
  cancelled: "Cancelled",
};

async function load(conn: Connection, subscriptionId: string) {
  return withTenant(conn.organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          eq(subscriptions.businessId, conn.businessId),
          isNull(subscriptions.deletedAt),
        ),
      )
      .limit(1);
    if (!sub) return null;
    const [customer] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.id, sub.customerId), eq(customers.businessId, conn.businessId)))
      .limit(1);
    if (!customer) return null;
    const [link] = await tx
      .select()
      .from(hubspotLinks)
      .where(
        and(
          eq(hubspotLinks.connectionId, conn.id),
          eq(hubspotLinks.localType, "subscription"),
          eq(hubspotLinks.localId, sub.id),
          eq(hubspotLinks.remoteType, "deal"),
        ),
      )
      .limit(1);
    return { sub, customer, link: link ?? null };
  });
}

async function customerTargets(conn: Connection, customerId: string): Promise<Targets> {
  const rows = await withTenant(conn.organizationId, (tx) =>
    tx
      .select({ type: hubspotLinks.remoteType, id: hubspotLinks.remoteId })
      .from(hubspotLinks)
      .where(
        and(
          eq(hubspotLinks.connectionId, conn.id),
          eq(hubspotLinks.localType, "customer"),
          eq(hubspotLinks.localId, customerId),
          or(eq(hubspotLinks.remoteType, "contact"), eq(hubspotLinks.remoteType, "company")),
        ),
      ),
  );
  return {
    contact: rows.find((r) => r.type === "contact")?.id ?? null,
    company: rows.find((r) => r.type === "company")?.id ?? null,
  };
}

/** Deals already held by another subscription: never matched twice. */
async function dealsLinkedElsewhere(conn: Connection, dealIds: string[], subscriptionId: string) {
  const rows = await withTenant(conn.organizationId, (tx) =>
    tx
      .select({ id: hubspotLinks.remoteId })
      .from(hubspotLinks)
      .where(
        and(
          eq(hubspotLinks.connectionId, conn.id),
          eq(hubspotLinks.localType, "subscription"),
          eq(hubspotLinks.remoteType, "deal"),
          inArray(hubspotLinks.remoteId, dealIds),
          ne(hubspotLinks.localId, subscriptionId),
        ),
      ),
  );
  return new Set(rows.map((r) => r.id));
}

function dealName(
  format: string,
  sub: Subscription,
  customer: Customer,
  plan: string | null,
): string {
  const tokens: Record<string, string> = {
    customer_id: customer.publicId,
    subscription_id: sub.publicId,
    customer_name: holderName(customer) ?? customer.email ?? "",
    company: customer.company ?? "",
    plan: plan ?? "",
  };
  const name = format
    .replace(/\{(\w+)\}/g, (m, t: string) => tokens[t] ?? m)
    .replace(/\s+/g, " ")
    .trim();
  return name || sub.publicId;
}

/**
 * What every write sends. Pipeline and stage travel together, and only for a mapped status:
 * stage ids are per pipeline, and an unmapped status leaves the deal where it is.
 */
async function buildProperties(
  ctx: SyncContext,
  sub: Subscription,
  customer: Customer,
  status: Status,
  resolve: FieldResolver,
): Promise<Record<string, string>> {
  const s = ctx.settings.deals;
  const values = await resolve(["plan", s.amount]);
  const plan = values.get("plan");
  const amount = values.get(s.amount);
  const out: Record<string, string> = {
    dealname: dealName(s.nameFormat, sub, customer, plan?.kind === "text" ? plan.value : null),
    deal_currency_code: sub.currency,
  };
  if (amount) out.amount = toHubSpot(amount);
  const stage = s.pipelineId ? s.stageMap[status] : undefined;
  if (s.pipelineId && stage) Object.assign(out, { pipeline: s.pipelineId, dealstage: stage });
  const mapped = await mappedProperties(ctx.client, ctx.conn, "deals", s.fields, resolve);
  return {
    ...out,
    ...mapped,
    ...(s.subscriptionIdProperty ? { [s.subscriptionIdProperty]: sub.publicId } : {}),
  };
}

/** Association targets are hashed too, so a customer relinked in HubSpot re-associates the deal. */
const dealHash = (properties: Record<string, string>, targets: Targets) =>
  propertiesHash({
    ...properties,
    "~contact": targets.contact ?? "",
    "~company": targets.company ?? "",
  });

/** The hash a push would store for this subscription's deal; null when it would not push at all. */
export async function subscriptionPushHash(
  ctx: SyncContext,
  subscriptionId: string,
): Promise<string | null> {
  const loaded = await load(ctx.conn, subscriptionId);
  if (!loaded) return null;
  const status = apiSubscriptionStatus(loaded.sub);
  if (!ctx.settings.deals.enabled || !ctx.settings.deals.statuses.includes(status)) return null;
  const targets = await customerTargets(ctx.conn, loaded.customer.id);
  const resolve = subscriptionResolver(ctx.conn, loaded.sub);
  return dealHash(
    await buildProperties(ctx, loaded.sub, loaded.customer, status, resolve),
    targets,
  );
}

/** HubSpot's 409 on create names the record that already holds the unique value. */
function conflictId(err: unknown): string | null {
  if (!(err instanceof HubSpotApiError) || err.status !== 409) return null;
  return /Existing ID:\s*(\d+)/i.exec(err.message)?.[1] ?? null;
}

async function searchByProperty(
  ctx: SyncContext,
  property: string,
  value: string,
): Promise<string | null> {
  const res = await ctx.client.request<{ results?: Deal[] }>("POST", `${DEALS}/search`, {
    filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
    properties: [property],
    limit: 1,
  });
  return res?.results?.[0]?.id ?? null;
}

/** The most recently created open deal on the contact that no other subscription holds. */
async function newestOpenDeal(
  ctx: SyncContext,
  contactId: string,
  subscriptionId: string,
): Promise<string | null> {
  const ids: string[] = [];
  let after: string | undefined;
  do {
    const page = await ctx.client.request<{
      results?: Array<{ toObjectId: string | number }>;
      paging?: { next?: { after?: string } };
    }>(
      "GET",
      `/crm/v4/objects/contacts/${enc(contactId)}/associations/deals?limit=500${after ? `&after=${enc(after)}` : ""}`,
    );
    for (const r of page?.results ?? []) ids.push(String(r.toObjectId));
    after = page?.paging?.next?.after;
  } while (after && ids.length < 2000);
  if (ids.length === 0) return null;

  const taken = await dealsLinkedElsewhere(ctx.conn, ids, subscriptionId);
  const free = ids.filter((id) => !taken.has(id));
  let best: { id: string; at: number } | null = null;
  for (let i = 0; i < free.length; i += 100) {
    const res = await ctx.client.request<{ results?: Deal[] }>("POST", `${DEALS}/batch/read`, {
      inputs: free.slice(i, i + 100).map((id) => ({ id })),
      properties: ["createdate", "hs_is_closed", "pipeline", "dealstage"],
    });
    for (const d of res?.results ?? []) {
      if (d.properties?.hs_is_closed === "true") continue;
      const at = Date.parse(d.properties?.createdate ?? "") || 0;
      if (!best || at > best.at) best = { id: d.id, at };
    }
  }
  return best?.id ?? null;
}

async function associate(ctx: SyncContext, dealId: string, targets: Targets) {
  for (const [object, id] of [
    ["contacts", targets.contact],
    ["companies", targets.company],
  ] as const) {
    if (id)
      await ctx.client.request(
        "PUT",
        `/crm/v4/objects/deals/${enc(dealId)}/associations/default/${object}/${enc(id)}`,
      );
  }
}

/** Subscription → Deal, associated to the customer's contact and company. */
export const pushSubscription: PushHandler = async (ctx, subscriptionId) => {
  const { conn, settings } = ctx;
  const s = settings.deals;
  const loaded = await load(conn, subscriptionId);
  if (!loaded)
    return [
      { action: "skipped", localType: "subscription", message: "Subscription no longer exists" },
    ];

  const { sub, customer, link } = loaded;
  const base = { localType: "subscription", localRef: sub.publicId, remoteType: "deal" } as const;
  const status = apiSubscriptionStatus(sub);
  if (!s.enabled) return [{ ...base, action: "skipped", message: "Deal sync is off" }];
  if (!s.statuses.includes(status))
    return [
      {
        ...base,
        action: "skipped",
        message: `${STATUS_LABEL[status]} subscriptions do not sync to deals`,
      },
    ];
  if ((await heldRemoteTypes(conn, "subscription", sub.id)).has("deal"))
    return [{ ...base, action: "skipped", remoteId: link?.remoteId, message: HELD_MESSAGE }];

  // The customer first, so the deal has a contact and company to be associated with.
  const outcomes: SyncOutcome[] = [];
  const notes: string[] = [];
  let targets = await customerTargets(conn, customer.id);
  if (!targets.contact) {
    try {
      for (const o of await pushCustomer(ctx, customer.id)) {
        if (o.action === "skipped") notes.push(o.message ?? "customer skipped");
        else outcomes.push(o);
      }
    } catch (err) {
      if (!(err instanceof HubSpotApiError) || err.retryable) throw err;
      notes.push(`We could not push the customer: ${err.message}`);
    }
    targets = await customerTargets(conn, customer.id);
    if (!targets.contact)
      notes.push("the customer has no HubSpot contact, so the deal is not associated to one");
  }
  const say = (main?: string) => [main, ...notes].filter(Boolean).join("; ") || undefined;
  const done = (o: Omit<SyncOutcome, "localType">) => [...outcomes, { ...base, ...o }];

  const resolve = subscriptionResolver(conn, sub);
  const properties = await buildProperties(ctx, sub, customer, status, resolve);
  const hash = dealHash(properties, targets);

  if (link) {
    if (link.lastPushedHash === hash)
      return done({ action: "skipped", remoteId: link.remoteId, message: "No changes" });
    // A null hash is a create whose associations never landed: always finish it.
    if (link.lastPushedHash !== null) {
      if (s.onChange === "nothing")
        return done({
          action: "skipped",
          remoteId: link.remoteId,
          message: say("Deal updates are off"),
        });
      if (settings.updates.localChange !== "overwrite_remote")
        return done({
          action: "skipped",
          remoteId: link.remoteId,
          message: say("Updates to HubSpot are off"),
        });
    }
    try {
      const w = await ctx.client.writeProperties(
        "PATCH",
        `${DEALS}/${enc(link.remoteId)}`,
        properties,
      );
      const left = droppedNote(w.dropped);
      if (left) notes.push(left);
      await associate(ctx, link.remoteId, targets);
      await upsertLink(conn, {
        localType: "subscription",
        localId: sub.id,
        remoteType: "deal",
        remoteId: link.remoteId,
        hash,
        written: w.written,
      });
      return done({ action: "updated", remoteId: link.remoteId, message: say() });
    } catch (err) {
      // Deleted in HubSpot since we linked it: match again.
      if (!(err instanceof HubSpotApiError && err.status === 404)) throw err;
    }
  }

  let found: string | null = null;
  let how = "";
  if (s.mode === "link_or_create") {
    if (s.subscriptionIdProperty) {
      found = await searchByProperty(ctx, s.subscriptionIdProperty, sub.publicId);
      how = `its ${s.subscriptionIdProperty}`;
    }
    if (!found && s.matchByAssociation && targets.contact) {
      found = await newestOpenDeal(ctx, targets.contact, sub.id);
      how = "the newest open deal on the customer's contact";
    }
  }

  if (!found) {
    const create = { ...properties };
    // No mapped stage: name the pipeline anyway, and HubSpot files the deal in its first stage.
    if (s.pipelineId && !create.pipeline) create.pipeline = s.pipelineId;
    try {
      const w = await ctx.client.writeProperties<{ id?: string }>("POST", DEALS, create);
      const made = w.result;
      const left = droppedNote(w.dropped);
      if (left) notes.push(left);
      if (!made?.id) throw new HubSpotApiError("HubSpot returned no deal id", 502, true, made);
      // Linked before associating: a failure below retries against this deal, never a duplicate.
      await upsertLink(conn, {
        localType: "subscription",
        localId: sub.id,
        remoteType: "deal",
        remoteId: made.id,
        hash: null,
      });
      await associate(ctx, made.id, targets);
      await upsertLink(conn, {
        localType: "subscription",
        localId: sub.id,
        remoteType: "deal",
        remoteId: made.id,
        hash,
        written: w.written,
      });
      return done({ action: "created", remoteId: made.id, message: say() });
    } catch (err) {
      // A unique subscription-id property already holds this id: that deal is the match.
      found = conflictId(err);
      if (!found) throw err;
      how = `its ${s.subscriptionIdProperty ?? "unique property"}`;
    }
  }

  const w = await ctx.client.writeProperties("PATCH", `${DEALS}/${enc(found)}`, properties);
  const left = droppedNote(w.dropped);
  if (left) notes.push(left);
  await associate(ctx, found, targets);
  await upsertLink(conn, {
    localType: "subscription",
    localId: sub.id,
    remoteType: "deal",
    remoteId: found,
    hash,
    written: w.written,
  });
  return done({
    action: "updated",
    remoteId: found,
    message: say(`Linked to an existing deal (matched on ${how})`),
  });
};
