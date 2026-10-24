import { z } from "zod";
import Decimal from "decimal.js";
import type { ChannelPackageFacts, ChannelPackageRequirements } from "@shared/catalog/shipping-package";
import { shippingPackageTypeSchema } from "@shared/catalog/shipping-package";
import { ChannelListingValidationError } from "@shared/channel-listing-validation";
import { prepareChannelPackage, type ChannelPackagePlan, type ListingPackageValues } from "../../../marketplace-listings/domain/channel-package";
import { EbayListingSyncError } from "../../ebay-listing-sync.domain";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { BuiltInventoryItem } from "./ebay-listing-builder";
import type { EbayInventoryItem, EbayPackageWeightAndSize } from "./ebay-types";

export interface EbayPackageSource {
  productId: number; variantId: number; facts: ChannelPackageFacts;
  requirements: ChannelPackageRequirements;
}
const packageTypes = { parcel: "PACKAGE_THICK_ENVELOPE", letter: "LETTER", large_envelope: "LARGE_ENVELOPE" } as const;
const positive = z.number().finite().positive();
const observedPackageSchema = z.object({
  weight: z.object({ value: positive, unit: z.enum(["GRAM", "KILOGRAM", "POUND", "OUNCE"]) }).passthrough().optional(),
  dimensions: z.object({ length: positive, width: positive, height: positive,
    unit: z.enum(["CENTIMETER", "METER", "INCH", "FEET"]) }).passthrough().optional(),
  packageType: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).optional(),
  shippingIrregular: z.boolean().optional(),
}).passthrough();
const weightUnits = { GRAM: 1, KILOGRAM: 1000, POUND: 453.59237, OUNCE: 28.349523125 };
const lengthUnits = { CENTIMETER: 10, METER: 1000, INCH: 25.4, FEET: 304.8 };

function observedValues(value: EbayPackageWeightAndSize | undefined): ListingPackageValues {
  const parsed = observedPackageSchema.safeParse(value ?? {});
  if (!parsed.success) throw new EbayListingSyncError("EBAY_PACKAGE_READ_INVALID",
    "eBay returned incomplete or invalid package data. No package replacement was sent. Review the package on eBay and retry.");
  const p = parsed.data;
  return { weightGrams: p.weight ? new Decimal(p.weight.value).mul(weightUnits[p.weight.unit]).toNumber() : null,
    lengthMm: p.dimensions ? new Decimal(p.dimensions.length).mul(lengthUnits[p.dimensions.unit]).toNumber() : null,
    widthMm: p.dimensions ? new Decimal(p.dimensions.width).mul(lengthUnits[p.dimensions.unit]).toNumber() : null,
    heightMm: p.dimensions ? new Decimal(p.dimensions.height).mul(lengthUnits[p.dimensions.unit]).toNumber() : null,
    packageType: p.packageType ?? null };
}

/** Transport translation only. The shared package owner selects facts and
 * enforces requirements; preserved provider fields keep their original units. */
export function resolveEbayListingPackage(input: { source: EbayPackageSource; sku: string;
  observed?: EbayPackageWeightAndSize }): { payload: EbayPackageWeightAndSize; plan: ChannelPackagePlan } {
  const { facts } = input.source;
  const parsedType = shippingPackageTypeSchema.nullish().safeParse(facts.shippingPackageType);
  if (!parsedType.success) throw new ChannelListingValidationError({ field: "package_type", reason: "invalid",
    productId: input.source.productId, variantId: input.source.variantId, variantSku: input.sku });
  const preserved = structuredClone(input.observed ?? {});
  if (facts.weightGrams != null) delete preserved.weight;
  if ([facts.lengthMm, facts.widthMm, facts.heightMm].some(value => value != null)) delete preserved.dimensions;
  if (facts.shippingPackageType != null) delete preserved.packageType;
  const plan = prepareChannelPackage({ ...input.source, sku: input.sku,
    catalog: { ...facts, packageType: parsedType.data ? packageTypes[parsedType.data] : null },
    observed: observedValues(preserved) });
  const payload: EbayPackageWeightAndSize = structuredClone(input.observed ?? {});
  if (plan.sources.weight === "catalog") payload.weight = { value: Number(plan.values.weightGrams), unit: "GRAM" };
  if (plan.sources.dimensions === "catalog") payload.dimensions = {
    length: new Decimal(plan.values.lengthMm!).div(10).toNumber(),
    width: new Decimal(plan.values.widthMm!).div(10).toNumber(),
    height: new Decimal(plan.values.heightMm!).div(10).toNumber(), unit: "CENTIMETER",
  };
  if (plan.sources.packageType === "catalog") payload.packageType = plan.values.packageType!;
  return { payload, plan };
}

type ItemReader = { getInventoryItem(sku: string): Promise<EbayInventoryItem | null> };
/** Read and prepare every member before any provider mutation or intent seal. */
export async function prepareEbayListingPackages<T extends { productId: number; inventoryItems: BuiltInventoryItem[];
  offers: Array<{ sku: string; variantId: number }> }>(client: ItemReader, draft: T): Promise<T> {
  const inventoryItems: BuiltInventoryItem[] = [];
  for (const item of draft.inventoryItems) {
    const member = draft.offers.find(offer => offer.sku === item.sku);
    if (!member) throw new EbayListingSyncError("EBAY_SYNC_DRAFT_SCOPE_INVALID", "Every package must belong to an included listing member.");
    const current = await client.getInventoryItem(item.sku);
    if (current && current.sku !== item.sku) throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The observed inventory item does not match the requested SKU.");
    // Legacy drafts carry provider-shaped facts. Preserve their reviewed values
    // while still retaining every existing package field they do not replace.
    const legacy = item.payload.packageWeightAndSize;
    const source = item.packageSource;
    let payload: EbayPackageWeightAndSize, plan: ChannelPackagePlan;
    if (source) ({ payload, plan } = resolveEbayListingPackage({ source, sku: item.sku, observed: current?.packageWeightAndSize }));
    else {
      plan = prepareChannelPackage({ productId: draft.productId,
        variantId: member.variantId, sku: item.sku,
        catalog: observedValues(legacy), observed: observedValues(current?.packageWeightAndSize),
        requirements: { weight: false, dimensions: false, packageType: false } });
      payload = { ...structuredClone(current?.packageWeightAndSize ?? {}), ...structuredClone(legacy ?? {}) };
    }
    inventoryItems.push({ ...item, packagePlan: plan,
      payload: { ...item.payload, ...(Object.keys(payload).length ? { packageWeightAndSize: payload } : {}) } });
  }
  return { ...draft, inventoryItems };
}

/** Detect channel edits to fields we promised to preserve before the first PUT.
 * Catalog-owned fields are intentionally replaced. Provider writes are still
 * serialized and journaled by the existing publication owner. */
export async function assertEbayPackagePreservation(client: ItemReader, items: readonly BuiltInventoryItem[]): Promise<void> {
  for (const item of items) {
    if (!item.packagePlan) throw new EbayListingSyncError("EBAY_SYNC_DRAFT_SCOPE_INVALID", "Package data must be prepared before publishing.");
    const current = await client.getInventoryItem(item.sku);
    if (current && current.sku !== item.sku) throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The observed inventory item does not match the requested SKU.");
    const preserved = (value: EbayPackageWeightAndSize | undefined) => {
      const copy = structuredClone(value ?? {});
      if (item.packagePlan!.sources.weight === "catalog") delete copy.weight;
      if (item.packagePlan!.sources.dimensions === "catalog") delete copy.dimensions;
      if (item.packagePlan!.sources.packageType === "catalog") delete copy.packageType;
      return copy;
    };
    observedValues(preserved(current?.packageWeightAndSize));
    if (canonicalJson(preserved(current?.packageWeightAndSize)) !== canonicalJson(preserved(item.payload.packageWeightAndSize)))
      throw new EbayListingSyncError("EBAY_SYNC_PACKAGE_CHANGED", "Package data changed on eBay after preparation. The saved update will prepare it again before replacing the item.");
  }
}
