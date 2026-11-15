import Link from "next/link";
import { listBusinesses } from "@/lib/api";
import {
  getEmailDeliveryReport,
  type EmailDeliveryReport,
  type EmailReportCounts,
} from "@/lib/api/emails";
import { emailTypeLabel } from "@/lib/email-types";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/patterns/section-card";
import { ErrorState } from "@/components/states";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { SegmentIndicator } from "@/components/ui/segment-indicator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtDate } from "@/lib/format-date";

export const dynamic = "force-dynamic";

const PERIODS = [4, 12, 26, 52] as const;

/** The columns, in the order the tables show them. `not_delivered` = the dev sink only. */
const COLUMNS: Array<{ key: keyof EmailReportCounts; label: string; status?: string }> = [
  { key: "delivered", label: "Delivered" },
  { key: "failed", label: "Failed", status: "failed" },
  { key: "bounced", label: "Bounced", status: "bounced" },
  { key: "complained", label: "Complaints" },
  { key: "skipped", label: "Skipped", status: "skipped" },
  { key: "pending", label: "Waiting", status: "pending" },
  { key: "not_delivered", label: "Not sent to a mail server" },
];

const total = (c: EmailReportCounts) => COLUMNS.reduce((n, col) => n + c[col.key], 0);

/** The type's label; a type with no label (an older one) reads as words, not as a key. */
function typeLabel(type: string): string {
  const label = emailTypeLabel(type);
  if (label !== type) return label;
  const words = type.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export default async function EmailReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ weeks?: string }>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  await requirePermission("emails:view", "ops");
  const asked = Number(search.weeks);
  const weeks = (PERIODS as readonly number[]).includes(asked) ? asked : 12;

  let businesses, report: EmailDeliveryReport;
  try {
    [businesses, report] = await Promise.all([
      listBusinesses(),
      getEmailDeliveryReport(biz, weeks),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Email delivery report" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  const emails = `/businesses/${biz}/emails`;
  // A count that has emails behind it opens the email log, narrowed to them.
  const logHref = (status: string | undefined, type?: string) => {
    const f = [
      ...(status ? [`filter=status:in:${status}`] : []),
      ...(type ? [`filter=type:in:${type}`] : []),
    ];
    return f.length ? `${emails}?${f.join("&")}` : emails;
  };
  const cell = (n: number, status: string | undefined, type?: string) =>
    n > 0 && status ? (
      <Link href={logHref(status, type)} className="figure-link">
        {n.toLocaleString("en-US")}
      </Link>
    ) : n === 0 ? (
      <span className="text-muted-foreground">0</span>
    ) : (
      n.toLocaleString("en-US")
    );
  const weeksShown = [...report.weekly].reverse();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email delivery report"
        description={`Billing emails by week and by type. Weeks start on Monday in ${report.timezone}. An email counts in the week we queued it.`}
        breadcrumbs={[
          { label: name, href: `/businesses/${biz}` },
          { label: "Emails", href: emails },
          { label: "Delivery report" },
        ]}
      />

      <nav aria-label="Period" className={SEGMENT_TRACK}>
        <SegmentIndicator />
        {PERIODS.map((p) => (
          <Link
            key={p}
            href={`${emails}/report?weeks=${p}`}
            aria-current={p === weeks ? "page" : undefined}
            className={segmentItem(p === weeks)}
          >
            {p} weeks
          </Link>
        ))}
      </nav>

      {/* Figures sit at the foot of each cell, so a label that wraps keeps them on one line. */}
      <div className="flex flex-wrap gap-px overflow-hidden rounded-xl border bg-border">
        {COLUMNS.map((col) => (
          <div
            key={col.key}
            className="flex flex-[1_1_8rem] flex-col justify-between gap-1 bg-card px-4 py-3"
          >
            <div className="text-xs text-muted-foreground">{col.label}</div>
            <div className="text-xl font-medium tabular-nums">
              {cell(report.totals[col.key], col.status)}
            </div>
          </div>
        ))}
      </div>

      <SectionCard layout="card" title="By email type" contentClassName="p-0">
        {report.by_type.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">
            We queued no billing email for this business in the last {weeks} weeks.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                {COLUMNS.map((col) => (
                  <TableHead key={col.key} className="text-right">
                    {col.label}
                  </TableHead>
                ))}
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.by_type.map((r) => (
                <TableRow key={r.type}>
                  <TableCell>
                    <Link
                      href={logHref(undefined, r.type)}
                      className="text-primary hover:underline"
                    >
                      {typeLabel(r.type)}
                    </Link>
                  </TableCell>
                  {COLUMNS.map((col) => (
                    <TableCell key={col.key} className="text-right">
                      {cell(r[col.key], col.status, r.type)}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-medium">
                    {total(r).toLocaleString("en-US")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard layout="card" title="By week" contentClassName="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Week of</TableHead>
              {COLUMNS.map((col) => (
                <TableHead key={col.key} className="text-right">
                  {col.label}
                </TableHead>
              ))}
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {weeksShown.map((w) => (
              <TableRow key={w.week_start}>
                <TableCell>{fmtDate(w.week_start, "UTC")}</TableCell>
                {COLUMNS.map((col) => (
                  <TableCell key={col.key} className="text-right">
                    {w[col.key] === 0 ? (
                      <span className="text-muted-foreground">0</span>
                    ) : (
                      w[col.key].toLocaleString("en-US")
                    )}
                  </TableCell>
                ))}
                <TableCell className="text-right font-medium">
                  {total(w).toLocaleString("en-US")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>

      <p className="text-sm text-muted-foreground">
        Complaints are emails that the recipient marked as spam. They are not in Bounced. &ldquo;Not
        sent to a mail server&rdquo; means no mail server carried the email: the installation had no
        mail transport set, or we have no record of how the email was sent. We do not track opens or
        clicks.
      </p>
    </div>
  );
}
