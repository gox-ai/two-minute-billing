/**
 * Migration 0244 — `resolveChargebackConfig`. Every default is today's record-only
 * behaviour, and only an explicit valid value may opt out of it — checked against the
 * literal union, never by truthiness, because a hand-edited or half-written blob must
 * never silently start cancelling subscriptions.
 */
import { describe, it, expect } from "vitest";
import {
  resolveChargebackConfig,
  DEFAULT_CHARGEBACK_CONFIG,
  type ChargebackConfig,
} from "@/modules/disputes/chargeback-config";

describe("resolveChargebackConfig", () => {
  it("null business resolves to the record-only default", () => {
    expect(resolveChargebackConfig(null)).toEqual(DEFAULT_CHARGEBACK_CONFIG);
  });

  it("undefined business resolves to the record-only default", () => {
    expect(resolveChargebackConfig(undefined)).toEqual(DEFAULT_CHARGEBACK_CONFIG);
  });

  it("absent chargebackConfig resolves to the record-only default", () => {
    expect(resolveChargebackConfig({})).toEqual(DEFAULT_CHARGEBACK_CONFIG);
  });

  it("null chargebackConfig resolves to the record-only default", () => {
    expect(resolveChargebackConfig({ chargebackConfig: null })).toEqual(DEFAULT_CHARGEBACK_CONFIG);
  });

  it("the default is record-only in every field", () => {
    expect(DEFAULT_CHARGEBACK_CONFIG).toEqual({
      onLostInvoice: "no_action",
      onInitiatedSubscription: "no_action",
      onLostSubscription: "no_action",
      cascadeToOtherSubscriptions: false,
      stopCollectingAll: false,
    });
  });

  describe("malformed values fall back to no_action, never to an action", () => {
    it("on_lost_invoice: an unknown string", () => {
      const c = resolveChargebackConfig({
        chargebackConfig: { on_lost_invoice: "refund_and_mark_not_paid" },
      });
      expect(c.onLostInvoice).toBe("no_action");
    });

    it("on_lost_invoice: a non-string value", () => {
      const c = resolveChargebackConfig({ chargebackConfig: { on_lost_invoice: true } });
      expect(c.onLostInvoice).toBe("no_action");
    });

    it("on_initiated_subscription: an unknown string", () => {
      const c = resolveChargebackConfig({
        chargebackConfig: { on_initiated_subscription: "delete_immediately" },
      });
      expect(c.onInitiatedSubscription).toBe("no_action");
    });

    it("on_lost_subscription: a non-string value", () => {
      const c = resolveChargebackConfig({ chargebackConfig: { on_lost_subscription: 1 } });
      expect(c.onLostSubscription).toBe("no_action");
    });

    it("cascade_to_other_subscriptions: a truthy non-boolean does not opt in", () => {
      const c = resolveChargebackConfig({
        chargebackConfig: { cascade_to_other_subscriptions: "true" },
      });
      expect(c.cascadeToOtherSubscriptions).toBe(false);
    });

    it("stop_collecting_all: a truthy non-boolean does not opt in", () => {
      const c = resolveChargebackConfig({
        chargebackConfig: { stop_collecting_all: "yes" },
      });
      expect(c.stopCollectingAll).toBe(false);
    });

    it("a wholly malformed blob (wrong shape) resolves to the full default", () => {
      const c = resolveChargebackConfig({ chargebackConfig: "not_an_object" });
      expect(c).toEqual(DEFAULT_CHARGEBACK_CONFIG);
    });
  });

  describe("on_lost_invoice round-trips", () => {
    it("credit_note", () => {
      const c = resolveChargebackConfig({ chargebackConfig: { on_lost_invoice: "credit_note" } });
      expect(c.onLostInvoice).toBe("credit_note");
    });

    it("no_action", () => {
      const c = resolveChargebackConfig({ chargebackConfig: { on_lost_invoice: "no_action" } });
      expect(c.onLostInvoice).toBe("no_action");
    });
  });

  describe("each subscription action round-trips for on_initiated_subscription", () => {
    const actions = [
      "cancel_immediately",
      "cancel_end_of_term",
      "pause_indefinitely",
      "pause_end_of_term",
      "no_action",
    ] as const;
    for (const action of actions) {
      it(action, () => {
        const c = resolveChargebackConfig({
          chargebackConfig: { on_initiated_subscription: action },
        });
        expect(c.onInitiatedSubscription).toBe(action);
      });
    }
  });

  describe("each subscription action round-trips for on_lost_subscription", () => {
    const actions = [
      "cancel_immediately",
      "cancel_end_of_term",
      "pause_indefinitely",
      "pause_end_of_term",
      "no_action",
    ] as const;
    for (const action of actions) {
      it(action, () => {
        const c = resolveChargebackConfig({ chargebackConfig: { on_lost_subscription: action } });
        expect(c.onLostSubscription).toBe(action);
      });
    }
  });

  it("cascade_to_other_subscriptions defaults false and honours an explicit true", () => {
    expect(resolveChargebackConfig({}).cascadeToOtherSubscriptions).toBe(false);
    const c = resolveChargebackConfig({
      chargebackConfig: { cascade_to_other_subscriptions: true },
    });
    expect(c.cascadeToOtherSubscriptions).toBe(true);
  });

  it("stop_collecting_all defaults false and honours an explicit true", () => {
    expect(resolveChargebackConfig({}).stopCollectingAll).toBe(false);
    const c = resolveChargebackConfig({ chargebackConfig: { stop_collecting_all: true } });
    expect(c.stopCollectingAll).toBe(true);
  });

  it("an explicit false on a boolean field is honoured, not treated as absent", () => {
    const c = resolveChargebackConfig({
      chargebackConfig: {
        cascade_to_other_subscriptions: false,
        stop_collecting_all: false,
      },
    });
    expect(c.cascadeToOtherSubscriptions).toBe(false);
    expect(c.stopCollectingAll).toBe(false);
  });

  it("one set field does not perturb resolution of the others", () => {
    const c: ChargebackConfig = resolveChargebackConfig({
      chargebackConfig: { on_lost_invoice: "credit_note" },
    });
    expect(c.onInitiatedSubscription).toBe("no_action");
    expect(c.onLostSubscription).toBe("no_action");
    expect(c.cascadeToOtherSubscriptions).toBe(false);
    expect(c.stopCollectingAll).toBe(false);
  });

  it("a fully configured, valid blob round-trips every field", () => {
    const c = resolveChargebackConfig({
      chargebackConfig: {
        on_lost_invoice: "credit_note",
        on_initiated_subscription: "pause_indefinitely",
        on_lost_subscription: "cancel_immediately",
        cascade_to_other_subscriptions: true,
        stop_collecting_all: true,
      },
    });
    expect(c).toEqual({
      onLostInvoice: "credit_note",
      onInitiatedSubscription: "pause_indefinitely",
      onLostSubscription: "cancel_immediately",
      cascadeToOtherSubscriptions: true,
      stopCollectingAll: true,
    });
  });
});
