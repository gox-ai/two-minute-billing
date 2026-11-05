/**
 * verify:edition — one switch decides Cloud or self-hosted (TMBILLING_EDITION).
 *
 * What it pins:
 *  - unset (or empty) is `self_hosted`; an unknown value refuses to boot the engine, to build
 *    the dashboard and to build the docs site,
 *  - self_hosted, even with every Cloud setting on and the DB flags set: sign-up is refused and
 *    reported off, a confirmation link spends nothing, Google never routes to sign-up, the
 *    live-mode lock and the read-only state never engage and are reported `enabled` / `active`,
 *    Settings → Billing is off, the plan banner is not drawn,
 *    and the docs drop marketing pages and links,
 *  - cloud: each of those works, and each still needs its own setting.
 *
 *   pnpm verify:edition
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { config } from "@/platform/config";
import { edition, ignoredCloudSettings, signupOnFreePlan } from "@/platform/edition";
import { GoogleSignupRequired, loginWithGoogle, signup } from "@/modules/auth/service";
import { createBusiness, setOrganizationStatus } from "@/modules/tenancy/service";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { organizations } from "@db/schema";
import { eq } from "drizzle-orm";
import { pinMfaMandateOff } from "./lib/mfa-policy";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";

// The dashboard's billing client reads its URL and token at import.
process.env.ACCOUNT_BILLING_URL = "http://127.0.0.1:9";
process.env.ACCOUNT_BILLING_TOKEN = "b".repeat(64);
// The dashboard and docs-site files type-check under their own projects (Next's fetch, Nuxt's
// auto-imports), so they are loaded by a computed path the engine's tsc does not follow.
const load = <T>(path: string) => import(path) as Promise<T>;
const dashBilling = await load<{
  accountBillingEnabled(): boolean;
  getAccountBilling(org: string): Promise<unknown>;
}>("../dashboard/lib/account-billing");
const dashEdition = await load<{ isCloud(): boolean }>("../dashboard/lib/edition");
const { isMarketingPath, parseEdition, stripMarketingLinks } = await load<{
  isMarketingPath(href: string): boolean;
  parseEdition(value: string | undefined): string;
  stripMarketingLinks(markdown: string): string;
}>("../docs-site/app/utils/edition");

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, !cond && detail !== undefined ? JSON.stringify(detail) : "");
}

const cfg = config as unknown as Record<string, string | undefined>;
const saved = {
  TMBILLING_EDITION: cfg.TMBILLING_EDITION,
  SIGNUP_ENABLED: cfg.SIGNUP_ENABLED,
  SIGNUP_SANDBOX: cfg.SIGNUP_SANDBOX,
  TURNSTILE_SECRET_KEY: cfg.TURNSTILE_SECRET_KEY,
};
const savedEnvEdition = process.env.TMBILLING_EDITION;
cfg.TURNSTILE_SECRET_KEY = undefined;
pinMfaMandateOff();
setMailer({
  kind: "console",
  target: null,
  async send(_m: OutboundEmail) {
    return { providerMessageId: "fake", status: "sent" as const };
  },
});
const setEdition = (e: string) => {
  cfg.TMBILLING_EDITION = e;
  process.env.TMBILLING_EDITION = e;
};

// ——— §A parsing ————————————————————————————————————————————————————————————
/** Boot the engine's config in a child: prints the edition, or exits 1 on a bad value. */
function engineEdition(value: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: "/dev/null" };
  if (value === undefined) delete env.TMBILLING_EDITION;
  else env.TMBILLING_EDITION = value;
  const r = spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "-e",
      'import("./src/platform/edition.ts").then((m) => console.log("EDITION=" + m.edition()))',
    ],
    { env, encoding: "utf8" },
  );
  return { status: r.status, edition: /EDITION=(\w+)/.exec(r.stdout)?.[1] };
}
{
  ok("§A unset is self_hosted", engineEdition(undefined).edition === "self_hosted");
  ok("§A empty is self_hosted", engineEdition("").edition === "self_hosted");
  ok("§A cloud is cloud", engineEdition("cloud").edition === "cloud");
  const bad = engineEdition("Cloud");
  ok("§A an unknown value refuses to boot", bad.status === 1 && !bad.edition, bad);

  const next = (value: string) =>
    spawnSync("node", ["-e", 'import("./dashboard/next.config.mjs")'], {
      env: { ...process.env, TMBILLING_EDITION: value },
      encoding: "utf8",
    }).status;
  ok("§A the dashboard refuses an unknown value", next("hosted") !== 0);
  ok("§A the dashboard accepts cloud", next("cloud") === 0);

  let threw = false;
  try {
    parseEdition("hosted");
  } catch {
    threw = true;
  }
  ok(
    "§A the docs site: unset → self_hosted, cloud → cloud, unknown refused",
    parseEdition(undefined) === "self_hosted" && parseEdition("cloud") === "cloud" && threw,
  );

  /** Does the production floor raise a CLOUD_LOGGING issue for this edition and value? */
  const loggingRefused = (ed: string, logging: string | undefined) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DOTENV_CONFIG_PATH: "/dev/null",
      NODE_ENV: "production",
      TMBILLING_EDITION: ed,
    };
    if (logging === undefined) delete env.CLOUD_LOGGING;
    else env.CLOUD_LOGGING = logging;
    const r = spawnSync(
      "pnpm",
      ["exec", "tsx", "-e", 'import("./src/platform/config.ts").then(() => console.log("BOOTED"))'],
      { env, encoding: "utf8" },
    );
    return /→ at CLOUD_LOGGING/.test(r.stderr + r.stdout);
  };
  ok(
    "§A self-hosted production refuses an unstated CLOUD_LOGGING",
    loggingRefused("self_hosted", undefined),
  );
  ok(
    "§A self-hosted production accepts CLOUD_LOGGING=FALSE",
    !loggingRefused("self_hosted", "FALSE"),
  );
  ok("§A cloud production refuses CLOUD_LOGGING=FALSE", loggingRefused("cloud", "FALSE"));
  ok("§A cloud production refuses an unstated CLOUD_LOGGING", loggingRefused("cloud", undefined));
}

const app = await buildApp({ logger: false });
await clearPublicRateLimits();
const j = (r: { body: string }) => JSON.parse(r.body);
const stamp = Date.now();
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: payload as object, headers });

// One operator whose organization carries BOTH Cloud flags in the database.
const owner = await signup({
  email: `edition+${stamp}@example.com`,
  password: "Long-Passphrase-71!",
  organizationName: `Edition ${stamp}`,
});
const orgId = owner.user.organizationId;
const live = await createBusiness({
  organizationId: orgId,
  name: "Edition Live",
  defaultCurrency: "USD",
  livemode: "live",
});
const S = () => ({
  authorization: `Bearer ${owner.token}`,
  "idempotency-key": crypto.randomUUID(),
});
const lock = (liveAccess: "locked" | "enabled") =>
  systemDb.update(organizations).set({ liveAccess }).where(eq(organizations.id, orgId));
const [orgRow] = await systemDb.select().from(organizations).where(eq(organizations.id, orgId));
const orgPid = orgRow!.publicId;

/** Everything a sign-up request can show, for one edition. */
async function signupSurface() {
  const p = await post("/auth/signup", {
    name: "Ada",
    organization_name: `Edition Co ${stamp}`,
    country: "IN",
    billing_volume: "under_10k",
    gateway: "stripe",
    email: `new+${crypto.randomUUID()}@example.com`,
    password: "Long-Passphrase-71!",
  });
  const g = j(await app.inject({ method: "GET", url: "/auth/signup" }));
  const c = await post("/auth/signup/confirm", { token: "sgnp_doesnotexist" });
  let routed = false;
  try {
    await loginWithGoogle({
      googleSub: `ed-${crypto.randomUUID()}`,
      email: `g+${crypto.randomUUID()}@example.com`,
      emailVerified: true,
    });
  } catch (e) {
    routed = e instanceof GoogleSignupRequired;
  }
  return {
    post: p.statusCode,
    enabled: g.enabled,
    sandbox: g.sandbox,
    confirm: c.statusCode,
    routed,
  };
}

/** A write to the live business, and what /v1/me and /auth/me report. */
async function accountSurface() {
  const w = await post(
    `/v1/businesses/${live.publicId}/customers`,
    { email: "b@example.com" },
    S(),
  );
  const me = j(await app.inject({ method: "GET", url: "/v1/me", headers: S() }));
  const am = j(
    await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: `tmb_session=${owner.token}` },
    }),
  );
  return {
    write: w.statusCode,
    code: w.statusCode === 403 ? j(w).error?.code : undefined,
    me: [me.live_access, me.status],
    authMe: [am.organization_live_access, am.organization_status],
  };
}

// ——— §B self-hosted: every Cloud setting on, nothing Cloud engages ——————————————
setEdition("self_hosted");
cfg.SIGNUP_ENABLED = "TRUE";
cfg.SIGNUP_SANDBOX = "TRUE";
{
  ok("§B the engine reports self_hosted", edition() === "self_hosted");
  const s = await signupSurface();
  ok("§B sign-up is refused", s.post === 403, s);
  ok("§B GET /auth/signup reports it off", s.enabled === false && s.sandbox === false, s);
  ok("§B a confirmation link is refused before it is read", s.confirm === 403, s);
  ok("§B an unknown Google address is not sent to sign-up", !s.routed);
  ok("§B sign-ups would not start on the Free plan", signupOnFreePlan() === false);
  ok(
    "§B the ignored Cloud settings are named for the boot log",
    ignoredCloudSettings().join() === "SIGNUP_ENABLED,SIGNUP_SANDBOX",
  );

  await lock("locked");
  await setOrganizationStatus(orgPid, "active");
  const a = await accountSurface();
  ok("§B a locked org still writes to its live business", a.write === 201, a);
  ok(
    "§B /v1/me and /auth/me report live access enabled",
    a.me[0] === "enabled" && a.authMe[0] === "enabled",
    a,
  );

  await lock("enabled");
  await setOrganizationStatus(orgPid, "restricted", "unpaid");
  const r = await accountSurface();
  ok("§B a restricted org still writes", r.write === 201, r);
  ok(
    "§B /v1/me and /auth/me report it active",
    r.me[1] === "active" && r.authMe[1] === "active",
    r,
  );

  ok("§B the dashboard is not Cloud", dashEdition.isCloud() === false);
  ok(
    "§B Settings → Billing is not offered, even with its URL and token set",
    dashBilling.accountBillingEnabled() === false,
  );
  let refused = false;
  try {
    await dashBilling.getAccountBilling(orgPid);
  } catch (e) {
    refused = /not set up/.test((e as Error).message);
  }
  ok("§B the dashboard's billing client refuses to call", refused);
}

// ——— §C Cloud: each behaviour works, and still needs its own setting ———————————————
setEdition("cloud");
{
  ok("§C the engine reports cloud", edition() === "cloud");
  cfg.SIGNUP_ENABLED = "FALSE";
  cfg.SIGNUP_SANDBOX = "FALSE";
  const off = await signupSurface();
  ok(
    "§C sign-up stays closed without SIGNUP_ENABLED",
    off.post === 403 && off.enabled === false,
    off,
  );
  ok("§C …and a link is refused", off.confirm === 403, off);
  ok("§C without SIGNUP_SANDBOX, sign-ups are not on the Free plan", signupOnFreePlan() === false);
  cfg.SIGNUP_ENABLED = "TRUE";
  cfg.SIGNUP_SANDBOX = "TRUE";
  const on = await signupSurface();
  ok("§C with SIGNUP_ENABLED, sign-up answers 202", on.post === 202, on);
  ok(
    "§C GET /auth/signup reports it on, as a sandbox",
    on.enabled === true && on.sandbox === true,
    on,
  );
  ok("§C a bad link is read, and refused as unknown", on.confirm === 400, on);
  ok("§C an unknown Google address is sent to sign-up", on.routed);
  ok("§C sign-ups start on the Free plan", signupOnFreePlan() === true);
  ok("§C no Cloud setting is ignored", ignoredCloudSettings().length === 0);

  await lock("locked");
  await setOrganizationStatus(orgPid, "active");
  const a = await accountSurface();
  ok(
    "§C a locked org's live write answers 403 live_access_required",
    a.write === 403 && a.code === "live_access_required",
    a,
  );
  ok("§C /v1/me and /auth/me report locked", a.me[0] === "locked" && a.authMe[0] === "locked", a);

  await lock("enabled");
  await setOrganizationStatus(orgPid, "restricted", "unpaid");
  const r = await accountSurface();
  ok(
    "§C a restricted org's write answers 403 account_restricted",
    r.write === 403 && r.code === "account_restricted",
    r,
  );
  ok(
    "§C /v1/me and /auth/me report restricted",
    r.me[1] === "restricted" && r.authMe[1] === "restricted",
    r,
  );
  await setOrganizationStatus(orgPid, "active");

  ok("§C the dashboard is Cloud", dashEdition.isCloud() === true);
  ok(
    "§C Settings → Billing is offered with its URL and token",
    dashBilling.accountBillingEnabled() === true,
  );
}

// ——— §D the dashboard shell and the docs site ——————————————————————————————————
{
  const layout = readFileSync("dashboard/app/(dashboard)/layout.tsx", "utf8");
  ok(
    "§D the plan banner is drawn only on Cloud",
    /\{isCloud\(\) \? \(\s*<AccountBanner/.test(layout),
  );
  const signupCfg = readFileSync("dashboard/lib/signup-config.ts", "utf8");
  ok(
    "§D sign-up and access requests need Cloud",
    /if \(!isCloud\(\)\) return "closed";/.test(signupCfg),
  );

  ok(
    "§D marketing paths are recognised",
    isMarketingPath("/pricing") &&
      isMarketingPath("/product/tax#gst") &&
      isMarketingPath("/contact?topic=Migration") &&
      !isMarketingPath("/help/getting-started") &&
      !isMarketingPath("/products"),
  );
  const md = [
    "See [our security](/security) and [the guide](/help/guides/your-team).",
    "",
    "## Related",
    "",
    "- [Cloud pricing](/pricing)",
    "- [Go live](/help/getting-started/go-live)",
  ].join("\n");
  const out = stripMarketingLinks(md);
  ok(
    "§D a self-hosted docs page keeps docs links and loses marketing ones",
    out.includes("See our security and [the guide](/help/guides/your-team).") &&
      !out.includes("/pricing") &&
      out.includes("- [Go live](/help/getting-started/go-live)"),
    out,
  );
  ok(
    "§D a Related list with only marketing links is dropped with its heading",
    stripMarketingLinks("Text.\n\n## Related\n\n- [Pricing](/pricing)\n") === "Text.\n\n",
  );
  const nuxt = readFileSync("docs-site/nuxt.config.ts", "utf8");
  ok(
    "§D a self-hosted docs build drops the marketing pages and sends / to /help",
    /if \(CLOUD\) return;/.test(nuxt) && /\{ "\/": \{ redirect: "\/help" \} \}/.test(nuxt),
  );
}

Object.assign(cfg, saved);
setMailer(null);
if (savedEnvEdition === undefined) delete process.env.TMBILLING_EDITION;
else process.env.TMBILLING_EDITION = savedEnvEdition;
await clearPublicRateLimits();
await app.close();
await closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "❌ EDITION: FAIL" : "✅ EDITION: PASS");
process.exit(fail ? 1 : 0);
