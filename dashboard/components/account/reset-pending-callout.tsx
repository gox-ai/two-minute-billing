import { Alert } from "@/components/ui/alert";

/** "8 Oct 2026", in UTC like the email that announced it. */
function day(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
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
