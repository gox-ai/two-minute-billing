/**
 * verify:sdk-package — the published SDK works for someone who installs it.
 *
 * Builds sdk/, packs it exactly as it would be published, installs the tarball into an
 * empty project outside this repo, and checks:
 *  - the tarball ships the build, the OpenAPI document, README and LICENSE, and no sources,
 *  - Node imports it as ESM and a call sends the right URL, auth and Idempotency-Key,
 *  - an error answer throws `TmbillingError` with the status and type,
 *  - a consumer typechecks under both `NodeNext` and `Bundler` resolution, and a wrong
 *    field is a type error (the types are real, not `any`).
 *
 *   pnpm verify:sdk-package
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = join(root, "sdk");
const tsc = join(root, "node_modules/.bin/tsc");
const work = mkdtempSync(join(tmpdir(), "tmb-sdk-"));
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${detail}` : ""}`);
  if (!cond) failed++;
};
const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

try {
  run("pnpm", ["-s", "sdk:build"], root);
  const packed = run("pnpm", ["pack", "--pack-destination", work], sdk).trim().split("\n");
  const tarball = packed.find((l) => l.endsWith(".tgz"))!;
  const files = run("tar", ["-tzf", tarball], work).split("\n").filter(Boolean);

  for (const f of ["dist/index.js", "dist/index.d.ts", "dist/schema.d.ts", "dist/ai-usage.js"]) {
    ok(`ships ${f}`, files.includes(`package/${f}`));
  }
  for (const f of ["openapi.json", "README.md", "LICENSE", "package.json"]) {
    ok(`ships ${f}`, files.includes(`package/${f}`));
  }
  ok(
    "ships no sources or build config",
    !files.some((f) => /^package\/[^/]+\.ts$|tsconfig/.test(f) && !f.endsWith(".d.ts")),
    files.join(", "),
  );

  const app = join(work, "app");
  run("mkdir", ["-p", app], work);
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "sdk-consumer", private: true, type: "module" }),
  );
  run("pnpm", ["add", "--ignore-workspace", tarball], app);

  writeFileSync(
    join(app, "smoke.mjs"),
    `import { Tmbilling, TmbillingError, reportAiUsage } from "@two-minute-billing/sdk";
const seen = [];
const ok = new Tmbilling({
  apiKey: "sk_test_XXXXXXXXXXXX01",
  baseUrl: "https://billing.example.com",
  fetch: async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ id: "cus_XXXXXXXXXXXX01", object: "customer" }), { status: 200 });
  },
});
const c = await ok.customers.create("biz_XXXXXXXXXXXX01", { email: "maya@example.com" });
const bad = new Tmbilling({
  apiKey: "sk_test_XXXXXXXXXXXX01",
  fetch: async () => new Response(JSON.stringify({ error: { type: "card_error", message: "Declined" } }), { status: 402 }),
});
let err = null;
try { await bad.invoices.collect("biz_XXXXXXXXXXXX01", "inv_XXXXXXXXXXXX01"); } catch (e) { err = e; }
const r = seen[0];
console.log(JSON.stringify({
  id: c.id,
  url: r.url,
  method: r.init.method,
  auth: r.init.headers.Authorization,
  idem: typeof r.init.headers["Idempotency-Key"] === "string" && r.init.headers["Idempotency-Key"].length > 0,
  body: JSON.parse(r.init.body),
  errIsTyped: err instanceof TmbillingError,
  errStatus: err?.status,
  errType: err?.type,
  hasAiHelper: typeof reportAiUsage === "function",
}));
`,
  );
  const out = JSON.parse(run("node", ["smoke.mjs"], app).trim().split("\n").pop()!);
  ok("imports as ESM in Node", out.id === "cus_XXXXXXXXXXXX01");
  ok(
    "sends to the configured base URL",
    out.url === "https://billing.example.com/v1/businesses/biz_XXXXXXXXXXXX01/customers",
    out.url,
  );
  ok("POST with the body", out.method === "POST" && out.body.email === "maya@example.com");
  ok("sends the API key as a bearer token", out.auth === "Bearer sk_test_XXXXXXXXXXXX01");
  ok("mints an Idempotency-Key on a write", out.idem === true);
  ok(
    "an error answer throws TmbillingError with status and type",
    out.errIsTyped && out.errStatus === 402 && out.errType === "card_error",
    JSON.stringify(out),
  );
  ok("exports the AI usage helper", out.hasAiHelper === true);

  const consumer = `import { Tmbilling, type TmbillingOptions } from "@two-minute-billing/sdk";
const opts: TmbillingOptions = { apiKey: "sk_test_XXXXXXXXXXXX01" };
const tmb = new Tmbilling(opts);
export async function f() {
  const c = await tmb.customers.create("biz_XXXXXXXXXXXX01", { email: "maya@example.com" });
  const id: string = c.id;
  return id;
}
`;
  writeFileSync(join(app, "consumer.ts"), consumer);
  writeFileSync(
    join(app, "wrong.ts"),
    `import { Tmbilling } from "@two-minute-billing/sdk";
const tmb = new Tmbilling({ apiKey: "sk_test_XXXXXXXXXXXX01" });
export const p = tmb.customers.create("biz_XXXXXXXXXXXX01", { emial: "maya@example.com" });
`,
  );
  for (const resolution of ["NodeNext", "Bundler"] as const) {
    const module = resolution === "NodeNext" ? "NodeNext" : "ESNext";
    const tsconfig = (file: string) =>
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module,
          moduleResolution: resolution,
          lib: ["ES2022", "DOM"],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: [file],
      });
    writeFileSync(join(app, "tsconfig.json"), tsconfig("consumer.ts"));
    let good = "";
    try {
      run(tsc, ["-p", "tsconfig.json"], app);
    } catch (e) {
      good = String((e as { stdout?: string }).stdout ?? e);
    }
    ok(`a consumer typechecks (${resolution})`, good === "", good.slice(0, 600));

    writeFileSync(join(app, "tsconfig.json"), tsconfig("wrong.ts"));
    let wrong = "";
    try {
      run(tsc, ["-p", "tsconfig.json"], app);
    } catch (e) {
      wrong = String((e as { stdout?: string }).stdout ?? e);
    }
    ok(
      `a misspelt field is a type error (${resolution})`,
      /emial/.test(wrong),
      wrong.slice(0, 300),
    );
  }

  const pkg = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")) as { license: string };
  ok("licensed MIT", pkg.license === "MIT");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failed ? `\n❌ SDK PACKAGE: ${failed} failed` : "\n✅ SDK PACKAGE: PASS");
process.exit(failed ? 1 : 0);
