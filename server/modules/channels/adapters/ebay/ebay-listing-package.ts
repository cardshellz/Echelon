import { z } from "zod";
import Decimal from "decimal.js";
import type { ChannelPackageFacts, ChannelPackageRequirements, ChannelPackageOperation } from "@shared/catalog/shipping-package";
import { prepareChannelPackage, type ChannelPackagePlan, type ListingPackageValues } from "../../../marketplace-listings/domain/channel-package";
import { EbayListingSyncError } from "../../ebay-listing-sync.domain";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { BuiltInventoryItem } from "./ebay-listing-builder";
import type { EbayInventoryItem, EbayPackageWeightAndSize } from "./ebay-types";
import type { EbayObservedOffer } from "../../listing-connectors/ebay-listing.connector";
import { ChannelProviderReadError, providerReadDiagnosticFromError } from "@shared/channel-provider-read";
import { EbayApiRequestError } from "./ebay-api-error";

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
 * enforces requirements; preserved provider fields keep their original units. */
export function resolveEbayListingPackage(input: { source: EbayPackageSource; sku: string;
  observed?: EbayPackageWeightAndSize; operation?: ChannelPackageOperation }): { payload: EbayPackageWeightAndSize; plan: ChannelPackagePlan } {
  const { facts } = input.source;
  const preserved = structuredClone(input.observed ?? {});
  if (facts.weightGrams != null) delete preserved.weight;
  if ([facts.lengthMm, facts.widthMm, facts.heightMm].some(value => value != null)) delete preserved.dimensions;
  const plan = prepareChannelPackage({ ...input.source, sku: input.sku,
    catalog: facts,
    operation: input.operation,
    observed: observedValues(preserved) });
  const payload: EbayPackageWeightAndSize = structuredClone(input.observed ?? {});
  if (plan.sources.weight === "catalog") payload.weight = { value: Number(plan.values.weightGrams), unit: "GRAM" };
  if (plan.sources.dimensions === "catalog") payload.dimensions = {
    length: new Decimal(plan.values.lengthMm!).div(10).toNumber(),
    width: new Decimal(plan.values.widthMm!).div(10).toNumber(),
    height: new Decimal(plan.values.heightMm!).div(10).toNumber(), unit: "CENTIMETER",
  };
  // packageType is optional in the Inventory API contract. It remains provider-owned:
  // preserve an observed value, but never infer one or replay a retired catalog override.
  return { payload, plan };
}

type ItemReader = { getInventoryItem(sku: string): Promise<EbayInventoryItem | null>;
  getOffers?(sku: string, marketplaceId: string): Promise<{ offers: EbayObservedOffer[] }>;
  getOffer?(offerId: string): Promise<unknown | null> };
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

async function readPackagePolicy<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (cause) {
    if (providerReadDiagnosticFromError(cause) || !(cause instanceof EbayApiRequestError) || cause.statusCode === undefined) throw cause;
    const status = cause.statusCode;
    throw new ChannelProviderReadError({ provider: "ebay", resource: "offer_shipping_policy", method: "GET",
      kind: status === 429 || status >= 500 ? "unavailable" : "refused", httpStatus: status }, { cause });
  }
}

/** Translate proved provider topology to a channel-neutral operation. A saved
 * flag or SKU alone cannot relax publication validation, nor can an unchanged
 * listing justify changing to a different fulfillment policy without it. */
async function packageOperation(client: ItemReader, input: { sku: string; variantId: number;
  desiredPolicyId: string | undefined; current: EbayInventoryItem | null;
  maintenance?: EbayPackageMaintenanceScope;
  offerReads?: ReadonlyMap<string, { offers: EbayObservedOffer[] }> }): Promise<ChannelPackageOperation> {
  const maintenance = input.maintenance;
  const expected = maintenance?.variants.find(member => member.variantId === input.variantId && member.sku === input.sku);
  if (!maintenance || !input.current || !expected?.offerId || !expected.listingId || !client.getOffers) return "publication";
  const response = input.offerReads?.get(input.sku)
    ?? await readPackagePolicy(() => client.getOffers!(input.sku, maintenance.marketplaceId));
  const published = response.offers.filter(offer => offer.sku === input.sku && offer.marketplaceId === maintenance.marketplaceId
    && offer.status === "PUBLISHED");
  const matches = response.offers.filter(offer => offer.sku === input.sku && offer.offerId === expected.offerId
    && offer.marketplaceId === maintenance.marketplaceId && offer.status === "PUBLISHED"
    && (offer.listingId ?? offer.listing?.listingId) === expected.listingId);
  if (matches.length !== 1 || published.length !== 1) throw new EbayListingSyncError("EBAY_SYNC_OFFER_IDENTITY_CHANGED",
    "The published offer changed while checking its shipping requirements. Refresh this listing and retry Sync.");
  let policyId: string | undefined = matches[0].listingPolicies?.fulfillmentPolicyId;
  // Collection responses can omit listingPolicies; get the exact offer rather
  // than treating that omission as an unchanged policy or inventing a default.
  if (!policyId && client.getOffer) {
    const parsed = z.object({ offerId: z.string().min(1), sku: z.string().min(1), marketplaceId: z.string().min(1),
      status: z.enum(["PUBLISHED", "UNPUBLISHED"]), listingId: z.string().min(1).optional(),
      listing: z.object({ listingId: z.string().min(1) }).passthrough().optional(),
      listingPolicies: z.object({ fulfillmentPolicyId: z.string().min(1).optional() }).passthrough().optional(),
    }).passthrough().safeParse(await readPackagePolicy(() => client.getOffer!(expected.offerId!)));
    if (!parsed.success) throw new ChannelProviderReadError({ provider: "ebay", resource: "offer_shipping_policy",
      method: "GET", kind: "invalid_response", issues: parsed.error.issues.slice(0, 25)
        .map(issue => ({ path: issue.path.join("."), code: issue.code })) });
    const offer = parsed.data;
    if (!offer || offer.offerId !== expected.offerId || offer.sku !== input.sku
      || offer.marketplaceId !== maintenance.marketplaceId || offer.status !== "PUBLISHED"
      || (offer.listingId ?? offer.listing?.listingId) !== expected.listingId)
      throw new EbayListingSyncError("EBAY_SYNC_OFFER_IDENTITY_CHANGED", "The exact offer could not be verified. Refresh this listing and retry Sync.");
    policyId = offer.listingPolicies?.fulfillmentPolicyId;
  }
  if (!policyId) {
    // Fulfillment policy is listing-level across all offers in a variation
    // listing. A verified published sibling may supply this fact when both
    // offer endpoints omit it; desired local settings are never evidence.
    // https://developer.ebay.com/api-docs/sell/static/inventory/inventory-item-to-offer.html
    const observedPolicyIds = new Set<string>();
    for (const peer of maintenance.variants.filter(member => member.sku !== input.sku && member.offerId
      && member.listingId === expected.listingId)) {
      const read = input.offerReads?.get(peer.sku)
        ?? await readPackagePolicy(() => client.getOffers!(peer.sku, maintenance.marketplaceId));
      const matching = read.offers.filter(offer => offer.sku === peer.sku && offer.offerId === peer.offerId
        && offer.marketplaceId === maintenance.marketplaceId && offer.status === "PUBLISHED"
        && (offer.listingId ?? offer.listing?.listingId) === expected.listingId);
      if (matching.length !== 1 || read.offers.filter(offer => offer.sku === peer.sku
        && offer.marketplaceId === maintenance.marketplaceId && offer.status === "PUBLISHED").length !== 1)
        throw new EbayListingSyncError("EBAY_SYNC_OFFER_IDENTITY_CHANGED",
        "A member of the published listing changed while checking shipping requirements. Refresh this listing and retry Sync.");
      const peerPolicy = matching[0].listingPolicies?.fulfillmentPolicyId;
      if (typeof peerPolicy === "string" && peerPolicy.trim()) observedPolicyIds.add(peerPolicy);
    }
    if (observedPolicyIds.size === 1) policyId = [...observedPolicyIds][0];
  }
  if (typeof policyId !== "string" || !policyId.trim()) throw new ChannelProviderReadError({ provider: "ebay",
    resource: "offer_shipping_policy", method: "GET", kind: "invalid_response",
    issues: [{ path: "listingPolicies.fulfillmentPolicyId", code: "missing" }] });
  return policyId && policyId === input.desiredPolicyId ? "maintenance" : "publication";
}
/** Read and prepare every member before any provider mutation or intent seal. */
export async function prepareEbayListingPackages<T extends { productId: number; inventoryItems: BuiltInventoryItem[];
  offers: Array<{ sku: string; variantId: number; payload?: { listingPolicies?: { fulfillmentPolicyId?: string } } }> }>(
    client: ItemReader, draft: T, maintenance?: EbayPackageMaintenanceScope): Promise<T> {
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
    let packageMaintenance: EbayPackageMaintenanceProof | undefined;
    let payload: EbayPackageWeightAndSize, plan: ChannelPackagePlan;
    if (source) {
      // No extra policy read is needed when complete dimensions already satisfy
      // publication validation, or when dimensions are optional in both modes.
      const needsMaintenanceRule = source.requirements.dimensions === true
        && source.requirements.dimensionsOnMaintenance !== undefined
        && [source.facts.lengthMm, source.facts.widthMm, source.facts.heightMm].every(value => value == null)
        && current?.packageWeightAndSize?.dimensions == null;
      const operation = !needsMaintenanceRule ? "publication"
        : await packageOperation(client, { sku: item.sku, variantId: member.variantId, current,
          desiredPolicyId: member.payload?.listingPolicies?.fulfillmentPolicyId, maintenance });
      if (operation === "maintenance") {
        const expected = maintenance?.variants.find(value => value.variantId === member.variantId && value.sku === item.sku);
        const policyId = member.payload?.listingPolicies?.fulfillmentPolicyId;
        if (!maintenance || !expected?.offerId || !expected.listingId || !policyId)
          throw new EbayListingSyncError("EBAY_SYNC_DRAFT_SCOPE_INVALID", "A maintenance package must retain its verified listing and shipping policy scope.");
        packageMaintenance = { marketplaceId: maintenance.marketplaceId, variantId: member.variantId, sku: item.sku,
          offerId: expected.offerId, listingId: expected.listingId, fulfillmentPolicyId: policyId,
          relatedMembers: maintenance.variants.filter(value => value.sku !== item.sku && value.listingId === expected.listingId)
            .map(value => ({ variantId: value.variantId, sku: value.sku, offerId: value.offerId, listingId: value.listingId }))
            .sort((left, right) => left.variantId - right.variantId) };
      }
      ({ payload, plan } = resolveEbayListingPackage({ source, sku: item.sku, observed: current?.packageWeightAndSize, operation }));
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
      if (plan.sources.weight === "catalog") payload.weight = structuredClone(legacy!.weight);
      if (plan.sources.dimensions === "catalog") payload.dimensions = structuredClone(legacy!.dimensions);
    }
    // Remove the original container even when no measurements remain. Otherwise
    // a legacy type-only draft would survive the conditional spread below.
    const { packageWeightAndSize: _previousPackage, ...basePayload } = item.payload;
    inventoryItems.push({ ...item, packagePlan: plan, packageMaintenance,
      payload: { ...basePayload, ...(Object.keys(payload).length ? { packageWeightAndSize: payload } : {}) } });
  }
  return { ...draft, inventoryItems };
}

/** Detect channel edits to fields we promised to preserve before the first PUT.
 * Catalog-owned fields are intentionally replaced. Provider writes are still
 * serialized and journaled by the existing publication owner. */
export async function assertEbayPackagePreservation(client: ItemReader, items: readonly BuiltInventoryItem[],
  offerReads?: ReadonlyMap<string, { offers: EbayObservedOffer[] }>): Promise<void> {
  for (const item of items) {
    if (!item.packagePlan) throw new EbayListingSyncError("EBAY_SYNC_DRAFT_SCOPE_INVALID", "Package data must be prepared before publishing.");
    const current = await client.getInventoryItem(item.sku);
    if (current && current.sku !== item.sku) throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The observed inventory item does not match the requested SKU.");
    if (item.packageMaintenance) {
      const proof = item.packageMaintenance;
      const operation = await packageOperation(client, { sku: item.sku, variantId: proof.variantId, current,
        desiredPolicyId: proof.fulfillmentPolicyId, offerReads, maintenance: { marketplaceId: proof.marketplaceId,
          variants: [{ variantId: proof.variantId, sku: proof.sku, offerId: proof.offerId, listingId: proof.listingId }, ...proof.relatedMembers] } });
      if (operation !== "maintenance") throw new EbayListingSyncError("EBAY_SYNC_PACKAGE_CHANGED",
        "The published shipping policy changed after package preparation. Retry Sync to check its current requirements before another update.");
    }
    const preserved = (value: EbayPackageWeightAndSize | undefined) => {
      const copy = structuredClone(value ?? {});
      if (item.packagePlan!.sources.weight === "catalog") delete copy.weight;
      if (item.packagePlan!.sources.dimensions === "catalog") delete copy.dimensions;
      return copy;
    };
    observedValues(preserved(current?.packageWeightAndSize));
    if (canonicalJson(preserved(current?.packageWeightAndSize)) !== canonicalJson(preserved(item.payload.packageWeightAndSize)))
      throw new EbayListingSyncError("EBAY_SYNC_PACKAGE_CHANGED", "Package data changed on eBay after preparation. The saved update will prepare it again before replacing the item.");
  }
}
