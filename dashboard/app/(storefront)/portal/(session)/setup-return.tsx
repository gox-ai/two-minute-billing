"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { reportBuyerError } from "@/lib/buyer-error-report";
import { Loader2 } from "lucide-react";
import { portalCompleteVaultAction } from "./actions";
import { usePortalSession } from "./portal-session-context";
import { withPortalSession } from "@/lib/portal-path";
import { AddMethodResult } from "./add-method-result";
import type { AddMethodOutcome } from "./portal-state";
import type { PortalMe } from "@/lib/portal-api";
import {
  clearPendingVaultSetup,
  consumeSetupReturn,
  readPendingVaultSetup,
} from "@/lib/pending-vault-setup";

/**
 * Completes a redirect-mode add-payment-method after the provider sends the buyer
 * back to `?setup=return` (PayPal wallet approval today; any redirect provider).
 *
 * Without this the buyer approves at PayPal, lands back on the portal, and
 * nothing happens — the approved setup token is never exchanged for a vaulted
 * method, so no payment method appears.
 *
 * The setup token comes from the pending setup stashed before we left; PayPal
 * also echoes it back as `approval_token_id`, which covers a tab where
 * sessionStorage isn't available.
 */
export function SetupReturn({ scope, me }: { scope: string; me: PortalMe }) {
  const session = usePortalSession();
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<AddMethodOutcome | null>(null);
  // The exchange must run exactly once per return, even under StrictMode's
  // double-invoked effects in dev.
  const ran = React.useRef(false);

  React.useEffect(() => {
    if (ran.current) return;
    const ret = consumeSetupReturn(withPortalSession("/portal", session));
    if (!ret) return;
    ran.current = true;

    const pending = readPendingVaultSetup(scope);
    if (ret.outcome === "cancel") {
      clearPendingVaultSetup(scope);
      toast("Payment method setup cancelled");
      return;
    }

    const setupToken = ret.approvalToken ?? pending?.setupToken;
    if (!setupToken) {
      const text = "We could not finish adding that payment method. Start again.";
      toast.error(text);
      reportBuyerError(text, { step: "setup_return" });
      return;
    }

    setBusy(true);
    void (async () => {
      // Vault on the SAME gateway the setup ran on — completing on the business
      // default would look the token up on the wrong account and fail.
      // Through the setup INTENT when we stashed one: the provider's webhook may have
      // harvested the same approval while the buyer was being redirected back, and the
      // intent's atomic claim is what makes whichever arrives second a no-op instead of
      // a second payment method. The approved token stays as the fallback.
      const res = await portalCompleteVaultAction(
        session,
        {
          ...(pending?.paymentIntent ? { paymentIntent: pending.paymentIntent } : {}),
          providerToken: setupToken,
          // An sdk gateway that left for its own 3DS page names the result on the URL.
          ...(pending?.paymentIntent && ret.clientResult ? { clientResult: ret.clientResult } : {}),
        },
        pending?.gateway,
      );
      /**
       * Cleared only on SUCCESS. A failed completion is exactly when the stash is still
       * needed: a buyer whose first attempt is refused inside the gateway's own sheet
       * retries THERE and comes back a second time, and clearing on the first (failed)
       * return left that second return with no setup token and no intent to complete
       * through — so it could only say "please start again" for a card that had just
       * been approved.
       */
      if (res.ok) clearPendingVaultSetup(scope);
      setBusy(false);
      // The action revalidates this path, and that re-render restores the URL the
      // router still thinks we're on (query and all). Strip it through the router
      // so a later reload can't replay a spent setup token.
      router.replace(withPortalSession("/portal", session), { scroll: false });
      /**
       * REFRESH EITHER WAY, and that is the fix for "it only worked after I refreshed".
       *
       * Our leg failing does not mean the instrument is not there. The gateway's webhook
       * harvest is the documented other completer for this exact intent
       * (`completeVaultFromIntent` waits ~2s for it and then gives up), and it can land
       * after we have given up — so the card is vaulted server-side while this page
       * still shows the state it rendered with. Refreshing only on success is what made
       * a manual reload the thing that "fixed" it.
       */
      router.refresh();
      if (!res.ok) {
        // Not "we failed" — the honest state is "not confirmed HERE yet", because the
        // refresh above may already be painting the card this toast is apologising for.
        const text =
          res.error ??
          "We could not confirm that payment method here. If you approved it, it will show here soon.";
        reportBuyerError(text, { step: "setup_return" });
        return void toast.error(text);
      }
      if (res.outcome) setOutcome(res.outcome);
      else toast.success("Payment method added.");
    })();
  }, [scope, router]);

  if (!busy)
    return (
      <AddMethodResult outcome={outcome} onClose={() => setOutcome(null)} me={me} scope={scope} />
    );
  return (
    <div className="flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Finishing setup with your payment provider…
    </div>
  );
}
