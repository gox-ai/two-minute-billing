/**
 * Customer portal (P14 slice) verify suite.
 *
 * - Operator mints a portal session (org-key route) → one-time pstk_ token.
 * - Portal token drives the buyer surface end-to-end: me → setup (tmtest
 *   client_secret mode) → complete vault → list → set default → remove.
 * - AUTH ISOLATION both ways: org key never satisfies /portal/v1/*, portal
 *   token never satisfies /v1/*.
 * - Expired + revoked sessions → 401. Cross-customer reach → 404.
 *
 * ⚠️ RUN IT THROUGH `pnpm verify:customer-portal`, which sets
 * `RATE_LIMIT_AUTH_PER_IP=1000`. `POST /portal/v1/session` is throttled per IP (30/min
 * by default, `refusedByRateLimit` scope `portal_exchange`) and every request in this
 * suite comes from 127.0.0.1 — including the deliberate replay/expired/revoked refusals,
 * which consume the bucket too. Past ~30 exchanges the mints start answering 429, the
 * helper returns an empty token, and the failures surface downstream as
 * `401 Missing portal token` on assertions that have nothing to do with auth. It was
 * INTERMITTENT because it depended on where the run straddled the one-minute window —
 * which is a worse way to find out than a clear cap.
 *
 * pnpm verify:customer-portal
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization } from "@/modules/tenancy/service";
import {
  portalSessions,
  businesses,
  customers,
  invoices,
  payments,
  paymentIntents,
  paymentMethods,
  tmtestCharges,
  buyerRequestRejections,
} from "@db/schema";
import { createPortalSession } from "@/modules/customer-portal/service";
import { recordExcessPayment } from "@/modules/customers/balances";
import {
  vaultPaymentMethod,
  setDefaultPaymentMethod,
  setPaymentMethodStatus,
} from "@/modules/payment-methods/service";
import {
  authorizePaymentIntent,
  createPaymentIntent,
  consumePaymentIntent,
  getPaymentIntent,
} from "@/modules/payment-intents/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import {
  listGatewayAccounts,
  updateGatewayAccount,
  createGatewayAccount,
} from "@/modules/gateway/service";
import { TmtestProvider } from "@/providers/tmtest";
import { setChargeStatus as setTmtestChargeStatus } from "@/providers/tmtest/store";
import { ProviderIndeterminateError } from "@/providers/types";
import { recordOfflinePayment } from "@/modules/invoicing/ops";
import { Tmbilling } from "../sdk/index";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const org = await createOrganization({ name: "Portal Co" });
const tmb = new Tmbilling({ apiKey: org.secret, baseUrl: base });

const biz = await tmb.businesses.create({
  name: "Portal Biz",
  default_currency: "USD",
  livemode: "test",
});
// Set through UPDATE, not create: the create route accepts `timezone` but the SDK's
// create signature does not list it (openapi's BusinessCreate documents only
// name/default_currency/livemode). Widening the SDK for a fixture would be the wrong
// order — the doc gap is its own item.
await tmb.businesses.update(biz.id, { timezone: "Asia/Kolkata" });
const cusA = await tmb.customers.create(biz.id, {
  email: "portal-a@acme.test",
  first_name: "Portal",
  last_name: "A",
});
// The portal link exchange is rate-limited per IP and every suite shares 127.0.0.1 — see
// scripts/lib/rate-limit-reset.ts for the confusing failure this prevents.
await clearPublicRateLimits();

const cusB = await tmb.customers.create(biz.id, {
  email: "portal-b@acme.test",
  first_name: "Portal",
  last_name: "B",
});
// Customer B has a card — customer A's portal token must never reach it.
const pmB = await tmb.paymentMethods.create(biz.id, cusB.id, { token: "tok_4242" });

const http = async (path: string, opts: { method?: string; token: string; body?: unknown }) => {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      // The buyer routes carry the idempotency preHandler, which now requires the header
      // (audit L6) — the storefront's own clients mint one per call for the same reason.
      ...(opts.method && opts.method !== "GET" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json: json as Record<string, unknown> & { data?: unknown[] } };
};

/**
 * Spend a minted link's ENTRY credential for a session token (0193).
 *
 * Every buyer-surface assertion below goes through this, because that is what the
 * storefront does: `/portal/s/<pstk_…>` calls this exact route server-side and puts the
 * `psst_…` it returns in an HttpOnly cookie. A suite that kept using the mint token
 * directly would be testing a contract no client has.
 */
const exchange = async (accessToken: string) => {
  const res = await fetch(`${base}/portal/v1/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => ({}))) as { token?: string };
  return { status: res.status, token: json.token ?? "" };
};

// ── Mint (operator, org key) ─────────────────────────────────────────────────
const mint = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
ok("mint: portal_session object", (mint as { object?: string }).object === "portal_session");
ok("mint: psess_ public id", mint.id.startsWith("psess_"));
ok("mint: pstk_ entry token returned once", mint.token.startsWith("pstk_"));
const ttlH = (new Date(mint.expires_at).getTime() - Date.now()) / 3600_000;
ok("mint: ~72h session ceiling", ttlH > 71 && ttlH <= 72.1);
// The LINK is short-lived independently of the session it will mint — the access_url is
// one hour, and collapsing the two is what made the value most likely to leak also the
// longest-lived.
const accessH = (new Date(mint.access_expires_at).getTime() - Date.now()) / 3600_000;
ok("mint: ~1h entry window, separate from the session ceiling", accessH > 0.9 && accessH <= 1.01);

// ── Exchange (0193) ──────────────────────────────────────────────────────────
// The entry credential buys a session and nothing else.
const preExchange = await http("/portal/v1/me", { token: mint.token });
ok("exchange: the ENTRY token is refused by /portal/v1/* (401)", preExchange.status === 401);

const exchanged = await exchange(mint.token);
ok(
  "exchange: 201 + psst_ session token",
  exchanged.status === 201 && exchanged.token.startsWith("psst_"),
);
const ptoken = exchanged.token;

// SINGLE-USE: once accessed, the access url cannot be reused. This is the
// assertion that makes a leaked link — in an inbox, a chat log, a proxy access log —
// worthless rather than a 72-hour session.
const replay = await exchange(mint.token);
ok("exchange: the entry token cannot be spent twice (401)", replay.status === 401);
// …and the session it already minted is unaffected by that refusal.
const stillLive = await http("/portal/v1/me", { token: ptoken });
ok("exchange: a refused replay does not disturb the live session", stillLive.status === 200);

// An unknown token answers exactly like a spent one — no oracle.
const bogus = await exchange("pstk_notarealtokenatall");
ok(
  "exchange: an unknown token answers the same 401 as a spent one",
  bogus.status === replay.status,
);

// ── Buyer surface ────────────────────────────────────────────────────────────
const me = await http("/portal/v1/me", { token: ptoken });
ok(
  "me: 200 + scoped to customer A",
  me.status === 200 &&
    (me.json.customer as { id?: string })?.id === cusA.id &&
    (me.json.business as { name?: string })?.name === "Portal Biz",
);
// The portal renders invoice dates and it sits outside the dashboard tree, so there is
// no BusinessTzProvider to read: the zone must travel in this payload or the buyer sees
// UTC while the invoice PDF says something else. Gated here because the field went
// missing unnoticed for exactly as long as nothing asserted it.
ok(
  "me: business carries the timezone for buyer-facing dates",
  (me.json.business as { timezone?: string | null })?.timezone === "Asia/Kolkata",
);

// F-23: the buyer's own tax registration number (GSTIN) — the portal is the only
// self-serve way to add it once a customer exists without one. Round-trip, not just
// "the PATCH returned 200" — zod silently strips unknown keys, which has bitten this
// codebase before, so the only real proof is a fresh GET actually carrying the value.
ok(
  "me: tax_registration_number starts unset",
  (me.json.customer as { tax_registration_number?: string | null })?.tax_registration_number ===
    null,
);
const taxSet = await http("/portal/v1/me", {
  method: "PATCH",
  token: ptoken,
  body: { tax_registration_number: "29ABCDE1234F1Z5" },
});
ok(
  "me PATCH: 200 + the number comes back on the same response",
  taxSet.status === 200 &&
    (taxSet.json.customer as { tax_registration_number?: string | null })
      ?.tax_registration_number === "29ABCDE1234F1Z5",
);
const taxReread = await http("/portal/v1/me", { token: ptoken });
ok(
  "me PATCH: the number round-trips on a FRESH read, not just the write response",
  (taxReread.json.customer as { tax_registration_number?: string | null })
    ?.tax_registration_number === "29ABCDE1234F1Z5",
);
// Empty string clears it (matches the checkout's `updateCheckoutCustomerDetails`), and
// the clear must round-trip through a fresh read the same way the set did.
const taxCleared = await http("/portal/v1/me", {
  method: "PATCH",
  token: ptoken,
  body: { tax_registration_number: "" },
});
ok(
  "me PATCH: empty string clears it, on the write response",
  taxCleared.status === 200 &&
    (taxCleared.json.customer as { tax_registration_number?: string | null })
      ?.tax_registration_number === null,
);
const taxRereadCleared = await http("/portal/v1/me", { token: ptoken });
ok(
  "me PATCH: the clear round-trips on a fresh read too",
  (taxRereadCleared.json.customer as { tax_registration_number?: string | null })
    ?.tax_registration_number === null,
);

// NULL clears it too — and this is the shape that matters, because it is the one our own
// buyer form actually sends. `portalUpdateMeAction` maps a blank box to `null` ("forget
// this number"), while the schema accepted only `optional()`, so every buyer WITHOUT a
// GSTIN got "Invalid request body" on Save billing details — and therefore could not add
// a payment method, which requires a saved address. The suite tested `""` and never
// `null`, which is exactly how it shipped. Set it again first, so the clear has something
// to clear and a false pass is impossible.
await http("/portal/v1/me", {
  method: "PATCH",
  token: ptoken,
  body: { tax_registration_number: "29ABCDE1234F1Z5" },
});
const taxNulled = await http("/portal/v1/me", {
  method: "PATCH",
  token: ptoken,
  body: { tax_registration_number: null },
});
ok(
  "me PATCH: null clears it (the shape the buyer form posts)",
  taxNulled.status === 200 &&
    (taxNulled.json.customer as { tax_registration_number?: string | null })
      ?.tax_registration_number === null,
);
const taxNullReread = await http("/portal/v1/me", { token: ptoken });
ok(
  "me PATCH: the null clear round-trips on a fresh read too",
  (taxNullReread.json.customer as { tax_registration_number?: string | null })
    ?.tax_registration_number === null,
);

// A UK number typed the domestic way (trunk 0 kept) must be refused with a message that says
// how to correct it — not "Invalid request body" — and the refusal must be recorded for ops.
const before = new Date(Date.now() - 1_000);
const trunkZero = await http("/portal/v1/me", {
  method: "PATCH",
  token: ptoken,
  body: {
    address: { first_name: "Ada", line1: "1 High St", country: "GB", phone: "+4407700900123" },
  },
});
const trunkMsg = String((trunkZero.json.error as { message?: string } | undefined)?.message ?? "");
ok(
  `me PATCH: a trunk-0 phone is refused with the correction in the message (${trunkMsg})`,
  trunkZero.status === 400 &&
    trunkMsg.includes("address.phone:") &&
    trunkMsg.includes("Remove the 0 after +44") &&
    !trunkMsg.includes("Invalid request body"),
);
await new Promise((r) => setTimeout(r, 200)); // the record is fire-and-forget
const recorded = await systemDb.select().from(buyerRequestRejections)
  .where(sql`${buyerRequestRejections.createdAt} >= ${before.toISOString()}::timestamptz
    and ${buyerRequestRejections.route} = '/portal/v1/me'`);
ok(
  "me PATCH: the refusal is recorded for ops with the value redacted",
  recorded.length >= 1 &&
    recorded.every((r) => r.surface === "portal" && !r.message.includes("07700900123")) &&
    recorded.some((r) => r.message.includes("Remove the 0 after +44")),
);

const empty = await http("/portal/v1/payment_methods", { token: ptoken });
ok("list: starts empty", empty.status === 200 && empty.json.data?.length === 0);

const setup = await http("/portal/v1/payment_methods/setup", {
  method: "POST",
  token: ptoken,
  body: {
    return_url: "http://localhost:3001/portal/x?setup=return",
    cancel_url: "http://localhost:3001/portal/x?setup=cancel",
  },
});
ok(
  "setup: 201 tmtest client_secret mode",
  setup.status === 201 &&
    setup.json.provider === "tmtest" &&
    setup.json.mode === "client_secret" &&
    String(setup.json.setup_token).startsWith("tmseti_") &&
    String(setup.json.client_secret).includes("_secret"),
);

// Gateway picker: the buyer can list the business's vault-capable gateways and
// begin setup on a chosen one (the "which gateway?" step).
const gws = await http("/portal/v1/payment_methods/gateways", { token: ptoken });
const gwList = (gws.json.data ?? []) as Array<{
  id: string;
  gateway_key: string;
  label: string;
  method_types?: string[] | null;
}>;
ok(
  "gateways: lists >=1 vault-capable gateway",
  gws.status === 200 &&
    gwList.length >= 1 &&
    gwList[0]!.id.startsWith("gwa_") &&
    typeof gwList[0]!.gateway_key === "string" &&
    typeof gwList[0]!.label === "string",
);
// F-16: the RAILS the account actually has enabled, which this route used to drop while
// the checkout's equivalent returned them. Without the key present at all the storefront
// cannot tell "no restriction" from "we forgot to send it", and falls back to a hardcoded
// ['card','upi','bank_transfer'] guess — offering UPI or netbanking on a RazorPay account
// with neither switched on. The key must EXIST on every row; null is a legitimate value.
ok(
  "gateways: every row carries method_types (null = no restriction, absent = a bug)",
  gwList.every(
    (g) => "method_types" in g && (g.method_types === null || Array.isArray(g.method_types)),
  ),
);

const setupChosen = await http("/portal/v1/payment_methods/setup", {
  method: "POST",
  token: ptoken,
  body: {
    return_url: "http://localhost:3001/portal/x?setup=return",
    cancel_url: "http://localhost:3001/portal/x?setup=cancel",
    gateway_account: gwList[0]?.id,
  },
});
ok(
  "setup: honors a chosen gateway_account",
  setupChosen.status === 201 && setupChosen.json.mode === "client_secret",
);

const setupBadGw = await http("/portal/v1/payment_methods/setup", {
  method: "POST",
  token: ptoken,
  body: {
    return_url: "http://localhost:3001/portal/x?setup=return",
    cancel_url: "http://localhost:3001/portal/x?setup=cancel",
    gateway_account: "gwa_does_not_exist",
  },
});
ok("setup: unknown gateway_account → 400", setupBadGw.status === 400);

// Completion vaults on the SAME gateway the setup ran on (gateway_account) —
// guards the regression where completion fell back to the business default.
const vaulted = await http("/portal/v1/payment_methods", {
  method: "POST",
  token: ptoken,
  body: { token: "tok_4242", gateway_account: gwList[0]?.id },
});
ok(
  "vault: 201 card added (on chosen gateway)",
  vaulted.status === 201 && (vaulted.json.last4 as string) === "4242",
);
const pm1 = vaulted.json.id as string;

const vaulted2 = await http("/portal/v1/payment_methods", {
  method: "POST",
  token: ptoken,
  body: { token: "tok_1881" },
});
ok("vault: second card added", vaulted2.status === 201);
const pm2 = vaulted2.json.id as string;

const listed = await http("/portal/v1/payment_methods", { token: ptoken });
ok("list: two cards", listed.status === 200 && listed.json.data?.length === 2);

const setDef = await http(`/portal/v1/payment_methods/${pm2}/default`, {
  method: "POST",
  token: ptoken,
});
ok("default: pm2 now default", setDef.status === 200 && setDef.json.is_default === true);

// ── ROLES: the buyer can name a backup, and promoting it SWAPS ────────────────
//
// The portal could set `primary` and nothing else, so the second slot the engine
// falls back to before dunning begins was operator-only and invisible. Worse, the
// one action a buyer could take used to EMPTY it: promoting the backup demoted the
// old primary to `none`, leaving the account with no fallback and no event saying so.
const setBackup = await http(`/portal/v1/payment_methods/${pm1}/role`, {
  method: "POST",
  token: ptoken,
  body: { role: "backup" },
});
ok(
  "role: the buyer can designate a backup",
  setBackup.status === 200 && setBackup.json.role === "backup",
);

// The buyer can take a backup out of collection, but never demote the primary.
const clearRole = await http(`/portal/v1/payment_methods/${pm1}/role`, {
  method: "POST",
  token: ptoken,
  body: { role: "none" },
});
ok(
  "role: the buyer can REMOVE a backup",
  clearRole.status === 200 && clearRole.json.role === "none",
);
const demote = await http(`/portal/v1/payment_methods/${pm2}/role`, {
  method: "POST",
  token: ptoken,
  body: { role: "backup" },
});
ok("role: the buyer cannot demote the primary", demote.status === 409);
await http(`/portal/v1/payment_methods/${pm1}/role`, {
  method: "POST",
  token: ptoken,
  body: { role: "backup" },
});

// The swap. pm1 is backup, pm2 is primary; promoting pm1 must hand pm2 the vacated
// backup slot rather than clearing it.
const swap = await http(`/portal/v1/payment_methods/${pm1}/role`, {
  method: "POST",
  token: ptoken,
  body: { role: "primary" },
});
ok(
  "role: promoting the backup makes it primary",
  swap.status === 200 && swap.json.role === "primary",
);
const afterSwap = await http("/portal/v1/payment_methods", { token: ptoken });
const roleOf = (id: string) =>
  (afterSwap.json.data as Array<{ id: string; role: string }>).find((m) => m.id === id)?.role;
ok(
  "role: …and the old primary takes the backup slot, not `none`",
  afterSwap.status === 200 && roleOf(pm2) === "backup",
);
ok(
  "role: …so the account still has both roles filled",
  roleOf(pm1) === "primary" && roleOf(pm2) === "backup",
);

// Put it back so the removal below reads as it always did.
await http(`/portal/v1/payment_methods/${pm2}/default`, { method: "POST", token: ptoken });

const removed = await http(`/portal/v1/payment_methods/${pm1}`, {
  method: "DELETE",
  token: ptoken,
});
ok("remove: pm1 detached", removed.status === 200 && removed.json.deleted === true);
const afterRemove = await http("/portal/v1/payment_methods", { token: ptoken });
ok("list: one card after remove", afterRemove.json.data?.length === 1);

// ── Completing through the setup INTENT, not the provider token (0183) ────────
// The `token` completions above are the OLDER shape: they hand the provider token
// straight to the vault call, which bypasses the setup intent the add-card began — while
// `harvestSetupIntent` vaults that same instrument from the gateway's webhook for the
// buyer who approves and never comes back. Both wrote. Measured 2026-08-21 on RazorPay
// UPI, one mandate became two payment methods 15 seconds apart. Completing through the
// intent puts both sides on one atomic `authorized -> consumed` claim.
const beforeIntent = (afterRemove.json.data ?? []).length;
const piSetup = await http("/portal/v1/payment_methods/setup", {
  method: "POST",
  token: ptoken,
  body: {
    return_url: "http://localhost:3001/portal/x?setup=return",
    cancel_url: "http://localhost:3001/portal/x?setup=cancel",
    gateway_account: gwList[0]?.id,
  },
});
const piId = piSetup.json.payment_intent as string;
ok(
  "setup: records the add-card as a payment_intent to complete through",
  typeof piId === "string" && piId.startsWith("pi_"),
);
const viaIntent = await http("/portal/v1/payment_methods", {
  method: "POST",
  token: ptoken,
  body: { payment_intent: piId },
});
ok(
  "vault: 201 completing through the setup intent",
  viaIntent.status === 201 && typeof viaIntent.json.id === "string",
);
// The buyer's browser and the webhook harvest both completing is the WHOLE point: the
// second one must resolve to the instrument that already exists.
const replayIntent = await http("/portal/v1/payment_methods", {
  method: "POST",
  token: ptoken,
  body: { payment_intent: piId },
});
ok(
  "vault: re-completing the same intent returns the SAME payment method, not a second one",
  replayIntent.status === 201 && replayIntent.json.id === viaIntent.json.id,
);
const afterIntent = await http("/portal/v1/payment_methods", { token: ptoken });
ok(
  "vault: two completions of one intent leave exactly one new payment method",
  (afterIntent.json.data ?? []).length === beforeIntent + 1,
);
const neither = await http("/portal/v1/payment_methods", {
  method: "POST",
  token: ptoken,
  body: {},
});
ok("vault: neither payment_intent nor token → 400", neither.status === 400);

// ── Cross-customer scoping ───────────────────────────────────────────────────
const reachB = await http(`/portal/v1/payment_methods/${pmB.id}/default`, {
  method: "POST",
  token: ptoken,
});
ok("scoping: customer B's pm unreachable via A's token (404)", reachB.status === 404);
const listStillA = await http("/portal/v1/payment_methods", { token: ptoken });
ok(
  "scoping: list never shows B's card",
  (listStillA.json.data as Array<{ id: string }>).every((p) => p.id !== pmB.id),
);

// ── Auth isolation (both directions) ─────────────────────────────────────────
const orgKeyOnPortal = await http("/portal/v1/me", { token: org.secret });
ok("isolation: org key rejected on /portal/v1/* (401)", orgKeyOnPortal.status === 401);
const portalOnOrg = await http(`/v1/businesses/${biz.id}/customers/${cusA.id}/payment_methods`, {
  token: ptoken,
});
ok("isolation: portal token rejected on /v1/* (401)", portalOnOrg.status === 401);

// ── Expiry + revocation ──────────────────────────────────────────────────────
await systemDb
  .update(portalSessions)
  .set({ expiresAt: new Date(Date.now() - 1000) })
  .where(eq(portalSessions.publicId, mint.id));
const expired = await http("/portal/v1/me", { token: ptoken });
ok("expired session → 401", expired.status === 401);

// Revocation must bite in BOTH places, which is the new part: a revoked row cannot be
// exchanged for a session, and a session already minted from it stops working.
const mint2 = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
const sess2 = await exchange(mint2.token);
await systemDb
  .update(portalSessions)
  .set({ revokedAt: new Date() })
  .where(eq(portalSessions.publicId, mint2.id));
const revoked = await http("/portal/v1/me", { token: sess2.token });
ok("revoked session → 401", revoked.status === 401);

const mint3 = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
await systemDb
  .update(portalSessions)
  .set({ revokedAt: new Date() })
  .where(eq(portalSessions.publicId, mint3.id));
ok("a revoked link cannot be exchanged at all", (await exchange(mint3.token)).status === 401);

// An entry credential past its one-hour window is refused even though the session
// ceiling it would mint is still 72h away — the two clocks are genuinely separate.
const mint4 = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
await systemDb
  .update(portalSessions)
  .set({ accessExpiresAt: new Date(Date.now() - 1000) })
  .where(eq(portalSessions.publicId, mint4.id));
ok("an entry token past its 1h window is refused", (await exchange(mint4.token)).status === 401);

// ── Email links get their OWN window (0195) ──────────────────────────────────
// The one-hour entry window above is right for `access_url` — minted by an API call and
// opened moments later. A link that goes in a DUNNING NOTICE is read the next morning,
// after a weekend, or when someone is back from leave, so it gets five days. The two
// windows are asserted together because the whole point is that they differ.
// The service takes INTERNAL uuids; everything above this point is holding public ids
// handed back by the SDK, so they have to be resolved first.
const [bizRow] = await systemDb
  .select({ id: businesses.id })
  .from(businesses)
  .where(eq(businesses.publicId, biz.id))
  .limit(1);
const [cusRow] = await systemDb
  .select({ id: customers.id })
  .from(customers)
  .where(eq(customers.publicId, cusA.id))
  .limit(1);
const linkInput = {
  organizationId: org.organization.id,
  businessId: bizRow!.id,
  customerId: cusRow!.id,
};
const emailLink = await createPortalSession({ ...linkInput, kind: "email" as const });
const apiLink = await createPortalSession(linkInput);
const hoursOut = (d: Date) => (d.getTime() - Date.now()) / 3600_000;
ok(
  "an email link is good for ~5 days",
  hoursOut(emailLink.accessExpiresAt) > 119 && hoursOut(emailLink.accessExpiresAt) <= 120,
);
ok("an API link is still the 1-hour window", hoursOut(apiLink.accessExpiresAt) <= 1);
// The mint-time ceiling is unchanged at 72h for BOTH — the API reports it, and it means
// "how long a session lasts", not "how long the link is good for". For an email link the
// entry window deliberately OUTLIVES it, which is only coherent because the exchange no
// longer gates on it and re-stamps the ceiling on arrival. The day-four case below is
// what proves that, and is exactly what a stale gate would have broken.
ok(
  "the mint-time session ceiling is the same 72h regardless of link kind",
  Math.abs(emailLink.expiresAt.getTime() - apiLink.expiresAt.getTime()) < 5000,
);
ok(
  "an email link outlives that ceiling on purpose",
  emailLink.accessExpiresAt > emailLink.expiresAt,
);
// It must still actually open — a five-day link nobody can exchange is worse than an hour.
const emailSess = await exchange(emailLink.accessToken);
ok("an email link exchanges for a working session", emailSess.status === 201);
ok(
  "and that session authenticates",
  (await http("/portal/v1/me", { token: emailSess.token })).status === 200,
);
// Single-use is unchanged: the longer window widens WHEN it can be opened, not how often.
ok("an email link is still single-use", (await exchange(emailLink.accessToken)).status === 401);

// The case the whole change exists for: a dunning notice opened on DAY FOUR. The session
// ceiling used to be stamped at mint, 72h out, so a five-day link was refused after three
// days regardless of its entry window — a longer link that still died early.
const dayFour = await createPortalSession({ ...linkInput, kind: "email" as const });
await systemDb
  .update(portalSessions)
  .set({ createdAt: new Date(Date.now() - 4 * 24 * 3600_000) })
  .where(eq(portalSessions.publicId, dayFour.publicId));
const lateSess = await exchange(dayFour.accessToken);
ok("an email link still opens on day four", lateSess.status === 201);
// …and the session it mints is measured from ARRIVAL, not from when the link was made.
const [lateRow] = await systemDb
  .select()
  .from(portalSessions)
  .where(eq(portalSessions.publicId, dayFour.publicId))
  .limit(1);
const sessionHours = (lateRow!.expiresAt.getTime() - Date.now()) / 3600_000;
ok("and its session runs 72h from arrival, not from mint", sessionHours > 71 && sessionHours <= 72);

// ── Logout ───────────────────────────────────────────────────────────────────
const mint5 = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
const sess5 = await exchange(mint5.token);
ok(
  "logout: the session works before it",
  (await http("/portal/v1/me", { token: sess5.token })).status === 200,
);
const loggedOut = await http("/portal/v1/logout", { method: "POST", token: sess5.token });
ok("logout: 200", loggedOut.status === 200);
// The credential is cleared, not just flagged — a cookie kept after logout must
// authenticate nothing without depending on a later reader checking `status`.
ok(
  "logout: the session token stops working",
  (await http("/portal/v1/me", { token: sess5.token })).status === 401,
);
// …and the spent link cannot be used to get back in.
ok("logout: the original link is still spent", (await exchange(mint5.token)).status === 401);

// The audit trail we had no answer for: was this link ever opened, and when.
const [audited] = await systemDb
  .select()
  .from(portalSessions)
  .where(eq(portalSessions.publicId, mint5.id))
  .limit(1);
ok("audit: status reaches logged_out", audited?.status === "logged_out");
ok(
  "audit: login_at and logout_at are both recorded",
  Boolean(audited?.loginAt && audited?.logoutAt),
);
ok("audit: consumed_at marks the link spent", Boolean(audited?.consumedAt));

// ── THE OPERATOR'S REVOKE, AT THE ROUTE (F-9) ────────────────────────────────
//
// `POST /v1/businesses/:biz/customers/:cus/portal_sessions/:id/revoke` is the WRITER for
// `portal_sessions.revoked_at`. Until it existed the column was honoured by BOTH readers
// (`exchangePortalAccessToken` and `resolvePortalSession`) with nothing in the product
// ever setting it — a guard no code path exercised, and no lever at all for an operator
// whose link had leaked or who needed to end a live buyer session from outside the
// buyer's browser. `POST /portal/v1/logout` is not that lever: it needs the buyer's own
// `psst_…`, which lives in their cookie.
//
// The two halves are LITERAL here, because 0193 gave the portal two credentials where
// checkout has one: a session ALREADY IN FLIGHT must stop working, AND a link NEVER
// OPENED must be unexchangeable. One `revoked_at` write has to kill both. Each half
// carries its positive control — a refusal proves nothing unless the same route answers
// for a session that was NOT revoked.
{
  const revoke = (bizId: string, cusId: string, sessionId: string, token: string) =>
    http(`/v1/businesses/${bizId}/customers/${cusId}/portal_sessions/${sessionId}/revoke`, {
      method: "POST",
      token,
      body: {},
    });

  // ── Half (a): a session the buyer is already holding ───────────────────────
  const liveMint = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
  const bystanderMint = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
  const liveTok = (await exchange(liveMint.token)).token;
  const bystanderTok = (await exchange(bystanderMint.token)).token;
  ok(
    "revoke: the session answers before it is revoked (200)",
    (await http("/portal/v1/me", { token: liveTok })).status === 200,
  );

  const rev1 = await revoke(biz.id, cusA.id, liveMint.id, org.secret);
  ok(
    "revoke: the operator route answers 200 and echoes the session + revoked_at",
    rev1.status === 200 && rev1.json.id === liveMint.id && typeof rev1.json.revoked_at === "string",
  );
  // Revocation is orthogonal to the LIFECYCLE. `created → logged_in → logged_out` answers
  // "was this link ever opened"; revocation is a kill switch beside it, not a step in it.
  ok(
    "revoke: …and it leaves the lifecycle status alone (still logged_in)",
    rev1.json.status === "logged_in",
  );
  ok(
    "revoke, half (a): the in-flight session token is now 401 on /me",
    (await http("/portal/v1/me", { token: liveTok })).status === 401,
  );
  // The READABLE routes too — revocation bites at `resolvePortalSession`, before
  // `authenticatePortal` authenticates anything, so there is no route it does not reach.
  ok(
    "revoke, half (a): …and 401 on a READ route (invoices)",
    (await http("/portal/v1/invoices", { token: liveTok })).status === 401,
  );
  ok(
    "revoke, half (a): …and 401 on a MUTATING route (add-card setup)",
    (
      await http("/portal/v1/payment_methods/setup", {
        method: "POST",
        token: liveTok,
        body: {
          return_url: "http://localhost:3001/portal?setup=return",
          cancel_url: "http://localhost:3001/portal?setup=cancel",
        },
      })
    ).status === 401,
  );
  // THE POSITIVE CONTROL. A surface broken for everyone reads as perfect security.
  ok(
    "revoke: a sibling session minted alongside it is UNAFFECTED (200)",
    (await http("/portal/v1/me", { token: bystanderTok })).status === 200,
  );

  // ── Half (b): a link nobody has opened yet ─────────────────────────────────
  // Half (a) alone would leave the mailed-but-unopened link alive — and that is the
  // likelier leak, since the `pstk_…` is the half that travels through inboxes and proxy
  // logs. The ENTRY credential has to die with the session it would have minted.
  const unopened = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
  const revUnopened = await revoke(biz.id, cusA.id, unopened.id, org.secret);
  ok(
    "revoke, half (b): a never-opened link is revocable (200), status still created",
    revUnopened.status === 200 && revUnopened.json.status === "created",
  );
  const unopenedExchange = await exchange(unopened.token);
  ok(
    "revoke, half (b): …and it cannot be exchanged at all — no session is ever minted",
    unopenedExchange.status === 401 && unopenedExchange.token === "",
  );
  // Same single 401 as a token that never existed: the exchange route is unauthenticated,
  // so telling a caller that a token was real-but-revoked would be a free oracle.
  ok(
    "revoke, half (b): …answering exactly as an unknown token does",
    unopenedExchange.status === (await exchange("pstk_neverexisted")).status,
  );

  // ── Revoked is not logged out ──────────────────────────────────────────────
  // A `logged_out` session still holds a spent ENTRY token and a row; revoking it is
  // what makes the whole thing unambiguous, and it must not rewrite the audit trail.
  const goneMint = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
  const goneTok = (await exchange(goneMint.token)).token;
  await http("/portal/v1/logout", { method: "POST", token: goneTok });
  const revGone = await revoke(biz.id, cusA.id, goneMint.id, org.secret);
  ok(
    "revoke: a logged_out session is revocable, and stays logged_out",
    revGone.status === 200 && revGone.json.status === "logged_out",
  );

  // ── Idempotent, and scoped to the one row ──────────────────────────────────
  const rev2 = await revoke(biz.id, cusA.id, liveMint.id, org.secret);
  ok(
    "revoke: a second revoke answers 200 with the SAME revoked_at (never moves it)",
    rev2.status === 200 && rev2.json.revoked_at === rev1.json.revoked_at,
  );
  const rows = await withTenant(org.organization.id, (tx) =>
    tx
      .select({ id: portalSessions.publicId, revokedAt: portalSessions.revokedAt })
      .from(portalSessions),
  );
  const revokedAtOf = (id: string) => rows.find((r) => r.id === id)?.revokedAt ?? null;
  ok(
    "revoke: it wrote revoked_at on the named sessions and on NO other row",
    revokedAtOf(liveMint.id) !== null &&
      revokedAtOf(unopened.id) !== null &&
      revokedAtOf(goneMint.id) !== null &&
      revokedAtOf(bystanderMint.id) === null,
  );

  // ── Who may revoke what ────────────────────────────────────────────────────
  ok(
    "revoke: an unknown session id is 404",
    (await revoke(biz.id, cusA.id, "psess_doesnotexist", org.secret)).status === 404,
  );
  // Same org, same business, WRONG CUSTOMER. The org key is authorized for both, so only
  // the service's own customer predicate stands between them.
  ok(
    "revoke: another customer's path cannot revoke this session (404)",
    (await revoke(biz.id, cusB.id, bystanderMint.id, org.secret)).status === 404,
  );
  // CROSS-TENANT: a second organization with its own business and customer, so the
  // request is well-formed for the caller and only tenancy refuses it.
  const xOrg = await createOrganization({ name: "Portal Foreign Co" });
  const xTmb = new Tmbilling({ apiKey: xOrg.secret, baseUrl: base });
  const xBiz = await xTmb.businesses.create({
    name: "Foreign Portal Biz",
    default_currency: "USD",
    livemode: "test",
  });
  const xCus = await xTmb.customers.create(xBiz.id, {
    email: "foreign@acme.test",
    first_name: "Foreign",
    last_name: "Buyer",
  });
  ok(
    "revoke: org X cannot revoke org A's session through its OWN business (404)",
    (await revoke(xBiz.id, xCus.id, bystanderMint.id, xOrg.secret)).status === 404,
  );
  ok(
    "revoke: org X naming org A's business is refused at the business itself (404)",
    (await revoke(biz.id, cusA.id, bystanderMint.id, xOrg.secret)).status === 404,
  );
  // A BUYER's own token cannot reach the operator route — separate namespaces (the
  // isolation asserted above, restated on the route that kills credentials).
  ok(
    "revoke: a portal session token is rejected on the operator route (401)",
    (await revoke(biz.id, cusA.id, bystanderMint.id, bystanderTok)).status === 401,
  );
  ok(
    "revoke: …and the bystander session survived all four refusals (200)",
    (await http("/portal/v1/me", { token: bystanderTok })).status === 200,
  );
  // The rightful operator can still revoke it — proving those refusals were about
  // AUTHORIZATION, not a route that had stopped functioning.
  ok(
    "revoke: the rightful operator can still revoke it (200)",
    (await revoke(biz.id, cusA.id, bystanderMint.id, org.secret)).status === 200,
  );
  ok(
    "revoke: …and it is dead now (401)",
    (await http("/portal/v1/me", { token: bystanderTok })).status === 401,
  );
}

// ── "Pay now": the buyer settles their own invoice ───────────────────────────
//
// The endpoint moves money on a buyer-authenticated token, so its guards matter as
// much as its happy path: it must refuse another customer's invoice, refuse an
// invoice with nothing owing, and refuse a foreign payment intent on the second leg.
{
  // A FRESH session: the expiry/revocation checks above deliberately kill `ptoken`,
  // so reusing it here fails every assertion with a 401 that looks like a routing bug.
  const payMint = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
  const payToken = (await exchange(payMint.token)).token;
  const inv = await tmb.invoices.create(biz.id, {
    customer: cusA.id,
    lines: [{ description: "Pay-now coverage", amount_minor: 250_00, quantity: 1 }],
  });
  const collect = await http(`/portal/v1/invoices/${inv.id}/collect`, {
    method: "POST",
    token: payToken,
    body: {},
  });
  // With a vaulted tmtest card the intent authorizes with no challenge, so the first
  // leg settles outright; a gateway that challenges answers `action_required` instead.
  ok("pay now settles or challenges, never 5xx", collect.status === 200);
  ok(
    "pay now reports the invoice or a challenge",
    collect.json.object === "invoice" || collect.json.status === "action_required",
  );

  // An invoice with nothing left to pay is refused rather than charged again.
  if (collect.json.object === "invoice" && collect.json.status === "paid") {
    const again = await http(`/portal/v1/invoices/${inv.id}/collect`, {
      method: "POST",
      token: payToken,
      body: {},
    });
    ok("pay now on a settled invoice → 400", again.status === 400);
  } else {
    ok("pay now on a settled invoice → 400 (skipped: first leg challenged)", true);
  }

  /**
   * ── The buyer must not be shown "Intent already consumed" for a payment that WORKED ──
   *
   * Two settlers reach for one intent by design: the buyer's browser posts leg 2, and
   * `intent.authorized` reaches `harvestInvoiceIntent` in the inbound webhook (which
   * exists because the browser sometimes never comes back — measured 2026-08-14, a
   * ₹20,000 Pay now left held at the gateway with the tab gone). The webhook side has
   * always handled losing gracefully; the buyer's side answered 400 `Intent already
   * consumed` — a red error for money captured a moment earlier.
   *
   * The race is simulated rather than raced: consume the intent out of band, exactly as
   * the webhook harvest would, then post the leg the browser posts. Deterministic, and
   * it fails on the pre-fix code.
   */
  {
    const cusR = await tmb.customers.create(biz.id, {
      email: "portal-race@acme.test",
      first_name: "Ra",
      last_name: "Ce",
    });
    const [bizRowR] = await systemDb
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
      .limit(1);
    const [cusRowR] = await systemDb
      .select()
      .from(customers)
      .where(eq(customers.publicId, cusR.id))
      .limit(1);
    const pmR = await vaultPaymentMethod({
      organizationId: org.organization.id,
      businessId: bizRowR!.id,
      customer: cusRowR!,
      token: "tok_4242",
    });
    const raceInv = await tmb.invoices.create(biz.id, {
      customer: cusR.id,
      lines: [{ description: "Race pay-now", amount_minor: 310_00, quantity: 1 }],
    });
    const { intent } = await createPaymentIntent({
      organizationId: org.organization.id,
      businessId: bizRowR!.id,
      purpose: "payment",
      paymentMethodPublicId: pmR.publicId,
      customerPublicId: cusR.id,
      amountMinor: raceInv.amount_due_minor!,
      currency: raceInv.currency!,
      invoicePublicId: raceInv.id,
      session: "on_session",
    });
    // THE WEBHOOK GETS THERE FIRST — the same call `harvestInvoiceIntent` makes.
    await consumePaymentIntent(org.organization.id, bizRowR!.id, intent.publicId, raceInv.id);

    const raceMint = await tmb.paymentMethods.createPortalSession(biz.id, cusR.id);
    const raceToken = (await exchange(raceMint.token)).token;
    const late = await http(`/portal/v1/invoices/${raceInv.id}/collect`, {
      method: "POST",
      token: raceToken,
      body: { payment_intent: intent.publicId },
    });
    if (late.status !== 200)
      console.log("    ↳ race leg-2:", late.status, JSON.stringify(late.json));
    ok("losing the race to the webhook is NOT reported as an error", late.status === 200);
    ok("…the buyer is told the invoice is paid", late.json.status === "paid");
    ok("…and no payment_error is invented for money that arrived", late.json.payment_error == null);

    /**
     * The OPERATOR route loses the same race, to the same webhook, and answered the same
     * 400. Its twin lives here rather than in an operator suite because this is the only
     * harness with `buildApp` + an org key + the http helper — and keeping the pair in one
     * place is what stops one being fixed and the other quietly regressing.
     */
    const opInv = await tmb.invoices.create(biz.id, {
      customer: cusR.id,
      lines: [{ description: "Operator race collect", amount_minor: 275_00, quantity: 1 }],
    });
    const { intent: opIntent } = await createPaymentIntent({
      organizationId: org.organization.id,
      businessId: bizRowR!.id,
      purpose: "payment",
      paymentMethodPublicId: pmR.publicId,
      customerPublicId: cusR.id,
      amountMinor: opInv.amount_due_minor!,
      currency: opInv.currency!,
      invoicePublicId: opInv.id,
      session: "on_session",
    });
    await consumePaymentIntent(org.organization.id, bizRowR!.id, opIntent.publicId, opInv.id);
    const opLate = await http(`/v1/businesses/${biz.id}/invoices/${opInv.id}/collect`, {
      method: "POST",
      token: org.secret,
      body: { payment_intent: opIntent.publicId },
    });
    if (opLate.status !== 200)
      console.log("    ↳ operator race leg:", opLate.status, JSON.stringify(opLate.json));
    ok("the OPERATOR collect route survives the same race", opLate.status === 200);
    ok("…and reports the invoice as paid", opLate.json.status === "paid");
  }

  /**
   * ── TWO CLICKS ON "PAY NOW" MUST NOT BUY TWO GATEWAY ORDERS ──────────────────
   *
   * A REAL production double-charge, measured on INV-5510 (INR 32,943.24):
   *   16:14:18  pi_XXXXXXXXXXXXXXXXXXXXXX01 → order_XXXXXXXXXXXX01 → pay_XXXXXXXXXXXX02
   *   16:17:30  pi_XXXXXXXXXXXXXXXXXXXXXX02 → order_XXXXXXXXXXXX02 → pay_XXXXXXXXXXXX03
   * Both charged. At 16:17:30 the first intent was still `in_progress` and unexpired (it
   * was consumed at 16:17:46), but an intent-only checkout writes NO `payments` row, so
   * the `pendingPaymentForInvoice` guard saw a clean invoice and the route minted a
   * second intent — a second real RazorPay order on money already being paid.
   *
   * The first click is planted rather than posted, because tmtest CANNOT be made to
   * challenge leg 1 of this route: it mints with `letBuyerChooseMethod`, which withholds
   * both the instrument and the rail, and tmtest then authorizes immediately (no
   * `next_action`) and the route consumes it in the same call. Minting out of band with a
   * checkout rail reproduces the exact 16:14:18 state — `in_progress`, a stored checkout
   * descriptor carrying the gateway's order id, and no payments row — which is the state
   * the guard has to see. Everything after that is the buyer's SECOND click, posted for
   * real through the route.
   */
  {
    const cusX = await tmb.customers.create(biz.id, {
      email: "portal-doubleclick@acme.test",
      first_name: "Double",
      last_name: "Click",
    });
    const [bizRowX] = await systemDb
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
      .limit(1);
    const [cusRowX] = await systemDb
      .select()
      .from(customers)
      .where(eq(customers.publicId, cusX.id))
      .limit(1);
    const pmX = await vaultPaymentMethod({
      organizationId: org.organization.id,
      businessId: bizRowX!.id,
      customer: cusRowX!,
      token: "tok_4242",
    });
    const xMint = await tmb.paymentMethods.createPortalSession(biz.id, cusX.id);
    const xToken = (await exchange(xMint.token)).token;

    /** Payment intents currently attached to one invoice — one click, one intent. */
    const intentsOn = async (invoicePublicId: string) => {
      const [invRow] = await systemDb
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.publicId, invoicePublicId))
        .limit(1);
      return withTenant(org.organization.id, async (tx) => {
        const rows = await tx
          .select({ publicId: paymentIntents.publicId })
          .from(paymentIntents)
          .where(eq(paymentIntents.invoiceId, invRow!.id));
        return rows.map((r) => r.publicId);
      });
    };

    // ── The double-click itself ───────────────────────────────────────────────
    const dcInv = await tmb.invoices.create(biz.id, {
      customer: cusX.id,
      // INV-5510's own figure, so the fixture names the incident.
      lines: [{ description: "Double-click pay-now", amount_minor: 32_943_24, quantity: 1 }],
    });
    const { intent: firstClick } = await createPaymentIntent({
      organizationId: org.organization.id,
      businessId: bizRowX!.id,
      purpose: "payment",
      paymentMethodPublicId: pmX.publicId,
      customerPublicId: cusX.id,
      amountMinor: dcInv.amount_due_minor!,
      currency: dcInv.currency!,
      invoicePublicId: dcInv.id,
      session: "on_session",
      // A CHECKOUT_RAILS rail, so tmtest answers `requires_action` with a real checkout
      // descriptor — the offline stand-in for order_XXXXXXXXXXXX01.
      methodTypes: ["upi"],
    });
    ok(
      "the planted first click is mid-checkout, exactly as at 16:14:18",
      firstClick.status === "in_progress",
    );
    ok(
      "…and carries a checkout descriptor the buyer could return to",
      firstClick.nextAction != null,
    );

    const secondClick = await http(`/portal/v1/invoices/${dcInv.id}/collect`, {
      method: "POST",
      token: xToken,
      body: {},
    });
    if (secondClick.status !== 200)
      console.log("    ↳ second click:", secondClick.status, JSON.stringify(secondClick.json));
    ok("a second Pay-now click is answered, not refused", secondClick.status === 200);
    ok("…as a challenge to finish", secondClick.json.status === "action_required");
    // THE REGRESSION. Pre-fix this is a brand-new pi_… (and a brand-new gateway order).
    ok(
      "…and it RESUMES the checkout already open, rather than minting a second intent",
      (secondClick.json.payment_intent as { id?: string } | undefined)?.id === firstClick.publicId,
    );
    const replayed = secondClick.json.next_action as
      | { mode?: string; checkout?: { orderId?: string } }
      | undefined;
    ok(
      "…handing back the SAME gateway order, so no second order is bought",
      replayed?.checkout?.orderId === firstClick.intentAtGateway,
    );
    const mintedOnDc = await intentsOn(dcInv.id);
    if (mintedOnDc.length !== 1) console.log("    ↳ intents on the invoice:", mintedOnDc);
    ok("ONE intent on the invoice after two clicks, not two", mintedOnDc.length === 1);

    /**
     * ── A live intent for the WRONG amount is refused, never resumed ───────────
     *
     * Credit, a part payment or TDS landing between the clicks moves the collectible,
     * and `consumePaymentIntent` demands the intent amount equal the outstanding
     * EXACTLY — so resuming a stale one walks the buyer through their bank's challenge
     * only to fail at the end. Refuse, and still do not mint a second order.
     */
    const staleInv = await tmb.invoices.create(biz.id, {
      customer: cusX.id,
      lines: [{ description: "Stale-amount pay-now", amount_minor: 500_00, quantity: 1 }],
    });
    await createPaymentIntent({
      organizationId: org.organization.id,
      businessId: bizRowX!.id,
      purpose: "payment",
      paymentMethodPublicId: pmX.publicId,
      customerPublicId: cusX.id,
      // Deliberately NOT the collectible.
      amountMinor: 400_00,
      currency: staleInv.currency!,
      invoicePublicId: staleInv.id,
      session: "on_session",
      methodTypes: ["upi"],
    });
    const stale = await http(`/portal/v1/invoices/${staleInv.id}/collect`, {
      method: "POST",
      token: xToken,
      body: {},
    });
    ok("a live intent for a different amount is refused → 400", stale.status === 400);
    const staleMsg = (stale.json.error as { message?: string } | undefined)?.message ?? "";
    ok(
      "…and the buyer is told to reload rather than shown an id",
      /amount due has changed/i.test(staleMsg) && !/pi_/.test(staleMsg),
    );
    ok("…and no second intent was minted", (await intentsOn(staleInv.id)).length === 1);

    /** Succeeded payments on one invoice — paid once means exactly one. */
    const paymentsOn = async (invoicePublicId: string) => {
      const [invRow] = await systemDb
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.publicId, invoicePublicId))
        .limit(1);
      return withTenant(org.organization.id, async (tx) =>
        tx
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.invoiceId, invRow!.id), eq(payments.status, "succeeded"))),
      ).then((r) => r.length);
    };

    /**
     * ── An intent the gateway already AUTHORIZED is booked, not re-opened ──────
     *
     * Our row may say `authorized` (callback arrived) or still `in_progress` (it did
     * not). Either way the gateway holds the money and the form cannot be confirmed
     * again, so a second click runs leg 2 and the invoice is paid once.
     */
    const heldInv = await tmb.invoices.create(biz.id, {
      customer: cusX.id,
      lines: [{ description: "Held-authorization pay-now", amount_minor: 610_00, quantity: 1 }],
    });
    const { intent: held } = await createPaymentIntent({
      organizationId: org.organization.id,
      businessId: bizRowX!.id,
      purpose: "payment",
      paymentMethodPublicId: pmX.publicId,
      customerPublicId: cusX.id,
      amountMinor: heldInv.amount_due_minor!,
      currency: heldInv.currency!,
      invoicePublicId: heldInv.id,
      session: "on_session",
    });
    ok(
      "the held intent really is authorized with nothing to re-open",
      held.status === "authorized" && held.nextAction == null,
    );
    const heldRes = await http(`/portal/v1/invoices/${heldInv.id}/collect`, {
      method: "POST",
      token: xToken,
      body: {},
    });
    if (heldRes.status !== 200)
      console.log("    ↳ held resume:", heldRes.status, JSON.stringify(heldRes.json));
    ok("Pay now over a HELD authorization books it → paid", heldRes.json.status === "paid");
    ok("…once, with no second intent", (await intentsOn(heldInv.id)).length === 1);
    ok("…and one succeeded payment", (await paymentsOn(heldInv.id)) === 1);

    // The dead-form case: authorized at the gateway, our row still `in_progress`.
    const stuckInv = await tmb.invoices.create(biz.id, {
      customer: cusX.id,
      lines: [{ description: "Authorized-unbooked pay-now", amount_minor: 620_00, quantity: 1 }],
    });
    const { intent: stuck } = await createPaymentIntent({
      organizationId: org.organization.id,
      businessId: bizRowX!.id,
      purpose: "payment",
      paymentMethodPublicId: pmX.publicId,
      customerPublicId: cusX.id,
      amountMinor: stuckInv.amount_due_minor!,
      currency: stuckInv.currency!,
      invoicePublicId: stuckInv.id,
      session: "on_session",
      methodTypes: ["upi"],
    });
    // The buyer finishes at the gateway; no callback reaches us.
    await TmtestProvider.resolveChallenge(stuck.intentAtGateway!, true);
    ok(
      "the planted intent is still in_progress on our side",
      (await getPaymentIntent(org.organization.id, bizRowX!.id, stuck.publicId))?.status ===
        "in_progress",
    );
    const stuckRes = await http(`/portal/v1/invoices/${stuckInv.id}/collect`, {
      method: "POST",
      token: xToken,
      body: {},
    });
    if (stuckRes.json.status !== "paid")
      console.log("    ↳ stuck resume:", stuckRes.status, JSON.stringify(stuckRes.json));
    ok(
      "resuming an authorized-but-unbooked intent books it, not a dead form",
      stuckRes.status === 200 && stuckRes.json.status === "paid",
    );
    ok("…through the same intent", (await intentsOn(stuckInv.id)).length === 1);
    ok("…with one succeeded payment", (await paymentsOn(stuckInv.id)) === 1);
    const stuckAgain = await http(`/portal/v1/invoices/${stuckInv.id}/collect`, {
      method: "POST",
      token: xToken,
      body: {},
    });
    ok("…and a third click charges nothing more", stuckAgain.status === 400);
    ok("…still one payment", (await paymentsOn(stuckInv.id)) === 1);

    // Cancelled at the gateway: our row is voided and a new attempt starts.
    const goneInv = await tmb.invoices.create(biz.id, {
      customer: cusX.id,
      lines: [{ description: "Cancelled-at-gateway pay-now", amount_minor: 630_00, quantity: 1 }],
    });
    const { intent: gone } = await createPaymentIntent({
      organizationId: org.organization.id,
      businessId: bizRowX!.id,
      purpose: "payment",
      paymentMethodPublicId: pmX.publicId,
      customerPublicId: cusX.id,
      amountMinor: goneInv.amount_due_minor!,
      currency: goneInv.currency!,
      invoicePublicId: goneInv.id,
      session: "on_session",
      methodTypes: ["upi"],
    });
    await setTmtestChargeStatus(gone.intentAtGateway!, "voided");
    const goneRes = await http(`/portal/v1/invoices/${goneInv.id}/collect`, {
      method: "POST",
      token: xToken,
      body: {},
    });
    ok(
      "a cancelled intent is not resumed",
      goneRes.status === 200 &&
        (goneRes.json.payment_intent as { id?: string } | undefined)?.id !== gone.publicId,
    );
    ok(
      "…our row is voided",
      (await getPaymentIntent(org.organization.id, bizRowX!.id, gone.publicId))?.status ===
        "voided",
    );
    ok("…and a new attempt was started", (await intentsOn(goneInv.id)).length === 2);
  }

  /**
   * ── A ZERO-DUE INVOICE WITH THE BUYER'S MONEY IN FLIGHT ───────────────────────
   *
   * Measured 2026-09-03 on INV-7824. 11:59:10 the buyer pressed Pay now and an intent for
   * ₹22,184.00 went live at RazorPay; 11:59:57.948 — forty-seven seconds later — a
   * downgrade raised an adjustment credit note for exactly that amount against the same
   * invoice and applied it there, leaving the invoice `paid` with ₹0.00 due. The capture
   * landed at 12:15:57 and was auto-refunded three seconds later, so the money was handled.
   *
   * What the buyer would have been told, had their second click reached us, is the defect:
   * `due <= 0n` is checked BEFORE the live-intent lookup, so the route answers "This
   * invoice has nothing left to pay" to a person whose ₹22,184.00 is at that moment held
   * at the gateway on that exact invoice. Three of the four states here have careful copy
   * (resume mid-checkout, amount-changed, already-with-your-bank); this one — money in
   * flight, invoice closed under them, refund coming automatically — fell through to the
   * flattest sentence available.
   *
   * The refusal itself is right: there is nothing to collect and a second checkout would
   * be a second real order. Only the sentence was wrong.
   */
  {
    const cusZ = await tmb.customers.create(biz.id, {
      email: "portal-zerodue@acme.test",
      first_name: "Zero",
      last_name: "Due",
    });
    const [bizRowZ] = await systemDb
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
      .limit(1);
    const [cusRowZ] = await systemDb
      .select()
      .from(customers)
      .where(eq(customers.publicId, cusZ.id))
      .limit(1);
    const pmZ = await vaultPaymentMethod({
      organizationId: org.organization.id,
      businessId: bizRowZ!.id,
      customer: cusRowZ!,
      token: "tok_4242",
    });
    const zMint = await tmb.paymentMethods.createPortalSession(biz.id, cusZ.id);
    const zToken = (await exchange(zMint.token)).token;

    // INV-7824's own figure, so the fixture names the incident.
    const flightInv = await tmb.invoices.create(biz.id, {
      customer: cusZ.id,
      lines: [
        { description: "Zero-due with money in flight", amount_minor: 22_184_00, quantity: 1 },
      ],
    });
    const { intent: inFlightIntent } = await createPaymentIntent({
      organizationId: org.organization.id,
      businessId: bizRowZ!.id,
      purpose: "payment",
      paymentMethodPublicId: pmZ.publicId,
      customerPublicId: cusZ.id,
      amountMinor: flightInv.amount_due_minor!,
      currency: flightInv.currency!,
      invoicePublicId: flightInv.id,
      session: "on_session",
      // A checkout rail, so the intent sits `in_progress` with the gateway's own sheet
      // open — 11:59:10's state, and the one the buyer would click again from.
      methodTypes: ["upi"],
    });
    ok(
      "zero-due: the buyer's checkout is live at the gateway",
      inFlightIntent.status === "in_progress",
    );
    // The invoice closes under them. A cheque rather than a credit note because this suite
    // has no catalog: the pass keys on "owes nothing", not on which producer got it there.
    await recordOfflinePayment({
      organizationId: org.organization.id,
      businessId: bizRowZ!.id,
      invoicePublicId: flightInv.id,
      method: "cheque",
    });
    const flightRes = await http(`/portal/v1/invoices/${flightInv.id}/collect`, {
      method: "POST",
      token: zToken,
      body: {},
    });
    const flightMsg = (flightRes.json.error as { message?: string } | undefined)?.message ?? "";
    ok("zero-due with money in flight is still refused → 400", flightRes.status === 400);
    if (flightRes.status === 400) console.log("    ↳ zero-due reply:", flightMsg);
    ok(
      "…and the buyer is told their payment is still with the bank",
      /still with your bank/i.test(flightMsg),
    );
    ok(
      "…and that it comes back on its own, without promising a refund already booked",
      /returned to you automatically/i.test(flightMsg) && !/refunded/i.test(flightMsg),
    );

    /**
     * …AND THE FLAT SENTENCE SURVIVES for the case it was written for. A settled invoice
     * with nothing in flight has nothing to explain, and a message that mentioned a
     * payment coming back would be a lie there. This is the half a hard-coded new string
     * cannot pass.
     */
    const quietInv = await tmb.invoices.create(biz.id, {
      customer: cusZ.id,
      lines: [{ description: "Zero-due, nothing in flight", amount_minor: 150_00, quantity: 1 }],
    });
    await recordOfflinePayment({
      organizationId: org.organization.id,
      businessId: bizRowZ!.id,
      invoicePublicId: quietInv.id,
      method: "cheque",
    });
    const quietRes = await http(`/portal/v1/invoices/${quietInv.id}/collect`, {
      method: "POST",
      token: zToken,
      body: {},
    });
    const quietMsg = (quietRes.json.error as { message?: string } | undefined)?.message ?? "";
    ok("a settled invoice with nothing in flight → 400", quietRes.status === 400);
    ok(
      "…and keeps the plain sentence, with no payment invented to explain",
      /nothing left to pay/i.test(quietMsg) && !/still with your bank/i.test(quietMsg),
    );
  }

  /**
   * ── Pay now follows the customer's DEFAULT, not whatever was added last ──
   *
   * `listPaymentMethods` orders `created_at DESC`, and the route took the first `valid`
   * row — so adding a second instrument silently repointed Pay now at it, overriding the
   * "Set default" the buyer had used on that same screen. It matters more since Pay now
   * stopped debiting the mandate: `methodTypes` is derived from this pick, so the chosen
   * instrument no longer just pays, it decides which rail the checkout will even offer.
   *
   * The fixture is built so the two rules disagree: the DEFAULT is the OLDER card, and a
   * newer valid card exists. Picking "first valid" chooses the newer one and fails here.
   */
  {
    const cusD = await tmb.customers.create(biz.id, {
      email: "portal-default@acme.test",
      first_name: "Def",
      last_name: "Ault",
    });
    const [bizRowD] = await systemDb
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
      .limit(1);
    const [cusRowD] = await systemDb
      .select()
      .from(customers)
      .where(eq(customers.publicId, cusD.id))
      .limit(1);
    const older = await vaultPaymentMethod({
      organizationId: org.organization.id,
      businessId: bizRowD!.id,
      customer: cusRowD!,
      token: "tok_4242",
    });
    const newer = await vaultPaymentMethod({
      organizationId: org.organization.id,
      businessId: bizRowD!.id,
      customer: cusRowD!,
      token: "tok_4111111111111111",
    });
    ok("fixture: two distinct valid instruments", older.id !== newer.id);
    // The buyer chooses the OLDER one — exactly what the portal's "Set default" does.
    await setDefaultPaymentMethod(org.organization.id, cusRowD!.id, older.publicId);

    const defInv = await tmb.invoices.create(biz.id, {
      customer: cusD.id,
      lines: [{ description: "Default-method pay-now", amount_minor: 120_00, quantity: 1 }],
    });
    const defMint = await tmb.paymentMethods.createPortalSession(biz.id, cusD.id);
    const defEx = await exchange(defMint.token);
    // A 429 here is the per-IP exchange throttle, not a portal bug — see the header.
    if (!defEx.token) console.log("    ↳ portal exchange failed:", defEx.status);
    const defToken = defEx.token;
    const res = await http(`/portal/v1/invoices/${defInv.id}/collect`, {
      method: "POST",
      token: defToken,
      body: {},
    });
    if (res.status !== 200)
      console.log("    ↳ default-method leg:", res.status, JSON.stringify(res.json));
    ok("pay now on the default-method customer is accepted", res.status === 200);

    // WHICH instrument actually paid — read off the payment, not off the response.
    const [payRow] = await systemDb
      .select()
      .from(payments)
      .where(eq(payments.customerId, cusRowD!.id))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    /**
     * Pay now opens the gateway's OWN sheet and the buyer types an instrument into it —
     * `letBuyerChooseMethod` withholds the stored method from the adapter — so no saved
     * card is charged. This used to assert the payment carried the default instrument;
     * that was our bookkeeping naming a card which had not paid, and the same coupling
     * refused a buyer whose card sat on a gateway that could not take their currency.
     */
    ok(
      "pay now does not attribute the payment to a stored card that never paid",
      payRow?.paymentMethodId == null,
    );

    /**
     * …but a DEAD default must not become a dead button. Collection does not filter on
     * status because it can hard-decline and fall through to the backup; a buyer-facing
     * checkout has no such second chance — opening on an invalid card just wastes the
     * buyer's time — so Pay now falls through to something payable.
     */
    await withTenant(org.organization.id, (tx) =>
      setPaymentMethodStatus(tx, org.organization.id, older.id, "invalid"),
    );
    const inv2 = await tmb.invoices.create(biz.id, {
      customer: cusD.id,
      lines: [{ description: "Invalid-default pay-now", amount_minor: 90_00, quantity: 1 }],
    });
    const mint2 = await tmb.paymentMethods.createPortalSession(biz.id, cusD.id);
    const token2 = (await exchange(mint2.token)).token;
    const res2 = await http(`/portal/v1/invoices/${inv2.id}/collect`, {
      method: "POST",
      token: token2,
      body: {},
    });
    ok("an INVALID default does not block pay now", res2.status === 200);
    const [payRow2] = await systemDb
      .select()
      .from(payments)
      .where(eq(payments.customerId, cusRowD!.id))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    // Nothing to fall through TO any more, and nothing needed: an invalid stored card
    // cannot make the button dead when no stored card is consulted.
    ok("…and still records no stored instrument", payRow2?.paymentMethodId == null);
  }

  /**
   * ── A buyer with NO stored instrument can pay ────────────────────────────────
   *
   * The engine refused the intent outright ("A payment intent requires a payment
   * method") even though the buyer types a card into the gateway's sheet either way —
   * so an invoice was unpayable in the portal for exactly the customers most likely to
   * be looking at one. Off-session still requires a token; there it has something to
   * charge.
   */
  {
    await clearPublicRateLimits();
    const cusN = await tmb.customers.create(biz.id, {
      email: "portal-nocard@acme.test",
      first_name: "No",
      last_name: "Card",
    });
    const invN = await tmb.invoices.create(biz.id, {
      customer: cusN.id,
      lines: [{ description: "No stored card", amount_minor: 70_00, quantity: 1 }],
    });
    const [bizRowN] = await systemDb
      .select()
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
      .limit(1);
    const tokenN = (
      await exchange((await tmb.paymentMethods.createPortalSession(biz.id, cusN.id)).token)
    ).token;
    const resN = await http(`/portal/v1/invoices/${invN.id}/collect`, {
      method: "POST",
      token: tokenN,
      body: {},
    });
    if (resN.status !== 200)
      console.log("    ↳ no-card pay now:", resN.status, JSON.stringify(resN.json));
    ok("a customer with NO saved card can pay now", resN.status === 200);

    /**
     * …and the relaxation is BUYER-PRESENT ONLY. An off-session intent has no sheet to
     * collect an instrument in, so with no stored token there is literally nothing to
     * charge — that must still be refused, or the hole this opens is silent.
     */
    let refusedOffSession = "";
    try {
      await createPaymentIntent({
        organizationId: org.organization.id,
        businessId: bizRowN!.id,
        purpose: "payment",
        customerPublicId: cusN.id,
        amountMinor: 70_00,
        currency: "USD",
        session: "off_session",
      });
    } catch (e) {
      refusedOffSession = (e as Error).message;
    }
    ok(
      "an off-session payment intent with no stored method is STILL refused",
      /requires a payment method/.test(refusedOffSession),
    );
  }

  /**
   * ── The card's gateway must not decide whether the buyer may pay ─────────────
   *
   * Production, 2026-09-06: `GatewayRouterError: Gateway account gwa_… does not handle
   * INR`. The buyer's card was vaulted on a gateway account whose `currencies` did not
   * list the invoice's currency, so Pay now died — on an instrument the adapter never
   * receives. Routing belongs to what is being CHARGED.
   *
   * Reproduced with a EUR-only vaulting account against a USD invoice. The business's
   * auto-provisioned tmtest account has `currencies = null` (all), so USD has exactly
   * one match and the choice is unambiguous.
   */
  {
    await clearPublicRateLimits();
    const [bizRowM] = await systemDb
      .select()
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
      .limit(1);
    const eurOnly = await createGatewayAccount({
      organizationId: org.organization.id,
      businessId: bizRowM!.id,
      gatewayKey: "tmtest",
      label: "EUR-only vault",
      credentials: {},
      currencies: ["EUR"],
    });
    const cusM = await tmb.customers.create(biz.id, {
      email: "portal-mismatch@acme.test",
      first_name: "Mis",
      last_name: "Match",
    });
    const [cusRowM] = await systemDb
      .select()
      .from(customers)
      .where(eq(customers.publicId, cusM.id))
      .limit(1);
    // The invoice FIRST, then the card. Creating it with the stranded card already in
    // place auto-collects off-session against that card, which genuinely cannot work —
    // only the gateway holding a token can charge it. That is the renewal path, not this
    // one, and letting it fire here would crash the fixture on a real limitation.
    const invM = await tmb.invoices.create(biz.id, {
      customer: cusM.id,
      lines: [{ description: "USD invoice, EUR-only card", amount_minor: 150_00, quantity: 1 }],
    });
    const strandedCard = await vaultPaymentMethod({
      organizationId: org.organization.id,
      businessId: bizRowM!.id,
      customer: cusRowM!,
      token: "tok_4242",
      gatewayAccountId: eurOnly.publicId,
    });
    ok(
      "fixture: the buyer's only card is vaulted on the EUR-only account",
      strandedCard.gatewayAccountId === eurOnly.id,
    );
    const tokenM = (
      await exchange((await tmb.paymentMethods.createPortalSession(biz.id, cusM.id)).token)
    ).token;
    const resM = await http(`/portal/v1/invoices/${invM.id}/collect`, {
      method: "POST",
      token: tokenM,
      body: {},
    });
    if (resM.status !== 200)
      console.log("    ↳ mismatch pay now:", resM.status, JSON.stringify(resM.json));
    ok("a card on a currency-mismatched gateway does not block pay now", resM.status === 200);

    // …and it routed to the account that can actually take USD, not the card's.
    const [piM] = await systemDb
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.customerId, cusRowM!.id))
      .orderBy(desc(paymentIntents.createdAt))
      .limit(1);
    ok(
      "…and routed to a gateway that handles the invoice currency",
      !!piM && piM.gatewayAccountId !== eurOnly.id,
    );

    // Leave the business as we found it. Active, this EUR-only account is the NEWEST one
    // on a shared fixture, so `resolveDefaultAccountForBusiness` hands it to every later
    // vault that names no account — which is how it broke a test 300 lines below.
    await updateGatewayAccount({
      organizationId: org.organization.id,
      businessId: bizRowM!.id,
      gwaPublicId: eurOnly.publicId,
      status: "disabled",
    });
  }

  /**
   * ── Pay now must NOT pin the rail to the instrument we happen to hold ────────
   *
   * The intent is minted with `letBuyerChooseMethod`, so the gateway's sheet offers
   * whatever the merchant has enabled and the buyer picks. Before that, `methodTypes`
   * carried the resolved instrument's rail — so a customer holding a card AND a UPI
   * mandate got whichever their default happened to be, with no way to use the other.
   *
   * A UPI default is what makes it observable through tmtest: `CHECKOUT_RAILS` contains
   * `upi` and not `card`, so a pinned UPI rail produces a checkout descriptor carrying
   * `method: 'upi'` and forces `requires_action`. Unpinned, there is no rail to build a
   * descriptor from. Asserting on the DESCRIPTOR rather than on the status, because the
   * status is a tmtest artefact while the pinned method is the thing under test.
   */
  {
    const cusU = await tmb.customers.create(biz.id, {
      email: "portal-unpinned@acme.test",
      first_name: "Un",
      last_name: "Pinned",
    });
    const [bizRowU] = await systemDb
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
      .limit(1);
    const [cusRowU] = await systemDb
      .select()
      .from(customers)
      .where(eq(customers.publicId, cusU.id))
      .limit(1);
    const upiPm = await vaultPaymentMethod({
      organizationId: org.organization.id,
      businessId: bizRowU!.id,
      customer: cusRowU!,
      token: "tok_4242",
    });
    await withTenant(org.organization.id, (tx) =>
      tx
        .update(paymentMethods)
        .set({ type: "upi", mandateRail: "upi" })
        .where(eq(paymentMethods.id, upiPm.id)),
    );

    const upiInv = await tmb.invoices.create(biz.id, {
      customer: cusU.id,
      lines: [{ description: "Unpinned rail", amount_minor: 180_00, quantity: 1 }],
    });
    const upiMint = await tmb.paymentMethods.createPortalSession(biz.id, cusU.id);
    const upiToken = (await exchange(upiMint.token)).token;
    const res = await http(`/portal/v1/invoices/${upiInv.id}/collect`, {
      method: "POST",
      token: upiToken,
      body: {},
    });
    ok("pay now on a UPI-default customer is accepted", res.status === 200);
    const action = (res.json.next_action ??
      (res.json.payment_intent as { next_action?: unknown } | undefined)?.next_action) as
      | { mode?: string; checkout?: { method?: string } }
      | undefined;
    if (action?.checkout?.method)
      console.log("    ↳ rail still pinned to:", action.checkout.method);
    ok(
      "…and the checkout is NOT pinned to the instrument's rail",
      action?.checkout?.method == null,
    );
  }

  /**
   * ── An invoice carrying CREDIT must be payable, for the amount the buyer is shown ──
   *
   * `total_minor` is the gross taxed claim; the collectible is `amount_due_minor`, net of
   * the promotional slice, the refundable/excess credit applied at generation, and TDS.
   * Leg 1 used to quote the gross, and `consumePaymentIntent` refuses an intent whose
   * amount is not exactly the outstanding — so Pay now on any credited invoice was not
   * merely wrong, it was IMPOSSIBLE: the buyer completed their bank's challenge and only
   * then hit "Intent amount … does not match invoice amount due …".
   *
   * Nothing caught it because the two columns are equal on an ordinary invoice — which is
   * exactly why this fixture puts credit on one.
   */
  {
    const [bizRow2] = await systemDb
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
      .limit(1);
    const [cusRow2] = await systemDb
      .select()
      .from(customers)
      .where(eq(customers.publicId, cusA.id))
      .limit(1);
    await recordExcessPayment({
      organizationId: org.organization.id,
      businessId: bizRow2!.id,
      customer: cusRow2!,
      amountMinor: 100_00,
      currency: "USD",
    });
    const credited = await tmb.invoices.create(biz.id, {
      customer: cusA.id,
      lines: [{ description: "Credited pay-now", amount_minor: 250_00, quantity: 1 }],
    });
    ok(
      "the fixture really is credited — due is BELOW the gross total",
      (credited.amount_due_minor ?? 0) < (credited.total_minor ?? 0),
    );

    const credMint = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
    const credToken = (await exchange(credMint.token)).token;
    const paid = await http(`/portal/v1/invoices/${credited.id}/collect`, {
      method: "POST",
      token: credToken,
      body: {},
    });
    if (paid.status !== 200)
      console.log("    ↳ credited leg:", paid.status, JSON.stringify(paid.json));
    ok("pay now on a CREDITED invoice is accepted, not 400", paid.status === 200);
    // The decisive one: the legs agree. A mismatch surfaces as a 400 from
    // `consumePaymentIntent`, never as a wrong amount — its equality guard is what
    // turned this bug into a dead button instead of an overcharge.
    ok(
      "…and settles or challenges rather than failing the amount check",
      paid.json.object === "invoice" || paid.json.status === "action_required",
    );
  }

  // ── "Collect open invoices when a payment method is added" must fire on the PORTAL,
  // not only on the operator route. This is where customers actually add cards, the
  // setting is ON by default, and it is the recovery path a parked invoice depends on.
  {
    const cusC = await tmb.customers.create(biz.id, {
      email: "portal-collect@acme.test",
      first_name: "Portal",
      last_name: "Collect",
    });
    const open = await tmb.invoices.create(biz.id, {
      customer: cusC.id,
      lines: [{ description: "Open before the card", amount_minor: 150_00, quantity: 1 }],
    });
    const mintC = await tmb.paymentMethods.createPortalSession(biz.id, cusC.id);
    const tokenC = (await exchange(mintC.token)).token;
    const vault = await http("/portal/v1/payment_methods", {
      method: "POST",
      token: tokenC,
      body: { token: "tok_4242" },
    });
    ok("portal add-card vaults", vault.status === 201);
    const settled = (vault.json.collected ?? []) as Array<{ invoice: string; status: string }>;
    ok(
      "…and collects the customer's open invoice",
      settled.some((c) => c.invoice === open.id && c.status === "succeeded"),
    );
    const reread = await http(`/portal/v1/invoices/${open.id}`, { token: tokenC });
    ok("…so the invoice is actually paid", reread.json.status === "paid");
  }

  // ── Double-pay guard. An async rail (UPI, netbanking, a card mandate) books a
  // PENDING payment that settles by webhook up to days later. If "Pay now" opens a
  // second checkout over the top of it, the buyer pays once and the settling debit pays
  // again. `collectInvoice` has always refused this; the portal route creates its own
  // intent, so it needed the guard explicitly.
  {
    const inv2 = await tmb.invoices.create(biz.id, {
      customer: cusA.id,
      lines: [{ description: "Double-pay guard", amount_minor: 300_00, quantity: 1 }],
    });
    // Park a pending payment on it the way an async debit would.
    await systemDb.execute(sql`
      insert into payments (organization_id, business_id, customer_id, invoice_id, public_id,
                            status, amount_minor, currency, provider_key)
      select i.organization_id, i.business_id, i.customer_id, i.id, ${`pay_guard${Date.now()}`},
             'pending', i.total_minor, i.currency, 'tmtest'
      from invoices i where i.public_id = ${inv2.id}
    `);
    const blocked = await http(`/portal/v1/invoices/${inv2.id}/collect`, {
      method: "POST",
      token: payToken,
      body: {},
    });
    ok("pay now refuses while a payment is already pending → 400", blocked.status === 400);

    // …and the list must SAY so, or the portal renders a button the engine will refuse.
    // Nothing else on the row reveals it: the status stays `payment_due` and the full
    // amount stays due while the money is in motion.
    const listed = await http("/portal/v1/invoices", { token: payToken });
    const rows = (listed.json.data ?? []) as Array<{ id: string; payment_in_flight?: boolean }>;
    ok(
      "the invoice list flags the in-flight payment",
      rows.find((i) => i.id === inv2.id)?.payment_in_flight === true,
    );
    ok(
      "…and does not flag an invoice with nothing in flight",
      rows.filter((i) => i.id !== inv2.id).every((i) => i.payment_in_flight !== true),
    );
    ok(
      "…and says so in words a buyer can act on",
      /already being processed/i.test(
        String((blocked.json?.error as { message?: string } | undefined)?.message ?? ""),
      ),
    );
  }

  // ── Ownership. cusB's invoice must be invisible to cusA's portal token, and
  // phrased as "no such invoice" so a token cannot probe which ids exist.
  const foreign = await tmb.invoices.create(biz.id, {
    customer: cusB.id,
    lines: [{ description: "Someone else", amount_minor: 100_00, quantity: 1 }],
  });
  const stolen = await http(`/portal/v1/invoices/${foreign.id}/collect`, {
    method: "POST",
    token: payToken,
    body: {},
  });
  ok("pay now cannot touch another customer's invoice → 404", stolen.status === 404);
  const peek = await http(`/portal/v1/invoices/${foreign.id}`, { token: payToken });
  ok("another customer's invoice is not readable either → 404", peek.status === 404);

  // ── The PDF, which had NO coverage at all before 2026-08-28 ────────────────────
  //
  // Not even a happy path, and it is the worst surface to leave unasserted on this tier: the
  // whole point of a "Download PDF" button is that the file gets saved and forwarded, and the
  // document carries the buyer's name, address, line items and totals. The dashboard's own
  // passthrough route states that "the backend still enforces that the invoice belongs to this
  // portal session's customer" — that sentence was an unasserted claim until now.
  //
  // The positive control comes first, or a route that 404s for everybody would read as perfect
  // isolation. (This suite's `http` helper parses JSON, so the PDF is fetched raw.)
  const pdfOwn = await fetch(`${base}/portal/v1/invoices/${inv.id}/pdf`, {
    headers: { authorization: `Bearer ${payToken}` },
  });
  const pdfBytes = Buffer.from(await pdfOwn.arrayBuffer());
  ok("portal pdf: a buyer CAN download their own invoice", pdfOwn.status === 200);
  // A PDF's content streams are compressed, so no fixture string is findable in a correct
  // response — assert it is a real document instead of weakening the check until it passes.
  ok(
    "portal pdf: …and it is a real PDF, not an error page",
    pdfBytes.subarray(0, 5).toString() === "%PDF-" && pdfBytes.length > 1000,
  );

  const pdfForeign = await fetch(`${base}/portal/v1/invoices/${foreign.id}/pdf`, {
    headers: { authorization: `Bearer ${payToken}` },
  });
  ok("portal pdf: another customer's invoice PDF is refused → 404", pdfForeign.status === 404);
  const pdfForeignBody = Buffer.from(await pdfForeign.arrayBuffer()).toString("latin1");
  ok("portal pdf: …and the refusal is not a PDF at all", !pdfForeignBody.startsWith("%PDF-"));

  // ── Deleting another buyer's vaulted card ──────────────────────────────────────
  //
  // `/default` was covered; plain DELETE was not, and it is the destructive one — removing
  // someone else's card stops their renewals and sends them to dunning.
  const killB = await http(`/portal/v1/payment_methods/${pmB.id}`, {
    method: "DELETE",
    token: payToken,
  });
  ok("portal: cannot DELETE another customer's payment method → 404", killB.status === 404);
  // Proving the refusal was real rather than a 404 returned after the row was already gone —
  // the same reasoning as `verify:bola`'s "B is untouched" section.
  const bStillHasIt = await tmb.paymentMethods.list(biz.id, cusB.id);
  ok(
    "portal: …and B's card is still there",
    bStillHasIt.data.some((p) => p.id === pmB.id),
  );
}

/**
 * ── #28a · a disabled/misconfigured gateway must not name itself to the buyer ──────
 *
 * `PaymentIntentError`, `GatewayRouterError`, `ProviderRefusalError` and
 * `PaymentMethodConfigError` all used to reach `/portal/v1/invoices/:inv/collect` and
 * get forwarded to the buyer as `badRequest(reply, e.message)` verbatim — messages like
 * `"Gateway account gwa_… is not active"` that name what an OPERATOR must fix, on the
 * one route a buyer actually reads. HTTP-level, through the real route, rather than
 * asserting on the service layer directly: this is what a buyer's browser would
 * actually receive.
 */
{
  const cfgCus = await tmb.customers.create(biz.id, {
    email: "portal-gwconfig@acme.test",
    first_name: "Gate",
    last_name: "Way",
  });
  const [bizRowCfg] = await systemDb
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.publicId, biz.id))
    .limit(1);
  const [cusRowCfg] = await systemDb
    .select()
    .from(customers)
    .where(eq(customers.publicId, cfgCus.id))
    .limit(1);
  const pmCfg = await vaultPaymentMethod({
    organizationId: org.organization.id,
    businessId: bizRowCfg!.id,
    customer: cusRowCfg!,
    token: "tok_4242",
  });
  const cfgInv = await tmb.invoices.create(biz.id, {
    customer: cfgCus.id,
    lines: [{ description: "Gateway-config coverage", amount_minor: 550_00, quantity: 1 }],
  });
  const { intent: cfgIntent } = await createPaymentIntent({
    organizationId: org.organization.id,
    businessId: bizRowCfg!.id,
    purpose: "payment",
    paymentMethodPublicId: pmCfg.publicId,
    customerPublicId: cfgCus.id,
    amountMinor: cfgInv.amount_due_minor!,
    currency: cfgInv.currency!,
    invoicePublicId: cfgInv.id,
    session: "on_session",
  });
  ok(
    "#28a fixture: intent authorizes immediately (tmtest, no challenge)",
    cfgIntent.status === "authorized",
  );

  const cfgAcct = (await listGatewayAccounts(org.organization.id, bizRowCfg!.id)).find(
    (a) => a.gatewayKey === "tmtest",
  )!;
  await updateGatewayAccount({
    organizationId: org.organization.id,
    businessId: bizRowCfg!.id,
    gwaPublicId: cfgAcct.publicId,
    status: "disabled",
  });

  const cfgToken = (
    await exchange((await tmb.paymentMethods.createPortalSession(biz.id, cfgCus.id)).token)
  ).token;
  const cfgCollect = await http(`/portal/v1/invoices/${cfgInv.id}/collect`, {
    method: "POST",
    token: cfgToken,
    body: { payment_intent: cfgIntent.publicId },
  });
  if (cfgCollect.status !== 400)
    console.log("    ↳ #28a collect:", cfgCollect.status, JSON.stringify(cfgCollect.json));
  ok(
    "#28a: a disabled gateway account still refuses the buyer's leg-2 (400)",
    cfgCollect.status === 400,
  );
  const cfgMsg = String(
    (cfgCollect.json?.error as { message?: string } | undefined)?.message ?? "",
  );
  console.log(`    ↳ #28a buyer-facing message: ${cfgMsg}`);
  ok(
    "#28a: …but the message no longer names the gateway account",
    !cfgMsg.includes(cfgAcct.publicId) && !/gateway account/i.test(cfgMsg),
  );
  ok(
    "#28a: …and says something true and buyer-actionable instead",
    cfgMsg.includes("problem with the payment configuration") &&
      cfgMsg.includes("We did not charge you"),
  );
  await updateGatewayAccount({
    organizationId: org.organization.id,
    businessId: bizRowCfg!.id,
    gwaPublicId: cfgAcct.publicId,
    status: "active",
  });

  /**
   * ── The SAME leak, a different route through the code: no live account AT ALL ──
   *
   * The fixture above hits `assertIntentGatewayUsable` (leg 2 / consume). A FIRST
   * click routes through `createPaymentIntent` → `resolveAccountForPm` →
   * `selectGatewayAccount`, which throws `GatewayRouterError` — a different class,
   * caught separately in the route (`reportGatewayConfigErrorToBuyer`), and worth its
   * own fixture: disabling the account here still leaves it resolvable by publicId,
   * but with NO active account left to route to at all, `no_gateway_for_currency`'s
   * own message ("No active gateway account handles USD") is a "set a default gateway
   * account" class of operator instruction — unusable to a buyer.
   */
  await updateGatewayAccount({
    organizationId: org.organization.id,
    businessId: bizRowCfg!.id,
    gwaPublicId: cfgAcct.publicId,
    status: "disabled",
  });
  const noRouteInv = await tmb.invoices.create(biz.id, {
    customer: cfgCus.id,
    lines: [{ description: "No routable gateway", amount_minor: 300_00, quantity: 1 }],
  });
  const noRouteCollect = await http(`/portal/v1/invoices/${noRouteInv.id}/collect`, {
    method: "POST",
    token: cfgToken,
    body: {},
  });
  if (noRouteCollect.status !== 400)
    console.log(
      "    ↳ #28a no-route collect:",
      noRouteCollect.status,
      JSON.stringify(noRouteCollect.json),
    );
  ok(
    "#28a: a first click with no live gateway account is refused (400), not a 5xx",
    noRouteCollect.status === 400,
  );
  const noRouteMsg = String(
    (noRouteCollect.json?.error as { message?: string } | undefined)?.message ?? "",
  );
  console.log(`    ↳ #28a no-route buyer-facing message: ${noRouteMsg}`);
  ok(
    "#28a: …the GatewayRouterError message is not forwarded verbatim either",
    !/active gateway account/i.test(noRouteMsg) && !/set a default/i.test(noRouteMsg),
  );
  ok(
    "#28a: …and the buyer sees the same safe, true sentence",
    noRouteMsg.includes("problem with the payment configuration") &&
      noRouteMsg.includes("We did not charge you"),
  );
  await updateGatewayAccount({
    organizationId: org.organization.id,
    businessId: bizRowCfg!.id,
    gwaPublicId: cfgAcct.publicId,
    status: "active",
  });
}

// ── INVOICE LIST IS BOUNDED (and says so) ────────────────────────────────────
//
// `/portal/v1/invoices` used to call `listInvoices` with no limit: every invoice the
// customer had ever had, plus `paidTotals` and an in-flight lookup across all of them,
// on every portal open. Nothing was hidden from the buyer, which is exactly why it was
// invisible — the cost and the ever-growing card were the only symptoms.
//
// The contract now has three parts and each is tested, because a page size is worthless
// if `has_more` lies (the caller then renders no way to reach the rest) and a `limit`
// that is not clamped just re-creates the unbounded read from a query string.
{
  const cusPage = await tmb.customers.create(biz.id, {
    email: "portal-paging@acme.test",
    first_name: "Portal",
    last_name: "Paging",
  });
  // Twelve, so the default page of ten leaves a remainder that must be reachable.
  for (let i = 0; i < 12; i++) {
    await tmb.invoices.create(biz.id, {
      customer: cusPage.id,
      lines: [{ description: `Paging ${i + 1}`, amount_minor: 100_00, quantity: 1 }],
    });
  }
  const mint = await tmb.paymentMethods.createPortalSession(biz.id, cusPage.id);
  const tok = (await exchange(mint.token)).token;
  const list = (qs: string) => http(`/portal/v1/invoices${qs}`, { token: tok });

  const first = await list("");
  ok("invoices: the default page is bounded", first.json.data?.length === 10);
  ok("invoices: …and has_more says the rest exist", first.json.has_more === true);

  const all = await list("?limit=12");
  ok("invoices: an explicit limit reaches the rest", all.json.data?.length === 12);
  ok("invoices: …and has_more is then false", all.json.has_more === false);

  const clamped = await list("?limit=999999");
  ok(
    "invoices: a huge limit is clamped, not honoured",
    clamped.json.data?.length === 12 && clamped.json.has_more === false,
  );

  // Newest first, and the page must be the newest ones — a limit applied before the sort
  // would return ten arbitrary rows and still look correct on a count alone.
  const firstIds: string[] = ((first.json.data ?? []) as { id: string }[]).map((i) => i.id);
  const allIds: string[] = ((all.json.data ?? []) as { id: string }[]).map((i) => i.id);
  ok(
    "invoices: the page is the NEWEST rows, in order",
    firstIds.length === 10 && firstIds.every((id, n) => id === allIds[n]),
  );

  const junk = await list("?limit=abc");
  ok(
    "invoices: an unparseable limit falls back rather than erroring",
    junk.status === 200 && junk.json.data?.length === 10,
  );
}

/**
 * ── #23 · THE BUYER'S OWN CALLBACK, REFUSED ON OUR STALE STATUS ──────────────
 *
 * Measured 2026-09-03 17:47 on a deliberate failure test (Pay now → cancel the
 * subscription mid-checkout → complete the payment at RazorPay). A SUCCESSFUL payment
 * showed the payer:
 *
 *     "Intent is in_progress; complete the challenge first"
 *
 * State at that moment: intent `pi_XXXXXXXXXXXXXXXXXXXXXX03` (₹22,184.00, order
 * `order_XXXXXXXXXXXX03`) still `in_progress`, `authorized_at` NULL, its attempt
 * `requires_action`, and ZERO inbound webhooks since 17:15. So the buyer's browser
 * arrived with leg 2 before RazorPay's authorize event, and `consumePaymentIntent`
 * refused because it trusted a row nothing had updated. Three faults in one sentence:
 * it leaks our vocabulary (`Intent`, `in_progress`) to a PAYER; it is FALSE, telling
 * them to complete a challenge they had just completed; and it is avoidable, because
 * #15 put `fetchIntent` on the adapter and this path did not ask.
 *
 * This section drives the REAL second leg over HTTP as the buyer, because the string is
 * the defect — an engine-level assertion would prove the status logic and miss the
 * sentence, and the sentence is what the person read.
 *
 * ⚠ Every fixture here rewinds OUR row directly and moves the GATEWAY's row directly.
 * Neither goes through `TmtestProvider.resolveChallenge`, which drives BOTH and would
 * erase the divergence that IS the defect — A1 lost a #17 fixture to exactly that
 * (`resolveChallenge(id, true)` re-authorizes any row it finds; the note is in
 * verify-gateway.ts). The proof that the rewind survives is `#23-A: authorized_at is
 * NULL before leg 2`: if anything had re-authorized our row the fixture would announce
 * itself instead of passing for the wrong reason.
 */
{
  const cus23 = await tmb.customers.create(biz.id, {
    email: "portal-stale23@acme.test",
    first_name: "Stale",
    last_name: "TwentyThree",
  });
  const [biz23] = await systemDb
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.publicId, biz.id))
    .limit(1);
  const [cusRow23] = await systemDb
    .select()
    .from(customers)
    .where(eq(customers.publicId, cus23.id))
    .limit(1);
  const pm23 = await vaultPaymentMethod({
    organizationId: org.organization.id,
    businessId: biz23!.id,
    customer: cusRow23!,
    token: "tok_4242",
  });
  const mint23 = await tmb.paymentMethods.createPortalSession(biz.id, cus23.id);
  const tok23 = (await exchange(mint23.token)).token;

  const ourIntent = async (id: string) =>
    (
      await withTenant(org.organization.id, (tx) =>
        tx.select().from(paymentIntents).where(eq(paymentIntents.id, id)).limit(1),
      )
    )[0];
  /** Force the GATEWAY's own row, leaving our intent alone. */
  const gatewaySays = (chargeId: string, status: string) =>
    systemDb.update(tmtestCharges).set({ status }).where(eq(tmtestCharges.chargeId, chargeId));
  /** The leg the buyer's browser posts once the gateway's sheet closes. */
  const legTwo = (invId: string, piId: string) =>
    http(`/portal/v1/invoices/${invId}/collect`, {
      method: "POST",
      token: tok23,
      body: { payment_intent: piId },
    });
  /**
   * An invoice plus an intent for its exact outstanding, with our row rewound to the
   * state the defect was measured in: `in_progress`, `authorized_at` NULL — a callback
   * that has not arrived yet.
   */
  const staleLeg = async (label: string, amountMinor: number) => {
    const inv = await tmb.invoices.create(biz.id, {
      customer: cus23.id,
      lines: [{ description: label, amount_minor: amountMinor, quantity: 1 }],
    });
    const { intent } = await createPaymentIntent({
      organizationId: org.organization.id,
      businessId: biz23!.id,
      purpose: "payment",
      paymentMethodPublicId: pm23.publicId,
      customerPublicId: cus23.id,
      amountMinor: inv.amount_due_minor!,
      currency: inv.currency!,
      invoicePublicId: inv.id,
      session: "on_session",
    });
    await withTenant(org.organization.id, (tx) =>
      tx
        .update(paymentIntents)
        .set({ status: "in_progress", authorizedAt: null })
        .where(eq(paymentIntents.id, intent.id)),
    );
    return { inv, intent, gw: intent.intentAtGateway! };
  };
  /** The sentence the PAYER reads — `badRequest` sends `{error:{type,message}}`. */
  const refusalText = (r: { json?: unknown }) =>
    String((r.json as { error?: { message?: string } } | undefined)?.error?.message ?? "");
  /** Our vocabulary, and the false instruction, in one predicate. */
  const leaksInternals = (m: string) =>
    /\bintent\b|in_progress|\bconsumed\b|\bchallenge\b|\bgateway\b/i.test(m);

  // ── (A) the gateway is holding the money; our row never heard ────────────────
  const a23 = await staleLeg("Stale-23 A", 221_84_00);
  ok("#23-A: our row says in_progress (the callback never arrived)", a23.intent.status !== null);
  const aBefore = await ourIntent(a23.intent.id);
  ok(
    "#23-A: …and authorized_at is NULL before leg 2 (the fixture was not undone)",
    aBefore?.status === "in_progress" && aBefore?.authorizedAt == null,
  );
  await gatewaySays(a23.gw, "authorized");
  const legA = await legTwo(a23.inv.id, a23.intent.publicId);
  if (legA.status !== 200)
    console.log("    ↳ #23-A leg 2:", legA.status, JSON.stringify(legA.json));
  ok(
    "#23-A: leg 2 SUCCEEDS where our row says in_progress and the gateway says authorized",
    legA.status === 200,
  );
  ok("#23-A: …and the payer is told the invoice is paid", legA.json.status === "paid");
  const aAfter = await ourIntent(a23.intent.id);
  // Proves the flip went through `authorizePaymentIntent` — the writer the WEBHOOK uses —
  // and not a second local mutation. Only that writer stamps `authorized_at`; #15/#17 are
  // both about two writers of one fact drifting apart.
  ok(
    "#23-A: …and the row was flipped through the webhook's own writer (authorized_at stamped)",
    aAfter?.authorizedAt != null,
  );
  ok("#23-A: …ending consumed, so the capture really happened", aAfter?.status === "consumed");

  // ── (R) the gateway takes the capture but holds it for review (PayPal PENDING_REVIEW) ──
  {
    const r23 = await staleLeg("Review-23 R", 52_55);
    await authorizePaymentIntent(org.organization.id, biz23!.id, r23.intent.publicId);
    const chargeId = `tmch_review_${crypto.randomUUID()}`;
    const original = TmtestProvider.prototype.consumeIntent;
    TmtestProvider.prototype.consumeIntent = async () => ({
      purpose: "payment",
      charge: { status: "pending", providerChargeId: chargeId },
    });
    let legR: Awaited<ReturnType<typeof legTwo>>;
    try {
      legR = await legTwo(r23.inv.id, r23.intent.publicId);
    } finally {
      TmtestProvider.prototype.consumeIntent = original;
    }
    ok(
      "#review: Pay now with a held capture answers 200 with no payment error",
      legR.status === 200 && !legR.json.payment_error && legR.json.status !== "paid",
    );
    const listedR = await http("/portal/v1/invoices", { token: tok23 });
    const rowR = (listedR.json.data as { id: string; payment_in_flight?: boolean }[]).find(
      (i) => i.id === r23.inv.id,
    );
    ok(
      "#review: …and the invoice list shows the payment in flight",
      rowR?.payment_in_flight === true,
    );
    await handleProviderEvent(
      "tmtest",
      {
        providerEventId: `tmev_review_${crypto.randomUUID()}`,
        type: "charge.succeeded",
        providerChargeId: chargeId,
        occurredAt: new Date(),
        raw: { data: {} },
      },
      { businessId: biz23!.id },
    );
    const afterR = await http(`/portal/v1/invoices/${r23.inv.id}`, { token: tok23 });
    ok("#review: …and the gateway's later success pays it", afterR.json.status === "paid");
  }

  // ── (B) the gateway agrees nothing is authorized — refuse, but say what is true ──
  const b23 = await staleLeg("Stale-23 B", 150_00);
  await gatewaySays(b23.gw, "requires_action");
  const legB = await legTwo(b23.inv.id, b23.intent.publicId);
  const msgB = refusalText(legB);
  if (legB.status !== 400)
    console.log("    ↳ #23-B leg 2:", legB.status, JSON.stringify(legB.json));
  ok(
    "#23-B: leg 2 still refuses when the gateway agrees nothing is authorized",
    legB.status === 400,
  );
  ok("#23-B: …and says we have not heard from their bank", /bank did not tell us yet/i.test(msgB));
  ok("#23-B: …and tells them not to pay twice", /do not pay again/i.test(msgB));
  ok(
    "#23-B: …and never instructs them to complete a step they completed",
    !/complete the challenge/i.test(msgB),
  );
  ok("#23-B: …and leaks no internal vocabulary to the payer", !leaksInternals(msgB));
  if (leaksInternals(msgB)) console.log("    ↳ #23-B leaked wording:", msgB);
  const bAfter = await ourIntent(b23.intent.id);
  ok("#23-B: …and our row is left alone, not flipped", bAfter?.status === "in_progress");

  // ── (C) `unknown` is not an answer about money ───────────────────────────────
  //
  // The gateway has never heard of the order (A1's lever from #17: remove the row rather
  // than flip it). `FetchedIntent.status: 'unknown'` must keep the behaviour we had
  // before we asked — it must never become "authorized".
  const c23 = await staleLeg("Stale-23 C", 175_00);
  const goneC = await systemDb
    .delete(tmtestCharges)
    .where(eq(tmtestCharges.chargeId, c23.gw))
    .returning();
  ok("#23-FIXTURE: the gateway has never heard of this order", goneC.length === 1);
  const legC = await legTwo(c23.inv.id, c23.intent.publicId);
  ok("#23-C: an `unknown` answer is NOT read as authorized", legC.status === 400);
  const cAfter = await ourIntent(c23.intent.id);
  ok("#23-C: …and our row was not flipped on our own ignorance", cAfter?.status === "in_progress");
  ok("#23-C: …and the refusal is still buyer-safe", !leaksInternals(refusalText(legC)));

  // ── (D) the invoice was settled out from under them while the money moved ────
  //
  // #23's own scenario, one step further on: the gateway DOES hold the money, and the
  // invoice has since been settled (17:47: a cancellation credited it). The refusal is
  // correct — there is nothing to collect — but it must not read as a dead end, and it
  // must match the voice B2 already wrote for the zero-due branch of this same route.
  const d23 = await staleLeg("Stale-23 D", 200_00);
  await gatewaySays(d23.gw, "authorized");
  await recordOfflinePayment({
    organizationId: org.organization.id,
    businessId: biz23!.id,
    invoicePublicId: d23.inv.id,
    amountMinor: 200_00,
    method: "cash",
  });
  const legD = await legTwo(d23.inv.id, d23.intent.publicId);
  const msgD = refusalText(legD);
  if (legD.status !== 400)
    console.log("    ↳ #23-D leg 2:", legD.status, JSON.stringify(legD.json));
  ok("#23-D: a settled invoice still refuses the leg", legD.status === 400);
  ok(
    "#23-D: …and promises the money comes back on its own",
    /return it to you automatically/i.test(msgD),
  );
  ok("#23-D: …and leaks no internal vocabulary to the payer", !leaksInternals(msgD));
  if (legD.status === 400 && leaksInternals(msgD)) console.log("    ↳ #23-D wording:", msgD);

  // ── (E) the gateway has already CAPTURED it, and we never booked it ─────────
  //
  // The third answer, and the reason the poll returns a verdict rather than a boolean.
  // `consumed` at the gateway means the money MOVED. Authorizing on it would walk an
  // already-captured intent back into a capture; refusing with "we have not heard from
  // your bank" would be false about money that has actually left this person's account —
  // the same fault as `complete the challenge first`, which is the whole of #23. This
  // was NOT in the original fix: the first implementation lumped `consumed` in with
  // "nothing is authorized" and would have told them exactly that lie.
  //
  // tmtest maps its own `succeeded` to `FetchedIntent.status: 'consumed'` — a captured
  // intent, not a hold.
  const e23 = await staleLeg("Stale-23 E", 190_00);
  await gatewaySays(e23.gw, "succeeded");
  const legE = await legTwo(e23.inv.id, e23.intent.publicId);
  const msgE = refusalText(legE);
  if (legE.status !== 400)
    console.log("    ↳ #23-E leg 2:", legE.status, JSON.stringify(legE.json));
  ok("#23-E: a capture the gateway already made is not re-captured", legE.status === 400);
  ok(
    "#23-E: …and the payer is NOT told we have not heard from their bank",
    !/have not heard from your bank/i.test(msgE),
  );
  ok(
    "#23-E: …but is told their payment arrived",
    /Your payment reached us, and we are applying it/i.test(msgE),
  );
  ok("#23-E: …and leaks no internal vocabulary to the payer", !leaksInternals(msgE));
  if (legE.status === 400 && !/Your payment reached us, and we are applying it/i.test(msgE))
    console.log("    ↳ #23-E wording:", msgE);
  ok(
    "#23-E: …and our row was not flipped to authorized on a captured intent",
    (await ourIntent(e23.intent.id))?.status === "in_progress",
  );
}

/**
 * ── #42 · a gateway condition we cannot RESOLVE is not a 500, and not a refusal ────
 *
 * The buyer's half. `ProviderIndeterminateError` means the fact the operation turns on
 * could not be established — nobody did anything wrong and retrying is right — so the
 * portal answers 502 `retriable: true` rather than the 500 a bare `Error` produces or
 * the 400 a refusal gets (a 400 would tell a payer to fix a request that was fine).
 *
 * Two things are asserted about the SENTENCE, and they pull in opposite directions:
 * the adapter's own words must NOT reach the buyer (they name gateway resources), and
 * what replaces them must not claim anything about the money either way — "we cannot
 * yet tell you whether it went through", never "nothing was charged".
 */
{
  const indCus = await tmb.customers.create(biz.id, {
    email: "portal-indeterminate@acme.test",
    first_name: "Ina",
    last_name: "Determinate",
  });
  const [bizRowInd] = await systemDb
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.publicId, biz.id))
    .limit(1);
  const [cusRowInd] = await systemDb
    .select()
    .from(customers)
    .where(eq(customers.publicId, indCus.id))
    .limit(1);
  const pmInd = await vaultPaymentMethod({
    organizationId: org.organization.id,
    businessId: bizRowInd!.id,
    customer: cusRowInd!,
    token: "tok_4242",
  });
  const indInv = await tmb.invoices.create(biz.id, {
    customer: indCus.id,
    lines: [{ description: "Indeterminate coverage", amount_minor: 310_00, quantity: 1 }],
  });
  const { intent: indIntent } = await createPaymentIntent({
    organizationId: org.organization.id,
    businessId: bizRowInd!.id,
    purpose: "payment",
    paymentMethodPublicId: pmInd.publicId,
    customerPublicId: indCus.id,
    amountMinor: indInv.amount_due_minor!,
    currency: indInv.currency!,
    invoicePublicId: indInv.id,
    session: "on_session",
  });
  const ADAPTER_SENTENCE =
    "tmtest consume aborted: authorization auth_42 could not be resolved — whether a hold " +
    "is in place is unknown";
  const realConsume = TmtestProvider.prototype.consumeIntent;
  TmtestProvider.prototype.consumeIntent = async () => {
    throw new ProviderIndeterminateError(ADAPTER_SENTENCE);
  };
  const indToken = (
    await exchange((await tmb.paymentMethods.createPortalSession(biz.id, indCus.id)).token)
  ).token;
  const indCollect = await http(`/portal/v1/invoices/${indInv.id}/collect`, {
    method: "POST",
    token: indToken,
    body: { payment_intent: indIntent.publicId },
  });
  TmtestProvider.prototype.consumeIntent = realConsume;
  if (indCollect.status !== 502)
    console.log("    ↳ #42 collect:", indCollect.status, JSON.stringify(indCollect.json));
  const indErr = (indCollect.json?.error ?? {}) as {
    type?: string;
    message?: string;
    retriable?: boolean;
  };
  ok("#42: the buyer gets 502, not 500 and not 400", indCollect.status === 502);
  ok(
    "#42: …a gateway_error the buyer is told is retriable",
    indErr.type === "gateway_error" && indErr.retriable === true,
  );
  const indMsg = String(indErr.message ?? "");
  console.log(`    ↳ #42 buyer-facing message: ${indMsg}`);
  ok(
    "#42: …the adapter's own gateway-resource sentence is NOT forwarded",
    indMsg.length > 0 && !indMsg.includes("auth_42") && !indMsg.includes("tmtest"),
  );
  ok(
    "#42: …and the replacement claims nothing about the buyer's money",
    !/\bnothing (?:has been|was) (?:charged|paid|debited)\b/i.test(indMsg) &&
      !/\b(?:was|were) (?:not )?(?:charged|paid|debited|released)\b/i.test(indMsg),
  );
  ok(
    "#42: …and the invoice was not marked paid on the way out",
    (await tmb.invoices.get(biz.id, indInv.id)).status !== "paid",
  );
}

// ── 0238: the coupon box — ONE discount, buyer-removable ─────────────────────
//
// The portal allows a buyer to carry one discount at a time and to take a COUPON back
// off. Both halves are load-bearing: without the ceiling a buyer assembles a price no one
// set, and without removal the ceiling traps them behind their own typo. An operator's
// manual discount is excluded from removal — they never asked for it and cannot restore
// it — and that exclusion is what the last three checks pin.
{
  const { createProduct, createPrice } = await import("@/modules/catalog/service");
  const { createSubscription } = await import("@/modules/subscriptions/service");
  const { createCoupon } = await import("@/modules/coupons/service");
  const { applyManualDiscount, removeDiscount } = await import("@/modules/coupons/service");

  const orgId = org.organization.id;
  // Straight to the column: the SDK's business update does not list this flag, and
  // widening the SDK for a fixture would be the wrong order (same call the suite's
  // timezone note makes about `timezone`).
  const setCouponSwitch = (on: boolean) =>
    withTenant(orgId, (tx) =>
      tx
        .update(businesses)
        .set({ allowCustomerCoupons: on })
        .where(eq(businesses.publicId, biz.id)),
    );
  await setCouponSwitch(true);
  // The SDK hands back PUBLIC ids; the service layer takes internal ones. Mixing them is
  // how this block first failed — a catalog insert against `biz_…` finds no business.
  const [bizRow] = await withTenant(orgId, (tx) =>
    tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
      .limit(1),
  );
  if (!bizRow) throw new Error("portal coupon fixture: business missing");
  const bizId = bizRow.id;
  const product = await createProduct({ organizationId: orgId, businessId: bizId, name: "Cpn" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  const [cusRow] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.publicId, cusA.id)).limit(1),
  );
  if (!cusRow) throw new Error("portal coupon fixture: customer A missing");
  const { subscription: cpnSub } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: cusRow.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  for (const code of ["PORTALCPN-A", "PORTALCPN-B", "PORTALCPN-C"])
    await createCoupon({
      organizationId: orgId,
      businessId: bizId,
      code,
      kind: "percentage",
      percentOffBps: 500,
      durationType: "forever",
    });

  await clearPublicRateLimits();
  const cpnMint = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
  const cpnTok = (await exchange(cpnMint.token)).token;
  const subPath = `/portal/v1/subscriptions/${cpnSub.publicId}/coupon`;
  const discountOf = async () => {
    const list = await http("/portal/v1/subscriptions", { token: cpnTok });
    const rows = (list.json.data ?? []) as Array<{ id: string; discount: unknown }>;
    return rows.find((r) => r.id === cpnSub.publicId)?.discount as
      | { coupon: string | null; source: string; removable: boolean }
      | null
      | undefined;
  };

  ok("0238: no discount → the list reports null", (await discountOf()) === null);
  const applyA = await http(subPath, {
    method: "POST",
    token: cpnTok,
    body: { code: "PORTALCPN-A" },
  });
  ok("0238: the buyer's code applies", applyA.status === 200);
  const applied = await discountOf();
  ok(
    "0238: …and the list names it, coupon-sourced and removable",
    applied?.coupon === "PORTALCPN-A" && applied.source === "coupon" && applied.removable === true,
  );

  // The ceiling. A second code must not stack — this is the whole reason the box is
  // hidden rather than shown-and-refused.
  const applyB = await http(subPath, {
    method: "POST",
    token: cpnTok,
    body: { code: "PORTALCPN-B" },
  });
  ok("0238: a SECOND code is refused while one is live", applyB.status === 400);

  const del = await http(subPath, { method: "DELETE", token: cpnTok });
  ok("0238: the buyer can take their coupon off", del.status === 200);
  ok("0238: …and the list goes back to null", (await discountOf()) === null);
  const delAgain = await http(subPath, { method: "DELETE", token: cpnTok });
  ok("0238: removing nothing is a 400, not a silent success", delAgain.status === 400);
  const applyBNow = await http(subPath, {
    method: "POST",
    token: cpnTok,
    body: { code: "PORTALCPN-B" },
  });
  ok("0238: …and the slot is free again for another code", applyBNow.status === 200);
  await http(subPath, { method: "DELETE", token: cpnTok });

  // An operator's manual discount is NOT the buyer's to lift.
  await applyManualDiscount({
    organizationId: orgId,
    businessId: bizId,
    subscriptionId: cpnSub.id,
    kind: "percentage",
    percentOffBps: 500,
    durationType: "forever",
    now: new Date(),
  });
  const manual = await discountOf();
  ok(
    "0238: a manual discount reports source=manual, removable=false",
    manual?.source === "manual" && manual.removable === false && manual.coupon === null,
  );
  const delManual = await http(subPath, { method: "DELETE", token: cpnTok });
  ok("0238: …and the buyer's remove is refused with 403", delManual.status === 403);

  // 0495: at the default cap of 1 any live discount blocks the box, operator ones included.
  // Above 1 the merchant allowed stacking, and only the customer's own codes count.
  const setCap = (n: number) =>
    withTenant(orgId, (tx) =>
      tx.update(businesses).set({ maxCustomerCouponCodes: n }).where(eq(businesses.id, bizId)),
    );
  const subRow = async () => {
    const list = await http("/portal/v1/subscriptions", { token: cpnTok });
    return (
      (list.json.data ?? []) as Array<{
        id: string;
        discounts?: Array<{ coupon: string | null }>;
        coupon_codes_left?: number;
      }>
    ).find((r) => r.id === cpnSub.publicId);
  };
  const apply = (code: string) => http(subPath, { method: "POST", token: cpnTok, body: { code } });
  ok(
    "0495: cap 1 + an operator discount → the buyer has no code left",
    (await subRow())?.coupon_codes_left === 0,
  );
  const besideManual = await apply("PORTALCPN-A");
  ok(
    "0495: cap 1: a code beside an operator discount is refused (no stacking)",
    besideManual.status === 400,
  );
  await setCap(2);
  ok(
    "0495: cap 2 + an operator discount → the buyer has 2 codes left",
    (await subRow())?.coupon_codes_left === 2,
  );
  const a2 = await apply("PORTALCPN-A");
  const b2 = await apply("PORTALCPN-B");
  const two = await subRow();
  ok(
    "0495: cap 2: two buyer codes stack beside the operator discount",
    a2.status === 200 &&
      b2.status === 200 &&
      two?.discounts?.length === 3 &&
      two.coupon_codes_left === 0,
  );
  const overCap = await apply("PORTALCPN-C");
  ok(
    "0495: cap 2: a third buyer code is refused with the cap message",
    overCap.status === 400 &&
      (overCap.json as { error?: { message?: string } })?.error?.message ===
        "You can enter 2 coupon codes. Remove one of the codes first.",
  );
  const delNamed = await http(`${subPath}?code=PORTALCPN-A`, { method: "DELETE", token: cpnTok });
  const afterNamed = await subRow();
  ok(
    "0495: ?code= removes that code only",
    delNamed.status === 200 &&
      !afterNamed?.discounts?.some((d) => d.coupon === "PORTALCPN-A") &&
      !!afterNamed?.discounts?.some((d) => d.coupon === "PORTALCPN-B") &&
      afterNamed?.coupon_codes_left === 1,
  );
  await setCap(1);
  await removeDiscount(orgId, cpnSub.id);

  // The switch governs the whole box, not half of it.
  await setCouponSwitch(false);
  const offApply = await http(subPath, {
    method: "POST",
    token: cpnTok,
    body: { code: "PORTALCPN-A" },
  });
  const offRemove = await http(subPath, { method: "DELETE", token: cpnTok });
  ok(
    "0238: with the switch off BOTH apply and remove answer 403",
    offApply.status === 403 && offRemove.status === 403,
  );
}

// Portal resume runs the operator's core: once the paid term has ended, a new term starts
// now and is billed once — the paused span is never back-billed.
{
  const { createProduct, createPrice } = await import("@/modules/catalog/service");
  const { createSubscription, pauseSubscriptionWithOptions } =
    await import("@/modules/subscriptions/service");
  const { runBillingClockTick } = await import("@/modules/subscriptions/renewal");
  const { runWithClockScope } = await import("@/platform/clock");
  const { subscriptions } = await import("@db/schema");
  const DAY = 86_400_000;
  const orgId = org.organization.id;
  const [bizRow] = await withTenant(orgId, (tx) =>
    tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
      .limit(1),
  );
  const [cusRow] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.publicId, cusA.id)).limit(1),
  );
  if (!bizRow || !cusRow) throw new Error("portal resume fixture: business/customer missing");
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({
        storefrontConfig: sql`coalesce(${businesses.storefrontConfig}, '{}'::jsonb) || '{"allow_pause_resume": true}'::jsonb`,
      })
      .where(eq(businesses.id, bizRow.id)),
  );
  const product = await createProduct({
    organizationId: orgId,
    businessId: bizRow.id,
    name: "Rsm",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: bizRow.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  const { subscription: rsm } = await createSubscription({
    organizationId: orgId,
    businessId: bizRow.id,
    customerId: cusRow.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await pauseSubscriptionWithOptions({
    organizationId: orgId,
    businessId: bizRow.id,
    subscriptionId: rsm.id,
    now: new Date(),
    pauseOption: "immediately",
  });
  // The paid term ended 15 days into the pause.
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({
        currentPeriodStart: new Date(Date.now() - 45 * DAY),
        currentPeriodEnd: new Date(Date.now() - 15 * DAY),
      })
      .where(eq(subscriptions.id, rsm.id)),
  );
  const invCount = async () =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.subscriptionId, rsm.id)),
      )
    ).length;
  const n0 = await invCount();

  await clearPublicRateLimits();
  const rsmTok = (
    await exchange((await tmb.paymentMethods.createPortalSession(biz.id, cusA.id)).token)
  ).token;
  type ActionsRow = {
    id: string;
    actions?: {
      cancel: { timing: string; reasons: Array<{ code: string; label: string }> } | null;
      pause: boolean;
      resume: boolean;
      reactivate: boolean;
    };
  };
  const actionsOf = async () =>
    ((await http("/portal/v1/subscriptions", { token: rsmTok })).json.data as ActionsRow[]).find(
      (r) => r.id === rsm.publicId,
    )?.actions;
  const pausedActions = await actionsOf();
  ok(
    "portal actions: a paused subscription offers resume only (cancel and reactivate off)",
    pausedActions?.resume === true &&
      pausedActions.pause === false &&
      pausedActions.cancel === null &&
      pausedActions.reactivate === false,
  );
  const res = await http(`/portal/v1/subscriptions/${rsm.publicId}/resume`, {
    method: "POST",
    token: rsmTok,
  });
  const activeActions = await actionsOf();
  ok(
    "portal actions: after resume it offers pause, not resume",
    activeActions?.pause === true && activeActions.resume === false,
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({
        storefrontConfig: sql`coalesce(${businesses.storefrontConfig}, '{}'::jsonb) || '{"allow_cancel_subscription": true, "allow_reactivate": true, "cancel_timing": "end_of_term"}'::jsonb`,
      })
      .where(eq(businesses.id, bizRow.id)),
  );
  const cancelable = await actionsOf();
  ok(
    "portal actions: cancel on → offered with the business timing and its reasons",
    cancelable?.cancel?.timing === "end_of_term" &&
      (cancelable.cancel.reasons.length ?? 0) > 0 &&
      cancelable.reactivate === false,
  );
  await withTenant(orgId, (tx) =>
    tx.update(subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(subscriptions.id, rsm.id)),
  );
  const cancelling = await actionsOf();
  ok(
    "portal actions: a scheduled cancel offers reactivate, not cancel or pause",
    cancelling?.reactivate === true && cancelling.cancel === null && cancelling.pause === false,
  );
  await withTenant(orgId, (tx) =>
    tx.update(subscriptions).set({ cancelAtPeriodEnd: false }).where(eq(subscriptions.id, rsm.id)),
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({
        storefrontConfig: sql`coalesce(${businesses.storefrontConfig}, '{}'::jsonb) || '{"allow_cancel_subscription": false, "allow_reactivate": false, "allow_pause_resume": false}'::jsonb`,
      })
      .where(eq(businesses.id, bizRow.id)),
  );
  const off = await actionsOf();
  ok(
    "portal actions: every switch off → nothing offered",
    off?.cancel === null && !off.pause && !off.resume && !off.reactivate,
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({
        storefrontConfig: sql`coalesce(${businesses.storefrontConfig}, '{}'::jsonb) || '{"allow_pause_resume": true}'::jsonb`,
      })
      .where(eq(businesses.id, bizRow.id)),
  );
  const [after] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, rsm.id)).limit(1),
  );
  const start = after?.currentPeriodStart?.getTime() ?? 0;
  ok(
    "portal resume out-of-term → active on a new term from now",
    res.status === 200 &&
      after?.status === "active" &&
      start > Date.now() - DAY &&
      (after?.currentPeriodEnd?.getTime() ?? 0) > Date.now(),
  );
  ok(
    "portal resume out-of-term → the new term is invoiced once",
    (await invCount()) === n0 + 1 && typeof res.json.latest_invoice === "string",
  );
  await runWithClockScope({ onlyBusinessId: bizRow.id }, () => runBillingClockTick(new Date()));
  ok(
    "portal resume → the next tick does not back-bill the paused span",
    (await invCount()) === n0 + 1,
  );
}

// ── Mint redirect_url / forward_url, and the operator's retrieve ────────────────
{
  await clearPublicRateLimits();
  const sessionsPath = `/v1/businesses/${biz.id}/customers/${cusA.id}/portal_sessions`;
  // Absent both: the exchange and the logout answer exactly as before.
  const plainMint = await tmb.paymentMethods.createPortalSession(biz.id, cusA.id);
  const plainEx = await fetch(`${base}/portal/v1/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${plainMint.token}` },
  });
  const plainExBody = (await plainEx.json()) as Record<string, unknown> & { token: string };
  ok("plain mint: the exchange carries no forward_url", !("forward_url" in plainExBody));
  const plainOut = await http("/portal/v1/logout", { method: "POST", token: plainExBody.token });
  ok(
    "plain mint: logout carries no redirect_url",
    plainOut.status === 200 && !("redirect_url" in plainOut.json),
  );

  const mintR = await http(sessionsPath, {
    method: "POST",
    token: org.secret,
    body: { redirect_url: "https://example.com/account", forward_url: "/portal?tab=methods" },
  });
  ok(
    "mint with redirect_url + forward_url → 201 echoing both",
    mintR.status === 201 &&
      mintR.json.redirect_url === "https://example.com/account" &&
      mintR.json.forward_url === "/portal?tab=methods",
  );
  const exR = await fetch(`${base}/portal/v1/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${String(mintR.json.token)}` },
  });
  const exRBody = (await exR.json()) as { token: string; forward_url?: string };
  ok(
    "the exchange returns the forward_url",
    exR.status === 201 && exRBody.forward_url === "/portal?tab=methods",
  );
  const outR = await http("/portal/v1/logout", { method: "POST", token: exRBody.token });
  ok("logout returns the redirect_url", outR.json.redirect_url === "https://example.com/account");

  ok(
    "mint: an off-portal forward_url → 400",
    (
      await http(sessionsPath, {
        method: "POST",
        token: org.secret,
        body: { forward_url: "https://evil.example.com" },
      })
    ).status === 400,
  );
  ok(
    "mint: a non-http redirect_url → 400",
    (
      await http(sessionsPath, {
        method: "POST",
        token: org.secret,
        body: { redirect_url: "javascript:alert(1)" },
      })
    ).status === 400,
  );

  const got = await http(`${sessionsPath}/${String(mintR.json.id)}`, { token: org.secret });
  ok(
    "GET portal_sessions/:id → lifecycle + destinations, no credential",
    got.status === 200 &&
      got.json.status === "logged_out" &&
      typeof got.json.login_at === "string" &&
      typeof got.json.logout_at === "string" &&
      got.json.redirect_url === "https://example.com/account" &&
      got.json.link_kind === "api" &&
      !("token" in got.json) &&
      !("token_hash" in got.json),
  );
  ok(
    "GET portal_sessions/:id through another customer's path → 404",
    (
      await http(
        `/v1/businesses/${biz.id}/customers/${cusB.id}/portal_sessions/${String(mintR.json.id)}`,
        {
          token: org.secret,
        },
      )
    ).status === 404,
  );
}

// ── Buyer cancel: end_of_term confirms the policy, reasons are the business's ───
{
  const { createProduct, createPrice } = await import("@/modules/catalog/service");
  const { createSubscription } = await import("@/modules/subscriptions/service");
  const { subscriptions } = await import("@db/schema");
  const orgId = org.organization.id;
  const [bizRow] = await withTenant(orgId, (tx) =>
    tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
      .limit(1),
  );
  const [cusRow] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.publicId, cusA.id)).limit(1),
  );
  if (!bizRow || !cusRow) throw new Error("portal cancel fixture: business/customer missing");
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({
        storefrontConfig: sql`coalesce(${businesses.storefrontConfig}, '{}'::jsonb) || '{"allow_cancel_subscription": true, "cancel_timing": "end_of_term"}'::jsonb`,
      })
      .where(eq(businesses.id, bizRow.id)),
  );
  const product = await createProduct({
    organizationId: orgId,
    businessId: bizRow.id,
    name: "Cxl",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: bizRow.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const mk = async () =>
    (
      await createSubscription({
        organizationId: orgId,
        businessId: bizRow.id,
        customerId: cusRow.id,
        now: new Date(),
        items: [{ price, quantity: 1 }],
      })
    ).subscription;
  await clearPublicRateLimits();
  const tok = (
    await exchange((await tmb.paymentMethods.createPortalSession(biz.id, cusA.id)).token)
  ).token;
  const cancel = (subId: string, body?: unknown) =>
    http(`/portal/v1/subscriptions/${subId}/cancel`, { method: "POST", token: tok, body });

  const s1 = await mk();
  const immediate = await cancel(s1.publicId, { end_of_term: false });
  const [s1After] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, s1.id)).limit(1),
  );
  ok(
    "cancel end_of_term:false on an end_of_term business → 400, subscription untouched",
    immediate.status === 400 && s1After?.status === "active" && !s1After.cancelAtPeriodEnd,
  );
  const badCode = await cancel(s1.publicId, { reason_code: "not_a_code" });
  ok("cancel with an unoffered reason_code → 400", badCode.status === 400);

  const plain = await cancel(s1.publicId);
  ok(
    "cancel with no body → the policy's end_of_term, as before",
    plain.status === 200 &&
      plain.json.effective === "end_of_term" &&
      plain.json.cancel_at_period_end === true,
  );

  const s2 = await mk();
  const withReason = await cancel(s2.publicId, { end_of_term: true, reason_code: "pricing_high" });
  const [s2After] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, s2.id)).limit(1),
  );
  ok(
    "cancel end_of_term:true + an offered reason_code → the code is on the subscription",
    withReason.status === 200 &&
      s2After?.cancelAtPeriodEnd === true &&
      s2After?.cancelReasonCode === "pricing_high",
  );
}

// ── Shipping address book (0360) ─────────────────────────────────────────────
{
  const { createProduct, createPrice } = await import("@/modules/catalog/service");
  const { createSubscription } = await import("@/modules/subscriptions/service");
  const { billSubscriptionPeriod } = await import("@/modules/invoicing/service");
  const { subscriptions } = await import("@db/schema");
  const orgId = org.organization.id;
  const [bizRow] = await withTenant(orgId, (tx) =>
    tx.select().from(businesses).where(eq(businesses.publicId, biz.id)).limit(1),
  );
  const cusS = await tmb.customers.create(biz.id, {
    email: "portal-ship@example.com",
    first_name: "Ship",
    last_name: "Buyer",
  });
  const [cusRow] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.publicId, cusS.id)).limit(1),
  );
  if (!bizRow || !cusRow) throw new Error("portal shipping fixture: business/customer missing");
  await clearPublicRateLimits();
  const tok = (
    await exchange((await tmb.paymentMethods.createPortalSession(biz.id, cusS.id)).token)
  ).token;
  const path = "/portal/v1/shipping_addresses";
  const HOME = {
    label: "Home",
    first_name: "Ship",
    line1: "1 Home St",
    city: "San Francisco",
    state_code: "CA",
    postal_code: "94105",
    country: "US",
  };
  const OFFICE = { ...HOME, label: "Office", line1: "2 Office Ave" };

  // Gate: the business hides shipping at checkout and this customer has no book yet.
  const gated = await http(path, { method: "POST", token: tok, body: HOME });
  ok(
    "shipping: add refused (403) while the business does not collect a ship-to",
    gated.status === 403,
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({
        checkoutFieldConfig: sql`coalesce(${businesses.checkoutFieldConfig}, '{}'::jsonb) || '{"shipping.address": "show"}'::jsonb`,
      })
      .where(eq(businesses.id, bizRow.id)),
  );
  const meS = await http("/portal/v1/me", { token: tok });
  ok(
    "shipping: me.business.collects_shipping_address is true once checkout collects it",
    (meS.json.business as { collects_shipping_address?: boolean })?.collects_shipping_address ===
      true,
  );

  const noCity = await http(path, {
    method: "POST",
    token: tok,
    body: { ...HOME, city: undefined },
  });
  ok("shipping: add without a city → 400", noCity.status === 400);
  const home = await http(path, { method: "POST", token: tok, body: HOME });
  ok(
    "shipping: add → 201, the first address is the default",
    home.status === 201 && home.json.is_default === true && home.json.line1 === HOME.line1,
  );
  const office = await http(path, { method: "POST", token: tok, body: OFFICE });
  ok(
    "shipping: a second add is not the default",
    office.status === 201 && office.json.is_default === false,
  );
  const homeId = String(home.json.id);
  const officeId = String(office.json.id);

  const listed = await http(path, { token: tok });
  const rows = (listed.json.data ?? []) as Array<{ id: string; is_default: boolean }>;
  ok(
    "shipping: list → both, home marked default",
    listed.status === 200 &&
      rows.length === 2 &&
      rows.find((r) => r.id === homeId)?.is_default === true,
  );

  const edited = await http(`${path}/${officeId}`, {
    method: "PATCH",
    token: tok,
    body: { line1: "3 Office Ave" },
  });
  ok(
    "shipping: edit → 200 with the new line1",
    edited.status === 200 && edited.json.line1 === "3 Office Ave",
  );
  const blanked = await http(`${path}/${officeId}`, {
    method: "PATCH",
    token: tok,
    body: { city: null },
  });
  ok("shipping: an edit that clears the city → 400", blanked.status === 400);

  const madeDefault = await http(`${path}/${officeId}`, {
    method: "PATCH",
    token: tok,
    body: { is_default: true },
  });
  const afterDefault = ((await http(path, { token: tok })).json.data ?? []) as Array<{
    id: string;
    is_default: boolean;
  }>;
  ok(
    "shipping: make default moves the flag (one default)",
    madeDefault.status === 200 &&
      afterDefault
        .filter((r) => r.is_default)
        .map((r) => r.id)
        .join() === officeId,
  );

  // Another customer's address: never reachable through this session.
  const foreign = await http(`/v1/businesses/${biz.id}/customers/${cusB.id}/shipping_addresses`, {
    method: "POST",
    token: org.secret,
    body: { ...HOME, label: "B" },
  });
  const foreignId = String(foreign.json.id);
  ok("shipping fixture: customer B has an address", foreign.status === 201);
  ok(
    "shipping: editing another customer's address → 404",
    (await http(`${path}/${foreignId}`, { method: "PATCH", token: tok, body: { line1: "x" } }))
      .status === 404,
  );
  ok(
    "shipping: archiving another customer's address → 404",
    (await http(`${path}/${foreignId}/archive`, { method: "POST", token: tok })).status === 404,
  );

  // A subscription, and its ship-to.
  const product = await createProduct({
    organizationId: orgId,
    businessId: bizRow.id,
    name: "Box",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: bizRow.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1500,
    interval: "month",
  });
  const sub = (
    await createSubscription({
      organizationId: orgId,
      businessId: bizRow.id,
      customerId: cusRow.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    })
  ).subscription;
  const shipPath = `/portal/v1/subscriptions/${sub.publicId}/shipping_address`;
  ok(
    "shipping: assigning another customer's address → 400",
    (await http(shipPath, { method: "POST", token: tok, body: { address_id: foreignId } }))
      .status === 400,
  );
  const portalSub = async () =>
    ((await http("/portal/v1/subscriptions", { token: tok })).json.data ?? []).find(
      (x) => (x as { id: string }).id === sub.publicId,
    ) as { shipping_address_id: string | null; shipping_address: { id: string } | null };
  const before = await portalSub();
  ok(
    "shipping: a new subscription ships to the default (id null, address = default)",
    before?.shipping_address_id === null && before?.shipping_address?.id === officeId,
  );
  const assigned = await http(shipPath, {
    method: "POST",
    token: tok,
    body: { address_id: homeId },
  });
  const after = await portalSub();
  ok(
    "shipping: assign → 200, the subscription ships to that address",
    assigned.status === 200 &&
      assigned.json.shipping_address_id === homeId &&
      after?.shipping_address_id === homeId &&
      after?.shipping_address?.id === homeId,
  );
  const otherSession = (
    await exchange((await tmb.paymentMethods.createPortalSession(biz.id, cusA.id)).token)
  ).token;
  ok(
    "shipping: another customer's session cannot set this subscription's ship-to (404)",
    (
      await http(shipPath, {
        method: "POST",
        token: otherSession,
        body: { address_id: null },
      })
    ).status === 404,
  );

  const blocked = await http(`${path}/${homeId}/archive`, { method: "POST", token: tok });
  ok(
    "shipping: archive refused (409) while a live subscription ships to it, naming it",
    blocked.status === 409 &&
      String((blocked.json.error as { message?: string })?.message).includes(sub.publicId),
  );

  // The next invoice snapshots the assigned ship-to, not the default.
  const [subRow] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1),
  );
  const nextStart = subRow!.currentPeriodEnd!;
  const nextEnd = new Date(nextStart);
  nextEnd.setUTCMonth(nextEnd.getUTCMonth() + 1);
  const { invoice: nextInv } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: bizRow.id,
    subscription: subRow!,
    periodStart: nextStart,
    periodEnd: nextEnd,
  });
  ok(
    "shipping: the next invoice snapshots the assigned address",
    (nextInv.shippingAddress as { line1?: string } | null)?.line1 === HOME.line1,
  );

  const backToDefault = await http(shipPath, {
    method: "POST",
    token: tok,
    body: { address_id: null },
  });
  const defaultBlocked = await http(`${path}/${officeId}/archive`, { method: "POST", token: tok });
  ok(
    "shipping: archiving the default refused (409) while a live subscription ships to the default",
    defaultBlocked.status === 409,
  );
  const archived = await http(`${path}/${homeId}/archive`, { method: "POST", token: tok });
  const live = ((await http(path, { token: tok })).json.data ?? []) as Array<{ id: string }>;
  ok(
    "shipping: after moving the subscription back to the default, archive → 200 and the list hides it",
    backToDefault.status === 200 &&
      backToDefault.json.shipping_address_id === null &&
      archived.status === 200 &&
      archived.json.archived === true &&
      !live.some((r) => r.id === homeId),
  );
  ok(
    "shipping: an archived address cannot be assigned → 400",
    (await http(shipPath, { method: "POST", token: tok, body: { address_id: homeId } })).status ===
      400,
  );
}

// ── A scheduled change or pause the renewal estimate cannot price: date, no amount ──
{
  const { createProduct, createPrice } = await import("@/modules/catalog/service");
  const { createSubscription } = await import("@/modules/subscriptions/service");
  const { scheduleChange } = await import("@/modules/subscriptions/scheduled-changes");
  const orgId = org.organization.id;
  const [bizRow] = await withTenant(orgId, (tx) =>
    tx.select().from(businesses).where(eq(businesses.publicId, biz.id)).limit(1),
  );
  const cusU = await tmb.customers.create(biz.id, { email: "portal-unpriced@example.com" });
  const [cusRow] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.publicId, cusU.id)).limit(1),
  );
  if (!bizRow || !cusRow) throw new Error("unpriced fixture: business/customer missing");
  const ctx = { organizationId: orgId, businessId: bizRow.id };
  const product = await createProduct({ ...ctx, name: "Unpriced plan", kind: "plan" });
  const mk = (amountMinor: number, interval: "month" | "year") =>
    createPrice({
      ...ctx,
      productId: product.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval,
    });
  const monthly = await mk(3000, "month");
  const yearly = await mk(30000, "year");
  const mkSub = async () =>
    createSubscription({
      ...ctx,
      customerId: cusRow.id,
      now: new Date(),
      items: [{ price: monthly, quantity: 1 }],
    });
  // A pause at the term end: no payment then.
  const paused = await mkSub();
  const pauseAt = paused.subscription.currentPeriodEnd!;
  await scheduleChange({
    ...ctx,
    subscriptionId: paused.subscription.id,
    type: "pause",
    effectiveAt: pauseAt,
  });
  // A change to a yearly price starts a new term: the estimate cannot price it.
  const yearlySwitch = await mkSub();
  await scheduleChange({
    ...ctx,
    subscriptionId: yearlySwitch.subscription.id,
    type: "change",
    effectiveAt: yearlySwitch.subscription.currentPeriodEnd!,
    changes: [{ itemId: yearlySwitch.items[0]!.publicId, newPriceId: yearly.publicId }],
  });
  await clearPublicRateLimits();
  const tok = (
    await exchange((await tmb.paymentMethods.createPortalSession(biz.id, cusU.id)).token)
  ).token;
  type Row = {
    id: string;
    next_payment: unknown;
    next_payment_unpriced: { type: string; at: string } | null;
  };
  const rows = ((await http("/portal/v1/subscriptions", { token: tok })).json.data ?? []) as Row[];
  const p = rows.find((r) => r.id === paused.subscription.publicId);
  const c = rows.find((r) => r.id === yearlySwitch.subscription.publicId);
  ok(
    "unpriced: a scheduled pause → next_payment_unpriced pause at the pause date, no amount",
    p?.next_payment === null &&
      p.next_payment_unpriced?.type === "pause" &&
      Date.parse(p.next_payment_unpriced.at) === pauseAt.getTime(),
  );
  ok(
    "unpriced: a plan change it cannot price → the period-end date, no amount",
    c?.next_payment === null &&
      c.next_payment_unpriced?.type === "change" &&
      Date.parse(c.next_payment_unpriced.at) ===
        yearlySwitch.subscription.currentPeriodEnd!.getTime(),
  );
}

// Garbage token never resolves.
const garbage = await http("/portal/v1/me", { token: "pstk_not_a_real_token" });
ok("garbage token → 401", garbage.status === 401);

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
