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
  } else if (state.code === "conflict") {
    toast.error(state.message ?? "This record changed since you loaded it", {
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

const fieldLabel = (name: string) => {
  const t = name.replace(/[._]/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const FormErrorsContext = React.createContext<Record<string, string>>({});
export const useFieldError = (name: string): string | undefined =>
  React.useContext(FormErrorsContext)[name];

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
  formRef: externalFormRef,
}: {
  action: FormAction;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  /** Receives the result, so a create can land on `result.redirectTo`. */
  onSuccess?: (result: ActionResult) => void;
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
  const withToast = async (prev: ActionResult | null, formData: FormData) => {
    const result = await action(prev, formData);
    notify(result, formRef.current, router.push);
    return result;
  };
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
    }
  }, [state, resetOnSuccess, router, onSuccess]);

  return (
    <FormErrorsContext.Provider value={state?.ok === false ? (state.errors ?? {}) : {}}>
      <form ref={formRef} action={formAction} className={cn(className)}>
        {children}
      </form>
    </FormErrorsContext.Provider>
  );
}
