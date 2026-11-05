import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@/modules/events/registry";
import { MAX_DELIVERY_ATTEMPTS, BACKOFF_SECONDS } from "@/modules/webhooks/outbox";
import {
  OUT_PATH,
  renderWebhookReference,
  uncoveredFamilies,
} from "../../scripts/gen-webhook-reference";

type Doc = {
  event_count: number;
  delivery: { max_attempts: number; backoff_seconds: number[] };
  families: { key: string; summary: string | null; events: { type: string }[] }[];
};

/**
 * The published webhook reference is generated, so what needs guarding is that it is
 * REgenerated. The engine is free to add an event type; it is not free to add one that
 * the documentation does not list, or to change the retry schedule the page promises.
 */
describe("published webhook reference", () => {
  const committed = () => JSON.parse(readFileSync(OUT_PATH, "utf8")) as Doc;

  it("matches what pnpm gen:webhook-reference would write", () => {
    expect(readFileSync(OUT_PATH, "utf8")).toBe(renderWebhookReference());
  });

  it("lists every event type exactly once", () => {
    const listed = committed().families.flatMap((f) => f.events.map((e) => e.type));
    expect([...listed].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("promises the retry schedule the deliverer actually runs", () => {
    // The page states both numbers. If outbox.ts changes them and this file does not,
    // the documentation is lying about when a subscriber will be called again.
    expect(committed().delivery.max_attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(committed().delivery.backoff_seconds).toEqual([...BACKOFF_SECONDS]);
  });

  it("has a customer-facing summary for every family", () => {
    // A new family reaching the published page unnamed is the failure this prevents:
    // the registry's own note is written for us and never renders.
    expect(uncoveredFamilies()).toEqual([]);
  });
});
