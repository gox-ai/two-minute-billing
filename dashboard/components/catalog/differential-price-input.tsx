'use client'

import { MoneyInput } from '@/components/form/money-input'
import { toMajorInput } from '@/lib/money'

/**
 * Currency-aware amount field for the differential-price grid. The operator types
 * a major-unit amount with the currency shown in the field; a hidden `amount_minor`
 * carries integer minor units, so `setDifferentialPriceAction` is unchanged.
 *
 * This used to carry its own private copy of the exponent lookup and its own
 * major↔minor arithmetic. Both now live in `lib/money.ts` and the field itself is
 * `MoneyInput` — the grid was the only place in the dashboard that got zero-decimal
 * currencies right, and duplicating the rule is how the other twelve stayed wrong.
 */
export function DifferentialPriceInput({
  currency,
  defaultMinor,
}: {
  currency: string
  defaultMinor?: number | null
}) {
  return (
    <MoneyInput
      name="amount_minor"
      currency={currency}
      defaultMajor={defaultMinor != null ? toMajorInput(defaultMinor, currency) : undefined}
      className="w-40"
      inputClassName="text-right"
    />
  )
}
