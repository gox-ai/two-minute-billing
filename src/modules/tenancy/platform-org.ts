import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Data of a platform organization (`organizations.is_platform`) is never deleted by any
 * retention or cleanup sweep: events, logs, analytics, attachments. Add this to the WHERE of
 * every age-based delete of organization-scoped rows. A row with no organization stays in
 * scope.
 */
export function notPlatformOrg(column: AnyPgColumn): SQL {
  return sql`(${column} is null or ${column}::text not in (select id::text from organizations where is_platform))`;
}

/**
 * Same rule for per-user security records (login attempts, security events): a member of a
 * platform organization keeps them forever. A row with no user stays in scope.
 */
export function notPlatformUser(column: AnyPgColumn): SQL {
  return sql`(${column} is null or ${column} not in (select m.user_id from memberships m join organizations o on o.id = m.organization_id where o.is_platform))`;
}
