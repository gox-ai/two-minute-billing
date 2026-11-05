import Link from "next/link";
import { listEventsForBusiness } from "@/lib/api/developer";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime } from "@/lib/api";
import {
  listAuditLogsForCustomer,
  listAuditLogsForResource,
  type AuditRow,
} from "@/components/audit/api";
import { EVENT_TYPE_FOR_ACTION, actionHeadline, actorLabel } from "@/components/audit/labels";
import { cn } from "@/lib/utils";
import { Paged, PagedFooter, PagedItems } from "@/components/patterns/pager";

/** Per stream; the card pages through the merged result. */
const ACTIVITY_LIMIT = 200;

/**
 * "Activity Log" — the history of one record, merged from the two streams that
 * record it (P4).
 *
 *  - EVENTS are the backbone: `emitEvent` derives a per-resource id for every
 *    domain event, so an invoice's whole life is one query — including the changes
 *    nobody chose (a renewal, a clock-driven retry), which have no actor at all.
 *  - AUDIT rows add the operator side: actor, source, the origin IP and a
 *    field-by-field before/after diff. Some ops are audited and NOT evented on
 *    purpose (`invoice.update` — a PO-number edit no webhook subscriber can act
 *    on), and before this merge those actions were invisible on the record.
 *
 * One act writes to both streams, so pairing collapses them into a single row.
 *
 * PAIRING IS ON `trace_id` (0149), not on a time window. Both rows are written in
 * the same execution, so they carry the same trace — an exact join. It used to match
 * the mapped event type within ±60s, which the code called best-effort and which
 * genuinely mispaired: two collection attempts on one invoice inside a minute (a
 * retry, or a dunning run) gave two audit rows and two events, and nothing said
 * which belonged to which. `EVENT_TYPE_FOR_ACTION` is still consulted, but only to
 * pick the right event when ONE trace emitted several — a cancel writes
 * `subscription_canceled` and `invoice_voided` under one trace, and the audit row
 * for `subscription.cancel` must not swallow the invoice's event.
 *
 * Rows carry the SOURCE as a badge and the change as a sentence naming the resource
 * ("Subscription activated." · via API). The "Details" link carries
 * `?source=<resource_type>` so the record page leads with the resource you came from.
 */
/** Audit rows and events written before 0148/0149 have no trace to pair on. */
const PAIR_WINDOW_MS = 60_000;

interface LogRow {
  key: string;
  at: string;
  /** The resource the sentence names, and what happened to it. */
  noun: string;
  verb: string;
  actor: string | null;
  source: string | null;
  ip: string | null;
  /** Where "Details" goes — the audit record when we have a diff to show. */
  href: string;
  /** The other record, when the act is in both streams. */
  altHref?: string;
  altLabel?: string;
  /**
   * The record this row is about, when the log spans more than one — a customer's
   * log carries its invoices and subscriptions, and "Invoice payment due." without
   * an id cannot say WHICH invoice.
   */
  ref?: string | null;
}

export async function ActivityLogCard({
  biz,
  resourceType,
  resourceId,
  tz,
  scope = "resource",
  layout = "section",
  previewRows,
}: {
  biz: string;
  resourceType: string;
  resourceId: string;
  tz: string | null;
  /**
   * 'resource' — only what was written against this record.
   * 'customer'  — the customer's whole footprint: its subscriptions, invoices,
   *   credit notes and payments too.
   *   Only legal with resourceType 'customer'; both streams are scoped the same
   *   way, so an act still pairs into one row.
   */
  scope?: "resource" | "customer";
  layout?: "section" | "card";
  /** Rows per page (default 10). */
  previewRows?: number;
}) {
  const byCustomer = scope === "customer";
  let page;
  try {
    page = byCustomer
      ? await listEventsForBusiness(biz, { customer: resourceId, limit: ACTIVITY_LIMIT })
      : await listEventsForBusiness(biz, {
          resource_type: resourceType,
          resource_id: resourceId,
          limit: ACTIVITY_LIMIT,
        });
  } catch {
    return null;
  }

  // The audit read is independent: a failure (or a key without audit access) must
  // degrade to the event-only log this card shipped before, never blank the card.
  let audits: AuditRow[] = [];
  let auditsMore = false;
  try {
    const a = byCustomer
      ? await listAuditLogsForCustomer(biz, resourceId, { limit: ACTIVITY_LIMIT })
      : await listAuditLogsForResource(biz, resourceType, resourceId, { limit: ACTIVITY_LIMIT });
    audits = a.data;
    auditsMore = a.has_more;
  } catch {
    audits = [];
  }

  const events = page.data;
  const auditForEvent = new Map<string, AuditRow>();
  const unpaired: AuditRow[] = [];
  const claimed = new Set<string>();
  for (const a of audits) {
    const type = EVENT_TYPE_FOR_ACTION[a.action];
    // Exact join when both sides carry a trace. Among the events of that trace,
    // prefer the one this action maps to; fall back to any unclaimed event of the
    // trace, since an audited action that emitted exactly one event does not need a
    // mapping entry to be pairable.
    let match = a.trace_id
      ? (events.find((e) => e.trace_id === a.trace_id && e.type === type && !claimed.has(e.id)) ??
        events.find((e) => e.trace_id === a.trace_id && !claimed.has(e.id)))
      : undefined;
    // Pre-0148 rows have no trace on either side; keep the old window so a migrated
    // or historical record still collapses instead of doubling every line.
    if (!match && !a.trace_id && type) {
      const at = Date.parse(a.created_at);
      match = events.find(
        (e) =>
          e.type === type &&
          !claimed.has(e.id) &&
          Math.abs(Date.parse(e.occurred_at) - at) <= PAIR_WINDOW_MS,
      );
    }
    if (match) {
      claimed.add(match.id);
      auditForEvent.set(match.id, a);
    } else {
      unpaired.push(a);
    }
  }

  // `?source=` makes the record page lead with the resource this card belongs to.
  const auditHref = (a: AuditRow) =>
    `/businesses/${biz}/audit/${a.id}?source=${encodeURIComponent(resourceType)}`;
  // Name the record only when it isn't the one whose page this is — on a resource
  // log every row is about that resource, and repeating its id 50 times is noise.
  const refOf = (id: string | null) => (byCustomer && id && id !== resourceId ? id : null);
  const rows: LogRow[] = [
    ...events.map((e) => {
      const a = auditForEvent.get(e.id);
      // An audited act is described by its ACTION (the operator's verb); an
      // unaudited one only has its event type, so that is what names it.
      // In customer scope the row may be about an invoice or a subscription, so the
      // EVENT's own resource names it — the card's cannot stand in for it any more.
      const ownType = byCustomer ? (e.resource?.type ?? resourceType) : resourceType;
      const h = a
        ? actionHeadline(a.action, a.resource_type)
        : { noun: eventNoun(e.type, ownType), verb: eventVerb(e.type) };
      return {
        key: `e_${e.id}`,
        at: e.occurred_at,
        noun: h.noun,
        verb: h.verb,
        actor: a?.actor ?? e.actor,
        source: a?.source ?? e.source,
        ip: a?.actor_ip ?? null,
        href: a ? auditHref(a) : `/businesses/${biz}/events/${e.id}`,
        ...(a ? { altHref: `/businesses/${biz}/events/${e.id}`, altLabel: "Event" } : {}),
        ref: refOf(a?.resource_id ?? e.resource?.id ?? null),
      };
    }),
    ...unpaired.map((a) => {
      const h = actionHeadline(a.action, a.resource_type);
      return {
        key: `a_${a.id}`,
        at: a.created_at,
        noun: h.noun,
        verb: h.verb,
        actor: a.actor,
        source: a.source,
        ip: a.actor_ip,
        href: auditHref(a),
        ref: refOf(a.resource_id),
      };
    }),
  ].sort((x, y) => Date.parse(y.at) - Date.parse(x.at));

  // Two streams, each cut at its own limit: below the later of the two cut points one
  // of them is missing rows, so the merged log stops there instead of showing a gap.
  const cuts = [
    page.has_more && events.length ? Date.parse(events[events.length - 1].occurred_at) : null,
    auditsMore && audits.length ? Date.parse(audits[audits.length - 1].created_at) : null,
  ].filter((t): t is number => t != null);
  const cutoff = cuts.length ? Math.max(...cuts) : null;
  const shown = cutoff == null ? rows : rows.filter((r) => Date.parse(r.at) >= cutoff);

  return (
    <SectionCard id="activity" title="Activity log" layout={layout}>
      {rows.length === 0 ? (
        <EmptyState title="No activity yet" />
      ) : (
        <>
          <ActivityRows rows={shown} previewRows={previewRows} tz={tz} />
          {cutoff != null ? (
            <p className="border-t pt-3 text-xs text-muted-foreground">
              Showing activity since {fmtDateTime(new Date(cutoff).toISOString(), tz)}.{" "}
              {byCustomer ? (
                "Older entries are in the Events and Audit log lists."
              ) : (
                <Link
                  href={`/businesses/${biz}/events?resource_id=${encodeURIComponent(resourceId)}`}
                  className="text-primary hover:underline"
                >
                  Older events
                </Link>
              )}
            </p>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}

function ActivityRows({
  rows,
  previewRows,
  tz,
}: {
  rows: LogRow[];
  /** Rows per page (default 10). */
  previewRows?: number;
  tz: string | null;
}) {
  return (
    <Paged
      size={previewRows ?? 10}
      items={rows.map((r) => (
        <ActivityItem key={r.key} r={r} tz={tz} />
      ))}
    >
      <ul className="divide-y">
        <PagedItems />
      </ul>
      <PagedFooter className="px-0" />
    </Paged>
  );
}

function ActivityItem({ r, tz }: { r: LogRow; tz: string | null }) {
  return (
    // A real basis on the text, so on a narrow card the time drops under it instead of
    // squeezing it to a word per line.
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3 text-sm first:pt-0">
      <span className="min-w-0 flex-[1_1_14rem]">
        {/* The source leads the row: it is the first thing that tells you
                    whether a human, an integration or the clock did this. */}
        {r.source ? (
          <Badge variant="outline" className="mr-2 align-middle text-xs">
            via {r.source}
          </Badge>
        ) : null}
        <span className="font-medium">{r.noun}</span> <span>{r.verb}</span>
        {r.ref ? (
          <span className="ml-2 font-mono text-xs wrap-anywhere text-muted-foreground">
            {r.ref}
          </span>
        ) : null}
      </span>
      <span className="max-w-full shrink-0 text-right">
        <span className="block text-xs text-muted-foreground tabular-nums">
          {fmtDateTime(r.at, tz)}
        </span>
        {/* "System" / "Billing clock" are names, an api key id is a token —
                    `actorLabel` keeps that distinction the same on every surface. */}
        {r.actor ? (
          <span
            className={cn(
              "block text-xs wrap-anywhere text-muted-foreground",
              actorLabel(r.actor).mono && "font-mono",
            )}
          >
            {actorLabel(r.actor).text}
          </span>
        ) : null}
        {/* Only rendered when we actually captured one — a scheduled or
                    imported change has no origin address and must not imply one. */}
        {r.ip ? (
          <span className="block font-mono text-xs text-muted-foreground tabular-nums">{r.ip}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-baseline gap-2">
        {r.altHref ? (
          <Link href={r.altHref} className="text-xs text-muted-foreground hover:underline">
            {r.altLabel}
          </Link>
        ) : null}
        <Link href={r.href} className="text-xs text-primary hover:underline">
          Details
        </Link>
      </span>
    </li>
  );
}

/**
 * An UNAUDITED event's sentence. `invoice_payment_due` → "Invoice" + "payment due."
 *
 * The event type already begins with its resource on almost every type we emit, so
 * the prefix is stripped when it matches rather than printed twice. When it doesn't
 * match, the card's own resource names it — the row is on that record's page, so it
 * cannot be about anything else.
 */
function eventNoun(type: string, resourceType: string): string {
  const noun = type.split("_")[0] ?? resourceType;
  const base = type.startsWith(`${resourceType}_`) ? resourceType : noun;
  return base.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function eventVerb(type: string): string {
  const parts = type.split("_");
  return `${(parts.length > 1 ? parts.slice(1) : parts).join(" ")}.`;
}
