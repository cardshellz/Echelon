import { DropshipEbayCategoryRulesService } from "../application/dropship-ebay-category-rules-service";
import { makeDropshipListingPreviewLogger, systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { PgDropshipEbayCategoryRulesRepository } from "./dropship-ebay-category-rules.repository";
import { createDropshipEbayRegistrationCredentialProviderFromEnv } from "./dropship-ebay-registration-credentials";
import { EbayDropshipCategoryTaxonomy } from "./dropship-ebay-taxonomy.directory";

/**
 * One taxonomy per process: it holds the day's eBay category tree, and a second
 * instance would download the whole tree again.
 */
let processTaxonomy: EbayDropshipCategoryTaxonomy | null = null;

export function sharedDropshipEbayCategoryTaxonomy(): EbayDropshipCategoryTaxonomy {
  processTaxonomy ??= new EbayDropshipCategoryTaxonomy({
    credentials: createDropshipEbayRegistrationCredentialProviderFromEnv(),
    clock: systemDropshipListingPreviewClock,
    logger: makeDropshipListingPreviewLogger(),
  });
  return processTaxonomy;
}

export function createDropshipEbayCategoryRulesServiceFromEnv(): DropshipEbayCategoryRulesService {
  return new DropshipEbayCategoryRulesService({
    repository: new PgDropshipEbayCategoryRulesRepository(),
    taxonomy: sharedDropshipEbayCategoryTaxonomy(),
    clock: systemDropshipListingPreviewClock,
    logger: makeDropshipListingPreviewLogger(),
  });
}
