/**
 * verify:pause-locks — `pause_config.locked` is enforced on the pause and resume API routes.
 *
 *   §1 lockedOverrides: only an explicit value that differs from a LOCKED default counts.
 *   §2 HTTP pause: a locked override is a 400 naming the setting and changes nothing; the
 *      default itself, an omitted option and an unlocked override all pass.
 *   §3 HTTP resume: the same for the resume keys.
 *   §4 The service is not gated: scheduled and chargeback pauses call it with their own
 *      options, so a lock must not refuse them.
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  pauseSubscriptionWithOptions,
  resumeSubscriptionWithOptions,
} from "@/modules/subscriptions/service";
import {
  lockedOverrides,
  resolvePauseConfig,
  type PauseConfigKey,
} from "@/modules/subscriptions/pause-config";
import { businesses, subscriptions } from "@db/schema";

const checks: Array<[string, boolean, string]> = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

// §1 — pure
{
  const cfg = (locked: PauseConfigKey[], extra: Record<string, unknown> = {}) =>
    resolvePauseConfig({ pauseConfig: { locked, ...extra } });
  ok(
    "1a: nothing locked → nothing refused",
    lockedOverrides(cfg([]), { dunning_handling: "stop" }).length === 0,
  );
  ok(
    "1b: locked + different value → refused",
    lockedOverrides(cfg(["dunning_on_pause"]), { dunning_handling: "stop" }).join() ===
      "dunning_on_pause",
  );
  ok(
    "1c: locked + the default itself → allowed",
    lockedOverrides(cfg(["dunning_on_pause"]), { dunning_handling: "continue" }).length === 0,
  );
  ok("1d: locked + omitted → allowed", lockedOverrides(cfg(["dunning_on_pause"]), {}).length === 0);
  ok(
    "1e: unbilled no_action maps to retain",
    lockedOverrides(cfg(["unbilled_on_pause"]), { unbilled_charges_handling: "no_action" })
      .length === 0,
  );
  ok(
    "1f: unbilled delete has no stored twin, so it is refused when locked",
    lockedOverrides(cfg(["unbilled_on_pause"]), { unbilled_charges_handling: "delete" }).length ===
      1,
  );
  ok(
    "1g: locked pause_option refuses specific_date",
    lockedOverrides(cfg(["pause_option"], { pause_option: "end_of_term" }), {
      pause_option: "specific_date",
    }).join() === "pause_option",
  );
}

const org = await createOrganization({ name: "Pause Locks Org" });
const orgId = org.organization.id;
const app = await buildApp({ logger: false });
const { secret } = await createApiKey(orgId, "test");
let keyN = 0;
const post = (path: string, payload: unknown) =>
  app.inject({
    method: "POST",
    url: path,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "idempotency-key": `pause-locks-${keyN++}`,
    },
    payload: JSON.stringify(payload),
  });

async function fixture(label: string, pauseConfig: Record<string, unknown>) {
  const biz = await createBusiness({
    organizationId: orgId,
    name: `Locks ${label}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  await withTenant(orgId, (tx) =>
    tx.update(businesses).set({ pauseConfig }).where(eq(businesses.id, biz.id)),
  );
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${label.replace(/\W+/g, "-")}@locks.test`,
  });
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: `P ${label}`,
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  return { biz, sub: subscription };
}
const status = async (id: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select({ s: subscriptions.status }).from(subscriptions).where(eq(subscriptions.id, id)),
    )
  )[0]!.s;
const url = (biz: string, sub: string, op: string) =>
  `/v1/businesses/${biz}/subscriptions/${sub}/${op}`;

// §2 — pause over HTTP
{
  const { biz, sub } = await fixture("pause", {
    dunning_on_pause: "stop",
    locked: ["dunning_on_pause"],
  });
  const refused = await post(url(biz.publicId, sub.publicId, "pause"), {
    dunning_handling: "continue",
  });
  const msg = (refused.json() as { error?: { message?: string } }).error?.message ?? "";
  ok("2a: locked override → 400", refused.statusCode === 400, `status=${refused.statusCode}`);
  ok("2b: the message names the setting", msg.includes("Retries on pause"), msg);
  ok("2c: a refused pause changes nothing", (await status(sub.id)) === "active");
  const allowed = await post(url(biz.publicId, sub.publicId, "pause"), {
    dunning_handling: "stop",
    unbilled_charges_handling: "invoice",
  });
  ok(
    "2d: the locked default itself + an unlocked override → 200",
    allowed.statusCode === 200 && (await status(sub.id)) === "paused",
    `status=${allowed.statusCode} ${allowed.body.slice(0, 200)}`,
  );
}
{
  const { biz, sub } = await fixture("pause omitted", { locked: ["pause_option"] });
  const r = await post(url(biz.publicId, sub.publicId, "pause"), {});
  ok("2e: options omitted → 200", r.statusCode === 200, `status=${r.statusCode}`);
}

// §3 — resume over HTTP
{
  const { biz, sub } = await fixture("resume", {
    unpaid_invoices_on_resume: "schedule_payment_collection",
    locked: ["unpaid_invoices_on_resume"],
  });
  await post(url(biz.publicId, sub.publicId, "pause"), {});
  const refused = await post(url(biz.publicId, sub.publicId, "resume"), {
    unpaid_invoices_handling: "no_action",
  });
  ok(
    "3a: locked resume override → 400",
    refused.statusCode === 400,
    `status=${refused.statusCode}`,
  );
  ok("3b: still paused", (await status(sub.id)) === "paused");
  const allowed = await post(url(biz.publicId, sub.publicId, "resume"), {});
  ok(
    "3c: resume with options omitted → 200",
    allowed.statusCode === 200,
    `status=${allowed.statusCode}`,
  );
}

// §4 — the service is not gated
{
  const { biz, sub } = await fixture("service", {
    dunning_on_pause: "stop",
    locked: ["dunning_on_pause"],
  });
  let threw = "";
  try {
    await pauseSubscriptionWithOptions({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      now: new Date(),
      dunningHandling: "continue",
    });
    await resumeSubscriptionWithOptions({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      now: new Date(),
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("4a: a direct service pause/resume ignores locks", threw === "", threw);
}

await app.close();
let failed = 0;
for (const [name, pass, detail] of checks) {
  if (pass) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
console.log(
  failed === 0
    ? `\n✅ PAUSE-LOCKS: PASS (${checks.length} checks)`
    : `\n❌ PAUSE-LOCKS: FAIL — ${failed} of ${checks.length}`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
