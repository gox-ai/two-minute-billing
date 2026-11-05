/**
 * Proves the dashboard's date-ENTRY timezone math (`dashboard/lib/tz.ts`) is correct and
 * agrees with the engine's own day-boundary math (`src/platform/clock.ts`).
 *
 * Those two live in separate packages and cannot import each other — `platform/clock.ts`
 * pulls in AsyncLocalStorage + drizzle, so it can never reach a client bundle, and the
 * offset function is therefore duplicated. This suite is what keeps the copies honest: if
 * they ever disagree, an operator picking a term end in the dashboard would land on a
 * different instant than the engine's own start-of-day for that same local date.
 *
 * Covers the round trip (entry → UTC → prefill), DST transitions in both directions, the
 * half-hour and 45-minute zones that break naive offset math, and the form guard.
 *
 *   pnpm verify:dashboard-tz
 */
import {
  LEGACY_TO_MODERN as DASH_LEGACY,
  toModernZone,
  dateOnlyToUtcISO,
  parseUtcFromForm,
  utcToDateValue,
  utcToWallClockValue,
  wallClockToUtc,
} from "../dashboard/lib/tz";
import { startOfDayInTz } from "@/platform/clock";
import { InvalidTimezoneError, LEGACY_TO_MODERN, normalizeTimezone } from "@/platform/timezones";

let failures = 0;
function ok(label: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. The wall clock the operator types resolves to the instant they mean ──────────
console.log("\n1. business-timezone entry → UTC");
const cases: Array<[string, string, string]> = [
  // [typed wall clock, zone, expected UTC]
  ["2026-08-21T00:00", "Asia/Kolkata", "2026-08-20T18:30:00.000Z"], // +5:30, the parity site
  ["2026-08-21T00:00", "UTC", "2026-08-21T00:00:00.000Z"],
  ["2026-08-21T00:00", "America/New_York", "2026-08-21T04:00:00.000Z"], // EDT, -4
  ["2026-01-21T00:00", "America/New_York", "2026-01-21T05:00:00.000Z"], // EST, -5
  ["2026-08-21T00:00", "Asia/Kathmandu", "2026-08-20T18:15:00.000Z"], // +5:45 — a 45-min zone
  ["2026-08-21T13:45", "Australia/Adelaide", "2026-08-21T04:15:00.000Z"], // +9:30
  ["2026-08-21T00:00", "Pacific/Kiritimati", "2026-08-20T10:00:00.000Z"], // +14, the extreme
];
for (const [local, tz, expected] of cases) {
  const got = wallClockToUtc(local, tz);
  ok(`${local} in ${tz}`, got?.toISOString() === expected, got?.toISOString() ?? "null");
}

// ── 2. Round trip: what we store renders back as what was typed ─────────────────────
console.log("\n2. round trip (typed → UTC → prefill)");
for (const [local, tz] of cases.map(([l, t]) => [l, t] as const)) {
  const utc = wallClockToUtc(local, tz)!;
  ok(
    `${local} in ${tz} survives the round trip`,
    utcToWallClockValue(utc, tz) === local,
    utcToWallClockValue(utc, tz),
  );
}

// ── 3. Agreement with the engine's start-of-day ─────────────────────────────────────
// A `type="date"` pick means "that whole day in the business zone", which must be the
// SAME instant the engine anchors a day-aligned term to.
console.log("\n3. dateOnlyToUtcISO === platform/clock startOfDayInTz");
for (const tz of [
  "Asia/Kolkata",
  "UTC",
  "America/New_York",
  "Asia/Kathmandu",
  "Europe/Berlin",
  "Pacific/Kiritimati",
]) {
  for (const day of ["2026-01-15", "2026-03-29", "2026-07-31", "2026-11-01"]) {
    const fromDashboard = dateOnlyToUtcISO(day, tz)!;
    // Feed the engine an instant inside that local day and ask for its start.
    const fromEngine = startOfDayInTz(new Date(fromDashboard), tz).toISOString();
    if (fromDashboard !== fromEngine) {
      ok(`${tz} ${day}`, false, `dashboard=${fromDashboard} engine=${fromEngine}`);
    }
  }
}
ok("all zone/day combinations agree", failures === 0);

// ── 4. DST edges ────────────────────────────────────────────────────────────────────
// Berlin springs forward 2026-03-29 02:00 (02:00–03:00 does not exist) and falls back
// 2026-10-25 03:00 (02:00–03:00 happens twice). Neither may produce a wrong DAY.
console.log("\n4. DST transitions");
ok(
  "spring-forward day starts at 23:00Z the previous day",
  dateOnlyToUtcISO("2026-03-29", "Europe/Berlin") === "2026-03-28T23:00:00.000Z",
  String(dateOnlyToUtcISO("2026-03-29", "Europe/Berlin")),
);
ok(
  "fall-back day starts at 22:00Z the previous day",
  dateOnlyToUtcISO("2026-10-25", "Europe/Berlin") === "2026-10-24T22:00:00.000Z",
  String(dateOnlyToUtcISO("2026-10-25", "Europe/Berlin")),
);
// 02:30 on the spring-forward day is a nonexistent wall clock. Any resolution is
// defensible; landing on the WRONG DAY is not.
const nonexistent = wallClockToUtc("2026-03-29T02:30", "Europe/Berlin");
ok(
  "a nonexistent wall clock still resolves to the right day",
  !!nonexistent && utcToDateValue(nonexistent, "Europe/Berlin") === "2026-03-29",
  nonexistent ? utcToDateValue(nonexistent, "Europe/Berlin") : "null",
);

// ── 5. The server-action guard ───────────────────────────────────────────────────────
console.log("\n5. parseUtcFromForm rejects a zone-less wall clock");
ok("rejects a bare datetime-local value", parseUtcFromForm("2026-08-21T00:00") === null);
ok("rejects a bare date", parseUtcFromForm("2026-08-21") === null);
ok("rejects empty", parseUtcFromForm("") === null);
ok(
  "accepts …Z",
  parseUtcFromForm("2026-08-20T18:30:00.000Z")?.toISOString() === "2026-08-20T18:30:00.000Z",
);
ok(
  "accepts an explicit offset",
  parseUtcFromForm("2026-08-21T00:00:00+05:30")?.toISOString() === "2026-08-20T18:30:00.000Z",
);

// ── 6. Blank / malformed input stays blank instead of becoming epoch ─────────────────
console.log("\n6. blanks and malformed values");
ok("blank prefill → empty string", utcToWallClockValue(null, "Asia/Kolkata") === "");
ok("malformed prefill → empty string", utcToWallClockValue("not-a-date", "Asia/Kolkata") === "");
ok("malformed entry → null (never epoch)", wallClockToUtc("not-a-date", "Asia/Kolkata") === null);

// ── 7. Modern IANA names only, front and back ────────────────────────────────────────
console.log("\n7. modern timezone names only");

// The two rename maps are duplicated because the packages cannot import each other.
const dashKeys = Object.keys(DASH_LEGACY).sort();
const srvKeys = Object.keys(LEGACY_TO_MODERN).sort();
ok(
  "the dashboard and backend rename maps are identical",
  JSON.stringify(dashKeys.map((k) => [k, DASH_LEGACY[k]])) ===
    JSON.stringify(srvKeys.map((k) => [k, LEGACY_TO_MODERN[k]])),
  `dashboard=${dashKeys.length} backend=${srvKeys.length}`,
);

// The strong one: whatever THIS runtime calls canonical must normalize to a modern name.
// An ICU update that introduces a new legacy canonical fails here instead of quietly
// storing it. (Node 22 / Chrome 148 list ten such zones.)
{
  const listed = Intl.supportedValuesOf("timeZone");
  const stillLegacy = listed.map((z) => normalizeTimezone(z)).filter((z) => z in LEGACY_TO_MODERN);
  ok(
    `no runtime-listed zone normalizes to a legacy name (${listed.length} zones checked)`,
    stillLegacy.length === 0,
    stillLegacy.slice(0, 5).join(", "),
  );
  const legacyListed = listed.filter((z) => z in LEGACY_TO_MODERN);
  console.log(
    `     (${legacyListed.length} legacy canonicals in this ICU: ${legacyListed.join(", ")})`,
  );
}

ok(
  "Asia/Calcutta normalizes to Asia/Kolkata",
  normalizeTimezone("Asia/Calcutta") === "Asia/Kolkata",
);
ok("Asia/Kolkata is already modern", normalizeTimezone("Asia/Kolkata") === "Asia/Kolkata");
ok("Europe/Kiev normalizes to Europe/Kyiv", normalizeTimezone("Europe/Kiev") === "Europe/Kyiv");
ok("UTC survives", normalizeTimezone("UTC") === "UTC");
ok("the dashboard agrees on the modern name", toModernZone("Asia/Calcutta") === "Asia/Kolkata");

// Values `Intl` accepts but we must never store.
for (const [bad, why] of [
  ["+05:30", "fixed offset"],
  ["GMT+5", "fixed offset"],
  ["IST", "abbreviation"],
  ["EST", "abbreviation"],
  ["Mars/Olympus", "unknown"],
] as const) {
  let rejected = false;
  try {
    normalizeTimezone(bad);
  } catch (e) {
    rejected = e instanceof InvalidTimezoneError;
  }
  ok(`rejects '${bad}' (${why})`, rejected);
}

// ── 8. "Next billing" labels must be fed by `next_billing_at` ───────────────────────
// `current_period_end` is serialized INCLUSIVELY (the last second of the final day) —
// display-correct for a "Billing period ends" row, but a day early for "when is this
// customer charged again?". `next_billing_at` (src/modules/subscriptions/serialize.ts:
// ~347) is the only field the serializer documents as answering that question, and is
// deliberately NOT run through the inclusive-boundary helper. This bug has appeared in
// three dashboard files and been fixed in two (subscriptions/[sub]/page.tsx,
// customers/[cus]/page.tsx) before invoices/[inv]/page.tsx made it a third — this scan
// is what stops a fourth.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A genuine UI label — a quoted string reading "next billing", the words adjacent (as
 * in "Next billing date" / "Next Billing At" / "next-billing"). A loose /next.*billing/i
 * across a whole sentence also matched normal prose like "the next renewal invoice
 * instead of billing now" — not a label at all — so the gap between the two words is
 * kept tight rather than open-ended.
 */
const NEXT_BILLING_LABEL = /["'][^"'\n]{0,20}next[\s-]{1,3}billing[^"'\n]{0,40}["']/i;

/**
 * Finds a "next … billing" LABEL (a quoted string, e.g. `"Next billing date"` — not a
 * comment; several files discuss `current_period_end`'s inclusive-boundary problem in
 * prose, and that discussion must not itself trip the gate) in a file that also reads
 * `current_period_end` and does NOT read `next_billing_at` anywhere in the same file.
 * File-scoped rather than a line window: the correct value can be resolved by a
 * same-file helper defined far from the label (e.g. `subscriptions-table.tsx`'s
 * `nextBillingAt()`, which prefers `next_billing_at` and only falls back to
 * `current_period_end` when it's null — legitimate, and `next_billing_at` appears in
 * that same file, so it does not trip this). Returns one message per offending label
 * line, so it works identically against a real file and an in-memory fixture (the
 * self-test right below proves it actually catches the bug).
 */
function findNextBillingBugs(file: string, src: string): string[] {
  if (!NEXT_BILLING_LABEL.test(src)) return [];
  if (!/current_period_end/.test(src) || /next_billing_at/.test(src)) return [];
  const found: string[] = [];
  src.split("\n").forEach((line, i) => {
    if (NEXT_BILLING_LABEL.test(line)) found.push(`${file}:${i + 1} — ${line.trim()}`);
  });
  return found;
}

console.log('\n8. "Next billing" labels use next_billing_at, not current_period_end');

// Self-test FIRST: prove the detector actually fires on the pre-fix shape before
// trusting it to clear the real files. This is exactly the bug this invoices page
// carried before it was fixed — if this ever stops failing, the detector is broken,
// not the codebase.
const preFixFixture = `
                  sub?.current_period_end
                    ? { label: "Next billing date", value: fmtDate(sub.current_period_end, tz) }
                    : null,
`;
const postFixFixture = `
                  sub?.next_billing_at
                    ? { label: "Next billing date", value: fmtDate(sub.next_billing_at, tz) }
                    : null,
`;
ok(
  "self-test: detector catches the pre-fix expression (current_period_end, no next_billing_at)",
  findNextBillingBugs("<fixture>", preFixFixture).length === 1,
);
ok(
  "self-test: detector clears the fixed expression (next_billing_at)",
  findNextBillingBugs("<fixture>", postFixFixture).length === 0,
);

// The real scan.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}
const dashboardFiles = ["dashboard/app", "dashboard/components"].flatMap((r) => walk(r));
const bugs = dashboardFiles.flatMap((f) => findNextBillingBugs(f, readFileSync(f, "utf8")));
ok(
  `no "next … billing" label reads current_period_end without next_billing_at (${dashboardFiles.length} files scanned)`,
  bugs.length === 0,
  bugs.join("; "),
);
for (const b of bugs) console.log(`     ✗ ${b}`);

console.log("");
console.log(
  failures === 0 ? "✅ DASHBOARD TZ: PASS" : `❌ DASHBOARD TZ: FAIL (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
