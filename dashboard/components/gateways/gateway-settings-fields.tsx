"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { CurrenciesField } from "@/components/form/currency-select";
import { SettingRow } from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { MethodTypesField } from "@/components/gateways/method-types-field";
import type { GatewayAccount } from "@/lib/api/gateways";
import type { GatewayCatalogEntry, MethodTypeMeta } from "@/components/gateways/gateway-meta";
import { gatewayCurrencyField } from "@/lib/business-currencies";

/** Label / currencies / methods / status rows; the status consequence follows the live value. */
export function GatewaySettingsFields({
  account,
  methodTypes,
  currencyOptions,
  gateway,
}: {
  account: GatewayAccount;
  /** The business's currencies (`businessCurrencyOptions`); null = every currency. */
  currencyOptions: string[] | null;
  /** The account's gateway from the catalogue: its name, currency list and international switch. */
  gateway:
    | Pick<GatewayCatalogEntry, "display_name" | "currencies" | "international_domestic_currency">
    | undefined;
  /** The gateway's `method_types` from the catalogue. */
  methodTypes: MethodTypeMeta[];
}) {
  const [status, setStatus] = useDefaultState<string>(account.status);
  const domestic = gateway?.international_domestic_currency ?? null;
  // Codes the account already holds stay selected, even outside the options.
  const currencyField = gatewayCurrencyField(currencyOptions, gateway);
  return (
    <>
      <SettingRow
        label="Label"
        htmlFor="label"
        errorFor="label"
        control={
          <Input
            id="label"
            name="label"
            defaultValue={account.label}
            required
            maxLength={200}
            className="max-w-md"
          />
        }
      />
      <SettingRow
        label="Currencies"
        help={currencyField.help}
        control={
          <CurrenciesField
            defaultValue={account.currencies ?? []}
            options={currencyField.options}
            emptyHint={currencyField.emptyHint}
          />
        }
      />
      {domestic ? (
        <InternationalPaymentsRow
          domestic={domestic}
          gatewayName={gateway?.display_name ?? "the gateway"}
          defaultChecked={account.international_enabled === true}
          existing
        />
      ) : null}
      <SettingRow
        label="Payment methods"
        help="Leave empty to allow any method this gateway supports."
        control={
          <MethodTypesField available={methodTypes} defaultValue={account.method_types ?? []} />
        }
      />
      <SettingRow
        label="Status"
        htmlFor="status"
        control={
          // SelectField, not raw Select: it ignores the mount-time value Radix restores
          // on React's post-action form reset, which once re-enabled a disabled account.
          <SelectField
            name="status"
            value={status}
            onValueChange={setStatus}
            className="w-44"
            options={[
              { value: "active", label: "Active" },
              { value: "disabled", label: "Disabled" },
            ]}
          />
        }
        consequence={
          status === "active"
            ? "Active: charges route here when their currency and method match."
            : "Disabled: no charges route here and we refuse its webhooks. Payment methods saved on it go to another account. That account usually cannot charge them."
        }
      />
    </>
  );
}

/**
 * "International payments", for a gateway with an `internationalSwitch`. Posts
 * `international_switch` so the action knows this form shows it: unchecked, a switch posts nothing.
 */
export function InternationalPaymentsRow({
  domestic,
  gatewayName,
  defaultChecked,
  existing = false,
}: {
  /** The currency the account takes with the switch off. */
  domestic: string;
  gatewayName: string;
  defaultChecked: boolean;
  /** An existing account: saved payment methods can be in other currencies. */
  existing?: boolean;
}) {
  const [international, setInternational] = useDefaultState<boolean>(defaultChecked);
  return (
    <SettingRow
      label="International payments"
      help={`Ask ${gatewayName} to enable international payments on your ${gatewayName} account first. Then enable this setting.`}
      control={
        <>
          <input type="hidden" name="international_switch" value="1" />
          <SettingSwitch
            name="international_enabled"
            label="International payments"
            checked={international}
            onCheckedChange={setInternational}
          />
        </>
      }
      consequence={
        international
          ? `On: this account takes payments in ${domestic} and in other currencies.`
          : existing
            ? `Off: this account takes new payments in ${domestic} only. New payments in other currencies use a different gateway account. We continue to charge the saved payment methods in other currencies on this account.`
            : `Off: this account takes payments in ${domestic} only. To select other currencies, enable this setting.`
      }
    />
  );
}
