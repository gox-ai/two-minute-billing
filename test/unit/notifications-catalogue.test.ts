import { describe, expect, it } from "vitest";
import { isEventType } from "@/modules/events/registry";
import { isPermissionKey } from "@/modules/auth/permissions";
import {
  CATALOGUE,
  FRAUD_DECLINE_CODES,
  NOTIFICATION_KINDS,
  candidateKinds,
  defaultPreferences,
  kindDef,
} from "@/modules/notifications/catalogue";

describe("notification catalogue", () => {
  it("has 26 kinds, each complete", () => {
    expect(NOTIFICATION_KINDS).toHaveLength(26);
    expect(new Set(NOTIFICATION_KINDS).size).toBe(26);
    for (const def of CATALOGUE) {
      expect(def.label, def.kind).toMatch(/^[A-Z]/);
      expect(def.help, def.kind).toMatch(/^[A-Z0-9].*\.$/);
      expect(["destructive", "warning", "neutral"]).toContain(def.tone);
      expect(isPermissionKey(def.permission), def.permission).toBe(true);
    }
  });

  it("every event source is a registered event type", () => {
    for (const def of CATALOGUE) {
      if (def.source === "clock" || def.source === "direct") continue;
      expect(def.source.length, def.kind).toBeGreaterThan(0);
      for (const t of def.source) expect(isEventType(t), `${def.kind}: ${t}`).toBe(true);
    }
  });

  it("supersedes names real kinds that share an event type", () => {
    for (const def of CATALOGUE)
      for (const parent of def.supersedes ?? []) {
        const p = kindDef(parent);
        expect(Array.isArray(p.source) && Array.isArray(def.source)).toBe(true);
        expect((p.source as string[]).some((t) => (def.source as string[]).includes(t))).toBe(true);
      }
  });

  it("candidateKinds maps an event type, and the portal kind only from the portal", () => {
    expect(candidateKinds({ type: "payment_failed", source: "api" }).sort()).toEqual(
      ["payment_failed", "possible_fraud"].sort(),
    );
    expect(candidateKinds({ type: "subscription_canceled", source: "dashboard" })).toEqual([
      "subscription_cancelled",
    ]);
    expect(candidateKinds({ type: "subscription_canceled", source: "portal" }).sort()).toEqual(
      ["customer_portal_change", "subscription_cancelled"].sort(),
    );
    expect(candidateKinds({ type: "subscription_paused", source: "api" })).toEqual([]);
    expect(candidateKinds({ type: "customer_created" })).toEqual([]);
    expect(candidateKinds({ type: "invoice_not_paid" })).toEqual([]);
  });

  it("defaults follow the design: role-dependent operations rows", () => {
    const admin = defaultPreferences("admin");
    const ops = defaultPreferences("ops");
    const dev = defaultPreferences("developer");
    expect(admin.payment_failed).toEqual({ timing: "instant", push: true, email: false });
    expect(admin.dispute_opened).toEqual({ timing: "instant", push: true, email: true });
    expect(admin.payment_received.timing).toBe("summary");
    expect(admin.trial_ending.timing).toBe("off");
    expect(admin.large_credit_grant.timing).toBe("instant");
    expect(dev.large_credit_grant.timing).toBe("off");
    expect(dev.webhook_failing).toEqual({ timing: "instant", push: false, email: true });
    expect(ops.webhook_failing.timing).toBe("off");
    expect(ops.gateway_attention.timing).toBe("off");
    expect(defaultPreferences("custom").gateway_attention.timing).toBe("off");
    expect(Object.keys(admin)).toHaveLength(26);
  });

  it("fraud codes are canonical decline tokens", () => {
    expect([...FRAUD_DECLINE_CODES].sort()).toEqual(
      ["fraudulent", "lost_card", "pickup_card", "stolen_card"].sort(),
    );
  });
});
