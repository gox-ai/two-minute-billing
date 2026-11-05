/**
 * Custom roles (0389): a named set of catalogue permission keys per organization.
 *
 * Every guard lives here, not in the route: unknown keys refused, reserved and duplicate names
 * refused after normalisation, and the actor may only grant keys they hold — and may only edit
 * a role whose current keys they hold. A role in use cannot be deleted.
 */
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { memberships, roles } from "@db/schema";
import { writeAuditLog } from "@/modules/audit/service";
import { isPermissionKey, isReservedRoleName, roleNameKey } from "@/modules/auth/permissions";
import { PermissionEscalationError, assertGrantable } from "@/modules/auth/service";

export class RoleError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "RoleError";
  }
}

export interface RoleView {
  row: typeof roles.$inferSelect;
  memberCount: number;
}

export interface RoleActor {
  email: string;
  permissions: ReadonlySet<string>;
  /** The `role_…` id the actor holds, if any. Nobody edits or deletes their own role. */
  customRoleId?: string | null;
}

function refuseOwnRole(actor: RoleActor, id: string, verb: "change" | "delete") {
  if (actor.customRoleId === id) {
    throw new PermissionEscalationError(
      `We could not ${verb} the role. You have this role. Ask an owner or admin to ${verb} it.`,
    );
  }
}

const NAME_MAX = 60;
const DESCRIPTION_MAX = 255;

function cleanName(name: string): { name: string; nameKey: string } {
  const display = name.normalize("NFKC").replace(/\s+/g, " ").trim();
  const nameKey = roleNameKey(name);
  if (nameKey.length < 1 || nameKey.length > NAME_MAX) {
    throw new RoleError(
      `We could not save the role. The name must be 1 to ${NAME_MAX} characters.`,
    );
  }
  if (isReservedRoleName(name)) {
    throw new RoleError(
      `We could not save the role. "${display}" is the name of a fixed role. Use a different name.`,
    );
  }
  return { name: display, nameKey };
}

function cleanPermissions(keys: readonly string[]): string[] {
  const unique = [...new Set(keys)];
  if (unique.length === 0) {
    throw new RoleError("We could not save the role. Select at least one permission.");
  }
  const unknown = unique.filter((k) => !isPermissionKey(k));
  if (unknown.length > 0) {
    throw new RoleError(`We could not save the role. Unknown permission: ${unknown.join(", ")}.`);
  }
  return unique.sort();
}

function cleanDescription(d: string | null | undefined): string | null {
  const v = d?.trim() ?? "";
  if (v.length > DESCRIPTION_MAX) {
    throw new RoleError(
      `We could not save the role. The description must be ${DESCRIPTION_MAX} characters or fewer.`,
    );
  }
  return v === "" ? null : v;
}

async function memberCount(tx: Pick<Tx, "select">, roleId: string): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(eq(memberships.customRoleId, roleId));
  return Number(r?.n ?? 0);
}

function nameTaken(e: unknown): boolean {
  const err = e as { code?: string; constraint_name?: string; cause?: { code?: string } };
  return (err.code ?? err.cause?.code) === "23505";
}

const auditView = (r: typeof roles.$inferSelect) => ({
  id: r.publicId,
  name: r.name,
  description: r.description,
  permissions: r.permissions,
});

export async function listRoles(organizationId: string): Promise<RoleView[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.organizationId, organizationId), isNull(roles.deletedAt)))
      .orderBy(asc(roles.createdAt));
    const counts = await tx
      .select({ id: memberships.customRoleId, n: count() })
      .from(memberships)
      .where(eq(memberships.organizationId, organizationId))
      .groupBy(memberships.customRoleId);
    const byId = new Map(counts.map((c) => [c.id, Number(c.n)]));
    return rows.map((row) => ({ row, memberCount: byId.get(row.id) ?? 0 }));
  });
}

async function findRole(tx: Pick<Tx, "select">, organizationId: string, id: string, lock = false) {
  const q = tx
    .select()
    .from(roles)
    .where(
      and(
        eq(roles.organizationId, organizationId),
        eq(roles.publicId, id),
        isNull(roles.deletedAt),
      ),
    )
    .limit(1);
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new RoleError(`No such role: ${id}`, 404);
  return row;
}

export async function getRole(organizationId: string, id: string): Promise<RoleView> {
  return withTenant(organizationId, async (tx) => {
    const row = await findRole(tx, organizationId, id);
    return { row, memberCount: await memberCount(tx, row.id) };
  });
}

export async function createRole(
  organizationId: string,
  actor: RoleActor,
  input: { name: string; description?: string | null; permissions: readonly string[] },
): Promise<RoleView> {
  const { name, nameKey } = cleanName(input.name);
  const permissions = cleanPermissions(input.permissions);
  const description = cleanDescription(input.description);
  assertGrantable(actor.permissions, permissions);
  try {
    return await withTenant(organizationId, async (tx) => {
      const [row] = await tx
        .insert(roles)
        .values({
          organizationId,
          publicId: publicId("role"),
          name,
          nameKey,
          description,
          permissions,
        })
        .returning();
      await writeAuditLog(
        {
          organizationId,
          action: "role.create",
          resourceType: "role",
          resourceId: row!.publicId,
          before: null,
          after: auditView(row!),
          actor: actor.email,
          source: "dashboard",
        },
        tx,
      );
      return { row: row!, memberCount: 0 };
    });
  } catch (e) {
    if (nameTaken(e)) {
      throw new RoleError(
        `We could not save the role. A role named "${name}" exists. Use a different name.`,
        409,
      );
    }
    throw e;
  }
}

export async function updateRole(
  organizationId: string,
  actor: RoleActor,
  id: string,
  input: {
    name?: string;
    description?: string | null;
    permissions?: readonly string[];
    /** Optimistic concurrency: the version the caller saw. */
    version?: number;
  },
): Promise<RoleView> {
  const next = {
    ...(input.name !== undefined ? cleanName(input.name) : {}),
    ...(input.description !== undefined
      ? { description: cleanDescription(input.description) }
      : {}),
    ...(input.permissions !== undefined
      ? { permissions: cleanPermissions(input.permissions) }
      : {}),
  };
  refuseOwnRole(actor, id, "change");
  try {
    return await withTenant(organizationId, async (tx) => {
      const row = await findRole(tx, organizationId, id, true);
      if (input.version !== undefined && input.version !== row.version) {
        throw new RoleError(
          "We could not save the role. Someone changed it after you opened it. Reload and try again.",
          409,
        );
      }
      // Editing a role needs its current keys too: otherwise anyone with roles:manage could
      // rename or narrow a role broader than their own.
      assertGrantable(actor.permissions, row.permissions);
      if (next.permissions) assertGrantable(actor.permissions, next.permissions);
      const [updated] = await tx
        .update(roles)
        .set({ ...next, version: row.version + 1, updatedAt: new Date() })
        .where(eq(roles.id, row.id))
        .returning();
      const before = new Set(row.permissions);
      const after = new Set(updated!.permissions);
      await writeAuditLog(
        {
          organizationId,
          action: "role.update",
          resourceType: "role",
          resourceId: row.publicId,
          before: auditView(row),
          after: {
            ...auditView(updated!),
            added: [...after].filter((k) => !before.has(k)),
            removed: [...before].filter((k) => !after.has(k)),
          },
          actor: actor.email,
          source: "dashboard",
        },
        tx,
      );
      return { row: updated!, memberCount: await memberCount(tx, row.id) };
    });
  } catch (e) {
    if (nameTaken(e)) {
      throw new RoleError(
        "We could not save the role. A role with that name exists. Use a different name.",
        409,
      );
    }
    throw e;
  }
}

/** Soft delete. Refused while any member holds the role. */
export async function deleteRole(
  organizationId: string,
  actor: RoleActor,
  id: string,
): Promise<void> {
  refuseOwnRole(actor, id, "delete");
  await withTenant(organizationId, async (tx) => {
    const row = await findRole(tx, organizationId, id, true);
    assertGrantable(actor.permissions, row.permissions);
    const n = await memberCount(tx, row.id);
    if (n > 0) {
      throw new RoleError(
        `We could not delete the role. ${n} ${n === 1 ? "member has" : "members have"} it. Change their role first.`,
        409,
      );
    }
    await tx
      .update(roles)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(roles.id, row.id));
    await writeAuditLog(
      {
        organizationId,
        action: "role.delete",
        resourceType: "role",
        resourceId: row.publicId,
        before: auditView(row),
        after: null,
        actor: actor.email,
        source: "dashboard",
      },
      tx,
    );
  });
}

export { PermissionEscalationError };
