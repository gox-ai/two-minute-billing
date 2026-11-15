import Link from "next/link";
import { listEvents, listBusinesses, fmtDateTime } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { orgTz } from "@/lib/org-tz-server";
import { RecordCard } from "@/components/patterns/record-page";
import { Button } from "@/components/ui/button";
import { DeveloperShell } from "@/components/developer/developer-shell";
import { EmptyState, ErrorState } from "@/components/states";
import { ChevronDown, Radio } from "lucide-react";
import { IdChip } from "@/components/patterns/chip";
import { eventTitle } from "@/lib/labels";

export const dynamic = "force-dynamic";

/** Developer → Events: the latest events across the organization. */
export default async function DeveloperEventsPage() {
  await requirePermission("api_keys:view", "developer");
  const tz = await orgTz();

  let events, businesses;
  try {
    [events, businesses] = await Promise.all([listEvents(50), listBusinesses()]);
  } catch (e) {
    return (
      <DeveloperShell active="events" tz={tz}>
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </DeveloperShell>
    );
  }

  return (
    <DeveloperShell active="events" tz={tz}>
      <RecordCard
        id="recent-events"
        title="Recent events"
        meta={events.data.length > 20 ? "Showing the latest 20" : undefined}
        actions={
          businesses.data[0] ? (
            <Button asChild variant="outline" size="sm">
              {/* Events now live per-business (Logs > Events) — jump to the first business. */}
              <Link href={`/businesses/${businesses.data[0].id}/events`}>Events browser →</Link>
            </Button>
          ) : null
        }
      >
        {events.data.length === 0 ? (
          <EmptyState compact icon={<Radio />} title="No events yet" />
        ) : (
          <div className="divide-y">
            {events.data.slice(0, 20).map((ev) => (
              <details className="group py-2 first:pt-0 last:pb-0" key={ev.id}>
                {/* Same disclosure as FoldedCard: custom row, chevron, no native marker. */}
                <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md text-sm focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0 flex-1 truncate font-medium" title={ev.type}>
                    {eventTitle(ev.type)}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {fmtDateTime(ev.occurred_at ?? ev.created_at, tz)}
                  </span>
                  <ChevronDown
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                  />
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  <span className="flex">
                    <IdChip id={ev.id} label="Event ID" />
                  </span>
                  <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                    {JSON.stringify(ev.data, null, 2)}
                  </pre>
                </div>
              </details>
            ))}
          </div>
        )}
      </RecordCard>
    </DeveloperShell>
  );
}
