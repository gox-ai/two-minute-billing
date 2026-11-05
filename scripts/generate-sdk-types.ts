/**
 * Generate drift-proof TypeScript types from the OpenAPI document:
 *  1. write the live spec to sdk/openapi.json,
 *  2. emit sdk/schema.d.ts from it.
 * Run after changing routes/openapi.ts; commit both outputs.
 *
 *   pnpm sdk:generate
 *
 * Step 2 used to shell out to `openapi-typescript`. It does not any more, and cannot:
 * 7.13.0 is that package's latest release, it peer-depends on `typescript@^5.x`, and it
 * touches `ts.factory` at module load. TypeScript 7 is the native port whose main entry
 * exports only `version` and `versionMajorMinor`, so there is no factory to shim and no
 * newer release to move to. `scripts/lib/emit-schema-dts.ts` generates the same types as
 * text, with no compiler dependency at all — which is what stops this breaking again on the
 * next TypeScript upgrade.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openapiDocument } from "@/api/openapi";
import { emitSchemaDts } from "./lib/emit-schema-dts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "sdk", "openapi.json");
const typesPath = join(root, "sdk", "schema.d.ts");

await writeFile(specPath, JSON.stringify(openapiDocument, null, 2) + "\n");
console.log(`wrote ${specPath}`);

await writeFile(typesPath, emitSchemaDts(openapiDocument as Parameters<typeof emitSchemaDts>[0]));
console.log(`wrote ${typesPath}`);
