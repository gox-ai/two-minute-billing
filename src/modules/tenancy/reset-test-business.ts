/**
 * Reset a test business: it becomes what a new test twin of its live business is. Every
 * business-scoped row is deleted except KEEP, the settings are copied from live again, and
 * the TM Test Gateway is provisioned. The id and public id stay, so keys and env vars work.
 */
import { and, eq, sql } from "drizzle-orm";
import { systemDb, type Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { businesses } from "@db/schema";
import { writeAuditLog } from "@/modules/audit/service";
import { provisionTestGateway, TenancyError, twinSettings } from "./service";

const log = createLogger("tenancy");

/**
 * Business-scoped rows a reset keeps. They record who did what, or belong to a member or
 * to the platform; none of them is billing set-up or billing data. Every other table with
 * a `business_id` column is emptied, including tables added after this list.
 */
export const RESET_KEEP = new Set([
  "audit_logs",
  "api_request_logs",
  // MCP access a member granted: the developer's agent keeps working after a reset.
  "oauth_grants",
  "support_requests",
  "assistant_conversations",
  "assistant_actions",
  "assistant_attachments",
  // A member's saved list views and report dashboards.
  "list_views",
  "report_dashboards",
  // Copies into and out of this business; the live business shows the same rows.
  "transfer_configurations",
  // Platform state, not tenant data.
  "dependency_health",
  "buyer_request_rejections",
  "buyer_client_errors",
]);

export class ResetTestBusinessError extends Error {}

/** Every table with a `business_id` column, partitions folded into their parent. */
async function businessTables(tx: Tx): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
    order by 1`)) as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * `tables` with every referencing table before the table it references, so one pass
 * usually deletes everything. Cycles keep their input order; `deleteRows` retries them.
 */
async function childrenFirst(tx: Tx, tables: string[]): Promise<string[]> {
  const edges = (await tx.execute(sql`
    select distinct c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
    from pg_constraint c
    where c.contype = 'f' and c.conrelid <> c.confrelid`)) as unknown as Array<{
    child: string;
    parent: string;
  }>;
  const set = new Set(tables);
  const referencedBy = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
  for (const e of edges)
    if (set.has(e.child) && set.has(e.parent)) referencedBy.get(e.parent)!.add(e.child);
  const out: string[] = [];
  const done = new Set<string>();
  while (out.length < tables.length) {
    const ready = tables.filter(
      (t) => !done.has(t) && [...referencedBy.get(t)!].every((c) => done.has(c)),
    );
    const next = ready.length ? ready : tables.filter((t) => !done.has(t)).slice(0, 1);
    for (const t of next) {
      out.push(t);
      done.add(t);
    }
  }
  return out;
}

const fkCode = (e: unknown) =>
  (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;

/**
 * Delete this business's rows from `tables`. A table that another table's rows still
 * reference is tried again after the others, in a savepoint; a pass that refuses every
 * table left is an error.
 */
async function deleteRows(
  tx: Tx,
  tables: string[],
  bizId: string,
): Promise<{ deleted: number; passes: number }> {
  let left = tables;
  let deleted = 0;
  let passes = 0;
  while (left.length) {
    passes++;
    const refused: string[] = [];
    for (const t of left) {
      try {
        const res = await tx.transaction((sp) =>
          sp.execute(sql`delete from ${sql.identifier(t)} where business_id = ${bizId}::uuid`),
        );
        deleted += (res as unknown as { count?: number }).count ?? 0;
      } catch (e) {
        if (fkCode(e) !== "23503") throw e;
        refused.push(t);
      }
    }
    if (refused.length === left.length)
      throw new Error(`reset: rows in ${refused.join(", ")} are still referenced`);
    left = refused;
  }
  return { deleted, passes };
}

export async function resetTestBusiness(input: {
  orgId: string;
  bizId: string;
}): Promise<{ deleted: number }> {
  // `systemDb`: the reset spans every business-scoped table, as `wipeTestBusinessData` does.
  // The business is locked and checked in the same transaction, so a live row is never touched.
  const result = await systemDb.transaction(async (tx) => {
    const [biz] = await tx
      .select()
      .from(businesses)
      .where(and(eq(businesses.id, input.bizId), eq(businesses.organizationId, input.orgId)))
      .for("update");
    if (!biz) throw new TenancyError("No such business");
    if (biz.livemode !== "test")
      throw new ResetTestBusinessError("You can reset only a test business.");
    // A standalone test business has no live business to copy its settings from.
    if (!biz.liveBusinessId)
      throw new ResetTestBusinessError(
        "This test business has no live business to copy the settings from. Create a new business instead.",
      );
    const [live] = await tx.select().from(businesses).where(eq(businesses.id, biz.liveBusinessId));
    if (!live) throw new TenancyError("No such business");

    // The ledger is append-only for every login: its rows go through the test-only function.
    const [ledger] = (await tx.execute(
      sql`select public.app_wipe_test_ledger(${biz.id}::uuid) as n`,
    )) as unknown as Array<{ n: string | number }>;
    const tables = await childrenFirst(
      tx,
      (await businessTables(tx)).filter((t) => t !== "ledger_entries" && !RESET_KEEP.has(t)),
    );
    const rows = await deleteRows(tx, tables, biz.id);
    const deleted = Number(ledger?.n ?? 0) + rows.deleted;

    await tx
      .update(businesses)
      .set({
        ...twinSettings(live),
        defaultGatewayAccountId: null,
        invoiceNextNumber: sql`default`,
        creditNoteNextNumber: sql`default`,
        receiptNextNumber: sql`default`,
        teamAlertsConfig: sql`default`,
        updatedAt: new Date(),
        resourceVersion: sql`${businesses.resourceVersion} + 1`,
      })
      .where(eq(businesses.id, biz.id));
    return { deleted, passes: rows.passes, publicId: biz.publicId };
  });

  await provisionTestGateway(input.orgId, input.bizId);
  await writeAuditLog({
    organizationId: input.orgId,
    businessId: input.bizId,
    action: "business.test_reset",
    resourceType: "business",
    resourceId: result.publicId,
    after: { deleted: result.deleted },
  });
  log.info("test business reset", {
    businessId: input.bizId,
    deleted: result.deleted,
    passes: result.passes,
  });
  return { deleted: result.deleted };
}
