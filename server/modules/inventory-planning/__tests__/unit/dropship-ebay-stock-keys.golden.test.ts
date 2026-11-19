import { describe, expect, it } from "vitest";
import {
  DROPSHIP_EBAY_STOCK_KEY_PREFIX, dropshipEbayStockCommandKey, dropshipEbayStockOriginKey, dropshipEbayStockPreparationKey,
  dropshipEbayStockRequestHash, normalizeDropshipEbayStockInput,
} from "../../domain/dropship-ebay-stock-readiness";

// Channels PR2 (PLAN-CH2 v4.1 §5, TST-5): literal goldens written and green on main
// before ensureDropshipEbayStockReady becomes a wrapper over the shared stock-link
// command. A live Dropship push replays its command by these exact strings (the
// preparation receipt, each draft receipt and the command lock), so any change to a
// value below re-links or conflicts real listings. Never edit a literal to make this
// pass: a red here means the conversion changed a key. The draft-key template and the
// lock built from these keys are pinned end to end by the real-PostgreSQL pin
// (dropship-ebay-stock-command-lock.integration.test.ts).
const goldens = [
  {
    label: "a listing push",
    actor: "system:dropship-listing-push",
    raw: { vendorId: 10, storeConnectionId: 22, accountId: "dropship-seller", environment: "production", productId: 20,
      purpose: "publish", variants: [{ productVariantId: 101, sku: "P5" }],
      origin: { kind: "listing_push", jobId: 1, jobItemId: 1, listingId: 1 } },
    originKey: "listing_push:22:1",
    commandKey: "1a1a8c2c-5459-5e1d-8908-fa2952c12e80",
    requestHash: "139dbaa092f4c9d72839d8e65c439a2cb48eac19ab8c953403946515f24b7f76",
    preparationKey: "dropship-ebay-stock:1a1a8c2c-5459-5e1d-8908-fa2952c12e80",
    draftKeys: ["dropship-ebay-stock:1a1a8c2c-5459-5e1d-8908-fa2952c12e80:101"],
  },
  {
    label: "a live listing enrollment",
    actor: "system:dropship-stock-enrollment",
    raw: { vendorId: 10, storeConnectionId: 22, accountId: "dropship-seller", environment: "production", productId: 20,
      purpose: "sync", variants: [{ productVariantId: 101, sku: "P5" }],
      origin: { kind: "live_listing_enrollment", listingId: 1, evidenceHash: "e".repeat(64) } },
    originKey: `live_listing_enrollment:22:1:${"e".repeat(64)}`,
    commandKey: "7decbc90-605c-5960-99dc-554a0bd74db2",
    requestHash: "30b2179d43556761a97377fc7c9a6e10a1ccfbe09623841d64b03285a788c2f9",
    preparationKey: "dropship-ebay-stock:7decbc90-605c-5960-99dc-554a0bd74db2",
    draftKeys: ["dropship-ebay-stock:7decbc90-605c-5960-99dc-554a0bd74db2:101"],
  },
  {
    label: "a two-size push at the id bounds, sizes given out of order, a non-ASCII account",
    actor: "system:dropship-listing-push",
    raw: { vendorId: 2_147_483_647, storeConnectionId: 2_147_483_647, accountId: "seller-ü-2", environment: "sandbox",
      productId: 2_147_483_647, purpose: "publish",
      variants: [{ productVariantId: 2_147_483_647, sku: "ZZ-9" }, { productVariantId: 5, sku: "A-1" }],
      origin: { kind: "listing_push", jobId: 7, jobItemId: 2_147_483_647, listingId: 99 } },
    originKey: "listing_push:2147483647:2147483647",
    commandKey: "9e98a9ee-4ac4-52f7-8172-81e430609253",
    requestHash: "af01592d401f5c4242374c1dae986a6648a91e92532afb1d59bd8e49bed5a3d2",
    preparationKey: "dropship-ebay-stock:9e98a9ee-4ac4-52f7-8172-81e430609253",
    draftKeys: ["dropship-ebay-stock:9e98a9ee-4ac4-52f7-8172-81e430609253:5",
      "dropship-ebay-stock:9e98a9ee-4ac4-52f7-8172-81e430609253:2147483647"],
  },
] as const;

describe("Dropship eBay stock link keys (literal goldens)", () => {
  it("keeps the key prefix", () => {
    expect(DROPSHIP_EBAY_STOCK_KEY_PREFIX).toBe("dropship-ebay-stock");
  });

  it.each(goldens)("keeps the origin key, command key, request hash, preparation key and draft keys for $label", golden => {
    const raw = structuredClone(golden.raw);
    const source = normalizeDropshipEbayStockInput(raw);
    expect(raw).toEqual(golden.raw);
    const commandKey = dropshipEbayStockCommandKey(source.storeConnectionId, source.origin);
    expect(dropshipEbayStockOriginKey(source.storeConnectionId, source.origin)).toBe(golden.originKey);
    expect(commandKey).toBe(golden.commandKey);
    expect(dropshipEbayStockRequestHash(source, golden.actor)).toBe(golden.requestHash);
    expect(dropshipEbayStockPreparationKey(commandKey)).toBe(golden.preparationKey);
    // Draft keys: `<prefix>:<command key>:<variant id>` in variant-id order
    // (exact-ebay-sku-mapping.apply.ts builds them per reviewed member).
    expect(source.variants.map(row => `${dropshipEbayStockPreparationKey(commandKey)}:${row.productVariantId}`)).toEqual(golden.draftKeys);
  });

  it("fits each golden key in its column", () => {
    for (const golden of goldens) {
      // inventory.publication_mapping_preparations.idempotency_key is varchar(120).
      expect(golden.preparationKey).toHaveLength(56);
      // publication_variant_mapping_versions.idempotency_key is varchar(120) too.
      for (const key of golden.draftKeys) expect(key.length).toBeLessThanOrEqual(67);
    }
  });
});
