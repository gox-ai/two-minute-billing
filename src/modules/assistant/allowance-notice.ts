/**
 * The 80% allowance email (enforce mode). Sent to the organization's owners and admins once a
 * month: the first turn that crosses 80% claims the month in `allowance_warned_month`, so two
 * turns finishing together send it once.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { config } from "@/platform/config";
import { withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { assistantSettings, memberships, organizations, users } from "@db/schema";
import { accountBrand } from "@/modules/emails/account-brand";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import { renderAssistantAllowanceEmail } from "@/modules/emails/templates";
import { monthKey } from "./allowance";

const log = createLogger("assistant.allowance");

export async function warnAllowance(
  organizationId: string,
  a: { used_percent: number; renews_at: string },
  now = new Date(),
): Promise<number> {
  const month = monthKey(now);
  const claimed = await withTenant(organizationId, (tx) =>
    tx
      .insert(assistantSettings)
      .values({ organizationId, allowanceWarnedMonth: month })
      .onConflictDoUpdate({
        target: assistantSettings.organizationId,
        set: { allowanceWarnedMonth: month },
        setWhere: sql`${assistantSettings.allowanceWarnedMonth} is distinct from ${month}`,
      })
      .returning({ id: assistantSettings.organizationId }),
  );
  if (!claimed.length) return 0;

  const { org, people } = await withTenant(organizationId, async (tx) => {
    const [org] = await tx
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const people = await tx
      .select({ email: users.email, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          inArray(memberships.role, ["owner", "admin"]),
          isNotNull(memberships.acceptedAt),
        ),
      );
    return { org: org!, people };
  });

  const base = config.DASHBOARD_BASE_URL?.replace(/\/$/, "");
  const renewsOn = new Date(a.renews_at).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  let sent = 0;
  for (const p of people) {
    const mail = renderAssistantAllowanceEmail({
      name: p.name,
      organizationName: org.name,
      usedPercent: a.used_percent,
      renewsOn,
      link: base ? `${base}/settings/assistant` : null,
    });
    try {
      await resolveMailer(null).send({
        to: p.email,
        from: config.MAIL_FROM,
        fromName: accountBrand().name,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
      sent++;
    } catch (err) {
      log.error(err, { event: "assistant_allowance_mail_failed", organizationId });
    }
  }
  log.info("assistant allowance warning sent", {
    event: "assistant_allowance_warned",
    organizationId,
    usedPercent: a.used_percent,
    recipients: sent,
  });
  return sent;
}
