"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { LIMITS } from "@/lib/limits";
import { inviteAction } from "@/app/auth-actions";
import type { RoleOption } from "@/lib/roles";

/** What each role can reach. Reference material, so it sits where the question is asked. */
const ROLE_ACCESS: Array<[string, string]> = [
  ["admin", "Everything, including team management"],
  ["manager", "Revenue, catalog, customers, worklist, plus all ops access"],
  ["ops", "Invoices, payments, metrics, the attention queue"],
  ["developer", "Webhooks, events, API keys and the SDK"],
];

/**
 * Invite behind a button rather than an always-open form card.
 *
 * The page's job is to answer "who can get in", and a permanently-mounted form pushed that
 * list down the screen and put a second table (the role legend) beside it — three surfaces
 * competing for a screen that has one question.
 *
 * NOT `CreateDialog`: that closes on any submit, so a refused invite ("already a member of
 * this organization") would close over the form and lose what was typed. This closes on
 * SUCCESS only, via `ActionForm`'s `onSuccess` — the error stays in the dialog, on the
 * email field, where it can be corrected.
 */
export function InviteDialog({ roleOptions }: { roleOptions: RoleOption[] }) {
  const [open, setOpen] = React.useState(false);
  /**
   * The typed fields are CONTROLLED, and this is not a preference.
   *
   * React 19 resets an uncontrolled `<form action={…}>` once the action settles — including
   * when it FAILED. So a refused invite ("already a member of this organization") left the
   * dialog open, showing that error against an empty Email field: the reader is told their
   * address is wrong and cannot see which address. Keeping the dialog open is only an
   * improvement if it keeps what was typed.
   *
   * Role is deliberately left uncontrolled: `SelectField` holds its choice in React state,
   * not the DOM, so the reset does not touch it.
   */
  const [email, setEmail] = React.useState("");
  // Owner is given by changing a member's role, never by invite. Roles the inviter cannot
  // give are omitted: the engine refuses them.
  const offered = roleOptions.filter((r) => r.grantable && r.value !== "owner");
  const [name, setName] = React.useState("");

  function close() {
    setOpen(false);
    setEmail("");
    setName("");
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>
            {/*
              No password field (0197). The invitee sets their own through a single-use
              emailed link, which is also what proves they hold the address. An admin
              choosing a colleague's password meant a second person knew it, permanently,
              unless the colleague thought to change it.
            */}
            They get an email with a link to choose their own password. The link works once and
            expires in 72 hours. If it expires, resend it from their row.
          </DialogDescription>
        </DialogHeader>
        <ActionForm action={inviteAction} className="space-y-4" onSuccess={close}>
          <Field name="email" label="Email">
            <Input
              name="email"
              type="email"
              placeholder="teammate@example.com"
              required
              maxLength={LIMITS.email}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field name="name" label="Name" help="Optional. They can set it later.">
            <Input
              name="name"
              placeholder="Jane Doe"
              maxLength={LIMITS.name}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field name="role" label="Role">
            <SelectField
              name="role"
              defaultValue={
                offered.some((r) => r.value === "manager") ? "manager" : (offered[0]?.value ?? "")
              }
              className="w-56"
              options={offered.map((r) => ({
                value: r.value,
                label: r.custom ? `${r.label} (custom)` : r.label,
              }))}
            />
          </Field>
          {/*
            The role reference, next to the choice instead of in a second card on the page.
            A filled well rather than a bordered box — it is secondary content inside a
            dialog that already has a border, and the design system has no dashed ones.
          */}
          <dl className="space-y-1.5 rounded-md bg-muted/50 p-3 text-xs">
            {ROLE_ACCESS.filter(([role]) => offered.some((r) => r.value === role)).map(
              ([role, access]) => (
                <div key={role} className="flex gap-2">
                  <dt className="w-20 shrink-0 font-medium">{role}</dt>
                  <dd className="text-muted-foreground">{access}</dd>
                </div>
              ),
            )}
            {offered.some((r) => r.custom) ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 font-medium">custom</dt>
                <dd className="text-muted-foreground">The permissions set in Team → Roles</dd>
              </div>
            ) : null}
          </dl>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit">Send invite</Button>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
