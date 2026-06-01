/**
 * C2 Phase 2 tests: tx-aware OMS→WMS sync pipeline.
 *
 * Validates that:
 * 1. createShipmentForOrder uses pg_advisory_xact_lock when useXactLock is set
 * 2. ReservationService.reserveOrder/reserveForOrder thread dbOverride
 * 3. ordersStorage.createOrderWithItems uses txOverride when provided
 * 4. The sync pipeline passes a transaction handle through all three steps
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WMS_SYNC_SRC = readFileSync(
  fileURLToPath(new URL("../../wms-sync.service.ts", import.meta.url)),
  "utf8",
);
const CREATE_SHIPMENT_SRC = readFileSync(
  fileURLToPath(
    new URL("../../../wms/create-shipment.ts", import.meta.url),
  ),
  "utf8",
);
const RESERVATION_SRC = readFileSync(
  fileURLToPath(
    new URL("../../../channels/reservation.service.ts", import.meta.url),
  ),
  "utf8",
);
const INVENTORY_SRC = readFileSync(
  fileURLToPath(
    new URL(
      "../../../inventory/application/inventory.use-cases.ts",
      import.meta.url,
    ),
  ),
  "utf8",
);
const ORDERS_STORAGE_SRC = readFileSync(
  fileURLToPath(
    new URL("../../../orders/orders.storage.ts", import.meta.url),
  ),
  "utf8",
);

// ─── Structural: source-level contract verification ─────────────────

describe("C2 Phase 2: tx-aware pipeline structural checks", () => {
  it("syncOmsOrderToWms wraps steps 5-6 in db.transaction()", () => {
    expect(WMS_SYNC_SRC).toContain("db.transaction(async (tx");
  });

  it("syncOmsOrderToWms passes tx to createOrderWithItems", () => {
    expect(WMS_SYNC_SRC).toContain(
      "ordersStorage.createOrderWithItems(wmsOrderData, wmsLineItems, tx)",
    );
  });

  it("syncOmsOrderToWms passes tx to createShipmentForOrder with useXactLock", () => {
    expect(WMS_SYNC_SRC).toContain("tx as any,");
    expect(WMS_SYNC_SRC).toContain("{ useXactLock: true }");
  });

  it("syncOmsOrderToWms passes tx to reservation.reserveOrder", () => {
    expect(WMS_SYNC_SRC).toContain(
      "this.services.reservation.reserveOrder(newWmsOrder.id, undefined, tx)",
    );
  });

  it("createShipmentForOrder accepts useXactLock option", () => {
    expect(CREATE_SHIPMENT_SRC).toContain("useXactLock");
    expect(CREATE_SHIPMENT_SRC).toContain("pg_advisory_xact_lock");
  });

  it("createShipmentForOrder skips pg_advisory_unlock when useXactLock is true", () => {
    const xactBlock = CREATE_SHIPMENT_SRC.substring(
      CREATE_SHIPMENT_SRC.indexOf("if (options?.useXactLock)"),
      CREATE_SHIPMENT_SRC.indexOf(
        "await db.execute(sql`SELECT pg_advisory_lock(",
      ),
    );
    expect(xactBlock).toContain("pg_advisory_xact_lock");
    expect(xactBlock).not.toContain("pg_advisory_unlock");
  });

  it("ReservationService.reserveForOrder accepts dbOverride parameter", () => {
    expect(RESERVATION_SRC).toContain("dbOverride?: any");
    expect(RESERVATION_SRC).toContain("dbOverride ?? this.db");
  });

  it("ReservationService.reserveOrder accepts dbOverride parameter", () => {
    const reserveOrderSig = RESERVATION_SRC.match(
      /async reserveOrder\([^)]+\)/,
    );
    expect(reserveOrderSig).not.toBeNull();
    expect(reserveOrderSig![0]).toContain("dbOverride");
  });

  it("ReservationService.reserveOrder passes dbOverride to reserveForOrder", () => {
    const callSite = RESERVATION_SRC.match(
      /await this\.reserveForOrder\([^)]+dbOverride[^)]*\)/,
    );
    expect(callSite).not.toBeNull();
  });

  it("ReservationService.reserveForOrder passes dbOverride to inventoryCore.reserveForOrder", () => {
    expect(RESERVATION_SRC).toContain(
      "}, dbOverride);",
    );
  });

  it("inventoryCore.reserveForOrder accepts txOverride parameter", () => {
    expect(INVENTORY_SRC).toContain("txOverride?: any");
    expect(INVENTORY_SRC).toContain("txOverride");
  });

  it("createOrderWithItems accepts txOverride parameter", () => {
    expect(ORDERS_STORAGE_SRC).toContain("txOverride?: any");
    const fnBody = ORDERS_STORAGE_SRC.substring(
      ORDERS_STORAGE_SRC.indexOf("async createOrderWithItems"),
    );
    expect(fnBody).toContain("if (txOverride)");
    expect(fnBody).toContain("return create(txOverride)");
  });
});

// ─── Behavioral: createShipmentForOrder useXactLock ─────────────────

import { createShipmentForOrder } from "../../../wms/create-shipment";

function isAdvisoryLockQuery(query: any): boolean {
  try {
    const str = JSON.stringify(query);
    return (
      str.includes("pg_advisory_lock") ||
      str.includes("pg_advisory_unlock") ||
      str.includes("pg_advisory_xact_lock")
    );
  } catch {
    return String(query).includes("advisory");
  }
}

function isXactLockQuery(query: any): boolean {
  try {
    return JSON.stringify(query).includes("pg_advisory_xact_lock");
  } catch {
    return String(query).includes("pg_advisory_xact_lock");
  }
}

function isUnlockQuery(query: any): boolean {
  try {
    return JSON.stringify(query).includes("pg_advisory_unlock");
  } catch {
    return String(query).includes("pg_advisory_unlock");
  }
}

function makeMockDb(newShipmentId = 12345) {
  const executeCalls: any[] = [];

  const execute = vi.fn(async (query: any) => {
    executeCalls.push(query);
    if (isAdvisoryLockQuery(query)) {
      return { rows: [{}] };
    }
    return { rows: [] };
  });

  const inserts: any[] = [];

  function insert(table: any) {
    const record: any = { table };
    inserts.push(record);
    const chain: any = {
      values(vals: any) {
        record.values = vals;
        return chain;
      },
      returning(_shape?: any) {
        record.returning = true;
        return Promise.resolve([{ id: newShipmentId }]);
      },
      then(resolve: any, reject?: any) {
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    db: { execute, insert: vi.fn(insert) },
    executeCalls,
    inserts,
  };
}

describe("createShipmentForOrder :: useXactLock option", () => {
  it("uses pg_advisory_xact_lock and skips unlock when useXactLock=true", async () => {
    const mock = makeMockDb(9001);
    await createShipmentForOrder(
      mock.db as any,
      42,
      7,
      [{ id: 101, quantity: 2 }],
      { useXactLock: true },
    );

    const lockCalls = mock.executeCalls.filter((q) => isAdvisoryLockQuery(q));
    const xactCalls = lockCalls.filter((q) => isXactLockQuery(q));
    const unlockCalls = lockCalls.filter((q) => isUnlockQuery(q));

    expect(xactCalls.length).toBe(1);
    expect(unlockCalls.length).toBe(0);
  });

  it("uses session-level pg_advisory_lock/unlock when useXactLock is not set", async () => {
    const mock = makeMockDb(9002);
    await createShipmentForOrder(mock.db as any, 43, 7, [
      { id: 102, quantity: 1 },
    ]);

    const lockCalls = mock.executeCalls.filter((q) => isAdvisoryLockQuery(q));
    const xactCalls = lockCalls.filter((q) => isXactLockQuery(q));
    const unlockCalls = lockCalls.filter((q) => isUnlockQuery(q));

    expect(xactCalls.length).toBe(0);
    expect(unlockCalls.length).toBe(1);
  });

  it("uses session-level lock when useXactLock is explicitly false", async () => {
    const mock = makeMockDb(9003);
    await createShipmentForOrder(
      mock.db as any,
      44,
      7,
      [{ id: 103, quantity: 1 }],
      { useXactLock: false },
    );

    const lockCalls = mock.executeCalls.filter((q) => isAdvisoryLockQuery(q));
    const unlockCalls = lockCalls.filter((q) => isUnlockQuery(q));

    expect(unlockCalls.length).toBe(1);
  });
});

// ─── Behavioral: ReservationService dbOverride ──────────────────────

import { createReservationService } from "../../../channels/reservation.service";

describe("ReservationService :: dbOverride threading", () => {
  function makeServiceWithSpies() {
    const mainDbCalls: string[] = [];
    const overrideDbCalls: string[] = [];

    function makeThenableResult(data: any[] = []) {
      const result: any = {
        orderBy: vi.fn(() => makeThenableResult(data)),
        limit: vi.fn(() => Promise.resolve(data)),
        then(resolve: any, reject?: any) {
          return Promise.resolve(data).then(resolve, reject);
        },
      };
      return result;
    }

    function makeDbSpy(label: string, callLog: string[]) {
      return {
        select: vi.fn(() => {
          callLog.push(`${label}:select`);
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => makeThenableResult([])),
            })),
          };
        }),
        insert: vi.fn(() => {
          callLog.push(`${label}:insert`);
          return { values: vi.fn(() => Promise.resolve([])) };
        }),
        update: vi.fn(() => {
          callLog.push(`${label}:update`);
          return { set: vi.fn(() => ({ where: vi.fn() })) };
        }),
        delete: vi.fn(() => {
          callLog.push(`${label}:delete`);
          return { where: vi.fn() };
        }),
        transaction: vi.fn((fn: any) => fn(makeDbSpy(`${label}:tx`, callLog))),
      };
    }

    const mainDb = makeDbSpy("main", mainDbCalls);
    const overrideDb = makeDbSpy("override", overrideDbCalls);

    const inventoryCore = {
      reserveForOrder: vi.fn(async () => true),
    };

    const channelSync = {
      queueSyncAfterInventoryChange: vi.fn(async () => {}),
    };

    const atpService = {
      getAtpPerVariant: vi.fn(async () => []),
    };

    const service = createReservationService(
      mainDb as any,
      inventoryCore,
      channelSync,
      atpService,
    );

    return {
      service,
      mainDb,
      overrideDb,
      mainDbCalls,
      overrideDbCalls,
      inventoryCore,
    };
  }

  it("reserveOrder uses dbOverride for item queries when provided", async () => {
    const { service, mainDbCalls, overrideDbCalls, overrideDb } =
      makeServiceWithSpies();

    await service.reserveOrder(123, undefined, overrideDb as any);

    expect(overrideDbCalls.some((c) => c.startsWith("override:"))).toBe(true);
    expect(
      mainDbCalls.filter((c) => c.startsWith("main:select")).length,
    ).toBe(0);
  });

  it("reserveOrder uses this.db when dbOverride is undefined", async () => {
    const { service, mainDbCalls, overrideDbCalls } = makeServiceWithSpies();

    await service.reserveOrder(456);

    expect(mainDbCalls.some((c) => c.startsWith("main:"))).toBe(true);
    expect(overrideDbCalls.length).toBe(0);
  });

  it("reserveForOrder passes dbOverride through to inventoryCore.reserveForOrder", async () => {
    const { service, inventoryCore } = makeServiceWithSpies();
    const overrideDbCalls: string[] = [];

    function makeThenableResult(data: any[] = []) {
      const result: any = {
        orderBy: vi.fn(() => makeThenableResult(data)),
        limit: vi.fn(() => Promise.resolve(data)),
        then(resolve: any, reject?: any) {
          return Promise.resolve(data).then(resolve, reject);
        },
      };
      return result;
    }

    const overrideDb = {
      select: vi.fn(() => {
        overrideDbCalls.push("override:select");
        const chainable: any = {
          from: vi.fn(() => chainable),
          innerJoin: vi.fn(() => chainable),
          where: vi.fn(() => makeThenableResult([{ warehouseLocationId: 1 }])),
        };
        return chainable;
      }),
    };

    const atpService = (service as any).atpService;
    atpService.getAtpPerVariant.mockResolvedValue([
      { productVariantId: 10, atpUnits: 5, sku: "TEST-SKU" },
    ]);

    await (service as any).reserveForOrder(
      1, 10, 2, 100, 200, undefined, overrideDb,
    );

    expect(inventoryCore.reserveForOrder).toHaveBeenCalledTimes(1);
    const [_params, txArg] = inventoryCore.reserveForOrder.mock.calls[0];
    expect(txArg).toBe(overrideDb);
  });
});
