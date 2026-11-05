/**
 * Portal link-error message: a business's own rich text for a buyer who cannot get in.
 * Covers the stored setting (sanitised on read), the business named by a DEAD link's
 * failed exchange, and the public notice the storefront renders.
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import { createOrganization } from "@/modules/tenancy/service";
import { portalSessions } from "@db/schema";
import { Tmbilling } from "../sdk/index";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

const org = await createOrganization({ name: "Link Notice Co" });
const tmb = new Tmbilling({ apiKey: org.secret, baseUrl: base });
const biz = await tmb.businesses.create({
  name: "Link Notice Biz",
  default_currency: "USD",
  livemode: "test",
});
const cus = await tmb.customers.create(biz.id, { email: "link-notice@example.com" });
await clearPublicRateLimits();

const exchange = async (token: string) => {
  const res = await fetch(`${base}/portal/v1/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
};
const notice = async (id: string) => {
  const res = await fetch(`${base}/portal/v1/link_notice/${id}`);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};

// ── Default: nothing configured ──────────────────────────────────────────────
const n0 = await notice(biz.id);
ok("notice: 200 for a known business", n0.status === 200);
ok("notice: no message configured → message_html null", n0.json.message_html === null);
ok("notice: carries the business name", n0.json.business?.name === "Link Notice Biz");
ok("notice: unknown business → 404", (await notice("biz_doesnotexist")).status === 404);

// ── Configured, with markup the allowlist must strip ─────────────────────────
await tmb.businesses.update(biz.id, {
  storefront_config: {
    portal_link_error_html:
      '<p>Email <a href="mailto:help@example.com">support</a>.</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)>',
  },
});
const n1 = await notice(biz.id);
const html = String(n1.json.message_html ?? "");
ok("configured: the message comes back", html.includes("support"));
ok("configured: a mailto link survives", html.includes('href="mailto:help@example.com"'));
ok(
  "configured: <script> is dropped with its content",
  !/<script/i.test(html) && !html.includes("alert"),
);
ok("configured: a javascript: href is dropped", !html.includes("javascript:"));
ok("configured: <img>/handlers are dropped", !/<img|onerror/i.test(html));

// Markup with no text resolves to the default, not an empty card.
await tmb.businesses.update(biz.id, {
  storefront_config: { portal_link_error_html: "<p></p><p> </p>" },
});
ok("empty markup → message_html null", (await notice(biz.id)).json.message_html === null);

const tooLong = await fetch(`${base}/v1/businesses/${biz.id}`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${org.secret}`,
    "Content-Type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: JSON.stringify({ storefront_config: { portal_link_error_html: "x".repeat(5001) } }),
});
ok("write: over 5000 chars → 400", tooLong.status === 400);

// ── Exchange names the business: on success, and for every kind of dead link ─
const live = await tmb.paymentMethods.createPortalSession(biz.id, cus.id);
const ex1 = await exchange(live.token);
ok("exchange success: 201 + business id", ex1.status === 201 && ex1.json.business === biz.id);
const spent = await exchange(live.token);
ok("spent link: 401 + business id", spent.status === 401 && spent.json.business === biz.id);
ok(
  "spent link: the usual single error message",
  (spent.json.error as { message?: string })?.message === "This link is not valid or is expired",
);

const stale = await tmb.paymentMethods.createPortalSession(biz.id, cus.id);
await systemDb
  .update(portalSessions)
  .set({ accessExpiresAt: new Date(Date.now() - 60_000) })
  .where(eq(portalSessions.publicId, stale.id));
const expired = await exchange(stale.token);
ok("expired link: 401 + business id", expired.status === 401 && expired.json.business === biz.id);

const unknown = await exchange("pstk_not_a_real_token");
ok("unknown link: 401, no business", unknown.status === 401 && unknown.json.business === undefined);

// ── Report ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length} failed`,
);
await app.close();
await closeDb();
process.exit(failed === 0 ? 0 : 1);
