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
import { readResolvedEbayCategories } from "../../infrastructure/dropship-ebay-category-rules.reader";
import { readResolvedListingContents } from "../../infrastructure/dropship-listing-content.reader";
import { readListingSettingLayers } from "../../infrastructure/dropship-listing-setting-layers.reader";
import { loadListingRulePrices } from "../../infrastructure/dropship-rule-price.loader";
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

    /**
     * Answers the resolver and settings reads with the given rows; anything else fails the test.
     * `fail` makes the first statement it matches throw that error; `rollbackFails` makes ROLLBACK throw.
     */
    function scriptedClient(answers: {
      productRows?: unknown[]; categoryRows?: unknown[]; fail?: { at: RegExp; error: Error }; rollbackFails?: boolean;
    } = {}) {
      const statements: string[] = [];
      const client = {
        query: vi.fn(async (sql: string, _params?: readonly unknown[]) => {
          statements.push(sql.trim());
          if (answers.fail?.at.test(sql.trim())) throw answers.fail.error;
          if (answers.rollbackFails && /^ROLLBACK\b/.test(sql.trim())) throw new Error("The connection was lost.");
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

    it("has no separate rule price, description or eBay category loader: each would read in its own snapshot (D23)", () => {
      const repository = new PgDropshipListingPreviewRepository(scriptedClient().pool) as unknown as Record<string, unknown>;
      expect([repository.loadRulePrices, repository.loadListingContents, repository.loadEbayCategories]).toEqual([undefined, undefined, undefined]);
    });

    it("hands each resolver loader the snapshot's layers: it reads no settings itself, and answers what it answers reading them", async () => {
      const cost: DropshipProductCost = { status: "available", unitCostCents: 809, planId: "ops", source: "variant_fixed_price",
        overrideId: "fixed", issue: null, retailPriceCents: null, discountBps: null };
      vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction").mockReturnValue({
        loadProductCosts: async ({ productVariantIds }: { productVariantIds: readonly number[] }) =>
          new Map(productVariantIds.map((id) => [id, cost])),
      } as unknown as PgShellzClubProductCostAdapter);
      const { pool, statements } = scriptedClient({ productRows: [productRow(501)] });
      const connection = await pool.connect();
      const candidate = listingCandidate({ productVariantId: 101, productId: 501, categoryId: null, defaultRetailPriceCents: 1_299 });
      const loaders = [
        ["rule prices", (input: Parameters<typeof loadListingRulePrices>[1]) => loadListingRulePrices(connection, input)],
        ["descriptions", (input: Parameters<typeof readResolvedListingContents>[1]) => readResolvedListingContents(connection, input)],
        ["eBay categories", (input: Parameters<typeof readResolvedEbayCategories>[1]) => readResolvedEbayCategories(connection, input)],
      ] as const;

      for (const [label, load] of loaders) {
        statements.length = 0;
        const given = await load({ ...scope([candidate]), layers: LAYERS });
        expect(statements.some((sql) => LAYER_READ.test(sql)), label).toBe(false);
        statements.length = 0;
        const own = await load(scope([candidate]));
        expect(statements.filter((sql) => LAYER_READ.test(sql)), label).toHaveLength(1);
        expect(own, label).toEqual(given);
      }
      const answers = await Promise.all(loaders.map(([, load]) => load({ ...scope([candidate]), layers: LAYERS })));
      expect((answers[0] as Map<number, unknown>).get(101)).toMatchObject({ priceCents: 1_299, ruleName: "Product price" });
      expect((answers[1] as Map<number, { descriptionHtml: string }>).get(101)?.descriptionHtml).toContain("Shipped from our shop.");
      expect((answers[2] as Map<number, unknown>).get(101)).toMatchObject({ categoryId: "900200", source: "product" });
    });

    describe("the four resolver inputs in one snapshot (PR 11c, plan 7.A, D23)", () => {
      const SNAPSHOT_BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
      const PRICING_PROFILE_READ = /FROM dropship\.dropship_pricing_profiles\b/;
      const CONTENT_PROFILE_READ = /FROM dropship\.dropship_content_profiles\b/;
      const CONTENT_SETTINGS_READ = /FROM dropship\.dropship_listing_content_settings\b/;
      const EBAY_RULES_READ = /FROM dropship\.dropship_ebay_category_rule_profiles\b/;
      const PRODUCT_READ = /FROM dropship\.dropship_product_listing_settings\b/;
      const CATEGORY_READ = /FROM dropship\.dropship_category_listing_settings\b/;
      const cost: DropshipProductCost = { status: "available", unitCostCents: 809, planId: "ops", source: "variant_fixed_price",
        overrideId: "fixed", issue: null, retailPriceCents: null, discountBps: null };
      const costReads: number[][] = [];
      function mockCosts(read: (ids: readonly number[]) => Promise<Map<number, DropshipProductCost>> =
        async (ids) => new Map(ids.map((id) => [id, cost]))) {
        costReads.length = 0;
        vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction").mockReturnValue({
          loadProductCosts: async ({ productVariantIds }: { productVariantIds: readonly number[] }) => {
            costReads.push([...productVariantIds]);
            return read(productVariantIds);
          },
        } as unknown as PgShellzClubProductCostAdapter);
      }
      // Sizes 101 and 102 are product 501's (its own price, text and eBay category) in category 31; 201 is product 601's, with no
      // category. 102 is a size of the preview that is not rule-eligible.
      const CANDIDATES = [
        listingCandidate({ productVariantId: 101, productId: 501, categoryId: 31, defaultRetailPriceCents: 1_299 }),
        listingCandidate({ productVariantId: 102, productId: 501, categoryId: 31 }),
        listingCandidate({ productVariantId: 201, productId: 601, categoryId: null }),
      ];
      const RULE_ELIGIBLE = [CANDIDATES[0], CANDIDATES[2]];
      const input = (platform: "ebay" | "shopify" = "ebay") => ({ ...scope(CANDIDATES), ruleEligibleCandidates: RULE_ELIGIBLE, platform });
      const indexOf = (statements: readonly string[], read: RegExp) => statements.findIndex((sql) => read.test(sql));

      it("reads the layers, the pricing profile, the content profile and the eBay rules after one BEGIN and before its one COMMIT", async () => {
        mockCosts();
        const { pool, client, statements } = scriptedClient({ productRows: [productRow(501)], categoryRows: [categoryRow(31)] });
        const repository = new PgDropshipListingPreviewRepository(pool);

        const inputs = await repository.loadResolverInputs(input());

        expect(statements[0]).toBe(SNAPSHOT_BEGIN);
        expect(statements.at(-1)).toBe("COMMIT");
        expect(statements.filter((sql) => /^BEGIN\b/.test(sql))).toHaveLength(1);
        expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
        expect(statements).not.toContain("ROLLBACK");
        // In order, each once: the layers (products, then categories), the pricing profile, the content profile and
        // its size texts, the eBay rules. The loaders are given the layers, so no settings are read twice.
        const order = [PRODUCT_READ, CATEGORY_READ, PRICING_PROFILE_READ, CONTENT_PROFILE_READ, CONTENT_SETTINGS_READ, EBAY_RULES_READ]
          .map((read) => indexOf(statements, read));
        expect(order.every((index) => index > 0 && index < statements.length - 1)).toBe(true);
        expect(order).toEqual([...order].sort((left, right) => left - right));
        expect(statements).toHaveLength(order.length + 2);
        for (const sql of statements) {
          expect(sql).not.toMatch(/\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i);
          expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|LOCK)\b/i);
        }
        // One client: the same connection for all of them, released once.
        expect(pool.connect).toHaveBeenCalledTimes(1);
        expect(client.release).toHaveBeenCalledTimes(1);
        // Every size's settings; rule prices and descriptions for the rule-eligible sizes only; eBay categories for every size.
        expect([...inputs.layers.products.keys()]).toEqual([501]);
        expect([...inputs.layers.categories.keys()]).toEqual([31]);
        expect([...inputs.rulePrices.keys()]).toEqual([101]);
        expect(costReads).toEqual([[101]]);
        expect(inputs.rulePrices.get(101)).toMatchObject({ priceCents: 1_299, ruleName: "Product price" });
        expect([...inputs.contents.keys()]).toEqual([101, 201]);
        expect(inputs.contents.get(101)?.descriptionHtml).toContain("Shipped from our shop.");
        expect([...(inputs.ebayCategories?.keys() ?? [])]).toEqual([101, 102, 201]);
        expect(inputs.ebayCategories?.get(101)).toMatchObject({ categoryId: "900200", source: "product" });
      });

      it("answers what the four readers answer one by one for the same store", async () => {
        mockCosts();
        const { pool } = scriptedClient({ productRows: [productRow(501)], categoryRows: [categoryRow(31)] });
        const repository = new PgDropshipListingPreviewRepository(pool);

        const together = await repository.loadResolverInputs(input());
        const connection = await pool.connect();
        const layers = await readListingSettingLayers(connection, scope(CANDIDATES));
        const separate = {
          layers,
          rulePrices: await loadListingRulePrices(connection, { ...scope(RULE_ELIGIBLE), layers }),
          contents: await readResolvedListingContents(connection, { ...scope(RULE_ELIGIBLE), layers }),
          ebayCategories: await readResolvedEbayCategories(connection, { ...scope(CANDIDATES), layers }),
        };

        expect(together).toEqual(separate);
      });

      it("reads no eBay rules for a store that is not eBay, and answers no eBay categories", async () => {
        mockCosts();
        const { pool, statements } = scriptedClient({ productRows: [productRow(501)] });
        const repository = new PgDropshipListingPreviewRepository(pool);

        const inputs = await repository.loadResolverInputs(input("shopify"));

        expect(statements.some((sql) => EBAY_RULES_READ.test(sql))).toBe(false);
        expect(inputs).not.toHaveProperty("ebayCategories");
        expect(statements[0]).toBe(SNAPSHOT_BEGIN);
        expect(statements.at(-1)).toBe("COMMIT");
      });

      it.each([
        ["the BEGIN", /^BEGIN\b/],
        ["the product settings read", PRODUCT_READ],
        ["the category settings read", CATEGORY_READ],
        ["the pricing profile read", PRICING_PROFILE_READ],
        ["the content profile read", CONTENT_PROFILE_READ],
        ["the size texts read", CONTENT_SETTINGS_READ],
        ["the eBay rules read", EBAY_RULES_READ],
        ["the COMMIT", /^COMMIT$/],
      ])("rolls back once, releases once and throws the failure's own error when %s fails", async (_name, at) => {
        mockCosts();
        const error = new Error("The read failed.");
        const { pool, client, statements } = scriptedClient({ productRows: [productRow(501)], categoryRows: [categoryRow(31)], fail: { at, error } });
        const repository = new PgDropshipListingPreviewRepository(pool);

        await expect(repository.loadResolverInputs(input())).rejects.toBe(error);

        expect(statements.at(-1)).toBe("ROLLBACK");
        expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
        expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(at.test("COMMIT") ? 1 : 0);
        // Nothing is read after the failure.
        expect(statements.findIndex((sql) => at.test(sql))).toBe(statements.length - 2);
        expect(pool.connect).toHaveBeenCalledTimes(1);
        expect(client.release).toHaveBeenCalledTimes(1);
      });

      it("rolls back once and releases once when the cost read fails", async () => {
        const error = new Error("The cost source failed.");
        mockCosts(async () => { throw error; });
        const { pool, client, statements } = scriptedClient({ productRows: [productRow(501)] });
        const repository = new PgDropshipListingPreviewRepository(pool);

        await expect(repository.loadResolverInputs(input())).rejects.toBe(error);

        expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
        expect(statements).not.toContain("COMMIT");
        expect(statements.some((sql) => CONTENT_PROFILE_READ.test(sql) || EBAY_RULES_READ.test(sql))).toBe(false);
        expect(client.release).toHaveBeenCalledTimes(1);
      });

      it("keeps the read's own error when the ROLLBACK fails too, and still releases once", async () => {
        mockCosts();
        const error = new Error("The read failed.");
        const { pool, client, statements } = scriptedClient({ productRows: [productRow(501)], fail: { at: CONTENT_PROFILE_READ, error },
          rollbackFails: true });
        const repository = new PgDropshipListingPreviewRepository(pool);

        await expect(repository.loadResolverInputs(input())).rejects.toBe(error);

        expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
        expect(client.release).toHaveBeenCalledTimes(1);
      });

      it.each(["ebay", "shopify"] as const)("opens no transaction and reads nothing with no catalog sizes (%s)", async (platform) => {
        const { pool } = scriptedClient();
        const repository = new PgDropshipListingPreviewRepository(pool);

        const inputs = await repository.loadResolverInputs({ ...scope([]), ruleEligibleCandidates: [], platform });

        expect(pool.connect).not.toHaveBeenCalled();
        expect(inputs.layers).toBe(EMPTY_LISTING_SETTING_LAYERS);
        expect(inputs.rulePrices).toEqual(new Map());
        expect(inputs.contents).toEqual(new Map());
        if (platform === "ebay") expect(inputs.ebayCategories).toEqual(new Map());
        else expect(inputs).not.toHaveProperty("ebayCategories");
      });

      it.each([
        ["with sizes", CANDIDATES.slice(0, 2)],
        ["with none", []],
      ])("refuses a rule-eligible size that is not one of the preview's sizes, before any statement (%s)", async (_name, candidates) => {
        const { pool } = scriptedClient();
        const repository = new PgDropshipListingPreviewRepository(pool);

        const failure = await repository.loadResolverInputs({ ...scope(candidates), ruleEligibleCandidates: RULE_ELIGIBLE, platform: "ebay" })
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DropshipError);
        expect(failure).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
          context: { storeConnectionId: 22, outsideCount: candidates.length === 0 ? 2 : 1, classification: "fatal" } });
        expect(pool.connect).not.toHaveBeenCalled();
      });
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
