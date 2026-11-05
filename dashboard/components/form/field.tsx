"use client";

import * as React from "react";
import { Label } from "@/components/ui/label";
import { useFieldError } from "@/components/form/action-form";
import { cn } from "@/lib/utils";

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
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={name} className="text-sm font-medium">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id: (children.props as Record<string, unknown>).id ?? name,
            "aria-invalid": error ? true : undefined,
            "aria-describedby": error ? errorId : undefined,
          })
        : children}
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
