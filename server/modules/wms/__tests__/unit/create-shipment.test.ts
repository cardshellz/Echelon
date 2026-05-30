/**
 * Unit tests for createShipmentForOrder (§6 Commit 8).
 *
 * Scope: fully mocked db — the helper is exercised through its
 * structural contract (execute() for the idempotency probe,
 * insert()...values()...returning() for the shipment row, and
 * insert()...values() for the items).
 *
 * Cases covered (per Rule #9):
 *   - Happy path — no existing shipment, N items → one shipment
 *     insert + one items insert, returns {created:true}.
 *   - Idempotency — existing planned shipment found → returns
 *     {created:false}, NO insert calls.
 *   - Empty items — no existing shipment, 0 items → shipment inserted,
 *     items insert NOT called, returns {created:true}.
 *   - Defensive input validation — bad wmsOrderId / item fields throw.
 *   - Source constant is 'echelon_sync' (contract with ops dashboards).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createShipmentForOrder,
  ECHELON_SYNC_SHIPMENT_SOURCE,
} from "../../create-shipment";

const CREATE_SHIPMENT_SRC = readFileSync(
  fileURLToPath(new URL("../../create-shipment.ts", import.meta.url)),
  "utf8",
);

// ─── Mock db factory ─────────────────────────────────────────────────

interface RecordedInsert {
  table: any;
  values?: any;
  returning?: boolean;
}

function isAdvisoryLockQuery(query: any): boolean {
  try {
    const str = JSON.stringify(query);
    return str.includes("pg_advisory_lock") || str.includes("pg_advisory_unlock");
  } catch {
    return String(query).includes("advisory");
  }
}

function makeMockDb(existingPlannedId: number | null, newShipmentId = 12345) {
  const inserts: RecordedInsert[] = [];

  const execute = vi.fn(async (query: any) => {
    if (isAdvisoryLockQuery(query)) {
      return { rows: [{}] };
    }

    if (existingPlannedId === null) {
      return { rows: [] };
    }
    return { rows: [{ id: existingPlannedId }] };
  });

  function getNonLockExecuteCalls(): number {
    return execute.mock.calls.filter((args: any[]) => !isAdvisoryLockQuery(args[0])).length;
  }

  // Drizzle-like chain: insert(table).values(rows).returning({...})?
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
        // Simulate DB-assigned id for the shipments insert only.
        // The items insert never calls .returning() so it never reaches
        // this path in the helper.
        return Promise.resolve([{ id: newShipmentId }]);
      },
      // If the caller awaits the chain without .returning() (items
      // insert path), resolve to an empty result array.
      then(resolve: any, reject?: any) {
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    db: { execute, insert: vi.fn(insert) },
    getInserts: () => inserts,
    getExecuteCalls: () => getNonLockExecuteCalls(),
  };
}

// ─── Happy path ──────────────────────────────────────────────────────

describe("createShipmentForOrder :: happy path", () => {
  it("inserts one shipment + one items batch, returns {created:true}", async () => {
    const mock = makeMockDb(null, 9001);
    const result = await createShipmentForOrder(mock.db as any, 42, 7, [
      { id: 101, quantity: 2 },
      { id: 102, quantity: 1 },
    ]);

    expect(result.shipmentId).toBe(9001);
    expect(result.created).toBe(true);
    expect(Number.isInteger(result.shipmentId)).toBe(true);

    // One planned-shipment probe, one active-coverage probe, plus one
    // default lookup and one idempotent
    // shipment-item insert per shipment item.
    expect(mock.getExecuteCalls()).toBe(6);

    // Only the shipment row uses the Drizzle insert chain. Shipment
    // items use raw SQL guarded by NOT EXISTS so retries cannot duplicate
    // (shipment_id, order_item_id).
    const inserts = mock.getInserts();
    expect(inserts.length).toBe(1);

    // First insert = shipment row with the correct scalar fields.
    const shipmentInsert = inserts[0];
    expect(shipmentInsert.values.orderId).toBe(42);
    expect(shipmentInsert.values.channelId).toBe(7);
    expect(shipmentInsert.values.status).toBe("planned");
    expect(shipmentInsert.values.source).toBe(ECHELON_SYNC_SHIPMENT_SOURCE);
    expect(shipmentInsert.returning).toBe(true);

  });

  it("accepts channelId=null (e.g. manual / non-channel orders)", async () => {
    const mock = makeMockDb(null, 4242);
    const result = await createShipmentForOrder(mock.db as any, 5, null, [
      { id: 1, quantity: 3 },
    ]);

    expect(result.created).toBe(true);
    const inserts = mock.getInserts();
    expect(inserts[0].values.channelId).toBeNull();
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────

describe("createShipmentForOrder :: idempotency", () => {
  it("builds active coverage item filters as a real Postgres int array", () => {
    expect(CREATE_SHIPMENT_SRC).toContain("ANY(ARRAY[");
    expect(CREATE_SHIPMENT_SRC).toContain(
      "sql.join(orderItemIds.map((id) => sql`${id}`), sql`, `)",
    );
    expect(CREATE_SHIPMENT_SRC).not.toContain("ANY(${orderItemIds}::int[])");
  });

  it("returns existing id and performs NO insert when an active shipment exists", async () => {
    const mock = makeMockDb(555, /* newShipmentId irrelevant */ 99999);
    const result = await createShipmentForOrder(mock.db as any, 42, 7, [
      { id: 101, quantity: 2 },
      { id: 102, quantity: 1 },
    ]);

    expect(result.shipmentId).toBe(555);
    expect(result.created).toBe(false);

    // Only the probe ran; no inserts.
    expect(mock.getExecuteCalls()).toBe(1);
    expect(mock.getInserts().length).toBe(0);
  });

  it("dedup probe checks all active statuses, not just planned", () => {
    expect(CREATE_SHIPMENT_SRC).toContain("NOT IN ('voided', 'cancelled')");
    expect(CREATE_SHIPMENT_SRC).not.toContain("AND status  = ${PLANNED_STATUS}");
  });

  it("throws if the existing row's id is not a positive integer (defensive)", async () => {
    // Simulate a corrupted probe result.
    const mock = makeMockDb(0, 1);
    await expect(
      createShipmentForOrder(mock.db as any, 42, 7, []),
    ).rejects.toThrow(/positive integer/);
  });

  it("returns an existing active shipment when all requested items are already covered", async () => {
    const inserts: RecordedInsert[] = [];
    let realQueryCount = 0;
    const execute = vi.fn().mockImplementation((query: any) => {
      if (isAdvisoryLockQuery(query)) {
        return Promise.resolve({ rows: [{}] });
      }
      realQueryCount++;
      // First real query: probe for existing shipment → none found
      // Second real query: active coverage → all items covered
      if (realQueryCount <= 1) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({
        rows: [
          { shipment_id: 777, order_item_id: 101, qty: 2 },
          { shipment_id: 777, order_item_id: 102, qty: 1 },
        ],
      });
    });
    const insert = vi.fn((table: any) => {
      const record: RecordedInsert = { table };
      inserts.push(record);
      return {
        values(vals: any) {
          record.values = vals;
          return this;
        },
        returning() {
          return Promise.resolve([{ id: 999 }]);
        },
      };
    });

    const result = await createShipmentForOrder(
      { execute, insert } as any,
      42,
      7,
      [
        { id: 101, quantity: 2 },
        { id: 102, quantity: 1 },
      ],
    );

    expect(result).toEqual({ shipmentId: 777, created: false });
    expect(insert).not.toHaveBeenCalled();
  });
});

// ─── Empty items ─────────────────────────────────────────────────────

describe("createShipmentForOrder :: empty items", () => {
  it("inserts the shipment but skips the items insert when items=[]", async () => {
    const mock = makeMockDb(null, 777);
    const result = await createShipmentForOrder(mock.db as any, 42, 7, []);

    expect(result.shipmentId).toBe(777);
    expect(result.created).toBe(true);

    // Only one insert (the shipment row); items insert was skipped.
    expect(mock.getInserts().length).toBe(1);
    const shipmentInsert = mock.getInserts()[0];
    expect(shipmentInsert.values.orderId).toBe(42);
    expect(shipmentInsert.values.status).toBe("planned");
  });
});

// ─── Input validation ────────────────────────────────────────────────

describe("createShipmentForOrder :: input validation", () => {
  let mock: ReturnType<typeof makeMockDb>;
  beforeEach(() => {
    mock = makeMockDb(null, 1);
  });

  it("throws when wmsOrderId is 0", async () => {
    await expect(
      createShipmentForOrder(mock.db as any, 0, null, []),
    ).rejects.toThrow(/positive integer/);
  });

  it("throws when wmsOrderId is negative", async () => {
    await expect(
      createShipmentForOrder(mock.db as any, -1, null, []),
    ).rejects.toThrow(/positive integer/);
  });

  it("throws when wmsOrderId is a float (Rule #3: no loose coercion)", async () => {
    await expect(
      createShipmentForOrder(mock.db as any, 1.5 as any, null, []),
    ).rejects.toThrow(/positive integer/);
  });

  it("throws when an item.id is zero", async () => {
    await expect(
      createShipmentForOrder(mock.db as any, 42, null, [
        { id: 0, quantity: 1 },
      ]),
    ).rejects.toThrow(/orderItem.id/);
  });

  it("throws when an item.quantity is negative", async () => {
    await expect(
      createShipmentForOrder(mock.db as any, 42, null, [
        { id: 1, quantity: -1 },
      ]),
    ).rejects.toThrow(/orderItem.quantity/);
  });

  it("accepts an item with quantity=0 (possible after ship-only-shippable filter)", async () => {
    // We don't reject qty=0 outright because digital/non-shipping
    // items can legitimately flow through with qty=0 in some upstream
    // paths. The shipment row is still useful; the items rows record
    // the intent. Rule: non-negative integer.
    const result = await createShipmentForOrder(mock.db as any, 42, null, [
      { id: 1, quantity: 0 },
    ]);
    expect(result.created).toBe(true);
    expect(mock.getInserts().length).toBe(1);
    expect(mock.getExecuteCalls()).toBe(4);
  });
});

// ─── Source constant contract ────────────────────────────────────────

describe("createShipmentForOrder :: source constant", () => {
  it("stamps source='echelon_sync' on every new shipment", async () => {
    const mock = makeMockDb(null, 1);
    await createShipmentForOrder(mock.db as any, 42, null, []);
    const shipmentInsert = mock.getInserts()[0];
    expect(shipmentInsert.values.source).toBe("echelon_sync");
    expect(ECHELON_SYNC_SHIPMENT_SOURCE).toBe("echelon_sync");
  });
});
