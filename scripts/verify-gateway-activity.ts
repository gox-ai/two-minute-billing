/**
 * Gateway Activity verify suite (LOG-1 stage 2).
 *
 * Exercises the outbound gateway-request-log pipeline: tmtest synthetic rows
 * (charge + refund) get businessId/gatewayAccountId stamped via
 * resolveAdapter's withGatewayLogging Proxy + ALS (log-context.ts), source is
 * stamped from the ambient event context (event-context.ts), redaction masks
 * secrets, org-guard isolates cross-tenant reads, and the serializer shape is
 * stable.
 *
 * pnpm verify:gateway-activity
 */
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount, getGatewayAccount } from "@/modules/gateway/service";
import { resolveAdapter } from "@/providers/registry";
import { createCustomer } from "@/modules/customers/service";
import { redactHeaders, redactBody, flushGatewayRequestLogs } from "@/providers/http";
import {
  listGatewayRequestLogs,
  getGatewayRequestLog,
  serializeGatewayRequestLog,
} from "@/modules/gateway/activity";
import { runWithEventContext } from "@/platform/event-context";
import { closeDb } from "@/platform/db";
import type { ProviderCustomerRef } from "@/providers/types";

const checks: [string, boolean][] = [];
function ok(name: string, cond: boolean) {
  checks.push([name, cond]);
}

async function main() {
  const org = await createOrganization({ name: "Gateway Activity Co" });
  const orgId = org.organization.id;

  const biz = await createBusiness({
    organizationId: orgId,
    name: "GA Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
  const acctRow = (await getGatewayAccount(orgId, biz.id, acct.publicId))!;
  const tm = resolveAdapter(acctRow);

  const cust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "ga@gw.test",
  });

  // ── Drive a tmtest charge + refund inside a runWithEventContext({source:'system'}) span ──
  const { chargeRes, refundRes } = await runWithEventContext(
    { source: "system", actor: "verify-gateway-activity" },
    async () => {
      const ref: ProviderCustomerRef = await tm.ensureCustomer({ customerRef: cust.publicId });
      const pmRef = await tm.vaultPaymentMethod({
        customer: ref,
        token: "tok_tmtest_4242424242424242",
      });
      const chargeRes = await tm.charge({
        amountMinor: 5000n,
        currency: "USD",
        customer: ref,
        paymentMethod: pmRef,
        idempotencyKey: `idem_ga_${Date.now()}`,
      });
      const refundRes = await tm.refund({
        providerChargeId: chargeRes.providerChargeId,
        amountMinor: 5000n,
        idempotencyKey: `idem_ga_refund_${Date.now()}`,
      });
      return { chargeRes, refundRes };
    },
  );
  ok("setup: tmtest charge succeeded", chargeRes.status === "succeeded");
  ok("setup: tmtest refund succeeded", refundRes.status === "succeeded");

  // The log insert is fire-and-forget by design (an observability row must never delay
  // a charge), so reading the table immediately after the refund raced it: the refund's
  // row had not landed yet and `ops.has('refund')` failed — but only under load, which
  // is why this suite passed standalone and flaked inside `verify:gate`.
  await flushGatewayRequestLogs();

  // ── (1) rows recorded for the business, gateway_key=tmtest, ops cover charge+refund ──
  const logs = await listGatewayRequestLogs(orgId, biz.id, { limit: 200 });
  ok("logs: rows recorded for business", logs.length > 0);
  ok(
    "logs: all rows gateway_key=tmtest",
    logs.every((r) => r.gatewayKey === "tmtest"),
  );
  const ops = new Set(logs.map((r) => r.operation));
  ok("logs: operations cover charge", ops.has("charge"));
  ok("logs: operations cover refund", ops.has("refund"));

  // businessId + gatewayAccountId stamped via resolveAdapter's ALS wiring (real-bug check).
  ok(
    "logs: businessId stamped on every row",
    logs.every((r) => r.businessId === biz.id),
  );
  ok(
    "logs: gatewayAccountId stamped on every row",
    logs.every((r) => r.gatewayAccountId === acctRow.id),
  );

  // ── (2) source stamped from event context ('system') ──
  const chargeLog = logs.find((r) => r.operation === "charge");
  ok("logs: source stamped as system", chargeLog?.source === "system");
  ok("logs: actor stamped from event context", chargeLog?.actor === "verify-gateway-activity");

  // ── (3) redaction ──
  const rh = redactHeaders({
    authorization: "Bearer sk_test_123",
    "x-api-key": "k",
    "content-type": "application/json",
  });
  ok("redact: authorization masked", rh.authorization === "****");
  ok("redact: x-api-key masked", rh["x-api-key"] === "****");
  ok("redact: content-type NOT masked", rh["content-type"] === "application/json");

  const rb = redactBody(
    JSON.stringify({ card: { number: "4111111111111111", cvv: "123" }, note: "ok" }),
  ) as {
    card: { number: string; cvv: string };
    note: string;
  };
  ok("redact: card.number masked", rb.card.number === "****");
  ok("redact: card.cvv masked", rb.card.cvv === "****");
  ok("redact: non-secret field survives", rb.note === "ok");

  // ── MANDATE TERMS ARE NOT SECRETS (2026-08-31) ──
  // `SECRET_BODY_KEY_RE` matches KEY NAMES and one of them is `token`. RazorPay nests the
  // whole mandate under exactly that key, so blanking the value wholesale wrote
  // `"token":"****"` and the ceiling and expiry never reached the log — which cost a whole
  // investigation that could only infer what we SENT from what RazorPay echoed back.
  // A structure under a secret-looking key is now recursed instead of blanked.
  const rbT = redactBody(
    JSON.stringify({
      token: { max_amount: 6336305, expire_at: 2093532793, frequency: "as_presented" },
      amount: 100,
      method: "card",
    }),
  ) as { token: { max_amount: number; expire_at: number; frequency: string }; amount: number };
  ok("redact: mandate max_amount is readable", rbT.token?.max_amount === 6336305);
  ok("redact: mandate expire_at is readable", rbT.token?.expire_at === 2093532793);
  ok("redact: mandate frequency is readable", rbT.token?.frequency === "as_presented");

  // The property that makes recursing SAFE: a real secret nested under a secret-looking key
  // is still caught by its OWN key on the way down. Without this the change would be a leak.
  const rbNest = redactBody(
    JSON.stringify({ token: { number: "4111111111111111", max_amount: 500 } }),
  ) as {
    token: { number: string; max_amount: number };
  };
  ok("redact: a secret nested under `token` is STILL masked", rbNest.token?.number === "****");
  ok("redact: …while its non-secret sibling survives", rbNest.token?.max_amount === 500);

  // A STRING under a secret-looking key is the ordinary case and must stay masked.
  const rbStr = redactBody(JSON.stringify({ token: "tok_live_abc123", note: "keep" })) as {
    token: string;
    note: string;
  };
  ok("redact: a token STRING is still masked", rbStr.token === "****");

  // ARRAYS stay blanked: their elements are positional, so a bare secret string inside one
  // has no key to be judged by and would walk the recursion untouched.
  const rbArr = redactBody(
    JSON.stringify({ keys: ["sk_live_aaa", "sk_live_bbb"], note: "keep" }),
  ) as {
    keys: unknown;
    note: string;
  };
  ok("redact: an ARRAY under a secret key is masked, not walked", rbArr.keys === "****");
  ok("redact: sibling of the array survives", rbArr.note === "keep");

  // ── (4) org-guard ──
  const otherOrg = await createOrganization({ name: "Other Org" });
  const crossOrg = await listGatewayRequestLogs(otherOrg.organization.id, biz.id, { limit: 10 });
  ok("org-guard: cross-org list returns []", Array.isArray(crossOrg) && crossOrg.length === 0);

  // ── (5) serializer shape ──
  ok(
    "serialize: object=gateway_request_log",
    chargeLog != null && serializeGatewayRequestLog(chargeLog).object === "gateway_request_log",
  );
  if (chargeLog) {
    const fetched = await getGatewayRequestLog(orgId, biz.id, chargeLog.id);
    ok("serialize: getGatewayRequestLog round-trips id", fetched?.id === chargeLog.id);
  }

  // ── report ───────────────────────────────────────────────────────────────
  let pass = true;
  for (const [n, c] of checks) {
    console.log(` ${c ? "✓" : "✗"} ${n}`);
    if (!c) pass = false;
  }
  console.log("");
  console.log(pass ? "✅ GATEWAY ACTIVITY: PASS" : "❌ GATEWAY ACTIVITY: FAIL");
  await closeDb();
  process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
