/**
 * Apply ONE transfer item inside the caller's transaction. Each kind re-reads its source row,
 * resolves its references in the destination by natural key, and writes. The caller commits
 * the write and the item's `done` together, so a crash never leaves a half-applied item.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import {
  attachedItems,
  businesses,
  couponItemConstraints,
  coupons,
  creditUnits,
  differentialPrices,
  meters,
  priceRates,
  prices,
  productGroups,
  products,
  taxProfiles,
} from "@db/schema";
import type { Biz } from "./plan";
import { copyTaxRates, copyValues, wipeDestinationCatalog } from "./service";
import { plain } from "./items";

type Row = Record<string, unknown>;

export interface ItemToApply {
  kind: string;
  key: string;
  section: string;
  action: string;
  sourceRef: string | null;
  diff: unknown;
}

export interface Applied {
  resultRef: string | null;
  /** The destination values this write replaced; null for a create. */
  replaced: unknown;
}

export class ItemApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemApplyError";
  }
}

const RUNTIME_STRIP = ["timesRedeemed", "lockedAt", "foldedFrom", "backfilledAt"];
const strip = (v: Row, keep: string[] = []) => {
  for (const k of RUNTIME_STRIP) if (!keep.includes(k)) delete v[k];
  return v;
};

async function one<T>(rows: Promise<T[]> | T[]): Promise<T | undefined> {
  return (await rows)[0];
}

export async function applyItem(tx: Tx, item: ItemToApply, src: Biz, dest: Biz): Promise<Applied> {
  const org = dest.organizationId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const source = async (table: any): Promise<Row> => {
    const r = await one(
      tx
        .select()
        .from(table)
        .where(and(eq(table.id, item.sourceRef), eq(table.businessId, src.id)))
        .limit(1),
    );
    if (!r)
      throw new ItemApplyError("The source no longer has this item. Check the changes again.");
    return r as Row;
  };
  const product = async (pub: string) => {
    const p = await one(
      tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.businessId, dest.id), eq(products.publicId, pub)))
        .limit(1),
    );
    if (!p) throw new ItemApplyError(`The destination has no product ${pub}.`);
    return p.id;
  };
  const productPubOf = async (id: string) =>
    (await one(tx.select({ p: products.publicId }).from(products).where(eq(products.id, id))))?.p;

  /** Insert, or update the row the natural key finds; `create` refuses a row that appeared. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upsert = async (table: any, existing: Row | undefined, values: Row, keyCols: string[]) => {
    if (item.action === "create") {
      if (existing)
        throw new ItemApplyError("It is in the destination now. Check the changes again.");
      const [row] = await tx.insert(table).values(values).returning({ id: table.id });
      return { resultRef: String(row!.id), replaced: null };
    }
    if (!existing)
      throw new ItemApplyError("It is no longer in the destination. Check the changes again.");
    const set = { ...values };
    for (const k of keyCols) delete set[k];
    for (const k of RUNTIME_STRIP) delete set[k];
    await tx.update(table).set(set).where(eq(table.id, existing.id));
    return { resultRef: String(existing.id), replaced: plain(existing) };
  };

  switch (item.kind) {
    case "clear": {
      await wipeDestinationCatalog(tx, dest.id, [item.section as "catalog"]);
      return { resultRef: null, replaced: null };
    }
    case "meter": {
      const s = await source(meters);
      const existing = await one(
        tx
          .select()
          .from(meters)
          .where(and(eq(meters.businessId, dest.id), eq(meters.key, String(s.key))))
          .limit(1),
      );
      return upsert(meters, existing, strip(copyValues(s, org, dest.id)), ["key"]);
    }
    case "credit_unit": {
      const s = await source(creditUnits);
      const existing = await one(
        tx
          .select()
          .from(creditUnits)
          .where(and(eq(creditUnits.businessId, dest.id), eq(creditUnits.key, String(s.key))))
          .limit(1),
      );
      return upsert(creditUnits, existing, strip(copyValues(s, org, dest.id)), ["key"]);
    }
    case "tax_default_rename": {
      const to = (item.diff as Array<{ to: string }> | null)?.[0]?.to;
      const p = await one(
        tx
          .select()
          .from(taxProfiles)
          .where(
            and(eq(taxProfiles.id, String(item.sourceRef)), eq(taxProfiles.businessId, dest.id)),
          ),
      );
      if (!p || !to)
        throw new ItemApplyError("The default tax profile changed. Check the changes again.");
      await tx.update(taxProfiles).set({ name: to }).where(eq(taxProfiles.id, p.id));
      return { resultRef: p.id, replaced: { name: p.name } };
    }
    case "tax_profile": {
      const s = await source(taxProfiles);
      const before = await one(
        tx
          .select()
          .from(taxProfiles)
          .where(and(eq(taxProfiles.businessId, dest.id), eq(taxProfiles.name, String(s.name)))),
      );
      const rep = { created: 0, updated: 0, skipped: 0 };
      await copyTaxRates(tx, src.id, dest.id, org, rep, "overwrite", String(s.name));
      const after = await one(
        tx
          .select({ id: taxProfiles.id })
          .from(taxProfiles)
          .where(and(eq(taxProfiles.businessId, dest.id), eq(taxProfiles.name, String(s.name)))),
      );
      return { resultRef: after?.id ?? null, replaced: before ? plain(before) : null };
    }
    case "product_group": {
      const s = await source(productGroups);
      const existing = await one(
        tx
          .select()
          .from(productGroups)
          .where(
            and(
              eq(productGroups.businessId, dest.id),
              eq(productGroups.publicId, String(s.publicId)),
            ),
          )
          .limit(1),
      );
      return upsert(productGroups, existing, copyValues(s, org, dest.id), ["publicId"]);
    }
    case "product": {
      const s = await source(products);
      let groupId: string | null = null;
      if (s.productGroupId) {
        const g = await one(
          tx
            .select({ p: productGroups.publicId })
            .from(productGroups)
            .where(eq(productGroups.id, String(s.productGroupId))),
        );
        const dg = g
          ? await one(
              tx
                .select({ id: productGroups.id })
                .from(productGroups)
                .where(and(eq(productGroups.businessId, dest.id), eq(productGroups.publicId, g.p))),
            )
          : undefined;
        if (!dg) throw new ItemApplyError(`The destination has no product group ${g?.p ?? ""}.`);
        groupId = dg.id;
      }
      let taxProfileId: string | null = null;
      if (s.taxProfileId) {
        const sp = await one(
          tx
            .select({ name: taxProfiles.name })
            .from(taxProfiles)
            .where(eq(taxProfiles.id, String(s.taxProfileId))),
        );
        const dp = sp
          ? await one(
              tx
                .select({ id: taxProfiles.id })
                .from(taxProfiles)
                .where(and(eq(taxProfiles.businessId, dest.id), eq(taxProfiles.name, sp.name))),
            )
          : undefined;
        if (!dp)
          throw new ItemApplyError(`The destination has no tax profile "${sp?.name ?? ""}".`);
        taxProfileId = dp.id;
      }
      const existing = await one(
        tx
          .select()
          .from(products)
          .where(and(eq(products.businessId, dest.id), eq(products.publicId, String(s.publicId))))
          .limit(1),
      );
      return upsert(
        products,
        existing,
        copyValues(s, org, dest.id, { productGroupId: groupId, taxProfileId }),
        ["publicId"],
      );
    }
    case "price": {
      const s = await source(prices);
      const pub = await productPubOf(String(s.productId));
      const productId = await product(String(pub));
      let meterId: string | null = null;
      if (s.meterId) {
        const m = await one(
          tx
            .select({ key: meters.key })
            .from(meters)
            .where(eq(meters.id, String(s.meterId))),
        );
        const dm = m
          ? await one(
              tx
                .select({ id: meters.id })
                .from(meters)
                .where(and(eq(meters.businessId, dest.id), eq(meters.key, m.key))),
            )
          : undefined;
        if (!dm) throw new ItemApplyError(`The destination has no meter ${m?.key ?? ""}.`);
        meterId = dm.id;
      }
      const unit = (s.grantsCredit as { unit?: string | null } | null)?.unit;
      if (unit) {
        const du = await one(
          tx
            .select({ id: creditUnits.id })
            .from(creditUnits)
            .where(and(eq(creditUnits.businessId, dest.id), eq(creditUnits.key, unit))),
        );
        if (!du) throw new ItemApplyError(`The destination has no credit unit ${unit}.`);
      }
      const existing = await one(
        tx
          .select()
          .from(prices)
          .where(and(eq(prices.businessId, dest.id), eq(prices.publicId, String(s.publicId))))
          .limit(1),
      );
      const res = await upsert(
        prices,
        existing,
        copyValues(s, org, dest.id, { productId, meterId }),
        ["publicId"],
      );
      // The rate card goes with its price, whole.
      const destPriceId = res.resultRef!;
      const oldRates = await tx
        .select()
        .from(priceRates)
        .where(eq(priceRates.priceId, destPriceId));
      if (oldRates.length) await tx.delete(priceRates).where(eq(priceRates.priceId, destPriceId));
      const srcRates = await tx
        .select()
        .from(priceRates)
        .where(eq(priceRates.priceId, String(s.id)));
      if (srcRates.length)
        await tx
          .insert(priceRates)
          .values(srcRates.map((r) => copyValues(r, org, dest.id, { priceId: destPriceId })));
      if (res.replaced) (res.replaced as Row).rates = plain(oldRates);
      return res;
    }
    case "attached_item": {
      const s = await source(attachedItems);
      const itemId = await product(String(await productPubOf(String(s.itemProductId))));
      const planId = await product(String(await productPubOf(String(s.planProductId))));
      const existing = await one(
        tx
          .select()
          .from(attachedItems)
          .where(
            and(
              eq(attachedItems.businessId, dest.id),
              eq(attachedItems.itemProductId, itemId),
              eq(attachedItems.planProductId, planId),
            ),
          ),
      );
      return upsert(
        attachedItems,
        existing,
        copyValues(s, org, dest.id, { itemProductId: itemId, planProductId: planId }),
        [],
      );
    }
    case "differential_price": {
      const s = await source(differentialPrices);
      const addonId = await product(String(await productPubOf(String(s.addonProductId))));
      const planId = await product(String(await productPubOf(String(s.planProductId))));
      const existing = await one(
        tx
          .select()
          .from(differentialPrices)
          .where(
            and(
              eq(differentialPrices.businessId, dest.id),
              eq(differentialPrices.addonProductId, addonId),
              eq(differentialPrices.planProductId, planId),
              eq(differentialPrices.currency, String(s.currency)),
              s.interval == null
                ? isNull(differentialPrices.interval)
                : eq(differentialPrices.interval, String(s.interval)),
            ),
          ),
      );
      const values = copyValues(s, org, dest.id, {
        addonProductId: addonId,
        planProductId: planId,
      });
      // A dprice_ id is unique across businesses: a new row gets its own.
      if (existing) delete values.publicId;
      else values.publicId = publicId("dprice");
      return upsert(differentialPrices, existing, values, []);
    }
    case "coupon": {
      const s = await source(coupons);
      const existing = await one(
        tx
          .select()
          .from(coupons)
          .where(and(eq(coupons.businessId, dest.id), eq(coupons.code, String(s.code))))
          .limit(1),
      );
      const values = copyValues(s, org, dest.id);
      values.timesRedeemed = 0;
      return upsert(coupons, existing, values, ["code"]);
    }
    case "coupon_constraint": {
      const s = await source(couponItemConstraints);
      const sc = await one(
        tx
          .select({ code: coupons.code })
          .from(coupons)
          .where(eq(coupons.id, String(s.couponId))),
      );
      const dc = sc
        ? await one(
            tx
              .select({ id: coupons.id })
              .from(coupons)
              .where(and(eq(coupons.businessId, dest.id), eq(coupons.code, sc.code))),
          )
        : undefined;
      if (!dc) throw new ItemApplyError(`The destination has no coupon ${sc?.code ?? ""}.`);
      const existing = await one(
        tx
          .select()
          .from(couponItemConstraints)
          .where(
            and(
              eq(couponItemConstraints.couponId, dc.id),
              eq(couponItemConstraints.itemKind, String(s.itemKind)),
            ),
          ),
      );
      return upsert(
        couponItemConstraints,
        existing,
        copyValues(s, org, dest.id, { couponId: dc.id }),
        ["couponId", "itemKind"],
      );
    }
    case "field": {
      const column = String(item.sourceRef) as keyof Biz;
      const to = (item.diff as Array<{ to: unknown }> | null)?.[0]?.to ?? null;
      const [cur] = await tx
        .select()
        .from(businesses)
        .where(eq(businesses.id, dest.id))
        .for("update");
      const set: Record<string, unknown> = { [column]: to };
      // One transport per business (businesses_mail_transport_ck): switching one on switches
      // the other off in the same write, as the email settings do.
      const other =
        column === "smtpConfig" ? "sesConfig" : column === "sesConfig" ? "smtpConfig" : null;
      const otherCfg = other ? (cur?.[other] as Row | null) : null;
      if (other && (to as Row | null)?.enabled === true && otherCfg?.enabled === true)
        set[other] = { ...otherCfg, enabled: false };
      await tx
        .update(businesses)
        .set(set as Partial<Biz>)
        .where(eq(businesses.id, dest.id));
      return {
        resultRef: dest.id,
        replaced: Object.fromEntries(
          Object.keys(set).map((k) => [k, plain(cur?.[k as keyof Biz] ?? null)]),
        ),
      };
    }
  }
  throw new ItemApplyError(`Unknown item kind ${item.kind}.`);
}
