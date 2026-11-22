"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import {
  deletePushSubscription,
  markAllNotificationsRead,
  markNotificationRead,
  savePushSubscription,
  sendTestPush,
  type PushSubscription,
  type PushSubscriptionInput,
} from "@/lib/api/notifications";

/** Called from client code (the bell, the device rows), not from a form. */
export type PlainResult = { ok: true } | { ok: false; message: string };

const failed = (r: { ok: boolean; error?: string }, fallback: string): PlainResult =>
  r.ok ? { ok: true } : { ok: false, message: r.error ?? fallback };

/** Opening a bell row marks it read. Only the caller's own rows. */
export async function markNotificationReadAction(id: string): Promise<PlainResult> {
  await requireUser();
  if (!/^[A-Za-z0-9_]{1,64}$/.test(id)) return { ok: false, message: "Not a notification." };
  return failed(await markNotificationRead(id), "We could not mark the notification as read.");
}

/** "Mark all as read", in one business when the bell is filtered to it. */
export async function markAllNotificationsReadAction(business?: string): Promise<PlainResult> {
  await requireUser();
  if (business && !/^[A-Za-z0-9_]{1,64}$/.test(business))
    return { ok: false, message: "Not a business." };
  return failed(
    await markAllNotificationsRead(business),
    "We could not mark the notifications as read.",
  );
}

/** This device's browser subscription. Returns the stored device id. */
export async function savePushSubscriptionAction(
  input: PushSubscriptionInput,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  await requireUser();
  const r = await savePushSubscription({
    endpoint: String(input.endpoint).slice(0, 2048),
    keys: { p256dh: String(input.keys?.p256dh ?? ""), auth: String(input.keys?.auth ?? "") },
    label: input.label?.slice(0, 100),
    user_agent: input.user_agent?.slice(0, 500),
  });
  if (!r.ok)
    return { ok: false, message: r.error ?? "We could not enable notifications on this device." };
  revalidatePath("/account/notifications");
  return { ok: true, id: (r.data as PushSubscription).id };
}

export async function removePushSubscriptionAction(id: string): Promise<PlainResult> {
  await requireUser();
  const r = await deletePushSubscription(id);
  revalidatePath("/account/notifications");
  // Already gone is the outcome the person asked for.
  return r.ok || r.status === 404 ? { ok: true } : failed(r, "We could not remove the device.");
}

export async function sendTestPushAction(id: string): Promise<PlainResult> {
  await requireUser();
  return failed(await sendTestPush(id), "We could not send the test notification.");
}
