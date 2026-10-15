import { describe, expect, it } from "vitest";
import { reviewEbayPublicationMember, type EbayPublicationMappingRow } from "../../domain/ebay-publication-readiness";
import { calculatePublicationVariantMappingDefinitionHash } from "../../domain/inventory-channel-exposure";
import { inventoryEbayPublicationReadinessInputSchema } from "@shared/types/ebay-publication-readiness";

const member = { productVariantId: 463, sku: "BLUE-P10" };
const row = (): EbayPublicationMappingRow => ({ id: 463, product_id: 232, sku: "BLUE-P10", external_sku: null, eligible: true,
  active_mapping_id: null, draft_mapping_id: 401, head_revision: "1", mapping_id: 401, mapping_version: 1,
  active_inventory_id: null, active_sku: null,
  mapping_hash: calculatePublicationVariantMappingDefinitionHash({ publicationTargetId: 3, productVariantId: 463, externalInventoryItemId: "BLUE-P10", externalSku: "BLUE-P10" }),
  mapping_inventory_id: "BLUE-P10", mapping_sku: "BLUE-P10", mapping_status: "draft", held_at: null, conflicts: [] });
describe("exact eBay stock mapping proposal", () => {
  it("reuses the reviewed draft and preserves input", () => {
    const current = row(), before = structuredClone(current);
    expect(reviewEbayPublicationMember({ productId: 232 }, member, 3, [current])).toMatchObject({ blockers: [],
      variant: { mappingAction: "promote_draft", desiredQuantity: null } });
    expect(current).toEqual(before);
  });
  it("supports a saved provider SKU alias without renaming the local SKU", () => {
    expect(reviewEbayPublicationMember({ productId: 232 }, member, 3, [{ ...row(), sku: "RENAMED", external_sku: "BLUE-P10" }]).blockers).toEqual([]);
  });
  it("keeps an inactive member's exact identity available to maintenance selection without authorizing new publication", () => {
    const retained = { ...row(), eligible: false };
    expect(reviewEbayPublicationMember({ productId: 232, purpose: "sync" }, member, 3, [retained]).blockers).toEqual([]);
    expect(reviewEbayPublicationMember({ productId: 232 }, member, 3, [retained]).blockers)
      .toContainEqual(expect.objectContaining({ code: "STOCK_LISTING_SOURCE_CHANGED" }));
    expect(reviewEbayPublicationMember({ productId: 232, purpose: "sync" }, member, 3, [{ ...retained, mapping_sku: "OTHER" }]).blockers)
      .toContainEqual(expect.objectContaining({ code: "STOCK_LISTING_MAPPING_REVIEW_REQUIRED" }));
  });
  it.each([
    [{ product_id: 3 }, "STOCK_LISTING_SOURCE_CHANGED"], [{ eligible: false }, "STOCK_LISTING_SOURCE_CHANGED"],
    [{ held_at: new Date("2026-10-12T12:00:00Z") }, "STOCK_LISTING_HELD"],
    [{ conflicts: [5, 6] }, "STOCK_LISTING_MAPPING_CONFLICT"], [{ mapping_sku: "CLEAR-P10" }, "STOCK_LISTING_MAPPING_REVIEW_REQUIRED"],
    [{ mapping_hash: "a".repeat(64) }, "STOCK_LISTING_MAPPING_REVIEW_REQUIRED"],
    [{ active_mapping_id: 400, active_inventory_id: "OLD", active_sku: "OLD" }, "STOCK_LISTING_MAPPING_REVIEW_REQUIRED"],
  ] as const)("preserves incompatible setup %j", (change, code) => {
    expect(reviewEbayPublicationMember({ productId: 232 }, member, 3, [{ ...row(), ...change, conflicts: [...("conflicts" in change ? change.conflicts : [])] }]).blockers.map(issue => issue.code)).toContain(code);
  });
  it("does not accept duplicate or missing local ownership", () => {
    for (const rows of [[], [row(), row()]]) expect(reviewEbayPublicationMember({ productId: 232 }, member, 3, rows).blockers.map(issue => issue.code)).toContain("STOCK_LISTING_SOURCE_CHANGED");
  });
  it("directs changed catalog identity to variant review, not stock configuration", () => {
    const result = reviewEbayPublicationMember({ productId: 232 }, member, 3, [{ ...row(), sku: "CHANGED" }]);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "STOCK_LISTING_SOURCE_CHANGED", action: "review_variant" }));
  });
  it("rejects duplicate provider identities at the public boundary", () => {
    expect(inventoryEbayPublicationReadinessInputSchema.safeParse({ channelId: 67, connectionId: 34, accountId: "seller", environment: "production",
      productId: 232, variants: [member, { ...member, productVariantId: 464 }] }).success).toBe(false);
  });
});
