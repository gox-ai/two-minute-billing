import { requirePermission } from "@/lib/session";
import {
  listMetadataKeyRules,
  getMetadataRuleSettings,
  listObservedMetadataKeys,
  type MetadataKeyRule,
  type MetadataRuleSettings,
} from "@/lib/api/metadata-rules";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ErrorState } from "@/components/states";
import { cn } from "@/lib/utils";
import {
  More,
  SettingRow,
  SettingsCard,
  SettingsPage,
} from "@/components/settings/settings-layout";
import {
  AddRuleButton,
  CreateFromSuggestionButton,
  RuleRowActions,
  StrictSwitch,
  ValidationSwitch,
} from "./controls";
import { draftRuleFrom, ruleSuggestions, type ObservedKey } from "@/lib/metadata-editor";
import { TYPE_LABEL } from "./types";

export const dynamic = "force-dynamic";

const ENTITIES = [
  { key: "customer", label: "Customers", noun: "customer" },
  { key: "subscription", label: "Subscriptions", noun: "subscription" },
] as const;

/** One line per rule limit, so the table says what each rule checks. */
function limits(r: MetadataKeyRule): string {
  const parts: string[] = [];
  if (r.data_type === "enum" && r.enum_options?.length) parts.push(r.enum_options.join(", "));
  if (r.pattern) parts.push(`matches ${r.pattern}`);
  if (r.max_length != null) parts.push(`up to ${r.max_length} characters`);
  if (r.integer) parts.push("whole numbers");
  if (r.min != null && r.max != null) parts.push(`${r.min} to ${r.max}`);
  else if (r.min != null) parts.push(`${r.min} or more`);
  else if (r.max != null) parts.push(`${r.max} or less`);
  if (r.item_type)
    parts.push(
      `${{ string: "text", number: "number", boolean: "true or false" }[r.item_type]} items`,
    );
  if (r.item_enum_options?.length) parts.push(r.item_enum_options.join(", "));
  if (r.min_items != null) parts.push(`at least ${r.min_items} items`);
  if (r.max_items != null) parts.push(`at most ${r.max_items} items`);
  return parts.join(" · ");
}

// Metadata rules (0332): checks on paths inside the free-form metadata of customers and
// subscriptions. Distinct from custom fields, which are typed values in their own column.
export default async function MetadataRulesSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");
  const crumbs = [
    { label: "Settings", href: `/businesses/${biz}/settings` },
    { label: "Metadata rules" },
  ];

  let rules: MetadataKeyRule[];
  let settings: MetadataRuleSettings;
  let observed: Record<(typeof ENTITIES)[number]["key"], ObservedKey[]>;
  try {
    const [list, s, oc, os] = await Promise.all([
      listMetadataKeyRules(biz),
      getMetadataRuleSettings(biz),
      // Suggestions only: a failed read shows none.
      listObservedMetadataKeys(biz, "customer").catch(() => null),
      listObservedMetadataKeys(biz, "subscription").catch(() => null),
    ]);
    rules = list.data;
    settings = s;
    observed = { customer: oc?.data ?? [], subscription: os?.data ?? [] };
  } catch (e) {
    return (
      <SettingsPage title="Metadata rules" crumbs={crumbs}>
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Metadata rules"
      crumbs={crumbs}
      description="Check the metadata that your integrations write on customers and subscriptions. A rule sets the type of the value at a key or a nested path. Rules check new writes only."
    >
      {ENTITIES.map((ent) => {
        const conf = settings[ent.key];
        const on = conf.metadata_validation === "on";
        const rows = rules.filter((r) => r.entity_type === ent.key);
        const active = rows.filter((r) => !r.archived).length;
        return (
          <SettingsCard
            key={ent.key}
            id={ent.key}
            title={ent.label}
            meta={`${active} active${rows.length > active ? ` · ${rows.length - active} archived` : ""} · Validation ${on ? "on" : "off"}`}
            actions={<AddRuleButton biz={biz} entity={ent.key} />}
          >
            <SettingRow
              label="Validate metadata"
              help={`Check each write of ${ent.noun} metadata against the rules below.`}
              placement="end"
              control={<ValidationSwitch biz={biz} entity={ent.key} on={on} />}
              consequence={
                on
                  ? `On. A write that breaks a rule gets an error and is not saved. Stored ${ent.noun} metadata does not change.`
                  : `Off. The rules are not checked, and ${ent.noun} metadata is saved as sent. When you enable this, we check only later writes. Stored data does not change.`
              }
            />
            <SettingRow
              label="Strict mode"
              help="Refuse a key or path that no rule covers."
              placement="end"
              control={<StrictSwitch biz={biz} entity={ent.key} on={conf.strict} disabled={!on} />}
              consequence={
                !on
                  ? `Strict mode works only while validation is on.${conf.strict ? " It is set, and it starts to apply when you enable validation." : ""}`
                  : conf.strict
                    ? "On. A new key with no rule gets an error. A key is covered when it has a rule, or when a rule is below it, such as billing for billing.po."
                    : "Off. Keys with no rule are saved as sent."
              }
            />
            {rows.length === 0 ? (
              <p className="m-0 px-5 py-6 text-sm text-muted-foreground">
                No rules for {ent.label.toLowerCase()} yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Path</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Checks</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="pr-5 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} className={cn(r.archived && "opacity-60")}>
                      <TableCell className="pl-5 font-mono text-xs">
                        {r.key}
                        {r.description ? (
                          <span className="block font-sans text-xs text-muted-foreground">
                            {r.description}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>{TYPE_LABEL[r.data_type] ?? r.data_type}</TableCell>
                      <TableCell className="max-w-72 text-xs text-muted-foreground">
                        {limits(r) || "—"}
                      </TableCell>
                      <TableCell>
                        {r.archived ? (
                          <Badge variant="outline">Archived</Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">Active</span>
                        )}
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        <RuleRowActions biz={biz} rule={r} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <Suggestions
              biz={biz}
              entity={ent.key}
              noun={ent.noun}
              items={ruleSuggestions(observed[ent.key], rows)}
            />
          </SettingsCard>
        );
      })}

      <SettingsCard id="about" title="How the rules work" padded>
        <More label="Paths, optional values, strict mode and archiving">
          A path is a key, or keys joined with dots that go into nested objects, such as
          billing.address.city. A rule below another rule needs that rule to have the Object type.
          Every path is optional: a rule checks a value only when it is present and not null. For a
          value that each record must have, use a custom field and set it to Required. Hosted
          checkout and integrations do not use strict mode. Strict mode checks each level that has
          rules below it. Inside an Object rule with no rules below it, any content is allowed. A
          value that was stored before a rule existed, and that is sent again with no change, is
          accepted. Archive stops a rule. Restore starts it again.
        </More>
      </SettingsCard>
    </SettingsPage>
  );
}

const fmtCount = (n: number) => n.toLocaleString("en-US");

/** Paths in use with no rule yet, each with a "Create rule" that pre-fills the dialog. */
function Suggestions({
  biz,
  entity,
  noun,
  items,
}: {
  biz: string;
  entity: (typeof ENTITIES)[number]["key"];
  noun: string;
  items: ObservedKey[];
}) {
  if (!items.length) return null;
  return (
    <div className="border-t">
      <div className="px-5 pt-4 pb-2">
        <p className="m-0 text-sm font-medium">Suggested from your data</p>
        <p className="m-0 text-xs text-muted-foreground">
          Paths in your recent {noun} metadata that have no rule.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">Path</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Records</TableHead>
            <TableHead>Values</TableHead>
            <TableHead className="pr-5 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((o) => {
            const vals = o.values ?? o.item_values;
            return (
              <TableRow key={o.path}>
                <TableCell className="pl-5 font-mono text-xs">{o.path}</TableCell>
                <TableCell>{o.type}</TableCell>
                <TableCell className="tabular-nums">{fmtCount(o.rows)}</TableCell>
                <TableCell className="max-w-72 text-xs text-muted-foreground">
                  {vals?.length
                    ? vals.map((v) => (v.value === "" ? "(empty)" : String(v.value))).join(", ")
                    : `${fmtCount(o.distinct_values)} different values`}
                </TableCell>
                <TableCell className="pr-5 text-right">
                  <CreateFromSuggestionButton biz={biz} entity={entity} draft={draftRuleFrom(o)} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
