/**
 * verify:docs-snippets — the developer docs' code runs.
 *
 * For each page in PAGES, every ```bash block and every ```ts block runs in page order
 * against an in-process API, each language with its own fresh organization and test key.
 *
 *  - bash: `curl` answers ≥ 400 fail the page. A placeholder line `export BIZ=biz_…`
 *    takes the id of the latest response whose id has that prefix — the step a reader
 *    does by hand. It may close the same block as the request it reads. `export
 *    TMBILLING_*` lines are set up by the suite instead.
 *  - ts: the page's blocks are one program. It is typechecked against the SDK, then run,
 *    so a field the SDK does not have fails here, not in a reader's editor.
 *
 * Children are spawned ASYNC: the API runs in this process, so a blocking spawn would
 * freeze the server the child is calling and hang the suite.
 *
 *   pnpm verify:docs-snippets
 *   DOCS_SNIPPETS_DUMP=/some/dir pnpm verify:docs-snippets   # also save every curl response
 *   DOCS_SNIPPETS_ONLY=quickstart pnpm verify:docs-snippets   # pages whose path contains it
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// A docs run must not ship its log lines to the deployment's log sink (and in a worktree the
// sink's credentials file is absent, which crashed the run). Set before config is imported.
process.env.CLOUD_LOGGING = "FALSE";
const { buildApp } = await import("@/index");
const { closeDb } = await import("@/platform/db");
const { createApiKey, createOrganization } = await import("@/modules/tenancy/service");

const ROOT = resolve(import.meta.dirname, "..");
const DEV = join(ROOT, "docs-site/content/help/40.developers");
const PAGES = [
  "01.getting-started/02.quickstart.md",
  "03.recipes/01.trials.md",
  "03.recipes/02.usage-based-billing.md",
  "03.recipes/05.one-time-purchases.md",
  "03.recipes/07.failed-payments.md",
  "03.recipes/08.india-gst-invoices.md",
  "03.recipes/09.india-mandates.md",
  "03.recipes/10.migrate-your-billing.md",
  "03.recipes/11.meter-usage-events.md",
  "03.recipes/12.bill-ai-tokens.md",
];
const DUMP = process.env.DOCS_SNIPPETS_DUMP;
const TIMEOUT_MS = 180_000;

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, !cond && detail ? `\n    ${detail}` : "");
}

type Block = { lang: string; code: string; line: number };

function blocks(md: string): Block[] {
  const out: Block[] = [];
  const re = /^```(\w+)[^\n]*\n([\s\S]*?)^```/gm;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    out.push({ lang: m[1]!, code: m[2]!, line: md.slice(0, m.index).split("\n").length });
  }
  return out;
}

type Run = { status: number | null; stdout: string; stderr: string };
function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string }) {
  return new Promise<Run>((done) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      stderr += `\n(killed after ${TIMEOUT_MS / 1000}s)`;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

async function testKey(name: string): Promise<string> {
  const { organization } = await createOrganization({ name });
  return (await createApiKey(organization.id, "test")).secret;
}

const CURL = `curl() { command curl -sS -w '\\n@@HTTP %{http_code}\\n' "$@"; }\n`;
const PLACEHOLDER = /^export (\w+)=(\w+_)…\s*$/;

async function runBash(page: string, bs: Block[]) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TMBILLING_URL: url,
    TMBILLING_API_KEY: await testKey(`Docs bash ${page}`),
  };
  const ids: string[] = [];
  const dumped: Array<{ line: number; status: number; body: unknown }> = [];

  async function exec(line: number, script: string[]) {
    if (!script.join("").trim()) return;
    const r = await run("bash", ["-eo", "pipefail", "-c", CURL + script.join("\n")], { env });
    const parts = r.stdout.split(/\n@@HTTP (\d{3})\n/);
    const statuses: number[] = [];
    for (let i = 1; i < parts.length; i += 2) {
      const status = Number(parts[i]);
      statuses.push(status);
      try {
        const body = JSON.parse(parts[i - 1]!) as { id?: unknown };
        if (typeof body.id === "string") ids.push(body.id);
        dumped.push({ line, status, body });
      } catch {
        // not JSON — the status check below still applies
      }
    }
    const bad = statuses.find((s) => s >= 400);
    ok(
      `${page}:${line} bash runs (${statuses.join(", ") || "no request"})`,
      r.status === 0 && statuses.length > 0 && bad === undefined,
      `${r.stderr.trim()} ${parts.slice(0, -1).join(" ").slice(0, 600)}`,
    );
  }

  for (const b of bs) {
    let script: string[] = [];
    for (const line of b.code.split("\n")) {
      if (/^export TMBILLING_\w+=/.test(line)) continue;
      const ph = PLACEHOLDER.exec(line);
      if (ph) {
        await exec(b.line, script);
        script = [];
        const id = ids.findLast((i) => i.startsWith(ph[2]!));
        ok(
          `${page}:${b.line} ${ph[1]} resolves to a ${ph[2]}… id`,
          !!id,
          `seen: ${ids.join(", ")}`,
        );
        if (id) env[ph[1]!] = id;
        continue;
      }
      script.push(line);
    }
    await exec(b.line, script);
  }

  if (DUMP) {
    mkdirSync(DUMP, { recursive: true });
    writeFileSync(
      join(DUMP, `${page.replaceAll("/", "__")}.json`),
      JSON.stringify(dumped, null, 2),
    );
  }
}

async function runTs(page: string, bs: Block[]) {
  const dir = mkdtempSync(join(ROOT, "scripts/.docs-snippets-"));
  try {
    const file = join(dir, "snippet.ts");
    const program = bs.map((b) => b.code).join("\n");
    writeFileSync(file, program.replaceAll(/from "\.\/sdk"/g, `from "${join(ROOT, "sdk")}"`));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: join(ROOT, "tsconfig.json"),
        compilerOptions: { noEmit: true, rootDir: ROOT, noUnusedLocals: false },
        include: [file],
      }),
    );
    const tsc = await run("pnpm", ["exec", "tsc", "-p", join(dir, "tsconfig.json")], {
      cwd: ROOT,
    });
    ok(`${page} ts typechecks against the SDK`, tsc.status === 0, tsc.stdout.trim());
    const r = await run("pnpm", ["exec", "tsx", file], {
      cwd: ROOT,
      env: {
        ...process.env,
        TMBILLING_URL: url,
        TMBILLING_API_KEY: await testKey(`Docs ts ${page}`),
      },
    });
    ok(`${page} ts runs`, r.status === 0, r.stderr.trim().slice(0, 600));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ONLY = process.env.DOCS_SNIPPETS_ONLY;
for (const page of PAGES.filter((p) => !ONLY || p.includes(ONLY))) {
  const bs = blocks(readFileSync(join(DEV, page), "utf8"));
  await runBash(
    page,
    bs.filter((b) => b.lang === "bash"),
  );
  const ts = bs.filter((b) => b.lang === "ts");
  if (ts.length) await runTs(page, ts);
}

await app.close();
await closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "❌ DOCS-SNIPPETS: FAIL" : "✅ DOCS-SNIPPETS: PASS");
process.exit(fail ? 1 : 0);
