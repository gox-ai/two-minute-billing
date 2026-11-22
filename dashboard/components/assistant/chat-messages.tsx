"use client";

import * as React from "react";
import Link from "next/link";
import { Check, FileText, ImageIcon, RotateCcw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type {
  AssistantGuide,
  AssistantProposal,
  AssistantQuestion,
  AssistantTask,
  AttachmentRef,
  FeedbackRating,
  MentionRef,
  MessageExtras,
  SupportDraft,
} from "@/lib/assistant";
import { answerPlainText, unansweredQuestions } from "@/lib/assistant-reply";
import { AnswerMarkdown } from "./answer-markdown";
import { fmtSize } from "./composer";
import { ToolData, type ToolDataItem } from "./tool-data";
import { AnsweredQuestion, QuestionCard } from "./question-card";
import { ProposalCard } from "./proposal-card";
import { SupportCard } from "./support-card";
import { ShowMeButton } from "./show-me";
import { ThinkingIndicator } from "./thinking";
import { TurnSteps } from "./turn-steps";
import { ReplyActions } from "./reply-actions";

/** One message in the panel, and how a stored one reads back. */

export type Step = { id: string; label: string; phase: "running" | "done" | "error" };
export type Figures = {
  checked: number;
  unverified: string[];
  links: string[];
  unverified_links?: string[];
  /** Ids in the answer with no prefix (imported records), by dashboard folder. */
  record_links?: Record<string, string>;
};
export interface Msg {
  /** The stored message's id, once the API has saved it (for feedback). */
  id?: string;
  role: "user" | "assistant";
  content: string;
  steps: Step[];
  data: ToolDataItem[];
  figures: Figures | null;
  error: string | null;
  /** Where to go next after an error, as dashboard paths (the used-up allowance). */
  actions?: Array<{ label: string; href: string }>;
  /** The 80% allowance note under an answer. */
  notice?: string | null;
  suggestions?: string[];
  question?: AssistantQuestion;
  proposal?: AssistantProposal;
  guide?: AssistantGuide;
  /** Cloud: a support request drafted for the member to send. */
  supportDraft?: SupportDraft;
  attachments?: AttachmentRef[];
  mentions?: MentionRef[];
  /** A question sent with a menu task: "Try again" sends it with the same task. */
  tool?: AssistantTask;
  feedback?: FeedbackRating | null;
  streaming?: boolean;
  /** The member selected Stop: the answer ends where it was. */
  stopped?: boolean;
  /** When the turn started, for the seconds shown while Billy works. */
  startedAt?: number;
}

export type StoredMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  steps?: Array<{ name?: string; label: string; ok: boolean }>;
  data?: ToolDataItem[];
  figures?: Figures | null;
  extras?: MessageExtras | null;
  feedback?: FeedbackRating | { rating?: FeedbackRating | null } | null;
} & MessageExtras;

export function fromStored(m: StoredMessage): Msg {
  const x = { ...m, ...(m.extras ?? {}) };
  const fb = typeof m.feedback === "string" ? m.feedback : (m.feedback?.rating ?? null);
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    steps: (m.steps ?? []).map((s, i) => ({
      id: String(i),
      label: s.label,
      phase: s.ok ? "done" : "error",
    })),
    data: m.data ?? [],
    figures: m.figures ?? null,
    error: null,
    suggestions: x.suggestions,
    question: x.question,
    proposal: x.proposal,
    guide: x.guide,
    supportDraft: x.support_draft,
    attachments: x.attachments,
    feedback: fb,
  };
}

export const blank = (role: Msg["role"], content = ""): Msg => ({
  role,
  content,
  steps: [],
  data: [],
  figures: null,
  error: null,
});

/** The follow-up questions of the latest answer, for the chips under it. */
export function followUpsOf(messages: Msg[]): string[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || last.streaming || last.error) return [];
  // A question with options waits for its answer: its options are the next step.
  if (last.question) return [];
  return (last.suggestions ?? []).slice(0, 3);
}

export function FiguresLine({ figures }: { figures: Figures | null }) {
  if (!figures) return null;
  if (figures.unverified.length) {
    return (
      <p className="m-0 text-xs text-warning">
        We could not find{" "}
        {figures.unverified.length === 1 ? "1 figure" : `${figures.unverified.length} figures`} in
        your data. They have a dotted underline. Check them before you use them.
      </p>
    );
  }
  if (figures.checked > 0) {
    return (
      <p className="m-0 inline-flex items-center gap-1 text-xs text-success">
        <Check className="size-3.5" aria-hidden /> Every figure found in your data
      </p>
    );
  }
  return null;
}

export function UserBubble({ m }: { m: Msg }) {
  const chips = [
    ...(m.mentions ?? []).map((x) => ({ key: x.id, icon: FileText, text: `@${x.label}` })),
    ...(m.attachments ?? []).map((a) => ({
      key: a.id,
      icon: ImageIcon,
      text: `${a.name} · ${fmtSize(a.size)}`,
    })),
  ];
  return (
    <div className="flex max-w-[85%] min-w-0 flex-col items-end gap-1 self-end">
      {chips.length ? (
        <div className="flex max-w-full flex-wrap justify-end gap-1">
          {chips.map(({ key, icon: Icon, text }) => (
            <span
              key={key}
              className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 text-xs"
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">{text}</span>
            </span>
          ))}
        </div>
      ) : null}
      <div className="max-w-full rounded-xl bg-muted px-3 py-2 text-sm wrap-break-word whitespace-pre-wrap">
        {m.content}
      </div>
    </div>
  );
}

/** A turn that did not end in an answer. "Try again" sends the same question again. */
function TurnFailed({
  tone,
  title,
  actions,
  onRetry,
}: {
  tone: "error" | "neutral";
  title: string;
  actions?: Array<{ label: string; href: string }>;
  onRetry?: () => void;
}) {
  const retry = onRetry ? (
    <Button type="button" size="sm" variant="outline" onClick={onRetry}>
      <RotateCcw className="size-3.5" aria-hidden /> Try again
    </Button>
  ) : null;
  if (tone === "neutral") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="m-0 text-xs text-muted-foreground">{title}</p>
        {retry}
      </div>
    );
  }
  return (
    <Alert tone="error" title={title}>
      {actions?.length || retry ? (
        <span className="mt-1.5 flex flex-wrap items-center gap-3">
          {actions?.map((a) => (
            <Link key={a.href} href={a.href} className="font-medium text-primary hover:underline">
              {a.label}
            </Link>
          ))}
          {retry}
        </span>
      ) : null}
    </Alert>
  );
}

/**
 * The finished answer for screen readers, once: a polite live region that never reads the
 * tokens as they stream.
 */
function useAnswerAnnouncement(messages: Msg[]): string {
  const last = messages[messages.length - 1];
  const streaming = last?.role === "assistant" && !!last.streaming;
  const [was, setWas] = React.useState(streaming);
  const [text, setText] = React.useState("");
  if (was !== streaming) {
    setWas(streaming);
    if (!streaming && last?.role === "assistant")
      setText(
        last.error ??
          (last.stopped
            ? "You stopped this answer."
            : answerPlainText(last.content).slice(0, 1500)),
      );
  }
  return text;
}

/** The open chat: questions, answers and what can be done with them. */
export function LiveMessages({
  messages,
  biz,
  tz,
  busy,
  supportOn,
  conversation,
  onSend,
  onRetry,
  onPatch,
  onSupportSent,
  onShowMeStart,
  onTypeOther,
}: {
  messages: Msg[];
  biz: string;
  tz: string;
  busy: boolean;
  supportOn: boolean;
  conversation: string | null;
  onSend: (text: string) => void;
  /** Send the question at this index again, in place of its failed turn. */
  onRetry: (userIndex: number) => void;
  onPatch: (index: number, f: (m: Msg) => Msg) => void;
  onSupportSent: () => void;
  onShowMeStart: () => void;
  onTypeOther: () => void;
}) {
  const announce = useAnswerAnnouncement(messages);
  const unanswered = unansweredQuestions(messages);
  const lastIndex = messages.length - 1;
  const followUps = followUpsOf(messages);
  return (
    <div className="flex flex-col gap-5">
      {messages.map((m, i) => {
        if (m.role === "user") {
          return (
            <React.Fragment key={i}>
              <UserBubble m={m} />
              {unanswered.has(i) ? (
                <TurnFailed
                  tone="neutral"
                  title="We did not save an answer to this question."
                  onRetry={i === lastIndex && !busy ? () => onRetry(i) : undefined}
                />
              ) : null}
            </React.Fragment>
          );
        }
        const next = messages[i + 1];
        const isLast = i === lastIndex;
        let asked = -1;
        for (let j = i - 1; j >= 0; j--)
          if (messages[j]!.role === "user") {
            asked = j;
            break;
          }
        const retry = isLast && !busy && asked >= 0 ? () => onRetry(asked) : undefined;
        const finished = !m.streaming && !m.error && !!m.content;
        return (
          <div key={i} className="group/reply anim-fade flex min-w-0 flex-col gap-2.5">
            <TurnSteps steps={m.steps} live={!!m.streaming} />
            {m.content ? (
              <AnswerMarkdown
                text={m.content}
                biz={biz}
                unverified={m.figures?.unverified ?? []}
                records={m.figures?.record_links}
              />
            ) : null}
            {m.streaming && !m.error ? (
              <ThinkingIndicator steps={m.steps} hasText={!!m.content} startedAt={m.startedAt} />
            ) : null}
            {m.guide && !m.streaming ? (
              <ShowMeButton guide={m.guide} onStart={onShowMeStart} />
            ) : null}
            {m.data.length ? <ToolData items={m.data} biz={biz} tz={tz} /> : null}
            {m.question ? (
              next?.role === "user" ? (
                <AnsweredQuestion q={m.question} answer={next.content} />
              ) : isLast && !m.streaming ? (
                <QuestionCard
                  q={m.question}
                  disabled={busy}
                  onAnswer={(t) => onSend(t)}
                  onTypeOther={onTypeOther}
                />
              ) : null
            ) : null}
            {m.proposal ? <ProposalCard key={m.proposal.id} p={m.proposal} tz={tz} /> : null}
            {m.supportDraft && supportOn && !m.streaming ? (
              <SupportCard
                key={m.supportDraft.id}
                draft={m.supportDraft}
                biz={biz}
                conversation={conversation}
                onSent={(sent) => {
                  onPatch(i, (x) =>
                    x.supportDraft ? { ...x, supportDraft: { ...x.supportDraft, sent } } : x,
                  );
                  onSupportSent();
                }}
              />
            ) : null}
            {finished ? <FiguresLine figures={m.figures} /> : null}
            {m.stopped && !m.error ? (
              <TurnFailed tone="neutral" title="You stopped this answer." onRetry={retry} />
            ) : null}
            {finished ? (
              <ReplyActions
                m={m}
                latest={isLast}
                canAskAgain={!busy && asked >= 0}
                onAskAgain={() => asked >= 0 && onSend(messages[asked]!.content)}
                onRated={(rating) => onPatch(i, (x) => ({ ...x, feedback: rating }))}
              />
            ) : null}
            {isLast && !busy && followUps.length ? (
              <div
                role="group"
                aria-label="Suggested questions"
                className="flex flex-wrap gap-1.5 pt-1"
              >
                {followUps.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => onSend(q)}
                    className="max-w-full rounded-xl border bg-card px-3 py-1 text-left text-xs transition-colors hover:bg-muted/60"
                  >
                    {q}
                  </button>
                ))}
              </div>
            ) : null}
            {m.notice ? <p className="m-0 text-xs text-muted-foreground">{m.notice}</p> : null}
            {m.error ? (
              <TurnFailed
                tone="error"
                title={m.error}
                actions={m.actions}
                // A used-up allowance names its own next steps; asking again would only fail again.
                onRetry={m.actions?.length ? undefined : retry}
              />
            ) : null}
          </div>
        );
      })}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

/**
 * A shared chat as its reader sees it: questions, answers, the data behind them. Nothing
 * here writes — no proposals to confirm, no support drafts, no feedback, no follow-ups, no
 * retry. Copy is the one action.
 */
export function ReadOnlyMessages({
  messages,
  biz,
  tz,
}: {
  messages: Msg[];
  biz: string;
  tz: string;
}) {
  return (
    <div className="flex flex-col gap-5">
      {messages.map((m, i) => {
        if (m.role === "user") return <UserBubble key={i} m={m} />;
        const next = messages[i + 1];
        return (
          <div key={i} className="group/reply flex min-w-0 flex-col gap-2.5">
            <TurnSteps steps={m.steps} live={false} />
            {m.content ? (
              <AnswerMarkdown
                text={m.content}
                biz={biz}
                unverified={m.figures?.unverified ?? []}
                records={m.figures?.record_links}
              />
            ) : null}
            {m.data.length ? <ToolData items={m.data} biz={biz} tz={tz} /> : null}
            {m.question && next?.role === "user" ? (
              <AnsweredQuestion q={m.question} answer={next.content} />
            ) : null}
            {m.content ? <FiguresLine figures={m.figures} /> : null}
            {m.content ? <ReplyActions m={m} latest={i === messages.length - 1} readOnly /> : null}
          </div>
        );
      })}
    </div>
  );
}
