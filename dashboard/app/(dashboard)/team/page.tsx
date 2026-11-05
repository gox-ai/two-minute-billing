import { requirePermission, listTeamMembers, allows } from "@/lib/session";
import { listRoles } from "@/lib/api";
import { TeamTabs } from "@/components/team/team-tabs";
import {
  FIXED_ROLES,
  canGrant,
  fixedRoleKeys,
  type CustomRole,
  type RoleOption,
} from "@/lib/roles";
import { SettingsPage } from "@/components/settings/settings-layout";
import { RecordCard } from "@/components/patterns/record-page";
import { InviteDialog } from "@/components/team/invite-dialog";
import { TeamMembersTable } from "@/components/team/members-table";

export const dynamic = "force-dynamic";

/**
 * Team / RBAC management: who can sign in to this organization, their role, whether they
 * have accepted, and whether they hold a second factor. Inviting is a dialog behind the
 * header button; the role reference lives inside it.
 */
export default async function TeamPage() {
  const me = await requirePermission("members:view", "admin");
  const members = await listTeamMembers();
  const canSeeRoles = allows(me, "roles:view", "admin");
  const customRoles: CustomRole[] = canSeeRoles ? (await listRoles()).data : [];
  // Only the roles this member may give are offered; the engine refuses the rest.
  const held = me.permissions ?? [];
  // Owner is senior to admin: only an owner gives, changes or removes the owner role.
  const isOwner = me.role === "owner";
  const roleOptions: RoleOption[] = [
    ...FIXED_ROLES.map((r) => ({
      value: r,
      label: r,
      grantable: canGrant(held, fixedRoleKeys(r)) && (r !== "owner" || isOwner),
      keys: fixedRoleKeys(r),
    })),
    ...customRoles.map((r) => ({
      value: r.id,
      label: r.name,
      grantable: canGrant(held, r.permissions),
      keys: r.permissions,
      custom: true,
    })),
  ];

  return (
    <SettingsPage
      title="Team"
      crumbs={[{ label: "Settings", href: "/settings" }, { label: "Team" }]}
      description={
        <>
          Who can sign in to this organization. You are{" "}
          <b className="text-foreground">{me.email}</b> ({me.custom_role?.name ?? me.role}).
        </>
      }
      actions={
        allows(me, "members:manage", "admin") ? <InviteDialog roleOptions={roleOptions} /> : null
      }
    >
      <TeamTabs active="members" showRoles={canSeeRoles} />
      <RecordCard
        title="Members"
        meta={`${members.length} ${members.length === 1 ? "person" : "people"}`}
        flush
      >
        <TeamMembersTable
          members={members}
          roleOptions={roleOptions}
          actorPermissions={held}
          actorIsOwner={isOwner}
        />
      </RecordCard>
    </SettingsPage>
  );
}
