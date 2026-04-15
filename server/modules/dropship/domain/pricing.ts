import { DropshipError } from "./errors";
import { VendorTier } from "./vendor";

export class PricingDomainService {
  /**
   * Deterministic discount matrices based on pure membership capabilities.
   * Locked integers to dictate exactly baseline Tier discounts.
   */
  private static readonly TIER_DISCOUNTS: Record<VendorTier, number> = {
    standard: 15, // 15% wholesale discount
    gold: 20,    // 20%
    pro: 25,     // 25%
    elite: 30    // 30%
  };

  /**
   * Calculates wholesale price purely in CENTS.
   * Explictly neutralizes floating point destruction by forcing strict integer boundary math.
   */
  static calculateWholesaleCents(retailBaseCents: number, tier: VendorTier): number {
    if (!Number.isInteger(retailBaseCents)) {
      throw new DropshipError("FLOATING_POINT_VIOLATION", "All currency computations must remain dynamically typed strictly as integers (cents).");
    }
    if (retailBaseCents <= 0) {
      throw new DropshipError("INVALID_BASE_PRICE", "Base retail price must geometrically exceed 0.");
    }

    const discountPercent = this.TIER_DISCOUNTS[tier] || this.TIER_DISCOUNTS.standard;
    const discountAmountCents = Math.floor((retailBaseCents * discountPercent) / 100);
    
    return retailBaseCents - discountAmountCents;
  }
}
