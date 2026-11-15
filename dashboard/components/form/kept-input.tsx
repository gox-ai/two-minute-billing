"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { useKeptValue } from "@/components/form/action-form";

/**
 * An `Input` that keeps what was typed after a failed submit. React 19 resets the form after
 * its action, and a native reset restores `defaultValue`; here that default follows the
 * value the action sent back (`ActionResult.values`). Never for a secret.
 */
export function KeptInput({
  name,
  defaultValue,
  ...props
}: React.ComponentProps<typeof Input> & { name: string }) {
  const kept = useKeptValue(name);
  return <Input name={name} defaultValue={kept ?? defaultValue} {...props} />;
}
