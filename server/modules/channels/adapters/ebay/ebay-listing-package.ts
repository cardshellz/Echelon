import { z } from "zod";
import Decimal from "decimal.js";
import type { ChannelPackageFacts, ChannelPackageRequirements } from "@shared/catalog/shipping-package";
import { prepareChannelPackage, type ChannelPackagePlan, type ListingPackageValues } from "../../../marketplace-listings/domain/channel-package";
import { EbayListingSyncError } from "../../ebay-listing-sync.domain";
import { canonicalJson } from "@shared/utils/canonical-json";
import { prepareChannelPublicationWeight } from "../../../marketplace-listings/domain/channel-package-weight";
import type { BuiltInventoryItem } from "./ebay-listing-builder";
import type { EbayInventoryItem, EbayPackageWeightAndSize } from "./ebay-types";
import type { EbayNativePackageReader } from "./ebay-native-package.reader";
import { EBAY_US_STANDARD_PACKAGE_TYPE, ebayPreparedPackageTypeSchema, type EbayPreparedPackageType } from "./ebay-package-classification";

export interface EbayPackageSource {
  productId: number; variantId: number; facts: ChannelPackageFacts;
  requirements: ChannelPackageRequirements;
}
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
    heightMm: p.dimensions ? new Decimal(p.dimensions.height).mul(lengthUnits[p.dimensions.unit]).toNumber() : null };
}

/** Transport translation only. The shared package owner selects facts and
 * enforces requirements. Weight uses shared publication precision; preserved
 * dimensions, flags and provider extensions retain their original values. */
export function resolveEbayListingPackage(input: { source: EbayPackageSource; sku: string;
  observed?: EbayPackageWeightAndSize }): { payload: EbayPackageWeightAndSize; plan: ChannelPackagePlan } {
  const { facts } = input.source;
  const preserved = structuredClone(input.observed ?? {});
  if (facts.weightGrams != null) delete preserved.weight;
  if ([facts.lengthMm, facts.widthMm, facts.heightMm].some(value => value != null)) delete preserved.dimensions;
  const plan = prepareChannelPackage({ ...input.source, sku: input.sku,
    catalog: facts,
    observed: observedValues(preserved) });
  const payload: EbayPackageWeightAndSize = structuredClone(input.observed ?? {});
  if (plan.values.weightGrams != null) payload.weight = {
    value: prepareChannelPublicationWeight({ value: plan.values.weightGrams, unit: "GRAM" }).ounces, unit: "OUNCE",
  };
  if (plan.sources.dimensions === "catalog") payload.dimensions = {
    length: new Decimal(plan.values.lengthMm!).div(10).toNumber(),
    width: new Decimal(plan.values.widthMm!).div(10).toNumber(),
    height: new Decimal(plan.values.heightMm!).div(10).toNumber(), unit: "CENTIMETER",
  };
  // packageType is optional in the Inventory API contract. It remains provider-owned:
  // preserve an observed value, but never infer one or replay a retired catalog override.
  return { payload, plan };
}

type ItemReader = { getInventoryItem(sku: string): Promise<EbayInventoryItem | null>; getListingPackageType?: EbayNativePackageReader };

/** Verify the native classification when Inventory GET omits its projection.
 * Other package fields remain the exact inventory response, without backfill. */
export async function readEbayPackageVerificationView(client: ItemReader, item: BuiltInventoryItem,
  current: EbayInventoryItem, marketplaceId: string): Promise<EbayInventoryItem> {
  if (!item.payload.packageWeightAndSize?.packageType || current.packageWeightAndSize?.packageType !== undefined
    || marketplaceId !== "EBAY_US" || !client.getListingPackageType) return current;
  const native = await client.getListingPackageType(item.sku, marketplaceId);
  if (native.packageType === null) return current;
  return { ...current, packageWeightAndSize: { ...current.packageWeightAndSize, packageType: native.packageType } };
}

/** @deprecated Retained only to decode and hash already-sealed historical drafts.
 * New preparation never creates an operation-specific package proof. */
export interface EbayPackageMaintenanceScope {
  marketplaceId: string;
  variants: ReadonlyArray<{ variantId: number; sku: string; offerId: string | null; listingId: string | null }>;
}
export interface EbayPackageMaintenanceProof {
  marketplaceId: string;
  variantId: number;
  sku: string;
  offerId: string;
  listingId: string;
  fulfillmentPolicyId: string;
  relatedMembers: EbayPackageMaintenanceScope["variants"];
}

/** Read and prepare every member before any provider mutation or intent seal. */
export async function prepareEbayListingPackages<T extends { productId: number; marketplaceId?: string; inventoryItems: BuiltInventoryItem[];
  offers: Array<{ sku: string; variantId: number; payload?: { listingPolicies?: { fulfillmentPolicyId?: string } } }> }>(
    client: ItemReader, draft: T, observedOffersBySku?: ReadonlyMap<string, readonly unknown[]>): Promise<T> {
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
    if (source) {
      ({ payload, plan } = resolveEbayListingPackage({ source, sku: item.sku, observed: current?.packageWeightAndSize }));
    }
    else {
      plan = prepareChannelPackage({ productId: draft.productId,
        variantId: member.variantId, sku: item.sku,
        catalog: observedValues({ weight: legacy?.weight, dimensions: legacy?.dimensions }), observed: observedValues(current?.packageWeightAndSize),
        requirements: { weight: false, dimensions: false } });
      // Old builders supplied default provider flags without a catalog source.
      // Only weight and dimensions are authoritative in that draft;
      // preserve provider flags and extensions instead of replaying defaults.
      payload = structuredClone(current?.packageWeightAndSize ?? {});
      if (plan.values.weightGrams != null) payload.weight = {
        value: prepareChannelPublicationWeight({ value: plan.values.weightGrams, unit: "GRAM" }).ounces, unit: "OUNCE",
      };
      if (plan.sources.dimensions === "catalog") payload.dimensions = structuredClone(legacy!.dimensions);
    }
    // Remove the original container even when no measurements remain. Otherwise
    // a legacy type-only draft would survive the conditional spread below.
    const { packageWeightAndSize: _previousPackage, ...basePayload } = item.payload;
    let packageTypeProof: EbayPreparedPackageType | undefined;
    // Only an authoritative read can distinguish absence from a failed read.
    // New publication reuses the connector's exact offer discovery; unpublished
    // offers do not need a native GetItem request.
    if (!payload.packageType && payload.weight && draft.marketplaceId === "EBAY_US" && client.getListingPackageType) {
      const native = await client.getListingPackageType(item.sku, draft.marketplaceId, observedOffersBySku?.get(item.sku));
      packageTypeProof = ebayPreparedPackageTypeSchema.parse({ sku: item.sku, marketplaceId: draft.marketplaceId,
        listingId: native.listingId, packageType: native.packageType ?? EBAY_US_STANDARD_PACKAGE_TYPE,
        ...(native.packageType === null ? { source: "marketplace_default", observedPackageType: null } : {}) });
      payload.packageType = packageTypeProof.packageType;
    }
    const { packageMaintenance: _legacyProof, packageTypeProof: _previousTypeProof, ...preparedItem } = item;
    inventoryItems.push({ ...preparedItem, packagePlan: plan, ...(packageTypeProof ? { packageTypeProof } : {}),
      payload: { ...basePayload, ...(Object.keys(payload).length ? { packageWeightAndSize: payload } : {}) } });
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
    if (item.packageTypeProof) {
      const proof = ebayPreparedPackageTypeSchema.parse(item.packageTypeProof);
      if (proof.sku !== item.sku || !client.getListingPackageType || item.payload.packageWeightAndSize?.packageType !== proof.packageType)
        throw new EbayListingSyncError("EBAY_SYNC_DRAFT_SCOPE_INVALID", "The prepared package classification no longer matches this SKU's verified source.");
      const native = await client.getListingPackageType(item.sku, proof.marketplaceId);
      const observed = current?.packageWeightAndSize?.packageType;
      // An earlier journaled item PUT may already have applied our default.
      // A different observed class is a concurrent edit, never permission to
      // overwrite it with the default or with an old sealed value.
      const nativeUnchanged = native.packageType === proof.packageType
        || ("source" in proof && native.packageType === proof.observedPackageType);
      if (native.listingId !== proof.listingId || !nativeUnchanged || (observed !== undefined && observed !== proof.packageType))
        throw new EbayListingSyncError("EBAY_SYNC_PACKAGE_CHANGED", "Package configuration changed on eBay after preparation. Retry Sync to prepare current values.");
    }
    // Preserve the original measurement when checking a channel-owned weight.
    // Comparing only rounded ounces would hide concurrent edits in one bucket.
    if (item.packagePlan.sources.weight === "channel") {
      const observedWeight = observedValues(current?.packageWeightAndSize).weightGrams;
      const intendedWeight = observedValues(item.payload.packageWeightAndSize).weightGrams;
      if (intendedWeight == null) throw new EbayListingSyncError("EBAY_SYNC_DRAFT_SCOPE_INVALID",
        "The prepared update is missing the package weight it must preserve. Prepare the listing again before syncing.");
      // An earlier successful item stage may already have normalized this
      // weight before a later stage failed. Its exact target is safe to resume;
      // an unrelated edit inside the same rounded ounce is still a conflict.
      const unchanged = observedWeight != null && new Decimal(observedWeight).eq(item.packagePlan.values.weightGrams!);
      const alreadyApplied = observedWeight != null && new Decimal(observedWeight).eq(intendedWeight);
      if (!unchanged && !alreadyApplied)
        throw new EbayListingSyncError("EBAY_SYNC_PACKAGE_CHANGED", "Package weight changed on eBay after preparation. Prepare the update again before replacing the item.");
    }
    const preserved = (value: EbayPackageWeightAndSize | undefined) => {
      const copy = structuredClone(value ?? {});
      if (item.packagePlan!.sources.weight !== "absent") delete copy.weight;
      if (item.packagePlan!.sources.dimensions === "catalog") delete copy.dimensions;
      if (item.packageTypeProof) delete copy.packageType;
      return copy;
    };
    observedValues(preserved(current?.packageWeightAndSize));
    if (canonicalJson(preserved(current?.packageWeightAndSize)) !== canonicalJson(preserved(item.payload.packageWeightAndSize)))
      throw new EbayListingSyncError("EBAY_SYNC_PACKAGE_CHANGED", "Package data changed on eBay after preparation. The saved update will prepare it again before replacing the item.");
  }
}
