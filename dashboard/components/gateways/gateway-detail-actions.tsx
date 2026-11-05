"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, ShieldCheck, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { ActionResult } from "@/lib/action-result";
import type { GatewayVerifyResult } from "@/lib/api/gateways";

type VerifyOutcome = Pick<GatewayVerifyResult, "ok" | "detail" | "checks">;

/**
 * Imperative actions on a gateway account detail page: Verify (health probe,
 * result shown inline), Set as default, and Delete (ConfirmDialog; extra
 * warning when the account is the business default).
 */
export function GatewayDetailActions({
  isDefault,
  label,
  listHref,
  verify,
  setDefault,
  destroy,
}: {
  /** Whether this account is (or may be) the business default. */
  isDefault: boolean;
  label: string;
  /** Where to navigate after a successful delete (the gateways list). */
  listHref: string;
  verify: () => Promise<VerifyOutcome>;
  setDefault: () => Promise<ActionResult>;
  destroy: () => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [verifying, startVerify] = React.useTransition();
  const [settingDefault, startSetDefault] = React.useTransition();
  const [verifyResult, setVerifyResult] = React.useState<VerifyOutcome | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  function handleVerify() {
    setVerifyResult(null);
    startVerify(async () => {
      const res = await verify();
      setVerifyResult(res);
    });
  }

  function handleSetDefault() {
    startSetDefault(async () => {
      const res = await setDefault();
      if (res.ok) {
        toast.success(res.message ?? "Set as default gateway");
        router.refresh();
      } else {
        toast.error(res.message ?? "We could not set the default gateway.");
      }
    });
  }

  async function handleDelete() {
    const res = await destroy();
    if (res.ok) {
      if (res.warning)
        toast.warning(res.message ?? "Gateway account deleted.", { duration: Infinity });
      else toast.success(res.message ?? "Gateway account deleted.");
      router.push(listHref);
      router.refresh();
    } else {
      toast.error(res.message ?? "We could not delete the gateway account.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={handleVerify} disabled={verifying}>
          {verifying ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <ShieldCheck className="size-4" aria-hidden />
          )}
          Check credentials
        </Button>
        <Button variant="outline" onClick={handleSetDefault} disabled={settingDefault || isDefault}>
          {settingDefault ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Star className="size-4" aria-hidden />
          )}
          {isDefault ? "Default gateway" : "Set as default"}
        </Button>
        <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="size-4" aria-hidden />
          Delete
        </Button>
      </div>

      {verifyResult ? <VerifyAlert result={verifyResult} /> : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${label}”?`}
        destructive
        confirmLabel="Delete gateway account"
        description={
          <>
            This permanently deletes the gateway account and its stored credentials. We also delete
            the webhook that sends this account&apos;s events, if the gateway lets us. Payment
            methods saved on it go to another account. That account usually cannot charge them.
            {isDefault ? (
              <b className="mt-1 block text-destructive">
                This account is the default gateway of the business. If you delete it, the business
                has no default gateway. Until you set a new default, we refuse a charge that more
                than one account can take.
              </b>
            ) : null}
          </>
        }
        onConfirm={handleDelete}
      />
    </div>
  );
}

/** The probe's verdict, with each named check that needs the operator listed below it. */
function VerifyAlert({ result }: { result: VerifyOutcome }) {
  const notes = (result.checks ?? []).filter((c) => c.status !== "ok");
  const failed = notes.some((c) => c.status === "failed");
  const tone = !result.ok ? "error" : notes.length ? "warning" : "success";
  const title = result.ok
    ? notes.length
      ? "Healthy. We could not run all checks."
      : "Healthy"
    : failed
      ? "Correct the settings below."
      : "We could not check the credentials.";
  return (
    <Alert tone={tone} title={title}>
      {notes.length ? (
        <div className="space-y-2">
          {notes.map((c) => (
            <div key={c.key} className="space-y-1">
              <p>{c.message}</p>
              {c.steps?.length ? (
                <ol className="list-decimal space-y-0.5 pl-5 text-xs opacity-90">
                  {c.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              ) : null}
            </div>
          ))}
        </div>
      ) : result.detail ? (
        <span className="text-xs opacity-90">{result.detail}</span>
      ) : null}
    </Alert>
  );
}
