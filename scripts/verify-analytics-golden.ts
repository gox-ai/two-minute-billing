/**
 * The analytics rewrite's safety net: every captured payload must come back unchanged.
 *
 * Re-seeds the fixture `capture-analytics-golden.ts` froze, recomputes every report, every
 * analytics range and the metrics payload, and compares against `test/golden/analytics/`.
 * A missing file and an extra one both fail — a report that stops answering is exactly the
 * regression a rewrite makes, and an empty comparison would pass.
 *
 * The stored file is re-serialised through the SAME canonicaliser before the comparison, so
 * the gate asserts VALUES and not the bytes that happen to hold them: a formatter run over
 * `test/golden/` reflowed every short array and the byte comparison read that as 86 changed
 * reports. `serialise` is the one authority on the shape.
 *
 *   pnpm verify:analytics-golden
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { closeDb } from "@/platform/db";
import {
  GOLDEN_DIR,
  captureAll,
  goldenFence,
  releaseGoldenFence,
  seedGoldenBook,
  serialise,
} from "./lib/analytics-golden";

/** How many differing lines to print per file, and how many failing files to detail. */
const MAX_DIFF_LINES = 12;
const MAX_DETAILED_FILES = 5;

const stored = new Map<string, string>();
for (const f of (await readdir(GOLDEN_DIR).catch(() => [])).filter((f) => f.endsWith(".json"))) {
  const name = f.replace(/\.json$/, "");
  const raw = await readFile(join(GOLDEN_DIR, f), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`❌ ANALYTICS-GOLDEN: FAIL — ${f} is not valid JSON`);
    process.exit(1);
  }
  stored.set(name, serialise(parsed));
}
if (stored.size === 0) {
  console.error(`❌ ANALYTICS-GOLDEN: FAIL — no golden files in ${GOLDEN_DIR}/`);
  console.error("   capture them first: pnpm tsx scripts/capture-analytics-golden.ts");
  process.exit(1);
}

/** `GOLDEN_FENCE_DEBUG=1` prints the fence row before the capture and after its release. */
const fenceDebug = process.env.GOLDEN_FENCE_DEBUG === "1";
const showFence = async (when: string) =>
  console.log(`   fence ${when}: ${JSON.stringify(await goldenFence(book))}`);

const book = await seedGoldenBook();
if (fenceDebug) await showFence("after seed");

/**
 * The fence comes off in a `finally`. A `time_travels` row that outlives the run would
 * fence the live clock away from that business forever — a worse bug than the flake.
 */
const actual = await (async () => {
  try {
    return await captureAll(book);
  } finally {
    await releaseGoldenFence(book);
    if (fenceDebug) await showFence("after release");
  }
})();

/** A unified diff of the two payloads, trimmed to the first differing lines. */
function diff(expected: string, got: string): string[] {
  const a = expected.split("\n");
  const b = got.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < MAX_DIFF_LINES; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`    - ${a[i]!.trim()}`);
    if (b[i] !== undefined) out.push(`    + ${b[i]!.trim()}`);
  }
  return out;
}

const failures: Array<[string, string[]]> = [];
let passed = 0;

for (const [name, payload] of actual) {
  const expected = stored.get(name);
  stored.delete(name);
  if (expected === undefined) {
    failures.push([name, ["    (no golden file — recapture if this report is new)"]]);
    continue;
  }
  const got = serialise(payload);
  if (got === expected) {
    passed++;
    continue;
  }
  failures.push([name, diff(expected, got)]);
}
for (const name of stored.keys()) {
  failures.push([name, ["    (golden file has no payload — the report no longer answers)"]]);
}

for (const [name] of failures) console.log(`FAIL ${name}`);
console.log(`PASS ${passed} payload(s)`);

if (failures.length > 0) {
  console.log("");
  for (const [name, lines] of failures.slice(0, MAX_DETAILED_FILES)) {
    console.log(`── ${name}.json`);
    for (const l of lines) console.log(l);
  }
  if (failures.length > MAX_DETAILED_FILES) {
    console.log(`… and ${failures.length - MAX_DETAILED_FILES} more differing file(s)`);
  }
}

console.log("");
const verdict = failures.length === 0;
console.log(
  verdict
    ? `✅ ANALYTICS-GOLDEN: PASS (${passed}/${passed} payloads identical)`
    : `❌ ANALYTICS-GOLDEN: FAIL (${failures.length} differ, ${passed} identical)`,
);
await closeDb();
process.exit(verdict ? 0 : 1);
