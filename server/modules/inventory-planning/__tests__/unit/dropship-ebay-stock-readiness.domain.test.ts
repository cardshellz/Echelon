import { describe, expect, it } from "vitest";
import {
  dropshipEbayStockActorSchema, dropshipEbayStockReadinessInputSchema, dropshipEbayStockReadinessResultSchema,
} from "@shared/types/dropship-ebay-stock-readiness";
import {
  DROPSHIP_EBAY_STOCK_KEY_PREFIX, dropshipEbayStockCommandKey, dropshipEbayStockOriginKey, dropshipEbayStockPreparationKey,
  dropshipEbayStockRequestHash, normalizeDropshipEbayStockInput,
} from "../../domain/dropship-ebay-stock-readiness";

const push = { kind: "listing_push" as const, jobId: 7, jobItemId: 70, listingId: 700 };
const enrollment = (evidenceHash = "b".repeat(64)) => ({ kind: "live_listing_enrollment" as const, listingId: 700, evidenceHash });
const input = (overrides: Record<string, unknown> = {}) => ({ vendorId: 10, storeConnectionId: 22, accountId: "dropship-seller",
  environment: "production", productId: 20, purpose: "publish",
  variants: [{ productVariantId: 102, sku: "B-SKU" }, { productVariantId: 101, sku: "A-SKU" }], origin: push, ...overrides });
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Dropship eBay stock link command identity", () => {
  it("is a deterministic v5 UUID per store and origin", () => {
    const key = dropshipEbayStockCommandKey(22, push);
    expect(key).toMatch(UUID_V5);
    expect(dropshipEbayStockCommandKey(22, { ...push })).toBe(key);
    expect(dropshipEbayStockOriginKey(22, push)).toBe("listing_push:22:70");
    expect(dropshipEbayStockOriginKey(22, enrollment())).toBe(`live_listing_enrollment:22:700:${"b".repeat(64)}`);
  });

  it("differs by job item, origin kind, evidence hash and store, but not by job or listing of the same item", () => {
    const keys = [
      dropshipEbayStockCommandKey(22, push),
      dropshipEbayStockCommandKey(22, { ...push, jobItemId: 71 }),
      dropshipEbayStockCommandKey(23, push),
      dropshipEbayStockCommandKey(22, enrollment()),
      dropshipEbayStockCommandKey(22, enrollment("c".repeat(64))),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    // A job item belongs to one job and listing: the item alone identifies the command.
    expect(dropshipEbayStockCommandKey(22, { ...push, jobId: 8, listingId: 701 })).toBe(keys[0]);
  });

  it("does not depend on the SKU or variant order, so a changed SKU is a detectable conflict", () => {
    const first = normalizeDropshipEbayStockInput(input());
    const reordered = normalizeDropshipEbayStockInput(input({ variants: [...input().variants].reverse() }));
    const changedSku = normalizeDropshipEbayStockInput(input({ variants: [{ productVariantId: 101, sku: "OTHER" }, { productVariantId: 102, sku: "B-SKU" }] }));
    expect(dropshipEbayStockCommandKey(first.storeConnectionId, first.origin))
      .toBe(dropshipEbayStockCommandKey(changedSku.storeConnectionId, changedSku.origin));
    const actor = "system:dropship-listing-push";
    expect(dropshipEbayStockRequestHash(reordered, actor)).toBe(dropshipEbayStockRequestHash(first, actor));
    expect(dropshipEbayStockRequestHash(changedSku, actor)).not.toBe(dropshipEbayStockRequestHash(first, actor));
    expect(dropshipEbayStockRequestHash(first, "system:dropship-stock-enrollment")).not.toBe(dropshipEbayStockRequestHash(first, actor));
    expect(dropshipEbayStockRequestHash(first, actor)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fits every derived key in its column", () => {
    const key = dropshipEbayStockCommandKey(2_147_483_647, { ...push, jobItemId: 2_147_483_647 });
    expect(dropshipEbayStockPreparationKey(key)).toBe(`${DROPSHIP_EBAY_STOCK_KEY_PREFIX}:${key}`);
    expect(dropshipEbayStockPreparationKey(key).length).toBe(56); // publication_mapping_preparations.idempotency_key varchar(120)
    expect(`${dropshipEbayStockPreparationKey(key)}:2147483647`.length).toBeLessThanOrEqual(67); // draft keys
  });
});

describe("Dropship eBay stock link input contract", () => {
  it("normalizes variant order without mutating the caller's input", () => {
    const raw = input();
    const snapshot = structuredClone(raw);
    const normalized = normalizeDropshipEbayStockInput(raw);
    expect(normalized.variants.map(row => row.productVariantId)).toEqual([101, 102]);
    expect(raw).toEqual(snapshot);
    expect(normalized).not.toBe(raw);
  });

  it.each([
    ["a duplicate variant", input({ variants: [{ productVariantId: 101, sku: "A" }, { productVariantId: 101, sku: "B" }] })],
    ["a duplicate SKU", input({ variants: [{ productVariantId: 101, sku: "A" }, { productVariantId: 102, sku: "A" }] })],
    ["no variants", input({ variants: [] })],
    ["501 variants", input({ variants: Array.from({ length: 501 }, (_, index) => ({ productVariantId: index + 1, sku: `S-${index}` })) })],
    ["an extra key", { ...input(), channelId: 67 }],
    ["an extra variant key", input({ variants: [{ productVariantId: 101, sku: "A", quantity: 3 }] })],
    ["a blank SKU", input({ variants: [{ productVariantId: 101, sku: "   " }] })],
    ["a SKU over 100 characters", input({ variants: [{ productVariantId: 101, sku: "S".repeat(101) }] })],
    ["a bad environment", input({ environment: "staging" })],
    ["an account longer than a destination scope", input({ accountId: "a".repeat(241) })],
    ["a missing purpose", (() => { const { purpose: _purpose, ...rest } = input(); return rest; })()],
    ["a zero id", input({ productId: 0 })],
    ["an id beyond PostgreSQL integer", input({ vendorId: 2_147_483_648 })],
    ["an unknown origin kind", input({ origin: { kind: "manual", listingId: 1 } })],
    ["a malformed evidence hash", input({ origin: enrollment("XYZ") })],
    ["an extra origin key", input({ origin: { ...push, sku: "A" } })],
  ])("rejects %s", (_label, raw) => {
    expect(dropshipEbayStockReadinessInputSchema.safeParse(raw).success).toBe(false);
    expect(() => normalizeDropshipEbayStockInput(raw)).toThrow();
  });

  it("accepts 500 variants and both origins", () => {
    expect(dropshipEbayStockReadinessInputSchema.safeParse(input({
      variants: Array.from({ length: 500 }, (_, index) => ({ productVariantId: index + 1, sku: `S-${index}` })) })).success).toBe(true);
    expect(dropshipEbayStockReadinessInputSchema.safeParse(input({ origin: enrollment(), purpose: "sync" })).success).toBe(true);
  });

  it("allows only the two automatic system actors", () => {
    expect(dropshipEbayStockActorSchema.options).toEqual(["system:dropship-listing-push", "system:dropship-stock-enrollment"]);
    expect(dropshipEbayStockActorSchema.safeParse("operator").success).toBe(false);
  });
});

describe("Dropship eBay stock link result contract", () => {
  const commandKey = dropshipEbayStockCommandKey(22, push);
  it("requires at least one blocker on a refusal and one linked member on success", () => {
    expect(dropshipEbayStockReadinessResultSchema.safeParse({ status: "blocked", commandKey, publicationTargetId: null,
      targetCount: 0, blockers: [] }).success).toBe(false);
    expect(dropshipEbayStockReadinessResultSchema.safeParse({ status: "blocked", commandKey, publicationTargetId: null, targetCount: 0,
      blockers: [{ code: "STOCK_LISTING_TARGET_MISMATCH", message: "No destination.", action: "configure_inventory", productVariantId: null }] }).success).toBe(true);
    expect(dropshipEbayStockReadinessResultSchema.safeParse({ status: "ready", commandKey, publicationTargetId: 4,
      linkedProductVariantIds: [], alreadyLinked: true, mappingActions: [], preparation: null, fenceHoldMs: null }).success).toBe(false);
    expect(dropshipEbayStockReadinessResultSchema.safeParse({ status: "ready", commandKey, publicationTargetId: 4,
      linkedProductVariantIds: [101], alreadyLinked: true, mappingActions: [], preparation: null, fenceHoldMs: -1 }).success).toBe(false);
    expect(dropshipEbayStockReadinessResultSchema.safeParse({ status: "not_applicable", reason: "legacy_authority" }).success).toBe(true);
  });
});
