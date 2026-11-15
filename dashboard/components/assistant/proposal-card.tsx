"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  CircleAlert,
  Coins,
  CreditCard,
  FileText,
  Gauge,
  Link2,
  Loader2,
  Mail,
  MapPin,
  MessageSquare,
  ReceiptText,
  Repeat,
  TicketPercent,
  TriangleAlert,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { SwitchField } from "@/components/ui/switch";
import { Chip } from "@/components/patterns/chip";
import { ASSISTANT_NAME } from "@/lib/assistant";
import { fmtDate, fmtDateTime } from "@/lib/format-date";
import type {
  ActionResult,
  AssistantProposal,
  ProposalLine,
  ProposalLineInput,
} from "@/lib/assistant";

/**
 * A change the assistant prepared. Nothing is sent until the member confirms; a money change
 * (tier 3) asks a second time and posts `confirm_money: true`. Back withdraws the proposal.
 */

const STATUS_TEXT: Record<string, string> = {
  confirmed: "Confirmed. The change is in progress.",
  running: "Confirmed. The change is in progress.",
  done: "Done.",
  failed: "The change did not complete.",
  cancelled: "You did not confirm this change. Nothing changed.",
  expired: "This proposal expired. Nothing changed. Ask again to prepare it again.",
};

/** The kind of record a change is about, by the last path segment that names one. */
const RECORD_ICON: Record<string, LucideIcon> = {
  customers: UserRound,
  contacts: UserRound,
  shipping_addresses: MapPin,
  coupons: TicketPercent,
  invoices: FileText,
  credit_notes: ReceiptText,
  subscriptions: Repeat,
  scheduled_changes: CalendarClock,
  payments: CreditCard,
  payment_requests: CreditCard,
  payment_links: Link2,
  collect_payment: CreditCard,
  emails: Mail,
  comments: MessageSquare,
  credit_grants: Coins,
  promotional_credits: Coins,
  wallet: Coins,
  auto_topup: Coins,
  record_excess_payment: Coins,
  spend_limits: Gauge,
  usage: Gauge,
  usages: Gauge,
  unbilled_charges: ReceiptText,
  charges: ReceiptText,
};
function recordIcon(operation: string): LucideIcon {
  const segs = operation.slice(operation.indexOf(" ") + 1).split("/");
  for (let i = segs.length - 1; i >= 0; i--) {
    const icon = RECORD_ICON[segs[i]!];
    if (icon) return icon;
  }
  return FileText;
}
function RecordIcon({ operation }: { operation: string }) {
  return React.createElement(recordIcon(operation), {
    className: "mt-0.5 size-4 shrink-0 text-muted-foreground",
    "aria-hidden": true,
  });
}

function Lines({ lines }: { lines: ProposalLine[] }) {
  if (!lines.length) return null;
  return (
    <dl className="m-0 flex flex-col gap-1 text-sm">
      {lines.map((l, i) =>
        l.before !== undefined ? (
          // A change: the label, then the value now → the new value.
          <div key={`${l.label}-${i}`} className="flex flex-col">
            <dt className="text-muted-foreground">{l.label}</dt>
            <dd className="m-0 wrap-break-word tabular-nums">
              <span className="text-muted-foreground">{l.before}</span>
              <span className="text-muted-foreground" aria-label="changes to">
                {" → "}
              </span>
              <span className="font-medium">{l.value}</span>
            </dd>
          </div>
        ) : (
          <div key={`${l.label}-${i}`} className="flex flex-wrap justify-between gap-x-3">
            <dt className="text-muted-foreground">{l.label}</dt>
            <dd className="m-0 text-right tabular-nums">{l.value}</dd>
          </div>
        ),
      )}
    </dl>
  );
}

type Draft = Record<string, string | boolean>;

/** One field's control: the value as the member types it (major units, a percent, local time). */
function FieldControl({
  id,
  label,
  input,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  input: ProposalLineInput;
  value: string | boolean;
  disabled: boolean;
  onChange: (v: string | boolean) => void;
}) {
  if (input.kind === "boolean") {
    const side = input.options?.find((o) => o.value === String(value === true))?.label;
    return (
      <div className="flex items-center gap-2">
        <SwitchField
          checked={value === true}
          onCheckedChange={onChange}
          disabled={disabled}
          ariaLabel={label}
        />
        {side ? <span className="text-sm">{side}</span> : null}
      </div>
    );
  }
  if (input.kind === "select")
    return (
      <SelectField
        id={id}
        size="sm"
        options={input.options ?? []}
        value={String(value)}
        onValueChange={onChange}
        disabled={disabled}
      />
    );
  const decimals = input.kind === "amount" ? (String(input.value).split(".")[1]?.length ?? 0) : 0;
  const field = (
    <Input
      id={id}
      className="h-8"
      disabled={disabled}
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
      {...(input.kind === "date"
        ? { type: "date" }
        : input.kind === "datetime"
          ? { type: "datetime-local" }
          : input.kind === "number" || input.kind === "amount"
            ? {
                type: "number",
                inputMode: "decimal" as const,
                step: input.kind === "amount" ? (decimals ? 10 ** -decimals : 1) : "any",
              }
            : { type: "text" })}
    />
  );
  const unit =
    input.kind === "amount" ? input.currency?.toUpperCase() : input.unit === "bps" ? "%" : null;
  return unit ? (
    <div className="flex items-center gap-2">
      {field}
      <span className="text-sm text-muted-foreground">{unit}</span>
    </div>
  ) : (
    field
  );
}

/** The card's fields as controls: lines with a `key` can change, the rest stay as text. */
function EditLines({
  id,
  lines,
  draft,
  disabled,
  onChange,
}: {
  id: string;
  lines: ProposalLine[];
  draft: Draft;
  disabled: boolean;
  onChange: (key: string, v: string | boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {lines.map((l, i) =>
        l.key && l.input ? (
          <div key={`${l.key}-${i}`} className="flex flex-col gap-1">
            <label htmlFor={`${id}-${l.key}`} className="text-muted-foreground">
              {l.label}
            </label>
            <FieldControl
              id={`${id}-${l.key}`}
              label={l.label}
              input={l.input}
              value={draft[l.key] ?? l.input.value}
              disabled={disabled}
              onChange={(v) => onChange(l.key!, v)}
            />
          </div>
        ) : (
          <Lines key={`${l.label}-${i}`} lines={[l]} />
        ),
      )}
    </div>
  );
}

/** Emails are designed on white; links in a preview are shown, not followed. */
const INERT_EMAIL =
  "<style>html{background:#fff;color-scheme:light}a{pointer-events:none;cursor:default}</style>";

/** The email word for word, so the member approves what the customer will read. */
function EmailPreview({
  e,
  tz,
}: {
  e: NonNullable<AssistantProposal["email"]>;
  tz?: string | null;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-2.5 text-sm">
      <dl className="m-0 flex flex-col gap-1">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">To</dt>
          <dd className="m-0 min-w-0 break-all">
            {e.to}
            {e.cc.length ? (
              <span className="text-muted-foreground"> · copy to {e.cc.join(", ")}</span>
            ) : null}
          </dd>
        </div>
        {e.sent_at ? (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">First sent</dt>
            <dd className="m-0">{fmtDate(e.sent_at, tz)}</dd>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">Subject</dt>
          <dd className="m-0 min-w-0 font-medium">{e.subject}</dd>
        </div>
      </dl>
      {e.removed ? (
        <p className="m-0 text-muted-foreground">
          We deleted the text of this email after its retention period. Only the subject is kept.
        </p>
      ) : e.html ? (
        // The email as the customer sees it, button included. No scripts; links do nothing here.
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={INERT_EMAIL + e.html}
          className="h-96 w-full rounded-md border"
        />
      ) : (
        <div className="max-h-64 overflow-y-auto rounded-md border bg-card px-2.5 py-2 text-sm whitespace-pre-wrap">
          {e.text.trim()}
        </div>
      )}
    </div>
  );
}

async function post(path: string, body?: unknown): Promise<{ ok: boolean; json: any }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { ok: res.ok, json: await res.json().catch(() => ({})) };
}

/** A portal link, shown once: it is not stored, so it is gone after the page reloads. */
function ShareLink({
  share,
  tz,
}: {
  share: NonNullable<ActionResult["share"]>;
  tz?: string | null;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Input
          readOnly
          value={share.url}
          aria-label="Portal link"
          onFocus={(e) => e.target.select()}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(share.url).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        This link works one time
        {share.expires_at ? `. It stops working on ${fmtDateTime(share.expires_at, tz)}` : ""}.
      </p>
    </div>
  );
}

export function ProposalCard({ p: initial, tz }: { p: AssistantProposal; tz?: string | null }) {
  const router = useRouter();
  // The card as last saved: an edit returns it built again from the changed request.
  const [p, setP] = useDefaultState(initial, (v) => JSON.stringify(v));
  const [status, setStatus] = useDefaultState(initial.status);
  const [email, setEmail] = useDefaultState(p.email, (e) => JSON.stringify(e ?? null));
  const [note, setNote] = useDefaultState(p.email?.note ?? "");
  const [saving, setSaving] = React.useState(false);
  const seq = React.useRef(0);
  const [step, setStep] = React.useState<"review" | "money">("review");
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = useDefaultState<ActionResult | null>(
    p.result ? { status: p.status === "done" ? "done" : "failed", ...p.result } : null,
    (r) => JSON.stringify(r),
  );
  const [error, setError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  // Edit mode: the member corrects the fields the card offers, then saves before Confirm.
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>({});
  const [savingEdit, setSavingEdit] = React.useState(false);
  const [editError, setEditError] = React.useState<string | null>(null);

  // An open proposal expires on the server after 15 minutes; show it here too.
  React.useEffect(() => {
    if (status !== "proposed") return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [status]);
  const expired = status === "proposed" && new Date(p.expires_at).getTime() <= now;
  const shown = expired ? "expired" : status;
  const live = p.livemode === true || p.livemode === "live";
  // A create or update with no field has nothing to review: no Confirm. Old cards have no kind.
  const empty =
    p.kind === "create" || p.kind === "update"
      ? !p.fields
      : !p.kind && !p.lines.length && !p.preview_lines.length && !p.email;
  // A new email: the member may change Billy's note; the email is rendered again after a pause.
  const editable = p.operation === "POST emails/send" && shown === "proposed";
  const dirty = editable && note.trim() !== (email?.note ?? "").trim();
  React.useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(async () => {
      const mine = ++seq.current;
      setSaving(true);
      setError(null);
      try {
        const r = await post(`/api/assistant/actions/${encodeURIComponent(p.id)}/edit`, { note });
        if (mine !== seq.current) return;
        if (!r.ok) setError(r.json?.error?.message ?? "We could not update the email. Try again.");
        else setEmail(r.json.email);
      } catch {
        if (mine === seq.current) setError("We could not reach the server. Try again.");
      } finally {
        if (mine === seq.current) setSaving(false);
      }
    }, 700);
    return () => clearTimeout(t);
  }, [dirty, note, p.id]);

  const changeable = p.lines.some((l) => l.key && l.input);
  const startEdit = () => {
    setDraft({});
    setEditError(null);
    setEditing(true);
  };
  const stopEdit = () => {
    setEditing(false);
    setDraft({});
    setEditError(null);
  };
  const saveEdit = async () => {
    const fields = Object.fromEntries(
      Object.entries(draft).filter(
        ([k, v]) => p.lines.find((l) => l.key === k)?.input?.value !== v,
      ),
    );
    if (!Object.keys(fields).length) return stopEdit();
    setSavingEdit(true);
    setEditError(null);
    try {
      const r = await post(`/api/assistant/actions/${encodeURIComponent(p.id)}/edit`, { fields });
      if (!r.ok) {
        setEditError(r.json?.error?.message ?? "We could not save your changes. Try again.");
        return;
      }
      const { object: _o, ...view } = r.json as AssistantProposal & { object?: string };
      setP(view);
      setEmail(view.email);
      stopEdit();
    } catch {
      setEditError("We could not reach the server. Try again.");
    } finally {
      setSavingEdit(false);
    }
  };

  const confirm = async (money: boolean) => {
    setPending(true);
    setError(null);
    try {
      const r = await post(
        `/api/assistant/actions/${encodeURIComponent(p.id)}/confirm`,
        money ? { confirm_money: true } : {},
      );
      if (!r.ok) {
        setError(
          r.json?.error?.message ?? "We could not make the change. Nothing changed. Try again.",
        );
        return;
      }
      // The answer is the action's view: its status, and `result` once it ran.
      const j = r.json as {
        status?: AssistantProposal["status"];
        message?: string;
        link?: string | null;
        result?: { message: string; link: string | null } | null;
        share?: ActionResult["share"];
      };
      const next = j.status ?? "failed";
      const message = j.result?.message ?? j.message;
      if (message) {
        setResult({
          status: next === "done" ? "done" : "failed",
          message,
          link: j.result?.link ?? j.link ?? null,
          share: j.share ?? null,
        });
      }
      setStatus(next);
      // The page behind the panel shows the record that just changed: read it again.
      if (next === "done") router.refresh();
    } catch {
      setError("We could not reach the server. Nothing changed. Try again.");
    } finally {
      setPending(false);
    }
  };

  const back = async () => {
    if (step === "money") return setStep("review");
    setPending(true);
    setError(null);
    try {
      const r = await post(`/api/assistant/actions/${encodeURIComponent(p.id)}/cancel`);
      if (r.ok) setStatus("cancelled");
      else setError(r.json?.error?.message ?? "We could not withdraw the proposal. Try again.");
    } catch {
      setError("We could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-card p-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <RecordIcon operation={p.operation} />
          <h3 className="m-0 flex-1 text-base font-semibold">{p.title}</h3>
          <Chip tone={live ? "tan" : "gray"}>{live ? "Live" : "Test"}</Chip>
        </div>
        {live && shown === "proposed" ? (
          <p className="m-0 flex items-center gap-1.5 text-xs text-warning">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            This changes your live business.
          </p>
        ) : null}
      </div>
      {p.sentence ? <p className="m-0 text-sm">{p.sentence}</p> : null}
      {editing ? (
        <div className="flex flex-col gap-2.5 rounded-md border p-2.5">
          <EditLines
            id={`edit-${p.id}`}
            lines={p.lines}
            draft={draft}
            disabled={savingEdit}
            onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
          />
          <p className="m-0 text-xs text-muted-foreground">
            We check the change again when you save. The preview then shows your changes.
          </p>
          {editError ? <Alert tone="error" title={editError} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={savingEdit} onClick={() => void saveEdit()}>
              {savingEdit ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              Save changes
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={savingEdit}
              onClick={stopEdit}
            >
              Discard changes
            </Button>
          </div>
        </div>
      ) : (
        <Lines lines={p.lines} />
      )}
      {shown === "proposed" && step === "review" && changeable && !editing && !empty ? (
        <Button
          type="button"
          size="sm"
          variant="link"
          className="h-auto self-start p-0"
          disabled={pending || saving}
          onClick={startEdit}
        >
          Edit
        </Button>
      ) : null}
      {editable ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`note-${p.id}`} className="text-sm font-medium">
            Note to the customer
          </label>
          <Textarea
            id={`note-${p.id}`}
            value={note}
            maxLength={2000}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
            {saving || dirty ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> Updating the email
              </>
            ) : (
              `${ASSISTANT_NAME} wrote this note. You can change it. The email below shows your change.`
            )}
          </p>
        </div>
      ) : null}
      {email ? <EmailPreview e={email} tz={tz} /> : null}
      {p.preview_lines.length ? (
        <div className="flex flex-col gap-1 rounded-md bg-muted/50 px-2.5 py-2">
          <p className="m-0 text-xs font-medium text-muted-foreground">Preview</p>
          <Lines lines={p.preview_lines} />
        </div>
      ) : null}

      {shown === "proposed" && empty ? (
        <div className="flex flex-col gap-2">
          <Alert
            tone="warning"
            title={`${ASSISTANT_NAME} did not include any details. Ask again with the details.`}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={back}>
              Back
            </Button>
          </div>
        </div>
      ) : shown === "proposed" ? (
        step === "review" ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              // Confirm sends what the card shows: wait for the email to catch up with the note.
              disabled={pending || saving || dirty || editing || savingEdit}
              onClick={() => (p.tier === 3 ? setStep("money") : void confirm(false))}
            >
              {p.tier === 3 ? "Continue" : "Confirm"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={back}>
              Back
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5 rounded-md border border-destructive/30 bg-destructive-soft p-2.5">
            <p className="m-0 flex items-start gap-1.5 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {p.money ? `${p.money} ` : "This change moves money. "}You cannot undo this.
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => void confirm(true)}
              >
                Confirm
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={back}>
                Back
              </Button>
            </div>
          </div>
        )
      ) : (
        <p className="m-0 text-sm text-muted-foreground">
          {result?.message ?? STATUS_TEXT[shown] ?? ""}{" "}
          {result?.link && result.link.startsWith("/") && !result.link.startsWith("//") ? (
            <Link href={result.link} className="text-primary hover:underline">
              View the record
            </Link>
          ) : null}
        </p>
      )}
      {result?.share ? <ShareLink share={result.share} tz={tz} /> : null}
      {error ? <Alert tone="error" title={error} /> : null}
    </div>
  );
}
