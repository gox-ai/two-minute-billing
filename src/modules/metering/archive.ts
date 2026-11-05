import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { config } from "@/platform/config";
import { systemDb } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { addMonths, dropPartition, listPartitions, monthStart } from "./partitions";
import { rowsOf } from "./usage-sql";

const log = createLogger("metering.archive");

/**
 * Where expired event partitions go before they are dropped. `put` stores a finished file;
 * `size` reads back what the store holds, so a partition is dropped only after the object
 * proves complete.
 */
export interface ArchiveTarget {
  readonly describe: string;
  put(key: string, file: string, bytes: number): Promise<void>;
  size(key: string): Promise<number | null>;
  get(key: string): Promise<Readable>;
}

/** A local directory (self-host, tests). */
export class DirectoryArchiveTarget implements ArchiveTarget {
  constructor(readonly root: string) {}
  get describe() {
    return `file://${this.root}`;
  }
  async put(key: string, file: string): Promise<void> {
    const dest = join(this.root, key);
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(createReadStream(file), createWriteStream(dest));
  }
  async size(key: string): Promise<number | null> {
    try {
      return (await stat(join(this.root, key))).size;
    } catch {
      return null;
    }
  }
  async get(key: string): Promise<Readable> {
    return createReadStream(join(this.root, key));
  }
}

/** S3-compatible storage, with the object store's credentials and endpoint. */
export class S3ArchiveTarget implements ArchiveTarget {
  constructor(
    readonly bucket: string,
    readonly prefix: string,
  ) {}
  get describe() {
    return `s3://${this.bucket}/${this.prefix}`;
  }
  private keyOf(key: string) {
    return this.prefix ? `${this.prefix.replace(/\/$/, "")}/${key}` : key;
  }
  private async client() {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({
      region: config.OBJECT_STORE_REGION,
      endpoint:
        config.OBJECT_STORE_ENDPOINT ??
        (config.R2_ACCOUNT_ID
          ? `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
          : undefined),
      forcePathStyle: config.OBJECT_STORE_FORCE_PATH_STYLE === "TRUE",
      ...(config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: config.R2_ACCESS_KEY_ID,
              secretAccessKey: config.R2_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }
  async put(key: string, file: string, bytes: number): Promise<void> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (
      await this.client()
    ).send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.keyOf(key),
        Body: createReadStream(file),
        ContentLength: bytes,
        ContentType: "application/gzip",
      }),
    );
  }
  async size(key: string): Promise<number | null> {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      const r = await (
        await this.client()
      ).send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.keyOf(key) }));
      return r.ContentLength ?? null;
    } catch {
      return null;
    }
  }
  async get(key: string): Promise<Readable> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const r = await (
      await this.client()
    ).send(new GetObjectCommand({ Bucket: this.bucket, Key: this.keyOf(key) }));
    return r.Body as Readable;
  }
}

/** `s3://bucket/prefix` or `file:///abs/path` (a bare absolute path also works). */
export function archiveTargetFromUrl(url: string): ArchiveTarget {
  if (url.startsWith("s3://")) {
    const u = new URL(url);
    return new S3ArchiveTarget(u.hostname, u.pathname.replace(/^\//, ""));
  }
  if (url.startsWith("file://")) return new DirectoryArchiveTarget(fileURLToPath(url));
  if (url.startsWith("/")) return new DirectoryArchiveTarget(url);
  throw new Error(`USAGE_ARCHIVE_URL must start with s3:// or file://, got ${url.split(":")[0]}:`);
}

let targetOverride: ArchiveTarget | null | undefined;
/** Tests: a target (or `null` = none configured). `undefined` restores the config. */
export function setArchiveTargetForTests(t: ArchiveTarget | null | undefined): void {
  targetOverride = t;
}

export function configuredArchiveTarget(): ArchiveTarget | null {
  if (targetOverride !== undefined) return targetOverride;
  return config.USAGE_ARCHIVE_URL ? archiveTargetFromUrl(config.USAGE_ARCHIVE_URL) : null;
}

export const archiveObjectKey = (partition: string, month: Date) =>
  `usage_events/${monthStart(month).toISOString().slice(0, 7)}/${partition}.csv.gz`;

/** COPY streams need a connection of their own; the pooled drizzle client has no COPY. */
function copyClient() {
  return postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} });
}

const PARTITION_RE = /^usage_events_y\d{4}m\d{2}$/;

export interface ArchiveRecord {
  partition: string;
  rows: number;
  bytes: number;
  sha256: string;
  objectKey: string;
}

/**
 * Archive one event partition: `COPY … TO STDOUT` (CSV with a header) through gzip to a
 * temporary file, SHA-256 taken while streaming, the file stored, the stored size checked,
 * then the `usage_archives` row written. Throws on any failed step; the partition stays.
 */
export async function archiveEventPartition(
  partition: string,
  month: Date,
  target: ArchiveTarget,
): Promise<ArchiveRecord> {
  if (!PARTITION_RE.test(partition)) throw new Error(`not a usage_events partition: ${partition}`);
  const objectKey = archiveObjectKey(partition, month);
  const dir = await mkdtemp(join(tmpdir(), "usage-archive-"));
  const file = join(dir, `${partition}.csv.gz`);
  const client = copyClient();
  try {
    const [{ n }] = (await client.unsafe(
      `select count(*)::bigint::text as n from public.${partition}`,
    )) as unknown as [{ n: string }];
    const hash = createHash("sha256");
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    const copy = await client
      .unsafe(
        `copy (select * from public.${partition} order by id) to stdout with (format csv, header true)`,
      )
      .readable();
    await pipeline(copy, createGzip(), tap, createWriteStream(file));
    const bytes = (await stat(file)).size;
    const sha256 = hash.digest("hex");
    await target.put(objectKey, file, bytes);
    const stored = await target.size(objectKey);
    if (stored !== bytes)
      throw new Error(
        `archived object ${objectKey} holds ${stored ?? "nothing"} bytes, expected ${bytes}`,
      );
    await systemDb.execute(sql`
      insert into usage_archives (partition_name, month, row_count, byte_count, sha256, object_key)
      values (${partition}, ${monthStart(month).toISOString().slice(0, 10)}::date, ${n}::bigint,
              ${bytes}, ${sha256}, ${objectKey})
      on conflict (partition_name) do update set month = excluded.month,
        row_count = excluded.row_count, byte_count = excluded.byte_count,
        sha256 = excluded.sha256, object_key = excluded.object_key, archived_at = now(),
        dropped_at = null`);
    return { partition, rows: Number(n), bytes, sha256, objectKey };
  } finally {
    await client.end({ timeout: 5 });
    await rm(dir, { recursive: true, force: true });
  }
}

export class UsageArchiveTargetMissingError extends Error {
  constructor(readonly expired: string[]) {
    super(
      `${expired.length} usage event partition(s) are past retention and kept: USAGE_ARCHIVE_URL is not set. ` +
        `Set it, or set USAGE_ARCHIVE_MODE=drop to delete them with no archive.`,
    );
    this.name = "UsageArchiveTargetMissingError";
  }
}

export class UsageArchiveFailedError extends Error {
  constructor(readonly failed: string[]) {
    super(`Usage partitions could not be archived and stay live: ${failed.join(", ")}`);
    this.name = "UsageArchiveFailedError";
  }
}

export interface RetentionRun {
  archived: string[];
  dropped: string[];
  rollupsDropped: string[];
  kept: string[];
}

/**
 * Keep `USAGE_EVENTS_LIVE_MONTHS` months live (the current one included). Each older event
 * partition is archived, then dropped; a failure leaves it live for the next day. With no
 * target nothing is dropped. A rollup partition drops once its month's events are gone
 * (derived data; rebuildable from restored events). Throws after the loop when anything
 * was kept, so the job run records a failure the back-office alerts on.
 */
export async function runUsageRetention(now: Date = new Date()): Promise<RetentionRun> {
  const oldestKept = addMonths(monthStart(now), -(config.USAGE_EVENTS_LIVE_MONTHS - 1));
  const run: RetentionRun = { archived: [], dropped: [], rollupsDropped: [], kept: [] };
  const expired = (await listPartitions("usage_events")).filter((p) => p.month < oldestKept);
  const mode = config.USAGE_ARCHIVE_MODE;
  const target = mode === "drop" ? null : configuredArchiveTarget();
  const failed: string[] = [];
  for (const p of expired) {
    if (mode === "drop") {
      await dropPartition("usage_events", p.month);
      run.dropped.push(p.name);
      log.warn("usage partition dropped without archive", {
        event: "usage_partition_dropped",
        partition: p.name,
        mode,
      });
      continue;
    }
    if (!target) {
      run.kept.push(p.name);
      continue;
    }
    try {
      const [prior] = rowsOf<{ byte_count: string; object_key: string }>(
        await systemDb.execute(sql`select byte_count::text, object_key from usage_archives
          where partition_name = ${p.name} and dropped_at is null`),
      );
      const reuse = prior && (await target.size(prior.object_key)) === Number(prior.byte_count);
      if (!reuse) {
        const rec = await archiveEventPartition(p.name, p.month, target);
        run.archived.push(p.name);
        log.info("usage partition archived", {
          event: "usage_partition_archived",
          ...rec,
          target: target.describe,
        });
      }
      await dropPartition("usage_events", p.month);
      await systemDb.execute(
        sql`update usage_archives set dropped_at = now() where partition_name = ${p.name}`,
      );
      run.dropped.push(p.name);
    } catch (e) {
      failed.push(p.name);
      run.kept.push(p.name);
      log.error(e, { event: "usage_archive_failed", partition: p.name });
    }
  }
  const liveEventMonths = new Set(
    (await listPartitions("usage_events")).map((p) => p.month.getTime()),
  );
  for (const r of await listPartitions("usage_rollups")) {
    if (r.month >= oldestKept || liveEventMonths.has(r.month.getTime())) continue;
    await dropPartition("usage_rollups", r.month);
    run.rollupsDropped.push(r.name);
  }
  // Rollups changed: the read cache's key moves (0468).
  if (run.rollupsDropped.length)
    await systemDb.execute(
      sql`update usage_rollup_state set rollup_version = nextval('usage_rollup_version_seq')`,
    );
  if (failed.length) throw new UsageArchiveFailedError(failed);
  if (run.kept.length) {
    log.warn("usage partitions kept: no archive target", {
      event: "usage_archive_target_missing",
      partitions: run.kept,
    });
    throw new UsageArchiveTargetMissingError(run.kept);
  }
  return run;
}
