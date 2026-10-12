import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

import { PgDropshipListingPreviewRepository } from "../../infrastructure/dropship-listing-preview.repository";
import type { DropshipListingCatalogCandidate } from "../../application/dropship-listing-preview-service";
import {
  EMPTY_LISTING_SETTING_LAYERS,
  type ListingSettingLayers,
} from "../../application/dropship-listing-setting-layers";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import { DropshipError } from "../../domain/errors";
import {
  EMPTY_CATEGORY_LISTING_SETTING_VALUES,
  EMPTY_PRODUCT_LISTING_SETTING_VALUES,
} from "../../domain/listing-setting-values";
import {
  categoryValuesToColumns,
  productValuesToColumns,
} from "../../infrastructure/dropship-listing-setting-shared.repository";
import { PgShellzClubProductCostAdapter } from "../../infrastructure/shellz-club-product-cost.adapter";
import type { ProductListingSettingValues } from "../../../../../shared/dropship/listing-setting-values";

describe("PgDropshipListingPreviewRepository", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("loads exact vendor/store scoped price revisions including explicit null resets", async () => {
    const query = vi.fn(async () => ({ rows: [{ product_variant_id: 101, revision_id: 8, override_price_cents: null,
      updated_at: new Date("2026-09-06T16:00:00.000Z") }] }));
    const repository = new PgDropshipListingPreviewRepository({ query } as unknown as Pool);
    expect(await repository.listSavedListingPrices({ vendorId: 10, storeConnectionId: 22, productVariantIds: [101] }))
      .toEqual([{ productVariantId: 101, revisionId: 8, overridePriceCents: null, updatedAt: "2026-09-06T16:00:00.000Z" }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("vendor_id = $1 AND store_connection_id = $2"), [10, 22, [101]]);
    query.mockClear();
    expect(await repository.listSavedListingPrices({ vendorId: 10, storeConnectionId: 22, productVariantIds: [] })).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

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
      category_id: 12,
      ebay_browse_category_id: "183438",
      ebay_browse_category_name: "Card Toploaders & Holders",
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
      uom_type: "each",
      default_retail_price_cents: "1299",
    });
    const repository = new PgDropshipListingPreviewRepository(makePool(client));

    const result = await repository.listCatalogCandidates([101]);

    expect(result[0]).toMatchObject({
      productVariantId: 101,
      weightGrams: 321,
      category: "Protectors",
      // The Card Shellz category id that category listing settings key by.
      categoryId: 12,
      ebayBrowseCategoryId: "183438",
      ebayBrowseCategoryName: "Card Toploaders & Holders",
    });
    const query = String(client.query.mock.calls[0]?.[0]);
    expect(query).toContain("pv.weight_grams");
    expect(query).toContain("p.category_id");
    expect(query).toContain("pv.requires_shipping = true");
    expect(query).toContain("COALESCE(pv.track_inventory, true) = true");
    expect(query).toContain("pv.sales_eligibility = 'sellable'");
    expect(query).toContain("p.ebay_browse_category_id");
    expect(query).toContain("FROM ebay.ebay_category_mappings ecm");
    expect(query).toContain("supplier_channel.type = 'internal'");
    expect(query).toContain("supplier_channel.status = 'active'");
    // The Card Shellz listing toggle must not remove the dropship default category.
    expect(query).not.toContain("ecm.listing_enabled");
    expect(query).toContain("HAVING COUNT(DISTINCT ecm.ebay_browse_category_id) = 1");
  });

  describe("product and category listing settings (PR 8b, plan D26)", () => {
    afterEach(() => vi.restoreAllMocks());
    const SAVED_AT = new Date("2026-10-01T08:30:00.000Z");
    const PRODUCT_VALUES: ProductListingSettingValues = {
      ...EMPTY_PRODUCT_LISTING_SETTING_VALUES,
      price: { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" },
      ebayCategory: { categoryId: "900200", categoryName: "Toploaders", path: ["Collectibles", "Card Storage", "Toploaders"] },
      textAbove: { mode: "own", text: "Shipped from our shop." },
    };
    const productRow = (productId: number, values: ProductListingSettingValues = PRODUCT_VALUES) => ({
      product_id: productId, revision_id: 71, ...productValuesToColumns(values), created_at: SAVED_AT,
    });
    const categoryRow = (categoryId: number) => ({
      category_id: categoryId, revision_id: 72, created_at: SAVED_AT,
      ...categoryValuesToColumns({ ...EMPTY_CATEGORY_LISTING_SETTING_VALUES, shippingPolicy: { id: "ship-category", name: null } }),
    });
    /** The preview's one read, as the service passes it on: product 501 has its own settings. */
    const LAYERS: ListingSettingLayers = {
      products: new Map([[501, { storeConnectionId: 22, productId: 501, revisionId: 71, updatedAt: SAVED_AT.toISOString(), values: PRODUCT_VALUES }]]),
      categories: new Map(),
    };
    const LAYER_READ = /FROM dropship\.dropship_(product|category)_listing_settings\b/;

    /** Answers the resolver and settings reads with the given rows; anything else fails the test. */
    function scriptedClient(answers: { productRows?: unknown[]; categoryRows?: unknown[] } = {}) {
      const statements: string[] = [];
      const client = {
        query: vi.fn(async (sql: string, _params?: readonly unknown[]) => {
          statements.push(sql.trim());
          if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(sql.trim())) return { rows: [] };
          if (sql.includes("FROM dropship.dropship_product_listing_settings")) return { rows: structuredClone(answers.productRows ?? []) };
          if (sql.includes("FROM dropship.dropship_category_listing_settings")) return { rows: structuredClone(answers.categoryRows ?? []) };
          if (/FROM dropship\.dropship_(pricing_profiles|content_profiles|listing_content_settings|ebay_category_rule_profiles)\b/.test(sql)) {
            return { rows: [] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        }),
        release: vi.fn(),
      };
      return { client, statements, pool: makePool(client as unknown as PoolClient) };
    }
    const scope = (candidates: DropshipListingCatalogCandidate[]) => ({ vendorId: 10, storeConnectionId: 22, candidates });

    it("reads them once in a read-only snapshot, products then categories, with no lock and no write", async () => {
      const { pool, client, statements } = scriptedClient({ productRows: [productRow(501)], categoryRows: [categoryRow(31)] });
      const repository = new PgDropshipListingPreviewRepository(pool);

      const layers = await repository.loadListingSettingLayers(scope([
        listingCandidate({ productVariantId: 101, productId: 501, categoryId: 31 }),
        listingCandidate({ productVariantId: 102, productId: 501, categoryId: 31 }),
        listingCandidate({ productVariantId: 201, productId: 601, categoryId: null }),
      ]));

      expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(statements.slice(1, 3).map((sql) => LAYER_READ.exec(sql)?.[1])).toEqual(["product", "category"]);
      expect(statements[3]).toBe("COMMIT");
      expect(statements).toHaveLength(4);
      for (const sql of statements) {
        expect(sql).not.toMatch(/\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i);
        expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\b/i);
      }
      // Each product and category once, whatever number of sizes share it.
      expect(client.query.mock.calls[1]?.[1]).toEqual([10, 22, [501, 601]]);
      expect(client.query.mock.calls[2]?.[1]).toEqual([10, 22, [31]]);
      expect([...layers.products.keys()]).toEqual([501]);
      expect(layers.products.get(501)?.values).toEqual(PRODUCT_VALUES);
      expect(layers.categories.get(31)?.values.shippingPolicy).toEqual({ id: "ship-category", name: null });
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it("opens no transaction and reads nothing when the preview has no catalog sizes", async () => {
      const { pool } = scriptedClient();
      const repository = new PgDropshipListingPreviewRepository(pool);

      await expect(repository.loadListingSettingLayers(scope([]))).resolves.toBe(EMPTY_LISTING_SETTING_LAYERS);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it("rolls back, releases and fails when a stored row breaks its contract", async () => {
      // A price group with only its basis set: a writer bypassed the CHECKs.
      const broken = { ...productRow(501), price_markup_bps: null };
      const { pool, client, statements } = scriptedClient({ productRows: [broken] });
      const repository = new PgDropshipListingPreviewRepository(pool);

      const failure = await repository.loadListingSettingLayers(scope([listingCandidate({ productId: 501, categoryId: null })]))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(DropshipError);
      expect(failure).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
      expect(statements.at(-1)).toBe("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it("prices with the preview's layers and reads no settings of its own", async () => {
      const cost: DropshipProductCost = { status: "available", unitCostCents: 809, planId: "ops", source: "variant_fixed_price",
        overrideId: "fixed", issue: null, retailPriceCents: null, discountBps: null };
      vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction").mockReturnValue({
        loadProductCosts: async ({ productVariantIds }: { productVariantIds: readonly number[] }) =>
          new Map(productVariantIds.map((id) => [id, cost])),
      } as unknown as PgShellzClubProductCostAdapter);
      const { pool, statements } = scriptedClient({ productRows: [productRow(501)] });
      const repository = new PgDropshipListingPreviewRepository(pool);
      const candidate = listingCandidate({ productVariantId: 101, productId: 501, categoryId: null, defaultRetailPriceCents: 1_299 });

      const given = await repository.loadRulePrices({ ...scope([candidate]), layers: LAYERS });
      expect(statements.some((sql) => LAYER_READ.test(sql))).toBe(false);
      expect(given.get(101)).toMatchObject({ priceCents: 1_299, ruleName: "Product price" });

      // Without them it reads the same rows itself, inside its own snapshot.
      statements.length = 0;
      const own = await repository.loadRulePrices(scope([candidate]));
      const layerRead = statements.findIndex((sql) => LAYER_READ.test(sql));
      expect(layerRead).toBeGreaterThan(statements.indexOf("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
      expect(layerRead).toBeLessThan(statements.indexOf("COMMIT"));
      expect(own).toEqual(given);
    });

    it("describes with the preview's layers and reads no settings of its own", async () => {
      const { pool, statements } = scriptedClient({ productRows: [productRow(501)] });
      const repository = new PgDropshipListingPreviewRepository(pool);
      const candidate = listingCandidate({ productVariantId: 101, productId: 501, categoryId: null });

      const given = await repository.loadListingContents({ ...scope([candidate]), layers: LAYERS });
      expect(statements.some((sql) => LAYER_READ.test(sql))).toBe(false);
      expect(given.get(101)?.descriptionHtml).toContain("Shipped from our shop.");

      statements.length = 0;
      const own = await repository.loadListingContents(scope([candidate]));
      expect(statements.filter((sql) => LAYER_READ.test(sql))).toHaveLength(1);
      expect(own).toEqual(given);
    });

    it("picks the eBay category with the preview's layers and reads no settings of its own", async () => {
      const { pool, statements } = scriptedClient({ productRows: [productRow(501)] });
      const repository = new PgDropshipListingPreviewRepository(pool);
      const candidate = listingCandidate({ productVariantId: 101, productId: 501, categoryId: null });

      const given = await repository.loadEbayCategories({ ...scope([candidate]), layers: LAYERS });
      expect(statements.some((sql) => LAYER_READ.test(sql))).toBe(false);
      expect(given.get(101)).toMatchObject({ categoryId: "900200", source: "product" });

      statements.length = 0;
      const own = await repository.loadEbayCategories(scope([candidate]));
      expect(statements.filter((sql) => LAYER_READ.test(sql))).toHaveLength(1);
      expect(own).toEqual(given);
    });
  });
});

/** A sellable size as listCatalogCandidates maps it. */
function listingCandidate(overrides: Partial<DropshipListingCatalogCandidate> = {}): DropshipListingCatalogCandidate {
  return {
    productId: 501, productVariantId: 101, productLineIds: [], category: "Protectors", categoryId: null,
    ebayBrowseCategoryId: "183438", ebayBrowseCategoryName: "Card Toploaders & Holders", productIsActive: true,
    variantIsActive: true, variantUomType: "pack", unitsPerVariant: 3, catalogUnitsPerVariant: 3, defaultRetailPriceCents: 1_199,
    sku: "CS-TOPLOADER-35PT", productName: "Toploader", variantName: "35pt", title: "Card Shellz Toploader 35pt",
    description: "Rigid card protection.", brand: "Card Shellz", gtin: null, mpn: "TL35", condition: "new",
    itemSpecifics: null, imageUrls: [], weightGrams: 100,
    ...overrides,
  };
}

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
