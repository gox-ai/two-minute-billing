"use client";

import * as React from "react";
import { Pencil, Plus } from "lucide-react";
import { EditDrawer } from "@/components/edit-drawer";
import { AddressFields } from "@/components/customers/address-fields";
import { ActionForm } from "@/components/form/action-form";
import { ActionButton } from "@/components/action-button";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import { Chip } from "@/components/patterns/chip";
import type { ShippingAddress } from "@/lib/api";
import type { Country } from "@/lib/api/geo";
import {
  archiveShippingAddressAction,
  makeDefaultShippingAddressAction,
  restoreShippingAddressAction,
  saveShippingAddressAction,
} from "@/app/(dashboard)/businesses/[biz]/customers/[cus]/actions";

/** Recipient line: the person, else the company. */
export function shippingRecipient(a: ShippingAddress): string {
  return [a.first_name, a.last_name].filter(Boolean).join(" ");
}

/** Add (no `address`) or edit one book entry. */
export function ShippingAddressButton({
  biz,
  cus,
  countries,
  address,
  first,
}: {
  biz: string;
  cus: string;
  countries: Country[];
  address?: ShippingAddress;
  /** No live default yet: the engine makes the new address the default anyway. */
  first?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant={address ? "ghost" : "outline"} size="sm" onClick={() => setOpen(true)}>
        {address ? <Pencil className="size-4" /> : <Plus className="size-4" />}
        {address ? "Edit" : "Add address"}
      </Button>
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        wide
        title={address ? "Edit shipping address" : "Add shipping address"}
        description={address ? <span className="font-mono text-xs">{address.id}</span> : undefined}
      >
        <ActionForm
          action={saveShippingAddressAction}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="cus" value={cus} />
          {address ? <input type="hidden" name="addr" value={address.id} /> : null}
          <Field name="label" label="Label" help="A short name, for example Office or Warehouse.">
            <Input name="label" maxLength={100} defaultValue={address?.label ?? ""} />
          </Field>
          <AddressFields
            countries={countries}
            value={address}
            prefix="sa_"
            requireRest={false}
            contactHeading="Recipient"
          />
          {address || first ? null : (
            <CheckboxField
              name="is_default"
              label="Make this the default shipping address"
              hint="Subscriptions with no address of their own ship to the default."
            />
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">{address ? "Save address" : "Add address"}</Button>
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}

/**
 * The address book: live entries (default first), and archived ones on request, each
 * with Restore. `addresses` is the `include_archived=true` read.
 */
export function ShippingAddressList({
  biz,
  cus,
  countries,
  addresses,
}: {
  biz: string;
  cus: string;
  countries: Country[];
  addresses: ShippingAddress[];
}) {
  const [showArchived, setShowArchived] = React.useState(false);
  const live = addresses
    .filter((a) => !a.archived)
    .sort((a, b) => Number(b.is_default) - Number(a.is_default));
  const archived = addresses.filter((a) => a.archived);
  const rows = showArchived ? [...live, ...archived] : live;
  return (
    <div className="flex flex-col gap-3">
      {live.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No shipping addresses. Add one for subscriptions that ship goods.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="divide-y">
          {rows.map((a) => (
            <ShippingAddressRow key={a.id} biz={biz} cus={cus} countries={countries} a={a} />
          ))}
        </ul>
      ) : null}
      {archived.length > 0 ? (
        <div>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ShippingAddressRow({
  biz,
  cus,
  countries,
  a,
}: {
  biz: string;
  cus: string;
  countries: Country[];
  a: ShippingAddress;
}) {
  const recipient = shippingRecipient(a);
  const name = a.label || recipient || a.line1 || a.id;
  const fields = { biz, cus, addr: a.id };
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-[1_1_14rem]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium wrap-anywhere">{a.label || "No label"}</span>
          {a.is_default ? <Chip tone="blue">Default</Chip> : null}
          {a.archived ? <Chip tone="gray">Archived</Chip> : null}
        </div>
        <address className="mt-1 text-sm leading-relaxed text-muted-foreground not-italic">
          {recipient ? <div className="text-foreground">{recipient}</div> : null}
          {a.company ? <div>{a.company}</div> : null}
          {[a.line1, a.line2, a.line3].filter(Boolean).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          <div>{[a.city, a.state_code || a.state, a.postal_code].filter(Boolean).join(", ")}</div>
          {a.country ? <div>{a.country}</div> : null}
          {a.phone ? <div>{a.phone}</div> : null}
        </address>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {a.archived ? (
          // The engine restores it as a non-default entry.
          <ActionButton
            resultAction={restoreShippingAddressAction}
            fields={fields}
            label="Restore"
            variant="ghost"
            size="sm"
          />
        ) : (
          <>
            <ShippingAddressButton biz={biz} cus={cus} countries={countries} address={a} />
            {a.is_default ? null : (
              <ActionButton
                resultAction={makeDefaultShippingAddressAction}
                fields={fields}
                label="Make default"
                variant="ghost"
                size="sm"
              />
            )}
            <ActionButton
              resultAction={archiveShippingAddressAction}
              fields={fields}
              label="Archive"
              variant="ghost"
              size="sm"
              confirm={{
                title: "Archive shipping address?",
                description: a.is_default
                  ? `${name} is the default. You cannot archive it while a live subscription ships to the default. Make a different address the default first. If no subscription ships to it, the customer has no default shipping address after you archive it. You can restore it later.`
                  : `${name} moves to the archived addresses. You can restore it later. Invoices keep the address that they show.`,
                confirmLabel: "Archive",
              }}
            />
          </>
        )}
      </div>
    </li>
  );
}
