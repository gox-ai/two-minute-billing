import * as React from "react";
import Link from "next/link";
import {
  listWebhookEndpoints,
  listEvents,
  listApiKeys,
  listBusinesses,
  PUBLIC_API_URL,
  publicApiReachable,
  fmtDate,
  fmtDateTime,
} from "@/lib/api";
import {
  createWebhookEndpoint,
  createApiKeyAction,
  revokeApiKeyAction,
  rotateApiKeyAction,
  updateApiKeyAccessAction,
  toggleWebhookAction,
  deleteWebhookAction,
  rotateWebhookSecretAction,
} from "@/app/actions";
import { requirePermission } from "@/lib/session";
import { orgTz } from "@/lib/org-tz-server";
import { SettingsPage } from "@/components/settings/settings-layout";
import { RecordCard } from "@/components/patterns/record-page";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/action-button";
import { SecretActionForm, SecretActionButton } from "@/components/developer/secret-action";
import { RotateApiKeyDialog } from "@/components/developer/rotate-api-key-dialog";
import { EditKeyAccessDialog, KeyAccessFields } from "@/components/developer/key-access";
import { keyAccessSummary, keyGrantOptions } from "@/lib/roles";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/states";
import { KeyRound, Webhook, Radio } from "lucide-react";
import { SelectField } from "@/components/ui/select-field";
import { Alert } from "@/components/ui/alert";
import { LIMITS } from "@/lib/limits";

export const dynamic = "force-dynamic";

/** A key past its expiry is refused by the API exactly like a revoked one. */
const isExpired = (expiresAt: string | null) =>
  expiresAt != null && new Date(expiresAt).getTime() <= Date.now();

// Developer view (org-wide): API keys, webhooks + delivery log, event stream, API reference.
export default async function DeveloperPage() {
  const me = await requirePermission("api_keys:view", "developer");
  // The organization requires 2FA and this person has none (0329): the API refuses a new key, so
  // the form is replaced by the reason. Existing keys keep working.
  const keyGate =
    me.organization_two_factor?.required && !me.organization_two_factor.satisfied
      ? me.organization_two_factor.organization.name
      : null;
  // The signed-in operator's org display zone (0216); these screens span every
  // business, so there is no business zone to prefer. Falls back to UTC when unset.
  const tz = await orgTz();
  // What this member may put on a key: the engine refuses anything wider (0391).
  const grant = keyGrantOptions(me.permissions ?? []);

  let endpoints, events, apiKeys, businesses;
  try {
    [endpoints, events, apiKeys, businesses] = await Promise.all([
      listWebhookEndpoints(),
      listEvents(50),
      listApiKeys(),
      listBusinesses(),
    ]);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }

  return (
    <SettingsPage
      title="Developer"
      crumbs={[{ label: "Settings", href: "/settings" }, { label: "Developer" }]}
      description="Integration surface for this organization."
      // Names the zone the dates below are printed in — it follows the organization
      // setting now, so leaving it unstated would make every date here ambiguous.
      actions={<span className="text-xs text-muted-foreground">Dates in {tz}</span>}
    >
      {/* These two are the only BROWSER-facing URLs on this page, so they are built from
          PUBLIC_API_URL, never from API_URL — the latter is the server-to-server address
          (production: a loopback port on this box) and linking it hands the reader a URL
          only the server can open. When the deployment has not set the public URL we
          render the paths as TEXT rather than a link that cannot work: a control that
          lies is worse than a missing one (CLAUDE.md). */}
      <Alert tone="info">
        <span className="flex flex-wrap items-center gap-3">
          <span>API reference:</span>
          {publicApiReachable ? (
            <>
              <a
                href={`${PUBLIC_API_URL}/docs`}
                target="_blank"
                rel="noreferrer"
                className="font-medium hover:underline"
              >
                /docs
              </a>
              <a
                href={`${PUBLIC_API_URL}/openapi.json`}
                target="_blank"
                rel="noreferrer"
                className="font-medium hover:underline"
              >
                openapi.json
              </a>
            </>
          ) : (
            <>
              <span className="font-mono text-xs">/docs</span>
              <span className="font-mono text-xs">/openapi.json</span>
              <span className="text-sm text-muted-foreground">
                (set{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  TMBILLING_PUBLIC_API_URL
                </code>{" "}
                to link these)
              </span>
            </>
          )}
          <span className="text-sm text-muted-foreground">
            · typed SDK in{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">sdk/</code>{" "}
            (generated from the spec)
          </span>
        </span>
      </Alert>

      <RecordCard
        id="api-keys"
        title="API keys"
        meta={`${apiKeys.data.length} ${apiKeys.data.length === 1 ? "key" : "keys"}`}
        flush
        footer={
          <span className="text-muted-foreground">
            The full secret shows one time, when you create or rotate the key. A revoke has an
            immediate effect. In-flight requests with a revoked or expired key get 401. A rotation
            keeps the old key in operation for the time you select. These are your integration keys.
            This dashboard uses a system credential, which is not in this list.
          </span>
        }
      >
        {/* Minting used to sit behind a step-up gate (audit M3.3). REMOVED 2026-09-02 on our
                user's instruction — see docs/PROGRESS.md. Nothing re-authenticates here now: a
                session that can reach this page can mint a key. */}
        {keyGate ? (
          <div className="border-b px-5 py-4">
            <Alert tone="warning" title="Enable 2FA to create API keys">
              {keyGate} requires two-factor authentication. Your existing keys continue to operate.{" "}
              <Link href="/account#two-factor">Enable 2FA</Link>
            </Alert>
          </div>
        ) : (
          <SecretActionForm
            action={createApiKeyAction}
            className="flex flex-wrap items-center gap-2 border-b px-5 py-4"
          >
            {/* Optional, and says so: an unnamed key is legal and the column renders an
                  em dash for it. First in the row because it is the only field the operator
                  types — both selects already carry the default the server would apply. */}
            <Input
              name="name"
              maxLength={LIMITS.name}
              placeholder="What is this key for? (optional)"
              aria-label="Key name"
              className="w-72"
            />
            <SelectField
              name="livemode"
              defaultValue="test"
              ariaLabel="Key mode"
              className="w-44"
              options={[
                { value: "test", label: "test" },
                { value: "live", label: "live" },
              ]}
            />
            {/* Expiry (0374). "Never" is what the API applies when none is sent. */}
            <SelectField
              name="expires_in_days"
              defaultValue="never"
              ariaLabel="Key expiry"
              className="w-48"
              options={[
                { value: "never", label: "Never expires" },
                { value: "30", label: "Expires in 30 days" },
                { value: "90", label: "Expires in 90 days" },
                { value: "365", label: "Expires in 1 year" },
              ]}
            />
            {/* Access (0391): full, read only, or per resource. Options above the member's own
                rights are disabled; full is preselected when the member may grant it. */}
            <KeyAccessFields grant={grant} />
            <Button type="submit">Create API key</Button>
          </SecretActionForm>
        )}

        {apiKeys.data.length === 0 ? (
          <EmptyState
            icon={<KeyRound />}
            title="No API keys"
            description="Create a key to authenticate API requests."
          />
        ) : (
          <div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Keys are partitioned: a live key reaches only live businesses, a test key
                    only test modes. Grouped so which one an integration needs is obvious. */}
                {(
                  [
                    { mode: "live", label: "Live keys" },
                    { mode: "test", label: "Test keys" },
                  ] as const
                ).map((g) => {
                  const rows = apiKeys.data.filter((k) => k.livemode === g.mode);
                  return rows.length === 0 ? null : (
                    <React.Fragment key={g.mode}>
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={9}
                          className="bg-muted/50 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                        >
                          {g.label}
                        </TableCell>
                      </TableRow>
                      {rows.map((k) => (
                        <TableRow key={k.id}>
                          {/* Em dash for a key minted before names existed, or one created
                                      without a name — both are legitimately unnamed. */}
                          <TableCell className="text-sm">
                            {k.name ?? <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {k.id}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {k.prefix}…
                          </TableCell>
                          <TableCell className="max-w-72 text-sm text-muted-foreground">
                            {keyAccessSummary(k)}
                          </TableCell>
                          {/* Written at most once per 5 minutes per key, so it can lag by that much. */}
                          <TableCell className="text-sm text-muted-foreground">
                            {k.last_used_at ? fmtDateTime(k.last_used_at, tz) : "Never"}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {k.expires_at ? fmtDateTime(k.expires_at, tz) : "Never"}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {fmtDate(k.created_at, tz)}
                          </TableCell>
                          <TableCell>
                            <StatusBadge
                              status={
                                k.revoked_at
                                  ? "canceled"
                                  : isExpired(k.expires_at)
                                    ? "expired"
                                    : "active"
                              }
                            />
                          </TableCell>
                          <TableCell>
                            {/* View requests stays on a revoked or expired key: its old
                                requests are still in the log. */}
                            <div className="flex items-center gap-2">
                              <Button asChild variant="outline" size="sm">
                                <Link href={`/developer/logs?api_key=${k.id}`}>View requests</Link>
                              </Button>
                              {k.revoked_at || isExpired(k.expires_at) ? null : (
                                <>
                                  <EditKeyAccessDialog
                                    keyId={k.id}
                                    prefix={k.prefix}
                                    scope={k.scope}
                                    permissions={k.permissions ?? null}
                                    grant={grant}
                                    action={updateApiKeyAccessAction}
                                  />
                                  <RotateApiKeyDialog
                                    keyId={k.id}
                                    prefix={k.prefix}
                                    action={rotateApiKeyAction}
                                  />
                                  <ActionButton
                                    resultAction={revokeApiKeyAction}
                                    fields={{ id: k.id }}
                                    label="Revoke"
                                    size="sm"
                                    confirm={{
                                      title: "Revoke this API key?",
                                      description: (
                                        <>
                                          <span className="font-mono">{k.prefix}…</span> stops
                                          working immediately. You cannot restore it. Each
                                          integration that still signs requests with it will get
                                          401. If a live integration uses this key, create a
                                          replacement key first.
                                        </>
                                      ),
                                      confirmLabel: "Revoke key",
                                      destructive: true,
                                    }}
                                  />
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </RecordCard>

      <RecordCard
        id="request-logs"
        title="Request logs"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/developer/logs">View request logs</Link>
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">
          Each request that your API keys make, and each change made in this dashboard: the status,
          the duration and the request and response bodies. Secrets are hidden. We keep reads for 30
          days and writes for 90 days.
        </p>
      </RecordCard>

      <RecordCard
        id="webhook-endpoints"
        title="Webhook endpoints"
        meta={`${endpoints.data.length} ${endpoints.data.length === 1 ? "endpoint" : "endpoints"}`}
        flush
        footer={
          <span className="text-muted-foreground">
            We sign deliveries with{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              Tmbilling-Signature
            </code>{" "}
            (HMAC-SHA256). The signing secret shows one time, when you create or rotate it.
          </span>
        }
      >
        <SecretActionForm
          action={createWebhookEndpoint}
          className="flex flex-wrap items-center gap-2 border-b px-5 py-4"
        >
          <Input
            name="url"
            type="url"
            placeholder="https://your-app.com/webhooks/tmbilling"
            required
            className="min-w-[340px]"
          />
          {/*
                The name. Optional, and asked for HERE because it was previously only editable
                after the fact on the endpoint detail page — so every endpoint was born nameless
                and the event screen headed its delivery cards with a `whe_…` id. Posts to
                `description`, the real column, which the API already accepted.
              */}
          <Input
            name="description"
            type="text"
            placeholder="Name (e.g. Analytics sync)"
            aria-label="Endpoint name"
            className="min-w-56"
          />
          <SelectField
            name="business"
            ariaLabel="Business scope"
            className="max-w-56"
            options={[
              { value: "", label: "All businesses" },
              ...businesses.data.map((b) => ({ value: b.id, label: `${b.name} only` })),
            ]}
          />
          {/*
                Mode. Added 2026-09-19 after the browser proved this form could not create an
                all-businesses endpoint AT ALL: the API requires an explicit `livemode` when the
                caller holds a full-access credential, which is what this dashboard is, so every
                such submit came back "livemode is required for an org-wide endpoint created with
                a full-access key". Scoped to one business it is derived, and sending a
                contradicting value is itself a 400 — so the action forwards it only when the
                scope is "All businesses".
              */}
          <SelectField
            name="livemode"
            ariaLabel="Test or live"
            className="max-w-32"
            defaultValue="test"
            options={[
              { value: "test", label: "Test" },
              { value: "live", label: "Live" },
            ]}
          />
          <Button type="submit">Create endpoint</Button>
        </SecretActionForm>

        {endpoints.data.length === 0 ? (
          <EmptyState
            icon={<Webhook />}
            title="No endpoints"
            description="Create an endpoint to receive signed events."
          />
        ) : (
          <div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.data.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-sm">
                      {e.description || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {e.id}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {e.url}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {e.business
                        ? (businesses.data.find((b) => b.id === e.business)?.name ?? e.business)
                        : "All businesses"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={e.enabled ? "enabled" : "disabled"} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {fmtDate(e.created_at, tz)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/developer/webhooks/${e.id}`}>Deliveries</Link>
                        </Button>
                        {/* Enable is the benign direction — it restores normal delivery —
                                so only Disable is gated. Rotate and Delete always are. */}
                        <ActionButton
                          resultAction={toggleWebhookAction}
                          fields={{ id: e.id, enabled: (!e.enabled).toString() }}
                          label={e.enabled ? "Disable" : "Enable"}
                          size="sm"
                          confirm={
                            e.enabled
                              ? {
                                  title: "Disable this endpoint?",
                                  description: (
                                    <>
                                      tmbilling stops delivering events to{" "}
                                      <span className="font-mono">{e.url}</span>. The system
                                      continues to record events, but it does not queue them for
                                      this endpoint while it is disabled. When you enable it again,
                                      it does not replay the missed events.
                                    </>
                                  ),
                                  confirmLabel: "Disable endpoint",
                                  destructive: true,
                                }
                              : undefined
                          }
                        />
                        <SecretActionButton
                          action={rotateWebhookSecretAction}
                          fields={{ id: e.id }}
                          label="Rotate secret"
                          size="sm"
                          confirm={{
                            title: "Rotate the signing secret?",
                            description: (
                              <>
                                The current secret stops signing deliveries to{" "}
                                <span className="font-mono">{e.url}</span> immediately. Your
                                receiver rejects every event until you deploy the new secret. The
                                new secret shows only one time, immediately after the rotation.
                              </>
                            ),
                            confirmLabel: "Rotate secret",
                            destructive: true,
                          }}
                        />
                        <ActionButton
                          resultAction={deleteWebhookAction}
                          fields={{ id: e.id }}
                          label="Delete"
                          size="sm"
                          confirm={{
                            title: "Delete this endpoint?",
                            description: (
                              <>
                                We delete <span className="font-mono">{e.url}</span> and its
                                delivery history. You cannot undo this. To pause deliveries and keep
                                the history, disable the endpoint.
                              </>
                            ),
                            confirmLabel: "Delete endpoint",
                            destructive: true,
                          }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </RecordCard>

      <RecordCard
        id="recent-events"
        title="Recent events"
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
          <EmptyState icon={<Radio />} title="No events yet" />
        ) : (
          <div className="divide-y">
            {events.data.map((ev) => (
              <details className="py-2 first:pt-0 last:pb-0" key={ev.id}>
                <summary className="cursor-pointer text-sm font-medium">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {ev.type}
                  </code>{" "}
                  <span className="font-mono text-xs text-muted-foreground">{ev.id}</span>{" "}
                  <span className="text-sm text-muted-foreground">
                    {fmtDateTime(ev.created_at, tz)}
                  </span>
                </summary>
                <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">
                  {JSON.stringify(ev.data, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        )}
      </RecordCard>
    </SettingsPage>
  );
}
