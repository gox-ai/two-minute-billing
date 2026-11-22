"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import type { RoutingGroup } from "@/lib/payment-routing";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { SelectAnswer } from "@/components/patterns/settings-page";
import { SettingsCard } from "@/components/settings/settings-layout";
import { Alert } from "@/components/ui/alert";
import { SortableList } from "@/components/ui/sortable-list";
import { savePaymentRoutingAction } from "../../actions";

/**
 * Settings → Gateways → where new payment methods go, per currency: the order of the
 * method rows in the portal, and the account a new method of each kind goes to.
 * `groups` arrive resolved (`buildRoutingGroups`): the order and accounts in effect now.
 */
export function PaymentRoutingCard({
  biz,
  version,
  groups,
  canManage,
}: {
  biz: string;
  version: number | null | undefined;
  groups: RoutingGroup[];
  canManage: boolean;
}) {
  return (
    <ActionForm action={savePaymentRoutingAction}>
      <input type="hidden" name="biz" value={biz} />
      {version != null ? <input type="hidden" name="expected_version" value={version} /> : null}
      <SettingsCard
        title="Where new payment methods go"
        meta="Self-serve portal"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3 py-1">
            <span className="text-muted-foreground">
              The portal shows saved payment methods first, then these rows in this order. Drag a
              row to change the order.
            </span>
            {canManage ? (
              <span className="ml-auto">
                <SubmitButton>Save</SubmitButton>
              </span>
            ) : null}
          </div>
        }
      >
        <div className="px-5 py-4">
          <Alert tone="info">
            A saved payment method keeps charging on the gateway that holds it.
          </Alert>
        </div>
        {groups.map((g) => (
          <CurrencyGroup key={g.currency} group={g} disabled={!canManage} />
        ))}
      </SettingsCard>
    </ActionForm>
  );
}

function CurrencyGroup({ group, disabled }: { group: RoutingGroup; disabled: boolean }) {
  const cur = group.currency;
  const initialOrder = group.rows.map((r) => r.method);
  const [order, setOrder] = useDefaultState(initialOrder, (o) => o.join(","));
  const initialPicks = Object.fromEntries(group.rows.map((r) => [r.method, r.selected]));
  const [picks, setPicks] = useDefaultState(initialPicks, (p) => JSON.stringify(p));
  const byMethod = new Map(group.rows.map((r) => [r.method, r]));

  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <p className="m-0 text-sm font-medium">{cur}</p>
      <input type="hidden" name={`order:${cur}`} value={order.join(",")} />
      <SortableList
        items={order.filter((m) => byMethod.has(m))}
        onReorder={setOrder}
        disabled={disabled}
        itemLabel={(m) => byMethod.get(m)?.label ?? m}
        itemClassName="px-3 py-2"
        renderItem={(m) => {
          const row = byMethod.get(m)!;
          const pick = picks[m] ?? row.selected;
          return (
            <>
              <span className="min-w-0 flex-[1_1_10rem] text-sm">{row.label}</span>
              <span className="flex min-w-0 items-center">
                {row.options.length >= 2 ? (
                  <SelectAnswer
                    name={`route:${cur}:${m}`}
                    value={pick}
                    onValueChange={(v) => setPicks((p) => ({ ...p, [m]: v }))}
                    ariaLabel={`Gateway for ${row.label} in ${cur}`}
                    disabled={disabled}
                    options={row.options.map((o) => ({ value: o.id, label: o.label }))}
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">{row.options[0]?.label}</span>
                )}
              </span>
            </>
          );
        }}
      />
    </div>
  );
}
