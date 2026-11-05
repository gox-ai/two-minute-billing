"use client";

// Client because every row carries its own <ActionForm>, and the filters are local state.

import * as React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SelectField } from "@/components/ui/select-field";
import { TableSearch } from "@/components/table-search";
import { Chip } from "@/components/patterns/chip";
import { More, SettingsCard } from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import type { DeclineRule, DeclineRuleList, DeclineCodeOverride } from "@/lib/api/decline-rules";
import {
  setDeclineRuleAction,
  resetDeclineRuleAction,
  setDeclineCodeAction,
  resetDeclineCodeAction,
} from "@/app/(dashboard)/businesses/[biz]/settings/decline-rules/actions";

/**
 * Every gateway decline we recognise, and what this business has decided about it.
 *
 * Three columns exist rather than one because a merchant needs to see that they changed
 * something, and what it was before: `Built in` is ours, `Retry` and `Tell the customer`
 * are what the engine will actually do, and a row that differs is marked. A screen showing
 * only the outcome could not honestly offer the reset this page's DELETE exists for.
 */
/**
 * A dotted identifier with break points at its own segment boundaries.
 *
 * `wrap-anywhere` is load-bearing on these cells and must stay (see the note at
 * the rule id: `break-word` does not reduce min-content width, so the id forced
 * 432px into a 352px box). But "anywhere" is also where it broke —
 * `stripe.table.payment_intent_authenti / cation_failure` on screen at 1600px.
 *
 * `<wbr />` adds PREFERRED break opportunities. The browser takes a normal break
 * when one is in range and only falls back to an arbitrary position when none is,
 * so the min-content reduction is unchanged and the breaks land after the dots
 * and underscores instead of inside a word.
 */
function BreakableId({ value, className }: { value: string; className?: string }) {
  const parts = value.split(/(?<=[._])/);
  return (
    <span className={className}>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {part}
          {i < parts.length - 1 ? <wbr /> : null}
        </React.Fragment>
      ))}
    </span>
  );
}

export function DeclineRuleTable({ biz, list }: { biz: string; list: DeclineRuleList }) {
  const [gateway, setGateway] = React.useState("");
  const [family, setFamily] = React.useState("");
  const [changedOnly, setChangedOnly] = React.useState(false);
  /**
   * SETTLED search text, never the keystroke.
   *
   * `q` used to be bound to the input in this component, alongside 81 rendered
   * rules — so every character re-rendered all of them to produce a table that
   * had not changed. Measured, production build: ~20ms of synchronous work per
   * keystroke at 67 visible rows, 2ms at one. The rows were the cost.
   *
   * `useDeferredValue` was tried first and MEASURED NOT TO HELP (still ~20ms): it
   * spares the second filter pass, but the component re-renders either way and
   * reconciling the rows is what costs. Keeping the volatile state in `TableSearch`
   * — below this component in the tree — is what actually fixes it, and it is the
   * same shape `DataTable` uses, so both searches now behave alike.
   */
  const [q, setQ] = React.useState("");
  const [configurableOnly, setConfigurableOnly] = React.useState(false);
  const codeOverrides = React.useMemo(
    () => new Map((list.code_overrides ?? []).map((c) => [c.code, c])),
    [list.code_overrides],
  );

  const groupsMap = new Map<string, typeof list.data>();
  const LABEL: Record<string, string> = {
    stripe: "Stripe",
    paypal: "PayPal",
    razorpay: "RazorPay",
  };
  /**
   * The taxonomy's axis (stage 4). Derived from the rows for the same reason the gateway
   * list is: a family with nothing behind it is a filter that empties the table, which is
   * the same defect as a control that does nothing.
   */
  const familyOptions = [
    { value: "", label: "All families" },
    ...Array.from(new Set(list.data.map((r) => r.family)))
      .sort()
      .map((f) => ({
        value: f,
        label: `${f.replace(/_/g, " ")} · ${list.data.filter((r) => r.family === f).length}`,
      })),
  ];

  const gatewayOptions = [
    { value: "", label: "All gateways" },
    ...Array.from(new Set(list.data.map((r) => r.gateway)))
      .sort()
      .map((g) => ({
        value: g,
        label: `${LABEL[g] ?? g} (${list.data.filter((r) => r.gateway === g).length})`,
      })),
  ];

  const rows = list.data.filter((r) => {
    if (gateway && r.gateway !== gateway) return false;
    if (changedOnly && !r.override) return false;
    if (configurableOnly && !r.overridable) return false;
    if (family && r.family !== family) return false;
    if (!q) return true;
    const hay = `${r.id} ${r.code} ${r.matches.value}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  for (const r of rows) {
    const g = groupsMap.get(r.code);
    if (g) g.push(r);
    else groupsMap.set(r.code, [r]);
  }
  // Alphabetical by canonical code: a stable order a merchant can scan twice and find the
  // same thing, rather than one that shifts as rules are added.
  const groups = Array.from(groupsMap.entries()).sort(([a], [b]) => a.localeCompare(b));

  const configurable = list.data.filter((r) => r.overridable).length;
  const changedCount = list.data.filter((r) => r.override).length;

  return (
    <SettingsCard
      title="Payment errors"
      meta={`${list.data.length} rules · ${configurable} configurable · ${changedCount} changed`}
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <More label="How Retry and Tell the customer work">
          <span className="flex flex-col gap-2">
            <span>
              <strong className="text-foreground">Retry</strong> sets whether a failure goes back to
              the dunning schedule. Off makes it a hard decline. We do not retry, and if the error
              is about the payment method, we mark the method as invalid. On gives a temporary fault
              one more chance.
            </span>
            <span>
              <strong className="text-foreground">Tell the customer</strong> sets whether the reason
              appears in the payment failure email. Some errors describe a problem that the payer
              can correct, for example an expired card or a bank decline. Other errors describe a
              fault on our side. If we name those errors, the customer cannot do anything about
              them.
            </span>
            <span>
              A row that you change affects only this business. A code-level answer applies to all
              rules for the code, except rules with their own answer. Rules that you do not change
              use the built-in answer.
            </span>
          </span>
        </More>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full sm:w-48">
            <SelectField
              name="gateway"
              value={gateway}
              onValueChange={setGateway}
              ariaLabel="Filter by gateway"
              // Derived from the rows: a gateway with no rules behind it would empty the table.
              options={gatewayOptions}
              className="w-full"
            />
          </div>
          <div className="w-full sm:w-56">
            <SelectField
              name="family"
              value={family}
              onValueChange={setFamily}
              ariaLabel="Filter by error family"
              options={familyOptions}
              className="w-full"
            />
          </div>
          <TableSearch
            className="relative w-full sm:w-72"
            placeholder="Search a code or an error id"
            ariaLabel="Search decline rules"
            debounceMs={200}
            onSettled={setQ}
          />
          <SettingSwitch
            checked={changedOnly}
            onCheckedChange={setChangedOnly}
            label="Show only rules this business has changed"
            text="Changed only"
          />
          <SettingSwitch
            checked={configurableOnly}
            onCheckedChange={setConfigurableOnly}
            label="Show only codes this business can change"
            text="Configurable only"
          />
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {rows.length} of {list.data.length} shown
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-11 px-4">Rule</TableHead>
              <TableHead className="h-11 px-4">Matches, and what the customer reads</TableHead>
              <TableHead className="h-11 px-4">Behavior</TableHead>
              {/*
                No standing "Built in" column. It duplicated the Behaviour cell on every
                unchanged row — 79 of 81 — while pushing Reset off the right edge of a
                1600px viewport. A built-in answer is only worth a column's width where it
                DIFFERS, so it moved into the changed rows themselves.
              */}
              {/* Visible, not sr-only. The cells under it carry the built-in answer,
                  who changed it and when, and Reset — real content under a header that
                  read as an empty column to everyone not using a screen reader. */}
              <TableHead className="h-11 px-4">Set by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="px-4 py-3 text-sm text-muted-foreground">
                  No rule matches those filters.
                </TableCell>
              </TableRow>
            ) : (
              /**
               * Grouped by the CANONICAL code, which is the thing that actually decides
               * behaviour — several gateway spellings collapse onto one answer, and a flat
               * list of 81 hides that. It is also the axis a merchant reasons on.
               */
              groups.map(([code, rules]) => (
                <React.Fragment key={code}>
                  <CodeHeader
                    biz={biz}
                    code={code}
                    rules={rules}
                    override={codeOverrides.get(code) ?? null}
                  />
                  {rules.map((r) => (
                    <Row key={r.id} biz={biz} rule={r} />
                  ))}
                </React.Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </SettingsCard>
  );
}

/**
 * The code-level setting: one answer for every rule that means the same thing.
 *
 * It matters because the rules under a code are gateway spellings of one fact — a
 * merchant who decides "we do not retry an expired card" means it for all of them, and
 * setting six rows by hand invites getting five right.
 *
 * A rule with its own setting is NOT touched by this: narrower wins, and the row below
 * says so, so nobody has to discover it by watching a decline behave unexpectedly.
 */
function CodeHeader({
  biz,
  code,
  rules,
  override,
}: {
  biz: string;
  code: string;
  rules: DeclineRule[];
  override: DeclineCodeOverride | null;
}) {
  const individually = rules.filter((r) => r.override?.level === "rule").length;

  /**
   * The built-in answer under this code, shown as text rather than as the control's state.
   *
   * It is text because the rules under a code do not always agree — `mandate_expired` has a
   * PayPal rule that does not retry sitting beside five Stripe codes that do. A switch would
   * have to pick one of those to display and would then be showing an answer the engine does
   * not give.
   */
  const retr = new Set(rules.map((r) => r.built_in.retriable));
  const exp = new Set(rules.map((r) => r.built_in.exposed_to_payer));
  const builtIn =
    retr.size > 1 || exp.size > 1
      ? "these rules differ"
      : `${rules[0]!.built_in.retriable ? "retries" : "no retry"}, ${
          rules[0]!.built_in.exposed_to_payer ? "reason shown" : "reason internal"
        }`;

  /**
   * Three states, not two: "leave it alone" is a real answer and the common one, so the
   * control has to be able to express it. A pair of switches could not — they would have to
   * start somewhere, and whatever they started at would be a setting the merchant never made
   * staring back at them as though they had.
   */
  const tri = (yes: string, no: string) => [
    { value: "", label: "Leave as they are" },
    { value: "yes", label: yes },
    { value: "no", label: no },
  ];
  const cur = (v: boolean | null | undefined) => (v == null ? "" : v ? "yes" : "no");

  return (
    <TableRow className="bg-muted">
      <TableCell colSpan={4} className="px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="font-mono text-xs font-medium text-foreground">{code}</span>
          {/* The namespaced id, so a merchant recognises the family their error history
              was already filed under. The flat code stays first because it is what our
              API returns and what is stored. */}
          <span className="font-mono text-xs text-muted-foreground">{rules[0]!.error_id}</span>
          <span className="text-xs text-muted-foreground">
            {rules.length} {rules.length === 1 ? "rule" : "rules"} &middot; built in: {builtIn}
          </span>
          {override ? <Chip tone="blue">Set for the code</Chip> : null}
          {individually > 0 ? (
            /* A code-level setting does NOT reach a rule that has its own — narrower wins.
               Said here because the alternative is discovering it from a decline. */
            <span className="text-xs text-muted-foreground">
              {individually} set individually and {individually === 1 ? "keeps its" : "keep their"}{" "}
              own answer
            </span>
          ) : null}

          <div className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-2">
            {/* `key` on the saved values so the selects re-read their defaults after a save
                or a clear; without it React keeps the old uncontrolled state and the row
                shows what it held before the click. */}
            <ActionForm
              key={`${code}:${override?.updated_at ?? "none"}`}
              action={setDeclineCodeAction}
            >
              <input type="hidden" name="biz" value={biz} />
              <input type="hidden" name="code" value={code} />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                <SelectField
                  name="retriable"
                  size="sm"
                  className="w-44"
                  defaultValue={cur(override?.retriable)}
                  options={tri("Retry", "Do not retry")}
                  ariaLabel={`Retries for every rule with the code ${code}`}
                />
                <SelectField
                  name="exposed_to_payer"
                  size="sm"
                  className="w-52"
                  defaultValue={cur(override?.exposed_to_payer)}
                  options={tri("Tell the customer", "Keep internal")}
                  ariaLabel={`Whether the customer is told the reason for the code ${code}`}
                />
                <SubmitButton size="sm" variant="outline">
                  Apply to all
                </SubmitButton>
              </div>
            </ActionForm>
            {override ? (
              <ActionForm action={resetDeclineCodeAction}>
                <input type="hidden" name="biz" value={biz} />
                <input type="hidden" name="code" value={code} />
                <SubmitButton size="sm" variant="ghost">
                  Clear
                </SubmitButton>
              </ActionForm>
            ) : null}
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}

function Row({ biz, rule }: { biz: string; rule: DeclineRule }) {
  const changed = rule.override != null;
  return (
    <TableRow>
      <TableCell className="px-4 py-3 align-top">
        <div className="flex max-w-[22rem] min-w-0 flex-col items-start gap-1 whitespace-normal">
          {/*
            `wrap-anywhere`, not `wrap-break-word`. They look interchangeable and are not:
            `overflow-wrap: break-word` breaks LINES but does not reduce a flex item's
            min-content width, so `razorpay.code.card_mandate_current_cycle_allowed_debit_exceeds`
            still forced 432px inside a 352px box. `anywhere` reduces min-content too, which
            is the property that actually makes it fit.
          */}
          <BreakableId value={rule.id} className="font-mono text-xs wrap-anywhere" />
          <span className="text-xs text-muted-foreground">&rarr; {rule.code}</span>
          {/* A changed row must be findable at a glance. "Changed" needs no action, so it
              stays quiet rather than taking a fill. */}
          {changed ? <Chip tone="blue">Changed</Chip> : null}
          {/* Not "Not configurable" any more: no RULE names this code, but the code-level
              control above the group does reach it, and the engine honours it. */}
          {!rule.overridable ? <Chip tone="gray">Set by code only</Chip> : null}
        </div>
      </TableCell>

      <TableCell className="px-4 py-3 align-top">
        {/*
          `whitespace-normal` because `TableCell` ships `whitespace-nowrap` — right for a
          column of amounts, wrong for prose and 44-character rule ids. Without it the text
          sat on ONE line 18px tall holding 767px of content inside a 416px box: clipped,
          and invisible unless you measured, because the rows on screen happened to be short.

          A max-width is the ONLY width lever once a table overflows its wrapper: with
          `table-layout: auto` every column otherwise collapses to its content width, and
          `stripe.code.payment_intent_payment_attempt_failed` is content 44 characters
          wide. Without this the table ran past the right edge and took the Reset column
          with it.
        */}
        <div className="flex max-w-[26rem] min-w-0 flex-col gap-1.5 whitespace-normal">
          <span className="font-mono text-xs wrap-anywhere">
            {rule.matches.field} {rule.matches.op} <BreakableId value={rule.matches.value} />
          </span>
          {/*
            The sentence itself, because a merchant deciding whether to tell the customer
            has to be able to READ what the customer would be told. We already had this
            copy and only offered a toggle over it, which is asking someone to choose blind.

            NOT `max-w-prose` on the span: 65ch is ~700px, wider than this cell's own 26rem,
            so it forced the column open and clipped it — measured at 779px of content in a
            466px box. The parent already sets the measure; a second, larger one only fights
            it. (And the comment belongs HERE: a JSX comment cannot be the first thing
            inside a ternary branch, which is how I broke this file a moment ago.)
          */}
          {rule.effective.message ? (
            <span className="text-xs text-muted-foreground">
              {rule.effective.exposed_to_payer ? "" : "Internal: "}
              {rule.effective.message}
            </span>
          ) : null}
        </div>
      </TableCell>

      {/*
        Both switches and Save live in ONE cell, and the form with them.
        A <form> is not valid inside <tr>, and `display: contents` only hides that from
        the eye — React still hydrates invalid markup, and the browser may relocate the
        element. One cell keeps the markup honest and the row's controls together.
      */}
      <TableCell className="px-4 py-3 align-top">
        {!rule.overridable ? (
          /**
           * No rule names this code, so there is no id a rule-level override could point
           * at and a PATCH aimed here would 404. The lever is the code-level control on
           * the group above, which the engine does honour — so the row shows its answer
           * and points at where to change it, rather than offering a control that fails.
           */
          <span className="text-sm text-muted-foreground">
            {rule.effective.retriable ? "Retries" : "No retry"} &middot;{" "}
            {rule.effective.exposed_to_payer ? "reason shown" : "reason internal"}
          </span>
        ) : (
          <ActionForm action={setDeclineRuleAction}>
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="rule" value={rule.id} />
            {/* Two switches and Save. This used to fit on ONE line at 1600px; since the
              row padding came up to match the other lists (px-4 py-3, as DataTable
              renders) Save drops to a second line, which is the right way to spend the
              width. `xl:flex-nowrap` buys the line back and is deliberately NOT used: it
              squeezes the Rule column until identifiers break mid-token
              (`stripe.code.authentication_requi / red`), and a broken identifier is
              harder to scan than a wrapped control group. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <SettingSwitch
                name="retriable"
                defaultChecked={rule.effective.retriable}
                label={`Retry after ${rule.id}`}
                text="Retry"
              />
              <SettingSwitch
                name="exposed_to_payer"
                defaultChecked={rule.effective.exposed_to_payer}
                label={`Show the reason to the customer for ${rule.id}`}
                text="Tell customer"
              />
              {/* `outline`, not the filled primary. There are 49 configurable rules on
                this page and each one carries its own Save, so a filled button here
                puts 82 page-primary actions on screen and none of them means anything.
                A per-row commit is a row-level control; the page's primary action is
                the family-level "Apply to all" above it. */}
              <SubmitButton size="sm" variant="outline">
                Save
              </SubmitButton>
            </div>
          </ActionForm>
        )}
      </TableCell>

      <TableCell className="px-4 py-3 align-top">
        {changed ? (
          <div className="flex flex-col items-start gap-1">
            {/* Who to ask about a setting that surprised somebody. */}
            {/* What it was, shown only where it differs — the whole reason the standing
                column went away. */}
            <span className="text-xs text-muted-foreground">
              Built in: {rule.built_in.retriable ? "retries" : "no retry"},{" "}
              {rule.built_in.exposed_to_payer ? "reason shown" : "reason internal"}
            </span>
            {rule.override?.updated_by || rule.override?.updated_at ? (
              <span className="text-xs text-muted-foreground">
                {rule.override.updated_by ?? "Changed"}
                {rule.override.updated_at
                  ? ` · ${new Date(rule.override.updated_at).toLocaleDateString()}`
                  : ""}
              </span>
            ) : null}
            <ActionForm action={resetDeclineRuleAction}>
              <input type="hidden" name="biz" value={biz} />
              <input type="hidden" name="rule" value={rule.id} />
              <SubmitButton size="sm" variant="ghost">
                Reset
              </SubmitButton>
            </ActionForm>
          </div>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
