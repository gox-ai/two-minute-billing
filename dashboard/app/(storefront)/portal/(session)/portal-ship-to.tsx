"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDefaultState } from "@/lib/use-default-state";
import { Alert } from "@/components/ui/alert";
import { RadioField } from "@/components/ui/radio-group";
import type { PortalShippingAddress } from "@/lib/portal-api";
import { portalSetShipToAction } from "./actions";
import { shippingSummary } from "./shipping-format";

/** Radio value for "ship to my default address" (posts `address_id: null`). */
const DEFAULT = "__default";

/**
 * "Ships to" on one subscription, with Change. The options are the customer's live
 * addresses plus the default, which follows whatever address is the default later.
 */
export function PortalShipTo({
  subscription,
  shipTo,
  shipToId,
  addresses,
  changeable,
}: {
  subscription: string;
  /** Where it ships now (its own address, else the default). */
  shipTo: PortalShippingAddress | null;
  /** Its own `addr_…`; null = it follows the default. */
  shipToId: string | null;
  addresses: PortalShippingAddress[];
  /** False for a cancelled subscription: the engine refuses the change. */
  changeable: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = useDefaultState<string>(shipToId ?? DEFAULT);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const def = addresses.find((a) => a.is_default) ?? null;

  function openDialog() {
    setSelected(shipToId ?? DEFAULT);
    setError(null);
    setOpen(true);
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await portalSetShipToAction(subscription, selected === DEFAULT ? null : selected);
    setBusy(false);
    if (!res.ok) return setError(res.error ?? "We could not change the shipping address.");
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="border-t px-5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">
          Ships to:{" "}
          <span className="text-foreground">
            {shipTo ? shippingSummary(shipTo) : "No shipping address"}
          </span>
          {shipTo && !shipToId ? " (your default address)" : ""}
        </span>
        {changeable && addresses.length > 0 ? (
          <button
            type="button"
            onClick={openDialog}
            className="text-xs font-medium text-primary transition-colors hover:underline"
          >
            Change
          </button>
        ) : null}
      </div>

      {/* `data-brand`: Radix portals the dialog outside the storefront's brand wrapper. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm" data-brand className="flex max-h-[85vh] flex-col overflow-hidden">
          <DialogHeader className="pr-12">
            <DialogTitle>Change the shipping address</DialogTitle>
            <DialogDescription>
              We send this subscription&apos;s orders to the address that you select.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
            <RadioField
              ariaLabel="Shipping address"
              value={selected}
              onValueChange={setSelected}
              options={[
                {
                  value: DEFAULT,
                  label: "My default address",
                  hint: def
                    ? `${shippingSummary(def)}. If you change your default, this changes too.`
                    : "You have no default address.",
                },
                ...addresses.map((a) => ({
                  value: a.id,
                  label: a.label?.trim() || shippingSummary(a),
                  hint: a.label?.trim() ? shippingSummary(a) : undefined,
                })),
              ]}
            />
          </div>
          {error ? (
            <Alert tone="error" className="text-xs">
              {error}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
