/**
 * Embedding routes: the business's list of websites that may embed its checkout, portal and
 * usage widget, and the lookup the storefront makes before it lets a page be framed.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { config } from "@/platform/config";
import { EMBED_SCRIPT, EMBED_SCRIPT_INTEGRITY } from "@/modules/embedding/embed-script";
import {
  MAX_EMBED_ORIGINS,
  getEmbedOrigins,
  normaliseEmbedOrigin,
  resolveFrameAncestor,
  setEmbedOrigins,
} from "@/modules/embedding/service";
import { badRequest, requirePerm, resolveBusiness } from "./helpers";
import { parseRequest } from "./strict-params";

const originsBody = z.object({
  origins: z.array(z.string().min(1).max(300)).max(MAX_EMBED_ORIGINS),
});

/** Where a page loads `embed.js` from: the API host developers are told to call. */
const scriptUrl = () => {
  const base = config.ADVERTISED_API_URL;
  return base ? `${base.replace(/\/$/, "")}/js/v1/embed.js` : null;
};

const settingsView = (origins: string[]) => ({
  object: "embedding_settings",
  origins,
  script_url: scriptUrl(),
  script_integrity: EMBED_SCRIPT_INTEGRITY,
});

export async function registerEmbeddingRoutes(app: FastifyInstance) {
  app.get(
    "/v1/businesses/:biz/settings/embedding",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      return settingsView(await getEmbedOrigins(req.organization!.id, business.id));
    },
  );

  app.put(
    "/v1/businesses/:biz/settings/embedding",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(originsBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const origins: string[] = [];
      for (const [i, raw] of parsed.data.origins.entries()) {
        const n = normaliseEmbedOrigin(raw);
        if ("error" in n)
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              message: `We could not save the websites. ${n.error}`,
              param: `origins.${i}`,
            },
          });
        origins.push(n.origin);
      }
      return settingsView(await setEmbedOrigins(req.organization!.id, business.id, origins));
    },
  );

  // The loader. Public, static JS: any page may load it (SRI needs CORS on a cross-origin script).
  app.get("/js/v1/embed.js", async (_req, reply) =>
    reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300")
      .send(EMBED_SCRIPT),
  );

  // Public, called by the storefront's server before it answers a framed page. Says only which
  // website may frame the page this credential opens; never whether the credential is valid.
  app.get("/storefront/v1/frame_ancestor", async (req, reply) => {
    const { credential } = (req.query ?? {}) as { credential?: unknown };
    const origin =
      typeof credential === "string" && credential.length <= 200
        ? await resolveFrameAncestor(credential)
        : null;
    reply.header("cache-control", "no-store");
    return { object: "frame_ancestor", frame_ancestor: origin };
  });
}
