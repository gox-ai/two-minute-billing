import { requireUser } from "@/lib/session";
import { orgTz } from "@/lib/org-tz-server";
import {
  getNotificationPreferences,
  getNotificationSettings,
  getPushConfig,
  listPushSubscriptions,
} from "@/lib/api/notifications";
import { SettingsPage } from "@/components/settings/settings-layout";
import { ErrorState } from "@/components/states";
import { NotificationsSettings } from "@/components/notifications/notifications-settings";

export const dynamic = "force-dynamic";

/** Your notifications (0533): personal, every role. Devices, events, summaries, quiet hours. */
export default async function YourNotificationsPage() {
  const user = await requireUser();
  let data: [
    Awaited<ReturnType<typeof getNotificationPreferences>>,
    Awaited<ReturnType<typeof getNotificationSettings>>,
    Awaited<ReturnType<typeof getPushConfig>>,
    Awaited<ReturnType<typeof listPushSubscriptions>>,
  ];
  try {
    data = await Promise.all([
      getNotificationPreferences(),
      getNotificationSettings(),
      getPushConfig(),
      listPushSubscriptions(),
    ]);
  } catch (e) {
    // A form that replaces stored settings never starts from a failed load.
    return (
      <SettingsPage
        title="Notifications"
        crumbs={[{ label: "Your account", href: "/account" }, { label: "Notifications" }]}
      >
        <ErrorState title="We could not load your notifications" error={e} retry />
      </SettingsPage>
    );
  }
  const [prefs, settings, push, devices] = data;
  return (
    <SettingsPage
      title="Notifications"
      description="Select what you want to know about, and where we send it. Only you get these settings."
      crumbs={[{ label: "Your account", href: "/account" }, { label: "Notifications" }]}
    >
      <NotificationsSettings
        prefs={prefs}
        settings={settings}
        fallbackTz={await orgTz()}
        publicKey={push.public_key}
        devices={devices.data}
        email={user.email}
        manager={user.role === "owner" || user.role === "admin"}
      />
    </SettingsPage>
  );
}
