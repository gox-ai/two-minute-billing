"use client";

import * as React from "react";
import { Share } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { installPrompt, isIosSafari, isStandalone, setInstallPrompt } from "@/lib/pwa";

export type InstallMode = "prompt" | "ios" | null;

/**
 * What "Install the app" can do here: start the browser's own prompt, show the iPhone steps,
 * or nothing (already installed, or the browser offers no install).
 */
export function useInstallApp(): { mode: InstallMode; install: () => void } {
  const prompt = React.useSyncExternalStore(
    installPrompt.subscribe,
    installPrompt.get,
    installPrompt.getServer,
  );
  const [env, setEnv] = React.useState<{ standalone: boolean; ios: boolean } | null>(null);
  // Browser-only facts; read after mount so the server render and hydration agree.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => setEnv({ standalone: isStandalone(), ios: isIosSafari() }), []);

  const mode: InstallMode =
    !env || env.standalone ? null : prompt ? "prompt" : env.ios ? "ios" : null;
  const install = React.useCallback(() => {
    if (!prompt) return;
    void prompt.prompt();
    // A prompt can be used once; the browser fires a new event if it may ask again.
    void prompt.userChoice.finally(() => setInstallPrompt(null));
  }, [prompt]);
  return { mode, install };
}

/** Safari on iPhone has no install prompt: the steps to add the app to the Home Screen. */
export function IosInstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Install the app</DialogTitle>
          <DialogDescription>
            Add Two Minute Billing to your Home Screen to get notifications on this device.
          </DialogDescription>
        </DialogHeader>
        <ol className="flex list-decimal flex-col gap-2 ps-5 text-sm">
          <li>
            Select the Share button{" "}
            <Share aria-hidden className="inline size-4 align-text-bottom text-muted-foreground" />{" "}
            in Safari.
          </li>
          <li>
            Select <span className="font-medium">Add to Home Screen</span>.
          </li>
          <li>Open Two Minute Billing from your Home Screen.</li>
          <li>
            Go to <span className="font-medium">Notifications</span> and select{" "}
            <span className="font-medium">Enable on this device</span>.
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          Needs iOS 16.4 or later. Push does not work in a Safari tab on iPhone.
        </p>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

const CARD_DISMISSED_KEY = "tmb.install-card.dismissed";

/**
 * The install offer as a card (Home, Notifications): desktop Chrome shows only an address-bar
 * icon, so most people never see an install prompt otherwise. Shown while an install is
 * possible here; "Not now" hides it in this browser.
 */
export function InstallCard({
  className,
  ios = true,
}: {
  className?: string;
  /** False where the page has its own iPhone install note (Notifications). */
  ios?: boolean;
}) {
  const { mode, install } = useInstallApp();
  const [dismissed, setDismissed] = React.useState(true);
  const [iosOpen, setIosOpen] = React.useState(false);
  // Read after mount: storage can throw (private window, blocked site data).
  React.useEffect(() => {
    let v: string | null = null;
    try {
      v = localStorage.getItem(CARD_DISMISSED_KEY);
    } catch {
      // No storage: show the card; "Not now" then hides it until the next load.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(v === "1");
  }, []);
  if (!mode || dismissed || (mode === "ios" && !ios)) return null;
  const notNow = () => {
    setDismissed(true);
    try {
      localStorage.setItem(CARD_DISMISSED_KEY, "1");
    } catch {
      // Hidden for this page view only.
    }
  };
  return (
    <>
      <Alert
        tone="neutral"
        title="Install Two Minute Billing"
        className={className}
        action={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => (mode === "ios" ? setIosOpen(true) : install())}
            >
              Install
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={notNow}>
              Not now
            </Button>
          </div>
        }
      >
        Open billing in its own window and get notifications on this device.
      </Alert>
      {mode === "ios" ? <IosInstallDialog open={iosOpen} onOpenChange={setIosOpen} /> : null}
    </>
  );
}
