import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { config } from "@/platform/config";
import { withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { updateEventContext } from "@/platform/event-context";
import { updateTraceContext } from "@/platform/trace";
import { prices, products } from "@db/schema";
import { LIMITS } from "./limits";
import type { Connection } from "@/modules/hubspot/client";
import { parseSettings } from "@/modules/hubspot/settings";
import { verifyHubSpotRequest } from "@/modules/hubspot/app/signature";
import {
  HubSpotAppError,
  remoteTypeOf,
  resolvePortalConnection,
} from "@/modules/hubspot/app/resolve";
import { cardData, linkedRecord } from "@/modules/hubspot/app/card";
import {
  createSubscriptionFromHubSpot,
  customerForRecord,
  linkDeal,
} from "@/modules/hubspot/app/subscribe";
import {
  claimExecution,
  finishExecution,
  releaseExecution,
  runWorkflowAction,
  type WorkflowActionRequest,
} from "@/modules/hubspot/app/actions";

const log = createLogger("hubspot.app.routes");

const recordBody = z.object({
  objectId: z.union([z.string(), z.number()]).transform(String),
  objectType: z.string().min(1).max(40),
});
const createBody = recordBody.extend({
  /** One per opening of the card's create form, so a double click cannot bill twice. */
  requestId: z.string().min(8).max(100),
  priceId: z.string().min(1).max(100),
  quantity: z.number().int().positive().max(LIMITS.quantity).default(1),
});

/** Every URI HubSpot may have signed: our public base first, then the host we were reached on. */
function signedUris(req: FastifyRequest): string[] {
  const out: string[] = [];
  const base = config.WEBHOOK_BASE_URL?.replace(/\/+$/, "");
  if (base) out.push(`${base}${req.url}`);
  out.push(`${req.protocol}://${req.host}${req.url}`);
  return out;
}

function parseJson(req: FastifyRequest): { raw: string; body: Record<string, unknown> } {
  const raw = (req.body as Buffer | undefined)?.toString("utf8") ?? "";
  if (!raw) return { raw, body: {} };
  try {
    const body = JSON.parse(raw) as unknown;
    return { raw, body: body && typeof body === "object" ? (body as Record<string, unknown>) : {} };
  } catch {
    throw new HubSpotAppError("Body is not JSON", 400, "invalid_json");
  }
}

function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof HubSpotAppError) {
    // HubSpot retries a workflow action on 429 (honouring Retry-After) and fails it on other 4xx.
    if (e.status === 429) reply.header("retry-after", "30");
    return reply
      .code(e.status)
      .send({ error: { type: "hubspot_app_error", code: e.code, message: e.message } });
  }
  throw e;
}

/**
 * Verify the signature, parse the body, and find the portal's connection. HubSpot appends
 * `portalId` (and `userId`) to card fetches; workflow calls carry `origin.portalId`.
 */
async function authorize(
  req: FastifyRequest,
  opts: {
    record?: (body: Record<string, unknown>) => { remoteType: string; remoteId: string } | null;
    /** Workflow-action calls are signed v2 (no timestamp); card fetches are always v3. */
    allowV2?: boolean;
  } = {},
): Promise<{ conn: Connection; body: Record<string, unknown> }> {
  const { raw, body } = parseJson(req);
  const verdict = verifyHubSpotRequest({
    secret: config.HUBSPOT_CLIENT_SECRET,
    method: req.method,
    uris: signedUris(req),
    body: raw,
    headers: req.headers,
    allowV2: opts.allowV2 ?? false,
  });
  if (!verdict.ok) {
    log.warn("hubspot app request rejected", {
      event: "hubspot_signature_rejected",
      reason: verdict.reason,
      route: req.url,
    });
    throw new HubSpotAppError(verdict.reason, 401, "invalid_signature");
  }
  const query = (req.query ?? {}) as Record<string, string | undefined>;
  const origin = (body.origin ?? {}) as { portalId?: string | number };
  const portalId =
    query.portalId ?? origin.portalId ?? (body.portalId as string | number | undefined);
  const conn = await resolvePortalConnection(portalId, opts.record?.(body) ?? null);
  updateTraceContext({ businessId: conn.businessId });
  const user = query.userId ?? query.userEmail;
  updateEventContext({
    source: "hubspot",
    actor: `hubspot:${conn.portalId}${user ? `:user:${user}` : ":workflow"}`,
  });
  return { conn, body };
}

function recordOf(body: Record<string, unknown>) {
  const parsed = recordBody.safeParse(body);
  if (!parsed.success) return null;
  const remoteType = remoteTypeOf(parsed.data.objectType);
  return remoteType ? { remoteType, remoteId: parsed.data.objectId } : null;
}

function workflowRecordOf(body: Record<string, unknown>) {
  const object = (body.object ?? {}) as { objectId?: unknown; objectType?: string };
  const remoteType = remoteTypeOf(object.objectType);
  return remoteType && object.objectId != null
    ? { remoteType, remoteId: String(object.objectId) }
    : null;
}

/**
 * Endpoints the HubSpot app calls: the record card and the workflow actions. Authenticated
 * by HubSpot's v3 request signature alone, so the body parser keeps the raw bytes it covers.
 */
export async function registerHubSpotAppRoutes(app: FastifyInstance) {
  await app.register(async (instance) => {
    instance.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );

    instance.post("/v1/hubspot/app/card", async (req, reply) => {
      try {
        const { conn, body } = await authorize(req, { record: recordOf });
        const record = recordOf(body);
        if (!record)
          throw new HubSpotAppError("Unsupported HubSpot record", 400, "unsupported_record");
        return reply.send(await cardData(conn, record.remoteType, record.remoteId));
      } catch (e) {
        return sendError(reply, e);
      }
    });

    instance.post("/v1/hubspot/app/subscriptions", async (req, reply) => {
      try {
        const { conn, body } = await authorize(req, { record: recordOf });
        const parsed = createBody.safeParse(body);
        const record = recordOf(body);
        if (!parsed.success || !record)
          throw new HubSpotAppError("Select a plan and a quantity", 400, "invalid_request");
        if (!parseSettings(conn.settings).deals.manualCreate)
          throw new HubSpotAppError(
            "Creating subscriptions from HubSpot is disabled for this business.",
            403,
            "manual_create_disabled",
          );
        if (
          record.remoteType === "deal" &&
          (await linkedRecord(conn, "deal", record.remoteId)).subscriptionId
        )
          throw new HubSpotAppError(
            "This deal already has a subscription.",
            409,
            "deal_already_subscribed",
          );
        const key = `card:${parsed.data.requestId}`;
        const prior = await claimExecution(conn, key, "card_create");
        if (prior) {
          if (prior.status === "running")
            throw new HubSpotAppError(
              "This subscription is already being created.",
              429,
              "in_progress",
            );
          return reply.code(201).send(prior.result);
        }
        let payload: Record<string, unknown>;
        try {
          const { customerId } = await customerForRecord(conn, record);
          const { subscription, invoiceId } = await createSubscriptionFromHubSpot({
            conn,
            customerId,
            pricePublicId: parsed.data.priceId,
            quantity: parsed.data.quantity,
            metadata:
              record.remoteType === "deal" ? { hubspot_deal_id: record.remoteId } : undefined,
          });
          if (record.remoteType === "deal") await linkDeal(conn, subscription.id, record.remoteId);
          payload = {
            object: "hubspot_subscription_created",
            subscription: { id: subscription.publicId, status: subscription.status },
            invoice_id: invoiceId,
          };
        } catch (e) {
          // Nothing was billed (creation is charge-first), so the next click may try again.
          await releaseExecution(conn, key);
          throw e;
        }
        await finishExecution(conn, key, "succeeded", payload);
        return reply
          .code(201)
          .send({ ...payload, card: await cardData(conn, record.remoteType, record.remoteId) });
      } catch (e) {
        return sendError(reply, e);
      }
    });

    for (const [path, action] of [
      ["/v1/hubspot/app/actions/create-subscription", "create_subscription"],
      ["/v1/hubspot/app/actions/edit-subscription", "edit_subscription"],
    ] as const) {
      instance.post(path, async (req, reply) => {
        try {
          const { conn, body } = await authorize(req, { record: workflowRecordOf, allowV2: true });
          return reply.send(await runWorkflowAction(conn, action, body as WorkflowActionRequest));
        } catch (e) {
          return sendError(reply, e);
        }
      });
    }

    // The price dropdown on both actions: the business's active recurring plan prices.
    instance.post("/v1/hubspot/app/actions/price-options", async (req, reply) => {
      try {
        const { conn, body } = await authorize(req, { allowV2: true });
        const q = typeof body.q === "string" ? body.q.trim().toLowerCase() : "";
        const rows = await withTenant(conn.organizationId, (tx) =>
          tx
            .select({
              id: prices.publicId,
              name: prices.name,
              product: products.name,
              currency: prices.currency,
            })
            .from(prices)
            .innerJoin(products, eq(products.id, prices.productId))
            .where(
              and(
                eq(prices.businessId, conn.businessId),
                eq(prices.type, "recurring"),
                eq(prices.active, true),
                eq(products.kind, "plan"),
              ),
            )
            .orderBy(products.name, prices.name)
            .limit(500),
        );
        const options = rows
          .map((r) => ({
            label: `${r.product}${r.name && r.name !== r.product ? ` — ${r.name}` : ""} (${r.currency})`,
            value: r.id,
          }))
          .filter(
            (o) => !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
          )
          .slice(0, 200);
        return reply.send({ options, searchable: true });
      } catch (e) {
        return sendError(reply, e);
      }
    });
  });
}
