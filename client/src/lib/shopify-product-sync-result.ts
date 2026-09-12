export interface ShopifyProductSyncResult {
  success?: boolean;
  products?: { created?: number; updated?: number };
  variants?: { created?: number; updated?: number };
  canonicalMappings?: {
    repairedProducts?: number;
    alreadyConsistentProducts?: number;
    failedProducts?: number;
  };
  mappingConflicts?: readonly unknown[];
  contentSync?: {
    mappingConflicts?: readonly unknown[];
  };
}

export interface ShopifyProductSyncOutcome {
  readonly needsReview: boolean;
  readonly title: string;
  readonly description: string;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function summarizeShopifyProductSync(
  result: ShopifyProductSyncResult,
): ShopifyProductSyncOutcome {
  if (!result.canonicalMappings) {
    return {
      needsReview: true,
      title: "Shopify sync needs review",
      description: "Catalog content was synced, but the server did not return canonical mapping results. Treat the mapping as incomplete.",
    };
  }

  const failedMappings = count(result.canonicalMappings.failedProducts);
  const mappingConflicts = arrayLength(result.mappingConflicts)
    + arrayLength(result.contentSync?.mappingConflicts);
  if (result.success === false || failedMappings > 0 || mappingConflicts > 0) {
    return {
      needsReview: true,
      title: "Shopify sync needs review",
      description: `Catalog content was synced, but ${failedMappings} canonical mapping${failedMappings === 1 ? "" : "s"} failed and ${mappingConflicts} conflict${mappingConflicts === 1 ? " was" : "s were"} reported. Unmapped items will not be treated as successfully synced.`,
    };
  }

  return {
    needsReview: false,
    title: "Sync Complete",
    description: `Products: ${count(result.products?.created)} created, ${count(result.products?.updated)} updated. Variants: ${count(result.variants?.created)} created, ${count(result.variants?.updated)} updated. Canonical mappings: ${count(result.canonicalMappings.repairedProducts)} repaired, ${count(result.canonicalMappings.alreadyConsistentProducts)} already consistent.`,
  };
}
