"use client";

import * as React from "react";
import { attachItemToPlanAction } from "@/app/(dashboard)/businesses/[biz]/catalog/products/[prod]/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { AttachedItemConfig, Product } from "@/lib/api";
import { SelectField } from "@/components/ui/select-field";
import { Field } from "@/components/form/field";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Alert } from "@/components/ui/alert";
import { SwitchField } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";

type ChargeOnEvent = "subscription_creation" | "trial_start" | "activation" | "on_demand";

const CHARGE_ON_EVENT_LABELS: Record<ChargeOnEvent, string> = {
  subscription_creation: "On creation",
  trial_start: "On trial start",
  activation: "On activation",
  on_demand: "On demand",
};

/**
 * Attach (or re-configure) an add-on or charge on a plan.
 *
 * - Add-on: applicability + default_quantity + billing_cycles.
 * - Charge: mandatory/optional + charge_on_event + default_quantity. The engine bills a
 *   charge once and never cycle-caps it, so neither control is offered.
 * - Edit mode: modal is pre-filled from the existing AttachedItemConfig.
 *
 * `addons` must already exclude charges with no one-time price: the engine refuses them.
 */
export function AttachAddonModal({
  biz,
  plan,
  addons,
  editItem,
  editConfig,
  note,
  trigger,
  quantityApplies,
}: {
  biz: string;
  plan: string;
  /** Items not yet attached (or single item when editing). */
  addons: Product[];
  /** When editing, the product being reconfigured. */
  editItem?: Product;
  /** Existing config when editing. */
  editConfig?: AttachedItemConfig;
  /**
   * Shown above the fields. Used when the item is applicable for a reason this form
   * does NOT control (`addon_applies_to_all`, or an implied differential price), so the
   * reader knows saving stores a plan-specific row rather than editing what they see.
   */
  note?: React.ReactNode;
  /** Custom trigger element — defaults to a "+ Attach" button. */
  trigger?: React.ReactNode;
  /**
   * product id → does a quantity mean anything for it, from
   * `quantityAppliesByProduct` over the business's prices. A `flat`-priced item is
   * `false` and the Default-quantity field is OMITTED rather than rendered dead:
   * the engine ignores quantity when rating a flat price AND refuses any value but
   * 1 at subscription-create time. Absent map / unknown id ⇒ shown.
   */
  quantityApplies?: Record<string, boolean>;
}) {
  const [open, setOpen] = React.useState(false);
  const [selectedAddon, setSelectedAddon] = React.useState<string>(editItem?.id ?? "");
  const [canChangeQuantity, setCanChangeQuantity] = useDefaultState(
    editConfig?.customerCanChangeQuantity ?? true,
  );

  const selectedProduct = editItem ?? addons.find((a) => a.id === selectedAddon);
  const isCharge = selectedProduct?.kind === "charge";
  // No item picked yet ⇒ show the field; hiding it and revealing it on select made the
  // dialog jump a row height on every change.
  const showQuantity = !selectedProduct || (quantityApplies?.[selectedProduct.id] ?? true);
  // Legacy/imported rows can hold a quantity the engine would now refuse. Saying so
  // beats silently normalising it to 1 on the next save.
  const staleQuantity =
    !showQuantity && editConfig?.defaultQuantity != null && editConfig.defaultQuantity !== 1;

  // Reset selection when modal opens in add mode.
  React.useEffect(() => {
    if (open && !editItem) setSelectedAddon("");
  }, [open, editItem]);

  const title = editItem ? `Edit ${editItem.name}` : "Add an add-on or charge";
  const description = editItem
    ? "Change how this item works on this plan."
    : "Select an add-on or charge. Then configure how it applies to this plan.";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" disabled={addons.length === 0 && !editItem}>
            + Add
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ActionForm
          action={attachItemToPlanAction}
          onSuccess={() => setOpen(false)}
          className="space-y-4"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="plan" value={plan} />

          {note ? <Alert tone="info">{note}</Alert> : null}

          {/* Addon / charge selector — locked when editing */}
          {editItem ? (
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Item</span>
              <input type="hidden" name="addon" value={editItem.id} />
              <span className="flex h-9 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
                {editItem.name}
                <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs capitalize">
                  {editItem.kind}
                </span>
              </span>
            </div>
          ) : (
            <Field name="addon" label="Item" required>
              <SelectField
                name="addon"
                required
                value={selectedAddon}
                onValueChange={setSelectedAddon}
                ariaLabel="Item"
                placeholder="Select an add-on or charge…"
                options={addons.map((a) => ({
                  value: a.id,
                  label: a.kind === "charge" ? `${a.name} (charge)` : a.name,
                }))}
              />
            </Field>
          )}

          {/* Keyed on kind so switching item re-seeds the default. */}
          <Field name="applicability" label="Applicability" required>
            <SelectField
              key={isCharge ? "charge" : "addon"}
              name="applicability"
              required
              defaultValue={
                isCharge && editConfig?.applicability === "recommended"
                  ? "optional"
                  : (editConfig?.applicability ?? "optional")
              }
              ariaLabel="Applicability"
              options={[
                {
                  value: "mandatory",
                  label: isCharge
                    ? "Mandatory: billed automatically at the charge event"
                    : "Mandatory: always included, cannot be removed",
                },
                ...(isCharge
                  ? []
                  : [{ value: "recommended", label: "Recommended: suggested at checkout" }]),
                { value: "optional", label: "Optional" },
              ]}
            />
          </Field>

          {/* Charge-specific fields */}
          {isCharge ? (
            <>
              <Field name="charge_on_event" label="Charge event">
                <SelectField
                  name="charge_on_event"
                  defaultValue={editConfig?.chargeOnEvent ?? "subscription_creation"}
                  ariaLabel="Charge on event"
                  options={(
                    Object.entries(CHARGE_ON_EVENT_LABELS) as [ChargeOnEvent, string][]
                  ).map(([v, l]) => ({ value: v, label: l }))}
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                We bill a charge one time, when its event occurs.
              </p>
            </>
          ) : null}

          {/* Billing cycles cap — add-ons only. Default quantity only where it rates. */}
          <div className={cn("grid gap-4", showQuantity && !isCharge && "sm:grid-cols-2")}>
            {showQuantity ? (
              <Field name="default_quantity" label="Default quantity">
                <Input
                  name="default_quantity"
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={editConfig?.defaultQuantity ?? 1}
                />
              </Field>
            ) : null}

            {isCharge ? null : (
              <Field
                name="billing_cycles"
                label="Billing cycles cap"
                help="The maximum number of renewal cycles that we bill this item. Leave empty for no limit."
              >
                <Input
                  name="billing_cycles"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="Leave empty for no limit"
                  defaultValue={editConfig?.billingCycles ?? ""}
                />
              </Field>
            )}
          </div>

          {/* Portal limits: add-ons whose quantity rates. Charges are not sold in the portal. */}
          {showQuantity && !isCharge ? (
            <div className="space-y-3 rounded-lg border p-3">
              <input type="hidden" name="portal_limits" value="1" />
              <div>
                <div className="text-sm font-medium">Customer portal</div>
                <p className="text-xs text-muted-foreground">
                  These limits apply to customers in the portal. Your team can set any quantity.
                </p>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">Customers can change the quantity</span>
                <SwitchField
                  name="customer_can_change_quantity"
                  ariaLabel="Customers can change the quantity"
                  checked={canChangeQuantity}
                  onCheckedChange={setCanChangeQuantity}
                />
              </div>
              {/* A fixed quantity makes the limits moot: hide them, keep the stored values. */}
              {canChangeQuantity ? null : (
                <>
                  <input type="hidden" name="min_quantity" value={editConfig?.minQuantity ?? ""} />
                  <input type="hidden" name="max_quantity" value={editConfig?.maxQuantity ?? ""} />
                  <input type="hidden" name="quantity_step" value={editConfig?.quantityStep ?? 1} />
                  <p className="text-xs text-muted-foreground">
                    Customers get the default quantity and cannot change it.
                  </p>
                </>
              )}
              {canChangeQuantity ? (
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field name="min_quantity" label="Minimum">
                    <Input
                      name="min_quantity"
                      type="number"
                      min={1}
                      step={1}
                      placeholder="1"
                      defaultValue={editConfig?.minQuantity ?? ""}
                    />
                  </Field>
                  <Field name="max_quantity" label="Maximum">
                    <Input
                      name="max_quantity"
                      type="number"
                      min={1}
                      step={1}
                      placeholder="No limit"
                      defaultValue={editConfig?.maxQuantity ?? ""}
                    />
                  </Field>
                  <Field name="quantity_step" label="Step">
                    <Input
                      name="quantity_step"
                      type="number"
                      min={1}
                      step={1}
                      defaultValue={editConfig?.quantityStep ?? 1}
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          ) : null}

          {!showQuantity ? (
            <p className="text-xs text-muted-foreground">
              This item has a flat-fee price. The quantity does not change the amount. We bill the
              fixed amount and accept only a quantity of 1.
              {staleQuantity
                ? ` Save changes the stored quantity of ${editConfig!.defaultQuantity} to 1.`
                : ""}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>{editItem ? "Save" : "Add"}</SubmitButton>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
