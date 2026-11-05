import { majorStep, toMajorInput } from "@/lib/money";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/settings-layout";
import type { Business } from "@/lib/api";

/** Every currency the business bills in, plus any that already holds an amount. */
export function businessCurrencies(b: Business, amounts: Record<string, number>): string[] {
  return [
    ...new Set(
      [b.default_currency, ...(b.currencies ?? []), ...Object.keys(amounts)]
        .filter((c): c is string => !!c)
        .map((c) => c.toUpperCase()),
    ),
  ];
}

/** One `amount_<CUR>` input per currency, in major units. Empty = no amount. */
export function CurrencyAmountRows({
  currencies,
  amounts,
  help,
}: {
  currencies: string[];
  amounts: Record<string, number>;
  help: string;
}) {
  if (currencies.length === 0)
    return (
      <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
        Set a default currency on the business profile first.
      </p>
    );
  return (
    <>
      <input type="hidden" name="currencies" value={currencies.join(",")} />
      {currencies.map((c) => (
        <SettingRow
          key={c}
          label={c}
          htmlFor={`amount_${c}`}
          errorFor={`amount_${c}`}
          help={help}
          control={
            <Input
              id={`amount_${c}`}
              name={`amount_${c}`}
              type="number"
              min="0"
              step={majorStep(c)}
              inputMode="decimal"
              className="w-full sm:w-56"
              defaultValue={toMajorInput(amounts[c] ?? null, c)}
              placeholder="No limit"
            />
          }
        />
      ))}
    </>
  );
}
