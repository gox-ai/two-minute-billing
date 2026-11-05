import { describe, expect, it } from "vitest";
import { reportAiUsage, usageEventsFromAiResponse } from "../../sdk/ai-usage";
import {
  anthropicMessage,
  openaiChat,
  openaiResponse,
  vercelV5,
  vercelV6,
} from "./fixtures/ai-usage-responses";

const tokens = (events: ReturnType<typeof usageEventsFromAiResponse>) =>
  Object.fromEntries(events.map((e) => [e.properties.token_type, e.properties.tokens]));

describe("usageEventsFromAiResponse", () => {
  it("OpenAI chat: cached tokens are taken out of input, never billed twice", () => {
    const ev = usageEventsFromAiResponse(openaiChat, { customer: "ws_01" });
    expect(tokens(ev)).toEqual({ input: 1_034_567, output: 456_789, cached_input: 200_000 });
    expect(ev[0]).toMatchObject({
      key: "chatcmpl-XXXXXXXXXXXX01:input",
      customer: "ws_01",
      event_name: "ai_tokens",
      properties: { model: "gpt-4o-mini-2024-07-18", provider: "openai" },
    });
  });

  it("OpenAI responses", () => {
    const ev = usageEventsFromAiResponse(openaiResponse, { customer: "ws_01" });
    expect(tokens(ev)).toEqual({ input: 4_000, output: 700, cached_input: 1_000 });
  });

  it("Anthropic: input excludes cache reads and writes, so nothing is subtracted", () => {
    const ev = usageEventsFromAiResponse(anthropicMessage, { customer: "ws_01" });
    expect(tokens(ev)).toEqual({
      input: 2_000,
      output: 500,
      cached_input: 10_000,
      cache_write: 3_000,
    });
    expect(ev.every((e) => e.properties.provider === "anthropic")).toBe(true);
  });

  it("Vercel AI SDK 6 and 5", () => {
    expect(tokens(usageEventsFromAiResponse(vercelV6, { customer: "c" }))).toEqual({
      input: 2_000,
      output: 500,
      cached_input: 10_000,
      cache_write: 3_000,
    });
    const v5 = usageEventsFromAiResponse(vercelV5, { customer: "c" });
    expect(tokens(v5)).toEqual({ input: 500, output: 100, cached_input: 400 });
    expect(v5[0]!.properties.provider).toBe("openai");
  });

  it("keys are stable per response and token type, so a retried report dedupes", () => {
    const a = usageEventsFromAiResponse(anthropicMessage, { customer: "c", keyPrefix: "req-7" });
    const b = usageEventsFromAiResponse(anthropicMessage, { customer: "c", keyPrefix: "req-7" });
    expect(a.map((e) => e.key)).toEqual(b.map((e) => e.key));
    expect(new Set(a.map((e) => e.key)).size).toBe(a.length);
    expect(a[0]!.key).toBe("req-7:msg_XXXXXXXXXXXX01:input");
  });

  describe("reported cost (OpenRouter usage.cost)", () => {
    const openrouter = (cost: number | undefined) => ({
      ...openaiChat,
      id: "gen-XXXXXXXXXXXX01",
      model: "openai/gpt-4o-mini",
      usage: { ...openaiChat.usage, ...(cost === undefined ? {} : { cost }) },
    });

    it("puts the whole cost on the first event and 0 on the rest, all in USD", () => {
      const ev = usageEventsFromAiResponse(openrouter(0.0123), { customer: "c" });
      expect(ev.map((e) => [e.properties.token_type, e.cost, e.currency])).toEqual([
        ["input", "0.0123", "USD"],
        ["output", "0", "USD"],
        ["cached_input", "0", "USD"],
      ]);
    });

    it("no cost leaves the events unchanged", () => {
      for (const r of [openaiChat, openrouter(undefined)]) {
        const ev = usageEventsFromAiResponse(r, { customer: "c" });
        expect(ev).toHaveLength(3);
        expect(ev.some((e) => "cost" in e || "currency" in e)).toBe(false);
      }
    });

    it("formats a tiny cost without an exponent", () => {
      expect(String(4.2e-7)).toBe("4.2e-7");
      const cost = (v: number) =>
        usageEventsFromAiResponse(openrouter(v), { customer: "c" })[0]!.cost;
      expect(cost(4.2e-7)).toBe("0.00000042");
      expect(cost(0.0000042)).toBe("0.0000042");
      expect(cost(1e-13)).toBe("0");
    });

    it("a zero cost is still a reported cost", () => {
      const ev = usageEventsFromAiResponse(openrouter(0), { customer: "c" });
      expect(ev.every((e) => e.cost === "0" && e.currency === "USD")).toBe(true);
    });
  });

  it("refuses an unknown shape rather than reporting zero", () => {
    expect(() => usageEventsFromAiResponse({} as never, { customer: "c" })).toThrow(TypeError);
  });
});

describe("reportAiUsage", () => {
  it("sends one batch and sends nothing for an empty response", async () => {
    const sent: unknown[] = [];
    const client = {
      usageEvents: {
        sendBatch: async (_biz: string, events: unknown[]) => {
          sent.push(events);
          return { results: [], created: events.length, duplicates: 0, errors: 0 };
        },
      },
    };
    const r = await reportAiUsage(client, "biz_01", openaiChat, { customer: "c" });
    expect(r.created).toBe(3);
    const empty = { ...openaiChat, usage: { prompt_tokens: 0, completion_tokens: 0 } };
    await reportAiUsage(client, "biz_01", empty, { customer: "c" });
    expect(sent).toHaveLength(1);
  });
});
