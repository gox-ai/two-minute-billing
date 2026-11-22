"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { KeptInput } from "@/components/form/kept-input";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Chip } from "@/components/patterns/chip";
import { RowMenu } from "@/components/patterns/row-menu";
import { EmptyState } from "@/components/states";
import { SettingsCard } from "@/components/settings/settings-layout";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useDisplayTz } from "@/components/business-tz";
import { fmtDate } from "@/lib/format-date";
import { aboveText } from "@/lib/notifications-view";
import type { CatalogueEntry, NotificationDestination } from "@/lib/api/notifications";
import {
  addChatSpaceAction,
  addOutsideEmailAction,
  removeDestinationAction,
  resendConfirmationAction,
  testDestinationAction,
} from "@/app/(dashboard)/settings/notifications/actions";

type Biz = { id: string; name: string };

const PATH = "/settings/notifications";

/** "All businesses · 7 events · payments above ₹10,000 · daily summary" */
function summaryLine(d: NotificationDestination, businesses: Biz[], catalogue: CatalogueEntry[]) {
  const parts: string[] = [];
  if (d.business_filter.mode === "all") parts.push("All businesses");
  else {
    const ids = d.business_filter.business_ids;
    const names = ids.map((id) => businesses.find((b) => b.id === id)?.name ?? id);
    parts.push(names.length > 2 ? `${names.length} businesses` : names.join(", "));
  }
  const on = Object.entries(d.kinds).filter(([, k]) => k.on);
  if (on.length === 1) {
    const [kind, k] = on[0]!;
    const label = catalogue.find((c) => c.kind === kind)?.label ?? kind;
    const above = aboveText(k.above);
    parts.push(above === "Any amount" ? label : `${label} above ${above}`);
  } else if (on.length > 1) parts.push(`${on.length} events`);
  const summaries = [d.daily && "daily summary", d.weekly && "weekly summary"].filter(Boolean);
  if (summaries.length) parts.push(summaries.join(" and "));
  else if (on.length === 0) parts.push("no events selected");
  if (d.type === "chat" && d.hide_names) parts.push("customer names hidden");
  return parts.join(" · ");
}

function statusChip(d: NotificationDestination) {
  if (d.type === "chat")
    return d.status === "not_working" ? (
      <Chip tone="red">Not working</Chip>
    ) : (
      <Chip tone="green">Working</Chip>
    );
  return d.status === "pending" ? (
    <Chip>Waiting for confirmation</Chip>
  ) : (
    <Chip tone="green">Confirmed</Chip>
  );
}

/** Settings → Team notifications: two lists of card rows, each with its own Add dialog. */
export function TeamNotifications({
  destinations,
  businesses,
  catalogue,
}: {
  destinations: NotificationDestination[];
  businesses: Biz[];
  catalogue: CatalogueEntry[];
}) {
  const [dialog, setDialog] = React.useState<"chat" | "email" | null>(null);
  const spaces = destinations.filter((d) => d.type === "chat");
  const emails = destinations.filter((d) => d.type === "email");
  return (
    <>
      <SettingsCard
        id="google-chat"
        title="Google Chat spaces"
        meta="Messages to a space in your Google Chat"
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => setDialog("chat")}>
            <Plus aria-hidden />
            Add space
          </Button>
        }
      >
        {spaces.length === 0 ? (
          <EmptyState
            compact
            title="Add a Google Chat space"
            description="Send billing events to a space where your team works."
          />
        ) : (
          spaces.map((d) => (
            <DestinationRow key={d.id} d={d} businesses={businesses} catalogue={catalogue} />
          ))
        )}
      </SettingsCard>
      <SettingsCard
        id="outside-email"
        title="Outside email addresses"
        meta="People who are not members, such as your accountant"
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => setDialog("email")}>
            <Plus aria-hidden />
            Add address
          </Button>
        }
      >
        {emails.length === 0 ? (
          <EmptyState
            compact
            title="Add an outside email address"
            description="Members set their own notifications. Add an address only for a person outside the organization."
          />
        ) : (
          emails.map((d) => (
            <DestinationRow key={d.id} d={d} businesses={businesses} catalogue={catalogue} />
          ))
        )}
      </SettingsCard>
      <AddSpaceDialog
        open={dialog === "chat"}
        onOpenChange={(o) => setDialog(o ? "chat" : null)}
        businesses={businesses}
      />
      <AddAddressDialog
        open={dialog === "email"}
        onOpenChange={(o) => setDialog(o ? "email" : null)}
        businesses={businesses}
      />
    </>
  );
}

function DestinationRow({
  d,
  businesses,
  catalogue,
}: {
  d: NotificationDestination;
  businesses: Biz[];
  catalogue: CatalogueEntry[];
}) {
  const router = useRouter();
  const tz = useDisplayTz();
  const [confirm, setConfirm] = React.useState(false);
  const title = d.type === "chat" ? d.name : (d.email ?? d.name);
  const broken = d.type === "chat" && d.status === "not_working";
  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    const r = await fn();
    if (r.ok) toast.success(r.message);
    else toast.error(r.message);
    router.refresh();
  };
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-4">
      <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1">
        <Link
          href={`${PATH}/${d.id}`}
          className="text-sm font-medium wrap-anywhere text-foreground hover:underline"
        >
          {title}
        </Link>
        <p className="m-0 text-xs leading-normal text-muted-foreground">
          {broken && d.last_error ? d.last_error : summaryLine(d, businesses, catalogue)}
          {d.type === "email" && d.status === "pending"
            ? ` · confirmation sent ${fmtDate(d.created_at, tz)}`
            : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {statusChip(d)}
        {broken ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`${PATH}/${d.id}#webhook`}>Change webhook URL</Link>
          </Button>
        ) : null}
        <RowMenu
          label={title}
          groups={[
            { items: [{ label: "Edit", href: `${PATH}/${d.id}` }] },
            {
              items: [
                d.type === "chat"
                  ? {
                      label: "Send a test message",
                      onSelect: () => run(() => testDestinationAction(d.id)),
                    }
                  : d.status === "pending"
                    ? {
                        label: "Send the confirmation email again",
                        onSelect: () => run(() => resendConfirmationAction(d.id)),
                      }
                    : {
                        label: "Send a test email",
                        onSelect: () => run(() => testDestinationAction(d.id)),
                      },
              ],
            },
            { items: [{ label: "Remove", onSelect: () => setConfirm(true) }] },
          ]}
        />
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={d.type === "chat" ? "Remove this space?" : "Remove this address?"}
        description={`We stop sending notifications to ${title}. You can add it again later.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => run(() => removeDestinationAction(d.id))}
      />
    </div>
  );
}

const businessOptions = (businesses: Biz[]) => [
  { value: "", label: "All businesses" },
  ...businesses.map((b) => ({ value: b.id, label: b.name })),
];

function AddSpaceDialog({
  open,
  onOpenChange,
  businesses,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businesses: Biz[];
}) {
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add a Google Chat space</DialogTitle>
          <DialogDescription>
            In Google Chat, open the space, select Apps and integrations, then Webhooks. Name the
            webhook &quot;Two Minute Billing&quot; (Google Chat shows that name on each message),
            then copy its URL.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={addChatSpaceAction}
          className="flex min-h-0 flex-col gap-4"
          onSuccess={(r) => {
            onOpenChange(false);
            if (r.redirectTo) router.push(r.redirectTo);
          }}
        >
          <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6">
            <Field name="name" label="Name">
              <KeptInput name="name" placeholder="Billing team" maxLength={100} required />
            </Field>
            <Field
              name="url"
              label="Webhook URL"
              help="Starts with https://chat.googleapis.com/. We keep it secret and show only its end."
            >
              <KeptInput
                name="url"
                type="url"
                placeholder="https://chat.googleapis.com/v1/spaces/…"
                maxLength={2048}
                required
              />
            </Field>
            <Field name="business" label="Businesses">
              <SelectField name="business" options={businessOptions(businesses)} />
            </Field>
            <CheckboxField name="hide_names" label="Hide customer names and email addresses" />
            <p className="m-0 text-xs text-muted-foreground">
              You select the events after you add the space. We send a test message to the space
              first.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton>Send test and add</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function AddAddressDialog({
  open,
  onOpenChange,
  businesses,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businesses: Biz[];
}) {
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add an outside email address</DialogTitle>
          <DialogDescription>
            For a person who is not a member of the organization. Members set their own
            notifications.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={addOutsideEmailAction}
          className="flex flex-col gap-4"
          onSuccess={(r) => {
            onOpenChange(false);
            if (r.redirectTo) router.push(r.redirectTo);
          }}
        >
          <Field
            name="email"
            label="Email address"
            help="We email a confirmation link. We send nothing else until the address confirms."
          >
            <KeptInput
              name="email"
              type="email"
              placeholder="finance@example.com"
              maxLength={254}
              required
            />
          </Field>
          <Field name="business" label="Businesses">
            <SelectField name="business" options={businessOptions(businesses)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton>Add address</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
