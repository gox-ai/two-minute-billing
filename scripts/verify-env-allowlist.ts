/**
 * verify:env-allowlist — the dashboard and the docs server take only named keys from the root
 * `.env`, which also holds the database URL and the engine's secrets.
 *
 * What it pins:
 *  - every `process.env.X` the dashboard reads is in ROOT_ENV_KEYS (or PROCESS_ONLY_KEYS), every
 *    listed key is read, and no dynamic `process.env[...]` read hides a name from this scan,
 *  - no listed dashboard key looks like a secret, except the documented SECRET_NAME_EXCEPTIONS,
 *  - the docs allowlist is exactly nuxt.config.ts's runtimeConfig as env names, minus the
 *    build-time NUXT_PUBLIC_EDITION,
 *  - both loaders copy only listed keys, never override a key already set, skip empty values,
 *    and find the root file (DOTENV_CONFIG_PATH, else the repository root).
 *
 *   pnpm verify:env-allowlist
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

// Both loaders type-check under their own projects, so they are loaded by a computed path.
const load = <T>(path: string) => import(path) as Promise<T>;
type Env = Record<string, string | undefined>;
const dash = await load<{
  ROOT_ENV_KEYS: readonly string[];
  PROCESS_ONLY_KEYS: readonly string[];
  SECRET_NAME_EXCEPTIONS: Record<string, string>;
  rootEnvPath(env?: Env): string;
  loadRootEnv(env?: Env, path?: string): string[];
}>("../dashboard/root-env.mjs");
const docs = await load<{
  DOCS_ROOT_ENV_KEYS: readonly string[];
  docsRootEnvPath(env?: Env, cwd?: string): string | undefined;
  loadDocsRootEnv(env?: Env, path?: string): string[];
}>("../docs-site/server/lib/root-env.ts");

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, !cond && detail !== undefined ? JSON.stringify(detail) : "");
}
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const same = (a: Iterable<string>, b: Iterable<string>) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

// ── dashboard: what the code reads ───────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", "public", "content"]);
function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) yield* sources(join(dir, e.name));
    } else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      yield join(dir, e.name);
    }
  }
}

const LOADER = join(ROOT, "dashboard/root-env.mjs");
const reads = new Map<string, string[]>();
const opaque: string[] = [];
for (const file of sources(join(ROOT, "dashboard"))) {
  // The loader writes env; it reads no setting of its own.
  if (file === LOADER) continue;
  const text = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);
  for (const m of text.matchAll(
    /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\])?/g,
  )) {
    const key = m[1] ?? m[2];
    if (key) reads.set(key, [...(reads.get(key) ?? []), rel]);
    else opaque.push(`${rel}:${text.slice(0, m.index).split("\n").length}`);
  }
}

const allowed = new Set(dash.ROOT_ENV_KEYS);
const processOnly = new Set(dash.PROCESS_ONLY_KEYS);
ok(
  "the dashboard reads env vars at all (the scan is not empty)",
  reads.size >= 5,
  sorted(reads.keys()),
);
ok("no dynamic process.env access the scan cannot name", opaque.length === 0, opaque);
const unlisted = [...reads.keys()].filter((k) => !allowed.has(k) && !processOnly.has(k));
ok(
  "every process.env.X the dashboard reads is in ROOT_ENV_KEYS or PROCESS_ONLY_KEYS",
  unlisted.length === 0,
  unlisted.map((k) => `${k} (${reads.get(k)!.join(", ")})`),
);
const unread = dash.ROOT_ENV_KEYS.filter((k) => !reads.has(k));
ok("every key in ROOT_ENV_KEYS is read by the dashboard", unread.length === 0, unread);
const both = dash.ROOT_ENV_KEYS.filter((k) => processOnly.has(k));
ok("no key is both loaded from the file and process-only", both.length === 0, both);

// ── dashboard: nothing that looks like a secret ──────────────────────────────────
/**
 * A name is secret-looking when it says so (SECRET, PASSWORD, PRIVATE, CREDENTIAL), names a
 * connection string (DATABASE, DSN, SMTP), or ends in KEY or TOKEN. NEXT_PUBLIC_*_KEY is exempt
 * from the KEY rule only: Next inlines those into the browser bundle, so they are publishable by
 * construction — and a NEXT_PUBLIC_ name saying SECRET is still refused.
 */
function secretLooking(key: string): boolean {
  if (/SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|DATABASE|_DSN$|SMTP/.test(key)) return true;
  if (/_TOKEN$|_PAT$/.test(key)) return true;
  if (/_KEY$|_KEY_/.test(key)) return !key.startsWith("NEXT_PUBLIC_");
  return false;
}
const exceptions = dash.SECRET_NAME_EXCEPTIONS;
const secret = dash.ROOT_ENV_KEYS.filter((k) => secretLooking(k) && !(k in exceptions));
ok(
  "no key in ROOT_ENV_KEYS looks like a secret (outside the exceptions)",
  secret.length === 0,
  secret,
);
const stale = Object.keys(exceptions).filter((k) => !allowed.has(k) || !secretLooking(k));
ok("every secret-name exception is listed and still needed", stale.length === 0, stale);
const publicExc = Object.keys(exceptions).filter((k) => k.startsWith("NEXT_PUBLIC_"));
ok("no exception reaches the browser bundle (NEXT_PUBLIC_)", publicExc.length === 0, publicExc);
for (const k of [
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "API_KEY_SECRET",
  "GATEWAY_CREDENTIALS_KEY",
  "SESSION_SECRET",
  "TURNSTILE_SECRET_KEY",
]) {
  ok(`the rule refuses ${k}`, secretLooking(k));
}
ok(
  "the rule allows a publishable NEXT_PUBLIC_*_KEY",
  !secretLooking("NEXT_PUBLIC_TURNSTILE_SITE_KEY"),
);
ok("the rule refuses NEXT_PUBLIC_*_SECRET", secretLooking("NEXT_PUBLIC_X_SECRET"));

const nextConfig = readFileSync(join(ROOT, "dashboard/next.config.mjs"), "utf8");
const loadAt = nextConfig.indexOf("loadRootEnv();");
const firstRead = nextConfig.search(/process\.env\./);
ok(
  "next.config.mjs loads the root file before it reads any setting",
  loadAt >= 0 && loadAt < firstRead,
);

// ── docs: the allowlist is the runtimeConfig ─────────────────────────────────────
/** runtimeConfig's leaf keys as Nuxt env names (`pricingApiUrl` → NUXT_PRICING_API_URL). */
function runtimeConfigEnvNames(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // The top-level key only: `$production` carries a nested `runtimeConfig` override.
  const top = /^ {2}runtimeConfig: \{/m.exec(text);
  if (!top) return [];
  const start = top.index + 2;
  const names: string[] = [];
  const path: string[] = [];
  let pendingKey: string | undefined;
  let i = start + "runtimeConfig: {".length;
  let depth = 1;
  for (; i < text.length && depth > 0; i++) {
    const rest = text.slice(i);
    const key = /^([A-Za-z_]\w*)\s*:\s*/.exec(rest);
    if (key && /[\s{,]/.test(text[i - 1]!)) {
      const after = rest.slice(key[0].length);
      if (after.startsWith("{")) {
        pendingKey = key[1];
      } else {
        names.push([...path, key[1]!].join("_"));
      }
      i += key[0].length - 1;
      continue;
    }
    if (text[i] === "{") {
      depth++;
      path.push(pendingKey ?? "?");
      pendingKey = undefined;
    } else if (text[i] === "}") {
      depth--;
      path.pop();
    }
  }
  const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return names.map((n) => `NUXT_${n.split("_").map(snake).join("_")}`);
}
const nuxtConfig = readFileSync(join(ROOT, "docs-site/nuxt.config.ts"), "utf8");
const runtimeKeys = runtimeConfigEnvNames(nuxtConfig);
/** Baked into the prerendered pages, so the server must not change them. */
const BUILD_TIME_KEYS = new Set(["NUXT_PUBLIC_EDITION", "NUXT_PUBLIC_GA_ID"]);
ok(
  "nuxt.config.ts runtimeConfig parsed",
  runtimeKeys.includes("NUXT_PRICING_API_URL"),
  runtimeKeys,
);
ok(
  "NUXT_PUBLIC_EDITION is a runtimeConfig key (the exclusion below means something)",
  runtimeKeys.includes("NUXT_PUBLIC_EDITION"),
);
ok(
  "DOCS_ROOT_ENV_KEYS is exactly runtimeConfig minus the build-time keys",
  same(
    docs.DOCS_ROOT_ENV_KEYS,
    runtimeKeys.filter((k) => !BUILD_TIME_KEYS.has(k)),
  ),
  { listed: sorted(docs.DOCS_ROOT_ENV_KEYS), runtimeConfig: sorted(runtimeKeys) },
);
ok(
  "every docs key is NUXT_ prefixed",
  docs.DOCS_ROOT_ENV_KEYS.every((k) => k.startsWith("NUXT_")),
);
const plugin = readFileSync(join(ROOT, "docs-site/server/plugins/root-env.ts"), "utf8");
ok("the docs server plugin runs the loader", /loadDocsRootEnv\(\)/.test(plugin));

// ── both loaders, on a scratch root file ─────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), "env-allowlist-"));
try {
  const file = join(scratch, ".env");
  const lines = [
    "DATABASE_URL=postgres://u:p@h/db",
    "GATEWAY_CREDENTIALS_KEY=k",
    "API_KEY_SECRET=s",
    "TMBILLING_API_URL=http://from-root:1",
    "TMBILLING_EDITION=cloud",
    "ACCOUNT_BILLING_TOKEN=t",
    "CSP_REPORT_ONLY=",
    "NUXT_PRICING_API_URL=http://from-root:2",
    "NUXT_PUBLIC_EDITION=cloud",
    "NUXT_PUBLIC_APP_URL=http://from-root:3",
  ];
  writeFileSync(file, lines.join("\n") + "\n");

  const env: Env = { TMBILLING_EDITION: "self_hosted" };
  const applied = dash.loadRootEnv(env, file);
  ok(
    "dashboard: copies the listed keys",
    env.TMBILLING_API_URL === "http://from-root:1" && env.ACCOUNT_BILLING_TOKEN === "t",
  );
  ok(
    "dashboard: never copies an unlisted key",
    !("DATABASE_URL" in env) &&
      !("GATEWAY_CREDENTIALS_KEY" in env) &&
      !("API_KEY_SECRET" in env) &&
      !("NUXT_PRICING_API_URL" in env),
    sorted(Object.keys(env)),
  );
  ok("dashboard: a key already set wins over the file", env.TMBILLING_EDITION === "self_hosted");
  ok("dashboard: an empty value counts as unset", !("CSP_REPORT_ONLY" in env));
  ok(
    "dashboard: reports the names it set",
    same(applied, ["TMBILLING_API_URL", "ACCOUNT_BILLING_TOKEN"]),
    applied,
  );
  ok(
    "dashboard: DOTENV_CONFIG_PATH names the root file",
    dash.rootEnvPath({ DOTENV_CONFIG_PATH: file }) === file,
  );
  ok(
    "dashboard: default root file is the repository's .env",
    dash.rootEnvPath({}) === join(ROOT, ".env"),
  );
  ok(
    "dashboard: a missing root file is not an error",
    dash.loadRootEnv({}, join(scratch, "none")).length === 0,
  );

  const denv: Env = { NUXT_PUBLIC_APP_URL: "http://from-env" };
  docs.loadDocsRootEnv(denv, file);
  ok("docs: copies the listed keys", denv.NUXT_PRICING_API_URL === "http://from-root:2");
  ok(
    "docs: never copies an unlisted key (nor the build-time edition)",
    !("DATABASE_URL" in denv) && !("TMBILLING_API_URL" in denv) && !("NUXT_PUBLIC_EDITION" in denv),
    sorted(Object.keys(denv)),
  );
  ok("docs: a key already set wins over the file", denv.NUXT_PUBLIC_APP_URL === "http://from-env");

  // The production layout: `node .output/server/index.mjs` with cwd docs-site/.
  const repo = join(scratch, "repo");
  mkdirSync(join(repo, "docs-site/.output/server"), { recursive: true });
  writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages: []\n");
  ok(
    "docs: finds ../.env from docs-site/",
    docs.docsRootEnvPath({}, join(repo, "docs-site")) === join(repo, ".env"),
  );
  ok(
    "docs: finds .env from the repository root",
    docs.docsRootEnvPath({}, repo) === join(repo, ".env"),
  );
  ok(
    "docs: DOTENV_CONFIG_PATH wins",
    docs.docsRootEnvPath({ DOTENV_CONFIG_PATH: file }, repo) === file,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "❌ ENV-ALLOWLIST: FAIL" : "✅ ENV-ALLOWLIST: PASS");
process.exit(fail ? 1 : 0);
