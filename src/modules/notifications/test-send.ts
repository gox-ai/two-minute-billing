/**
 * Test sends the routes trigger: "Send a test notification" on a device, "Send test and add" for a
 * Google Chat space. Sent now (not queued), through the same channel code as the drain.
 */
import { and, eq, ne } from "drizzle-orm";
import { notificationDestinations, organizations, pushSubscriptions } from "@db/schema";
import { withTenant } from "@/platform/db";
import { decryptSecret } from "@/platform/secrets";
import { escapeHtml } from "@/modules/emails/sanitize";
import { pushConfigured, sendChat, sendMail, sendPush, type SendOutcome } from "./channels";
import { recordChatResult, recordPushResult } from "./deliver";
import { isChatWebhookUrl } from "./service";

export type TestSendResult = { ok: true } | { ok: false; code: string; message: string };

const failed = (code: string, message: string): TestSendResult => ({ ok: false, code, message });

const why = (o: Exclude<SendOutcome, { kind: "sent" | "skipped" }>) => o.error.slice(0, 200);

/** One push to one of the caller's own devices, sent now (not queued). */
export async function sendTestPush(input: {
  organizationId: string;
  userId: string;
  subscriptionPublicId: string;
}): Promise<TestSendResult> {
  if (!pushConfigured())
    return failed(
      "push_not_configured",
      "We could not send the test. Push notifications are not set up on this server.",
    );
  const [sub] = await withTenant(input.organizationId, (tx) =>
    tx
      .select()
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, input.userId),
          eq(pushSubscriptions.publicId, input.subscriptionPublicId),
        ),
      )
      .limit(1),
  );
  if (!sub)
    return failed("not_found", `We could not find the device ${input.subscriptionPublicId}.`);
  const now = new Date();
  const o = await sendPush(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    {
      title: "Test notification",
      body: "Notifications work on this device.",
      url: "/account/notifications",
      tag: "test",
      renotify: true,
    },
    "high",
  );
  await recordPushResult(sub.id, o, now);
  if (o.kind === "sent") return { ok: true };
  if (o.kind === "skipped")
    return o.gone
      ? failed(
          "subscription_gone",
          "We could not send the test. This device does not accept notifications now. Enable notifications on it again.",
        )
      : failed(
          o.reason,
          "We could not send the test. Push notifications are not set up on this server.",
        );
  return failed(
    "push_failed",
    `We could not send the test. The push service refused it: ${why(o)}. Try again later.`,
  );
}

function testCard(name: string) {
  return {
    text: `Test message from Two Minute Billing for "${name}".`,
    cardsV2: [
      {
        cardId: "test",
        card: {
          header: { title: "Test message", subtitle: "Two Minute Billing" },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: escapeHtml(
                      `Notifications for "${name}" come to this space. You do not need to do anything.`,
                    ),
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** One message to a Google Chat webhook URL (not yet stored), sent now. */
export async function sendTestChat(input: {
  organizationId: string;
  url: string;
  name: string;
}): Promise<TestSendResult> {
  if (!isChatWebhookUrl(input.url))
    return failed(
      "invalid_url",
      "Enter a Google Chat webhook URL. It starts with https://chat.googleapis.com/.",
    );
  const o = await sendChat(input.url, testCard(input.name));
  if (o.kind === "sent") return { ok: true };
  return failed(
    "chat_failed",
    `We could not send the test message to Google Chat. ${o.kind === "skipped" ? o.reason : why(o)}. Check the webhook URL.`,
  );
}

/** One test message to a stored destination (chat or confirmed email), sent now. */
export async function sendTestToDestination(input: {
  organizationId: string;
  destinationPublicId: string;
}): Promise<TestSendResult> {
  const found = await withTenant(input.organizationId, async (tx) => {
    const [d] = await tx
      .select()
      .from(notificationDestinations)
      .where(
        and(
          eq(notificationDestinations.publicId, input.destinationPublicId),
          ne(notificationDestinations.status, "removed"),
        ),
      )
      .limit(1);
    const [org] = await tx
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1);
    return d ? { d, orgName: org?.name ?? "your organization" } : null;
  });
  if (!found)
    return failed("not_found", `We could not find the destination ${input.destinationPublicId}.`);
  const { d, orgName } = found;
  const now = new Date();
  if (d.type === "chat") {
    if (!d.urlEnc)
      return failed("invalid_url", "We could not send the test. The space has no webhook URL.");
    let url: string;
    try {
      url = decryptSecret(d.urlEnc);
    } catch {
      return failed(
        "invalid_url",
        "We could not send the test. Change the webhook URL of the space.",
      );
    }
    const o = await sendChat(url, testCard(d.name));
    await recordChatResult(d, o, now);
    if (o.kind === "sent") return { ok: true };
    return failed(
      "chat_failed",
      `We could not send the test message to Google Chat. ${o.kind === "skipped" ? o.reason : why(o)}. Check the webhook URL.`,
    );
  }
  if (d.status !== "active" || !d.email)
    return failed(
      "not_confirmed",
      `We did not send the test. ${d.name} did not confirm the address.`,
    );
  const subject = `Test notification from ${orgName}`;
  const intro = `This is a test. Billing notifications of ${orgName} come to this address. You do not need to do anything.`;
  const o = await sendMail({
    to: d.email,
    subject,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222"><h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(subject)}</h2><p style="font-size:14px;line-height:1.6;margin:0">${escapeHtml(intro)}</p></div>`,
    text: intro,
    idempotencyKey: `notification_test:${d.id}:${now.getTime()}`,
  });
  if (o.kind === "sent") return { ok: true };
  return failed(
    "email_failed",
    `We could not send the test email. ${o.kind === "skipped" ? o.reason : why(o)}. Try again later.`,
  );
}
