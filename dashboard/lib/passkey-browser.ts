import { useSyncExternalStore } from "react";
import { WebAuthnError, browserSupportsWebAuthn } from "@simplewebauthn/browser";

/**
 * What went wrong in the BROWSER half of a passkey ceremony, as the copy names it. Client-only:
 * imported by the passkey components, never by a server module.
 */
export type PasskeyFailure =
  | "duplicate" // this device already holds a passkey for the account
  | "no_user_verification" // no screen lock, so the device can't check it's you
  | "unsupported" // no WebAuthn in this browser
  | "cancelled" // the browser window was closed or timed out
  | "failed";

export function classifyPasskeyError(e: unknown): PasskeyFailure {
  const code = e instanceof WebAuthnError ? e.code : undefined;
  const name = (e as { name?: string } | null)?.name;
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError")
    return "duplicate";
  if (
    code === "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT" ||
    code === "ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE"
  )
    return "no_user_verification";
  if (name === "NotSupportedError" || code === "ERROR_MALFORMED_PUBKEYCREDPARAMS")
    return "unsupported";
  // NotAllowedError is the browser's answer to a closed window, a timeout, and a refusal alike.
  if (name === "NotAllowedError" || name === "AbortError" || code === "ERROR_CEREMONY_ABORTED")
    return "cancelled";
  return "failed";
}

/** Title and line for a failed "Add a passkey". */
export const CREATE_FAILURE: Record<PasskeyFailure, { title: string; line: string }> = {
  duplicate: {
    title: "This device already has a passkey for your account",
    line: "Use a different device or password manager. Or use the authenticator app.",
  },
  no_user_verification: {
    title: "This device cannot verify your identity",
    line: "Enable a screen lock (fingerprint, face or PIN) and try again. Or save the passkey on your phone.",
  },
  unsupported: {
    title: "This browser cannot make passkeys",
    line: "You can add a passkey later from your phone or a different browser. Or use the authenticator app.",
  },
  cancelled: {
    title: "The browser did not make the passkey",
    line: "The browser window closed before the step was complete. Try again. Or save the passkey on your phone or in a password manager.",
  },
  failed: {
    title: "The browser did not make the passkey",
    line: "An error occurred in the browser. Try again. Or save the passkey on your phone or in a password manager.",
  },
};

/** "MacBook Pro or Pixel 8", "A, B or C". */
export function passkeyNamesPhrase(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

const noSubscribe = () => () => {};

/** Whether this browser can run a passkey ceremony. Null during server render (unknown). */
export function useWebAuthnSupport(): boolean | null {
  return useSyncExternalStore(noSubscribe, browserSupportsWebAuthn, () => null);
}
