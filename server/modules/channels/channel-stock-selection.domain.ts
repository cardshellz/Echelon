import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { isInventoryManagedVariant } from "@shared/catalog/variant-inventory-eligibility";
import { stockPublicationSelectionSchema, type StockPublicationSelection } from "@shared/types/stock-publication-selection";
import type { CatalogStockSelectionFacts } from "../catalog/catalog-stock-selection.reader";
import { isVariantSellable } from "./ebay-listing-eligibility";

export interface ChannelStockSelectionFacts {
  channelId: number;
  channelConnectionId: number;
  provider: "shopify" | "ebay" | "walmart";
  productId: number;
  productVariantIds: readonly number[];
  catalog: CatalogStockSelectionFacts;
  productIsListed: number | null;
  typeListingEnabled: boolean | null;
  variants: readonly {
    productVariantId: number;
    variantIsListed: number | null;
    feed: { active: boolean; quarantined: boolean; externalVariantId: string | null; externalInventoryItemId: string | null; externalSku: string | null } | null;
    listing: { status: string | null; externalProductId: string | null; externalVariantId: string | null; externalSku: string | null } | null;
  }[];
  latestJob: {
    id: string; operation: "publish" | "sync" | "withdraw"; state: string;
    accountId?: string;
    members: readonly { variantId: number; sku: string; offerId: string | null; listingId: string | null }[];
    verifiedMembers: readonly { variantId: number; sku: string; offerId: string | null; listingId: string | null }[];
  } | null;
}

/** Listing eligibility remains with its existing resolver. This projection owns
 * only whether the known destination wants positive stock, a clearing zero, or
 * a read-only quantity preview. Inventory still proves the exact mapping. */
export function resolveChannelStockSelection(facts: ChannelStockSelectionFacts): StockPublicationSelection {
  const variants = [...facts.productVariantIds].sort((a, b) => a - b).map(productVariantId => {
    const catalog = facts.catalog.variants.find(variant => variant.id === productVariantId);
    const product = facts.catalog.product;
    const known = facts.variants.find(variant => variant.productVariantId === productVariantId);
    const jobMember = facts.latestJob?.members.find(member => member.variantId === productVariantId);
    const blockers: StockPublicationSelection["variants"][number]["blockers"] = [];
    const result = (action: StockPublicationSelection["variants"][number]["action"], reason: string) => ({ productVariantId, action, reason, blockers });
    if (!catalog || !product) {
      blockers.push({ code: "CHANNEL_SELECTION_CATALOG_IDENTITY_MISSING", message: "This requested variant no longer belongs to the selected catalog product. Review its saved mapping before publishing stock." });
      return result("none", "The exact catalog identity could not be established.");
    }
    const feed = known?.feed;
    const listing = known?.listing;
    if (feed?.quarantined) blockers.push({ code: "CHANNEL_SELECTION_MAPPING_QUARANTINED", message: "This channel mapping is quarantined. Review or repair its provider identity before publishing stock." });
    const hasSavedIdentity = Boolean(feed && (feed.externalInventoryItemId || feed.externalVariantId || feed.externalSku))
      || Boolean(listing && (listing.externalProductId || listing.externalVariantId || listing.externalSku))
      || Boolean(jobMember && (jobMember.offerId || jobMember.listingId));
    const isEbay = facts.provider === "ebay";
    const selected = isInventoryManagedVariant(catalog) && isVariantSellable({
      productActive: product.isActive, variantActive: catalog.isActive, salesEligibility: catalog.salesEligibility,
      productOverrideIsListed: facts.productIsListed, variantOverrideIsListed: known?.variantIsListed,
      ...(isEbay ? { productExcluded: product.ebayListingExcluded, variantExcluded: catalog.ebayListingExcluded,
        typeListingEnabled: facts.typeListingEnabled } : {}),
    }) && (isEbay || product.status === "active");
    const withdrawing = isEbay && jobMember && facts.latestJob?.operation === "withdraw"
      && facts.latestJob.state !== "completed";
    const withdrawn = facts.latestJob?.verifiedMembers.find(member => member.variantId === productVariantId);
    const verifiedRemoval = isEbay && facts.latestJob?.operation === "withdraw" && facts.latestJob.state === "completed"
      && listing?.status === "ended" && withdrawn?.offerId && withdrawn.listingId
      && withdrawn.offerId === listing.externalVariantId && withdrawn.listingId === listing.externalProductId
      && withdrawn.sku === (listing.externalSku ?? jobMember?.sku);
    if (!selected && verifiedRemoval)
      return { ...result("none", "The saved withdrawal verified removal of this exact listing; no stock publication remains due."),
        ...(facts.latestJob?.accountId && blockers.length === 0 ? { retirementEvidence: {
          operationId: facts.latestJob.id, externalAccountId: facts.latestJob.accountId,
          externalSku: withdrawn.sku, externalOfferId: withdrawn.offerId!, externalListingId: withdrawn.listingId!,
        } } : {}) };
    if (!selected || withdrawing || (!isEbay && feed?.active === false)) {
      return hasSavedIdentity
        ? result("zero", withdrawing ? "The saved withdrawal is pending; positive stock must remain disabled." : "The channel selection excludes this retained destination; its stock must be cleared.")
        : result("none", "The variant is not selected and has no saved provider destination to clear.");
    }
    const publishIntent = isEbay && jobMember && facts.latestJob?.operation === "publish";
    const ended = listing && ["ended", "deleted"].includes(listing.status ?? "");
    if (isEbay && ended && !publishIntent)
      return result("read_only", "The variant is selected, but its previous listing ended. A new reviewed publication must establish its managed destination.");
    const managedIntent = isEbay ? Boolean(hasSavedIdentity || publishIntent) : feed?.active === true;
    if (managedIntent) return result("publish", "The existing channel selection requests stock for this known listing destination.");
    return result("read_only", "The candidate is selected for listing review, but no managed stock publication intent is saved yet.");
  });
  const fingerprint = createHash("sha256").update(canonicalJson({ ...facts,
    productVariantIds: [...facts.productVariantIds].sort((a, b) => a - b),
    variants: [...facts.variants].sort((a, b) => a.productVariantId - b.productVariantId),
    catalog: { product: facts.catalog.product, variants: [...facts.catalog.variants].sort((a, b) => a.id - b.id) },
    latestJob: facts.latestJob ? { ...facts.latestJob, members: [...facts.latestJob.members].sort((a, b) => a.variantId - b.variantId),
      verifiedMembers: [...facts.latestJob.verifiedMembers].sort((a, b) => a.variantId - b.variantId) } : null,
  })).digest("hex");
  return stockPublicationSelectionSchema.parse({ productId: facts.productId, fingerprint, variants });
}
