import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import {
  getNotificationPreferences,
  getNotificationSummary,
  type NotificationSummary,
} from "@/lib/api/notifications";
import { PageHeader } from "@/components/page-header";
import { SummaryPart, type DigestParts } from "@/components/notifications/summary-part";
import { fmtDate, fmtRange } from "@/lib/format-date";

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_]{1,64}$/;

/**
 * A daily or weekly summary: one part per business, stacked. The path names the first
 * business's summary; `?also=` names the others of the same send (one digest per business).
 */
export default async function SummaryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ also?: string }>;
}) {
  await requireUser();
  const { id } = await params;
  const { also } = await searchParams;
  if (!ID.test(id)) notFound();
  const ids = [id, ...(also ?? "").split(",").filter((x) => ID.test(x) && x !== id)].slice(0, 50);
  const [summaries, labels] = await Promise.all([
    Promise.all(ids.map((x) => getNotificationSummary(x))),
    getNotificationPreferences().then(
      (p) => Object.fromEntries(p.catalogue.map((c) => [c.kind, c.label])),
      () => ({}) as Record<string, string>,
    ),
  ]);
  const found = summaries.filter((s): s is NotificationSummary => s !== null);
  if (found.length === 0) notFound();
  const first = found[0]!;
  const parts = first.parts as DigestParts;
  const weekly = first.period === "weekly";
  // A calendar date: the same day in every zone.
  const when = weekly
    ? fmtRange(parts.start, lastDay(parts.end), first.timezone)
    : fmtDate(first.period_start, first.timezone);
  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <PageHeader
        title={weekly ? "Weekly summary" : "Daily summary"}
        description={
          weekly
            ? `The week ${when}, in each business's time zone.`
            : `For ${when}, in each business's time zone.`
        }
        breadcrumbs={[
          { label: "Notifications", href: "/notifications" },
          { label: weekly ? "Weekly summary" : "Daily summary" },
        ]}
      />
      {found.map((s) => (
        <SummaryPart key={s.id} summary={s} labels={labels} />
      ))}
    </div>
  );
}

/** The exclusive end date, as the last day of the period. */
function lastDay(end: string): string {
  const [y, m, d] = end.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
