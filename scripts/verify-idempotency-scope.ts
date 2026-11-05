/**
 * Proves an Idempotency-Key on a BUYER surface is scoped to the buyer SESSION that
 * used it — that two different buyers can never share one cache entry.
 *
 * THE BUG THIS PINS (2026-08-28, 🔴 security). `platform/idempotency.ts` recorded a
 * key as `(organization_id, key)` and fingerprinted `sha256(method:url:body)`.
 * Neither carried `req.checkoutSession` / `req.portalSession`. Every buyer on a
 * hosted checkout or a portal link authenticates with a session token, not an API
 * key, but they all resolve to the SAME organization — so the cache entry was shared
 * across the whole tenant's buyers.
 *
 * Measured before the fix, with this very script:
 *   checkout session B posted session A's Idempotency-Key with a byte-identical body
 *   and got HTTP 200 + `Idempotent-Replayed: true` carrying **A's customer id**,
 *   while B's own `checkout_sessions.resulting_customer_id` stayed NULL. B's handler
 *   never ran; B was handed another buyer's identity. The storefront then vaulted
 *   B's card and completed B's checkout against it.
 *
 * The keys collide in practice rather than only in theory: the buyer surfaces mint
 * their own keys client-side, and a page that derives one from the step it is on
 * ("checkout-customer", a retry counter, a tab-scoped sequence) produces the same
 * string for every buyer on it.
 *
 * WHAT IT ASSERTS (four sections, each "must differ" paired with a "must still be
 * cached" positive control — a scope fix that merely broke idempotency would pass a
 * one-sided suite):
 *
 *  C) CHECKOUT — two checkout sessions, one org, the SAME key, an identical body:
 *     different customers, no replay for the second, and each session's own
 *     `resulting_customer_id` recording its OWN customer.
 *  P) POSITIVE CONTROL — the same session replaying its OWN key still gets the
 *     cached response verbatim and does NOT re-execute; a different body on that key
 *     still 409s as a fingerprint mismatch. This is the half that proves the fix
 *     scoped idempotency rather than disabled it.
 *  R) PORTAL — the same property on `/portal/v1/*`, where the sessions belong to two
 *     different CUSTOMERS: the write must land on the caller's own customer row.
 *  O) OPERATOR — an API-key caller is untouched: same key + same body still replays,
 *     one side effect, and the stored `idempotency_keys.key` is still the RAW header
 *     value (no scope prefix), so operator records keep exactly the shape
 *     `verify:idempotency-race` seeds and asserts.
 *
 *   pnpm verify:idempotency-scope
 *
 * Runs entirely IN-PROCESS (`app.inject`) — it never touches a running dev server.
 */
import { eq, and, or, like, count } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createCheckoutSession } from "@/modules/checkout/service";
import { createCustomer } from "@/modules/customers/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { checkoutSessions, customers, idempotencyKeys } from "@db/schema";

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
}

type Res = { statusCode: number; headers: Record<string, unknown>; payload: string };
const body = (r: Res): Record<string, any> => {
  try {
    return JSON.parse(r.payload);
  } catch {
    return {};
  }
};
/** True when the response came out of the idempotency cache rather than the handler. */
const replayed = (r: Res) => r.headers["idempotent-replayed"] === "true";
/**
 * Key-order-insensitive serialization, for comparing a replayed body against the
 * original. A stored response makes a round trip through a `jsonb` column, which does
 * not preserve object key order — so a plain `JSON.stringify` comparison reports two
 * value-identical bodies as different, and a positive control that can never be green
 * is worse than no control at all.
 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
const sameValue = (a: unknown, b: unknown) => canonical(a) === canonical(b);

const app = await buildApp({ logger: false });
await clearPublicRateLimits();

// ── Fixture ──────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Idem Scope Co" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Scope Reports",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "Asia/Kolkata",
});
await createGatewayAccount({
  organizationId: orgId,
  businessId: biz.id,
  gatewayKey: "tmtest",
  label: "TM Test",
  credentials: {},
});
const product = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Scope Plan",
});
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
});

/**
 * Counts the idempotency records that this raw header value produced, however the
 * middleware chose to store it: the unscoped key itself, or any scoped variant that
 * ends in it. Deliberately shape-agnostic — the property under test is "one record
 * per session", not the spelling of the composite.
 */
async function recordsForRawKey(rawKey: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.organizationId, orgId),
          or(eq(idempotencyKeys.key, rawKey), like(idempotencyKeys.key, `%${rawKey}`)),
        ),
      ),
  );
}

async function customersWithEmail(email: string) {
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .select({ n: count() })
      .from(customers)
      .where(and(eq(customers.businessId, biz.id), eq(customers.email, email))),
  );
  return Number(row?.n ?? 0);
}

async function sessionRow(publicId: string) {
  const [row] = await withTenant(orgId, (tx) =>
    tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, publicId)).limit(1),
  );
  return row;
}

// ── C) CHECKOUT: two sessions, one key, identical body ────────────────────────
//
// Both sessions are minted by the operator against the same price in the same
// business, exactly as a storefront would serve two visitors — the ONLY difference
// between the two requests below is which checkout token they carry.
const csA = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: price.publicId,
  quantity: 1,
});
const csB = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: price.publicId,
  quantity: 1,
});

const SHARED_KEY = "checkout-customer-step";
const CHECKOUT_EMAIL = "scope-checkout@buyer.test";
// One object, posted twice — so the two requests are byte-identical, which is the
// case the old fingerprint could not tell apart. (`setCheckoutCustomer` never reuses a
// customer by email on a public link, so the same email MUST still yield two rows.)
const checkoutBody = { email: CHECKOUT_EMAIL };

const postCheckout = (token: string, key: string, payload: unknown) =>
  app.inject({
    method: "POST",
    url: "/checkout/v1/customer",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    payload: JSON.stringify(payload),
  }) as unknown as Promise<Res>;

const a1 = await postCheckout(csA.token, SHARED_KEY, checkoutBody);
const idA = body(a1).id as string | undefined;
check(
  "C1 — session A's first write succeeds and names a customer (the baseline)",
  a1.statusCode === 200 && typeof idA === "string" && idA.startsWith("cus_"),
  `${a1.statusCode} id=${idA}`,
);

const b1 = await postCheckout(csB.token, SHARED_KEY, checkoutBody);
const idB = body(b1).id as string | undefined;
check(
  "C2 — session B posting A's key with an IDENTICAL body is NOT served from A's cache entry",
  b1.statusCode === 200 && !replayed(b1),
  `${b1.statusCode} replayed=${replayed(b1)}`,
);
check(
  "C3 — …and B is given its OWN customer, never A's",
  typeof idB === "string" && idB.startsWith("cus_") && idB !== idA,
  `A=${idA} B=${idB}`,
);

const rowA = await sessionRow(csA.publicId);
const rowB = await sessionRow(csB.publicId);
const custA = await withTenant(orgId, (tx) =>
  tx
    .select({ id: customers.id, publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.publicId, idA ?? "")),
);
const custB = await withTenant(orgId, (tx) =>
  tx
    .select({ id: customers.id, publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.publicId, idB ?? "")),
);
// The sharpest signal of the original bug: a replayed response left B's session row
// untouched, so the very next step of B's checkout had no customer to work with.
check(
  "C4 — …and B's session records B's customer (its handler really ran)",
  rowB?.resultingCustomerId != null && rowB?.resultingCustomerId === custB[0]?.id,
  `resulting_customer_id=${rowB?.resultingCustomerId ?? "NULL"}`,
);
check(
  "C5 — …and A's session still records A's customer (B did not repoint it)",
  rowA?.resultingCustomerId != null && rowA?.resultingCustomerId === custA[0]?.id,
  `resulting_customer_id=${rowA?.resultingCustomerId ?? "NULL"}`,
);

const sharedRecords = await recordsForRawKey(SHARED_KEY);
check(
  "C6 — the one raw key produced TWO idempotency records, one per session",
  sharedRecords.length === 2 && new Set(sharedRecords.map((r) => r.key)).size === 2,
  `${sharedRecords.length} record(s): ${sharedRecords.map((r) => r.key).join(" , ")}`,
);

// ── P) POSITIVE CONTROLS: idempotency is SCOPED, not switched off ─────────────
const a2 = await postCheckout(csA.token, SHARED_KEY, checkoutBody);
check(
  "P1 — session A replaying its OWN key is still served from cache",
  a2.statusCode === 200 && replayed(a2),
  `${a2.statusCode} replayed=${replayed(a2)}`,
);
check(
  "P2 — …and the replayed body is value-identical to A's original response",
  sameValue(body(a2), body(a1)),
  `equal=${sameValue(body(a2), body(a1))}`,
);
const emailCount = await customersWithEmail(CHECKOUT_EMAIL);
check(
  "P3 — …and the replay created NO third customer (the handler did not re-run)",
  emailCount === 2,
  `${emailCount} customer(s) with that email (MUST be 2: one per session)`,
);

const a3 = await postCheckout(csA.token, SHARED_KEY, { email: "someone-else@buyer.test" });
check(
  "P4 — session A reusing its key with a DIFFERENT body still 409s as a fingerprint mismatch",
  a3.statusCode === 409 && /different request payload/i.test(String(body(a3).error?.message)),
  `${a3.statusCode} ${body(a3).error?.message ?? ""}`,
);

// ── R) PORTAL: two sessions, two CUSTOMERS, one key, identical body ───────────
const pcA = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "scope-portal-a@buyer.test",
});
const pcB = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "scope-portal-b@buyer.test",
});

/** Mint a portal link and spend its single-use entry credential for a live bearer token. */
async function portalToken(customerId: string): Promise<string> {
  const link = await createPortalSession({ organizationId: orgId, businessId: biz.id, customerId });
  const ex = (await app.inject({
    method: "POST",
    url: "/portal/v1/session",
    headers: { authorization: `Bearer ${link.accessToken}` },
  })) as unknown as Res;
  return String(body(ex).token ?? "");
}
const tokA = await portalToken(pcA.id);
const tokB = await portalToken(pcB.id);

const PORTAL_KEY = "portal-me-save";
// Identical for both buyers. `first_name` is present because the route refuses a patch
// that would leave the customer with no billable name.
const portalBody = {
  address: {
    line1: "9 Scope Lane",
    city: "Austin",
    state: "Texas",
    state_code: "TX",
    postal_code: "78701",
    country: "US",
    first_name: "Pat",
    last_name: "Probe",
    phone: "+15125550100",
  },
};
const patchMe = (token: string, key: string, payload: unknown) =>
  app.inject({
    method: "PATCH",
    url: "/portal/v1/me",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    payload: JSON.stringify(payload),
  }) as unknown as Promise<Res>;

const pa1 = await patchMe(tokA, PORTAL_KEY, portalBody);
check(
  "R1 — portal session A's first write succeeds and answers with A's customer (baseline)",
  pa1.statusCode === 200 && body(pa1).customer?.id === pcA.publicId,
  `${pa1.statusCode} id=${body(pa1).customer?.id}`,
);

const pb1 = await patchMe(tokB, PORTAL_KEY, portalBody);
check(
  "R2 — portal session B posting A's key with an IDENTICAL body is not served from A's entry",
  pb1.statusCode === 200 && !replayed(pb1) && body(pb1).customer?.id === pcB.publicId,
  `${pb1.statusCode} replayed=${replayed(pb1)} id=${body(pb1).customer?.id} (MUST be ${pcB.publicId})`,
);

const [pbRow] = await withTenant(orgId, (tx) =>
  tx
    .select({ line1: customers.addressLine1 })
    .from(customers)
    .where(eq(customers.id, pcB.id))
    .limit(1),
);
check(
  "R3 — …and B's own customer row actually received the address",
  pbRow?.line1 === "9 Scope Lane",
  `address_line1=${pbRow?.line1 ?? "NULL"}`,
);

const pa2 = await patchMe(tokA, PORTAL_KEY, portalBody);
check(
  "R4 — portal session A replaying its OWN key is still served from cache (positive control)",
  pa2.statusCode === 200 && replayed(pa2) && sameValue(body(pa2), body(pa1)),
  `${pa2.statusCode} replayed=${replayed(pa2)} equal=${sameValue(body(pa2), body(pa1))}`,
);

const portalRecords = await recordsForRawKey(PORTAL_KEY);
check(
  "R5 — the one raw portal key produced TWO records, one per portal session",
  portalRecords.length === 2 && new Set(portalRecords.map((r) => r.key)).size === 2,
  `${portalRecords.length} record(s): ${portalRecords.map((r) => r.key).join(" , ")}`,
);

// ── O) OPERATOR: the API-key surface must be BYTE-for-byte unchanged ──────────
const { secret } = await createApiKey(orgId, "test");
const OP_KEY = "operator-create-customer";
const OP_EMAIL = "scope-operator@buyer.test";
const opBody = { email: OP_EMAIL };
const postOperator = (key: string, payload: unknown) =>
  app.inject({
    method: "POST",
    url: `/v1/businesses/${biz.publicId}/customers`,
    headers: {
      authorization: `Bearer ${secret}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    payload: JSON.stringify(payload),
  }) as unknown as Promise<Res>;

const o1 = await postOperator(OP_KEY, opBody);
check(
  "O1 — an API-key create with a fresh key still succeeds (201)",
  o1.statusCode === 201 && String(body(o1).id).startsWith("cus_"),
  `${o1.statusCode} id=${body(o1).id}`,
);

const o2 = await postOperator(OP_KEY, opBody);
check(
  "O2 — the same API key + same Idempotency-Key + same body still REPLAYS (unchanged)",
  o2.statusCode === 201 && replayed(o2) && body(o2).id === body(o1).id,
  `${o2.statusCode} replayed=${replayed(o2)} same_id=${body(o2).id === body(o1).id}`,
);

const opCount = await customersWithEmail(OP_EMAIL);
check(
  "O3 — …so the operator pair produced exactly ONE customer",
  opCount === 1,
  `${opCount} customer(s) (MUST be 1)`,
);

// Operator records keep the RAW header value as their key. `verify:idempotency-race`
// seeds rows by raw key and reads them back, so a scope prefix leaking onto this
// surface would silently invalidate that whole suite rather than fail here.
const opRecords = await recordsForRawKey(OP_KEY);
check(
  "O4 — the operator record stores the RAW key, with no scope prefix",
  opRecords.length === 1 && opRecords[0]?.key === OP_KEY,
  `${opRecords.length} record(s): ${opRecords.map((r) => r.key).join(" , ")}`,
);

// ── Verdict ──────────────────────────────────────────────────────────────────
await app.close();
await closeDb();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length} assertions, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\n❌ IDEMPOTENCY SCOPE: FAIL");
  for (const f of failed) console.log(`   - ${f.name}`);
  process.exit(1);
}
console.log(
  "\n✅ IDEMPOTENCY SCOPE: PASS (one buyer session, one cache entry; operator surface untouched)",
);
