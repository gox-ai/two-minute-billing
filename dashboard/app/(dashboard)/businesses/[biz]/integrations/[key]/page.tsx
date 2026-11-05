import Link from "next/link";
import { getBusiness } from "@/lib/api/business-settings";
import {
  getIntegration,
  listIntegrationCatalogue,
  listIntegrationDeliveries,
  type Integration,
  type IntegrationDelivery,
} from "@/lib/api/integrations";
import { requirePermission } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";
import { LIMITS } from "@/lib/limits";
import { ErrorState, EmptyState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { RecordCard } from "@/components/patterns/record-page";
import { SettingsPage } from "@/components/settings/settings-layout";
import { KeyValueGrid } from "@/components/patterns/key-value-grid";
import { Chip, StatusChip } from "@/components/patterns/chip";
import { DeliveryStatusChip } from "@/components/webhooks/delivery-status-chip";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { CreateDialog } from "@/components/create-dialog";
import { LOGO_SIZE, PartnerLogo } from "@/components/partner-logo";
import {
  IntegrationDisconnect,
  IntegrationResendButton,
} from "@/components/integrations/integration-controls";
import { IntegrationEnabledSwitch } from "@/components/integrations/integration-enabled-switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  changeIntegrationCredentialsAction,
  connectIntegrationAction,
  disconnectIntegrationAction,
  redeliverFailedIntegrationAction,
  redeliverIntegrationAction,
  saveIntegrationSettingsAction,
  setIntegrationEnabledAction,
} from "./actions";

export const dynamic = "force-dynamic";

/** One push integration, rendered only from its catalogue entry: no per-partner code here. */
export default async function IntegrationPage({
  params,
}: {
  params: Promise<{ biz: string; key: string }>;
}) {
  const { biz, key } = await params;
  await requirePermission("integrations:view", "admin");

  let business, catalogue;
  try {
    [business, catalogue] = await Promise.all([getBusiness(biz), listIntegrationCatalogue()]);
  } catch (e) {
    return (
      <ErrorState
        title="We could not load the integration"
        description={<span className="font-mono text-xs">{(e as Error).message}</span>}
      />
    );
  }
  if (!business)
    return <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />;
  // HubSpot has its own page (a static route); any other sync integration has none.
  const info = catalogue.data.find((i) => i.key === key && i.kind === "push");
  if (!info)
    return (
      <ErrorState title="Not found" description={`We could not find the integration ${key}.`} />
    );

  let conn, deliveries: IntegrationDelivery[] | null;
  try {
    [conn, deliveries] = await Promise.all([
      getIntegration(biz, key),
      // Non-fatal: the page still works when the log does not load.
      listIntegrationDeliveries(biz, key)
        .then((r) => r.data)
        .catch(() => null),
    ]);
  } catch (e) {
    return (
      <ErrorState
        title="We could not load the integration"
        description={<span className="font-mono text-xs">{(e as Error).message}</span>}
      />
    );
  }

  const tz = business.timezone;
  const hidden = (
    <>
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="key" value={key} />
    </>
  );
  const frame = {
    title: info.label,
    description: info.blurb,
    crumbs: [
      { label: business.name, href: `/businesses/${biz}` },
      { label: "Integrations", href: `/businesses/${biz}/integrations` },
      { label: info.label },
    ],
  };

  if (conn.status === "not_connected") {
    return (
      <SettingsPage {...frame}>
        <div className="flex max-w-3xl flex-col gap-5">
          {info.prerequisite ? (
            <Alert tone="warning" title={info.prerequisite.title}>
              {info.prerequisite.body}
            </Alert>
          ) : null}
          <RecordCard
            title={
              <span className="flex items-center gap-2">
                <PartnerLogo brand={info.key} name={info.label} {...LOGO_SIZE.mark} fit />
                Connect {info.label}
              </span>
            }
          >
            <ActionForm action={connectIntegrationAction} className="space-y-4">
              {hidden}
              <input type="hidden" name="label" value={info.label} />
              <CredentialFields info={info} />
              <ConfigFields info={info} />
              <EventsLine info={info} />
              <div className="flex justify-end">
                <SubmitButton>Connect</SubmitButton>
              </div>
            </ActionForm>
          </RecordCard>
        </div>
        {/* History survives a disconnect. Read-only: there are no credentials to resend with. */}
        {deliveries?.length ? (
          <DeliveryLog biz={biz} info={info} deliveries={deliveries} tz={tz} readOnly />
        ) : null}
      </SettingsPage>
    );
  }

  const { stats } = conn;
  return (
    <SettingsPage {...frame}>
      <RecordCard
        title={
          <span className="flex items-center gap-2">
            <PartnerLogo brand={info.key} name={info.label} {...LOGO_SIZE.mark} fit />
            Connection
          </span>
        }
        actions={
          <>
            <IntegrationEnabledSwitch
              biz={biz}
              integrationKey={key}
              label={info.label}
              enabled={conn.enabled}
              action={setIntegrationEnabledAction}
            />
            <CreateDialog
              triggerLabel="Change credentials"
              triggerVariant="outline"
              triggerSize="sm"
              title="Change the credentials"
              description="Enter all the credentials. They replace the stored set. They apply from the next delivery, also to deliveries that wait to retry."
            >
              <ActionForm action={changeIntegrationCredentialsAction} className="space-y-4">
                {hidden}
                <CredentialFields info={info} />
                <div className="flex justify-end">
                  <SubmitButton>Save</SubmitButton>
                </div>
              </ActionForm>
            </CreateDialog>
            <IntegrationDisconnect
              biz={biz}
              integrationKey={key}
              label={info.label}
              action={disconnectIntegrationAction}
            />
          </>
        }
      >
        <KeyValueGrid
          columns={2}
          rows={[
            { label: "Status", value: <StatusChip status={conn.status} /> },
            { label: "Mode", value: conn.livemode === "live" ? "Live" : "Test" },
            { label: "Connected", value: fmtDateTime(conn.connected_at, tz) },
            { label: "Last changed", value: fmtDateTime(conn.updated_at, tz) },
            { label: "Delivered, last 24 hours", value: stats.delivered_24h.toLocaleString() },
            {
              label: "Failed",
              value: (
                <span className={stats.failed > 0 ? "text-destructive" : undefined}>
                  {stats.failed.toLocaleString()}
                </span>
              ),
            },
            { label: "Waiting to send", value: stats.pending.toLocaleString() },
            {
              label: "Events",
              value: (
                <span className="flex flex-wrap gap-1">
                  {info.event_types.map((t) => (
                    <Chip key={t} className="font-mono">
                      {t}
                    </Chip>
                  ))}
                </span>
              ),
            },
          ]}
        />
      </RecordCard>

      {info.fields.length ? (
        <ActionForm action={saveIntegrationSettingsAction}>
          {hidden}
          <RecordCard
            title="Settings"
            footer={
              <div className="flex justify-end">
                <SubmitButton size="sm" variant="outline">
                  Save settings
                </SubmitButton>
              </div>
            }
          >
            <div className="max-w-xl space-y-4">
              <ConfigFields info={info} values={conn.config} />
            </div>
          </RecordCard>
        </ActionForm>
      ) : null}

      <DeliveryLog biz={biz} info={info} deliveries={deliveries} tz={tz} failed={stats.failed} />
    </SettingsPage>
  );
}

/** One input per declared credential. `secret: false` is an id the partner prints openly. */
function CredentialFields({ info }: { info: Integration }) {
  return (
    <>
      {info.credentials.map((c) => (
        <Field key={c.key} name={`cred_${c.key}`} label={c.label} help={c.hint} required>
          <Input
            name={`cred_${c.key}`}
            type={c.secret ? "password" : "text"}
            required
            autoComplete={c.secret ? "new-password" : "off"}
            maxLength={LIMITS.name}
          />
        </Field>
      ))}
    </>
  );
}

/** The integration's own settings. Blank uses the default shown as the placeholder. */
function ConfigFields({ info, values }: { info: Integration; values?: Record<string, string> }) {
  return (
    <>
      {info.fields.map((f) => (
        <Field key={f.key} name={`cfg_${f.key}`} label={f.label} help={f.help}>
          <Input
            name={`cfg_${f.key}`}
            type="text"
            defaultValue={values?.[f.key] ?? ""}
            placeholder={f.placeholder}
            maxLength={LIMITS.code}
          />
        </Field>
      ))}
    </>
  );
}

function EventsLine({ info }: { info: Integration }) {
  if (!info.event_types.length) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">Events that we send</p>
      <div className="flex flex-wrap gap-1">
        {info.event_types.map((t) => (
          <Chip key={t} className="font-mono">
            {t}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function DeliveryLog({
  biz,
  info,
  deliveries,
  tz,
  failed = 0,
  readOnly = false,
}: {
  biz: string;
  info: Integration;
  deliveries: IntegrationDelivery[] | null;
  tz?: string | null;
  failed?: number;
  readOnly?: boolean;
}) {
  // The API refuses a resend while a delivery of the same event waits to send.
  const waiting = new Set(
    (deliveries ?? []).filter((d) => d.status === "pending").map((d) => d.event),
  );
  return (
    <RecordCard
      id="deliveries"
      title="Delivery log"
      meta={deliveries ? "Newest 100" : undefined}
      flush
      actions={
        readOnly ? undefined : (
          <ActionForm action={redeliverFailedIntegrationAction}>
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="key" value={info.key} />
            <SubmitButton size="sm" variant="outline" disabled={failed === 0}>
              Resend failed
            </SubmitButton>
          </ActionForm>
        )
      }
      footer={
        readOnly ? (
          <span className="text-muted-foreground">
            This history is from an earlier connection. To resend a delivery, connect again.
          </span>
        ) : undefined
      }
    >
      {!deliveries ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">
          We could not load the delivery log. Reload the page.
        </p>
      ) : deliveries.length === 0 ? (
        <EmptyState
          title="No deliveries yet"
          description={`Deliveries show here after the system sends events to ${info.label}.`}
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Event</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Last response</TableHead>
                <TableHead>Time</TableHead>
                {readOnly ? null : <TableHead className="pr-5" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="pl-5 font-mono text-xs">
                    <Link
                      href={`/businesses/${biz}/events/${d.event}`}
                      className="text-primary hover:underline"
                    >
                      {d.event}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Chip className="font-mono">{d.event_type}</Chip>
                  </TableCell>
                  <TableCell>
                    <DeliveryStatusChip status={d.status} />
                  </TableCell>
                  <TableCell className="text-right">{d.attempts}</TableCell>
                  <TableCell>
                    {d.last_response_status ?? "—"}
                    {d.last_error ? (
                      <span
                        className="block max-w-64 truncate font-mono text-xs text-muted-foreground"
                        title={d.last_error}
                      >
                        {d.last_error}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fmtDateTime(d.last_attempt_at ?? d.created_at, tz)}
                    {d.status === "pending" && d.next_attempt_at ? (
                      <span className="block text-xs">
                        Next try {fmtDateTime(d.next_attempt_at, tz)}
                      </span>
                    ) : null}
                  </TableCell>
                  {readOnly ? null : (
                    <TableCell className="pr-5">
                      <IntegrationResendButton
                        biz={biz}
                        integrationKey={info.key}
                        label={info.label}
                        deliveryId={d.id}
                        queued={waiting.has(d.event)}
                        action={redeliverIntegrationAction}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </RecordCard>
  );
}
