"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plug, RefreshCw, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/patterns/chip";
import { Alert } from "@/components/ui/alert";
import { CopyButton } from "@/components/patterns/copy-button";
import { Field } from "@/components/form/field";
import type { GatewayWebhookEndpoint } from "@/lib/api/gateways";

/**
 * Webhooks card on a gateway account.
 *
 * Key behavior: **tmbilling owns the webhook secret — the operator is never
 * asked to supply one.**
 *   - Stripe / PayPal (`self_provisioned`): we register the endpoint with the
 *     provider ourselves and keep the secret / webhook id it mints. Nothing to copy.
 *   - RazorPay: WE generate the shared secret and register the endpoint with it. Only
 *     when registration fails (`paste_required`) is it shown (Show/Copy) for pasting.
 *   - `secret_in`: the exception — the gateway mints a secret it will not hand to an API,
 *     so the operator pastes it here. Write-only, like the credentials card.
 *   - `url_only`: the API keys verify the events; the operator only registers the URL.
 *
 * The Notification URL carries the gateway account's public id (`?id=gwa_…`) so
 * inbound events are attributed to this exact account.
 */
export function GatewayWebhookCard({
  gatewayName,
  endpoint,
  provision,
  reveal,
  saveSecret,
}: {
  gatewayName: string;
  endpoint: GatewayWebhookEndpoint;
  provision: (
    force: boolean,
  ) => Promise<{ ok: boolean; detail?: string; endpoint?: GatewayWebhookEndpoint }>;
  reveal: () => Promise<{ ok: boolean; secret?: string | null; detail?: string }>;
  /** `secret_in` only: store the gateway's secret. */
  saveSecret: (
    secret: string,
  ) => Promise<{ ok: boolean; detail?: string; endpoint?: GatewayWebhookEndpoint }>;
}) {
  const router = useRouter();
  const [ep, setEp] = React.useState(endpoint);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [pasted, setPasted] = React.useState("");
  const [busy, startBusy] = React.useTransition();
  const [revealing, startReveal] = React.useTransition();
  const [saving, startSave] = React.useTransition();

  // Keep local state in sync when the server component refetches after revalidate.
  React.useEffect(() => {
    setEp(endpoint);
  }, [endpoint]);

  if (ep.mode === "not_applicable") {
    return (
      <p className="text-sm text-muted-foreground">
        The {gatewayName} runs in-process. It does not need an external webhook endpoint.
      </p>
    );
  }

  const urlMissingBase = !ep.notification_url.startsWith("http");
  // We hold no secret of our own for these two, so there is nothing to generate or rotate.
  const noOwnSecret = ep.mode === "secret_in" || ep.mode === "url_only";

  function handleProvision(force: boolean) {
    startBusy(async () => {
      const res = await provision(force);
      if (!res.ok) {
        toast.error(res.detail ?? "We could not configure the webhook.");
        return;
      }
      if (res.endpoint) setEp(res.endpoint);
      if (res.endpoint?.secret) setSecret(res.endpoint.secret);
      // The mode AFTER the call: a non-force call can register a paste-required endpoint.
      toast.success(
        (res.endpoint ?? ep).mode === "self_provisioned"
          ? `Endpoint registered with ${gatewayName}`
          : noOwnSecret
            ? "Webhook endpoint checked"
            : "Webhook secret generated. Paste it into your gateway dashboard",
      );
      router.refresh();
    });
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    startSave(async () => {
      const res = await saveSecret(pasted);
      if (!res.ok) {
        toast.error(res.detail ?? "We could not save the webhook secret.");
        return;
      }
      if (res.endpoint) setEp(res.endpoint);
      setPasted("");
      toast.success("Webhook secret saved");
      router.refresh();
    });
  }

  function handleReveal() {
    if (secret) {
      setSecret(null);
      return;
    }
    startReveal(async () => {
      const res = await reveal();
      if (!res.ok || !res.secret) {
        toast.error(res.detail ?? "No secret is available. Generate a secret first");
        return;
      }
      setSecret(res.secret);
    });
  }

  return (
    <div className="space-y-4">
      <Field
        name="notification_url"
        label="Notification URL"
        help={
          ep.mode === "self_provisioned"
            ? `We register this URL with ${gatewayName} for you. You do not need to copy a secret.`
            : ep.mode === "secret_in"
              ? `Paste this URL into your ${gatewayName} dashboard. Then paste the secret that ${gatewayName} shows into the field below.`
              : ep.mode === "url_only"
                ? `Paste this URL into your ${gatewayName} dashboard. ${gatewayName} signs its events with your API keys, so there is no secret to copy.`
                : `Paste this URL and the secret below into your ${gatewayName} dashboard.`
        }
      >
        <div className="flex max-w-xl items-center gap-2">
          <Input readOnly value={ep.notification_url} className="font-mono text-xs" />
          <CopyButton value={ep.notification_url} className="size-8 shrink-0 border" />
        </div>
      </Field>

      {urlMissingBase ? (
        <Alert tone="warning">
          <code className="font-mono text-xs">WEBHOOK_BASE_URL</code> is not configured, so this URL
          has no origin. Before you register the endpoint, set it to the public base URL of this
          API. In local development, use a tunnel origin.
        </Alert>
      ) : null}

      {/* Status: what the operator actually needs to know. `url_only` always reads as
          configured (the keys verify), yet only the gateway knows whether the URL is
          registered, so it gets no chip. */}
      <p className="text-sm">
        {ep.mode === "url_only" ? null : ep.configured ? (
          <Chip tone="green">
            {ep.mode === "self_provisioned"
              ? `Registered with ${gatewayName} ✓`
              : ep.mode === "secret_in"
                ? "Webhook secret saved ✓"
                : "Webhook secret generated ✓"}
          </Chip>
        ) : (
          <Chip tone="tan">Not configured yet</Chip>
        )}
        {ep.webhook_id ? (
          <span className="ml-2 text-xs text-muted-foreground">
            Webhook ID <code className="font-mono">{ep.webhook_id}</code>
          </span>
        ) : null}
      </p>

      {/* RazorPay-style secret display (Show / Copy), only when we hold one. */}
      {ep.mode === "paste_required" ? (
        <Field
          name="webhook_secret"
          label="Secret"
          help="We generate this secret. Paste it into the webhook Secret field of the gateway."
        >
          <div className="flex max-w-xl items-center gap-2">
            <Input
              readOnly
              value={secret ?? "•".repeat(44)}
              className="font-mono text-xs"
              type="text"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={handleReveal}
              disabled={revealing || !ep.configured}
            >
              {revealing ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : secret ? (
                <EyeOff className="size-4" aria-hidden />
              ) : (
                <Eye className="size-4" aria-hidden />
              )}
              {secret ? "Hide" : "Show"}
            </Button>
            {secret ? <CopyButton value={secret} className="size-8 shrink-0 border" /> : null}
          </div>
        </Field>
      ) : null}

      {ep.mode === "secret_in" ? (
        <form onSubmit={handleSave}>
          <Field
            name="webhook_secret"
            label="Webhook secret"
            help={`Paste the secret from your ${gatewayName} dashboard. We store it encrypted, and nobody can view it.`}
          >
            {/* The row takes its own id so `Field`'s label points at the input. */}
            <div id="webhook_secret_row" className="flex max-w-xl items-center gap-2">
              <Input
                id="webhook_secret"
                type="password"
                autoComplete="off"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder={ep.configured ? "Paste a new secret to replace the saved one" : ""}
                className="font-mono text-xs"
              />
              <Button
                type="submit"
                size="sm"
                className="shrink-0"
                disabled={saving || !pasted.trim()}
              >
                {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Save
              </Button>
            </div>
          </Field>
        </form>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => handleProvision(false)}
          disabled={busy || urlMissingBase}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Plug className="size-4" aria-hidden />
          )}
          {ep.configured || noOwnSecret
            ? "Re-check endpoint"
            : ep.mode === "self_provisioned"
              ? `Register with ${gatewayName}`
              : "Generate secret"}
        </Button>
        {ep.configured && !noOwnSecret ? (
          <Button
            variant="outline"
            onClick={() => handleProvision(true)}
            disabled={busy || urlMissingBase}
          >
            <RefreshCw className="size-4" aria-hidden />
            {ep.mode === "self_provisioned" ? "Re-register" : "Rotate secret"}
          </Button>
        ) : null}
      </div>

      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        {ep.instructions.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
