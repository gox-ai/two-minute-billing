import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import type { Connection } from "../client";

export type SyncAction = "created" | "updated" | "skipped" | "failed";

export interface SyncOutcome {
  action: SyncAction;
  localType: string;
  localRef?: string;
  remoteType?: string;
  remoteId?: string;
  message?: string;
}

/** Stable across key order, so an unchanged record hashes the same every time. */
export function propertiesHash(props: Record<string, string>): string {
  const sorted = Object.keys(props)
    .sort()
    .map((k) => [k, props[k]]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export async function upsertLink(
  conn: Connection,
  link: {
    localType: string;
    localId: string;
    remoteType: string;
    remoteId: string;
    hash: string | null;
    /** Properties this push wrote; folded into `remote_values` once a pull has baselined it. */
    written?: Record<string, string>;
  },
): Promise<void> {
  const written = link.written ? JSON.stringify(link.written) : null;
  await withTenant(conn.organizationId, (tx) =>
    tx.execute(sql`
      INSERT INTO hubspot_links
        (organization_id, business_id, connection_id, local_type, local_id, remote_type, remote_id,
         last_pushed_hash, last_pushed_at)
      VALUES (${conn.organizationId}, ${conn.businessId}, ${conn.id}, ${link.localType}, ${link.localId},
              ${link.remoteType}, ${link.remoteId}, ${link.hash}, now())
      ON CONFLICT (connection_id, local_type, local_id, remote_type)
      DO UPDATE SET remote_id = EXCLUDED.remote_id,
                    last_pushed_hash = EXCLUDED.last_pushed_hash,
                    last_pushed_at = now(),
                    remote_values = CASE
                      WHEN hubspot_links.remote_values IS NULL OR ${written}::jsonb IS NULL THEN hubspot_links.remote_values
                      ELSE hubspot_links.remote_values || ${written}::jsonb END
    `),
  );
}
