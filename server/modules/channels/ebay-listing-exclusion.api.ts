export { ebayListingExclusionService } from "./infrastructure/ebay-listing-withdrawal";
import type { EbayProductExclusionResult } from "@shared/types/ebay-listing-exclusion";

export interface EbayListingExclusionService {
  set(productId: number, input: unknown, actor: string): Promise<EbayProductExclusionResult>;
  get(productId: number, commandKey: string): Promise<EbayProductExclusionResult>;
}
