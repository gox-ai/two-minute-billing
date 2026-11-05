"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { signInAgainAction, stepUpAction } from "@/app/auth-actions";
import { LIMITS } from "@/lib/limits";

/**
 * What `/auth/step_up` can take from this person. `code`: a TOTP or recovery code. `recovery`:
 * 2FA through passkeys only, so a recovery code. `password`: no 2FA. `google`: no 2FA and no
 * password, so only a new sign-in.
 */
export type StepUpProof = "code" | "recovery" | "password" | "google";

type Retry = () => Promise<void>;
const AskContext = React.createContext<((retry: Retry) => void) | null>(null);

/**
 * Wraps the 2FA card. The API refuses its writes with `step_up_required` unless the session
 * stepped up or signed in within the window; this asks once, then retries the refused action.
 */
export function StepUpProvider({
  proof,
  windowMinutes,
  children,
}: {
  proof: StepUpProof;
  windowMinutes: number;
  children: React.ReactNode;
}) {
  const [retry, setRetry] = React.useState<Retry | null>(null);
  // A new key per prompt, so the field and its error start empty each time.
  const [prompt, setPrompt] = React.useState(0);
  const ask = React.useCallback((r: Retry) => {
    setPrompt((n) => n + 1);
    setRetry(() => r);
  }, []);
  return (
    <AskContext.Provider value={ask}>
      {children}
      <StepUpDialog
        key={prompt}
        open={retry !== null}
        proof={proof}
        windowMinutes={windowMinutes}
        onCancel={() => setRetry(null)}
        onConfirmed={async () => {
          const r = retry;
          setRetry(null);
          await r?.();
        }}
      />
    </AskContext.Provider>
  );
}

/**
 * `guard(run, done)`: run the action. If the API wants a step-up, ask for it and run it again.
 * `done` gets the final result either way. `ask(retry)` is the raw prompt, for flows that must
 * close their own dialog first.
 */
export function useStepUp() {
  const ask = React.useContext(AskContext);
  const guard = React.useCallback(
    async <T extends { ok: boolean; code?: string; reason?: string }>(
      run: () => Promise<T>,
      done: (r: T) => void | Promise<void>,
    ) => {
      const r = await run();
      if (ask && !r.ok && needsStepUp(r)) {
        ask(async () => done(await run()));
        return;
      }
      await done(r);
    },
    [ask],
  );
  return { guard, ask };
}

export function needsStepUp(r: { code?: string; reason?: string }): boolean {
  return r.code === "step_up_required" || r.reason === "step_up_required";
}

function StepUpDialog({
  open,
  proof,
  windowMinutes,
  onCancel,
  onConfirmed,
}: {
  open: boolean;
  proof: StepUpProof;
  windowMinutes: number;
  onCancel: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const field = proof === "password" ? "password" : "code";
  const confirm = async () => {
    if (!value.trim()) return setError("Enter a value.");
    setBusy(true);
    const r = await stepUpAction(field === "password" ? { password: value } : { code: value });
    setBusy(false);
    if (!r.ok) return setError(r.errors?.[field] ?? r.message ?? "Try again.");
    await onConfirmed();
  };
  const signInAgain = async () => {
    setBusy(true);
    await signInAgainAction();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onCancel())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
            Confirm your identity
          </DialogTitle>
          <DialogDescription>
            This change affects how you sign in. After you confirm, you can make changes for{" "}
            {windowMinutes} minutes.
          </DialogDescription>
        </DialogHeader>
        {proof === "google" ? (
          <p className="m-0 text-sm text-muted-foreground">
            You sign in with Google and you do not have a password. To confirm your identity, sign
            in again. We then show this page again.
          </p>
        ) : (
          <form
            className="space-y-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            <Label htmlFor="step-up-value">
              {proof === "password" ? "Password" : proof === "recovery" ? "Recovery code" : "Code"}
            </Label>
            <Input
              id="step-up-value"
              type={proof === "password" ? "password" : "text"}
              autoComplete={proof === "password" ? "current-password" : "one-time-code"}
              inputMode={proof === "code" ? "numeric" : undefined}
              maxLength={proof === "password" ? LIMITS.password : 20}
              value={value}
              autoFocus
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
            <p className="m-0 text-xs text-muted-foreground">
              {proof === "code"
                ? "Enter the 6-digit code from your authenticator app, or a recovery code."
                : proof === "recovery"
                  ? "Enter one of your recovery codes. Or sign in again with your passkey."
                  : "Enter the password that you use to sign in."}
            </p>
            {error ? <p className="m-0 text-xs text-destructive">{error}</p> : null}
          </form>
        )}
        <DialogFooter>
          {proof === "google" ? (
            <>
              <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void signInAgain()} disabled={busy}>
                Sign in again
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                onClick={() => void signInAgain()}
                disabled={busy}
              >
                Sign in again
              </Button>
              <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void confirm()} disabled={busy}>
                {busy ? "Confirming…" : "Confirm"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
