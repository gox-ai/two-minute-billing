/**
 * #43 · the three capture-verdict LOG EVENT NAMES are a PUBLIC contract.
 *
 * `reconcileUnmatchedCapture` (`webhooks/inbound.ts`) splits a capture we hold no row
 * for three ways (#31) and logs one event name per verdict. Those names are what every
 * grep, dashboard filter and alert built on this money path keys on — including
 * `unappliedGatewayMoney`'s own remediation sentence, which tells an operator to grep
 * one of them BY NAME.
 *
 * ⚠️ WHY THIS FILE IS PART STATIC. `verify:ops-alerts` and `verify:webhooks` lock the
 * three COUNTERS and the verdict, but neither has a log sink, and a runtime one is not
 * available: pino's `pino-pretty` transport runs in a worker thread and writes to the
 * fd directly, bypassing `process.stdout.write`, so a capture-and-assert would pass or
 * fail for the wrong reason. `reconcileUnmatchedCapture` is also module-private and
 * DB-backed, so it cannot be driven from a unit test at all. So the contract is locked
 * two ways instead, and the difference matters when reading a failure:
 *
 *   · BY VALUE (real code): the exported name map, and the map composed with the real
 *     `classifyUnmatchedCapture`. Renaming a name, or swapping two of them, is a real
 *     assertion failure about real behaviour.
 *   · BY SOURCE TEXT: that the three call sites still index the map with the verdict
 *     they just computed, at the level each verdict is meant to log at. This asserts
 *     the SHAPE OF THE SOURCE, not observed behaviour — it is what catches a site that
 *     stops using the constant, or a guard/level that gets swapped.
 *
 * Precedent for the source scan: `razorpay-ownership.test.ts` regexes every `POST`
 * path out of the adapter and fails on an unclassified one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UNMATCHED_CAPTURE_EVENTS, classifyUnmatchedCapture } from "@/modules/webhooks/inbound";

const INBOUND = resolve(__dirname, "../../src/modules/webhooks/inbound.ts");

const inboundSrc = () => readFileSync(INBOUND, "utf8");

/**
 * The if / else-if / else chain that logs the verdict, sliced out by its two ends. Both
 * anchors are real code (not comment prose), so a reformat cannot move them apart.
 */
function verdictLogRegion(): string {
  const src = inboundSrc();
  const start = src.indexOf("const provenance = classifyUnmatchedCapture(ev);");
  expect(start, "anchor lost: the classifier call moved — re-anchor this scan").toBeGreaterThan(-1);
  const end = src.indexOf('return "ignored";', start);
  expect(end, 'anchor lost: the branch no longer ends in `return "ignored"`').toBeGreaterThan(
    start,
  );
  return src.slice(start, end);
}

describe("#43 · capture-verdict log event names", () => {
  // ── BY VALUE ──────────────────────────────────────────────────────────────
  //
  // The literal strings, one assertion each, because a rename is the failure mode
  // this defect is about. Note `unclassified` → `…_unattributable`: the verdict and
  // the event name deliberately DISAGREE (the original name was kept so existing
  // greps keep working), which is exactly the pair a well-meaning "consistency"
  // rename would break.
  it("keeps the three literal names it published", () => {
    expect(UNMATCHED_CAPTURE_EVENTS.ours_unattributed).toBe("unmatched_capture_ours_unattributed");
    expect(UNMATCHED_CAPTURE_EVENTS.foreign).toBe("unmatched_capture_foreign");
    expect(UNMATCHED_CAPTURE_EVENTS.unclassified).toBe("unmatched_capture_unattributable");
  });

  it("covers every verdict and nothing else, and cannot be reassigned at runtime", () => {
    // Keyed by `CaptureProvenance`, so a fourth verdict added to the union without a
    // name fails the type check, and a stray key fails here.
    expect(Object.keys(UNMATCHED_CAPTURE_EVENTS).sort()).toEqual([
      "foreign",
      "ours_unattributed",
      "unclassified",
    ]);
    expect(Object.isFrozen(UNMATCHED_CAPTURE_EVENTS)).toBe(true);
    // Three distinct names — an alert keyed on one of them must not receive another's.
    expect(new Set(Object.values(UNMATCHED_CAPTURE_EVENTS)).size).toBe(3);
  });

  /**
   * The pairing, through the REAL classifier: what a given gateway fact is named. This
   * is the composition the call site performs (`UNMATCHED_CAPTURE_EVENTS[provenance]`
   * where `provenance = classifyUnmatchedCapture(ev)`), so swapping two entries in the
   * map turns these red as well as the value assertions above.
   */
  it("names the verdict the classifier actually reaches", () => {
    // Ages kept only to prove the verdict no longer depends on them (rollout gate removed).
    const after = new Date();
    const before = new Date("2020-01-01T00:00:00.000Z");
    const name = (ev: Parameters<typeof classifyUnmatchedCapture>[0]) =>
      UNMATCHED_CAPTURE_EVENTS[classifyUnmatchedCapture(ev)];

    // Our tag on an object we have no row for — the one that pages.
    expect(name({ ownership: "ours", providerObjectCreatedAt: after })).toBe(
      "unmatched_capture_ours_unattributed",
    );
    // A read absence on an object young enough for absence to mean something.
    expect(name({ ownership: "foreign", providerObjectCreatedAt: after })).toBe(
      "unmatched_capture_foreign",
    );
    // Same read absence on an OLD object. INVERTED 2026-09-04 with the rollout gate's
    // removal: it used to be `unattributable`, on the reasoning that a pre-tagging object
    // was untagged for our own reasons. Now a tag read is the verdict at any age.
    expect(name({ ownership: "foreign", providerObjectCreatedAt: before })).toBe(
      "unmatched_capture_foreign",
    );
    // We learned nothing at all.
    expect(name({ ownership: "unknown", providerObjectCreatedAt: after })).toBe(
      "unmatched_capture_unattributable",
    );
    // No date at all. Also INVERTED 2026-09-04: there is no age bar left to clear, so the
    // tag read stands on its own and a missing date cannot downgrade it.
    expect(name({ ownership: "foreign", providerObjectCreatedAt: null })).toBe(
      "unmatched_capture_foreign",
    );
  });

  // ── BY SOURCE TEXT ────────────────────────────────────────────────────────

  it("logs all three verdicts through the map and never a bare literal", () => {
    const region = verdictLogRegion();
    // Every site indexes the map with the verdict it just computed. A site that
    // hardcodes a key (`…EVENTS.foreign` inside the `ours_unattributed` branch) or
    // re-inlines a string drops this count.
    expect(region.match(/UNMATCHED_CAPTURE_EVENTS\[provenance\]/g)?.length ?? 0).toBe(3);
    // And no event-name literal survives anywhere in the branch.
    expect(region.match(/"unmatched_capture_[a-z_]+"/g)).toBeNull();
  });

  /**
   * The whole file may quote each name exactly ONCE — in the map. Anything else is a
   * second definition or a call site that stopped using the constant.
   *
   * Prose in this codebase quotes identifiers in backticks, so a comment mentioning a
   * name does not count; a new comment that uses double quotes will trip this and
   * should be reworded rather than exempted.
   */
  it("defines each name in exactly one place", () => {
    const src = inboundSrc();
    for (const name of Object.values(UNMATCHED_CAPTURE_EVENTS)) {
      const quoted = src.match(new RegExp(`"${name}"`, "g"))?.length ?? 0;
      expect(quoted, `"${name}" is quoted ${quoted}× in inbound.ts`).toBe(1);
    }
  });

  /**
   * Verdict ↔ LEVEL, positionally. The level is not decoration: `ours_unattributed` is
   * the only one of the three that PAGES, `foreign` is deliberately `info` (a sibling
   * product's money on a shared merchant account, nothing for anyone to do), and
   * `unclassified` is the `warn` the split inherited. Swapping a guard or a level is
   * the "a verdict logs as the wrong one of the three" mutation, and only the order of
   * these tokens can see it.
   */
  it("keeps each verdict on its own log level, in order", () => {
    const region = verdictLogRegion();
    const levels = [...region.matchAll(/\blog\.(error|info|warn)\(/g)].map((m) => m[1]);
    expect(levels).toEqual(["error", "info", "warn"]);
    const guards = [...region.matchAll(/provenance === "([a-z_]+)"/g)].map((m) => m[1]);
    // The third branch is a bare `else` on purpose — the union is closed, and an
    // `unclassified` guard would let a fourth verdict fall through logging nothing.
    expect(guards).toEqual(["ours_unattributed", "foreign"]);
    // Interleaved: guard, its call, next guard, its call, then the fallthrough's.
    const at = (re: RegExp) => region.search(re);
    expect(at(/provenance === "ours_unattributed"/)).toBeLessThan(at(/\blog\.error\(/));
    expect(at(/\blog\.error\(/)).toBeLessThan(at(/provenance === "foreign"/));
    expect(at(/provenance === "foreign"/)).toBeLessThan(at(/\blog\.info\(/));
    expect(at(/\blog\.info\(/)).toBeLessThan(at(/\blog\.warn\(/));
  });

  /**
   * The line has to carry what the alert tells an operator to look for. `ownershipRef`
   * is the public id `createIntent` minted before it crashed — for `ours_unattributed`
   * there is no local row, so that ref is the ONLY handle, and the remediation sentence
   * says to grep the event name for it.
   */
  it("carries the reconstructible verdict on the line", () => {
    // The `facts` OBJECT LITERAL, not the branch around it. Scanning the branch was the
    // first cut and it passed with the field deleted: the `ours_unattributed` comment
    // names `ownershipRef` in prose, so the identifier was still "present" while the
    // field was gone. Only the `key:` shape inside the literal is evidence.
    const region = verdictLogRegion();
    const open = region.indexOf("const facts = {");
    expect(open, "anchor lost: the shared `facts` object was renamed").toBeGreaterThan(-1);
    const close = region.indexOf("\n    };", open);
    expect(close, "anchor lost: `facts` no longer closes at its own indent").toBeGreaterThan(open);
    const facts = region.slice(open, close);
    for (const key of ["provenance", "ownership", "ownershipRef", "objectCreatedAt"]) {
      // `key:` or the shorthand `key,` — `provenance` is passed shorthand.
      expect(facts, `${key} must stay on the verdict log line`).toMatch(
        new RegExp(`\\b${key}\\s*[:,]`),
      );
    }
  });
});
