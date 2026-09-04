import { describe, expect, it, vi } from "vitest";

import type { InventoryChannelExposureRuntimePlan } from "@shared/types/inventory-channel-exposure";
import {
  AuthorityAwareInventoryPublicationService,
  type ActiveInventoryPublicationTarget,
  type InventoryAvailabilityRuntimePublicationContext,
  type InventoryAvailabilityRuntimePublicationExecutor,
} from "../../application/inventory-availability-runtime-publication.service";

const HASH = "a".repeat(64);

describe("AuthorityAwareInventoryPublicationService", () => {
  it("pins legacy authority around the existing publisher", async () => {
    const context = runtimeContext("legacy");
    const legacyPublisher = vi.fn(async () => ["legacy-result"]);
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    await expect(service.publishProduct({
      productId: 10,
      dryRun: false,
      triggeredBy: "inventory_change:receive",
    }, legacyPublisher)).resolves.toEqual({
      authority: "legacy",
      legacyResult: ["legacy-result"],
    });

    expect(legacyPublisher).toHaveBeenCalledOnce();
    expect(context.planProduct).not.toHaveBeenCalled();
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("calculates active target exposure and durably enqueues absolute canonical quantity", async () => {
    const context = runtimeContext("canonical");
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    const routed = await service.publishProduct({
      productId: 10,
      dryRun: false,
      triggeredBy: "inventory_change:pick",
    }, vi.fn());

    expect(routed).toMatchObject({
      authority: "canonical",
      publication: {
        authorityRevision: "9",
        activationRunId: "44",
        enqueuedRows: 1,
        coalescedRows: 0,
        rows: [{
          publicationTargetId: 5,
          productVariantId: 101,
          desiredQuantity: "4",
          externalInventoryItemId: "inventory-item-101",
          sourceWarehouseIds: [1],
        }],
      },
    });
    expect(context.enqueueFullPublications).toHaveBeenCalledWith(
      "44",
      [expect.objectContaining({ desiredQuantity: "4" })],
    );
  });

  it("uses the canonical calculation for dry-run without inserting outbox work", async () => {
    const context = runtimeContext("canonical");
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    const routed = await service.publishProduct({ productId: 10, dryRun: true }, vi.fn());

    expect(routed).toMatchObject({
      authority: "canonical",
      publication: { dryRun: true, rows: [{ desiredQuantity: "4" }], enqueuedRows: 0 },
    });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("fails closed before enqueueing a Dropship-owned canonical target", async () => {
    const context = runtimeContext("canonical");
    const plan = runtimePlan([target()]);
    context.planProduct = vi.fn(async () => ({
      ...plan,
      targets: plan.targets.map((publicationTarget) => ({
        ...publicationTarget,
        destinationKind: "dropship_store_connection" as const,
        channelConnectionId: null,
        dropshipStoreConnectionId: 91,
      })),
    }));
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    await expect(service.publishProduct({ productId: 10, dryRun: false }, vi.fn()))
      .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_DESTINATION_UNSUPPORTED" });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("forces an inactive mapped variant to zero without requiring it in the active ATP snapshot", async () => {
    const context = runtimeContext("canonical");
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    const routed = await service.publishVariantAvailability({
      productId: 10,
      productVariantId: 101,
      channelId: 3,
      desiredActive: false,
    }, vi.fn());

    expect(routed).toMatchObject({
      authority: "canonical",
      publication: {
        rows: [{ productVariantId: 101, channelId: 3, desiredQuantity: "0" }],
      },
    });
    expect(context.planProduct).not.toHaveBeenCalled();
    expect(context.enqueueFullPublications).toHaveBeenCalledWith(
      "44",
      [expect.objectContaining({ desiredQuantity: "0" })],
    );
  });

  it("fails closed when a live target lacks the exact active provider mapping", async () => {
    const context = runtimeContext("canonical", [{ ...target(), mappings: [] }]);
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    await expect(service.publishProduct({ productId: 10, dryRun: false }, vi.fn()))
      .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING" });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("rejects overlapping account and location targets for the same channel variant", async () => {
    const context = runtimeContext("canonical", [
      { ...target(), providerScopeType: "account", externalScopeId: "account-3" },
      { ...target(), publicationTargetId: 6, externalScopeId: "location-2" },
    ]);
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    await expect(service.publishProduct({ productId: 10, dryRun: false }, vi.fn()))
      .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_TARGET_SCOPE_AMBIGUOUS" });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("does not treat separate channel connections as an overlapping provider scope", async () => {
    const context = runtimeContext("canonical", [
      { ...target(), providerScopeType: "account", externalScopeId: "account-3" },
      { ...target(), publicationTargetId: 6, channelConnectionId: 34, externalScopeId: "location-2" },
    ]);
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    await expect(service.publishProduct({ productId: 10, dryRun: false }, vi.fn()))
      .resolves.toMatchObject({ authority: "canonical", publication: { enqueuedRows: 2 } });
  });

  it("uses active canonical mappings to enumerate full-sync products", async () => {
    const canonical = runtimeContext("canonical");
    canonical.listActivePublicationProductIds = vi.fn(async () => [12, 10, 12]);
    const canonicalService = new AuthorityAwareInventoryPublicationService(executor(canonical));
    await expect(canonicalService.listProductIds(vi.fn(async () => [99])))
      .resolves.toEqual([10, 12]);

    const legacy = runtimeContext("legacy");
    const legacyReader = vi.fn(async () => [8, 7, 8]);
    const legacyService = new AuthorityAwareInventoryPublicationService(executor(legacy));
    await expect(legacyService.listProductIds(legacyReader)).resolves.toEqual([7, 8]);
    expect(legacy.listActivePublicationProductIds).not.toHaveBeenCalled();
  });
});

function executor(
  context: InventoryAvailabilityRuntimePublicationContext,
): InventoryAvailabilityRuntimePublicationExecutor {
  return { execute: (work) => work(context) };
}

function runtimeContext(
  authority: "legacy" | "canonical",
  targets: ActiveInventoryPublicationTarget[] = [target()],
): InventoryAvailabilityRuntimePublicationContext & Record<string, ReturnType<typeof vi.fn>> {
  return {
    authority,
    authorityRevision: authority === "canonical" ? "9" : "1",
    activationRunId: authority === "canonical" ? "44" : null,
    listActivePublicationProductIds: vi.fn(async () => [10]),
    planProduct: vi.fn(async () => runtimePlan(targets)),
    loadActivePublicationTargets: vi.fn(async () => targets),
    enqueueFullPublications: vi.fn(async (_runId, intents) => ({
      enqueuedRows: intents.length,
      coalescedRows: 0,
      enqueuedPublicationKeys: intents.map((row) =>
        `${row.publicationTargetId}:${row.productVariantId}`),
      coalescedPublicationKeys: [],
    })),
  } as never;
}

function target(): ActiveInventoryPublicationTarget {
  return {
    publicationTargetId: 5,
    publicationTargetRevision: "2",
    channelId: 3,
    channelName: "Shopify US",
    providerKey: "shopify",
    channelConnectionId: 33,
    providerScopeType: "location",
    externalScopeId: "location-1",
    sourceBindingId: 7,
    sourceWarehouseIds: [1],
    mappings: [{
      productVariantId: 101,
      externalInventoryItemId: "inventory-item-101",
      externalSku: "EA",
    }],
  };
}

function runtimePlan(targets: ActiveInventoryPublicationTarget[]): InventoryChannelExposureRuntimePlan {
  return {
    authority: "canonical",
    authorityRevision: "9",
    activationRunId: "44",
    productId: 10,
    snapshotFingerprint: HASH,
    snapshotCapturedAt: "2026-09-04T12:00:00.000Z",
    targets: targets.map((target) => {
      const mapping = target.mappings[0] ?? null;
        return {
          publicationTargetId: target.publicationTargetId,
          publicationTargetRevision: target.publicationTargetRevision,
          destinationKind: "channel_connection" as const,
          channelId: target.channelId,
        channelName: target.channelName,
        channelProvider: target.providerKey,
          channelConnectionId: target.channelConnectionId,
          dropshipStoreConnectionId: null,
        providerScopeType: target.providerScopeType,
        externalScopeId: target.externalScopeId,
        publicationAuthority: "echelon" as const,
        publicationTargetState: "live" as const,
        sourceBinding: {
          bindingId: target.sourceBindingId ?? 7,
          version: 1,
          definitionHash: HASH,
          fulfillmentNodeIds: [1],
          warehouseIds: target.sourceWarehouseIds,
        },
        selectedPolicies: [{
          scopeKey: `channel:${target.channelId}`,
          policyId: 1,
          version: 1,
          definitionHash: HASH,
        }],
        rows: [{
          productVariantId: 101,
          sku: "EA",
          unitsPerVariant: 1,
          canonicalAtpUnits: "10",
          sharedUnits: "5",
          afterHoldbackUnits: "4",
          cappedUnits: "4",
          publishedUnits: "4",
          sourceWarehouseBreakdown: [{ warehouseId: 1, canonicalAtpUnits: "10" }],
          policy: {
            allocationSemantics: "exposure" as const,
            eligible: true,
            shareBps: 5_000,
            holdbackSellableUnits: "1",
            maxPublishSellableUnits: null,
            minPublishSellableUnits: "0",
            sources: {
              allocationSemantics: `channel:${target.channelId}`,
              eligible: `channel:${target.channelId}`,
              shareBps: `channel:${target.channelId}`,
              holdbackSellableUnits: `channel:${target.channelId}`,
              maxPublishSellableUnits: `channel:${target.channelId}`,
              minPublishSellableUnits: `channel:${target.channelId}`,
            },
          },
          mapping: mapping ? {
            mappingId: 1,
            version: 1,
            definitionHash: HASH,
            externalInventoryItemId: mapping.externalInventoryItemId,
            externalSku: mapping.externalSku,
          } : null,
          blockers: mapping ? [] : [{
            code: "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING",
            message: "The target has no active provider inventory identity for this SKU.",
            context: {},
          }],
          warnings: [],
        }],
        blockers: [],
        publishable: mapping !== null,
      };
    }),
    providerWriteAttempted: false,
    outboxEnqueued: false,
  };
}
