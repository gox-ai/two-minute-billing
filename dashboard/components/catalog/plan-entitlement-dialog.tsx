"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { setPlanEntitlementAction } from "@/app/(dashboard)/businesses/[biz]/catalog/products/[prod]/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";
import { Field } from "@/components/form/field";
import { ActionForm } from "@/components/form/action-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { Feature, PlanEntitlement } from "@/lib/api";
import { RenewsField } from "@/components/catalog/renews-field";
import {
  draftOf,
  isCreditsLink,
  resetLabel,
  resetOf,
  type CreditsLinkOption,
  type ResetDraft,
} from "@/lib/reset";

/**
 * Add or edit one plan entitlement. The POST upserts on (product, feature), so edit is
 * the same call with the feature locked. The value control follows the feature type:
 * a switch is on/off, a quota or meter is a whole number or unlimited. A meter allowance also
 * renews (G3b): "Same as the credits" posts a link the engine resolves per subscription, else
 * its own clock. A stored copy of a schedule stays a plain reset.
 */
export function PlanEntitlementDialog({
  biz,
  prod,
  features,
  edit,
  creditsLink,
  trigger,
}: {
  biz: string;
  prod: string;
  /** Features that can be added (add mode); ignored when editing. */
  features: Feature[];
  edit?: PlanEntitlement;
  /** What "Same as the credits" follows; undefined = the plan grants no credits per period. */
  creditsLink?: CreditsLinkOption;
  trigger: React.ReactNode;
}) {
  const linkable = !!creditsLink && "reset" in creditsLink;
  const initialSame = () => linkable && (edit ? isCreditsLink(edit.reset) : true);
  const [same, setSame] = useDefaultState(initialSame());
  const linked = same && linkable;
  const [reset, setReset] = React.useState<ResetDraft>(() => draftOf(edit?.reset));
  const [open, setOpen] = React.useState(false);
  const [featureKey, setFeatureKey] = React.useState(edit?.feature ?? "");
  const [unlimited, setUnlimited] = React.useState(edit?.value === "unlimited");
  const [seq, setSeq] = React.useState(0);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setFeatureKey(edit?.feature ?? "");
      setUnlimited(edit?.value === "unlimited");
      setSame(initialSame());
      setReset(draftOf(edit?.reset));
      setSeq((s) => s + 1);
    }
  };

  const type = edit?.type ?? features.find((f) => f.key === featureKey)?.type;
  const unit = edit ? edit.unit : (features.find((f) => f.key === featureKey)?.unit ?? null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{edit ? `Edit ${edit.feature_name}` : "Add entitlement"}</DialogTitle>
          <DialogDescription>
            Every subscription on this plan gets this entitlement. An override on a subscription has
            priority.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          key={seq}
          action={setPlanEntitlementAction}
          onSuccess={() => setOpen(false)}
          className="space-y-4"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="prod" value={prod} />
          {edit ? (
            <input type="hidden" name="feature" value={edit.feature} />
          ) : (
            <Field name="feature" label="Feature" required>
              <SelectField
                name="feature"
                required
                value={featureKey}
                onValueChange={setFeatureKey}
                ariaLabel="Feature"
                placeholder="Select a feature…"
                options={features.map((f) => ({ value: f.key, label: `${f.name} (${f.key})` }))}
              />
            </Field>
          )}

          {type === "switch" ? (
            <Field name="value" label="Value" required>
              <SelectField
                name="value"
                required
                defaultValue={edit?.value ?? "true"}
                ariaLabel="Value"
                options={[
                  { value: "true", label: "Enabled" },
                  { value: "false", label: "Disabled" },
                ]}
              />
            </Field>
          ) : type ? (
            <div className="space-y-3">
              <Field name="value" label={unit ? `Value (${unit})` : "Value"} required={!unlimited}>
                <Input
                  name="value"
                  type="number"
                  min={0}
                  step={1}
                  required={!unlimited}
                  disabled={unlimited}
                  defaultValue={edit && edit.value !== "unlimited" ? edit.value : ""}
                />
              </Field>
              <CheckboxField
                name="unlimited"
                label="Unlimited"
                checked={unlimited}
                onCheckedChange={setUnlimited}
              />
            </div>
          ) : null}

          {type === "meter" ? (
            <div className="space-y-3">
              <input type="hidden" name="reset_present" value="1" />
              <input
                type="hidden"
                // Not "reset": a field by that name shadows form.reset(), which React calls.
                name="reset_json"
                value={JSON.stringify(reset)}
              />
              {creditsLink ? (
                <CheckboxField
                  name="reset_same"
                  label={
                    "reset" in creditsLink
                      ? `Same as the credits (renews ${resetLabel(creditsLink.reset)})`
                      : "Same as the credits"
                  }
                  hint={"blocked" in creditsLink ? creditsLink.blocked : undefined}
                  disabled={!linkable}
                  checked={linked}
                  onCheckedChange={setSame}
                />
              ) : null}
              {!linked ? (
                <RenewsField
                  name="reset"
                  target="allowance"
                  value={reset}
                  onChange={setReset}
                  help={'"Each billing term" counts the usage on the next invoice.'}
                />
              ) : null}
              {!linked && !resetOf(reset).ok ? (
                <p className="text-sm text-destructive">Enter a whole number from 1 to 1,000.</p>
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!type}>
              {edit ? "Save" : "Add entitlement"}
            </Button>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
