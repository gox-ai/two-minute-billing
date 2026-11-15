import Link from "next/link";
import { getMe } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { getOrganizationSecurity } from "@/lib/org-security";
import { fmtDate } from "@/lib/format-date";
import { Alert } from "@/components/ui/alert";
import { CheckboxField } from "@/components/ui/checkbox";
import { SettingRow, SettingsCard, SettingsSaveBar } from "@/components/settings/settings-layout";
import { RequireTwoFactorSwitch } from "@/components/settings/require-two-factor-switch";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { OrgSettingsFrame } from "@/components/org-settings/org-settings-frame";
import { saveSecuritySettingsAction } from "../save-actions";

export const dynamic = "force-dynamic";

type Security = NonNullable<Awaited<ReturnType<typeof getOrganizationSecurity>>>;

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  ops: "Ops",
  developer: "Developer",
};

// Settings → Security: the organization's two-factor rules. "Require two-factor
// authentication" saves at once through its own confirm dialog; the roles save with Save.
export default async function SecuritySettingsPage() {
  const me = await requirePermission("settings:manage", "admin");

  let org: Awaited<ReturnType<typeof getMe>>;
  let security: Awaited<ReturnType<typeof getOrganizationSecurity>>;
  try {
    // `getOrganizationSecurity` never throws: it answers null.
    [org, security] = await Promise.all([getMe(), getOrganizationSecurity()]);
  } catch (e) {
    return (
      <ErrorState
        title="We could not connect to the API"
        description={<span className="font-mono text-xs">{(e as Error).message}</span>}
      />
    );
  }
  const tz = org.timezone ?? null;

  return (
    <OrgSettingsFrame
      page="security"
      description="How all members of this organization sign in."
      liveAccessLocked={me.organization_live_access === "locked"}
    >
      {security ? (
        <ActionForm action={saveSecuritySettingsAction} className="flex flex-col gap-5">
          <SettingsCard id="security" title="Two-factor authentication">
            <TwoFactorRows security={security} orgName={org.name} tz={tz} />
            <RoleRows security={security} />
          </SettingsCard>
          {/* An engine older than 0482 sends no policy: no roles, so nothing to save. */}
          {security.deployment ? <SettingsSaveBar label="Save" /> : null}
        </ActionForm>
      ) : (
        <Alert tone="error" title="We could not show the security settings">
          Check your connection. Then try again.
        </Alert>
      )}
    </OrgSettingsFrame>
  );
}

/** "8 Oct 2026" for a YYYY-MM-DD day. */
function fmtDay(d: string): string {
  return fmtDate(d, "UTC");
}

/** Today + `days`, as YYYY-MM-DD in `tz`: the deadline turning it on now would set. */
function dayAfter(days: number, tz: string | null): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const t = Date.parse(`${today}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** "Require two-factor authentication" (0329), its current state and who still owes a setup. */
function TwoFactorRows({
  security: s,
  orgName,
  tz,
}: {
  security: Security;
  orgName: string;
  tz: string | null;
}) {
  const without = s.members - s.members_with_two_factor;
  const by = s.required_by ? s.required_by.name || s.required_by.email : null;
  let status: string | null = null;
  if (s.require_two_factor) {
    const since = s.required_since ? fmtDate(s.required_since, tz) : null;
    const parts = [since ? `Required since ${since}${by ? `. Enabled by ${by}.` : "."}` : null];
    if (s.members_in_grace > 0)
      parts.push(
        s.members_in_grace_deadline_day
          ? `${s.members_in_grace} ${s.members_in_grace === 1 ? "member has" : "members have"} until ${fmtDay(s.members_in_grace_deadline_day)} to enable it.`
          : `${s.members_in_grace} ${s.members_in_grace === 1 ? "member is" : "members are"} still in the grace period.`,
      );
    if (s.members_blocked > 0)
      parts.push(
        `${s.members_blocked} ${s.members_blocked === 1 ? "member" : "members"} without 2FA cannot open ${orgName} until they enable it.`,
      );
    parts.push(
      "New members must enable 2FA when they join. While this setting is on, members cannot disable 2FA.",
    );
    status = parts.filter(Boolean).join(" ");
  }
  return (
    <>
      <SettingRow
        label="Require two-factor authentication"
        help={`All members of ${orgName} must enable 2FA to open the organization.`}
        placement="end"
        control={
          <RequireTwoFactorSwitch
            required={s.require_two_factor}
            disabled={!s.caller_has_two_factor}
            orgName={orgName}
            membersWithout={without}
            deadlineIfOnToday={fmtDay(dayAfter(s.grace_days, tz))}
          />
        }
        consequence={status ?? undefined}
      >
        {!s.require_two_factor && !s.caller_has_two_factor ? (
          <p className="m-0 text-sm text-muted-foreground">
            Enable 2FA for yourself before you make it necessary for the organization.{" "}
            <Link href="/account#two-factor" className="text-primary hover:underline">
              Enable 2FA
            </Link>
          </p>
        ) : null}
      </SettingRow>
      <SettingRow
        label="Members with two-factor authentication"
        help={`${s.members_with_two_factor} of ${s.members} ${s.members === 1 ? "member has" : "members have"} 2FA on.`}
        placement="end"
        control={
          <Link href="/team" className="text-sm text-primary hover:underline">
            See members
          </Link>
        }
      />
    </>
  );
}

/**
 * The session policy (0482): roles that need 2FA, added to the installation's. The idle
 * timeout and session length are set by the installation only, so they have no row.
 */
function RoleRows({ security: s }: { security: Security }) {
  const d = s.deployment;
  // An engine older than 0482 sends no policy: show nothing rather than a control with no backend.
  if (!d) return null;
  const orgRoles = new Set(s.mfa_required_roles ?? []);
  const envRoles = new Set(d.mfa_required_roles);
  const ownRoleBlocked = !s.caller_has_two_factor && s.caller_role ? s.caller_role : null;
  return (
    <>
      <input type="hidden" name="session_policy" value="1" />
      <SettingRow
        label="Roles that must use two-factor authentication"
        help="A member with a selected role must enable 2FA to use the dashboard. There is no grace period."
        control={
          <div className="flex flex-col gap-2">
            {Object.entries(ROLE_LABELS).map(([role, label]) =>
              envRoles.has(role) ? (
                <CheckboxField
                  key={role}
                  label={label}
                  hint="Always necessary on this installation."
                  defaultChecked
                  disabled
                />
              ) : (
                <CheckboxField
                  key={role}
                  name="mfa_role"
                  value={role}
                  label={label}
                  hint={
                    ownRoleBlocked === role
                      ? "This is your role. Enable 2FA for yourself before you select it."
                      : undefined
                  }
                  defaultChecked={orgRoles.has(role)}
                />
              ),
            )}
          </div>
        }
      />
    </>
  );
}
