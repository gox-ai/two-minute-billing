"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Mail, UserMinus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SelectField } from "@/components/ui/select-field";
import { Chip, StatusChip } from "@/components/patterns/chip";
import type { RoleOption } from "@/lib/roles";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/states";
import { InviteDialog } from "@/components/team/invite-dialog";
import { initials } from "@/components/patterns/record-page";
import { fmtDateTime } from "@/lib/format";
import { useDisplayTz } from "@/components/business-tz";
import type { TeamMember } from "@/lib/session";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  changeMemberRoleAction,
  removeMemberAction,
  resendMemberInviteAction,
} from "@/app/auth-actions";

/**
 * Who is in the organization, and the three things an admin can do to them (2026-08-30).
 *
 * The screen used to be an invite form and a legend — an org could only ever gain members,
 * and "remove the person who left" meant psql. Every control here reaches a real endpoint
 * (`/auth/members`), and every refusal shown is the API's own message rather than a guess
 * made in the browser: the rules that matter ("keep at least one owner or admin", "you
 * cannot change your own role") are enforced server-side, so the UI only has to relay them.
 *
 * Client component because the role select writes on change and removal needs a confirm
 * step; the row data is passed down from the server page.
 */

/** The value a member's role select holds: the fixed code, or the custom role's id. */
const roleValue = (m: TeamMember) => (m.role === "custom" ? (m.custom_role?.id ?? "") : m.role);

/** "8 Oct" for a YYYY-MM-DD day, without shifting it through a timezone. */
function fmtDueDay(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function TeamMembersTable({
  members,
  roleOptions,
  actorPermissions,
  actorIsOwner,
}: {
  members: TeamMember[];
  roleOptions: RoleOption[];
  actorPermissions: string[];
  /** Only an owner may change or remove an owner; the API refuses anyone else. */
  actorIsOwner: boolean;
}) {
  const router = useRouter();
  /**
   * The ORGANIZATION's zone, not UTC. Team is an org-scoped screen — it spans every
   * business in the account — so `useDisplayTz()` resolves business → organization → UTC
   * and lands on `organizations.timezone` here (0216).
   *
   * It rendered UTC before, because `fmtDateTime` was called with no zone and its default
   * is UTC. Our user caught it from the outside: their own row showed a five-day-old last
   * sign-in while they were signed in, and a wall clock five and a half hours behind the
   * one you live in is how a stale-looking timestamp starts.
   */
  const tz = useDisplayTz();
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState<TeamMember | null>(null);
  /**
   * The role each select is SHOWING. Seeded from the server rows and re-seeded whenever they
   * change, so a refused change snaps back to the truth instead of leaving the select
   * displaying a role the member does not have.
   */
  const [shown, setShown] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(members.map((m) => [m.id, roleValue(m)])),
  );
  React.useEffect(() => {
    setShown(Object.fromEntries(members.map((m) => [m.id, roleValue(m)])));
  }, [members]);

  // A member whose role has a permission the signed-in member lacks is shown, not offered:
  // the engine refuses to change or remove them.
  const keysOf = (value: string) => roleOptions.find((o) => o.value === value)?.keys;
  const held = new Set(actorPermissions);
  const mayTouch = (m: TeamMember) => {
    if (m.role === "owner" && !actorIsOwner) return false;
    const keys = keysOf(roleValue(m));
    return keys ? keys.every((k) => held.has(k)) : false;
  };
  const optionsFor = (m: TeamMember) =>
    roleOptions
      .filter((o) => o.grantable || o.value === roleValue(m))
      .map((o) => ({ value: o.value, label: o.custom ? `${o.label} (custom)` : o.label }));

  if (members.length === 0) {
    return (
      <EmptyState
        title="No team members yet"
        description="Invite a teammate and they will appear here."
        // The copy named an action with no way to take it. `InviteDialog` takes no props and
        // owns its own state, so the zero-state can hold a second instance of the real control
        // rather than pointing at the one in the page header.
        action={<InviteDialog roleOptions={roleOptions} />}
      />
    );
  }

  async function onRoleChange(member: TeamMember, role: string) {
    if (role === roleValue(member)) return;
    setShown((s) => ({ ...s, [member.id]: role }));
    setPendingId(member.id);
    try {
      const res = await changeMemberRoleAction(member.id, role);
      if (res.ok) {
        toast.success(`Role changed for ${member.email}.`);
        router.refresh();
      } else {
        setShown((s) => ({ ...s, [member.id]: roleValue(member) }));
        toast.error(res.error ?? "We could not change the role.");
      }
    } finally {
      setPendingId(null);
    }
  }

  async function onRemove(member: TeamMember) {
    const res = await removeMemberAction(member.id);
    if (res.ok) {
      toast.success(`Removed ${member.email}`);
      router.refresh();
    } else {
      toast.error(res.error ?? "We could not remove the member.");
    }
  }

  async function onResend(member: TeamMember) {
    setPendingId(member.id);
    try {
      const res = await resendMemberInviteAction(member.id);
      if (res.ok) toast.success(`New invite sent to ${member.email}`);
      else toast.error(res.error ?? "We could not resend the invite.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>2FA</TableHead>
            <TableHead>Last sign-in</TableHead>
            <TableHead className="w-10 text-right" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((m) => (
            <TableRow key={m.id}>
              <TableCell>
                {/*
                  `||`, not `??`. Rows invited before the service started normalising a
                  blank name hold `''`, and `'' ?? email` is `''` — which rendered an
                  empty Member cell. The address is the identity here; never show nothing.
                */}
                <div className="flex min-w-60 items-center gap-2.5">
                  {/* The shared Avatar falls back to initials when a photo (e.g. Google's) fails to load. */}
                  <Avatar aria-hidden className="size-8">
                    {m.avatar_url ? <AvatarImage src={m.avatar_url} alt="" /> : null}
                    <AvatarFallback className="border-0 bg-primary/10 text-primary">
                      {initials(m.name || m.email)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="font-semibold">{m.name || m.email}</div>
                    {m.status === "invited" ? (
                      <div className="text-xs text-muted-foreground">
                        {m.name ? `${m.email} · Invite pending` : "Invite pending"}
                      </div>
                    ) : m.name ? (
                      <div className="text-xs text-muted-foreground">{m.email}</div>
                    ) : null}
                  </div>
                </div>
              </TableCell>
              <TableCell>
                {/*
                  Your own role is READ-ONLY text, not a disabled select: the API refuses a
                  self-change outright, and a disabled control implies a choice exists.
                */}
                {m.is_self || !mayTouch(m) ? (
                  <span>
                    {m.custom_role?.name ?? m.role}
                    {m.custom_role ? <Chip className="ml-1">Custom</Chip> : null}
                    {m.is_self ? (
                      <span className="text-xs text-muted-foreground"> (you)</span>
                    ) : null}
                  </span>
                ) : (
                  <SelectField
                    size="sm"
                    className="w-44"
                    ariaLabel={`Role for ${m.email}`}
                    options={optionsFor(m)}
                    value={shown[m.id] ?? roleValue(m)}
                    onValueChange={(role) => void onRoleChange(m, role)}
                    disabled={pendingId === m.id}
                  />
                )}
              </TableCell>
              <TableCell>
                <StatusChip status={m.status} />
              </TableCell>
              <TableCell>
                {/*
                  Off-by-policy and overdue are different facts. "Due" and "Locked out" appear
                  only when 2FA is required — by the organization (0329) or the deprecated
                  MFA_REQUIRED_ROLES — so a team that requires nothing reads plain On / Off.
                */}
                {m.mfa_enabled ? (
                  <span className="text-sm text-success">On</span>
                ) : m.mfa_blocked ? (
                  <span className="text-sm text-destructive">No access · 2FA necessary</span>
                ) : m.mfa_required && m.mfa_deadline_day ? (
                  <span className="text-sm text-warning">
                    Due by {fmtDueDay(m.mfa_deadline_day)}
                  </span>
                ) : m.mfa_required ? (
                  <span className="text-sm text-warning">Enrolment due</span>
                ) : (
                  <span className="text-sm text-muted-foreground">Off</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {m.last_login_at ? fmtDateTime(m.last_login_at, tz) : "Never"}
              </TableCell>
              <TableCell className="text-right">
                {m.is_self || !mayTouch(m) ? null : (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={`Actions for ${m.email}`}
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {/*
                        Resend is offered ONLY for an outstanding invite. For someone who
                        already holds a credential there is nothing to accept — the API
                        refuses it — and their route back in is the password reset.
                      */}
                      {m.status === "invited" ? (
                        <DropdownMenuItem onSelect={() => void onResend(m)}>
                          <Mail className="size-4" />
                          Resend invite
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem variant="destructive" onSelect={() => setConfirmRemove(m)}>
                        <UserMinus className="size-4" />
                        Remove from organization
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => !open && setConfirmRemove(null)}
        title={`Remove ${confirmRemove?.email ?? ""}?`}
        description="They lose access immediately. Their open sessions stop working. Their name stays on the audit log entries they wrote. You can invite them again later."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (confirmRemove) await onRemove(confirmRemove);
        }}
      />
    </>
  );
}
