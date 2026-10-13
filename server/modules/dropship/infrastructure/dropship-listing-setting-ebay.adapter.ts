import type { ListingSettingEbayPort } from "../application/dropship-listing-setting-ebay-values";
import { sharedDropshipEbayCategoryTaxonomy } from "./dropship-ebay-category-rules.factory";
import { createDropshipEbayFulfillmentCapabilityProviderFromEnv } from "./dropship-ebay-fulfillment-capability.provider";
import { EbayDropshipListingSetupDirectory } from "./dropship-ebay-listing-setup.directory";
import { createDropshipEbayRegistrationCredentialProviderFromEnv } from "./dropship-ebay-registration-credentials";
import { EbayDropshipStoreCategoryDirectory } from "./dropship-ebay-store-category.directory";

/**
 * The listing-settings writers' eBay reads (plan PR 9, section 6.1) over the
 * providers W2 and W3 use today: the setup directory and Card Shellz shipping
 * for policies, the store-category directory for shelves, and the
 * process-wide category taxonomy (one tree per process). The directories
 * share one credential provider, as the setup factory builds them. Every
 * provider keeps its own errors, sign-in handling and token refresh.
 */
export function createDropshipListingSettingEbayAdapterFromEnv(): ListingSettingEbayPort {
  const credentials = createDropshipEbayRegistrationCredentialProviderFromEnv();
  const directory = new EbayDropshipListingSetupDirectory(credentials);
  const shelves = new EbayDropshipStoreCategoryDirectory(credentials);
  const capabilities = createDropshipEbayFulfillmentCapabilityProviderFromEnv();
  const taxonomy = sharedDropshipEbayCategoryTaxonomy();
  return {
    describeCategories: (identity, categoryIds) => taxonomy.describe(identity, categoryIds),
    discoverPolicies: (input) => directory.discoverForStoreConnection(input),
    // Read fresh, as W2 does before it accepts a shipping policy.
    loadFulfillmentCapability: (input) => capabilities.getForStoreConnection({ ...input, fresh: true }),
    listStoreShelves: (input) => shelves.listLeafCategories(input),
  };
}
