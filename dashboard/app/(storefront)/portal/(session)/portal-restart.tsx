"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { money } from "@/lib/format";
import type { PortalSubscription } from "@/lib/portal-api";
import { portalRestartAction } from "./actions";
import { termName } from "./portal-change-view";

type Restart = NonNullable<PortalSubscription["restart"]>;

/**
 * Restart an ended subscription. The button opens a checkout: the subscription starts again
 * only after the payment there succeeds, so nothing changes until the buyer pays.
 */
export function PortalRestart({
  subscription,
  restart,
  closesLabel,
}: {
  subscription: string;
  restart: Restart;
  /** `closes_at` in the business timezone, or null when there is no limit. */
  closesLabel: string | null;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!restart.allowed)
    return restart.message ? (
      <div className="border-t px-5 py-3 text-xs text-muted-foreground">{restart.message}</div>
    ) : null;

  async function go() {
    setBusy(true);
    setError(null);
    const res = await portalRestartAction(window.location.origin, subscription);
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
      return;
    }
    window.location.assign(res.url);
  }

  return (
    <div className="flex flex-col gap-3 border-t px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex-[1_1_14rem] text-sm text-muted-foreground">
          {restart.term
            ? `You can restart this subscription. The price of ${termName(restart.term.interval, restart.term.interval_count)} is ${money(restart.term.subtotal_minor, restart.term.currency)} before tax and discounts. On the next page, you see the full amount and pay it.`
            : "You can restart this subscription. On the next page, you see the price of the new term and pay it."}{" "}
          Your subscription starts again after you pay.
          {closesLabel ? ` You can restart it until ${closesLabel}.` : ""}
        </p>
        <Button size="sm" onClick={go} disabled={busy}>
          {busy ? "Opening…" : "Restart subscription"}
        </Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}
