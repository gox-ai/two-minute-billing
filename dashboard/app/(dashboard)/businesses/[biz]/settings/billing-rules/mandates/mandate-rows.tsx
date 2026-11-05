"use client";

import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/settings-layout";

const inr = (rupees: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(rupees);

/** The two mandate-sizing inputs; the consequence previews a ₹10,000 debit. */
export function MandateRows({ multiple, capRupees }: { multiple: number; capRupees: number }) {
  const [m, setM] = useDefaultState(String(multiple));
  const [c, setC] = useDefaultState(String(capRupees));
  const mult = Number(m);
  const cap = Number(c);
  const okMult = m.trim() !== "" && Number.isFinite(mult) && mult >= 1 && mult <= 10;
  const okCap = c.trim() !== "" && Number.isInteger(cap) && cap >= 1;
  const sample = 10_000;
  // withMandateHeadroom: the multiple, clamped to the cap unless the charge itself reaches it.
  const generous = Math.ceil(sample * mult);
  const ceiling = okMult && okCap ? (sample >= cap ? generous : Math.min(generous, cap)) : null;

  return (
    <>
      <SettingRow
        label="Mandate ceiling"
        htmlFor="mandate_multiple"
        help="The largest debit a mandate allows, as a multiple of the subscription's next charge, tax included. A larger multiple lets upgrades charge without a new mandate. The customer sees the ceiling when they approve the mandate."
        errorFor="mandate_multiple"
        control={
          <span className="inline-flex items-center gap-2">
            <Input
              id="mandate_multiple"
              name="mandate_multiple"
              type="number"
              inputMode="decimal"
              min={1}
              max={10}
              step={0.05}
              required
              value={m}
              onChange={(e) => setM(e.target.value)}
              className="w-24 text-right tabular-nums"
            />
            <span className="text-sm text-muted-foreground">× the charge</span>
          </span>
        }
        consequence={
          okMult
            ? ceiling != null
              ? `A ${inr(sample)} charge gets a mandate of up to ${inr(ceiling)}.`
              : undefined
            : "Enter a multiple from 1 to 10."
        }
      />
      <SettingRow
        label="Ceiling cap"
        htmlFor="mandate_cap_rupees"
        help="No mandate asks for more than this, so that UPI Autopay stays available. NPCI limits a UPI Autopay mandate to ₹1,00,000. A charge above the cap still gets its full multiple."
        errorFor="mandate_cap_rupees"
        control={
          <span className="inline-flex items-center gap-2">
            <span className="text-sm text-muted-foreground">₹</span>
            <Input
              id="mandate_cap_rupees"
              name="mandate_cap_rupees"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              required
              value={c}
              onChange={(e) => setC(e.target.value)}
              className="w-36 text-right tabular-nums"
            />
          </span>
        }
        consequence={
          okCap
            ? cap > 100_000
              ? "Above ₹1,00,000, UPI Autopay cannot approve the mandate. The customer must use a card or e-mandate."
              : undefined
            : "Enter a whole number of rupees, 1 or more."
        }
      />
    </>
  );
}
