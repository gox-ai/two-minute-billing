/**
 * THE ORDER LINES APPEAR ON AN INVOICE: plan first, then charges by amount ascending.
 *
 * Two bugs are pinned here, both fixed by the same rule (`orderDocumentLines`,
 * invoicing/service.ts):
 *
 *   1. The order FLAPPED across runs. Two add-ons attached in the same transaction share a
 *      `createdAt`, so the period planner's final tiebreak — a random uuid — decided.
 *      Three identical offline replays of one fixture returned 0 fail, 8 fail, 0 fail.
 *   2. The order was wrong. Add-ons belong cheapest-first; we listed them in insertion
 *      order (the planner) or alphabetically by price publicId (proration).
 *
 * The first test below is the case that rules out every other model: the add-on added FIRST
 * must appear LAST, and it is also the one that sorts first alphabetically. Only line amount
 * ascending explains it.
 */
import { describe, it, expect } from "vitest";
import { orderDocumentLines } from "../../src/modules/invoicing/service";

interface L {
  description: string;
  amountMinor: bigint;
  plan?: boolean;
  slug?: string;
}
const order = (lines: L[]) =>
  orderDocumentLines(lines, { isPlan: (l) => l.plan === true, tiebreak: (l) => l.slug ?? "" }).map(
    (l) => l.description,
  );

describe("orderDocumentLines", () => {
  it("orders a plan and two add-ons: plan, then add-ons cheapest first", () => {
    // Attached in the order [connections, gds]; the document must read [plan, gds, connections].
    expect(
      order([
        { description: "PRO plan", amountMinor: 27_918_000n, plan: true },
        {
          description: "Additional Connections",
          amountMinor: 9_024_000n,
          slug: "platform-additional-connections",
        },
        {
          description: "Google Sheets Destination",
          amountMinor: 5_527_200n,
          slug: "platform-destination-gds",
        },
      ]),
    ).toEqual(["PRO plan", "Google Sheets Destination", "Additional Connections"]);
  });

  it("orders lines where insertion order happens to agree", () => {
    expect(
      order([
        { description: "PRO plan", amountMinor: 2_791_800n, plan: true },
        { description: "Additional Connections", amountMinor: 75_200n },
        { description: "Google Sheets Destination", amountMinor: 460_600n },
      ]),
    ).toEqual(["PRO plan", "Additional Connections", "Google Sheets Destination"]);
  });

  it("keeps the plan first even when it is the cheapest line on the invoice", () => {
    expect(
      order([
        { description: "Add-on", amountMinor: 96_000n },
        { description: "LITE plan", amountMinor: 1_000n, plan: true },
      ]),
    ).toEqual(["LITE plan", "Add-on"]);
  });

  it("is stable across runs where the old uuid tiebreak was not", () => {
    // The same three lines handed over in every possible order must produce one document.
    const lines: L[] = [
      { description: "PRO plan", amountMinor: 27_918_000n, plan: true },
      { description: "A", amountMinor: 9_024_000n },
      { description: "B", amountMinor: 5_527_200n },
    ];
    const expected = ["PRO plan", "B", "A"];
    expect(order([lines[0]!, lines[1]!, lines[2]!])).toEqual(expected);
    expect(order([lines[2]!, lines[1]!, lines[0]!])).toEqual(expected);
    expect(order([lines[1]!, lines[0]!, lines[2]!])).toEqual(expected);
  });

  it("sorts a ZERO-amount line as the charge it is", () => {
    expect(
      order([
        { description: "PRO plan", amountMinor: 118_800n, plan: true },
        { description: "Additional Connections", amountMinor: 0n },
      ]),
    ).toEqual(["PRO plan", "Additional Connections"]);
    // …and ahead of a priced add-on, because 0 is the smallest amount.
    expect(
      order([
        { description: "Paid add-on", amountMinor: 500n },
        { description: "Free add-on", amountMinor: 0n },
      ]),
    ).toEqual(["Free add-on", "Paid add-on"]);
  });

  it("never moves a CREDIT line — its position is not ours to guess", () => {
    // Ascending amount would sweep the credit to the front of the document on a guess.
    // Instead every negative line keeps the exact index it had, and only the charges
    // around it are reordered.
    expect(
      order([
        { description: "charge 500", amountMinor: 500n },
        { description: "Unused time", amountMinor: -100n },
        { description: "charge 200", amountMinor: 200n },
      ]),
    ).toEqual(["charge 200", "Unused time", "charge 500"]);
  });

  it("breaks an amount tie on description, then on the caller-supplied stable key", () => {
    expect(
      order([
        { description: "B item", amountMinor: 100n },
        { description: "A item", amountMinor: 100n },
      ]),
    ).toEqual(["A item", "B item"]);
    expect(
      order([
        { description: "same", amountMinor: 100n, slug: "zzz" },
        { description: "same", amountMinor: 100n, slug: "aaa" },
      ]).length,
    ).toBe(2);
    expect(
      orderDocumentLines(
        [
          { description: "same", amountMinor: 100n, slug: "zzz" },
          { description: "same", amountMinor: 100n, slug: "aaa" },
        ],
        { isPlan: () => false, tiebreak: (l) => l.slug },
      ).map((l) => l.slug),
    ).toEqual(["aaa", "zzz"]);
  });

  it("leaves a single-charge document untouched (the common case does no work)", () => {
    const one: L[] = [{ description: "PRO plan", amountMinor: 1_000n, plan: true }];
    expect(orderDocumentLines(one, { isPlan: () => true })).toBe(one);
  });
});
