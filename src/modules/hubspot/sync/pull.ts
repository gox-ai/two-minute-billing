import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { hubspotConnections, hubspotLinks } from "@db/schema";
import { HubSpotApiError } from "../client";
import { HubSpotAuthError } from "../oauth";
import type { PullHandler, SyncContext } from "./context";
import type { SyncOutcome } from "./links";
import { heldLocalIds } from "./conflicts";
import {
  cfTypesFor,
  linksFor,
  LOCAL_TYPE,
  pullFields,
  pullRecord,
  REMOTE_TYPE,
  type PullObject,
  type RemoteRecord,
} from "./inbound";

const log = createLogger("hubspot.pull");

/**
 * Change detection: search each object for records modified after its watermark, oldest first,
 * and keep the ones we link. The watermark stores where the NEXT search starts: the newest
 * processed modification minus `OVERLAP_MS`, because HubSpot's search index lags writes by a few
 * seconds. Records re-read inside the overlap are dropped by `hubspot_links.remote_updated_at`.
 */

/** Contacts expose their modification time under a different name than companies and deals. */
const MODIFIED: Record<PullObject, string> = {
  contacts: "lastmodifieddate",
  companies: "hs_lastmodifieddate",
  deals: "hs_lastmodifieddate",
};
const WATERMARK = {
  contacts: "contactsWatermark",
  companies: "companiesWatermark",
  deals: "dealsWatermark",
} as const;

const PAGE = 100;
/** HubSpot refuses to page a single search past 10,000 results. */
const SEARCH_CAP = 10_000;
const OVERLAP_MS = 2 * 60_000;
/** Leaves most of the pass for pushes; the rest resumes from the watermark next time. */
const BUDGET_MS = 25_000;

type SearchPage = {
  results?: Array<{
    id: string | number;
    properties?: Record<string, string | null>;
    updatedAt?: string;
  }>;
  paging?: { next?: { after?: string } };
};

async function saveWatermark(ctx: SyncContext, object: PullObject, at: Date) {
  const col = WATERMARK[object];
  await withTenant(ctx.conn.organizationId, (tx) =>
    tx
      .update(hubspotConnections)
      .set({ [col]: at })
      .where(
        and(
          eq(hubspotConnections.id, ctx.conn.id),
          eq(hubspotConnections.businessId, ctx.conn.businessId),
        ),
      ),
  );
  (ctx.conn as Record<string, unknown>)[col] = at;
}

async function hasLinks(ctx: SyncContext, object: PullObject): Promise<boolean> {
  const [row] = await withTenant(ctx.conn.organizationId, (tx) =>
    tx
      .select({ one: sql<number>`1` })
      .from(hubspotLinks)
      .where(
        and(
          eq(hubspotLinks.connectionId, ctx.conn.id),
          eq(hubspotLinks.businessId, ctx.conn.businessId),
          eq(hubspotLinks.localType, LOCAL_TYPE[object]),
          eq(hubspotLinks.remoteType, REMOTE_TYPE[object]),
        ),
      )
      .limit(1),
  );
  return !!row;
}

/** Why an object is not pulled at all under these settings, or null when it is. */
function skipReason(ctx: SyncContext, object: PullObject): string | null {
  const s = ctx.settings;
  if (s.updates.remoteChange === "nothing") return "HubSpot changes are not synced back";
  if (object === "companies") {
    if (!s.customers.companyMatch) return "companies are not synced";
    // Customer ↔ contact stays 1:1, so contact changes still flow; a shared company has no one owner.
    if (s.customers.multipleCustomersPerCompany) return "several customers share companies";
  }
  if (object === "deals") {
    if (!s.deals.enabled) return "deal sync is off";
    if (pullFields(s, "deals").length === 0) return "no deal field is mapped from HubSpot";
  }
  return null;
}

async function pullObject(
  ctx: SyncContext,
  object: PullObject,
  deadline: number,
): Promise<SyncOutcome[]> {
  // Consumed while off: turning it on later starts from here, not from history.
  if (skipReason(ctx, object) || !(await hasLinks(ctx, object))) {
    await saveWatermark(ctx, object, new Date());
    return [];
  }

  const outcomes: SyncOutcome[] = [];
  const fields = pullFields(ctx.settings, object);
  const modified = MODIFIED[object];
  const properties = [...new Set([modified, ...fields.map((f) => f.remote)])];
  const cfTypes = await cfTypesFor(ctx.conn, object);
  let watermark: Date = ctx.conn[WATERMARK[object]] ?? ctx.conn.connectedAt;
  let from = watermark.getTime();

  for (;;) {
    let after: string | undefined;
    let read = 0;
    let newest = -Infinity;
    let blocked = false;
    do {
      const page = await ctx.client.request<SearchPage>(
        "POST",
        `/crm/v3/objects/${object}/search`,
        {
          filterGroups: [
            { filters: [{ propertyName: modified, operator: "GT", value: String(from) }] },
          ],
          sorts: [{ propertyName: modified, direction: "ASCENDING" }],
          properties,
          limit: PAGE,
          ...(after ? { after } : {}),
        },
      );
      const records: RemoteRecord[] = (page?.results ?? []).map((r) => {
        const props = r.properties ?? {};
        const at = Date.parse(props[modified] ?? r.updatedAt ?? "");
        return {
          id: String(r.id),
          properties: props,
          updatedAt: new Date(Number.isFinite(at) ? at : 0),
        };
      });
      read += records.length;

      const links = await linksFor(
        ctx.conn,
        object,
        records.map((r) => r.id),
      );
      const held = await heldLocalIds(
        ctx.conn,
        REMOTE_TYPE[object],
        links.map((l) => l.localId),
      );
      for (const record of records) {
        try {
          for (const link of links.filter(
            (l) => l.remoteId === record.id && !held.has(l.localId),
          )) {
            const o = await pullRecord(ctx, object, record, link, cfTypes);
            if (o) outcomes.push(o);
          }
        } catch (err) {
          if (err instanceof HubSpotAuthError) throw err;
          // Stop here: the watermark stays before this record, so the next pass retries it.
          blocked = true;
          outcomes.push({
            action: "failed",
            localType: LOCAL_TYPE[object],
            remoteType: REMOTE_TYPE[object],
            remoteId: record.id,
            message: `We could not pull from HubSpot: ${(err as Error).message}. We will retry.`,
          });
          if (!(err instanceof HubSpotApiError))
            log.error(err, { event: "hubspot_pull_record_error", connection: ctx.conn.publicId });
          break;
        }
        newest = Math.max(newest, record.updatedAt.getTime());
      }
      after = page?.paging?.next?.after;
    } while (after && !blocked && read + PAGE <= SEARCH_CAP && Date.now() < deadline);

    if (Number.isFinite(newest)) {
      const next = new Date(Math.max(watermark.getTime(), newest - OVERLAP_MS));
      if (next.getTime() > watermark.getTime()) await saveWatermark(ctx, object, next);
      watermark = next;
    }
    // Past the 10,000 cap: start a fresh search just before the newest record processed.
    if (
      !after ||
      blocked ||
      Date.now() >= deadline ||
      !Number.isFinite(newest) ||
      newest - 1 <= from
    )
      break;
    from = newest - 1;
  }
  return outcomes;
}

/** HubSpot → billing for linked contacts, companies and deals, with conflict rules. */
export const pullChanges: PullHandler = async (ctx) => {
  const deadline = Date.now() + BUDGET_MS;
  const outcomes: SyncOutcome[] = [];
  for (const object of ["contacts", "companies", "deals"] as const) {
    try {
      outcomes.push(...(await pullObject(ctx, object, deadline)));
    } catch (err) {
      if (err instanceof HubSpotAuthError) throw err;
      outcomes.push({
        action: "failed",
        localType: LOCAL_TYPE[object],
        remoteType: REMOTE_TYPE[object],
        message: `We could not read ${object} from HubSpot: ${(err as Error).message}. We will retry.`,
      });
      if (!(err instanceof HubSpotApiError))
        log.error(err, { event: "hubspot_pull_error", connection: ctx.conn.publicId });
    }
  }
  return outcomes;
};
