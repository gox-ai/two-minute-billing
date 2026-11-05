"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { startRegistration } from "@simplewebauthn/browser";
import { Fingerprint } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  addPasskeyAction,
  passkeyRegistrationOptionsAction,
  removeAuthenticatorAppAction,
  removePasskeyAction,
  renamePasskeyAction,
} from "@/app/passkey-actions";
import {
  CREATE_FAILURE,
  classifyPasskeyError,
  useWebAuthnSupport,
  type PasskeyFailure,
} from "@/lib/passkey-browser";
import type { ActionResult } from "@/lib/action-result";
import { needsStepUp, useStepUp } from "@/components/account/step-up";

const NAME_MAX = 64;

function useRun() {
  const router = useRouter();
  return async (r: Promise<ActionResult>) => {
    const res = await r;
    if (res.ok) {
      if (res.message) toast.success(res.message);
      router.refresh();
    } else toast.error(res.message ?? "The action did not complete");
    return res.ok;
  };
}

/** A removal that asks for a step-up when the API wants one, then retries. */
function useGuardedRun() {
  const run = useRun();
  const { guard } = useStepUp();
  return (action: () => Promise<ActionResult>) =>
    guard(action, async (r) => {
      await run(Promise.resolve(r));
    });
}

/**
 * "Add a passkey": create it in the browser, then name it. The first passkey turns 2FA on, and
 * the page then shows its recovery codes (the action parks them in the same cookie the
 * authenticator app's setup uses).
 */
export function AddPasskeyButton({
  label = "Add",
  variant = "outline",
}: {
  label?: string;
  variant?: "outline" | "default";
}) {
  const router = useRouter();
  const supported = useWebAuthnSupport();
  const { ask } = useStepUp();
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState<"create" | "name">("create");
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<{ title: string; line: string } | null>(null);
  const [created, setCreated] = React.useState<{
    id: string;
    name: string;
    turnedOn: boolean;
  } | null>(null);
  const [name, setName] = React.useState("");
  const [nameError, setNameError] = React.useState<string | null>(null);

  if (supported === false) {
    return (
      <span className="max-w-60 text-xs text-muted-foreground">
        This browser cannot create passkeys. Add one from your phone or another browser.
      </span>
    );
  }

  const reset = () => {
    setStep("create");
    setFailure(null);
    setCreated(null);
    setName("");
    setNameError(null);
  };

  const finish = (c: { turnedOn: boolean }) => {
    setOpen(false);
    reset();
    toast.success(c.turnedOn ? "Two-factor authentication is on" : "Passkey added");
    router.refresh();
  };

  const create = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const o = await passkeyRegistrationOptionsAction();
      if (!o.ok && needsStepUp(o) && ask) {
        // One dialog at a time: close this one, step up, then open it again. The passkey
        // ceremony starts from a fresh click on "Create passkey".
        setOpen(false);
        reset();
        ask(async () => setOpen(true));
        return;
      }
      if (!o.ok)
        return setFailure({ title: "The browser did not make the passkey", line: o.message });
      let response: unknown;
      try {
        response = await startRegistration({ optionsJSON: o.options as never });
      } catch (e) {
        return setFailure(CREATE_FAILURE[classifyPasskeyError(e)]);
      }
      const r = await addPasskeyAction(o.handle, response);
      if (!r.ok) {
        const kind: PasskeyFailure =
          r.reason === "duplicate"
            ? "duplicate"
            : r.reason === "user_verification"
              ? "no_user_verification"
              : "failed";
        return setFailure(
          kind === "failed"
            ? { title: "The browser did not make the passkey", line: r.message }
            : CREATE_FAILURE[kind],
        );
      }
      setCreated({ ...r.passkey, turnedOn: r.turnedOn });
      setName(r.passkey.name);
      setStep("name");
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    if (!created) return;
    const trimmed = name.trim();
    if (!trimmed) return setNameError("Give the passkey a name.");
    if (trimmed !== created.name) {
      setBusy(true);
      const r = await renamePasskeyAction(created.id, trimmed);
      setBusy(false);
      if (!r.ok) return setNameError(r.message ?? "We could not save the name. Try again.");
    }
    finish(created);
  };

  return (
    <>
      <Button type="button" variant={variant} size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          // Closing after the passkey exists keeps it, under the suggested name.
          if (!o && created) return finish(created);
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{step === "create" ? "Add a passkey" : "Passkey created"}</DialogTitle>
            <DialogDescription>
              {step === "create"
                ? "Use your fingerprint, face or screen lock. This is the same step that you use to unlock your phone or laptop."
                : "Give the passkey a name. We suggest a name from your device. You can change it."}
            </DialogDescription>
          </DialogHeader>
          {step === "create" ? (
            failure ? (
              <Alert tone="warning" title={failure.title}>
                {failure.line}
              </Alert>
            ) : (
              <p className="m-0 text-xs text-muted-foreground">
                Step 1 of 2 · Step 2: give it a name.
              </p>
            )
          ) : (
            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void saveName();
              }}
            >
              <Label htmlFor="passkey-name">Name</Label>
              <Input
                id="passkey-name"
                value={name}
                maxLength={NAME_MAX}
                autoFocus
                aria-invalid={nameError ? true : undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(null);
                }}
              />
              {nameError ? <p className="m-0 text-xs text-destructive">{nameError}</p> : null}
            </form>
          )}
          <DialogFooter>
            {step === "create" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button type="button" onClick={() => void create()} disabled={busy}>
                  {failure ? null : <Fingerprint aria-hidden />}
                  {busy ? "Waiting for your browser…" : failure ? "Try again" : "Create passkey"}
                </Button>
              </>
            ) : (
              <Button type="button" onClick={() => void saveName()} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "Rename" on one passkey. */
export function RenamePasskeyButton({ id, name }: { id: string; name: string }) {
  const run = useRun();
  const [open, setOpen] = React.useState(false);
  // Seeded on open (below), so it always starts from the current name.
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const save = async () => {
    if (!value.trim()) return setError("Give the passkey a name.");
    setBusy(true);
    const ok = await run(renamePasskeyAction(id, value));
    setBusy(false);
    if (ok) setOpen(false);
  };
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Rename ${name}`}
        onClick={() => {
          setValue(name);
          setError(null);
          setOpen(true);
        }}
      >
        Rename
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Rename passkey</DialogTitle>
            <DialogDescription>
              Your passkey list and the security emails show this name.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Label htmlFor={`passkey-rename-${id}`}>Name</Label>
            <Input
              id={`passkey-rename-${id}`}
              value={value}
              maxLength={NAME_MAX}
              autoFocus
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
            {error ? <p className="m-0 text-xs text-destructive">{error}</p> : null}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * "Remove" on one passkey. When it is the last method the dialog says so and removing it turns
 * 2FA off — the API refuses that unless told, so the dialog's wording and the request agree.
 */
export function RemovePasskeyButton({
  id,
  name,
  isLast,
  remaining,
}: {
  id: string;
  name: string;
  isLast: boolean;
  /** "your other passkey and your authenticator app" — what keeps 2FA on. */
  remaining: string;
}) {
  const run = useGuardedRun();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Remove ${name}`}
        onClick={() => setOpen(true)}
      >
        Remove
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={isLast ? "Remove your last 2FA method?" : "Remove this passkey?"}
        description={
          isLast
            ? `${name} is your only passkey, and you do not have an authenticator app. If you remove it, we disable two-factor authentication and delete your recovery codes.`
            : `You cannot sign in with ${name} after this. 2FA stays on with ${remaining}. The device keeps the passkey until you delete it on the device.`
        }
        confirmLabel={isLast ? "Remove and disable 2FA" : "Remove passkey"}
        destructive
        onConfirm={async () => {
          await run(() => removePasskeyAction(id, isLast));
        }}
      />
    </>
  );
}

/** "Remove" on the authenticator app — offered only while a passkey keeps 2FA on. */
export function RemoveAuthenticatorAppButton({ remaining }: { remaining: string }) {
  const run = useGuardedRun();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Remove the authenticator app?"
        description={`Codes from your app will stop operating. 2FA stays on with ${remaining}.`}
        confirmLabel="Remove app"
        destructive
        onConfirm={async () => {
          await run(() => removeAuthenticatorAppAction());
        }}
      />
    </>
  );
}
