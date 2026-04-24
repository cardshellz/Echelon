/**
 * Unit tests for linkChildToParentShipment (§6 Commit 14).
 *
 * Scope: fully mocked db — the helper is exercised through its
 * structural contract (execute() for the child-idempotency probe and
 * the parent-lookup, insert()...values()...returning() for the
 * shipment row, and insert()...values() for the items).
 *
 * Cases covered (per Rule #9):
 *   - Happy path: parent has shipment → child row inserted with
 *     inherited shipstation_order_id/key, items inserted, created:true.
 *   - Parent has shipment but SS linkage is NULL (pre-push): child row
 *     inserts with NULL SS linkage (reconcile will backfill).
 *   - Parent has NO shipment row → ChildWithoutParentShipmentError.
 *   - Idempotent: child already has a shipment (any status) → returns
 *     existing id, created:false, zero inserts.
 *   - Empty child items: shipment row inserted, items insert skipped,
 *     returns {created:true}.
 *   - Input validation: negative ids, zero ids, non-integer ids,
 *     child==parent, bad item ids, negative item qty → throws.
 *   - source='echelon_combined_child' is stamped on every new row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  linkChildToParentShipment,
  ChildWithoutParentShipmentError,
  ECHELON_COMBINED_CHILD_SHIPMENT_SOURCE,
} from "../../create-shipment";

// ─── Mock db factory ─────────────────────────────────────────────────
//
// The helper issues TWO execute() calls:
//   1. Child idempotency probe (SELECT id FROM outbound_shipments WHERE order_id=child)
//   2. Parent lookup        (SELECT id, shipstation_order_id, shipstation_order_key ...)
//
// The mock returns canned rows for each call in order. This mirrors
// the helper's execution order exactly and keeps the mock trivial.

interface RecordedInsert {
  table: any;
  values?: any;
  returning?: boolean;
}

interface MockDbConfig {
  /** rows[] returned by the child-idempotency probe (first execute). */
  childProbeRows: any[];
  /** rows[] returned by the parent lookup (second execute). */
  parentLookupRows: any[];
  /** id assigned to the new shipment row by the mocked insert chain. */
  newShipmentId?: number;
}

function makeMockDb(cfg: MockDbConfig) {
  const inserts: RecordedInsert[] = [];
  const executeCalls: Array<{ index: number }> = [];
  let executeIndex = 0;

  const execute = vi.fn(async (_query: any) => {
    const idx = executeIndex++;
    executeCalls.push({ index: idx });
    if (idx === 0) return { rows: cfg.childProbeRows };
    if (idx === 1) return { rows: cfg.parentLookupRows };
    return { rows: [] };
  });

  function insert(table: any) {
    const record: RecordedInsert = { table };
    inserts.push(record);

    const chain: any = {
      values(vals: any) {
        record.values = vals;
        return chain;
      },
      returning(_shape?: any) {
        record.returning = true;
        return Promise.resolve([{ id: cfg.newShipmentId ?? 77777 }]);
      },
      then(resolve: any, reject?: any) {
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    db: { execute, insert: vi.fn(insert) },
    getInserts: () => inserts,
    getExecuteCalls: () => executeCalls.length,
  };
}

// ─── Happy path ──────────────────────────────────────────────────────

describe("linkChildToParentShipment :: happy path", () => {
  it("inserts child shipment inheriting parent's SS linkage + items, returns created:true", async () => {
    const mock = makeMockDb({
      childProbeRows: [],
      parentLookupRows: [
        {
          id: 100,
          shipstation_order_id: 5555,
          shipstation_order_key: "echelon-wms-shp-100",
        },
      ],
      newShipmentId: 9001,
    });

    const result = await linkChildToParentShipment(mock.db as any, 42, 41, 7, [
      { id: 201, quantity: 2 },
      { id: 202, quantity: 1 },
    ]);

    expect(result.shipmentId).toBe(9001);
    expect(result.created).toBe(true);

    // Two execute()s (child probe + parent lookup) then two inserts
    // (shipment row + items batch).
    expect(mock.getExecuteCalls()).toBe(2);

    const inserts = mock.getInserts();
    expect(inserts.length).toBe(2);

    // Shipment row — inherits parent's SS linkage.
    const shipmentInsert = inserts[0];
    expect(shipmentInsert.values.orderId).toBe(42);
    expect(shipmentInsert.values.channelId).toBe(7);
    expect(shipmentInsert.values.status).toBe("planned");
    expect(shipmentInsert.values.source).toBe(
      ECHELON_COMBINED_CHILD_SHIPMENT_SOURCE,
    );
    expect(shipmentInsert.values.shipstationOrderId).toBe(5555);
    expect(shipmentInsert.values.shipstationOrderKey).toBe(
      "echelon-wms-shp-100",
    );
    expect(shipmentInsert.returning).toBe(true);

    // Items rows — each carries the new shipmentId.
    const itemsInsert = inserts[1];
    expect(Array.isArray(itemsInsert.values)).toBe(true);
    expect(itemsInsert.values.length).toBe(2);
    expect(itemsInsert.values[0]).toEqual({
      shipmentId: 9001,
      orderItemId: 201,
      qty: 2,
    });
    expect(itemsInsert.values[1]).toEqual({
      shipmentId: 9001,
      orderItemId: 202,
      qty: 1,
    });
  });

  it("accepts channelId=null", async () => {
    const mock = makeMockDb({
      childProbeRows: [],
      parentLookupRows: [
        {
          id: 10,
          shipstation_order_id: 111,
          shipstation_order_key: "k",
        },
      ],
      newShipmentId: 1234,
    });

    const result = await linkChildToParentShipment(
      mock.db as any,
      5,
      4,
      null,
      [{ id: 1, quantity: 3 }],
    );

    expect(result.created).toBe(true);
    const inserts = mock.getInserts();
    expect(inserts[0].values.channelId).toBeNull();
  });

  it("inherits NULL SS linkage when parent has not been pushed yet (reconcile backfills later)", async () => {
    const mock = makeMockDb({
      childProbeRows: [],
      parentLookupRows: [
        {
          id: 50,
          // Parent exists but hasn't been pushed to SS yet; these
          // are NULL at link time. The helper must pass NULLs
          // through, NOT throw, NOT default to 0/empty-string.
          shipstation_order_id: null,
          shipstation_order_key: null,
        },
      ],
      newShipmentId: 9876,
    });

    const result = await linkChildToParentShipment(
      mock.db as any,
      12,
      11,
      null,
      [],
    );

    expect(result.created).toBe(true);
    const shipmentInsert = mock.getInserts()[0];
    expect(shipmentInsert.values.shipstationOrderId).toBeNull();
    expect(shipmentInsert.values.shipstationOrderKey).toBeNull();
    expect(shipmentInsert.values.source).toBe(
      ECHELON_COMBINED_CHILD_SHIPMENT_SOURCE,
    );
  });

  it("handles camelCase column names from the parent lookup driver", async () => {
    // Defensive: some db drivers return column names as camelCase
    // rather than snake_case. The helper normalizes both.
    const mock = makeMockDb({
      childProbeRows: [],
      parentLookupRows: [
        {
          id: 99,
          shipstationOrderId: 4242,
          shipstationOrderKey: "alt-key",
        },
      ],
      newShipmentId: 5000,
    });

    await linkChildToParentShipment(mock.db as any, 8, 7, null, []);

    const shipmentInsert = mock.getInserts()[0];
    expect(shipmentInsert.values.shipstationOrderId).toBe(4242);
    expect(shipmentInsert.values.shipstationOrderKey).toBe("alt-key");
  });
});

// ─── Parent-missing guard ────────────────────────────────────────────

describe("linkChildToParentShipment :: parent without shipment", () => {
  it("throws ChildWithoutParentShipmentError when parent has no shipment row", async () => {
    const mock = makeMockDb({
      childProbeRows: [],
      parentLookupRows: [], // parent shipment doesn't exist yet
      newShipmentId: 1,
    });

    await expect(
      linkChildToParentShipment(mock.db as any, 42, 41, 7, []),
    ).rejects.toThrow(ChildWithoutParentShipmentError);

    // NO inserts should have happened — the race is surfaced before
    // we touch the write path.
    expect(mock.getInserts().length).toBe(0);
  });

  it("error carries childWmsOrderId and parentWmsOrderId for observability", async () => {
    const mock = makeMockDb({
      childProbeRows: [],
      parentLookupRows: [],
    });

    try {
      await linkChildToParentShipment(mock.db as any, 42, 41, null, []);
      expect.fail("expected ChildWithoutParentShipmentError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ChildWithoutParentShipmentError);
      expect(err.name).toBe("ChildWithoutParentShipmentError");
      expect(err.childWmsOrderId).toBe(42);
      expect(err.parentWmsOrderId).toBe(41);
      expect(err.message).toMatch(/parent order 41/);
      expect(err.message).toMatch(/child 42/);
    }
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────

describe("linkChildToParentShipment :: idempotency", () => {
  it("returns existing id and performs NO inserts when child already has a shipment (any status)", async () => {
    // Even if the child's shipment has advanced past 'planned' (e.g.
    // reconcile already bumped it to 'shipped' in lockstep with the
    // parent), re-linking must not duplicate.
    const mock = makeMockDb({
      childProbeRows: [{ id: 333 }],
      parentLookupRows: [], // shouldn't be consulted
      newShipmentId: 99999,
    });

    const result = await linkChildToParentShipment(
      mock.db as any,
      42,
      41,
      7,
      [{ id: 1, quantity: 2 }],
    );

    expect(result.shipmentId).toBe(333);
    expect(result.created).toBe(false);

    // Only the child probe ran; parent lookup was skipped.
    expect(mock.getExecuteCalls()).toBe(1);
    expect(mock.getInserts().length).toBe(0);
  });

  it("throws if the existing child shipment id is not a positive integer (defensive)", async () => {
    const mock = makeMockDb({
      childProbeRows: [{ id: 0 }],
      parentLookupRows: [],
    });

    await expect(
      linkChildToParentShipment(mock.db as any, 42, 41, null, []),
    ).rejects.toThrow(/positive integer/);
  });
});

// ─── Empty items ─────────────────────────────────────────────────────

describe("linkChildToParentShipment :: empty items", () => {
  it("inserts the shipment but skips the items insert when childOrderItems=[]", async () => {
    const mock = makeMockDb({
      childProbeRows: [],
      parentLookupRows: [
        { id: 1, shipstation_order_id: 10, shipstation_order_key: "k" },
      ],
      newShipmentId: 777,
    });

    const result = await linkChildToParentShipment(
      mock.db as any,
      42,
      41,
      7,
      [],
    );

    expect(result.shipmentId).toBe(777);
    expect(result.created).toBe(true);

    // Only one insert (the shipment row); items insert skipped.
    const inserts = mock.getInserts();
    expect(inserts.length).toBe(1);
    expect(inserts[0].values.orderId).toBe(42);
    expect(inserts[0].values.source).toBe(
      ECHELON_COMBINED_CHILD_SHIPMENT_SOURCE,
    );
  });
});

// ─── Input validation ────────────────────────────────────────────────

describe("linkChildToParentShipment :: input validation", () => {
  let mock: ReturnType<typeof makeMockDb>;
  beforeEach(() => {
    mock = makeMockDb({
      childProbeRows: [],
      parentLookupRows: [
        { id: 1, shipstation_order_id: 1, shipstation_order_key: "k" },
      ],
      newShipmentId: 1,
    });
  });

  it("throws when childWmsOrderId is 0", async () => {
    await expect(
      linkChildToParentShipment(mock.db as any, 0, 41, null, []),
    ).rejects.toThrow(/childWmsOrderId.*positive integer/);
  });

  it("throws when childWmsOrderId is negative", async () => {
    await expect(
      linkChildToParentShipment(mock.db as any, -5, 41, null, []),
    ).rejects.toThrow(/childWmsOrderId.*positive integer/);
  });

  it("throws when childWmsOrderId is a float (Rule #3: no loose coercion)", async () => {
    await expect(
      linkChildToParentShipment(mock.db as any, 1.5 as any, 41, null, []),
    ).rejects.toThrow(/childWmsOrderId.*positive integer/);
  });

  it("throws when parentWmsOrderId is 0", async () => {
    await expect(
      linkChildToParentShipment(mock.db as any, 42, 0, null, []),
    ).rejects.toThrow(/parentWmsOrderId.*positive integer/);
  });

  it("throws when parentWmsOrderId is negative", async () => {
    await expect(
      linkChildToParentShipment(mock.db as any, 42, -1, null, []),
    ).rejects.toThrow(/parentWmsOrderId.*positive integer/);
  });

  it("throws when parentWmsOrderId is a float", async () => {
    await expect(
      linkChildToParentShipment(mock.db as any, 42, 1.5 as any, null, []),
    ).rejects.toThrow(/parentWmsOrderId.*positive integer/);
  });

  it("throws when childWmsOrderId == parentWmsOrderId (cycle guard)", async () => {
    await expect(
      linkChildToParentShipment(mock.db as any, 42, 42, null, []),
    ).rejects.toThrow(/differ/);
  });

  it("throws when an item.id is zero", async () => {
    await expect(
      linkChildToParentShipment(mock.db as any, 42, 41, null, [
        { id: 0, quantity: 1 },
      ]),
    ).rejects.toThrow(/orderItem\.id/);
  });

  it("throws when an item.id is negative", async () => {
    await expect(
      linkChildToParentShipment(mock.db as any, 42, 41, null, [
        { id: -1, quantity: 1 },
      ]),
    ).rejects.toThrow(/orderItem\.id/);
  });

  it("throws when an item.quantity is negative", async () => {
    await expect(
      linkChildToParentShipment(mock.db as any, 42, 41, null, [
        { id: 1, quantity: -1 },
      ]),
    ).rejects.toThrow(/orderItem\.quantity/);
  });

  it("accepts an item with quantity=0 (e.g. non-shippable lines)", async () => {
    const result = await linkChildToParentShipment(
      mock.db as any,
      42,
      41,
      null,
      [{ id: 1, quantity: 0 }],
    );
    expect(result.created).toBe(true);
    const itemsInsert = mock.getInserts()[1];
    expect(itemsInsert.values[0].qty).toBe(0);
  });
});

// ─── Source constant contract ────────────────────────────────────────

describe("linkChildToParentShipment :: source constant", () => {
  it("stamps source='echelon_combined_child' on every new shipment", async () => {
    const mock = makeMockDb({
      childProbeRows: [],
      parentLookupRows: [
        { id: 1, shipstation_order_id: 1, shipstation_order_key: "k" },
      ],
      newShipmentId: 1,
    });

    await linkChildToParentShipment(mock.db as any, 42, 41, null, []);
    const shipmentInsert = mock.getInserts()[0];
    expect(shipmentInsert.values.source).toBe("echelon_combined_child");
    expect(ECHELON_COMBINED_CHILD_SHIPMENT_SOURCE).toBe(
      "echelon_combined_child",
    );
  });
});
