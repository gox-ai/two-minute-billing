/**
 * Build the published SDK package in sdk/: ESM + declarations into sdk/dist.
 *
 *   pnpm sdk:build
 *
 * `tsc` does not copy declaration-only inputs, so the generated `schema.d.ts` is copied
 * beside the emitted `index.d.ts`, which imports it.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = join(root, "sdk");
rmSync(join(sdk, "dist"), { recursive: true, force: true });
execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(sdk, "tsconfig.build.json")], {
  stdio: "inherit",
});
copyFileSync(join(sdk, "schema.d.ts"), join(sdk, "dist/schema.d.ts"));
console.log("built sdk/dist");
