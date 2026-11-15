/**
 * Async transfers: a persisted plan the member reviews, then an apply that queues the
 * `transfer_run` job. Plan → (exclude items) → apply → runner → succeeded | partially_failed |
 * failed | cancelled; retry re-queues only the failed items and the ones they held back.
 */
import { and, asc, eq, gt, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { getTraceId } from "@/platform/trace";
import { currentEventContext } from "@/platform/event-context";
import { isUuid } from "@/platform/list-query";
import { businesses, transferConfigurations, transferItems } from "@db/schema";
import { DEFAULT_SECTIONS, TransferError, type Numbering, type TransferSection } from "./plan";
import {
  resolvePairs,
  TransferConflictError,
  TransferForbiddenError,
  type Pair as BizPair,
} from "./service";
import {
  blockingErrors,
  checkExclusionKeys,
  countStatuses,
  effectiveState,
  needsLiveOverride,
  pairKey,
  RESULT_OF_ACTION,
  summarize,
  warnings,
  writes,
  type GraphItem,
  type ResultKind,
  type RunSummary,
  type ItemStatus,
  type Pair,
} from "./graph";
import { defaultPolicy, planPairItems, type ConflictPolicy, type PlannedItem } from "./items";

export type RunRow = typeof transferConfigurations.$inferSelect;
export type ItemRow = typeof transferItems.$inferSelect;

/**
 * `transfer_items.id` in `ids`, bound as ONE uuid[] parameter. A plan can hold tens of
 * thousands of items (one per coupon); `inArray` binds one parameter per id.
 */
export const itemIdIn = (ids: string[]) =>
  sql`${transferItems.id} = any(${`{${ids.join(",")}}`}::uuid[])`;

/**
 * Rows per INSERT. Each item row binds 16 parameters: one statement of every item overflows
 * the stack building the query, and Postgres caps a statement at 65,535 parameters.
 */
const ITEM_INSERT_BATCH = 500;

/** The set-up changed between the plan and the apply. */
export class TransferDriftError extends TransferConflictError {
  constructor(message: string) {
    super(message);
    this.name = "TransferDriftError";
  }
}

export interface PlanInput {
  organizationId: string;
  sourceBusinessId: string;
  destinationBusinessId: string;
  sections?: TransferSection[];
  conflictPolicy?: ConflictPolicy;
  numbering?: Numbering;
  includeTestTwins?: boolean;
  wipeDestination?: boolean;
  /** Item keys (`main:price:pro-usd`) to leave out, carried from an earlier plan. */
  exclude?: string[];
}

interface StoredOptions {
  numbering?: Numbering;
  include_test_twins?: boolean;
  twin?: { source: string; destination: string };
}

const actor = () => currentEventContext()?.actor ?? "system";

/** Both pairs' fresh items, twin first. */
async function planAll(
  tx: Tx,
  pairs: { main: BizPair; twin: BizPair | null },
  o: { sections: TransferSection[]; policy: ConflictPolicy; numbering?: Numbering; wipe: boolean },
): Promise<PlannedItem[]> {
  const out: PlannedItem[] = [];
  if (pairs.twin)
    out.push(
      ...(
        await planPairItems(tx, pairs.twin.src, pairs.twin.dest, "twin", {
          sections: o.sections,
          numbering: o.numbering,
          wipe: false,
          policy: defaultPolicy(false, o.sections),
        })
      ).items,
    );
  out.push(
    ...(
      await planPairItems(tx, pairs.main.src, pairs.main.dest, "main", {
        sections: o.sections,
        numbering: o.numbering,
        wipe: o.wipe,
        policy: o.policy,
      })
    ).items,
  );
  return out;
}

type GraphFields = Pick<
  ItemRow,
  "pair" | "section" | "kind" | "key" | "label" | "action" | "excluded" | "dependsOn" | "messages"
>;
const asGraph = (i: GraphFields | PlannedItem): GraphItem => ({
  pair: i.pair as Pair,
  section: i.section,
  kind: i.kind as GraphItem["kind"],
  key: i.key,
  label: i.label,
  action: i.action as GraphItem["action"],
  excluded: i.excluded,
  dependsOn: (i.dependsOn as string[]) ?? [],
  messages: (i.messages as GraphItem["messages"]) ?? [],
});

function validationOf(items: GraphItem[]) {
  return { errors: blockingErrors(items), warnings: warnings(items) };
}

/** Build and store a plan. An older open plan for the same pair is superseded. */
export async function createTransferPlan(input: PlanInput) {
  const sections = input.sections?.length ? input.sections : DEFAULT_SECTIONS;
  return withTenant(input.organizationId, async (tx) => {
    const pairs = await resolvePairs(tx, {
      organizationId: input.organizationId,
      sourceBusinessId: input.sourceBusinessId,
      destinationBusinessId: input.destinationBusinessId,
      includeTestTwins: input.includeTestTwins,
    });
    const destLive = pairs.main.dest.livemode === "live";
    const policy = { ...defaultPolicy(destLive, sections), ...(input.conflictPolicy ?? {}) };
    const wipe = input.wipeDestination === true && !destLive;
    const planned = await planAll(tx, pairs, {
      sections,
      policy,
      numbering: input.numbering,
      wipe,
    });
    const excluded = new Set(input.exclude ?? []);
    for (const i of planned) i.excluded = excluded.has(pairKey(i));

    await tx
      .update(transferConfigurations)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(transferConfigurations.sourceBusinessId, pairs.main.src.id),
          eq(transferConfigurations.destinationBusinessId, pairs.main.dest.id),
          eq(transferConfigurations.runKind, "async"),
          eq(transferConfigurations.status, "planned"),
        ),
      );
    const options: StoredOptions = {
      ...(input.numbering ? { numbering: input.numbering } : {}),
      ...(pairs.twin
        ? {
            include_test_twins: true,
            twin: { source: pairs.twin.src.id, destination: pairs.twin.dest.id },
          }
        : {}),
    };
    const [run] = await tx
      .insert(transferConfigurations)
      .values({
        organizationId: input.organizationId,
        sourceBusinessId: pairs.main.src.id,
        destinationBusinessId: pairs.main.dest.id,
        sections,
        wipeDestination: wipe,
        status: "planned",
        runKind: "async",
        conflictPolicy: policy,
        options: Object.keys(options).length ? options : null,
        validation: validationOf(planned.map(asGraph)),
        plannedBy: actor(),
      })
      .returning();
    const rows = planned.map((i, seq) => ({
      organizationId: input.organizationId,
      transferId: run!.id,
      seq,
      pair: i.pair,
      section: i.section,
      kind: i.kind,
      key: i.key,
      label: i.label,
      action: i.action,
      excluded: i.excluded,
      dependsOn: i.dependsOn,
      diff: i.diff,
      messages: i.messages,
      sourceRef: i.sourceRef,
      fingerprint: i.fingerprint,
      status: "pending" as const,
    }));
    for (let at = 0; at < rows.length; at += ITEM_INSERT_BATCH)
      await tx.insert(transferItems).values(rows.slice(at, at + ITEM_INSERT_BATCH));
    return run!.id;
  });
}

export interface RunView {
  run: RunRow;
  /** Every item with its diff; empty when the caller asked for none. */
  items: ItemRow[];
  /** Per item: blocked by itself or a dependency, with every message. */
  effective: Map<string, { blocked: boolean; messages: GraphItem["messages"] }>;
  summary: RunSummary;
  liveOverrideNeeded: boolean;
  destLive: boolean;
}

/** The columns the graph rules, counts and filters read: no diff, no undo record. */
const lightColumns = {
  seq: transferItems.seq,
  pair: transferItems.pair,
  section: transferItems.section,
  kind: transferItems.kind,
  key: transferItems.key,
  label: transferItems.label,
  action: transferItems.action,
  excluded: transferItems.excluded,
  dependsOn: transferItems.dependsOn,
  messages: transferItems.messages,
  status: transferItems.status,
  skipReason: transferItems.skipReason,
};
type LightRow = { [K in keyof typeof lightColumns]: ItemRow[K] };

const lightGraph = (i: LightRow) => ({
  ...asGraph(i),
  status: i.status as ItemStatus,
  skipReason: i.skipReason,
});

async function readRun(tx: Tx, runId: string) {
  const [run] = await tx
    .select()
    .from(transferConfigurations)
    .where(and(eq(transferConfigurations.id, runId), eq(transferConfigurations.runKind, "async")));
  if (!run) return null;
  const light = await tx
    .select(lightColumns)
    .from(transferItems)
    .where(eq(transferItems.transferId, run.id))
    .orderBy(asc(transferItems.seq));
  const g = light.map(lightGraph);
  const effective = effectiveState(g);
  return { run, g, effective, summary: summarize(g, effective) };
}

export async function getTransferRun(
  orgId: string,
  runId: string,
  opts: { items?: boolean } = {},
): Promise<RunView | null> {
  if (!isUuid(runId)) return null;
  return withTenant(orgId, async (tx) => {
    const r = await readRun(tx, runId);
    if (!r) return null;
    const items =
      opts.items === false
        ? []
        : await tx
            .select()
            .from(transferItems)
            .where(eq(transferItems.transferId, r.run.id))
            .orderBy(asc(transferItems.seq));
    const [dest] = await tx
      .select({ livemode: businesses.livemode })
      .from(businesses)
      .where(eq(businesses.id, r.run.destinationBusinessId));
    const destLive = dest?.livemode === "live";
    return {
      run: r.run,
      items,
      effective: r.effective,
      summary: r.summary,
      liveOverrideNeeded: needsLiveOverride(r.g, destLive),
      destLive,
    };
  });
}

export type ItemResultFilter = ResultKind | "changes";
/** Over queued items only: every one, or by status (`open` = pending or running). */
export type ItemStatusFilter = "queued" | "open" | "done" | "failed" | "skipped";

export interface ItemPageQuery {
  section?: string;
  result?: ItemResultFilter;
  status?: ItemStatusFilter;
  /** Case-insensitive substring of the label. */
  q?: string;
  limit: number;
  /** The `seq` of the last item of the previous page. */
  startingAfter?: number;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** One page of a run's items in plan order. Filters run in SQL; `blocked` needs the graph. */
export async function listTransferItems(
  orgId: string,
  runId: string,
  query: ItemPageQuery,
): Promise<{ items: ItemRow[]; effective: RunView["effective"]; hasMore: boolean } | null> {
  if (!isUuid(runId)) return null;
  return withTenant(orgId, async (tx) => {
    const r = await readRun(tx, runId);
    if (!r) return null;
    const blockedKeys = r.summary.blocked.map((b) => b.key);
    const isBlocked = blockedKeys.length
      ? sql`(${transferItems.pair} || ':' || ${transferItems.key}) = any(${toPgArray(blockedKeys)}::text[])`
      : sql`false`;
    const notOut = eq(transferItems.excluded, false);
    const byResult = (k: ResultKind): SQL => {
      if (k === "left_out") return eq(transferItems.excluded, true);
      if (k === "blocked") return and(notOut, isBlocked)!;
      const actions = Object.entries(RESULT_OF_ACTION)
        .filter(([, v]) => v === k)
        .map(([a]) => a);
      return and(notOut, sql`not ${isBlocked}`, inArray(transferItems.action, actions))!;
    };
    const queued = sql`not (${transferItems.status} = 'skipped' and coalesce(${transferItems.skipReason}, '') in ('excluded', 'unchanged'))`;
    const where: SQL[] = [eq(transferItems.transferId, r.run.id)];
    if (query.startingAfter !== undefined) where.push(gt(transferItems.seq, query.startingAfter));
    if (query.section) where.push(eq(transferItems.section, query.section));
    if (query.q) where.push(ilike(transferItems.label, `%${likeEscape(query.q)}%`));
    if (query.result === "changes")
      where.push(or(byResult("new"), byResult("updated"), byResult("deleted"))!);
    else if (query.result) where.push(byResult(query.result));
    if (query.status) {
      where.push(queued);
      if (query.status === "open")
        where.push(inArray(transferItems.status, ["pending", "running"]));
      else if (query.status !== "queued") where.push(eq(transferItems.status, query.status));
    }
    const rows = await tx
      .select()
      .from(transferItems)
      .where(and(...where))
      .orderBy(asc(transferItems.seq))
      .limit(query.limit + 1);
    return {
      items: rows.slice(0, query.limit),
      effective: r.effective,
      hasMore: rows.length > query.limit,
    };
  });
}

/** A text[] literal bound as ONE parameter (a plan can block thousands of items). */
const toPgArray = (xs: string[]) =>
  `{${xs.map((x) => `"${x.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(",")}}`;

/** The newest open plan or active run started from this business, if any. */
export async function currentTransferRun(orgId: string, sourceBusinessId: string) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({ id: transferConfigurations.id })
      .from(transferConfigurations)
      .where(
        and(
          eq(transferConfigurations.sourceBusinessId, sourceBusinessId),
          eq(transferConfigurations.runKind, "async"),
          inArray(transferConfigurations.status, ["planned", "queued", "running"]),
        ),
      )
      .orderBy(sql`${transferConfigurations.createdAt} desc`)
      .limit(1);
    return row?.id ?? null;
  });
}

async function lockRun(tx: Tx, runId: string): Promise<RunRow> {
  if (!isUuid(runId)) throw new TransferError("No such transfer.");
  const [run] = await tx
    .select()
    .from(transferConfigurations)
    .where(and(eq(transferConfigurations.id, runId), eq(transferConfigurations.runKind, "async")))
    .for("update");
  if (!run) throw new TransferError("No such transfer.");
  return run;
}

/** Leave items out of a plan, or put them back. Only an open plan changes. */
export async function setItemExclusions(
  orgId: string,
  runId: string,
  change: { exclude?: string[]; include?: string[] },
): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const run = await lockRun(tx, runId);
    if (run.status !== "planned")
      throw new TransferConflictError("This plan has started. You cannot change it now.");
    const items = await tx.select().from(transferItems).where(eq(transferItems.transferId, run.id));
    const keys = [...(change.exclude ?? []), ...(change.include ?? [])];
    const unknown = checkExclusionKeys(items.map(asGraph), keys);
    if (unknown.length) throw new TransferError(`No such item in this plan: ${unknown[0]}.`);
    for (const [list, excluded] of [
      [change.exclude ?? [], true],
      [change.include ?? [], false],
    ] as const) {
      const wanted = new Set(list);
      const ids = items.filter((i) => wanted.has(pairKey(asGraph(i)))).map((i) => i.id);
      if (ids.length)
        await tx
          .update(transferItems)
          .set({ excluded, updatedAt: new Date() })
          .where(itemIdIn(ids));
    }
    const fresh = await tx
      .select()
      .from(transferItems)
      .where(eq(transferItems.transferId, run.id))
      .orderBy(asc(transferItems.seq));
    await tx
      .update(transferConfigurations)
      .set({ validation: validationOf(fresh.map(asGraph)), updatedAt: new Date() })
      .where(eq(transferConfigurations.id, run.id));
  });
}

/** The run's businesses, re-read: the stored plan may name a twin pair. */
async function pairsOf(tx: Tx, run: RunRow) {
  const opts = (run.options ?? {}) as StoredOptions;
  const ids = [run.sourceBusinessId, run.destinationBusinessId];
  if (opts.twin) ids.push(opts.twin.source, opts.twin.destination);
  const rows = await tx.select().from(businesses).where(inArray(businesses.id, ids));
  const get = (id: string) => {
    const b = rows.find((r) => r.id === id);
    if (!b) throw new TransferError("We could not find the source or the destination.");
    return b;
  };
  return {
    main: { src: get(run.sourceBusinessId), dest: get(run.destinationBusinessId) },
    twin: opts.twin ? { src: get(opts.twin.source), dest: get(opts.twin.destination) } : null,
  };
}

/**
 * Re-plan and compare with the stored items. Only `keys` are compared (all when omitted):
 * an item already done has moved the destination on purpose. Returns the drifted labels.
 */
export async function driftOf(tx: Tx, run: RunRow, stored: ItemRow[], keys?: Set<string>) {
  const pairs = await pairsOf(tx, run);
  const opts = (run.options ?? {}) as StoredOptions;
  const fresh = await planAll(tx, pairs, {
    sections: run.sections as TransferSection[],
    policy: (run.conflictPolicy ?? {}) as ConflictPolicy,
    numbering: opts.numbering,
    wipe: run.wipeDestination,
  });
  const byKey = new Map(fresh.map((i) => [pairKey(i), i]));
  const drifted: string[] = [];
  for (const s of stored) {
    const k = pairKey(asGraph(s));
    if (keys && !keys.has(k)) continue;
    const f = byKey.get(k);
    if (!f || f.action !== s.action || f.fingerprint !== s.fingerprint) drifted.push(s.label);
  }
  if (!keys) {
    const known = new Set(stored.map((s) => pairKey(asGraph(s))));
    for (const f of fresh)
      if (!known.has(pairKey(f)) && f.action !== "unchanged") drifted.push(f.label);
  }
  return drifted;
}

const driftMessage = (labels: string[]) =>
  `The set-up changed after the check: ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ` and ${labels.length - 3} more` : ""}. Check the changes again.`;

/** Refuse when another async or sync run holds the destination (or the twin destination). */
async function assertNoActiveRun(tx: Tx, run: RunRow, dests: string[]) {
  await tx
    .select({ id: businesses.id })
    .from(businesses)
    .where(inArray(businesses.id, dests))
    .for("update");
  const [busy] = await tx
    .select({ id: transferConfigurations.id })
    .from(transferConfigurations)
    .where(
      and(
        inArray(transferConfigurations.destinationBusinessId, dests),
        ne(transferConfigurations.id, run.id),
        or(
          and(
            eq(transferConfigurations.runKind, "async"),
            inArray(transferConfigurations.status, ["queued", "running"]),
          ),
          and(
            eq(transferConfigurations.runKind, "sync"),
            eq(transferConfigurations.status, "running"),
            sql`${transferConfigurations.createdAt} > now() - interval '10 minutes'`,
          ),
        ),
      ),
    )
    .limit(1);
  if (busy)
    throw new TransferConflictError(
      "A copy into this business is running. Wait for it to finish, then try again.",
    );
}

export interface ApplyInput {
  organizationId: string;
  runId: string;
  /** The destination's name typed back; needed when the plan changes a live business. */
  confirm?: string | null;
  operatorPermissions: ReadonlySet<string> | null;
  operatorUserId?: string | null;
}

/** Validate again and queue the run. Items that do not write are skipped now, with the reason. */
export async function applyTransferPlan(input: ApplyInput): Promise<void> {
  await withTenant(input.organizationId, async (tx) => {
    const run = await lockRun(tx, input.runId);
    if (run.status !== "planned")
      throw new TransferConflictError(
        run.status === "superseded"
          ? "A newer plan replaced this one. Open the newer plan."
          : "This plan has started already.",
      );
    const pairs = await pairsOf(tx, run);
    await assertNoActiveRun(tx, run, [
      pairs.main.dest.id,
      ...(pairs.twin ? [pairs.twin.dest.id] : []),
    ]);
    const items = await tx
      .select()
      .from(transferItems)
      .where(eq(transferItems.transferId, run.id))
      .orderBy(asc(transferItems.seq));
    const g = items.map(asGraph);
    const errors = blockingErrors(g);
    if (errors.length)
      throw new TransferError(
        `${errors.length === 1 ? "1 item cannot" : `${errors.length} items cannot`} be copied. Correct ${errors.length === 1 ? "it or leave it" : "them or leave them"} out. ${errors[0]!.message}`,
      );
    const drift = await driftOf(tx, run, items);
    if (drift.length) throw new TransferDriftError(driftMessage(drift));
    const destLive = pairs.main.dest.livemode === "live";
    if (needsLiveOverride(g, destLive)) {
      if (!input.operatorPermissions?.has("transfers:live_override"))
        throw new TransferForbiddenError(
          "This plan changes records of a live business. Only a signed-in owner or admin can apply it.",
        );
      if (input.confirm !== pairs.main.dest.name)
        throw new TransferError(
          "The confirmation does not match the destination's name. Type the name exactly.",
        );
    }
    const queue = items.filter((i) => writes(asGraph(i))).map((i) => i.id);
    const queued = new Set(queue);
    const rest = items.filter((i) => !queued.has(i.id));
    for (const reason of ["excluded", "unchanged"] as const) {
      const ids = rest.filter((i) => (reason === "excluded") === i.excluded).map((i) => i.id);
      if (ids.length)
        await tx
          .update(transferItems)
          .set({ status: "skipped", skipReason: reason, updatedAt: new Date() })
          .where(itemIdIn(ids));
    }
    const now = new Date();
    await tx
      .update(transferConfigurations)
      .set({
        status: "queued",
        queuedAt: now,
        startedBy: actor(),
        startedByUserId: input.operatorUserId ?? null,
        liveOverride: needsLiveOverride(g, destLive),
        counts: countStatuses(
          items.map((i) => ({ status: "pending" as ItemStatus, queued: queue.includes(i.id) })),
        ),
        validation: validationOf(g),
        updatedAt: now,
      })
      .where(eq(transferConfigurations.id, run.id));
    const { writeAuditLog } = await import("@/modules/audit/service");
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: run.destinationBusinessId,
        action: "transfer.apply",
        resourceType: "transfer",
        resourceId: run.id,
        after: {
          source_business: pairs.main.src.publicId,
          sections: run.sections,
          items: queue.length,
          conflict_policy: run.conflictPolicy,
          live_override: needsLiveOverride(g, destLive),
        },
      },
      tx,
    );
    await queueRun(tx, run.id);
  });
}

async function queueRun(tx: Tx, runId: string) {
  await tx.execute(
    sql`select public.app_queue_transfer_run(${runId}::uuid, ${getTraceId() ?? null})`,
  );
}

/** Stop a run after its current item. A queued run or an open plan stops at once. */
export async function cancelTransferRun(orgId: string, runId: string): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const run = await lockRun(tx, runId);
    const now = new Date();
    if (run.status === "running") {
      await tx
        .update(transferConfigurations)
        .set({ cancelRequestedAt: now, cancelledBy: actor(), updatedAt: now })
        .where(eq(transferConfigurations.id, run.id));
    } else if (run.status === "queued" || run.status === "planned") {
      await tx
        .update(transferItems)
        .set({ status: "skipped", skipReason: "cancelled", updatedAt: now })
        .where(
          and(
            eq(transferItems.transferId, run.id),
            inArray(transferItems.status, ["pending", "running"]),
          ),
        );
      await tx
        .update(transferConfigurations)
        .set({
          status: "cancelled",
          cancelRequestedAt: now,
          cancelledBy: actor(),
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(transferConfigurations.id, run.id));
    } else {
      throw new TransferConflictError("This copy has ended. There is nothing to cancel.");
    }
    const { writeAuditLog } = await import("@/modules/audit/service");
    await writeAuditLog(
      {
        organizationId: orgId,
        businessId: run.destinationBusinessId,
        action: "transfer.cancel",
        resourceType: "transfer",
        resourceId: run.id,
        before: { status: run.status },
      },
      tx,
    );
  });
}

/** Queue again only the failed items and the items a failure held back. */
export async function retryTransferRun(input: ApplyInput): Promise<void> {
  await withTenant(input.organizationId, async (tx) => {
    const run = await lockRun(tx, input.runId);
    if (run.status !== "partially_failed" && run.status !== "failed")
      throw new TransferConflictError("Only a copy that has failed items can be tried again.");
    const pairs = await pairsOf(tx, run);
    await assertNoActiveRun(tx, run, [
      pairs.main.dest.id,
      ...(pairs.twin ? [pairs.twin.dest.id] : []),
    ]);
    const items = await tx
      .select()
      .from(transferItems)
      .where(eq(transferItems.transferId, run.id))
      .orderBy(asc(transferItems.seq));
    const again = items.filter(
      (i) =>
        i.status === "failed" ||
        (i.status === "skipped" && (i.skipReason === "dependency" || i.skipReason === "drift")),
    );
    if (!again.length)
      throw new TransferConflictError("No item failed. There is nothing to try again.");
    const keys = new Set(again.map((i) => pairKey(asGraph(i))));
    const drift = await driftOf(tx, run, items, keys);
    if (drift.length) throw new TransferDriftError(driftMessage(drift));
    const destLive = pairs.main.dest.livemode === "live";
    if (needsLiveOverride(again.map(asGraph), destLive)) {
      if (!input.operatorPermissions?.has("transfers:live_override"))
        throw new TransferForbiddenError(
          "These items change records of a live business. Only a signed-in owner or admin can try them again.",
        );
      if (input.confirm !== pairs.main.dest.name)
        throw new TransferError(
          "The confirmation does not match the destination's name. Type the name exactly.",
        );
    }
    const now = new Date();
    await tx
      .update(transferItems)
      .set({ status: "pending", error: null, skipReason: null, updatedAt: now })
      .where(itemIdIn(again.map((i) => i.id)));
    await tx
      .update(transferConfigurations)
      .set({
        status: "queued",
        queuedAt: now,
        finishedAt: null,
        error: null,
        notifiedAt: null,
        cancelRequestedAt: null,
        leaseCount: 0,
        updatedAt: now,
      })
      .where(eq(transferConfigurations.id, run.id));
    const { writeAuditLog } = await import("@/modules/audit/service");
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: run.destinationBusinessId,
        action: "transfer.retry",
        resourceType: "transfer",
        resourceId: run.id,
        after: { items: again.length },
      },
      tx,
    );
    await queueRun(tx, run.id);
  });
}
