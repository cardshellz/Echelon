import { CatalogRepository, CatalogVariantRow } from "../infrastructure/catalog.repository";
import { PricingDomainService } from "../domain/pricing";
import { VendorTier } from "../domain/vendor";

export interface VendorCatalogItem extends CatalogVariantRow {
  wholesalePriceCents: number;
}

export class CatalogOrchestrator {
  /**
   * Retrieves the physical catalog grid and enforces Tier-based Pricing securely.
   * Prevents raw uncalculated values surfacing toward any downstream UI layers.
   */
  static async getVendorCatalog(vendorTier: VendorTier): Promise<VendorCatalogItem[]> {
    // 1. Unadulterated Infrastructure Pull
    const rawCatalog = await CatalogRepository.getEligibleDropshipCatalog();

    // 2. Domain Immutability Math
    return rawCatalog.map(item => {
      const verifiedWholesale = PricingDomainService.calculateWholesaleCents(item.retailPriceCents, vendorTier);
      
      return {
        ...item,
        wholesalePriceCents: verifiedWholesale
      };
    });
  }
}
