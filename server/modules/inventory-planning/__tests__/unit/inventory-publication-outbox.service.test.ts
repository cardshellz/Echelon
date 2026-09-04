import { beforeEach, describe, expect, it, vi } from "vitest";

import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { InventoryPublicationTransportConfigurationError } from "../../application/inventory-publication-transport";
import type { ClaimedInventoryPublication } from "../../infrastructure/inventory-publication-outbox.repository";

const NOW = new Date("2026-09-01T18:00:00.000Z");

describe("InventoryPublicationOutboxService", () => {
  let store: {
    claimDue: ReturnType<typeof vi.fn>;
    runIfCurrent: ReturnType<typeof vi.fn>;
    recordVerified: ReturnType<typeof vi.fn>;
    recordFailure: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    store = {
      claimDue: vi.fn(async () => [claim()]),
      runIfCurrent: vi.fn(async (_claim, work) => ({ status: "current" as const, value: await work() })),
      recordVerified: vi.fn(async () => "verified" as const),
      recordFailure: vi.fn(async () => true),
    };
  });

  it("publishes and reads back through the exact immutable target context", async () => {
    const adapter = {
      supportedScopeTypes: ["location"] as const,
      publishAbsolute: vi.fn(async () => ({ publishedQuantity: 7, providerResponse: { status: 200 } })),
      readAbsolute: vi.fn(async () => ({ observedQuantity: 7, providerResponse: { status: 200 } })),
    };
    const service = new InventoryPublicationOutboxService(
      store,
      { get: vi.fn(() => adapter as any) },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1, verified: 1, failed: 0, superseded: 0,
    });
    expect(adapter.publishAbsolute).toHaveBeenCalledWith({
      destination: {
        kind: "channel_connection",
        channelConnectionId: 33,
        dropshipStoreConnectionId: null,
      },
      channelId: 3,
      providerScopeType: "location",
      externalScopeId: "location-9",
      productVariantId: 101,
      externalInventoryItemId: "inventory-item-101",
      externalSku: "SKU-101",
      desiredQuantity: 7,
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
      supportedScopeTypes: ["location"] as const,
      publishAbsolute: vi.fn(async () => ({ publishedQuantity: 7, providerResponse: {} })),
      readAbsolute: vi.fn(async () => ({ observedQuantity: 6, providerResponse: {} })),
    };
    const service = new InventoryPublicationOutboxService(
      store,
      { get: () => adapter as any },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1, verified: 0, failed: 1, superseded: 0,
    });
    expect(store.recordFailure).not.toHaveBeenCalled();
  });

  it("dead-letters an unsupported adapter without attempting a provider call", async () => {
    const service = new InventoryPublicationOutboxService(
      store,
      { get: () => undefined },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1, verified: 0, failed: 1, superseded: 0,
    });
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
      supportedScopeTypes: ["account"] as const,
      publishAbsolute: vi.fn(),
      readAbsolute: vi.fn(),
    };
    const service = new InventoryPublicationOutboxService(
      store,
      { get: () => adapter as any },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1, verified: 0, failed: 1, superseded: 0,
    });
    expect(adapter.publishAbsolute).not.toHaveBeenCalled();
    expect(store.recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorClass: "PUBLICATION_SCOPE_UNSUPPORTED", retryable: false }),
    );
  });

  it("dead-letters deterministic adapter configuration errors without retrying", async () => {
    const adapter = {
      supportedScopeTypes: ["location"] as const,
      publishAbsolute: vi.fn(async () => {
        throw new InventoryPublicationTransportConfigurationError(
          "EXACT_CONNECTION_AMBIGUOUS",
          "The provider account cannot be identified exactly.",
        );
      }),
      readAbsolute: vi.fn(),
    };
    const service = new InventoryPublicationOutboxService(
      store,
      { get: () => adapter as any },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1, verified: 0, failed: 1, superseded: 0,
    });
    expect(store.recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorClass: "EXACT_CONNECTION_AMBIGUOUS", retryable: false }),
    );
  });

  it("publishes a Dropship-owned claim through its exact store adapter", async () => {
    const dropshipClaim: ClaimedInventoryPublication = {
      ...claim(),
      destinationKind: "dropship_store_connection",
      channelConnectionId: null,
      dropshipStoreConnectionId: 77,
      providerKey: "ebay",
      providerScopeType: "account",
      externalScopeId: "seller-account-1",
    };
    store.claimDue.mockResolvedValueOnce([dropshipClaim]);
    const adapter = {
      supportedScopeTypes: ["account"] as const,
      publishAbsolute: vi.fn(async () => ({ publishedQuantity: 7, providerResponse: {} })),
      readAbsolute: vi.fn(async () => ({ observedQuantity: 7, providerResponse: {} })),
    };
    const get = vi.fn(() => adapter as any);
    const service = new InventoryPublicationOutboxService(
      store,
      { get },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1, verified: 1, failed: 0, superseded: 0,
    });
    expect(get).toHaveBeenCalledWith("dropship_store_connection", "ebay");
    expect(adapter.publishAbsolute).toHaveBeenCalledWith(expect.objectContaining({
      destination: {
        kind: "dropship_store_connection",
        channelConnectionId: null,
        dropshipStoreConnectionId: 77,
      },
      desiredQuantity: 7,
    }));
  });

  it("dead-letters a malformed destination owner without calling the provider", async () => {
    store.claimDue.mockResolvedValueOnce([{
      ...claim(),
      channelConnectionId: null,
    }]);
    const adapter = {
      supportedScopeTypes: ["location"] as const,
      publishAbsolute: vi.fn(),
      readAbsolute: vi.fn(),
    };
    const service = new InventoryPublicationOutboxService(
      store,
      { get: () => adapter as any },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1, verified: 0, failed: 1, superseded: 0,
    });
    expect(adapter.publishAbsolute).not.toHaveBeenCalled();
    expect(store.recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        errorClass: "PUBLICATION_DESTINATION_INVALID",
        retryable: false,
      }),
    );
  });

  it("skips a claimed revision that became stale before the provider call", async () => {
    store.runIfCurrent.mockResolvedValueOnce({ status: "superseded" });
    const adapter = {
      supportedScopeTypes: ["location"] as const,
      publishAbsolute: vi.fn(),
      readAbsolute: vi.fn(),
    };
    const service = new InventoryPublicationOutboxService(
      store,
      { get: () => adapter as any },
      { now: () => NOW },
      () => "lease-1",
    );

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1, verified: 0, failed: 0, superseded: 1,
    });
    expect(adapter.publishAbsolute).not.toHaveBeenCalled();
    expect(store.recordFailure).not.toHaveBeenCalled();
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
    destinationKind: "channel_connection",
    channelConnectionId: 33,
    dropshipStoreConnectionId: null,
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
