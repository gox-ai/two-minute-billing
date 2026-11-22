"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { SecretDialog, revealOf } from "@/components/developer/secret-action";
import { KeyAccessFields } from "@/components/developer/key-access";
import { LIMITS } from "@/lib/limits";
import type { KeyGrantOptions } from "@/lib/roles";
import type { ActionResult } from "@/lib/action-result";
import type { SecretActionResult } from "@/app/actions";

type SecretAction = (prev: ActionResult | null, formData: FormData) => Promise<SecretActionResult>;
type Reveal = NonNullable<SecretActionResult["reveal"]>;

/**
 * A create form in a dialog whose action returns a one-time secret. The reveal lives
 * OUTSIDE the form dialog, which unmounts its content when it closes.
 */
function CreateWithSecret({
  trigger,
  title,
  description,
  submit,
  size,
  action,
  children,
}: {
  trigger: string;
  title: string;
  description: string;
  submit: string;
  size: "md" | "lg";
  action: SecretAction;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [reveal, setReveal] = React.useState<Reveal | null>(null);
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button>{trigger}</Button>
        </DialogTrigger>
        <DialogContent size={size} className="flex max-h-[85vh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <ActionForm
            action={action}
            className="flex min-h-0 flex-col gap-4"
            onSuccess={(r) => {
              setOpen(false);
              setReveal(revealOf(r));
            }}
          >
            <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-1">
              {children}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>{submit}</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
      <SecretDialog reveal={reveal} onClose={() => setReveal(null)} />
    </>
  );
}

/** Create API key: name, mode, expiry and access. Posts to `createApiKeyAction`. */
export function CreateApiKeyDialog({
  grant,
  action,
}: {
  grant: KeyGrantOptions;
  action: SecretAction;
}) {
  return (
    <CreateWithSecret
      trigger="Create API key"
      title="Create API key"
      description="The secret shows one time, after you create the key."
      submit="Create API key"
      size="lg"
      action={action}
    >
      {/* An unnamed key is legal; both selects carry the default the server would apply. */}
      <Field name="name" label="Name" help="Optional.">
        <Input name="name" maxLength={LIMITS.name} placeholder="Production server" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="livemode" label="Mode">
          <SelectField
            name="livemode"
            defaultValue="test"
            ariaLabel="Mode"
            className="w-full"
            options={[
              { value: "test", label: "Test" },
              { value: "live", label: "Live" },
            ]}
          />
        </Field>
        {/* Expiry (0374). "Never" is what the API applies when none is sent. */}
        <Field name="expires_in_days" label="Expiry">
          <SelectField
            name="expires_in_days"
            defaultValue="never"
            ariaLabel="Expiry"
            className="w-full"
            options={[
              { value: "never", label: "Never expires" },
              { value: "30", label: "Expires in 30 days" },
              { value: "90", label: "Expires in 90 days" },
              { value: "365", label: "Expires in 1 year" },
            ]}
          />
        </Field>
      </div>
      {/* Access (0391): full, read only, or per resource. Options above the member's own
          rights are disabled; full is preselected when the member may grant it. */}
      <KeyAccessFields grant={grant} />
    </CreateWithSecret>
  );
}

/** Create endpoint: URL, name, scope and mode. Posts to `createWebhookEndpoint`. */
export function CreateEndpointDialog({
  businesses,
  action,
}: {
  businesses: EndpointBusiness[];
  action: SecretAction;
}) {
  return (
    <CreateWithSecret
      trigger="Create endpoint"
      title="Create endpoint"
      description="The signing secret shows one time, after you create the endpoint."
      submit="Create endpoint"
      size="md"
      action={action}
    >
      <Field name="url" label="Endpoint URL">
        <Input
          name="url"
          type="url"
          placeholder="https://your-app.com/webhooks/tmbilling"
          required
        />
      </Field>
      {/* Posts to `description`, the real column; it heads the endpoint's delivery cards. */}
      <Field name="description" label="Name" help="Optional.">
        <Input name="description" type="text" placeholder="Analytics sync" />
      </Field>
      <EndpointScopeFields businesses={businesses} />
    </CreateWithSecret>
  );
}

type EndpointBusiness = { id: string; name: string; livemode: "live" | "test" };

/**
 * Mode, then scope. A live business and its test mode share a name, so the scope lists only
 * the selected mode's businesses, and changing the mode clears a business that is not in it.
 * The state lives here, inside the dialog content, so closing the dialog resets it.
 */
function EndpointScopeFields({ businesses }: { businesses: EndpointBusiness[] }) {
  const [mode, setMode] = React.useState<"test" | "live">("test");
  const [scope, setScope] = React.useState("");
  const inMode = businesses.filter((b) => b.livemode === mode);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {/* Required for an all-businesses endpoint made with this dashboard's credential.
          For one business it is derived (a contradicting value is a 400), and the action
          forwards it only when the scope is all businesses. */}
      <Field name="livemode" label="Mode">
        <SelectField
          name="livemode"
          ariaLabel="Mode"
          className="w-full"
          value={mode}
          onValueChange={(v) => {
            const next = v === "live" ? "live" : "test";
            setMode(next);
            if (scope && !businesses.some((b) => b.id === scope && b.livemode === next)) {
              setScope("");
            }
          }}
          options={[
            { value: "test", label: "Test" },
            { value: "live", label: "Live" },
          ]}
        />
      </Field>
      <Field name="business" label="Scope">
        <SelectField
          name="business"
          ariaLabel="Business scope"
          className="w-full"
          value={scope}
          onValueChange={setScope}
          options={[
            { value: "", label: mode === "live" ? "All live businesses" : "All test businesses" },
            ...inMode.map((b) => ({ value: b.id, label: `${b.name} only` })),
          ]}
        />
      </Field>
    </div>
  );
}
