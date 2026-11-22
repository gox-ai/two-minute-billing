import Link from "next/link";
import { listWebhookEndpoints, listBusinesses, fmtDate } from "@/lib/api";
import {
  createWebhookEndpoint,
  toggleWebhookAction,
  deleteWebhookAction,
  rotateWebhookSecretAction,
} from "@/app/actions";
import { requirePermission } from "@/lib/session";
import { orgTz } from "@/lib/org-tz-server";
import { RecordCard } from "@/components/patterns/record-page";
import { StatusBadge } from "@/components/status-badge";
import { Chip } from "@/components/patterns/chip";
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
import { SecretActionButton } from "@/components/developer/secret-action";
import { CreateEndpointDialog } from "@/components/developer/create-dialogs";
import { CardNote, DeveloperShell } from "@/components/developer/developer-shell";
import { MoreMenu } from "@/components/patterns/more-menu";
import { EmptyState, ErrorState } from "@/components/states";
import { Webhook } from "lucide-react";

export const dynamic = "force-dynamic";

/** Developer → Webhooks: the organization's webhook endpoints. */
export default async function DeveloperWebhooksPage() {
  await requirePermission("api_keys:view", "developer");
  const tz = await orgTz();

  let endpoints, businesses;
  try {
    [endpoints, businesses] = await Promise.all([listWebhookEndpoints(), listBusinesses()]);
  } catch (e) {
    return (
      <DeveloperShell active="webhooks" tz={tz}>
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </DeveloperShell>
    );
  }

  return (
    <DeveloperShell
      active="webhooks"
      tz={tz}
      actions={
        <CreateEndpointDialog
          businesses={businesses.data.map((b) => ({
            id: b.id,
            name: b.name,
            livemode: b.livemode,
          }))}
          action={createWebhookEndpoint}
        />
      }
    >
      <RecordCard
        id="webhook-endpoints"
        title="Webhook endpoints"
        meta={`${endpoints.data.length} ${endpoints.data.length === 1 ? "endpoint" : "endpoints"}`}
        flush
      >
        <CardNote>
          We sign each delivery with the{" "}
          <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
            Tmbilling-Signature
          </code>{" "}
          header (HMAC-SHA256).
        </CardNote>
        {endpoints.data.length === 0 ? (
          <EmptyState
            compact
            icon={<Webhook />}
            title="No endpoints"
            description="Create an endpoint to receive signed events."
          />
        ) : (
          <div>
            <Table phone="stack">
              <TableHeader>
                <TableRow>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead phone="aside">Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.data.map((e) => {
                  const title = e.description || e.url;
                  return (
                    <TableRow key={e.id}>
                      {/* The URL is the fact an operator matches against their config; the
                          name sits over it when one was given. */}
                      <TableCell className="max-w-96 py-1.25">
                        <div className="truncate text-sm font-medium">{title}</div>
                        {e.description ? (
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {e.url}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {e.business
                          ? (businesses.data.find((b) => b.id === e.business)?.name ?? e.business)
                          : "All businesses"}
                      </TableCell>
                      {/* A live business and its test mode share a name; this tells them apart. */}
                      <TableCell>
                        <Chip tone={e.livemode === "test" ? "tan" : "gray"}>
                          {e.livemode === "test" ? "Test" : "Live"}
                        </Chip>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={e.enabled ? "enabled" : "disabled"} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {fmtDate(e.created_at, tz)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button asChild variant="outline" size="sm">
                            <Link href={`/developer/webhooks/${e.id}`}>Deliveries</Link>
                          </Button>
                          <MoreMenu icon label={`Actions for ${title}`}>
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
                                          this endpoint while it is disabled. When you enable it
                                          again, it does not replay the missed events.
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
                                    receiver rejects every event until you deploy the new secret.
                                    The new secret shows only one time, immediately after the
                                    rotation.
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
                              className="text-destructive"
                              confirm={{
                                title: "Delete this endpoint?",
                                description: (
                                  <>
                                    We delete <span className="font-mono">{e.url}</span> and its
                                    delivery history. You cannot undo this. To pause deliveries and
                                    keep the history, disable the endpoint.
                                  </>
                                ),
                                confirmLabel: "Delete endpoint",
                                destructive: true,
                              }}
                            />
                          </MoreMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </RecordCard>
    </DeveloperShell>
  );
}
