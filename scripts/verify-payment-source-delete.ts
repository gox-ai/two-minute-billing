/**
 * Deleting a payment source must delete the vaulted instrument AT THE GATEWAY —
 * not just the local row. Before this, `detachPaymentMethod` was a pure local
 * DELETE and `clearPersonalData` called an optional `deletePaymentMethod` that no
 * real adapter implemented, so every "deleted" card stayed chargeable upstream.
 *
 * Driven through the TM Test Gateway, whose vault is a real table (`tmtest_vault`),
 * so the upstream side is assertable offline. Asserts:
 *  - detach → local row gone, `payment_source_deleted` emitted, AND the vault row gone,
 *  - the shared-token guard: two pms on one vault id → deleting the first leaves the
 *    vault intact (the survivor must stay chargeable); deleting the last removes it,
 *  - idempotency: a second detach returns false and does not throw,
 *  - a gateway failure does not block the delete (local row still goes),
 *  - `clear_personal_data` (CUST-7) erases the vault too, via the same path.
 *
 *   pnpm verify:payment-source-delete
 */
import { eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createCustomer, clearPersonalData } from "@/modules/customers/service";
import { vaultPaymentMethod, detachPaymentMethod } from "@/modules/payment-methods/service";
import { paymentMethods, events, tmtestVault } from "@db/schema";

const checks: [string, boolean][] = [];
const ok = (name: string, cond: boolean) => checks.push([name, cond]);

const vaultExists = async (vaultId: string): Promise<boolean> => {
  const rows = await systemDb
    .select({ id: tmtestVault.id })
    .from(tmtestVault)
    .where(eq(tmtestVault.vaultId, vaultId));
  return rows.length > 0;
};

async function main() {
  const org = await createOrganization({ name: "PM Delete Co" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "PMD Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });

  // ── 1) The plain delete reaches the gateway ────────────────────────────────
  {
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: "plain@a.com",
    });
    const pm = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: biz.id,
      customer,
      token: "tok_4242",
    });
    ok("vault row exists before delete", await vaultExists(pm.providerPaymentMethodId));

    const detached = await detachPaymentMethod(orgId, customer.id, pm.publicId);
    ok("detach returns true", detached === true);
    ok("vault row DELETED at the gateway", !(await vaultExists(pm.providerPaymentMethodId)));

    const localGone = await withTenant(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.publicId, pm.publicId));
      return rows.length === 0;
    });
    ok("local payment_methods row gone", localGone);

    const emitted = await withTenant(orgId, async (tx) => {
      const rows = await tx.select().from(events).where(eq(events.type, "payment_source_deleted"));
      return rows.some((e) => JSON.stringify(e.data).includes(pm.publicId));
    });
    ok("payment_source_deleted emitted", emitted);

    // Idempotency: a second delete is a no-op, not a throw.
    let threw = false;
    let second: boolean | undefined;
    try {
      second = await detachPaymentMethod(orgId, customer.id, pm.publicId);
    } catch {
      threw = true;
    }
    ok("second detach returns false and does not throw", !threw && second === false);
  }

  // ── 2) Shared provider token: the survivor must stay chargeable ────────────
  {
    // The twin lives under a SECOND customer, and that is not incidental. This block
    // used to duplicate the row under the same customer, on the stated premise that
    // "provider_payment_method_id has no unique index" — true when it was written, and
    // false since migration 0183, which added
    // `payment_methods_provider_pm_uq (customer_id, provider_key, provider_payment_method_id)`
    // AND deduped the existing rows. So the fixture crashed on a 23505 rather than
    // testing anything, and being outside verify:all is why that went unnoticed.
    //
    // The behaviour is unchanged and still worth pinning: `deleteAtGateway`'s guard
    // matches on (provider_key, provider_payment_method_id) across the whole
    // organization, NOT per customer, so one instrument referenced by two customers'
    // rows — which an import can produce — must survive until the last row goes.
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: "shared@a.com",
    });
    const other = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: "shared-twin@a.com",
    });
    const pm = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: biz.id,
      customer,
      token: "tok_4242",
    });
    const twin = await withTenant(orgId, async (tx) => {
      const [src] = await tx
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.publicId, pm.publicId))
        .limit(1);
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          ...src!,
          id: undefined as unknown as string,
          publicId: `${src!.publicId}_twin`,
          customerId: other.id,
        })
        .returning();
      return row!;
    });

    await detachPaymentMethod(orgId, customer.id, pm.publicId);
    ok(
      "shared token: vault SURVIVES while a twin references it",
      await vaultExists(pm.providerPaymentMethodId),
    );

    await detachPaymentMethod(orgId, other.id, twin.publicId);
    ok(
      "shared token: vault deleted once the last row goes",
      !(await vaultExists(pm.providerPaymentMethodId)),
    );
  }

  // ── 3) A gateway failure must not block the local delete ───────────────────
  {
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: "broken@a.com",
    });
    const pm = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: biz.id,
      customer,
      token: "tok_4242",
    });
    // Point the row at a gateway account that cannot be resolved → the adapter
    // lookup throws inside deleteAtGateway. The delete must still complete.
    await withTenant(orgId, (tx) =>
      tx
        .update(paymentMethods)
        .set({ gatewayAccountId: "00000000-0000-0000-0000-000000000000" })
        .where(eq(paymentMethods.publicId, pm.publicId)),
    );
    let threw = false;
    let detached: boolean | undefined;
    try {
      detached = await detachPaymentMethod(orgId, customer.id, pm.publicId);
    } catch {
      threw = true;
    }
    ok(
      "unresolvable gateway: delete still succeeds locally (warned, not thrown)",
      !threw && detached === true,
    );
  }

  // ── 4) GDPR erasure erases the vault too (CUST-7) ──────────────────────────
  {
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: "gdpr@a.com",
    });
    const pm = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: biz.id,
      customer,
      token: "tok_4242",
    });
    const cleared = await clearPersonalData(orgId, biz.id, customer.publicId);
    ok("clear_personal_data returns the scrubbed customer", cleared != null);
    ok(
      "clear_personal_data deleted the vaulted instrument",
      !(await vaultExists(pm.providerPaymentMethodId)),
    );
  }
}

await main();

console.log("");
let pass = true;
for (const [name, cond] of checks) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) pass = false;
}
console.log(pass ? `\nPASS (${checks.length}/${checks.length})` : "\nFAIL");
await closeDb();
process.exit(pass ? 0 : 1);
