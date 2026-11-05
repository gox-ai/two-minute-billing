"use client";

import * as React from "react";
import { SelectField } from "@/components/ui/select-field";
import { Button } from "@/components/ui/button";
import { ActionForm } from "@/components/form/action-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ActionResult } from "@/lib/action-result";
import { permissionAreas, resourceLabel, type KeyAccess, type KeyGrantOptions } from "@/lib/roles";

const NOT_HELD = "You cannot give a permission that you do not have";

/**
 * The access a new or changed API key gets: full, read only, or per resource.
 * Posts `access` (full | read | custom) and, for custom, one `perm_<resource>` per resource.
 * An option above the member's own rights is disabled: the engine refuses it anyway.
 */
export function KeyAccessFields({
  grant,
  defaultAccess,
  defaultMap,
}: {
  grant: KeyGrantOptions;
  defaultAccess?: "full" | "read" | "custom";
  defaultMap?: Record<string, "read" | "write"> | null;
}) {
  const first = defaultAccess ?? (grant.full ? "full" : grant.readOnly ? "read" : "custom");
  const [access, setAccess] = React.useState<string>(first);
  const areas = React.useMemo(
    () =>
      permissionAreas()
        .map((a) => ({ ...a, resources: a.resources.filter((r) => grant.resources[r.resource]) }))
        .filter((a) => a.resources.length > 0),
    [grant],
  );
  return (
    <div className="flex w-full flex-col gap-3">
      <SelectField
        name="access"
        value={access}
        onValueChange={setAccess}
        ariaLabel="Key access"
        className="w-64"
        options={[
          {
            value: "full",
            label: grant.full ? "Full access" : `Full access (${NOT_HELD.toLowerCase()})`,
            disabled: !grant.full,
          },
          {
            value: "read",
            label: grant.readOnly ? "Read only" : `Read only (${NOT_HELD.toLowerCase()})`,
            disabled: !grant.readOnly,
          },
          { value: "custom", label: "Custom: select access per resource" },
        ]}
      />
      {access === "custom" ? (
        <div className="grid gap-x-6 gap-y-4 rounded-md bg-muted/50 p-3 sm:grid-cols-2">
          {areas.map((a) => (
            <div key={a.area} className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">{a.area}</div>
              {a.resources.map(({ resource }) => {
                const g = grant.resources[resource]!;
                const current = defaultMap?.[resource] ?? "none";
                return (
                  <div key={resource} className="flex items-center justify-between gap-3">
                    <span className="text-sm">{resourceLabel(resource)}</span>
                    <SelectField
                      name={`perm_${resource}`}
                      defaultValue={current}
                      size="sm"
                      className="w-40"
                      ariaLabel={`${resourceLabel(resource)} access`}
                      options={[
                        { value: "none", label: "No access" },
                        { value: "read", label: "Read", disabled: !g.read },
                        { value: "write", label: "Read and write", disabled: !g.write },
                      ]}
                    />
                  </div>
                );
              })}
            </div>
          ))}
          {areas.some((a) => a.resources.some((r) => !grant.resources[r.resource]!.write)) ? (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Some options are not available. {NOT_HELD}.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Edit the access of an existing key (PATCH). Same choices as creation. */
export function EditKeyAccessDialog({
  keyId,
  prefix,
  scope,
  permissions,
  grant,
  action,
}: {
  keyId: string;
  prefix: string;
  scope: string;
  permissions: Record<string, KeyAccess> | null;
  grant: KeyGrantOptions;
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
}) {
  const [open, setOpen] = React.useState(false);
  const current = permissions ? "custom" : scope === "read" ? "read" : "full";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Edit access
        </Button>
      </DialogTrigger>
      <DialogContent size="lg" className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Edit access</DialogTitle>
          <DialogDescription>
            Key <span className="font-mono">{prefix}…</span>. The change applies to the next request
            made with this key.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={action}
          className="flex min-h-0 flex-col gap-4"
          onSuccess={() => setOpen(false)}
        >
          <input type="hidden" name="id" value={keyId} />
          <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
            <KeyAccessFields
              grant={grant}
              defaultAccess={current}
              defaultMap={permissions as Record<string, "read" | "write"> | null}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
