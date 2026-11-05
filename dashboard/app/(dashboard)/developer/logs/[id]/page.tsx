import Link from "next/link";
import { listBusinesses } from "@/lib/api";
import { getRequestLog } from "@/lib/api/request-logs";
import { requirePermission, allows } from "@/lib/session";
import { orgTz } from "@/lib/org-tz-server";
import { fmtDateTime } from "@/lib/format";
import { statusTone, type RequestLogDetail } from "@/lib/request-log-types";
import { PageHeader } from "@/components/page-header";
import { ErrorState, EmptyState } from "@/components/states";
import { CopyButton } from "@/components/patterns/copy-button";
import { Chip, IdChip } from "@/components/patterns/chip";
import {
  Facts,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Zone,
} from "@/components/patterns/record-page";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { RequestLogBody } from "@/components/developer/request-log-body";
import { FileSearch } from "lucide-react";

export const dynamic = "force-dynamic";

const OUTCOME: Record<string, string> = {
  new: "First use of this key",
  replayed: "Replayed: we sent the saved response again",
  mismatch: "Refused: this key was used before with a different request",
  in_progress: "Refused: the first request with this key was still running",
  missing: "No key sent",
};

const LINK = "text-primary hover:underline";

function Mono({ value, copy = false }: { value: string; copy?: boolean }) {
  return (
    <span className="inline-flex items-start gap-1">
      <span className="font-mono text-xs wrap-anywhere">{value}</span>
      {copy ? <CopyButton value={value} className="shrink-0" /> : null}
    </span>
  );
}

/** Ids from `related`, each linked where the signed-in role can open the page. */
function IdList({
  ids,
  count,
  href,
}: {
  ids: string[];
  count: number;
  href?: (id: string) => string;
}) {
  if (count === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <span className="flex flex-col gap-1">
      {ids.map((id) =>
        href ? (
          <Link key={id} href={href(id)} className={`font-mono text-xs wrap-anywhere ${LINK}`}>
            {id}
          </Link>
        ) : (
          <span key={id} className="font-mono text-xs wrap-anywhere">
            {id}
          </span>
        ),
      )}
      {count > ids.length ? (
        <span className="text-xs text-muted-foreground">
          And {(count - ids.length).toLocaleString("en-US")} more
        </span>
      ) : null}
    </span>
  );
}

export default async function RequestLogPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requirePermission("api_logs:view", "developer");
  const [{ id }, tz] = await Promise.all([params, orgTz()]);

  let log: RequestLogDetail | null, businesses;
  try {
    [log, businesses] = await Promise.all([getRequestLog(id), listBusinesses()]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Request" />
        <ErrorState
          title="We could not load this request"
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const crumbs = [
    { label: "Developers", href: "/developer" },
    { label: "Request logs", href: "/developer/logs" },
    { label: id },
  ];

  if (!log) {
    return (
      <div className="flex flex-col gap-4">
        <RecordCrumbs items={crumbs} right={<PageRefresh />} />
        <div className="rounded-xl border bg-card px-5 py-4">
          <EmptyState
            icon={<FileSearch />}
            title="This request is not in the log"
            description="A new request can take a few seconds to show. Reload the page. We keep reads for 30 days and writes for 90 days. Requests with an incorrect key or an unknown path are not in the log."
          />
        </div>
      </div>
    );
  }

  const bizName = (b: string) => businesses.data.find((x) => x.id === b)?.name ?? b;
  const biz = log.business;
  // Each related page has its own gate; link only where this role can open it.
  const canEvents = allows(me, "events:view", "developer");
  const canAudit = allows(me, "audit_logs:view", "manager");
  const canGateway = allows(me, "gateways:view", "ops");
  const rel = log.related;
  const fullPath = log.query ? `${log.path}?${log.query}` : log.path;

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs items={crumbs} right={<PageRefresh />} />

      <RecordHeader
        title={
          <span className="font-mono text-xl">
            {log.method} {log.path}
          </span>
        }
        chips={
          <>
            <Chip tone={statusTone(log.status)} className="tabular-nums">
              {log.status ?? "No reply"}
            </Chip>
            {log.livemode ? (
              <Chip tone={log.livemode === "test" ? "tan" : "gray"}>
                {log.livemode === "test" ? "Test" : "Live"}
              </Chip>
            ) : null}
          </>
        }
        facts={[
          <IdChip key="id" label="Request ID" id={log.id} />,
          fmtDateTime(log.created_at, tz),
          log.duration_ms != null ? `${log.duration_ms} ms` : null,
        ]}
      />

      <Row span="8/4">
        <div className="flex min-w-0 flex-col gap-4">
          <RequestLogBody
            title="Request body"
            body={log.request_body}
            empty={log.kind === "read" ? "A read request has no body." : "The request had no body."}
          />
          <RequestLogBody
            title="Response body"
            body={log.response_body}
            empty="We keep the response body for writes and for failed requests only."
          />
        </div>

        <RecordCard title="Details">
          <Facts
            rows={[
              { label: "Request ID", value: <Mono value={log.id} copy /> },
              { label: "Time", value: fmtDateTime(log.created_at, tz) },
              { label: "Method", value: <Mono value={log.method} /> },
              { label: "Path", value: <Mono value={fullPath} copy /> },
              log.route ? { label: "Route", value: <Mono value={log.route} /> } : null,
              { label: "API version", value: log.api_version },
              { label: "Type", value: log.kind === "write" ? "Write" : "Read" },
              {
                label: "Status",
                value:
                  log.status != null
                    ? String(log.status)
                    : "No reply. The client closed the connection first.",
              },
              log.error_type
                ? { label: "Error type", value: <Mono value={log.error_type} /> }
                : null,
              {
                label: "Duration",
                value: log.duration_ms != null ? `${log.duration_ms} ms` : "—",
              },
              { label: "Source", value: log.source === "dashboard" ? "Dashboard" : "API" },
              log.api_key
                ? {
                    label: "API key",
                    value: (
                      <span className="flex flex-col gap-0.5">
                        <Link href={`/developer/logs?api_key=${log.api_key.id}`} className={LINK}>
                          {log.api_key.name ?? log.api_key.id}
                        </Link>
                        <span className="font-mono text-xs text-muted-foreground">
                          {log.api_key.id}
                          {log.api_key.revoked ? " · revoked" : ""}
                        </span>
                      </span>
                    ),
                  }
                : null,
              log.member ? { label: "Member", value: log.member.email } : null,
              {
                label: "Business",
                value: biz ? (
                  <Link href={`/businesses/${biz}`} className={LINK}>
                    {bizName(biz)}
                  </Link>
                ) : (
                  "—"
                ),
              },
              {
                label: "Mode",
                value: log.livemode === "test" ? "Test" : log.livemode === "live" ? "Live" : "—",
              },
              log.customer
                ? {
                    label: "Customer",
                    value:
                      biz && canAudit ? (
                        <Link
                          href={`/businesses/${biz}/customers/${log.customer}`}
                          className={`font-mono text-xs ${LINK}`}
                        >
                          {log.customer}
                        </Link>
                      ) : (
                        <Mono value={log.customer} />
                      ),
                  }
                : null,
              {
                label: "Idempotency key",
                value: log.idempotency_key ? <Mono value={log.idempotency_key} copy /> : "—",
              },
              log.idempotency_outcome
                ? {
                    label: "Idempotency result",
                    value: OUTCOME[log.idempotency_outcome] ?? log.idempotency_outcome,
                  }
                : null,
              { label: "Trace ID", value: log.trace_id ? <Mono value={log.trace_id} copy /> : "—" },
              { label: "IP address", value: log.ip ? <Mono value={log.ip} /> : "—" },
              {
                label: "User agent",
                value: log.user_agent ? <span className="text-xs">{log.user_agent}</span> : "—",
              },
            ]}
          />
        </RecordCard>
      </Row>

      <Zone title="Related">
        {log.idempotency_key ? (
          <RecordCard
            title="Same idempotency key"
            meta={`${rel.same_idempotency_key.length} ${rel.same_idempotency_key.length === 1 ? "request" : "requests"}`}
            footer={
              <span className="text-muted-foreground">
                We keep an idempotency key for 24 hours. A request that uses the key again after
                that time is a new request, so this list can show more than one first use.
              </span>
            }
          >
            <ul className="flex flex-col gap-2 text-sm">
              {rel.same_idempotency_key.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {r.current ? (
                    <span className="font-mono text-xs">{r.id}</span>
                  ) : (
                    <Link href={`/developer/logs/${r.id}`} className={`font-mono text-xs ${LINK}`}>
                      {r.id}
                    </Link>
                  )}
                  <Chip tone={statusTone(r.status)} className="tabular-nums">
                    {r.status ?? "No reply"}
                  </Chip>
                  <span className="text-muted-foreground">{fmtDateTime(r.created_at, tz)}</span>
                  {r.idempotency_outcome ? (
                    <span className="text-muted-foreground">
                      {OUTCOME[r.idempotency_outcome] ?? r.idempotency_outcome}
                    </span>
                  ) : null}
                  {r.original ? <Chip tone="blue">Original request</Chip> : null}
                  {r.current ? <Chip>This request</Chip> : null}
                </li>
              ))}
            </ul>
          </RecordCard>
        ) : null}

        <Row span="6/6">
          <RecordCard
            title="Events"
            meta={`${rel.events.count}`}
            footer={<span className="text-muted-foreground">Events that this request caused.</span>}
          >
            <IdList
              ids={rel.events.ids}
              count={rel.events.count}
              href={biz && canEvents ? (e) => `/businesses/${biz}/events/${e}` : undefined}
            />
          </RecordCard>
          <RecordCard
            title="Audit entries"
            meta={`${rel.audit_logs.count}`}
            footer={
              <span className="text-muted-foreground">Changes that this request recorded.</span>
            }
          >
            <IdList
              ids={rel.audit_logs.ids}
              count={rel.audit_logs.count}
              href={biz && canAudit ? (a) => `/businesses/${biz}/audit/${a}` : undefined}
            />
          </RecordCard>
        </Row>
        <Row span="12">
          <RecordCard
            title="Gateway calls"
            meta={`${rel.gateway_requests.count}`}
            actions={
              biz && log.trace_id && canGateway && rel.gateway_requests.count > 0 ? (
                <Link
                  href={`/businesses/${biz}/gateway_requests?trace_id=${encodeURIComponent(log.trace_id)}`}
                  className={LINK}
                >
                  View gateway calls
                </Link>
              ) : null
            }
            footer={
              <span className="text-muted-foreground">
                Calls to the payment gateway that this request made.
              </span>
            }
          >
            <IdList ids={rel.gateway_requests.ids} count={rel.gateway_requests.count} />
          </RecordCard>
        </Row>
      </Zone>
    </div>
  );
}
