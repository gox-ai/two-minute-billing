"use client";

import * as React from "react";
import {
  ArrowUp,
  AtSign,
  CreditCard,
  FileText,
  ImageIcon,
  Loader2,
  Paperclip,
  Plus,
  Receipt,
  Repeat,
  Square,
  TrendingUp,
  UserRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_TYPES,
  MENTION_MAX,
  TASKS,
  type AssistantTask,
  type AttachmentRef,
  type MentionRef,
} from "@/lib/assistant";
import {
  MESSAGE_MAX_CHARS,
  charsLeftNote,
  dropSlash,
  filterCommands,
  slashQuery,
} from "@/lib/assistant-reply";

export interface SendExtras {
  tool?: AssistantTask;
  mentions?: MentionRef[];
  attachments?: AttachmentRef[];
}

/** What the panel can ask of the composer: files dropped on it attach here. */
export interface ComposerHandle {
  attach: (files: File[]) => void;
}

type Pending = AttachmentRef & { uploading?: boolean; key: string };
type Icon = React.ComponentType<{ className?: string }>;

const TASK_ICON: Record<AssistantTask, Icon> = {
  explain_invoice: Receipt,
  explain_mrr_change: TrendingUp,
};
const RECORD_ICON: Record<string, Icon> = {
  customer: UserRound,
  invoice: FileText,
  subscription: Repeat,
  "credit note": Receipt,
  credit_note: Receipt,
  transaction: CreditCard,
  payment: CreditCard,
};

export const fmtSize = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

function Chip({
  icon: Icon,
  children,
  onRemove,
  removeLabel,
  onSelect,
  selectLabel,
}: {
  icon?: Icon;
  children: React.ReactNode;
  onRemove?: () => void;
  removeLabel: string;
  /** The chip itself is a button: the anchored record opens the record search. */
  onSelect?: () => void;
  selectLabel?: string;
}) {
  const body = (
    <>
      {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 rounded-md border bg-muted/60 py-0.5 pr-1 pl-1.5 text-xs">
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          aria-label={selectLabel}
          title={selectLabel}
          className="-my-0.5 -ml-1 inline-flex min-w-0 items-center gap-1 rounded-md py-0.5 pr-0.5 pl-1 hover:bg-muted"
        >
          {body}
        </button>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1">{body}</span>
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3" aria-hidden />
          <span className="sr-only">{removeLabel}</span>
        </button>
      ) : null}
    </span>
  );
}

const MENTION_AT = /(?:^|\s)@([^\s@]{0,40})$/;
const dropAt = (before: string) => before.replace(/@[^\s@]{0,40}$/, "");

export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

type Command = {
  id: string;
  group: "Add" | "Tasks";
  label: string;
  hint?: string;
  keywords?: string[];
  icon: Icon;
};

export function Composer({
  biz,
  busy,
  placeholder,
  anchor,
  onClearAnchor,
  onChangeAnchor,
  onSend,
  onStop,
  inputRef,
  handleRef,
}: {
  biz: string | null;
  busy: boolean;
  placeholder: string;
  /** The record the panel asks about (sent as `page.record`), shown as the first mention. */
  anchor: { type: string; label: string } | null;
  onClearAnchor: () => void;
  onChangeAnchor: (record: MentionRef) => void;
  /** The latest answer's suggested next questions. */
  onSend: (text: string, extras: SendExtras) => boolean;
  onStop: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  handleRef?: React.Ref<ComposerHandle>;
}) {
  const [text, setText] = React.useState("");
  // The draft survives a full page load (a hard navigation, a reload): kept per business for
  // this tab only, restored after mount so the server render and hydration agree.
  const draftKey = biz ? `tmb.assistant.draft.${biz}` : null;
  const draftRestored = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!draftKey || draftRestored.current === draftKey) return;
    draftRestored.current = draftKey;
    try {
      const saved = window.sessionStorage.getItem(draftKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setText((cur) => cur || saved);
    } catch {
      /* no storage: the draft lives in memory only */
    }
  }, [draftKey]);
  React.useEffect(() => {
    if (!draftKey || draftRestored.current !== draftKey) return;
    try {
      if (text) window.sessionStorage.setItem(draftKey, text);
      else window.sessionStorage.removeItem(draftKey);
    } catch {
      /* optional */
    }
  }, [draftKey, text]);
  const [tool, setTool] = React.useState<AssistantTask | null>(null);
  const [mentions, setMentions] = React.useState<MentionRef[]>([]);
  const [files, setFiles] = React.useState<Pending[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  // "@" search: the query after the @, the results and the highlighted row. `swap` = the
  // search replaces the anchored record instead of adding a mention.
  const [mq, setMq] = React.useState<string | null>(null);
  const [swap, setSwap] = React.useState(false);
  const [found, setFound] = React.useState<MentionRef[]>([]);
  const [searching, setSearching] = React.useState(false);
  // "/" menu: the query after the slash; Escape keeps it shut until the slash is gone.
  const [sq, setSq] = React.useState<string | null>(null);
  const [slashOff, setSlashOff] = React.useState(false);
  const [hi, setHi] = React.useState(0);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();

  const uploading = files.some((f) => f.uploading);
  const canSend = !!biz && !busy && !uploading && !!text.trim();

  React.useEffect(() => {
    if (mq === null || !biz || !mq) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/assistant/mentions?business=${encodeURIComponent(biz)}&q=${encodeURIComponent(mq)}`,
          { signal: ctrl.signal },
        );
        const body = res.ok ? ((await res.json()) as { data?: MentionRef[] }) : { data: [] };
        setFound((body.data ?? []).slice(0, 8));
        setHi(0);
        setSearching(false);
      } catch {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [mq, biz]);

  const caretAt = () => inputRef.current?.selectionStart ?? text.length;
  const placeCaret = (at: number) =>
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(at, at);
    });

  const syncTriggers = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = MENTION_AT.exec(before);
    setMq(m ? m[1]! : null);
    if (!m) setSwap(false);
    const s = slashQuery(before);
    if (s === null) setSlashOff(false);
    if (s !== sq) setHi(0);
    setSq(s);
  };

  /** Take the typed "@query" out of the text (a pick, or a cancelled record change). */
  const removeAtQuery = (refocus = true) => {
    const caret = caretAt();
    const before = dropAt(text.slice(0, caret));
    setText(before + text.slice(caret));
    if (refocus) placeCaret(before.length);
  };

  const pickMention = (m: MentionRef) => {
    removeAtQuery();
    setMq(null);
    if (swap) {
      setSwap(false);
      onChangeAnchor(m);
      return;
    }
    if (mentions.some((x) => x.id === m.id)) return;
    if (mentions.length >= MENTION_MAX) {
      setError(
        `We could not add this record. You can mention up to ${MENTION_MAX} records in one question. Remove a record first.`,
      );
      return;
    }
    setMentions((ms) => [...ms, m]);
  };

  const startMention = (value = text, caret = caretAt(), replacing = false) => {
    const pad = caret > 0 && !/\s$/.test(value.slice(0, caret)) ? " @" : "@";
    setText(value.slice(0, caret) + pad + value.slice(caret));
    setMq("");
    setSwap(replacing);
    setFound([]);
    placeCaret(caret + pad.length);
  };

  const closeMention = (refocus = true) => {
    if (swap) removeAtQuery(refocus);
    setMq(null);
    setSwap(false);
  };

  const upload = async (file: File) => {
    if (!(ATTACHMENT_TYPES as readonly string[]).includes(file.type)) {
      setError("We could not attach this file. Only PNG, JPEG and WebP images can be attached.");
      return;
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setError("We could not attach this file. It is larger than 10 MB. Attach a smaller image.");
      return;
    }
    if (!biz) return;
    const key = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
    setFiles((fs) => [
      ...fs,
      { key, id: "", name: file.name, size: file.size, content_type: file.type, uploading: true },
    ]);
    try {
      const res = await fetch("/api/assistant/attachments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          business: biz,
          name: file.name,
          content_type: file.type,
          data_base64: await readBase64(file),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<AttachmentRef> & {
        error?: { message?: string };
      };
      if (!res.ok || !body.id) {
        setFiles((fs) => fs.filter((f) => f.key !== key));
        setError(body.error?.message ?? "We could not attach this file. Try again.");
        return;
      }
      setFiles((fs) =>
        fs.map((f) =>
          f.key === key
            ? {
                key,
                id: body.id!,
                name: body.name ?? file.name,
                size: body.size ?? file.size,
                content_type: body.content_type ?? file.type,
              }
            : f,
        ),
      );
    } catch {
      setFiles((fs) => fs.filter((f) => f.key !== key));
      setError("We could not attach this file. Check your connection and try again.");
    }
  };

  /** The file picker, a paste and a drop all come here: the same checks for each file. */
  const attach = (list: File[]) => {
    if (!list.length || !biz) return;
    setError(null);
    const room = Math.max(0, ATTACHMENT_MAX_COUNT - files.length);
    for (const f of list.slice(0, room)) void upload(f);
    if (list.length > room)
      setError(
        `We could not attach all the images. You can attach up to ${ATTACHMENT_MAX_COUNT} images to one question.`,
      );
  };
  React.useImperativeHandle(handleRef, () => ({ attach }));

  const removeFile = (f: Pending) => {
    setFiles((fs) => fs.filter((x) => x.key !== f.key));
    if (f.id) {
      void fetch(`/api/assistant/attachments/${encodeURIComponent(f.id)}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
  };

  /** Backspace in an empty box: the last chip goes, the way it was added last. */
  const removeLastChip = () => {
    const f = files[files.length - 1];
    if (f) return removeFile(f);
    if (tool) return setTool(null);
    if (mentions.length) return setMentions((ms) => ms.slice(0, -1));
    if (anchor) onClearAnchor();
  };

  const submit = () => {
    if (!canSend) return;
    const sent = onSend(text, {
      ...(tool ? { tool } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(files.length
        ? {
            attachments: files.map(({ id, name, size, content_type }) => ({
              id,
              name,
              size,
              content_type,
            })),
          }
        : {}),
    });
    if (!sent) return;
    setText("");
    setTool(null);
    setMentions([]);
    setFiles([]);
    setMq(null);
    setSq(null);
    setError(null);
  };

  // One list for the "/" menu and the "+" button: each entry does what it says.
  const commands: Command[] = [
    ...TASKS.map((t) => ({
      id: t.id,
      group: "Tasks" as const,
      label: t.label,
      icon: TASK_ICON[t.id],
    })),
    {
      id: "attach",
      group: "Add",
      label: "Attach a file",
      hint: "Screenshot to explain, e.g. an error or a bank email",
      keywords: ["image", "screenshot", "upload"],
      icon: Paperclip,
    },
    {
      id: "mention",
      group: "Add",
      label: "Mention a record",
      hint: "A customer, invoice or subscription",
      keywords: ["customer", "invoice", "subscription", "record"],
      icon: AtSign,
    },
  ];

  const doCommand = (id: string) => {
    if (id === "attach") return fileRef.current?.click();
    if (id === "mention") return startMention();
    const task = TASKS.find((t) => t.id === id);
    if (task) setTool(task.id);
  };

  const runCommand = (c: Command) => {
    const caret = caretAt();
    const before = dropSlash(text.slice(0, caret));
    const next = before + text.slice(caret);
    setText(next);
    setSq(null);
    if (c.id === "mention") return startMention(next, before.length);
    placeCaret(before.length);
    doCommand(c.id);
  };

  const mentionOpen = mq !== null;
  const slashHits = sq !== null && !mentionOpen && !slashOff ? filterCommands(commands, sq) : [];
  // A typed space with nothing matching reads as text, not a command.
  const slashOpen =
    sq !== null && !mentionOpen && !slashOff && (slashHits.length > 0 || !/\s/.test(sq));
  const open = mentionOpen || slashOpen;
  // Results answer the last query; with no query there is nothing to list.
  const hits = mentionOpen ? (mq ? found : []) : slashHits;
  const taskLabel = tool ? TASKS.find((t) => t.id === tool)?.label : null;
  const hasChips = !!anchor || !!tool || mentions.length > 0 || files.length > 0;
  const charsNote = charsLeftNote(text.length);
  const filesNote =
    files.length >= ATTACHMENT_MAX_COUNT - 1
      ? `${files.length} of ${ATTACHMENT_MAX_COUNT} images`
      : null;

  const optionClass = (i: number) =>
    cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
      i === hi ? "bg-muted" : "hover:bg-muted/60",
    );

  return (
    <form
      className="relative flex shrink-0 flex-col gap-2 px-3 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={mentionOpen ? "Records to mention" : "Tasks and actions"}
          className="absolute inset-x-3 bottom-full z-10 mb-1 max-h-64 overflow-y-auto rounded-xl border border-popover-border bg-popover p-1 shadow-lg"
        >
          {mentionOpen ? (
            !mq ? (
              <p className="m-0 px-2 py-1.5 text-xs text-muted-foreground">
                {swap
                  ? "Type a name, email or number to find the record to ask about."
                  : "Type a name, email or number to find a customer, invoice or subscription."}
              </p>
            ) : searching && !hits.length ? (
              <p className="m-0 px-2 py-1.5 text-xs text-muted-foreground">Searching…</p>
            ) : !hits.length ? (
              <p className="m-0 px-2 py-1.5 text-xs text-muted-foreground">
                No matches for “{mq}”.
              </p>
            ) : (
              found.map((h, i) => {
                const Icon = RECORD_ICON[h.type] ?? FileText;
                return (
                  <button
                    key={`${h.type}:${h.id}`}
                    id={`${listId}-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === hi}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickMention(h)}
                    className={optionClass(i)}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{h.label}</span>
                    {h.detail ? (
                      <span className="shrink-0 truncate text-xs text-muted-foreground">
                        {h.detail}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )
          ) : !slashHits.length ? (
            <p className="m-0 px-2 py-1.5 text-xs text-muted-foreground">No tasks match “{sq}”.</p>
          ) : (
            slashHits.map((c, i) => {
              const Icon = c.icon;
              const head = i === 0 || slashHits[i - 1]!.group !== c.group;
              return (
                <React.Fragment key={c.id}>
                  {head ? (
                    <p
                      role="presentation"
                      className="m-0 px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground"
                    >
                      {c.group}
                    </p>
                  ) : null}
                  <button
                    id={`${listId}-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === hi}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runCommand(c)}
                    className={optionClass(i)}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 rounded-xl border bg-card px-2.5 pt-2 pb-1.5 focus-within:border-ring">
        {hasChips ? (
          <div className="flex flex-wrap gap-1.5">
            {anchor ? (
              <Chip
                icon={RECORD_ICON[anchor.type] ?? FileText}
                onSelect={() => startMention(text, caretAt(), true)}
                selectLabel={`Change the record you ask about: ${anchor.label}`}
                onRemove={onClearAnchor}
                removeLabel="Ask about the whole business"
              >
                @{anchor.label}
              </Chip>
            ) : null}
            {mentions.map((m) => (
              <Chip
                key={m.id}
                icon={RECORD_ICON[m.type] ?? FileText}
                onRemove={() => setMentions((ms) => ms.filter((x) => x.id !== m.id))}
                removeLabel={`Remove ${m.label}`}
              >
                @{m.label}
              </Chip>
            ))}
            {tool && taskLabel ? (
              <Chip icon={TASK_ICON[tool]} onRemove={() => setTool(null)} removeLabel="Remove task">
                {taskLabel}
              </Chip>
            ) : null}
            {files.map((f) => (
              <Chip
                key={f.key}
                icon={f.uploading ? Loader2 : ImageIcon}
                onRemove={() => removeFile(f)}
                removeLabel={`Remove ${f.name}`}
              >
                {f.name} · {f.uploading ? "Uploading…" : fmtSize(f.size)}
              </Chip>
            ))}
          </div>
        ) : null}
        <Textarea
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            syncTriggers(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => {
            const t = e.currentTarget;
            syncTriggers(t.value, t.selectionStart ?? t.value.length);
          }}
          onBlur={() => {
            closeMention(false);
            setSq(null);
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault();
              attach(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (open && hits.length) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                return setHi((i) => (i + 1) % hits.length);
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                return setHi((i) => (i - 1 + hits.length) % hits.length);
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const at = Math.min(hi, hits.length - 1);
                return mentionOpen ? pickMention(found[at]!) : runCommand(slashHits[at]!);
              }
            }
            if (open && e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (mentionOpen) return closeMention();
              setSlashOff(true);
              return setSq(null);
            }
            if (e.key === "Backspace" && !text && hasChips) {
              e.preventDefault();
              return removeLastChip();
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          maxLength={MESSAGE_MAX_CHARS}
          disabled={!biz}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={
            open && hits.length ? `${listId}-${Math.min(hi, hits.length - 1)}` : undefined
          }
          aria-autocomplete="list"
          aria-label="Your question"
          placeholder={placeholder}
          className="field-sizing-content max-h-48 min-h-11 resize-none overflow-y-auto border-0 bg-transparent px-1 py-0.5 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" disabled={!biz} title="Add">
                <Plus className="size-4" />
                <span className="sr-only">Add a file, a record or a task</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              className="w-72"
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                inputRef.current?.focus();
              }}
            >
              {commands
                .filter((c) => c.group === "Add")
                .map((c) => {
                  const Icon = c.icon;
                  return (
                    <DropdownMenuItem
                      key={c.id}
                      // The menu returns focus to the box first; the record search opens after.
                      onSelect={() =>
                        c.id === "mention" ? setTimeout(() => doCommand(c.id), 0) : doCommand(c.id)
                      }
                    >
                      <Icon className="size-4" />
                      <span className="flex flex-col">
                        <span>{c.label}</span>
                        {c.hint ? (
                          <span className="text-xs text-muted-foreground">{c.hint}</span>
                        ) : null}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">Tasks</DropdownMenuLabel>
              {commands
                .filter((c) => c.group === "Tasks")
                .map((c) => {
                  const Icon = c.icon;
                  return (
                    <DropdownMenuItem key={c.id} onSelect={() => doCommand(c.id)}>
                      <Icon className="size-4" />
                      {c.label}
                    </DropdownMenuItem>
                  );
                })}
              <DropdownMenuSeparator />
              <p className="m-0 px-2 py-1.5 text-xs text-muted-foreground">
                Type / in the box to open this list.
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={fileRef}
            type="file"
            accept={ATTACHMENT_TYPES.join(",")}
            multiple
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = "";
              attach(picked);
            }}
          />
          <span className="min-w-0 flex-1 truncate px-1 text-right text-xs text-muted-foreground tabular-nums">
            {[filesNote, charsNote].filter(Boolean).join(" · ")}
          </span>
          {busy ? (
            <Button type="button" variant="outline" size="sm" onClick={onStop}>
              <Square className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button type="submit" size="icon-sm" disabled={!canSend} title="Send">
              <ArrowUp className="size-4" />
              <span className="sr-only">Send</span>
            </Button>
          )}
        </div>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
