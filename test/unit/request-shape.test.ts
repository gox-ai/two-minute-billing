import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { requestShapeHook } from "@/api/request-shape";
import { listFilterError } from "@/api/helpers";
import { isIsoCurrency } from "@/platform/currency";

let app: FastifyInstance | undefined;
afterEach(() => app?.close());

async function build() {
  app = Fastify();
  app.addHook("onRequest", requestShapeHook);
  app.get("/items/:id", async (req) => ({ id: (req.params as { id: string }).id }));
  app.get("/list", { config: { repeatableQuery: ["type"] } }, async (req) => req.query);
  await app.ready();
  return app;
}

describe("requestShapeHook", () => {
  it("refuses a NUL in a path parameter with a 400", async () => {
    const res = await (await build()).inject({ method: "GET", url: "/items/inv_123%00" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });

  it("refuses a repeated query key the route does not declare", async () => {
    const res = await (await build()).inject({ method: "GET", url: "/list?status=a&status=b" });
    expect(res.statusCode).toBe(400);
  });

  it("lets a declared key repeat", async () => {
    const res = await (await build()).inject({ method: "GET", url: "/list?type=a&type=b" });
    expect(res.statusCode).toBe(200);
    expect(res.json().type).toEqual(["a", "b"]);
  });

  it("refuses a NUL in a query value", async () => {
    const res = await (await build()).inject({ method: "GET", url: "/list?q=a%00b" });
    expect(res.statusCode).toBe(400);
  });

  it("passes an ordinary request", async () => {
    const res = await (await build()).inject({ method: "GET", url: "/items/inv_123?x=1" });
    expect(res.statusCode).toBe(200);
  });
});

describe("listFilterError", () => {
  const allow = { filterOps: { status: ["is"] as const } };
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "refuses the prototype key %s as an unknown field",
    (field) => {
      expect(listFilterError({ field, op: "is", value: "x" }, allow)).toMatch(/Cannot filter on/);
    },
  );
});

describe("isIsoCurrency", () => {
  it("accepts real codes in either case", () => {
    expect(isIsoCurrency("INR")).toBe(true);
    expect(isIsoCurrency("usd")).toBe(true);
  });
  it("refuses made-up codes and XXX", () => {
    expect(isIsoCurrency("ZZZ")).toBe(false);
    expect(isIsoCurrency("XXX")).toBe(false);
  });
});
