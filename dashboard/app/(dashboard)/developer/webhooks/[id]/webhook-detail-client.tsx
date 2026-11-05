"use client";

import * as React from "react";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useDefaultState } from "@/lib/use-default-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/status-badge";
import { ActionForm } from "@/components/form/action-form";
import { RecordCard, Row } from "@/components/patterns/record-page";
import { EVENT_TYPES, groupEventTypes } from "@/lib/api/event-types";
import type { WebhookEndpointDetail } from "@/lib/api/developer";
import type { ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/utils";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";

// Extended ActionResult that carries test-send response fields.
type TestSendResult = ActionResult & {
  response_status?: number;
  latency_ms?: number;
  delivered?: boolean;
};

type TestSendAction = (prev: TestSendResult | null, formData: FormData) => Promise<TestSendResult>;

export function WebhookDetailClient({
  endpoint,
  updateAction,
  testAction,
  resendAction,
  requeueAction,
}: {
  endpoint: WebhookEndpointDetail;
  updateAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  testAction: TestSendAction;
  /** Server action, passed in like the others — this is a client component. */
  resendAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  requeueAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}) {
  // Re-seeded from the saved endpoint, so the next save cannot post a stale subscription.
  const [allEvents, setAllEvents] = useDefaultState(endpoint.event_types === null);
  const [checked, setChecked] = useDefaultState<Set<string>>(
    new Set(endpoint.event_types ?? []),
    (v) => [...v].sort().join(","),
  );
  const groups = React.useMemo(() => groupEventTypes(), []);

  // Test send
  const [resendState, resendFormAction, resendPending] = useActionState<
    ActionResult | null,
    FormData
  >(resendAction, null);
  const seenResend = useRef<ActionResult | null>(null);
  useEffect(() => {
    if (!resendState || resendState === seenResend.current) return;
    seenResend.current = resendState;
    // A 409 on a history-less endpoint is an ordinary answer, not a failure — say what the
    // engine said rather than reporting an error the operator cannot act on.
    if (resendState.ok) toast.success(resendState.message ?? "Queued for resend");
    else if (resendState.message) toast.message(resendState.message);
  }, [resendState]);

  const [requeueState, requeueFormAction, requeuePending] = useActionState<
    ActionResult | null,
    FormData
  >(requeueAction, null);
  const seenRequeue = useRef<ActionResult | null>(null);
  useEffect(() => {
    if (!requeueState || requeueState === seenRequeue.current) return;
    seenRequeue.current = requeueState;
    // "Nothing to requeue" is an ordinary answer, not an error — say what happened either way.
    if (requeueState.ok) toast.success(requeueState.message ?? "Requeued");
    else if (requeueState.message) toast.error(requeueState.message);
  }, [requeueState]);

  const [testState, testFormAction, testPending] = useActionState<TestSendResult | null, FormData>(
    testAction,
    null,
  );
  const seenTest = React.useRef<TestSendResult | null>(null);
  React.useEffect(() => {
    if (!testState || testState === seenTest.current) return;
    seenTest.current = testState;
    if (!testState.ok && testState.message) toast.error(testState.message);
  }, [testState]);

  function toggleAll() {
    if (!allEvents) setChecked(new Set(EVENT_TYPES));
    setAllEvents((v) => !v);
  }

  function toggleType(t: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  return (
    <Row span="8/4">
      {/* Description + event types editor */}
      <RecordCard title="Subscription settings">
        <ActionForm action={updateAction} className="space-y-5">
          <input type="hidden" name="id" value={endpoint.id} />

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              name="description"
              defaultValue={endpoint.description ?? ""}
              placeholder="Optional note about this endpoint"
              maxLength={500}
            />
          </div>

          {/* Event types */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Subscribed events</Label>
              <CheckboxField
                name="all_events"
                value="true"
                checked={allEvents}
                onCheckedChange={toggleAll}
                label="All events"
              />
            </div>

            {!allEvents && (
              <div className="max-h-72 space-y-4 overflow-y-auto rounded-md border p-3">
                {Object.entries(groups).map(([prefix, types]) => (
                  <div key={prefix}>
                    <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      {prefix}
                    </p>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {types.map((t) => (
                        <CheckboxField
                          key={t}
                          name="event_type"
                          value={t}
                          checked={checked.has(t)}
                          onCheckedChange={() => toggleType(t)}
                          label={<span className="font-mono text-xs">{t}</span>}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {allEvents && (
              <p className="text-sm text-muted-foreground">
                We deliver all event types to this endpoint.
              </p>
            )}
          </div>

          <Button type="submit">Save settings</Button>
        </ActionForm>
      </RecordCard>

      {/* Test send */}
      <RecordCard title="Test send">
        <form action={testFormAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={endpoint.id} />
          <div className="space-y-1.5">
            <Label htmlFor="test-type">Event type</Label>
            <SelectField
              id="test-type"
              name="type"
              defaultValue={EVENT_TYPES[0]}
              ariaLabel="Event type"
              className="w-72 max-w-full"
              options={EVENT_TYPES.map((t) => ({ value: t, label: t }))}
            />
          </div>
          <Button type="submit" disabled={testPending} variant="outline">
            {testPending ? "Sending…" : "Send test event"}
          </Button>
        </form>

        {/* The OTHER half of a health check, and deliberately next to it so the difference is
            visible: the test above signs a sample and posts it straight at the URL — it proves
            reachability and that the signature verifies, and nothing about the retry path,
            because it never touches the outbox and leaves no delivery row. This one pushes the
            endpoint's most recent delivery back through the REAL outbox, so it exercises retry
            and is recorded. It needs history, which is why it is not the first thing offered on
            a brand-new endpoint. */}
        <form action={resendFormAction} className="mt-4 flex flex-col items-start gap-1.5">
          <input type="hidden" name="endpoint_id" value={endpoint.id} />
          <Button type="submit" disabled={resendPending} variant="outline">
            {resendPending ? "Resending…" : "Resend latest delivery"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Replays the most recent delivery through the outbox. Use this after you correct a
            receiver.
          </span>
        </form>

        {/*
          The backlog version, and deliberately a different mechanism from Resend above: that one
          POSTs INLINE to hand back a live transcript, which is right for one delivery and
          unusable for a backlog — 28 dead deliveries at up to 10s each is a request nobody waits
          out. This writes fresh pending rows and lets the clock send them, so the replay gets the
          real retry ladder and circuit breaker, and the page comes back at once with a count.
        */}
        <form action={requeueFormAction} className="mt-4 flex flex-col items-start gap-1.5">
          <input type="hidden" name="endpoint_id" value={endpoint.id} />
          <Button type="submit" disabled={requeuePending} variant="outline">
            {requeuePending ? "Requeueing…" : "Requeue all failed"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Queues every failed delivery again, up to 500. An event that is already waiting is
            skipped. No event is sent two times.
          </span>
        </form>

        {testState?.ok && testState.response_status !== undefined && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-4 py-3 text-sm">
            <span>
              HTTP{" "}
              <span
                className={cn(
                  "font-mono font-semibold",
                  testState.delivered ? "text-success" : "text-destructive",
                )}
              >
                {testState.response_status}
              </span>
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{testState.latency_ms} ms</span>
            <StatusBadge status={testState.delivered ? "delivered" : "failed"} />
          </div>
        )}

        {testState && !testState.ok && testState.message && (
          <p className="mt-3 text-sm text-destructive">{testState.message}</p>
        )}
      </RecordCard>
    </Row>
  );
}
