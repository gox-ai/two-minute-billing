"use client";

import * as React from "react";
import { Pause, Square } from "lucide-react";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { DateTimeField } from "@/components/form/datetime-field";
import { SubmitButton } from "@/components/form/submit-button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EditDrawer } from "@/components/edit-drawer";
import {
  closeInvoiceAction,
  regenerateInvoiceAction,
  stopDunningAction,
  pauseDunningAction,
} from "@/app/(dashboard)/businesses/[biz]/invoices/actions";
import type { ActionResult } from "@/lib/action-result";

type LifecycleVariant = React.ComponentProps<typeof Button>["variant"];

type Op = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/**
 * One-click lifecycle op rendered as an ActionForm (toasts + 409→reload via the
 * shared form plumbing), optionally gated by a confirm dialog. Rendered as a
 * rail link by default.
 */
export function LifecycleButton({
  action,
  biz,
  inv,
  label,
  className = "h-auto p-1 text-sm",
  variant = "link",
  confirm,
}: {
  action: Op;
  biz: string;
  inv: string;
  label: React.ReactNode;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  confirm?: {
    title: string;
    description?: React.ReactNode;
    confirmLabel?: string;
    destructive?: boolean;
  };
}) {
  const formRef = React.useRef<HTMLFormElement>(null);
  const [open, setOpen] = React.useState(false);

  return (
    <ActionForm action={action}>
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="inv" value={inv} />
      {/* ActionForm renders its own <form>; grab it to requestSubmit after confirm. */}
      <span
        ref={(el) => {
          formRef.current = el?.closest("form") ?? null;
        }}
        className="contents"
      />
      {confirm ? (
        <>
          <Button
            type="button"
            variant={variant}
            size="sm"
            className={className}
            onClick={() => setOpen(true)}
          >
            {label}
          </Button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title={confirm.title}
            description={confirm.description}
            confirmLabel={confirm.confirmLabel ?? "Confirm"}
            destructive={confirm.destructive}
            onConfirm={() => formRef.current?.requestSubmit()}
          />
        </>
      ) : (
        <SubmitButton variant={variant} size="sm" className={className}>
          {label}
        </SubmitButton>
      )}
    </ActionForm>
  );
}

export const CloseInvoiceButton = (p: {
  biz: string;
  inv: string;
  label?: React.ReactNode;
  variant?: LifecycleVariant;
  className?: string;
}) => (
  <LifecycleButton
    variant={p.variant}
    className={p.className}
    action={closeInvoiceAction}
    biz={p.biz}
    inv={p.inv}
    label={p.label ?? "Close (finalize)"}
    confirm={{
      title: "Close this invoice?",
      description:
        "This finalizes the pending invoice. We apply discount, tax and credits, then try to collect payment. Usage stops accruing.",
      confirmLabel: "Close invoice",
    }}
  />
);

export const RegenerateInvoiceButton = (p: {
  biz: string;
  inv: string;
  label?: React.ReactNode;
  variant?: LifecycleVariant;
  className?: string;
}) => (
  <LifecycleButton
    variant={p.variant}
    className={p.className}
    action={regenerateInvoiceAction}
    biz={p.biz}
    inv={p.inv}
    label={p.label ?? "Regenerate invoice"}
    confirm={{
      title: "Regenerate this voided invoice?",
      description:
        "We create a new invoice for the same billing period. The voided invoice does not change.",
      confirmLabel: "Regenerate",
    }}
  />
);

export const StopDunningButton = (p: {
  biz: string;
  inv: string;
  label?: React.ReactNode;
  /** `button`: an outline button for a card header; the default is a menu link. */
  variant?: "link" | "button";
}) => (
  <LifecycleButton
    action={stopDunningAction}
    biz={p.biz}
    inv={p.inv}
    {...(p.variant === "button" ? { variant: "outline" as const, className: "" } : {})}
    label={
      p.label ??
      (p.variant === "button" ? (
        <>
          <Square className="size-3.5" /> Stop dunning
        </>
      ) : (
        "Stop dunning"
      ))
    }
    confirm={{
      title: "Stop dunning?",
      description:
        "This stops automated retries. The invoice status changes to “not paid”. The customer still owes the amount. You can still collect, record a payment or credit it.",
      confirmLabel: "Stop dunning",
      destructive: true,
    }}
  />
);

/** Pause dunning until a chosen datetime — a small EditDrawer with a datetime input. */
export function PauseDunningButton({
  biz,
  inv,
  variant = "link",
}: {
  biz: string;
  inv: string;
  /** `button`: an outline button for a card header; the default is a menu link. */
  variant?: "link" | "button";
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      {variant === "button" ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Pause className="size-3.5" /> Pause dunning…
        </Button>
      ) : (
        <button
          type="button"
          className="rounded px-1 py-0.5 text-left text-sm text-primary hover:underline"
          onClick={() => setOpen(true)}
        >
          Pause dunning…
        </button>
      )}
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        title="Pause dunning"
        description="Skip automated retries until a time that you select."
      >
        <ActionForm
          action={pauseDunningAction}
          className="space-y-4"
          onSuccess={() => setOpen(false)}
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="inv" value={inv} />
          <p className="text-sm text-muted-foreground">
            The invoice stays <strong>payment due</strong>, but we skip automated retries until the
            date below.
          </p>
          <Field
            name="until"
            label="Pause retries until"
            required
            help="No retry runs before this time."
          >
            <DateTimeField name="until" required />
          </Field>
          <SubmitButton>Pause dunning</SubmitButton>
        </ActionForm>
      </EditDrawer>
    </>
  );
}
