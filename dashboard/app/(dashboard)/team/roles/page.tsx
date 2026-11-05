import { requirePermission, allows } from "@/lib/session";
import { listRoles } from "@/lib/api";
import { SettingsPage } from "@/components/settings/settings-layout";
import { RecordCard } from "@/components/patterns/record-page";
import { TeamTabs } from "@/components/team/team-tabs";
import { RolesPanel } from "@/components/team/roles-panel";

export const dynamic = "force-dynamic";

/** Settings → Team → Roles: fixed roles (read-only) and the organization's custom roles. */
export default async function TeamRolesPage() {
  const me = await requirePermission("roles:view", "admin");
  const roles = await listRoles();
  return (
    <SettingsPage
      title="Team"
      crumbs={[
        { label: "Settings", href: "/settings" },
        { label: "Team", href: "/team" },
        { label: "Roles" },
      ]}
      description="A role is a set of permissions. Give a member a fixed role, or a custom role that you make here."
    >
      <TeamTabs active="roles" showRoles />
      <RecordCard title="Roles" meta={`${roles.data.length + 5} roles`}>
        <RolesPanel
          roles={roles.data}
          actorPermissions={me.permissions ?? []}
          canManage={allows(me, "roles:manage", "admin")}
          ownRoleId={me.custom_role?.id ?? null}
        />
      </RecordCard>
    </SettingsPage>
  );
}
