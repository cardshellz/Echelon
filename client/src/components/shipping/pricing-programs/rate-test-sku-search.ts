export interface CatalogSkuSearchResult {
  sku: string;
  name: string;
  productVariantId: number;
}

const MIN_SKU_SEARCH_LENGTH = 2;
const MAX_SKU_SEARCH_RESULTS = 20;

export function buildCatalogSkuSearchUrl(search: string): string | null {
  const normalized = search.trim();
  if (normalized.length < MIN_SKU_SEARCH_LENGTH) return null;
  return `/api/inventory/skus/search?q=${encodeURIComponent(normalized)}&limit=${MAX_SKU_SEARCH_RESULTS}`;
}

export function normalizeCatalogSkuSearchResults(value: unknown): CatalogSkuSearchResult[] {
  if (!Array.isArray(value)) return [];

  const bySku = new Map<string, CatalogSkuSearchResult>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const sku = typeof candidate.sku === "string" ? candidate.sku.trim() : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const productVariantId = Number(candidate.productVariantId);
    if (
      sku.length === 0
      || name.length === 0
      || !Number.isSafeInteger(productVariantId)
      || productVariantId <= 0
    ) {
      continue;
    }

    const option = { sku, name, productVariantId };
    const existing = bySku.get(sku);
    if (!existing || option.productVariantId < existing.productVariantId) {
      bySku.set(sku, option);
    }
  }

  return [...bySku.values()]
    .sort((left, right) => left.sku.localeCompare(right.sku) || left.productVariantId - right.productVariantId)
    .slice(0, MAX_SKU_SEARCH_RESULTS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
