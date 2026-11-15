import { describe, expect, it } from "vitest";
import {
  Tmbilling,
  type CreditUnitCreate,
  type UsageEvent,
  type UsageEventInput,
} from "../../sdk/index";

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | undefined;
}

/** A client whose fetch records each request and answers `{}`. */
function client() {
  const calls: Call[] = [];
  const tmb = new Tmbilling({
    apiKey: "sk_test_XXXXXXXXXXXX01",
    baseUrl: "http://api.test",
    fetch: (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({
        method: init.method!,
        path: url.replace("http://api.test", ""),
        body: init.body ? JSON.parse(init.body as string) : undefined,
        key: headers["Idempotency-Key"],
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { tmb, calls };
}

const B = "/v1/businesses/biz_1";

describe("sdk: credit units", () => {
  it("create sends minor_per_unit, a rate or an explicit null", async () => {
    const { tmb, calls } = client();
    await tmb.creditUnits.create("biz_1", {
      name: "credit",
      currency: "USD",
      minor_per_unit: null,
    });
    await tmb.creditUnits.create(
      "biz_1",
      { id: "token", name: "token", currency: "USD", minor_per_unit: "1" },
      { idempotencyKey: "k1" },
    );
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", `${B}/credit_units`],
      ["POST", `${B}/credit_units`],
    ]);
    expect(calls[0]!.body).toEqual({ name: "credit", currency: "USD", minor_per_unit: null });
    expect(calls[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]!.key).toBe("k1");
  });

  it("the create type refuses a body with no minor_per_unit", () => {
    // @ts-expect-error minor_per_unit is required: a rate, or null.
    const missing: CreditUnitCreate = { name: "credit", currency: "USD" };
    const none: CreditUnitCreate = { name: "credit", currency: "USD", minor_per_unit: null };
    expect(missing.minor_per_unit).toBeUndefined();
    expect(none.minor_per_unit).toBeNull();
  });

  it("list, get, update and archive use the unit routes", async () => {
    const { tmb, calls } = client();
    await tmb.creditUnits.list("biz_1");
    await tmb.creditUnits.list("biz_1", { limit: 10, startingAfter: "credit", status: "active" });
    await tmb.creditUnits.get("biz_1", "credit");
    await tmb.creditUnits.update("biz_1", "credit", { minor_per_unit: null, expected_version: 2 });
    await tmb.creditUnits.archive("biz_1", "credit", { idempotencyKey: "k2" });
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", `${B}/credit_units`],
      ["GET", `${B}/credit_units?limit=10&starting_after=credit&status=active`],
      ["GET", `${B}/credit_units/credit`],
      ["PATCH", `${B}/credit_units/credit`],
      ["POST", `${B}/credit_units/credit/archive`],
    ]);
    expect(calls[0]!.key).toBeUndefined();
    expect(calls[3]!.body).toEqual({ minor_per_unit: null, expected_version: 2 });
    expect(calls[4]!.body).toBeUndefined();
    expect(calls[4]!.key).toBe("k2");
  });
});

describe("sdk: meter credit cost", () => {
  it("get, set and delete use one route with three methods", async () => {
    const { tmb, calls } = client();
    const cost = {
      unit: "credit",
      credits_per_unit: "0.5",
      overrides: [{ product: "pro-plan", credits_per_unit: "0.4" }],
    };
    await tmb.meters.getCreditCost("biz_1", "images");
    await tmb.meters.setCreditCost("biz_1", "images", cost, { idempotencyKey: "k3" });
    await tmb.meters.deleteCreditCost("biz_1", "images");
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", `${B}/meters/images/credit_cost`],
      ["PUT", `${B}/meters/images/credit_cost`],
      ["DELETE", `${B}/meters/images/credit_cost`],
    ]);
    expect(calls[1]!.body).toEqual(cost);
    expect(calls[1]!.key).toBe("k3");
    expect(calls[2]!.key).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("sdk: credit usage", () => {
  it("lists a customer's settlements, filtered by meter", async () => {
    const { tmb, calls } = client();
    await tmb.creditUsage.list("biz_1", "cus_1");
    await tmb.creditUsage.list("biz_1", "cus_1", {
      limit: 5,
      startingAfter: "cst_1",
      meter: "images",
    });
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", `${B}/customers/cus_1/credit_usage`],
      ["GET", `${B}/customers/cus_1/credit_usage?limit=5&starting_after=cst_1&meter=images`],
    ]);
  });
});

describe("sdk: usage events of a meter with a credit cost", () => {
  it("send passes backfill through", async () => {
    const { tmb, calls } = client();
    const event: UsageEventInput = {
      key: "evt-1",
      customer: "cus_1",
      event_name: "image",
      backfill: true,
    };
    await tmb.usageEvents.send("biz_1", event);
    expect(calls[0]!.body).toEqual(event);
  });

  it("an event types its credit entries", () => {
    const credit: NonNullable<UsageEvent["credit"]> = [
      { meter: "images", unit: "credit", status: "refused", reason: "insufficient_credit" },
    ];
    expect(credit[0]!.status).toBe("refused");
  });
});
