"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import type { Business } from "@/lib/api";
import type {
  TransferJob,
  TransferPreview as Preview,
  TransferRequest,
  TransferSection,
} from "@/lib/api/transfer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";
import { RadioField } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDefaultState } from "@/lib/use-default-state";
import { SECTIONS } from "./sections";
import { TransferPreview } from "./TransferPreview";
import { blockedSections, classify } from "./classify";

type PreviewResult = { ok: true; preview: Preview } | { ok: false; message: string };
type RunResult = { ok: boolean; job?: TransferJob; message?: string };
/** What happens to the destination's own records. */
export type Existing = "keep" | "clear" | "add_only" | "update";

/** A previous run's choices, to start the form from ("Repeat" in the history). */
export interface TransferSeed {
  dest: string;
  sections: TransferSection[];
  invoicePrefix?: string;
  creditNotePrefix?: string;
  withTwins?: boolean;
}

interface TransferFormProps {
  biz: string;
  currentBizId: string;
  businesses: Business[];
  /** The signed-in person is an owner or admin, so they may update a live business. */
  canOverride: boolean;
  seed: TransferSeed | null;
  previewAction: (biz: string, body: TransferRequest) => Promise<PreviewResult>;
  runAction: (biz: string, body: TransferRequest) => Promise<RunResult>;
  onJob: (job: TransferJob) => void;
}

function Block({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-base font-medium">{title}</h3>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * Copy set-up from this business: pick the destination and what happens to its records, pick
 * the sections, check every change, then copy. No <form>: each step sends the same request
 * object, and any change to it drops the checked changes, so a copy always matches them.
 */
export function TransferForm({
  biz,
  currentBizId,
  businesses,
  canOverride,
  seed,
  previewAction,
  runAction,
  onJob,
}: TransferFormProps) {
  const router = useRouter();
  const current = businesses.find((b) => b.id === currentBizId);
  // The usual copy is between the two modes of the same business, so start there.
  const twinId =
    (current?.livemode === "live" ? current.test_business_id : current?.live_business_id) ?? "";
  const startDest = seed?.dest ?? twinId;
  const liveOf = (id: string) => businesses.find((b) => b.id === id)?.livemode === "live";

  // "Repeat" hands in a new seed: each value re-seeds when it changes, and an edit in progress
  // survives a refresh that brings the same seed back.
  const [dest, setDest] = useDefaultState<string>(startDest);
  const [existing, setExisting] = useDefaultState<Existing>(
    liveOf(startDest) ? "add_only" : "keep",
  );
  const [sections, setSections] = useDefaultState<TransferSection[]>(
    seed?.sections ?? SECTIONS.filter((s) => s.defaultOn).map((s) => s.id),
    (v) => v.join(","),
  );
  const [invoicePrefix, setInvoicePrefix] = useDefaultState(seed?.invoicePrefix ?? "");
  const [creditNotePrefix, setCreditNotePrefix] = useDefaultState(seed?.creditNotePrefix ?? "");
  const [withTwins, setWithTwins] = useDefaultState(!!seed?.withTwins);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState<"check" | "copy" | null>(null);

  const destBiz = businesses.find((b) => b.id === dest);
  const destLive = destBiz?.livemode === "live";
  const twinsPossible =
    current?.livemode === "live" &&
    destLive &&
    !!current?.test_business_id &&
    !!destBiz?.test_business_id;
  const clears = sections.some((s) => s === "catalog" || s === "coupons" || s === "tax_rates");

  // Any change to the request makes the checked changes stale.
  const touch =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPreview(null);
    };

  const request = (
    secs = sections,
    inv = invoicePrefix,
    cn = creditNotePrefix,
  ): TransferRequest => ({
    destination_business: dest,
    sections: secs,
    ...(inv.trim() || cn.trim()
      ? {
          numbering: {
            ...(inv.trim() ? { invoice_prefix: inv.trim() } : {}),
            ...(cn.trim() ? { credit_note_prefix: cn.trim() } : {}),
          },
        }
      : {}),
    ...(twinsPossible && withTwins ? { include_test_twins: true } : {}),
    ...(existing === "clear" && !destLive && clears ? { wipe_destination: true } : {}),
  });

  async function check(body = request()) {
    setBusy("check");
    try {
      const r = await previewAction(biz, body);
      if (r.ok) setPreview(r.preview);
      else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  }

  /** Drop every section that has a problem, then check again. */
  async function leaveOutProblems() {
    if (!preview) return;
    const blocked = blockedSections(rows);
    const secs = sections.filter((s) => !blocked.includes(s));
    const numbering = blocked.includes("numbering");
    setSections(secs);
    if (numbering) {
      setInvoicePrefix("");
      setCreditNotePrefix("");
    }
    if (secs.length === 0) {
      setPreview(null);
      return;
    }
    await check(request(secs, numbering ? "" : invoicePrefix, numbering ? "" : creditNotePrefix));
  }

  async function copy() {
    if (!preview) return;
    setBusy("copy");
    try {
      const body = request();
      if (existing === "update" && destLive)
        body.live_override = { confirm: typed, plan_digest: preview.plan_digest };
      const r = await runAction(biz, body);
      if (r.job) onJob(r.job);
      if (r.ok) {
        toast.success("Set-up copied.");
        setPreview(null);
        setConfirmOpen(false);
        router.refresh();
      } else {
        toast.error(r.message ?? "We could not copy the set-up.");
        setConfirmOpen(false);
      }
    } finally {
      setBusy(null);
    }
  }

  const update = existing === "update" && destLive;
  const rows = preview ? classify(preview, update) : [];
  const problems = rows.filter((r) => r.problem);
  const n = (k: string) => rows.filter((r) => r.kind === k && !r.problem).length;
  const destName = destBiz?.name ?? "";
  const confirmed = !update || typed === destName;
  const other = businesses.filter((b) => b.id !== currentBizId);

  const existingOptions = destLive
    ? [
        {
          value: "add_only",
          label: "Add only what is new",
          hint: "Records that the live business has stay as they are. Settings, company profile, email sending and numbering do not change.",
        },
        {
          value: "update",
          label: "Also update what is there",
          hint: canOverride
            ? "Settings, company profile, email sending, numbering and tax profiles change to the values below. Products, prices and coupons that exist stay as they are."
            : "Only an owner or an admin can select this.",
          disabled: !canOverride,
        },
      ]
    : [
        {
          value: "keep",
          label: "Keep what is there",
          hint: "Records with the same id are updated. Other records stay.",
        },
        {
          value: "clear",
          label: "Delete its catalog, coupons and taxes first",
          hint: clears
            ? "The destination gets an exact copy of these sections."
            : "Select Catalog, Coupons or Taxes to use this.",
          disabled: !clears,
        },
      ];

  return (
    <div className="space-y-5">
      <Block title="Destination">
        <div className="space-y-1.5">
          <Label htmlFor="dest-select">Copy to</Label>
          <SelectField
            id="dest-select"
            value={dest}
            onValueChange={(v) => {
              touch(setDest)(v);
              setExisting(liveOf(v) ? "add_only" : "keep");
              setTyped("");
            }}
            ariaLabel="Copy to"
            placeholder="Select a business…"
            className="max-w-xs"
            options={other.map((b) => ({
              value: b.id,
              label: `${b.name} (${b.livemode === "live" ? "Live" : "Test"})`,
            }))}
          />
        </div>
        {dest && (
          <div className="space-y-1.5">
            <Label>Records the destination has</Label>
            <RadioField
              ariaLabel="Records the destination has"
              value={existing}
              onValueChange={(v) => touch(setExisting)(v as Existing)}
              options={existingOptions}
            />
            {destLive && (
              <p className="text-xs text-muted-foreground">
                A live business is never cleared: it has customers that bill from these records.
              </p>
            )}
          </div>
        )}
        {twinsPossible && (
          <CheckboxField
            checked={withTwins}
            onCheckedChange={touch(setWithTwins)}
            label="Also copy the test businesses"
            hint="The test business of this business goes into the test business of the destination first. If that fails, the live business does not change."
          />
        )}
      </Block>

      {dest && (
        <Block title="What to copy">
          <div className="grid gap-3 sm:grid-cols-2">
            {SECTIONS.map((s) => (
              <div key={s.id} className="rounded-md border p-3 transition-colors hover:bg-accent">
                <CheckboxField
                  checked={sections.includes(s.id)}
                  onCheckedChange={(on) =>
                    touch(setSections)(
                      on ? [...sections, s.id] : sections.filter((x) => x !== s.id),
                    )
                  }
                  label={s.label}
                  hint={s.description}
                />
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              The copy does not take the source&apos;s number prefixes. To give the destination new
              ones, enter them here.
            </p>
            <div className="flex flex-wrap gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="invoice-prefix">Invoice prefix</Label>
                <Input
                  id="invoice-prefix"
                  className="w-72"
                  maxLength={20}
                  value={invoicePrefix}
                  placeholder={
                    destBiz?.invoice_prefix
                      ? `Keep ${destBiz.invoice_prefix}`
                      : "Keep the current prefix"
                  }
                  onChange={(e) => touch(setInvoicePrefix)(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="credit-note-prefix">Credit note prefix</Label>
                <Input
                  id="credit-note-prefix"
                  className="w-72"
                  maxLength={20}
                  value={creditNotePrefix}
                  placeholder={
                    destBiz?.credit_note_prefix
                      ? `Keep ${destBiz.credit_note_prefix}`
                      : "Keep the current prefix"
                  }
                  onChange={(e) => touch(setCreditNotePrefix)(e.target.value)}
                />
              </div>
            </div>
          </div>
        </Block>
      )}

      {dest && (
        <Block
          title="Changes"
          hint={
            preview
              ? undefined
              : "Check the changes before you copy. Nothing changes until you copy."
          }
        >
          {preview && (
            <>
              {problems.length > 0 && (
                <Alert tone="error" title="Some sections cannot be copied">
                  <div className="space-y-2">
                    <ul className="list-inside list-disc space-y-1">
                      {problems.map((p) => (
                        <li key={p.key}>
                          {p.section}: {p.reason}
                        </li>
                      ))}
                    </ul>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={leaveOutProblems}
                      disabled={busy !== null}
                    >
                      Leave out these sections
                    </Button>
                  </div>
                </Alert>
              )}
              <TransferPreview rows={rows} />
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={preview ? "outline" : "default"}
              onClick={() => check()}
              disabled={sections.length === 0 || busy !== null}
            >
              {busy === "check" ? "Checking…" : preview ? "Check again" : "Check changes"}
            </Button>
            {preview && (
              <>
                <Button
                  onClick={() => setConfirmOpen(true)}
                  disabled={problems.length > 0 || busy !== null}
                >
                  Copy now
                </Button>
                <span className="text-sm text-muted-foreground">
                  {n("new")} new, {n("replaced")} replaced, {n("left_out")} left out
                </span>
              </>
            )}
          </div>
        </Block>
      )}

      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => {
          setConfirmOpen(o);
          if (!o) setTyped("");
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Copy to {destName}?</DialogTitle>
            <DialogDescription>
              {n("new")} new and {n("replaced")} replaced. You cannot undo this.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {preview?.pairs.some((p) => p.clear_first) && (
              <Alert tone="warning">
                The catalog, coupons and taxes of {destName} are deleted before the copy.
              </Alert>
            )}
            {update && (
              <div className="space-y-1.5">
                <p>
                  The live business {destName} changes. The audit log records each value that
                  changes.
                </p>
                <Label htmlFor="copy-confirm">Type {destName} to confirm</Label>
                <Input
                  id="copy-confirm"
                  className="w-72"
                  autoComplete="off"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={busy !== null}
            >
              Cancel
            </Button>
            <Button onClick={copy} disabled={!confirmed || busy !== null}>
              {busy === "copy" ? "Copying…" : "Copy now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
