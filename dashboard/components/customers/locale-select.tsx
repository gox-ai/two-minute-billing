"use client";

import * as React from "react";
import { Combobox } from "@/components/ui/combobox";

/**
 * Language / locale picker for `customers.locale` — this was a free-text box,
 * which let `english`, `en_us` and `EN` into a column that is meant to hold one
 * BCP-47 tag.
 *
 * The list is CURATED, not authoritative: the API stores the tag verbatim
 * (`locale: z.string().max(20)`) and no renderer reads it yet, so the only job
 * this control has is to keep the stored value well-formed. Which is also why a
 * value already on the record that is NOT in the list is prepended to it — an
 * imported locale must survive an unrelated edit, and a select that
 * silently rewrote it would be worse than the text box it replaces.
 */
const LOCALES = [
  "en-US",
  "en-GB",
  "en-AU",
  "en-CA",
  "en-IN",
  "en-SG",
  "fr-FR",
  "fr-CA",
  "de-DE",
  "de-CH",
  "es-ES",
  "es-MX",
  "it-IT",
  "nl-NL",
  "pt-BR",
  "pt-PT",
  "da-DK",
  "fi-FI",
  "nb-NO",
  "sv-SE",
  "pl-PL",
  "cs-CZ",
  "tr-TR",
  "ru-RU",
  "uk-UA",
  "el-GR",
  "ar-AE",
  "he-IL",
  "hi-IN",
  "ta-IN",
  "te-IN",
  "bn-IN",
  "ja-JP",
  "ko-KR",
  "zh-CN",
  "zh-TW",
  "th-TH",
  "vi-VN",
  "id-ID",
  "ms-MY",
];

function localeLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    return name && name !== code ? `${name} — ${code}` : code;
  } catch {
    return code;
  }
}

/**
 * Search terms for a tag: the English name, plus the language and region subtags on their
 * own. `Intl.DisplayNames` renders `pt-BR` as "Brazilian Portuguese", which contains
 * neither "BR" nor "Brazil" as a separate word — so without this, searching the region
 * code an operator actually knows finds nothing.
 */
function localeKeywords(code: string): string {
  const [lang = "", region = ""] = code.split("-");
  let regionName = "";
  try {
    regionName = (region && new Intl.DisplayNames(["en"], { type: "region" }).of(region)) || "";
  } catch {
    regionName = "";
  }
  return `${code} ${lang} ${region} ${regionName}`;
}

export function LocaleSelect({
  name = "locale",
  defaultValue,
  className,
}: {
  name?: string;
  /** The stored tag, or null/'' when the customer has none. */
  defaultValue?: string | null;
  className?: string;
}) {
  const current = (defaultValue ?? "").trim();
  const options = React.useMemo(() => {
    const known = LOCALES.includes(current);
    return [
      // Empty is a real, storable state (the column is nullable) — not a
      // placeholder. Combobox posts '' for it, which the action clears to null.
      { value: "", label: "No language" },
      ...(current && !known
        ? [{ value: current, label: `${current} — stored on this customer` }]
        : []),
      ...LOCALES.map((code) => ({
        value: code,
        label: localeLabel(code),
        keywords: localeKeywords(code),
      })),
    ];
  }, [current]);

  return (
    <Combobox
      name={name}
      defaultValue={current}
      options={options}
      className={className}
      ariaLabel="Language / locale"
      placeholder="No language"
      searchPlaceholder="Search language, region or tag…"
      emptyMessage="No matching language."
    />
  );
}
