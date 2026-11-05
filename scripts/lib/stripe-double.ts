/**
 * A stand-in for api.stripe.com inside a verify run. It serves the objects a suite
 * registers, by id, and counts every read. An unknown id gets Stripe's own 404, and an
 * id marked as failing gets a 503. Every other host passes through to the real fetch.
 */
type StripeObject = { id: string; object?: string; charge?: string; created?: number };

const PATHS: Record<string, string> = {
  charges: "charge",
  payment_intents: "payment_intent",
  refunds: "refund",
  disputes: "dispute",
  payment_methods: "payment_method",
  setup_intents: "setup_intent",
  mandates: "mandate",
};

export interface StripeDouble {
  /** Serve this object for reads of its id, replacing any earlier one. */
  serve(...objects: StripeObject[]): void;
  /** Ids whose reads answer 503 until removed. */
  failing: Set<string>;
  /** Every read, as `GET /v1/<path>`, in order. */
  reads: string[];
  restore(): void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_double" },
  });

export function installStripeDouble(): StripeDouble {
  const objects = new Map<string, StripeObject>();
  const failing = new Set<string>();
  const reads: string[] = [];
  const realFetch = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname !== "api.stripe.com") return realFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    reads.push(`${method} ${url.pathname}${url.search}`);
    const [, , path, id] = url.pathname.split("/");
    if (method !== "GET" || !path || !PATHS[path]) {
      return json(400, {
        error: { type: "invalid_request_error", message: "Not served by the double." },
      });
    }
    if (!id) {
      // Only `refunds.list({ charge, created: { lte } })` is read as a list.
      const charge = url.searchParams.get("charge");
      const lte = Number(url.searchParams.get("created[lte]") ?? Infinity);
      if (path !== "refunds" || !charge || failing.has(charge)) {
        return json(503, { error: { type: "api_error", message: "List not available." } });
      }
      const data = [...objects.values()]
        .filter((o) => o.object === "refund" && o.charge === charge && (o.created ?? 0) <= lte)
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
      return json(200, { object: "list", data, has_more: false, url: "/v1/refunds" });
    }
    if (failing.has(id)) {
      return json(503, { error: { type: "api_error", message: "Stripe is not available." } });
    }
    const obj = objects.get(id);
    if (!obj) {
      return json(404, {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: `No such ${PATHS[path]}: '${id}'`,
        },
      });
    }
    return json(200, obj);
  };

  return {
    serve: (...list) => list.forEach((o) => objects.set(o.id, o)),
    failing,
    reads,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}
