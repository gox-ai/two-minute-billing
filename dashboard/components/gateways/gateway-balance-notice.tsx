"use client";

import * as React from "react";
import { Alert } from "@/components/ui/alert";
import { useDisplayTz } from "@/components/business-tz";
import { fmtDateTime, money } from "@/lib/format";
import { loadGatewayBalanceAction } from "@/app/(dashboard)/businesses/[biz]/settings/gateways/actions";
import type { GatewayBalance } from "@/lib/api/gateways";

/**
 * The gateway balance beside a refund, read when the dialog opens. A gateway that pays
 * refunds from the merchant's balance (PayPal) refuses one the balance cannot cover, so
 * the operator sees that before sending. Renders nothing for a gateway with no balance,
 * or when the operator cannot read gateway accounts.
 */
export function GatewayBalanceNotice({
  biz,
  account,
  currency,
  refundMinor,
}: {
  biz: string;
  /** The gateway account the refund goes through, and its label. */
  account: { id: string; name: string };
  currency: string;
  /** The full refund the dialog starts with. */
  refundMinor: number;
}) {
  const tz = useDisplayTz();
  const [balance, setBalance] = React.useState<GatewayBalance | null | "loading">("loading");
  React.useEffect(() => {
    let live = true;
    loadGatewayBalanceAction(biz, account.id, currency).then((b) => {
      if (live) setBalance(b);
    });
    return () => {
      live = false;
    };
  }, [biz, account.id, currency]);

  if (balance === "loading")
    return (
      <p className="m-0 text-sm text-muted-foreground">
        We are reading the {account.name} balance.
      </p>
    );
  if (!balance || !balance.supported) return null;
  if (!balance.available)
    return (
      <Alert tone="info" title={`We cannot read the ${account.name} balance.`}>
        {balance.message}
      </Alert>
    );

  const row = balance.balances.find((b) => b.currency === currency.toUpperCase());
  const availableMinor = row?.available_minor ?? 0;
  const asOf = balance.as_of
    ? ` ${account.name} updated this figure on ${fmtDateTime(balance.as_of, tz)}.`
    : "";
  if (availableMinor >= refundMinor)
    return (
      <Alert tone="info">
        {account.name} balance: {money(availableMinor, currency)} available.{asOf}
      </Alert>
    );
  return (
    <Alert tone="warning" title={`The ${account.name} balance is less than this refund.`}>
      Available: {money(availableMinor, currency)}. Full refund: {money(refundMinor, currency)}.{" "}
      {account.name} can refuse the refund. Add money to the {account.name} balance, or make sure
      that the bank account linked to {account.name} can pay the difference.{asOf}
    </Alert>
  );
}
