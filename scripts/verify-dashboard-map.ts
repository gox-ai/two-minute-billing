/**
 * The dashboard map the assistant reads is current: regenerating it from the source gives the
 * committed file, every signed-in screen is in it, every screen has a name, and no screen lists
 * page chrome, a heading, code or a label it does not render as a control (dashboard-map-audit).
 *
 *   pnpm verify:dashboard-map     (fix: pnpm dashboard-map:generate)
 */
import { readFileSync } from "node:fs";
import { auditMap } from "./dashboard-map-audit";
import {
  MAP_PATH,
  buildDashboardMap,
  codeLike,
  labelKinds,
  pageFileOf,
  renderMap,
  unresolved,
} from "./generate-dashboard-map";

const screens = await buildDashboardMap();
const checks: Array<[string, boolean, string?]> = [];
checks.push([
  "the committed map matches the source (pnpm dashboard-map:generate)",
  // Content, not text: the pre-commit formatter lays the JSON out its own way.
  JSON.stringify(JSON.parse(readFileSync(MAP_PATH, "utf8"))) ===
    JSON.stringify(JSON.parse(renderMap(screens))),
]);
checks.push([
  `every screen has a name (${screens.length} screens)`,
  screens.every((s) => s.label.trim().length > 0),
]);
const withControls = screens.filter((s) => s.controls.length > 0).length;
checks.push([
  `most screens list their controls (${withControls}/${screens.length})`,
  withControls / screens.length > 0.8,
]);
checks.push([
  "the key screens are present",
  [
    "/developer",
    "/settings/assistant",
    "/businesses/{business}/invoices/{inv}",
    "/businesses/{business}/settings/dunning",
  ].every((r) => screens.some((s) => s.route === r)),
]);
// A CSS class string or an identifier is code, not a control: the generator read the wrong prop.
const code = screens.flatMap((s) =>
  [...s.controls, ...s.groups.flatMap((g) => g.controls)]
    .filter(codeLike)
    .map((c) => `${s.route}: ${c}`),
);
checks.push([
  `no control is a CSS class or an identifier${code.length ? `: ${code.slice(0, 5).join(" · ")}` : ""}`,
  code.length === 0,
]);
// Screen by screen: a breadcrumb, a page title or a heading is never a control, and every control
// is in a file the screen renders or in the catalogue it declares.
const findings = auditMap(screens, labelKinds, pageFileOf);
for (const rule of ["chrome", "heading", "rendered"] as const) {
  const hit = findings.filter((f) => f.rule === rule);
  const what = {
    chrome: "no control is a breadcrumb or a page title",
    heading: "no control is only a card or section heading",
    rendered: "every control is in a file the screen renders or a catalogue it declares",
  }[rule];
  checks.push([
    `${what}${
      hit.length
        ? `: ${hit
            .slice(0, 5)
            .map((f) => `${f.route}: ${f.label}`)
            .join(" · ")}`
        : ""
    }`,
    hit.length === 0,
  ]);
}
// Not a failure: a label built from data ("Remove EUR") has no static value to list.
for (const at of [...unresolved].sort())
  console.log(`  ! ${at}: an action label template reads no static value`);
let failed = 0;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) failed++;
}
process.exit(failed ? 1 : 0);
