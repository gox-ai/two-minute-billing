"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const KEY = "tmb:tfa-reminded";

/**
 * Once per sign-in while the organization's 2FA deadline is ahead: every sign-in (and every
 * organization switch) writes a new session, so `session` changes and the dialog opens again.
 * The banner stays on every page; this is the prompt that cannot scroll past unread.
 */
export function TwoFactorDueDialog({
  session,
  org,
  date,
  when,
}: {
  /** A digest of the session cookie — never the token itself. */
  session: string;
  org: string;
  date: string;
  when: string;
}) {
  const path = usePathname();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    let seen: string | null = null;
    try {
      seen = window.localStorage.getItem(KEY);
    } catch {
      // Storage blocked: remind on this load rather than never.
    }
    if (seen === session) return;
    remember(session);
    // Already on the page that enables it.
    if (!path.startsWith("/account")) setOpen(true);
    // Once per session, not per page: the path is read at mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="sm">
        <DialogHeader>
          <ShieldAlert className="size-6 text-warning" aria-hidden />
          <DialogTitle>Two-factor authentication is due</DialogTitle>
          <DialogDescription>
            {org} requires two-factor authentication. Enable it by {date} ({when}). After that date,
            you cannot open {org} until you enable it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Later</Button>
          </DialogClose>
          <Button asChild>
            <Link href="/account#two-factor" onClick={() => setOpen(false)}>
              Enable 2FA
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function remember(session: string) {
  try {
    window.localStorage.setItem(KEY, session);
  } catch {
    // ignore
  }
}
