import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { businesses, dunningPolicies, paymentMethods, payments } from "@db/schema";
import type { Tx } from "@/platform/db";
import { resolveDunningConfig, type DunningConfig } from "@/modules/subscriptions/dunning-schedule";
import { parksWhenRepeated } from "@/providers/decline-codes";

/**
 * The config of the policy assigned to a subscription's PLAN (2.48), or SQL null.
 * Assignments live in `businesses.dunning_config.plan_policies` as
 * `{ <plan product id>: <dpol_…> }`; `bizConfig` is that column in the caller's query.
 */
export function planPolicyConfigSql(subscriptionId: SQL | string, bizConfig: SQL): SQL {
  // The CASE skips the join for the many businesses that assign no plan policy.
  return sql`(case when (${bizConfig} -> 'plan_policies') is not null then
      (select ppol.config from subscription_items psi
      join prices ppr on ppr.id = psi.price_id
      join products ppd on ppd.id = ppr.product_id and ppd.kind = 'plan'
      join dunning_policies ppol on ppol.business_id = ppd.business_id
        and ppol.public_id = (${bizConfig} -> 'plan_policies' ->> ppd.public_id)
      where psi.subscription_id = ${subscriptionId}
      order by psi.created_at limit 1) end)`;
}

/**
 * The dunning config one invoice runs: the customer's policy, else its plan's policy, else
 * the business config. `dunning_excluded` is checked separately (`dunningHoldFor`) and beats
 * all three. With no customer and no subscription this is the business config.
 */
export async function loadEffectiveDunningConfig(
  tx: Tx,
  input: { businessId: string; customerId?: string | null; subscriptionId?: string | null },
): Promise<DunningConfig> {
  const [row] = await tx
    .select({
      dunningRetryDays: businesses.dunningRetryDays,
      dunningConfig: businesses.dunningConfig,
      policyConfig: input.customerId
        ? sql<unknown>`(select edp.config from customers edc
            join dunning_policies edp on edp.id = edc.dunning_policy_id
            where edc.id = ${input.customerId} and edc.business_id = ${input.businessId})`
        : sql<unknown>`null::jsonb`,
      planPolicyConfig: input.subscriptionId
        ? sql<unknown>`${planPolicyConfigSql(input.subscriptionId, sql`${businesses.dunningConfig}`)}`
        : sql<unknown>`null::jsonb`,
    })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  return resolveDunningConfig(row, row?.policyConfig ?? row?.planPolicyConfig ?? null);
}

/**
 * The instruments of the failed attempts on an invoice, oldest first, minus `exceptPaymentId`
 * (the attempt being booked). `planFailureRearm` uses them so a switch of instrument never
 * ends dunning early.
 */
export async function priorFailedMethods(
  tx: Tx,
  invoiceId: string,
  exceptPaymentId?: string | null,
): Promise<Array<{ type: string | null; rail: string | null }>> {
  return tx
    .select({ type: paymentMethods.type, rail: paymentMethods.mandateRail })
    .from(payments)
    .leftJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
    .where(
      and(
        eq(payments.invoiceId, invoiceId),
        eq(payments.status, "failed"),
        ...(exceptPaymentId ? [ne(payments.id, exceptPaymentId)] : []),
      ),
    )
    .orderBy(asc(payments.createdAt));
}

/**
 * Did this refusal (`parksWhenRepeated`) also end the method's last attempt on an EARLIER
 * invoice? Then it is the second cycle in a row, and `planFailureRearm` parks.
 */
export async function refusedLastCycleToo(
  tx: Tx,
  input: { paymentMethodId: string | null; invoiceId: string; message: string | null | undefined },
): Promise<boolean> {
  if (!input.paymentMethodId || !parksWhenRepeated(input.message)) return false;
  const [last] = await tx
    .select({ status: payments.status, failureMessage: payments.failureMessage })
    .from(payments)
    .where(
      and(
        eq(payments.paymentMethodId, input.paymentMethodId),
        ne(payments.invoiceId, input.invoiceId),
        inArray(payments.status, ["succeeded", "failed"]),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(1);
  return last?.status === "failed" && parksWhenRepeated(last.failureMessage);
}

/** Internal policy ids → public ids, for customer reads. */
export async function dunningPolicyPublicIds(
  tx: Tx,
  ids: Array<string | null>,
): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const rows = await tx
    .select({ id: dunningPolicies.id, publicId: dunningPolicies.publicId })
    .from(dunningPolicies)
    .where(inArray(dunningPolicies.id, want));
  return new Map(rows.map((r) => [r.id, r.publicId]));
}
