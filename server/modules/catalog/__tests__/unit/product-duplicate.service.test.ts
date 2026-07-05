import { describe, it, expect, vi, beforeEach } from "vitest";
import { duplicateProduct, ProductDuplicateError } from "../../product-duplicate.service";

// ─────────────────────────────────────────────────────────────────────────────
// duplicateProduct — clones a product into a new DRAFT with fresh SKUs.
// Verifies copy/reset rules (sync keys nulled, status → draft), variant SKU
// regeneration + parent-hierarchy remap, asset remap, and validation errors.
// Storage is mocked in-memory; no DB.
// ─────────────────────────────────────────────────────────────────────────────

function makeSource() {
  return {
    id: 10,
    sku: "SHLZ-TOP-100PT",
    name: "100PT Toploader",
    title: "100PT Toploader — Shopify Title",
    description: "desc",
    categoryId: 3,
    category: "Toploaders",
    brand: "Shellz",
    baseUnit: "piece",
    leadTimeDays: 120,
    safetyStockDays: 0,
    status: "active",
    isActive: true,
    shopifyProductId: "gid://shopify/Product/111",
    lastPushedAt: new Date("2026-01-01"),
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-06-01"),
  };
}

function buildMockStorage(source: any, sourceVariants: any[] = [], sourceAssets: any[] = [], opts: {
  skuConflict?: string;
  variantConflicts?: Record<string, number>;
} = {}) {
  let nextVariantId = 1000;
  const createdVariants: any[] = [];
  const createdAssets: any[] = [];
  const holder: { product: any } = { product: null };
  const storage = {
    getProductById: vi.fn(async (id: number) => (source && id === source.id ? source : undefined)),
    getProductBySku: vi.fn(async (sku: string) => (opts.skuConflict && sku === opts.skuConflict ? { id: 999 } : undefined)),
    getActiveVariantBySku: vi.fn(async (sku: string) =>
      opts.variantConflicts && opts.variantConflicts[sku] ? { id: opts.variantConflicts[sku] } : undefined,
    ),
    getProductVariantsByProductId: vi.fn(async (pid: number) =>
      source && pid === source.id ? sourceVariants : createdVariants.filter((v) => v.productId === pid),
    ),
    getProductAssetsByProductId: vi.fn(async (pid: number) => (source && pid === source.id ? sourceAssets : [])),
    createProduct: vi.fn(async (p: any) => { holder.product = { ...p, id: 5000 }; return holder.product; }),
    createProductVariant: vi.fn(async (v: any) => { const row = { ...v, id: nextVariantId++ }; createdVariants.push(row); return row; }),
    updateProductVariant: vi.fn(async (id: number, updates: any) => {
      const row = createdVariants.find((v) => v.id === id);
      if (row) Object.assign(row, updates);
      return row ?? null;
    }),
    createProductAsset: vi.fn(async (a: any) => { const row = { ...a, id: createdAssets.length + 1 }; createdAssets.push(row); return row; }),
  };
  return { storage, createdVariants, createdAssets, holder };
}

const baseInput = { name: "100PT Toploader (Copy)", sku: "SHLZ-TOP-100PT-COPY" };

describe("duplicateProduct", () => {
  it("copies base fields but resets identity, Shopify keys, lastPushedAt, and defaults status to draft", async () => {
    const { storage } = buildMockStorage(makeSource());

    const result = await duplicateProduct(storage as any, 10, baseInput);

    const created = storage.createProduct.mock.calls[0][0] as any;
    expect(created).toMatchObject({
      name: "100PT Toploader (Copy)",
      sku: "SHLZ-TOP-100PT-COPY",
      brand: "Shellz",
      category: "Toploaders",
      categoryId: 3,
      leadTimeDays: 120,
      status: "draft", // default
      isActive: true,
      title: null,
      shopifyProductId: null, // MUST reset
      lastPushedAt: null,
    });
    // Identity fields never carried over.
    expect(created).not.toHaveProperty("id");
    expect(created).not.toHaveProperty("createdAt");
    expect(created).not.toHaveProperty("updatedAt");
    expect(result.id).toBe(5000);
  });

  it("honours status=active when requested", async () => {
    const { storage } = buildMockStorage(makeSource());
    await duplicateProduct(storage as any, 10, { ...baseInput, status: "active" });
    expect((storage.createProduct.mock.calls[0][0] as any).status).toBe("active");
  });

  it("copies active variants with new SKUs and resets their Shopify keys", async () => {
    const variants = [
      { id: 50, productId: 10, sku: "V-A", name: "20ct", unitsPerVariant: 20, isActive: true, parentVariantId: null, shopifyVariantId: "sv1", shopifyInventoryItemId: "ii1", priceCents: 999 },
      { id: 51, productId: 10, sku: "V-B", name: "800ct", unitsPerVariant: 800, isActive: true, parentVariantId: null, shopifyVariantId: "sv2", shopifyInventoryItemId: "ii2", priceCents: 1999 },
    ];
    const { storage, createdVariants } = buildMockStorage(makeSource(), variants);

    await duplicateProduct(storage as any, 10, {
      ...baseInput,
      variants: [
        { sourceVariantId: 50, sku: "V-A-COPY" },
        { sourceVariantId: 51, sku: "V-B-COPY" },
      ],
    });

    expect(createdVariants).toHaveLength(2);
    expect(createdVariants.map((v) => v.sku)).toEqual(["V-A-COPY", "V-B-COPY"]);
    for (const v of createdVariants) {
      expect(v.productId).toBe(5000);
      expect(v.shopifyVariantId).toBeNull();
      expect(v.shopifyInventoryItemId).toBeNull();
      expect(v.isActive).toBe(true);
    }
    expect(createdVariants[0].unitsPerVariant).toBe(20);
    expect(createdVariants[1].priceCents).toBe(1999);
  });

  it("remaps parent hierarchy to the new variant ids", async () => {
    const variants = [
      { id: 50, productId: 10, sku: "P", name: "case", unitsPerVariant: 800, isActive: true, parentVariantId: null, hierarchyLevel: 1 },
      { id: 51, productId: 10, sku: "C", name: "each", unitsPerVariant: 1, isActive: true, parentVariantId: 50, hierarchyLevel: 2 },
    ];
    const { storage, createdVariants } = buildMockStorage(makeSource(), variants);

    await duplicateProduct(storage as any, 10, {
      ...baseInput,
      variants: [
        { sourceVariantId: 50, sku: "P2" },
        { sourceVariantId: 51, sku: "C2" },
      ],
    });

    const parent = createdVariants.find((v) => v.sku === "P2");
    const child = createdVariants.find((v) => v.sku === "C2");
    // Child's parent points at the NEW parent id, not the source id 50.
    expect(child.parentVariantId).toBe(parent.id);
    expect(child.parentVariantId).not.toBe(50);
  });

  it("copies assets and remaps variant-scoped assets to the new variant id", async () => {
    const variants = [{ id: 50, productId: 10, sku: "V-A", name: "20ct", unitsPerVariant: 20, isActive: true, parentVariantId: null }];
    const assets = [
      { id: 1, productId: 10, productVariantId: null, assetType: "image", url: "http://x/prod.jpg", position: 0, isPrimary: 1 },
      { id: 2, productId: 10, productVariantId: 50, assetType: "image", url: "http://x/var.jpg", position: 1, isPrimary: 0 },
    ];
    const { storage, createdVariants, createdAssets } = buildMockStorage(makeSource(), variants, assets);

    await duplicateProduct(storage as any, 10, { ...baseInput, variants: [{ sourceVariantId: 50, sku: "V-A-COPY" }] });

    const newVariantId = createdVariants[0].id;
    expect(createdAssets).toHaveLength(2);
    expect(createdAssets.every((a) => a.productId === 5000)).toBe(true);
    expect(createdAssets.find((a) => a.url.endsWith("prod.jpg")).productVariantId).toBeNull();
    expect(createdAssets.find((a) => a.url.endsWith("var.jpg")).productVariantId).toBe(newVariantId);
  });

  it("skips inactive variants and their variant-scoped assets", async () => {
    const variants = [
      { id: 50, productId: 10, sku: "V-A", name: "active", unitsPerVariant: 1, isActive: true, parentVariantId: null },
      { id: 60, productId: 10, sku: "V-DEAD", name: "archived", unitsPerVariant: 1, isActive: false, parentVariantId: null },
    ];
    const assets = [{ id: 9, productId: 10, productVariantId: 60, assetType: "image", url: "http://x/dead.jpg", position: 0, isPrimary: 0 }];
    const { storage, createdVariants, createdAssets } = buildMockStorage(makeSource(), variants, assets);

    await duplicateProduct(storage as any, 10, { ...baseInput, variants: [{ sourceVariantId: 50, sku: "V-A-COPY" }] });

    expect(createdVariants.map((v) => v.sku)).toEqual(["V-A-COPY"]); // archived one not duplicated
    expect(createdAssets).toHaveLength(0); // its asset skipped
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("404s when the source product does not exist", async () => {
    const { storage } = buildMockStorage(null);
    await expect(duplicateProduct(storage as any, 999, baseInput)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a missing base SKU", async () => {
    const { storage } = buildMockStorage(makeSource());
    await expect(duplicateProduct(storage as any, 10, { name: "x", sku: "  " })).rejects.toBeInstanceOf(ProductDuplicateError);
  });

  it("409s when the base SKU is already used by another product", async () => {
    const { storage } = buildMockStorage(makeSource(), [], [], { skuConflict: "SHLZ-TOP-100PT-COPY" });
    await expect(duplicateProduct(storage as any, 10, baseInput)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("400s when an active variant is missing a new SKU", async () => {
    const variants = [{ id: 50, productId: 10, sku: "V-A", name: "20ct", unitsPerVariant: 20, isActive: true, parentVariantId: null }];
    const { storage } = buildMockStorage(makeSource(), variants);
    await expect(duplicateProduct(storage as any, 10, { ...baseInput, variants: [] })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("409s on duplicate SKUs within the request", async () => {
    const variants = [
      { id: 50, productId: 10, sku: "A", name: "a", unitsPerVariant: 1, isActive: true, parentVariantId: null },
      { id: 51, productId: 10, sku: "B", name: "b", unitsPerVariant: 1, isActive: true, parentVariantId: null },
    ];
    const { storage } = buildMockStorage(makeSource(), variants);
    await expect(
      duplicateProduct(storage as any, 10, {
        ...baseInput,
        variants: [
          { sourceVariantId: 50, sku: "DUP" },
          { sourceVariantId: 51, sku: "dup" }, // case-insensitive collision
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("409s when a new variant SKU collides with an existing active variant", async () => {
    const variants = [{ id: 50, productId: 10, sku: "V-A", name: "a", unitsPerVariant: 1, isActive: true, parentVariantId: null }];
    const { storage } = buildMockStorage(makeSource(), variants, [], { variantConflicts: { "V-A-COPY": 777 } });
    await expect(
      duplicateProduct(storage as any, 10, { ...baseInput, variants: [{ sourceVariantId: 50, sku: "V-A-COPY" }] }),
    ).rejects.toMatchObject({ statusCode: 409, details: { conflictVariantId: 777 } });
  });
});
