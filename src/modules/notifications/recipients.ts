/**
 * Who can receive: members of the organization that set up notifications (a default row),
 * with the permissions of their role at send time, and the organization's destinations.
 * Reads inside the tenant transaction.
 */
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  businesses,
  memberships,
  notificationDestinations,
  notificationPreferences,
  notificationSettingsOrg,
  pushSubscriptions,
  roles,
  users,
  type BusinessFilter,
  type SummaryPref,
} from "@db/schema";
import type { Tx } from "@/platform/db";
import { effectivePermissions } from "@/modules/auth/permissions";
import type { KindPreference, MemberRole } from "./catalogue";
import { passesFilter } from "./resolve";

export interface Member {
  userId: string;
  email: string;
  role: string;
  memberRole: MemberRole;
  permissions: ReadonlySet<string>;
  defaultKinds: Record<string, KindPreference>;
  /** Business id → that business's exceptions. */
  exceptions: Map<string, Record<string, KindPreference>>;
  filter: BusinessFilter;
  daily: SummaryPref;
  weekly: SummaryPref;
  sendEmpty: boolean;
}

export const asMemberRole = (role: string): MemberRole =>
  (["owner", "admin", "manager", "ops", "developer"].includes(role)
    ? role
    : "custom") as MemberRole;

/** Accepted members with a default preferences row. */
export async function loadMembers(tx: Tx, organizationId: string): Promise<Member[]> {
  const prefs = await tx
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.organizationId, organizationId));
  const userIds = [...new Set(prefs.filter((p) => p.businessId === null).map((p) => p.userId))];
  if (userIds.length === 0) return [];
  const rows = await tx
    .select({
      userId: memberships.userId,
      role: memberships.role,
      customRoleId: memberships.customRoleId,
      email: users.email,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        inArray(memberships.userId, userIds),
        isNotNull(memberships.acceptedAt),
      ),
    );
  const customIds = rows.map((r) => r.customRoleId).filter((x): x is string => !!x);
  const custom = customIds.length
    ? await tx
        .select({ id: roles.id, version: roles.version, permissions: roles.permissions })
        .from(roles)
        .where(and(inArray(roles.id, customIds), isNull(roles.deletedAt)))
    : [];
  const customById = new Map(custom.map((r) => [r.id, r]));
  const orgRows = await tx
    .select()
    .from(notificationSettingsOrg)
    .where(eq(notificationSettingsOrg.organizationId, organizationId));
  const orgByUser = new Map(orgRows.map((r) => [r.userId, r]));

  return rows.map((r) => {
    const mine = prefs.filter((p) => p.userId === r.userId);
    const org = orgByUser.get(r.userId);
    return {
      userId: r.userId,
      email: r.email,
      role: r.role,
      memberRole: asMemberRole(r.role),
      permissions: effectivePermissions(
        r.role,
        r.customRoleId ? (customById.get(r.customRoleId) ?? null) : null,
      ),
      defaultKinds: mine.find((p) => p.businessId === null)!.kinds,
      exceptions: new Map(
        mine.filter((p) => p.businessId !== null).map((p) => [p.businessId!, p.kinds]),
      ),
      filter: org?.businessFilter ?? { mode: "all" },
      daily: org?.daily ?? { enabled: true, channels: ["email"] },
      weekly: org?.weekly ?? { enabled: false, channels: ["email"] },
      sendEmpty: org?.sendEmpty ?? false,
    };
  });
}

export interface LiveBusiness {
  id: string;
  publicId: string;
  name: string;
  timezone: string;
}

export async function liveBusinesses(tx: Tx, organizationId: string): Promise<LiveBusiness[]> {
  const rows = await tx
    .select({
      id: businesses.id,
      publicId: businesses.publicId,
      name: businesses.name,
      timezone: businesses.timezone,
    })
    .from(businesses)
    .where(
      and(
        eq(businesses.organizationId, organizationId),
        eq(businesses.livemode, "live"),
        eq(businesses.status, "active"),
      ),
    )
    .orderBy(asc(businesses.name));
  return rows.map((b) => ({ ...b, timezone: b.timezone ?? "UTC" }));
}

/** Name the business in the text when the member sees more than one. */
export const seesSeveral = (filter: BusinessFilter, live: readonly LiveBusiness[]) =>
  live.filter((b) => passesFilter(filter, b.id)).length > 1;

export type PushSub = typeof pushSubscriptions.$inferSelect;

export async function pushSubscriptionsOf(
  tx: Tx,
  userIds: string[],
): Promise<Map<string, PushSub[]>> {
  const out = new Map<string, PushSub[]>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, userIds));
  for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r]);
  return out;
}

export type Destination = typeof notificationDestinations.$inferSelect;

export async function activeDestinations(tx: Tx, organizationId: string): Promise<Destination[]> {
  return tx
    .select()
    .from(notificationDestinations)
    .where(
      and(
        eq(notificationDestinations.organizationId, organizationId),
        eq(notificationDestinations.status, "active"),
      ),
    );
}

/** Owners and admins: who hears that a destination stopped working. */
export async function ownerAndAdminEmails(tx: Tx, organizationId: string): Promise<string[]> {
  const rows = await tx
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        inArray(memberships.role, ["owner", "admin"]),
        isNotNull(memberships.acceptedAt),
      ),
    );
  return [...new Set(rows.map((r) => r.email))];
}
