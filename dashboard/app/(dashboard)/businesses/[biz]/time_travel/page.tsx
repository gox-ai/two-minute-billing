import { listBusinesses } from "@/lib/api";
import { fmtDateTime } from "@/lib/format-date";
import { getTimeTravel } from "@/lib/api/time-travel";
import { PageHeader, type Crumb } from "@/components/page-header";
import { SectionCard } from "@/components/patterns/section-card";
import { Facts } from "@/components/patterns/record-page";
import { StatusChip } from "@/components/patterns/chip";
import { ErrorState } from "@/components/states";
import { StartForm, TravelForm, StopButton } from "@/components/time-travel/controls";
import { Explainer } from "@/components/time-travel/explainer";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

const TITLE = "Time travel";

/** Human "N days" delta between the simulated clock and real now. */
function deltaLabel(simulatedNow: string): string {
  const ms = new Date(simulatedNow).getTime() - Date.now();
  const days = Math.round(ms / 86_400_000);
  if (days === 0) return "about now";
  const abs = Math.abs(days);
  const unit = abs === 1 ? "day" : "days";
  return days > 0 ? `${abs} ${unit} ahead of real time` : `${abs} ${unit} behind real time`;
}

export default async function TimeTravelPage({ params }: { params: Promise<{ biz: string }> }) {
  await requirePermission("test_tools:manage", "admin");

  const { biz } = await params;
  const crumbsFor = (name?: string): Crumb[] =>
    name ? [{ label: name, href: `/businesses/${biz}` }, { label: TITLE }] : [{ label: TITLE }];

  let businesses;
  try {
    businesses = await listBusinesses();
  } catch (e) {
    return (
      <>
        <PageHeader title={TITLE} breadcrumbs={crumbsFor()} />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz);
  // Dates render in the business timezone, not UTC — the engine's term
  // boundaries are midnight in this zone (see components/business-tz).
  const tz = business?.timezone ?? null;
  if (!business) {
    return (
      <>
        <PageHeader title={TITLE} breadcrumbs={crumbsFor()} />
        <ErrorState title="Not found" description={`No business has the ID ${biz}.`} />
      </>
    );
  }
  const crumbs = crumbsFor(business.name);

  // Guard: time travel is test-only. A live business gets an explainer, not controls.
  if (business.livemode === "live") {
    return (
      <>
        <PageHeader
          title={TITLE}
          description={
            <>
              Simulated billing clock for <span className="font-medium">{business.name}</span>
            </>
          }
          breadcrumbs={crumbs}
        />
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <SectionCard layout="card" title="Not available on live businesses">
            <div className="space-y-2 text-sm text-foreground/80">
              <p className="font-medium text-foreground">
                {business.name} is a <span className="text-destructive">live</span> business.
              </p>
              <p>
                Time travel runs destructive, simulated billing. It runs only on test businesses, so
                that it never changes or deletes real customer data. Switch to a test business to
                simulate billing time.
              </p>
            </div>
          </SectionCard>
          <Explainer />
        </div>
      </>
    );
  }

  let tm;
  try {
    tm = await getTimeTravel(biz);
  } catch (e) {
    return (
      <>
        <PageHeader title={TITLE} breadcrumbs={crumbs} />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const running = tm.status === "in_progress" && tm.simulated_now != null;

  return (
    <>
      <PageHeader
        title={TITLE}
        description={
          <>
            Simulate billing time on <span className="font-medium">{business.name}</span> (test)
          </>
        }
        breadcrumbs={crumbs}
        actions={running ? <StopButton biz={biz} /> : undefined}
      />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <SectionCard
            layout="card"
            title="Clock status"
            actions={<StatusChip status={running ? "active" : "disabled"} />}
          >
            {running ? (
              <Facts
                rows={[
                  { label: "Simulated now", value: fmtDateTime(tm.simulated_now, tz) },
                  { label: "Genesis", value: fmtDateTime(tm.genesis_time, tz) },
                  { label: "Offset", value: deltaLabel(tm.simulated_now!) },
                  { label: "Real time now", value: fmtDateTime(new Date().toISOString(), tz) },
                  tm.error
                    ? {
                        label: "Error",
                        value: <span className="text-destructive">{tm.error}</span>,
                      }
                    : null,
                  tm.updated_at
                    ? { label: "Last activity", value: fmtDateTime(tm.updated_at, tz) }
                    : null,
                ]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Time travel is <span className="font-medium text-foreground">off</span>. This
                business runs on the real clock. Start it below. This sets the clock to a genesis
                date and starts to simulate billing time.
              </p>
            )}
          </SectionCard>

          {running ? (
            <SectionCard layout="card" title="Travel forward">
              <TravelForm biz={biz} simulatedNow={tm.simulated_now!} />
            </SectionCard>
          ) : (
            <SectionCard layout="card" title="Start time travel">
              <StartForm biz={biz} />
            </SectionCard>
          )}
        </div>

        <Explainer />
      </div>
    </>
  );
}
