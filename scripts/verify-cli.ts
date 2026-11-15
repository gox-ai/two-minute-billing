/**
 * The `tmb` command line (cli/), run as a user runs it against this engine over HTTP:
 *  - --help, --version, unknown command; settings from ./.env and --env-file, the real
 *    environment wins
 *  - doctor: test key → 0, live write key → 3; push: plan → apply → nothing to change
 *  - clock start / advance / stop; webhooks register writes the secret to ./.env
 *  - listen forwards trigger's events to a local stub, signed with the secret, the body byte for
 *    byte what the outbox sends, no pre-start event and no duplicate; no secret → exit 1
 *  - trigger purchase → a paid invoice; payment-failed; subscription
 *  - reset: refuses without --confirm and no TTY, then empties the business
 *  - init: names added to .env.example, .env untouched
 */
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { createApiKey, createBusiness, createOrganization } from "@/modules/tenancy/service";
import { events } from "@db/schema";

const root = join(import.meta.dirname, "..");
const TMB = join(root, "cli/bin/tmb.mjs");
execFileSync("pnpm", ["-s", "cli:build"], { cwd: root, stdio: "ignore" });

const checks: Array<[string, boolean]> = [];
const outputs: Record<string, string> = {};
const tmp = mkdtempSync(join(tmpdir(), "tmb-cli-"));

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const URL_ = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

const { organization } = await createOrganization({ name: "CLI Check Co" });
const { secret: testKey } = await createApiKey(organization.id, "test");
const { secret: liveKey } = await createApiKey(organization.id, "live");

type Run = { code: number; out: string };
// Async on purpose: the server answers from this same process.
function tmb(args: string[], env: Record<string, string> = {}, cwd = tmp, label?: string) {
  return new Promise<Run>((resolve) => {
    execFile(
      process.execPath,
      [TMB, ...args],
      { env: { PATH: process.env.PATH ?? "", TMBILLING_URL: URL_, ...env }, cwd, timeout: 120_000 },
      (err, stdout, stderr) => {
        const r = { code: err ? Number(err.code ?? 1) : 0, out: stdout + stderr };
        if (label) outputs[label] = r.out;
        resolve(r);
      },
    );
  });
}
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${testKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}
const until = async (cond: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end && !cond();)
    await new Promise((r) => setTimeout(r, 100));
  return cond();
};

// ——— help, version, settings ————————————————————————————————————————————————————
const pkg = JSON.parse(readFileSync(join(root, "cli/package.json"), "utf8"));
const help = await tmb(["--help"]);
checks.push([
  "--help → exit 0, lists the commands",
  help.code === 0 && help.out.includes("listen"),
]);
checks.push([
  "--version prints cli/package.json's version",
  (await tmb(["--version"])).out.trim() === pkg.version,
]);
checks.push(["<command> --help → exit 0", (await tmb(["trigger", "--help"])).code === 0]);
const unknown = await tmb(["nope"]);
checks.push([
  "unknown command → exit 1 with the list",
  unknown.code === 1 && unknown.out.includes("Commands:"),
]);

const doctor = await tmb(["doctor"], { TMBILLING_API_KEY: testKey }, tmp, "doctor");
checks.push(["doctor: test key → exit 0", doctor.code === 0]);
checks.push(["doctor: never prints the key", !doctor.out.includes(testKey.slice(8))]);
checks.push([
  "doctor: live write key → exit 3",
  (await tmb(["doctor"], { TMBILLING_API_KEY: liveKey })).code === 3,
]);
const envDir = join(tmp, "envfile");
mkdirSync(envDir);
writeFileSync(join(envDir, "billing.env"), `TMBILLING_URL=${URL_}\nTMBILLING_API_KEY=${testKey}\n`);
writeFileSync(join(envDir, ".env"), `TMBILLING_API_KEY=${liveKey}\n`);
checks.push([
  "settings: --env-file loads the file",
  (await tmb(["doctor", "--env-file", "billing.env"], { TMBILLING_URL: "" }, envDir)).code === 0,
]);
checks.push([
  "settings: ./.env loads without a flag",
  (await tmb(["doctor"], {}, envDir)).code === 3,
]);
checks.push([
  "settings: the real environment wins over the file",
  (await tmb(["doctor", "--env-file", "billing.env"], { TMBILLING_API_KEY: liveKey }, envDir))
    .code === 3,
]);

// ——— a test business with a live twin (reset needs one), its catalog pushed ——————————————
const live = await createBusiness({
  organizationId: organization.id,
  name: `CLI Shop ${crypto.randomUUID().slice(0, 6)}`,
  defaultCurrency: "USD",
});
const twin = (await api("GET", "/v1/businesses")).data.find(
  (b: any) => b.name === live.name && b.livemode === "test",
);
const biz: string = twin.id;
const env = { TMBILLING_API_KEY: testKey, TMBILLING_BUSINESS_ID: biz };
const catalogFile = join(tmp, "billing.catalog.json");
writeFileSync(
  catalogFile,
  JSON.stringify({
    business: { name: live.name, default_currency: "USD" },
    products: [
      { id: "pro", name: "Pro", kind: "plan" },
      { id: "credit-pack", name: "Credit pack", kind: "charge" },
    ],
    prices: [
      {
        id: "pro-monthly-usd",
        product: "pro",
        name: "Pro monthly",
        model: "flat",
        currency: "USD",
        amount_minor: 2900,
        interval: "month",
      },
      {
        id: "credit-pack-usd",
        product: "credit-pack",
        name: "Credit pack",
        type: "one_time",
        model: "flat",
        currency: "USD",
        amount_minor: 2500,
      },
    ],
  }),
);
const plan = await tmb(["push", catalogFile], env, tmp, "plan");
checks.push([
  "push: plan → exit 0, lists the creates, changes nothing",
  plan.code === 0 &&
    plan.out.includes(`Business ${biz} (test)`) &&
    plan.out.includes("+ price credit-pack-usd") &&
    plan.out.includes("Plan only") &&
    (await api("GET", `/v1/businesses/${biz}/prices`)).data.length === 0,
]);
const applied = await tmb(["push", catalogFile, "--apply"], env, tmp, "apply");
checks.push([
  "push --apply → exit 0, the prices exist",
  applied.code === 0 && (await api("GET", `/v1/businesses/${biz}/prices`)).data.length === 2,
]);
checks.push([
  "push: a second run → nothing to change",
  (await tmb(["push", catalogFile], env)).out.includes("Nothing to change."),
]);

// ——— clock, on a business of its own ——————————————————————————————————————————————
const clockBiz = await api("POST", "/v1/businesses", {
  name: "CLI Clock",
  default_currency: "USD",
});
const clockEnv = { TMBILLING_API_KEY: testKey, TMBILLING_BUSINESS_ID: clockBiz.id };
const cStart = await tmb(["clock", "start"], clockEnv, tmp, "clock start");
const cAdv = await tmb(["clock", "advance", "--by", "2d"], clockEnv, tmp, "clock advance");
const cStop = await tmb(["clock", "stop"], clockEnv, tmp, "clock stop");
checks.push([
  "clock: start, advance, stop → exit 0 each",
  cStart.code === 0 && cStart.out.includes('"in_progress"') && cAdv.code === 0 && cStop.code === 0,
]);

// ——— a local app that checks the signature ———————————————————————————————————————————
let secret = "";
type Hit = { id: string; type: string; raw: string; signed: boolean; header: string };
const hits: Hit[] = [];
const stub = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const want = Buffer.from("sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
    const got = Buffer.from(String(req.headers["tmbilling-signature"] ?? ""));
    if (!(want.length === got.length && timingSafeEqual(want, got))) {
      res.writeHead(401).end();
      return;
    }
    const body = JSON.parse(raw.toString("utf8"));
    hits.push({
      id: body.id,
      type: body.event_type,
      raw: raw.toString("utf8"),
      signed: true,
      header: String(req.headers["tmbilling-event-id"]),
    });
    res.writeHead(200).end();
  });
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
const hook = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/hook`;

// register writes the secret to ./.env of the app's directory; tmb reads it from there.
const appDir = join(tmp, "app");
mkdirSync(appDir);
const reg = await tmb(["webhooks", "register", "--url", hook], env, appDir, "register");
secret =
  /^TMBILLING_WEBHOOK_SECRET=(.+)$/m.exec(readFileSync(join(appDir, ".env"), "utf8"))?.[1] ?? "";
checks.push([
  "webhooks register → exit 0, secret in ./.env, never printed",
  reg.code === 0 && secret.length > 8 && !reg.out.includes(secret),
]);
const wt = await tmb(["webhooks", "test", "--url", hook], {}, appDir, "webhooks test");
checks.push(["webhooks test → exit 0 against a correct handler", wt.code === 0]);
hits.length = 0;

const noSecret = await tmb(["listen", "--forward", hook], env, tmp);
checks.push([
  "listen: no secret → exit 1, says to set it",
  noSecret.code === 1 && noSecret.out.includes("TMBILLING_WEBHOOK_SECRET"),
]);
checks.push([
  "listen: a remote URL is refused",
  (await tmb(["listen", "--forward", "https://app.example.com/hook"], env, appDir)).code === 1,
]);

// ——— listen + trigger ———————————————————————————————————————————————————————————————
const before = new Set(
  (await api("GET", `/v1/businesses/${biz}/events?limit=100`)).data.map((e: any) => e.id),
);
let listenOut = "";
const listener = spawn(
  process.execPath,
  [TMB, "listen", "--forward", hook, "--since", "now", "--interval", "300ms"],
  { cwd: appDir, env: { PATH: process.env.PATH ?? "", TMBILLING_URL: URL_, ...env } },
);
listener.stdout.on("data", (d) => (listenOut += d));
listener.stderr.on("data", (d) => (listenOut += d));
const exited = new Promise<number | null>((r) => listener.on("exit", (code) => r(code)));
checks.push(["listen: starts", await until(() => listenOut.includes("Ready."), 20_000)]);

const buy = await tmb(["trigger", "purchase"], env, tmp, "trigger purchase");
const invId = /^invoice\s+(inv_\S+)/m.exec(buy.out)?.[1];
const inv = invId ? await api("GET", `/v1/businesses/${biz}/invoices/${invId}`) : null;
checks.push([
  "trigger purchase → exit 0, names the price, the invoice is paid",
  buy.code === 0 && buy.out.includes("Using price credit-pack-usd") && inv?.status === "paid",
]);
checks.push([
  "trigger: the customer has a trigger+…@example.com email",
  /customer\s+cus_\S+ \(trigger\+[0-9a-f]+@example\.com\)/.test(buy.out),
]);
const gotPaid = await until(() => hits.some((h) => h.type === "invoice_paid"), 20_000);
checks.push(["listen: the stub got invoice_paid, signed with the secret", gotPaid]);

const failed = await tmb(["trigger", "payment-failed"], env, tmp, "trigger payment-failed");
checks.push(["trigger payment-failed → exit 0", failed.code === 0]);
const subRun = await tmb(["trigger", "subscription"], env, tmp, "trigger subscription");
checks.push([
  "trigger subscription → exit 0, a subscription",
  subRun.code === 0 && /^subscription\s+sub_/m.test(subRun.out),
]);
checks.push([
  "listen: payment_failed and subscription_created arrive too",
  await until(
    () =>
      hits.some((h) => h.type === "payment_failed") &&
      hits.some((h) => h.type === "subscription_created"),
    20_000,
  ),
]);
await new Promise((r) => setTimeout(r, 2500)); // several more polls
const ids = hits.map((h) => h.id);
checks.push(["listen: no event twice", new Set(ids).size === ids.length && ids.length > 0]);
checks.push(["listen: no event from before the start", !ids.some((id) => before.has(id))]);
checks.push(["listen: Tmbilling-Event-Id is the event id", hits.every((h) => h.header === h.id)]);
// The body the outbox would sign for the same row, key for key.
const paidHit = hits.find((h) => h.type === "invoice_paid");
const [row] = paidHit
  ? await systemDb.select().from(events).where(eq(events.publicId, paidHit.id))
  : [];
const outbox = row
  ? JSON.stringify({
      id: row.publicId,
      occurred_at: row.createdAt,
      source: row.source,
      user: row.actor,
      event_type: row.type,
      api_version: row.apiVersion,
      content: row.data,
      object: "event",
    })
  : "";
checks.push([
  "listen: the forwarded body is byte for byte the outbox's envelope",
  !!paidHit && paidHit.raw === outbox,
]);
checks.push([
  "listen: one line per event with the app's status",
  /invoice_paid\s+evt_\S+\s+→ 200\s+\d+ms/.test(listenOut),
]);
listener.kill("SIGINT");
checks.push(["listen: Ctrl-C → exit 0", (await exited) === 0]);
outputs.listen = listenOut;
stub.close();

// ——— reset ——————————————————————————————————————————————————————————————————————————
const noTty = await tmb(["reset"], env, tmp, "reset no tty");
checks.push([
  "reset: no --confirm and no TTY → exit 1, nothing deleted",
  noTty.code === 1 && (await api("GET", `/v1/businesses/${biz}/prices`)).data.length === 2,
]);
checks.push([
  "reset: a wrong --confirm → exit 1",
  (await tmb(["reset", "--confirm", "biz_wrong"], env)).code === 1,
]);
checks.push([
  "reset: a live key → exit 3",
  (await tmb(["reset", "--confirm", biz], { ...env, TMBILLING_API_KEY: liveKey })).code === 3,
]);
const reset = await tmb(["reset", "--confirm", biz], env, tmp, "reset");
const after = await api("GET", `/v1/businesses/${biz}/prices?include_archived=true`);
const prods = await api("GET", `/v1/businesses/${biz}/products?include_archived=true`);
const custs = await api("GET", `/v1/businesses/${biz}/customers`);
checks.push([
  "reset --confirm → exit 0, the catalog and customers are gone",
  reset.code === 0 &&
    reset.out.includes("webhook endpoints") &&
    after.data.length === 0 &&
    prods.data.length === 0 &&
    custs.data.length === 0,
]);

// ——— init ———————————————————————————————————————————————————————————————————————————
const proj = join(tmp, "proj");
mkdirSync(proj);
writeFileSync(join(proj, ".env"), "SECRET_THING=1\n");
writeFileSync(join(proj, ".env.example"), "TMBILLING_URL=\nOTHER=");
const init = await tmb(["init", "--yes", "--skip-skills"], {}, proj, "init");
const example = readFileSync(join(proj, ".env.example"), "utf8");
checks.push([
  "init → exit 0, adds the missing names to .env.example once",
  init.code === 0 &&
    example.startsWith("TMBILLING_URL=\nOTHER=\n") &&
    ["TMBILLING_API_KEY=", "TMBILLING_BUSINESS_ID=", "TMBILLING_WEBHOOK_SECRET="].every((n) =>
      example.includes(`\n${n}\n`),
    ) &&
    example.match(/TMBILLING_URL=/g)?.length === 1,
]);
checks.push([
  "init: the real .env is untouched",
  readFileSync(join(proj, ".env"), "utf8") === "SECRET_THING=1\n",
]);
checks.push([
  "init: a second run adds nothing; next steps name tmb doctor",
  (await tmb(["init", "--yes", "--skip-skills"], {}, proj)).out.includes("already lists") &&
    readFileSync(join(proj, ".env.example"), "utf8") === example &&
    init.out.includes("tmb doctor"),
]);
const fresh = join(tmp, "fresh");
mkdirSync(fresh);
await tmb(["init", "--skip-skills"], {}, fresh);
checks.push([
  "init: no example file → creates .env.example",
  readFileSync(join(fresh, ".env.example"), "utf8").includes("TMBILLING_API_KEY="),
]);

await app.close();
await closeDb();
let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
if (!pass) for (const [n, out] of Object.entries(outputs)) console.log(`--- ${n}\n${out}`);
console.log(pass ? "✅ CLI: PASS" : "❌ CLI: FAIL");
process.exit(pass ? 0 : 1);
