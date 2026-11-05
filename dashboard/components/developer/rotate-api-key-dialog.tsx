"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { SelectField } from "@/components/ui/select-field";
import { SecretDialog, revealOf } from "@/components/developer/secret-action";
import type { ActionResult } from "@/lib/action-result";
import type { SecretActionResult } from "@/app/actions";

type Reveal = NonNullable<SecretActionResult["reveal"]>;

/**
 * Rotate one API key: select how long the old key keeps working, then show the new secret once.
 * The reveal lives OUTSIDE the form dialog, which unmounts its content when it closes.
 */
export function RotateApiKeyDialog({
  keyId,
  prefix,
  action,
}: {
  keyId: string;
  prefix: string;
  action: (prev: ActionResult | null, formData: FormData) => Promise<SecretActionResult>;
}) {
  const [open, setOpen] = React.useState(false);
  const [reveal, setReveal] = React.useState<Reveal | null>(null);
  const fieldId = `overlap_seconds_${keyId}`;
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            Rotate
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate this API key?</DialogTitle>
            <DialogDescription>
              We create a new key with the same name, mode and scope. The new secret shows one time.{" "}
              <span className="font-mono">{prefix}…</span> continues to operate until the time you
              select, then it stops.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={action}
            className="space-y-4"
            onSuccess={(r) => {
              setOpen(false);
              setReveal(revealOf(r));
            }}
          >
            <input type="hidden" name="id" value={keyId} />
            {/* 24 hours is preselected because it is what the API applies when no value is sent. */}
            <Field name="overlap_seconds" label="The old key stops">
              <SelectField
                id={fieldId}
                name="overlap_seconds"
                ariaLabel="When the old key stops"
                defaultValue="86400"
                options={[
                  { value: "0", label: "Immediately" },
                  { value: "3600", label: "After 1 hour" },
                  { value: "86400", label: "After 24 hours" },
                  { value: "604800", label: "After 7 days" },
                ]}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>Rotate key</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
      <SecretDialog reveal={reveal} onClose={() => setReveal(null)} />
    </>
  );
}
