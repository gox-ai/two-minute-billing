"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CheckboxField } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { Chip } from "@/components/patterns/chip";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { permissionDef } from "@/lib/permissions.generated";
import {
  FIXED_ROLES,
  canGrant,
  fixedRoleKeys,
  permissionAreas,
  resourceLabel,
  type CustomRole,
  type FixedRoleName,
} from "@/lib/roles";
import {
  createRoleAction,
  deleteRoleAction,
  updateRoleAction,
} from "@/app/(dashboard)/team/actions";

const NOT_HELD = "You cannot give a permission that you do not have.";
const FIXED_LABEL: Record<FixedRoleName, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  ops: "Ops",
  developer: "Developer",
};

/**
 * Settings → Team → Roles: the five fixed roles (read-only) and the organization's custom roles.
 * Every checkbox in the editor writes one key of `permissions[]`; a key the member does not have
 * is disabled with the reason, because the engine refuses it.
 */
export function RolesPanel({
  roles,
  actorPermissions,
  canManage,
  ownRoleId,
}: {
  roles: CustomRole[];
  actorPermissions: string[];
  canManage: boolean;
  ownRoleId: string | null;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = React.useState<CustomRole | null>(null);
  return (
    <div className="flex flex-col gap-4">
      {canManage ? (
        <div>
          <RoleDialog actorPermissions={actorPermissions} />
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Role</TableHead>
            <TableHead>Permissions</TableHead>
            <TableHead>Members</TableHead>
            <TableHead className="text-right" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {FIXED_ROLES.map((r) => (
            <TableRow key={r}>
              <TableCell className="font-medium">
                {FIXED_LABEL[r]} <Chip className="ml-1">Fixed</Chip>
              </TableCell>
              <TableCell className="text-muted-foreground">{fixedRoleKeys(r).length}</TableCell>
              <TableCell className="text-muted-foreground">—</TableCell>
              <TableCell className="text-right">
                <ViewPermissionsDialog title={FIXED_LABEL[r]} keys={fixedRoleKeys(r)} />
              </TableCell>
            </TableRow>
          ))}
          {roles.map((r) => {
            const mayEdit =
              canManage && r.id !== ownRoleId && canGrant(actorPermissions, r.permissions);
            return (
              <TableRow key={r.id}>
                <TableCell>
                  <div className="font-medium">
                    {r.name} <Chip className="ml-1">Custom</Chip>
                  </div>
                  {r.description ? (
                    <div className="text-xs text-muted-foreground">{r.description}</div>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{r.permissions.length}</TableCell>
                <TableCell className="text-muted-foreground">{r.member_count}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    {mayEdit ? (
                      <RoleDialog actorPermissions={actorPermissions} role={r} />
                    ) : (
                      <ViewPermissionsDialog title={r.name} keys={r.permissions} />
                    )}
                    {mayEdit && r.member_count === 0 ? (
                      <Button variant="outline" size="sm" onClick={() => setDeleting(r)}>
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete the role ${deleting?.name ?? ""}?`}
        description="No member has this role. You cannot undo this."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const res = await deleteRoleAction(deleting.id);
          if (res.ok) {
            toast.success("Role deleted.");
            router.refresh();
          } else toast.error(res.error ?? "We could not delete the role.");
        }}
      />
    </div>
  );
}

function ViewPermissionsDialog({ title, keys }: { title: string; keys: string[] }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          View permissions
        </Button>
      </DialogTrigger>
      <DialogContent size="md" className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{keys.length} permissions.</DialogDescription>
        </DialogHeader>
        <ul className="-mx-6 min-h-0 flex-1 space-y-1 overflow-y-auto px-6 text-sm">
          {keys.map((k) => (
            <li key={k} className="flex justify-between gap-3">
              <span>{permissionDef(k)?.label ?? k}</span>
              <span className="font-mono text-xs text-muted-foreground">{k}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function RoleDialog({ actorPermissions, role }: { actorPermissions: string[]; role?: CustomRole }) {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(role?.permissions ?? []),
  );
  const [start, setStart] = React.useState("");
  const areas = React.useMemo(() => permissionAreas(), []);
  const held = React.useMemo(() => new Set(actorPermissions), [actorPermissions]);

  function reset() {
    setSelected(new Set(role?.permissions ?? []));
    setStart("");
  }
  function startFrom(r: string) {
    setStart(r);
    if (r) setSelected(new Set(fixedRoleKeys(r as FixedRoleName).filter((k) => held.has(k))));
  }
  function toggle(key: string, on: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        {role ? (
          <Button variant="outline" size="sm">
            Edit
          </Button>
        ) : (
          <Button>
            <Plus className="size-4" />
            Create role
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="xl" className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{role ? `Edit ${role.name}` : "Create a role"}</DialogTitle>
          <DialogDescription>
            A change applies to each member with this role on their next request.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={role ? updateRoleAction : createRoleAction}
          className="flex min-h-0 flex-col gap-4"
          onSuccess={() => setOpen(false)}
        >
          {role ? (
            <>
              <input type="hidden" name="id" value={role.id} />
              <input type="hidden" name="version" value={role.version} />
            </>
          ) : null}
          <div className="-mx-6 min-h-0 flex-1 space-y-4 overflow-y-auto px-6">
            <Field name="name" label="Name">
              <Input
                name="name"
                maxLength={60}
                required
                defaultValue={role?.name ?? ""}
                className="w-72"
              />
            </Field>
            <Field name="description" label="Description" help="Optional.">
              <Textarea name="description" maxLength={255} defaultValue={role?.description ?? ""} />
            </Field>
            {role ? null : (
              <Field
                name="start"
                label="Start from"
                help="Selects the permissions of a fixed role that you also have."
              >
                <SelectField
                  className="w-48"
                  value={start}
                  onValueChange={startFrom}
                  options={[
                    { value: "", label: "No role" },
                    ...FIXED_ROLES.map((r) => ({ value: r, label: FIXED_LABEL[r] })),
                  ]}
                />
              </Field>
            )}
            <p className="text-xs text-muted-foreground">
              {selected.size} selected. {NOT_HELD}
            </p>
            {areas.map((a) => (
              <fieldset key={a.area} className="rounded-md bg-muted/50 p-3">
                <legend className="text-sm font-medium">{a.area}</legend>
                <div className="mt-2 space-y-3">
                  {a.resources.map((r) => (
                    <div key={r.resource} className="flex flex-wrap items-start gap-x-6 gap-y-2">
                      <div className="w-40 shrink-0 text-sm">{resourceLabel(r.resource)}</div>
                      <div className="flex flex-[1_1_20rem] flex-wrap gap-x-5 gap-y-2">
                        {r.keys.map((p) => (
                          <CheckboxField
                            key={p.key}
                            name="perm"
                            value={p.key}
                            label={p.label}
                            checked={selected.has(p.key)}
                            onCheckedChange={(on) => toggle(p.key, on)}
                            disabled={!held.has(p.key)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">{role ? "Save" : "Create role"}</Button>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
