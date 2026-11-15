/**
 * Build the published CLI package in cli/: copy the Agent Skills' scripts into cli/scripts,
 * where `tmb` runs them. One implementation: the skills and the CLI run the same files.
 *
 *   pnpm cli:build
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skills = join(root, "docs-site/skills");
const out = join(root, "cli/scripts");

const CLI_SCRIPTS = [
  "two-minute-billing/scripts/preflight.mjs",
  "two-minute-billing-pricing/scripts/catalog.mjs",
  "two-minute-billing-verify/scripts/clock.mjs",
  "two-minute-billing-verify/scripts/money-check.mjs",
  "two-minute-billing-verify/scripts/webhook-check.mjs",
  "two-minute-billing-integrate/scripts/register-webhook.mjs",
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of CLI_SCRIPTS) copyFileSync(join(skills, f), join(out, f.split("/").pop()!));
console.log(`copied ${CLI_SCRIPTS.length} scripts into cli/scripts`);
