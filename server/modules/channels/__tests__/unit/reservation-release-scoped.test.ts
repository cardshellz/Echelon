import { describe, it, expect, vi } from "vitest";
import { createReservationService } from "../../reservation.service";

/**
 * P0.1b — order-scoped, idempotent release.
 *
 * releaseOrderReservation must release ONLY what the ledger says is still
 * open for this order's items — never the raw order quantity (the pre-P0.1
 * behavior, which double-released on repeated calls and drained OTHER
 * orders' reservations → oversell).
 *
 * The db is mocked with scripted response queues:
 *   - select() chain resolves the next entry of `selects`
 *   - execute() resolves the next entry of `executes`
 */

function makeDb(selects: any[][], executes: any[]) {
  const selectQ = [...selects];
  const executeQ = [...executes];

  const makeChain = () => {
    const rows = selectQ.length > 0 ? selectQ.shift()! : [];
    const chain: any = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  };

  return {
    select: vi.fn(() => makeChain()),
    execute: vi.fn(async () => (executeQ.length > 0 ? executeQ.shift()! : { rows: [] })),
    transaction: async (fn: any) => fn(dbSelf()),
  } as any;

  function dbSelf(): any {
    // transaction callback receives the same mock surface
    return { select: vi.fn(() => makeChain()), execute: vi.fn(async () => ({ rows: [] })) };
  }
}

function makeHarness() {
  const releaseCalls: any[] = [];
  const mockInventoryCore = {
    releaseReservation: vi.fn(async (params: any) => {
      releaseCalls.push(params);
    }),
  };
  const mockChannelSync = {
    queueSyncAfterInventoryChange: vi.fn().mockResolvedValue(undefined),
  };
  const mockAtpService = { getAtpPerVariant: vi.fn().mockResolvedValue([]) };
  return { mockInventoryCore, mockChannelSync, mockAtpService, releaseCalls };
}

const ITEM = { id: 700, orderId: 42, sku: "SKU-A", quantity: 5 };
const VARIANT = { id: 9, sku: "SKU-A", productId: 3, unitsPerVariant: 1 };

function ledgerRow(over: Partial<Record<string, number>> = {}) {
  return {
    rows: [{ delta_sum: 0, legacy_reserves: 0, picked_units: 0, unreserved_units: 0, ...over }],
  };
}

describe("releaseOrderReservation — order-scoped + idempotent (P0.1b)", () => {
  it("releases exactly the ledger-open amount, not the order quantity", async () => {
    const { mockInventoryCore, mockChannelSync, mockAtpService, releaseCalls } = makeHarness();
    // ledger: reserved 5, pick consumed 3 → open = 2 (delta_sum already nets it)
    const db = makeDb(
      [
        [ITEM],                                        // items
        [VARIANT],                                     // variant lookup
        [{ id: 1, warehouseLocationId: 10, reservedQty: 10, productVariantId: 9 }], // levels
      ],
      [ledgerRow({ delta_sum: 2 })],
    );
    const svc = createReservationService(db, mockInventoryCore, mockChannelSync, mockAtpService);

    const result = await svc.releaseOrderReservation(42, "test_cancel");

    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0].qty).toBe(2); // NOT 5 (item.quantity)
    expect(releaseCalls[0].orderId).toBe(42);
    expect(releaseCalls[0].orderItemId).toBe(700);
    expect(result.failed).toHaveLength(0);
  });

  it("is a no-op when the ledger shows nothing open (idempotent second call)", async () => {
    const { mockInventoryCore, mockChannelSync, mockAtpService, releaseCalls } = makeHarness();
    const db = makeDb(
      [[ITEM], [VARIANT]],
      [ledgerRow({ delta_sum: 0 })], // fully released / consumed already
    );
    const svc = createReservationService(db, mockInventoryCore, mockChannelSync, mockAtpService);

    const result = await svc.releaseOrderReservation(42, "test_cancel_again");

    expect(releaseCalls).toHaveLength(0);
    expect(result.released).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  it("uses the conservative estimate for pre-116 (legacy) reservations", async () => {
    const { mockInventoryCore, mockChannelSync, mockAtpService, releaseCalls } = makeHarness();
    // legacy reserve row (qty unknown), 3 picked via ledger, none unreserved:
    // estimate = max(0, 5 - 3 - 0) = 2
    const db = makeDb(
      [
        [ITEM],
        [VARIANT],
        [{ id: 1, warehouseLocationId: 10, reservedQty: 10, productVariantId: 9 }],
      ],
      [ledgerRow({ delta_sum: -3, legacy_reserves: 1, picked_units: 3 })],
    );
    const svc = createReservationService(db, mockInventoryCore, mockChannelSync, mockAtpService);

    await svc.releaseOrderReservation(42, "legacy_cancel");

    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0].qty).toBe(2);
  });

  it("caps the release at what the counters actually hold (never over-releases)", async () => {
    const { mockInventoryCore, mockChannelSync, mockAtpService, releaseCalls } = makeHarness();
    // ledger says 5 open, but counters only hold 3 → release 3, no failure spam
    const db = makeDb(
      [
        [ITEM],
        [VARIANT],
        [{ id: 1, warehouseLocationId: 10, reservedQty: 3, productVariantId: 9 }],
      ],
      [ledgerRow({ delta_sum: 5 })],
    );
    const svc = createReservationService(db, mockInventoryCore, mockChannelSync, mockAtpService);

    const result = await svc.releaseOrderReservation(42, "drift_case");

    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0].qty).toBe(3);
    expect(result.failed).toHaveLength(0); // drift is logged, not failed
  });

  it("spreads a release across multiple levels, largest reserved first", async () => {
    const { mockInventoryCore, mockChannelSync, mockAtpService, releaseCalls } = makeHarness();
    const db = makeDb(
      [
        [ITEM],
        [VARIANT],
        [
          { id: 1, warehouseLocationId: 10, reservedQty: 3, productVariantId: 9 },
          { id: 2, warehouseLocationId: 11, reservedQty: 2, productVariantId: 9 },
        ],
      ],
      [ledgerRow({ delta_sum: 4 })],
    );
    const svc = createReservationService(db, mockInventoryCore, mockChannelSync, mockAtpService);

    await svc.releaseOrderReservation(42, "multi_level");

    expect(releaseCalls).toHaveLength(2);
    expect(releaseCalls[0].qty).toBe(3);
    expect(releaseCalls[1].qty).toBe(1);
  });
});

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => {
      if (chunk == null) return [];
      if (typeof chunk === "string") return [chunk];
      if (Array.isArray(chunk.value)) return chunk.value;
      if (chunk.value !== undefined) return [String(chunk.value)];
      return [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeLineReleaseDb(args: {
  previouslyReleased?: number;
  openQuantity?: number;
  reservedQuantity?: number;
}) {
  const tx: any = {
    execute: vi.fn(async (query: any) => {
      const text = queryText(query);
      if (text.includes("FROM wms.order_items oi")) {
        return { rows: [{ order_item_id: 700, sku: "SKU-A", product_variant_id: 9, product_id: 3 }] };
      }
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("reference_type = 'shopify_refund'")) {
        return { rows: [{ released_quantity: args.previouslyReleased ?? 0 }] };
      }
      if (text.includes("WITH location_authority")) {
        return {
          rows: [{
            id: 1,
            warehouse_location_id: 10,
            reserved_qty: args.reservedQuantity ?? 5,
            attributed_open_quantity: args.openQuantity ?? 5,
            has_legacy_reserve: false,
          }],
        };
      }
      if (text.includes("transaction_type IN ('reserve', 'unreserve', 'pick')")) {
        return {
          rows: [{
            delta_sum: args.openQuantity ?? 5,
            legacy_reserves: 0,
            picked_units: 0,
            unreserved_units: 0,
          }],
        };
      }
      throw new Error(`Unexpected line release query: ${text}`);
    }),
  };
  return {
    transaction: vi.fn(async (callback: (transaction: any) => Promise<unknown>) => callback(tx)),
  } as any;
}

describe("releaseOrderItemReservation - refund-event scoped", () => {
  it("releases only the requested line quantity and records the refund event identity", async () => {
    const { mockInventoryCore, mockChannelSync, mockAtpService, releaseCalls } = makeHarness();
    const db = makeLineReleaseDb({ openQuantity: 5, reservedQuantity: 5 });
    const svc = createReservationService(db, mockInventoryCore, mockChannelSync, mockAtpService);

    const result = await svc.releaseOrderItemReservation({
      orderId: 42,
      orderItemId: 700,
      quantity: 2,
      sourceEventId: "refund-123",
      reason: "Shopify line refund refund-123",
      userId: "system:shopify_refund",
    });

    expect(result).toMatchObject({
      requestedQuantity: 2,
      previouslyReleasedQuantity: 0,
      releasedQuantity: 2,
      openReservationAfter: 3,
      idempotentReplay: false,
    });
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]).toMatchObject({
      qty: 2,
      orderId: 42,
      orderItemId: 700,
      referenceType: "shopify_refund",
      referenceId: "refund-123",
    });
    expect(mockChannelSync.queueSyncAfterInventoryChange).toHaveBeenCalledWith(9);
  });

  it("does not release inventory twice when the refund event is replayed", async () => {
    const { mockInventoryCore, mockChannelSync, mockAtpService, releaseCalls } = makeHarness();
    const db = makeLineReleaseDb({ previouslyReleased: 2, openQuantity: 3 });
    const svc = createReservationService(db, mockInventoryCore, mockChannelSync, mockAtpService);

    const result = await svc.releaseOrderItemReservation({
      orderId: 42,
      orderItemId: 700,
      quantity: 2,
      sourceEventId: "refund-123",
      reason: "Shopify line refund refund-123",
    });

    expect(result).toMatchObject({
      previouslyReleasedQuantity: 2,
      releasedQuantity: 0,
      idempotentReplay: true,
    });
    expect(releaseCalls).toHaveLength(0);
    expect(mockChannelSync.queueSyncAfterInventoryChange).not.toHaveBeenCalled();
  });

  it("caps the line release at the reservation still open in the ledger", async () => {
    const { mockInventoryCore, mockChannelSync, mockAtpService, releaseCalls } = makeHarness();
    const db = makeLineReleaseDb({ openQuantity: 1, reservedQuantity: 5 });
    const svc = createReservationService(db, mockInventoryCore, mockChannelSync, mockAtpService);

    const result = await svc.releaseOrderItemReservation({
      orderId: 42,
      orderItemId: 700,
      quantity: 2,
      sourceEventId: "refund-456",
      reason: "Shopify line refund refund-456",
    });

    expect(result.releasedQuantity).toBe(1);
    expect(result.openReservationAfter).toBe(0);
    expect(releaseCalls[0].qty).toBe(1);
  });

  it("fails instead of releasing another order's reservation when attribution is missing", async () => {
    const { mockInventoryCore, mockChannelSync, mockAtpService, releaseCalls } = makeHarness();
    const db = makeLineReleaseDb({ openQuantity: 2, reservedQuantity: 0 });
    const svc = createReservationService(db, mockInventoryCore, mockChannelSync, mockAtpService);

    await expect(svc.releaseOrderItemReservation({
      orderId: 42,
      orderItemId: 700,
      quantity: 2,
      sourceEventId: "refund-789",
      reason: "Shopify line refund refund-789",
    })).rejects.toThrow("only 0 unit(s) were attributable");

    expect(releaseCalls).toHaveLength(0);
    expect(mockChannelSync.queueSyncAfterInventoryChange).not.toHaveBeenCalled();
  });
});
