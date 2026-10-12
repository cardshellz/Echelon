import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type {
  CategoryListingSettingRow,
  CategoryListingSettingValues,
  ProductListingSettingRow,
  ProductListingSettingValues,
} from "../../../../../shared/dropship/listing-setting-values";
import {
  EMPTY_LISTING_SETTING_LAYERS,
  layersFor,
  mergeListingPolicyOverride,
  resolveListingStoreShelf,
  type ListingPolicyOverrideIds,
  type ListingSettingLayers,
} from "../../application/dropship-listing-setting-layers";
import type { EbayStoreShelfDefault } from "../../domain/ebay-listing-setup-config";
import { DropshipError } from "../../domain/errors";
import {
  EMPTY_CATEGORY_LISTING_SETTING_VALUES,
  EMPTY_PRODUCT_LISTING_SETTING_VALUES,
} from "../../domain/listing-setting-values";
import {
  readCatalogCategoryNames,
  readListingSettingLayers,
} from "../../infrastructure/dropship-listing-setting-layers.reader";
import {
  categoryValuesToColumns,
  productValuesToColumns,
} from "../../infrastructure/dropship-listing-setting-shared.repository";

const VENDOR_ID = 10;
const STORE_ID = 44;
const SAVED_AT = new Date("2026-10-01T08:30:00.000Z");

const PRODUCT_VALUES: ProductListingSettingValues = {
  ...EMPTY_PRODUCT_LISTING_SETTING_VALUES,
  price: { basis: "product_cost", markupBps: 3_000, flatCents: 0, rounding: "up_99" },
  storeShelf: { mode: "own", shelves: [{ id: "301", name: "Mailers:Bubble" }, { id: "302", name: "Sale" }] },
  shippingPolicy: { id: "ship-product", name: "Product shipping" },
};

const CATEGORY_VALUES: CategoryListingSettingValues = {
  ...EMPTY_CATEGORY_LISTING_SETTING_VALUES,
  storeShelf: { mode: "own", shelves: [{ id: "401", name: "Mailers" }] },
  shippingPolicy: { id: "ship-category", name: "Category shipping" },
  returnPolicy: { id: "return-category", name: null },
  paymentPolicy: { id: "payment-category", name: "Category payment" },
};

const STORE_DEFAULT: EbayStoreShelfDefault = { ids: ["900", "901"], names: ["Everything", "New"] };

function productRow(productId: number, values: ProductListingSettingValues, revisionId = 7): ProductListingSettingRow {
  return { storeConnectionId: STORE_ID, productId, revisionId, updatedAt: SAVED_AT.toISOString(), values };
}

function categoryRow(categoryId: number, values: CategoryListingSettingValues, revisionId = 8): CategoryListingSettingRow {
  return { storeConnectionId: STORE_ID, categoryId, revisionId, updatedAt: SAVED_AT.toISOString(), values };
}

function layersOf(
  products: readonly ProductListingSettingRow[],
  categories: readonly CategoryListingSettingRow[],
): ListingSettingLayers {
  return {
    products: new Map(products.map((row) => [row.productId, row])),
    categories: new Map(categories.map((row) => [row.categoryId, row])),
  };
}

/** A per-size policy row as the preview lists it today (DropshipEbayListingPolicyOverride). */
function sizeOverride(productVariantId: number, ids: Partial<ListingPolicyOverrideIds> = {}) {
  return {
    productVariantId, revisionId: 5, updatedAt: SAVED_AT,
    fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null,
    ...ids,
  };
}

/** Freezes every nested object, so a write to any input throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

async function failure(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

// ---------------------------------------------------------------------------
// layersFor
// ---------------------------------------------------------------------------

describe("layersFor", () => {
  const layers = layersOf([productRow(100, PRODUCT_VALUES)], [categoryRow(11, CATEGORY_VALUES)]);

  it("gives the product's and its category's values", () => {
    expect(layersFor(layers, { productId: 100, categoryId: 11 })).toEqual({ product: PRODUCT_VALUES, category: CATEGORY_VALUES });
  });

  it("gives null for a product or category with no row", () => {
    expect(layersFor(layers, { productId: 200, categoryId: 12 })).toEqual({ product: null, category: null });
  });

  it("ignores every category row for a product with no Card Shellz category", () => {
    const everyCategory = layersOf([], [categoryRow(11, CATEGORY_VALUES), categoryRow(12, CATEGORY_VALUES)]);
    expect(layersFor(everyCategory, { productId: 100, categoryId: null })).toEqual({ product: null, category: null });
  });

  it("reads nothing from the empty layers, which are frozen", () => {
    expect(layersFor(EMPTY_LISTING_SETTING_LAYERS, { productId: 100, categoryId: 11 })).toEqual({ product: null, category: null });
    expect(EMPTY_LISTING_SETTING_LAYERS.products.size).toBe(0);
    expect(EMPTY_LISTING_SETTING_LAYERS.categories.size).toBe(0);
    expect(Object.isFrozen(EMPTY_LISTING_SETTING_LAYERS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeListingPolicyOverride
// ---------------------------------------------------------------------------

describe("mergeListingPolicyOverride", () => {
  it("returns the size object itself when the layers are empty", () => {
    const size = sizeOverride(501, { fulfillmentPolicyId: "ship-size" });
    const merged = mergeListingPolicyOverride({ productVariantId: 501, size, product: null, category: null });
    expect(merged.override).toBe(size);
    expect(merged.sources).toEqual({ fulfillmentPolicyId: "size", returnPolicyId: null, paymentPolicyId: null });
  });

  it("returns null with no size row and empty layers, so the store default applies as today", () => {
    expect(mergeListingPolicyOverride({ productVariantId: 501, size: null, product: null, category: null })).toEqual({
      override: null,
      sources: { fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null },
    });
  });

  it("treats layer rows that set no policy as empty", () => {
    const size = sizeOverride(501, { paymentPolicyId: "payment-size" });
    const merged = mergeListingPolicyOverride({
      productVariantId: 501, size,
      product: { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, price: PRODUCT_VALUES.price },
      category: EMPTY_CATEGORY_LISTING_SETTING_VALUES,
    });
    expect(merged.override).toBe(size);
    expect(mergeListingPolicyOverride({
      productVariantId: 501, size: null, product: EMPTY_PRODUCT_LISTING_SETTING_VALUES, category: EMPTY_CATEGORY_LISTING_SETTING_VALUES,
    }).override).toBeNull();
  });

  it("merges per field: size, then product, then category, then the store default", () => {
    const merged = mergeListingPolicyOverride({
      productVariantId: 501,
      size: sizeOverride(501, { returnPolicyId: "return-size" }),
      product: { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, shippingPolicy: { id: "ship-product", name: null } },
      category: { ...EMPTY_CATEGORY_LISTING_SETTING_VALUES, shippingPolicy: { id: "ship-category", name: null },
        returnPolicy: { id: "return-category", name: null } },
    });
    expect(merged).toEqual({
      // Only the three ids: the size row's revision and time are not carried into a merged override.
      override: { productVariantId: 501, fulfillmentPolicyId: "ship-product", returnPolicyId: "return-size", paymentPolicyId: null },
      sources: { fulfillmentPolicyId: "product", returnPolicyId: "size", paymentPolicyId: null },
    });
  });

  it("fills each field the size and product leave from the category", () => {
    const merged = mergeListingPolicyOverride({
      productVariantId: 501, size: null, product: PRODUCT_VALUES, category: CATEGORY_VALUES,
    });
    expect(merged).toEqual({
      override: { productVariantId: 501, fulfillmentPolicyId: "ship-product", returnPolicyId: "return-category",
        paymentPolicyId: "payment-category" },
      sources: { fulfillmentPolicyId: "product", returnPolicyId: "category", paymentPolicyId: "category" },
    });
  });

  it("gives a size with no row its category's policies when the product sets none", () => {
    const { override, sources } = mergeListingPolicyOverride({
      productVariantId: 502, size: null, product: null, category: CATEGORY_VALUES,
    });
    expect(override).toEqual({ productVariantId: 502, fulfillmentPolicyId: "ship-category", returnPolicyId: "return-category",
      paymentPolicyId: "payment-category" });
    expect(sources).toEqual({ fulfillmentPolicyId: "category", returnPolicyId: "category", paymentPolicyId: "category" });
  });

  it("keeps the size object when the size's own ids win every field", () => {
    const size = sizeOverride(501, { fulfillmentPolicyId: "ship-size", returnPolicyId: "return-size", paymentPolicyId: "payment-size" });
    const merged = mergeListingPolicyOverride({ productVariantId: 501, size, product: PRODUCT_VALUES, category: CATEGORY_VALUES });
    expect(merged.override).toBe(size);
    expect(merged.sources).toEqual({ fulfillmentPolicyId: "size", returnPolicyId: "size", paymentPolicyId: "size" });
  });

  it("merges ids only: policy names never change the result", () => {
    const named = mergeListingPolicyOverride({ productVariantId: 501, size: null, product: PRODUCT_VALUES, category: null });
    const renamed = mergeListingPolicyOverride({
      productVariantId: 501, size: null, category: null,
      product: { ...PRODUCT_VALUES, shippingPolicy: { id: "ship-product", name: "Renamed on eBay" } },
    });
    expect(renamed).toEqual(named);
  });

  it("never mutates its inputs", () => {
    const size = deepFreeze(sizeOverride(501, { returnPolicyId: "return-size" }));
    const product = deepFreeze(structuredClone(PRODUCT_VALUES));
    const category = deepFreeze(structuredClone(CATEGORY_VALUES));
    const merged = mergeListingPolicyOverride({ productVariantId: 501, size, product, category });
    expect(merged.override).not.toBe(size);
    expect(size.fulfillmentPolicyId).toBeNull();
    expect(product).toEqual(PRODUCT_VALUES);
    expect(category).toEqual(CATEGORY_VALUES);
  });

  it("refuses a size row that belongs to another size", () => {
    let caught: unknown = null;
    try {
      mergeListingPolicyOverride({ productVariantId: 501, size: sizeOverride(502), product: null, category: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DropshipError);
    expect(caught).toMatchObject({
      code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: { productVariantId: 501, overrideProductVariantId: 502, retryable: false, classification: "fatal" },
    });
  });
});

// ---------------------------------------------------------------------------
// resolveListingStoreShelf
// ---------------------------------------------------------------------------

describe("resolveListingStoreShelf", () => {
  const NONE_PRODUCT: ProductListingSettingValues = { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, storeShelf: { mode: "none" } };
  const NONE_CATEGORY: CategoryListingSettingValues = { ...EMPTY_CATEGORY_LISTING_SETTING_VALUES, storeShelf: { mode: "none" } };

  it("gives no shelf with nothing set, as today", () => {
    expect(resolveListingStoreShelf({ sizeNames: null, product: null, category: null, storeDefault: null }))
      .toEqual({ names: [], source: "none" });
  });

  it("keeps the size's own row over everything else", () => {
    expect(resolveListingStoreShelf({
      sizeNames: ["Size shelf"], product: PRODUCT_VALUES, category: CATEGORY_VALUES, storeDefault: STORE_DEFAULT,
    })).toEqual({ names: ["Size shelf"], source: "size" });
  });

  it("reads an empty size list as no row, as the preview and the facts read it today", () => {
    expect(resolveListingStoreShelf({ sizeNames: [], product: null, category: null, storeDefault: null }))
      .toEqual({ names: [], source: "none" });
    expect(resolveListingStoreShelf({ sizeNames: [], product: null, category: null, storeDefault: STORE_DEFAULT }))
      .toEqual({ names: ["Everything", "New"], source: "store_default" });
  });

  it("gives the product's own shelves, first then second, over the category and the store default", () => {
    expect(resolveListingStoreShelf({
      sizeNames: null, product: PRODUCT_VALUES, category: CATEGORY_VALUES, storeDefault: STORE_DEFAULT,
    })).toEqual({ names: ["Mailers:Bubble", "Sale"], source: "product" });
  });

  it("lets the product's explicit none beat the category's shelves and the store default", () => {
    expect(resolveListingStoreShelf({
      sizeNames: null, product: NONE_PRODUCT, category: CATEGORY_VALUES, storeDefault: STORE_DEFAULT,
    })).toEqual({ names: [], source: "product" });
  });

  it("gives the category's shelves when the product follows", () => {
    expect(resolveListingStoreShelf({
      sizeNames: null, product: { ...PRODUCT_VALUES, storeShelf: null }, category: CATEGORY_VALUES, storeDefault: STORE_DEFAULT,
    })).toEqual({ names: ["Mailers"], source: "category" });
  });

  it("lets the category's explicit none beat the store default", () => {
    expect(resolveListingStoreShelf({ sizeNames: null, product: null, category: NONE_CATEGORY, storeDefault: STORE_DEFAULT }))
      .toEqual({ names: [], source: "category" });
  });

  it("gives the store default only when nothing else is set", () => {
    expect(resolveListingStoreShelf({
      sizeNames: null,
      product: EMPTY_PRODUCT_LISTING_SETTING_VALUES,
      category: EMPTY_CATEGORY_LISTING_SETTING_VALUES,
      storeDefault: STORE_DEFAULT,
    })).toEqual({ names: ["Everything", "New"], source: "store_default" });
  });

  it("gives a product with no category the store default, whatever category rows exist", () => {
    const layers = layersOf([], [categoryRow(11, CATEGORY_VALUES)]);
    expect(resolveListingStoreShelf({
      sizeNames: null, ...layersFor(layers, { productId: 100, categoryId: null }), storeDefault: STORE_DEFAULT,
    })).toEqual({ names: ["Everything", "New"], source: "store_default" });
  });

  it("returns new arrays and never mutates its inputs", () => {
    const sizeNames = deepFreeze(["Size shelf"]);
    const product = deepFreeze(structuredClone(PRODUCT_VALUES));
    const storeDefault = deepFreeze(structuredClone(STORE_DEFAULT));
    const fromSize = resolveListingStoreShelf({ sizeNames, product: null, category: null, storeDefault: null });
    const fromProduct = resolveListingStoreShelf({ sizeNames: null, product, category: null, storeDefault: null });
    const fromDefault = resolveListingStoreShelf({ sizeNames: null, product: null, category: null, storeDefault });
    expect(fromSize.names).not.toBe(sizeNames);
    expect(fromDefault.names).not.toBe(storeDefault.names);
    fromSize.names.push("changed");
    fromProduct.names.push("changed");
    fromDefault.names.push("changed");
    expect(sizeNames).toEqual(["Size shelf"]);
    expect(product).toEqual(PRODUCT_VALUES);
    expect(storeDefault).toEqual(STORE_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();
/** Every statement the readers may send: a plain SELECT, never a lock or a write. */
const READ_ONLY = /^SELECT\b/;
const LOCK_OR_WRITE = /\b(FOR (UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)|INSERT|UPDATE|DELETE|LOCK)\b/;

/** What PostgreSQL hands back for a stored revision: jsonb arrays parsed again, timestamps as Dates. */
function storedProduct(productId: number, values: ProductListingSettingValues, revisionId = 7): Record<string, unknown> {
  return { product_id: productId, revision_id: revisionId,
    ...(JSON.parse(JSON.stringify(productValuesToColumns(values))) as Record<string, unknown>), created_at: SAVED_AT };
}

function storedCategory(categoryId: number, values: CategoryListingSettingValues, revisionId = 8): Record<string, unknown> {
  return { category_id: categoryId, revision_id: revisionId,
    ...(JSON.parse(JSON.stringify(categoryValuesToColumns(values))) as Record<string, unknown>), created_at: SAVED_AT };
}

class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  products: Record<string, unknown>[] = [];
  categories: Record<string, unknown>[] = [];
  categoryNames: Record<string, unknown>[] = [];

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = oneLine(text);
    this.sql.push(sql);
    this.params.push(params);
    if (/FROM dropship\.dropship_product_listing_settings s\b/.test(sql)) return { rows: this.products as T[] };
    if (/FROM dropship\.dropship_category_listing_settings s\b/.test(sql)) return { rows: this.categories as T[] };
    if (sql.startsWith("SELECT id, name FROM catalog.product_categories")) return { rows: this.categoryNames as T[] };
    throw new Error(`Unexpected query: ${sql}`);
  }
}

function asClient(client: ScriptedClient): Pick<PoolClient, "query"> {
  return client as unknown as Pick<PoolClient, "query">;
}

function expectReadOnly(client: ScriptedClient): void {
  for (const sql of client.sql) {
    expect(sql).toMatch(READ_ONLY);
    expect(sql).not.toMatch(LOCK_OR_WRITE);
  }
}

describe("readListingSettingLayers", () => {
  const read = (client: ScriptedClient, candidates: readonly { productId: number; categoryId: number | null }[]) =>
    readListingSettingLayers(asClient(client), { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, candidates });

  it("sends no query for no candidates", async () => {
    const client = new ScriptedClient();
    const layers = await read(client, []);
    expect(client.sql).toEqual([]);
    expect(layers.products.size).toBe(0);
    expect(layers.categories.size).toBe(0);
  });

  it("sends only the product read when no candidate has a Card Shellz category", async () => {
    const client = new ScriptedClient();
    const layers = await read(client, [{ productId: 600, categoryId: null }, { productId: 700, categoryId: null }]);
    expect(client.sql).toHaveLength(1);
    expect(client.sql[0]).toMatch(/FROM dropship\.dropship_product_listing_settings s\b/);
    expect(client.params[0]).toEqual([VENDOR_ID, STORE_ID, [600, 700]]);
    expect(layers.categories.size).toBe(0);
    expectReadOnly(client);
  });

  it("reads products then categories, each id once, scoped to the vendor and store", async () => {
    const client = new ScriptedClient();
    await read(client, [
      { productId: 300, categoryId: 13 },
      { productId: 100, categoryId: 11 },
      { productId: 100, categoryId: 11 },
      { productId: 600, categoryId: null },
      { productId: 200, categoryId: 11 },
    ]);
    expect(client.sql).toHaveLength(2);
    expect(client.sql[0]).toMatch(/FROM dropship\.dropship_product_listing_settings s\b/);
    expect(client.params[0]).toEqual([VENDOR_ID, STORE_ID, [100, 200, 300, 600]]);
    expect(client.sql[1]).toMatch(/FROM dropship\.dropship_category_listing_settings s\b/);
    expect(client.params[1]).toEqual([VENDOR_ID, STORE_ID, [11, 13]]);
    expectReadOnly(client);
  });

  it("keys each parsed row by its product or category id", async () => {
    const client = new ScriptedClient();
    client.products = [storedProduct(100, PRODUCT_VALUES, 21)];
    client.categories = [storedCategory(11, CATEGORY_VALUES, 31)];
    const layers = await read(client, [{ productId: 100, categoryId: 11 }, { productId: 200, categoryId: 12 }]);
    expect([...layers.products.keys()]).toEqual([100]);
    expect([...layers.categories.keys()]).toEqual([11]);
    expect(layers.products.get(100)).toEqual(productRow(100, PRODUCT_VALUES, 21));
    expect(layers.categories.get(11)).toEqual(categoryRow(11, CATEGORY_VALUES, 31));
    expect(layersFor(layers, { productId: 200, categoryId: 12 })).toEqual({ product: null, category: null });
  });

  it("resolves a size's policies and shelf from the rows it read", async () => {
    const client = new ScriptedClient();
    client.products = [storedProduct(100, { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, returnPolicy: { id: "return-product", name: null } })];
    client.categories = [storedCategory(11, CATEGORY_VALUES)];
    const layers = await read(client, [{ productId: 100, categoryId: 11 }]);
    const values = layersFor(layers, { productId: 100, categoryId: 11 });
    expect(mergeListingPolicyOverride({ productVariantId: 501, size: null, ...values })).toEqual({
      override: { productVariantId: 501, fulfillmentPolicyId: "ship-category", returnPolicyId: "return-product",
        paymentPolicyId: "payment-category" },
      sources: { fulfillmentPolicyId: "category", returnPolicyId: "product", paymentPolicyId: "category" },
    });
    expect(resolveListingStoreShelf({ sizeNames: null, ...values, storeDefault: STORE_DEFAULT }))
      .toEqual({ names: ["Mailers"], source: "category" });
  });

  it("refuses a stored row that breaks the stored contract (fatal)", async () => {
    const client = new ScriptedClient();
    client.products = [{ ...storedProduct(100, PRODUCT_VALUES), price_rounding: null }];
    const error = await failure(read(client, [{ productId: 100, categoryId: null }]));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ retryable: false, classification: "fatal" });
  });

  it("refuses a candidate whose category id is missing instead of skipping its category", async () => {
    const client = new ScriptedClient();
    const unmapped = { productId: 100 } as unknown as { productId: number; categoryId: number | null };
    const error = await failure(read(client, [unmapped]));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(client.sql.some((sql) => /dropship_category_listing_settings/.test(sql))).toBe(false);
  });

  it("refuses an invalid product id before any query", async () => {
    const client = new ScriptedClient();
    const error = await failure(read(client, [{ productId: 0, categoryId: null }]));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(client.sql).toEqual([]);
  });
});

describe("readCatalogCategoryNames", () => {
  it("sends no query for no ids", async () => {
    const client = new ScriptedClient();
    expect(await readCatalogCategoryNames(asClient(client), [])).toEqual(new Map());
    expect(client.sql).toEqual([]);
  });

  it("reads each category once and gives its current name; a missing category is absent", async () => {
    const client = new ScriptedClient();
    client.categoryNames = [{ id: 11, name: "Mailers" }, { id: 13, name: "Toploaders" }];
    const names = await readCatalogCategoryNames(asClient(client), [13, 11, 13, 12]);
    expect(names).toEqual(new Map([[11, "Mailers"], [13, "Toploaders"]]));
    expect(client.sql).toEqual(["SELECT id, name FROM catalog.product_categories WHERE id = ANY($1::int[]) ORDER BY id"]);
    expect(client.params).toEqual([[[11, 12, 13]]]);
    expectReadOnly(client);
  });

  it("refuses an invalid id before any query", async () => {
    const client = new ScriptedClient();
    for (const invalid of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      const error = await failure(readCatalogCategoryNames(asClient(client), [11, invalid]));
      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
      expect(error.context).toMatchObject({ invalidCount: 1, classification: "fatal" });
    }
    expect(client.sql).toEqual([]);
  });

  it("refuses a blank or non-text name, naming the category", async () => {
    for (const name of ["  ", "", null]) {
      const client = new ScriptedClient();
      client.categoryNames = [{ id: 11, name }];
      const error = await failure(readCatalogCategoryNames(asClient(client), [11]));
      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
      expect(error.context).toMatchObject({ categoryId: 11 });
    }
  });

  it("refuses a row it did not ask for", async () => {
    const client = new ScriptedClient();
    client.categoryNames = [{ id: 99, name: "Other" }];
    const error = await failure(readCatalogCategoryNames(asClient(client), [11]));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
  });
});
