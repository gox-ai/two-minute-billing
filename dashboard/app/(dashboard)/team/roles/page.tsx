import { requirePermission, allows, listTeamMembers } from "@/lib/session";
import { listRoles } from "@/lib/api";
import { FIXED_ROLES } from "@/lib/roles";
import { SettingsPage } from "@/components/settings/settings-layout";
import { RecordCard } from "@/components/patterns/record-page";
import { TeamTabs } from "@/components/team/team-tabs";
import { CreateRoleButton, RolesPanel } from "@/components/team/roles-panel";

export const dynamic = "force-dynamic";

/** Settings → Team → Roles: fixed roles (read-only) and the organization's custom roles. */
export default async function TeamRolesPage() {
  const me = await requirePermission("roles:view", "admin");
  // Fixed roles have no count in the roles API: count them from the member list.
  const [roles, members] = await Promise.all([
    listRoles(),
    allows(me, "members:view", "admin") ? listTeamMembers().catch(() => null) : null,
  ]);
  const fixedCounts = members
    ? Object.fromEntries(
        FIXED_ROLES.map((r) => [r, members.filter((m) => !m.custom_role && m.role === r).length]),
      )
    : null;
  return (
    <SettingsPage
      title="Team"
      crumbs={[
        { label: "Overview", href: "/" },
        { label: "Team", href: "/team" },
        { label: "Roles" },
      ]}
      description="A role is a set of permissions. Give a member a fixed role, or a custom role that you make here."
      actions={
        allows(me, "roles:manage", "admin") ? (
          <CreateRoleButton actorPermissions={me.permissions ?? []} />
        ) : undefined
      }
    >
      <TeamTabs active="roles" showRoles />
      <RecordCard title="Roles" meta={`${roles.data.length + 5} roles`} flush>
        <RolesPanel
          roles={roles.data}
          actorPermissions={me.permissions ?? []}
          canManage={allows(me, "roles:manage", "admin")}
          ownRoleId={me.custom_role?.id ?? null}
          fixedCounts={fixedCounts}
        />
      </RecordCard>
    </SettingsPage>
  );
}
