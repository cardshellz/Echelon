import { describe, expect, it } from "vitest";

async function loadModule() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  return await import("../relink-shopify-variant-ids");
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    variantId: 265,
    sku: "ARM-ENV-SGL-C700",
    shopifyVariantId: "old-var",
    shopifyInventoryItemId: "old-inv",
    feedId: 10,
    feedChannelProductId: "old-prod",
    feedChannelVariantId: "old-var",
    feedChannelInventoryItemId: "old-inv",
    listingId: 20,
    listingExternalProductId: "old-prod",
    listingExternalVariantId: "old-var",
    ...overrides,
  } as any;
}

function makeLive(entries: Record<string, any>, duplicates: string[] = []) {
  return {
    bySku: new Map(Object.entries(entries)),
    duplicateSkus: new Set(duplicates),
    variantsWithoutSku: 0,
  } as any;
}

const FRESH = { productId: "p-new", variantId: "v-new", inventoryItemId: "inv-new" };

describe("relink-shopify-variant-ids", () => {
  it("parses CLI flags with a safe dry-run default", async () => {
    const { parseCli } = await loadModule();
    expect(parseCli([])).toEqual({ apply: false, channelId: null, skus: null });
    expect(parseCli(["--apply", "--channel=36", "--sku=arm-env-sgl-c700, eg-slv-std-c10000"]))
      .toEqual({
        apply: true,
        channelId: 36,
        skus: ["ARM-ENV-SGL-C700", "EG-SLV-STD-C10000"],
      });
  });

  it("builds the live SKU map uppercased, flags duplicates, guards missing inventory_item_id", async () => {
    const { buildLiveSkuMap } = await loadModule();
    const map = buildLiveSkuMap([
      {
        id: 1,
        variants: [
          { id: 11, sku: "arm-env-sgl-c700", inventory_item_id: 111 },
          { id: 12, sku: null }, // no SKU — uncounted, never mapped
          { id: 13, sku: "NO-INV-ITEM" }, // inventory_item_id missing — must NOT become "undefined"
        ],
      },
      {
        id: 2,
        variants: [
          { id: 21, sku: "DUP-SKU", inventory_item_id: 211 },
          { id: 22, sku: "dup-sku", inventory_item_id: 221 },
        ],
      },
    ]);

    expect(map.bySku.get("ARM-ENV-SGL-C700")).toEqual({
      productId: "1",
      variantId: "11",
      inventoryItemId: "111",
    });
    expect(map.bySku.get("NO-INV-ITEM")!.inventoryItemId).toBeNull();
    expect(map.duplicateSkus.has("DUP-SKU")).toBe(true);
    expect(map.variantsWithoutSku).toBe(1);
  });

  it("plans a full re-link across feeds, listings, and (authority only) product_variants", async () => {
    const { planChannelRelink } = await loadModule();
    const plan = planChannelRelink(
      [makeRow()],
      makeLive({ "ARM-ENV-SGL-C700": FRESH }),
      true,
    );

    expect(plan[0].status).toBe("relink");
    const byTarget = (t: string) => plan[0].changes.filter((c: any) => c.target === t);
    expect(byTarget("channel_feeds").map((c: any) => c.field)).toEqual([
      "channel_product_id",
      "channel_variant_id",
      "channel_inventory_item_id",
    ]);
    expect(byTarget("channel_listings").map((c: any) => c.field)).toEqual([
      "external_product_id",
      "external_variant_id",
    ]);
    expect(byTarget("product_variants").map((c: any) => c.field)).toEqual([
      "shopify_variant_id",
      "shopify_inventory_item_id",
    ]);
  });

  it("never touches product_variants for a non-authority channel", async () => {
    const { planChannelRelink } = await loadModule();
    const plan = planChannelRelink(
      [makeRow()],
      makeLive({ "ARM-ENV-SGL-C700": FRESH }),
      false,
    );
    expect(plan[0].status).toBe("relink");
    expect(plan[0].changes.some((c: any) => c.target === "product_variants")).toBe(false);
  });

  it("reports ok when everything already matches (idempotent re-run)", async () => {
    const { planChannelRelink } = await loadModule();
    const row = makeRow({
      shopifyVariantId: "v-new",
      shopifyInventoryItemId: "inv-new",
      feedChannelProductId: "p-new",
      feedChannelVariantId: "v-new",
      feedChannelInventoryItemId: "inv-new",
      listingExternalProductId: "p-new",
      listingExternalVariantId: "v-new",
    });
    const plan = planChannelRelink([row], makeLive({ "ARM-ENV-SGL-C700": FRESH }), true);
    expect(plan[0].status).toBe("ok");
    expect(plan[0].changes).toEqual([]);
  });

  it("treats legacy 'undefined'/'null'/'' strings as absent (still drift)", async () => {
    const { isAbsentExternalValue, planChannelRelink } = await loadModule();
    expect(isAbsentExternalValue("undefined")).toBe(true);
    expect(isAbsentExternalValue("null")).toBe(true);
    expect(isAbsentExternalValue("  ")).toBe(true);
    expect(isAbsentExternalValue("123")).toBe(false);

    const row = makeRow({ feedChannelInventoryItemId: "undefined" });
    const plan = planChannelRelink([row], makeLive({ "ARM-ENV-SGL-C700": FRESH }), false);
    expect(
      plan[0].changes.some(
        (c: any) => c.field === "channel_inventory_item_id" && c.newValue === "inv-new",
      ),
    ).toBe(true);
  });

  it("never overwrites a stored id with an unknown live value", async () => {
    const { planChannelRelink } = await loadModule();
    const plan = planChannelRelink(
      [makeRow()],
      makeLive({
        "ARM-ENV-SGL-C700": { productId: "p-new", variantId: "v-new", inventoryItemId: null },
      }),
      true,
    );
    // inventory-item fields stay untouched when live value is unknown
    expect(plan[0].changes.some((c: any) => c.field.includes("inventory_item"))).toBe(false);
    expect(plan[0].changes.some((c: any) => c.field === "channel_variant_id")).toBe(true);
  });

  it("classifies placeholder, missing, and ambiguous SKUs as unhealable", async () => {
    const { planChannelRelink } = await loadModule();
    const plan = planChannelRelink(
      [
        makeRow({ sku: "SHOPIFY-1234567", variantId: 1 }),
        makeRow({ sku: "GONE-FROM-SHOPIFY", variantId: 2 }),
        makeRow({ sku: "DUP-SKU", variantId: 3 }),
      ],
      makeLive({}, ["DUP-SKU"]),
      true,
    );
    expect(plan.map((p: any) => p.status)).toEqual([
      "placeholder_unlinkable",
      "missing_in_shopify",
      "ambiguous_sku",
    ]);
    expect(plan.every((p: any) => p.changes.length === 0)).toBe(true);
  });

  it("re-links a placeholder-free row even when only the listing exists (no feed row)", async () => {
    const { planChannelRelink } = await loadModule();
    const row = makeRow({ feedId: null });
    const plan = planChannelRelink([row], makeLive({ "ARM-ENV-SGL-C700": FRESH }), false);
    expect(plan[0].status).toBe("relink");
    expect(plan[0].changes.every((c: any) => c.target === "channel_listings")).toBe(true);
  });
});
