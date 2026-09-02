import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../../../../db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@shared/schema", () => ({
  products: { id: "products.id", shopifyProductId: "products.shopify_product_id", updatedAt: "products.updated_at" },
  productVariants: { productId: "pv.product_id", sku: "pv.sku" },
  productLocations: { id: "pl.id", sku: "pl.sku" },
}));

import { retireDeletedShopifyProduct } from "../../shopify-product-retirement.service";

/** Minimal drizzle-shaped tx recording what the service asked for. */
function makeTx(opts: { owned: Array<{ id: number }>; skus: Array<{ sku: string | null }> }) {
  const calls = { deletedSkus: null as string[] | null, updated: false };
  let selectCall = 0;
  const tx = {
    select: () => ({
      from: () => ({
        where: async () => (selectCall++ === 0 ? opts.owned : opts.skus),
      }),
    }),
    delete: () => ({
      where: (cond: any) => ({
        returning: async () => {
          calls.deletedSkus = cond?.__skus ?? [];
          return (cond?.__skus ?? []).map((_: string, i: number) => ({ id: i + 1 }));
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            calls.updated = true;
            return opts.owned;
          },
        }),
      }),
    }),
  };
  return { tx, calls };
}

describe("retireDeletedShopifyProduct", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ignores a payload without a usable product id", async () => {
    for (const bad of [undefined, null, "", "abc", "12a"]) {
      const result = await retireDeletedShopifyProduct(bad as any);
      expect(result.mappingsRetired).toBe(0);
    }
    // Never opens a transaction for junk input.
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("retires every catalog row that claimed the deleted listing", async () => {
    const { tx } = makeTx({ owned: [{ id: 5 }, { id: 102 }], skus: [{ sku: "shlz-top-35pt-blu-p25" }] });
    mocks.transaction.mockImplementation(async (fn: any) => fn(tx));

    const result = await retireDeletedShopifyProduct("7120209903775");

    expect(result.shopifyProductId).toBe("7120209903775");
    expect(result.mappingsRetired).toBe(2);
    expect(result.retiredProductIds).toEqual([5, 102]);
  });

  it("is a no-op when no local row claims the listing", async () => {
    const { tx, calls } = makeTx({ owned: [], skus: [] });
    mocks.transaction.mockImplementation(async (fn: any) => fn(tx));

    const result = await retireDeletedShopifyProduct(999);

    expect(result.mappingsRetired).toBe(0);
    expect(calls.updated).toBe(false);
  });

  it("accepts a numeric id as well as a string", async () => {
    const { tx } = makeTx({ owned: [{ id: 7 }], skus: [] });
    mocks.transaction.mockImplementation(async (fn: any) => fn(tx));

    const result = await retireDeletedShopifyProduct(7120209903775);
    expect(result.mappingsRetired).toBe(1);
  });
});
