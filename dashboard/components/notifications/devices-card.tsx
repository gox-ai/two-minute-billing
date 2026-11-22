"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/patterns/chip";
import { SettingRow, SettingsCard } from "@/components/settings/settings-layout";
import { IosInstallDialog } from "@/components/app-install/install-app";
import { useDisplayTz } from "@/components/business-tz";
import { fmtDate } from "@/lib/format-date";
import { SW_URL, getRegistration, isIosSafari, isStandalone } from "@/lib/pwa";
import { deviceLabel, keyBytes } from "@/lib/notifications-view";
import type { PushSubscription } from "@/lib/api/notifications";
import {
  removePushSubscriptionAction,
  savePushSubscriptionAction,
  sendTestPushAction,
} from "@/app/(dashboard)/notifications/actions";

/** This browser's subscription: the device id the API gave it, and its endpoint. */
const STORE = "tmb.push.device";

type Env =
  | { kind: "unknown" }
  | { kind: "unsupported" }
  | { kind: "ios-tab" }
  | { kind: "ready"; permission: NotificationPermission; thisId: string | null };

function readStored(): { id: string; endpoint: string } | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as { id: string; endpoint: string }) : null;
  } catch {
    return null;
  }
}
function writeStored(v: { id: string; endpoint: string } | null) {
  try {
    if (v) localStorage.setItem(STORE, JSON.stringify(v));
    else localStorage.removeItem(STORE);
  } catch {
    // Private window: this device simply is not remembered.
  }
}

/** The worker's registration, registering it when the shell has not (a dev server). */
async function registration(): Promise<ServiceWorkerRegistration> {
  const reg =
    (await getRegistration()) ?? (await navigator.serviceWorker.register(SW_URL, { scope: "/" }));
  await navigator.serviceWorker.ready;
  return reg;
}

/**
 * "Where we send notifications": this device (enable, test, disable), the member's other
 * devices (remove), and the email address from the profile. Personal, for every organization.
 */
export function DevicesCard({
  publicKey,
  devices,
  email,
  emphasis,
}: {
  /** Null: this server cannot send push. */
  publicKey: string | null;
  devices: PushSubscription[];
  email: string;
  /** The enable button is the filled action only while the settings form is clean. */
  emphasis: boolean;
}) {
  const router = useRouter();
  const tz = useDisplayTz();
  const [env, setEnv] = React.useState<Env>({ kind: "unknown" });
  const [busy, setBusy] = React.useState<string | null>(null);
  const [iosHelp, setIosHelp] = React.useState(false);

  // Browser-only facts (permission, this device's stored id): read after mount, so the server
  // render and hydration agree.
  React.useEffect(() => {
    if (isIosSafari() && !isStandalone()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEnv({ kind: "ios-tab" });
      return;
    }
    if (
      !("Notification" in window) ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window)
    ) {
      setEnv({ kind: "unsupported" });
      return;
    }
    const stored = readStored();
    const known = stored && devices.some((d) => d.id === stored.id) ? stored.id : null;
    setEnv({ kind: "ready", permission: Notification.permission, thisId: known });
  }, [devices]);

  const thisId = env.kind === "ready" ? env.thisId : null;
  const thisDevice = devices.find((d) => d.id === thisId) ?? null;
  const others = devices.filter((d) => d.id !== thisId);

  async function enable() {
    if (!publicKey) return;
    setBusy("enable");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setEnv({ kind: "ready", permission, thisId: null });
        return;
      }
      const reg = await registration();
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        }));
      const json = sub.toJSON();
      const ua = navigator.userAgent;
      const r = await savePushSubscriptionAction({
        endpoint: sub.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
        label: deviceLabel(ua),
        user_agent: ua,
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      writeStored({ id: r.id, endpoint: sub.endpoint });
      setEnv({ kind: "ready", permission, thisId: r.id });
      toast.success("Notifications enabled on this device.");
      router.refresh();
    } catch {
      toast.error("We could not enable notifications on this device. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function disable() {
    if (!thisId) return;
    setBusy("disable");
    try {
      const reg = await getRegistration();
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
    } catch {
      // The server copy is what sends; removing it below is enough.
    }
    const r = await removePushSubscriptionAction(thisId);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    writeStored(null);
    setEnv((e) => (e.kind === "ready" ? { ...e, thisId: null } : e));
    toast.success("Notifications disabled on this device.");
    router.refresh();
  }

  async function remove(d: PushSubscription) {
    setBusy(d.id);
    const r = await removePushSubscriptionAction(d.id);
    setBusy(null);
    if (!r.ok) toast.error(r.message);
    else {
      toast.success("Device removed.");
      router.refresh();
    }
  }

  async function test(id: string) {
    setBusy(`test:${id}`);
    const r = await sendTestPushAction(id);
    setBusy(null);
    if (r.ok) toast.success("Test notification sent.");
    else toast.error(r.message);
  }

  const used = (d: PushSubscription) =>
    d.last_success_at
      ? `last notification ${fmtDate(d.last_success_at, tz)}`
      : `added ${fmtDate(d.created_at, tz)}`;

  let thisRow: React.ReactNode;
  if (!publicKey) {
    thisRow = (
      <div className="px-5 py-4">
        <Alert tone="neutral">Push notifications are not set up on this server.</Alert>
      </div>
    );
  } else if (env.kind === "ios-tab") {
    thisRow = (
      <div className="px-5 py-4">
        <Alert
          tone="info"
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => setIosHelp(true)}>
              How to install
            </Button>
          }
        >
          On an iPhone or iPad, first add the app to your Home Screen, then enable notifications
          from the app.
        </Alert>
      </div>
    );
  } else if (env.kind === "unsupported") {
    thisRow = (
      <div className="px-5 py-4">
        <Alert tone="neutral">This browser cannot get push notifications.</Alert>
      </div>
    );
  } else if (thisDevice) {
    thisRow = (
      <SettingRow
        label={
          <span className="inline-flex items-center gap-2">
            This device <Chip tone="green">On</Chip>
          </span>
        }
        help={[
          thisDevice.label ?? "This browser",
          isStandalone() ? "installed app" : null,
          `enabled ${fmtDate(thisDevice.created_at, tz)}`,
        ]
          .filter(Boolean)
          .join(" · ")}
        placement="end"
        control={
          <span className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => test(thisDevice.id)}
            >
              Send a test notification
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={disable}
            >
              Disable
            </Button>
          </span>
        }
      />
    );
  } else {
    const blocked = env.kind === "ready" && env.permission === "denied";
    thisRow = (
      <SettingRow
        label="This device"
        help="Get a notification on this device when an event you selected happens, also when the app is closed."
        placement="end"
        control={
          <Button
            type="button"
            size="sm"
            variant={emphasis ? "default" : "outline"}
            disabled={busy !== null || env.kind === "unknown"}
            onClick={enable}
          >
            Enable on this device
          </Button>
        }
      >
        {blocked ? (
          <Alert tone="warning">
            Notifications are blocked in this browser. Allow notifications for this site in the
            browser settings, then select &quot;Enable on this device&quot; again.
          </Alert>
        ) : null}
      </SettingRow>
    );
  }

  return (
    <SettingsCard
      id="devices"
      title="Where we send notifications"
      meta="For all your organizations"
    >
      {thisRow}
      {others.map((d) => (
        <SettingRow
          key={d.id}
          label={
            <span className="inline-flex items-center gap-2">
              {d.label ?? "Other device"} <Chip tone="green">On</Chip>
            </span>
          }
          help={used(d)}
          placement="end"
          control={
            <span className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null || !publicKey}
                onClick={() => test(d.id)}
              >
                Send a test notification
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => remove(d)}
              >
                Remove
              </Button>
            </span>
          }
        />
      ))}
      <SettingRow label="Email" help={`${email} · from your profile`} />
      <IosInstallDialog open={iosHelp} onOpenChange={setIosHelp} />
    </SettingsCard>
  );
}
