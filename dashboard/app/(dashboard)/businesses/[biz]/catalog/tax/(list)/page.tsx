import { listBusinesses, listTaxRegions } from "@/lib/api";
import { createTaxRegionAction } from "@/app/actions";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { CreateDialog } from "@/components/create-dialog";
import { Field } from "@/components/form/field";
import { ErrorState } from "@/components/states";
import { AddRegionFields } from "@/components/tax/add-region-fields";
import { TaxRegionsTable } from "@/components/tax/tax-regions-table";
import { ActionForm } from "@/components/form/action-form";

export const dynamic = "force-dynamic";

export default async function TaxRegionsPage({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("taxes:view", "manager");

  let businesses, regions;
  try {
    [businesses, regions] = await Promise.all([listBusinesses(), listTaxRegions(biz)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Taxes" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  /* Hoisted so the zero-state can hold the real control too: "Add a region for each country
     you collect tax in." named an action the empty screen gave no way to take. */
  const addRegion = (
    <CreateDialog
      triggerLabel="Create region"
      title="Create a taxable region"
      description="Create one region for each country where you collect tax. You configure rates on the region."
    >
      <ActionForm action={createTaxRegionAction} className="space-y-4">
        <input type="hidden" name="biz" value={biz} />
        {/* Country + derived regime + strict state picker. Client component
            because the state options and the regime both follow the country. */}
        <AddRegionFields />
        <Field name="price_type" label="Catalog prices in this country" required>
          <SelectField
            name="price_type"
            defaultValue="exclusive"
            ariaLabel="Price type"
            options={[
              { value: "exclusive", label: "Exclusive of tax: tax is a separate line" },
              { value: "inclusive", label: "Inclusive of tax: the price includes tax" },
            ]}
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit">Create region</Button>
        </div>
      </ActionForm>
    </CreateDialog>
  );

  return (
    <>
      <PageHeader
        title="Taxes"
        breadcrumbs={[
          { label: name, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: "Taxes" },
        ]}
        actions={addRegion}
      />

      <Card>
        <CardContent className="space-y-5">
          <TaxRegionsTable biz={biz} rows={regions.data} createAction={addRegion} />
        </CardContent>
      </Card>
    </>
  );
}
