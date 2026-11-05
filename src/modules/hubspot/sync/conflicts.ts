import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { hubspotConflicts, type HubSpotConflictField } from "@db/schema";
import type { Connection } from "../client";

export type Conflict = typeof hubspotConflicts.$inferSelect;

export const HELD_MESSAGE = "Changed here and in HubSpot. The conflict waits for a decision.";

/** Remote types (contact | company | deal) of this record held by an open conflict. */
export async function heldRemoteTypes(
  conn: Connection,
  localType: string,
  localId: string,
): Promise<Set<string>> {
  const rows = await withTenant(conn.organizationId, (tx) =>
    tx
      .select({ t: hubspotConflicts.remoteType })
      .from(hubspotConflicts)
      .where(
        and(
          eq(hubspotConflicts.connectionId, conn.id),
          eq(hubspotConflicts.businessId, conn.businessId),
          eq(hubspotConflicts.localType, localType),
          eq(hubspotConflicts.localId, localId),
          eq(hubspotConflicts.status, "open"),
        ),
      ),
  );
  return new Set(rows.map((r) => r.t));
}

/** `local_id` values with an open conflict on `remoteType`, among the given ones. */
export async function heldLocalIds(
  conn: Connection,
  remoteType: string,
  localIds: string[],
): Promise<Set<string>> {
  if (localIds.length === 0) return new Set();
  const rows = await withTenant(conn.organizationId, (tx) =>
    tx
      .select({ id: hubspotConflicts.localId })
      .from(hubspotConflicts)
      .where(
        and(
          eq(hubspotConflicts.connectionId, conn.id),
          eq(hubspotConflicts.businessId, conn.businessId),
          eq(hubspotConflicts.remoteType, remoteType),
          eq(hubspotConflicts.status, "open"),
          inArray(hubspotConflicts.localId, localIds),
        ),
      ),
  );
  return new Set(rows.map((r) => r.id));
}

export async function openConflict(
  conn: Connection,
  c: {
    localType: string;
    localId: string;
    localRef: string;
    remoteType: string;
    remoteId: string;
    fields: HubSpotConflictField[];
    remoteUpdatedAt: Date;
  },
): Promise<void> {
  await withTenant(conn.organizationId, (tx) =>
    tx
      .insert(hubspotConflicts)
      .values({
        organizationId: conn.organizationId,
        businessId: conn.businessId,
        connectionId: conn.id,
        publicId: publicId("hscf"),
        ...c,
      })
      .onConflictDoNothing(),
  );
}

export async function listOpenConflicts(
  conn: Connection,
  opts: { limit: number; startingAfter?: string },
): Promise<{ rows: Conflict[]; hasMore: boolean }> {
  return withTenant(conn.organizationId, async (tx) => {
    const scope = and(
      eq(hubspotConflicts.connectionId, conn.id),
      eq(hubspotConflicts.businessId, conn.businessId),
      eq(hubspotConflicts.status, "open"),
    );
    let cursor: Conflict | undefined;
    if (opts.startingAfter)
      [cursor] = await tx
        .select()
        .from(hubspotConflicts)
        .where(and(scope, eq(hubspotConflicts.publicId, opts.startingAfter)))
        .limit(1);
    const rows = await tx
      .select()
      .from(hubspotConflicts)
      .where(
        and(
          scope,
          cursor
            ? or(
                gt(hubspotConflicts.createdAt, cursor.createdAt),
                and(
                  eq(hubspotConflicts.createdAt, cursor.createdAt),
                  gt(hubspotConflicts.publicId, cursor.publicId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(hubspotConflicts.createdAt), asc(hubspotConflicts.publicId))
      .limit(opts.limit + 1);
    return { rows: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit };
  });
}

export async function getConflict(conn: Connection, id: string): Promise<Conflict | null> {
  const [row] = await withTenant(conn.organizationId, (tx) =>
    tx
      .select()
      .from(hubspotConflicts)
      .where(
        and(
          eq(hubspotConflicts.connectionId, conn.id),
          eq(hubspotConflicts.businessId, conn.businessId),
          eq(hubspotConflicts.publicId, id),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

/** Close an open conflict; null when someone else resolved it first. */
export async function markResolved(
  tx: Tx,
  conflict: Conflict,
  resolution: "ours" | "theirs",
  resolvedBy: string | null,
): Promise<Conflict | null> {
  const [row] = await tx
    .update(hubspotConflicts)
    .set({
      status: "resolved",
      resolution,
      resolvedBy,
      resolvedAt: new Date(),
      updatedAt: sql`now()`,
    })
    .where(and(eq(hubspotConflicts.id, conflict.id), eq(hubspotConflicts.status, "open")))
    .returning();
  return row ?? null;
}
