"use client";

import * as React from "react";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { RecordCard } from "@/components/patterns/record-page";
import { SettingRow, SelectAnswer, ToggleAnswer } from "@/components/patterns/settings-page";
import { StateSelect } from "@/components/tax/state-select";
import { saveTaxRegionAction } from "@/app/actions";
import type { TaxRegion } from "@/lib/api";

/**
 * The region's own settings, as a list of decisions (settings-page archetype).
 *
 * Every row here reaches a real column on `tax_regions`. Two rows are deliberately
 * ABSENT rather than rendered dead:
 *   - "Use local currency to display tax in invoices and credit notes" — we have no
 *     per-invoice tax display currency, so the switch would toggle nothing.
 *   - "Transitional Taxation" (effective-dated rate changes) — `tax_rate_components`
 *     has no validity period, so a supply spanning a rate change cannot be split.
 * Both are logged in docs/PROGRESS.md as pending backend work.
 *
 * Note-carrying switches render their text input in the SAME row, revealed by the
 * switch, because a note with its switch off prints nothing — showing the input
 * unconditionally implies it is in effect.
 */
export function TaxRegionSettings({ biz, region }: { biz: string; region: TaxRegion }) {
  // Reflects the SAVED state, not live switch position: the hint tells the operator what
  // is currently in effect, which is the useful fact after a reload.
  const reverseCharge = region.reverse_charge_enabled;

  return (
    <ActionForm action={saveTaxRegionAction} className="flex flex-col gap-4">
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="txg" value={region.id} />

      <SettingsCard title="Pricing and registration">
        <SettingRow
          question="Are your catalog prices in this country inclusive of tax?"
          help="Exclusive shows tax as separate lines after the subtotal. Inclusive keeps tax in the price. For reports, we calculate the tax part of the price."
        >
          <SelectAnswer
            name="price_type"
            defaultValue={region.price_type}
            options={[
              { value: "exclusive", label: "Exclusive of tax" },
              { value: "inclusive", label: "Inclusive of tax" },
            ]}
          />
        </SettingRow>

        <SettingRow
          question="Which state does your business supply from?"
          help={
            region.regime === "gst"
              ? "It sets intra-state (CGST + SGST/UTGST) or inter-state (IGST) tax. We save it on each invoice, so that we can reproduce past tax."
              : "Only GST regions use this, to split tax by place of supply."
          }
        >
          {/* Strictly selectable — this single value decides CGST+SGST vs IGST for
              every supply, and a code that matches nothing makes every supply
              resolve inter-state. Not `SelectAnswer` (the inline settings-row
              control) because that takes a flat option list and this one has to be
              country-aware and alias-tolerant. */}
          <StateSelect
            name="home_state_code"
            country={region.country}
            defaultValue={region.home_state_code}
            className="w-64"
            ariaLabel="Your registered state"
          />
        </SettingRow>

        <SettingRow question="How is your tax registration labeled on invoices?">
          <SelectAnswer
            name="registration_label"
            defaultValue={region.registration_label ?? ""}
            options={[
              { value: "", label: "— none —" },
              { value: "gstin", label: "GSTIN" },
              { value: "gst", label: "GST Reg #" },
              { value: "vat", label: "VAT Reg #" },
              { value: "tax_reg", label: "Tax Reg #" },
              { value: "abn", label: "ABN" },
            ]}
          />
        </SettingRow>

        <SettingRow
          question="Your tax registration number"
          help="We use this number when no state-specific registration matches the place of supply."
        >
          <Input
            name="registration_number"
            defaultValue={region.registration_number ?? ""}
            placeholder="33AAFCN5032R1Z6"
            maxLength={50}
            className="w-56"
            aria-label="Your tax registration number"
          />
        </SettingRow>

        <SettingRow question="Collect a tax registration number from customers in this country?">
          <ToggleAnswer
            name="collect_registration_number"
            defaultChecked={region.collect_registration_number}
            label="Collect tax registration number from customers"
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="Reverse charge">
        <SettingRow
          question="Allow reverse charge for customers in this country?"
          help="The buyer becomes liable for the tax. The supply is zero-rated, and the invoice shows this."
        >
          <ToggleAnswer
            name="reverse_charge_enabled"
            defaultChecked={region.reverse_charge_enabled}
            label="Enable reverse charge"
          />
        </SettingRow>
        {/* Gated on the switch above: a note under a disabled reverse charge would
            never print, and showing its input suggests otherwise. */}
        <SettingRow
          question="Print a note on reverse-charge invoices?"
          help={reverseCharge ? undefined : "Enable reverse charge first."}
        >
          <ToggleAnswer
            name="show_reverse_charge_note"
            defaultChecked={region.show_reverse_charge_note}
            label="Show note on reverse charge"
          />
        </SettingRow>
        <SettingRow
          question="Reverse-charge note"
          help="Up to 250 characters. It prints below the payment details."
        >
          <Input
            name="reverse_charge_note"
            defaultValue={region.reverse_charge_note ?? ""}
            placeholder="Tax payable by recipient under reverse charge"
            maxLength={250}
            className="w-72"
            aria-label="Reverse-charge note"
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="Special economic zones (SEZ)">
        <SettingRow
          question="Offer “SEZ — with payment of IGST”?"
          help="You can then select this treatment on a customer. IGST applies even in your own state."
        >
          <ToggleAnswer
            name="sez_igst_enabled"
            defaultChecked={region.sez_igst_enabled}
            label="SEZ with IGST"
          />
        </SettingRow>
        <SettingRow question="Invoice note for SEZ with IGST" help="Up to 100 characters.">
          <Input
            name="sez_igst_note"
            defaultValue={region.sez_igst_note ?? ""}
            maxLength={100}
            className="w-72"
            aria-label="SEZ IGST invoice note"
          />
        </SettingRow>
        <SettingRow
          question="Offer “SEZ — zero-rated”?"
          help="You can then select this treatment on a customer. We charge no tax and record the reason."
        >
          <ToggleAnswer
            name="sez_zero_rated_enabled"
            defaultChecked={region.sez_zero_rated_enabled}
            label="SEZ zero-rated"
          />
        </SettingRow>
        <SettingRow question="Invoice note for SEZ zero-rated" help="Up to 100 characters.">
          <Input
            name="sez_zero_rated_note"
            defaultValue={region.sez_zero_rated_note ?? ""}
            maxLength={100}
            className="w-72"
            aria-label="SEZ zero-rated invoice note"
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="Exports">
        <SettingRow
          question="Offer “Export — with payment of IGST”?"
          help="For customers outside this country. IGST applies."
        >
          <ToggleAnswer
            name="export_igst_enabled"
            defaultChecked={region.export_igst_enabled}
            label="Export with IGST"
          />
        </SettingRow>
        <SettingRow question="Invoice note for export with IGST" help="Up to 100 characters.">
          <Input
            name="export_igst_note"
            defaultValue={region.export_igst_note ?? ""}
            maxLength={100}
            className="w-72"
            aria-label="Export IGST invoice note"
          />
        </SettingRow>
        <SettingRow
          question="Offer “Export — zero-rated”?"
          help="We charge no tax and record the reason."
        >
          <ToggleAnswer
            name="export_zero_rated_enabled"
            defaultChecked={region.export_zero_rated_enabled}
            label="Export zero-rated"
          />
        </SettingRow>
        <SettingRow question="Invoice note for export zero-rated" help="Up to 100 characters.">
          <Input
            name="export_zero_rated_note"
            defaultValue={region.export_zero_rated_note ?? ""}
            maxLength={100}
            className="w-72"
            aria-label="Export zero-rated invoice note"
          />
        </SettingRow>
      </SettingsCard>

      <div className="flex justify-end">
        <SubmitButton>Save tax settings</SubmitButton>
      </div>
    </ActionForm>
  );
}

/** One group of settings rows, as a record-page card. */
function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <RecordCard title={title} flush>
      <div className="divide-y [&_p]:max-w-prose">{children}</div>
    </RecordCard>
  );
}
