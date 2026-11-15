import * as React from "react";
import Link from "next/link";
import { listApiKeys, fmtDate, fmtDateTime } from "@/lib/api";
import {
  createApiKeyAction,
  revokeApiKeyAction,
  rotateApiKeyAction,
  updateApiKeyAccessAction,
} from "@/app/actions";
import { requirePermission } from "@/lib/session";
import { orgTz } from "@/lib/org-tz-server";
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
import { RotateApiKeyDialog } from "@/components/developer/rotate-api-key-dialog";
import { EditKeyAccessDialog } from "@/components/developer/key-access";
import { CreateApiKeyDialog } from "@/components/developer/create-dialogs";
import { CardNote, DeveloperShell } from "@/components/developer/developer-shell";
import { DeveloperHashRedirect } from "@/components/developer/developer-hash-redirect";
import { keyAccessEntries, keyAccessLabel, keyGrantOptions } from "@/lib/roles";
import { MoreMenu } from "@/components/patterns/more-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, ErrorState } from "@/components/states";
import { KeyRound } from "lucide-react";
import { Alert } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

/** A key past its expiry is refused by the API exactly like a revoked one. */
const isExpired = (expiresAt: string | null) =>
  expiresAt != null && new Date(expiresAt).getTime() <= Date.now();

/** Developer → API keys, the default tab. */
export default async function DeveloperApiKeysPage() {
  const me = await requirePermission("api_keys:view", "developer");
  // The organization requires 2FA and this person has none (0329): the API refuses a new key, so
  // Create is replaced by the reason. Existing keys keep working.
  const keyGate =
    me.organization_two_factor?.required && !me.organization_two_factor.satisfied
      ? me.organization_two_factor.organization.name
      : null;
  // The signed-in operator's org display zone (0216); these screens span every
  // business, so there is no business zone to prefer. Falls back to UTC when unset.
  const tz = await orgTz();
  // What this member may put on a key: the engine refuses anything wider (0391).
  const grant = keyGrantOptions(me.permissions ?? []);

  let apiKeys;
  try {
    apiKeys = await listApiKeys();
  } catch (e) {
    return (
      <DeveloperShell active="api-keys" tz={tz}>
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </DeveloperShell>
    );
  }

  return (
    <DeveloperShell
      active="api-keys"
      tz={tz}
      // Minting used to sit behind a step-up gate (audit M3.3), removed 2026-09-02 on our
      // user's instruction (docs/PROGRESS.md): a session that can reach this page can mint a key.
      actions={
        keyGate ? undefined : <CreateApiKeyDialog grant={grant} action={createApiKeyAction} />
      }
    >
      {/* Old links to this page's sections (`/developer#webhook-endpoints`) open their tab. */}
      <DeveloperHashRedirect />
      <RecordCard
        id="api-keys"
        title="API keys"
        meta={`${apiKeys.data.length} ${apiKeys.data.length === 1 ? "key" : "keys"}`}
        flush
      >
        <CardNote>
          Keys for your integrations. A request with a revoked or expired key gets 401. This
          dashboard uses a system credential, which is not in this list.
        </CardNote>
        {keyGate ? (
          <div className="border-b px-5 py-4">
            <Alert tone="warning" title="Enable 2FA to create API keys">
              {keyGate} requires two-factor authentication. Your existing keys continue to operate.{" "}
              <Link href="/account#two-factor">Enable 2FA</Link>
            </Alert>
          </div>
        ) : null}

        {apiKeys.data.length === 0 ? (
          <EmptyState
            compact
            icon={<KeyRound />}
            title="No API keys"
            description={keyGate ? undefined : "Create a key to authenticate API requests."}
          />
        ) : (
          <div>
            <Table phone="stack">
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead phone="aside">Status</TableHead>
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
                          colSpan={7}
                          className="bg-muted/50 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                        >
                          {g.label}
                        </TableCell>
                      </TableRow>
                      {rows.map((k) => {
                        const dead = !!k.revoked_at || isExpired(k.expires_at);
                        const title = k.name ?? `${k.prefix}…`;
                        const entries = keyAccessEntries(k);
                        return (
                          <TableRow key={k.id}>
                            {/* The prefix is how an operator recognises a key in a config file;
                                an unnamed key (minted before names existed) is titled by it. */}
                            <TableCell className="py-1.25">
                              <div className="text-sm font-medium">{title}</div>
                              {k.name ? (
                                <div className="font-mono text-xs text-muted-foreground">
                                  {k.prefix}…
                                </div>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {entries.length === 0 ? (
                                keyAccessLabel(k)
                              ) : (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="underline decoration-dotted underline-offset-3">
                                      {keyAccessLabel(k)}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-72">
                                    <ul className="columns-2 gap-x-4 text-xs">
                                      {entries.map((e) => (
                                        <li key={e.label} className="break-inside-avoid">
                                          {e.label}: {e.access}
                                        </li>
                                      ))}
                                    </ul>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </TableCell>
                            {/* Written at most once per 5 minutes per key, so it can lag by that much. */}
                            <TableCell className="text-sm text-muted-foreground">
                              {k.last_used_at ? fmtDateTime(k.last_used_at, tz) : "Never"}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {k.expires_at ? fmtDate(k.expires_at, tz) : "Never"}
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
                            <TableCell className="text-right">
                              {/* View requests stays on a revoked or expired key: its old
                                  requests are still in the log. The rest sit behind ⋯ so a
                                  row is one line at any width. */}
                              <div className="flex items-center justify-end gap-2">
                                <Button asChild variant="outline" size="sm">
                                  <Link href={`/developer/logs?api_key=${k.id}`}>
                                    View requests
                                  </Link>
                                </Button>
                                {dead ? null : (
                                  <MoreMenu icon label={`Actions for ${title}`}>
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
                                      className="text-destructive"
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
                                  </MoreMenu>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </React.Fragment>
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
