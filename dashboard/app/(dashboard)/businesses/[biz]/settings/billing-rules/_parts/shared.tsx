import Link from "next/link";

/** Crumbs for a page under Billing rules. */
export function ruleCrumbs(biz: string, label: string) {
  const base = `/businesses/${biz}/settings`;
  return [
    { label: "Settings", href: base },
    { label: "Billing rules", href: `${base}/billing-rules` },
    { label },
  ];
}

/** The hidden inputs every billing-rules form posts. */
export function FormIds({ biz, version }: { biz: string; version?: number | null }) {
  return (
    <>
      <input type="hidden" name="biz" value={biz} />
      {version != null ? <input type="hidden" name="expected_version" value={version} /> : null}
    </>
  );
}

/** A footer line for the summary column pointing at Time Travel. */
export function TimeTravelNote({ biz }: { biz: string }) {
  return (
    <p className="m-0 border-t px-5 py-3 text-sm text-muted-foreground">
      Try these rules on a test clock in{" "}
      <Link href={`/businesses/${biz}/time_travel`} className="text-primary hover:underline">
        Time Travel
      </Link>
      .
    </p>
  );
}

/** A hub row for a rule; the shared settings row. */
export { SettingsLinkRow as RuleLink } from "@/components/settings/settings-layout";
