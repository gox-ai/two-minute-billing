import Link from "next/link";
import { getBusiness } from "@/lib/api/business-settings";
import { getHubSpot, listHubSpotRuns, type HubSpotSyncRun } from "@/lib/api/hubspot";
import { requirePermission } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RecordCard } from "@/components/patterns/record-page";
import { SettingsPage } from "@/components/settings/settings-layout";
import { KeyValueGrid } from "@/components/patterns/key-value-grid";
import { StatusChip } from "@/components/patterns/chip";
import { SettingRow, ToggleAnswer } from "@/components/patterns/settings-page";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { HubSpotDisconnect } from "@/components/integrations/hubspot-disconnect";
import { LOGO_SIZE, PartnerLogo } from "@/components/partner-logo";
import { CustomersSection } from "@/components/integrations/hubspot/customers-section";
import { DealsSection } from "@/components/integrations/hubspot/deals-section";
import { UpdatesSection } from "@/components/integrations/hubspot/updates-section";
import { ConflictsSection } from "@/components/integrations/hubspot/conflicts-section";
import { ProductsSection } from "@/components/integrations/hubspot/products-section";
import { InvoicesSection } from "@/components/integrations/hubspot/invoices-section";
import { HubSpotAppSection } from "@/components/integrations/hubspot/hubspot-app-section";
import {
  disconnectHubSpotAction,
  saveHubSpotSettingsAction,
  startHubSpotAction,
  syncHubSpotAction,
} from "./actions";

export const dynamic = "force-dynamic";

const TRIGGER_LABEL: Record<HubSpotSyncRun["trigger"], string> = {
  event: "Change",
  autosync: "Autosync",
  manual: "Sync now",
  initial: "Initial sync",
};

function duration(r: HubSpotSyncRun): string {
  if (!r.finished_at) return "—";
  const s = Math.max(0, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warning" | "destructive";
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-4 py-3">
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div
        className={
          "mt-1 text-xl font-semibold tabular-nums " +
          (value > 0 && tone === "destructive"
            ? "text-destructive"
            : value > 0 && tone === "warning"
              ? "text-warning"
              : "")
        }
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

export default async function HubSpotSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ error?: string; connected?: string; after?: string }>;
}) {
  const { biz } = await params;
  const sp = await searchParams;
  await requirePermission("integrations:view", "admin");

  let business, hs;
  try {
    [business, hs] = await Promise.all([getBusiness(biz), getHubSpot(biz)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="HubSpot" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  if (!business)
    return <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />;
  const tz = business.timezone;

  const integrations = `/businesses/${biz}/integrations`;
  const connectHref = `/integrations/hubspot/start?biz=${encodeURIComponent(biz)}`;
  const mark = <PartnerLogo brand="hubspot" name="HubSpot" {...LOGO_SIZE.mark} fit />;
  const titled = (text: string) => (
    <span className="flex items-center gap-2">
      {mark}
      {text}
    </span>
  );
  const frame = {
    title: "HubSpot",
    description: "Keep your customers up to date in your HubSpot CRM.",
    crumbs: [
      { label: business.name, href: `/businesses/${biz}` },
      { label: "Integrations", href: integrations },
      { label: "HubSpot" },
    ],
  };
  const banners = (
    <>
      {sp.error ? <Alert tone="error">{sp.error}</Alert> : null}
      {sp.connected && hs.status === "active" ? (
        <Alert tone="success" title="HubSpot connected.">
          {hs.initial_sync === "pending"
            ? "We did not send data yet. Review the settings below. Then start the first sync."
            : "We are sending the changes since the last sync now. The sync log below shows the progress."}
        </Alert>
      ) : null}
    </>
  );

  // Test data must not reach a real CRM, so test mode cannot connect HubSpot. A test business
  // that is already connected (from before this rule) keeps its page, so it can disconnect.
  if (hs.status === "not_connected" && business.livemode === "test") {
    return (
      <SettingsPage {...frame}>
        <Alert tone="info" title="HubSpot is not available in test mode.">
          Test data must not go into your CRM. To connect HubSpot, switch to live mode.
          {business.live_business_id ? (
            <>
              {" "}
              <Link href={`/businesses/${business.live_business_id}/integrations/hubspot`}>
                Open HubSpot in live mode
              </Link>
              .
            </>
          ) : null}
        </Alert>
      </SettingsPage>
    );
  }

  if (hs.status === "not_connected") {
    return (
      <SettingsPage {...frame}>
        {banners}
        {!hs.configured ? (
          <Alert tone="info" title="HubSpot is not configured on this deployment.">
            Before a business can connect, an administrator must add the HubSpot app credentials.
          </Alert>
        ) : null}
        <div className="max-w-3xl">
          <RecordCard title={titled("Connect your HubSpot portal")}>
            <div className="space-y-4 text-sm text-foreground/80">
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Customers become contacts and companies. Subscriptions become deals. Plans become
                  products. With HubSpot Enterprise, invoices can sync to a custom object.
                </li>
                <li>
                  We match and link records that are already in HubSpot. We do not duplicate them.
                </li>
                <li>Edits in HubSpot come back here, by the rules that you select.</li>
                <li>
                  Your team can see billing on HubSpot records and create subscriptions from
                  HubSpot.
                </li>
              </ul>
              {hs.configured ? (
                <Button asChild>
                  <a href={connectHref}>Connect HubSpot</a>
                </Button>
              ) : null}
            </div>
          </RecordCard>
        </div>
      </SettingsPage>
    );
  }

  const runs = await listHubSpotRuns(biz, sp.after).catch(() => null);
  const h = hs.health;

  return (
    <SettingsPage {...frame}>
      {banners}
      {hs.status === "reauth_required" ? (
        <Alert tone="error" title="HubSpot access is revoked.">
          Nothing syncs until you reconnect the portal. We keep the changes made until then, and
          send them when you reconnect.{" "}
          <a href={connectHref} className="font-medium underline">
            Reconnect HubSpot
          </a>
        </Alert>
      ) : null}

      {hs.status === "active" && hs.initial_sync === "pending" ? (
        <RecordCard title={titled("Start the first sync")}>
          <div className="space-y-3 text-sm text-foreground/80">
            <p>
              We did not write data to HubSpot yet. In the sections below, configure how customers,
              deals and products match and sync. Then start the sync. The first sync reads all
              customers, subscriptions and plans. After the first sync, changes sync when they
              occur.
            </p>
            <p className="text-muted-foreground">
              If a different tool already syncs billing into this HubSpot portal, disable it first.
              If you do not, both tools write to the same records.
            </p>
            <ActionForm action={startHubSpotAction}>
              <input type="hidden" name="biz" value={biz} />
              <SubmitButton>Start first sync</SubmitButton>
            </ActionForm>
          </div>
        </RecordCard>
      ) : null}

      <RecordCard
        title={titled("Connection")}
        actions={
          <div className="flex items-center gap-2">
            <ActionForm action={syncHubSpotAction}>
              <input type="hidden" name="biz" value={biz} />
              <SubmitButton
                size="sm"
                disabled={hs.status !== "active" || hs.initial_sync === "pending"}
              >
                Sync now
              </SubmitButton>
            </ActionForm>
            <HubSpotDisconnect
              biz={biz}
              portal={hs.hub_domain ?? `portal ${hs.portal_id}`}
              action={disconnectHubSpotAction}
            />
          </div>
        }
      >
        <KeyValueGrid
          columns={2}
          rows={[
            { label: "Portal", value: hs.hub_domain ?? "—" },
            {
              label: "Hub ID",
              value: <span className="font-mono">{hs.portal_id}</span>,
              copy: hs.portal_id,
            },
            { label: "Status", value: <StatusChip status={hs.status} /> },
            { label: "Connected by", value: hs.installed_by ?? "—" },
            { label: "Connected", value: fmtDateTime(hs.connected_at, tz) },
            {
              label: "Initial sync",
              value:
                hs.initial_sync === "done"
                  ? "Complete"
                  : hs.initial_sync === "running"
                    ? "In progress"
                    : hs.initial_sync === "queued"
                      ? "Starting"
                      : "Not started",
            },
            {
              label: "Last synced",
              value: hs.last_sync_at ? fmtDateTime(hs.last_sync_at, tz) : "Not yet",
            },
            hs.last_error
              ? {
                  label: "Last error",
                  value: <span className="text-destructive">{hs.last_error}</span>,
                }
              : null,
          ]}
        />
      </RecordCard>

      <RecordCard title="Sync health">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Synced, last 24h" value={h.synced_24h} />
          <Stat label="Failed, last 24h" value={h.failed_24h} tone="destructive" />
          <Stat label="Waiting to sync" value={h.pending} />
          <Stat label="Retrying" value={h.retrying} tone="warning" />
        </div>
      </RecordCard>

      <ActionForm action={saveHubSpotSettingsAction}>
        <input type="hidden" name="biz" value={biz} />
        <RecordCard
          title="Preferences"
          flush
          footer={
            <div className="flex justify-end">
              <SubmitButton size="sm" variant="outline">
                Save preferences
              </SubmitButton>
            </div>
          }
        >
          <SettingRow
            question="Sync changes automatically?"
            help="When on, we send changes within a minute and do a full check every 15 minutes. When off, nothing syncs until you click Sync now."
          >
            <ToggleAnswer
              name="autosync"
              defaultChecked={hs.autosync}
              label="Sync changes automatically"
            />
          </SettingRow>
        </RecordCard>
      </ActionForm>

      {/* One section per concern, each owning its own form and server action. */}
      <ConflictsSection biz={biz} hs={hs} />
      <CustomersSection biz={biz} hs={hs} />
      <DealsSection biz={biz} hs={hs} />
      <ProductsSection biz={biz} hs={hs} />
      <InvoicesSection biz={biz} hs={hs} />
      <UpdatesSection biz={biz} hs={hs} />
      <HubSpotAppSection biz={biz} hs={hs} />

      <RecordCard
        title="Sync log"
        flush
        footer={
          runs?.has_more && runs.next_cursor ? (
            <Link
              href={`?after=${encodeURIComponent(runs.next_cursor)}`}
              className="text-primary hover:underline"
            >
              Older runs
            </Link>
          ) : undefined
        }
        actions={
          <ActionForm action={syncHubSpotAction}>
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="full" value="1" />
            <SubmitButton
              size="sm"
              variant="outline"
              disabled={hs.status !== "active" || hs.initial_sync === "pending"}
            >
              Resync everything
            </SubmitButton>
          </ActionForm>
        }
      >
        {!runs || runs.data.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            {runs
              ? "No syncs yet. The first sync starts within a minute after you connect."
              : "We could not load the sync log."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Took</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        href={`${integrations}/hubspot/runs/${r.id}`}
                        className="text-primary hover:underline"
                      >
                        {fmtDateTime(r.started_at, tz)}
                      </Link>
                    </TableCell>
                    <TableCell>{TRIGGER_LABEL[r.trigger]}</TableCell>
                    <TableCell>
                      <StatusChip status={r.status} />
                    </TableCell>
                    <TableCell className="text-right">{r.created}</TableCell>
                    <TableCell className="text-right">{r.updated}</TableCell>
                    <TableCell className={"text-right " + (r.failed > 0 ? "text-destructive" : "")}>
                      {r.failed}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {duration(r)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </RecordCard>
    </SettingsPage>
  );
}
