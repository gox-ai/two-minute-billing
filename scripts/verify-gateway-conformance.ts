/**
 * Gateway conformance (plan 3e): the shared scenarios S1–S14 run against each gateway's fixture
 * module, through the real adapter (behind a fake API), the real engine and the real webhook
 * route. PASSES only when the failing rows equal `src/providers/conformance/known-gaps.json`
 * exactly, every catalog gateway has fixtures or a stated exclusion, and every entry of
 * `live-proof-pending.json` names a real catalog gateway and method.
 *
 *   pnpm verify:gateway-conformance                 every fixture module
 *   pnpm verify:gateway-conformance -- square       one gateway
 *
 * Recipe for a new gateway: scripts/conformance/README.md.
 */
import { buildApp } from "@/index";
import { closeDb } from "@/platform/db";
import { loadGeoReference } from "@/platform/geo";
import { flushGatewayRequestLogs } from "@/providers/http";
import { GATEWAY_KEYS, isGatewayKey, withholdableMethods } from "@/providers/gateway-catalog";
import {
  conformanceExclusions,
  knownGapsByGateway,
  liveProofPending,
} from "@/providers/conformance";
import { createOrganization } from "@/modules/tenancy/service";
import { FIXTURES } from "./conformance/registry";
import { runFixture, type RowResult } from "./conformance/scenarios";
import { uninstallFakes } from "./conformance/fake-http";
import {
  compareWithKnownGaps,
  coverageProblems,
  pendingMethodProblems,
} from "./conformance/verdict";

const only = process.argv.slice(2).filter((a) => a !== "--" && !a.endsWith(".ts"));
const gaps = knownGapsByGateway();
const exclusions = conformanceExclusions();

// ── coverage gate ───────────────────────────────────────────────────────────
const coverage = coverageProblems({
  catalog: [...GATEWAY_KEYS],
  fixtures: FIXTURES.map((f) => f.key),
  gapKeys: Object.keys(gaps),
  exclusions,
});
coverage.push(
  ...pendingMethodProblems(liveProofPending(), (gw) =>
    isGatewayKey(gw) ? withholdableMethods(gw) : null,
  ),
);
for (const f of FIXTURES)
  for (const id of Object.keys(f.na))
    if (!/^S\d+(\.|$)/.test(id))
      coverage.push(`${f.key}: n/a key "${id}" is not a scenario or row id`);

await loadGeoReference();
const app = await buildApp({ logger: false });
const org = await createOrganization({ name: `Gateway conformance ${Date.now().toString(36)}` });
const rows: RowResult[] = [];
const run = FIXTURES.filter((f) => only.length === 0 || only.includes(f.key));
try {
  for (const f of run) {
    const t0 = Date.now();
    const got = await runFixture(f, app, { id: org.organization.id, secret: org.secret });
    rows.push(...got);
    console.log(`▶ ${f.key}: ${got.length} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
} finally {
  uninstallFakes();
}

const clip = (t?: string) => (t && t.length > 240 ? `${t.slice(0, 240)}…` : (t ?? ""));
const verdict = compareWithKnownGaps(
  rows,
  gaps,
  run.map((f) => f.key),
);

for (const f of run) {
  const mine = rows.filter((r) => r.gateway === f.key);
  const count = (o: RowResult["outcome"]) => mine.filter((r) => r.outcome === o).length;
  console.log(`\n── ${f.key}: ${count("pass")} pass · ${count("fail")} fail · ${count("na")} n/a`);
  for (const r of mine) {
    const known = gaps[f.key]?.[r.id];
    const mark = r.outcome === "pass" ? "✓" : r.outcome === "na" ? "–" : known ? "◌" : "✗";
    const note =
      r.outcome === "na"
        ? ` (n/a: ${r.detail})`
        : r.outcome === "fail"
          ? ` — ${clip(r.detail)}${known ? ` [known gap, ${known.planRef}]` : ""}`
          : "";
    console.log(` ${mark} ${r.id}${note}`);
  }
}

let pass = true;
if (coverage.length) {
  pass = false;
  console.log("\n✗ coverage gate:");
  for (const c of coverage) console.log(`   ${c}`);
}
if (verdict.unexpected.length) {
  pass = false;
  console.log("\n✗ failing rows that are not known gaps (fix them, or list them with a planRef):");
  for (const r of verdict.unexpected) console.log(`   ${r.gateway}:${r.id} — ${clip(r.detail)}`);
}
if (verdict.stale.length) {
  pass = false;
  console.log("\n✗ known gaps that no longer fail — remove them from known-gaps.json:");
  for (const s of verdict.stale) console.log(`   ${s.gateway}:${s.row} (now ${s.now})`);
}
console.log(
  `\n${verdict.known.length} known gaps, ${verdict.unexpected.length} unexpected failures, ${verdict.stale.length} stale gaps`,
);
console.log(pass ? "✅ GATEWAY CONFORMANCE: PASS" : "❌ GATEWAY CONFORMANCE: FAIL");
await app.close();
await flushGatewayRequestLogs();
await closeDb();
process.exit(pass ? 0 : 1);
