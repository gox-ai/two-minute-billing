/**
 * Limits on free credit (0495, `credit_config.grant_limits`): a wallet `granted` top-up,
 * promotional credit and a promotional credit grant are refused above the maximum; above the
 * alert amount they are written to the audit log and mailed to the team when `large_grants`
 * is on. Unset means no limit.
 *
 *   pnpm verify:grant-limits
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { buildApp } from "@/index";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { addPromotionalCredits, BalanceError } from "@/modules/customers/balances";
import { createPromotionalGrant, CreditRuleError } from "@/modules/credits/service";
import { topUpWallet, WalletError } from "@/modules/wallet/service";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { auditLogs, businesses, memberships, users } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail ?? "");
  }
}
const refusal = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
};

const sent: OutboundEmail[] = [];
setMailer({
  kind: "smtp",
  target: null,
  async send(msg) {
    sent.push(msg);
    return { providerMessageId: `p-${sent.length}`, status: "sent" };
  },
});

const RUN = randomUUID().slice(0, 8);
const org = await createOrganization({ name: `Grant limits ${RUN}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Grant Limits Biz",
  defaultCurrency: "USD",
  livemode: "live",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: `grants-${RUN}@example.com`,
});
// A team member receives the alert without confirmation.
const member = `member-${RUN}@example.com`;
const [u] = await systemDb
  .insert(users)
  .values({ publicId: publicId("usr"), email: member, name: "Member" })
  .returning();
await systemDb.insert(memberships).values({ organizationId: orgId, userId: u!.id, role: "ops" });

const granted = (amountMinor: number) =>
  topUpWallet({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    amountMinor,
    currency: "USD",
    type: "granted",
  });
const promo = (amountMinor: number) =>
  addPromotionalCredits({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    amountMinor,
    currency: "USD",
  });
const grant = (amount: bigint) =>
  createPromotionalGrant({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: customer.publicId,
    currency: "USD",
    amount,
  });
const largeGrantAudits = () =>
  withTenant(orgId, (tx) =>
    tx
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.businessId, biz.id), eq(auditLogs.action, "credit.large_grant"))),
  );

// ── Unset: no limit, no audit (today's behaviour) ─────────────────────────────
{
  ok(
    "unset: a large granted top-up is allowed",
    (await refusal(() => granted(10_000_000))) === null,
  );
  ok(
    "unset: large promotional credit is allowed",
    (await refusal(() => promo(10_000_000))) === null,
  );
  ok("unset: a large credit grant is allowed", (await refusal(() => grant(10_000_000n))) === null);
  ok("unset: nothing is audited as a large grant", (await largeGrantAudits()).length === 0);
}

// ── A maximum of 100.00 and an alert above 50.00 ──────────────────────────────
await systemDb
  .update(businesses)
  .set({ creditConfig: { grant_limits: { USD: { max_minor: 10_000, alert_above_minor: 5_000 } } } })
  .where(eq(businesses.id, biz.id));
await updateBusiness(orgId, biz.publicId, {
  teamAlertsConfig: { recipients: [member], large_grants: { enabled: true } },
});
{
  const w = await refusal(() => granted(10_001));
  ok(
    "a granted top-up above the maximum is refused (WalletError, 400 at the API)",
    w instanceof WalletError && /maximum for one grant is \$100\.00/.test(w.message),
    w?.message,
  );
  const p = await refusal(() => promo(10_001));
  ok("promotional credit above the maximum is refused", p instanceof BalanceError, p?.message);
  const g = await refusal(() => grant(10_001n));
  ok("a credit grant above the maximum is refused", g instanceof CreditRuleError, g?.message);
  ok("refusals write no audit row", (await largeGrantAudits()).length === 0);

  sent.length = 0;
  ok("at the maximum a granted top-up is allowed", (await refusal(() => granted(10_000))) === null);
  ok("at the alert amount nothing is audited", (await refusal(() => promo(5_000))) === null);
  ok(
    "above the alert amount a credit grant is allowed",
    (await refusal(() => grant(6_000n))) === null,
  );
  const audits = await largeGrantAudits();
  ok(
    "each grant above the alert amount is in the audit log",
    audits.length === 2 &&
      audits.some((a) => a.resourceType === "wallet_topup") &&
      audits.some((a) => a.resourceType === "credit_grant") &&
      audits.every((a) => (a.after as { customer?: string })?.customer === customer.publicId),
    audits.map((a) => [a.resourceType, a.after]),
  );
  ok(
    "…and each is mailed to the team",
    sent.length === 2 &&
      sent.every((m) => m.to === member && /above your alert limit/.test(m.subject)),
    sent.map((m) => [m.to, m.subject]),
  );
}

// ── The alert is opt-in; the audit row is not ─────────────────────────────────
{
  await updateBusiness(orgId, biz.publicId, {
    teamAlertsConfig: { recipients: [member], large_grants: { enabled: false } },
  });
  sent.length = 0;
  await promo(7_000);
  ok("alert off: no mail", sent.length === 0);
  ok("alert off: still audited", (await largeGrantAudits()).length === 3);
}

// ── The API answers 400 ───────────────────────────────────────────────────────
{
  const app = await buildApp({ logger: false });
  const res = await app.inject({
    method: "POST",
    url: `/v1/businesses/${biz.publicId}/customers/${customer.publicId}/wallet/topup`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `gl-${RUN}` },
    payload: { amount_minor: 20_000, currency: "USD", type: "granted" },
  });
  ok("POST wallet/topup above the maximum → 400", res.statusCode === 400, res.body);
  const paid = await app.inject({
    method: "PATCH",
    url: `/v1/businesses/${biz.publicId}`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `gl-${RUN}-cfg` },
    payload: {
      credit_config: { grant_limits: { USD: { max_minor: 1, alert_above_minor: null } } },
    },
  });
  const body = JSON.parse(paid.body) as { credit_config?: { grant_limits?: unknown } };
  ok(
    "PATCH stores grant_limits (null bounds dropped)",
    paid.statusCode === 200 &&
      JSON.stringify(body.credit_config?.grant_limits) ===
        JSON.stringify({ USD: { max_minor: 1 } }),
    paid.body.slice(0, 300),
  );
  await app.close();
}

setMailer(null);
await closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "❌ GRANT-LIMITS: FAIL" : "✅ GRANT-LIMITS: PASS");
process.exit(fail ? 1 : 0);
