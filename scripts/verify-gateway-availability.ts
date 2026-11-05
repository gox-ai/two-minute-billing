/**
 * The availability flag against the real engine, on Adyen's conformance fake. Fakes of
 * `known-gaps.json` and `live-proof-pending.json` go in through the function parameters; the
 * checked-in files are not changed. What regresses without it: a gateway or method that is not
 * offered blocks money already moving on it, or still reaches a new account or a new setup.
 *
 *   pnpm verify:gateway-availability
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, withTenant } from "@/platform/db";
import { loadGeoReference } from "@/platform/geo";
import { flushGatewayRequestLogs } from "@/providers/http";
import { createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import {
  assertGatewayOffered,
  effectiveMethodTypes,
  getGatewayAccount,
  GatewayError,
} from "@/modules/gateway/service";
import {
  assertVaultPreconditions,
  PaymentMethodConfigError,
} from "@/modules/payment-methods/service";
import {
  gatewayOffered,
  knownGapsByGateway,
  methodOffered,
  type PendingMethods,
} from "@/providers/conformance";
import { paymentMethods } from "@db/schema";
import { adyenFixture } from "./conformance/fixtures/adyen";
import { installFake, uninstallFakes } from "./conformance/fake-http";
import { newWorld } from "./conformance/harness";

let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  console.log(
    `${cond ? "✓" : "✗"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
  if (!cond) failed++;
}
async function thrown(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

const gapped = {
  gaps: { ...knownGapsByGateway(), adyen: { "S7.lost": { reason: "r", planRef: "3f x" } } },
};
const sepaPending: PendingMethods = { adyen: { sepa_debit: { reason: "r", planRef: "4 x" } } };

await loadGeoReference();
const app = await buildApp({ logger: false });
const org = await createOrganization({ name: `Gateway availability ${Date.now().toString(36)}` });
const driver = adyenFixture.driver();
installFake(driver.fake);
try {
  // This account exists before the gap opens: money already moves on it.
  const w = await newWorld(
    adyenFixture,
    driver,
    app,
    { id: org.organization.id, secret: org.secret },
    "avail",
  );

  // ── gateway level ───────────────────────────────────────────────────────
  ok("a gateway with an open gap is not offered", !gatewayOffered("adyen", gapped));
  const refusal = await thrown(() => assertGatewayOffered("adyen", gapped));
  ok(
    "a new account of it is refused, in STE",
    refusal instanceof GatewayError &&
      refusal.message === "We could not connect Adyen. It is not available yet.",
    String(refusal),
  );
  const collected = await w.collected();
  ok(
    "its existing account still books a charge settled by webhook",
    collected.txnStatus === "succeeded",
    collected,
  );
  const acc = await getGatewayAccount(org.organization.id, w.biz.id, w.account.publicId);
  ok("its existing account stays active", acc?.status === "active", acc?.status);

  // ── method level ────────────────────────────────────────────────────────
  const row = { gatewayKey: "adyen", methodTypes: ["card", "sepa_debit"] };
  ok(
    "a pending method leaves the buyer list; the other methods stay",
    effectiveMethodTypes(row, "EUR", "setup", sepaPending).join() === "card" &&
      effectiveMethodTypes(row, "EUR", "setup", {}).join() === "card,sepa_debit",
    effectiveMethodTypes(row, "EUR", "setup", sepaPending),
  );
  const customer = await createCustomer({
    organizationId: org.organization.id,
    businessId: w.biz.id,
    email: `avail-${Date.now().toString(36)}@example.com`,
    firstName: "Availability",
    lastName: "Payer",
  });
  const account = { ...acc!, methodTypes: ["card", "sepa_debit"] };
  const setupRefusal = await thrown(() =>
    assertVaultPreconditions({
      account,
      customer,
      methodTypes: ["sepa_debit"],
      pendingMethods: sepaPending,
    }),
  );
  ok(
    "a new setup of a pending method is refused",
    setupRefusal instanceof PaymentMethodConfigError &&
      /^We could not set up Direct Debit \(SEPA\)\. It is not available yet\./.test(
        setupRefusal.message,
      ),
    String(setupRefusal),
  );
  const setupMethods = await assertVaultPreconditions({
    account,
    customer,
    pendingMethods: sepaPending,
  });
  ok(
    "a setup with no method named asks only for the offered ones",
    setupMethods?.join() === "card",
    setupMethods,
  );

  ok("the fake marks SEPA pending", !methodOffered("adyen", "sepa_debit", sepaPending));
  const debit = await w.bill("bank_debit");
  const [pm] = await withTenant(org.organization.id, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, debit.paymentMethodId)),
  );
  ok("the saved method is a SEPA mandate", pm?.type === "sepa_debit", pm?.type);
  ok(
    "a saved method of a pending kind still charges",
    debit.chargeId !== "" && (debit.paymentStatus === "pending" || debit.txnStatus === "succeeded"),
    debit,
  );
  await w.deliver(driver.collect(w, debit.chargeId));
  const settled = await w.reload(debit);
  ok("its debit still settles by webhook", settled.txnStatus === "succeeded", settled);
  ok("the ledger balances", await w.balanced());
} finally {
  uninstallFakes();
}

console.log(failed ? `❌ GATEWAY AVAILABILITY: ${failed} FAILED` : "✅ GATEWAY AVAILABILITY: PASS");
await app.close();
await flushGatewayRequestLogs();
await closeDb();
process.exit(failed ? 1 : 0);
