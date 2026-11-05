"use client";

import * as React from "react";
import { Node, mergeAttributes, useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
  Heading1Icon,
  Heading2Icon,
  ListIcon,
  ListOrderedIcon,
  LinkIcon,
  Undo2Icon,
  Redo2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * WYSIWYG for an email body, limited to exactly what the engine's sanitiser keeps
 * (p, br, b, i, u, h1, h2, ul, ol, li, a). Merge tokens (`{{…}}`) are atomic chips, so
 * they cannot be half-deleted or mistyped. The value in and out is the template SOURCE
 * the engine stores; this component never renders an email — the preview does.
 */

const TOKEN = /\{\{[^{}]*\}\}/g;

export type VarLabels = Record<string, string>;

/** A human label for a token chip. */
export function tokenLabel(token: string, labels: VarLabels): string {
  const inner = token.slice(2, -2).trim();
  let m: RegExpMatchArray | null;
  const name = (k: string) => labels[k] ?? k;
  if ((m = inner.match(/^#if\s+(\w+)$/))) return `If ${name(m[1]!)} is set`;
  if ((m = inner.match(/^#unless\s+(\w+)$/))) return `If ${name(m[1]!)} is empty`;
  if (/^else$/.test(inner)) return "Otherwise";
  if (/^\/(if|unless)$/.test(inner)) return "End";
  if ((m = inner.match(/^(\w+)\s*\|\s*default:\s*"([^"]*)"$/)))
    return `${name(m[1]!)} · or “${m[2]}”`;
  if ((m = inner.match(/^(\w+)$/))) return name(m[1]!);
  return inner;
}

const isSectionToken = (t: string) => /^\{\{\s*(#|else|\/)/.test(t);

const MergeToken = Node.create<{ labels: VarLabels }>({
  name: "mergeToken",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addOptions: () => ({ labels: {} }),
  addAttributes: () => ({
    token: { default: "", parseHTML: (el) => el.getAttribute("data-merge-token") ?? "" },
  }),
  parseHTML: () => [{ tag: "span[data-merge-token]" }],
  renderHTML({ node, HTMLAttributes }) {
    const token = String(node.attrs.token);
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-merge-token": token,
        title: token,
        class: cn(
          "mx-px rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
          isSectionToken(token) ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
        ),
      }),
      tokenLabel(token, this.options.labels),
    ];
  },
  renderText: ({ node }) => String(node.attrs.token),
});

/** Template source → editor HTML: plain text becomes paragraphs, tokens become chips. */
export function sourceToEditorHtml(source: string): string {
  const html = /<[a-z][^>]*>/i.test(source)
    ? source
    : source
        .split(/\r?\n\s*\r?\n/)
        .map((p) => `<p>${escapeText(p).replace(/\r?\n/g, "<br>")}</p>`)
        .join("");
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const t of texts) {
    const value = t.nodeValue ?? "";
    if (!TOKEN.test(value)) continue;
    TOKEN.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of value.matchAll(TOKEN)) {
      frag.append(value.slice(last, m.index));
      const span = doc.createElement("span");
      span.setAttribute("data-merge-token", m[0]);
      frag.append(span);
      last = m.index! + m[0].length;
    }
    frag.append(value.slice(last));
    t.replaceWith(frag);
  }
  return doc.body.innerHTML;
}

/** Editor HTML → template source: chips back to tokens, editor-only attributes dropped. */
export function editorHtmlToSource(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.querySelectorAll("span[data-merge-token]").forEach((el) => {
    el.replaceWith(doc.createTextNode(el.getAttribute("data-merge-token") ?? ""));
  });
  doc.querySelectorAll("a").forEach((a) => {
    for (const attr of [...a.attributes]) if (attr.name !== "href") a.removeAttribute(attr.name);
  });
  return doc.body.innerHTML.replace(/<p><\/p>$/, "");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface RichBodyHandle {
  /** Insert a token at the cursor. */
  insertToken: (token: string) => void;
  /** Wrap the selection (or the current paragraph) in an if/unless section. */
  wrapSection: (open: string, close: string) => void;
  focus: () => void;
}

export const RichBodyEditor = React.forwardRef<
  RichBodyHandle,
  {
    value: string;
    /** Changes whenever the source is replaced from outside (reset, mode switch). */
    seed: number;
    onChange: (source: string) => void;
    onFocus?: () => void;
    labels: VarLabels;
    /** Whether `{{portalUrl}}` can be linked — offered as a one-click link target. */
    portalLinkable: boolean;
    invalid?: boolean;
    /** A shorter box, for secondary text like the footer. */
    compact?: boolean;
    /** Accessible name; defaults to the email body/footer wording. */
    ariaLabel?: string;
  }
>(function RichBodyEditor(
  { value, seed, onChange, onFocus, labels, portalLinkable, invalid, compact, ariaLabel },
  ref,
) {
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2] },
        blockquote: false,
        code: false,
        codeBlock: false,
        strike: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
          protocols: ["mailto"],
          HTMLAttributes: { rel: null, target: null },
          isAllowedUri: (url, ctx) =>
            /^\{\{\s*portalUrl\s*\}\}$/.test(url) ||
            (/^(https?:|mailto:)/i.test(url) && ctx.defaultValidate(url)),
        },
      }),
      MergeToken.configure({ labels }),
    ],
    editorProps: {
      attributes: {
        class:
          (compact ? "min-h-24 " : "min-h-64 ") +
          "prose-email px-3 py-2.5 text-sm leading-relaxed outline-none [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_a]:text-primary [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
        "aria-label": ariaLabel ?? (compact ? "Email footer" : "Email body"),
      },
    },
    content: "",
    onUpdate: ({ editor: e }) => onChangeRef.current(editorHtmlToSource(e.getHTML())),
    onFocus: () => onFocus?.(),
  });

  // Seed from the source whenever it is replaced from outside — not on every keystroke,
  // which would fight the cursor.
  React.useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(sourceToEditorHtml(value), { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, seed]);

  React.useImperativeHandle(
    ref,
    () => ({
      insertToken: (token) => {
        editor?.chain().focus().insertContent({ type: "mergeToken", attrs: { token } }).run();
      },
      wrapSection: (open, close) => {
        if (!editor) return;
        const { from, to, $from, $to } = editor.state.selection;
        const chip = (token: string) => ({ type: "mergeToken", attrs: { token } });
        if ($from.sameParent($to) && from !== to) {
          // Inline: both markers inside one paragraph.
          editor
            .chain()
            .focus()
            .insertContentAt(to, chip(close))
            .insertContentAt(from, chip(open))
            .run();
          return;
        }
        // Block: markers on paragraphs of their own around the selected blocks.
        const start = $from.before(1);
        const end = $to.after(1);
        editor
          .chain()
          .focus()
          .insertContentAt(end, { type: "paragraph", content: [chip(close)] })
          .insertContentAt(start, { type: "paragraph", content: [chip(open)] })
          .run();
      },
      focus: () => editor?.commands.focus(),
    }),
    [editor],
  );

  return (
    <div
      className={cn(
        "rounded-md border bg-card shadow-xs focus-within:ring-[3px] focus-within:ring-ring/50",
        invalid && "border-destructive",
      )}
    >
      {editor ? <Toolbar editor={editor} portalLinkable={portalLinkable} /> : null}
      <EditorContent editor={editor} />
    </div>
  );
});

function Toolbar({ editor, portalLinkable }: { editor: Editor; portalLinkable: boolean }) {
  // Re-render on selection moves so the active states follow the cursor.
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    editor.on("transaction", force);
    return () => {
      editor.off("transaction", force);
    };
  }, [editor]);

  const btn = (
    label: string,
    Icon: React.ComponentType<{ className?: string }>,
    active: boolean,
    run: () => void,
    disabled = false,
  ) => (
    <Button
      key={label}
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={cn(active && "bg-accent text-accent-foreground")}
    >
      <Icon className="size-4" />
    </Button>
  );
  const c = () => editor.chain().focus();

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b px-1.5 py-1">
      {btn("Bold", BoldIcon, editor.isActive("bold"), () => c().toggleBold().run())}
      {btn("Italic", ItalicIcon, editor.isActive("italic"), () => c().toggleItalic().run())}
      {btn("Underline", UnderlineIcon, editor.isActive("underline"), () =>
        c().toggleUnderline().run(),
      )}
      <span className="mx-1 h-5 w-px bg-border" />
      {btn("Heading", Heading1Icon, editor.isActive("heading", { level: 1 }), () =>
        c().toggleHeading({ level: 1 }).run(),
      )}
      {btn("Subheading", Heading2Icon, editor.isActive("heading", { level: 2 }), () =>
        c().toggleHeading({ level: 2 }).run(),
      )}
      {btn("Bulleted list", ListIcon, editor.isActive("bulletList"), () =>
        c().toggleBulletList().run(),
      )}
      {btn("Numbered list", ListOrderedIcon, editor.isActive("orderedList"), () =>
        c().toggleOrderedList().run(),
      )}
      <span className="mx-1 h-5 w-px bg-border" />
      <LinkButton editor={editor} portalLinkable={portalLinkable} />
      <span className="mx-1 h-5 w-px bg-border" />
      {btn("Undo", Undo2Icon, false, () => c().undo().run(), !editor.can().undo())}
      {btn("Redo", Redo2Icon, false, () => c().redo().run(), !editor.can().redo())}
    </div>
  );
}

function LinkButton({ editor, portalLinkable }: { editor: Editor; portalLinkable: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const active = editor.isActive("link");

  const apply = (href: string) => {
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!href) chain.unsetLink().run();
    else if (editor.state.selection.empty && !active)
      chain
        .insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] })
        .run();
    else chain.setLink({ href }).run();
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setUrl(String(editor.getAttributes("link").href ?? ""));
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Link"
          title="Link"
          aria-pressed={active}
          onMouseDown={(e) => e.preventDefault()}
          className={cn(active && "bg-accent text-accent-foreground")}
        >
          <LinkIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            apply(url.trim());
          }}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://… or mailto:…"
            aria-label="Link address"
            autoFocus
          />
          <Button type="submit" size="sm">
            {url.trim() ? "Apply" : "Remove"}
          </Button>
        </form>
        {portalLinkable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => apply("{{portalUrl}}")}
          >
            Link to the customer’s billing portal
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Links must start with http(s):// or mailto:.
        </p>
      </PopoverContent>
    </Popover>
  );
}
