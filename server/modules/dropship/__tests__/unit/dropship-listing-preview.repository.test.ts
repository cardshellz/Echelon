import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

import { PgDropshipListingPreviewRepository } from "../../infrastructure/dropship-listing-preview.repository";

describe("PgDropshipListingPreviewRepository", () => {
  it("maps launch readiness from store credential fields", async () => {
    const client = makeClient({
      vendor_id: 10,
      vendor_status: "active",
      entitlement_status: "active",
      store_connection_id: 22,
      store_status: "connected",
      setup_status: "ready",
      platform: "ebay",
      access_token_ref: "access-ref",
      refresh_token_ref: null,
    });
    const repository = new PgDropshipListingPreviewRepository(makePool(client));

    const result = await repository.loadStoreContext({
      vendorId: 10,
      storeConnectionId: 22,
    });

    expect(result).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      storeLaunchReady: false,
    });
    const query = client.query.mock.calls[0]?.[0];
    expect(String(query)).toContain("sc.access_token_ref");
    expect(String(query)).toContain("sc.refresh_token_ref");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("evaluates package readiness from catalog variant weight and dimensions", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM catalog.product_variants")) {
          return { rows: [{ product_variant_id: 101 }] };
        }
        if (sql.includes("FROM dropship.dropship_box_catalog")) {
          return { rows: [{ count: "1" }] };
        }
        if (sql.includes("FROM dropship.dropship_rate_tables")) {
          return { rows: [{ count: "1" }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const repository = new PgDropshipListingPreviewRepository(makePool(client));

    const result = await repository.getPackageReadiness([101, 102]);

    expect(result.get(101)).toEqual({
      hasCatalogPackageData: true,
      hasActiveBox: true,
      hasActiveRateTable: true,
    });
    expect(result.get(102)).toEqual({
      hasCatalogPackageData: false,
      hasActiveBox: true,
      hasActiveRateTable: true,
    });
    expect(queries[0]).toContain("weight_grams > 0");
    expect(queries[0]).toContain("height_mm > 0");
    expect(queries[0]).not.toContain("dropship.dropship_package_profiles");
  });

  it("maps canonical catalog weight into listing candidates", async () => {
    const client = makeClient({
      product_id: 501,
      product_variant_id: 101,
      product_line_ids: [9],
      product_sku: "PRODUCT-101",
      variant_sku: "SKU-101",
      product_name: "Toploader",
      variant_name: "35pt",
      title: "Toploader 35pt",
      description: "Rigid card protection.",
      category: "Protectors",
      brand: "Card Shellz",
      gtin: null,
      mpn: null,
      condition: "new",
      item_specifics: {},
      image_urls: [],
      weight_grams: 321,
      product_is_active: true,
      variant_is_active: true,
      units_per_variant: 1,
      default_retail_price_cents: "1299",
    });
    const repository = new PgDropshipListingPreviewRepository(makePool(client));

    const result = await repository.listCatalogCandidates([101]);

    expect(result[0]).toMatchObject({ productVariantId: 101, weightGrams: 321 });
    expect(String(client.query.mock.calls[0]?.[0])).toContain("pv.weight_grams");
  });
});

function makePool(client: PoolClient): Pool {
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

function makeClient(row: Record<string, unknown>): PoolClient & {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(async () => ({ rows: [row] })),
    release: vi.fn(),
  } as unknown as PoolClient & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}
