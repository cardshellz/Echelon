import type { StockPublicationSelection } from "@shared/types/stock-publication-selection";
import type { ListingMemberRetirement } from "@shared/types/listing-member-lifecycle";
import { archivedListingMemberSelection, isArchivedCatalogMember } from "../../marketplace-listings/listing-member-lifecycle";
import { isCustomerSellableVariant, type VariantSalesEligibility } from "@shared/catalog/variant-sales-eligibility";
import {
  evaluateDropshipCatalogExposure,
  type DropshipCatalogExposureRule,
  type DropshipCatalogVariantCandidate,
} from "./catalog-exposure";
import {
  evaluateDropshipVendorCatalogSelection,
  type DropshipVendorSelectionRule,
  type DropshipVendorVariantOverride,
} from "./vendor-selection";

export interface DropshipStockListingState {
  id: number;
  productVariantId: number;
  status: string;
  externalListingId: string | null;
  externalOfferId: string | null;
  /** Only a saved, noncancelled live push intent for this exact destination. */
  livePushItemId: number | null;
}

export interface DropshipStockSelectionConfig {
  listingMode: "draft_first" | "live" | "manual_only";
  inventoryMode: "managed_quantity_sync" | "manual_quantity" | "disabled";
  isActive: boolean;
}

type VariantSelection = StockPublicationSelection["variants"][number];

/** Listing intent only. ATP, destination mapping, standing/tier holds and provider
 * readiness retain their existing owners and are deliberately not computed here. */
export function decideDropshipStockPublicationSelection(input: {
  productVariantId: number;
  candidate: (DropshipCatalogVariantCandidate & {
    requiresShipping: boolean | null;
    trackInventory: boolean | null;
    salesEligibility: VariantSalesEligibility | null;
    productStatus?: string | null;
  }) | null;
  rules: readonly DropshipCatalogExposureRule[];
  vendorRules: readonly DropshipVendorSelectionRule[];
  override: DropshipVendorVariantOverride | null;
  listing: DropshipStockListingState | null;
  config: DropshipStockSelectionConfig | null;
  storePaused: boolean;
  now: Date;
  retirement?: ListingMemberRetirement | null;
}): VariantSelection {
  const result = (action: VariantSelection["action"], reason: string,
    blockers: VariantSelection["blockers"] = []): VariantSelection => ({
    productVariantId: input.productVariantId, action, reason, blockers,
  });
  const listing = input.listing;
  const archived = archivedListingMemberSelection({ productVariantId: input.productVariantId,
    archived: Boolean(input.candidate && isArchivedCatalogMember({ productActive: input.candidate.productIsActive,
      variantActive: input.candidate.variantIsActive, productStatus: input.candidate.productStatus })), retirement: input.retirement });
  if (archived) return archived;
  const retainedIdentity = Boolean(listing?.externalListingId || listing?.externalOfferId);
  const savedLivePush = listing?.livePushItemId != null;
  // An ended projection retires older intents. A genuinely newer saved push is
  // identified by the owner reader; historical completed jobs cannot resurrect it.
  if (listing?.status === "ended" && !savedLivePush) return result("none", "listing_ended");
  const retainedDuty = retainedIdentity || savedLivePush;
  if (!input.candidate) return result(retainedDuty ? "zero" : "none", "catalog_identity_missing", [{
    code: "DROPSHIP_STOCK_CATALOG_IDENTITY_MISSING",
    message: "This variant is no longer part of the requested catalog product. Review its saved store listing.",
  }]);

  const exposure = evaluateDropshipCatalogExposure(input.candidate, input.rules, input.now);
  const selection = evaluateDropshipVendorCatalogSelection({
    candidate: input.candidate, adminExposureDecision: exposure, rules: input.vendorRules,
    override: input.override,
    // The selection resolver's quantity output is intentionally unused. This is
    // the same selection-only invocation used by catalog preview before ATP.
    rawAtpUnits: 0, applyMarketplaceQuantityCap: false,
  });
  const stockEligible = input.candidate.requiresShipping === true
    && input.candidate.trackInventory !== false
    && isCustomerSellableVariant(input.candidate);
  if (!selection.selected || !stockEligible) {
    return result(retainedDuty ? "zero" : "none",
      stockEligible ? selection.reason : "variant_not_stock_eligible");
  }
  if (input.storePaused || listing?.status === "paused" || input.config?.isActive === false) {
    return result(retainedDuty ? "zero" : "read_only", "listing_paused");
  }
  const managedLive = input.config?.isActive === true
    && input.config.listingMode === "live"
    && input.config.inventoryMode === "managed_quantity_sync";
  // Leaving managed live mode must clear a retained destination. A selected
  // candidate without that existing duty remains a quantity preview only.
  if (!managedLive) return result(retainedDuty ? "zero" : "read_only", "managed_live_publication_not_enabled");
  // Merely creating a failed/preview row is not consent to publish. A saved live
  // intent or retained destination does carry duty through queued/failed/blocked.
  if (retainedDuty) return result("publish", savedLivePush ? "saved_live_push" : "selected_existing_listing");
  return result("read_only", "selected_catalog_preview");
}
