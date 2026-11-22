import { requirePermission } from "@/lib/session";
import { getPortalReport } from "@/lib/api/hosted-page-reports";
import { csvRow } from "@/lib/csv";

/**
 * The portal report's tables as one CSV, from the same read the page renders. Money is in
 * MINOR UNITS and rates in basis points, as the API sends them.
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
  const r = await getPortalReport(biz, {
    start,
    end,
    compare: false,
    ...(qs.get("plan") ? { plan: qs.get("plan")! } : {}),
    ...(qs.get("arrived") ? { arrivedFrom: qs.get("arrived")! } : {}),
    ...(qs.get("country") ? { country: qs.get("country")! } : {}),
    ...(qs.get("device") ? { device: qs.get("device")! } : {}),
  });
  const lines: string[] = [
    csvRow(["Portal report", `${r.start} to ${r.end}`, `Currency: ${r.currency} (minor units)`]),
    "",
    csvRow(["Figure", "Value"]),
    ...Object.entries(r.totals).map(([k, v]) => csvRow([k, v ?? ""])),
    "",
    csvRow(["Day", "Visits", "Visits with an action", "Paid (minor)", "Methods added"]),
    ...r.days.map((d, i) =>
      csvRow([
        d.date,
        r.series.visits[i],
        r.series.visits_with_action[i],
        r.series.paid_minor[i],
        r.series.methods_added[i],
      ]),
    ),
    "",
    csvRow(["Arrived from", "Visits", "Customers", "Visits with an action", "Paid (minor)"]),
    ...r.arrivals.map((a) =>
      csvRow([a.arrival, a.visits, a.customers, a.visits_with_action, a.paid_minor]),
    ),
    "",
    csvRow(["Funnel step", "Links"]),
    ...r.funnel.map((s) => csvRow([s.label, s.sessions])),
    "",
    csvRow(["Action", "Count"]),
    ...r.actions.map((a) => csvRow([a.label, a.count])),
    "",
    csvRow(["Payment method", "Paid", "Amount (minor)", "Failed"]),
    ...r.payments.methods.map((m) => csvRow([m.method, m.paid, m.amount_minor, m.failed])),
    "",
    csvRow(["Delete reason", "Count"]),
    ...r.payment_methods.delete_reasons.map((d) => csvRow([d.reason, d.count])),
    "",
    csvRow(["Cancellation reason", "Started to cancel", "Saved"]),
    ...r.retention.reasons.map((x) => csvRow([x.reason ?? "", x.started, x.saved])),
    "",
    csvRow(["Visit time", "Customer", "Arrived from", "Actions", "Paid (minor)"]),
    ...r.recent.map((v) =>
      csvRow([v.at, v.customer, v.arrival, v.actions.join(" "), v.paid_minor]),
    ),
    // First-party visit tracking.
    "",
    csvRow(["Tracked since", r.tracking.since ?? ""]),
    csvRow(["Tracked visits", r.tracking.visits]),
    csvRow(["Invoice PDF downloads", r.tracking.pdf_downloads]),
    csvRow(["Visits with a PDF download", r.tracking.visits_with_pdf]),
    "",
    csvRow(["Portal section", "Visits"]),
    ...r.tracking.sections.map((x) => csvRow([x.section, x.visits])),
    ...(
      [
        ["Visitor country", r.tracking.countries],
        ["Device", r.tracking.devices],
        ["Browser", r.tracking.browsers],
      ] as const
    ).flatMap(([head, rows]) => [
      "",
      csvRow([head, "Visits"]),
      ...rows.map((x) => csvRow([x.key ?? "unknown", x.visits])),
    ]),
  ];
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="portal-report-${r.start}-${r.end}.csv"`,
    },
  });
}
