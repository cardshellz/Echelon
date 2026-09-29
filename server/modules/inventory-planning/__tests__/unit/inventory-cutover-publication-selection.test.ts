import { describe, expect, it } from "vitest";
import type { ActiveInventoryPublicationTargetSnapshot } from "../../application/inventory-channel-exposure-runtime.service";
import { inventoryCutoverManifestSchema, type InventoryCutoverManifest } from "@shared/types/inventory-cutover-commit";
import { projectCutoverSourceActivation, selectedCutoverPublicationMappings } from "../../domain/inventory-cutover-publication-selection";

const target: ActiveInventoryPublicationTargetSnapshot = {
  publicationTargetId: 1, publicationTargetRevision: "1", destinationKind: "channel_connection", channelId: 1,
  channelName: "Shopify US", channelProvider: "shopify", channelConnectionId: 1, dropshipStoreConnectionId: null,
  providerScopeType: "location", externalScopeId: "external-location", publicationAuthority: "echelon", publicationTargetState: "live",
  hold: null, sourceBinding: { bindingId: 1, version: 1, definitionHash: "a".repeat(64),
    members: [{ fulfillmentNodeId: 1, warehouseId: 7, fulfillmentNodeLifecycleStatus: "draft" }] },
  policies: [], variantHolds: [], mappings: [101, 102].map((productVariantId, index) => ({
    mappingId: index + 1, productVariantId, version: 1, definitionHash: "b".repeat(64),
    externalInventoryItemId: `external-${productVariantId}`, externalSku: `SKU-${productVariantId}`,
  })), membership: { mode: "explicit", includedVariantIds: [101] },
};
const manifest: InventoryCutoverManifest = {
  contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [20], publicationTargetIds: [1], selections: [],
  sourceNodes: [{ nodeId: 1, warehouseId: 7, nodeType: "internal_warehouse", inventoryAuthority: "echelon", fulfillmentAuthority: "echelon",
    providerAccountId: null, providerLocationId: null, lifecycleStatus: "draft", warehouseActive: 1 }],
};

describe("cutover publication selection", () => {
  it("requires mappings for included SKUs only, without removing excluded SKUs from supply", () => {
    expect(selectedCutoverPublicationMappings(target).map(mapping => mapping.productVariantId)).toEqual([101]);
    expect(target.mappings.map(mapping => mapping.productVariantId)).toEqual([101, 102]);
  });

  it.each([undefined, { mode: "whole_product" as const }])("preserves whole-product callers: %j", membership => {
    expect(selectedCutoverPublicationMappings({ ...target, membership })).toEqual(target.mappings);
  });

  it("does not opt excluded or unknown SKUs in", () => {
    expect(selectedCutoverPublicationMappings({ ...target, membership: { mode: "explicit", includedVariantIds: [] } })).toEqual([]);
    expect(selectedCutoverPublicationMappings({ ...target, membership: { mode: "explicit", includedVariantIds: [999] } })).toEqual([]);
  });

  it("projects only reviewed draft sources, including SKU source overrides, without mutating runtime evidence", () => {
    const input = { ...target, sourceOverrideMembers: target.sourceBinding!.members };
    const before = JSON.stringify(input);
    const [projected] = projectCutoverSourceActivation([input], manifest);
    expect(projected.sourceBinding!.members[0].fulfillmentNodeLifecycleStatus).toBe("active");
    expect(projected.sourceOverrideMembers![0].fulfillmentNodeLifecycleStatus).toBe("active");
    expect(projected.mappings).toEqual(target.mappings);
    expect(JSON.stringify(input)).toBe(before);
    expect(manifest.sourceNodes![0].lifecycleStatus).toBe("draft");
  });

  it.each([
    { nodeId: 2 }, { warehouseId: 8 }, { lifecycleStatus: "retired" }, { lifecycleStatus: "active" }, { warehouseActive: 0 },
  ] as const)("does not project a source inconsistent with reviewed draft evidence: %j", change => {
    const result = projectCutoverSourceActivation([target], { ...manifest, sourceNodes: [{ ...manifest.sourceNodes![0], ...change }] });
    expect(result[0].sourceBinding!.members[0].fulfillmentNodeLifecycleStatus).toBe("draft");
  });

  it("does not activate an unreviewed source or invent a missing binding", () => {
    expect(projectCutoverSourceActivation([target], { ...manifest, sourceNodes: undefined })[0]).toEqual(target);
    expect(projectCutoverSourceActivation([{ ...target, sourceBinding: null }], manifest)[0].sourceBinding).toBeNull();
  });

  it("cannot project a retired binding member back to active", () => {
    const retired = { ...target, sourceBinding: { ...target.sourceBinding!, members: [
      { fulfillmentNodeId: 1, warehouseId: 7, fulfillmentNodeLifecycleStatus: "retired" as const },
    ] } };
    expect(projectCutoverSourceActivation([retired], manifest)[0]).toEqual(retired);
  });

  it("accepts historical manifests and rejects duplicate or unordered source evidence", () => {
    expect(inventoryCutoverManifestSchema.parse({ ...manifest, sourceNodes: undefined }).sourceNodes).toBeUndefined();
    expect(inventoryCutoverManifestSchema.parse(manifest)).toEqual(manifest);
    const node = manifest.sourceNodes![0];
    expect(() => inventoryCutoverManifestSchema.parse({ ...manifest, sourceNodes: [node, node] })).toThrow();
    expect(() => inventoryCutoverManifestSchema.parse({ ...manifest, sourceNodes: [{ ...node, nodeId: 2 }, node] })).toThrow();
  });
});
