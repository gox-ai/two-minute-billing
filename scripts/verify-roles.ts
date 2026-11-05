/**
 * Custom roles, finer permissions and per-resource API key permissions (0389–0391), over real HTTP.
 *
 *  - § D2–D4 the defects found while designing this (each failed on the code before the fix):
 *        a developer minted a full-access write key; two admins demoting each other at once
 *        left an org with no admin; an admin could demote or remove the last owner
 *  - § F fixed roles: every route key allows exactly the roles its legacy level allowed, and a
 *        real route per level answers 403 to exactly the roles below it
 *  - § C custom roles: CRUD, reserved and look-alike names, unknown keys, escalation, self-edit,
 *        delete in use, cross-org role refused by the database, an edit bites on the next request
 *  - § K API key maps: enforced per resource and mode, NULL keys unchanged, grant only what
 *        you hold (session and key), rotation copies the map, PATCH narrows, members-only routes
 *  - § A audit rows and the role_changed security event
 *
 *   pnpm verify:roles
 */
import { and, eq, desc } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import {
  apiKeys,
  auditLogs,
  authTokens,
  memberships,
  roles,
  securityEvents,
  users,
} from "@db/schema";
import { signup, inviteUser, acceptInvite } from "@/modules/auth/service";
import { createApiKey, createBusiness } from "@/modules/tenancy/service";
import { routePermissions } from "@/api/permission-registry";
import {
  FIXED_ROLES,
  fixedRolePermissions,
  legacyAllows,
  permissionDef,
} from "@/modules/auth/permissions";
import { pinMfaMandateOff } from "./lib/mfa-policy";

pinMfaMandateOff();
const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const uniq = randomBytes(4).toString("hex");
const PW = "Correct-Horse-Battery-9";

type Fixed = "owner" | "admin" | "manager" | "ops" | "developer";
async function memberSession(orgId: string, email: string, role: string) {
  const invited = await inviteUser({ organizationId: orgId, email, role });
  const tok = `invt_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId: invited.userId,
    tokenHash: createHash("sha256").update(tok).digest("hex"),
    purpose: "invite",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const s = await acceptInvite(tok, PW);
  return { token: s.token, publicId: invited.userPublicId, userId: invited.userId };
}
type Method = "GET" | "POST" | "PATCH" | "DELETE";
const call = (cookie: string, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie: `tmb_session=${cookie}`, "idempotency-key": randomBytes(8).toString("hex") },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const withKey = (secret: string, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${secret}`,
      "idempotency-key": randomBytes(8).toString("hex"),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const roleOf = async (userId: string, orgId: string) =>
  (
    await systemDb
      .select({ r: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, orgId)))
  )[0]?.r;
const body = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>;
const ownerPublicId = async (userId: string) =>
  (await systemDb.select().from(users).where(eq(users.id, userId)))[0]!.publicId;

// ── § D2 · a developer mints a full-access write key ─────────────────────────────
{
  const o = await signup({
    email: `rb2-${uniq}@example.com`,
    password: PW,
    organizationName: `RB2 ${uniq}`,
  });
  const dev = await memberSession(
    o.user.organizationId,
    `rb2-dev-${uniq}@example.com`,
    "developer",
  );
  const res = await call(dev.token, "POST", "/v1/api_keys", { name: "full" });
  ok(
    `§D2 a developer cannot mint a full-access write key (got ${res.statusCode})`,
    res.statusCode === 403,
  );
  ok("§D2 …refused as an escalation", body(res).error?.code === "permission_escalation");
  const narrow = await call(dev.token, "POST", "/v1/api_keys", {
    permissions: { webhooks: "write", api_keys: "read" },
  });
  ok(
    `§D2 …but can mint a key inside their own rights (got ${narrow.statusCode})`,
    narrow.statusCode === 201,
  );
  const own = await call(o.token, "POST", "/v1/api_keys", { name: "owner full" });
  ok(
    "§D2 an owner still mints a full-access key",
    own.statusCode === 201 && body(own).permissions === null,
  );
}

// ── § D3 · two admins demote each other at the same moment ───────────────────────
{
  let broken = 0;
  let oneWon = 0;
  const rounds = 6;
  for (let i = 0; i < rounds; i++) {
    const o = await signup({
      email: `rb3-${i}-${uniq}@example.com`,
      password: PW,
      organizationName: `RB3 ${uniq}`,
    });
    const orgId = o.user.organizationId;
    const a = await memberSession(orgId, `rb3-a-${i}-${uniq}@example.com`, "admin");
    const b = await memberSession(orgId, `rb3-b-${i}-${uniq}@example.com`, "admin");
    // An org that has already lost its owner: only the two admins administer it.
    await systemDb
      .update(memberships)
      .set({ role: "manager" })
      .where(and(eq(memberships.userId, o.user.userId), eq(memberships.organizationId, orgId)));
    const [ra, rb] = await Promise.all([
      call(a.token, "PATCH", `/auth/members/${b.publicId}`, { role: "manager" }),
      call(b.token, "PATCH", `/auth/members/${a.publicId}`, { role: "manager" }),
    ]);
    const admins = [await roleOf(a.userId, orgId), await roleOf(b.userId, orgId)].filter(
      (r) => r === "admin",
    ).length;
    if (admins === 0) broken++;
    if ([ra.statusCode, rb.statusCode].filter((s) => s === 200).length === 1) oneWon++;
  }
  ok(
    `§D3 concurrent demotions never leave an org with no admin (${broken}/${rounds} broke it)`,
    broken === 0,
  );
  ok(`§D3 …exactly one of the two demotions wins (${oneWon}/${rounds})`, oneWon === rounds);
}

// ── § D4 · the last owner ──────────────────────────────────────────────────────
{
  const o = await signup({
    email: `rb4-${uniq}@example.com`,
    password: PW,
    organizationName: `RB4 ${uniq}`,
  });
  const orgId = o.user.organizationId;
  const a = await memberSession(orgId, `rb4-a-${uniq}@example.com`, "admin");
  const owner = await ownerPublicId(o.user.userId);
  const demote = await call(a.token, "PATCH", `/auth/members/${owner}`, { role: "manager" });
  ok(
    `§D4 an admin cannot demote the last owner (got ${demote.statusCode})`,
    demote.statusCode >= 400,
  );
  const remove = await call(a.token, "DELETE", `/auth/members/${owner}`);
  ok(
    `§D4 an admin cannot remove the last owner (got ${remove.statusCode})`,
    remove.statusCode >= 400,
  );
  ok("§D4 the org still has an owner", (await roleOf(o.user.userId, orgId)) === "owner");
  // A second owner makes the first one removable.
  const o2 = await memberSession(orgId, `rb4-o2-${uniq}@example.com`, "owner");
  const ok2 = await call(o2.token, "PATCH", `/auth/members/${owner}`, { role: "manager" });
  ok("§D4 …with a second owner the first may be demoted", ok2.statusCode === 200);
}

// ── § F · fixed roles keep exactly today's access ───────────────────────────────
{
  let mismatched = 0;
  let pairs = 0;
  for (const d of routePermissions().values()) {
    if (!d.key) continue;
    const def = permissionDef(d.key)!;
    for (const role of FIXED_ROLES) {
      pairs++;
      if (fixedRolePermissions(role).has(d.key) !== legacyAllows(role, def.legacy)) mismatched++;
    }
  }
  ok(`§F every route key × fixed role = the legacy matrix (${pairs} pairs)`, mismatched === 0);

  const o = await signup({
    email: `rf-${uniq}@example.com`,
    password: PW,
    organizationName: `RF ${uniq}`,
  });
  const orgId = o.user.organizationId;
  const biz = await createBusiness({
    organizationId: orgId,
    name: `RF ${uniq}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const sessions: Record<Fixed, string> = { owner: o.token } as Record<Fixed, string>;
  for (const r of ["admin", "manager", "ops", "developer"] as const)
    sessions[r] = (await memberSession(orgId, `rf-${r}-${uniq}@example.com`, r)).token;
  const B = `/v1/businesses/${biz.publicId}`;
  // One real route per legacy level. A refusal must be OUR refusal (code), not a 400 or 404.
  const probes: Array<[string, Method, string, unknown]> = [
    ["any", "GET", `${B}/customers`, undefined],
    ["ops", "POST", `${B}/customers`, { email: `rf-c-${uniq}@example.com` }],
    ["manager", "POST", `${B}/coupons`, {}],
    ["developer", "POST", "/v1/webhook_endpoints", {}],
    ["admin", "POST", `${B}/reason_codes`, {}],
  ];
  for (const [level, method, url, payload] of probes) {
    const wrong: string[] = [];
    for (const r of FIXED_ROLES) {
      const res = await call(sessions[r], method, url, payload);
      const refused = res.statusCode === 403 && body(res).error?.code === "missing_permission";
      if (refused === legacyAllows(r, level as never)) wrong.push(`${r}:${res.statusCode}`);
    }
    ok(
      `§F ${level}-level ${method} ${url.replace(B, "")} answers by the legacy matrix ${wrong.join(" ")}`,
      wrong.length === 0,
    );
  }
}

// ── § C · custom roles ─────────────────────────────────────────────────────────
{
  const o = await signup({
    email: `rc-${uniq}@example.com`,
    password: PW,
    organizationName: `RC ${uniq}`,
  });
  const orgId = o.user.organizationId;
  const biz = await createBusiness({
    organizationId: orgId,
    name: `RC ${uniq}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const B = `/v1/businesses/${biz.publicId}`;

  const create = (cookie: string, p: unknown) => call(cookie, "POST", "/v1/roles", p);
  const support = await create(o.token, {
    name: "Support",
    description: "Reads customers",
    permissions: ["customers:view", "invoices:view"],
  });
  ok(
    "§C an owner creates a custom role",
    support.statusCode === 201 && body(support).member_count === 0,
  );
  const supportId = body(support).id as string;

  for (const name of ["Admin", "ＡＤＭＩＮ", "Ad​min", "Admin ", " owner "]) {
    const r = await create(o.token, { name, permissions: ["customers:view"] });
    ok(`§C reserved name ${JSON.stringify(name)} → 400`, r.statusCode === 400);
  }
  const dup = await create(o.token, { name: " support ", permissions: ["customers:view"] });
  ok("§C a duplicate name (after normalising) → 409", dup.statusCode === 409);
  const unknown = await create(o.token, { name: "Odd", permissions: ["customers:fly"] });
  ok("§C an unknown permission → 400", unknown.statusCode === 400);
  const empty = await create(o.token, { name: "Empty", permissions: [] });
  ok("§C no permissions → 400", empty.statusCode === 400);

  // A member with the custom role: allowed what it holds, refused the rest.
  const sup = await memberSession(orgId, `rc-sup-${uniq}@example.com`, supportId);
  ok(
    "§C the member reads customers",
    (await call(sup.token, "GET", `${B}/customers`)).statusCode === 200,
  );
  const write = await call(sup.token, "POST", `${B}/customers`, {
    email: `rc-x-${uniq}@example.com`,
  });
  ok(
    "§C …and is refused a write it lacks",
    write.statusCode === 403 && body(write).error?.required === "customers:manage",
  );
  const me = body(await call(sup.token, "GET", "/auth/me"));
  ok(
    "§C /auth/me returns the custom role and its permissions",
    me.role === "custom" &&
      me.custom_role?.id === supportId &&
      me.permissions?.join() === "customers:view,invoices:view",
  );

  // An edit bites on the next request.
  const v = body(await call(o.token, "GET", `/v1/roles/${supportId}`)).version as number;
  const edited = await call(o.token, "PATCH", `/v1/roles/${supportId}`, {
    permissions: ["invoices:view"],
    version: v,
  });
  ok("§C an owner edits the role", edited.statusCode === 200 && body(edited).version === v + 1);
  ok(
    "§C …and it bites on the member's next request",
    (await call(sup.token, "GET", `${B}/customers`)).statusCode === 403,
  );
  const stale = await call(o.token, "PATCH", `/v1/roles/${supportId}`, {
    name: "Support 2",
    version: v,
  });
  ok("§C a stale version → 409", stale.statusCode === 409);

  // Escalation: an "HR" role holds members:* only.
  const hr = body(
    await create(o.token, { name: "HR", permissions: ["members:view", "members:manage"] }),
  ).id as string;
  const hrm = await memberSession(orgId, `rc-hr-${uniq}@example.com`, hr);
  const asAdmin = await call(hrm.token, "POST", "/auth/invite", {
    email: `rc-new-${uniq}@example.com`,
    role: "admin",
  });
  ok("§C a members:manage role cannot invite an admin", asAdmin.statusCode === 403);
  const asHr = await call(hrm.token, "POST", "/auth/invite", {
    email: `rc-new2-${uniq}@example.com`,
    role: hr,
  });
  ok("§C …but can invite into a role it covers", asHr.statusCode === 201);
  const ownerId = await ownerPublicId(o.user.userId);
  ok(
    "§C …cannot remove an owner",
    (await call(hrm.token, "DELETE", `/auth/members/${ownerId}`)).statusCode === 403,
  );
  ok(
    "§C …cannot change the support member (role not a subset)",
    (await call(hrm.token, "PATCH", `/auth/members/${sup.publicId}`, { role: hr })).statusCode ===
      403,
  );
  const hrRolesManage = body(
    await create(o.token, {
      name: "Role admin",
      permissions: ["roles:view", "roles:manage", "customers:view"],
    }),
  ).id as string;
  const ra = await memberSession(orgId, `rc-ra-${uniq}@example.com`, hrRolesManage);
  const wider = await create(ra.token, {
    name: "Wider",
    permissions: ["customers:view", "invoices:void"],
  });
  ok("§C a role manager cannot create a role with a key they lack", wider.statusCode === 403);
  const self = await call(ra.token, "PATCH", `/v1/roles/${hrRolesManage}`, { name: "Mine" });
  ok("§C …and cannot edit the role they hold", self.statusCode === 403);

  // Delete: refused in use, allowed when unassigned.
  const del = await call(o.token, "DELETE", `/v1/roles/${supportId}`);
  ok("§C deleting a role in use → 409", del.statusCode === 409);
  await call(o.token, "PATCH", `/auth/members/${sup.publicId}`, { role: "ops" });
  ok(
    "§C …and succeeds once unassigned",
    (await call(o.token, "DELETE", `/v1/roles/${supportId}`)).statusCode === 200,
  );
  ok(
    "§C a deleted role is gone from the list",
    !(body(await call(o.token, "GET", "/v1/roles")).data as Array<{ id: string }>).some(
      (r) => r.id === supportId,
    ),
  );

  // Cross-org: the composite FK refuses a role from another organization.
  const other = await signup({
    email: `rc-o-${uniq}@example.com`,
    password: PW,
    organizationName: `RCO ${uniq}`,
  });
  const [foreign] = await systemDb.select().from(roles).where(eq(roles.publicId, hr));
  const crossOrg = await systemDb
    .update(memberships)
    .set({ role: "custom", customRoleId: foreign!.id })
    .where(eq(memberships.userId, other.user.userId))
    .then(() => false)
    .catch(() => true);
  ok("§C a role from another organization is refused by the database", crossOrg);
  const inconsistent = await systemDb
    .update(memberships)
    .set({ role: "custom", customRoleId: null })
    .where(eq(memberships.userId, other.user.userId))
    .then(() => false)
    .catch(() => true);
  ok("§C role 'custom' without a custom role is refused by the database", inconsistent);

  // An API key never manages roles.
  const k = await createApiKey(orgId, "test");
  const kr = await withKey(k.secret, "GET", "/v1/roles");
  ok(
    "§C an API key cannot read roles (members only)",
    kr.statusCode === 403 && body(kr).error?.code === "key_missing_permission",
  );
  ok(
    "§C the catalogue is open to keys",
    (await withKey(k.secret, "GET", "/v1/permissions")).statusCode === 200,
  );

  // § A · audit + security event
  const rows = await systemDb
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, orgId))
    .orderBy(desc(auditLogs.createdAt));
  const acts = new Set(rows.map((r) => r.action));
  ok(
    "§A role.create / role.update / role.delete are audited",
    ["role.create", "role.update", "role.delete"].every((a) => acts.has(a)),
  );
  ok(
    "§A team.role_change is audited with the custom role",
    rows.some(
      (r) => r.action === "team.role_change" && JSON.stringify(r.before).includes(supportId),
    ),
  );
  const sec = body(await call(o.token, "GET", "/v1/audit_logs?category[is]=security&limit=100"));
  ok(
    "§A the security filter of the audit log includes role changes",
    (sec.data as Array<{ action: string }>).some((r) => r.action === "role.create"),
  );
  const ev = await systemDb
    .select()
    .from(securityEvents)
    .where(and(eq(securityEvents.userId, sup.userId), eq(securityEvents.kind, "role_changed")));
  ok("§A the member gets a role_changed security event", ev.length === 1);
}

// ── § K · API key permission maps ──────────────────────────────────────────────
{
  const o = await signup({
    email: `rk-${uniq}@example.com`,
    password: PW,
    organizationName: `RK ${uniq}`,
  });
  const orgId = o.user.organizationId;
  const biz = await createBusiness({
    organizationId: orgId,
    name: `RK ${uniq}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const B = `/v1/businesses/${biz.publicId}`;
  const mint = async (cookie: string, p: unknown) => call(cookie, "POST", "/v1/api_keys", p);

  const inv = body(await mint(o.token, { permissions: { invoices: "read" } }));
  ok(
    "§K a map key is minted with scope read",
    inv.scope === "read" && inv.permissions?.invoices === "read",
  );
  ok("§K …reads invoices", (await withKey(inv.secret, "GET", `${B}/invoices`)).statusCode === 200);
  const cus = await withKey(inv.secret, "GET", `${B}/customers`);
  ok(
    "§K …is refused customers (not in the map)",
    cus.statusCode === 403 && body(cus).error?.code === "key_missing_permission",
  );

  const w = body(await mint(o.token, { permissions: { customers: "write", invoices: "read" } }));
  ok(
    "§K a write map writes its resource",
    (await withKey(w.secret, "POST", `${B}/customers`, { email: `rk-c-${uniq}@example.com` }))
      .statusCode < 300,
  );
  const vd = await withKey(w.secret, "POST", `${B}/invoices/in_none/void`, {});
  ok(
    "§K …and is refused a write on a read resource",
    vd.statusCode === 403 && body(vd).error?.required === "invoices:void",
  );

  const est = body(await mint(o.token, { permissions: { subscriptions: "read" } }));
  const e = await withKey(est.secret, "POST", `${B}/customers/cus_none/subscription_estimate`, {
    items: [],
  });
  ok("§K a read map reaches a read-scope estimate POST", e.statusCode !== 403);

  // NULL keys behave exactly as before.
  const full = await createApiKey(orgId, "test", "api", "write");
  const read = await createApiKey(orgId, "test", "api", "read");
  ok(
    "§K a NULL write key writes",
    (await withKey(full.secret, "POST", `${B}/customers`, { email: `rk-n-${uniq}@example.com` }))
      .statusCode < 300,
  );
  ok(
    "§K a NULL read key reads",
    (await withKey(read.secret, "GET", `${B}/customers`)).statusCode === 200,
  );
  const rw = await withKey(read.secret, "POST", `${B}/customers`, {
    email: `rk-r-${uniq}@example.com`,
  });
  ok(
    "§K a NULL read key is still refused a write, with the old message",
    rw.statusCode === 403 && rw.body.includes("read-only"),
  );

  // Validation.
  ok(
    "§K an unknown resource → 400",
    (await mint(o.token, { permissions: { spaceships: "read" } })).statusCode === 400,
  );
  ok(
    "§K a members-only resource → 400",
    (await mint(o.token, { permissions: { members: "read" } })).statusCode === 400,
  );
  ok(
    "§K scope disagreeing with the map → 400",
    (await mint(o.token, { scope: "write", permissions: { invoices: "read" } })).statusCode === 400,
  );

  // A key minting a key: only inside its own grant.
  const keyMaker = body(
    await mint(o.token, { permissions: { api_keys: "write", webhooks: "write" } }),
  );
  ok(
    "§K a key cannot mint a full key",
    (await withKey(keyMaker.secret, "POST", "/v1/api_keys", {})).statusCode === 403,
  );
  ok(
    "§K …nor a map wider than its own",
    (await withKey(keyMaker.secret, "POST", "/v1/api_keys", { permissions: { customers: "read" } }))
      .statusCode === 403,
  );
  ok(
    "§K …but can mint inside it",
    (await withKey(keyMaker.secret, "POST", "/v1/api_keys", { permissions: { webhooks: "read" } }))
      .statusCode === 201,
  );

  // Rotation copies the map; PATCH narrows it.
  const rot = await call(o.token, "POST", `/v1/api_keys/${w.id}/rotate`, { overlap_seconds: 0 });
  ok(
    "§K rotation copies the map",
    rot.statusCode === 201 && body(rot).permissions?.customers === "write",
  );
  const patched = await call(o.token, "PATCH", `/v1/api_keys/${inv.id}`, {
    permissions: { invoices: "read", customers: "read" },
  });
  ok(
    "§K PATCH changes the map",
    patched.statusCode === 200 && body(patched).permissions?.customers === "read",
  );
  ok(
    "§K …and it bites at once",
    (await withKey(inv.secret, "GET", `${B}/customers`)).statusCode === 200,
  );
  const dev = await memberSession(orgId, `rk-dev-${uniq}@example.com`, "developer");
  const widen = await call(dev.token, "PATCH", `/v1/api_keys/${inv.id}`, { permissions: null });
  ok("§K a developer cannot widen a key to full access", widen.statusCode === 403);
  const au = await systemDb
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.action, "api_key.update")));
  ok(
    "§K api_key.update is audited with the map",
    au.some((r) => JSON.stringify(r.after).includes("customers")),
  );

  // A dashboard key can never hold a map.
  const dashMap = await systemDb
    .update(apiKeys)
    .set({ permissions: { invoices: "read" } })
    .where(and(eq(apiKeys.organizationId, orgId), eq(apiKeys.kind, "dashboard")))
    .then(() => false)
    .catch(() => true);
  ok("§K the database refuses a map on a dashboard key", dashMap);
}

await app.close();
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ ROLES: PASS" : "❌ ROLES: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
