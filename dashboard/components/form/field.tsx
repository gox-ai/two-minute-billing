"use client";

import * as React from "react";
import { Label } from "@/components/ui/label";
import { useFieldError } from "@/components/form/action-form";
import { cn } from "@/lib/utils";

/**
 * "row": label on the left, control on the row's right edge (a settings card).
 * Default "stack": label above the control.
 */
export const FieldLayout = React.createContext<"stack" | "row">("stack");

/**
 * Labeled form field with helper text + inline error (from the enclosing
 * <ActionForm>'s server-action result). Label above, muted helper below.
 */
export function Field({
  name,
  label,
  help,
  required,
  error: errorProp,
  children,
  className,
}: {
  name: string;
  label: React.ReactNode;
  help?: React.ReactNode;
  required?: boolean;
  /** Override/augment the context error (e.g. client-side validation). */
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const contextError = useFieldError(name);
  const error = errorProp ?? contextError;
  const errorId = `${name}-error`;
  const row = React.useContext(FieldLayout) === "row";
  const control = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        id: (children.props as Record<string, unknown>).id ?? name,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": error ? errorId : undefined,
      })
    : children;
  if (row)
    return (
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="min-w-0 sm:max-w-md">
          <Label htmlFor={name} className="text-sm leading-relaxed font-medium">
            {label}
            {required ? <span className="text-destructive"> *</span> : null}
          </Label>
          {error ? (
            <p id={errorId} className="mt-1 text-xs font-medium text-destructive">
              {error}
            </p>
          ) : help ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{help}</p>
          ) : null}
        </div>
        <div className={cn("w-full shrink-0 sm:w-72", className)}>{control}</div>
      </div>
    );
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={name} className="text-sm font-medium">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {control}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : help ? (
        <p className="text-xs text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}
