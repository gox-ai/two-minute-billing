import { requirePermission } from "@/lib/session";
import { listCustomFieldDefinitions, type CustomFieldDefinition } from "@/lib/api/custom-fields";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
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
import { More, SettingsCard, SettingsPage } from "@/components/settings/settings-layout";
import { RowActions } from "./row-actions";
import { AddFieldForm } from "./add-field-form";
import { TYPE_LABEL } from "./types";

export const dynamic = "force-dynamic";

const ENTITIES: Array<{ key: "customer" | "subscription"; label: string; where: string }> = [
  {
    key: "customer",
    label: "Customers",
    where: "Edited on the customer form and through the API",
  },
  // The subscription forms render no custom fields; only the API writes them.
  { key: "subscription", label: "Subscriptions", where: "Set through the API" },
];

// Custom fields (SET-4): typed fields per business + entity, surfaced as cf_<name> on
// records and in the API. Distinct from metadata.
export default async function CustomFieldsSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");
  const crumbs = [
    { label: "Settings", href: `/businesses/${biz}/settings` },
    { label: "Custom fields" },
  ];

  let defs: CustomFieldDefinition[];
  try {
    const res = await listCustomFieldDefinitions(biz, { includeArchived: true });
    defs = res.data;
  } catch (e) {
    return (
      <SettingsPage title="Custom fields" crumbs={crumbs}>
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Custom fields"
      crumbs={crumbs}
      description="Typed fields that you define for customers and subscriptions. Each field shows as cf_<name> on the record and in the API. Custom fields are separate from metadata."
    >
      {ENTITIES.map((ent) => {
        const rows = defs.filter((d) => d.entity_type === ent.key);
        const active = rows.filter((d) => !d.archived).length;
        return (
          <SettingsCard
            key={ent.key}
            title={ent.label}
            meta={`${active} active${rows.length > active ? ` · ${rows.length - active} archived` : ""} · ${ent.where}`}
            actions={
              <a href="#add-field" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Create a field
              </a>
            }
          >
            {rows.length === 0 ? (
              <p className="m-0 px-5 py-6 text-sm text-muted-foreground">
                No custom fields for {ent.label.toLowerCase()} yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">API name</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Flags</TableHead>
                    <TableHead className="pr-5 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => (
                    <TableRow key={d.id} className={cn(d.archived && "opacity-60")}>
                      <TableCell className="pl-5 font-mono text-xs">{d.cf_name}</TableCell>
                      <TableCell>{d.label}</TableCell>
                      <TableCell>
                        {TYPE_LABEL[d.data_type] ?? d.data_type}
                        {d.data_type === "enum" && d.enum_options?.length ? (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({d.enum_options.join(", ")})
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          {d.required && <Badge variant="secondary">Required</Badge>}
                          {d.is_pii && <Badge variant="secondary">Personal data</Badge>}
                          {d.show_in_portal && <Badge variant="secondary">Portal flag</Badge>}
                          {d.archived && <Badge variant="outline">Archived</Badge>}
                        </span>
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        <RowActions biz={biz} id={d.id} archived={d.archived} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SettingsCard>
        );
      })}

      <SettingsCard id="add-field" title="Create a custom field" meta="Name, type and flags">
        <AddFieldForm biz={biz} />
        <div className="px-5 py-3">
          <More label="About Required, archiving and flags">
            Required applies to customers and subscriptions that you create in the dashboard or
            through the API. The hosted checkout does not ask for custom fields, so its signups
            complete with these fields empty. When you archive a field, nobody can set new values.
            Values that are already stored stay readable, and Restore brings the field back.
            &ldquo;Personal data&rdquo; is only a label on the definition. Some definitions store a
            &ldquo;Portal flag&rdquo;, but the self-serve portal does not show custom fields.
          </More>
        </div>
      </SettingsCard>
    </SettingsPage>
  );
}
