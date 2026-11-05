import { listBusinesses, getCustomer, listTaxRegions, type TaxRegion } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { getCountries, type Country } from "@/lib/api/geo";
import { listCustomFieldDefinitions, type CustomFieldDefinition } from "@/lib/api/custom-fields";
import { accountHolderName } from "@/lib/names";
import { CustomerForm, type CustomerDunningOptions } from "@/components/customers/customer-form";
import { listDunningPolicies } from "@/lib/api/dunning-policies";
import { customerDunningOptions } from "../../../settings/dunning/defaults";
import { loadMetadataEditor } from "@/lib/api/metadata-rules";
import type { MetadataEditorData } from "@/components/form/metadata-field";

export const dynamic = "force-dynamic";

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ biz: string; cus: string }>;
}) {
  const { biz, cus } = await params;
  await requirePermission("customers:manage", "manager");

  let name = biz;
  let currencies: string[] | null = null;
  let customer;
  let cfDefs: CustomFieldDefinition[] = [];
  let taxRegions: TaxRegion[] = [];
  let countries: Country[] = [];
  let metadataEditor: MetadataEditorData | null = null;
  let dunning: CustomerDunningOptions | undefined;
  try {
    const [businesses, c, defs, regions, countryList, mdEditor, policies] = await Promise.all([
      listBusinesses(),
      getCustomer(biz, cus),
      // Non-critical: no definitions just means no custom-field card.
      listCustomFieldDefinitions(biz, { entityType: "customer" }).catch(() => ({ data: [] })),
      // Non-critical: no regions means no treatment select (the field says why).
      listTaxRegions(biz).catch(() => ({ data: [] })),
      getCountries(),
      // Non-critical: null falls back to the plain JSON field.
      loadMetadataEditor(biz, "customer"),
      // Non-critical: without the policies the form omits the picker. Archived ones are
      // read so a customer still holding one shows it.
      listDunningPolicies(biz, { includeArchived: true }).catch(() => null),
    ]);
    const business = businesses.data.find((b) => b.id === biz);
    name = business?.name ?? biz;
    currencies = business?.currencies ?? null;
    customer = c;
    cfDefs = defs.data;
    taxRegions = regions.data;
    countries = countryList;
    metadataEditor = mdEditor;
    if (business && policies)
      dunning = customerDunningOptions(policies.data, business, c.dunning_policy);
  } catch (e) {
    return (
      <>
        <PageHeader title="Edit customer" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  return (
    <CustomerForm
      mode="edit"
      biz={biz}
      customer={customer}
      taxRegions={taxRegions}
      metadataEditor={metadataEditor}
      crumbs={[
        { label: name, href: `/businesses/${biz}` },
        { label: "Customers", href: `/businesses/${biz}/customers` },
        {
          label: accountHolderName(customer) ?? customer.id,
          href: `/businesses/${biz}/customers/${customer.id}`,
        },
        { label: "Edit" },
      ]}
      currencies={currencies}
      countries={countries}
      cfDefs={cfDefs}
      dunning={dunning}
    />
  );
}
