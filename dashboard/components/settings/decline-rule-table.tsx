"use client";

// Client because the drafts, filters and open groups are local state.

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { enumLabel, plural } from "@/lib/labels";
import { fmtDate } from "@/lib/format-date";
import { useDisplayTz } from "@/components/business-tz";
import { partnerName } from "@/components/partner-logo";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TableSearch } from "@/components/table-search";
import { Chip } from "@/components/patterns/chip";
import { Pager, useLocalPages } from "@/components/patterns/pager";
import { SelectAnswer, ToggleAnswer } from "@/components/patterns/settings-page";
import { More, SettingsCard, SettingsSaveBar } from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { ActionForm } from "@/components/form/action-form";
import type { DeclineRule, DeclineRuleList, DeclineCodeOverride } from "@/lib/api/decline-rules";
import {
  saveDeclineRulesAction,
  type DeclineChanges,
} from "@/app/(dashboard)/businesses/[biz]/settings/decline-rules/actions";

/**
 * Every gateway decline we recognise, and what this business has decided about it.
 *
 * 872 rules under 33 codes. Families are collapsed groups (the first open); inside a
 * family each code is one row with the code-level answer, and its gateway rules open
 * on demand, ten to a page. Nothing commits on change: every edit is a draft and the
 * page has one Save, in the sticky bar with the count of pending changes.
 */

type Tri = "" | "yes" | "no";
type CodeDraft = { retriable: Tri; exposed_to_payer: Tri };
type RuleDraft = { reset: true } | { retriable: boolean; exposed_to_payer: boolean };

const RULES_PER_PAGE = 10;

const FIELD: Record<string, string> = {
  code: "Error code",
  decline_code: "Decline code",
  message: "Message",
  category: "Category",
  network_message: "Network message",
  recommendation_code: "Advice code",
};

const gatewayLabel = (g: string) => partnerName(g) ?? enumLabel(g);
const cur = (v: boolean | null | undefined): Tri => (v == null ? "" : v ? "yes" : "no");
const answer = (retriable: boolean, exposed: boolean) =>
  `${retriable ? "retry" : "do not retry"}, ${exposed ? "show the reason" : "keep the reason internal"}`;

/** A snake_case gateway code reads as words; anything else stays as the gateway wrote it. */
function ruleTitle(r: DeclineRule): string {
  const { field, op, value } = r.matches;
  const f = FIELD[field] ?? enumLabel(field);
  if (op === "contains") return `${f} contains “${value}”`;
  if (op === "matches") return `${f} matches “${value}”`;
  return /[a-z]/i.test(value) && /^[\w-]+$/.test(value) ? enumLabel(value) : `${f} ${value}`;
}

/** Breaks only after a dot or an underscore, never inside a word. */
function SegmentedId({ value, className }: { value: string; className?: string }) {
  const parts = value.split(/(?<=[._])/);
  return (
    <span className={cn("font-mono", className)}>
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
  const [configurableOnly, setConfigurableOnly] = React.useState(false);
  // Settled search text from `TableSearch`, so typing does not re-render every row.
  const [q, setQ] = React.useState("");
  const [codeDrafts, setCodeDrafts] = React.useState<Record<string, CodeDraft>>({});
  const [ruleDrafts, setRuleDrafts] = React.useState<Record<string, RuleDraft>>({});
  const [openFamilies, setOpenFamilies] = React.useState<Set<string> | null>(null);

  const codeOverrides = React.useMemo(
    () => new Map((list.code_overrides ?? []).map((c) => [c.code, c])),
    [list.code_overrides],
  );

  const gatewayOptions = [
    { value: "", label: "All gateways" },
    ...Array.from(new Set(list.data.map((r) => r.gateway)))
      .sort((a, b) => gatewayLabel(a).localeCompare(gatewayLabel(b)))
      .map((g) => ({
        value: g,
        label: `${gatewayLabel(g)} (${list.data.filter((r) => r.gateway === g).length})`,
      })),
  ];
  const familyOptions = [
    { value: "", label: "All families" },
    ...Array.from(new Set(list.data.map((r) => r.family)))
      .sort()
      .map((f) => ({
        value: f,
        label: `${enumLabel(f)} (${list.data.filter((r) => r.family === f).length})`,
      })),
  ];

  const needle = q.trim().toLowerCase();
  const rows = list.data.filter((r) => {
    if (gateway && r.gateway !== gateway) return false;
    if (family && r.family !== family) return false;
    if (changedOnly && !r.override && !ruleDrafts[r.id]) return false;
    if (configurableOnly && !r.overridable) return false;
    if (!needle) return true;
    return `${r.id} ${r.code} ${enumLabel(r.code)} ${r.matches.value} ${ruleTitle(r)}`
      .toLowerCase()
      .includes(needle);
  });

  // family → code → rules, each level in a stable alphabetical order.
  const families = new Map<string, Map<string, DeclineRule[]>>();
  for (const r of rows) {
    const codes = families.get(r.family) ?? new Map<string, DeclineRule[]>();
    families.set(r.family, codes);
    const rs = codes.get(r.code) ?? [];
    codes.set(r.code, rs);
    rs.push(r);
  }
  const familyList = Array.from(families.entries()).sort(([a], [b]) =>
    enumLabel(a).localeCompare(enumLabel(b)),
  );
  // Until the user opens or closes one, the first group is open.
  const isOpen = (f: string, i: number) =>
    !!needle || !!family || (openFamilies ? openFamilies.has(f) : i === 0);
  const toggle = (f: string) =>
    setOpenFamilies((prev) => {
      const next = new Set(prev ?? [familyList[0]?.[0] ?? ""]);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  const allRules = React.useMemo(() => {
    const m = new Map<string, DeclineRule[]>();
    for (const r of list.data) m.set(r.code, [...(m.get(r.code) ?? []), r]);
    return m;
  }, [list.data]);

  const setCode = (code: string, part: keyof CodeDraft, v: string) =>
    setCodeDrafts((prev) => {
      const saved = codeOverrides.get(code);
      const base = prev[code] ?? {
        retriable: cur(saved?.retriable),
        exposed_to_payer: cur(saved?.exposed_to_payer),
      };
      const next = { ...base, [part]: v as Tri };
      const out = { ...prev };
      if (
        next.retriable === cur(saved?.retriable) &&
        next.exposed_to_payer === cur(saved?.exposed_to_payer)
      )
        delete out[code];
      else out[code] = next;
      return out;
    });

  const setRule = (r: DeclineRule, draft: RuleDraft | null) =>
    setRuleDrafts((prev) => {
      const out = { ...prev };
      const same =
        draft &&
        !("reset" in draft) &&
        draft.retriable === r.effective.retriable &&
        draft.exposed_to_payer === r.effective.exposed_to_payer;
      if (!draft || same) delete out[r.id];
      else out[r.id] = draft;
      return out;
    });

  const changes: DeclineChanges = {
    codes: Object.entries(codeDrafts).map(([code, d]) => ({ code, ...d })),
    rules: Object.entries(ruleDrafts).map(([rule, d]) =>
      "reset" in d ? { rule, reset: true as const } : { rule, ...d },
    ),
  };
  const dirty = changes.codes.length + changes.rules.length;
  const discard = () => {
    setCodeDrafts({});
    setRuleDrafts({});
  };

  const configurable = list.data.filter((r) => r.overridable).length;
  const changedCount = list.data.filter((r) => r.override).length;
  const codeCount = new Set(list.data.map((r) => r.code)).size;

  return (
    <ActionForm action={saveDeclineRulesAction} onSuccess={discard} className="flex flex-col gap-5">
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="changes" value={JSON.stringify(changes)} />
      <SettingsCard
        title="Payment errors"
        meta={`${plural(list.data.length, "rule")} · ${plural(codeCount, "code")} · ${configurable} configurable · ${changedCount} changed`}
      >
        <div className="flex flex-col gap-4 px-5 py-4">
          <More label="How Retry and Tell the customer work">
            <span className="flex flex-col gap-2">
              <span>
                <strong className="text-foreground">Retry</strong> sets whether a failure goes back
                to the dunning schedule. Off makes it a hard decline. We do not retry, and if the
                error is about the payment method, we mark the method as invalid. On gives a
                temporary fault one more chance.
              </span>
              <span>
                <strong className="text-foreground">Tell the customer</strong> sets whether the
                reason appears in the payment failure email. Some errors describe a problem that the
                payer can correct, for example an expired card or a bank decline. Other errors
                describe a fault on our side. If we name those errors, the customer cannot do
                anything about them.
              </span>
              <span>
                An answer for a code applies to all its gateway rules, except rules with their own
                answer. Rules that you do not change use the default answer.
              </span>
            </span>
          </More>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex w-full flex-col gap-1.5 sm:w-auto">
              <label
                htmlFor="decline-gateway"
                className="text-xs font-medium text-muted-foreground"
              >
                Gateway
              </label>
              <SelectField
                id="decline-gateway"
                value={gateway}
                onValueChange={setGateway}
                options={gatewayOptions}
                size="sm"
                className="w-full sm:w-52"
              />
            </div>
            <div className="flex w-full flex-col gap-1.5 sm:w-auto">
              <label htmlFor="decline-family" className="text-xs font-medium text-muted-foreground">
                Error family
              </label>
              <SelectField
                id="decline-family"
                value={family}
                onValueChange={setFamily}
                options={familyOptions}
                size="sm"
                className="w-full sm:w-60"
              />
            </div>
            <TableSearch
              className="relative w-full sm:w-72"
              placeholder="Search a code or an error"
              ariaLabel="Search payment errors"
              debounceMs={200}
              onSettled={setQ}
            />
            <div className="flex h-8 items-center gap-4">
              <SettingSwitch
                checked={changedOnly}
                onCheckedChange={setChangedOnly}
                label="Show only rules this business has changed"
                text="Changed only"
              />
              <SettingSwitch
                checked={configurableOnly}
                onCheckedChange={setConfigurableOnly}
                label="Show only rules this business can change"
                text="Configurable only"
              />
            </div>
          </div>
        </div>

        {familyList.length === 0 ? (
          <p className="m-0 border-t px-5 py-4 text-sm text-muted-foreground">
            No payment error matches these filters.
          </p>
        ) : (
          <div className="divide-y border-t">
            {familyList.map(([fam, codes], i) => {
              const open = isOpen(fam, i);
              const ruleCount = Array.from(codes.values()).reduce((n, rs) => n + rs.length, 0);
              const pending =
                Array.from(codes.keys()).filter((c) => codeDrafts[c]).length +
                Array.from(codes.values())
                  .flat()
                  .filter((r) => ruleDrafts[r.id]).length;
              const panel = `decline-family-${fam}`;
              return (
                <section key={fam}>
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={panel}
                    onClick={() => toggle(fam)}
                    className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                  >
                    {open ? (
                      <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="text-sm font-medium">{enumLabel(fam)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {plural(codes.size, "code")} · {plural(ruleCount, "rule")}
                    </span>
                    {pending > 0 ? (
                      <Chip tone="blue" className="ml-auto">
                        {plural(pending, "unsaved change")}
                      </Chip>
                    ) : null}
                  </button>
                  {open ? (
                    <div id={panel} className="divide-y border-t bg-muted/20">
                      {Array.from(codes.entries())
                        .sort(([a], [b]) => enumLabel(a).localeCompare(enumLabel(b)))
                        .map(([code, rules]) => (
                          <CodeBlock
                            key={code}
                            code={code}
                            rules={rules}
                            allRules={allRules.get(code) ?? rules}
                            override={codeOverrides.get(code) ?? null}
                            draft={codeDrafts[code]}
                            onCode={(part, v) => setCode(code, part, v)}
                            ruleDrafts={ruleDrafts}
                            onRule={setRule}
                            expand={!!needle}
                          />
                        ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </SettingsCard>
      <SettingsSaveBar
        disabled={dirty === 0}
        note={
          dirty === 0
            ? "No unsaved changes."
            : `${plural(dirty, "unsaved change")}. A change applies to new payment failures after you save.`
        }
      >
        {dirty > 0 ? (
          <Button type="button" variant="outline" onClick={discard}>
            Discard
          </Button>
        ) : null}
      </SettingsSaveBar>
    </ActionForm>
  );
}

/**
 * One code: its label, the code-level answer, and its gateway rules behind a disclosure.
 * A rule with its own answer is not touched by the code-level one (narrower wins).
 */
function CodeBlock({
  code,
  rules,
  allRules,
  override,
  draft,
  onCode,
  ruleDrafts,
  onRule,
  expand,
}: {
  code: string;
  /** The rules under this code that pass the filters. */
  rules: DeclineRule[];
  allRules: DeclineRule[];
  override: DeclineCodeOverride | null;
  draft: CodeDraft | undefined;
  onCode: (part: keyof CodeDraft, v: string) => void;
  ruleDrafts: Record<string, RuleDraft>;
  onRule: (r: DeclineRule, d: RuleDraft | null) => void;
  /** Open the rule list, e.g. while a search is active. */
  expand: boolean;
}) {
  const [showRules, setShowRules] = React.useState(false);
  const open = expand || showRules;
  const { rows: page, pager } = useLocalPages(rules, RULES_PER_PAGE);
  const individually = allRules.filter((r) => r.override?.level === "rule").length;

  // Text, not a control state: the rules under one code do not always agree.
  const retr = new Set(allRules.map((r) => r.built_in.retriable));
  const exp = new Set(allRules.map((r) => r.built_in.exposed_to_payer));
  const mixed = retr.size > 1 || exp.size > 1;
  const builtRetry =
    mixed && retr.size > 1
      ? "each rule decides"
      : allRules[0]!.built_in.retriable
        ? "retry"
        : "do not retry";
  const builtTell =
    mixed && exp.size > 1
      ? "each rule decides"
      : allRules[0]!.built_in.exposed_to_payer
        ? "show the reason"
        : "keep it internal";

  const retriable = draft?.retriable ?? cur(override?.retriable);
  const exposed = draft?.exposed_to_payer ?? cur(override?.exposed_to_payer);
  const label = enumLabel(code);
  const list = `decline-code-${code}`;

  return (
    <div className="bg-card">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3 px-5 py-4">
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{label}</span>
            {override ? <Chip tone="blue">Set for the code</Chip> : null}
            {draft ? <Chip tone="tan">Unsaved</Chip> : null}
          </span>
          <span className="text-xs text-muted-foreground">
            <span className="font-mono" title={allRules[0]!.error_id}>
              {code}
            </span>{" "}
            · {plural(allRules.length, "gateway rule")}
            {individually > 0 ? ` · ${individually} with their own answer` : ""}
          </span>
        </div>
        <div className="flex shrink-0 flex-col gap-1 sm:items-end">
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <label htmlFor={`${list}-retry`} className="text-xs text-muted-foreground">
              Retry
            </label>
            <SelectAnswer
              id={`${list}-retry`}
              value={retriable}
              onValueChange={(v) => onCode("retriable", v)}
              ariaLabel={`Retry for ${label}`}
              options={[
                { value: "", label: `Default: ${builtRetry}` },
                { value: "yes", label: "Retry" },
                { value: "no", label: "Do not retry" },
              ]}
            />
          </div>
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <label htmlFor={`${list}-tell`} className="text-xs text-muted-foreground">
              Tell the customer
            </label>
            <SelectAnswer
              id={`${list}-tell`}
              value={exposed}
              onValueChange={(v) => onCode("exposed_to_payer", v)}
              ariaLabel={`Tell the customer the reason for ${label}`}
              options={[
                { value: "", label: `Default: ${builtTell}` },
                { value: "yes", label: "Show the reason" },
                { value: "no", label: "Keep it internal" },
              ]}
            />
          </div>
        </div>
      </div>
      {rules.length > 0 ? (
        <div className="px-5 pb-3">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={list}
            onClick={() => setShowRules((v) => !v)}
            disabled={expand}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline disabled:no-underline disabled:opacity-100"
          >
            {open ? (
              <ChevronDown aria-hidden className="size-4" />
            ) : (
              <ChevronRight aria-hidden className="size-4" />
            )}
            {open ? "Hide" : "Show"} {plural(rules.length, "gateway rule")}
          </button>
        </div>
      ) : null}
      {open && rules.length > 0 ? (
        <div id={list} className="mx-5 mb-4 overflow-hidden rounded-xl border">
          <ul className="m-0 list-none divide-y p-0">
            {page.map((r) => (
              <RuleRow
                key={r.id}
                rule={r}
                override={override}
                draft={ruleDrafts[r.id]}
                onRule={onRule}
              />
            ))}
          </ul>
          <Pager pager={pager} className="px-4" />
        </div>
      ) : null}
    </div>
  );
}

function RuleRow({
  rule,
  override,
  draft,
  onRule,
}: {
  rule: DeclineRule;
  override: DeclineCodeOverride | null;
  draft: RuleDraft | undefined;
  onRule: (r: DeclineRule, d: RuleDraft | null) => void;
}) {
  const tz = useDisplayTz();
  const resetting = !!draft && "reset" in draft;
  // After a reset the code-level answer applies where there is one, else the built-in one.
  const fallback = {
    retriable: override?.retriable ?? rule.built_in.retriable,
    exposed_to_payer: override?.exposed_to_payer ?? rule.built_in.exposed_to_payer,
  };
  const shown =
    draft && !("reset" in draft)
      ? draft
      : resetting
        ? fallback
        : {
            retriable: rule.effective.retriable,
            exposed_to_payer: rule.effective.exposed_to_payer,
          };
  const own = rule.override?.level === "rule";
  const title = ruleTitle(rule);
  const eqCode = rule.matches.op === "eq" && title === enumLabel(rule.matches.value);

  return (
    <li className="flex flex-wrap items-start gap-x-6 gap-y-2 bg-card px-4 py-3">
      <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{title}</span>
          {own && !resetting ? <Chip tone="blue">Changed</Chip> : null}
          {draft ? <Chip tone="tan">{resetting ? "Reset on save" : "Unsaved"}</Chip> : null}
        </span>
        <span className="text-xs text-muted-foreground">
          {gatewayLabel(rule.gateway)}
          {eqCode ? (
            <>
              {" · "}
              <SegmentedId value={rule.matches.value} />
            </>
          ) : null}
        </span>
        {rule.effective.message ? (
          <span className="text-xs text-muted-foreground">
            {rule.effective.exposed_to_payer ? "The customer reads: " : "Internal: "}
            {rule.effective.message}
          </span>
        ) : null}
        {own && rule.override ? (
          <span className="text-xs text-muted-foreground">
            Default: {answer(rule.built_in.retriable, rule.built_in.exposed_to_payer)}
            {rule.override.updated_by ? ` · ${rule.override.updated_by}` : ""}
            {rule.override.updated_at ? ` · ${fmtDate(rule.override.updated_at, tz)}` : ""}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
        {!rule.overridable ? (
          // No rule names this gateway code, so only the code-level answer above reaches it.
          <span className="text-sm text-muted-foreground">
            {answer(rule.effective.retriable, rule.effective.exposed_to_payer)} · set by the code
          </span>
        ) : (
          <>
            <span className="inline-flex items-center gap-2 text-sm">
              <ToggleAnswer
                checked={shown.retriable}
                disabled={resetting}
                onCheckedChange={(v) =>
                  onRule(rule, { retriable: v, exposed_to_payer: shown.exposed_to_payer })
                }
                label={`Retry after ${title} (${gatewayLabel(rule.gateway)})`}
              />
              <span aria-hidden>Retry</span>
            </span>
            <span className="inline-flex items-center gap-2 text-sm">
              <ToggleAnswer
                checked={shown.exposed_to_payer}
                disabled={resetting}
                onCheckedChange={(v) =>
                  onRule(rule, { retriable: shown.retriable, exposed_to_payer: v })
                }
                label={`Tell the customer the reason for ${title} (${gatewayLabel(rule.gateway)})`}
              />
              <span aria-hidden>Tell customer</span>
            </span>
            {draft ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => onRule(rule, null)}>
                Undo
              </Button>
            ) : own ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onRule(rule, { reset: true })}
              >
                Reset
              </Button>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}
