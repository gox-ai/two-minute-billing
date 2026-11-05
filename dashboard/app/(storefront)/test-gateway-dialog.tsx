"use client";

import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { GatewaySdkContext, GatewaySdkResult } from "@/lib/gateway-sdk";
import { PaymentDialog } from "./payment-dialog";

/** The nonces the test gateway's adapter expects back as `client_result.nonce`. */
const APPROVE = { nonce: "tmtest_ok" };
const DECLINE = { nonce: "tmtest_decline" };

function TestGatewayDialog({
  open,
  purpose,
  onSettle,
}: {
  open: boolean;
  purpose: GatewaySdkContext["purpose"];
  onSettle: (result: GatewaySdkResult) => void;
}) {
  return (
    <PaymentDialog
      open={open}
      onClose={() => onSettle({ status: "dismissed" })}
      title="Test gateway"
      description={
        purpose === "setup"
          ? "This is a test payment method. No money moves. Select Approve to save it or Decline to refuse it."
          : "This is a test payment. No money moves. Select Approve to authorize it or Decline to refuse it."
      }
    >
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => onSettle({ status: "completed", clientResult: DECLINE })}
        >
          Decline
        </Button>
        <Button onClick={() => onSettle({ status: "completed", clientResult: APPROVE })}>
          Approve
        </Button>
      </div>
    </PaymentDialog>
  );
}

/**
 * The `tmtest` loader. Mounted in its own root because the caller awaits a promise, not
 * a render. Unmounted on a timer: Radix only removes a closed dialog when its exit
 * animation ends, and the unmount also lifts the body pointer lock.
 */
export function openTestGatewayDialog(
  _params: Record<string, unknown>,
  context: GatewaySdkContext,
): Promise<GatewaySdkResult> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const settle = (result: GatewaySdkResult) => {
      if (settled) return;
      settled = true;
      root.render(<TestGatewayDialog open={false} purpose={context.purpose} onSettle={settle} />);
      resolve(result);
      setTimeout(() => {
        root.unmount();
        host.remove();
      }, 300);
    };
    root.render(<TestGatewayDialog open purpose={context.purpose} onSettle={settle} />);
  });
}
