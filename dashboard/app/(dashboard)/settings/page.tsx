import { getMe } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { Input } from "@/components/ui/input";
import { LIMITS } from "@/lib/limits";
import { IdChip } from "@/components/patterns/chip";
import { SettingRow, SettingsCard, SettingsSaveBar } from "@/components/settings/settings-layout";
import { TimezoneSelect } from "@/components/form/timezone-select";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { brandImageSupport } from "@/lib/api/brand-images";
import { OrgSettingsFrame } from "@/components/org-settings/org-settings-frame";
import { OrgLogoField } from "@/components/org-settings/org-logo-field";
import { OldAnchorRedirect } from "@/components/org-settings/old-anchor-redirect";
import { saveOrgSettingsAction } from "./save-actions";

export const dynamic = "force-dynamic";

// Settings → General: name, logo, time zone and id. The other organization settings are
// sibling pages in the side list; each page posts only its own fields, and the action
// sends only the fields present (PATCH), so saving here leaves them alone.
export default async function GeneralSettingsPage() {
  const me = await requirePermission("settings:manage", "admin");

  let org: Awaited<ReturnType<typeof getMe>>;
  let upload: Awaited<ReturnType<typeof brandImageSupport>>;
  try {
    // `brandImageSupport` never throws: it answers "unknown".
    [org, upload] = await Promise.all([getMe(), brandImageSupport()]);
  } catch (e) {
    return (
      <ErrorState
        title="We could not connect to the API"
        description={<span className="font-mono text-xs">{(e as Error).message}</span>}
      />
    );
  }

  return (
    <OrgSettingsFrame
      page="general"
      description="The name, logo and time zone of your organization."
      liveAccessLocked={me.organization_live_access === "locked"}
    >
      <OldAnchorRedirect />
      <ActionForm action={saveOrgSettingsAction} className="flex flex-col gap-5">
        <SettingsCard title="Organization">
          <SettingRow
            label="Organization name"
            htmlFor="name"
            errorFor="name"
            placement="end"
            help="Shown in the organization switcher and wherever the account is named."
            control={
              <Input
                id="name"
                name="name"
                defaultValue={org.name}
                required
                maxLength={LIMITS.name}
                className="w-full sm:w-72"
              />
            }
          />
          <SettingRow
            label="Logo"
            htmlFor="icon_url"
            errorFor="icon_url"
            placement="end"
            help={
              upload.uploadEnabled
                ? "A square PNG, JPEG, GIF or WebP, up to 5 MB. Upload it or paste an https URL. Empty: the sidebar shows the product mark."
                : "An https URL to a square PNG, JPEG, GIF or WebP. Empty: the sidebar shows the product mark."
            }
            control={<OrgLogoField iconUrl={org.icon_url ?? null} upload={upload} />}
          />
          <SettingRow
            label="Time zone"
            htmlFor="timezone"
            errorFor="timezone"
            placement="end"
            help={
              org.timezone
                ? "How Audit log and Developer show times. Each business keeps its own time zone for billing."
                : "How Audit log and Developer show times. Not set, so they show UTC. Each business keeps its own time zone."
            }
            control={
              <TimezoneSelect
                name="timezone"
                // The stored value. Empty shows the placeholder, never a UTC nobody chose.
                defaultValue={org.timezone}
                clearable
                className="w-full sm:w-72"
                description="Sets how Audit log and Developer show times. It does not move a billing day or an invoice date."
              />
            }
          />
          <SettingRow
            label="Organization ID"
            placement="end"
            help="Identifies the organization in every API request, webhook and ledger entry. You cannot change it."
            control={<IdChip id={org.id} />}
          />
        </SettingsCard>
        <SettingsSaveBar label="Save" />
      </ActionForm>
    </OrgSettingsFrame>
  );
}
