"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectField } from "@/components/ui/select-field";
import { DateTimeField } from "@/components/form/datetime-field";
import { CATEGORY_LABEL, TXN_KIND_LABEL } from "@/lib/credits";

type Values = Partial<
  Record<
    "grant" | "kind" | "category" | "unit" | "invoice" | "created_from" | "created_to" | "after",
    string
  >
>;

/**
 * The credit-transactions filters (`grant`, `kind`, `category`, `unit`, `invoice`,
 * `created[gte|lt]`, `include=holds`). A GET form: the filters live in the URL.
 */
export function CreditTransactionFiltersForm({
  units,
  values,
}: {
  units: Array<{ value: string; label: string }>;
  values: Values;
}) {
  const any = Object.entries(values).some(([k, v]) => k !== "after" && v);
  return (
    <form method="get" action="#transactions" className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="kind">Movement</Label>
          <SelectField
            name="kind"
            defaultValue={values.kind ?? ""}
            ariaLabel="Movement"
            options={[
              { value: "", label: "All movements" },
              ...Object.entries(TXN_KIND_LABEL).map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="category">Category</Label>
          <SelectField
            name="category"
            defaultValue={values.category ?? ""}
            ariaLabel="Category"
            options={[
              { value: "", label: "All categories" },
              ...Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="unit">Unit</Label>
          <SelectField
            name="unit"
            defaultValue={values.unit ?? ""}
            ariaLabel="Unit"
            options={[{ value: "", label: "All units" }, ...units]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="grant">Grant ID</Label>
          <Input
            id="grant"
            name="grant"
            defaultValue={values.grant ?? ""}
            placeholder="cgr_…"
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invoice">Invoice ID</Label>
          <Input
            id="invoice"
            name="invoice"
            defaultValue={values.invoice ?? ""}
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="created_from">From</Label>
          <DateTimeField
            id="created_from"
            name="created_from"
            granularity="date"
            defaultValue={values.created_from ?? null}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="created_to">Before</Label>
          <DateTimeField
            id="created_to"
            name="created_to"
            granularity="date"
            defaultValue={values.created_to ?? null}
          />
        </div>
        {/* Hold rows (`include=holds`) are not in the API yet, so there is no control for them. */}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="outline">
          Apply filters
        </Button>
        {any ? (
          <Link href="?#transactions" className="text-sm text-primary hover:underline">
            Clear filters
          </Link>
        ) : null}
      </div>
    </form>
  );
}
