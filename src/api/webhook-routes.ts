import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ingestGatewayWebhook,
  recordGatewayWebhookResponse,
  storeGatewayWebhook,
  WebhookRejectedError,
} from "@/modules/gateway/inbound";
import { createLogger } from "@/platform/logger";
import { gatewayDefinition } from "@/providers/gateway-catalog";

const log = createLogger("gateway.routes");

/**
 * Inbound provider webhooks. Signature verification needs the EXACT raw bytes,
 * so this runs in an encapsulated plugin with a raw-buffer body parser — scoped
 * here so the rest of the API keeps normal JSON parsing.
 *
 * Not API-key authenticated: authenticity comes from the provider signature.
 *
 * ONE shape for every gateway: `/v1/gateway_webhooks/:gateway?id=gwa_…`. The gateway
 * account id resolves the business by itself, so the per-business path segment the
 * generic route used to carry was dead weight — `ingestGatewayWebhook` never read it
 * when `?id=` was present.
 *
 * `/v1/gateway_webhooks/:gateway/:id` is the same route with the account id in the path,
 * for gateways that refuse a query string (`webhook.accountIdInPath`, Authorize.net).
 *
 * Removed 2026-08-01, with the registered endpoints migrated at each provider first:
 *   - `/v1/webhooks/stripe` — Stripe's older dedicated path, plus its pre-gateway-accounts
 *     env-global branch (`STRIPE_WEBHOOK_SECRET`, no business attribution).
 *   - `/v1/gateway_webhooks/:gateway/:business` — the per-business path.
 */
export async function registerWebhookRoutes(app: FastifyInstance) {
  await app.register(async (instance) => {
    // Form-encoded too: some gateways sign form posts (`bt_signature`, PayU's hash), and
    // without a parser Fastify answers 415 before the adapter sees them. text/plain is
    // parsed here because the app root no longer parses it.
    instance.addContentTypeParser(
      ["application/json", "application/x-www-form-urlencoded", "text/plain"],
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );

    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const { gateway, id: pathId } = req.params as { gateway: string; id?: string };
      const accountId = pathId ?? (req.query as { id?: string } | undefined)?.id;
      const rawBody = (req.body as Buffer | undefined)?.toString("utf8") ?? "";
      // P2: log the URL the gateway actually posted to. `req.url` is path + query
      // (which carries `?id=gwa_…`, a public id, not a secret); the Host header
      // completes it so the log shows the endpoint the gateway was configured with,
      // which is the whole point of the column — a misconfigured Notification URL is
      // otherwise invisible. Falls back to the path alone if there is no Host.
      const host = req.headers.host;
      const requestUrl = host ? `${req.protocol}://${host}${req.url}` : req.url;
      const def = gatewayDefinition(gateway);
      const rejected = (err: unknown) => {
        log.warn("gateway webhook processing failed", {
          event: "gateway_webhook_signature_rejected",
          gateway,
          detail: (err as Error).message,
        });
        return reply
          .code(def?.webhook.rejectedSignatureStatus ?? 400)
          .send({ error: { type: "webhook_signature_error", message: (err as Error).message } });
      };

      // Store, answer, then process on the job queue. A storage failure answers 5xx so the
      // gateway delivers again; a bad signature is refused before anything is stored.
      const answerFirst = def?.webhook.processAfterAnswer;
      if (answerFirst) {
        let stored;
        try {
          stored = await storeGatewayWebhook({
            gatewayKey: gateway,
            gatewayAccountPublicId: accountId,
            rawBody,
            headers: req.headers,
            requestUrl,
          });
        } catch (err) {
          if (err instanceof WebhookRejectedError) return rejected(err);
          throw err;
        }
        if ("error" in stored)
          return reply
            .code(404)
            .send({ error: { type: "invalid_request_error", message: stored.error } });
        return reply.code(200).type("text/plain").send(answerFirst.body);
      }

      let res;
      try {
        res = await ingestGatewayWebhook({
          gatewayKey: gateway,
          gatewayAccountPublicId: accountId,
          rawBody,
          headers: req.headers,
          requestUrl,
        });
      } catch (err) {
        return rejected(err);
      }
      if ("error" in res)
        return reply
          .code(404)
          .send({ error: { type: "invalid_request_error", message: res.error } });

      // P2: stamp the status we are about to answer onto the log rows this delivery
      // wrote, so the Gateway Webhooks log shows the exchange and not just the
      // verdict. Awaited before the reply: the row is the debugging record, and a
      // fire-and-forget update would race the gateway's next redelivery. Nothing was
      // written on the 400/404 paths above, so those rows simply don't exist.
      const providerEventIds = res.providerEventIds;
      const recordResponse = (responseStatus: number) =>
        recordGatewayWebhookResponse({
          gatewayKey: gateway,
          businessId: res.businessId,
          providerEventIds,
          responseStatus,
        });

      // A handler that THREW must not be answered 200. Every gateway retries on a
      // non-2xx and gives up on a 2xx, so replying 200 here told them "handled" and
      // stranded the event: the money had moved at the gateway, our ledger never
      // learned, and nothing ever tried again. `handleProviderEvent` reprocesses a
      // previously-errored event rather than deduping it, so the redelivery we are
      // asking for actually runs. The delivery also queued our own retry job, which races
      // the redelivery safely under the per-event lock.
      if (res.handled.includes("error")) {
        log.error("gateway webhook processing failed — answering 502 so the gateway redelivers", {
          event: "gateway_webhook_processing_failed",
          gateway,
          results: res.handled,
        });
        await recordResponse(502);
        return reply.code(502).send({
          error: {
            type: "webhook_processing_error",
            message: "We accepted the event but could not process it. Deliver it again.",
          },
          results: res.handled,
        });
      }
      await recordResponse(200);
      return reply.code(200).send({ received: true, results: res.handled });
    };
    instance.post("/v1/gateway_webhooks/:gateway", handler);
    instance.post("/v1/gateway_webhooks/:gateway/:id", handler);
  });
}
