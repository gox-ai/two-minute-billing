import type { FastifyInstance } from "fastify";
import {
  verifySnsMessage,
  parseSesFeedback,
  SnsVerificationError,
  type SnsEnvelope,
} from "@/modules/emails/sns";
import { applySesFeedback } from "@/modules/emails/suppression";
import { createLogger } from "@/platform/logger";

const log = createLogger("emails.sns.routes");

/**
 * Inbound SES delivery feedback, over SNS.
 *
 * PUBLIC and unauthenticated, exactly like the gateway webhooks: AWS posts here with no
 * shared secret and authenticity comes from the message signature. The stakes are worth
 * stating, because they are not the usual webhook stakes — a forged "bounce" would mark a
 * real customer's address permanently undeliverable and suppress every future invoice to
 * them, silently, from anyone who knows the URL. So nothing is acted on before
 * `verifySnsMessage` returns.
 *
 * Two AWS-specific details shape this route:
 *
 *  - **SNS posts `Content-Type: text/plain`**, not JSON, even though the body is JSON. A
 *    route relying on Fastify's JSON parser receives nothing at all. Parsed as a raw buffer
 *    here for that reason and because the signature covers exact bytes.
 *  - **A subscription must be CONFIRMED** before any notification arrives: AWS first posts a
 *    `SubscriptionConfirmation` carrying a one-time `SubscribeURL` that has to be fetched.
 *    Done automatically — but only after the signature verifies, since the URL is attacker-
 *    supplied otherwise.
 */
export async function registerEmailWebhookRoutes(app: FastifyInstance) {
  await app.register(async (instance) => {
    // SNS sends text/plain; the JSON parser would never see it. Raw buffer also keeps the
    // exact bytes, which is what the signature is computed over.
    for (const mime of ["text/plain", "application/json"]) {
      instance.addContentTypeParser(mime, { parseAs: "buffer" }, (_req, body, done) =>
        done(null, body),
      );
    }

    instance.post("/v1/email_webhooks/ses", async (req, reply) => {
      const raw = (req.body as Buffer | undefined)?.toString("utf8") ?? "";
      let msg: SnsEnvelope;
      try {
        msg = JSON.parse(raw) as SnsEnvelope;
      } catch {
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: "Body is not JSON" } });
      }

      try {
        await verifySnsMessage(msg);
      } catch (e) {
        // 403, not 400: this is an authenticity failure, and it is the one event on this
        // route worth alerting on — a genuine AWS message always verifies.
        log.warn("SNS message rejected", {
          event: "sns_signature_rejected",
          type: msg?.Type,
          topic: msg?.TopicArn,
          detail: e instanceof SnsVerificationError ? e.message : String(e),
        });
        return reply
          .code(403)
          .send({ error: { type: "webhook_signature_error", message: "SNS signature rejected" } });
      }

      if (msg.Type === "SubscriptionConfirmation") {
        // Only reachable AFTER the signature verified, so the URL is AWS's own. It is
        // host-checked again inside `confirmSubscription` regardless: this is the one
        // outbound request we make on an inbound message's say-so, on a public endpoint.
        const ok = await confirmSubscription(msg.SubscribeURL);
        log.info("SNS subscription confirmation", {
          event: "sns_subscription_confirmed",
          topic: msg.TopicArn,
          ok,
        });
        return reply.code(200).send({ received: true, confirmed: ok });
      }

      if (msg.Type === "UnsubscribeConfirmation") {
        // Nothing to do, but worth a line: an unsubscribe we did not perform means someone
        // detached our bounce feed, and the first symptom otherwise is silence.
        log.warn("SNS topic unsubscribed", {
          event: "sns_unsubscribed",
          topic: msg.TopicArn,
        });
        return reply.code(200).send({ received: true });
      }

      const feedback = parseSesFeedback(msg.Message);
      if (!feedback) return reply.code(200).send({ received: true, ignored: true });

      try {
        const outcome = await applySesFeedback(feedback);
        return reply.code(200).send({ received: true, ...outcome });
      } catch (e) {
        // Non-2xx so SNS redelivers. Its retry policy is generous (multiple attempts over
        // hours), and losing a bounce means continuing to mail a dead address — the exact
        // thing this endpoint exists to stop.
        log.error("SES feedback processing failed — answering 502 so SNS redelivers", {
          event: "ses_feedback_failed",
          kind: feedback.kind,
          detail: (e as Error).message,
        });
        return reply.code(502).send({
          error: {
            type: "webhook_processing_error",
            message: "We accepted the feedback but could not process it. Deliver it again.",
          },
        });
      }
    });
  });
}

/**
 * Complete an SNS subscription by fetching its one-time `SubscribeURL`.
 *
 * Host-checked before the fetch even though the envelope's signature has already verified:
 * the signature proves AWS sent the message, and this proves we are not being pointed at
 * something else entirely. Cheap, and the failure it prevents (an outbound request to an
 * arbitrary URL on an unauthenticated endpoint) is worth more than the check costs.
 */
async function confirmSubscription(subscribeUrl: string | undefined): Promise<boolean> {
  if (!subscribeUrl) return false;
  let url: URL;
  try {
    url = new URL(subscribeUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || !/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname)) {
    log.warn("refusing to confirm an SNS subscription on an untrusted host", {
      event: "sns_subscribe_url_rejected",
      host: url.hostname,
    });
    return false;
  }
  const res = await fetch(url.toString());
  return res.ok;
}
