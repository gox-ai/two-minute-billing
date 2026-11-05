/**
 * verify:selfhost-init — the self-hosted `init` step (src/platform/selfhost/init.ts), run as
 * the Docker image runs it: a child process against an EMPTY database, configured by env.
 *
 * What it pins:
 *  - a refused admin password exits 1, names the rule, never prints the password, creates nothing,
 *  - two inits at once both exit 0: one baseline record, one org, one owner, one bootstrap key,
 *  - a re-run is a no-op and never changes the owner's password (it logs that it ignored it),
 *  - another email on a database with users creates nothing,
 *  - a key held by another organization, and an `sk_all_` key, exit 1,
 *  - no run prints the admin password or the API key.
 *
 *   pnpm verify:selfhost-init
 *
 * Builds one throwaway database next to DATABASE_URL's and drops it.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { hashApiKey } from "@/platform/api-key";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}
const dbName = `${new URL(source).pathname.slice(1).slice(0, 36)}_shinit_${process.pid}`;
const at = (db: string) => {
  const u = new URL(source);
  u.pathname = `/${db}`;
  return u.toString();
};

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, !cond && detail !== undefined ? JSON.stringify(detail) : "");
}

const PASSWORD = `Pw-${randomBytes(18).toString("base64url")}9Z`;
const KEY = `sk_test_${randomBytes(24).toString("base64url")}`;
const EMAIL = "owner@example.com";

function init(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/platform/selfhost/init.ts"], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: at(dbName),
        MIGRATION_DATABASE_URL: at(dbName),
        PASSWORD_BREACH_CHECK: "FALSE",
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}
const leaks = (out: string) => out.includes(PASSWORD) || out.includes(KEY);

const admin = postgres(at("postgres"), { max: 1, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE "${dbName}"`);
const db = postgres(at(dbName), { max: 1, onnotice: () => {} });
const count = async (table: string) =>
  (await db.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`))[0]!.n;

try {
  const bootstrap = {
    TMBILLING_INIT_ADMIN_EMAIL: EMAIL,
    TMBILLING_INIT_ORG_NAME: "Self-host Org",
    TMBILLING_INIT_ADMIN_PASSWORD: PASSWORD,
    TMBILLING_INIT_API_KEY: KEY,
  };

  const weak = await init({ ...bootstrap, TMBILLING_INIT_ADMIN_PASSWORD: "password" });
  ok("a refused password exits 1", weak.code === 1, weak.out.slice(-400));
  ok(
    "the refusal names the setting and not the password",
    weak.out.includes("TMBILLING_INIT_ADMIN_PASSWORD is refused") && !/\bpassword"/.test(weak.out),
  );
  ok("nothing is created on a refusal", (await count("organizations")) === 0);

  const [a, b] = await Promise.all([init(bootstrap), init(bootstrap)]);
  ok("two inits at once both exit 0", a.code === 0 && b.code === 0, [
    a.out.slice(-400),
    b.out.slice(-400),
  ]);
  ok(
    "one baseline record",
    (await count("drizzle.__drizzle_migrations where hash like 'baseline:%'")) === 1,
  );
  ok(
    "one organization and one owner",
    (await count("organizations")) === 1 && (await count("users")) === 1,
  );
  const [key] = await db<{ kind: string; scope: string; livemode: string }[]>`
    select kind, scope, livemode from api_keys where hashed_key = ${hashApiKey(KEY)}`;
  ok(
    "the bootstrap key is a test write API key",
    key?.kind === "api" && key.scope === "write" && key.livemode === "test",
    key,
  );
  ok(
    "the key creation is audited",
    (await count("audit_logs where action = 'api_key.create'")) === 1,
  );

  const [before] = await db<
    { h: string }[]
  >`select password_hash as h from users where email = ${EMAIL}`;
  const again = await init({ ...bootstrap, TMBILLING_INIT_ADMIN_PASSWORD: `${PASSWORD}x` });
  const [after] = await db<
    { h: string }[]
  >`select password_hash as h from users where email = ${EMAIL}`;
  ok("a re-run exits 0", again.code === 0, again.out.slice(-400));
  ok("a re-run keeps the owner's password", before?.h === after?.h);
  ok("a re-run says it ignored the password", again.out.includes("bootstrap_password_ignored"));
  ok(
    "a re-run creates nothing",
    (await count("organizations")) === 1 && (await count("api_keys where kind = 'api'")) === 1,
  );

  const other = await init({ ...bootstrap, TMBILLING_INIT_ADMIN_EMAIL: "someone@example.com" });
  ok(
    "another email on an install with users creates nothing",
    other.code === 0 &&
      other.out.includes("bootstrap_skipped_existing_install") &&
      (await count("users")) === 1,
    other.out.slice(-400),
  );

  const foreign = `sk_live_${randomBytes(24).toString("base64url")}`;
  const [org2] = await db<{ id: string }[]>`
    insert into organizations (public_id, name) values ('org_selfhostverify2', 'Other') returning id`;
  await db`insert into api_keys (organization_id, public_id, prefix, hashed_key, livemode, kind)
    values (${org2!.id}, 'key_selfhostverify2', ${foreign.slice(0, 12)}, ${hashApiKey(foreign)}, 'live', 'api')`;
  const stolen = await init({ ...bootstrap, TMBILLING_INIT_API_KEY: foreign });
  ok(
    "a key held by another organization exits 1",
    stolen.code === 1 && stolen.out.includes("belongs to another organization"),
    stolen.out.slice(-400),
  );
  ok("that refusal does not print the key", !stolen.out.includes(foreign));

  const dash = await init({ ...bootstrap, TMBILLING_INIT_API_KEY: `sk_all_${"a".repeat(32)}` });
  ok("an sk_all_ key exits 1", dash.code === 1 && dash.out.includes("TMBILLING_INIT_API_KEY must"));

  ok(
    "no run printed the admin password or the API key",
    ![weak, a, b, again, other, stolen, dash].some((r) => leaks(r.out)),
  );
} finally {
  await db.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "❌ SELFHOST-INIT: FAIL" : "✅ SELFHOST-INIT: PASS");
process.exit(fail ? 1 : 0);
