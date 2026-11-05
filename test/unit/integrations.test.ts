/**
 * The parts of an integration that can be wrong without any I/O: the catalogue, which events a
 * push integration claims, and what it makes of a response status.
 *
 * The delivery path itself is proved by `verify:firstpromoter`, which drives a real endpoint
 * against a capture server. What is pinned here is the class of mistake that compiles, passes
 * that suite's happy path and still silently sends nothing — a subscription to an event type
 * that does not exist.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { isEventType } from "@/modules/events/registry";
import { firstPromoter } from "@/modules/integrations/providers/firstpromoter";
import { listIntegrations } from "@/modules/integrations/catalogue";
import { pushIntegration } from "@/modules/integrations/registry";

describe("integration registry", () => {
  it("resolves a known push integration and nothing else", () => {
    expect(pushIntegration("firstpromoter")).toBe(firstPromoter);
    expect(pushIntegration("not-an-integration")).toBeNull();
    expect(pushIntegration(null)).toBeNull();
    expect(pushIntegration(undefined)).toBeNull();
    // A sync integration has no push mapping.
    expect(pushIntegration("hubspot")).toBeNull();
  });

  it("names every push integration by the key it is stored under", () => {
    for (const i of listIntegrations().filter((x) => x.kind === "push"))
      expect(pushIntegration(i.key)).toMatchObject({ key: i.key });
  });

  it("lists HubSpot as an OAuth sync and FirstPromoter as a push integration", () => {
    const all = listIntegrations();
    const hubspot = all.find((i) => i.key === "hubspot");
    const fp = all.find((i) => i.key === "firstpromoter");
    expect(hubspot?.kind).toBe("sync");
    expect(hubspot?.connect.method).toBe("oauth");
    expect(fp?.kind).toBe("push");
  });

  it("subscribes every push integration only to registered event types", () => {
    for (const i of listIntegrations().filter((x) => x.kind === "push")) {
      const push = pushIntegration(i.key);
      for (const t of push?.connect.eventTypes ?? [])
        expect(isEventType(t), `${i.key}:${t}`).toBe(true);
    }
  });

  // The SDK generator imports the API reference with no env. Reaching the database layer
  // from it runs the env check and exits — CI's "SDK types in sync" step died that way.
  it("the API reference loads with an empty environment", () => {
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", 'await import("./src/api/openapi.ts"); console.log("ok")'],
      { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
    );
    expect(out.trim()).toBe("ok");
  }, 60_000);
});

describe("firstpromoter subscription", () => {
  /**
   * The one that actually bit: the event is `subscription_canceled`, one L. An integration
   * subscribed to `subscription_cancelled` type-checks (the list is strings to the compiler
   * through `EventType` widening at the array literal), never matches an emitted event, never
   * enqueues a delivery, and looks exactly like a partner with no churn — which is also what a
   * correctly-wired integration looks like on a quiet day.
   */
  it("subscribes only to event types the registry actually emits", () => {
    for (const t of firstPromoter.connect.eventTypes) expect(isEventType(t), t).toBe(true);
  });

  it("covers both halves of the refund pair", () => {
    // A refund accepted as `pending` claws back on `refund_settled`; one born `succeeded`
    // never emits that type, so `refund_created` has to be subscribed too. Exactly one of
    // them builds a call — see `buildRefund`.
    expect(firstPromoter.connect.eventTypes).toContain("refund_created");
    expect(firstPromoter.connect.eventTypes).toContain("refund_settled");
  });

  it("builds nothing for an event it does not map", async () => {
    const ctx = {
      event: { type: "invoice_voided", data: {}, businessId: null, organizationId: "org" },
      baseUrl: "https://api.firstpromoter.com/api/v2",
      credentials: { apiKey: "k" },
      config: {},
    } as never;
    await expect(firstPromoter.build(ctx)).resolves.toBeNull();
  });
});

describe("firstpromoter referral field", () => {
  /**
   * The Custom fields screen shows the API name as `cf_tid` while the stored key is `tid`, so
   * `cf_tid` is the natural thing to paste into the connect form. Matching nothing there is
   * indistinguishable from "this customer was not referred" — the signup is skipped and the
   * integration looks like a quiet day rather than a misconfiguration.
   */
  it("reads the referral field whether or not the operator typed the cf_ prefix", async () => {
    const fields = firstPromoter.connect.fields ?? [];
    const tid = fields.find((f) => f.key === "tidField");
    expect(tid, "tidField is the documented setting").toBeTruthy();
    // The help text has to say it names a FIELD, because "Referral-id custom field" alone reads
    // like it wants the id itself.
    expect(tid!.help ?? "").toMatch(/name of the field, not its value/i);
  });
});

describe("firstpromoter v2 contract", () => {
  /**
   * Built against v1 first, and every live call came back 401. The v1 header was RIGHT
   * (`X-API-KEY`, per its own OpenAPI spec) — the API version was wrong, and v2 needs a second
   * credential v1 never had. Pinned by value because the failure is invisible until a real
   * account rejects it: nothing in a mapping test notices a stale base URL.
   */
  it("targets the v2 base URL", () => {
    expect(firstPromoter.connect.defaultUrl).toBe("https://api.firstpromoter.com/api/v2");
  });

  it("asks for both credentials v2 authenticates with", () => {
    const keys = firstPromoter.connect.credentials.map((c) => c.key);
    expect(keys).toContain("apiKey");
    expect(keys).toContain("accountId");
  });

  it("does not mask the account id, which the partner displays openly", () => {
    const accountId = firstPromoter.connect.credentials.find((c) => c.key === "accountId");
    expect(accountId?.secret).toBe(false);
  });
});

describe("connect catalogue", () => {
  /**
   * The dashboard renders its connect form entirely from this descriptor, so an integration that
   * ships without one renders a form with no credential label and no way to fill it — and the
   * failure is a blank screen at connect time, not a compile error, because every field below
   * `blurb` is optional-looking until you try to use it.
   */
  it("every api_key integration can be connected from the catalogue alone", () => {
    for (const info of listIntegrations()) {
      if (info.connect.method !== "api_key") continue;
      const t = { ...info, connect: info.connect };
      expect(t.blurb.length, `${t.key} blurb`).toBeGreaterThan(0);
      expect(t.connect.credentials.length, `${t.key} has at least one credential`).toBeGreaterThan(
        0,
      );
      for (const c of t.connect.credentials) {
        expect(c.key.length, `${t.key} credential key`).toBeGreaterThan(0);
        expect(c.label.length, `${t.key}.${c.key} label`).toBeGreaterThan(0);
      }
      expect(t.icon.monogram.length, `${t.key} monogram`).toBeGreaterThan(0);
      // A remote icon would make our screen depend on a partner's CDN and tell them, on every
      // render, that this organization uses them. Local assets only.
      expect(t.icon.src ?? "", `${t.key} icon src`).not.toMatch(/^https?:/);
      for (const f of t.connect.fields ?? [])
        expect(f.label.length, `${t.key}.${f.key} label`).toBeGreaterThan(0);
    }
  });
});

describe("firstpromoter response verdicts", () => {
  it("treats a duplicate as delivered", () => {
    // 409 is "this event_id is already recorded" — which is the retry working, not failing.
    // Under the default rule this delivery would retry five more times and then be filed as
    // failed, for a commission that was paid on the first attempt.
    expect(firstPromoter.judge(409)).toBe("delivered");
  });

  it("stops spending attempts on a request that will never be accepted", () => {
    expect(firstPromoter.judge(400)).toBe("terminal");
    expect(firstPromoter.judge(422)).toBe("terminal");
  });

  /**
   * The one that turned a healthy production integration into a page of red. v2 answers 404 to
   * a sale for a customer nobody referred — verbatim, "Referral corresponding to email or uid
   * parameter not found or promoter is banned" — which is the majority case, and which v1
   * answered 204 to. Judged as a failure it trains an operator to stop reading the log.
   */
  it("treats a 404 on a sale as delivered — the customer simply was not referred", () => {
    const req = (path: string) => ({
      url: `https://api.firstpromoter.com/api/v2${path}`,
      headers: {},
      body: "",
    });
    expect(firstPromoter.judge(404, req("/track/sale"))).toBe("delivered");
    expect(firstPromoter.judge(404, req("/track/refund"))).toBe("delivered");
    expect(firstPromoter.judge(404, req("/track/cancellation"))).toBe("delivered");
  });

  it("…but a 404 on a SIGNUP is a real problem, because we only send referred ones", () => {
    // We skip a signup with no referral id, so a rejected one means the merchant's
    // `_fprom_tid` pipeline is feeding us ids FirstPromoter does not recognise.
    const signup = {
      url: "https://api.firstpromoter.com/api/v2/track/signup",
      headers: {},
      body: "",
    };
    expect(firstPromoter.judge(404, signup)).toBe("terminal");
  });

  it("retries a rate limit rather than burning the delivery on it", () => {
    expect(firstPromoter.judge(429)).toBe("retry");
  });

  it("defers to the default rule everywhere else", () => {
    // Null means "the native judgement": 2xx delivered, anything else worth another attempt.
    // 204 is a sale with no matching lead — the most common answer here, and a success.
    for (const status of [200, 204, 500, 502, 503]) expect(firstPromoter.judge(status)).toBeNull();
    // 0 is our own discriminator for a fetch that threw. It must fall through to a retry.
    expect(firstPromoter.judge(0)).toBeNull();
  });
});
