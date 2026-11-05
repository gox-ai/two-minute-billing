"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CurrenciesField } from "@/components/form/currency-select";
import { Chip } from "@/components/patterns/chip";
import { SettingRow, SettingsCard } from "@/components/settings/settings-layout";
import { CredentialFields } from "@/components/gateways/credential-fields";
import { MethodTypesField } from "@/components/gateways/method-types-field";
import { InternationalPaymentsRow } from "@/components/gateways/gateway-settings-fields";
import { gatewayEntry, type GatewayCatalogEntry } from "@/components/gateways/gateway-meta";
import { LOGO_SIZE, PartnerLogo } from "@/components/partner-logo";
import type { ActionResult } from "@/lib/action-result";
import { gatewayCurrencyField } from "@/lib/business-currencies";

/**
 * Add a gateway: step one is a directory built from the provider catalogue, step two
 * the chosen provider's form. Livemode is not a field — the engine stamps it from the
 * business (live businesses cannot hold tmtest accounts).
 */
export function GatewayCreateForm({
  biz,
  catalog,
  businessLivemode,
  businessCurrencies,
  currencyOptions,
  action,
  initialGateway = null,
}: {
  biz: string;
  /** `GET /v1/gateways`. */
  catalog: GatewayCatalogEntry[];
  businessLivemode: "live" | "test";
  businessCurrencies: string[] | null;
  /** The business's currencies (`businessCurrencyOptions`); null = every currency. */
  currencyOptions: string[] | null;
  action: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  /** A catalogue key to open on load; ignored when that gateway is not offered here. */
  initialGateway?: string | null;
}) {
  const router = useRouter();
  // `initialGateway` (from `?gateway=`) opens that provider's form directly when it is offered.
  const [gatewayKey, setGatewayKey] = React.useState<string | null>(() =>
    initialGateway &&
    catalog.some(
      (g) =>
        g.key === initialGateway &&
        g.available !== false &&
        !(businessLivemode === "live" && g.simulated),
    )
      ? initialGateway
      : null,
  );
  // Where focus goes after the user selects or un-selects: the form's first field, or back
  // to the card they left. Null on mount so the page does not grab focus on load.
  const focusNext = React.useRef<string | null>(null);
  React.useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target) document.getElementById(target)?.focus();
  }, [gatewayKey]);
  const select = (k: string | null) => {
    focusNext.current = k ? "label" : `gateway-card-${gatewayKey}`;
    setGatewayKey(k);
  };
  const live = businessLivemode === "live";
  const listed = catalog.filter((g) => !(live && g.simulated));
  const gateways = listed.filter((g) => g.available !== false);
  // Not offered yet: shown with the reason and no connect action (the API refuses them).
  const comingSoon = listed.filter((g) => g.available === false);
  const testOnly = catalog.filter((g) => live && g.simulated).map((g) => g.display_name);
  const selected = gatewayEntry(catalog, gatewayKey);
  const name = selected?.display_name ?? "";
  const currencyField = gatewayCurrencyField(currencyOptions, selected);
  // Preselect the business's currencies that this gateway takes.
  const preselected = businessCurrencies?.filter(
    (c) => !selected?.currencies || selected.currencies.includes(c.toUpperCase()),
  );

  return (
    <ActionForm
      action={action}
      onSuccess={(r) => r.redirectTo && router.push(r.redirectTo)}
      className="flex flex-col gap-5"
    >
      <input type="hidden" name="biz" value={biz} />
      {gatewayKey ? <input type="hidden" name="gateway_key" value={gatewayKey} /> : null}

      <SettingsCard
        title={selected ? "Provider" : "Select a provider"}
        meta={
          selected
            ? undefined
            : `${gateways.length} available${comingSoon.length ? ` · ${comingSoon.length} coming soon` : ""}${testOnly.length ? ` · the ${testOnly.join(", ")} is test-only` : ""}`
        }
        actions={
          selected ? (
            <Button type="button" variant="outline" size="sm" onClick={() => select(null)}>
              Change provider
            </Button>
          ) : undefined
        }
      >
        {selected ? (
          // The directory folds to the chosen card, so its form sits directly below it.
          <div className="p-4">
            <div className="flex flex-col gap-3 rounded-lg border border-primary px-4 py-3 ring-1 ring-primary">
              <ProviderCardBody g={selected} on />
            </div>
          </div>
        ) : (
          <ul role="list" className="m-0 grid list-none gap-3 p-4 sm:grid-cols-2">
            {gateways.map((g) => (
              <li key={g.key}>
                <button
                  type="button"
                  id={`gateway-card-${g.key}`}
                  onClick={() => select(g.key)}
                  className="flex h-full w-full flex-col gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <ProviderCardBody g={g} on={false} />
                </button>
              </li>
            ))}
            {comingSoon.map((g) => (
              <li key={g.key}>
                <div className="flex h-full w-full flex-col gap-3 rounded-lg border bg-muted/50 px-4 py-3">
                  <span className="flex items-center justify-between gap-3">
                    <PartnerLogo brand={g.key} name={g.display_name} {...LOGO_SIZE.card} fit />
                    <Chip tone="gray">Coming soon</Chip>
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-semibold">{g.display_name}</span>
                    <span className="text-sm text-muted-foreground">
                      {g.unavailable_reason ?? "This gateway is not available yet."}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      {gatewayKey && selected ? (
        <SettingsCard
          title={`Connect ${name}`}
          meta="We encrypt credentials at rest and do not show them again"
          footer={
            <div className="flex justify-end py-1.5">
              <SubmitButton>Create gateway account</SubmitButton>
            </div>
          }
        >
          <SettingRow
            label="Label"
            htmlFor="label"
            errorFor="label"
            help="An internal name to identify the account. For example: “Stripe US — primary”."
            control={
              <Input
                id="label"
                name="label"
                required
                maxLength={200}
                placeholder={`${name} account`}
                className="max-w-md"
              />
            }
          />
          <SettingRow
            label="Mode"
            control={
              <Chip
                tone={live ? "green" : "tan"}
                className="text-xs font-bold tracking-wide uppercase"
              >
                {live ? "Live" : "Test"}
              </Chip>
            }
            consequence={`The business sets the mode. A ${businessLivemode} business creates ${businessLivemode}-mode gateway accounts.`}
          />
          <SettingRow
            label="Credentials"
            control={<CredentialFields fields={selected.credential_fields} requiredFields />}
          />
          <SettingRow
            label="Currencies"
            help={currencyField.help}
            control={
              // Remounts per provider: a selection the previous gateway takes may not apply.
              <CurrenciesField
                key={gatewayKey}
                defaultValue={preselected ?? []}
                options={currencyField.options}
                emptyHint={currencyField.emptyHint}
              />
            }
          />
          {selected.international_domestic_currency ? (
            // Remounts per provider. Off by default, as the API creates it.
            <InternationalPaymentsRow
              key={gatewayKey}
              domestic={selected.international_domestic_currency}
              gatewayName={name}
              defaultChecked={false}
            />
          ) : null}
          <SettingRow
            label="Payment methods"
            help="Leave empty to allow any method this gateway supports."
            control={
              // Remounts per provider: a selection from another adapter must not survive.
              <MethodTypesField key={gatewayKey} available={selected.method_types} />
            }
          />
        </SettingsCard>
      ) : null}
    </ActionForm>
  );
}

function ProviderCardBody({ g, on }: { g: GatewayCatalogEntry; on: boolean }) {
  const methods = g.method_types.map((m) => m.label).join(" · ");
  const creds = g.credential_fields.map((f) => f.label);
  return (
    <>
      <span className="flex items-center justify-between gap-3">
        <PartnerLogo brand={g.key} name={g.display_name} {...LOGO_SIZE.card} fit />
        <span
          aria-hidden
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full border",
            on && "border-primary bg-primary text-primary-foreground",
          )}
        >
          {on ? <Check className="size-3.5" /> : null}
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-semibold">{g.display_name}</span>
        <span className="text-sm text-muted-foreground">{methods}</span>
        <span className="text-xs text-muted-foreground">
          {g.note ?? (creds.length ? `You need: ${creds.join(", ")}` : null)}
        </span>
      </span>
    </>
  );
}
