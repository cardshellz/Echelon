import { describe, expect, it, vi } from "vitest";

import {
  InventoryChannelQuantityRuntimeError,
  InventoryChannelQuantityRuntimeService,
} from "../../application/inventory-channel-quantity-runtime.service";
import type {
  CanonicalInventoryPublicationIntent,
  InventoryPublicationRouteResult,
} from "../../application/inventory-availability-runtime-publication.service";

function canonicalRow(overrides: Partial<CanonicalInventoryPublicationIntent> = {}): CanonicalInventoryPublicationIntent {
  return {
    publicationTargetId: 11,
    publicationTargetRevision: "7",
    productVariantId: 101,
    sku: "SKU-101",
    desiredQuantity: "8",
    channelId: 67,
    channelName: "eBay",
    destinationKind: "channel_connection",
    channelConnectionId: 34,
    dropshipStoreConnectionId: null,
    providerKey: "ebay",
    providerScopeType: "account",
    externalScopeId: "account-1",
    externalInventoryItemId: "SKU-101",
    externalSku: "SKU-101",
    sourceWarehouseIds: [1],
    blockerCodes: [],
    ...overrides,
  };
}

function serviceWith<T>(result: InventoryPublicationRouteResult<T>) {
  const publishProduct = vi.fn(async (_input, legacyReader) => {
    if (result.authority === "legacy") {
      return { authority: "legacy", legacyResult: await legacyReader() } as InventoryPublicationRouteResult<T>;
    }
    return result;
  });
  return {
    service: new InventoryChannelQuantityRuntimeService(() => ({ publishProduct } as never)),
    publishProduct,
  };
}

describe("InventoryChannelQuantityRuntimeService", () => {
  it("runs and validates the deployed legacy reader under the publication authority boundary", async () => {
    const { service, publishProduct } = serviceWith({
      authority: "legacy",
      legacyResult: [] as readonly { productVariantId: number; quantity: number }[],
    });
    const legacyReader = vi.fn(async () => [
      { productVariantId: 102, quantity: 0 },
      { productVariantId: 101, quantity: 9 },
    ]);

    await expect(service.readProduct({
      productId: 10,
      channelId: 67,
      target: { destinationKind: "channel_connection" },
      triggeredBy: "test",
    }, legacyReader)).resolves.toEqual({
      authority: "legacy",
      productId: 10,
      rows: [
        { productVariantId: 101, quantity: 9, publicationTargetIds: [] },
        { productVariantId: 102, quantity: 0, publicationTargetIds: [] },
      ],
    });
    expect(publishProduct).toHaveBeenCalledWith(
      { productId: 10, dryRun: true, triggeredBy: "test" },
      legacyReader,
    );
  });

  it("uses exact canonical channel exposure instead of invoking the legacy reader", async () => {
    const rows = [
      canonicalRow({ productVariantId: 102, desiredQuantity: "3" }),
      canonicalRow({ productVariantId: 101, desiredQuantity: "8" }),
      canonicalRow({ publicationTargetId: 12, destinationKind: "dropship_store_connection",
        channelConnectionId: null, dropshipStoreConnectionId: 91, desiredQuantity: "99" }),
    ];
    const { service } = serviceWith({
      authority: "canonical",
      publication: {
        authority: "canonical",
        authorityRevision: "2",
        activationRunId: "5",
        dryRun: true,
        productId: 10,
        rows,
        enqueuedRows: 0,
        coalescedRows: 0,
        enqueuedPublicationKeys: [],
        coalescedPublicationKeys: [],
      },
    });
    const legacyReader = vi.fn();

    await expect(service.readProduct({
      productId: 10,
      channelId: 67,
      target: { destinationKind: "channel_connection", connectionId: 34, providerKey: "EBAY" },
      triggeredBy: "listing_preview",
    }, legacyReader)).resolves.toEqual({
      authority: "canonical",
      productId: 10,
      rows: [
        { productVariantId: 101, quantity: 8, publicationTargetIds: [11] },
        { productVariantId: 102, quantity: 3, publicationTargetIds: [11] },
      ],
    });
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it("fails closed instead of summing ambiguous destination quantities", async () => {
    const { service } = serviceWith({
      authority: "canonical",
      publication: {
        authority: "canonical",
        authorityRevision: "2",
        activationRunId: "5",
        dryRun: true,
        productId: 10,
        rows: [canonicalRow(), canonicalRow({ publicationTargetId: 12, channelConnectionId: 35 })],
        enqueuedRows: 0,
        coalescedRows: 0,
        enqueuedPublicationKeys: [],
        coalescedPublicationKeys: [],
      },
    });

    await expect(service.readProduct({
      productId: 10,
      channelId: 67,
      target: { destinationKind: "channel_connection" },
      triggeredBy: "listing_preview",
    }, async () => [])).rejects.toMatchObject<Partial<InventoryChannelQuantityRuntimeError>>({
      code: "CANONICAL_CHANNEL_QUANTITY_TARGET_AMBIGUOUS",
    });
  });

  it("collapses equivalent destinations only for an explicitly channel-level read", async () => {
    const { service } = serviceWith({
      authority: "canonical",
      publication: {
        authority: "canonical",
        authorityRevision: "2",
        activationRunId: "5",
        dryRun: true,
        productId: 10,
        rows: [
          canonicalRow({ publicationTargetId: 21, destinationKind: "dropship_store_connection",
            channelConnectionId: null, dropshipStoreConnectionId: 91 }),
          canonicalRow({ publicationTargetId: 22, destinationKind: "dropship_store_connection",
            channelConnectionId: null, dropshipStoreConnectionId: 92 }),
        ],
        enqueuedRows: 0,
        coalescedRows: 0,
        enqueuedPublicationKeys: [],
        coalescedPublicationKeys: [],
      },
    });

    await expect(service.readProduct({
      productId: 10,
      channelId: 67,
      target: { destinationKind: "dropship_store_connection" },
      allowEquivalentDestinationRows: true,
      triggeredBy: "dropship_catalog_preview",
    }, async () => [])).resolves.toMatchObject({
      rows: [{ productVariantId: 101, quantity: 8, publicationTargetIds: [21, 22] }],
    });
  });

  it("rejects unequal channel-level destination quantities", async () => {
    const { service } = serviceWith({
      authority: "canonical",
      publication: {
        authority: "canonical",
        authorityRevision: "2",
        activationRunId: "5",
        dryRun: true,
        productId: 10,
        rows: [
          canonicalRow({ publicationTargetId: 21, destinationKind: "dropship_store_connection",
            channelConnectionId: null, dropshipStoreConnectionId: 91 }),
          canonicalRow({ publicationTargetId: 22, destinationKind: "dropship_store_connection",
            channelConnectionId: null, dropshipStoreConnectionId: 92, desiredQuantity: "7" }),
        ],
        enqueuedRows: 0,
        coalescedRows: 0,
        enqueuedPublicationKeys: [],
        coalescedPublicationKeys: [],
      },
    });

    await expect(service.readProduct({
      productId: 10,
      channelId: 67,
      target: { destinationKind: "dropship_store_connection" },
      allowEquivalentDestinationRows: true,
      triggeredBy: "dropship_catalog_preview",
    }, async () => [])).rejects.toMatchObject({
      code: "CANONICAL_CHANNEL_QUANTITY_TARGET_AMBIGUOUS",
    });
  });

  it("rejects a canonical preview for a different product or non-read-only execution", async () => {
    const { service } = serviceWith({
      authority: "canonical",
      publication: {
        authority: "canonical",
        authorityRevision: "2",
        activationRunId: "5",
        dryRun: false,
        productId: 11,
        rows: [canonicalRow()],
        enqueuedRows: 1,
        coalescedRows: 0,
        enqueuedPublicationKeys: ["unexpected"],
        coalescedPublicationKeys: [],
      },
    });

    await expect(service.readProduct({
      productId: 10,
      channelId: 67,
      target: { destinationKind: "channel_connection" },
      triggeredBy: "listing_preview",
    }, async () => [])).rejects.toMatchObject({
      code: "CANONICAL_CHANNEL_QUANTITY_PUBLICATION_MISMATCH",
    });
  });

  it("rejects duplicate canonical publication destinations", async () => {
    const { service } = serviceWith({
      authority: "canonical",
      publication: {
        authority: "canonical",
        authorityRevision: "2",
        activationRunId: "5",
        dryRun: true,
        productId: 10,
        rows: [canonicalRow(), canonicalRow()],
        enqueuedRows: 0,
        coalescedRows: 0,
        enqueuedPublicationKeys: [],
        coalescedPublicationKeys: [],
      },
    });

    await expect(service.readProduct({
      productId: 10,
      channelId: 67,
      target: { destinationKind: "channel_connection" },
      allowEquivalentDestinationRows: true,
      triggeredBy: "listing_preview",
    }, async () => [])).rejects.toMatchObject({
      code: "CANONICAL_CHANNEL_QUANTITY_TARGET_DUPLICATE",
    });
  });
});
