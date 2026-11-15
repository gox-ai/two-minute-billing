/**
 * The `transfer_run` job: apply a queued run item by item. Each item commits its write and its
 * `done` in one transaction, so a killed worker leaves every item either applied or not; the
 * next runner resumes the rest. A lease (token + heartbeat) keeps one runner per run.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { runWithEventContext } from "@/platform/event-context";
import { businesses, transferConfigurations, transferItems, users } from "@db/schema";
import {
  countStatuses,
  dependencyBlocker,
  finalStatus,
  pairKey,
  type ItemStatus,
  type Pair,
} from "./graph";
import { applyItem, ItemApplyError } from "./apply";
import { driftOf, itemIdIn, type ItemRow, type RunRow } from "./runs";

const log = createLogger("transfer");

/** A heartbeat older than this means the runner died; another may take the lease. */
export const LEASE_STALE_MS = 90_000;
/** A run leased this many times without finishing is failed instead of looping. */
const MAX_LEASES = 10;

/** Thrown by the test hook to stop the runner the way a killed process would. */
export class SimulatedCrash extends Error {}

export interface RunnerHooks {
  /** Called inside each item's transaction after its write, before commit. */
  afterWrite?: (index: number, item: ItemRow) => void | Promise<void>;
}

const counts = (items: ItemRow[], queued: Set<string>) =>
  countStatuses(items.map((i) => ({ status: i.status as ItemStatus, queued: queued.has(i.id) })));

export async function runTransferJob(runId: string, hooks: RunnerHooks = {}): Promise<string> {
  const [head] = await systemDb
    .select({ org: transferConfigurations.organizationId })
    .from(transferConfigurations)
    .where(eq(transferConfigurations.id, runId));
  if (!head) return "missing";
  const org = head.org;
  const token = randomUUID();
  const leased = await withTenant(org, async (tx) => {
    const [r] = await tx
      .update(transferConfigurations)
      .set({
        leaseToken: token,
        heartbeatAt: new Date(),
        leaseCount: sql`${transferConfigurations.leaseCount} + 1`,
        status: "running",
        startedAt: sql`coalesce(${transferConfigurations.startedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transferConfigurations.id, runId),
          eq(transferConfigurations.runKind, "async"),
          inArray(transferConfigurations.status, ["queued", "running"]),
          or(
            isNull(transferConfigurations.leaseToken),
            lt(transferConfigurations.heartbeatAt, new Date(Date.now() - LEASE_STALE_MS)),
          ),
        ),
      )
      .returning();
    return r ?? null;
  });
  if (!leased) return "busy_or_done";
  const actor = leased.startedBy ?? "system";
  return runWithEventContext({ source: "dashboard", actor }, async () => {
    try {
      return await drive(org, leased, token, hooks);
    } catch (e) {
      // An error frees the lease so the job's retry resumes now; a killed process cannot, and
      // its lease goes stale instead.
      if (!(e instanceof SimulatedCrash))
        await withTenant(org, (tx) =>
          tx
            .update(transferConfigurations)
            .set({ leaseToken: null, updatedAt: new Date() })
            .where(
              and(
                eq(transferConfigurations.id, runId),
                eq(transferConfigurations.leaseToken, token),
              ),
            ),
        ).catch(() => undefined);
      throw e;
    }
  });
}

async function drive(org: string, run: RunRow, token: string, hooks: RunnerHooks): Promise<string> {
  const load = () =>
    withTenant(org, (tx) =>
      tx
        .select()
        .from(transferItems)
        .where(eq(transferItems.transferId, run.id))
        .orderBy(asc(transferItems.seq)),
    );
  let items = await load();
  // The items this run applies: everything not skipped at apply time.
  const queued = new Set(
    items
      .filter((i) => i.skipReason !== "excluded" && i.skipReason !== "unchanged")
      .map((i) => i.id),
  );

  if (run.leaseCount > MAX_LEASES)
    return finish(
      org,
      run,
      token,
      items,
      queued,
      "We tried to finish this copy too many times. Try the failed items again.",
    );

  // Validate again before writing: anything still to apply must match the plan.
  const open = items.filter((i) => i.status === "pending" || i.status === "running");
  const drift = await withTenant(org, (tx) =>
    driftOf(
      tx,
      run,
      items,
      new Set(open.map((i) => pairKey({ pair: i.pair as Pair, key: i.key }))),
    ),
  );
  if (drift.length) {
    await withTenant(org, (tx) =>
      tx
        .update(transferItems)
        .set({
          status: "skipped",
          skipReason: "drift",
          error: "The set-up changed after the check.",
          updatedAt: new Date(),
        })
        .where(itemIdIn(open.map((i) => i.id))),
    );
    items = await load();
    return finish(
      org,
      run,
      token,
      items,
      queued,
      `The set-up changed after the check: ${drift.slice(0, 3).join(", ")}. Check the changes again.`,
    );
  }

  const [src, dest] = await withTenant(org, async (tx) => {
    const rows = await tx.select().from(businesses);
    const opts = (run.options ?? {}) as { twin?: { source: string; destination: string } };
    const get = (id: string) => rows.find((r) => r.id === id)!;
    return [
      { main: get(run.sourceBusinessId), twin: opts.twin ? get(opts.twin.source) : null },
      { main: get(run.destinationBusinessId), twin: opts.twin ? get(opts.twin.destination) : null },
    ] as const;
  });

  let index = 0;
  for (const item of items) {
    if (item.status !== "pending" && item.status !== "running") continue;
    // Cancel stops between items.
    const [state] = await withTenant(org, (tx) =>
      tx
        .select({
          cancel: transferConfigurations.cancelRequestedAt,
          lease: transferConfigurations.leaseToken,
        })
        .from(transferConfigurations)
        .where(eq(transferConfigurations.id, run.id)),
    );
    if (state?.lease !== token) return "lease_lost";
    if (state?.cancel) {
      await withTenant(org, (tx) =>
        tx
          .update(transferItems)
          .set({ status: "skipped", skipReason: "cancelled", updatedAt: new Date() })
          .where(
            and(
              eq(transferItems.transferId, run.id),
              inArray(transferItems.status, ["pending", "running"]),
            ),
          ),
      );
      return finish(org, run, token, await load(), queued, null, true);
    }

    const byKey = new Map(
      items.map((i) => [
        pairKey({ pair: i.pair as Pair, key: i.key }),
        {
          ...i,
          pair: i.pair as Pair,
          status: i.status as ItemStatus,
          skipReason: i.skipReason ?? undefined,
        },
      ]),
    );
    const twinFailed = items.some(
      (i) => i.pair === "twin" && (i.status === "failed" || i.skipReason === "dependency"),
    );
    const blocker = dependencyBlocker(
      { pair: item.pair as Pair, dependsOn: (item.dependsOn as string[]) ?? [] },
      byKey,
      twinFailed,
    );
    if (blocker) {
      await setItem(org, item.id, {
        status: "skipped",
        skipReason: "dependency",
        error: blocker,
        finishedAt: new Date(),
      });
      items = await load();
      continue;
    }

    await setItem(org, item.id, {
      status: "running",
      attempts: item.attempts + 1,
      startedAt: new Date(),
      error: null,
    });
    const s = item.pair === "twin" ? src.twin! : src.main;
    const d = item.pair === "twin" ? dest.twin! : dest.main;
    try {
      await withTenant(org, async (tx) => {
        const [locked] = await tx
          .select({ status: transferItems.status })
          .from(transferItems)
          .where(eq(transferItems.id, item.id))
          .for("update");
        if (locked?.status !== "running") return;
        const res = await applyItem(tx, item, s, d);
        await hooks.afterWrite?.(index, item);
        await tx
          .update(transferItems)
          .set({
            status: "done",
            resultRef: res.resultRef,
            replaced: res.replaced,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(transferItems.id, item.id));
      });
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      // Only our own messages reach the item; a database error stays in the log.
      const message =
        e instanceof ItemApplyError ? e.message : "We could not copy this item. Try it again.";
      log.error(e, { event: "transfer_item_failed", run: run.id, item: item.key });
      await setItem(org, item.id, {
        status: "failed",
        error: message.slice(0, 1000),
        finishedAt: new Date(),
      });
    }
    index++;
    items = await load();
    const beat = await withTenant(org, (tx) =>
      tx
        .update(transferConfigurations)
        .set({ heartbeatAt: new Date(), counts: counts(items, queued), updatedAt: new Date() })
        .where(
          and(eq(transferConfigurations.id, run.id), eq(transferConfigurations.leaseToken, token)),
        )
        .returning({ id: transferConfigurations.id }),
    );
    if (!beat.length) return "lease_lost";
  }
  return finish(org, run, token, items, queued, null);
}

async function setItem(org: string, id: string, set: Partial<typeof transferItems.$inferInsert>) {
  await withTenant(org, (tx) =>
    tx
      .update(transferItems)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(transferItems.id, id)),
  );
}

async function finish(
  org: string,
  run: RunRow,
  token: string,
  items: ItemRow[],
  queued: Set<string>,
  error: string | null,
  cancelled = false,
): Promise<string> {
  const c = counts(items, queued);
  const status = error ? "failed" : finalStatus(c, cancelled);
  const done = await withTenant(org, async (tx) => {
    const [row] = await tx
      .update(transferConfigurations)
      .set({
        status,
        counts: c,
        error:
          error ?? (c.failed ? `${c.failed} ${c.failed === 1 ? "item" : "items"} failed.` : null),
        finishedAt: new Date(),
        leaseToken: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(transferConfigurations.id, run.id), eq(transferConfigurations.leaseToken, token)),
      )
      .returning();
    if (!row) return null;
    const fields = items.filter((i) => i.kind === "field" && i.status === "done");
    const { writeAuditLog } = await import("@/modules/audit/service");
    await writeAuditLog(
      {
        organizationId: org,
        businessId: run.destinationBusinessId,
        action: row.liveOverride ? "transfer.live_override" : "transfer.run",
        resourceType: "transfer",
        resourceId: run.id,
        before: {
          fields: Object.fromEntries(
            fields.map((f) => [f.key, (f.diff as Array<{ from: unknown }>)?.[0]?.from ?? null]),
          ),
        },
        after: {
          fields: Object.fromEntries(
            fields.map((f) => [f.key, (f.diff as Array<{ to: unknown }>)?.[0]?.to ?? null]),
          ),
          status,
          counts: c,
          failed: items.filter((i) => i.status === "failed").map((i) => i.key),
        },
      },
      tx,
    );
    return row;
  });
  if (!done) return "lease_lost";
  await notify(org, done).catch((e) =>
    log.error(e, { event: "transfer_notify_failed", run: run.id }),
  );
  return status;
}

const STATUS_TEXT: Record<string, string> = {
  succeeded: "is complete",
  partially_failed: "is complete, but some items failed",
  failed: "failed",
  cancelled: "is cancelled",
};

/** Email the member who started the run, once. Mail to staff goes through the deployment mailer. */
async function notify(org: string, run: RunRow) {
  if (!run.startedByUserId) return;
  const claimed = await withTenant(org, (tx) =>
    tx
      .update(transferConfigurations)
      .set({ notifiedAt: new Date() })
      .where(and(eq(transferConfigurations.id, run.id), isNull(transferConfigurations.notifiedAt)))
      .returning({ id: transferConfigurations.id }),
  );
  if (!claimed.length) return;
  const [u] = await systemDb
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, run.startedByUserId));
  const [src] = await systemDb
    .select()
    .from(businesses)
    .where(eq(businesses.id, run.sourceBusinessId));
  const [dest] = await systemDb
    .select()
    .from(businesses)
    .where(eq(businesses.id, run.destinationBusinessId));
  if (!u?.email || !src || !dest) return;
  const c = (run.counts ?? {}) as {
    done?: number;
    failed?: number;
    skipped?: number;
    total?: number;
  };
  const { resolveMailer } = await import("@/modules/emails/mailer-resolver");
  const { escapeHtml } = await import("@/modules/emails/sanitize");
  const base = (config.DASHBOARD_BASE_URL ?? "").replace(/\/$/, "");
  const url = `${base}/businesses/${src.publicId}/transfer?run=${run.id}`;
  const what = STATUS_TEXT[run.status] ?? run.status;
  const subject = `The copy to ${dest.name} ${what}`;
  const lines = [
    `The copy of the set-up from ${src.name} to ${dest.name} ${what}.`,
    `Copied: ${c.done ?? 0}. Failed: ${c.failed ?? 0}. Not copied: ${c.skipped ?? 0}.`,
    `To see each item, open: ${url}`,
  ];
  await resolveMailer(null).send({
    to: u.email,
    cc: null,
    from: config.MAIL_FROM,
    fromName: config.MAIL_FROM_NAME,
    subject,
    text: lines.join("\n\n"),
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(""),
    idempotencyKey: `transfer_done:${run.id}:${run.finishedAt?.toISOString() ?? ""}`,
  });
}

/**
 * Clock pass: a queued or running run whose runner stopped sending heartbeats is queued again.
 * The lease makes a second runner wait, so a re-queue next to a live runner does nothing.
 */
export async function requeueStalledRuns(now: Date): Promise<number> {
  const stale = new Date(now.getTime() - 3 * 60_000);
  const rows = await systemDb
    .select({ id: transferConfigurations.id })
    .from(transferConfigurations)
    .where(
      and(
        eq(transferConfigurations.runKind, "async"),
        inArray(transferConfigurations.status, ["queued", "running"]),
        // An ISO string, not a Date: a Date inside raw sql breaks the driver.
        sql`coalesce(${transferConfigurations.heartbeatAt}, ${transferConfigurations.queuedAt}) < ${stale.toISOString()}::timestamptz`,
      ),
    );
  for (const r of rows)
    await systemDb.execute(
      sql`select graphile_worker.add_job('transfer_run', json_build_object('run', ${r.id}::text), max_attempts => 5, job_key => ${`transfer_run:${r.id}`})`,
    );
  return rows.length;
}
