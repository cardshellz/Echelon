import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  InventoryPublicationReadbackService,
  type PublicationReadbackTarget,
} from "../../application/inventory-publication-readback.service";

const NOW = new Date("2026-09-01T18:00:00.000Z");

describe("InventoryPublicationReadbackService", () => {
  let store: {
    begin: ReturnType<typeof vi.fn>;
    recordObserved: ReturnType<typeof vi.fn>;
    recordFailure: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    store = {
      begin: vi.fn(async () => ({ kind: "started" as const, readbackRunId: "5", targets: [target()] })),
      recordObserved: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
      complete: vi.fn(async (input) => result({
        targetRows: input.targetRows,
        observedRows: input.targetRows - input.failures.length,
        failedRows: input.failures.length,
        failures: input.failures,
        state: input.failures.length === 0 ? "completed" : "partial",
      })),
    };
  });

  it("captures an authoritative observation with exact connection and scope identity", async () => {
    const adapter = {
      supportedScopeTypes: ["location"] as const,
      readAbsolute: vi.fn(async () => ({ observedQuantity: 8, providerResponse: { status: 200 } })),
    };
    const service = new InventoryPublicationReadbackService(
      store,
      { get: () => adapter as any },
      { now: () => NOW },
    );

    await expect(service.capture(request(), "operator-1")).resolves.toEqual(result({}));
    expect(adapter.readAbsolute).toHaveBeenCalledWith({
      destination: {
        kind: "channel_connection",
        channelConnectionId: 33,
        dropshipStoreConnectionId: null,
      },
      channelId: 3,
      productVariantId: 101,
      externalSku: "SKU-101",
      externalInventoryItemId: "inventory-item-101",
      providerScopeType: "location",
      externalScopeId: "location-9",
    });
    expect(store.recordObserved).toHaveBeenCalledWith("5", target(), 8, NOW);
  });

  it("records target-scoped failures and completes a partial run", async () => {
    const service = new InventoryPublicationReadbackService(
      store,
      { get: () => undefined },
      { now: () => NOW },
    );

    const captured = await service.capture(request(), "operator-1");
    expect(captured.state).toBe("partial");
    expect(captured.failedRows).toBe(1);
    expect(store.recordFailure).toHaveBeenCalledWith(
      "5",
      target(),
      expect.objectContaining({ code: "PUBLICATION_READBACK_UNSUPPORTED" }),
    );
  });

  it("fails closed when a target scope cannot be addressed exactly", async () => {
    const adapter = {
      supportedScopeTypes: ["account"] as const,
      readAbsolute: vi.fn(),
    };
    const service = new InventoryPublicationReadbackService(
      store,
      { get: () => adapter as any },
      { now: () => NOW },
    );

    const captured = await service.capture(request(), "operator-1");
    expect(captured.state).toBe("partial");
    expect(adapter.readAbsolute).not.toHaveBeenCalled();
    expect(store.recordFailure).toHaveBeenCalledWith(
      "5",
      target(),
      expect.objectContaining({ code: "PUBLICATION_READBACK_SCOPE_UNSUPPORTED" }),
    );
  });

  it("routes Dropship readback through the exact store-owned provider adapter", async () => {
    const dropshipTarget = target({
      destinationKind: "dropship_store_connection",
      channelConnectionId: null,
      dropshipStoreConnectionId: 77,
      providerKey: "ebay",
      providerScopeType: "account",
      externalScopeId: "seller-account-1",
    });
    store.begin.mockResolvedValueOnce({ kind: "started", readbackRunId: "5", targets: [dropshipTarget] });
    const adapter = {
      supportedScopeTypes: ["account"] as const,
      readAbsolute: vi.fn(async () => ({ observedQuantity: 6, providerResponse: { status: 200 } })),
    };
    const get = vi.fn(() => adapter as any);
    const service = new InventoryPublicationReadbackService(store, { get }, { now: () => NOW });

    const captured = await service.capture(request(), "operator-1");

    expect(captured.state).toBe("completed");
    expect(get).toHaveBeenCalledWith("dropship_store_connection", "ebay");
    expect(adapter.readAbsolute).toHaveBeenCalledWith(expect.objectContaining({
      destination: {
        kind: "dropship_store_connection",
        channelConnectionId: null,
        dropshipStoreConnectionId: 77,
      },
    }));
    expect(store.recordObserved).toHaveBeenCalledWith("5", dropshipTarget, 6, NOW);
  });

  it("records a malformed destination owner as a target-scoped failure", async () => {
    const invalidTarget = target({ channelConnectionId: null });
    store.begin.mockResolvedValueOnce({ kind: "started", readbackRunId: "5", targets: [invalidTarget] });
    const adapter = {
      supportedScopeTypes: ["location"] as const,
      readAbsolute: vi.fn(),
    };
    const service = new InventoryPublicationReadbackService(
      store,
      { get: () => adapter as any },
      { now: () => NOW },
    );

    const captured = await service.capture(request(), "operator-1");

    expect(captured.state).toBe("partial");
    expect(adapter.readAbsolute).not.toHaveBeenCalled();
    expect(store.recordFailure).toHaveBeenCalledWith(
      "5",
      invalidTarget,
      expect.objectContaining({ code: "PUBLICATION_READBACK_DESTINATION_INVALID" }),
    );
  });

  it("returns a durable idempotent replay without calling a provider", async () => {
    store.begin.mockResolvedValueOnce({ kind: "replay", result: result({ alreadyApplied: true }) });
    const get = vi.fn();
    const service = new InventoryPublicationReadbackService(store, { get }, { now: () => NOW });

    await expect(service.capture(request(), "operator-1"))
      .resolves.toEqual(result({ alreadyApplied: true }));
    expect(get).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });
});

function request() {
  return { idempotencyKey: "readback-1", reason: "Refresh exact provider quantities" };
}

function target(overrides: Partial<PublicationReadbackTarget> = {}): PublicationReadbackTarget {
  return {
    publicationTargetId: 9,
    publicationTargetRevision: "4",
    productVariantId: 101,
    destinationKind: "channel_connection" as const,
    channelId: 3,
    channelConnectionId: 33,
    dropshipStoreConnectionId: null,
    providerKey: "shopify",
    providerScopeType: "location" as const,
    externalScopeId: "location-9",
    externalInventoryItemId: "inventory-item-101",
    externalSku: "SKU-101",
    ...overrides,
  };
}

function result(overrides: Record<string, unknown>) {
  return {
    readbackRunId: "5",
    state: "completed",
    requestedBy: "operator-1",
    reason: "Refresh exact provider quantities",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    targetRows: 1,
    observedRows: 1,
    failedRows: 0,
    failures: [],
    alreadyApplied: false,
    ...overrides,
  };
}
