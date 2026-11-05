import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Query keys this route reads as a list (`?type=a&type=b`). Any other key may appear once. */
    repeatableQuery?: readonly string[];
  }
}

// A NUL reaches the Postgres driver as an error, not a miss; a control character is never part of an id.
const BAD_PARAM_CHAR = /[\u0000-\u001f\u007f]/;
const BAD_QUERY_CHAR = /\u0000/;

const refuse = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: { type: "invalid_request_error", message } });

/**
 * onRequest hook: refuse input no route handles, before any route reads it.
 * - A path parameter with a control character, or a query value with a NUL.
 * - A repeated query key (Fastify parses it to an array, and routes read strings).
 */
export function requestShapeHook(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const params = (req.params ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === "string" && BAD_PARAM_CHAR.test(value)) {
      refuse(reply, `The path parameter '${name}' contains a character that is not permitted.`);
      return;
    }
  }
  const query = (req.query ?? {}) as Record<string, unknown>;
  const repeatable = req.routeOptions?.config?.repeatableQuery ?? [];
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    if (values.length > 1 && !repeatable.includes(key)) {
      refuse(reply, `The query parameter '${key}' occurs more than one time. Send it one time.`);
      return;
    }
    if (values.some((v) => typeof v === "string" && BAD_QUERY_CHAR.test(v))) {
      refuse(reply, `The query parameter '${key}' contains a character that is not permitted.`);
      return;
    }
  }
  done();
}
