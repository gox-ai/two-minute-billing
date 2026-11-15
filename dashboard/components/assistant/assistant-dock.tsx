"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  History,
  ImagePlus,
  LifeBuoy,
  Loader2,
  Maximize2,
  Minimize2,
  SearchX,
  SquarePen,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { EmptyState, ErrorState } from "@/components/states";
import { useDisplayTz } from "@/components/business-tz";
import { cn } from "@/lib/utils";
import {
  ASSISTANT_EVENT,
  ASSISTANT_NAME,
  ASSISTANT_RECORD_EVENT,
  SUPPORT_EVENT,
  openAssistant,
  pageContextOf,
  recordLabel,
  recordState,
  startersFor,
  type AllowanceView,
  type OpenAssistantDetail,
  type RecordRef,
  type SupportRequestView,
} from "@/lib/assistant";
import { SupportList, SupportThread } from "./support-view";
import { AssistantLauncher } from "./launcher";
import { BillyMark } from "./billy-mark";
import { Composer, type ComposerHandle, type SendExtras } from "./composer";
import { motionMs } from "@/lib/motion";
import {
  billyMoving,
  billyDocks,
  billyEntry,
  billyMorph,
  bubbleEl,
  panelEl,
  revealInset,
  type BillyEntry,
} from "./billy-morph";
import { OPEN_KEY, billyPushes, markBillyOpen } from "./billy-open";
import {
  BillyDockToggle,
  BillyResizeHandle,
  useBillyLayout,
  useBillyLayoutSync,
} from "./billy-size";
import {
  type BillyCorner,
  type FloatArea,
  CORNER_KEY,
  DEFAULT_CORNER,
  FLOAT_MARGIN,
  FLOAT_W,
  clampFloat,
  nearestCorner,
  parseStoredCorner,
  storeCorner,
} from "@/lib/billy-corner";
import { railWidth } from "@/lib/billy-width";
import { fmtDate } from "@/lib/format-date";
import { sharedChatId, toChat, type ChatSummary } from "@/lib/assistant-history";
import {
  LiveMessages,
  ReadOnlyMessages,
  blank,
  fromStored,
  type Msg,
  type StoredMessage,
} from "./chat-messages";
import { ChatHistory, ChatTitleBar, useChatHistory } from "./chat-history";

/**
 * The assistant panel at the right edge, as wide as `--billy-w` (lib/billy-width.ts; the
 * operator drags its edge). Docked, and where the page keeps room beside it
 * (app/motion/billy-push.css), <main> narrows to make room; otherwise it floats over the
 * page; the full screen below 640px or when the member asks. Escape closes it.
 * Changes are only ever proposed: a proposal card sends nothing until the member confirms.
 */

const renewsOn = (iso: string) => fmtDate(iso, "UTC");
/** A shared chat opened from its link, read only. */
type SharedView =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "failed"; id: string; message: string }
  | { status: "ready"; title: string; owner: string | null; messages: Msg[] };

const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

// Per tab: a reload keeps the panel where it was; a new tab or a new launch starts closed.
function readOpen(): boolean {
  try {
    return window.sessionStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function writeOpen(v: boolean) {
  try {
    window.sessionStorage.setItem(OPEN_KEY, v ? "1" : "0");
  } catch {
    /* a private window keeps it closed */
  }
}

/** The open conversation, per member and business, for this tab: a reload resumes it. */
const convKey = (member: string, biz: string) => `tmb.assistant.conversation.${member}.${biz}`;
function readConversation(member: string, biz: string): string | null {
  try {
    return window.sessionStorage.getItem(convKey(member, biz));
  } catch {
    return null;
  }
}
function writeConversation(member: string, biz: string | null, id: string | null) {
  if (!biz) return;
  try {
    if (id) window.sessionStorage.setItem(convKey(member, biz), id);
    else window.sessionStorage.removeItem(convKey(member, biz));
  } catch {
    /* without storage a reload starts a new conversation */
  }
}

const PHONE = "(max-width: 639.98px)";
const subscribePhone = (cb: () => void) => {
  const m = window.matchMedia(PHONE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const isPhone = () => window.matchMedia(PHONE).matches;
type BillyBox = "full" | "phone" | "dock" | "float";

export function AssistantDock({
  timezones = {},
  support = null,
  memberKey,
}: {
  timezones?: Record<string, string | null>;
  /** Cloud: support requests are on, with the member's unread count at page load. */
  support?: { unread: number } | null;
  /** The signed-in member, so per-member hints are remembered per member. */
  memberKey: string;
}) {
  const pathname = usePathname();
  const { biz, page } = pageContextOf(pathname);
  useBillyLayoutSync();
  const orgTz = useDisplayTz();
  const tz = (biz && timezones[biz]) || orgTz;
  const [open, setOpen] = React.useState(false);
  // The panel slides out before it unmounts; the bubble shrinks away while it slides in.
  const [closing, setClosing] = React.useState(false);
  const [bubbleOut, setBubbleOut] = React.useState(false);
  const shownRef = React.useRef(false);
  const motionTimer = React.useRef(0);
  const [full, setFull] = React.useState(false);
  const [conversation, setConversation] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [busy, setBusy] = React.useState(false);
  // History: the list in place of the chat, or (full screen with room) a column beside it.
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historyFocus, setHistoryFocus] = React.useState(0);
  const [wide, setWide] = React.useState(false);
  // The open chat's title and marks, once the API has named it.
  const [chat, setChat] = React.useState<ChatSummary | null>(null);
  const [shared, setShared] = React.useState<SharedView | null>(null);
  const [anchor, setAnchor] = React.useState<RecordRef | null>(page.record);
  const [labels, setLabels] = React.useState<Record<string, string>>({});
  const [allowance, setAllowance] = React.useState<AllowanceView | null>(null);
  // Support requests: the list, one thread, and the unread count behind the launcher's dot.
  const [view, setView] = React.useState<"chat" | "support">("chat");
  const [supportId, setSupportId] = React.useState<string | null>(null);
  const [supportItems, setSupportItems] = React.useState<SupportRequestView[] | null>(null);
  const [unread, setUnread] = React.useState(support?.unread ?? 0);
  const supportOn = !!support;
  const abortRef = React.useRef<AbortController | null>(null);
  // Stop was selected: the turn ends as "stopped", not silently (a new chat aborts too).
  const stopRef = React.useRef(false);
  const composerRef = React.useRef<ComposerHandle>(null);
  const [dropping, setDropping] = React.useState(false);
  const dragDepth = React.useRef(0);
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const bizRef = React.useRef(biz);

  const loadAllowance = React.useCallback(async () => {
    try {
      const res = await fetch("/api/assistant/usage");
      if (res.ok)
        setAllowance(((await res.json()) as { allowance: AllowanceView | null }).allowance);
    } catch {
      /* the bar is optional */
    }
  }, []);
  React.useEffect(() => {
    const o = readOpen();
    shownRef.current = o;
    markBillyOpen(o);
    // A reload shows the panel where it was: nothing moves.
    if (o) setEntry("still");
    try {
      setCorner(parseStoredCorner(window.localStorage.getItem(CORNER_KEY)));
    } catch {
      /* the default corner */
    }
    setOpen(o);
    if (o) void loadAllowance();
  }, [loadAllowance]);
  // Re-anchor only when the record changes, not on every render of the same page.
  React.useEffect(() => {
    setAnchor(page.record);
  }, [page.record?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A conversation belongs to one business: moving to ANOTHER business starts afresh. An
  // organization page (no business in the path) keeps the conversation, so a visit to
  // What's new or Account and back does not clear it.
  React.useEffect(() => {
    if (biz && bizRef.current !== biz) {
      const had = bizRef.current;
      bizRef.current = biz;
      if (!had) return;
      setConversation(null);
      setMessages([]);
      setHistoryOpen(false);
      setShared(null);
    }
  }, [biz]);
  // Keep the open conversation for this business; a remount or a reload resumes it.
  React.useEffect(() => {
    if (conversation) writeConversation(memberKey, biz, conversation);
  }, [conversation, biz, memberKey]);
  React.useEffect(() => {
    if (!biz) return;
    const id = readConversation(memberKey, biz);
    if (!id) return;
    void (async () => {
      try {
        const res = await fetch(`/api/assistant/conversations/${encodeURIComponent(id)}`);
        if (!res.ok) {
          if (res.status === 404) writeConversation(memberKey, biz, null);
          return;
        }
        const c = (await res.json()) as { id: string; messages: StoredMessage[] };
        if (bizRef.current !== biz) return;
        setChat(toChat(c));
        // The member started typing first: keep what they have.
        setConversation((cur) => cur ?? c.id);
        setMessages((cur) => (cur.length ? cur : c.messages.map(fromStored)));
      } catch {
        /* the panel starts empty */
      }
    })();
  }, [biz, memberKey]);
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const loadSupport = React.useCallback(async () => {
    if (!supportOn) return;
    try {
      const res = await fetch("/api/assistant/support/requests");
      if (!res.ok) return;
      const body = (await res.json()) as { data: SupportRequestView[]; unread: number };
      setSupportItems(body.data);
      setUnread(body.unread);
    } catch {
      /* the dot is optional */
    }
  }, [supportOn]);
  // A staff reply can land at any time: look again every minute while the tab is visible.
  React.useEffect(() => {
    if (!supportOn) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadSupport();
    }, 60_000);
    return () => window.clearInterval(t);
  }, [supportOn, loadSupport]);

  // How the panel came in, so it leaves the same way: one morph from the bubble (view
  // transition), a clip-path reveal from the bubble where those are missing, or a slide.
  const [entry, setEntry] = React.useState<BillyEntry>("slide");
  const entryRef = React.useRef<BillyEntry>("slide");
  entryRef.current = entry;
  const [returning, setReturning] = React.useState(false);
  const revealFrom = React.useRef<DOMRect | null>(null);
  const asideRef = React.useRef<HTMLElement>(null);

  // Which box the panel is: a column beside the page, a floating window, or the whole screen.
  const layout = useBillyLayout();
  const phone = React.useSyncExternalStore(subscribePhone, isPhone, () => false);
  const box: BillyBox = full ? "full" : phone ? "phone" : layout?.push ? "dock" : "float";
  const [corner, setCorner] = React.useState<BillyCorner>(DEFAULT_CORNER);
  // The page area the window may sit in: beside the rail, under the mode banner.
  const [area, setArea] = React.useState<FloatArea | null>(null);
  React.useLayoutEffect(() => {
    if (!open || box !== "float") return;
    const read = () => {
      const html = document.documentElement;
      const main = document.querySelector(".app-rail ~ main");
      setArea({
        left: railWidth(window.innerWidth, html.dataset.nav === "collapsed"),
        top: Math.max(0, main?.getBoundingClientRect().top ?? 0),
        right: window.innerWidth,
        bottom: window.innerHeight,
      });
    };
    read();
    window.addEventListener("resize", read);
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributeFilter: ["data-nav"] });
    return () => {
      window.removeEventListener("resize", read);
      mo.disconnect();
    };
  }, [open, box]);
  const motion = entry;

  // Drag the floating window by its header. It follows the pointer through `translate`, so
  // its corner anchors stay put; on release it snaps to the nearest corner.
  const drag = React.useRef<{
    id: number;
    x0: number;
    y0: number;
    r: DOMRect;
    frame: number;
    dx: number;
    dy: number;
  } | null>(null);
  const dragEnd = () => {
    const d = drag.current;
    const el = asideRef.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    if (!el || !area) return;
    delete el.dataset.dragging;
    const from = el.getBoundingClientRect();
    const next = nearestCorner(from, area);
    try {
      window.localStorage.setItem(CORNER_KEY, storeCorner(next));
    } catch {
      /* the corner lasts for this page only */
    }
    flushSync(() => setCorner(next));
    el.style.translate = "";
    const to = el.getBoundingClientRect();
    el.animate(
      [{ translate: `${from.left - to.left}px ${from.top - to.top}px` }, { translate: "0 0" }],
      {
        duration: motionMs("--dur-pop"),
        easing: getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim(),
      },
    );
  };
  const dragProps =
    box === "float"
      ? {
          onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
            const el = asideRef.current;
            if (e.button !== 0 || drag.current || !el) return;
            // The header's own controls stay controls; only the bare header drags.
            if ((e.target as HTMLElement).closest("button, a, input, textarea, [role='menu']"))
              return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = {
              id: e.pointerId,
              x0: e.clientX,
              y0: e.clientY,
              r: el.getBoundingClientRect(),
              frame: 0,
              dx: 0,
              dy: 0,
            };
            el.dataset.dragging = "";
          },
          onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
            const d = drag.current;
            const el = asideRef.current;
            if (!d || e.pointerId !== d.id || !el || !area) return;
            const p = clampFloat(
              d.r.left + e.clientX - d.x0,
              d.r.top + e.clientY - d.y0,
              d.r,
              area,
            );
            d.dx = p.x - d.r.left;
            d.dy = p.y - d.r.top;
            d.frame ||= requestAnimationFrame(() => {
              d.frame = 0;
              el.style.translate = `${d.dx}px ${d.dy}px`;
            });
          },
          onPointerUp: dragEnd,
          onPointerCancel: dragEnd,
          onLostPointerCapture: dragEnd,
        }
      : {};

  const show = React.useCallback(
    (v: boolean) => {
      writeOpen(v);
      const was = shownRef.current;
      shownRef.current = v;
      if (v === was) return;
      window.clearTimeout(motionTimer.current);
      if (v) {
        void loadAllowance();
        const from = bubbleEl();
        const how = billyEntry(from);
        // After a morph the composer is already mounted; after a plain open it mounts next.
        const focus = () =>
          inputRef.current?.focus() ?? window.setTimeout(() => inputRef.current?.focus(), 0);
        const opened = () => {
          markBillyOpen(true);
          setReturning(false);
          setEntry("morph");
          setClosing(false);
          setBubbleOut(false);
          setOpen(true);
        };
        // The bubble grows into the panel as one shape, whichever box the panel is.
        if (how === "morph" && from)
          return billyMorph(
            "open",
            isPhone() ? "phone" : billyDocks() ? "dock" : "float",
            from,
            opened,
            focus,
          );
        if (billyDocks()) {
          // The page's edge and the panel move as one: same clock, same curve.
          billyMoving(motionMs("--dur-dock"));
          opened();
          setEntry("dock");
          return focus();
        }
        // No room for a column, or the operator chose the window: it rises from its corner.
        if (!isPhone()) {
          opened();
          setEntry("float");
          if (from) {
            setBubbleOut(true);
            motionTimer.current = window.setTimeout(
              () => setBubbleOut(false),
              motionMs("--dur-out"),
            );
          }
          return focus();
        }
        revealFrom.current = how === "reveal" && from ? from.getBoundingClientRect() : null;
        markBillyOpen(true);
        setReturning(false);
        setEntry(how);
        setClosing(false);
        setOpen(true);
        if (how === "slide" && from) {
          setBubbleOut(true);
          motionTimer.current = window.setTimeout(() => setBubbleOut(false), motionMs("--dur-out"));
        }
        focus();
      } else {
        const panel = panelEl();
        const focusBubble = () =>
          bubbleEl()?.focus() ?? window.setTimeout(() => bubbleEl()?.focus(), 0);
        const closed = () => {
          markBillyOpen(false);
          setReturning(true);
          setBubbleOut(false);
          setClosing(false);
          setFull(false);
          setOpen(false);
        };
        const docked = panel?.dataset.box === "dock";
        const floating = panel?.dataset.box === "float";
        // The panel shrinks home into the bubble, from whichever box it is.
        if (panel && billyEntry(panel) === "morph")
          return billyMorph(
            "close",
            docked ? "dock" : floating ? "float" : "phone",
            panel,
            closed,
            focusBubble,
          );
        if (docked) {
          billyMoving(motionMs("--dur-dock"));
          setEntry("dock");
          setReturning(true);
        } else if (floating) {
          setEntry("float");
          setReturning(true);
        }
        // The page widens under the leaving panel, not after it.
        markBillyOpen(false);
        setBubbleOut(false);
        setClosing(true);
        motionTimer.current = window.setTimeout(
          () => {
            setOpen(false);
            setClosing(false);
            setFull(false);
            focusBubble();
          },
          motionMs(
            docked
              ? "--dur-dock"
              : floating
                ? "--dur-pop-out"
                : entryRef.current === "reveal"
                  ? "--dur-morph"
                  : "--dur-slow-out",
          ),
        );
      }
    },
    [loadAllowance],
  );
  // The fallback reveal starts from where the bubble was, inside the panel's own box.
  React.useLayoutEffect(() => {
    const a = asideRef.current;
    if (!open || entry !== "reveal" || !a || !revealFrom.current) return;
    for (const [k, val] of Object.entries(
      revealInset(revealFrom.current, a.getBoundingClientRect()),
    ))
      a.style.setProperty(k, val);
  }, [open, entry]);
  React.useEffect(
    () => () => {
      window.clearTimeout(motionTimer.current);
      markBillyOpen(false);
    },
    [],
  );

  const conversationRef = React.useRef(conversation);
  conversationRef.current = conversation;
  const forget = (id: string | null) => {
    abortRef.current?.abort();
    setConversation(null);
    setMessages([]);
    writeConversation(memberKey, bizRef.current, null);
    if (id) setChat((c) => (c?.id === id ? null : c));
  };
  const historyApi = useChatHistory({
    biz,
    active: open && view === "chat" && !!biz && (historyOpen || (full && wide)),
    onChanged: (c) => setChat((cur) => (cur?.id === c.id ? c : cur)),
    // An archived or deleted chat leaves the panel: a new, empty chat takes its place.
    onGone: (id) => {
      if (conversationRef.current === id) forget(id);
    },
  });
  const historyRef = React.useRef(historyApi);
  historyRef.current = historyApi;

  const patchLast = (f: (m: Msg) => Msg) =>
    setMessages((ms) => (ms.length ? [...ms.slice(0, -1), f(ms[ms.length - 1]!)] : ms));

  const send = React.useCallback(
    (text: string, extras: SendExtras = {}): boolean => {
      const content = text.trim();
      if (!content || busy || !biz) return false;
      setBusy(true);
      setView("chat");
      setHistoryOpen(false);
      setShared(null);
      setMessages((ms) => [
        ...ms,
        {
          ...blank("user", content),
          mentions: extras.mentions,
          attachments: extras.attachments,
          tool: extras.tool,
        },
        { ...blank("assistant"), streaming: true, startedAt: Date.now() },
      ]);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      stopRef.current = false;
      void (async () => {
        try {
          const res = await fetch("/api/assistant/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              business: biz,
              ...(conversation ? { conversation } : {}),
              content,
              page: { path: page.path, record: anchor },
              ...(extras.tool ? { tool: extras.tool } : {}),
              ...(extras.mentions?.length
                ? { mentions: extras.mentions.map(({ type, id }) => ({ type, id })) }
                : {}),
              ...(extras.attachments?.length
                ? { attachments: extras.attachments.map((a) => a.id) }
                : {}),
            }),
            signal: ctrl.signal,
          });
          if (!res.ok || !res.body) {
            let msg = "We could not get an answer. Try again in a minute.";
            try {
              msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg;
            } catch {
              /* keep the default */
            }
            patchLast((m) => ({ ...m, error: msg, streaming: false }));
            return;
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          // Text arrives word by word: one render per 32ms, not one per word.
          let words = "";
          let timer = 0;
          const flush = () => {
            window.clearTimeout(timer);
            timer = 0;
            if (!words) return;
            const t = words;
            words = "";
            patchLast((m) => ({ ...m, content: m.content + t }));
          };
          for (;;) {
            const { value, done } = await reader.read();
            if (done) {
              flush();
              break;
            }
            buf += dec.decode(value, { stream: true });
            let cut: number;
            while ((cut = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, cut);
              buf = buf.slice(cut + 2);
              if (!frame.startsWith("data: ")) continue;
              const e = JSON.parse(frame.slice(6)) as Record<string, any>;
              if (e.type === "text_delta") {
                words += e.text;
                timer ||= window.setTimeout(flush, 32);
                continue;
              }
              // Every other event lands after the text that came before it.
              flush();
              if (e.type === "conversation") {
                setConversation(e.conversation.id);
                const c = toChat(e.conversation);
                if (c) {
                  const fresh = { ...c, updated_at: new Date().toISOString() };
                  setChat(fresh);
                  historyRef.current.put(fresh);
                }
              }
              // The source guard rewrote the answer: show its version, not what streamed.
              else if (e.type === "replace_text") patchLast((m) => ({ ...m, content: e.text }));
              else if (e.type === "tool_status")
                patchLast((m) => ({
                  ...m,
                  steps: m.steps.some((s) => s.id === e.id)
                    ? m.steps.map((s) => (s.id === e.id ? { ...s, phase: e.phase } : s))
                    : [...m.steps, { id: e.id, label: e.label, phase: e.phase }],
                }));
              else if (e.type === "tool_data")
                patchLast((m) => ({
                  ...m,
                  data: [...m.data, { id: e.id, name: e.name, label: e.label, data: e.data }],
                }));
              else if (e.type === "figures") patchLast((m) => ({ ...m, figures: e.figures }));
              else if (e.type === "suggestions")
                patchLast((m) => ({ ...m, suggestions: (e.items as string[]).slice(0, 3) }));
              else if (e.type === "question") patchLast((m) => ({ ...m, question: e.question }));
              else if (e.type === "proposal") patchLast((m) => ({ ...m, proposal: e.proposal }));
              else if (e.type === "guide") patchLast((m) => ({ ...m, guide: e.guide }));
              else if (e.type === "support_draft")
                patchLast((m) => ({ ...m, supportDraft: e.draft }));
              else if (e.type === "error")
                patchLast((m) => ({
                  ...m,
                  error: e.message,
                  actions: e.actions,
                  streaming: false,
                }));
              else if (e.type === "allowance") {
                setAllowance({ used_percent: e.used_percent, renews_at: e.renews_at });
                patchLast((m) => ({
                  ...m,
                  notice: `Your organization used ${e.used_percent}% of this month's ${ASSISTANT_NAME} use. It renews on ${renewsOn(e.renews_at)}.`,
                }));
              } else if (e.type === "done")
                patchLast((m) => ({ ...m, id: e.message?.id ?? m.id, streaming: false }));
            }
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            if (stopRef.current) patchLast((m) => ({ ...m, stopped: true }));
          } else {
            patchLast((m) => ({
              ...m,
              error: "We could not get an answer. Try again in a minute.",
            }));
          }
        } finally {
          patchLast((m) => ({ ...m, streaming: false }));
          abortRef.current = null;
          setBusy(false);
          void loadAllowance();
        }
      })();
      return true;
    },
    [anchor, biz, busy, conversation, page.path, loadAllowance],
  );

  // Launchers: the bubble, ⌘K, the record pages, the tour, and ⌘J.
  const loadSupportRef = React.useRef(loadSupport);
  loadSupportRef.current = loadSupport;
  // The email about a support reply links to `?support=<id>`: open that thread.
  React.useEffect(() => {
    if (!supportOn) return;
    const id = new URLSearchParams(window.location.search).get("support");
    if (id && /^sr_[A-Za-z0-9]{6,60}$/.test(id)) {
      // The URL is only readable in the browser, so this runs once after mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      show(true);
      setView("support");
      setSupportId(id);
    }
  }, [supportOn, show]);
  const sendRef = React.useRef(send);
  sendRef.current = send;
  const anchorRef = React.useRef(anchor);
  anchorRef.current = anchor;
  React.useEffect(() => {
    const onOpen = (e: Event) => {
      show(true);
      setView("chat");
      const { ask, record } = (e as CustomEvent<OpenAssistantDetail>).detail ?? {};
      if (record) {
        if (record.label) setLabels((l) => ({ ...l, [record.id]: record.label! }));
        // A different record: start at its welcome rather than inside another conversation.
        if (anchorRef.current?.id !== record.id) {
          abortRef.current?.abort();
          setConversation(null);
          setMessages([]);
          writeConversation(memberKey, bizRef.current, null);
        }
        setHistoryOpen(false);
        setShared(null);
        setAnchor({ type: record.type, id: record.id });
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      if (ask) {
        setShared(null);
        setConversation(null);
        setMessages([]);
        writeConversation(memberKey, bizRef.current, null);
        setTimeout(() => void sendRef.current(ask), 0);
      }
    };
    const onRecord = (e: Event) => {
      const r = (e as CustomEvent<RecordRef & { label?: string }>).detail;
      if (r?.label) setLabels((l) => ({ ...l, [r.id]: r.label! }));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "j" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        show(!shownRef.current);
      }
    };
    const onSupport = (e: Event) => {
      const id = (e as CustomEvent<{ id: string | null }>).detail?.id ?? null;
      show(true);
      setHistoryOpen(false);
      setView("support");
      setSupportId(id);
      void loadSupportRef.current();
    };
    window.addEventListener(ASSISTANT_EVENT, onOpen);
    window.addEventListener(ASSISTANT_RECORD_EVENT, onRecord);
    window.addEventListener(SUPPORT_EVENT, onSupport);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(ASSISTANT_EVENT, onOpen);
      window.removeEventListener(ASSISTANT_RECORD_EVENT, onRecord);
      window.removeEventListener(SUPPORT_EVENT, onSupport);
      document.removeEventListener("keydown", onKey);
    };
  }, [show, memberKey]);

  // "Try again": the failed turn goes, and the same question is sent again in its place.
  const retry = (userIndex: number) => {
    const u = messages[userIndex];
    if (!u || u.role !== "user" || busy) return;
    setMessages((ms) =>
      ms.filter((x, j) => j !== userIndex && !(j === userIndex + 1 && x.role === "assistant")),
    );
    send(u.content, { tool: u.tool, mentions: u.mentions, attachments: u.attachments });
  };

  const newConversation = () => {
    setView("chat");
    setHistoryOpen(false);
    setShared(null);
    forget(null);
  };

  const toggleHistory = () => {
    setView("chat");
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    setHistoryFocus((n) => n + 1);
  };
  // Back from the list: the composer, whether the list replaced the chat or sits beside it.
  const leaveHistory = () => {
    setHistoryOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const openConversation = async (c: ChatSummary) => {
    try {
      const res = await fetch(`/api/assistant/conversations/${encodeURIComponent(c.id)}`);
      if (!res.ok) {
        if (res.status === 404) {
          toast.error("We could not open the chat.", {
            description: "It does not exist any more. It may have been deleted.",
          });
          historyApi.reload();
        } else toast.error("We could not open the chat.", { description: "Try again." });
        return;
      }
      const body = (await res.json()) as { id: string; messages: StoredMessage[] };
      if (body.id !== conversationRef.current) abortRef.current?.abort();
      setChat(toChat(body) ?? c);
      setConversation(body.id);
      setMessages(body.messages.map(fromStored));
      setShared(null);
      setHistoryOpen(false);
      setView("chat");
    } catch {
      toast.error("We could not open the chat.", {
        description: "Check your connection and try again.",
      });
    }
  };

  /** A `?billy=` link: the member's own chat opens as usual; another member's, read only. */
  const openShared = React.useCallback(async (id: string) => {
    setView("chat");
    setHistoryOpen(false);
    setShared({ status: "loading" });
    try {
      const own = await fetch(`/api/assistant/conversations/${encodeURIComponent(id)}`);
      if (own.ok) {
        const body = (await own.json()) as { id: string; messages: StoredMessage[] };
        abortRef.current?.abort();
        setChat(toChat(body));
        setConversation(body.id);
        setMessages(body.messages.map(fromStored));
        setShared(null);
        return;
      }
      const res = await fetch(`/api/assistant/shared/${encodeURIComponent(id)}`);
      if (res.status === 404) return setShared({ status: "missing" });
      const body = (await res.json().catch(() => null)) as {
        title?: string;
        owner?: { name?: string | null } | null;
        messages?: StoredMessage[];
        error?: { message?: string };
      } | null;
      if (!res.ok || !body)
        return setShared({
          status: "failed",
          id,
          message: body?.error?.message ?? "The billing API did not answer.",
        });
      setShared({
        status: "ready",
        title: body.title || "Shared chat",
        owner: body.owner?.name || null,
        messages: (body.messages ?? []).map(fromStored),
      });
    } catch {
      setShared({ status: "failed", id, message: "Check your connection and try again." });
    }
  }, []);
  // A shared chat's link: the business home with `?billy=<id>`. Read once per navigation,
  // then dropped from the address so a reload does not open it again.
  React.useEffect(() => {
    const id = sharedChatId(window.location.search);
    if (!id || !biz) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("billy");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    // The URL is only readable in the browser.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    show(true);
    void openShared(id);
  }, [pathname, biz, show, openShared]);

  // The history column needs room: a container query on the panel, read through a probe.
  const probeRef = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const probe = probeRef.current;
    if (!open || !probe) return;
    const read = () => setWide(probe.offsetWidth > 0);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(probe);
    return () => ro.disconnect();
  }, [open]);

  const onSupportRead = React.useCallback(() => void loadSupport(), [loadSupport]);

  // The bubble stays mounted while it shrinks away (panel opening) and pops back as the panel
  // slides out; both returns share one fragment shape so React keeps it mounted.
  const launcher =
    !open || closing || bubbleOut ? (
      <AssistantLauncher
        leaving={open && !closing}
        returning={returning}
        unread={supportOn ? unread : 0}
        record={page.record}
        memberKey={memberKey}
        pathname={pathname}
        onOpen={() => {
          // A reply waits: open the support requests, not a new question.
          if (supportOn && unread > 0) {
            show(true);
            setView("support");
            setSupportId(null);
            void loadSupport();
          } else show(true);
        }}
        onAskRecord={(r) => openAssistant({ record: r })}
      />
    ) : null;
  if (!open)
    return (
      <>
        {launcher}
        {null}
      </>
    );
  const starters = startersFor(anchor?.type ?? "", anchor ? recordState(anchor.id) : undefined);
  const named = anchor ? (labels[anchor.id] ?? recordLabel(anchor.id)) : undefined;
  const anchorLabel = anchor ? (named ?? anchor.id) : null;
  const welcome = anchor
    ? named
      ? `How can I help with ${named}?`
      : `How can I help with this ${anchor.type}?`
    : "How can I help?";
  const column = full && wide && view === "chat" && !!biz;
  const listShown = view === "chat" && !!biz && (column || historyOpen);
  const canDrop = view === "chat" && !shared && !!biz && !(listShown && !column);
  const titled = view === "chat" && !!biz && !shared && !!chat && chat.id === conversation;

  return (
    <>
      {launcher}
      <aside
        ref={asideRef}
        aria-label={ASSISTANT_NAME}
        data-assistant-panel="true"
        data-state={closing ? "closed" : "open"}
        data-entry={motion}
        data-box={box}
        style={
          box === "float"
            ? {
                [corner.side]:
                  corner.side === "left" ? (area?.left ?? 0) + FLOAT_MARGIN : FLOAT_MARGIN,
                [corner.vert]:
                  corner.vert === "top" ? (area?.top ?? 0) + FLOAT_MARGIN : FLOAT_MARGIN,
                width: FLOAT_W,
                // A list keeps one height; a chat is as tall as what it says, up to the cap.
                height: historyOpen || view !== "chat" ? "min(560px, 70dvh)" : "auto",
                // Compact: it never grows past this; a long chat scrolls inside.
                maxHeight: "min(560px, 70dvh)",
                minHeight: 240,
                transformOrigin: `${corner.vert} ${corner.side}`,
              }
            : undefined
        }
        onKeyDown={(e) => {
          // A menu or dialog inside the panel takes its own Escape (Radix marks it handled).
          if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.defaultPrevented) return;
          const layer = (e.target as Element).closest?.(
            '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
          );
          if (layer && !e.currentTarget.contains(layer)) return;
          e.preventDefault();
          if (full) setFull(false);
          else show(false);
        }}
        className={cn(
          "flex h-full flex-col bg-card data-[state=closed]:pointer-events-none",
          // A morph is drawn by the view transition; otherwise a reveal from the bubble or,
          // with no bubble to come from, a sheet from the right edge.
          motion === "slide" &&
            "[--m-x:100%] data-[state=closed]:animate-sheet-out data-[state=open]:animate-sheet-in",
          motion === "reveal" && "billy-reveal",
          // Docked or floating, the box is the same: billy-push.css narrows <main> beside it
          // and drops the float's shadow where the panel shares the screen.
          box === "full"
            ? "fixed inset-0 z-50"
            : box === "float"
              ? "billy-window fixed z-40 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl shadow-xl"
              : "billy-edge absolute inset-y-0 right-0 z-40 w-full bg-popover shadow-xl sm:w-(--billy-w)",
        )}
      >
        {box === "dock" ? <BillyResizeHandle /> : null}
        <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3" {...dragProps}>
          <BillyMark size={20} />
          <h2 className="m-0 flex-1 pl-1.5 text-base font-medium">{ASSISTANT_NAME}</h2>
          {supportOn ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                if (view === "support" && !supportId) return setView("chat");
                setHistoryOpen(false);
                setView("support");
                setSupportId(null);
                void loadSupport();
              }}
              aria-pressed={view === "support"}
              title="Support requests"
              className="relative"
            >
              <LifeBuoy className="size-4" />
              {unread ? (
                <span
                  className="absolute top-1 right-1 size-2 rounded-full bg-destructive"
                  aria-hidden
                />
              ) : null}
              <span className="sr-only">
                {unread ? "Support requests, new reply" : "Support requests"}
              </span>
            </Button>
          ) : null}
          {/* Full screen with room, the history is a column of its own. */}
          {column ? null : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleHistory}
              aria-pressed={historyOpen && view === "chat"}
              title="Chat history"
              disabled={!biz}
            >
              <History className="size-4" />
              <span className="sr-only">Chat history</span>
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={newConversation} title="New chat">
            <SquarePen className="size-4" />
            <span className="sr-only">New chat</span>
          </Button>
          {full ? null : <BillyDockToggle />}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setFull((f) => !f)}
            aria-pressed={full}
            title={full ? "Exit full screen" : "Full screen"}
            className="max-sm:hidden"
          >
            {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            <span className="sr-only">{full ? "Exit full screen" : "Full screen"}</span>
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => show(false)} title="Close">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </Button>
        </header>

        <div className="@container/billy relative flex min-h-0 flex-1">
          {/* 1px wide only when the panel has room for the history column. */}
          <span
            ref={probeRef}
            aria-hidden
            className="pointer-events-none absolute h-0 w-0 @min-[64rem]/billy:w-px"
          />
          {listShown ? (
            <div
              className={cn(
                "flex min-h-0 flex-col",
                column ? "w-72 shrink-0 border-r" : "min-w-0 flex-1",
              )}
            >
              <ChatHistory
                api={historyApi}
                tz={tz}
                current={conversation}
                onOpen={(c) => void openConversation(c)}
                onExit={leaveHistory}
                focusKey={historyFocus}
              />
            </div>
          ) : null}
          {/* Hidden, not unmounted, under the list: the composer keeps its draft. */}
          <div
            className={cn(
              "relative flex min-h-0 min-w-0 flex-1 flex-col",
              listShown && !column && "hidden",
            )}
            // Images dropped on the chat attach the way the file picker does.
            onDragEnter={(e) => {
              if (!canDrop || !hasFiles(e)) return;
              e.preventDefault();
              dragDepth.current++;
              setDropping(true);
            }}
            onDragOver={(e) => {
              if (!canDrop || !hasFiles(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={() => {
              dragDepth.current = Math.max(0, dragDepth.current - 1);
              if (!dragDepth.current) setDropping(false);
            }}
            onDrop={(e) => {
              dragDepth.current = 0;
              setDropping(false);
              if (!canDrop || !hasFiles(e)) return;
              e.preventDefault();
              composerRef.current?.attach(Array.from(e.dataTransfer.files));
            }}
          >
            {dropping ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-1 rounded-xl bg-card/95 px-4 text-center ring-2 ring-primary ring-inset"
              >
                <ImagePlus className="size-6 text-primary" />
                <p className="m-0 text-sm font-medium">Drop images to attach them</p>
                <p className="m-0 text-xs text-muted-foreground">
                  PNG, JPEG or WebP, up to 10 MB each
                </p>
              </div>
            ) : null}
            {titled && chat ? <ChatTitleBar chat={chat} api={historyApi} /> : null}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className={cn("px-4 py-4", full && "mx-auto w-full max-w-3xl")}>
                {view === "support" && supportOn ? (
                  supportId ? (
                    <SupportThread
                      id={supportId}
                      tz={tz}
                      onBack={() => {
                        setSupportId(null);
                        void loadSupport();
                      }}
                      onRead={onSupportRead}
                    />
                  ) : (
                    <SupportList items={supportItems} tz={tz} onOpen={(id) => setSupportId(id)} />
                  )
                ) : !biz ? (
                  <p className="m-0 text-sm text-muted-foreground">
                    Open a business to ask {ASSISTANT_NAME} about its billing.
                  </p>
                ) : shared ? (
                  shared.status === "loading" ? (
                    <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" aria-hidden /> Opening the chat
                    </p>
                  ) : shared.status === "missing" ? (
                    <EmptyState
                      compact
                      icon={<SearchX />}
                      title="We could not find this chat."
                      description="It does not exist, or its owner does not share it with you. Check the link."
                      action={
                        <Button type="button" size="sm" variant="outline" onClick={newConversation}>
                          New chat
                        </Button>
                      }
                    />
                  ) : shared.status === "failed" ? (
                    <ErrorState
                      title="We could not open this chat."
                      description={`${shared.message} Try again.`}
                      action={
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void openShared(shared.id)}
                        >
                          Try again
                        </Button>
                      }
                    />
                  ) : (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-2">
                        <p className="m-0 text-base font-medium wrap-break-word">{shared.title}</p>
                        <Alert tone="info">
                          {shared.owner ?? "A member"} shared this chat. You cannot reply.
                        </Alert>
                      </div>
                      <ReadOnlyMessages messages={shared.messages} biz={biz} tz={tz} />
                    </div>
                  )
                ) : messages.length === 0 ? (
                  <div className="flex flex-col gap-4 pt-4">
                    <BillyMark size={32} />
                    <div className="flex flex-col gap-1">
                      <p className="m-0 text-lg font-medium">{welcome}</p>
                      <p className="m-0 text-sm text-muted-foreground">
                        I read your data, check every figure and show you where to act.
                      </p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {starters.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => send(s)}
                          className="rounded-md border bg-card px-3 py-2 text-left text-sm hover:bg-muted/60"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col">
                    <LiveMessages
                      messages={messages}
                      biz={biz}
                      tz={tz}
                      busy={busy}
                      supportOn={supportOn}
                      conversation={conversation}
                      onSend={(t) => void send(t)}
                      onRetry={retry}
                      onPatch={(i, f) =>
                        setMessages((ms) => ms.map((x, j) => (j === i ? f(x) : x)))
                      }
                      onSupportSent={() => void loadSupport()}
                      onShowMeStart={() => {
                        // Where the panel covers the page, get it out of the way.
                        if (full || !billyPushes()) show(false);
                      }}
                      onTypeOther={() => inputRef.current?.focus()}
                    />
                    <div ref={endRef} />
                  </div>
                )}
              </div>
            </div>

            {/* The support thread has its own reply box: a question here would go to the assistant. */}
            <div
              className={cn(
                "shrink-0 border-t pb-3",
                full && "mx-auto w-full max-w-3xl border-t-0",
                view === "support" && supportOn && "hidden",
                shared && "hidden",
              )}
            >
              <Composer
                biz={biz}
                busy={busy}
                inputRef={inputRef}
                handleRef={composerRef}
                anchor={anchor && anchorLabel ? { type: anchor.type, label: anchorLabel } : null}
                onClearAnchor={() => setAnchor(null)}
                onChangeAnchor={(r) => {
                  setLabels((l) => ({ ...l, [r.id]: r.label }));
                  setAnchor({ type: r.type, id: r.id });
                }}
                placeholder={
                  anchor
                    ? `Ask about this ${anchor.type}. Type @ for a record or / for a task.`
                    : "Ask about your billing. Type @ for a record or / for a task."
                }
                onSend={send}
                onStop={() => {
                  stopRef.current = true;
                  abortRef.current?.abort();
                }}
              />
              {allowance ? (
                <div className="flex items-center gap-2 px-4 pt-2 text-xs text-muted-foreground">
                  <span className="shrink-0">Included use this month</span>
                  <span
                    className="block h-1 flex-1 rounded-full bg-muted"
                    role="progressbar"
                    aria-label="Included use this month"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.min(100, allowance.used_percent)}
                  >
                    <span
                      className="block h-full rounded-full bg-chart-1"
                      style={{ width: `${Math.min(100, allowance.used_percent)}%` }}
                    />
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {Math.min(100, allowance.used_percent)}%
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {historyApi.dialogs}
      </aside>
    </>
  );
}
