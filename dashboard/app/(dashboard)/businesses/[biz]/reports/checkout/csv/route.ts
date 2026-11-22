import { requirePermission } from "@/lib/session";
import { getCheckoutReport } from "@/lib/api/hosted-page-reports";
import { csvRow } from "@/lib/csv";

/**
 * The checkout report's tables as one CSV, from the same read the page renders. Money is in
 * MINOR UNITS, rates in basis points and times in seconds, as the API sends them.
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
  const r = await getCheckoutReport(biz, {
    start,
    end,
    compare: false,
    ...(qs.get("product") ? { product: qs.get("product")! } : {}),
    ...(qs.get("link") ? { paymentLink: qs.get("link")! } : {}),
    ...(qs.get("country") ? { country: qs.get("country")! } : {}),
    ...(qs.get("device") ? { device: qs.get("device")! } : {}),
  });
  const t = r.totals;
  const tk = r.tracking;
  const lines: string[] = [
    csvRow(["Checkout report", `${r.start} to ${r.end}`, `Currency: ${r.currency} (minor units)`]),
    "",
    csvRow(["Figure", "Value"]),
    ...Object.entries(t).map(([k, v]) => csvRow([k, v ?? ""])),
    "",
    csvRow(["Funnel step", "Checkouts", "Median seconds from previous step"]),
    ...r.funnel.map((s) => csvRow([s.label, s.sessions, s.median_seconds_from_previous ?? ""])),
    "",
    csvRow(["Day", "Opened", "Completed", "Revenue (minor)", "Abandoned", "Recovered"]),
    ...r.days.map((d, i) =>
      csvRow([
        d.date,
        r.series.opened[i],
        r.series.completed[i],
        r.series.revenue_minor[i],
        r.series.abandoned[i],
        r.series.recovered[i],
      ]),
    ),
    "",
    csvRow([
      "Checkout link",
      "Opened",
      "Completed",
      "Conversion (bps)",
      "Revenue (minor)",
      "Average order (minor)",
      "Median seconds to complete",
    ]),
    ...r.links.map((l) =>
      csvRow([
        l.name ?? "Checkouts made by the API",
        l.opened,
        l.completed,
        l.conversion_bps ?? "",
        l.revenue_minor,
        l.aov_minor ?? "",
        l.median_complete_seconds ?? "",
      ]),
    ),
    "",
    csvRow(["Payment method", "Gateway", "Paid", "Revenue (minor)"]),
    ...r.payment_methods.map((m) => csvRow([m.method, m.gateway ?? "", m.paid, m.revenue_minor])),
    "",
    csvRow(["Payment failure reason", "Checkouts"]),
    ...r.failures.reasons.map((x) => csvRow([x.reason, x.sessions])),
    "",
    csvRow(["Coupon code", "Checkouts", "Completed"]),
    ...r.coupons.codes.map((c) => csvRow([c.code, c.sessions, c.completed])),
    "",
    csvRow(["Billing country", "Completed"]),
    ...r.countries.map((c) => csvRow([c.country, c.completed])),
    "",
    csvRow(["Time to complete", "Completed"]),
    ...r.time_to_complete.map((b) => csvRow([b.label, b.completed])),
    // First-party visit tracking.
    "",
    csvRow(["Tracked since", tk.since ?? ""]),
    "",
    csvRow([
      "Channel",
      "Source",
      "Medium",
      "Campaign",
      "Views",
      "Completed",
      "Conversion (bps)",
      "Revenue (minor)",
    ]),
    ...tk.channels.map((c) =>
      csvRow([
        c.channel,
        c.source,
        c.medium,
        c.campaign ?? "",
        c.views,
        c.completed,
        c.conversion_bps ?? "",
        c.revenue_minor,
      ]),
    ),
    ...(
      [
        ["Visitor country", tk.countries],
        ["Device", tk.devices],
        ["Browser", tk.browsers],
      ] as const
    ).flatMap(([head, rows]) => [
      "",
      csvRow([head, "Views", "Completed", "Conversion (bps)", "Revenue (minor)"]),
      ...rows.map((x) =>
        csvRow([x.key ?? "unknown", x.views, x.completed, x.conversion_bps ?? "", x.revenue_minor]),
      ),
    ]),
    "",
    csvRow(["Checkout step", "Views", "Median milliseconds on screen"]),
    ...tk.step_time.map((x) => csvRow([x.step, x.visits, x.median_ms])),
  ];
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="checkout-report-${r.start}-${r.end}.csv"`,
    },
  });
}
