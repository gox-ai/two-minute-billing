"use client";

import * as React from "react";
import Link from "next/link";
import { InstallCard } from "@/components/app-install/install-app";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type {
  NotificationPreferences,
  NotificationSettings,
  PushSubscription,
} from "@/lib/api/notifications";
import { dismissNotificationsNoticeAction } from "@/app/(dashboard)/account/notifications/actions";
import { DevicesCard } from "./devices-card";
import { NotificationSettingsForm } from "./settings-form";

/** /account/notifications: the notice, the devices, then the one settings form. */
export function NotificationsSettings({
  prefs,
  settings,
  fallbackTz,
  publicKey,
  devices,
  email,
  manager,
}: {
  prefs: NotificationPreferences;
  settings: NotificationSettings;
  fallbackTz: string;
  publicKey: string | null;
  devices: PushSubscription[];
  email: string;
  /** Owner or admin: sees the notice and the link to Team notifications. */
  manager: boolean;
}) {
  // The save bar shows: the enable button steps down to outline, so one action is filled.
  const [barShown, setBarShown] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);
  const notice = manager && prefs.team_alerts_notice && !hidden;
  return (
    <div className="flex flex-col gap-5">
      {notice ? (
        <Alert
          tone="info"
          title="Team alerts are now notifications"
          action={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setHidden(true);
                void dismissNotificationsNoticeAction();
              }}
            >
              Dismiss
            </Button>
          }
        >
          Set up the notifications you want on this page. Add outside email addresses and Google
          Chat spaces in <Link href="/settings/notifications">Team notifications</Link>.
        </Alert>
      ) : null}
      {/* The card promises notifications, so only where push is set up. */}
      {publicKey ? <InstallCard ios={false} /> : null}
      <DevicesCard publicKey={publicKey} devices={devices} email={email} emphasis={!barShown} />
      <NotificationSettingsForm
        prefs={prefs}
        settings={settings}
        fallbackTz={fallbackTz}
        onDirtyChange={setBarShown}
      />
    </div>
  );
}
