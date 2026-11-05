"use client";

import { useRouter } from "next/navigation";
import { ProductGroupForm } from "@/components/catalog/product-group-dialog";
import type { ProductGroup } from "@/lib/api";

/** The product group edit form as a page body (the edit route). */
export function EditProductGroupPanel({
  biz,
  group,
  listHref,
}: {
  biz: string;
  group: ProductGroup;
  listHref: string;
}) {
  const router = useRouter();
  return (
    <ProductGroupForm
      biz={biz}
      group={group}
      cancelHref={listHref}
      onDone={() => router.push(listHref)}
    />
  );
}
