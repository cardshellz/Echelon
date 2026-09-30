import type { DropshipListingCatalogCandidate } from "../../application/dropship-listing-preview-service";
import type {
  EbayCategory,
  EbayCategoryOption,
  EbayCategoryRulesProfile,
  EbayCategoryRulesState,
} from "../../../../../shared/dropship/ebay-category-rules";
import { contentCandidate } from "./listing-content.fixture";

// Test categories only; the ids are not claimed to match eBay's live tree.
export const TOPLOADERS: EbayCategory = { categoryId: "900101", categoryName: "Toploaders", path: ["Collectibles", "Card Storage", "Toploaders"] };
export const SLEEVES: EbayCategory = { categoryId: "900102", categoryName: "Sleeves", path: ["Collectibles", "Card Storage", "Sleeves"] };
export const MAILERS: EbayCategory = { categoryId: "900103", categoryName: "Mailers", path: ["Collectibles", "Shipping Supplies", "Mailers"] };

export function categoryCandidate(overrides: Partial<DropshipListingCatalogCandidate> = {}): DropshipListingCatalogCandidate {
  return { ...contentCandidate(), ebayBrowseCategoryId: "184267", ebayBrowseCategoryName: "Card Shellz mailers", ...overrides };
}

export function rulesProfile(overrides: Partial<EbayCategoryRulesProfile> = {}): EbayCategoryRulesProfile {
  return { version: 1, defaultCategory: null, rules: [], ...overrides };
}

export function rulesState(profile: EbayCategoryRulesProfile | null, revisionId: number | null = profile ? 7 : null): EbayCategoryRulesState {
  return { revisionId, profile, updatedAt: revisionId === null ? null : "2026-09-30T12:00:00.000Z" };
}

export function categoryOption(category: EbayCategory, leaf = true): EbayCategoryOption {
  return { ...category, path: [...category.path], leaf };
}
