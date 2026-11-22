"use client";

import * as React from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/utils";

type FormAction = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/** Whether the field an error names is on screen: its control, or a primitive's trigger (`id = name`). */
function isVisibleField(form: HTMLFormElement | null, name: string): boolean {
  if (!form) return false;
  const candidates = [
    ...form.querySelectorAll<HTMLElement>(`[name="${CSS.escape(name)}"]`),
    ...form.querySelectorAll<HTMLElement>(`#${CSS.escape(name)}`),
  ];
  return candidates.some(
    (el) =>
      !(el instanceof HTMLInputElement && el.type === "hidden") && el.getClientRects().length > 0,
  );
}

/** "View request" on an error toast when the engine logged the failed write. */
const viewRequest = (state: ActionResult, go: (href: string) => void) =>
  state.requestId
    ? { action: { label: "View request", onClick: () => go(`/developer/logs/${state.requestId}`) } }
    : {};

function notify(state: ActionResult, form: HTMLFormElement | null, go: (href: string) => void) {
  if (state.ok) {
    if (state.message) (state.warning ? toast.warning : toast.success)(state.message);
  } else if (state.code === "possible_duplicate") {
    // The dialog shows this one inline, with a "Refund again" button.
  } else if (state.code === "conflict") {
    // Our words, never the engine's ("resource_version mismatch: expected 1, found 2").
    toast.error("We could not save the changes. Someone changed this page after you opened it.", {
      description: "Reload to see the current values, then make your changes again.",
      action: { label: "Reload", onClick: () => window.location.reload() },
      duration: 8000,
    });
  } else {
    // An error on a field nobody can see (a hidden input, a control without a <Field>)
    // cannot be "highlighted" — name it in the toast instead.
    const unseen = Object.entries(state.errors ?? {}).filter(
      ([name]) => !isVisibleField(form, name),
    );
    if (unseen.length)
      toast.error(
        unseen.length === Object.keys(state.errors ?? {}).length
          ? "We could not save the changes."
          : (state.message ?? "We could not save the changes."),
        {
          description: unseen.map(([name, msg]) => `${fieldLabel(name)}: ${msg}`).join(" · "),
          ...viewRequest(state, go),
        },
      );
    else if (state.message) toast.error(state.message, viewRequest(state, go));
  }
}

/**
 * `data-save-outcome` on the form: "refused" while React resets it after a failed save.
 * React resets after EVERY action that returns, so without this a refused save threw the
 * person's edits away and the form looked as if nothing had changed.
 */
export const SAVE_OUTCOME = "saveOutcome";

const TYPED = new Set([
  "text",
  "email",
  "url",
  "tel",
  "search",
  "number",
  "date",
  "datetime-local",
  "time",
  "month",
]);

/** Puts typed text back after a refused save's reset. Never a password. */
function restoreTyped(form: HTMLFormElement, data: FormData) {
  const seen = new Map<string, number>();
  for (const el of Array.from(form.elements)) {
    const typed =
      el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TYPED.has(el.type));
    if (!typed || !el.name || el.disabled) continue;
    const i = seen.get(el.name) ?? 0;
    seen.set(el.name, i + 1);
    const value = data.getAll(el.name)[i];
    if (typeof value !== "string" || el.value === value) continue;
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

const fieldLabel = (name: string) => {
  const t = name.replace(/[._]/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const FormErrorsContext = React.createContext<Record<string, string>>({});
export const useFieldError = (name: string): string | undefined =>
  React.useContext(FormErrorsContext)[name];

const NO_VALUES: Record<string, string> = {};
const FormValuesContext = React.createContext<Record<string, string>>(NO_VALUES);
/** The value a failed submit sent back for `name` (`ActionResult.values`). */
export const useKeptValue = (name: string): string | undefined =>
  React.useContext(FormValuesContext)[name];

/**
 * Form wired to a server action returning ActionResult: toasts success/error
 * (a 409 conflict gets a Reload action — CP-0), exposes field errors to
 * <Field>, refreshes server components on success, optionally resets.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  onSuccess,
  onRefused,
  formRef: externalFormRef,
}: {
  action: FormAction;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  /** Receives the result, so a create can land on `result.redirectTo`. */
  onSuccess?: (result: ActionResult) => void;
  /** Receives a refused result (`ok: false`), once per submission. */
  onRefused?: (result: ActionResult) => void;
  /**
   * Supply your own ref when a caller needs to `requestSubmit()` the form from
   * outside it (e.g. a confirm dialog's "Proceed" button) — ActionForm keeps
   * its own ref internally otherwise.
   */
  formRef?: React.RefObject<HTMLFormElement | null>;
}) {
  const router = useRouter();
  const internalFormRef = React.useRef<HTMLFormElement>(null);
  const formRef = externalFormRef ?? internalFormRef;
  // Toast as soon as the action returns, not from an effect: the action's own refresh
  // can unmount this form (a cancel removes the control that opened its dialog), and an
  // effect on an unmounted form never runs, so the result vanished silently.
  const refused = React.useRef<FormData | null>(null);
  const withToast = async (prev: ActionResult | null, formData: FormData) => {
    const result = await action(prev, formData);
    // Read by the reset that React runs after this action (see `SAVE_OUTCOME`).
    const form = formRef.current;
    if (form) form.dataset[SAVE_OUTCOME] = result.ok ? "saved" : "refused";
    refused.current = result.ok ? null : formData;
    notify(result, formRef.current, router.push);
    return result;
  };
  React.useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const onReset = () => {
      const data = form.dataset[SAVE_OUTCOME] === "refused" ? refused.current : null;
      if (data) queueMicrotask(() => restoreTyped(form, data));
      // After every control's microtask: a later reset (resetOnSuccess, a Reset button)
      // is not a refusal.
      setTimeout(() => delete form.dataset[SAVE_OUTCOME], 0);
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [formRef]);
  const [state, formAction] = useActionState<ActionResult | null, FormData>(withToast, null);
  // Run the success follow-ups once per submission, even with an identical result object.
  const seen = React.useRef<ActionResult | null>(null);

  React.useEffect(() => {
    if (!state || state === seen.current) return;
    seen.current = state;
    if (state.ok) {
      if (resetOnSuccess) formRef.current?.reset();
      router.refresh();
      onSuccess?.(state);
    } else {
      onRefused?.(state);
    }
  }, [state, resetOnSuccess, router, onSuccess, onRefused]);

  return (
    <FormErrorsContext.Provider value={state?.ok === false ? (state.errors ?? {}) : {}}>
      <FormValuesContext.Provider
        value={state?.ok === false ? (state.values ?? NO_VALUES) : NO_VALUES}
      >
        <form ref={formRef} action={formAction} className={cn(className)}>
          {children}
        </form>
      </FormValuesContext.Provider>
    </FormErrorsContext.Provider>
  );
}
