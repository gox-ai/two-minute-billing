import { requirePerm } from "./helpers";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { systemDb } from "@/platform/db";
import { businesses } from "@db/schema";
import { advanceTmtest } from "@/providers/tmtest/webhooks";
import { TmtestProvider } from "@/providers/tmtest";
import { getCharge } from "@/providers/tmtest/store";
import {
  TMTEST_FORM_POST_PATH,
  autoSubmitPage,
  verifyFormPostFields,
} from "@/providers/tmtest/form-post";

/**
 * TM Test Gateway simulator API (C4). Test-only helpers so verify suites can
 * drive the gateway's asynchronous behavior deterministically without sleeping.
 */
export async function registerTmtestRoutes(app: FastifyInstance) {
  // Flush all pending async webhooks for the caller's org immediately (they would
  // otherwise fire on their own `deliver_after` via the billing clock).
  app.post(
    "/v1/tmtest/advance",
    {
      preHandler: [authenticate, requirePerm("test_clock:advance"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      // Test-only: the TM Test Gateway lives only on test-mode businesses (TL-6), so
      // refuse a live-mode key explicitly rather than relying on that side effect.
      if (req.keyLivemode === "live") {
        return reply.code(404).send({
          object: "error",
          type: "not_found",
          message: "tmtest is only available in test mode",
        });
      }
      const result = await advanceTmtest(req.organization!.id, new Date());
      return { object: "tmtest_advance", ...result };
    },
  );

  // The gateway's own page for a `form_post` challenge (`buyer_auth_mode=form_post`).
  // The buyer's browser POSTs the signed fields here; we resolve the challenge and POST
  // the buyer back to `return_url`. No API key, like any gateway page: the signature is
  // what makes the fields ours. `decision=decline` fails the challenge.
  await app.register(async (instance) => {
    instance.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    instance.post(TMTEST_FORM_POST_PATH, async (req, reply) => {
      const fields = (req.body && typeof req.body === "object" ? req.body : {}) as Record<
        string,
        string
      >;
      if (!verifyFormPostFields(fields))
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: "We could not check this payment request. The signature is not correct.",
          },
        });
      const row = await getCharge(fields.intent!);
      const [biz] = row
        ? await systemDb
            .select({ livemode: businesses.livemode })
            .from(businesses)
            .where(eq(businesses.id, row.businessId))
            .limit(1)
        : [];
      // Same guard as /advance: the simulator acts on test businesses only.
      if (!row || biz?.livemode !== "test")
        return reply.code(404).send({
          object: "error",
          type: "not_found",
          message: "tmtest is only available in test mode",
        });
      // A replayed post leaves a resolved challenge as it is.
      if (row.status === "requires_action")
        await TmtestProvider.resolveChallenge(row.chargeId, fields.decision !== "decline");
      const after = await getCharge(row.chargeId);
      const status = after?.status === "failed" ? "declined" : "authorized";
      if (!fields.return_url)
        return reply
          .type("text/html; charset=utf-8")
          .send(
            '<!doctype html><html><head><meta charset="utf-8"><title>TM Test Gateway</title></head><body><p>The test payment step is complete. You can close this page.</p></body></html>',
          );
      return reply
        .type("text/html; charset=utf-8")
        .send(autoSubmitPage(fields.return_url, { intent: row.chargeId, status }));
    });
  });
}
