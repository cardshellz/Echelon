import { describe, expect, it, vi } from "vitest";

import type {
  InventoryAvailabilityBackfillQueueResponse,
  InventoryAvailabilityChannelPreview,
} from "@shared/types/inventory-availability-backfill";
import type { CurrentPublicationEvidence } from "@shared/types/inventory-availability-phase4";
import type {
  InventoryChannelExposureAdminView,
  InventoryChannelExposurePreview,
} from "@shared/types/inventory-channel-exposure";
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
      exposureReader(),
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
      disposition: "publish",
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
      exposureReader(),
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
      exposureReader(),
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

  it("fails closed when provider readback belongs to an older target/SKU identity", async () => {
    const publication = publicationEvidence();
    publication.configuredTargets[0]!.latestReadbackExternalInventoryItemId =
      "gid://shopify/InventoryItem/obsolete";
    const store = fakeStore([publication]);
    const service = new InventoryAvailabilityActivationDryRunService(
      {
        getMigrationQueue: vi.fn(async () => catalogQueue()),
        getChannelPreview: vi.fn(async () => channelPreview()),
      } as never,
      store,
      exposureReader(),
      sequenceClock(STARTED_AT, COMPLETED_AT),
    );

    const result = await service.runDryRun({
      expectedCatalogInputHash: HASH_A,
      expectedCatalogResultHash: HASH_B,
      idempotencyKey: "activation-dry-run-identity-mismatch",
      reason: "Reject readback from obsolete provider identity",
    }, "operator-1");

    expect(result.state).toBe("blocked");
    expect(result.products[0]?.blockers.map((entry) => entry.code))
      .toContain("PROVIDER_READBACK_IDENTITY_MISMATCH");
  });

  it("classifies externally authoritative targets as observation-only", async () => {
    const view = exposureView();
    view.publicationTargets[0]!.publicationAuthority = "external_provider";
    const preview = targetPreview();
    preview.publicationAuthority = "external_provider";
    const publication = publicationEvidence();
    publication.configuredTargets[0]!.publicationAuthority = "external_provider";
    const service = new InventoryAvailabilityActivationDryRunService(
      {
        getMigrationQueue: vi.fn(async () => catalogQueue()),
        getChannelPreview: vi.fn(async () => channelPreview()),
      } as never,
      fakeStore([publication]),
      {
        getView: vi.fn(async () => view),
        preview: vi.fn(async () => preview),
      },
      sequenceClock(STARTED_AT, COMPLETED_AT),
    );

    const result = await service.runDryRun({
      expectedCatalogInputHash: HASH_A,
      expectedCatalogResultHash: HASH_B,
      idempotencyKey: "activation-dry-run-observe-only",
      reason: "Prove externally authoritative target disposition",
    }, "operator-1");

    expect(result.state).toBe("ready_for_publication");
    expect(result.products[0]?.proposedPublications[0]?.disposition).toBe("observe_only");
  });

  it("blocks overlapping partitioned target shares above one hundred percent", async () => {
    const secondTarget = {
      ...exposureView().publicationTargets[0]!,
      id: 2,
      providerScopeType: "account" as const,
      externalScopeId: "shopify-location-2",
    };
    const view = exposureView();
    view.publicationTargets.push(secondTarget);
    const secondPreview = targetPreview();
    secondPreview.publicationTargetId = 2;
    secondPreview.providerScopeType = "account";
    secondPreview.externalScopeId = "shopify-location-2";
    secondPreview.rows[0]!.mapping = {
      ...secondPreview.rows[0]!.mapping!,
      mappingId: 71,
      externalInventoryItemId: "gid://shopify/InventoryItem/2",
    };
    secondPreview.rows[0]!.policy = {
      ...secondPreview.rows[0]!.policy!,
      shareBps: 3_000,
    };
    const reader = {
      getView: vi.fn(async () => view),
      preview: vi.fn(async (targetId: number) => targetId === 1 ? targetPreview() : secondPreview),
    };
    const publication = publicationEvidence();
    publication.configuredTargets.push({
      ...publication.configuredTargets[0]!,
      publicationTargetId: 2,
      externalScopeId: "shopify-location-2",
      mapping: secondPreview.rows[0]!.mapping,
      latestReadbackExternalInventoryItemId: "gid://shopify/InventoryItem/2",
    });
    const service = new InventoryAvailabilityActivationDryRunService(
      {
        getMigrationQueue: vi.fn(async () => catalogQueue()),
        getChannelPreview: vi.fn(async () => channelPreview()),
      } as never,
      fakeStore([publication]),
      reader,
      sequenceClock(STARTED_AT, COMPLETED_AT),
    );

    const result = await service.runDryRun({
      expectedCatalogInputHash: HASH_A,
      expectedCatalogResultHash: HASH_B,
      idempotencyKey: "activation-dry-run-partition-overage",
      reason: "Reject overlapping partition overcommit",
    }, "operator-1");

    expect(result.state).toBe("blocked");
    expect(result.products[0]?.blockers.map((entry) => entry.code))
      .toContain("PARTITIONED_CHANNEL_SHARE_EXCEEDS_SOURCE_CAPACITY");
    expect(result.products[0]?.blockers.map((entry) => entry.code))
      .toContain("PUBLICATION_TARGET_SCOPE_AMBIGUOUS");
  });

  describe.each(["external_provider", "manual"] as const)("%s publication authority", (authority) => {
    it.each(["missing", "stale", "wrong_identity"] as const)(
      "does not require %s Echelon write-verification evidence or imply custody readiness",
      async (readbackState) => {
        const fixture = readinessFixture(authority);
        const target = fixture.publication.configuredTargets[0]!;
        fixture.publication.lastAcknowledgedUnits = null;
        fixture.publication.lastAcknowledgedAt = null;
        if (readbackState === "missing") {
          target.latestReadbackUnits = null;
          target.latestReadbackAt = null;
        } else if (readbackState === "stale") {
          target.latestReadbackAt = "2026-08-27T16:00:00.000Z";
        } else {
          target.latestReadbackExternalInventoryItemId = "obsolete-provider-item";
        }

        const result = await runReadinessFixture(fixture);

        expect(result.state).toBe("ready_for_publication");
        expect(result.products[0]!.blockers).toEqual([expect.objectContaining({
          code: "EXTERNALLY_MANAGED_PUBLICATION_OBSERVE_ONLY",
          severity: "review",
          context: expect.objectContaining({
            publicationAuthority: authority,
            providerWriteVerificationRequired: false,
            externalInventoryCustodyEvaluated: false,
          }),
        })]);
        expect(result.products[0]!.proposedPublications[0]).toMatchObject({
          disposition: "observe_only",
          canonicalAtpUnits: "10",
          desiredUnits: "8",
          differenceFromLastAcknowledgedUnits: null,
        });
        expect(result).toMatchObject({
          runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false,
        });
      },
    );

    it("still requires exact target/SKU mapping", async () => {
      const fixture = readinessFixture(authority);
      fixture.preview.rows[0]!.mapping = null;
      fixture.publication.configuredTargets[0]!.mapping = null;

      const result = await runReadinessFixture(fixture);

      expect(result.state).toBe("blocked");
      expect(result.products[0]!.blockers.map((entry) => entry.code))
        .toContain("EXACT_TARGET_VARIANT_MAPPING_MISSING");
      expect(result.products[0]!.proposedPublications[0]!.disposition).toBe("blocked");
    });

    it.each(["CHANNEL_SOURCE_BINDING_MISSING", "CHANNEL_SOURCE_WAREHOUSE_MISSING_FROM_SHADOW"])(
      "retains the %s source evidence blocker",
      async (code) => {
        const fixture = readinessFixture(authority);
        fixture.preview.blockers.push({ code, message: "Source evidence requires review.", context: {} });
        if (code === "CHANNEL_SOURCE_BINDING_MISSING") {
          fixture.preview.sourceBindingId = null;
          fixture.preview.sourceBindingVersion = null;
          fixture.preview.sourceBindingDefinitionHash = null;
          fixture.preview.sourceBindingAuthority = "missing";
        }

        const result = await runReadinessFixture(fixture);

        expect(result.state).toBe("blocked");
        expect(result.products[0]!.blockers).toContainEqual(expect.objectContaining({ code, severity: "blocking" }));
      },
    );
  });

  it.each(["missing", "stale", "future", "wrong_identity"] as const)(
    "still blocks Echelon publication when provider readback is %s",
    async (readbackState) => {
      const fixture = readinessFixture("echelon");
      const target = fixture.publication.configuredTargets[0]!;
      const expectedCode = readbackState === "missing" ? "PROVIDER_READBACK_MISSING"
        : readbackState === "wrong_identity" ? "PROVIDER_READBACK_IDENTITY_MISMATCH" : "PROVIDER_READBACK_STALE";
      if (readbackState === "missing") target.latestReadbackUnits = null;
      if (readbackState === "stale") target.latestReadbackAt = "2026-08-27T16:00:00.000Z";
      if (readbackState === "future") target.latestReadbackAt = "2026-08-28T17:01:00.000Z";
      if (readbackState === "wrong_identity") target.latestReadbackExternalScopeId = "another-location";

      const result = await runReadinessFixture(fixture);

      expect(result.state).toBe("blocked");
      expect(result.products[0]!.blockers.map((entry) => entry.code)).toContain(expectedCode);
    },
  );

  it("still requires legacy acknowledgement when any enabled target is Echelon-owned", async () => {
    const fixture = readinessFixture("external_provider");
    fixture.publication.lastAcknowledgedUnits = null;
    fixture.publication.configuredTargets.push({
      ...fixture.publication.configuredTargets[0]!, publicationTargetId: 2,
      publicationAuthority: "echelon", externalScopeId: "second-location",
      latestReadbackExternalScopeId: "second-location",
    });

    const result = await runReadinessFixture(fixture);

    expect(result.state).toBe("blocked");
    expect(result.products[0]!.blockers.map((entry) => entry.code))
      .toContain("CURRENT_ACKNOWLEDGED_QUANTITY_MISSING");
  });

  it.each([
    { publicationAuthority: "echelon" as const },
    { providerScopeType: "account" as const },
    { externalScopeId: "another-location" },
    { revision: "2" },
    { channelConnectionId: 11 },
  ])("blocks target drift between catalog selection and preview: %j", async (change) => {
    const fixture = readinessFixture("external_provider");
    Object.assign(fixture.view.publicationTargets[0]!, change);

    const result = await runReadinessFixture(fixture);

    expect(result.state).toBe("blocked");
    expect(result.products[0]!.blockers.map((entry) => entry.code))
      .toContain("PUBLICATION_TARGET_CHANGED_DURING_DRY_RUN");
  });

  it.each([
    { publicationAuthority: "echelon" as const },
    { providerScopeType: "account" as const },
    { externalScopeId: "another-location" },
    { revision: "2" },
    { channelConnectionId: 11 },
    { state: "live" as const },
  ])("blocks target drift after an external preview: %j", async (change) => {
    const fixture = readinessFixture("external_provider");
    Object.assign(fixture.publication.configuredTargets[0]!, change);

    const result = await runReadinessFixture(fixture);

    expect(result.state).toBe("blocked");
    expect(result.products[0]!.blockers.map((entry) => entry.code))
      .toContain("PUBLICATION_TARGET_CHANGED_DURING_DRY_RUN");
  });

  it.each([
    { mappingId: 71 }, { version: 2 }, { definitionHash: HASH_B },
    { authority: "active" as const }, { externalInventoryItemId: "another-item" }, { externalSku: "ANOTHER-SKU" },
  ])("blocks exact mapping drift without relying on an external readback: %j", async (change) => {
    const fixture = readinessFixture("external_provider");
    Object.assign(fixture.publication.configuredTargets[0]!.mapping!, change);

    const result = await runReadinessFixture(fixture);

    expect(result.state).toBe("blocked");
    expect(result.products[0]!.blockers.map((entry) => entry.code))
      .toContain("PUBLICATION_VARIANT_MAPPING_CHANGED_DURING_DRY_RUN");
  });
});

function readinessFixture(authority: "echelon" | "external_provider" | "manual") {
  const view = exposureView();
  const preview = targetPreview();
  const publication = publicationEvidence();
  view.publicationTargets[0]!.publicationAuthority = authority;
  preview.publicationAuthority = authority;
  publication.configuredTargets[0]!.publicationAuthority = authority;
  return { view, preview, publication };
}

async function runReadinessFixture(fixture: ReturnType<typeof readinessFixture>) {
  const service = new InventoryAvailabilityActivationDryRunService({
    getMigrationQueue: vi.fn(async () => catalogQueue()),
    getChannelPreview: vi.fn(async () => channelPreview()),
  } as never, fakeStore([fixture.publication]), {
    getView: vi.fn(async () => fixture.view),
    preview: vi.fn(async () => fixture.preview),
  }, sequenceClock(STARTED_AT, COMPLETED_AT));
  return service.runDryRun({
    expectedCatalogInputHash: HASH_A, expectedCatalogResultHash: HASH_B,
    idempotencyKey: "authority-readiness-regression", reason: "Verify authority-scoped evidence",
  }, "operator-1");
}

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
      destinationKind: "channel_connection",
      channelConnectionId: 10,
      dropshipStoreConnectionId: null,
      fulfillmentNodeId: 1,
      warehouseId: 1,
      providerScopeType: "location",
      externalScopeId: "shopify-location-1",
      publicationAuthority: "echelon",
      state: "preview",
      revision: "1",
      mapping: {
        mappingId: 70,
        version: 1,
        definitionHash: HASH_A,
        authority: "draft",
        externalInventoryItemId: "gid://shopify/InventoryItem/1",
        externalSku: "EA",
      },
      latestReadbackUnits: "6",
      latestReadbackAt: "2026-08-28T16:59:00.000Z",
      latestReadbackExternalInventoryItemId: "gid://shopify/InventoryItem/1",
      latestReadbackDestinationKind: "channel_connection",
      latestReadbackChannelConnectionId: 10,
      latestReadbackDropshipStoreConnectionId: null,
      latestReadbackProviderScopeType: "location",
      latestReadbackExternalScopeId: "shopify-location-1",
      latestReadbackPublicationTargetRevision: "1",
    }],
  };
}

function exposureReader() {
  return {
    getView: vi.fn(async () => exposureView()),
    preview: vi.fn(async () => targetPreview()),
  };
}

function exposureView(): InventoryChannelExposureAdminView {
  return {
    products: [],
    selectedProduct: null,
    channels: [{
      id: 36,
      name: "Shopify",
      provider: "shopify",
      status: "active",
      connections: [{ id: 10, externalAccountLabel: "store.myshopify.com" }],
    }],
    dropshipStores: [],
    publicationTargets: [{
      id: 1,
      destinationKind: "channel_connection",
      channelId: 36,
      channelConnectionId: 10,
      dropshipStoreConnectionId: null,
      legacyFulfillmentNodeId: 1,
      providerScopeType: "location",
      externalScopeId: "shopify-location-1",
      publicationAuthority: "echelon",
      state: "preview",
      revision: "1",
    }],
    fulfillmentNodes: [],
    policyHeads: [],
    sourceBindingHeads: [],
    variantMappingHeads: [],
    legacyMappingCandidates: [],
    runtimeAuthority: "legacy_channel_allocation_rules",
    providerWriteEnabled: false,
  };
}

function targetPreview(): InventoryChannelExposurePreview {
  return {
    publicationTargetId: 1,
    destinationKind: "channel_connection",
    channelId: 36,
    channelConnectionId: 10,
    dropshipStoreConnectionId: null,
    providerScopeType: "location",
    externalScopeId: "shopify-location-1",
    publicationAuthority: "echelon",
    publicationTargetState: "preview",
    publicationTargetRevision: "1",
    productId: 10,
    shadowRunId: "3",
    snapshotFingerprint: HASH_B,
    shadowCapturedAt: "2026-08-28T16:45:00.000Z",
    modelId: 501,
    modelVersion: 1,
    modelDefinitionHash: HASH_A,
    sourceBindingId: 60,
    sourceBindingVersion: 1,
    sourceBindingDefinitionHash: HASH_B,
    sourceBindingAuthority: "draft",
    fulfillmentNodeIds: [1],
    warehouseIds: [1],
    selectedPolicies: [{
      scopeKey: "channel:36",
      policyId: 50,
      version: 1,
      definitionHash: HASH_A,
      authority: "draft",
    }],
    rows: [{
      productVariantId: 101,
      sku: "EA",
      unitsPerVariant: 1,
      canonicalAtpUnits: "10",
      sharedUnits: "8",
      afterHoldbackUnits: "8",
      cappedUnits: "8",
      publishedUnits: "8",
      sourceWarehouseBreakdown: [{ warehouseId: 1, canonicalAtpUnits: "10" }],
      policy: {
        allocationSemantics: "partitioned",
        eligible: true,
        shareBps: 8_000,
        holdbackSellableUnits: "0",
        maxPublishSellableUnits: null,
        minPublishSellableUnits: "0",
        sources: {
          allocationSemantics: "channel:36",
          eligible: "channel:36",
          shareBps: "channel:36",
          holdbackSellableUnits: "channel:36",
          maxPublishSellableUnits: "channel:36",
          minPublishSellableUnits: "channel:36",
        },
      },
      mapping: {
        mappingId: 70,
        version: 1,
        definitionHash: HASH_A,
        authority: "draft",
        externalInventoryItemId: "gid://shopify/InventoryItem/1",
        externalSku: "EA",
      },
    }],
    blockers: [],
    runtimeAuthorityChanged: false,
    providerWriteAttempted: false,
    outboxEnqueued: false,
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
