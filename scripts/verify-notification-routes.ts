/**
 * Notification routes (0533) over real HTTP: a member reads and saves their own settings,
 * destinations are for owners and admins, the bell touches only the caller's rows, and the
 * deprecated team alerts API answers from the destinations.
 *
 *   pnpm exec tsx scripts/lib/verify-run.ts scripts/verify-notification-routes.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { authTokens, notifications } from "@db/schema";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { setMailer } from "@/providers/mailer";
import { acceptInvite, inviteUser, signup } from "@/modules/auth/service";
import { createBusiness } from "@/modules/tenancy/service";
import { pinMfaMandateOff } from "./lib/mfa-policy";

pinMfaMandateOff();
setMailer({
  kind: "smtp",
  target: null,
  async send() {
    return { providerMessageId: "p", status: "sent" };
  },
});

const app = await buildApp({ logger: false });
const checks: Array<[string, boolean, string?]> = [];
const ok = (n: string, c: boolean, why?: string) => checks.push([n, c, c ? undefined : why]);
const uniq = randomBytes(4).toString("hex");
const PW = "Heron-Lattice-50217";

const owner = await signup({
  email: `ntf-owner-${uniq}@example.com`,
  password: PW,
  organizationName: `Notifications ${uniq}`,
});
const orgId = owner.user.organizationId;
const ownerCookie = `tmb_session=${owner.token}`;
const biz = await createBusiness({
  organizationId: orgId,
  name: `Notify Biz ${uniq}`,
  defaultCurrency: "USD",
  livemode: "live",
});

const invited = await inviteUser({
  organizationId: orgId,
  email: `ntf-manager-${uniq}@example.com`,
  role: "manager",
});
const tok = `invt_${randomBytes(32).toString("base64url")}`;
await systemDb.insert(authTokens).values({
  userId: invited.userId,
  tokenHash: createHash("sha256").update(tok).digest("hex"),
  purpose: "invite",
  expiresAt: new Date(Date.now() + 3600_000),
});
const manager = await acceptInvite(tok, PW);
const managerCookie = `tmb_session=${manager.token}`;

const call = (method: string, url: string, cookie: string | null, payload?: unknown) =>
  app.inject({
    method: method as "GET",
    url,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

// ── A. a member reads and saves their own preferences ──
{
  const anon = await call("GET", "/auth/notifications/preferences", null);
  ok("A0 no session → 401", anon.statusCode === 401, anon.body);

  const before = await call("GET", "/auth/notifications/preferences", managerCookie);
  const b = before.json();
  ok(
    "A1 GET preferences → 200, not set up",
    before.statusCode === 200 && b.set_up === false,
    before.body,
  );
  ok(
    "A2 the catalogue and the live business are listed",
    Array.isArray(b.catalogue) &&
      b.catalogue.length > 0 &&
      b.businesses.some((x: { id: string }) => x.id === biz.publicId),
    before.body,
  );

  const put = await call("PUT", "/auth/notifications/preferences", managerCookie, {
    ...b,
    default: { payment_failed: { timing: "summary", push: false, email: true } },
  });
  const p = put.json();
  ok(
    "A3 PUT (the GET object sent back) saves and seeds",
    put.statusCode === 200 && p.set_up === true && p.default.payment_failed.timing === "summary",
    put.body,
  );
  const again = (await call("GET", "/auth/notifications/preferences", managerCookie)).json();
  ok("A4 the save persists", again.default?.payment_failed?.timing === "summary");
  const ownerView = (await call("GET", "/auth/notifications/preferences", ownerCookie)).json();
  ok("A5 another member's settings are untouched", ownerView.set_up === false);

  const bad = await call("PUT", "/auth/notifications/preferences", managerCookie, { nope: 1 });
  ok("A6 an unknown key → 400", bad.statusCode === 400, bad.body);

  const s = await call("PUT", "/auth/notifications/settings", managerCookie, {
    timezone: "Asia/Kolkata",
    summary_hour: 9,
  });
  ok(
    "A7 PUT settings → 200",
    s.statusCode === 200 && s.json().timezone === "Asia/Kolkata" && s.json().summary_hour === 9,
    s.body,
  );
  const cfg = await call("GET", "/auth/notifications/push/config", managerCookie);
  ok("A8 push config answers", cfg.statusCode === 200 && "public_key" in cfg.json(), cfg.body);
}

// ── B. destinations are for owners and admins ──
{
  const list = await call("GET", "/auth/notification_destinations", managerCookie);
  ok(
    "B1 a manager cannot list destinations (403)",
    list.statusCode === 403 && list.json().error?.type === "permission_error",
    list.body,
  );
  const add = await call("POST", "/auth/notification_destinations", managerCookie, {
    type: "email",
    email: `ops-${uniq}@example.com`,
  });
  ok("B2 a manager cannot add one (403)", add.statusCode === 403, add.body);

  const ownerAdd = await call("POST", "/auth/notification_destinations", ownerCookie, {
    type: "email",
    email: owner.user.email,
    daily: true,
  });
  ok(
    "B3 the owner adds a member's address: active at once",
    ownerAdd.statusCode === 201 && ownerAdd.json().status === "active",
    ownerAdd.body,
  );
  const ownerList = await call("GET", "/auth/notification_destinations", ownerCookie);
  ok(
    "B4 the owner lists it",
    ownerList.statusCode === 200 && ownerList.json().data.length === 1,
    ownerList.body,
  );
  const badChat = await call("POST", "/auth/notification_destinations", ownerCookie, {
    type: "chat",
    name: "Ops",
    url: "https://example.com/hook",
  });
  ok("B5 a URL that is not Google Chat → 400", badChat.statusCode === 400, badChat.body);
}

// ── C. the bell: mark-read touches only the caller's rows ──
{
  const row = (userId: string) => ({
    publicId: publicId("ntf"),
    organizationId: orgId,
    businessId: biz.id,
    userId,
    kind: "payment_failed",
    tone: "destructive",
    timing: "instant",
    title: "Payment failed: $49.00",
    body: "Card declined.",
  });
  const mine = row(manager.user.userId);
  const theirs = row(owner.user.userId);
  await withTenant(orgId, (tx) => tx.insert(notifications).values([mine, theirs]));

  const count = await call("GET", "/auth/notifications/unread_count", managerCookie);
  ok(
    "C1 unread count is the caller's own",
    count.json().count === 1 && count.json().destructive === true,
    count.body,
  );
  const feed = await call("GET", "/auth/notifications?unread=1", managerCookie);
  ok(
    "C2 the feed lists only the caller's row",
    feed.json().data.length === 1 && feed.json().data[0].id === mine.publicId,
    feed.body,
  );
  const other = await call("POST", `/auth/notifications/${theirs.publicId}/read`, managerCookie);
  ok("C3 another member's row → 404", other.statusCode === 404, other.body);
  const all = await call("POST", "/auth/notifications/read_all", managerCookie, {});
  ok(
    "C4 read_all marks the caller's row",
    all.statusCode === 200 && all.json().marked === 1,
    all.body,
  );
  const [t] = await withTenant(orgId, (tx) =>
    tx
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(and(eq(notifications.publicId, theirs.publicId))),
  );
  ok("C5 the owner's row is still unread", t?.readAt === null);
  const own = await call("POST", `/auth/notifications/${mine.publicId}/read`, managerCookie);
  ok("C6 marking the caller's own row read again → 200", own.statusCode === 200, own.body);
}

// ── D. the deprecated team alerts API ──
{
  const old = await call("POST", "/auth/team_alerts/confirm", null, { token: "x" });
  ok(
    "D1 the old confirm link is retired (410)",
    old.statusCode === 410 && /no longer used/.test(old.json().error?.message ?? ""),
    old.body,
  );
  const patch = await app.inject({
    method: "PATCH",
    url: `/v1/businesses/${biz.publicId}`,
    headers: {
      cookie: ownerCookie,
      "content-type": "application/json",
      "idempotency-key": `ntf-${uniq}`,
    },
    payload: {
      team_alerts_config: {
        recipients: [owner.user.email],
        overdue: { enabled: true, thresholds: { USD: 10000 } },
        daily_digest: { enabled: true },
      },
    },
  });
  const cfg = patch.json().team_alerts_config;
  ok(
    "D2 PATCH team_alerts_config answers in the old shape",
    patch.statusCode === 200 &&
      cfg?.recipients?.[0] === owner.user.email &&
      cfg.overdue.enabled === true &&
      cfg.overdue.thresholds.USD === 10000 &&
      cfg.daily_digest.enabled === true &&
      cfg.webhook_failures.enabled === false,
    patch.body,
  );
  const rec = await call(
    "GET",
    `/v1/businesses/${biz.publicId}/team_alert_recipients`,
    ownerCookie,
  );
  ok(
    "D3 recipients answer from the destinations",
    rec.statusCode === 200 &&
      rec.json().data[0]?.state === "member" &&
      rec.headers["deprecation"] === "true",
    rec.body,
  );
  const get = await call("GET", `/v1/businesses/${biz.publicId}`, ownerCookie);
  ok(
    "D4 GET business reads the same config",
    get.json().team_alerts_config?.recipients?.[0] === owner.user.email,
    get.body,
  );
  const off = await app.inject({
    method: "PATCH",
    url: `/v1/businesses/${biz.publicId}`,
    headers: {
      cookie: ownerCookie,
      "content-type": "application/json",
      "idempotency-key": `ntf-off-${uniq}`,
    },
    payload: { team_alerts_config: null },
  });
  ok(
    "D5 null turns every alert off and removes the recipients",
    off.statusCode === 200 && off.json().team_alerts_config.recipients.length === 0,
    off.body,
  );
  const invalid = await app.inject({
    method: "PATCH",
    url: `/v1/businesses/${biz.publicId}`,
    headers: {
      cookie: ownerCookie,
      "content-type": "application/json",
      "idempotency-key": `ntf-bad-${uniq}`,
    },
    payload: { team_alerts_config: { recipients: [], daily_digest: { enabled: true } } },
  });
  ok("D6 the old validation still refuses", invalid.statusCode === 400, invalid.body);
}

await app.close();
await closeDb();

let failed = 0;
for (const [name, pass, why] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${name}${why ? `\n    ${why.slice(0, 400)}` : ""}`);
  if (!pass) failed++;
}
console.log(
  failed === 0
    ? `\n✅ NOTIFICATION ROUTES: PASS (${checks.length})`
    : `\n❌ NOTIFICATION ROUTES: FAIL (${failed}/${checks.length})`,
);
process.exit(failed === 0 ? 0 : 1);
