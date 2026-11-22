import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getNotificationPreferences, listNotificationDestinations } from "@/lib/api/notifications";
import { OrgSettingsFrame } from "@/components/org-settings/org-settings-frame";
import { ErrorState } from "@/components/states";
import { TeamNotifications } from "@/components/notifications/team-notifications";

export const dynamic = "force-dynamic";

/**
 * Settings → Team notifications (0533): Google Chat spaces and outside email addresses,
 * shared by the organization. Owners and admins only; anyone else gets the not-found page.
 */
export default async function TeamNotificationsPage() {
  const me = await requireUser();
  if (me.role !== "owner" && me.role !== "admin") notFound();
  let data: [
    Awaited<ReturnType<typeof listNotificationDestinations>>,
    Awaited<ReturnType<typeof getNotificationPreferences>>,
  ];
  try {
    data = await Promise.all([listNotificationDestinations(), getNotificationPreferences()]);
  } catch (e) {
    return (
      <OrgSettingsFrame page="notifications">
        <ErrorState title="We could not load team notifications" error={e} retry />
      </OrgSettingsFrame>
    );
  }
  const [dests, prefs] = data;
  return (
    <OrgSettingsFrame
      page="notifications"
      description="Send notifications to a Google Chat space or to an email address outside the organization, such as your accountant."
      liveAccessLocked={me.organization_live_access === "locked"}
    >
      <TeamNotifications
        destinations={dests.data}
        businesses={prefs.businesses}
        catalogue={prefs.catalogue}
      />
    </OrgSettingsFrame>
  );
}
