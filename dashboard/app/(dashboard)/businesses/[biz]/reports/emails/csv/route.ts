import { requirePermission } from "@/lib/session";
import { getEmailReport, type EmailCounts } from "@/lib/api/email-report";
import { csvRow } from "@/lib/csv";

/**
 * The email report's tables as one CSV, from the same read the page renders. Money is in MINOR
 * UNITS and rates in basis points, as the API sends them. Recipients show as domains only.
 */
export async function GET(req: Request, { params }: { params: Promise<{ biz: string }> }) {
  await requirePermission("reports:view", "ops");
  const { biz } = await params;
  const qs = new URL(req.url).searchParams;
  const start = qs.get("start");
  const end = qs.get("end");
  if (!start || !end)
    return new Response("We could not export the report. The request has no period.", {
      status: 400,
    });
  const r = await getEmailReport(biz, {
    start,
    end,
    compare: false,
    recent: 500,
    ...(qs.get("type") ? { type: qs.get("type")! } : {}),
    ...(qs.get("transport") ? { transport: qs.get("transport")! } : {}),
  });
  const counts = (c: EmailCounts) => [
    c.queued,
    c.delivered,
    c.not_sent,
    c.pending,
    c.failed,
    c.bounced,
    c.complained,
    c.skipped,
    c.delivered_bps ?? "",
    c.bounce_bps ?? "",
    c.complaint_bps ?? "",
  ];
  const head = [
    "Queued",
    "Delivered",
    "Not sent to a mail server",
    "Waiting",
    "Failed",
    "Bounced",
    "Complaints",
    "Skipped",
    "Delivered (bps)",
    "Bounced (bps)",
    "Complaints (bps)",
  ];
  const lines: string[] = [
    csvRow(["Email report", `${r.start} to ${r.end}`, `Currency: ${r.currency} (minor units)`]),
    "",
    csvRow(["Figure", "Value"]),
    ...Object.entries(r.totals).map(([k, v]) => csvRow([k, v ?? ""])),
    "",
    csvRow([
      "Day",
      "Queued",
      "Delivered",
      "Failed, bounced or complained",
      "Skipped",
      "Open rate (bps)",
      "Click rate (bps)",
      "Link visits",
      "Recovered (minor)",
    ]),
    ...r.days.map((d, i) =>
      csvRow([
        d.date,
        r.series.queued[i],
        r.series.delivered[i],
        r.series.problems[i],
        r.series.skipped[i],
        r.series.open_bps[i] ?? "",
        r.series.click_bps[i] ?? "",
        r.series.link_visits?.[i] ?? "",
        r.series.recovered_minor?.[i] ?? "",
      ]),
    ),
    "",
    csvRow(["Funnel step", "Count"]),
    ...r.funnel.map((s) => csvRow([s.label, s.sessions])),
    "",
    csvRow([
      "Email type",
      ...head,
      "Tracked",
      "Opened",
      "Open rate (bps)",
      "Clicked",
      "Click rate (bps)",
      "Machine opens",
      "Portal visits",
      "Invoices paid afterwards",
    ]),
    ...r.by_type.map((t) =>
      csvRow([
        t.type,
        ...counts(t),
        t.tracked,
        t.opened,
        t.open_bps ?? "",
        t.clicked,
        t.click_bps ?? "",
        t.machine_opened,
        t.link_visits ?? "",
        t.paid_after,
      ]),
    ),
    "",
    csvRow(["Tracking enabled", "Tracking since", "Period fully covered"]),
    csvRow([
      r.tracking.enabled ? "yes" : "no",
      r.tracking.since ?? "",
      r.tracking.covers_period ? "yes" : "no",
    ]),
    "",
    csvRow(["Link label", "Host", "Path", "Clicks", "Emails"]),
    ...r.top_links.map((l) =>
      csvRow([l.label ?? "", l.host ?? "", l.path ?? "", l.clicks, l.emails]),
    ),
    "",
    csvRow(["Transport", ...head]),
    ...r.by_transport.map((t) => csvRow([t.transport, ...counts(t)])),
    "",
    csvRow(["Recipient domain", ...head]),
    ...r.by_domain.map((t) => csvRow([t.domain, ...counts(t)])),
    "",
    csvRow(["Outcome", "Reason", "Count"]),
    ...r.reasons.map((x) => csvRow([x.outcome, x.reason ?? "", x.count])),
    "",
    csvRow(["Skipped reason", "Count"]),
    ...r.skipped_reasons.map((x) => csvRow([x.reason ?? "", x.count])),
    "",
    csvRow(["Failed-payment email number", "Sent", "Invoices paid afterwards"]),
    ...r.dunning.steps.map((s) => csvRow([s.position, s.sent, s.recovered])),
    "",
    csvRow([
      "Time",
      "Email",
      "Type",
      "Customer",
      "Status",
      "Transport",
      "Opened",
      "Clicked",
      "Portal link opened",
      "Invoice paid afterwards",
    ]),
    ...r.recent.map((e) =>
      csvRow([
        e.at,
        e.email,
        e.type,
        e.customer ?? "",
        e.status,
        e.transport ?? "",
        e.opened == null ? "" : e.opened ? "yes" : "no",
        e.clicked == null ? "" : e.clicked ? "yes" : "no",
        e.portal_opened ? "yes" : "no",
        e.paid_after ? "yes" : "no",
      ]),
    ),
  ];
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="email-report-${r.start}-${r.end}.csv"`,
    },
  });
}
