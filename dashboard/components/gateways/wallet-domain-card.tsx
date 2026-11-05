"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/patterns/chip";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/form/field";
import type { WalletDomainStatus } from "@/lib/api/gateways";

/** Gateway wallet names → what a buyer would recognise. */
const WALLET_LABELS: Record<string, string> = {
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  link: "Stripe Link",
  paypal: "PayPal",
};

/**
 * Register a storefront domain so wallet buttons may render on it.
 *
 * The reason this screen exists at all: Apple Pay paints NO button on a domain the gateway
 * has not registered, and it says nothing — no error, no console warning, no failed
 * request. An unregistered domain and "we do not support Apple Pay" look identical from
 * the outside. Nothing else was missing: an Apple Pay token is a card credential to the
 * gateway, the payment sheet surfaces the button by itself, and a saved instrument already
 * reads back as "Apple Pay" rather than a bare card brand.
 *
 * The per-wallet verdict shown here is the GATEWAY's, never ours, and its `detail` is
 * printed verbatim because it names the actual cause — almost always that the
 * association file is not reachable on that domain.
 */
export function WalletDomainCard({
  gatewayName,
  register,
}: {
  gatewayName: string;
  register: (
    domain: string,
  ) => Promise<{ ok: boolean; detail?: string; status?: WalletDomainStatus }>;
}) {
  const router = useRouter();
  /**
   * Left EMPTY on purpose, and the engine fills it in.
   *
   * This was prefilled from `window.location.hostname` on the reasoning that the storefront
   * and the dashboard are one app. True in local dev — both are :4100 — and WRONG in
   * production, where they are separate hosts (`portal.…` and `app.…`). The prefill would
   * therefore have registered the dashboard's domain, on which no buyer ever pays, and the
   * wallet would have stayed dark for the reason hardest to guess: a registration that
   * succeeded on the wrong domain.
   *
   * Only the API knows the storefront host (`PORTAL_BASE_URL`), so blank means "use it" and
   * the response says which domain was actually registered. Typing one here overrides that,
   * for a deployment serving checkout from somewhere else again.
   */
  const [domain, setDomain] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<WalletDomainStatus | null>(null);

  async function handleRegister() {
    setBusy(true);
    const res = await register(domain);
    setBusy(false);
    if (!res.ok) return void toast.error(res.detail ?? "We could not register the domain.");
    setStatus(res.status ?? null);
    toast.success("Domain checked");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <Field
        name="wallet_domain"
        label="Storefront domain"
        help={`Leave blank to use the storefront domain that this deployment configures. Buyers pay on that domain, not on this dashboard. We register the domain with ${gatewayName} so Apple Pay and Google Pay may appear at checkout. To use a different domain, enter only the hostname, with no https:// and no path.`}
      >
        <div className="flex max-w-xl items-center gap-2">
          <Input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="Using the configured storefront domain"
            className="font-mono text-xs"
          />
          {/* Enabled with the field EMPTY: blank is the normal case, and the server
              resolves the storefront domain. */}
          <Button onClick={handleRegister} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Wallet className="size-3.5" />}
            <span className="ml-1">Register &amp; check</span>
          </Button>
        </div>
      </Field>

      {status ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {status.wallets.map((w) => (
              <Chip key={w.wallet} tone={w.active ? "green" : "gray"}>
                {WALLET_LABELS[w.wallet] ?? w.wallet} · {w.active ? "live" : "not live"}
              </Chip>
            ))}
          </div>
          {status.wallets.some((w) => !w.active && w.detail) ? (
            <Alert tone="warning">
              <div className="space-y-1">
                {status.wallets
                  .filter((w) => !w.active && w.detail)
                  .map((w) => (
                    <div key={w.wallet}>
                      <span className="font-medium">{WALLET_LABELS[w.wallet] ?? w.wallet}:</span>{" "}
                      {w.detail}
                    </div>
                  ))}
                <div className="text-muted-foreground">
                  Serve the association file at{" "}
                  <code className="font-mono text-xs">
                    /.well-known/apple-developer-merchantid-domain-association
                  </code>{" "}
                  on this domain. Then check again.
                </div>
              </div>
            </Alert>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
