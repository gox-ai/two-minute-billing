"use client";

import { useFieldError } from "@/components/form/action-form";

/** The enclosing ActionForm's error for `name`, if the last save returned one. */
export function SettingError({ name }: { name: string }) {
  const error = useFieldError(name);
  if (!error) return null;
  return (
    <p id={`${name}-error`} className="m-0 text-xs font-medium text-destructive">
      {error}
    </p>
  );
}
