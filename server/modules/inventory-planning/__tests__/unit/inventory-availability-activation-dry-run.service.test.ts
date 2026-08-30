import { describe, expect, it, vi } from "vitest";

import type {
  InventoryAvailabilityBackfillQueueResponse,
  InventoryAvailabilityChannelPreview,
} from "@shared/types/inventory-availability-backfill";
import type { CurrentPublicationEvidence } from "@shared/types/inventory-availability-phase4";
import {
  InventoryAvailabilityActivationDryRunService,
  InventoryAvailabilityActivationDryRunServiceError,
} from "../../application/inventory-availability-activation-dry-run.service";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const STARTED_AT = new Date("2026-08-28T17:00:00.000Z");
const COMPLETED_AT = new Date("2026-08-28T17:00:01.000Z");

describe("inventory availability activation dry-run service", () => {
  it("records a ready full-catalog comparison without runtime, provider, or outbox writes", async () => {
    const queue = catalogQueue();
    const preview = channelPreview();
    const store = fakeStore([publicationEvidence()]);
    const service = new InventoryAvailabilityActivationDryRunService(
      {
        getMigrationQueue: vi.fn(async () => queue),
        getChannelPreview: vi.fn(async () => preview),
      } as never,
      store,
      sequenceClock(STARTED_AT, COMPLETED_AT),
    );

    const result = await service.runDryRun({
      expectedCatalogInputHash: HASH_A,
      expectedCatalogResultHash: HASH_B,
      idempotencyKey: "activation-dry-run-1",
      reason: "Validate the complete catalog before cutover",
    }, "operator-1");

    expect(result).toMatchObject({
      mode: "dry_run",
      scope: "full_catalog",
      state: "ready_for_publication",
      runtimeAuthorityChanged: false,
      providerWriteAttempted: false,
      outboxEnqueued: false,
      summary: { totalProducts: 1, readyProducts: 1, blockedProducts: 0, publicationRows: 1 },
    });
    expect(result.products[0]?.proposedPublications[0]).toMatchObject({
      canonicalAtpUnits: "10",
      desiredUnits: "8",
      differenceFromLastAcknowledgedUnits: "2",
    });
    expect(store.persistActivationDryRun).toHaveBeenCalledWith(expect.objectContaining({
      state: "ready_for_publication",
      requestedBy: "operator-1",
    }));
  });

  it("blocks an active legacy feed without exact target and provider readback evidence", async () => {
    const store = fakeStore([{
      ...publicationEvidence(),
      configuredTargets: [],
    }]);
    const service = new InventoryAvailabilityActivationDryRunService(
      {
        getMigrationQueue: vi.fn(async () => catalogQueue()),
        getChannelPreview: vi.fn(async () => channelPreview()),
      } as never,
      store,
      sequenceClock(STARTED_AT, COMPLETED_AT),
    );

    const result = await service.runDryRun({
      expectedCatalogInputHash: HASH_A,
      expectedCatalogResultHash: HASH_B,
      idempotencyKey: "activation-dry-run-2",
      reason: "Expose missing publication evidence",
    }, "operator-1");

    expect(result.state).toBe("blocked");
    expect(result.products[0]?.blockers.map((entry) => entry.code))
      .toContain("EXPLICIT_PUBLICATION_TARGET_MISSING");
  });

  it("rejects a stale catalog hash before channel or publication capture", async () => {
    const backfillReader = {
      getMigrationQueue: vi.fn(async () => catalogQueue()),
      getChannelPreview: vi.fn(),
    };
    const store = fakeStore([]);
    const service = new InventoryAvailabilityActivationDryRunService(
      backfillReader as never,
      store,
      { now: () => STARTED_AT },
    );

    await expect(service.runDryRun({
      expectedCatalogInputHash: "c".repeat(64),
      expectedCatalogResultHash: HASH_B,
      idempotencyKey: "activation-dry-run-3",
      reason: "Stale queue",
    }, "operator-1")).rejects.toEqual(
      expect.objectContaining<Partial<InventoryAvailabilityActivationDryRunServiceError>>({
        status: 409,
        code: "INVENTORY_AVAILABILITY_CATALOG_PREVIEW_STALE",
      }),
    );
    expect(backfillReader.getChannelPreview).not.toHaveBeenCalled();
    expect(store.captureCurrentPublicationEvidence).not.toHaveBeenCalled();
    expect(store.persistActivationDryRun).not.toHaveBeenCalled();
  });
});

function fakeStore(publication: CurrentPublicationEvidence[]) {
  return {
    captureCurrentPublicationEvidence: vi.fn(async () => publication),
    persistActivationDryRun: vi.fn(async (input: any) => ({
      activationRunId: "7",
      mode: "dry_run" as const,
      scope: "full_catalog" as const,
      state: input.state,
      requestHash: input.requestHash,
      resultHash: input.resultHash,
      catalogInputHash: input.catalogInputHash,
      catalogResultHash: input.catalogResultHash,
      requestedBy: input.requestedBy,
      reason: input.reason,
      startedAt: input.startedAt.toISOString(),
      completedAt: input.completedAt.toISOString(),
      summary: input.summary,
      products: input.products,
      blockers: input.blockers,
      runtimeAuthorityChanged: false as const,
      providerWriteAttempted: false as const,
      outboxEnqueued: false as const,
      alreadyApplied: false,
    })),
  };
}

function sequenceClock(...dates: Date[]) {
  let index = 0;
  return { now: () => dates[Math.min(index++, dates.length - 1)]! };
}

function publicationEvidence(): CurrentPublicationEvidence {
  return {
    channelId: 36,
    productVariantId: 101,
    feedId: 90,
    mappingState: "active",
    channelInventoryItemId: "gid://shopify/InventoryItem/1",
    lastAcknowledgedUnits: "6",
    lastAcknowledgedAt: "2026-08-28T16:00:00.000Z",
    configuredTargets: [{
      publicationTargetId: 1,
      channelConnectionId: 10,
      fulfillmentNodeId: 1,
      warehouseId: 1,
      providerScopeType: "location",
      externalScopeId: "shopify-location-1",
      publicationAuthority: "echelon",
      state: "preview",
      latestReadbackUnits: "6",
      latestReadbackAt: "2026-08-28T16:05:00.000Z",
    }],
  };
}

function catalogQueue(): InventoryAvailabilityBackfillQueueResponse {
  return {
    algorithmVersion: "inventory_availability_backfill_v3",
    capturedAt: "2026-08-28T16:55:00.000Z",
    catalogInputHash: HASH_A,
    catalogResultHash: HASH_B,
    summary: {
      totalActiveProducts: 1,
      blocked: 0,
      excluded: 0,
      notBackfilled: 0,
      conflictingDraft: 0,
      awaitingReview: 0,
      changesRequired: 0,
      approved: 1,
    },
    products: [{
      productId: 10,
      productSku: "PRODUCT",
      productName: "Product",
      legacyInventoryStrategy: "physical_only",
      activeVariantCount: 1,
      activeRecipeCount: 0,
      classification: "exact_only",
      inputHash: HASH_A,
      resultHash: HASH_B,
      candidateDefinitionHash: HASH_A,
      candidateDefinition: { buildToPromiseEnabled: false, paths: [], recipeBindings: [] },
      issues: [],
      queueState: "approved",
      draft: {
        modelId: 501,
        version: 1,
        definitionHash: HASH_A,
        headRevision: "1",
        origin: "phase3_backfill",
        originInputHash: HASH_A,
        originResultHash: HASH_B,
        candidateMatch: true,
      },
      review: {
        reviewId: "1",
        decision: "approved",
        reason: "Reviewed",
        reviewedBy: "operator-1",
        reviewedAt: "2026-08-28T16:30:00.000Z",
        modelId: 501,
        modelVersion: 1,
        modelDefinitionHash: HASH_A,
      },
      latestShadow: {
        runId: "3",
        status: "completed",
        snapshotFingerprint: HASH_B,
        modelDefinitionHash: HASH_A,
        capturedAt: "2026-08-28T16:45:00.000Z",
      },
    }],
  };
}

function channelPreview(): InventoryAvailabilityChannelPreview {
  return {
    productId: 10,
    shadowRunId: "3",
    snapshotFingerprint: HASH_B,
    shadowCapturedAt: "2026-08-28T16:45:00.000Z",
    modelId: 501,
    modelVersion: 1,
    modelDefinitionHash: HASH_A,
    policyAuthority: "legacy_channel_allocation_rules",
    runtimeAuthorityChanged: false,
    providerWriteAttempted: false,
    allocationAuditWritten: false,
    blockers: [],
    rows: [{
      channelId: 36,
      channelName: "Shopify",
      channelProvider: "shopify",
      productVariantId: 101,
      sku: "EA",
      unitsPerVariant: 1,
      warehouseScopeSource: "explicit",
      legacyAtpUnits: "9",
      proposedAtpUnits: "10",
      legacyPublishedUnits: "7",
      proposedPublishedUnits: "8",
      differenceUnits: "1",
      allocationMethod: "share",
      allocationReason: "80 percent",
      warehouseBreakdown: [{ warehouseId: 1, legacyQty: 7, proposedQty: 8 }],
    }],
  };
}
