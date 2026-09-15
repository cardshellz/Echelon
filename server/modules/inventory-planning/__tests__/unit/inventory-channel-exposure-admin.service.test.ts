import { describe, expect, it, vi } from "vitest";

import {
  InventoryChannelExposureAdminService,
  type InventoryChannelExposureAdminStore,
} from "../../application/inventory-channel-exposure-admin.service";

const NOW = new Date("2026-09-01T16:00:00.000Z");
const HASH = "a".repeat(64);

describe("InventoryChannelExposureAdminService", () => {
  it("builds a deterministic, actor-attributed policy draft command", async () => {
    const store = fakeStore();
    store.savePolicyDraft.mockResolvedValue(saveResult());
    const service = new InventoryChannelExposureAdminService(store, { now: () => NOW });
    const request = {
      scope: { scopeType: "variant" as const, channelId: 3, productId: 5, productVariantId: 7 },
      value: {
        allocationSemantics: "partitioned" as const,
        eligible: true,
        shareBps: 2_500,
        holdbackSellableUnits: "2",
        maxPublish: { mode: "units" as const, units: "40" },
        minPublishSellableUnits: "3",
      },
      expectedHeadRevision: "4",
      expectedDraftPolicyId: 9,
      expectedDraftDefinitionHash: HASH,
      changeReason: "Bound marketplace exposure",
      idempotencyKey: "channel-policy-1",
    };

    await service.savePolicyDraft(request, "operator-1");

    expect(store.savePolicyDraft).toHaveBeenCalledWith({
      ...request,
      actorId: "operator-1",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      occurredAt: NOW,
    });
  });

  it("builds a canonically ordered exact-node source-binding command", async () => {
    const store = fakeStore();
    store.saveSourceBindingDraft.mockResolvedValue(saveResult());
    const service = new InventoryChannelExposureAdminService(store, { now: () => NOW });

    await service.saveSourceBindingDraft({
      publicationTargetId: 12,
      fulfillmentNodeIds: [8, 4],
      expectedHeadRevision: "0",
      expectedDraftBindingId: null,
      expectedDraftDefinitionHash: null,
      changeReason: "Primary then 3PL",
      idempotencyKey: "source-binding-1",
    }, "operator-1");

    expect(store.saveSourceBindingDraft).toHaveBeenCalledWith(expect.objectContaining({
      publicationTargetId: 12,
      fulfillmentNodeIds: [4, 8],
      actorId: "operator-1",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      occurredAt: NOW,
    }));
  });

  it("builds audited target, preview-state, and exact mapping commands", async () => {
    const store = fakeStore();
    store.createPublicationTarget.mockResolvedValue(targetResult());
    store.setPublicationTargetPreviewState.mockResolvedValue(targetResult("preview", "2"));
    store.saveVariantMappingDraft.mockResolvedValue(saveResult());
    const service = new InventoryChannelExposureAdminService(store, { now: () => NOW });

    const targetRequest = {
      channelId: 36,
      channelConnectionId: 44,
      legacyFulfillmentNodeId: 1,
      providerScopeType: "location" as const,
      externalScopeId: "location-1",
      publicationAuthority: "echelon" as const,
      changeReason: "Register exact destination",
      idempotencyKey: "target-1",
    };
    await service.createPublicationTarget(targetRequest, "operator-1");
    expect(store.createPublicationTarget).toHaveBeenCalledWith({
      ...targetRequest,
      destinationKind: "channel_connection",
      dropshipStoreConnectionId: null,
      actorId: "operator-1",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      occurredAt: NOW,
    });

    const stateRequest = {
      publicationTargetId: 5,
      expectedRevision: "1",
      state: "preview" as const,
      changeReason: "Include in readiness evidence",
      idempotencyKey: "target-state-1",
    };
    await service.setPublicationTargetPreviewState(stateRequest, "operator-1");
    expect(store.setPublicationTargetPreviewState).toHaveBeenCalledWith({
      ...stateRequest,
      actorId: "operator-1",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      occurredAt: NOW,
    });

    const mappingRequest = {
      publicationTargetId: 5,
      productVariantId: 101,
      externalInventoryItemId: "inventory-item-1",
      externalSku: "EA",
      expectedHeadRevision: "0",
      expectedDraftMappingId: null,
      expectedDraftDefinitionHash: null,
      changeReason: "Map exact target inventory item",
      idempotencyKey: "mapping-1",
    };
    await service.saveVariantMappingDraft(mappingRequest, "operator-1");
    expect(store.saveVariantMappingDraft).toHaveBeenCalledWith({
      ...mappingRequest,
      actorId: "operator-1",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      occurredAt: NOW,
    });
  });

  it("treats the routine draft note as optional and never fabricates one", async () => {
    const store = fakeStore();
    store.savePolicyDraft.mockResolvedValue(saveResult());
    store.saveVariantMappingDraft.mockResolvedValue(saveResult());
    store.createPublicationTarget.mockResolvedValue(targetResult());
    const service = new InventoryChannelExposureAdminService(store, { now: () => NOW });

    await service.savePolicyDraft({
      scope: { scopeType: "channel", channelId: 3 },
      value: {
        allocationSemantics: "exposure",
        eligible: true,
        shareBps: 5_000,
        holdbackSellableUnits: "0",
        maxPublish: { mode: "unlimited" },
        minPublishSellableUnits: "0",
      },
      expectedHeadRevision: "0",
      expectedDraftPolicyId: null,
      expectedDraftDefinitionHash: null,
      idempotencyKey: "channel-policy-no-note",
    }, "operator-1");
    expect(store.savePolicyDraft).toHaveBeenCalledWith(expect.objectContaining({
      changeReason: null,
      actorId: "operator-1",
      occurredAt: NOW,
    }));

    await service.saveVariantMappingDraft({
      publicationTargetId: 5,
      productVariantId: 101,
      externalInventoryItemId: "inventory-item-1",
      externalSku: null,
      expectedHeadRevision: "0",
      expectedDraftMappingId: null,
      expectedDraftDefinitionHash: null,
      changeReason: "  \n ",
      idempotencyKey: "mapping-blank-note",
    }, "operator-1");
    expect(store.saveVariantMappingDraft).toHaveBeenCalledWith(expect.objectContaining({
      changeReason: null,
    }));

    await service.createPublicationTarget({
      channelId: 36,
      channelConnectionId: 44,
      legacyFulfillmentNodeId: 1,
      providerScopeType: "location",
      externalScopeId: "location-1",
      publicationAuthority: "echelon",
      idempotencyKey: "target-no-note",
    }, "operator-1");
    expect(store.createPublicationTarget).toHaveBeenCalledWith(expect.objectContaining({
      changeReason: null,
      destinationKind: "channel_connection",
    }));
  });

  it("keeps the required reason on the sensitive readiness-preview command", async () => {
    const store = fakeStore();
    const service = new InventoryChannelExposureAdminService(store, { now: () => NOW });
    await expect(service.setPublicationTargetPreviewState({
      publicationTargetId: 5,
      expectedRevision: "1",
      state: "preview",
      changeReason: "",
      idempotencyKey: "target-state-blank",
    }, "operator-1")).rejects.toMatchObject({
      code: "INVENTORY_CHANNEL_EXPOSURE_INVALID_TARGET_PREVIEW_STATE",
    });
    expect(store.setPublicationTargetPreviewState).not.toHaveBeenCalled();
  });

  it("rejects empty policies and duplicate source nodes before persistence", async () => {
    const store = fakeStore();
    const service = new InventoryChannelExposureAdminService(store, { now: () => NOW });
    await expect(service.savePolicyDraft({
      scope: { scopeType: "channel", channelId: 3 },
      value: {
        allocationSemantics: null,
        eligible: null,
        shareBps: null,
        holdbackSellableUnits: null,
        maxPublish: null,
        minPublishSellableUnits: null,
      },
      expectedHeadRevision: "0",
      expectedDraftPolicyId: null,
      expectedDraftDefinitionHash: null,
      changeReason: "Invalid empty policy",
      idempotencyKey: "empty-policy",
    }, "operator-1")).rejects.toMatchObject({
      code: "INVENTORY_CHANNEL_EXPOSURE_INVALID_POLICY_DRAFT",
    });
    await expect(service.saveSourceBindingDraft({
      publicationTargetId: 12,
      fulfillmentNodeIds: [8, 8],
      expectedHeadRevision: "0",
      expectedDraftBindingId: null,
      expectedDraftDefinitionHash: null,
      changeReason: "Invalid duplicate",
      idempotencyKey: "duplicate-source",
    }, "operator-1")).rejects.toMatchObject({
      code: "INVENTORY_CHANNEL_EXPOSURE_INVALID_SOURCE_BINDING",
    });
    expect(store.savePolicyDraft).not.toHaveBeenCalled();
    expect(store.saveSourceBindingDraft).not.toHaveBeenCalled();
  });

  describe("channel destination setup", () => {
    function setupResult(overrides: Record<string, unknown> = {}) {
      return {
        channelId: 7,
        created: [],
        skipped: [],
        alreadyApplied: false,
        runtimeAuthorityChanged: false as const,
        providerWriteAttempted: false as const,
        outboxEnqueued: false as const,
        ...overrides,
      };
    }

    const request = {
      channelId: 7,
      supplyFulfillmentNodeIds: [7, 8],
      publicationAuthority: "echelon" as const,
      changeReason: null,
      idempotencyKey: "setup-1",
    };

    it("includes dropship storefronts only for the resolved internal dropship channel", async () => {
      const store = fakeStore();
      store.setUpChannelDestinations.mockResolvedValue(setupResult());
      const service = new InventoryChannelExposureAdminService(store, { now: () => NOW }, {
        resolveChannelId: async () => 7,
      });

      await service.setUpChannelDestinations(request, "operator-1");

      expect(store.setUpChannelDestinations).toHaveBeenCalledWith(
        expect.objectContaining({ includeDropshipStores: true, actorId: "operator-1", occurredAt: NOW }),
      );
    });

    // A storefront registered against a marketplace channel would carry a
    // channel_id that contradicts how dropship quantities are planned.
    it("excludes dropship storefronts for any other channel", async () => {
      const store = fakeStore();
      store.setUpChannelDestinations.mockResolvedValue(setupResult({ channelId: 3 }));
      const service = new InventoryChannelExposureAdminService(store, { now: () => NOW }, {
        resolveChannelId: async () => 7,
      });

      await service.setUpChannelDestinations({ ...request, channelId: 3 }, "operator-1");

      expect(store.setUpChannelDestinations).toHaveBeenCalledWith(
        expect.objectContaining({ includeDropshipStores: false }),
      );
    });

    it("excludes dropship storefronts when the dropship channel cannot be resolved", async () => {
      const store = fakeStore();
      store.setUpChannelDestinations.mockResolvedValue(setupResult());
      const service = new InventoryChannelExposureAdminService(store, { now: () => NOW }, {
        resolveChannelId: async () => { throw new Error("unconfigured"); },
      });

      await service.setUpChannelDestinations(request, "operator-1");

      expect(store.setUpChannelDestinations).toHaveBeenCalledWith(
        expect.objectContaining({ includeDropshipStores: false }),
      );
    });

    // The hash must separate two otherwise identical requests that differ only
    // in dropship scope, so one cannot replay the other's receipt.
    it("binds the dropship scope into the request hash", async () => {
      const hashes: string[] = [];
      for (const dropshipChannelId of [7, 3]) {
        const store = fakeStore();
        store.setUpChannelDestinations.mockResolvedValue(setupResult());
        const service = new InventoryChannelExposureAdminService(store, { now: () => NOW }, {
          resolveChannelId: async () => dropshipChannelId,
        });
        await service.setUpChannelDestinations(request, "operator-1");
        hashes.push(store.setUpChannelDestinations.mock.calls[0]![0].requestHash);
      }
      expect(hashes[0]).not.toBe(hashes[1]);
    });

    it("refuses duplicate supply warehouses instead of creating a skewed binding", async () => {
      const store = fakeStore();
      const service = new InventoryChannelExposureAdminService(store, { now: () => NOW });

      await expect(service.setUpChannelDestinations(
        { ...request, supplyFulfillmentNodeIds: [7, 7] },
        "operator-1",
      )).rejects.toMatchObject({ code: "INVENTORY_CHANNEL_EXPOSURE_INVALID_DESTINATION_SETUP" });
      expect(store.setUpChannelDestinations).not.toHaveBeenCalled();
    });

    it("refuses setup with no supply warehouse at all", async () => {
      const store = fakeStore();
      const service = new InventoryChannelExposureAdminService(store, { now: () => NOW });

      await expect(service.setUpChannelDestinations(
        { ...request, supplyFulfillmentNodeIds: [] },
        "operator-1",
      )).rejects.toMatchObject({ code: "INVENTORY_CHANNEL_EXPOSURE_INVALID_DESTINATION_SETUP" });
      expect(store.setUpChannelDestinations).not.toHaveBeenCalled();
    });
  });

  describe("internal dropship channel on the view", () => {
    /** Minimal store view: every collection empty so the composed field is the only variable. */
    function emptyStoreView() {
      return {
        products: [], selectedProduct: null, channels: [], dropshipStores: [], publicationTargets: [],
        fulfillmentNodes: [], policyHeads: [], policySubjects: [], sourceBindingHeads: [],
        variantMappingHeads: [], legacyMappingCandidates: [],
        runtimeAuthority: "legacy" as const, runtimeAuthorityRevision: "1",
        providerWriteEnabled: false as const,
      };
    }

    it("reports the channel the dropship module resolves", async () => {
      const store = fakeStore();
      store.getAdminView.mockResolvedValue(emptyStoreView());
      const service = new InventoryChannelExposureAdminService(store, { now: () => NOW }, {
        resolveChannelId: async () => 7,
      });

      await expect(service.getView(null)).resolves.toMatchObject({ dropshipDestinationChannelId: 7 });
    });

    // A missing or ambiguous dropship channel must not take down setup for every
    // other channel; it is reported as absent so no storefront can be registered.
    it("degrades to null when the dropship channel cannot be resolved", async () => {
      const store = fakeStore();
      store.getAdminView.mockResolvedValue(emptyStoreView());
      const service = new InventoryChannelExposureAdminService(store, { now: () => NOW }, {
        resolveChannelId: async () => {
          throw Object.assign(new Error("ambiguous"), { code: "DROPSHIP_OMS_CHANNEL_CONFIG_AMBIGUOUS" });
        },
      });

      await expect(service.getView(null)).resolves.toMatchObject({ dropshipDestinationChannelId: null });
    });

    it("reports null when no resolver is wired at all", async () => {
      const store = fakeStore();
      store.getAdminView.mockResolvedValue(emptyStoreView());
      const service = new InventoryChannelExposureAdminService(store, { now: () => NOW });

      await expect(service.getView(null)).resolves.toMatchObject({ dropshipDestinationChannelId: null });
    });
  });
});

function saveResult() {
  return {
    definitionId: 9,
    version: 1,
    definitionHash: HASH,
    headRevision: "1",
    alreadyApplied: false,
    runtimeAuthorityChanged: false as const,
    providerWriteAttempted: false as const,
  };
}

function targetResult(state: "disabled" | "preview" = "disabled", revision = "1") {
  return {
    publicationTargetId: 5,
    revision,
    state,
    alreadyApplied: false,
    runtimeAuthorityChanged: false as const,
    providerWriteAttempted: false as const,
    outboxEnqueued: false as const,
  };
}

function fakeStore() {
  return {
    getAdminView: vi.fn<InventoryChannelExposureAdminStore["getAdminView"]>(),
    savePolicyDraft: vi.fn<InventoryChannelExposureAdminStore["savePolicyDraft"]>(),
    saveSourceBindingDraft: vi.fn<InventoryChannelExposureAdminStore["saveSourceBindingDraft"]>(),
    createPublicationTarget: vi.fn<InventoryChannelExposureAdminStore["createPublicationTarget"]>(),
    setPublicationTargetPreviewState:
      vi.fn<InventoryChannelExposureAdminStore["setPublicationTargetPreviewState"]>(),
    saveVariantMappingDraft: vi.fn<InventoryChannelExposureAdminStore["saveVariantMappingDraft"]>(),
    setUpChannelDestinations: vi.fn<InventoryChannelExposureAdminStore["setUpChannelDestinations"]>(),
    preview: vi.fn<InventoryChannelExposureAdminStore["preview"]>(),
  };
}
