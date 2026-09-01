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

function fakeStore() {
  return {
    getAdminView: vi.fn<InventoryChannelExposureAdminStore["getAdminView"]>(),
    savePolicyDraft: vi.fn<InventoryChannelExposureAdminStore["savePolicyDraft"]>(),
    saveSourceBindingDraft: vi.fn<InventoryChannelExposureAdminStore["saveSourceBindingDraft"]>(),
    preview: vi.fn<InventoryChannelExposureAdminStore["preview"]>(),
  };
}
