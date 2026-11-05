"use client";

import * as React from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  MonitorIcon,
  SmartphoneIcon,
  TextIcon,
} from "lucide-react";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { SwitchField } from "@/components/ui/switch";
import { useIsClient } from "@/components/safe-html";
import { sanitizeHtmlDocument } from "@/lib/sanitize-html";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useDefaultState } from "@/lib/use-default-state";
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/settings-layout";
import { RichBodyEditor, type RichBodyHandle, tokenLabel } from "./rich-body-editor";

type BlockKey = "body" | "action" | "facts" | "footer";
type FieldKey = "subject" | "heading" | "body" | "footer" | "cta_label";

/** Mirrors EmailTemplate in lib/api/emails.ts — declared locally to keep that
 *  server-only module out of this client bundle (see the note in emails-table.tsx). */
export interface TemplateEditorTemplate {
  type: string;
  subject: string;
  heading: string;
  body: string;
  footer: string | null;
  cta_label: string | null;
  show_facts: boolean;
  block_order: BlockKey[];
  default_cta_label: string | null;
  has_facts: boolean;
  default_footer: string;
  built_in: { subject: string; heading: string; body: string };
  customized: boolean;
  inherits_from: string | null;
  updated_at: string | null;
  variables: Array<{ key: string; label: string; always: boolean; sample: string | null }>;
  attachments: AttachmentsView | null;
}

interface AttachmentsView {
  document: "invoice" | "credit_note";
  pdf: boolean;
  skip_zero_pdf: boolean;
  skip_zero_send: boolean;
  can_skip_zero_pdf: boolean;
  can_skip_zero_send: boolean;
}

type AttachmentRule = { pdf: boolean; skipZeroPdf: boolean; skipZeroSend: boolean };
type AttachmentAction = (biz: string, type: string, rule: AttachmentRule) => Promise<unknown>;

interface Issue {
  field: FieldKey;
  severity: "error" | "warning";
  message: string;
}

interface Preview {
  subject: string;
  html: string;
  text: string;
  issues: Issue[];
}

type Action = (prev: unknown, fd: FormData) => Promise<unknown>;

/** Engine-rendered, so the delay only has to cover typing, not rendering. */
const PREVIEW_DEBOUNCE_MS = 250;

export function TemplateEditor({
  biz,
  label,
  template,
  initialPreview,
  userEmail,
  saveAction,
  testAction,
  attachmentAction,
}: {
  biz: string;
  label: string;
  template: TemplateEditorTemplate;
  /** Rendered on the server from what is currently in effect, so the pane is never empty. */
  initialPreview: Preview | null;
  userEmail: string;
  saveAction: Action;
  testAction: Action;
  attachmentAction: AttachmentAction;
}) {
  // Re-seeded whenever the stored template changes (a save or a reset), never mid-edit.
  const version = `${template.customized}:${template.updated_at}`;
  const seedBy = () => version;
  const [subject, setSubject] = useDefaultState(template.subject, seedBy);
  const [heading, setHeading] = useDefaultState(template.heading, seedBy);
  const [body, setBody] = useDefaultState(template.body, seedBy);
  const [footer, setFooter] = useDefaultState(template.footer ?? "", seedBy);
  const [ctaLabel, setCtaLabel] = useDefaultState(template.cta_label ?? "", seedBy);
  const [showFacts, setShowFacts] = useDefaultState(template.show_facts, seedBy);
  const [order, setOrder] = useDefaultState(template.block_order, seedBy);
  const [bodySeed, setBodySeed] = React.useState(0);
  const [seenVersion, setSeenVersion] = React.useState(version);
  if (seenVersion !== version) {
    setSeenVersion(version);
    setBodySeed((n) => n + 1);
  }

  const [mode, setMode] = React.useState<"visual" | "html">("visual");
  // Reset loads the built-in wording and layout as an unsaved DRAFT; nothing is written
  // until Save. Saving it untouched removes the override on the server (see upsertTemplate).
  const atBuiltIn =
    subject === template.built_in.subject &&
    heading === template.built_in.heading &&
    body === template.built_in.body &&
    !footer.trim() &&
    !ctaLabel.trim() &&
    showFacts &&
    order.join() === "body,action,facts,footer";
  function loadDefault() {
    setSubject(template.built_in.subject);
    setHeading(template.built_in.heading);
    setBody(template.built_in.body);
    setFooter("");
    setCtaLabel("");
    setShowFacts(true);
    setOrder(["body", "action", "facts", "footer"]);
    setBodySeed((n) => n + 1);
  }

  const hasAction = template.default_cta_label !== null;

  const draft = React.useMemo(
    () => ({
      subject,
      heading,
      body,
      footer: footer.trim() || null,
      ...(hasAction ? { cta_label: ctaLabel.trim() || null } : {}),
      ...(template.has_facts ? { show_facts: showFacts } : {}),
      block_order: order,
    }),
    [subject, heading, body, footer, ctaLabel, showFacts, order, hasAction, template.has_facts],
  );

  const dirty =
    subject !== template.subject ||
    heading !== template.heading ||
    body !== template.body ||
    (footer.trim() || null) !== (template.footer ?? null) ||
    (hasAction && (ctaLabel.trim() || null) !== template.cta_label) ||
    (template.has_facts && showFacts !== template.show_facts) ||
    order.join() !== template.block_order.join();

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const {
    preview,
    pending,
    error: previewError,
  } = useLivePreview(biz, template.type, draft, initialPreview);
  const issues = preview?.issues ?? [];
  const errors = issues.filter((i) => i.severity === "error");
  const fieldIssues = (f: FieldKey) => issues.filter((i) => i.field === f);

  // ── inserting variables into whichever field was last focused ──────────────────
  const focused = React.useRef<FieldKey>("body");
  const bodyRef = React.useRef<RichBodyHandle>(null);
  const htmlRef = React.useRef<HTMLTextAreaElement>(null);
  const footerRef = React.useRef<RichBodyHandle>(null);
  const footerHtmlRef = React.useRef<HTMLTextAreaElement>(null);
  const subjectRef = React.useRef<HTMLInputElement>(null);
  const headingRef = React.useRef<HTMLInputElement>(null);
  const ctaRef = React.useRef<HTMLInputElement>(null);
  const setters: Record<Exclude<FieldKey, "body" | "footer">, (v: string) => void> = {
    subject: setSubject,
    heading: setHeading,
    cta_label: setCtaLabel,
  };

  function spliceInto(
    el: HTMLInputElement | HTMLTextAreaElement | null,
    current: string,
    set: (v: string) => void,
    before: string,
    after = "",
  ) {
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    set(current.slice(0, start) + before + current.slice(start, end) + after + current.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      const at = end + before.length + after.length;
      el?.setSelectionRange(at, at);
    });
  }

  function insert(open: string, close?: string) {
    const f = focused.current;
    if (f === "body" || f === "footer") {
      const rich = (f === "body" ? bodyRef : footerRef).current;
      if (mode === "visual") {
        if (close) rich?.wrapSection(open, close);
        else rich?.insertToken(open);
      } else if (f === "body") spliceInto(htmlRef.current, body, setBody, open, close);
      else spliceInto(footerHtmlRef.current, footer, setFooter, open, close);
      return;
    }
    const value = f === "subject" ? subject : f === "heading" ? heading : ctaLabel;
    spliceInto(
      (f === "subject" ? subjectRef : f === "heading" ? headingRef : ctaRef).current,
      value,
      setters[f],
      open,
      close,
    );
  }

  const labels = React.useMemo(
    () => Object.fromEntries(template.variables.map((v) => [v.key, v.label])),
    [template.variables],
  );
  const [fallbackFor, setFallbackFor] = React.useState<string | null>(null);

  const statusMeta = template.inherits_from
    ? "Using your Invoice issued wording"
    : template.customized
      ? "Customised for this business"
      : "Built-in";

  const modeToggle = (
    <div className="flex rounded-md border p-0.5" role="group" aria-label="Editor mode">
      {(["visual", "html"] as const).map((m) => (
        <Button
          key={m}
          type="button"
          size="xs"
          variant="ghost"
          aria-pressed={mode === m}
          className={cn("touch-target relative", mode === m && "bg-accent text-accent-foreground")}
          onClick={() => {
            if (m === mode) return;
            if (m === "visual") setBodySeed((n) => n + 1);
            setMode(m);
          }}
        >
          {m === "visual" ? "Visual" : "HTML"}
        </Button>
      ))}
    </div>
  );

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <SettingsCard title="Content" meta={statusMeta} actions={modeToggle}>
          {template.inherits_from ? (
            <Note>
              This email uses your customized Invoice issued template, so offline invoices keep your
              wording. If you save here, they get their own template. Reset to default loads the
              built-in template.
            </Note>
          ) : !template.customized ? (
            <Note>
              This is the built-in {label.toLowerCase()} email. When you save, we create an override
              for this business. Until then, you automatically get the improvements that we make to
              the built-in email.
            </Note>
          ) : null}

          <div className="px-5 py-4">
            <IssueField name="subject" label="Subject" issues={fieldIssues("subject")}>
              <Input
                ref={subjectRef}
                name="subject_edit"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                onFocus={() => (focused.current = "subject")}
                maxLength={500}
              />
            </IssueField>
          </div>

          <div className="px-5 py-4">
            <IssueField
              name="heading"
              label="Heading"
              help="The bold line at the top of the email."
              issues={fieldIssues("heading")}
            >
              <Input
                ref={headingRef}
                name="heading_edit"
                value={heading}
                onChange={(e) => setHeading(e.target.value)}
                onFocus={() => (focused.current = "heading")}
                maxLength={200}
              />
            </IssueField>
          </div>

          <div className="space-y-2 px-5 py-4">
            <span className="text-sm font-medium">Message</span>
            {mode === "visual" ? (
              <RichBodyEditor
                ref={bodyRef}
                value={body}
                seed={bodySeed}
                onChange={setBody}
                onFocus={() => (focused.current = "body")}
                labels={labels}
                portalLinkable={template.variables.some((v) => v.key === "portalUrl")}
                invalid={fieldIssues("body").some((i) => i.severity === "error")}
              />
            ) : (
              <Textarea
                ref={htmlRef}
                aria-label="Email body HTML"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onFocus={() => (focused.current = "body")}
                rows={14}
                maxLength={20000}
                className="font-mono text-sm"
              />
            )}
            <IssueList issues={fieldIssues("body")} />
            {mode === "html" ? (
              <p className="text-xs text-muted-foreground">
                Allowed: links, bold, italic, underline, headings and lists. When you save, we
                remove all other HTML. Links must be http(s) or mailto.
              </p>
            ) : null}
          </div>

          <div className="space-y-2 px-5 py-4">
            <div>
              <span className="text-sm font-medium">Footer</span>
              <p className="text-xs text-muted-foreground">
                {footer.trim()
                  ? "The footer of this email. It replaces your business footer."
                  : "Empty, so this email uses your business footer from Sender settings. To give this email its own footer, type it here."}
              </p>
            </div>
            {mode === "visual" ? (
              <RichBodyEditor
                ref={footerRef}
                value={footer}
                seed={bodySeed}
                onChange={setFooter}
                onFocus={() => (focused.current = "footer")}
                labels={labels}
                portalLinkable={template.variables.some((v) => v.key === "portalUrl")}
                invalid={fieldIssues("footer").some((i) => i.severity === "error")}
                compact
              />
            ) : (
              <Textarea
                ref={footerHtmlRef}
                aria-label="Email footer HTML"
                value={footer}
                onChange={(e) => setFooter(e.target.value)}
                onFocus={() => (focused.current = "footer")}
                rows={5}
                maxLength={20000}
                className="font-mono text-sm"
              />
            )}
            <IssueList issues={fieldIssues("footer")} />
            {footer.trim() ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setFooter("");
                  setBodySeed((n) => n + 1);
                }}
              >
                Use business footer
              </Button>
            ) : (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-line text-muted-foreground">
                {template.default_footer}
              </div>
            )}
          </div>
        </SettingsCard>

        <VariablePalette
          variables={template.variables}
          onInsert={(key) => insert(`{{${key}}}`)}
          onFallback={(key) => setFallbackFor(key)}
          onSection={(key, negate) =>
            insert(`{{#${negate ? "unless" : "if"} ${key}}}`, `{{/${negate ? "unless" : "if"}}}`)
          }
        />

        <LayoutCard
          hasAction={hasAction}
          defaultCtaLabel={template.default_cta_label}
          hasFacts={template.has_facts}
          ctaLabel={ctaLabel}
          setCtaLabel={setCtaLabel}
          ctaRef={ctaRef}
          onCtaFocus={() => (focused.current = "cta_label")}
          ctaIssues={fieldIssues("cta_label")}
          showFacts={showFacts}
          setShowFacts={setShowFacts}
          order={order}
          setOrder={setOrder}
          isInvoice={template.type === "invoice_issued" || template.type === "invoice_sent"}
        />

        {template.attachments ? (
          <AttachmentsCard
            biz={biz}
            type={template.type}
            view={template.attachments}
            action={attachmentAction}
          />
        ) : null}

        {/* Sticky: the editor is long, and Save must stay reachable from any card. */}
        <ActionForm
          action={saveAction as never}
          className="sticky bottom-0 z-10 space-y-3 rounded-xl border bg-card px-5 py-4 shadow-sm"
        >
          <DraftFields biz={biz} type={template.type} draft={draft} />
          {errors.length ? <Alert tone="error">Correct the highlighted fields.</Alert> : null}
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton disabled={!dirty || errors.length > 0}>Save template</SubmitButton>
            <Button type="button" variant="outline" disabled={atBuiltIn} onClick={loadDefault}>
              Reset to default
            </Button>
            <span className="text-xs text-muted-foreground">
              {!dirty
                ? "No unsaved changes"
                : atBuiltIn && template.customized
                  ? "The default is loaded but not saved. Save to return to the default email."
                  : "Unsaved changes"}
            </span>
          </div>
        </ActionForm>

        <SettingsCard
          title="Send a test"
          meta="The email in the preview, saved or not, with sample data"
        >
          <ActionForm action={testAction as never} className="px-5 py-4">
            <DraftFields biz={biz} type={template.type} draft={draft} />
            <Field name="test_to" label="Send to">
              <div className="flex flex-wrap gap-2">
                <Input
                  name="test_to"
                  type="email"
                  defaultValue={userEmail}
                  className="max-w-72 min-w-0 flex-1"
                  required
                />
                <SubmitButton variant="outline" disabled={errors.length > 0}>
                  Send test
                </SubmitButton>
              </div>
            </Field>
          </ActionForm>
        </SettingsCard>
      </div>

      <PreviewPane preview={preview} pending={pending} error={previewError} />

      <FallbackDialog
        varKey={fallbackFor}
        label={fallbackFor ? tokenLabel(`{{${fallbackFor}}}`, labels) : ""}
        onClose={() => setFallbackFor(null)}
        onInsert={(key, text) => {
          setFallbackFor(null);
          insert(`{{${key} | default: "${text.replace(/["{}<>]/g, "")}"}}`);
        }}
      />
    </div>
  );
}

/** A quiet status line at the top of a card. */
function Note({ children }: { children: React.ReactNode }) {
  return <p className="m-0 bg-muted/50 px-5 py-3 text-sm text-muted-foreground">{children}</p>;
}

/** Renders the draft through the engine on every change, debounced; stale replies are dropped. */
function useLivePreview(
  biz: string,
  type: string,
  draft: object,
  initial: Preview | null,
): { preview: Preview | null; pending: boolean; error: string | null } {
  const [preview, setPreview] = React.useState(initial);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const key = JSON.stringify(draft);
  const first = React.useRef(true);

  React.useEffect(() => {
    // The server already rendered the untouched template.
    if (first.current && initial) {
      first.current = false;
      return;
    }
    first.current = false;
    const ctl = new AbortController();
    setPending(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/email-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ biz, type, ...JSON.parse(key) }),
          signal: ctl.signal,
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error ?? "We could not load the preview.");
        setPreview({
          subject: json.subject,
          html: json.html,
          text: json.text,
          issues: json.issues ?? [],
        });
        setError(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      } finally {
        if (!ctl.signal.aborted) setPending(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biz, type, key]);

  return { preview, pending, error };
}

function DraftFields({
  biz,
  type,
  draft,
}: {
  biz: string;
  type: string;
  draft: {
    subject: string;
    heading: string;
    body: string;
    footer: string | null;
    cta_label?: string | null;
    show_facts?: boolean;
    block_order: BlockKey[];
  };
}) {
  return (
    <>
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="subject" value={draft.subject} />
      <input type="hidden" name="heading" value={draft.heading} />
      <input type="hidden" name="body" value={draft.body} />
      <input type="hidden" name="footer" value={draft.footer ?? ""} />
      {"cta_label" in draft ? (
        <input type="hidden" name="cta_label" value={draft.cta_label ?? ""} />
      ) : null}
      {"show_facts" in draft ? (
        <input type="hidden" name="show_facts" value={draft.show_facts ? "on" : "off"} />
      ) : null}
      <input type="hidden" name="block_order" value={draft.block_order.join(",")} />
    </>
  );
}

function IssueField({
  name,
  label,
  help,
  issues,
  children,
}: {
  name: string;
  label: string;
  help?: string;
  issues: Issue[];
  children: React.ReactNode;
}) {
  const error = issues.find((i) => i.severity === "error")?.message;
  return (
    <div className="space-y-1.5">
      <Field name={name} label={label} help={help} error={error}>
        {children}
      </Field>
      <IssueList issues={issues.filter((i) => i.severity === "warning")} />
    </div>
  );
}

function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="space-y-1">
      {issues.map((i) => (
        <li
          key={i.message}
          className={cn(
            "text-xs",
            i.severity === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {i.severity === "warning" ? "Warning: " : ""}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function VariablePalette({
  variables,
  onInsert,
  onFallback,
  onSection,
}: {
  variables: TemplateEditorTemplate["variables"];
  onInsert: (key: string) => void;
  onFallback: (key: string) => void;
  onSection: (key: string, negate: boolean) => void;
}) {
  const groups = [
    { title: "Always set", items: variables.filter((v) => v.always) },
    { title: "Sometimes empty", items: variables.filter((v) => !v.always) },
  ].filter((g) => g.items.length);

  return (
    <SettingsCard title="Insert a variable" meta="Goes at the last cursor position" padded>
      <div className="space-y-3">
        <p className="m-0 text-sm text-muted-foreground">
          Use variables in the subject, heading, message, footer or button text. Use the arrow to
          add a fallback, or to show text only when a value is set.
        </p>
        {groups.map((g) => (
          <div key={g.title} className="space-y-1.5">
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {g.title}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.items.map((v) => (
                <div key={v.key} className="flex overflow-hidden rounded-md border">
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onInsert(v.key)}
                    className="touch-target relative px-2 py-1 text-xs hover:bg-muted"
                    title={v.sample ? `e.g. ${v.sample}` : `{{${v.key}}}`}
                  >
                    {v.label}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        aria-label={`More ways to insert ${v.label}`}
                        className="touch-target relative border-l px-1 text-muted-foreground hover:bg-muted"
                      >
                        <ChevronDownIcon className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
                      <DropdownMenuLabel className="font-mono text-xs">{`{{${v.key}}}`}</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => onInsert(v.key)}>Insert</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onFallback(v.key)}>
                        Insert with a fallback…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => onSection(v.key, false)}>
                        Show selection only when set
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onSection(v.key, true)}>
                        Show selection only when empty
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}

/**
 * Saved the moment a switch moves: this is business config, not template wording, so it
 * must not wait for "Save template" (which would create a wording override).
 */
function AttachmentsCard({
  biz,
  type,
  view,
  action,
}: {
  biz: string;
  type: string;
  view: AttachmentsView;
  action: AttachmentAction;
}) {
  const incoming: AttachmentRule = {
    pdf: view.pdf,
    skipZeroPdf: view.skip_zero_pdf,
    skipZeroSend: view.skip_zero_send,
  };
  const [rule, setRule] = useDefaultState(incoming, (r) => JSON.stringify(r));
  const [saving, setSaving] = React.useState(false);
  const doc = view.document === "invoice" ? "invoice" : "credit note";

  async function change(patch: Partial<AttachmentRule>) {
    const prev = rule;
    const next = { ...rule, ...patch };
    setRule(next);
    setSaving(true);
    try {
      const res = (await action(biz, type, next)) as { ok?: boolean; message?: string } | undefined;
      if (res?.ok) toast.success(res.message ?? "Attachments saved");
      else {
        setRule(prev);
        toast.error(res?.message ?? "We could not save the attachments.");
      }
    } catch {
      setRule(prev);
      toast.error("We could not save the attachments.");
    } finally {
      setSaving(false);
    }
  }

  const row = (
    label: string,
    help: string,
    checked: boolean,
    onChange: (v: boolean) => void,
    disabled = false,
  ) => (
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div>
        <div className={cn("text-sm font-medium", disabled && "text-muted-foreground")}>
          {label}
        </div>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <SwitchField
        checked={checked}
        onCheckedChange={onChange}
        disabled={saving || disabled}
        ariaLabel={label}
        className="touch-target relative"
      />
    </div>
  );

  return (
    <SettingsCard title="Attachments" meta="We save each change immediately · this email only">
      {row(
        `Attach the ${doc} PDF`,
        `We create the PDF when we send the email, so it shows the ${doc} at that time.`,
        rule.pdf,
        (v) => change({ pdf: v }),
      )}
      {view.can_skip_zero_pdf
        ? row(
            "Skip the PDF for zero-value invoices",
            "For example, the first invoice of a free trial, or an invoice that a coupon fully covers.",
            rule.skipZeroPdf,
            (v) => change({ skipZeroPdf: v }),
            !rule.pdf,
          )
        : null}
      {view.can_skip_zero_send
        ? row(
            "Do not send this email for zero-value invoices",
            "We send no email when the invoice total is zero.",
            rule.skipZeroSend,
            (v) => change({ skipZeroSend: v }),
          )
        : null}
    </SettingsCard>
  );
}

const BLOCK_LABEL: Record<BlockKey, string> = {
  body: "Message",
  action: "Button",
  facts: "Details card",
  footer: "Footer",
};

function LayoutCard({
  hasAction,
  defaultCtaLabel,
  hasFacts,
  ctaLabel,
  setCtaLabel,
  ctaRef,
  onCtaFocus,
  ctaIssues,
  showFacts,
  setShowFacts,
  order,
  setOrder,
  isInvoice,
}: {
  hasAction: boolean;
  defaultCtaLabel: string | null;
  hasFacts: boolean;
  ctaLabel: string;
  setCtaLabel: (v: string) => void;
  ctaRef: React.RefObject<HTMLInputElement | null>;
  onCtaFocus: () => void;
  ctaIssues: Issue[];
  showFacts: boolean;
  setShowFacts: (v: boolean) => void;
  order: BlockKey[];
  setOrder: (v: BlockKey[]) => void;
  isInvoice: boolean;
}) {
  // Only sections this email can actually contain are movable — reordering an absent
  // button would be a control that does nothing.
  const present = (k: BlockKey) =>
    k === "body" ||
    (k === "action" && hasAction) ||
    (k === "facts" && hasFacts && showFacts) ||
    k === "footer";
  const visible = order.filter(present);

  const move = (k: BlockKey, dir: -1 | 1) => {
    const v = [...visible];
    const i = v.indexOf(k);
    const j = i + dir;
    if (j < 0 || j >= v.length) return;
    [v[i], v[j]] = [v[j]!, v[i]!];
    let n = 0;
    setOrder(order.map((b) => (present(b) ? v[n++]! : b)));
  };

  if (!hasAction && !hasFacts && order.filter(present).length < 2) return null;

  return (
    <SettingsCard title="Layout" meta="Button, details card and section order">
      {hasAction ? (
        <div className="px-5 py-4">
          <IssueField
            name="cta_label"
            label="Button text"
            help={
              isInvoice
                ? `Shows only on invoices that the customer pays manually. Leave blank for “${defaultCtaLabel}”.`
                : `Leave blank for “${defaultCtaLabel}”. We set the link.`
            }
            issues={ctaIssues}
          >
            <Input
              ref={ctaRef}
              name="cta_label_edit"
              value={ctaLabel}
              placeholder={defaultCtaLabel ?? ""}
              onChange={(e) => setCtaLabel(e.target.value)}
              onFocus={onCtaFocus}
              maxLength={60}
              className="max-w-72"
            />
          </IssueField>
        </div>
      ) : null}

      {hasFacts ? (
        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div>
            <div className="text-sm font-medium">Details card</div>
            <p className="text-xs text-muted-foreground">
              The box that shows the amount, invoice and payment method. The values come from the
              invoice.
            </p>
          </div>
          <SwitchField
            checked={showFacts}
            onCheckedChange={setShowFacts}
            ariaLabel="Show the details card"
            className="touch-target relative"
          />
        </div>
      ) : null}

      {visible.length > 1 ? (
        <div className="space-y-1.5 px-5 py-4">
          <div className="text-sm font-medium">Section order</div>
          <ol className="divide-y rounded-md border">
            {visible.map((k, i) => (
              <li key={k} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                <span>{BLOCK_LABEL[k]}</span>
                <span className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="touch-target relative"
                    aria-label={`Move ${BLOCK_LABEL[k]} up`}
                    disabled={i === 0}
                    onClick={() => move(k, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="touch-target relative"
                    aria-label={`Move ${BLOCK_LABEL[k]} down`}
                    disabled={i === visible.length - 1}
                    onClick={() => move(k, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                </span>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">Your logo and heading always come first.</p>
        </div>
      ) : null}
    </SettingsCard>
  );
}

function PreviewPane({
  preview,
  pending,
  error,
}: {
  preview: Preview | null;
  pending: boolean;
  error: string | null;
}) {
  const [view, setView] = React.useState<"desktop" | "mobile" | "text">("desktop");
  const views = [
    { key: "desktop" as const, label: "Desktop", Icon: MonitorIcon },
    { key: "mobile" as const, label: "Mobile", Icon: SmartphoneIcon },
    { key: "text" as const, label: "Plain text", Icon: TextIcon },
  ];

  const toggle = (
    <div className="flex flex-wrap rounded-md border p-0.5" role="group" aria-label="Preview as">
      {views.map(({ key, label, Icon }) => (
        <Button
          key={key}
          type="button"
          size="xs"
          variant="ghost"
          aria-pressed={view === key}
          className={cn(
            "touch-target relative",
            view === key && "bg-accent text-accent-foreground",
          )}
          onClick={() => setView(key)}
        >
          <Icon />
          {label}
        </Button>
      ))}
    </div>
  );

  return (
    <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
      <SettingsCard
        title="Preview"
        meta={<span aria-live="polite">{pending ? "Updating…" : "Sample data"}</span>}
        actions={toggle}
      >
        {error ? (
          <div className="px-5 py-3">
            <Alert tone="error">{error}</Alert>
          </div>
        ) : null}
        {preview ? (
          <div className={cn("transition-opacity", pending && "opacity-80")}>
            <div className="border-b bg-muted/50 px-5 py-3">
              <div className="text-xs text-muted-foreground">Subject</div>
              <div className="text-sm font-medium wrap-break-word">{preview.subject}</div>
            </div>
            {view === "text" ? (
              <pre className="p-5 font-sans text-sm whitespace-pre-wrap">{preview.text}</pre>
            ) : (
              <div className={cn("overflow-x-auto bg-muted/30", view === "mobile" && "py-4")}>
                <EmailFrame html={preview.html} width={view === "mobile" ? 375 : null} />
              </div>
            )}
          </div>
        ) : (
          <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
            The preview appears when the template renders.
          </p>
        )}
      </SettingsCard>
    </div>
  );
}

/**
 * The email in its own document, as an inbox shows it: its own width, light, no dashboard
 * CSS leaking in. `allow-same-origin` only so the frame can be measured; scripts stay off.
 */
function EmailFrame({ html, width }: { html: string; width: number | null }) {
  const ref = React.useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = React.useState(480);
  // Sanitised in the browser only (see lib/sanitize-html); blank until hydrated.
  const client = useIsClient();
  const doc = React.useMemo(
    () =>
      client
        ? `<!doctype html>${sanitizeHtmlDocument(`<html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>html,body{margin:0;background:white}body{padding:20px}</style></head><body>${html}</body></html>`)}`
        : "",
    [client, html],
  );
  // The frame can finish loading before hydration attaches `onLoad`, so measure on
  // every render of new html too, and keep following the content's own size.
  React.useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro: ResizeObserver | null = null;
    const attach = () => {
      // The BODY, not the root: the root is at least the frame's own height, so measuring
      // it would let the frame grow but never shrink.
      const body = frame.contentDocument?.body;
      if (!body) return;
      const fit = () => setHeight(Math.ceil(body.getBoundingClientRect().height));
      fit();
      ro?.disconnect();
      ro = new ResizeObserver(fit);
      ro.observe(body);
    };
    if (frame.contentDocument?.readyState === "complete") attach();
    frame.addEventListener("load", attach);
    return () => {
      frame.removeEventListener("load", attach);
      ro?.disconnect();
    };
  }, [html]);
  return (
    <iframe
      ref={ref}
      title="Email preview"
      sandbox="allow-same-origin"
      srcDoc={doc}
      style={{ height, width: width ?? "100%" }}
      className={cn("block border-0 bg-card", width && "mx-auto rounded-lg border shadow-xs")}
    />
  );
}

function FallbackDialog({
  varKey,
  label,
  onClose,
  onInsert,
}: {
  varKey: string | null;
  label: string;
  onClose: () => void;
  onInsert: (key: string, text: string) => void;
}) {
  const [text, setText] = React.useState("");
  return (
    <Dialog
      open={varKey !== null}
      onOpenChange={(o) => {
        if (o) return;
        setText("");
        onClose();
      }}
    >
      <DialogContent size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (varKey && text.trim()) onInsert(varKey, text.trim());
            setText("");
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>Insert {label} with a fallback</DialogTitle>
            <DialogDescription>
              We use the fallback when {label.toLowerCase()} is empty.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Fallback text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. there"
            maxLength={100}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!text.trim()}>
              Insert
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
