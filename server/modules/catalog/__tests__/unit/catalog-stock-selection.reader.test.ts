import { describe, expect, it } from "vitest";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import {
  readCatalogStockSelectionFactsForProducts,
  readCatalogStockSelectionFactsForVariants,
} from "../../catalog-stock-selection.reader";

/**
 * The catalog's stock facts readers for many sizes (TST-7; no unit test of this reader existed before PR C): the
 * published read by sizes (the dropship effects reader's, PLAN-B v4.1 §7.7) and PR C's read of every size of some
 * products (PLAN-C v4.1 §4.2), one statement each, the same columns, only the filter and the bound differ. Their
 * parity on real rows is pinned in the PostgreSQL listing end suite.
 */

interface Recorded { text: string; values: readonly unknown[] }

function client(rows: Record<string, unknown>[] = []): StockSelectionQueryClient & { queries: Recorded[] } {
  const queries: Recorded[] = [];
  return {
    queries,
    async query<R>(text: string, values: readonly unknown[] = []): Promise<{ rows: R[] }> {
      queries.push({ text, values });
      return { rows: rows as R[] };
    },
  };
}

const row = { id: 11, productId: 3, sku: "S-11", uomType: "pack", isActive: true, requiresShipping: true, trackInventory: null,
  salesEligibility: "sellable", ebayListingExcluded: false,
  product: { id: 3, isActive: true, status: "active", productType: "sleeves", category: "Supplies", ebayListingExcluded: null, productLineIds: [4] } };

describe("catalog stock facts for many sizes", () => {
  it("reads every size of the products in one statement with the same columns as the read by sizes, bounded by maxSizes + 1", async () => {
    const byProducts = client([row]);
    const facts = await readCatalogStockSelectionFactsForProducts(byProducts, [3, 3, 5], { maxSizes: 30_000 });
    expect(facts).toEqual([{ product: row.product, variant: { id: 11, productId: 3, sku: "S-11", uomType: "pack", isActive: true,
      requiresShipping: true, trackInventory: null, salesEligibility: "sellable", ebayListingExcluded: false } }]);
    expect(byProducts.queries).toHaveLength(1);
    expect(byProducts.queries[0]!.values).toEqual([[3, 5], 30_001]);
    const productsSql = byProducts.queries[0]!.text.replace(/\s+/g, " ");
    expect(productsSql).toMatch(/WHERE pv\.product_id=ANY\(\$1::integer\[\]\) ORDER BY pv\.id LIMIT \$2$/);

    const bySizes = client([row]);
    await readCatalogStockSelectionFactsForVariants(bySizes, [11]);
    const sizesSql = bySizes.queries[0]!.text.replace(/\s+/g, " ");
    expect(sizesSql).toMatch(/WHERE pv\.id=ANY\(\$1::integer\[\]\) ORDER BY pv\.id$/);
    // The same columns and joins: everything before the filter is one text.
    expect(productsSql.slice(0, productsSql.indexOf(" WHERE "))).toBe(sizesSql.slice(0, sizesSql.indexOf(" WHERE ")));
  });

  it("reads nothing for no product, and refuses an invalid id or bound", async () => {
    const empty = client();
    expect(await readCatalogStockSelectionFactsForProducts(empty, [], { maxSizes: 10 })).toEqual([]);
    expect(empty.queries).toEqual([]);
    await expect(readCatalogStockSelectionFactsForProducts(empty, [0], { maxSizes: 10 })).rejects.toThrow();
    await expect(readCatalogStockSelectionFactsForProducts(empty, [3], { maxSizes: 0 })).rejects.toThrow();
  });

  it("refuses a row off its contract (the catalog's facts are parsed, never trusted)", async () => {
    await expect(readCatalogStockSelectionFactsForProducts(client([{ ...row, salesEligibility: "elsewhere" }]), [3], { maxSizes: 10 }))
      .rejects.toThrow();
  });
});
