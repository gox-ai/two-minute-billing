/** The dashboard's checkout-fields page keeps a copy of the engine defaults; they must match. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { DEFAULT_CHECKOUT_FIELD_CONFIG } from "@/modules/checkout/field-config";
import { DEFAULT_PORTAL_FIELD_CONFIG } from "@/modules/checkout/address-field-rules";

const source = readFileSync(
  resolve(
    process.cwd(),
    "dashboard/app/(dashboard)/businesses/[biz]/settings/checkout-fields/field-matrix.ts",
  ),
  "utf8",
);

/** The object literal assigned to `export const <name>…= { … };` as plain data. */
function literal(name: string): Record<string, string> {
  const m = new RegExp(`export const ${name}[^=]*=\\s*(\\{[\\s\\S]*?\\n\\});`).exec(source);
  if (!m?.[1]) throw new Error(`${name} not found in field-matrix.ts`);
  return JSON.parse(m[1].replace(/,(\s*\})/g, "$1").replace(/^(\s*)("[^"]+"):/gm, "$1$2:"));
}

describe("checkout-fields page defaults mirror the engine", () => {
  it("checkout", () => expect(literal("CHECKOUT_DEFAULTS")).toEqual(DEFAULT_CHECKOUT_FIELD_CONFIG));
  it("portal", () => expect(literal("PORTAL_DEFAULTS")).toEqual(DEFAULT_PORTAL_FIELD_CONFIG));
});
