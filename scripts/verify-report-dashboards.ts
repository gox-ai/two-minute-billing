/**
 * Saved report dashboards: the rules that live in code + constraints and that no
 * typecheck can see.
 *
 * Sections:
 *   §1 CREATE AND READ BACK — public id prefixes, tile order, what a tile stores.
 *   §2 WRITE-TIME VALIDATION — a tile is refused unless the catalogue would answer it:
 *      unknown key, a granularity on a report with no series, a breakdown it does not
 *      offer, a range that is not a preset.
 *   §3 TENANCY — another organization sees nothing, by RLS and by scope.
 *   §4 VISIBILITY — private is invisible to a colleague; `everyone` is visible.
 *   §5 OWNERSHIP — a non-owner cannot rename, re-share, default, delete or re-tile.
 *   §6 UNIQUENESS — the COALESCE'd name index, asserted on an ORG-LEVEL dashboard where a
 *      plain unique index over a NULL business_id would let the duplicate through.
 *   §7 DEFAULT EXCLUSIVITY — the second default moves the flag rather than erroring.
 *   §8 TILES — add, patch, remove, reorder (whole-list, every tile exactly once).
 *   §9 AN UNAVAILABLE TILE — a key that has left the registry is REPORTED, never blanked
 *      and never dropped.
 *   §10 THE WHOLE-DASHBOARD FETCH — one request, one answer per tile, and an org-level
 *      dashboard that needs a business named.
 *   §11 THE BUILT-IN PRESETS — declared in code, and every tile answered THROUGH THE
 *      SEMANTIC LAYER, which is what a board resolves its tiles with.
 *   §12 PER-OWNER CAP — 50 stored dashboards per person per organization, counted across
 *      businesses and org-level; presets do not count.
 *
 * ⚠️ Seeds its own org; safe on the dev database.
 *   pnpm verify:report-dashboards
 */
import { withTenant, closeDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { reportDashboardTiles } from "@db/schema";
import { REPORTS } from "@/modules/metrics/reports/registry";
import {
  PRESET_DASHBOARDS,
  assertPresetsAreWellFormed,
  presetPublicId,
} from "@/modules/metrics/dashboards/presets";
import {
  addTile,
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  removeTile,
  reorderTiles,
  resolveDashboard,
  serializeDashboard,
  updateDashboard,
  updateTile,
  ReportDashboardError,
  ReportDashboardNameTakenError,
  MAX_DASHBOARDS_PER_OWNER,
} from "@/modules/metrics/dashboards/service";

let ok = 0;
let fail = 0;
const check = (label: string, pass: boolean, detail?: string) => {
  if (pass) {
    ok++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const eq_ = (label: string, actual: unknown, expected: unknown) =>
  check(label, String(actual) === String(expected), `got ${actual}, want ${expected}`);

/** Assert a call rejects with a particular error class, not merely that it failed. */
async function rejects(
  label: string,
  cls: new (...a: never[]) => Error,
  fn: () => Promise<unknown>,
) {
  try {
    await fn();
    check(label, false, "resolved — expected a rejection");
  } catch (e) {
    check(label, e instanceof cls, `threw ${(e as Error).name}: ${(e as Error).message}`);
  }
}

/**
 * The SAVED dashboards only.
 *
 * Every org now also lists the built-in presets (§11), so a bare `.length` answers a
 * different question from the one these sections ask — "did one of OUR dashboards leak" is
 * about stored rows, not about defaults that exist everywhere by construction.
 */
const saved = (rows: Array<{ dashboard: { publicId: string } }>) =>
  rows.filter((r) => !r.dashboard.publicId.startsWith("dash_preset_"));

const alice = "alice@example.test";
const bob = "bob@example.test";

const org = await createOrganization({ name: "Report Dashboards Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Dashboards Co",
  defaultCurrency: "INR",
  livemode: "test",
});
const scope = { organizationId: orgId, businessId: biz.id };

// ── §1 CREATE AND READ BACK ───────────────────────────────────────────────────────────
console.log("\n§1 create and read back");
const morning = await createDashboard({
  ...scope,
  name: "Morning numbers",
  owner: alice,
  tiles: [
    { reportKey: "total_mrr", size: "lg" },
    { reportKey: "total_new_mrr", currency: "inr", groupBy: "plan", range: "3m" },
  ],
});
check(
  "a dashboard gets a dash_ public id",
  morning.dashboard.publicId.startsWith("dash_"),
  morning.dashboard.publicId,
);
check(
  "a tile gets a dtile_ public id",
  morning.tiles.every((t) => t.publicId.startsWith("dtile_")),
  morning.tiles.map((t) => t.publicId).join(","),
);
eq_(
  "tiles keep the order they were given",
  morning.tiles.map((t) => t.reportKey).join(","),
  "total_mrr,total_new_mrr",
);
eq_("positions are 0-based and dense", morning.tiles.map((t) => t.position).join(","), "0,1");
eq_("a currency is stored upper-cased", morning.tiles[1]!.currency, "INR");
eq_("an unpinned option is stored NULL, not ''", morning.tiles[0]!.range, null);
eq_("visibility defaults to private", morning.dashboard.visibility, "private");

const readBack = await getDashboard(orgId, morning.dashboard.publicId, alice);
eq_("the owner reads their own dashboard back", readBack?.tiles.length, 2);

// ── §2 WRITE-TIME VALIDATION ──────────────────────────────────────────────────────────
console.log("\n§2 write-time validation against the catalogue");
await rejects("a tile naming no such report is refused", ReportDashboardError, () =>
  createDashboard({
    ...scope,
    name: "Bad key",
    owner: alice,
    tiles: [{ reportKey: "no_such_report" }],
  }),
);
await rejects(
  "a granularity on a report with no series to re-cut is refused",
  ReportDashboardError,
  () =>
    createDashboard({
      ...scope,
      name: "Bad granularity",
      owner: alice,
      tiles: [{ reportKey: "mrr_movement_summary", granularity: "day" }],
    }),
);
await rejects("a breakdown the report does not offer is refused", ReportDashboardError, () =>
  createDashboard({
    ...scope,
    name: "Bad group",
    owner: alice,
    tiles: [{ reportKey: "total_mrr", groupBy: "plan" }],
  }),
);
await rejects("a range that is not a preset is refused", ReportDashboardError, () =>
  createDashboard({
    ...scope,
    name: "Bad range",
    owner: alice,
    tiles: [{ reportKey: "total_mrr", range: "since_forever" }],
  }),
);
await rejects("a dashboard with no name is refused", ReportDashboardError, () =>
  createDashboard({ ...scope, name: "   ", owner: alice }),
);

// ── §3 TENANCY ────────────────────────────────────────────────────────────────────────
console.log("\n§3 tenancy");
const other = await createOrganization({ name: "Somebody Else Ltd" });
const otherId = other.organization.id;
const otherBiz = await createBusiness({
  organizationId: otherId,
  name: "Not Yours Co",
  defaultCurrency: "USD",
  livemode: "test",
});
eq_(
  "another organization lists nothing of ours",
  saved(await listDashboards(otherId, otherBiz.id, alice)).length,
  0,
);
eq_(
  "another organization cannot fetch our dashboard by id",
  await getDashboard(otherId, morning.dashboard.publicId, alice),
  null,
);
check(
  "another organization cannot delete our dashboard",
  (await deleteDashboard(otherId, morning.dashboard.publicId, alice)) === false,
);

// ── §4 VISIBILITY ─────────────────────────────────────────────────────────────────────
console.log("\n§4 visibility");
eq_(
  "a private dashboard is invisible to a colleague",
  saved(await listDashboards(orgId, biz.id, bob)).length,
  0,
);
eq_(
  "a colleague cannot fetch a private dashboard by id",
  await getDashboard(orgId, morning.dashboard.publicId, bob),
  null,
);
const team = await createDashboard({
  ...scope,
  name: "Team weekly",
  owner: alice,
  visibility: "everyone",
  tiles: [{ reportKey: "total_mrr" }],
});
const bobSees = saved(await listDashboards(orgId, biz.id, bob));
eq_("a shared dashboard is visible to the organization", bobSees.length, 1);
eq_("and only the shared one", bobSees[0]!.dashboard.publicId, team.dashboard.publicId);
// `is_mine` is resolved from the session actor, never from an email the client holds.
const asBob = await getDashboard(orgId, team.dashboard.publicId, bob);
const asAlice = await getDashboard(orgId, team.dashboard.publicId, alice);
eq_(
  "is_mine is false for a colleague's shared dashboard",
  serializeDashboard(asBob!.dashboard, asBob!.tiles, bob).is_mine,
  false,
);
eq_(
  "is_mine is true for its owner",
  serializeDashboard(asAlice!.dashboard, asAlice!.tiles, alice).is_mine,
  true,
);

// ── §5 OWNERSHIP ──────────────────────────────────────────────────────────────────────
console.log("\n§5 ownership — visible is not editable");
eq_(
  "a colleague cannot rename a shared dashboard",
  await updateDashboard(orgId, team.dashboard.publicId, bob, { name: "Mine now" }),
  null,
);
eq_(
  "a colleague cannot re-share it",
  await updateDashboard(orgId, team.dashboard.publicId, bob, { visibility: "private" }),
  null,
);
eq_(
  "a colleague cannot make it their default",
  await updateDashboard(orgId, team.dashboard.publicId, bob, { isDefault: true }),
  null,
);
check(
  "a colleague cannot delete it",
  (await deleteDashboard(orgId, team.dashboard.publicId, bob)) === false,
);
eq_(
  "a colleague cannot add a tile to it",
  await addTile(orgId, team.dashboard.publicId, bob, { reportKey: "total_mrr" }),
  null,
);
eq_(
  "a colleague cannot reorder its tiles",
  await reorderTiles(orgId, team.dashboard.publicId, bob, []),
  null,
);

// ── §6 UNIQUENESS, WITH THE NULL BUSINESS COALESCED ───────────────────────────────────
console.log("\n§6 uniqueness");
await rejects("a duplicate name is a typed conflict", ReportDashboardNameTakenError, () =>
  createDashboard({ ...scope, name: "morning NUMBERS", owner: alice }),
);
check(
  "another operator may reuse the same name",
  (await createDashboard({ ...scope, name: "Morning numbers", owner: bob })).dashboard.publicId
    .length > 0,
);

// The case a plain unique index would miss: business_id IS NULL, so every row compares
// distinct and the duplicate would be stored.
const orgLevel = { organizationId: orgId, businessId: null };
const orgWide = await createDashboard({ ...orgLevel, name: "Org wide", owner: alice });
eq_("an org-level dashboard stores a NULL business", orgWide.dashboard.businessId, null);
await rejects(
  "a duplicate name on an ORG-LEVEL dashboard is still caught",
  ReportDashboardNameTakenError,
  () => createDashboard({ ...orgLevel, name: "org WIDE", owner: alice }),
);
check(
  "the same name may exist at org level and under a business",
  (await createDashboard({ ...orgLevel, name: "Morning numbers", owner: alice })).dashboard
    .businessId === null,
);
eq_(
  "an org-level list does not return the business-scoped dashboards",
  saved(await listDashboards(orgId, null, alice)).length,
  2,
);

// ── §7 DEFAULT EXCLUSIVITY ────────────────────────────────────────────────────────────
console.log("\n§7 one default per operator");
await updateDashboard(orgId, morning.dashboard.publicId, alice, { isDefault: true });
const secondDefault = await updateDashboard(orgId, team.dashboard.publicId, alice, {
  isDefault: true,
});
check("setting a second default succeeds", secondDefault?.dashboard.isDefault === true);
const aliceRows = await listDashboards(orgId, biz.id, alice);
const defaults = aliceRows.filter((r) => r.dashboard.isDefault);
eq_("exactly one default remains", defaults.length, 1);
eq_("and it is the one just set", defaults[0]!.dashboard.publicId, team.dashboard.publicId);
// The partial unique index makes a missed clear an ERROR rather than a silent second
// default, so a colleague's own default must not collide with Alice's.
const bobDefault = await createDashboard({
  ...scope,
  name: "Bob's default",
  owner: bob,
  isDefault: true,
});
check("a colleague's default does not collide", bobDefault.dashboard.isDefault === true);

// ── §8 TILES ──────────────────────────────────────────────────────────────────────────
console.log("\n§8 tiles");
const added = await addTile(orgId, morning.dashboard.publicId, alice, {
  reportKey: "mrr_movement_summary",
  size: "full",
});
eq_("an added tile lands at the end", added?.position, 2);
const resized = await updateTile(orgId, morning.dashboard.publicId, added!.publicId, alice, {
  size: "md",
});
eq_("a tile can be resized", resized?.size, "md");
// 0270: width/height are the stored size now; `size` is derived, so it cannot contradict them.
eq_("a width preset still moves the units", resized?.widthUnits, 6);
const dragged = await updateTile(orgId, morning.dashboard.publicId, added!.publicId, alice, {
  widthUnits: 7,
  heightUnits: 5,
});
eq_("a tile can be dragged to any width", dragged?.widthUnits, 7);
eq_("…and to any height", dragged?.heightUnits, 5);
// 7 of 12 has no preset of its own; the deprecated column takes the nearest, never a stale one.
eq_("…and the deprecated preset follows the width", dragged?.size, "md");
await rejects("a tile cannot be dragged past the board", ReportDashboardError, () =>
  updateTile(orgId, morning.dashboard.publicId, added!.publicId, alice, { widthUnits: 13 }),
);
await rejects("a tile cannot be dragged below the height floor", ReportDashboardError, () =>
  updateTile(orgId, morning.dashboard.publicId, added!.publicId, alice, { heightUnits: 1 }),
);
await rejects("a patch that would break the tile is refused", ReportDashboardError, () =>
  updateTile(orgId, morning.dashboard.publicId, added!.publicId, alice, { granularity: "day" }),
);
const pinned = await updateTile(
  orgId,
  morning.dashboard.publicId,
  morning.tiles[1]!.publicId,
  alice,
  {
    size: "sm",
  },
);
eq_("a resize leaves the pinned currency intact", pinned?.currency, "INR");
const cleared = await updateTile(
  orgId,
  morning.dashboard.publicId,
  morning.tiles[1]!.publicId,
  alice,
  {
    currency: null,
  },
);
eq_("an explicit null clears only that option", cleared?.currency, null);
eq_("and leaves the group_by", cleared?.groupBy, "plan");

const beforeReorder = (await getDashboard(orgId, morning.dashboard.publicId, alice))!.tiles;
const reversed = await reorderTiles(
  orgId,
  morning.dashboard.publicId,
  alice,
  [...beforeReorder].reverse().map((t) => t.publicId),
);
eq_(
  "a reorder applies the order given",
  reversed?.map((t) => t.publicId).join(","),
  [...beforeReorder]
    .reverse()
    .map((t) => t.publicId)
    .join(","),
);
await rejects("a partial order is refused", ReportDashboardError, () =>
  reorderTiles(orgId, morning.dashboard.publicId, alice, [beforeReorder[0]!.publicId]),
);
await rejects("an order naming a tile twice is refused", ReportDashboardError, () =>
  reorderTiles(
    orgId,
    morning.dashboard.publicId,
    alice,
    beforeReorder.map(() => beforeReorder[0]!.publicId),
  ),
);
check(
  "a tile can be removed",
  await removeTile(orgId, morning.dashboard.publicId, added!.publicId, alice),
);
eq_("and is gone", (await getDashboard(orgId, morning.dashboard.publicId, alice))!.tiles.length, 2);

// ── §9 AN UNAVAILABLE TILE ────────────────────────────────────────────────────────────
console.log("\n§9 a report key that has left the registry");
// Written straight to the table: the service refuses such a key on write, and the case
// under test is a key that was legal when it was saved and has since been retired.
await withTenant(orgId, (tx) =>
  tx.insert(reportDashboardTiles).values({
    organizationId: orgId,
    dashboardId: morning.dashboard.id,
    publicId: publicId("dtile"),
    reportKey: "retired_report",
    position: 99,
  }),
);
const withStale = await getDashboard(orgId, morning.dashboard.publicId, alice);
eq_("the stale tile is NOT dropped from the dashboard", withStale?.tiles.length, 3);

const answered = await resolveDashboard(orgId, biz.id, morning.dashboard.publicId, alice);
eq_("every tile gets an answer slot", answered?.resolved.length, 3);
const stale = answered!.resolved.find((t) => t.report_key === "retired_report")!;
check("the stale tile is reported, not blank", stale != null);
eq_("it is marked unavailable", stale.available, false);
eq_("it carries no report", stale.report, null);
check("it says why", (stale.error ?? "").length > 0, stale.error ?? "(empty)");
eq_("it still names its key", stale.report_key, "retired_report");
eq_("and has no catalogue name to show", stale.name, null);

const live = answered!.resolved.filter((t) => t.report_key !== "retired_report");
check(
  "the live tiles still answered",
  live.every((t) => t.available && t.report != null),
);
check(
  "one stale tile does not fail the dashboard",
  live.length === 2 && live.every((t) => t.error === null),
);

// ── §9b A TILE WHOSE PINNED OPTION THE REPORT REFUSES ─────────────────────────────────
// The tile CARRIES the pin, a client prints it ("Pinned: cut by day"), and a periodic
// report has no series to re-cut. Dropping the pin silently left the label asserting a cut
// that never happened — the same silent-honouring `/reports/:key` answers 400 for. Written
// straight to the table because writes refuse the combination: the case under test is a
// tile that OUTLIVED a registry change.
console.log("\n§9b a tile pinning an option its report refuses");
{
  const periodic = REPORTS.find((r) => r.shape === "periodic")!;
  await withTenant(orgId, (tx) =>
    tx.insert(reportDashboardTiles).values({
      organizationId: orgId,
      dashboardId: morning.dashboard.id,
      publicId: publicId("dtile"),
      reportKey: periodic.key,
      granularity: "day",
      position: 98,
    }),
  );
  const out = await resolveDashboard(orgId, biz.id, morning.dashboard.publicId, alice);
  const bad = out!.resolved.find((t) => t.report_key === periodic.key)!;
  check("the tile is reported, not dropped", bad != null);
  eq_("its key is still in the catalogue, so it stays available", bad.available, true);
  eq_("but it carries no report", bad.report, null);
  check(
    "and it says the pin cannot be honoured rather than ignoring it",
    /re-cut|granularity/i.test(bad.error ?? ""),
    bad.error ?? "(empty)",
  );
  eq_("the pin is still visible so the owner can fix it", bad.granularity, "day");
  const others = out!.resolved.filter((t) => t.available && t.report != null);
  check("the rest of the dashboard still answered", others.length >= 2);
}

// ── §10 THE WHOLE-DASHBOARD FETCH ─────────────────────────────────────────────────────
console.log("\n§10 the whole-dashboard fetch");
const mrrTile = answered!.resolved.find((t) => t.report_key === "total_mrr")!;
eq_("a tile's answer is its own report", mrrTile.report?.key, "total_mrr");
eq_("an unpinned tile takes the request default", mrrTile.report?.range, "12m");
// A request-level option is a DEFAULT: it fills in what a tile did not pin, and loses to
// what a tile did — otherwise "this dashboard, in EUR" would silently rewrite every tile.
const overSixMonths = await resolveDashboard(orgId, biz.id, morning.dashboard.publicId, alice, {
  range: "6m",
});
eq_(
  "a request-level range fills in for an unpinned tile",
  overSixMonths!.resolved.find((t) => t.report_key === "total_mrr")?.report?.range,
  "6m",
);
const pinnedTile = overSixMonths!.resolved.find((t) => t.report_key === "total_new_mrr")!;
eq_("but a tile's own pin wins", pinnedTile.report?.range, "3m");
eq_(
  "a colleague cannot resolve a private dashboard",
  await resolveDashboard(orgId, biz.id, morning.dashboard.publicId, bob),
  null,
);
// An org-level dashboard has no business of its own; the caller names one, which is what
// makes it a reusable layout rather than a dashboard with a missing field.
const orgWideTiled = await createDashboard({
  ...orgLevel,
  name: "Org wide, tiled",
  owner: alice,
  tiles: [{ reportKey: "total_mrr" }],
});
const orgWideAnswered = await resolveDashboard(
  orgId,
  biz.id,
  orgWideTiled.dashboard.publicId,
  alice,
);
check(
  "an org-level dashboard answers for the business it is pointed at",
  orgWideAnswered?.resolved[0]?.report != null,
);

// ── §11 THE BUILT-IN PRESETS ──────────────────────────────────────────────────────────
// Presets are declared in code, not stored, so the failure mode is a tile naming something
// the answering layer does not publish — and a DEFAULT dashboard full of errors is the worst
// possible first screen. A tile is a MEASURE id: that is what a board resolves, so that is
// what these checks exercise.
console.log("\n§11 the built-in dashboards");
{
  const problems = assertPresetsAreWellFormed();
  check("every preset tile names a live measure", problems.length === 0, problems.join(" | "));
  eq_("there are six of them", PRESET_DASHBOARDS.length, 6);
  eq_(
    "and they are the ones the module exports",
    PRESET_DASHBOARDS.map((p) => p.key).join(","),
    "overview,movement,lifecycle,credits,usage,sales",
  );
  check(
    "each has tiles and a description",
    PRESET_DASHBOARDS.every((p) => p.tiles.length > 0 && p.description.trim().length > 0),
  );
  check(
    "their ids are distinct and stably shaped",
    new Set(PRESET_DASHBOARDS.map((p) => presetPublicId(p.key))).size ===
      PRESET_DASHBOARDS.length &&
      PRESET_DASHBOARDS.every((p) => presetPublicId(p.key).startsWith("dash_preset_")),
  );

  // They must appear for an operator who has saved nothing at all — that is the case that
  // replaced the empty page.
  const nobody = await listDashboards(orgId, biz.id, "nobody@example.com");
  const presetRows = nobody.filter((d) => d.dashboard.publicId.startsWith("dash_preset_"));
  // A model preset (Credits) lists only for a business with that model; this one has none.
  eq_(
    "every general preset lists for an operator with no dashboards of their own",
    presetRows.length,
    PRESET_DASHBOARDS.filter((p) => !p.requires).length,
  );
  check(
    "and a model preset is left out for a business without that model",
    !presetRows.some((d) => d.dashboard.publicId === presetPublicId("credits")),
  );
  check(
    "and they lead the list, so the page opens on one",
    nobody[0]?.dashboard.publicId.startsWith("dash_preset_") === true,
  );

  // Every tile of every preset answers, through the resolver `/v1/analytics` uses. This is
  // the expensive check and the only one that proves the defaults are worth shipping: a tile
  // naming something the semantic layer cannot answer fails here, named.
  for (const p of PRESET_DASHBOARDS) {
    const res = await resolveDashboard(orgId, biz.id, presetPublicId(p.key), alice);
    const tiles = res?.resolved ?? [];
    const broken = tiles.filter((t) => !t.available || t.error != null || t.result == null);
    check(
      `${p.name}: all ${tiles.length} tiles answer`,
      tiles.length === p.tiles.length && broken.length === 0,
      broken.map((t) => `${t.report_key}: ${t.error ?? "no measure result"}`).join(" | "),
    );
    check(
      `${p.name}: every tile answered as a measure, not a report`,
      tiles.length > 0 &&
        tiles.every((t) => t.report === null && t.result?.measure === t.report_key),
    );
    const grouped = tiles.filter((t) => t.group_by != null);
    check(
      `${p.name}: a grouped tile came back split by what it asked for`,
      grouped.every((t) => t.result?.split?.dimension === t.group_by),
      grouped
        .map((t) => `${t.report_key}: split=${t.result?.split?.dimension ?? "none"}`)
        .join(" | "),
    );
  }

  // Read-only by construction: `owner` is "" and nothing can own that.
  const got = await getDashboard(orgId, presetPublicId("overview"), alice);
  check("a preset is visible to anyone", got != null);
  eq_("and owned by nobody", got?.dashboard.owner, "");
  eq_(
    "so it is never 'mine'",
    serializeDashboard(got!.dashboard, got!.tiles, alice).is_mine,
    false,
  );
  for (const [label, fn] of [
    ["renamed", () => updateDashboard(orgId, presetPublicId("overview"), alice, { name: "x" })],
    ["deleted", () => deleteDashboard(orgId, presetPublicId("overview"), alice)],
    ["added to", () => addTile(orgId, presetPublicId("overview"), alice, { reportKey: "mrr" })],
  ] as const) {
    let refused = false;
    let message = "";
    try {
      await fn();
    } catch (e) {
      refused = true;
      message = (e as Error).message;
    }
    check(`a preset cannot be ${label}`, refused, message);
    check(
      `…and the refusal says why it cannot be ${label}`,
      /built-in|cannot be changed/i.test(message),
      message,
    );
  }
}

// ── §shape A TILE STORES ITS ANSWER SHAPE (0274) ────────────────────────────────────────
console.log("\n§shape tile answer shape");
{
  const board = await createDashboard({
    organizationId: orgId,
    businessId: biz.id,
    name: "Shapes",
    owner: alice,
  });
  const refusal = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return "";
    } catch (e) {
      return e instanceof ReportDashboardError ? e.message : `unexpected: ${(e as Error).message}`;
    }
  };
  const ranked = await addTile(orgId, board.dashboard.publicId, alice, {
    reportKey: "mrr",
    groupBy: "plan",
    shape: "totals",
  });
  eq_("a measure tile stores shape=totals", ranked?.shape, "totals");
  const plain = await addTile(orgId, board.dashboard.publicId, alice, { reportKey: "mrr" });
  eq_("…and NULL when it asks for nothing (the default, series)", plain?.shape, null);
  check(
    "an unknown shape is refused by name",
    /shape must be one of: series, totals/.test(
      await refusal(() =>
        addTile(orgId, board.dashboard.publicId, alice, { reportKey: "mrr", shape: "matrix" }),
      ),
    ),
  );
  check(
    "a REPORT tile refuses a shape rather than ignoring it",
    /applies to measures only/.test(
      await refusal(() =>
        addTile(orgId, board.dashboard.publicId, alice, {
          reportKey: "mrr_movement_summary",
          shape: "totals",
        }),
      ),
    ),
  );
  const reshaped = await updateTile(orgId, board.dashboard.publicId, plain!.publicId, alice, {
    shape: "totals",
  });
  eq_("shape is patchable", reshaped?.shape, "totals");
  const resized = await updateTile(orgId, board.dashboard.publicId, plain!.publicId, alice, {
    widthUnits: 4,
  });
  eq_("…and a resize leaves it alone", resized?.shape, "totals");

  const out = await resolveDashboard(orgId, biz.id, board.dashboard.publicId, alice);
  const answer = out!.resolved.find((t) => t.id === ranked!.publicId)!;
  eq_("the tile serializes its shape", answer.shape, "totals");
  const result = answer.result as { shape?: string; series?: unknown[] } | null;
  check(
    "…and is ANSWERED in that shape",
    result?.shape === "totals" && (result.series ?? [1]).length === 0,
    JSON.stringify({ shape: result?.shape, error: answer.error }),
  );
}

// ── §12 PER-OWNER CAP ─────────────────────────────────────────────────────────────────
console.log("\n§12 per-owner cap");
{
  const carol = "carol@example.test";
  for (let i = 0; i < MAX_DASHBOARDS_PER_OWNER; i++) {
    // Half org-level, half on the business: the cap is per organization, not per scope.
    await createDashboard({
      organizationId: orgId,
      businessId: i % 2 ? biz.id : null,
      name: `Cap ${i}`,
      owner: carol,
    });
  }
  await rejects(
    `the ${MAX_DASHBOARDS_PER_OWNER + 1}st dashboard is refused`,
    ReportDashboardError,
    () => createDashboard({ ...scope, name: "One too many", owner: carol }),
  );
  const other = await createDashboard({ ...scope, name: "Bob is not capped by Carol", owner: bob });
  check("another person is unaffected", other.dashboard.owner === bob);
  const mine = (await listDashboards(orgId, null, carol)).find((r) => r.dashboard.owner === carol);
  await deleteDashboard(orgId, mine!.dashboard.publicId, carol);
  const again = await createDashboard({ ...scope, name: "After a delete", owner: carol });
  check("a delete frees a place", again.dashboard.name === "After a delete");
}

console.log("");
console.log(`${ok} ok, ${fail} failed`);
console.log(fail === 0 ? "✅ REPORT DASHBOARDS: PASS" : "❌ REPORT DASHBOARDS: FAIL");
await closeDb();
process.exit(fail === 0 ? 0 : 1);
