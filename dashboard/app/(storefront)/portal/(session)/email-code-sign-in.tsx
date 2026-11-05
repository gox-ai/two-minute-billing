"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { RadioField } from "@/components/ui/radio-group";
import { Turnstile } from "@/components/turnstile";
import { portalLoginRequestAction, portalLoginVerifyAction } from "./actions";

/**
 * Sign-in by email code (Phase 4) on the signed-out portal cards. A code the customer
 * types, never a link: a mail scanner can open a link, but it cannot type a code.
 */
export function EmailCodeSignIn({ business }: { business: string }) {
  const router = useRouter();
  const [step, setStep] = React.useState<"email" | "code" | "choose">("email");
  const [email, setEmail] = React.useState("");
  const [code, setCode] = React.useState("");
  const [accounts, setAccounts] = React.useState<Array<{ id: string; name: string }>>([]);
  const [account, setAccount] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  const botToken = () =>
    document.querySelector<HTMLInputElement>('#portal-sign-in input[name="turnstile_token"]')
      ?.value || undefined;

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    const res = await portalLoginRequestAction(business, email.trim(), botToken());
    setBusy(false);
    if (!res.ok) return void setError(res.error ?? "We could not send a code. Try again.");
    setCode("");
    setStep("code");
  }

  async function signIn(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy) return;
    if (step === "choose" && !account) return void setError("Select an account.");
    setBusy(true);
    setError(null);
    const res = await portalLoginVerifyAction(
      business,
      email.trim(),
      code.trim(),
      step === "choose" ? account : undefined,
    );
    setBusy(false);
    if (!res.ok) return void setError(res.error ?? "We could not sign you in. Try again.");
    if (res.choose) {
      setAccounts(res.choose);
      setAccount(res.choose[0]?.id ?? "");
      setStep("choose");
      return;
    }
    router.refresh();
  }

  return (
    <div id="portal-sign-in" className="mt-4 flex flex-col gap-3 border-t pt-4 text-left">
      {step === "email" ? (
        <form onSubmit={sendCode} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">Sign in with your email</span>
            <span className="text-sm text-muted-foreground">
              Enter the email on your account. We send you a code to sign in.
            </span>
          </div>
          <label
            className="flex flex-col gap-1.5 text-sm font-medium"
            htmlFor="portal-sign-in-email"
          >
            Email
            <Input
              id="portal-sign-in-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {siteKey ? <Turnstile siteKey={siteKey} /> : null}
          <Button type="submit" disabled={busy || !email.trim()}>
            {busy ? "Sending…" : "Email me a code"}
          </Button>
        </form>
      ) : step === "code" ? (
        <form onSubmit={signIn} className="flex flex-col gap-3">
          <span className="text-sm text-muted-foreground">
            If {email.trim()} has an account, we sent a code to it. The code works for 10 minutes.
          </span>
          <label
            className="flex flex-col gap-1.5 text-sm font-medium"
            htmlFor="portal-sign-in-code"
          >
            Code
            <Input
              id="portal-sign-in-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="tracking-widest tabular-nums"
            />
          </label>
          <Button type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => {
                setError(null);
                setStep("email");
              }}
            >
              Use a different email
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={signIn} className="flex flex-col gap-3">
          <span className="text-sm text-muted-foreground">
            This email is on more than one account. Select the account to open.
          </span>
          <RadioField
            ariaLabel="Account"
            value={account}
            onValueChange={setAccount}
            options={accounts.map((a) => ({ value: a.id, label: a.name }))}
          />
          <Button type="submit" disabled={busy || !account}>
            {busy ? "Opening…" : "Open account"}
          </Button>
        </form>
      )}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}
