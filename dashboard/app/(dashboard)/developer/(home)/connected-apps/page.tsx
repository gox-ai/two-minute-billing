import { fmtDate, fmtDateTime } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { listConnectedApps, type ConnectedApp } from "@/lib/oauth";
import { disconnectAppAction } from "@/app/(dashboard)/oauth/actions";
import { orgTz } from "@/lib/org-tz-server";
import { RecordCard } from "@/components/patterns/record-page";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ActionButton } from "@/components/action-button";
import { CardNote, DeveloperShell } from "@/components/developer/developer-shell";
import { EmptyState, ErrorState } from "@/components/states";
import { Plug } from "lucide-react";

export const dynamic = "force-dynamic";

/** Developer → Connected apps: AI assistants connected with MCP (OAuth grants). */
export default async function DeveloperConnectedAppsPage() {
  await requirePermission("api_keys:view", "developer");
  const tz = await orgTz();
  const connectedApps: ConnectedApp[] | null = await listConnectedApps().catch(() => null);

  return (
    <DeveloperShell active="connected-apps" tz={tz}>
      <RecordCard
        id="connected-apps"
        title="Connected apps"
        meta={
          connectedApps
            ? `${connectedApps.length} ${connectedApps.length === 1 ? "app" : "apps"}`
            : undefined
        }
        flush
      >
        <CardNote>
          AI assistants that a team member connected with MCP. Each one can read one business and
          cannot change data. A disconnect stops its access immediately.
        </CardNote>
        {!connectedApps ? (
          <div className="p-5">
            <ErrorState
              title="We could not load the connected apps"
              description="Reload the page."
            />
          </div>
        ) : connectedApps.length === 0 ? (
          <EmptyState
            compact
            icon={<Plug />}
            title="No connected apps"
            description="Connect an AI assistant from the assistant itself: add this server's /mcp address and sign in."
          />
        ) : (
          <Table phone="stack">
            <TableHeader>
              <TableRow>
                <TableHead>Application</TableHead>
                <TableHead>Business</TableHead>
                <TableHead>Connected</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {connectedApps.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="text-sm">{a.client_name ?? a.client_id}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.business_name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fmtDate(a.created_at, tz)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {a.last_used_at ? fmtDateTime(a.last_used_at, tz) : "Never"}
                  </TableCell>
                  <TableCell className="text-right">
                    <ActionButton
                      resultAction={disconnectAppAction}
                      fields={{ grant: a.id }}
                      label="Disconnect"
                      size="sm"
                      confirm={{
                        title: `Disconnect ${a.client_name ?? "this application"}?`,
                        description:
                          "It can no longer read your billing data. You cannot undo this. To connect it again, start from the application.",
                        confirmLabel: "Disconnect",
                        destructive: true,
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </RecordCard>
    </DeveloperShell>
  );
}
