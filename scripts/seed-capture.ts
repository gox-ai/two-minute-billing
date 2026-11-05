/**
 * Regenerate the demo snapshot `pnpm seed` loads (db/seed-data/demo/{full,small}/).
 *
 *   pnpm seed:capture                       # both variants
 *   pnpm seed:capture --only full           # one variant
 *
 * Each variant runs the live engine generator (`pnpm seed --live`) in a THROWAWAY database
 * (`<db>_seed_<pid>`: create, migrate, geo:seed, generate, dump, drop) — never the dev one.
 * The URL reaches children through their environment only, so the password never hits argv.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { captureSnapshot, fixtureBytes } from "./seed/snapshot";

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
const variants = (only ? [only] : ["full", "small"]).filter((v) => v === "full" || v === "small");
if (!variants.length) {
  console.error("--only takes full or small");
  process.exit(2);
}
const source = process.env.DATABASE_URL;
if (!source) {
  console.error("DATABASE_URL is not set — nothing to derive a throwaway database from.");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sourceDb = new URL(source).pathname.replace(/^\//, "");
const throwaway = `${sourceDb.slice(0, 40)}_seed_${process.pid}`;
const urlFor = (name: string) => {
  const u = new URL(source);
  u.pathname = `/${name}`;
  return u.toString();
};

async function admin(stmt: string): Promise<void> {
  let last: unknown;
  for (const name of ["postgres", sourceDb]) {
    const sql = postgres(urlFor(name), { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(stmt);
      return;
    } catch (e) {
      last = e;
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  }
  throw last;
}
const drop = () =>
  admin(
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${throwaway}' and pid <> pg_backend_pid()`,
  ).then(() => admin(`drop database if exists "${throwaway}"`));

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      cwd: root,
      env: { ...process.env, DATABASE_URL: urlFor(throwaway), LOG_LEVEL: "error" },
    });
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });
}

// The public mirror ships db/baseline.sql, not the migration chain: no journal, no tag.
const journalPath = join(root, "db", "migrations", "meta", "_journal.json");
const latest: { tag: string; when: number } | null = existsSync(journalPath)
  ? ((
      JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: Array<{ tag: string; when: number }>;
      }
    ).entries.at(-1) ?? null)
  : null;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => void drop().finally(() => process.exit(130)));
}
for (const variant of variants) {
  const t0 = Date.now();
  mkdirSync(join(root, "db", "seed-data", "demo"), { recursive: true });
  const report = join(root, "db", "seed-data", "demo", `.capture-${process.pid}.json`);
  console.log(`▶ ${variant}: throwaway database ${throwaway}`);
  await admin(`drop database if exists "${throwaway}"`);
  await admin(`create database "${throwaway}"`);
  try {
    await run("pnpm", ["db:migrate"]);
    await run("pnpm", ["geo:seed"]);
    const tg = Date.now();
    await run("pnpm", [
      "tsx",
      "scripts/seed.ts",
      "--live",
      "--report-json",
      report,
      ...(variant === "small" ? ["--small"] : []),
    ]);
    const generated = (Date.now() - tg) / 1000;
    const rep = JSON.parse(readFileSync(report, "utf8")) as {
      finishedAt: string;
      businesses: Record<string, unknown>;
    };
    const sql = postgres(urlFor(throwaway), { max: 1, onnotice: () => {} });
    try {
      const outDir = join(root, "db", "seed-data", "demo", variant);
      const m = await captureSnapshot(sql, {
        outDir,
        variant,
        capturedAt: new Date(rep.finishedAt),
        migration: latest,
        summaries: rep.businesses,
      });
      console.log(
        `✅ ${variant}: ${m.totalRows} rows in ${m.tables.length} tables, ${(fixtureBytes(outDir) / 1e6).toFixed(2)} MB` +
          ` — generate ${generated.toFixed(0)}s, total ${((Date.now() - t0) / 1000).toFixed(0)}s`,
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    rmSync(report, { force: true });
    await drop();
  }
}
process.exit(0);
