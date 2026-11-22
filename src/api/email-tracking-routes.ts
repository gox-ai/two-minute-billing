import type { FastifyInstance, FastifyRequest } from "fastify";
import { recordClick, recordOpen } from "@/modules/emails/tracking-service";
import { createLogger } from "@/platform/logger";

const log = createLogger("emails.tracking.routes");

/** A 1x1 transparent GIF. */
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const metaOf = (req: FastifyRequest) => ({
  method: req.method,
  userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
  ip: req.ip ?? null,
});

const notFound = (reply: import("fastify").FastifyReply) =>
  reply.code(404).header("cache-control", "no-store").type("text/plain").send("Not found");

/**
 * Open pixel and click redirect for tracked billing emails. PUBLIC: the signed token is the
 * credential. A token we did not sign, or a link we no longer hold, is a plain 404. The
 * redirect target is read from our own table; the request never names it.
 */
export async function registerEmailTrackingRoutes(app: FastifyInstance) {
  app.get("/e/o/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const token = file.endsWith(".gif") ? file.slice(0, -4) : "";
    let ok = false;
    try {
      ok = await recordOpen(token, metaOf(req));
    } catch (e) {
      // A recording fault must not break the image.
      log.warn("open not recorded", { error: (e as Error).message });
      ok = true;
    }
    if (!ok) return notFound(reply);
    return reply
      .header("cache-control", "no-store, no-cache, must-revalidate, private")
      .header("content-length", String(GIF.length))
      .type("image/gif")
      .send(GIF);
  });

  app.get("/e/c/:token", async (req, reply) => {
    const token = (req.params as { token: string }).token;
    let url: string | null = null;
    try {
      url = await recordClick(token, metaOf(req));
    } catch (e) {
      log.warn("click lookup failed", { error: (e as Error).message });
      return reply
        .code(503)
        .header("cache-control", "no-store")
        .type("text/plain")
        .send("Try again");
    }
    if (!url) return notFound(reply);
    return reply
      .code(302)
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("location", url)
      .send();
  });
}
