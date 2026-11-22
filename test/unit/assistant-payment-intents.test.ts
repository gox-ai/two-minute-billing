import { describe, expect, it } from "vitest";
import { TOOLS, attemptCallsQuery, type ToolContext } from "@/modules/assistant-tools/catalog";
import { RECORD_READS } from "@/modules/assistant/research";
import { nearPaths } from "@/modules/assistant/read-api";
import type { RouteResult } from "@/modules/assistant-tools/route-call";
import { BROWSER_REPORTED } from "@/modules/payment-intents/browser-failure";

/** GETs answer from a table keyed by path + query; every call is recorded. */
function fakeCtx(routes: Record<string, unknown>, calls: string[] = []): ToolContext {
  return {
    business: { id: "biz_A1" } as ToolContext["business"],
    get: async (rel, query): Promise<RouteResult> => {
      const key = query ? `${rel}?${new URLSearchParams(query as Record<string, string>)}` : rel;
      calls.push(key);
      return key in routes
        ? { status: 200, body: routes[key] }
        : { status: 403, body: { error: { message: "Your role cannot read this." } } };
    },
    post: async () => ({ status: 404, body: null }),
  };
}

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

describe("a customer read", () => {
  it("lists the customer's payment intents with the last error", async () => {
    const calls: string[] = [];
    const out = (await tool("get_customer").run(
      fakeCtx(
        {
          "customers/cus_1": { id: "cus_1" },
          "payment_intents?customer=cus_1&limit=10": {
            data: [
              {
                id: "pi_1",
                status: "in_progress",
                last_attempt_status: "failed",
                last_error: { code: "card_declined", message: "Declined" },
                customer_phone: "+10000000000",
              },
            ],
            has_more: false,
          },
        },
        calls,
      ),
      { customer: "cus_1" },
    )) as { recent_payment_intents: { data: Array<Record<string, unknown>> } };
    expect(calls).toContain("payment_intents?customer=cus_1&limit=10");
    const row = out.recent_payment_intents.data[0]!;
    expect(row).toMatchObject({ id: "pi_1", last_attempt_status: "failed" });
    expect(row.last_error).toEqual({ code: "card_declined", message: "Declined" });
    expect(row).not.toHaveProperty("customer_phone");
  });

  it("says why when the member cannot read payments", async () => {
    const out = (await tool("get_customer").run(fakeCtx({ "customers/cus_1": { id: "cus_1" } }), {
      customer: "cus_1",
    })) as { recent_payment_intents: { unavailable: string } };
    expect(out.recent_payment_intents.unavailable).toContain("cannot read");
  });
});

describe("a payment intent read", () => {
  const browserText = `Your card was declined. ${BROWSER_REPORTED}`;
  const attempts = Array.from({ length: 6 }, (_, i) => ({
    id: `pia_${i + 1}`,
    attempt_number: i + 1,
    status: "failed",
    error_code: "card_declined",
    error_text: i === 5 ? browserText : "Declined",
    span_id: i === 4 ? null : `span_${i + 1}`,
    trace_id: i === 4 ? "trace_5" : null,
  }));
  const routes = {
    "payment_intents/pi_1": { id: "pi_1", status: "in_progress", attempts },
    "gateway_requests?span_id%5Bis%5D=span_6&limit=10": {
      data: [{ id: "gwr_1", operation: "charge", status: 402, request_body: "{}" }],
    },
    "gateway_requests?trace_id%5Bis%5D=trace_5&limit=10": { data: [{ id: "gwr_2" }] },
    "gateway_webhooks?payment_intent%5Bis%5D=pi_1&limit=20": {
      data: [{ id: "pev_1", type: "payment_intent.payment_failed", payload: { x: 1 } }],
    },
  };

  it("carries the intent, every attempt's error, its gateway calls and the webhooks", async () => {
    const calls: string[] = [];
    const out = (await tool("get_payment_attempts").run(fakeCtx(routes, calls), {
      payment_intent: "pi_1",
    })) as {
      payment_intent: Record<string, unknown>;
      data: Array<Record<string, unknown> & { gateway_calls: Record<string, unknown> }>;
      webhooks: { data: Array<Record<string, unknown>> };
    };
    expect(out.payment_intent).toMatchObject({ id: "pi_1", status: "in_progress" });
    expect(out.data).toHaveLength(6);
    expect(out.data[5]!.error_text).toBe(browserText);
    expect(out.data[5]!.reported_by_browser).toBe(true);
    expect(out.data[4]!.reported_by_browser).toBe(false);
    // Bodies stay out; read_api gateway_requests/<id> reads one in full.
    expect(out.data[5]!.gateway_calls).toEqual({
      data: [expect.objectContaining({ id: "gwr_1", status: 402 })],
      has_more: false,
    });
    expect(JSON.stringify(out.data[5]!.gateway_calls)).not.toContain("request_body");
    expect((out.data[4]!.gateway_calls as { data: unknown[] }).data).toHaveLength(1);
    // Only the newest five attempts are traced.
    expect(out.data[0]!.gateway_calls).toHaveProperty("unavailable");
    expect(calls.filter((c) => c.startsWith("gateway_requests"))).toHaveLength(5);
    expect(out.webhooks.data[0]).toMatchObject({ id: "pev_1" });
    expect(out.webhooks.data[0]).not.toHaveProperty("payload");
  });

  it("says why when the gateway logs cannot be read", async () => {
    const out = (await tool("get_payment_attempts").run(
      fakeCtx({ "payment_intents/pi_1": routes["payment_intents/pi_1"] }),
      { payment_intent: "pi_1" },
    )) as { webhooks: { unavailable: string } };
    expect(out.webhooks.unavailable).toContain("cannot read");
  });

  it("filters an attempt's calls by its span, else its trace", () => {
    expect(attemptCallsQuery({ span_id: "s", trace_id: "t" })).toEqual({ "span_id[is]": "s" });
    expect(attemptCallsQuery({ span_id: null, trace_id: "t" })).toEqual({ "trace_id[is]": "t" });
    expect(attemptCallsQuery({})).toBeNull();
  });
});

describe("the page's record", () => {
  it("an intent page reads the intent in full; a customer page the customer overview", () => {
    expect(RECORD_READS.payment!("pi_1")).toEqual({
      tool: "get_payment_attempts",
      args: { payment_intent: "pi_1" },
    });
    expect(RECORD_READS.customer!("cus_1").tool).toBe("get_customer");
  });

  it("read_api can reach an intent's attempts and its gateway logs", () => {
    expect(nearPaths("payment_intents/x/y")).toContain("payment_intents/{pi}/attempts");
    expect(nearPaths("gateway_requests/x/y")).toContain("gateway_requests");
    expect(nearPaths("gateway_webhooks/x/y")).toContain("gateway_webhooks");
  });
});
