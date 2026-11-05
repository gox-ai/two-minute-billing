"use client";

import * as React from "react";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import type { CredentialFieldMeta } from "@/components/gateways/gateway-meta";

/**
 * Write-only credential inputs for a provider, from its catalogue entry. Inputs are
 * named cred_<key> (collected server-side by collectCredentials). A provider without
 * credential fields (tmtest) renders an explanatory note instead.
 */
export function CredentialFields({
  fields,
  requiredFields = false,
}: {
  fields: CredentialFieldMeta[];
  /** Mark fields required (create flow). Rotation leaves them optional. */
  requiredFields?: boolean;
}) {
  if (fields.length === 0) {
    return <p className="text-sm text-muted-foreground">This gateway requires no credentials.</p>;
  }
  return (
    <div className="space-y-3">
      {fields.map((f) => (
        <Field
          key={f.key}
          name={`cred_${f.key}`}
          label={f.label}
          help={f.hint ?? undefined}
          required={requiredFields && !f.optional}
        >
          <Input
            name={`cred_${f.key}`}
            type="password"
            autoComplete="off"
            placeholder={f.placeholder ?? undefined}
            required={requiredFields && !f.optional}
            className="max-w-md font-mono"
          />
        </Field>
      ))}
      <p className="text-xs text-muted-foreground">
        Credentials are write-only. We encrypt them at rest and do not show them again after you
        save.
      </p>
    </div>
  );
}
