import { describe, expect, it } from "vitest";

import {
  createInventoryPublicationTargetRequestSchema,
  type ResolvedChannelExposurePolicy,
} from "@shared/types/inventory-channel-exposure";

import {
  calculateChannelExposure,
  calculateChannelExposureDefinitionHash,
  calculatePublicationSourceBindingDefinitionHash,
  calculatePublicationVariantMappingDefinitionHash,
  channelExposurePolicyScopeKey,
  findPartitionedShareOverages,
  resolveChannelExposurePolicy,
} from "../../domain/inventory-channel-exposure";

const completeChannelValue = {
  allocationSemantics: "exposure" as const,
  eligible: true,
  shareBps: 8_000,
  holdbackSellableUnits: "2",
  maxPublish: { mode: "unlimited" as const },
  minPublishSellableUnits: "3",
};

describe("inventory channel exposure domain", () => {
  it("normalizes legacy channel target requests to an exact channel destination", () => {
    expect(createInventoryPublicationTargetRequestSchema.parse({
      channelId: 7,
      channelConnectionId: 9,
      legacyFulfillmentNodeId: 11,
      providerScopeType: "location",
      externalScopeId: "location-1",
      publicationAuthority: "echelon",
      changeReason: "Preserve the existing request contract",
      idempotencyKey: "target-channel-1",
    })).toEqual({
      destinationKind: "channel_connection",
      channelId: 7,
      channelConnectionId: 9,
      dropshipStoreConnectionId: null,
      legacyFulfillmentNodeId: 11,
      providerScopeType: "location",
      externalScopeId: "location-1",
      publicationAuthority: "echelon",
      changeReason: "Preserve the existing request contract",
      idempotencyKey: "target-channel-1",
    });
  });

  it("accepts a dropship store destination with an independent allocation dial", () => {
    expect(createInventoryPublicationTargetRequestSchema.parse({
      destinationKind: "dropship_store_connection",
      channelId: 7,
      channelConnectionId: null,
      dropshipStoreConnectionId: 13,
      legacyFulfillmentNodeId: 11,
      providerScopeType: "account",
      externalScopeId: "seller-account-1",
      publicationAuthority: "echelon",
      changeReason: "Prepare an inactive dropship target",
      idempotencyKey: "target-dropship-1",
    })).toMatchObject({
      destinationKind: "dropship_store_connection",
      channelId: 7,
      channelConnectionId: null,
      dropshipStoreConnectionId: 13,
    });
  });

  it.each([
    {
      destinationKind: "channel_connection" as const,
      channelConnectionId: null,
      dropshipStoreConnectionId: null,
    },
    {
      destinationKind: "channel_connection" as const,
      channelConnectionId: 9,
      dropshipStoreConnectionId: 13,
    },
    {
      destinationKind: "dropship_store_connection" as const,
      channelConnectionId: 9,
      dropshipStoreConnectionId: 13,
    },
  ])("rejects an invalid exact destination identity: %o", (destination) => {
    expect(createInventoryPublicationTargetRequestSchema.safeParse({
      ...destination,
      channelId: 7,
      legacyFulfillmentNodeId: 11,
      providerScopeType: "account",
      externalScopeId: "seller-account-1",
      publicationAuthority: "echelon",
      changeReason: "Invalid identity must fail",
      idempotencyKey: "target-invalid-1",
    }).success).toBe(false);
  });

  it("resolves every field SKU then product then channel", () => {
    const result = resolveChannelExposurePolicy({
      channelId: 7,
      productId: 11,
      productVariantId: 13,
      policies: [
        { scopeKey: "channel:7", scopeType: "channel", value: completeChannelValue },
        { scopeKey: "channel:7:product:11", scopeType: "product", value: {
          allocationSemantics: null,
          eligible: null,
          shareBps: 5_000,
          holdbackSellableUnits: null,
          maxPublish: { mode: "units", units: "20" },
          minPublishSellableUnits: null,
        } },
        { scopeKey: "channel:7:variant:13", scopeType: "variant", value: {
          allocationSemantics: "partitioned",
          eligible: null,
          shareBps: null,
          holdbackSellableUnits: "4",
          maxPublish: null,
          minPublishSellableUnits: null,
        } },
      ],
    });

    expect(result.missingFields).toEqual([]);
    expect(result.policy).toEqual({
      allocationSemantics: "partitioned",
      eligible: true,
      shareBps: 5_000,
      holdbackSellableUnits: "4",
      maxPublishSellableUnits: "20",
      minPublishSellableUnits: "3",
      sources: {
        allocationSemantics: "channel:7:variant:13",
        eligible: "channel:7",
        shareBps: "channel:7:product:11",
        holdbackSellableUnits: "channel:7:variant:13",
        maxPublishSellableUnits: "channel:7:product:11",
        minPublishSellableUnits: "channel:7",
      },
    });
  });

  it("fails closed when a required field is unresolved", () => {
    const result = resolveChannelExposurePolicy({
      channelId: 7,
      productId: 11,
      productVariantId: 13,
      policies: [{
        scopeKey: "channel:7",
        scopeType: "channel",
        value: { ...completeChannelValue, eligible: null },
      }],
    });

    expect(result.policy).toBeNull();
    expect(result.missingFields).toEqual(["eligible"]);
  });

  it("applies share, then holdback, then cap, then minimum cutoff", () => {
    const policy = resolvedPolicy({
      shareBps: 5_000,
      holdbackSellableUnits: "3",
      maxPublishSellableUnits: "20",
      minPublishSellableUnits: "5",
    });
    expect(calculateChannelExposure(BigInt(51), policy)).toEqual({
      canonicalAtpUnits: BigInt(51),
      sharedUnits: BigInt(25),
      afterHoldbackUnits: BigInt(22),
      cappedUnits: BigInt(20),
      publishedUnits: BigInt(20),
    });
    expect(calculateChannelExposure(BigInt(15), policy).publishedUnits).toBe(BigInt(0));
  });

  it("publishes zero immediately when the resolved SKU is ineligible", () => {
    expect(calculateChannelExposure(BigInt(100), resolvedPolicy({ eligible: false }))).toEqual({
      canonicalAtpUnits: BigInt(100),
      sharedUnits: BigInt(0),
      afterHoldbackUnits: BigInt(0),
      cappedUnits: BigInt(0),
      publishedUnits: BigInt(0),
    });
  });

  it("detects partitioned shares above 100 percent for overlapping warehouses", () => {
    const overages = findPartitionedShareOverages([
      { productVariantId: 13, sourceWarehouseIds: [1, 2], policy: resolvedPolicy({
        allocationSemantics: "partitioned", shareBps: 6_000,
      }) },
      { productVariantId: 13, sourceWarehouseIds: [2], policy: resolvedPolicy({
        allocationSemantics: "partitioned", shareBps: 5_000,
      }) },
      { productVariantId: 13, sourceWarehouseIds: [2], policy: resolvedPolicy({
        allocationSemantics: "exposure", shareBps: 10_000,
      }) },
    ]);
    expect(overages).toEqual([{ productVariantId: 13, warehouseId: 2, totalShareBps: 11_000 }]);
  });

  it("hashes ordered source bindings and normalized policy definitions deterministically", () => {
    const first = calculatePublicationSourceBindingDefinitionHash({
      publicationTargetId: 1,
      fulfillmentNodeIds: [2, 3],
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(calculatePublicationSourceBindingDefinitionHash({
      fulfillmentNodeIds: [2, 3],
      publicationTargetId: 1,
    }));
    expect(first).toBe(calculatePublicationSourceBindingDefinitionHash({
      publicationTargetId: 1,
      fulfillmentNodeIds: [3, 2],
    }));
    expect(calculateChannelExposureDefinitionHash({
      scope: { scopeType: "channel", channelId: 7 },
      value: completeChannelValue,
    })).toMatch(/^[0-9a-f]{64}$/);
    const mappingHash = calculatePublicationVariantMappingDefinitionHash({
      publicationTargetId: 5,
      productVariantId: 13,
      externalInventoryItemId: "inventory-item-13",
      externalSku: "EA",
    });
    expect(mappingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mappingHash).toBe(calculatePublicationVariantMappingDefinitionHash({
      externalSku: "EA",
      externalInventoryItemId: "inventory-item-13",
      productVariantId: 13,
      publicationTargetId: 5,
    }));
    expect(channelExposurePolicyScopeKey({
      scopeType: "variant", channelId: 7, productId: 11, productVariantId: 13,
    })).toBe("channel:7:variant:13");
  });
});

function resolvedPolicy(
  patch: Partial<ResolvedChannelExposurePolicy> = {},
): ResolvedChannelExposurePolicy {
  return {
    allocationSemantics: "exposure",
    eligible: true,
    shareBps: 10_000,
    holdbackSellableUnits: "0",
    maxPublishSellableUnits: null,
    minPublishSellableUnits: "0",
    sources: {
      allocationSemantics: "channel:7",
      eligible: "channel:7",
      shareBps: "channel:7",
      holdbackSellableUnits: "channel:7",
      maxPublishSellableUnits: "channel:7",
      minPublishSellableUnits: "channel:7",
    },
    ...patch,
  };
}
