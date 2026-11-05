import { describe, expect, it } from "vitest";
import { portalLinkLanding } from "../../dashboard/lib/portal-link-landing";

describe("portal link landing (scanner protection fails closed)", () => {
  it("a failed peek (rate limit, error) never spends the link on a GET", () => {
    expect(portalLinkLanding(null)).toBe("continue");
  });
  it("an email link goes to the continue page", () => {
    expect(portalLinkLanding({ link_kind: "email" })).toBe("continue");
  });
  it("a peek without a kind is treated as unknown → continue", () => {
    expect(portalLinkLanding({})).toBe("continue");
  });
  it("only a successful peek of an API link exchanges directly", () => {
    expect(portalLinkLanding({ link_kind: "api" })).toBe("exchange");
  });
});
