"use client";

import * as React from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { CheckboxField } from "@/components/ui/checkbox";
import {
  mfaPasskeyLoginAction,
  mfaPasskeyOptionsAction,
  passkeySignInAction,
  passkeySignInOptionsAction,
  type PasskeyOptionsResult,
  type PasskeySignInResult,
} from "@/app/passkey-actions";
import {
  classifyPasskeyError,
  passkeyNamesPhrase,
  useWebAuthnSupport,
} from "@/lib/passkey-browser";

/** Run one sign-in ceremony: options → the browser's prompt → verify. */
async function ceremony(
  getOptions: () => Promise<PasskeyOptionsResult>,
  verify: (handle: string, response: unknown) => Promise<PasskeySignInResult>,
): Promise<{ to?: string; error?: string; cancelled?: boolean }> {
  const o = await getOptions();
  if (!o.ok) return { error: o.message };
  let response: unknown;
  try {
    response = await startAuthentication({ optionsJSON: o.options as never });
  } catch (e) {
    return classifyPasskeyError(e) === "cancelled"
      ? { cancelled: true }
      : { error: "The passkey did not operate. Try again, or use a different method." };
  }
  const r = await verify(o.handle, response);
  return r.ok ? { to: r.to } : { error: r.message, to: r.to };
}

/**
 * "Sign in with a passkey" on the first page. No email, no password: the browser offers the
 * passkeys it holds for this site. Hidden where the browser cannot use passkeys at all — a
 * button that can only fail is worse than none.
 */
export function PasskeySignInButton({ redirectTo }: { redirectTo?: string }) {
  const supported = useWebAuthnSupport();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  if (!supported) return null;
  return (
    <div className="space-y-2">
      {error ? (
        <Alert tone="error" title="The passkey sign-in did not operate">
          {error}
        </Alert>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const r = await ceremony(passkeySignInOptionsAction, (h, res) =>
            passkeySignInAction(h, res, redirectTo),
          );
          // A full navigation: the session arrived as a cookie on this action's response, and
          // the router's cached payloads were rendered for a signed-out visitor.
          if (r.to && !r.error) return window.location.assign(r.to);
          setBusy(false);
          if (r.error) setError(r.error);
        }}
      >
        <Fingerprint aria-hidden />
        {busy ? "Waiting for your browser…" : "Sign in with a passkey"}
      </Button>
    </div>
  );
}

/** The sign-in second step, answered with a passkey. */
export function PasskeySecondStep({
  passkeyNames,
  redirectTo,
}: {
  passkeyNames: string[];
  redirectTo?: string;
}) {
  const supported = useWebAuthnSupport();
  const [busy, setBusy] = React.useState(false);
  const [trust, setTrust] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [cancelled, setCancelled] = React.useState(false);
  const names = passkeyNamesPhrase(passkeyNames);

  if (supported === false) {
    return (
      <Alert tone="warning" title="This browser cannot use passkeys">
        Use a different method, or use a different browser.
      </Alert>
    );
  }
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="m-0 text-sm font-medium">Use your passkey to complete the sign-in.</p>
        {names ? <p className="m-0 text-xs text-muted-foreground">{names}</p> : null}
      </div>
      {error ? (
        <Alert tone="error" title="The passkey did not operate">
          {error}
        </Alert>
      ) : cancelled ? (
        <Alert tone="info" title="Is your passkey on your phone?">
          In the browser window, select &ldquo;Use a phone or tablet&rdquo;.
        </Alert>
      ) : null}
      <CheckboxField
        checked={trust}
        onCheckedChange={setTrust}
        label="Do not ask again on this browser for 30 days"
        hint="Select this only on your own computer."
      />
      <Button
        type="button"
        className="w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setCancelled(false);
          const r = await ceremony(mfaPasskeyOptionsAction, (h, res) =>
            mfaPasskeyLoginAction(h, res, trust, redirectTo),
          );
          if (r.to) return window.location.assign(r.to);
          setBusy(false);
          if (r.cancelled) setCancelled(true);
          else if (r.error) setError(r.error);
        }}
      >
        <Fingerprint aria-hidden />
        {busy ? "Waiting for your browser…" : cancelled ? "Try again" : "Use passkey"}
      </Button>
    </div>
  );
}
