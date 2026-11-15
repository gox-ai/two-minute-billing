"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronRight, Plus } from "lucide-react";
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

/** "invoices:live_override" → "Live override": a short name, with the sentence as its hint. */
function actionLabel(key: string): string {
  const s = (key.split(":")[1] ?? key).replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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
  fixedCounts,
}: {
  roles: CustomRole[];
  actorPermissions: string[];
  canManage: boolean;
  ownRoleId: string | null;
  /** Members per fixed role; null when the viewer cannot read the member list. */
  fixedCounts?: Partial<Record<FixedRoleName, number>> | null;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = React.useState<CustomRole | null>(null);
  const [viewing, setViewing] = React.useState<{ title: string; keys: string[] } | null>(null);
  // The name is a real button (keyboard); the row click is the same action for a pointer.
  const open = (title: string, keys: string[]) => ({
    onClick: () => setViewing({ title, keys }),
  });
  const nameButton = (label: React.ReactNode, title: string, keys: string[]) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setViewing({ title, keys });
      }}
      className="rounded-md text-left font-medium"
      aria-label={`View permissions of ${title}`}
    >
      {label}
    </button>
  );
  return (
    <div>
      <Table phone="stack">
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
            <TableRow
              key={r}
              className="cursor-pointer"
              {...open(FIXED_LABEL[r], fixedRoleKeys(r))}
            >
              <TableCell>
                {nameButton(
                  <>
                    {FIXED_LABEL[r]} <Chip className="ml-1">Fixed</Chip>
                  </>,
                  FIXED_LABEL[r],
                  fixedRoleKeys(r),
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">{fixedRoleKeys(r).length}</TableCell>
              <TableCell className="text-muted-foreground">{fixedCounts?.[r] ?? "—"}</TableCell>
              <TableCell className="text-right">
                <ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden />
              </TableCell>
            </TableRow>
          ))}
          {roles.map((r) => {
            const mayEdit =
              canManage && r.id !== ownRoleId && canGrant(actorPermissions, r.permissions);
            return (
              <TableRow key={r.id} className="cursor-pointer" {...open(r.name, r.permissions)}>
                <TableCell>
                  <div>
                    {nameButton(
                      <>
                        {r.name} <Chip className="ml-1">Custom</Chip>
                      </>,
                      r.name,
                      r.permissions,
                    )}
                  </div>
                  {r.description ? (
                    <div className="text-xs text-muted-foreground">{r.description}</div>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{r.permissions.length}</TableCell>
                <TableCell className="text-muted-foreground">{r.member_count}</TableCell>
                <TableCell className="text-right">
                  {/* Stops a click here (and inside its dialog) from opening the permissions view. */}
                  <div
                    className="flex items-center justify-end gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {mayEdit ? <RoleDialog actorPermissions={actorPermissions} role={r} /> : null}
                    {mayEdit && r.member_count === 0 ? (
                      <Button variant="outline" size="sm" onClick={() => setDeleting(r)}>
                        Delete
                      </Button>
                    ) : null}
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <ViewPermissionsDialog viewing={viewing} onClose={() => setViewing(null)} />
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

/** The screen's one filled action; the page puts it in the page header. */
export function CreateRoleButton({ actorPermissions }: { actorPermissions: string[] }) {
  return <RoleDialog actorPermissions={actorPermissions} />;
}

function ViewPermissionsDialog({
  viewing,
  onClose,
}: {
  viewing: { title: string; keys: string[] } | null;
  onClose: () => void;
}) {
  const keys = viewing?.keys ?? [];
  return (
    <Dialog open={viewing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md" className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{viewing?.title}</DialogTitle>
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
          <div className="-mx-6 min-h-0 flex-1 space-y-5 overflow-y-auto px-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="name" label="Name" className={role ? "sm:col-span-2" : undefined}>
                <Input name="name" maxLength={60} required defaultValue={role?.name ?? ""} />
              </Field>
              {role ? null : (
                <Field
                  name="start"
                  label="Start from"
                  help="Selects the permissions of a fixed role that you also have."
                >
                  <SelectField
                    className="w-full"
                    value={start}
                    onValueChange={startFrom}
                    options={[
                      { value: "", label: "No role" },
                      ...FIXED_ROLES.map((r) => ({ value: r, label: FIXED_LABEL[r] })),
                    ]}
                  />
                </Field>
              )}
              <Field
                name="description"
                label="Description"
                help="Optional."
                className="sm:col-span-2"
              >
                <Textarea
                  name="description"
                  rows={2}
                  maxLength={255}
                  defaultValue={role?.description ?? ""}
                />
              </Field>
            </div>
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="text-sm font-medium">Permissions</h3>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {selected.size} selected. {NOT_HELD}
                </p>
              </div>
              {/* One column per mode, so every "view" box and every "change" box line up. */}
              {areas.map((a) => (
                <fieldset key={a.area} className="rounded-md bg-muted/50 px-3 py-3">
                  <legend className="sr-only">{a.area}</legend>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]">
                    <div aria-hidden className="text-sm font-semibold">
                      {a.area}
                    </div>
                    <div
                      aria-hidden
                      className="text-xs font-medium text-muted-foreground max-sm:hidden"
                    >
                      Read
                    </div>
                    <div
                      aria-hidden
                      className="text-xs font-medium text-muted-foreground max-sm:hidden"
                    >
                      Write
                    </div>
                    {a.resources.map((r) => (
                      <React.Fragment key={r.resource}>
                        <div className="text-sm max-sm:pt-1 max-sm:font-medium">
                          {resourceLabel(r.resource)}
                        </div>
                        {(["read", "write"] as const).map((mode) => (
                          <div
                            key={mode}
                            className="flex min-w-0 flex-col gap-2 empty:max-sm:hidden"
                          >
                            {r.keys
                              .filter((p) => p.mode === mode)
                              .map((p) => (
                                <CheckboxField
                                  key={p.key}
                                  name="perm"
                                  value={p.key}
                                  label={
                                    <>
                                      {actionLabel(p.key)}
                                      <span className="sr-only"> {resourceLabel(r.resource)}</span>
                                    </>
                                  }
                                  hint={p.label}
                                  checked={selected.has(p.key)}
                                  onCheckedChange={(on) => toggle(p.key, on)}
                                  disabled={!held.has(p.key)}
                                />
                              ))}
                          </div>
                        ))}
                      </React.Fragment>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
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
