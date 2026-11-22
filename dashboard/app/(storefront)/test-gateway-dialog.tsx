"use client";

import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { GatewaySdkContext, GatewaySdkResult } from "@/lib/gateway-sdk";
import { PaymentDialogFooter, SdkFrame } from "./payment-dialog";

/** The nonces the test gateway's adapter expects back as `client_result.nonce`. */
const APPROVE = { nonce: "tmtest_ok" };
const DECLINE = { nonce: "tmtest_decline" };

function TestGatewayDialog({
  open,
  purpose,
  inline,
  onSettle,
}: {
  open: boolean;
  purpose: GatewaySdkContext["purpose"];
  inline: boolean;
  onSettle: (result: GatewaySdkResult) => void;
}) {
  return (
    <SdkFrame
      inline={inline}
      open={open}
      onClose={() => onSettle({ status: "dismissed" })}
      title={purpose === "setup" ? "Test payment method" : "Test payment"}
      description={
        purpose === "setup"
          ? "This is a test payment method. No money moves. Select Approve to save it or Decline to refuse it."
          : "This is a test payment. No money moves. Select Approve to authorize it or Decline to refuse it."
      }
    >
      {/* Decline is an outcome, not a way out (the × is), so it takes the outline slot. */}
      <PaymentDialogFooter>
        <Button
          variant="outline"
          onClick={() => onSettle({ status: "completed", clientResult: DECLINE })}
        >
          Decline
        </Button>
        <Button onClick={() => onSettle({ status: "completed", clientResult: APPROVE })}>
          Approve
        </Button>
      </PaymentDialogFooter>
    </SdkFrame>
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
    const inline = Boolean(context.inline);
    const host = context.inline ?? document.createElement("div");
    if (!inline) document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const view = (open: boolean) => (
      <TestGatewayDialog open={open} purpose={context.purpose} inline={inline} onSettle={settle} />
    );
    const settle = (result: GatewaySdkResult) => {
      if (settled) return;
      settled = true;
      root.render(view(false));
      resolve(result);
      setTimeout(() => {
        root.unmount();
        if (!inline) host.remove();
      }, 300);
    };
    root.render(view(true));
  });
}
