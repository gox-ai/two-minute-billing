import * as React from "react";
import { SectionCard } from "@/components/patterns/section-card";

/**
 * Static explainer for time travel: what it does and what survives a stop.
 * Kept as a server component (no interactivity).
 */
export function Explainer() {
  return (
    <SectionCard layout="card" title="About time travel">
      <div className="space-y-4 text-sm text-foreground/80">
        <div>
          <p className="mb-1 font-medium text-foreground">What it does</p>
          <p>
            Time travel sets the clock of this test business to a genesis instant. Then you can
            travel forward one day at a time. Each simulated day runs the full billing pipeline, the
            same as real time: subscription renewals, invoice generation, dunning retries,
            entitlement changes and outbound webhooks. You can simulate months of billing in seconds
            to see how a catalog behaves over time.
          </p>
        </div>
        <div>
          <p className="mb-1 font-medium text-foreground">Rules</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Only for test businesses. Time travel never runs on live businesses.</li>
            <li>Travel is forward-only. You cannot return to an earlier date.</li>
            <li>
              Each tick does a maximum of one renewal for each subscription. Thus the step size must
              not be more than the shortest billing interval of the business&apos;s active
              subscriptions.
            </li>
            <li>While time travel is active, the real billing clock skips this business.</li>
          </ul>
        </div>
        <div>
          <p className="mb-1 font-medium text-foreground">A stop deletes simulated data</p>
          <p>
            When you stop time travel, it{" "}
            <span className="font-medium text-destructive">permanently deletes</span> every
            simulated customer, subscription, invoice, payment, credit note, refund, ledger entry,
            usage record and event. Then the business returns to the real clock.
          </p>
          <p className="mt-1">
            <span className="font-medium text-foreground">Kept:</span> catalog (products and
            prices), coupons, tax rates, business settings, payment gateways, API keys and webhook
            endpoints. You can start a new run with the same configuration.
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
