"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ActionForm } from "@/components/form/action-form";
import type { ActionResult } from "@/lib/action-result";

type Variant = React.ComponentProps<typeof Button>["variant"];
type ResultAction = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/**
 * Submit a server action as a one-click button with hidden fields, optionally
 * gated behind a confirm dialog (the design bar's "confirm destructive actions").
 *
 * Pass `resultAction` for an action returning an ActionResult: it runs through
 * <ActionForm>, so the page stays where it is and the outcome is toasted.
 * `action` is the older void form, which must redirect to report anything.
 */
export function ActionButton({
  action,
  resultAction,
  onSuccess,
  fields,
  label,
  variant = "outline",
  size,
  confirm,
  className,
}: {
  fields: Record<string, string>;
  label: React.ReactNode;
  variant?: Variant;
  size?: React.ComponentProps<typeof Button>["size"];
  confirm?: {
    title: string;
    description?: React.ReactNode;
    confirmLabel?: string;
    /** The dismiss button. Set it when the action itself is a "Cancel …". */
    cancelLabel?: string;
    destructive?: boolean;
  };
  className?: string;
} & (
  | {
      action: (formData: FormData) => void | Promise<void>;
      resultAction?: never;
      onSuccess?: never;
    }
  | { resultAction: ResultAction; onSuccess?: (result: ActionResult) => void; action?: never }
)) {
  const formRef = React.useRef<HTMLFormElement>(null);
  const [open, setOpen] = React.useState(false);

  const body = (
    <>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Button
        type={confirm ? "button" : "submit"}
        variant={variant}
        size={size}
        className={className}
        onClick={confirm ? () => setOpen(true) : undefined}
      >
        {label}
      </Button>
    </>
  );

  return (
    <>
      {resultAction ? (
        <ActionForm action={resultAction} formRef={formRef} onSuccess={onSuccess}>
          {body}
        </ActionForm>
      ) : (
        <form ref={formRef} action={action}>
          {body}
        </form>
      )}
      {confirm ? (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.confirmLabel ?? "Confirm"}
          {...(confirm.cancelLabel ? { cancelLabel: confirm.cancelLabel } : {})}
          destructive={confirm.destructive}
          onConfirm={() => formRef.current?.requestSubmit()}
        />
      ) : null}
    </>
  );
}
