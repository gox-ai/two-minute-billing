/**
 * 0149 — turn a Drizzle row into the record body stored in `audit_log_snapshots`.
 *
 * "Show Diff" renders the WHOLE record on both sides so a change reads
 * in context, and "Show Content" renders the full body of a record that was just
 * created. Both need a snapshot of the row, and every audited call site needs to
 * produce it the same way or the diff's field names change depending on which
 * action you are looking at.
 *
 * WHY NOT THE API SERIALIZERS. `serializeCustomer` wants resolved financials and
 * `serializeSubscription` wants the business's term-end convention plus items,
 * discount and dues — arguments most audited call sites don't have in hand and
 * would have to fetch purely to write an audit row. A snapshot is not an API
 * response: it needs to be faithful and cheap, not enriched. So this walks the row
 * mechanically, which also means a new column appears in the diff automatically
 * instead of being silently missing until someone updates a serializer.
 */

/** Internal plumbing no reader can act on. `publicId` becomes `id` instead. */
const DROP = new Set(["id", "organizationId", "businessId"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const snake = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * Values must survive `JSON.stringify` into jsonb, and two of ours don't by
 * default:
 *  - **bigint throws outright.** Money and MRR are bigint columns, so a snapshot of
 *    a subscription would have crashed the action it was auditing. Rendered as a
 *    STRING of minor units — e.g. `"mrr" : "0"` — never as a number, which would
 *    silently lose precision above 2^53.
 *  - **Date** becomes an ISO string, which is what every other jsonb column here
 *    already stores.
 */
function value(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(value);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, value(x)]),
    );
  }
  return v;
}

/**
 * The snapshot body for one row: snake_case keys, `publicId` surfaced as `id`,
 * internal uuids dropped.
 *
 * A key ending in `Id` whose value is a bare uuid is an internal FK
 * (`customerId`, `subscriptionId`) and is dropped: our public ids are all prefixed
 * (`cus_…`, `sub_…`), so the uuid shape is a reliable tell, and an unchanged line
 * of raw uuid is pure noise in a diff the reader is scanning for what moved.
 * Prefixed ids stay — those are how a reader identifies the related record.
 *
 * `extra` merges in anything the row itself doesn't carry — the item list of a
 * subscription, for instance, which lives in its own table but is part of "the
 * record" as anyone reading an audit log understands it.
 */
export function auditSnapshot(
  row: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof row.publicId === "string") out.id = row.publicId;
  for (const [k, v] of Object.entries(row)) {
    if (DROP.has(k) || k === "publicId") continue;
    if (/Id$/.test(k) && typeof v === "string" && UUID.test(v)) continue;
    out[snake(k)] = value(v);
  }
  for (const [k, v] of Object.entries(extra ?? {})) out[snake(k)] = value(v);
  return out;
}

/**
 * The changed-field maps for `audit_logs.before/after`, derived from two snapshots
 * so a call site states the change once instead of building the diff by hand and
 * the snapshot separately (they drifted apart every time that was done manually).
 *
 * Only keys that actually moved are returned — `audit_logs.before/after` are
 * defined as changed-field maps, and the dashboard's `diffFields` drops unchanged
 * pairs anyway. A key on one side only is kept, because that is a set or a clear.
 */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const inB = k in before;
    const inA = k in after;
    if (inB && inA && JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    if (inB) b[k] = before[k];
    if (inA) a[k] = after[k];
  }
  return { before: b, after: a };
}
