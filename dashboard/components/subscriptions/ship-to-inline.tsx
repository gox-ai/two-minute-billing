"use client";

import * as React from "react";
import Link from "next/link";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import type { ShippingAddress } from "@/lib/api";
import { setSubscriptionShippingAddressAction } from "@/app/(dashboard)/businesses/[biz]/subscriptions/actions";

/** "Office · 1 Main St, Springfield, US" for an option label. */
function oneLine(a: ShippingAddress): string {
  const where = [a.line1, a.city, a.country].filter(Boolean).join(", ");
  return a.label ? `${a.label} · ${where}` : where;
}

/**
 * The subscription's ship-to: the resolved address, where it comes from, and a Change
 * control that PATCHes `shipping_address_id` ("" = the customer's default).
 */
export function ShipToInline({
  biz,
  sub,
  customer,
  pickedId,
  resolved,
  addresses,
  canEdit,
}: {
  biz: string;
  sub: string;
  customer: string | null | undefined;
  /** The subscription's own pick; null = it follows the customer's default. */
  pickedId: string | null | undefined;
  resolved: ShippingAddress | null | undefined;
  /** The customer's live address book; null when the read failed. */
  addresses: ShippingAddress[] | null;
  canEdit: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const live = addresses ?? [];
  const def = live.find((a) => a.is_default) ?? null;
  const manageHref = customer
    ? `/businesses/${biz}/customers/${customer}#shipping-addresses`
    : null;

  if (!editing) {
    const recipient = resolved
      ? [resolved.first_name, resolved.last_name].filter(Boolean).join(" ")
      : "";
    return (
      <div className="flex flex-col gap-0.5">
        {resolved ? (
          <address className="leading-relaxed not-italic">
            {resolved.label ? <div className="font-medium">{resolved.label}</div> : null}
            {recipient || resolved.company ? (
              <div>{[recipient, resolved.company].filter(Boolean).join(", ")}</div>
            ) : null}
            <div className="text-muted-foreground">
              {[
                resolved.line1,
                resolved.line2,
                resolved.line3,
                resolved.city,
                resolved.state_code || resolved.state,
                resolved.postal_code,
                resolved.country,
              ]
                .filter(Boolean)
                .join(", ")}
            </div>
          </address>
        ) : (
          <span className="text-muted-foreground">No shipping address</span>
        )}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>
            {pickedId
              ? [
                  "set on this subscription",
                  resolved?.is_default ? "also the customer's default" : null,
                  resolved?.archived ? "archived" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "the customer's default address"}
          </span>
          {canEdit && live.length > 0 ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => setEditing(true)}
            >
              Change
            </Button>
          ) : null}
          {live.length === 0 && manageHref ? (
            <Link href={manageHref} className="text-primary hover:underline">
              Add on the customer
            </Link>
          ) : null}
        </span>
      </div>
    );
  }

  const options = [
    {
      value: "",
      label: def
        ? `Customer's default address (${oneLine(def)})`
        : "Customer's default address (none)",
    },
    ...live.map((a) => ({ value: a.id, label: oneLine(a) })),
    // An archived pick is not selectable again, but the select must still show it.
    ...(pickedId && !live.some((a) => a.id === pickedId)
      ? [
          {
            value: pickedId,
            label: `${resolved ? oneLine(resolved) : pickedId} (archived)`,
            disabled: true,
          },
        ]
      : []),
  ];

  return (
    <ActionForm
      action={setSubscriptionShippingAddressAction}
      className="flex flex-wrap items-center gap-2"
      onSuccess={() => setEditing(false)}
    >
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="sub" value={sub} />
      <SelectField
        name="shipping_address_id"
        defaultValue={pickedId ?? ""}
        ariaLabel="Ship to"
        className="h-7 w-auto max-w-full min-w-56 text-xs"
        options={options}
      />
      <SubmitButton size="sm" className="h-7 px-2 text-xs">
        Save
      </SubmitButton>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => setEditing(false)}
      >
        Cancel
      </Button>
    </ActionForm>
  );
}
