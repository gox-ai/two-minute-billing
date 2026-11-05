import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/platform/config";
import { taxIdValidatorChoice } from "@/modules/customers/tax-id";

// The site says Cloud checks EU VAT numbers in VIES; tests and self-hosted make no outside call.
const saved = { edition: config.TMBILLING_EDITION, validator: config.TAX_ID_VALIDATOR };
const set = (edition: typeof saved.edition, validator: typeof saved.validator) =>
  Object.assign(config, { TMBILLING_EDITION: edition, TAX_ID_VALIDATOR: validator });

describe("taxIdValidatorChoice", () => {
  afterEach(() => set(saved.edition, saved.validator));

  it("uses VIES on Cloud when unset", () => {
    set("cloud", undefined);
    expect(taxIdValidatorChoice()).toBe("vies");
  });

  it("makes no lookup on self-hosted when unset", () => {
    set("self_hosted", undefined);
    expect(taxIdValidatorChoice()).toBe("noop");
  });

  it("lets an explicit setting win on either edition", () => {
    set("cloud", "noop");
    expect(taxIdValidatorChoice()).toBe("noop");
    set("self_hosted", "vies");
    expect(taxIdValidatorChoice()).toBe("vies");
  });
});
