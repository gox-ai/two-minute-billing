import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { customers, hubspotActionExecutions, subscriptions } from "@db/schema";
import { HubSpotClient, type Connection } from "../client";
import { parseSettings } from "../settings";
import { linkedRecord } from "./card";
import { HubSpotAppError, remoteTypeOf } from "./resolve";
import {
  createSubscriptionFromHubSpot,
  customerForRecord,
  editSubscriptionFromHubSpot,
  isEditDealType,
  linkDeal,
  type DealDiscount,
} from "./subscribe";

const log = createLogger("hubspot.app.actions");

export type WorkflowActionName = "create_subscription" | "edit_subscription";

/** The body HubSpot POSTs to a custom workflow action's `actionUrl`. */
export interface WorkflowActionRequest {
  callbackId?: string;
  origin?: { portalId?: number | string; actionDefinitionId?: number | string };
  context?: { workflowId?: number | string };
  object?: {
    objectId?: number | string;
    objectType?: string;
    properties?: Record<string, string | null>;
  };
  inputFields?: Record<string, unknown>;
}

/** What HubSpot reads back: output fields, plus the execution state it branches on. */
export interface WorkflowActionResponse {
  outputFields: Record<string, string | number | null> & {
    hs_execution_state: "SUCCESS" | "FAIL_CONTINUE";
  };
}

const str = (v: unknown) => (v == null ? "" : String(v).trim());
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(str(v));
  return Number.isFinite(n) ? n : null;
};

function discountFrom(inputs: Record<string, unknown>): DealDiscount {
  return {
    percent: num(inputs.discount_percent),
    amount: num(inputs.discount_amount),
    couponCode: str(inputs.coupon_code) || null,
  };
}

const failure = (message: string, code = "failed"): WorkflowActionResponse => ({
  outputFields: {
    hs_execution_state: "FAIL_CONTINUE",
    error_code: code,
    error_message: message.slice(0, 500),
  },
});

async function dealType(conn: Connection, dealId: string, props?: Record<string, string | null>) {
  if (props && "dealtype" in props) return props.dealtype ?? null;
  const deal = await new HubSpotClient(conn).request<{
    properties?: Record<string, string | null>;
  }>("GET", `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=dealtype`);
  return deal?.properties?.dealtype ?? null;
}

async function perform(
  conn: Connection,
  action: WorkflowActionName,
  req: WorkflowActionRequest,
): Promise<WorkflowActionResponse> {
  const settings = parseSettings(conn.settings);
  const inputs = req.inputFields ?? {};
  if (remoteTypeOf(req.object?.objectType) !== "deal")
    return failure("This action runs on deal-based workflows only.", "not_a_deal");
  const dealId = str(req.object?.objectId);
  if (!dealId) return failure("The workflow sent no deal id.", "missing_deal");

  const type = await dealType(conn, dealId, req.object?.properties);
  const editType = isEditDealType(settings, type);
  const { subscriptionId: linkedSub } = await linkedRecord(conn, "deal", dealId);

  if (action === "create_subscription") {
    if (editType)
      return failure(
        `Deal type "${type}" is set to edit subscriptions. Use the Edit subscription action for this deal.`,
        "deal_type_edits",
      );
    if (linkedSub)
      return failure("This deal already has a subscription.", "deal_already_subscribed");
    const priceId = str(inputs.price_id);
    if (!priceId) return failure("Select a plan price for the subscription.", "missing_price");
    const { customerId } = await customerForRecord(conn, { remoteType: "deal", remoteId: dealId });
    const { subscription, invoiceId } = await createSubscriptionFromHubSpot({
      conn,
      customerId,
      pricePublicId: priceId,
      quantity: num(inputs.quantity) ?? 1,
      discount: discountFrom(inputs),
      metadata: { hubspot_deal_id: dealId },
    });
    await linkDeal(conn, subscription.id, dealId);
    return success(conn, subscription, invoiceId);
  }

  if (!editType)
    return failure(
      `Deal type "${type ?? "(none)"}" creates subscriptions. Add it to the edit deal types in Two Minute Billing to edit with this action.`,
      "deal_type_creates",
    );
  let subId = linkedSub;
  const given = str(inputs.subscription_id);
  if (!subId && given) {
    subId = await withTenant(conn.organizationId, async (tx) => {
      const [row] = await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(eq(subscriptions.businessId, conn.businessId), eq(subscriptions.publicId, given)),
        )
        .limit(1);
      return row?.id ?? null;
    });
  }
  if (!subId)
    return failure(
      "No subscription is linked to this deal, and no subscription id was given.",
      "no_subscription",
    );
  const res = await editSubscriptionFromHubSpot({
    conn,
    subscriptionId: subId,
    pricePublicId: str(inputs.price_id) || null,
    quantity: num(inputs.quantity),
    discount: discountFrom(inputs),
  });
  if (!linkedSub) await linkDeal(conn, subId, dealId);
  return success(conn, res.subscription, res.invoiceId);
}

async function success(
  conn: Connection,
  sub: typeof subscriptions.$inferSelect,
  invoiceId: string | null,
): Promise<WorkflowActionResponse> {
  const cus = await withTenant(conn.organizationId, async (tx) => {
    const [row] = await tx
      .select({ publicId: customers.publicId })
      .from(customers)
      .where(eq(customers.id, sub.customerId))
      .limit(1);
    return row?.publicId ?? null;
  });
  return {
    outputFields: {
      hs_execution_state: "SUCCESS",
      subscription_id: sub.publicId,
      subscription_status: sub.status,
      customer_id: cus,
      invoice_id: invoiceId,
    },
  };
}

type Execution = typeof hubspotActionExecutions.$inferSelect;

/** Claim `key` for this connection. Null means we hold it now; otherwise the prior execution. */
export async function claimExecution(
  conn: Connection,
  key: string,
  action: string,
): Promise<Execution | null> {
  return withTenant(conn.organizationId, async (tx) => {
    const rows = await tx.execute(sql`
      INSERT INTO hubspot_action_executions (organization_id, business_id, connection_id, callback_id, action, status)
      VALUES (${conn.organizationId}, ${conn.businessId}, ${conn.id}, ${key}, ${action}, 'running')
      ON CONFLICT (connection_id, callback_id) DO NOTHING
      RETURNING id
    `);
    if ((rows as unknown as unknown[]).length > 0) return null;
    const [prior] = await tx
      .select()
      .from(hubspotActionExecutions)
      .where(
        and(
          eq(hubspotActionExecutions.connectionId, conn.id),
          eq(hubspotActionExecutions.callbackId, key),
        ),
      )
      .limit(1);
    return prior ?? null;
  });
}

export async function finishExecution(
  conn: Connection,
  key: string,
  status: string,
  result: unknown,
): Promise<void> {
  await withTenant(conn.organizationId, (tx) =>
    tx
      .update(hubspotActionExecutions)
      .set({ status, result })
      .where(
        and(
          eq(hubspotActionExecutions.connectionId, conn.id),
          eq(hubspotActionExecutions.callbackId, key),
        ),
      ),
  );
}

export async function releaseExecution(conn: Connection, key: string): Promise<void> {
  await withTenant(conn.organizationId, (tx) =>
    tx
      .delete(hubspotActionExecutions)
      .where(
        and(
          eq(hubspotActionExecutions.connectionId, conn.id),
          eq(hubspotActionExecutions.callbackId, key),
        ),
      ),
  );
}

/**
 * Run a workflow action once per HubSpot `callbackId`. The claim row is written before any
 * billing happens, so a retry — or a duplicate racing the first — replays the stored result
 * instead of billing twice. An unexpected error drops the claim so HubSpot's retry runs again.
 */
export async function runWorkflowAction(
  conn: Connection,
  action: WorkflowActionName,
  req: WorkflowActionRequest,
): Promise<WorkflowActionResponse> {
  const callbackId = str(req.callbackId);
  if (!callbackId) throw new HubSpotAppError("Missing callbackId", 400, "missing_callback_id");

  const claimed = await withTenant(conn.organizationId, async (tx) => {
    const rows = await tx.execute(sql`
      INSERT INTO hubspot_action_executions (organization_id, business_id, connection_id, callback_id, action, status)
      VALUES (${conn.organizationId}, ${conn.businessId}, ${conn.id}, ${callbackId}, ${action}, 'running')
      ON CONFLICT (connection_id, callback_id) DO NOTHING
      RETURNING id
    `);
    if ((rows as unknown as unknown[]).length > 0) return null;
    const [prior] = await tx
      .select()
      .from(hubspotActionExecutions)
      .where(
        and(
          eq(hubspotActionExecutions.connectionId, conn.id),
          eq(hubspotActionExecutions.callbackId, callbackId),
        ),
      )
      .limit(1);
    return prior ?? null;
  });
  if (claimed) {
    if (claimed.status === "running")
      throw new HubSpotAppError(
        "This action is already running. Retry in a few moments.",
        429,
        "in_progress",
      );
    return claimed.result as WorkflowActionResponse;
  }

  const finish = (status: string, result: WorkflowActionResponse) =>
    withTenant(conn.organizationId, (tx) =>
      tx
        .update(hubspotActionExecutions)
        .set({ status, result })
        .where(
          and(
            eq(hubspotActionExecutions.connectionId, conn.id),
            eq(hubspotActionExecutions.callbackId, callbackId),
          ),
        ),
    );

  let result: WorkflowActionResponse;
  try {
    result = await perform(conn, action, req);
  } catch (e) {
    if (e instanceof HubSpotAppError && e.status < 500) {
      result = failure(e.message, e.code);
    } else {
      await withTenant(conn.organizationId, (tx) =>
        tx
          .delete(hubspotActionExecutions)
          .where(
            and(
              eq(hubspotActionExecutions.connectionId, conn.id),
              eq(hubspotActionExecutions.callbackId, callbackId),
            ),
          ),
      );
      log.error(e, { event: "hubspot_action_failed", action, connection: conn.publicId });
      throw e;
    }
  }
  await finish(
    result.outputFields.hs_execution_state === "SUCCESS" ? "succeeded" : "failed",
    result,
  );
  return result;
}
