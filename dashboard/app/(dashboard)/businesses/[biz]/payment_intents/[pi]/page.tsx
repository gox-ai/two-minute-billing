import type { ReactNode } from "react";
import Link from "next/link";
import { listBusinesses } from "@/lib/api";
import {
  getPaymentIntent,
  type PaymentAttemptWithMethod,
  type PaymentIntentDetail,
} from "@/lib/api/payments";
import { requirePermission } from "@/lib/session";
import { InstrumentMark } from "@/components/brand/instrument-mark";
import { StatusChip, IdChip, Chip } from "@/components/patterns/chip";
import { CopyButton } from "@/components/patterns/copy-button";
import {
  AttentionCard,
  Facts,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Zone,
  type AttentionItem,
} from "@/components/patterns/record-page";
import { MoreMenu, MoreSection } from "@/components/patterns/more-menu";
import { Paged, PagedFooter, PagedItems } from "@/components/patterns/pager";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { ActionButton } from "@/components/action-button";
import { voidPaymentIntentAction } from "../actions";
import { EmptyState, ErrorState } from "@/components/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { displayIntentStatus } from "@/lib/payment-intent-status";
import { fmtDateTime, money } from "@/lib/format";
import { Wallet } from "lucide-react";
import { GatewayLabel } from "@/components/partner-logo";
import { gatewayLogsHref } from "@/lib/gateway-logs-href";

export const dynamic = "force-dynamic";

/**
 * Payment-intent detail, from `GET /payment_intents/:pi`: the intent with its joined
 * customer, gateway account and card, every attempt WITH the instrument it was tried
 * with, and `voided_transaction` when a void booked one.
 */
export default async function PaymentIntentDetailPage({
  params,
}: {
  params: Promise<{ biz: string; pi: string }>;
}) {
  const { biz, pi } = await params;
  await requirePermission("payments:view", "ops");

  let businesses, intent: PaymentIntentDetail;
  try {
    [businesses, intent] = await Promise.all([listBusinesses(), getPaymentIntent(biz, pi)]);
  } catch (e) {
    return (
      <div className="flex flex-col gap-4">
        <RecordCrumbs
          items={[
            { label: biz, href: `/businesses/${biz}` },
            { label: "Payment intents", href: `/businesses/${biz}/payment_intents` },
            { label: pi },
          ]}
          right={<PageRefresh />}
        />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </div>
    );
  }

  const bizRow = businesses.data.find((b) => b.id === biz);
  const name = bizRow?.name ?? biz;
  // Server component: resolve the business timezone here, not from the BusinessTz context.
  const tz = bizRow?.timezone ?? null;

  const attempts = intent.attempts ?? [];
  /** The attempt that ended the intent, if one did — its `updated_at` is when. */
  const consumedAttempt = attempts.find((a) => a.status === "consumed");

  // The header says what HAPPENED; the summary keeps the stored value, which is what
  // the API returns and the list's status segments filter on.
  const displayStatus = displayIntentStatus(intent, attempts);
  const statusDiverges = displayStatus !== intent.status;

  // `payment_intents.customer_id` is nullable; a card of em-dashes says nothing.
  const hasCustomer = Boolean(
    intent.customer ||
    intent.customer_name ||
    intent.customer_first_name ||
    intent.customer_last_name ||
    intent.customer_email ||
    intent.customer_phone,
  );
  const hasSplitName = Boolean(intent.customer_first_name || intent.customer_last_name);
  const customerLabel =
    intent.customer_name ||
    [intent.customer_first_name, intent.customer_last_name].filter(Boolean).join(" ") ||
    intent.customer_email ||
    intent.customer;

  /**
   * Mirrors `voidPaymentIntent`'s own refusals: consumed and already-voided are named
   * errors there. `expired` stays voidable — expiry releases our claim, not the
   * gateway's hold.
   */
  const canVoid = !intent.voided_at && intent.status !== "consumed" && intent.status !== "voided";

  const hasAmount = intent.amount_minor != null && intent.currency;
  const amountText = hasAmount
    ? money(intent.amount_minor as number, intent.currency as string)
    : "—";
  const nextAction = isObject(intent.next_action) ? intent.next_action : null;

  const attention: AttentionItem[] = (
    [
      statusDiverges
        ? {
            key: "refused",
            tone: "attention" as const,
            title: "The gateway refused the newest attempt",
            detail:
              "An intent has no failed status of its own. It stays open for another attempt. It expires at its expiry time unless someone retries or voids it.",
          }
        : null,
      // The gateway handed back a step the buyer still has to complete.
      !statusDiverges && nextAction && intent.status === "in_progress"
        ? {
            key: "next_action",
            tone: "warning" as const,
            title: "Waiting for the buyer",
            detail: `The gateway returned a next step that the buyer must still complete${
              intent.expires_at ? ` · expires ${fmtDateTime(intent.expires_at, tz)}` : ""
            }`,
          }
        : null,
    ] as Array<AttentionItem | null>
  ).filter((i): i is AttentionItem => i !== null);

  // Newest first; every node is a timestamp the API returned. `consumed` has no column
  // of its own, so it is dated by the attempt that consumed it.
  const timeline: Array<{ label: string; date: ReactNode } | null> = [
    intent.voided_at
      ? {
          label: "Intent voided",
          // The reversal transaction only when the API returned one — never inferred.
          date: (
            <>
              {fmtDateTime(intent.voided_at, tz)}
              {intent.voided_transaction ? (
                <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                  {intent.voided_transaction.id}
                </span>
              ) : null}
            </>
          ),
        }
      : null,
    intent.status === "expired" && intent.expires_at
      ? { label: "Intent expired", date: fmtDateTime(intent.expires_at, tz) }
      : null,
    consumedAttempt
      ? { label: "Intent consumed", date: fmtDateTime(consumedAttempt.updated_at, tz) }
      : null,
    ...[...attempts].reverse().map((a) => ({
      label: `Attempt ${a.attempt_number} · ${a.status.replace(/_/g, " ")}`,
      date: fmtDateTime(a.created_at, tz),
    })),
    { label: "Intent created", date: fmtDateTime(intent.created_at, tz) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: name, href: `/businesses/${biz}` },
          { label: "Payment intents", href: `/businesses/${biz}/payment_intents` },
          { label: intent.id },
        ]}
        right={<PageRefresh />}
      />

      <RecordHeader
        title="Payment intent"
        chips={
          <>
            <StatusChip status={displayStatus} />
            <Chip>{intent.purpose === "setup" ? "Setup" : "Payment"}</Chip>
          </>
        }
        facts={[
          hasAmount ? (
            <span key="amt" className="tabular-nums">
              {amountText} {intent.currency}
            </span>
          ) : null,
          hasCustomer && intent.customer ? (
            <Link
              key="cus"
              href={`/businesses/${biz}/customers/${intent.customer}`}
              className="font-medium text-primary hover:underline"
            >
              {customerLabel}
            </Link>
          ) : null,
          intent.gateway_key ?? null,
          fmtDateTime(intent.created_at, tz),
          <IdChip key="id" label="Intent ID" id={intent.id} />,
        ]}
        actions={
          canVoid ? (
            <MoreMenu>
              <MoreSection>
                {/* A gateway without `intentVoid` answers "unsupported"; the refusal
                    surfaces through the action's toast, and nothing changes here. */}
                <ActionButton
                  resultAction={voidPaymentIntentAction}
                  fields={{ biz, pi: intent.id }}
                  label="Void intent"
                  variant="link"
                  size="sm"
                  className="text-destructive"
                  confirm={{
                    title: "Void this intent at the gateway?",
                    description:
                      "Cancels the intent at the gateway. The customer can then pay the invoice in a different way. If the gateway already took the money, the gateway refuses and nothing changes here. This action cannot void a paid intent.",
                    confirmLabel: "Void intent",
                    destructive: true,
                  }}
                />
              </MoreSection>
            </MoreMenu>
          ) : null
        }
      />

      <AttentionCard items={attention} />

      <Zone title="Intent">
        <Row span="8/4">
          <RecordCard
            id="intent_summary"
            title="Summary"
            actions={
              // `tab=list` is load-bearing: /transactions opens on its analytics tab,
              // whose own table ignores this filter.
              <Link
                href={`/businesses/${biz}/transactions?tab=list&payment_intent%5Bis%5D=${encodeURIComponent(intent.id)}`}
                className="text-primary hover:underline"
              >
                View transactions
              </Link>
            }
          >
            <Facts
              rows={[
                // The STORED value — the one that matches the API and the list segments.
                { label: "Intent status", value: <StatusChip status={intent.status} /> },
                // `setup` only vaults a card, which is why most rows are $0.00.
                {
                  label: "Type",
                  value: intent.purpose === "setup" ? "Setup (card on file)" : "Payment",
                },
                {
                  label: "Total attempts",
                  value: <span className="tabular-nums">{intent.attempt_count}</span>,
                },
                {
                  label: "Amount",
                  // Blank, not $0.00: a setup intent has no amount.
                  value: hasAmount ? (
                    <span className="tabular-nums">
                      {amountText}{" "}
                      <span className="text-xs text-muted-foreground">{intent.currency}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  ),
                },
                // The account label says WHICH account on a gateway authorized this.
                intent.gateway_key
                  ? {
                      label: "Gateway",
                      value: (
                        <span>
                          <GatewayLabel gatewayKey={intent.gateway_key} fit />
                          {intent.gateway_account_label ? (
                            <span className="block text-xs text-muted-foreground">
                              {intent.gateway_account_label}
                            </span>
                          ) : null}
                        </span>
                      ),
                    }
                  : null,
                { label: "Created at", value: fmtDateTime(intent.created_at, tz) },
                // The mandate ceiling (0174) explains a $0.00 setup intent; null elsewhere.
                intent.purpose === "setup" && intent.max_amount_minor != null && intent.currency
                  ? {
                      label: "Mandate ceiling",
                      value: (
                        <span className="tabular-nums">
                          {money(intent.max_amount_minor, intent.currency)}{" "}
                          <span className="text-xs text-muted-foreground">per debit</span>
                        </span>
                      ),
                    }
                  : null,
                intent.expires_at
                  ? { label: "Expires at", value: fmtDateTime(intent.expires_at, tz) }
                  : null,
                intent.voided_at
                  ? { label: "Voided at", value: fmtDateTime(intent.voided_at, tz) }
                  : null,
                // What the buyer still has to do — why an intent sits at `in_progress`.
                nextAction
                  ? {
                      label: "Next action",
                      value: (
                        <pre className="max-h-48 overflow-y-auto rounded-md bg-muted p-3 font-mono text-xs wrap-anywhere whitespace-pre-wrap">
                          {JSON.stringify(nextAction, null, 2)}
                        </pre>
                      ),
                    }
                  : null,
              ]}
            />
          </RecordCard>
          <RecordCard id="timeline" title="Timeline">
            <ol className="flex flex-col gap-2.5 text-sm">
              {timeline.filter(Boolean).map((e, i) => {
                const entry = e as { label: string; date: ReactNode };
                return (
                  <li key={i} className="grid grid-cols-[8px_minmax(0,1fr)] gap-3">
                    <span
                      aria-hidden
                      className="mt-1.5 size-2 rounded-full bg-muted-foreground/50"
                    />
                    <div className="min-w-0">
                      <div className="font-medium">{entry.label}</div>
                      <div className="text-xs text-muted-foreground tabular-nums">{entry.date}</div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </RecordCard>
        </Row>
        {hasCustomer ? (
          <Row span="12">
            <RecordCard id="customer_information" title="Customer">
              <Facts
                rows={[
                  // First/last and a display name are stored separately, and a display
                  // name cannot be split — show whichever the customer has.
                  hasSplitName
                    ? { label: "First name", value: intent.customer_first_name ?? "—" }
                    : null,
                  hasSplitName
                    ? { label: "Last name", value: intent.customer_last_name ?? "—" }
                    : null,
                  !hasSplitName && intent.customer_name
                    ? { label: "Name", value: intent.customer_name }
                    : null,
                  intent.customer_email
                    ? {
                        label: "Email",
                        value: <WithCopy value={intent.customer_email} />,
                      }
                    : null,
                  intent.customer_phone ? { label: "Phone", value: intent.customer_phone } : null,
                  intent.customer
                    ? {
                        label: "Customer",
                        value: (
                          <WithCopy value={intent.customer}>
                            <Link
                              href={`/businesses/${biz}/customers/${intent.customer}`}
                              className="font-mono text-xs text-primary hover:underline"
                            >
                              {intent.customer}
                            </Link>
                          </WithCopy>
                        ),
                      }
                    : null,
                ]}
              />
            </RecordCard>
          </Row>
        ) : null}
      </Zone>

      <Zone title="Attempts">
        <Row span="12">
          <RecordCard
            id="attempts"
            title="Attempts"
            meta={attempts.length ? String(attempts.length) : undefined}
            flush={attempts.length > 0}
          >
            {attempts.length === 0 ? (
              <EmptyState
                icon={<Wallet />}
                title="No attempts recorded"
                description="This intent has no payment attempts yet."
              />
            ) : (
              <Paged
                size={10}
                items={[...attempts]
                  .sort((a, b) => b.attempt_number - a.attempt_number)
                  .map((a) => (
                    <AttemptRow key={a.id} biz={biz} attempt={a} tz={tz} />
                  ))}
              >
                <Table className="table-fixed max-lg:min-w-3xl">
                  <colgroup>
                    {/* Status fits "requires action" at the 1024px card width. */}
                    <col className="w-[13%]" />
                    <col className="w-[20%]" />
                    <col className="w-[13%]" />
                    <col className="w-[14%]" />
                    <col />
                    <col className="w-[13%]" />
                    <col className="w-[13%]" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">Attempt</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Payment method</TableHead>
                      <TableHead>Gateway transaction id</TableHead>
                      <TableHead>Error</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="pr-5">Gateway calls</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <PagedItems />
                  </TableBody>
                </Table>
                <PagedFooter />
              </Paged>
            )}
          </RecordCard>
        </Row>
      </Zone>
    </div>
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function WithCopy({ value, children }: { value: string; children?: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <span className="min-w-0 wrap-anywhere">{children ?? value}</span>
      <CopyButton value={value} className="shrink-0" />
    </span>
  );
}

/**
 * One attempt. The logs link filters Gateway Requests on the trace id — the ONLY key
 * correlating an attempt with `gateway_request_logs` (platform-global, no FK). With no
 * trace id there is no link: an unfiltered log would look like it all belongs here.
 */
function AttemptRow({
  biz,
  attempt,
  tz,
}: {
  biz: string;
  attempt: PaymentAttemptWithMethod;
  tz: string | null;
}) {
  // The attempt's OWN instrument: a retry can use a different card.
  const hasMethod =
    attempt.payment_method_brand || attempt.payment_method_last4 || attempt.payment_method_type;
  return (
    <TableRow className="align-top">
      <TableCell className="py-3 pl-5 whitespace-normal">
        <div className="font-medium">Attempt {attempt.attempt_number}</div>
        <span className="mt-0.5 flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-xs text-muted-foreground">{attempt.id}</span>
          <CopyButton value={attempt.id} className="shrink-0" />
        </span>
      </TableCell>
      <TableCell className="py-3">
        <StatusChip status={attempt.status} />
      </TableCell>
      <TableCell className="py-3 whitespace-normal">
        {hasMethod ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <InstrumentMark
              brand={attempt.payment_method_brand}
              type={attempt.payment_method_type}
              last4={attempt.payment_method_last4}
              className="h-3.5 w-6"
            />
            {attempt.payment_method_brand ?? attempt.payment_method_type}
            {attempt.payment_method_last4 ? (
              <span className="text-muted-foreground">···· {attempt.payment_method_last4}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="py-3 whitespace-normal">
        {attempt.id_at_gateway ? (
          <span className="flex min-w-0 items-center gap-1">
            <span className="font-mono text-xs wrap-anywhere">{attempt.id_at_gateway}</span>
            <CopyButton value={attempt.id_at_gateway} className="shrink-0" />
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="py-3 whitespace-normal">
        {attempt.error_code || attempt.error_text ? (
          <div className="flex min-w-0 flex-col gap-0.5 text-destructive">
            {attempt.error_code ? (
              <span className="font-mono text-xs wrap-anywhere">{attempt.error_code}</span>
            ) : null}
            {attempt.error_text ? (
              <span className="wrap-anywhere">{attempt.error_text}</span>
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="py-3 whitespace-normal tabular-nums">
        {fmtDateTime(attempt.created_at, tz)}
        <span className="mt-0.5 block text-xs text-muted-foreground">
          Updated {fmtDateTime(attempt.updated_at, tz)}
        </span>
      </TableCell>
      <TableCell className="py-3 pr-5 whitespace-normal">
        {attempt.trace_id ? (
          <>
            <Link href={gatewayLogsHref(biz, attempt)!} className="text-primary hover:underline">
              Request/
              <wbr />
              response logs
            </Link>
            <span className="mt-0.5 flex min-w-0 items-center gap-1">
              <span className="truncate font-mono text-xs text-muted-foreground">
                {attempt.trace_id}
              </span>
              <CopyButton value={attempt.trace_id} className="shrink-0" />
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">No traced gateway calls</span>
        )}
        {/* What the gateway told US. A refusal confirmed in the buyer's browser exists only here. */}
        {attempt.id_at_gateway ? (
          <Link
            href={`/businesses/${biz}/gateway_webhooks?intent%5Bis%5D=${encodeURIComponent(attempt.id_at_gateway)}`}
            className="mt-1.5 block text-primary hover:underline"
          >
            Webhook events
          </Link>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
