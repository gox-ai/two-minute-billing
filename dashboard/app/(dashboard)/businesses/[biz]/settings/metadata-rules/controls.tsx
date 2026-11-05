"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SwitchField } from "@/components/ui/switch";
import type { ActionResult } from "@/lib/action-result";
import type { MetadataKeyRule, MetadataRuleEntity } from "@/lib/api/metadata-rules";
import {
  archiveRuleAction,
  restoreRuleAction,
  setStrictAction,
  setValidationAction,
} from "./actions";
import { RuleDialog } from "./rule-dialog";
import type { RuleDraft } from "./types";

function useRun() {
  const [pending, start] = React.useTransition();
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message ?? "Done");
      else toast.error(res.message ?? "We could not save the change.");
    });
  return [pending, run] as const;
}

/** Edit, and archive or restore, for one rule row. */
export function RuleRowActions({ biz, rule }: { biz: string; rule: MetadataKeyRule }) {
  const [pending, run] = useRun();
  if (rule.archived)
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => run(() => restoreRuleAction(biz, rule.id))}
      >
        {pending ? "…" : "Restore"}
      </Button>
    );
  return (
    <span className="inline-flex gap-1">
      <RuleDialog
        biz={biz}
        entity={rule.entity_type}
        rule={rule}
        trigger={(open) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={open}
            aria-label={`Edit the rule for ${rule.key}`}
          >
            Edit
          </Button>
        )}
      />
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => run(() => archiveRuleAction(biz, rule.id))}
        aria-label={`Archive the rule for ${rule.key}`}
      >
        {pending ? "…" : "Archive"}
      </Button>
    </span>
  );
}

export function AddRuleButton({ biz, entity }: { biz: string; entity: MetadataRuleEntity }) {
  return (
    <RuleDialog
      biz={biz}
      entity={entity}
      trigger={(open) => (
        <Button variant="outline" size="sm" onClick={open}>
          Create a rule
        </Button>
      )}
    />
  );
}

/** Opens the rule dialog pre-filled from a path already in use. */
export function CreateFromSuggestionButton({
  biz,
  entity,
  draft,
}: {
  biz: string;
  entity: MetadataRuleEntity;
  draft: RuleDraft;
}) {
  return (
    <RuleDialog
      biz={biz}
      entity={entity}
      draft={draft}
      trigger={(open) => (
        <Button
          variant="outline"
          size="sm"
          onClick={open}
          aria-label={`Create a rule for ${draft.key}`}
        >
          Create rule
        </Button>
      )}
    />
  );
}

/** Saves on change. The server value comes back through the page refresh. */
export function ValidationSwitch({
  biz,
  entity,
  on,
}: {
  biz: string;
  entity: MetadataRuleEntity;
  on: boolean;
}) {
  const [pending, run] = useRun();
  return (
    <SwitchField
      checked={on}
      disabled={pending}
      ariaLabel={`Metadata validation for ${entity === "customer" ? "customers" : "subscriptions"}`}
      onCheckedChange={(v) => run(() => setValidationAction(biz, entity, v))}
    />
  );
}

export function StrictSwitch({
  biz,
  entity,
  on,
  disabled,
}: {
  biz: string;
  entity: MetadataRuleEntity;
  on: boolean;
  disabled: boolean;
}) {
  const [pending, run] = useRun();
  return (
    <SwitchField
      checked={on}
      disabled={disabled || pending}
      ariaLabel={`Strict mode for ${entity === "customer" ? "customers" : "subscriptions"}`}
      onCheckedChange={(v) => run(() => setStrictAction(biz, entity, v))}
    />
  );
}
