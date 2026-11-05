"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { setRequireTwoFactorAction } from "@/app/(dashboard)/settings/security-actions";

/**
 * "Require two-factor authentication" (0329). Flipping it asks first and says exactly what
 * happens, because turning it on emails people and starts a deadline.
 */
export function RequireTwoFactorSwitch({
  required,
  disabled,
  orgName,
  membersWithout,
  deadlineIfOnToday,
}: {
  required: boolean;
  /** The caller has no 2FA themselves: they cannot turn it on. */
  disabled: boolean;
  orgName: string;
  /** Members without 2FA today, who get an email if it is turned on. */
  membersWithout: number;
  /** "15 Oct 2026": the grace deadline if it is turned on now. */
  deadlineIfOnToday: string;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<boolean | null>(null);

  async function save(enabled: boolean) {
    const r = await setRequireTwoFactorAction(enabled);
    if (r.ok) {
      toast.success(r.message ?? "Saved");
      router.refresh();
    } else toast.error(r.message ?? "We could not save the setting.");
  }

  return (
    <>
      <SettingSwitch
        label="Require two-factor authentication"
        checked={required}
        disabled={disabled && !required}
        onCheckedChange={(next) => setPending(next)}
      />
      <ConfirmDialog
        open={pending === true}
        onOpenChange={(o) => !o && setPending(null)}
        title="Require two-factor authentication?"
        description={
          <span className="flex flex-col gap-2">
            <span>
              {membersWithout === 0
                ? "All members have 2FA now. We send no emails."
                : `We send an email today to ${membersWithout} ${membersWithout === 1 ? "member" : "members"} without 2FA.`}
            </span>
            {membersWithout === 0 ? null : (
              <span>
                They have until {deadlineIfOnToday}. The dashboard reminds them until then. After
                that date, they must enable 2FA before they can open {orgName}.
              </span>
            )}
            <span>New members must enable 2FA when they join.</span>
          </span>
        }
        confirmLabel="Require 2FA"
        onConfirm={() => save(true)}
      />
      <ConfirmDialog
        open={pending === false}
        onOpenChange={(o) => !o && setPending(null)}
        title="Disable the requirement?"
        description={`Members can open ${orgName} without 2FA again. They can also disable their own 2FA. We do not disable 2FA for any member.`}
        confirmLabel="Disable requirement"
        onConfirm={() => save(false)}
      />
    </>
  );
}
