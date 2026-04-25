/**
 * Unit tests for processShipNotify V2 path (§6 Commit 15).
 *
 * Scope: exercises `processShipNotify` with `SHIP_NOTIFY_V2=true` via a
 * hand-rolled db mock + fetch mock. No network, no real DB.
 *
 * What this file covers:
 *   - Shipment found by `shipstation_order_id` → dispatches 'shipped'
 *     → rollup runs → OMS updated → event recorded.
 *   - Shipment not found → falls back to the legacy orderKey path
 *     (verified by observing the legacy path's SQL pattern).
 *   - Void detected → dispatches 'voided' (no OMS status change).
 *   - Idempotency: already-shipped with same tracking → no-op.
 *   - Flag-off (default) → legacy path, V2 SQL never runs.
 *
 * What it does NOT cover (left to integration tests per the plan):
 *   - Real partial-shipment rollup with multiple outbound_shipments
 *     rows in a live DB.
 *   - Real OMS → channel tracking push.
 *
 * Design note: we assert on SQL-text fragments produced by the drizzle
 * `sql` template because the per-call SQL is the clearest evidence of
 * "which branch ran". Call-count assertions back that up.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

import { createShipStationService } from "../../shipstation.service";

// ─── Mock helpers ────────────────────────────────────────────────────

interface RecordedCall {
  sqlText: string;
  tag: "execute" | "select" | "update" | "insert";
  target?: string;
}

/**
 * Scripted DB that understands both `db.execute(sql\`...\`)` (raw SQL)
 * and the drizzle query builder surface used by processShipNotifyLegacy
 * (`db.update(...).set(...).where(...)`, `db.insert(...).values(...)`,
 * `db.select().from(...).where(...).limit(...)`).
 *
 * `executeResponses` is a FIFO queue consumed only by `db.execute`.
 * Builder paths just resolve synchronously with an empty shape — the
 * V2 tests don't need their return values, they only assert that the
 * right SQL went out. For the fallback test we still inspect the
 * number of `execute` calls to prove the legacy orderKey path ran.
 */
function makeDb(executeResponses: Array<{ rows: any[] }>) {
  const calls: RecordedCall[] = [];
  const remaining = [...executeResponses];

  const execute = vi.fn(async (query: any) => {
    const chunks: unknown[] = query?.queryChunks ?? [];
    const text = chunks
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && Array.isArray((c as any).value)) {
          return (c as any).value.join("");
        }
        return "";
      })
      .join("");
    calls.push({ sqlText: text, tag: "execute" });
    if (remaining.length === 0) return { rows: [] };
    return remaining.shift()!;
  });

  // Fluent builders. Each `.then()`-resolvable leaf returns [] or the
  // canned omsOrder fixture when we need it; the tests that take the
  // V2 happy path never traverse these leaves.
  const selectLeaf = (rowsProvider?: () => any[]) => {
    const rows = rowsProvider ? rowsProvider() : [];
    const p: any = Promise.resolve(rows);
    p.from = () => p;
    p.where = () => p;
    p.limit = () => p;
    return p;
  };

  const db: any = {
    execute,
    update: (_table: any) => ({
      set: (_vals: any) => ({
        where: (_cond: any) => {
          calls.push({ sqlText: "__update__", tag: "update" });
          return Promise.resolve(undefined);
        },
      }),
    }),
    insert: (_table: any) => ({
      values: (_vals: any) => {
        calls.push({ sqlText: "__insert__", tag: "insert" });
        return Promise.resolve(undefined);
      },
    }),
    select: () => ({
      from: (_t: any) => ({
        where: (_w: any) => ({
          limit: (_n: number) => {
            calls.push({ sqlText: "__select__", tag: "select" });
            return Promise.resolve([]);
          },
        }),
      }),
    }),
  };

  return { db, execute, calls };
}

function mockFetchOnceOk(json: any) {
  return vi.fn(async (_url: string, _init: any) => ({
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
    headers: new Map<string, string>() as any,
  }));
}

const ORIGINAL_FETCH = globalThis.fetch;

const SHIP_DATE = "2026-04-24T12:00:00Z";

function makeShipmentPayload(overrides: Partial<any> = {}) {
  return {
    shipmentId: 77777,
    orderId: 555000, // ShipStation order id
    orderKey: "echelon-wms-shp-501",
    orderNumber: "EB-ABC",
    trackingNumber: "1Z12345",
    carrierCode: "ups",
    serviceCode: "ups_ground",
    shipDate: SHIP_DATE,
    voidDate: null as string | null,
    shipmentCost: 0,
    ...overrides,
  };
}

// ─── V2 flag-on tests ────────────────────────────────────────────────

describe("processShipNotify V2 :: shipment found by shipstation_order_id", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
    process.env.SHIP_NOTIFY_V2 = "true";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.SHIP_NOTIFY_V2;
    vi.restoreAllMocks();
  });

  it("dispatches 'shipped' → rollup → OMS derived update + event", async () => {
    const shipmentPayload = makeShipmentPayload();

    // Execute queue in the exact order the V2 path reads:
    //   1. SS fetch (uses fetch mock, NOT execute)
    //   2. SELECT outbound_shipments WHERE shipstation_order_id
    //   3. dispatchShipmentEvent → markShipmentShipped:
    //        a. SELECT outbound_shipments (load current) by id
    //        b. UPDATE outbound_shipments
    //   4. recomputeOrderStatusFromShipments:
    //        a. SELECT wms.orders
    //        b. SELECT shipment statuses
    //        c. UPDATE wms.orders (because state changes)
    //   5. SELECT wms.orders oms_fulfillment_order_id
    //   6. db.update(omsOrders).set(...).where(...)   — fluent, not execute
    //   7. db.update(omsOrderLines).set(...)          — fluent
    //   8. db.insert(omsOrderEvents).values(...)      — fluent
    const mock = makeDb([
      // 2. shipstation_order_id lookup
      {
        rows: [
          { id: 501, order_id: 42, status: "planned" },
        ],
      },
      // 3a. markShipmentShipped load-current
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            status: "planned",
            tracking_number: null,
            carrier: null,
            tracking_url: null,
          },
        ],
      },
      // 3b. UPDATE outbound_shipments
      { rows: [] },
      // 4a. SELECT wms.orders
      {
        rows: [
          {
            id: 42,
            warehouse_status: "ready_to_ship",
            completed_at: null,
          },
        ],
      },
      // 4b. SELECT shipment statuses
      { rows: [{ status: "shipped" }] },
      // 4c. UPDATE wms.orders
      { rows: [] },
      // 5. SELECT oms_fulfillment_order_id
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
    ]);

    // Fetch mock returns the SS shipment payload for the resourceUrl GET.
    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const svc = createShipStationService(mock.db);
    const processed = await svc.processShipNotify(
      "https://ssapi.shipstation.com/shipments?foo=bar",
    );

    expect(processed).toBe(1);

    // Verify the V2 primary lookup ran.
    const executeSqls = mock.calls
      .filter((c) => c.tag === "execute")
      .map((c) => c.sqlText);
    expect(executeSqls[0]).toMatch(/shipstation_order_id/);

    // Verify OMS was updated via the fluent builder.
    const updateCalls = mock.calls.filter((c) => c.tag === "update");
    // omsOrders update + omsOrderLines update (2 calls).
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);

    // Verify the audit event was inserted.
    const insertCalls = mock.calls.filter((c) => c.tag === "insert");
    expect(insertCalls.length).toBe(1);
  });

  it("handles a voided shipment → dispatches 'voided' (no OMS status change)", async () => {
    const shipmentPayload = makeShipmentPayload({
      voidDate: "2026-04-24T13:00:00Z",
    });

    const mock = makeDb([
      // shipstation_order_id lookup
      {
        rows: [
          { id: 501, order_id: 42, status: "shipped" },
        ],
      },
      // markShipmentVoided load-current
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            status: "shipped",
            tracking_number: "OLD",
            carrier: "UPS",
            tracking_url: null,
          },
        ],
      },
      // UPDATE outbound_shipments → voided
      { rows: [] },
      // recompute: SELECT order
      {
        rows: [
          {
            id: 42,
            warehouse_status: "shipped",
            completed_at: new Date("2026-04-20T00:00:00Z"),
          },
        ],
      },
      // recompute: SELECT shipments
      { rows: [{ status: "voided" }] },
      // recompute: UPDATE order (voided on its own derives to ready_to_ship)
      { rows: [] },
      // SELECT oms_fulfillment_order_id
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
    ]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const svc = createShipStationService(mock.db);
    const processed = await svc.processShipNotify("/foo");

    expect(processed).toBe(1);

    // Void events must NOT write to omsOrders.status (design: a void is
    // not a status change — the shipment can be re-labeled). The OMS
    // update branch for `cancelled` writes one update; for `voided` it
    // writes zero. So the count of `update` builder calls is 0.
    const updateCalls = mock.calls.filter((c) => c.tag === "update");
    expect(updateCalls.length).toBe(0);

    // But the audit event IS written.
    const insertCalls = mock.calls.filter((c) => c.tag === "insert");
    expect(insertCalls.length).toBe(1);
  });

  it("idempotent: already-shipped with same tracking → no-op, no UPDATE, no OMS write", async () => {
    const shipmentPayload = makeShipmentPayload();

    const mock = makeDb([
      // shipstation_order_id lookup
      {
        rows: [
          { id: 501, order_id: 42, status: "shipped" },
        ],
      },
      // markShipmentShipped load-current with SAME tracking + carrier
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            status: "shipped",
            tracking_number: "1Z12345",
            carrier: "UPS",
            tracking_url: null,
          },
        ],
      },
      // No further execute calls should happen.
    ]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const svc = createShipStationService(mock.db);
    const processed = await svc.processShipNotify("/foo");

    expect(processed).toBe(0); // no-op counts as not processed

    // Exactly 2 execute calls: the V2 lookup + the mark-* load-current.
    // No UPDATE, no rollup, no OMS writes.
    const executeSqls = mock.calls.filter((c) => c.tag === "execute");
    expect(executeSqls.length).toBe(2);

    expect(mock.calls.filter((c) => c.tag === "update").length).toBe(0);
    expect(mock.calls.filter((c) => c.tag === "insert").length).toBe(0);
  });

  it("fallback: shipment NOT found by shipstation_order_id → legacy path runs", async () => {
    // Pre-cutover order: orderKey is legacy echelon-oms-<id> AND no
    // shipstation_order_id is set on any outbound_shipments row.
    const shipmentPayload = makeShipmentPayload({
      orderId: 123456,
      orderKey: "echelon-oms-789",
    });

    const mock = makeDb([
      // V2 lookup by shipstation_order_id → not found
      { rows: [] },
      // Legacy path kicks in. The source === "oms" branch reads:
      //   SELECT wms.orders WHERE oms_fulfillment_order_id = '789'
      { rows: [] }, // hasWmsOrder = false → OMS-only path
      // After the OMS-only path, control flow:
      //   db.select().from(omsOrders).where().limit() → returns [] via builder
      // We need the legacy branch to detect missing OMS order and bail
      // early. That means the builder `.select().from(omsOrders)...`
      // resolves to [] which triggers the "neither WMS nor OMS order
      // found" warning and returns { processed: false }.
    ]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const svc = createShipStationService(mock.db);
    const processed = await svc.processShipNotify("/foo");

    expect(processed).toBe(0);

    const executeSqls = mock.calls
      .filter((c) => c.tag === "execute")
      .map((c) => c.sqlText);

    // V2 lookup ran first.
    expect(executeSqls[0]).toMatch(/shipstation_order_id/);
    // Legacy fallback then ran the OMS-by-pointer query.
    expect(executeSqls[1]).toMatch(/oms_fulfillment_order_id/);

    // Proof the legacy path was reached: it used the fluent builder to
    // hit omsOrders select.
    const selectCalls = mock.calls.filter((c) => c.tag === "select");
    expect(selectCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Flag-off behavior ───────────────────────────────────────────────

describe("processShipNotify :: SHIP_NOTIFY_V2 disabled → legacy path", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
    delete process.env.SHIP_NOTIFY_V2;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("does NOT run the V2 shipstation_order_id lookup when flag is off", async () => {
    const shipmentPayload = makeShipmentPayload({
      orderKey: "echelon-oms-789", // forces the legacy OMS branch
    });

    const mock = makeDb([
      // Legacy OMS branch: SELECT wms.orders by oms_fulfillment_order_id
      { rows: [] }, // hasWmsOrder = false
    ]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const svc = createShipStationService(mock.db);
    await svc.processShipNotify("/foo");

    const executeSqls = mock.calls
      .filter((c) => c.tag === "execute")
      .map((c) => c.sqlText);

    // V2 lookup pattern must be absent.
    const anyV2Lookup = executeSqls.some((s) =>
      /shipstation_order_id/.test(s),
    );
    expect(anyV2Lookup).toBe(false);

    // Legacy-path marker IS present.
    const anyLegacyLookup = executeSqls.some((s) =>
      /oms_fulfillment_order_id/.test(s),
    );
    expect(anyLegacyLookup).toBe(true);
  });

  it("flag explicitly set to 'false' runs the legacy path", async () => {
    process.env.SHIP_NOTIFY_V2 = "false";

    const shipmentPayload = makeShipmentPayload({
      orderKey: "echelon-oms-789",
    });
    const mock = makeDb([{ rows: [] }]);
    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const svc = createShipStationService(mock.db);
    await svc.processShipNotify("/foo");

    const executeSqls = mock.calls
      .filter((c) => c.tag === "execute")
      .map((c) => c.sqlText);
    expect(executeSqls.some((s) => /shipstation_order_id/.test(s))).toBe(
      false,
    );
  });

  it("flag set to a random non-'true' value is treated as OFF (safe default)", async () => {
    process.env.SHIP_NOTIFY_V2 = "1"; // not the exact literal "true"

    const shipmentPayload = makeShipmentPayload({
      orderKey: "echelon-oms-789",
    });
    const mock = makeDb([{ rows: [] }]);
    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const svc = createShipStationService(mock.db);
    await svc.processShipNotify("/foo");

    const executeSqls = mock.calls
      .filter((c) => c.tag === "execute")
      .map((c) => c.sqlText);
    expect(executeSqls.some((s) => /shipstation_order_id/.test(s))).toBe(
      false,
    );
  });
});

// ─── V2 error-resilience ─────────────────────────────────────────────

describe("processShipNotify V2 :: error resilience", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
    process.env.SHIP_NOTIFY_V2 = "true";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.SHIP_NOTIFY_V2;
    vi.restoreAllMocks();
  });

  it("swallows per-shipment errors and continues the batch", async () => {
    const good = makeShipmentPayload({ orderId: 1, orderKey: "echelon-wms-shp-1" });
    const broken = makeShipmentPayload({ orderId: 2, orderKey: "echelon-wms-shp-2" });
    const alsoGood = makeShipmentPayload({ orderId: 3, orderKey: "echelon-wms-shp-3" });

    // good → normal happy-path responses (7 execute calls)
    // broken → V2 lookup returns a shipment that triggers an error
    //          in the rollup step (we throw from the UPDATE sql step)
    // alsoGood → normal happy-path again
    const goodPath = [
      { rows: [{ id: 10, order_id: 100, status: "planned" }] },
      {
        rows: [
          {
            id: 10,
            order_id: 100,
            status: "planned",
            tracking_number: null,
            carrier: null,
            tracking_url: null,
          },
        ],
      },
      { rows: [] },
      {
        rows: [
          { id: 100, warehouse_status: "ready_to_ship", completed_at: null },
        ],
      },
      { rows: [{ status: "shipped" }] },
      { rows: [] },
      { rows: [{ oms_fulfillment_order_id: "200" }] },
    ];

    // Broken path: V2 lookup finds the shipment, then the mark-shipped
    // UPDATE throws. The outer try/catch must swallow and continue.
    const brokenPath = [
      { rows: [{ id: 11, order_id: 101, status: "planned" }] },
      {
        rows: [
          {
            id: 11,
            order_id: 101,
            status: "planned",
            tracking_number: null,
            carrier: null,
            tracking_url: null,
          },
        ],
      },
      // Next execute should be the UPDATE; instead we let the mock
      // trigger an error by leaving the queue short AND patching
      // execute to throw on the very next call. We'll handle this by
      // using a custom mock variant below.
    ];

    const alsoGoodPath: Array<{ rows: any[] }> = [
      { rows: [{ id: 12, order_id: 102, status: "planned" }] },
      {
        rows: [
          {
            id: 12,
            order_id: 102,
            status: "planned",
            tracking_number: null,
            carrier: null,
            tracking_url: null,
          },
        ],
      },
      { rows: [] },
      {
        rows: [
          { id: 102, warehouse_status: "ready_to_ship", completed_at: null },
        ],
      },
      { rows: [{ status: "shipped" }] },
      { rows: [] },
      { rows: [{ oms_fulfillment_order_id: "202" }] },
    ];

    // Custom db: first 7 execute calls take from goodPath, next 3 from
    // brokenPath (with the 3rd throwing), remainder from alsoGoodPath.
    const goodQ = [...goodPath];
    const brokenQ = [...brokenPath];
    const alsoGoodQ = [...alsoGoodPath];
    const calls: RecordedCall[] = [];
    const execute = vi.fn(async (query: any) => {
      const chunks: unknown[] = query?.queryChunks ?? [];
      const text = chunks
        .map((c) => {
          if (typeof c === "string") return c;
          if (c && typeof c === "object" && Array.isArray((c as any).value)) {
            return (c as any).value.join("");
          }
          return "";
        })
        .join("");
      calls.push({ sqlText: text, tag: "execute" });
      if (goodQ.length > 0) return goodQ.shift()!;
      if (brokenQ.length > 0) return brokenQ.shift()!;
      if (brokenQ.length === 0 && calls.length === goodPath.length + brokenPath.length + 1) {
        throw new Error("simulated DB failure on UPDATE");
      }
      if (alsoGoodQ.length > 0) return alsoGoodQ.shift()!;
      return { rows: [] };
    });
    const db: any = {
      execute,
      update: (_: any) => ({
        set: (_v: any) => ({
          where: (_w: any) => {
            calls.push({ sqlText: "__update__", tag: "update" });
            return Promise.resolve(undefined);
          },
        }),
      }),
      insert: (_: any) => ({
        values: (_v: any) => {
          calls.push({ sqlText: "__insert__", tag: "insert" });
          return Promise.resolve(undefined);
        },
      }),
      select: () => ({
        from: (_t: any) => ({
          where: (_w: any) => ({
            limit: (_n: number) => {
              calls.push({ sqlText: "__select__", tag: "select" });
              return Promise.resolve([]);
            },
          }),
        }),
      }),
    };

    globalThis.fetch = mockFetchOnceOk({
      shipments: [good, broken, alsoGood],
    }) as any;

    const svc = createShipStationService(db);
    const processed = await svc.processShipNotify("/foo");

    // good + alsoGood processed; broken swallowed.
    expect(processed).toBe(2);
  });
});
