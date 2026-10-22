import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-10-20, ARM-ENV-GRD-P10: setting the P10 <-> C100 package direction was
// refused with "An affected channel destination is not ready for publication"
// because another channel's listing was broken. That listing must not block a
// product's inventory rules; it is shown and stays frozen instead.

const { preview, publishProduct } = vi.hoisted(() => ({ preview: vi.fn(), publishProduct: vi.fn() }));
vi.mock("../../../../db", () => ({ pool: {} }));
vi.mock("../../infrastructure/inventory-availability-shadow.repository", () => ({
  captureActiveSupplySnapshotInsideTransaction: vi.fn(async () => ({ snapshotFingerprint: "a".repeat(64), variants: [], warehouses: [] })),
  captureProductDraftReviewSnapshotInsideTransaction: vi.fn(),
}));
vi.mock("../../infrastructure/inventory-availability-runtime-publication.repository", () => ({
  previewProductDefinitionPublicationInsideTransaction: preview,
  createTransactionScopedInventoryPublicationService: () => ({ publishProduct }),
}));

import { captureDefinitionImpact, enqueueReviewedDefinitionPublication } from "../../infrastructure/inventory-product-definition.repository";

const walmart = { publicationTargetId: 34, channelId: 104, channelName: "Walmart", errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING",
  blockerCodes: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"], productVariantIds: [64] };
const shopifyRow = { publicationTargetId: 1, productVariantId: 64, channelName: "Shopify", sku: "ARM-ENV-GRD-P10", desiredQuantity: "3", blockerCodes: [] };

describe("product definition review with a broken channel listing", () => {
  beforeEach(() => { preview.mockReset(); publishProduct.mockReset(); });

  it("previews in isolation, lists the skipped destination and does not block the review", async () => {
    preview.mockResolvedValue({ rows: [shopifyRow], blockedTargets: [walmart] });
    const snapshot = { snapshotFingerprint: "b".repeat(64), variants: [], warehouses: [] };
    const impact = await captureDefinitionImpact({} as never, [20], async () => snapshot as never);

    expect(preview).toHaveBeenCalledWith(expect.anything(), 20, expect.anything(), undefined, "isolate");
    expect(impact.blockers).toEqual([]);
    expect(impact.skippedDestinations).toEqual([expect.stringContaining("Walmart: stock is not updating (CANONICAL_PUBLICATION_MAPPING_MISSING")]);
    expect(impact.channels).toEqual([expect.objectContaining({ targetId: 1, proposed: "3" })]);
  });

  // Channels PR1: a channel Shopify destination with 1 of 3 sizes unlinked is row-isolated, so
  // the review says only that size is not updating and the linked sizes stay in the change.
  it("names only the unlinked sizes of a row-isolated channel Shopify destination", async () => {
    const shopifyIsolated = { publicationTargetId: 1, channelId: 35, channelName: "Shopify", errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING",
      blockerCodes: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"], productVariantIds: [102], isolation: "rows" };
    const linked = [101, 103].map(productVariantId => ({ ...shopifyRow, productVariantId, sku: `SKU-${productVariantId}` }));
    preview.mockResolvedValue({ rows: linked, blockedTargets: [shopifyIsolated] });
    const impact = await captureDefinitionImpact({} as never, [20],
      async () => ({ snapshotFingerprint: "b".repeat(64), variants: [], warehouses: [] }) as never);
    expect(impact.blockers).toEqual([]);
    expect(impact.skippedDestinations).toEqual(["Shopify: stock is not updating for 1 unlinked item(s) "
      + "(CANONICAL_PUBLICATION_MAPPING_MISSING: PUBLICATION_TARGET_VARIANT_MAPPING_MISSING). Fix that listing; this change still applies."]);
    expect(impact.channels.map(row => row.variantId)).toEqual([101, 103]);
  });

  it("changes the review fingerprint when a destination becomes blocked", async () => {
    const snapshot = async () => ({ snapshotFingerprint: "b".repeat(64), variants: [], warehouses: [] }) as never;
    preview.mockResolvedValue({ rows: [shopifyRow], blockedTargets: [] });
    const clean = await captureDefinitionImpact({} as never, [20], snapshot);
    preview.mockResolvedValue({ rows: [shopifyRow], blockedTargets: [walmart] });
    const blocked = await captureDefinitionImpact({} as never, [20], snapshot);
    expect(blocked.fingerprints).not.toEqual(clean.fingerprints);
  });

  it("applies the safe destinations and hands the skipped one to the publication work row", async () => {
    publishProduct.mockResolvedValue({ authority: "canonical", publication: { rows: [shopifyRow], blockedTargets: [walmart] } });
    const client = { query: vi.fn(async (text: string) => text.includes("inventory_publication_outbox") ? { rows: [{ id: "900" }] } : { rows: [] }) };

    await expect(enqueueReviewedDefinitionPublication(client as never, { affectedProductIds: [20], activationRunId: "44",
      channels: [{ productId: 20, targetId: 1, channelName: "Shopify", variantId: 64, sku: "ARM-ENV-GRD-P10", current: "0", proposed: "3" }] }))
      .resolves.toEqual(["900"]);
    expect(publishProduct).toHaveBeenCalledWith(expect.objectContaining({ productId: 20, blockedTargets: "isolate" }), expect.any(Function));
    expect(client.query).toHaveBeenCalledWith("SELECT inventory.invalidate_publication_selection_product($1)", [20]);
  });
});
