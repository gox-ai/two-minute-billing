#!/usr/bin/env node
// tmb: the Two Minute Billing command line. Node 20+, no dependencies.
// The doctor, push, clock, check and webhooks commands run the Agent Skills' own scripts,
// copied into ../scripts at build time, so the two can never disagree.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../lib/api.mjs";
import { loadEnv } from "../lib/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));

const COMMON = `Settings (from the environment; an env file fills in only what is not set):
  TMBILLING_URL             API host, e.g. https://api.twominutebilling.com
  TMBILLING_API_KEY         a test key (sk_test_…). Never printed.
  TMBILLING_BUSINESS_ID     the test business (biz_…), or pass --business
  TMBILLING_WEBHOOK_SECRET  the signing secret your app checks. Never printed.
  --env-file <path>         load this file. Without it, ./.env is loaded if it exists.`;

const HELP = {
  "": `tmb ${pkg.version}: the Two Minute Billing command line.

Usage: tmb <command> [options]

Commands:
  doctor                 Show which server, organization and key mode the key reaches.
  push [file] [--apply]  Plan, then apply, the catalog in billing.catalog.json.
  clock <action>         Move a test business's clock: start | advance | status | stop.
  check                  Compare a real invoice with the figures you expect.
  webhooks test          Send signed test events to your local webhook route.
  webhooks register      Create a webhook endpoint and write its secret to your env file.
  listen                 Send the business's new events to a local URL, signed.
  trigger <scenario>     Create test objects so that real events occur.
  reset                  Delete all the data of a test business.
  init                   Add the Agent Skills and the settings to this project.

Run "tmb <command> --help" for the options of a command.

${COMMON}

Exit codes: 0 done · 1 bad input or a failed request · 2 a check failed or a server error
(each command's help gives the details) · 3 the key is not a test key.
A command that changes data refuses every key that is not a test key.`,

  doctor: `Usage: tmb doctor [--allow-live-read] [--json]

Shows the server, the organization, the key's mode and access, and the businesses it sees.

Exit: 0 test key, ready · 1 a setting is missing · 2 server or key failed
      3 live key that can write (refused) · 4 live read-only key (only with --allow-live-read)`,

  push: `Usage: tmb push [billing.catalog.json] [--apply] [--json]

Plans the changes the catalog file asks for: business, meters, products, prices, features and
entitlements. With --apply, makes them. It never changes a price: give new terms a new price id.

Exit: 0 planned, applied or nothing to change · 1 bad input or request
      2 conflict, nothing applied · 3 not a test key`,

  clock: `Usage: tmb clock status
       tmb clock start [--at 2026-11-01T00:00:00Z]
       tmb clock advance (--by 1m|14d|36h | --to <ISO time>)
       tmb clock stop [--wipe]
Options: --business biz_…

Moves the clock of a test business, so renewals, trial ends and dunning run now.

Exit: 0 done · 1 bad input or request · 3 not a test key`,

  check: `Usage: tmb check --expected expected.json (--invoice inv_… | --subscription sub_… | --session cosess_…)
                 [--business biz_…] [--report out.json]

Gets the invoice from the API and compares it with the figures in expected.json (minor units).

Exit: 0 every field matches · 1 bad input, request, or no invoice yet · 2 a field differs`,

  webhooks: `Usage: tmb webhooks test --url http://localhost:3000/webhooks/billing [--type customer_updated]
       tmb webhooks register --url https://app.example.com/webhooks/billing
                             [--env-file-out .env] [--business biz_…] [--events a,b] [--json]

test: sends a bad signature (must get 401), a signed event (2xx) and the same event again (2xx).
  Loopback URLs only. Exit: 0 all pass · 1 bad input · 2 a step failed
register: creates the endpoint and appends TMBILLING_WEBHOOK_SECRET to the env file
  (default: the --env-file file, else .env). Exit: 0 created · 1 bad input or request
  2 the env file is tracked by git or has a secret already · 3 not a test key`,

  listen: `Usage: tmb listen --forward http://localhost:3000/webhooks/billing
                  [--business biz_…] [--events invoice_paid,payment_failed]
                  [--interval 2s] [--since now|10m|<ISO time>] [--allow-remote]

Gets the business's new events every --interval and sends each one to --forward, with the
same body and Tmbilling-Signature header that a webhook endpoint gets. It signs with
TMBILLING_WEBHOOK_SECRET. You need no registered endpoint: for local use, the secret can be any
value that your app and listen both read. Shows one line for each event: time, type, id, your
app's HTTP status and the time it took. --since now (the default) sends only events that occur
after the start. Only loopback URLs, unless you add --allow-remote. Press Ctrl-C to stop.

Exit: 0 stopped with Ctrl-C · 1 bad input, no secret, or a failed request at the start
      3 not a test key`,

  trigger: `Usage: tmb trigger <scenario> [--price <price id>] [--business biz_…]

Scenarios:
  purchase        A new test customer with the card 4242 4242 4242 4242 buys a one-time price.
                  Events: invoice_paid, payment_succeeded.
  payment-failed  The same with the card 4000 0000 0000 0002, which declines. Event: payment_failed.
  subscription    A new test customer subscribes to a recurring price. Event: subscription_created.
Without --price, the first active price of the correct type is used.

Exit: 0 created · 1 bad input or request · 2 created, but the outcome is not the expected one
      3 not a test key`,

  reset: `Usage: tmb reset [--business biz_…] [--confirm biz_…]

Deletes all the data of a test business: the customers and every subscription, invoice,
payment and credit note, the catalog, coupons, taxes, dunning, webhook endpoints, gateways and
email settings. The business id, team members, API keys and the audit log stay.
You must type the business id, or give it with --confirm. You cannot undo this.

Exit: 0 reset · 1 not confirmed, bad input or request · 3 not a test key or a live business`,

  init: `Usage: tmb init [--yes]

1. Asks, then runs "npx skills add https://twominutebilling.com" (--yes: no question).
2. Adds the setting names, with no values, to .env.example (or .env.sample or
   config/.env.example if one exists). It never changes .env.
3. Shows the next steps.

Exit: 0 done · 1 the skills install failed`,
};

const SCRIPTS = {
  doctor: "preflight.mjs",
  push: "catalog.mjs",
  clock: "clock.mjs",
  check: "money-check.mjs",
  "webhooks test": "webhook-check.mjs",
  "webhooks register": "register-webhook.mjs",
};

function runScript(file, args) {
  const script = join(here, "../scripts", file);
  if (!existsSync(script))
    throw new CliError(
      `${file} is missing from this install. In the repository, run: pnpm cli:build`,
    );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: "inherit",
      env: process.env,
    });
    // The child gets Ctrl-C too, and exits with its own code.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    child.on("exit", (code, signal) => {
      process.off("SIGINT", ignore);
      resolve(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}

async function main(argv) {
  let envFile;
  const i = argv.indexOf("--env-file");
  if (i >= 0) {
    envFile = argv[i + 1];
    if (!envFile) throw new CliError("--env-file needs a path.");
    argv.splice(i, 2);
  }
  const [cmd = "", ...rest] = argv;
  if (cmd === "--version" || cmd === "-v") {
    console.log(pkg.version);
    return 0;
  }
  if (cmd === "" || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP[""]);
    return 0;
  }
  if (!(cmd in HELP)) {
    console.error(`tmb: unknown command "${cmd}".\n\n${HELP[""]}`);
    return 1;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP[cmd]);
    return 0;
  }
  if (cmd !== "init") loadEnv(envFile);

  if (cmd === "webhooks") {
    const [sub, ...args] = rest;
    if (sub !== "test" && sub !== "register") {
      console.error(`tmb webhooks: test | register\n\n${HELP.webhooks}`);
      return 1;
    }
    if (sub === "register" && !args.includes("--env-file-out"))
      args.push("--env-file-out", envFile ?? ".env");
    return runScript(SCRIPTS[`webhooks ${sub}`], args);
  }
  if (SCRIPTS[cmd]) return runScript(SCRIPTS[cmd], rest);
  const mod = await import(`../lib/${cmd}.mjs`);
  return mod[cmd](rest);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  console.error(`tmb: ${e.message}`);
  process.exitCode = e.code;
}
