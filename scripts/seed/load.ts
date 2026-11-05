/**
 * `pnpm seed` (default): replay the captured demo book under a freshly created org.
 *
 * The org, login, dashboard key and the three test businesses (with their auto-provisioned
 * TM Test Gateway accounts) are created by the real services on THIS machine; the captured
 * rows are then remapped onto them, shifted so the history ends today, and bulk-inserted.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { config } from "@/platform/config";
import { withTenant } from "@/platform/db";
import { organizations } from "@db/schema";
import { signup } from "@/modules/auth/service";
import { createBusiness } from "@/modules/tenancy/service";
import { listGatewayAccounts, updateGatewayAccount } from "@/modules/gateway/service";
import { scanMetricDrift } from "@/modules/metrics/daily/maintenance";
import { COARSE_GRAINS } from "@/modules/metrics/daily/bulk-fill";
import { invalidateSeriesCache } from "@/modules/metrics/daily/series-cache";
import { refreshMovementSummary } from "@/modules/metrics/reports/movement-matview";
import { zonedDayString } from "@/platform/timezones";
import {
  DAY,
  Remapper,
  columnExpr,
  driftProblems,
  foreignKeys,
  insertScope,
  isGlobalTextId,
  readTable,
  shiftInstant,
  tableColumns,
  topoOrder,
  transformRow,
  type Manifest,
} from "./snapshot";
import { summarise, type BizSummary } from "./reporting";
import type { SeededBusiness } from "./live";
import type { FillJob } from "./fill-days";

export type LoadRefusal = { ok: false; reason: string };
export interface Loaded {
  ok: true;
  secret: string;
  orgPublicId: string;
  businesses: SeededBusiness[];
  shiftDays: Record<string, number>;
  rows: number;
  timings: Record<string, number>;
}

async function latestMigration(sql: postgres.Sql): Promise<number | null> {
  const r = await sql`select max(created_at)::bigint w from drizzle.__drizzle_migrations`.catch(
    () => [{ w: null }],
  );
  return r[0]!.w == null ? null : Number(r[0]!.w);
}

/**
 * Whole days to add so the captured instant lands at or just before `now` in the business's
 * own wall clock. Never after: a row dated in the future would read as scheduled, and a
 * renewal the capture already made would be early.
 */
export function shiftDaysFor(capturedAt: number, now: number, tz: string): number {
  let d = Math.floor((now - capturedAt) / DAY);
  while (shiftInstant(capturedAt, d, tz) > now) d--;
  return d;
}

export async function loadSnapshot(input: {
  dir: string;
  manifest: Manifest;
  login: { email: string; password: string; name: string };
}): Promise<Loaded | LoadRefusal> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (k: string, since: number) => (timings[k] = Date.now() - since);
  const m = input.manifest;
  const sql = postgres(config.DATABASE_URL, { max: 4, onnotice: () => {} });
  try {
    // ── drift guard ───────────────────────────────────────────────────────────
    const liveCols = await tableColumns(sql);
    const applied = await latestMigration(sql);
    const problems = driftProblems(m, liveCols);
    if (problems.length) {
      return {
        ok: false,
        reason:
          `the fixture was captured at migration ${m.migration?.tag ?? "baseline"} and no longer fits this schema:\n` +
          problems
            .slice(0, 8)
            .map((p) => `    · ${p}`)
            .join("\n") +
          (problems.length > 8 ? `\n    · …and ${problems.length - 8} more` : ""),
      };
    }
    // A baseline install (`db/baseline.sql`) has no migration history: the column check
    // above is then the whole test, and it has passed.
    if (applied != null && applied !== (m.migration?.when ?? null)) {
      console.log(
        `⚠ fixture captured at ${m.migration?.tag ?? "baseline"}; this database has a different latest migration.` +
          " Columns added since are nullable or defaulted, so it loads — refresh it with `pnpm seed:capture`.",
      );
    }
    const [geo] = await sql`select count(*)::int n from countries`;
    if (!geo!.n) throw new Error("countries table is empty — run `pnpm geo:seed` first");

    // ── fresh org + businesses, via the real services ────────────────────────
    const ts = Date.now();
    const s = await signup({
      ...input.login,
      organizationName: String(m.org.row.name ?? "Demo Org"),
    });
    const orgId = s.user.organizationId;
    await withTenant(orgId, (tx) =>
      tx.update(organizations).set({ isPlatform: true }).where(eq(organizations.id, orgId)),
    );
    const [key] =
      await sql`select id from api_keys where organization_id = ${orgId} order by created_at desc limit 1`;
    const rm = new Remapper();
    rm.addUuid(m.org.id, orgId);
    rm.addToken(m.org.publicId, s.user.organizationPublicId);
    for (const u of m.users) {
      rm.addUuid(u.id, s.user.userId);
      if (u.publicId && s.user.userPublicId) rm.addToken(u.publicId, s.user.userPublicId);
    }
    for (const k of m.apiKeys) rm.addUuid(k, String(key!.id));
    const fresh = new Map<string, { id: string; publicId: string; tz: string }>();
    for (const b of m.businesses) {
      const biz = await createBusiness({
        organizationId: orgId,
        name: b.name,
        defaultCurrency: b.currency ?? "USD",
        livemode: "test",
        ...(b.timezone ? { timezone: b.timezone } : {}),
      });
      fresh.set(b.key, { id: biz.id, publicId: biz.publicId, tz: b.timezone ?? "UTC" });
      // Same as the generator: magic amounts would park renewals whose total ends in …13.
      for (const gwa of await listGatewayAccounts(orgId, biz.id))
        if (gwa.gatewayKey === "tmtest")
          await updateGatewayAccount({
            organizationId: orgId,
            businessId: biz.id,
            gwaPublicId: gwa.publicId,
            credentials: { magic_amounts: false },
          });
      rm.addUuid(b.id, biz.id);
      rm.addToken(b.publicId, biz.publicId);
      const gwas = await sql<Array<{ id: string; public_id: string; gateway_key: string }>>`
        select id, public_id, gateway_key from gateway_accounts where business_id = ${biz.id}`;
      for (const g of b.gatewayAccounts) {
        const f = gwas.find((x) => x.gateway_key === g.gatewayKey);
        if (!f)
          throw new Error(
            `${b.name}: no fresh ${g.gatewayKey} gateway account to map ${g.publicId} onto`,
          );
        rm.addUuid(g.id, f.id);
        rm.addToken(g.publicId, f.public_id);
      }
    }
    mark("org+businesses", ts);

    // ── read + remap + shift ──────────────────────────────────────────────────
    const tr = Date.now();
    const now = Date.now();
    const capturedAt = Date.parse(m.capturedAt);
    const shiftDays: Record<string, number> = { org: shiftDaysFor(capturedAt, now, "UTC") };
    for (const b of m.businesses)
      shiftDays[b.key] = shiftDaysFor(capturedAt, now, fresh.get(b.key)!.tz);
    const tzOf = (scope: string) => (scope === "org" ? "UTC" : fresh.get(scope)!.tz);

    // metric_daily is rebuilt by child processes (the day fill is CPU-bound JS). They boot
    // now, while the rows are remapped and inserted, and pull jobs once the rows are in.
    const at = new Date();
    const plans = m.businesses.map((b) => {
      const f = fresh.get(b.key)!;
      const genesis = shiftInstant(Date.parse(String(b.row.created_at)), shiftDays[b.key]!, f.tz);
      return { f, days: daysThroughYesterday(new Date(genesis), f.tz) };
    });
    // ~100 days a child: below that, booting one costs more than it saves.
    const total = plans.reduce((a, p) => a + p.days.length, 0);
    const workers = Math.max(1, Math.min(Math.ceil(total / 100), 10, availableParallelism() - 2));
    const pool = fillPool(workers);

    const raw = new Map<string, Array<[string, Record<string, unknown>]>>();
    for (const t of m.tables) {
      const rows = readTable(input.dir, t.name);
      raw.set(t.name, rows);
      const idCol = t.columns.find((c) => c.name === "id" && c.type === "uuid");
      const textIds = t.columns.filter((c) => isGlobalTextId(t.name, c.name)).map((c) => c.name);
      for (const [, r] of rows) {
        if (idCol && typeof r.id === "string") rm.addUuid(r.id);
        for (const c of textIds) if (typeof r[c] === "string") rm.addToken(r[c] as string);
      }
    }
    const byScope = new Map<string, Map<string, Array<Record<string, unknown>>>>();
    for (const t of m.tables) {
      for (const [scope, r] of raw.get(t.name)!) {
        const shift = { days: shiftDays[scope]!, tz: tzOf(scope) };
        const out = transformRow(r, t.columns, rm, shift);
        const tables = byScope.get(scope) ?? new Map<string, Array<Record<string, unknown>>>();
        const list = tables.get(t.name) ?? [];
        list.push(out);
        tables.set(t.name, list);
        byScope.set(scope, tables);
      }
    }
    // `seq` is re-drawn from this database's sequence, so insert in captured seq order.
    for (const tables of byScope.values()) {
      tables.get("invoice_line_items")?.sort((a, b) => Number(a.seq) - Number(b.seq));
    }
    mark("remap+shift", tr);

    // ── bulk insert: the org scope, then every business in its own transaction ─
    const ti = Date.now();
    const fks = await foreignKeys(sql);
    const order = topoOrder(
      m.tables.map((t) => t.name),
      fks,
    );
    const columns = new Map(m.tables.map((t) => [t.name, t.columns]));
    // Captured settings onto the fresh rows (ids, keys and mode stay the fresh ones).
    const patch = async (
      tx: postgres.TransactionSql,
      table: string,
      id: string,
      row: Record<string, unknown>,
      scope: string,
    ) => {
      const keep = new Set([
        "id",
        "organization_id",
        "public_id",
        "livemode",
        "row_version",
        "is_platform",
      ]);
      const cols = liveCols
        .get(table)!
        .filter((c) => !c.generated && !keep.has(c.name) && c.name in row);
      const shift = { days: shiftDays[scope]!, tz: tzOf(scope) };
      const r = transformRow(row, cols, rm, shift);
      await tx.unsafe(
        `update public."${table}" t set (${cols.map((c) => `"${c.name}"`).join(", ")}) = ` +
          `(select ${cols.map((c) => columnExpr(c, shift.days, shift.tz)).join(", ")} ` +
          `from json_populate_record(null::public."${table}", $1::text::json) r) where t.id = $2`,
        [JSON.stringify(r), id],
      );
    };
    let rows = 0;
    await sql.begin(async (tx) => {
      await patch(tx, "organizations", orgId, m.org.row, "org");
      const tables = byScope.get("org");
      if (tables)
        rows += await insertScope(tx, {
          order,
          rows: tables,
          columns,
          fks,
          days: shiftDays.org!,
          tz: "UTC",
        });
    });
    const perBiz = await Promise.all(
      m.businesses.map((b) =>
        sql.begin(async (tx) => {
          const f = fresh.get(b.key)!;
          await patch(tx, "businesses", f.id, b.row, b.key);
          const tables = byScope.get(b.key);
          const genesis = shiftInstant(
            Date.parse(String(b.row.created_at)),
            shiftDays[b.key]!,
            f.tz,
          );
          return tables
            ? insertScope(tx, {
                order,
                rows: tables,
                columns,
                fks,
                days: shiftDays[b.key]!,
                tz: f.tz,
                notAfter: new Date(genesis).toISOString(),
              })
            : 0;
        }),
      ),
    );
    rows += perBiz.reduce((a, n) => a + n, 0);
    mark("insert", ti);

    // ── reporting: metric_daily from the shifted book (snapshots came with it) ─
    const tp = Date.now();
    await pool.run(
      fillJobs(
        orgId,
        at,
        plans.map(({ f, days }) => ({ businessId: f.id, timezone: f.tz, days })),
        workers,
      ),
    );
    for (const { f } of plans) invalidateSeriesCache(f.id);
    await refreshMovementSummary();
    // ops_invariant_results is not in the snapshot; record one scan so "never run" clears.
    await scanMetricDrift();
    mark("reporting", tp);

    const businesses: SeededBusiness[] = [];
    for (const b of m.businesses) {
      const f = fresh.get(b.key)!;
      const summary: BizSummary = await summarise(f.id);
      const showcase = ((b.summary as { showcase?: string[] } | null)?.showcase ?? []).map((l) =>
        rm.str(l),
      );
      businesses.push({ name: b.name, publicId: f.publicId, summary, showcase });
    }
    timings.total = Date.now() - t0;
    return {
      ok: true,
      secret: s.dashboardKeySecret,
      orgPublicId: s.user.organizationPublicId,
      businesses,
      shiftDays,
      rows,
      timings,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Business-local calendar days from `from` through yesterday. */
function daysThroughYesterday(from: Date, tz: string): string[] {
  const out: string[] = [];
  const d = new Date(`${zonedDayString(from, tz)}T00:00:00.000Z`);
  const today = zonedDayString(new Date(), tz);
  while (d.toISOString().slice(0, 10) < today) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Every job that rebuilds `metric_daily` for these businesses: one per coarse grain, then
 * the days in slices of about two jobs per worker. Each job pays one load of the standing
 * reads (~0.5 s), so fewer, longer jobs win until the pool can no longer balance its tail.
 * Coarse jobs go first — the largest units, kept off the tail.
 */
export function fillJobs(
  organizationId: string,
  now: Date,
  plans: Array<{ businessId: string; timezone: string; days: string[] }>,
  workers: number,
): FillJob[] {
  const total = plans.reduce((a, p) => a + p.days.length, 0);
  const slice = Math.max(1, Math.ceil(total / (2 * workers)));
  const base = (p: (typeof plans)[number]) => ({
    organizationId,
    businessId: p.businessId,
    timezone: p.timezone,
    now: now.toISOString(),
  });
  const jobs: FillJob[] = [];
  for (const grain of COARSE_GRAINS)
    for (const p of plans)
      if (p.days.length) jobs.push({ ...base(p), days: p.days, coarse: grain });
  const slices = plans.map((p) => {
    const out: FillJob[] = [];
    for (let i = 0; i < p.days.length; i += slice)
      out.push({ ...base(p), days: p.days.slice(i, i + slice) });
    return out;
  });
  for (let i = 0; slices.some((s) => i < s.length); i++)
    for (const s of slices) if (s[i]) jobs.push(s[i]!);
  return jobs;
}

const FILL_WORKER = join(dirname(fileURLToPath(import.meta.url)), "fill-days.ts");

/** `n` booted fill workers; `run` hands each job to whichever worker is free, then stops them. */
export function fillPool(n: number): { run: (jobs: FillJob[]) => Promise<void> } {
  const workers = Array.from({ length: n }, () => {
    const child = spawn(process.execPath, ["--import", "tsx", FILL_WORKER], {
      stdio: ["pipe", "pipe", "inherit"],
      // One of up to ten: keep its pool small.
      env: { ...process.env, DB_POOL_MAX: "2", LOG_LEVEL: process.env.LOG_LEVEL ?? "error" },
    });
    const replies = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const exited = new Promise<void>((resolve, reject) =>
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`metric_daily fill child exited ${code}`)),
      ),
    );
    // Surfaced through `run`; never an unhandled rejection before it is awaited.
    exited.catch(() => {});
    const send = async (job: FillJob) => {
      child.stdin!.write(JSON.stringify(job) + "\n");
      const r = await Promise.race([replies.next(), exited.then(() => ({ done: true }))]);
      if (r.done) await exited.then(() => Promise.reject(new Error("fill child exited mid-job")));
    };
    return { child, send, exited };
  });
  return {
    run: async (jobs) => {
      const queue = [...jobs];
      await Promise.all(
        workers.map(async (w) => {
          try {
            for (let job = queue.shift(); job; job = queue.shift()) await w.send(job);
          } finally {
            w.child.stdin!.end();
          }
          await w.exited;
        }),
      );
    },
  };
}
