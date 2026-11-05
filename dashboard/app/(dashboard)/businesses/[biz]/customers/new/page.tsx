import { billingRules } from "@/lib/billing-rules";
import { listBusinesses } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { getCountries } from "@/lib/api/geo";
import { listCustomFieldDefinitions, type CustomFieldDefinition } from "@/lib/api/custom-fields";
import { CustomerForm, type CustomerDunningOptions } from "@/components/customers/customer-form";
import { listDunningPolicies } from "@/lib/api/dunning-policies";
import { customerDunningOptions } from "../../settings/dunning/defaults";

export const dynamic = "force-dynamic";

export default async function NewCustomerPage({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("customers:manage", "manager");
  let name = biz;
  let currencies: string[] | null = null;
  let cfDefs: CustomFieldDefinition[] = [];
  let dunning: CustomerDunningOptions | undefined;
  let defaultAutoCollection: "on" | "off" = "on";
  // Outside the try: the address fields cannot render without countries.
  const countries = await getCountries();
  try {
    const businesses = await listBusinesses();
    const business = businesses.data.find((b) => b.id === biz);
    name = business?.name ?? biz;
    currencies = business?.currencies ?? null;
    defaultAutoCollection = billingRules(business).new_customer_auto_collection;
    // Non-critical: without the policies the form omits the picker.
    const policies = await listDunningPolicies(biz).catch(() => null);
    if (business && policies) dunning = customerDunningOptions(policies.data, business, null);
  } catch {
    /* crumb + currency list only */
  }
  // A failure here still leaves a usable form, just without custom fields.
  try {
    cfDefs = (await listCustomFieldDefinitions(biz, { entityType: "customer" })).data;
  } catch {
    /* no custom-field card */
  }

  return (
    <CustomerForm
      mode="new"
      biz={biz}
      crumbs={[
        { label: name, href: `/businesses/${biz}` },
        { label: "Customers", href: `/businesses/${biz}/customers` },
        { label: "New customer" },
      ]}
      currencies={currencies}
      countries={countries}
      cfDefs={cfDefs}
      dunning={dunning}
      defaultAutoCollection={defaultAutoCollection}
    />
  );
}
