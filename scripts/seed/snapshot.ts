/**
 * The demo book as a snapshot: `capture` dumps what the live generator produced, `load`
 * replays it under a freshly created org so `pnpm seed` takes seconds, not minutes.
 *
 * Layout (`db/seed-data/demo/<variant>/`): `manifest.json` plus one brotli JSON-lines file
 * per table (`tables/<name>.jsonl.br`); each line is `[scope, row]`, scope = "org" or the business key.
 *
 * Load remaps every captured uuid and every globally-unique text id (public ids, test
 * gateway ids) consistently — in typed columns AND inside text/json — and shifts every
 * date/timestamp by one whole-day delta in the business's own timezone.
 */
import { createHash, randomBytes } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants as z } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type postgres from "postgres";

export const DAY = 86_400_000;

/**
 * Never captured. Secrets and machine-bound state (credentials, sessions, keys, idempotency,
 * clock/worker/queue state, delivery outboxes), reference data seeded separately (geo), and
 * reporting that is rebuilt after the shift (metric_daily/metric_windows) or maintained by
 * triggers (due_work). The org, its businesses and gateway accounts are created fresh.
 */
export const EXCLUDED = new Set([
  "organizations",
  "businesses",
  "users",
  "memberships",
  "sessions",
  "auth_tokens",
  "api_keys",
  "gateway_accounts",
  "idempotency_keys",
  "clock_ticks",
  "worker_heartbeats",
  "time_travels",
  "due_work",
  "email_messages",
  "webhook_deliveries",
  "webhook_endpoints",
  "portal_sessions",
  "checkout_sessions",
  "checkout_session_items",
  "hubspot_connections",
  "metric_daily",
  "metric_windows",
  "ops_invariant_results",
  "dependency_health",
  "rate_limit_counters",
  "user_mfa",
  "hubspot_links",
  "hubspot_sync_queue",
  "hubspot_sync_runs",
  "hubspot_conflicts",
  "hubspot_action_executions",
  "hubspot_sync_items",
  "countries",
  "country_subdivisions",
  "country_subdivision_aliases",
  "reference_data_sources",
  "model_price_models",
  "model_prices",
  "model_price_notices",
]);

/**
 * Set up once at a business's genesis, but stamped with wall time (the engine dates config
 * rows by the real clock): clamped to the business's genesis at load.
 */
const CATALOG = new Set([
  "product_groups",
  "products",
  "prices",
  "attached_items",
  "differential_prices",
  "features",
  "plan_entitlements",
  "coupons",
  "coupon_sets",
  "coupon_set_codes",
  "coupon_item_constraints",
  "tax_profiles",
  "tax_regions",
  "tax_rate_components",
  "tax_state_registrations",
  "reason_codes",
  "custom_field_definitions",
  "email_templates",
  "decline_rule_overrides",
]);

/** Text columns that must be unique across tenants, so a second load must not reuse them. */
const GLOBAL_TEXT_IDS: Record<string, string[]> = {
  tmtest_charges: ["charge_id"],
  tmtest_outbound: ["event_id"],
  tmtest_vault: ["vault_id"],
  provider_events: ["provider_event_id"],
};

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
}
export interface ForeignKey {
  table: string;
  cols: string[];
  refTable: string;
  refCols: string[];
}
export interface TableManifest {
  name: string;
  rows: number;
  byScope: Record<string, number>;
  columns: ColumnInfo[];
}
export interface CapturedBusiness {
  key: string;
  id: string;
  publicId: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  row: Record<string, unknown>;
  gatewayAccounts: Array<{ id: string; publicId: string; gatewayKey: string }>;
  summary: unknown;
}
export interface Manifest {
  format: 1;
  variant: string;
  capturedAt: string;
  migration: { tag: string; when: number } | null;
  org: { id: string; publicId: string; row: Record<string, unknown> };
  users: Array<{ id: string; publicId: string | null }>;
  apiKeys: string[];
  businesses: CapturedBusiness[];
  tables: TableManifest[];
  totalRows: number;
}

type Sql = postgres.Sql;

export async function tableColumns(sql: Sql): Promise<Map<string, ColumnInfo[]>> {
  const rows = await sql<
    Array<{ t: string; c: string; ty: string; nn: boolean; d: boolean; g: boolean }>
  >`
    select c.relname t, a.attname c, format_type(a.atttypid, a.atttypmod) ty, a.attnotnull nn,
           (a.atthasdef and a.attgenerated = '') d, a.attgenerated <> '' g
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind in ('r', 'p') and not c.relispartition and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum`;
  const out = new Map<string, ColumnInfo[]>();
  for (const r of rows) {
    const list = out.get(r.t) ?? [];
    list.push({ name: r.c, type: r.ty, notNull: r.nn, hasDefault: r.d, generated: r.g });
    out.set(r.t, list);
  }
  return out;
}

export async function foreignKeys(sql: Sql): Promise<ForeignKey[]> {
  const rows = await sql<Array<{ t: string; cols: string[]; rt: string; rcols: string[] }>>`
    select c.relname t, rc.relname rt,
      (select array_agg(a.attname::text order by k.i) from unnest(con.conkey) with ordinality k(n, i)
         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) cols,
      (select array_agg(a.attname::text order by k.i) from unnest(con.confkey) with ordinality k(n, i)
         join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n) rcols
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_class rc on rc.oid = con.confrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where con.contype = 'f' and not c.relispartition and con.conparentid = 0`;
  return rows.map((r) => ({ table: r.t, cols: r.cols, refTable: r.rt, refCols: r.rcols }));
}

async function primaryKey(sql: Sql, table: string): Promise<string[]> {
  const rows = await sql<Array<{ c: string }>>`
    select a.attname c from pg_index x
    join pg_attribute a on a.attrelid = x.indrelid and a.attnum = any(x.indkey)
    where x.indrelid = ${`public.${table}`}::regclass and x.indisprimary
    order by array_position(x.indkey, a.attnum)`;
  return rows.map((r) => r.c);
}

/** Parents before children; self-references are ordered row by row at load. */
export function topoOrder(tables: string[], fks: ForeignKey[]): string[] {
  const set = new Set(tables);
  const deps = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const fk of fks) {
    if (set.has(fk.table) && set.has(fk.refTable) && fk.table !== fk.refTable)
      deps.get(fk.table)!.add(fk.refTable);
  }
  const out: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (t: string, path: string[]) => {
    if (state.get(t) === 2) return;
    if (state.get(t) === 1) throw new Error(`FK cycle: ${[...path, t].join(" → ")}`);
    state.set(t, 1);
    for (const d of [...deps.get(t)!].sort()) visit(d, [...path, t]);
    state.set(t, 2);
    out.push(t);
  };
  for (const t of [...tables].sort()) visit(t, []);
  return out;
}

export const slug = (name: string) => name.split(" ")[0]!.toLowerCase();

// ─── capture ──────────────────────────────────────────────────────────────────

export async function captureSnapshot(
  sql: Sql,
  input: {
    outDir: string;
    variant: string;
    capturedAt: Date;
    migration: { tag: string; when: number } | null;
    summaries: Record<string, unknown>;
  },
): Promise<Manifest> {
  const cols = await tableColumns(sql);
  const fks = await foreignKeys(sql);
  const [org] = await sql<
    Array<{ row: Record<string, unknown> }>
  >`select row_to_json(o) as row from organizations o`;
  const orgCount = await sql`select count(*)::int n from organizations`;
  if (orgCount[0]!.n !== 1)
    throw new Error(`capture expects exactly one organization, found ${orgCount[0]!.n}`);
  const bizRows = await sql<Array<{ row: Record<string, unknown> }>>`
    select row_to_json(b) as row from businesses b order by b.created_at, b.name`;
  const gwa = await sql<
    Array<{ id: string; public_id: string; gateway_key: string; business_id: string }>
  >`
    select id, public_id, gateway_key, business_id from gateway_accounts order by public_id`;
  const users = await sql<
    Array<{ id: string; public_id: string | null }>
  >`select id, public_id from users`;
  const keys = await sql<Array<{ id: string }>>`select id from api_keys`;

  const scopeOfBiz = new Map<string, string>();
  const businesses: CapturedBusiness[] = bizRows.map(({ row }) => {
    const key = slug(String(row.name));
    scopeOfBiz.set(String(row.id), key);
    return {
      key,
      id: String(row.id),
      publicId: String(row.public_id),
      name: String(row.name),
      currency: (row.default_currency as string | null) ?? null,
      timezone: (row.timezone as string | null) ?? null,
      row,
      gatewayAccounts: gwa
        .filter((g) => g.business_id === row.id)
        .map((g) => ({ id: g.id, publicId: g.public_id, gatewayKey: g.gateway_key })),
      summary: input.summaries[key] ?? null,
    };
  });

  const nonEmpty: string[] = [];
  for (const t of cols.keys()) {
    if (EXCLUDED.has(t)) continue;
    const [r] = await sql.unsafe(`select exists (select 1 from public."${t}") e`);
    if (r!.e) nonEmpty.push(t);
  }
  const order = topoOrder(nonEmpty, fks);

  rmSync(input.outDir, { recursive: true, force: true });
  mkdirSync(join(input.outDir, "tables"), { recursive: true });
  // id → scope, for tables that carry no business_id (attributed through their FK parent).
  const scopeOfId = new Map<string, string>();
  const tables: TableManifest[] = [];
  let totalRows = 0;
  for (const t of order) {
    const tcols = cols.get(t)!;
    const names = new Set(tcols.map((c) => c.name));
    const pk = await primaryKey(sql, t);
    const orderBy = (pk.length ? pk : tcols.filter((c) => !c.generated).map((c) => c.name))
      .map((c) => `"${c}"`)
      .join(", ");
    const rows = await sql.unsafe<Array<{ r: Record<string, unknown> }>>(
      `select row_to_json(x) r from public."${t}" x order by ${orderBy}`,
    );
    const parents = fks.filter(
      (f) => f.table === t && f.cols.length === 1 && f.refCols[0] === "id",
    );
    const lines: Array<[string, Record<string, unknown>]> = [];
    for (const { r } of rows) {
      for (const c of tcols) if (c.generated) delete r[c.name];
      let scope: string | undefined;
      if (names.has("business_id") && r.business_id) scope = scopeOfBiz.get(String(r.business_id));
      for (const f of parents) {
        if (scope) break;
        const v = r[f.cols[0]!];
        if (v) scope = scopeOfId.get(String(v));
      }
      scope ??= "org";
      if (names.has("id") && r.id) scopeOfId.set(String(r.id), scope);
      lines.push([scope, r]);
    }
    const scopeRank = (s: string) => (s === "org" ? -1 : businesses.findIndex((b) => b.key === s));
    lines.sort((a, b) => scopeRank(a[0]) - scopeRank(b[0]));
    const byScope: Record<string, number> = {};
    for (const [s] of lines) byScope[s] = (byScope[s] ?? 0) + 1;
    writeFileSync(
      join(input.outDir, "tables", `${t}.jsonl.br`),
      // Brotli with a 16 MB window: the event payloads repeat across rows, and it packs
      // them ~4x tighter than gzip (decompression stays well under a second).
      brotliCompressSync(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
        params: { [z.BROTLI_PARAM_QUALITY]: 11, [z.BROTLI_PARAM_LGWIN]: 24 },
      }),
    );
    tables.push({
      name: t,
      rows: lines.length,
      byScope,
      columns: tcols.filter((c) => !c.generated),
    });
    totalRows += lines.length;
  }

  const manifest: Manifest = {
    format: 1,
    variant: input.variant,
    capturedAt: input.capturedAt.toISOString(),
    migration: input.migration,
    org: { id: String(org!.row.id), publicId: String(org!.row.public_id), row: org!.row },
    users: users.map((u) => ({ id: u.id, publicId: u.public_id })),
    apiKeys: keys.map((k) => k.id),
    businesses,
    tables,
    totalRows,
  };
  writeFileSync(join(input.outDir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  return manifest;
}

// ─── load ─────────────────────────────────────────────────────────────────────

export function readManifest(dir: string): Manifest | null {
  const p = join(dir, "manifest.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Manifest) : null;
}

export function fixtureBytes(dir: string): number {
  let n = readFileSync(join(dir, "manifest.json")).length;
  for (const f of readdirSync(join(dir, "tables")))
    n += readFileSync(join(dir, "tables", f)).length;
  return n;
}

export function readTable(dir: string, table: string): Array<[string, Record<string, unknown>]> {
  const text = brotliDecompressSync(
    readFileSync(join(dir, "tables", `${table}.jsonl.br`)),
  ).toString("utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as [string, Record<string, unknown>]);
}

/**
 * Schema drift. The fixture is loadable when every captured table + column still exists
 * with the same type, and every column added since is nullable or defaulted (it takes its
 * default, exactly as a pre-migration row would). Anything else is refused.
 */
export function driftProblems(manifest: Manifest, live: Map<string, ColumnInfo[]>): string[] {
  const out: string[] = [];
  for (const t of manifest.tables) {
    const cols = live.get(t.name);
    if (!cols) {
      out.push(`table ${t.name} no longer exists`);
      continue;
    }
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const c of t.columns) {
      const now = byName.get(c.name);
      if (!now) out.push(`${t.name}.${c.name} was dropped`);
      else if (now.generated) out.push(`${t.name}.${c.name} is now generated`);
      else if (now.type !== c.type)
        out.push(`${t.name}.${c.name} changed type ${c.type} → ${now.type}`);
    }
    const captured = new Set(t.columns.map((c) => c.name));
    for (const c of cols) {
      if (!captured.has(c.name) && !c.generated && c.notNull && !c.hasDefault) {
        out.push(`${t.name}.${c.name} is new, NOT NULL and has no default`);
      }
    }
  }
  return out;
}

export interface LoadTargets {
  orgId: string;
  orgPublicId: string;
  userId: string;
  userPublicId: string | null;
  apiKeyId: string;
  businesses: Map<
    string,
    { id: string; publicId: string; gatewayAccounts: Map<string, { id: string; publicId: string }> }
  >;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TOKEN_RE = /[A-Za-z0-9_]{12,}/g;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALNUM = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const formatters = new Map<string, Intl.DateTimeFormat>();
const offsets = new Map<string, number>();

/** Minutes east of UTC for `tz` at `t` (memoised per tz and quarter-hour: offsets change on those). */
function tzOffset(t: number, tz: string): number {
  const memo = `${tz}|${Math.floor(t / 900_000)}`;
  const hit = offsets.get(memo);
  if (hit !== undefined) return hit;
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  const base = Math.floor(t / 900_000) * 900_000;
  const p = f.formatToParts(new Date(base));
  const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
  const off =
    (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - base) /
    60_000;
  offsets.set(memo, off);
  return off;
}

/** Same wall-clock time, `days` later, in `tz` — mirrors the SQL shift for typed columns. */
export function shiftInstant(t: number, days: number, tz: string): number {
  const s = t + days * DAY;
  return s + (tzOffset(t, tz) - tzOffset(s, tz)) * 60_000;
}

function shiftDate(d: string, days: number): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + days);
  return x.toISOString().slice(0, 10);
}

export class Remapper {
  readonly uuid = new Map<string, string>();
  readonly token = new Map<string, string>();
  private readonly salt = randomBytes(16).toString("hex");
  /** `str` results; the same ids recur across thousands of rows. Cleared on every add. */
  private readonly memo = new Map<string, string>();

  private hash(v: string): Buffer {
    return createHash("sha256").update(this.salt).update(v).digest();
  }

  /** Every captured uuid gets a fresh one; `fixed` pins the org/business/gateway/user ids. */
  addUuid(old: string, fixed?: string): void {
    if (this.uuid.has(old)) return;
    this.memo.clear();
    if (fixed) return void this.uuid.set(old, fixed);
    const h = this.hash(old).toString("hex");
    this.uuid.set(
      old,
      `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`,
    );
  }

  /** A text id: keep its `prefix_`, replace the random tail with one of the same length. */
  addToken(old: string, fixed?: string): void {
    if (this.token.has(old) || old.length < 12) return;
    this.memo.clear();
    if (fixed) return void this.token.set(old, fixed);
    const cut = old.lastIndexOf("_") + 1;
    const tail = old.length - cut;
    const h = this.hash(old);
    let s = "";
    for (let i = 0; i < tail; i++) s += ALNUM[h[i % h.length]! % ALNUM.length];
    this.token.set(old, old.slice(0, cut) + s);
  }

  str(v: string): string {
    if (v.length < 12) return v;
    const hit = this.memo.get(v);
    if (hit !== undefined) return hit;
    let out = v.includes("-") ? v.replace(UUID_RE, (m) => this.uuid.get(m) ?? m) : v;
    if (out.length >= 12) out = out.replace(TOKEN_RE, (m) => this.token.get(m) ?? m);
    this.memo.set(v, out);
    return out;
  }
}

/** Walk a json value: remap ids in every string; shift whole-value dates when `shift` is set. */
function walk(v: unknown, rm: Remapper, shift: { days: number; tz: string } | null): unknown {
  if (typeof v === "string") {
    let s = rm.str(v);
    if (shift && shift.days !== 0 && s.length >= 10 && s.length <= 35) {
      if (ISO_TS_RE.test(s))
        s = new Date(shiftInstant(Date.parse(s), shift.days, shift.tz)).toISOString();
      else if (ISO_DATE_RE.test(s)) s = shiftDate(s, shift.days);
    }
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, rm, shift));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[rm.str(k)] = walk(x, rm, shift);
    return o;
  }
  return v;
}

const TEMPORAL = /^(timestamp|date)/;

/** SQL for one column out of `json_populate_recordset` — temporal columns shift in the business tz. */
function columnExpr(c: ColumnInfo, days: number, tz: string): string {
  const id = `r."${c.name}"`;
  if (c.type === "timestamp with time zone")
    return `((${id} at time zone '${tz}') + interval '${days} days') at time zone '${tz}'`;
  if (c.type.startsWith("timestamp")) return `${id} + interval '${days} days'`;
  if (c.type === "date") return `${id} + ${days}`;
  return id;
}

export function transformRow(
  row: Record<string, unknown>,
  cols: ColumnInfo[],
  rm: Remapper,
  shift: { days: number; tz: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) {
    const v = row[c.name];
    if (v === undefined) continue;
    out[c.name] = TEMPORAL.test(c.type)
      ? v
      : walk(v, rm, /^(json|text|character)/.test(c.type) ? shift : null);
  }
  return out;
}

/** Self-referencing tables (e.g. an invoice that supersedes another): parents first. */
function orderSelfRefs(
  rows: Array<Record<string, unknown>>,
  selfCols: string[],
): Array<Record<string, unknown>> {
  if (!selfCols.length) return rows;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const done = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  const visit = (r: Record<string, unknown>) => {
    const id = String(r.id);
    if (done.has(id)) return;
    done.add(id);
    for (const c of selfCols) {
      const p = r[c] ? byId.get(String(r[c])) : undefined;
      if (p) visit(p);
    }
    out.push(r);
  };
  rows.forEach(visit);
  return out;
}

/**
 * Insert one scope's rows, table by table in FK order, with multi-row
 * `insert … select from json_populate_recordset` statements.
 */
export async function insertScope(
  tx: postgres.TransactionSql,
  input: {
    order: string[];
    rows: Map<string, Array<Record<string, unknown>>>;
    columns: Map<string, ColumnInfo[]>;
    fks: ForeignKey[];
    days: number;
    tz: string;
    /** Catalog/config rows record wall time, not the simulated one: never date them after this. */
    notAfter?: string;
  },
): Promise<number> {
  let n = 0;
  for (const t of input.order) {
    let rows = input.rows.get(t);
    if (!rows?.length) continue;
    // A serial ordinal is re-drawn from the target's sequence; rows are inserted in captured order.
    const cols = input.columns
      .get(t)!
      .filter((c) => !(t === "invoice_line_items" && c.name === "seq"));
    rows = orderSelfRefs(
      rows,
      input.fks
        .filter((f) => f.table === t && f.refTable === t && f.cols.length === 1)
        .map((f) => f.cols[0]!),
    );
    const list = cols.map((c) => `"${c.name}"`).join(", ");
    const exprs = cols
      .map((c) => {
        const e = columnExpr(c, input.days, input.tz);
        return input.notAfter &&
          CATALOG.has(t) &&
          (c.name === "created_at" || c.name === "updated_at")
          ? `least(${e}, '${input.notAfter}'::timestamptz)`
          : e;
      })
      .join(", ");
    const stmt = `insert into public."${t}" (${list}) select ${exprs} from json_populate_recordset(null::public."${t}", $1::text::json) r`;
    const CHUNK = 2000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx.unsafe(stmt, [JSON.stringify(rows.slice(i, i + CHUNK))]);
    }
    n += rows.length;
  }
  return n;
}

export { columnExpr };
export const isGlobalTextId = (t: string, c: string) =>
  c === "public_id" || (GLOBAL_TEXT_IDS[t]?.includes(c) ?? false);
