"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Truck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckboxField } from "@/components/ui/checkbox";
import { Chip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field } from "@/components/form/field";
import { ActionForm } from "@/components/form/action-form";
import {
  AddressFields,
  type AddressFieldKey,
  type AddressFieldState,
  type AddressValue,
} from "@/components/customers/address-fields";
import type { Country } from "@/lib/api/geo";
import type { PortalShippingAddress } from "@/lib/portal-api";
import {
  portalArchiveShippingAction,
  portalMakeDefaultShippingAction,
  portalSaveShippingAddressAction,
} from "./actions";
import { usePortalSession } from "./portal-session-context";
import { Row, RowList } from "../../chrome";
import { shippingLines } from "./shipping-format";

/** What the engine requires of a ship-to (region and postal code only where the country has them). */
const SHIPPING_FIELD_STATES: Partial<Record<AddressFieldKey, AddressFieldState>> = {
  line1: "mandatory",
  city: "mandatory",
  state_code: "mandatory",
  postal_code: "mandatory",
  country: "mandatory",
  phone: "show",
};

/**
 * The buyer's shipping address book: add, edit, make default, remove. "Remove" posts the
 * engine's archive; the portal offers no restore, so the buyer word is Remove.
 */
export function ShippingAddresses({
  addresses,
  countries,
  billing,
}: {
  addresses: PortalShippingAddress[];
  countries: Country[];
  /** The billing address with its contact name resolved: the start of a new address. */
  billing: AddressValue;
}) {
  const session = usePortalSession();
  const router = useRouter();
  /** `null` = closed; `"new"` = add; else the address being edited. */
  const [editing, setEditing] = React.useState<PortalShippingAddress | "new" | null>(null);
  const [removing, setRemoving] = React.useState<PortalShippingAddress | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function makeDefault(a: PortalShippingAddress) {
    setBusy(a.id);
    const res = await portalMakeDefaultShippingAction(session, a.id);
    setBusy(null);
    if (!res.ok) return void toast.error(res.error ?? "We could not change your default address.");
    toast.success("Default address changed.");
    router.refresh();
  }

  async function remove(a: PortalShippingAddress) {
    const res = await portalArchiveShippingAction(session, a.id);
    // The engine's 409 names the subscription that still ships to it (or to the default).
    if (!res.ok) return void toast.error(res.error ?? "We could not remove the address.");
    toast.success("Address removed.");
    router.refresh();
  }

  const current = editing === "new" ? null : editing;
  /** Bumped by "Use my billing address" to remount the fields with the billing values. */
  const [fill, setFill] = React.useState<{ n: number; value: AddressValue | null }>({
    n: 0,
    value: null,
  });
  // A new address starts in the billing country, for the billing contact.
  const start: AddressValue = {
    first_name: billing.first_name,
    last_name: billing.last_name,
    company: billing.company,
    country: billing.country,
  };
  const hasBilling = Boolean(billing.line1 && billing.country);

  return (
    <>
      {addresses.length === 0 ? (
        <EmptyState
          compact
          icon={<Truck />}
          title="No shipping address"
          description="Add the address where we send your orders."
        />
      ) : (
        <RowList>
          {addresses.map((a) => (
            <Row key={a.id}>
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-sm font-medium wrap-break-word">
                      {a.label?.trim() || "Shipping address"}
                    </span>
                    {a.is_default ? <Chip>Default</Chip> : null}
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed whitespace-pre-line text-muted-foreground">
                    {shippingLines(a, countries).join("\n")}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:ml-12">
                {/* Outline, never filled: a hosted page paints `--solid` in the merchant's brand. */}
                {!a.is_default ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === a.id}
                    onClick={() => makeDefault(a)}
                  >
                    Make default
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" onClick={() => setEditing(a)}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRemoving(a)}>
                  Remove
                </Button>
              </div>
            </Row>
          ))}
        </RowList>
      )}
      <div className="border-t px-5 py-4">
        <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          Add address
        </Button>
      </div>

      {/* `data-brand`: Radix portals the dialog outside the storefront's brand wrapper. */}
      <Dialog
        open={editing != null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
          setFill({ n: 0, value: null });
        }}
      >
        <DialogContent size="md" data-brand className="flex max-h-[85vh] flex-col overflow-hidden">
          <DialogHeader className="pr-12">
            <DialogTitle>
              {current ? "Edit shipping address" : "Add a shipping address"}
            </DialogTitle>
            <DialogDescription>
              We send your orders to this address. Your billing address does not change.
            </DialogDescription>
          </DialogHeader>
          {editing != null ? (
            <ActionForm
              key={current?.id ?? "new"}
              action={portalSaveShippingAddressAction.bind(null, session)}
              onSuccess={() => setEditing(null)}
              className="flex min-h-0 flex-1 flex-col gap-4"
            >
              {current ? <input type="hidden" name="addr" value={current.id} /> : null}
              {/* The body scrolls; the footer stays in view on the long form. */}
              <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-1">
                {hasBilling ? (
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setFill((f) => ({ n: f.n + 1, value: billing }))}
                    >
                      Use my billing address
                    </Button>
                  </div>
                ) : null}
                <AddressFields
                  key={fill.n}
                  countries={countries}
                  value={fill.value ?? current ?? start}
                  contactHeading="Recipient"
                  autoCompleteSection="shipping"
                  fieldStates={SHIPPING_FIELD_STATES}
                />
                <Field
                  name="label"
                  label="Label"
                  help="This is optional. For example, Home or Office."
                >
                  <Input name="label" defaultValue={current?.label ?? ""} maxLength={100} />
                </Field>
                {/* The first address becomes the default by itself; a default is changed with "Make default". */}
                {!current && addresses.length > 0 ? (
                  <CheckboxField name="is_default" label="Make this my default shipping address" />
                ) : null}
              </div>
              <DialogFooter className="shrink-0 border-t pt-4">
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit">{current ? "Save address" : "Add address"}</Button>
              </DialogFooter>
            </ActionForm>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        brand
        open={removing != null}
        onOpenChange={(o) => {
          if (!o) setRemoving(null);
        }}
        title="Remove this address?"
        description={
          removing?.is_default
            ? "We remove it from your list of addresses. It is your default address, so you have no default address until you make a different one the default. Invoices that show it do not change."
            : "We remove it from your list of addresses. Invoices that show it do not change."
        }
        confirmLabel="Remove"
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </>
  );
}
