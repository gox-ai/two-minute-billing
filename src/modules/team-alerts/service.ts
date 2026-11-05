/**
 * Team alerts: what each alert reports, how it reads, and the one send.
 *
 * Every alert covers a fixed WINDOW derived from the hour it runs for, so no "already sent"
 * ledger is needed: a due date, a failed delivery or a local day falls in exactly one window,
 * and the hourly cron fires each hour once (`fanout.ts`). A send job that fails is retried by
 * the queue; a send that succeeded but whose job did not complete can repeat once.
 *
 * Mail goes through the deployment mailer (`resolveMailer(null)`), the same transport as
 * operator invites: it is mail to the merchant's staff, not to their customers, and must
 * arrive whether or not the business configured its own relay.
 */
import { sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { formatMoney } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import { escapeHtml } from "@/modules/emails/sanitize";
import { invoiceOutstanding } from "@/modules/invoicing/service";
import { rowsOf } from "@/modules/metering/usage-sql";
import {
  activeTeamAlertKinds,
  resolveTeamAlertsConfig,
  type TeamAlertKind,
  type TeamAlertsConfig,
} from "./config";
import { alertHour, digestDay, overdueWindow, webhookWindow } from "./windows";
import { deliverableRecipients } from "./recipients";

const log = createLogger("team-alerts");
export interface AlertBusiness {
  id: string;
  organizationId: string;
  publicId: string;
  name: string;
  timezone: string;
  config: TeamAlertsConfig;
}

export interface OverdueRow {
  invoicePublicId: string;
  number: string | null;
  customer: string;
  currency: string;
  outstandingMinor: bigint;
  dueDate: Date;
}

/** Unpaid invoices whose due date fell in the window, at or above the currency's threshold. */
export async function collectOverdue(
  tx: Tx,
  biz: AlertBusiness,
  hour: Date,
): Promise<OverdueRow[]> {
  const { start, end } = overdueWindow(hour);
  const thresholds = biz.config.overdue.thresholds;
  const currencies = Object.keys(thresholds);
  if (currencies.length === 0) return [];
  const rows = rowsOf<{
    id: string;
    public_id: string;
    number: string | null;
    currency: string;
    amount_due_minor: string | null;
    total_minor: string;
    due_date: Date | string;
    customer: string | null;
  }>(
    await tx.execute(sql`
      select i.id, i.public_id, i.number, i.currency, i.amount_due_minor, i.total_minor,
        i.due_date, coalesce(c.company, c.name, c.email, c.public_id) as customer
      from invoices i join customers c on c.id = i.customer_id
      where i.business_id = ${biz.id}
        and i.status in ('posted', 'payment_due', 'not_paid') and not i.written_off
        and i.due_date >= ${start.toISOString()}::timestamptz
        and i.due_date < ${end.toISOString()}::timestamptz
        and i.currency = any(${`{${currencies.join(",")}}`}::text[])
      order by i.due_date, i.public_id`),
  );
  const out: OverdueRow[] = [];
  for (const r of rows) {
    const { remainingMinor } = await invoiceOutstanding(tx, {
      id: r.id,
      amountDueMinor: r.amount_due_minor == null ? null : BigInt(r.amount_due_minor),
      totalMinor: BigInt(r.total_minor),
    });
    const threshold = thresholds[r.currency];
    if (threshold === undefined || remainingMinor <= 0n || remainingMinor < BigInt(threshold))
      continue;
    out.push({
      invoicePublicId: r.public_id,
      number: r.number,
      customer: r.customer ?? "",
      currency: r.currency,
      outstandingMinor: remainingMinor,
      dueDate: new Date(r.due_date),
    });
  }
  return out;
}

export interface WebhookFailureRow {
  endpointPublicId: string;
  url: string;
  failed: number;
  lastStatus: number | null;
  lastError: string | null;
}

/** Deliveries that reached `failed` in the window, one row per endpoint. */
export async function collectWebhookFailures(
  tx: Tx,
  biz: AlertBusiness,
  hour: Date,
): Promise<WebhookFailureRow[]> {
  const { start, end } = webhookWindow(hour);
  const rows = rowsOf<{
    public_id: string;
    url: string;
    failed: number;
    last_status: number | null;
    last_error: string | null;
  }>(
    await tx.execute(sql`
      select e.public_id, e.url, count(*)::int as failed,
        (array_agg(d.last_response_status order by d.last_attempt_at desc))[1] as last_status,
        (array_agg(d.last_error order by d.last_attempt_at desc))[1] as last_error
      from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
      where d.business_id = ${biz.id} and d.status = 'failed'
        and d.last_attempt_at >= ${start.toISOString()}::timestamptz
        and d.last_attempt_at < ${end.toISOString()}::timestamptz
      group by e.public_id, e.url
      order by e.public_id`),
  );
  return rows.map((r) => ({
    endpointPublicId: r.public_id,
    url: r.url,
    failed: r.failed,
    lastStatus: r.last_status,
    lastError: r.last_error,
  }));
}

export interface MoneyByCurrency {
  currency: string;
  amountMinor: bigint;
  count: number;
}

export interface DigestData {
  day: string;
  collected: MoneyByCurrency[];
  failedPayments: MoneyByCurrency[];
  /** Invoices in dunning when the digest is built (a snapshot, not a count for the day). */
  inDunning: number;
  /** Cards that expire this month or next month, local to the business. */
  expiringCards: number;
}

/** The previous local day's figures, plus two snapshots taken now. */
export async function collectDigest(
  tx: Tx,
  biz: AlertBusiness,
  window: { day: string; start: Date; end: Date; today: string },
): Promise<DigestData> {
  const money = async (statuses: string[]): Promise<MoneyByCurrency[]> =>
    rowsOf<{ currency: string; amount: string; n: number }>(
      await tx.execute(sql`
        select currency, sum(amount_minor)::text as amount, count(*)::int as n
        from transactions
        where business_id = ${biz.id} and type = 'payment'
          and status = any(${`{${statuses.join(",")}}`}::text[])
          and finalised_at >= ${window.start.toISOString()}::timestamptz
          and finalised_at < ${window.end.toISOString()}::timestamptz
        group by currency order by currency`),
    ).map((r) => ({ currency: r.currency, amountMinor: BigInt(r.amount), count: r.n }));

  const [dunning] = rowsOf<{ n: number }>(
    await tx.execute(sql`
      select count(*)::int as n from invoices
      where business_id = ${biz.id} and status = 'payment_due'
        and dunning_status in ('in_progress', 'parked')`),
  );

  const [y, m] = window.today.split("-").map(Number) as [number, number];
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  const [cards] = rowsOf<{ n: number }>(
    await tx.execute(sql`
      select count(*)::int as n from payment_methods
      where business_id = ${biz.id} and type = 'card' and status in ('valid', 'expiring')
        and ((exp_year = ${y} and exp_month = ${m}) or (exp_year = ${next.y} and exp_month = ${next.m}))`),
  );

  return {
    day: window.day,
    collected: await money(["succeeded"]),
    failedPayments: await money(["failed", "late_failed"]),
    inDunning: dunning?.n ?? 0,
    expiringCards: cards?.n ?? 0,
  };
}

export interface RenderedAlert {
  subject: string;
  html: string;
  text: string;
}

const dashboardBase = (): string | null => config.DASHBOARD_BASE_URL?.replace(/\/$/, "") ?? null;
const cell = 'style="padding:4px 12px 4px 0;vertical-align:top"';

function layout(
  heading: string,
  intro: string,
  table: string[][] | null,
  link: { label: string; href: string } | null,
) {
  const head = table?.[0] ?? [];
  const body = table?.slice(1) ?? [];
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">',
    `<h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(heading)}</h2>`,
    `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${escapeHtml(intro)}</p>`,
    table
      ? [
          '<table style="font-size:13px;line-height:1.5;border-collapse:collapse;margin:0 0 16px">',
          `<tr>${head.map((h) => `<th ${cell} align="left">${escapeHtml(h)}</th>`).join("")}</tr>`,
          ...body.map(
            (r) => `<tr>${r.map((v) => `<td ${cell}>${escapeHtml(v)}</td>`).join("")}</tr>`,
          ),
          "</table>",
        ].join("")
      : "",
    link
      ? `<p style="margin:24px 0"><a href="${escapeHtml(link.href)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(link.label)}</a></p>`
      : "",
    "</div>",
  ].join("");
  const text = [
    intro,
    ...body.map((r) => r.map((v, i) => `${head[i]}: ${v}`).join(" · ")),
    link ? `${link.label}: ${link.href}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { html, text };
}

const dateText = (d: Date, tz: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);

const moneyList = (rows: MoneyByCurrency[]): string =>
  rows.length === 0
    ? "None"
    : rows.map((r) => `${formatMoney(r.amountMinor, r.currency)} (${r.count})`).join(", ");

export function renderOverdue(biz: AlertBusiness, rows: OverdueRow[]): RenderedAlert {
  const n = rows.length;
  const subject = `${biz.name}: ${n} high-value invoice${n === 1 ? " is" : "s are"} overdue`;
  const intro = `${n === 1 ? "This invoice is" : "These invoices are"} past the due date and not paid. The amount due is at or above your alert limit.`;
  const base = dashboardBase();
  const { html, text } = layout(
    subject,
    intro,
    [
      ["Invoice", "Customer", "Amount due", "Due date"],
      ...rows.map((r) => [
        r.number ?? r.invoicePublicId,
        r.customer,
        formatMoney(r.outstandingMinor, r.currency),
        dateText(r.dueDate, biz.timezone),
      ]),
    ],
    base ? { label: "View invoices", href: `${base}/businesses/${biz.publicId}/invoices` } : null,
  );
  return { subject, html, text };
}

export function renderWebhookFailures(
  biz: AlertBusiness,
  rows: WebhookFailureRow[],
): RenderedAlert {
  const total = rows.reduce((s, r) => s + r.failed, 0);
  const subject = `${biz.name}: ${total} webhook${total === 1 ? "" : "s"} could not be delivered`;
  const intro =
    "We stopped trying to deliver these webhooks. The endpoint did not accept them after all retries. Correct the endpoint, then send the webhooks again.";
  const base = dashboardBase();
  const { html, text } = layout(
    subject,
    intro,
    [
      ["Endpoint", "Failed", "Last response"],
      ...rows.map((r) => [
        r.url,
        String(r.failed),
        r.lastStatus ? `HTTP ${r.lastStatus}` : (r.lastError?.slice(0, 120) ?? "No response"),
      ]),
    ],
    base ? { label: "View events", href: `${base}/businesses/${biz.publicId}/events` } : null,
  );
  return { subject, html, text };
}

export function renderDigest(biz: AlertBusiness, d: DigestData): RenderedAlert {
  const subject = `${biz.name}: daily summary for ${d.day}`;
  const intro = `Your billing summary for ${d.day} (${biz.timezone}). Dunning and cards show the status at the time of this email.`;
  const base = dashboardBase();
  const { html, text } = layout(
    subject,
    intro,
    [
      ["Item", "Value"],
      ["Payments collected", moneyList(d.collected)],
      ["Payments that failed", moneyList(d.failedPayments)],
      ["Invoices in dunning", String(d.inDunning)],
      ["Cards that expire this month or next month", String(d.expiringCards)],
    ],
    base ? { label: "View dashboard", href: `${base}/businesses/${biz.publicId}` } : null,
  );
  return { subject, html, text };
}

/** Load the business this job is for. Null when it no longer exists. */
export async function loadAlertBusiness(
  organizationId: string,
  businessId: string,
): Promise<AlertBusiness | null> {
  return withTenant(organizationId, async (tx) => {
    const [b] = rowsOf<{
      id: string;
      organization_id: string;
      public_id: string;
      name: string;
      timezone: string | null;
      team_alerts_config: unknown;
    }>(
      await tx.execute(sql`
        select id, organization_id, public_id, name, timezone, team_alerts_config
        from businesses where id = ${businessId}`),
    );
    if (!b) return null;
    return {
      id: b.id,
      organizationId: b.organization_id,
      publicId: b.public_id,
      name: b.name,
      timezone: b.timezone ?? "UTC",
      config: resolveTeamAlertsConfig({ teamAlertsConfig: b.team_alerts_config }),
    };
  });
}

export type SendOutcome =
  | "sent"
  | "nothing_to_report"
  | "not_due"
  | "off"
  | "no_business"
  | "no_recipients";

/**
 * Build and send one alert for one business and hour. Re-reads the config, so turning an
 * alert off stops jobs already queued. Throws when the mailer refuses, so the queue retries.
 */
export async function sendTeamAlert(input: {
  organizationId: string;
  businessId: string;
  kind: TeamAlertKind;
  /** The hour the run is for (any instant in it). */
  hour: Date;
}): Promise<SendOutcome> {
  const biz = await loadAlertBusiness(input.organizationId, input.businessId);
  if (!biz) return "no_business";
  if (!activeTeamAlertKinds(biz.config).includes(input.kind)) return "off";
  // Members and confirmed addresses only: an unconfirmed outside address gets nothing.
  const recipients = await deliverableRecipients(biz.organizationId, biz.id, biz.config.recipients);
  if (recipients.length === 0) return "no_recipients";
  const hour = alertHour(input.hour);

  const mail = await withTenant(
    biz.organizationId,
    async (tx): Promise<RenderedAlert | SendOutcome> => {
      if (input.kind === "overdue") {
        const rows = await collectOverdue(tx, biz, hour);
        return rows.length ? renderOverdue(biz, rows) : "nothing_to_report";
      }
      if (input.kind === "webhook_failures") {
        const rows = await collectWebhookFailures(tx, biz, hour);
        return rows.length ? renderWebhookFailures(biz, rows) : "nothing_to_report";
      }
      const day = digestDay(hour, biz.timezone);
      if (!day) return "not_due";
      return renderDigest(biz, await collectDigest(tx, biz, day));
    },
  );
  if (typeof mail === "string") return mail;

  const [to, ...cc] = recipients;
  await resolveMailer(null).send({
    to: to!,
    cc: cc.length ? cc : null,
    from: config.MAIL_FROM,
    fromName: config.MAIL_FROM_NAME,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    idempotencyKey: `team_alert:${input.kind}:${biz.id}:${hour.toISOString()}`,
  });
  log.info("team alert sent", {
    event: "team_alert_sent",
    businessId: biz.id,
    kind: input.kind,
    hour: hour.toISOString(),
    recipients: recipients.length,
  });
  return "sent";
}

/**
 * A free credit grant above the business's alert threshold (0495). Sent once, after the grant
 * commits, when `large_grants` is on. The audit row is written whether or not this sends.
 */
export async function sendLargeGrantAlert(input: {
  organizationId: string;
  businessId: string;
  kindLabel: string;
  reference: string;
  customer: string | null;
  amountMinor: bigint;
  currency: string;
  alertAboveMinor: number;
}): Promise<SendOutcome> {
  const biz = await loadAlertBusiness(input.organizationId, input.businessId);
  if (!biz) return "no_business";
  if (!biz.config.largeGrants.enabled) return "off";
  const recipients = await deliverableRecipients(biz.organizationId, biz.id, biz.config.recipients);
  if (recipients.length === 0) return "no_recipients";
  const amount = formatMoney(input.amountMinor, input.currency);
  const subject = `${biz.name}: a ${input.kindLabel} of ${amount} is above your alert limit`;
  const intro = `A team member or API key gave free credit above your alert limit of ${formatMoney(input.alertAboveMinor, input.currency)}. If you did not expect this, examine the audit log.`;
  const base = dashboardBase();
  const { html, text } = layout(
    subject,
    intro,
    [
      ["Item", "Value"],
      ["Type", input.kindLabel],
      ["Amount", amount],
      ["Customer", input.customer ?? "Not known"],
      ["Reference", input.reference],
    ],
    base ? { label: "View audit log", href: `${base}/businesses/${biz.publicId}/audit` } : null,
  );
  const [to, ...cc] = recipients;
  await resolveMailer(null).send({
    to: to!,
    cc: cc.length ? cc : null,
    from: config.MAIL_FROM,
    fromName: config.MAIL_FROM_NAME,
    subject,
    html,
    text,
    idempotencyKey: `team_alert:large_grant:${biz.id}:${input.reference}`,
  });
  log.info("team alert sent", {
    event: "team_alert_sent",
    businessId: biz.id,
    kind: "large_grants",
    recipients: recipients.length,
  });
  return "sent";
}
