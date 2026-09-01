import { beforeEach, describe, expect, it, vi } from "vitest";

import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { InventoryPublicationConfigurationError } from "../../../channels/channel-adapter.interface";
import type { ClaimedInventoryPublication } from "../../infrastructure/inventory-publication-outbox.repository";

const NOW = new Date("2026-09-01T18:00:00.000Z");

describe("InventoryPublicationOutboxService", () => {
  let store: {
    claimDue: ReturnType<typeof vi.fn>;
    recordVerified: ReturnType<typeof vi.fn>;
    recordFailure: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    store = {
      claimDue: vi.fn(async () => [claim()]),
      recordVerified: vi.fn(async () => "verified" as const),
      recordFailure: vi.fn(async () => true),
    };
  });

  it("publishes and reads back through the exact immutable target context", async () => {
    const adapter = {
      inventoryPublicationScopeTypes: ["location"] as const,
      pushInventory: vi.fn(async () => [{ variantId: 101, pushedQty: 7, status: "success" as const }]),
      readInventory: vi.fn(async () => [{ variantId: 101, observedQty: 7, status: "success" as const }]),
    };
    const service = new InventoryPublicationOutboxService(
      store,
      { get: vi.fn(() => adapter as any) },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({ claimed: 1, verified: 1, failed: 0 });
    expect(adapter.pushInventory).toHaveBeenCalledWith(3, [{
      variantId: 101,
      sku: "SKU-101",
      externalVariantId: null,
      externalInventoryItemId: "inventory-item-101",
      allocatedQty: 7,
    }], {
      authority: "canonical_outbox",
      channelConnectionId: 33,
      providerScopeType: "location",
      externalScopeId: "location-9",
    });
    expect(store.recordVerified).toHaveBeenCalledWith(
      expect.objectContaining({ outboxId: "41" }),
      expect.objectContaining({ observedQuantity: 7, completedAt: NOW }),
    );
    expect(store.recordFailure).not.toHaveBeenCalled();
  });

  it("keeps provider readback drift retryable instead of reporting verification", async () => {
    store.recordVerified.mockResolvedValueOnce("drifted");
    const adapter = {
      inventoryPublicationScopeTypes: ["location"] as const,
      pushInventory: vi.fn(async () => [{ variantId: 101, pushedQty: 7, status: "success" as const }]),
      readInventory: vi.fn(async () => [{ variantId: 101, observedQty: 6, status: "success" as const }]),
    };
    const service = new InventoryPublicationOutboxService(
      store,
      { get: () => adapter as any },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({ claimed: 1, verified: 0, failed: 1 });
    expect(store.recordFailure).not.toHaveBeenCalled();
  });

  it("dead-letters an unsupported adapter without attempting a provider call", async () => {
    const service = new InventoryPublicationOutboxService(
      store,
      { get: () => undefined },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({ claimed: 1, verified: 0, failed: 1 });
    expect(store.recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        errorClass: "PUBLICATION_ADAPTER_MISSING",
        retryable: false,
      }),
    );
  });

  it("dead-letters a provider scope the adapter cannot address exactly", async () => {
    const adapter = {
      inventoryPublicationScopeTypes: ["account"] as const,
      pushInventory: vi.fn(),
      readInventory: vi.fn(),
    };
    const service = new InventoryPublicationOutboxService(
      store,
      { get: () => adapter as any },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({ claimed: 1, verified: 0, failed: 1 });
    expect(adapter.pushInventory).not.toHaveBeenCalled();
    expect(store.recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorClass: "PUBLICATION_SCOPE_UNSUPPORTED", retryable: false }),
    );
  });

  it("dead-letters deterministic adapter configuration errors without retrying", async () => {
    const adapter = {
      inventoryPublicationScopeTypes: ["location"] as const,
      pushInventory: vi.fn(async () => {
        throw new InventoryPublicationConfigurationError(
          "EXACT_CONNECTION_AMBIGUOUS",
          "The provider account cannot be identified exactly.",
        );
      }),
      readInventory: vi.fn(),
    };
    const service = new InventoryPublicationOutboxService(
      store,
      { get: () => adapter as any },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({ claimed: 1, verified: 0, failed: 1 });
    expect(store.recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorClass: "EXACT_CONNECTION_AMBIGUOUS", retryable: false }),
    );
  });
});

function claim(): ClaimedInventoryPublication {
  return {
    outboxId: "41",
    activationRunId: "12",
    publicationPhase: "conservative",
    publicationTargetId: 9,
    publicationTargetRevision: "4",
    productVariantId: 101,
    desiredRevision: "2",
    desiredQuantity: "7",
    channelId: 3,
    channelConnectionId: 33,
    providerKey: "shopify",
    providerScopeType: "location",
    externalScopeId: "location-9",
    externalInventoryItemId: "inventory-item-101",
    externalSku: "SKU-101",
    leaseToken: "lease-1",
    attemptNumber: 1,
    attemptStartedAt: NOW,
  };
}
