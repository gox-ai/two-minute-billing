import * as React from "react";
import { Alert } from "@/components/ui/alert";

/** One live resend: what was sent and what came back. Shared by webhooks and integrations. */
export interface AttemptLike {
  outcome: string;
  latency_ms: number;
  error: string | null;
  request: { method?: string; url: string; headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string } | null;
}

/**
 * The verdict first, then the request and response, collapsed. The engine does not store the
 * transcript, so the caller renders it from the resend result it holds.
 */
export function AttemptTranscript({
  attempt,
  subject = "your webhook notification",
}: {
  attempt: AttemptLike;
  /** What was resent, as the verdict names it. */
  subject?: string;
}) {
  return (
    <div className="space-y-3">
      <Alert
        tone={attempt.response ? (attempt.response.status < 300 ? "success" : "warning") : "error"}
      >
        {attempt.response
          ? `Resent ${subject}. The receiver answered HTTP ${attempt.response.status} in ${attempt.latency_ms}ms.`
          : `Resent ${subject}, but no response came back: ${attempt.error ?? "the request failed"}.`}
        {attempt.outcome === "retrying"
          ? " It stays in the queue, so the billing clock retries it on its own schedule."
          : null}
      </Alert>

      <TranscriptPanel
        title="Request sent"
        head={`${attempt.request.method ?? "POST"} ${attempt.request.url}`}
        headers={attempt.request.headers}
        body={attempt.request.body}
      />
      {attempt.response ? (
        <TranscriptPanel
          title="Response received"
          head={`HTTP ${attempt.response.status}`}
          headers={attempt.response.headers}
          body={attempt.response.body}
        />
      ) : (
        // No empty panel: "sent nothing back" and "never reached" are different faults.
        <p className="text-xs text-muted-foreground">
          No response to show. The request did not reach a server that answered.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        We show this for this resend only. We do not store request or response contents, so this
        disappears when you leave the page.
      </p>
    </div>
  );
}

/** Headers + body of one side of the exchange, collapsed, scrolling inside its own box. */
function TranscriptPanel({
  title,
  head,
  headers,
  body,
}: {
  title: string;
  head: string;
  headers: Record<string, string>;
  body: string;
}) {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return (
    <details className="rounded-md bg-muted/50">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs font-medium">
        <span>{title}</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground">{head}</span>
      </summary>
      <div className="space-y-3 px-3 pb-3">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Headers</p>
          {/* Wide content scrolls in its own container — the page body must never scroll sideways. */}
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
            {lines.length ? lines.join("\n") : "(none)"}
          </pre>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Body</p>
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
            {body || "(empty)"}
          </pre>
        </div>
      </div>
    </details>
  );
}
