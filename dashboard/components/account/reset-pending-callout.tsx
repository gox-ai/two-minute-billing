import { Alert } from "@/components/ui/alert";
import { fmtDate } from "@/lib/format-date";

/** "8 Oct 2026", in UTC like the email that announced it. */
function day(iso: string): string | null {
  return Number.isNaN(Date.parse(iso)) ? null : fmtDate(iso, "UTC");
}

/**
 * Support is about to turn this person's 2FA off. Shown on the sign-in code step and on the
 * account page's two-factor card. No button: the emailed link is the only way to cancel, which
 * is what the copy says.
 */
export function ResetPendingCallout({ effectiveAt }: { effectiveAt: string }) {
  const d = day(effectiveAt);
  return (
    <Alert tone="warning" title="2FA reset requested">
      Support will disable 2FA {d ? `on ${d}` : "in a few days"}. Did you not ask for this? Use the
      link in our email to cancel the reset.
    </Alert>
  );
}
