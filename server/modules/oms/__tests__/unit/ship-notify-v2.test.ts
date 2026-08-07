/**
 * Unit tests for processShipNotify V2 path (§6 Commit 15).
 *
 * Scope: exercises `processShipNotify` via a hand-rolled db mock +
 * fetch mock. No network, no real DB.
 *
 * What this file covers:
 *   - Shipment found by `shipstation_order_id` → records operational shipment
 *     evidence → hands one physical package to canonical fulfillment authority.
 *   - Shipment not found → falls back to the legacy orderKey path
 *     (verified by observing the legacy path's SQL pattern).
 *   - Void detected → dispatches 'voided' (no OMS status change).
 *   - Idempotency: already-shipped with the same tracking replays through the
 *     same canonical authority boundary without direct OMS writes.
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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createShipStationService } from "../../shipstation.service";

// ─── Mock helpers ────────────────────────────────────────────────────

interface RecordedCall {
  sqlText: string;
  tag: "execute" | "select" | "update" | "insert";
  target?: string;
  values?: any;
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
  const fulfillmentAuthority = {
    recordPhysicalPackage: vi.fn(async () => ({
      materialized: {
        physicalShipmentId: 90001,
        shippingEngineOrderId: 80001,
        channelCommands: [
          { id: 70001, pushStatus: "pending" },
        ],
        customerFulfillmentItemCount: 1,
        nonCustomerItemCount: 0,
      },
      dispatch: {
        claimed: 0,
        succeeded: 0,
        ignored: 0,
        retryScheduled: 0,
        reviewRequired: 0,
        deadLettered: 0,
      },
    })),
    ensureLegacyShipment: vi.fn(),
    projectPhysicalPackage: vi.fn(),
    runDueBatch: vi.fn(),
  };
  const providerLabelObserver = {
    observeShipStationLabel: vi.fn().mockResolvedValue({
      shippingProviderLabelId: 60001,
      labelInserted: true,
      eventInserted: true,
    }),
  };

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
    if (
      text.includes("WITH candidates AS")
      && text.includes("UPDATE wms.reconciliation_exceptions")
    ) {
      return { rows: [] };
    }
    if (text.includes("AS has_positive_item_authority")) {
      return { rows: [{ has_positive_item_authority: true }] };
    }
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
        calls.push({ sqlText: "__insert__", tag: "insert", values: _vals });
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

  return {
    db,
    execute,
    calls,
    fulfillmentAuthority,
    providerLabelObserver,
  };
}

function createTestShipStationService(mock: ReturnType<typeof makeDb>, inventoryCore?: any) {
  return createShipStationService(mock.db, inventoryCore, {
    fulfillmentAuthority: mock.fulfillmentAuthority as any,
    providerLabelObserver: mock.providerLabelObserver as any,
  });
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
    isReturnLabel: false,
    shipmentCost: 0,
    ...overrides,
  };
}

function makeDispatchInput(overrides: Partial<any> = {}) {
  return {
    commandId: 701,
    shippingProviderLabelId: 60001,
    carrierTrackingEventId: 101,
    provider: "shipstation",
    providerLabelId: "77777",
    providerOrderId: "555000",
    providerOrderKey: "echelon-wms-shp-501",
    trackingNumber: "1Z12345",
    normalizedTrackingNumber: "1Z12345",
    carrier: "ups",
    serviceCode: "ups_ground",
    dispatchOccurredAt: new Date("2026-04-24T15:30:00.000Z"),
    ...overrides,
  };
}

// ─── V2 tests ───────────────────────────────────────────────────────

async function processTestShipment(
  mock: ReturnType<typeof makeDb>,
  shipment: ReturnType<typeof makeShipmentPayload>,
  inventoryCore?: any,
): Promise<number> {
  const result = await createTestShipStationService(
    mock,
    inventoryCore,
  ).processManualShipmentNotification(shipment, {
    operator: "test:ship-notify-v2",
    reason: "unit_test",
  });
  return result.processed ? 1 : 0;
}

describe("processShipNotify V2 :: shipment found by shipstation_order_id", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("dispatches shipped evidence to canonical authority without direct fulfillment writes", async () => {
    const shipmentPayload = makeShipmentPayload({ shipmentCost: 5.99 });

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
      // 4. SELECT oms_fulfillment_order_id
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
      // finality guard
      { rows: [{ status: "confirmed", financial_status: "paid" }] },
    ]);

    // Fetch mock returns the SS shipment payload for the resourceUrl GET.
    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const processed = await processTestShipment(mock, shipmentPayload);

    expect(processed).toBe(1);

    // Verify the V2 primary lookup ran.
    const executeSqls = mock.calls
      .filter((c) => c.tag === "execute")
      .map((c) => c.sqlText);
    expect(executeSqls[0]).toMatch(/shipstation_order_id/);
    expect(executeSqls.some((text) => text.includes("carrier_cost_cents = CASE"))).toBe(true);
    expect(executeSqls.some((text) => text.includes("service_code = COALESCE"))).toBe(true);

    // ShipStation is not an OMS/WMS fulfillment writer. Projection belongs to
    // the canonical authority invoked below.
    const updateCalls = mock.calls.filter((c) => c.tag === "update");
    expect(updateCalls).toHaveLength(0);
    expect(executeSqls.some((text) => text.includes("shipped_by_line"))).toBe(false);
    expect(executeSqls.some((text) => text.includes("UPDATE oms.oms_order_lines"))).toBe(false);
    expect(
      executeSqls.some((text) => text.includes("UPDATE wms.reconciliation_exceptions")),
    ).toBe(true);

    // The callback records one audit event and hands the physical package to
    // canonical authority. It must not enqueue a second legacy retry row.
    const insertCalls = mock.calls.filter((c) => c.tag === "insert");
    expect(insertCalls.length).toBe(1);
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyWmsShipmentIds: [501],
        shippingProvider: "shipstation",
        providerPhysicalShipmentId: "77777",
        providerOrderId: "555000",
        trackingNumber: "1Z12345",
        legacyHeaderPolicy: "aggregate_projection",
      }),
      { executeImmediately: false },
    );
  });

  it("quarantines an unmapped provider-first shell when ShipStation omits package contents", async () => {
    const shipmentPayload = makeShipmentPayload({ shipmentItems: [] });
    const mock = makeDb([{
      rows: [{
        id: 5034,
        order_id: 203878,
        status: "shipped",
        source: "shipstation_split",
        shipment_purpose: "customer_fulfillment",
        requires_review: true,
        external_fulfillment_id: "shipstation_shipment:77777",
        tracking_number: "1Z12345",
      }],
    }]);
    globalThis.fetch = mockFetchOnceOk({ shipments: [shipmentPayload] }) as any;

    const processed = await processTestShipment(mock, shipmentPayload);

    expect(processed).toBe(0);
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).not.toHaveBeenCalled();
    const sqlText = mock.calls.map((call) => call.sqlText).join("\n");
    expect(sqlText).toContain("INSERT INTO wms.reconciliation_exceptions");
    expect(sqlText).toContain("shipstation_unmapped_physical_shipment");
  });

  it("records a post-refund package for review without direct OMS or provider writes", async () => {
    const shipmentPayload = makeShipmentPayload();
    const mock = makeDb([
      // shipstation_order_id lookup
      { rows: [{ id: 501, order_id: 42, status: "queued" }] },
      // markShipmentShipped load-current
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            status: "queued",
            tracking_number: null,
            carrier: null,
            tracking_url: null,
          },
        ],
      },
      // UPDATE outbound_shipments -> shipped
      { rows: [] },
      // resolve OMS id
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
      // finality guard
      { rows: [{ status: "shipped", financial_status: "refunded" }] },
      // mark shipment review
      { rows: [] },
    ]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const processed = await processTestShipment(mock, shipmentPayload);

    expect(processed).toBe(1);

    const updateCalls = mock.calls.filter((c) => c.tag === "update");
    expect(updateCalls.length).toBe(0);

    const insertCalls = mock.calls.filter((c) => c.tag === "insert");
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls.map((call) => call.values.eventType)).toContain(
      "shipstation_shipped_after_final_order",
    );

    const sqlText = mock.calls.map((c) => c.sqlText).join("\n");
    expect(sqlText).toMatch(/review_reason/);
    expect(sqlText).toMatch(/shipstation_shipped_after_refund/);
    expect(sqlText).not.toMatch(/shipped_by_line/);
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyWmsShipmentIds: [501],
        providerPhysicalShipmentId: "77777",
        trackingNumber: "1Z12345",
      }),
      { executeImmediately: false },
    );
  });

  it("rejects non-ShipStation resource URLs before fetch", async () => {
    const mock = makeDb([]);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    const svc = createTestShipStationService(mock);

    await expect(
      svc.processShipNotify("https://attacker.example/shipments?foo=bar"),
    ).rejects.toThrow(/resource_url host is not allowed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles a voided shipment → dispatches 'voided' (no OMS status change)", async () => {
    const shipmentPayload = makeShipmentPayload({
      voidDate: "2026-04-24T13:00:00Z",
      // Void targets the shipment's CURRENT label of record ("OLD"), so the
      // label-of-record guard lets it through. A void carrying a DIFFERENT
      // tracking (a superseded label) is skipped — covered in
      // shipment-rollup.test.ts.
      trackingNumber: "OLD",
    });

    const mock = makeDb([
      // Resolve any prior unmapped-package exception for the voided label.
      { rows: [] },
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

    const processed = await processTestShipment(mock, shipmentPayload);

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

  it("repairs an exact package replay even when its historical provider line key is obsolete", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentItems: [
        { lineItemKey: "wms-item-8502", sku: "SPORTS-CARD", quantity: 1 },
      ],
    });

    const mock = makeDb([
      // The provider physical shipment identity is already canonical.
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            status: "shipped",
            external_fulfillment_id: "shipstation_shipment:77777",
            tracking_number: "1Z12345",
          },
        ],
      },
      // The historical provider line key no longer resolves. Exact package
      // identity must prevent this stale key from creating a fake split.
      { rows: [] },
      // Resolve any previously-open unmapped-package exception.
      { rows: [{ id: 328 }] },
      // markShipmentShipped load-current with SAME tracking + carrier
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            status: "shipped",
            tracking_number: "1Z12345",
            carrier: "UPS",
            service_code: "ups_ground",
            tracking_url: null,
          },
        ],
      },
      // resolve OMS id.
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
      // finality guard.
      { rows: [{ status: "confirmed", financial_status: "paid" }] },
    ]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const processed = await processTestShipment(mock, shipmentPayload);

    expect(processed).toBe(1);

    const executeSqls = mock.calls.filter((c) => c.tag === "execute");
    const allSql = executeSqls.map((c) => c.sqlText).join("\n");
    expect(allSql).not.toMatch(/UPDATE oms\.oms_order_lines/);
    expect(allSql).not.toMatch(/UPDATE wms\.orders/);
    expect(allSql).not.toMatch(/INSERT INTO wms\.reconciliation_exceptions/);
    expect(allSql).not.toMatch(/requested_items/);
    expect(allSql).toContain("resolve_exact_provider_package_replay");

    // No duplicate legacy writer is emitted because status/tracking already
    // match, but canonical projection still gets a repair attempt.
    expect(mock.calls.filter((c) => c.tag === "update")).toHaveLength(0);
    expect(mock.calls.filter((c) => c.tag === "insert").length).toBe(1);
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyWmsShipmentIds: [501],
        providerPhysicalShipmentId: "77777",
        trackingNumber: "1Z12345",
      }),
      { executeImmediately: false },
    );
  });

  it("ignores ShipStation split/package edits that are not shipped", async () => {
    const splitButNotShipped = makeShipmentPayload({
      shipmentId: 7001,
      orderId: 88001,
      orderKey: "echelon-wms-shp-501",
      trackingNumber: "",
      shipDate: null,
      voidDate: null,
      shipmentItems: [
        { lineItemKey: "wms-item-10001", sku: "SKU-A", quantity: 1 },
      ],
    });

    const mock = makeDb([]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [splitButNotShipped],
    }) as any;

    const processed = await processTestShipment(mock, splitButNotShipped);

    expect(processed).toBe(0);
    const sqlText = mock.calls.map((c) => c.sqlText).join("\n");
    expect(sqlText).not.toMatch(/FROM wms\.outbound_shipments/);
    expect(sqlText).not.toMatch(/UPDATE wms\.order_items/);
    expect(sqlText).not.toMatch(/UPDATE wms\.orders/);
    expect(sqlText).not.toMatch(/INSERT INTO wms\.outbound_shipment_items/);
    expect(sqlText).not.toMatch(/INSERT INTO wms\.reconciliation_exceptions/);
  });

  it("applies shipped split quantities to WMS order_items without completing the remaining quantity", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 7001,
      orderId: 555000,
      orderKey: "echelon-wms-shp-501",
      shipmentItems: [
        { lineItemKey: "wms-item-10001", sku: "SKU-A", quantity: 1 },
      ],
    });
    const inventoryCore = {
      recordShipment: vi.fn(async () => undefined),
    };

    const mock = makeDb([
      // Physical ShipStation shipment id lookup -> not found.
      { rows: [] },
      // Parent WMS shipment referenced by orderKey.
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            channel_id: 7,
            status: "planned",
            shipstation_order_id: 555000,
            shipstation_order_key: "echelon-wms-shp-501",
            external_fulfillment_id: null,
          },
        ],
      },
      // Parent item qty is larger than this physical package, so this must
      // become a child shipment instead of mutating the parent item to qty=1.
      { rows: [{ id: 10001, qty: 3 }] },
      // Transaction-scoped advisory lock for the parent WMS order.
      { rows: [] },
      // Post-lock external id dedup guard -> still not found.
      { rows: [] },
      // Parent is still active after taking its row lock.
      { rows: [{ id: 501, status: "planned" }] },
      // INSERT child wms.outbound_shipments with source=shipstation_split.
      { rows: [{ id: 9001, order_id: 42, status: "queued", shipstation_order_id: 555000 }] },
      // Lock the parent source quantity.
      { rows: [{ id: 10001, qty: 3 }] },
      // Insert the physical child quantity from the parent authority row.
      { rows: [{ id: 11001 }] },
      // Reduce the parent remainder from 3 to 2.
      { rows: [{ id: 10001 }] },
      // Combined-shipment source item order grouping.
      { rows: [{ source_shipment_item_id: 10001, wms_order_id: 42 }] },
      // Child owns only the physical quantity while the source ID remains on the parent.
      {
        rows: [{
          id: 11001,
          order_item_id: 30001,
          replacement_for_order_item_id: null,
          shipment_item_purpose: "customer_fulfillment",
          product_variant_id: 40001,
          qty: 1,
        }],
      },
      // Reload the authoritative item for location and package metadata.
      {
        rows: [
          {
            id: 10001,
            order_item_id: 30001,
            product_variant_id: 40001,
            from_location_id: 50001,
            box_id: null,
            weight_oz: 4,
          },
        ],
      },
      // Refresh quantity/location/tracking on the physical child item.
      { rows: [] },
      // loadValidatedInventoryShipmentItems.
      {
        rows: [
          {
            id: 11001,
            order_item_id: 30001,
            product_variant_id: 40001,
            qty: 1,
            pick_location_id: 50001,
          },
        ],
      },
      // self-heal: clear inventory_deduction_missing_item_data flag.
      { rows: [] },
      // markShipmentShipped load-current.
      {
        rows: [
          {
            id: 9001,
            order_id: 42,
            status: "queued",
            tracking_number: null,
            carrier: null,
            tracking_url: null,
          },
        ],
      },
      // UPDATE outbound_shipments.
      { rows: [] },
      // resolve OMS id.
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
      // finality guard.
      { rows: [{ status: "confirmed", financial_status: "paid" }] },
    ]);
    mock.db.transaction = vi.fn(async (work: (tx: any) => Promise<unknown>) => (
      work(mock.db)
    ));

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const processed = await processTestShipment(mock, shipmentPayload, inventoryCore);

    expect(processed).toBe(1);
    expect(inventoryCore.recordShipment).toHaveBeenCalledWith(expect.objectContaining({
      orderItemId: 30001,
      shipmentItemId: 11001,
      qty: 1,
      shipmentId: "9001",
    }));
    const sqlText = mock.calls.map((c) => c.sqlText).join("\n");
    expect(sqlText).toMatch(/shipstation_split/);
    expect(sqlText).toMatch(/INSERT INTO wms\.outbound_shipment_items[\s\S]*shipment_item_purpose/);
    expect(sqlText).toMatch(/SET qty = qty -/);
    expect(sqlText).not.toMatch(/SET shipment_id/);
    // Split creation and physical item synchronization are separate atomic
    // units; both must roll back independently on a failed invariant.
    expect(mock.db.transaction).toHaveBeenCalledTimes(2);
    expect(sqlText).not.toMatch(/fulfilled_quantity = LEAST\(/);
    expect(sqlText).not.toMatch(/picked_quantity = LEAST\(/);
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyWmsShipmentIds: [9001],
        providerPhysicalShipmentId: "7001",
      }),
      { executeImmediately: false },
    );
  });

  it("moves a whole shipment item into a physical split without writing zero quantity", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 7003,
      orderId: 555003,
      orderKey: "echelon-wms-shp-501",
      shipmentItems: [
        { lineItemKey: "wms-item-10001", sku: "SKU-A", quantity: 1 },
      ],
    });
    const inventoryCore = {
      recordShipment: vi.fn(async () => undefined),
    };

    const mock = makeDb([
      { rows: [] },
      {
        rows: [{
          id: 501,
          order_id: 42,
          channel_id: 7,
          status: "planned",
          shipstation_order_id: 555003,
          shipstation_order_key: "echelon-wms-shp-501",
          external_fulfillment_id: null,
        }],
      },
      // The physical package contains one complete line while another line
      // remains on the parent shipment.
      { rows: [{ id: 10001, qty: 1 }, { id: 10002, qty: 1 }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ id: 501, status: "planned" }] },
      { rows: [{ id: 9001, order_id: 42, status: "queued", shipstation_order_id: 555003 }] },
      { rows: [{ id: 10001, qty: 1 }] },
      // Move the stable item row to the physical child.
      { rows: [{ id: 10001 }] },
      { rows: [{ source_shipment_item_id: 10001, wms_order_id: 42 }] },
      {
        rows: [{
          id: 10001,
          order_item_id: 30001,
          replacement_for_order_item_id: null,
          shipment_item_purpose: "customer_fulfillment",
          product_variant_id: 40001,
          qty: 1,
        }],
      },
      {
        rows: [{
          id: 10001,
          order_item_id: 30001,
          product_variant_id: 40001,
          from_location_id: 50001,
          box_id: null,
          weight_oz: 4,
        }],
      },
      { rows: [] },
      {
        rows: [{
          id: 10001,
          order_item_id: 30001,
          product_variant_id: 40001,
          qty: 1,
          pick_location_id: 50001,
        }],
      },
      { rows: [] },
      {
        rows: [{
          id: 9001,
          order_id: 42,
          status: "queued",
          tracking_number: null,
          carrier: null,
          tracking_url: null,
        }],
      },
      { rows: [] },
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
      { rows: [{ status: "confirmed", financial_status: "paid" }] },
    ]);
    mock.db.transaction = vi.fn(async (work: (tx: any) => Promise<unknown>) => (
      work(mock.db)
    ));

    globalThis.fetch = mockFetchOnceOk({ shipments: [shipmentPayload] }) as any;

    const processed = await processTestShipment(mock, shipmentPayload, inventoryCore);

    expect(processed).toBe(1);
    expect(inventoryCore.recordShipment).toHaveBeenCalledWith(expect.objectContaining({
      orderItemId: 30001,
      shipmentItemId: 10001,
      qty: 1,
      shipmentId: "9001",
    }));
    const sqlText = mock.calls.map((call) => call.sqlText).join("\n");
    expect(sqlText).toMatch(/SET shipment_id =/);
    expect(sqlText).not.toMatch(/SET qty = qty -/);
    expect(sqlText).not.toMatch(/SET qty = 0/);
    expect(sqlText).not.toMatch(/INSERT INTO wms\.outbound_shipment_items/);
  });

  it("matches ShipStation shipment items by exact SKU/qty when lineItemKey is missing", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 7002,
      orderId: 555001,
      orderKey: "echelon-wms-shp-501",
      shipmentItems: [
        { lineItemKey: null, sku: "SKU-A", quantity: 1 },
      ],
    });
    const inventoryCore = {
      recordShipment: vi.fn(async () => undefined),
    };

    const mock = makeDb([
      { rows: [{ id: 501, order_id: 42, status: "planned", shipstation_order_id: 555001 }] },
      {
        rows: [
          { id: 10001, order_item_id: 30001, sku: "SKU-A", qty: 1 },
        ],
      },
      {
        rows: [
          {
            id: 10001,
            order_item_id: 30001,
            product_variant_id: 40001,
            from_location_id: 50001,
            box_id: null,
            weight_oz: 4,
          },
        ],
      },
      { rows: [] },
      {
        rows: [
          {
            id: 10001,
            order_item_id: 30001,
            product_variant_id: 40001,
            qty: 1,
            pick_location_id: 50001,
          },
        ],
      },
      // self-heal: clear inventory_deduction_missing_item_data flag.
      { rows: [] },
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
      { rows: [] },
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
      { rows: [{ status: "confirmed", financial_status: "paid" }] },
    ]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const processed = await processTestShipment(mock, shipmentPayload, inventoryCore);

    expect(processed).toBe(1);
    expect(inventoryCore.recordShipment).toHaveBeenCalledWith(expect.objectContaining({
      orderItemId: 30001,
      qty: 1,
      shipmentId: "501",
    }));
    const sqlText = mock.calls.map((c) => c.sqlText).join("\n");
    expect(sqlText).not.toMatch(/shipstation_split_items_unmapped/);
  });

  it("records replacement inventory without repeating OMS or channel fulfillment", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 7004,
      orderId: 555004,
      orderKey: "echelon-wms-reship-9004",
      trackingNumber: "1Z-REPLACEMENT",
      shipmentItems: [
        { lineItemKey: null, sku: "SHIPSTATION-STALE-SKU", quantity: 1 },
      ],
    });
    const inventoryCore = {
      recordReplacementShipmentFromAvailableInventory: vi.fn(async () => ({
        warehouseLocationId: 50001,
        alreadyRecorded: false,
      })),
      recordShipment: vi.fn(async () => undefined),
    };
    const mock = makeDb([
      {
        rows: [{
          id: 9004,
          order_id: 42,
          source: "shipstation_reship_adopted",
          status: "shipped",
          shipment_purpose: "replacement",
          replaces_shipment_id: 501,
          replacement_reason: "lost",
          external_fulfillment_id: "shipstation_shipment:7004",
          tracking_number: "1Z-REPLACEMENT",
        }],
      },

      {
        rows: [{
          id: 91004,
          order_item_id: null,
          replacement_for_order_item_id: 30001,
          inventory_order_item_id: 30001,
          product_variant_id: 40001,
          qty: 1,
          pick_location_id: 50001,
          warehouse_id: 1,
          shipment_purpose: "replacement",
        }],
      },
      { rows: [] },
      {
        rows: [{
          id: 9004,
          order_id: 42,
          status: "shipped",
          tracking_number: "1Z-REPLACEMENT",
          carrier: "UPS",
          service_code: "ups_ground",
          carrier_cost_cents: 0,
        }],
      },
      { rows: [] },
      { rows: [{ id: 42, warehouse_status: "shipped", completed_at: SHIP_DATE }] },
      { rows: [{ status: "lost" }, { status: "shipped" }] },
      { rows: [] },
    ]);

    globalThis.fetch = mockFetchOnceOk({ shipments: [shipmentPayload] }) as any;

    const processed = await processTestShipment(mock, shipmentPayload, inventoryCore);

    expect(processed).toBe(1);
    expect(inventoryCore.recordReplacementShipmentFromAvailableInventory).toHaveBeenCalledWith(expect.objectContaining({
      productVariantId: 40001,
      warehouseId: 1,
      orderItemId: 30001,
      qty: 1,
      shipmentId: 9004,
      shipmentItemId: 91004,
    }));
    expect(inventoryCore.recordShipment).not.toHaveBeenCalled();
    const sqlText = mock.calls.map((call) => call.sqlText).join("\n");
    expect(sqlText).toContain("replacement_for_order_item_id");
    expect(sqlText).not.toContain("osi.provider_membership_state");
    expect(sqlText).not.toMatch(/UPDATE oms\.oms_orders/);
    expect(sqlText).not.toMatch(/UPDATE oms\.oms_order_lines/);
    expect(sqlText).toMatch(/UPDATE wms\.outbound_shipment_items[\s\S]*SET from_location_id/);
    expect(mock.calls.filter((call) => call.tag === "insert")).toHaveLength(0);
  });

  it("records provider-confirmed historical replacement evidence when current stock cannot prove its past debit", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 7005,
      orderId: 555005,
      orderKey: "echelon-wms-reship-9005",
      trackingNumber: "1Z-HISTORICAL-REPLACEMENT",
      shipmentItems: [
        { lineItemKey: null, sku: "SKU-HISTORICAL", quantity: 1 },
      ],
    });
    const inventoryCore = {
      recordReplacementShipmentFromAvailableInventory: vi.fn(async () => {
        throw {
          code: "REPLACEMENT_INVENTORY_UNAVAILABLE",
          message: "no current unreserved stock",
          context: { productVariantId: 40002, qty: 1, warehouseId: 1 },
        };
      }),
      recordShipment: vi.fn(async () => undefined),
    };
    const mock = makeDb([
      {
        rows: [{
          id: 9005,
          order_id: 42,
          source: "shipstation_reship_adopted",
          status: "shipped",
          shipment_purpose: "replacement",
          replaces_shipment_id: 501,
          replacement_reason: "lost",
          external_fulfillment_id: "shipstation_shipment:7005",
          tracking_number: "1Z-HISTORICAL-REPLACEMENT",
        }],
      },
      {
        rows: [{
          id: 91005,
          order_item_id: null,
          replacement_for_order_item_id: 30002,
          inventory_order_item_id: 30002,
          product_variant_id: 40002,
          qty: 1,
          pick_location_id: null,
          warehouse_id: 1,
          shipment_purpose: "replacement",
          shipment_source: "shipstation_reship_adopted",
          shipment_tracking_number: "1Z-HISTORICAL-REPLACEMENT",
          external_fulfillment_id: "shipstation_shipment:7005",
          historical_inventory_deferred: false,
        }],
      },
      // Clear any stale missing-data marker before dispatch.
      { rows: [] },
      // Dispatch sees an already-shipped package before the inventory fact is deferred.
      {
        rows: [{
          id: 9005,
          order_id: 42,
          status: "shipped",
          tracking_number: "1Z-HISTORICAL-REPLACEMENT",
          carrier: "UPS",
          service_code: "ups_ground",
        }],
      },
      // Persist the idempotent reconciliation exception and retain shipment review.
      { rows: [] },
      { rows: [] },
    ]);

    globalThis.fetch = mockFetchOnceOk({ shipments: [shipmentPayload] }) as any;

    const processed = await processTestShipment(mock, shipmentPayload, inventoryCore);

    expect(processed).toBe(1);
    expect(inventoryCore.recordReplacementShipmentFromAvailableInventory).toHaveBeenCalledTimes(1);
    expect(inventoryCore.recordShipment).not.toHaveBeenCalled();
    const sqlText = mock.calls.map((call) => call.sqlText).join("\n");
    expect(sqlText).toContain("historical_replacement_inventory_unproven");
    expect(sqlText).toMatch(/INSERT INTO wms\.reconciliation_exceptions/);
    expect(sqlText).toMatch(/UPDATE wms\.outbound_shipments[\s\S]*requires_review = true/);
  });
  it("does not debit newly available stock on a replay after historical replacement inventory was deferred", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 7007,
      orderId: 555007,
      orderKey: "echelon-wms-reship-9007",
      trackingNumber: "1Z-HISTORICAL-REPLAY",
      shipmentItems: [
        { lineItemKey: null, sku: "SKU-HISTORICAL", quantity: 1 },
      ],
    });
    const inventoryCore = {
      recordReplacementShipmentFromAvailableInventory: vi.fn(async () => ({
        warehouseLocationId: 50002,
        alreadyRecorded: false,
      })),
      recordShipment: vi.fn(async () => undefined),
    };
    const mock = makeDb([
      {
        rows: [{
          id: 9007,
          order_id: 42,
          source: "shipstation_reship_adopted",
          status: "shipped",
          shipment_purpose: "replacement",
          replaces_shipment_id: 501,
          replacement_reason: "lost",
          external_fulfillment_id: "shipstation_shipment:7007",
          tracking_number: "1Z-HISTORICAL-REPLAY",
        }],
      },
      {
        rows: [{
          id: 91007,
          order_item_id: null,
          replacement_for_order_item_id: 30002,
          inventory_order_item_id: 30002,
          product_variant_id: 40002,
          qty: 1,
          pick_location_id: null,
          warehouse_id: 1,
          shipment_purpose: "replacement",
          shipment_source: "shipstation_reship_adopted",
          shipment_tracking_number: "1Z-HISTORICAL-REPLAY",
          external_fulfillment_id: "shipstation_shipment:7007",
          historical_inventory_deferred: true,
        }],
      },
      { rows: [] },
      {
        rows: [{
          id: 9007,
          order_id: 42,
          status: "shipped",
          tracking_number: "1Z-HISTORICAL-REPLAY",
          carrier: "UPS",
          service_code: "ups_ground",
        }],
      },
    ]);

    globalThis.fetch = mockFetchOnceOk({ shipments: [shipmentPayload] }) as any;

    const processed = await processTestShipment(mock, shipmentPayload, inventoryCore);

    expect(processed).toBe(1);
    expect(inventoryCore.recordReplacementShipmentFromAvailableInventory).not.toHaveBeenCalled();
    expect(inventoryCore.recordShipment).not.toHaveBeenCalled();
    const sqlText = mock.calls.map((call) => call.sqlText).join("\n");
    expect(sqlText).not.toMatch(/UPDATE wms\.outbound_shipment_items[\s\S]*SET from_location_id/);
  });
  it("records an omission-correction package without a second inventory or fulfillment write", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 7006,
      orderId: 555006,
      orderKey: "echelon-wms-reship-9006",
      trackingNumber: "1Z-OMISSION-CORRECTION",
      shipmentItems: [
        { lineItemKey: null, sku: "SKU-A", quantity: 1 },
      ],
    });
    const inventoryCore = {
      recordShipment: vi.fn(async () => undefined),
    };
    const mock = makeDb([
      {
        rows: [{
          id: 9006,
          order_id: 42,
          source: "shipstation_reship_adopted",
          status: "shipped",
          shipment_purpose: "replacement",
          replaces_shipment_id: 501,
          replacement_reason: "packing_omission",
          external_fulfillment_id: "shipstation_shipment:7006",
          tracking_number: "1Z-OMISSION-CORRECTION",
        }],
      },
      // loadValidatedInventoryShipmentItems excludes omission corrections.
      { rows: [] },
      // Clear any stale inventory review marker.
      { rows: [] },
      {
        rows: [{
          id: 9006,
          order_id: 42,
          status: "shipped",
          tracking_number: "1Z-OMISSION-CORRECTION",
          carrier: "UPS",
          service_code: "ups_ground",
          carrier_cost_cents: 0,
        }],
      },
      { rows: [{ id: 42, warehouse_status: "shipped", completed_at: SHIP_DATE }] },
      { rows: [{ status: "shipped" }, { status: "shipped" }] },
      { rows: [] },
    ]);

    globalThis.fetch = mockFetchOnceOk({ shipments: [shipmentPayload] }) as any;

    const processed = await processTestShipment(mock, shipmentPayload, inventoryCore);

    expect(processed).toBe(1);
    expect(inventoryCore.recordShipment).not.toHaveBeenCalled();
    const sqlText = mock.calls.map((call) => call.sqlText).join("\n");
    expect(sqlText).toContain("osi.shipment_item_purpose <> 'omission_correction'");
    expect(sqlText).not.toMatch(/UPDATE oms\.oms_orders/);
    expect(sqlText).not.toMatch(/UPDATE oms\.oms_order_lines/);
    expect(mock.calls.filter((call) => call.tag === "update")).toHaveLength(0);
    expect(mock.calls.filter((call) => call.tag === "insert")).toHaveLength(0);
  });
  it("deducts an off-order concession item without changing order fulfillment", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 7005,
      orderId: 555005,
      orderKey: "echelon-wms-reship-9005",
      trackingNumber: "1Z-CONCESSION",
      shipmentItems: [
        { lineItemKey: null, sku: "FREE-SKU", quantity: 1 },
      ],
    });
    const inventoryCore = {
      recordReplacementShipmentFromAvailableInventory: vi.fn(async () => ({
        warehouseLocationId: 50001,
        alreadyRecorded: false,
      })),
      recordShipment: vi.fn(async () => undefined),
    };
    const mock = makeDb([
      {
        rows: [{
          id: 9005,
          order_id: 42,
          source: "shipstation_reship_adopted",
          status: "shipped",
          shipment_purpose: "replacement",
          replaces_shipment_id: 501,
          replacement_reason: "concession",
          external_fulfillment_id: "shipstation_shipment:7005",
          tracking_number: "1Z-CONCESSION",
        }],
      },

      {
        rows: [{
          id: 91005,
          order_item_id: null,
          replacement_for_order_item_id: null,
          shipment_item_purpose: "concession",
          inventory_order_item_id: null,
          product_variant_id: 40002,
          qty: 1,
          pick_location_id: 50001,
          warehouse_id: 1,
          shipment_purpose: "replacement",
        }],
      },
      { rows: [] },
      {
        rows: [{
          id: 9005,
          order_id: 42,
          status: "shipped",
          tracking_number: "1Z-CONCESSION",
          carrier: "UPS",
          service_code: "ups_ground",
          carrier_cost_cents: 0,
        }],
      },
      { rows: [] },
      { rows: [{ id: 42, warehouse_status: "shipped", completed_at: SHIP_DATE }] },
      { rows: [{ status: "shipped" }, { status: "shipped" }] },
      { rows: [] },
    ]);

    globalThis.fetch = mockFetchOnceOk({ shipments: [shipmentPayload] }) as any;

    const processed = await processTestShipment(mock, shipmentPayload, inventoryCore);

    expect(processed).toBe(1);
    expect(inventoryCore.recordReplacementShipmentFromAvailableInventory).toHaveBeenCalledWith(expect.objectContaining({
      productVariantId: 40002,
      warehouseId: 1,
      orderItemId: null,
      shipmentItemId: 91005,
      qty: 1,
      shipmentId: 9005,
    }));
    expect(inventoryCore.recordShipment).not.toHaveBeenCalled();
    const sqlText = mock.calls.map((call) => call.sqlText).join("\n");
    expect(sqlText).not.toContain("osi.provider_membership_state");
    expect(sqlText).not.toMatch(/UPDATE oms\.oms_orders/);
    expect(sqlText).not.toMatch(/UPDATE oms\.oms_order_lines/);
    expect(sqlText).toMatch(/UPDATE wms\.outbound_shipment_items[\s\S]*SET from_location_id/);
    expect(mock.calls.filter((call) => call.tag === "insert")).toHaveLength(0);
  });

  it("fallback: shipment NOT found by shipstation_order_id → legacy path runs", async () => {
    // Pre-cutover order: orderKey is legacy echelon-oms-<id> AND no
    // shipstation_order_id is set on any outbound_shipments row.
    const shipmentPayload = makeShipmentPayload({
      orderId: 123456,
      orderKey: "echelon-oms-789",
    });

    const mock = makeDb([
      // Physical ShipStation shipment id lookup -> not found.
      { rows: [] },
      // Legacy shipstation_order_id fallback -> not found.
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

    const processed = await processTestShipment(mock, shipmentPayload);

    expect(processed).toBe(0);

    const executeSqls = mock.calls
      .filter((c) => c.tag === "execute")
      .map((c) => c.sqlText);

    // V2 probes by physical shipment id first, then legacy order id.
    expect(executeSqls[0]).toMatch(/external_fulfillment_id/);
    expect(executeSqls[1]).toMatch(/shipstation_order_id/);
    // Legacy fallback then ran the OMS-by-pointer query.
    expect(executeSqls[2]).toMatch(/oms_fulfillment_order_id/);
    // Final no-match is persisted as a WMS review exception.
    expect(executeSqls.join("\n")).toMatch(/INSERT INTO wms\.reconciliation_exceptions/);

    // The compatibility resolver is SQL-only and must not fall back to the
    // former OMS-only builder path that could fabricate fulfillment state.
    expect(mock.calls.some((c) => c.tag === "select")).toBe(false);
    expect(mock.calls.some((c) => c.tag === "insert")).toBe(false);
  });

  it("records unmatched ShipStation callbacks as reconciliation exceptions", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 88001,
      orderId: 99001,
      orderKey: "external-order-key",
      orderNumber: "SS-EXT-99001",
      trackingNumber: "1ZUNMATCHED",
    });

    const mock = makeDb([
      // V2 lookup by shipstation_order_id -> not found. Non-Echelon orderKey
      // skips legacy SQL, so the next execute is the review-exception upsert.
      { rows: [] },
      { rows: [] },
    ]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const processed = await processTestShipment(mock, shipmentPayload);

    expect(processed).toBe(0);

    const sqlText = mock.calls
      .filter((c) => c.tag === "execute")
      .map((c) => c.sqlText)
      .join("\n");
    expect(sqlText).toMatch(/INSERT INTO wms\.reconciliation_exceptions/);
    expect(sqlText).toMatch(/manual_review/);
    expect(sqlText).toMatch(/ship_notify_no_match/);
    expect(sqlText).toMatch(/ON CONFLICT \(idempotency_key\)/);
    expect(mock.calls.some((c) => c.tag === "insert")).toBe(false);
  });
});

// ─── V2 Shopify fulfillment push wiring (C22d) ───────────────────────

describe("processShipNotify V2 :: canonical channel fulfillment handoff", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.SHOPIFY_FULFILLMENT_PUSH_ENABLED;
    vi.restoreAllMocks();
  });

  function happyPathRows() {
    return [
      { rows: [{ id: 501, order_id: 42, status: "planned" }] },
      {
        rows: [{
          id: 501,
          order_id: 42,
          status: "planned",
          tracking_number: null,
          carrier: null,
          tracking_url: null,
        }],
      },
      { rows: [] },
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
      { rows: [{ status: "confirmed", financial_status: "paid" }] },
    ];
  }

  it("materializes the physical package and never invokes a legacy provider push", async () => {
    const mock = makeDb(happyPathRows());
    globalThis.fetch = mockFetchOnceOk({
      shipments: [makeShipmentPayload()],
    }) as any;

    const processed = await processTestShipment(mock, makeShipmentPayload());

    expect(processed).toBe(1);
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).toHaveBeenCalledTimes(1);
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyWmsShipmentIds: [501],
        shippingProvider: "shipstation",
        providerPhysicalShipmentId: "77777",
        providerOrderId: "555000",
        providerOrderKey: "echelon-wms-shp-501",
        trackingNumber: "1Z12345",
        carrier: "UPS",
        serviceCode: "ups_ground",
        source: "shipstation_manual_remediation",
      }),
      { executeImmediately: false },
    );
    const source = readFileSync(
      resolve(__dirname, "../../shipstation.service.ts"),
      "utf-8",
    );
    expect(source).not.toContain("__fulfillmentPush");
  });

  it("promotes an exact non-voided label only after confirmed carrier possession", async () => {
    const mock = makeDb(happyPathRows());
    globalThis.fetch = mockFetchOnceOk({
      shipments: [makeShipmentPayload()],
    }) as any;

    const result = await createTestShipStationService(mock).confirmDispatch(
      makeDispatchInput(),
    );

    expect(result).toMatchObject({
      processed: true,
      evidence: {
        provider: "shipstation",
        providerLabelId: "77777",
        carrierTrackingEventId: 101,
        carrierDispatchCommandId: 701,
        dispatchOccurredAt: "2026-04-24T15:30:00.000Z",
      },
    });
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPhysicalShipmentId: "77777",
        trackingNumber: "1Z12345",
        source: "carrier_tracking_confirmed_dispatch",
        shippedAt: new Date("2026-04-24T15:30:00.000Z"),
        correlationId: "carrier-tracking-event:101",
        causationId: "carrier-dispatch-command:701",
      }),
      { executeImmediately: false },
    );
  });

  it("rejects a voided label before any WMS or inventory transition", async () => {
    const mock = makeDb([]);
    globalThis.fetch = mockFetchOnceOk({
      shipments: [makeShipmentPayload({
        voidDate: "2026-04-24T15:00:00.000Z",
      })],
    }) as any;

    await expect(
      createTestShipStationService(mock).confirmDispatch(makeDispatchInput()),
    ).rejects.toMatchObject({
      code: "CARRIER_DISPATCH_PROVIDER_LABEL_VOIDED",
      retryable: false,
    });
    expect(mock.execute).not.toHaveBeenCalled();
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).not.toHaveBeenCalled();
  });

  it("rejects tracking identity drift before any WMS or inventory transition", async () => {
    const mock = makeDb([]);
    globalThis.fetch = mockFetchOnceOk({
      shipments: [makeShipmentPayload({ trackingNumber: "1Z-DIFFERENT" })],
    }) as any;

    await expect(
      createTestShipStationService(mock).confirmDispatch(makeDispatchInput()),
    ).rejects.toMatchObject({
      code: "CARRIER_DISPATCH_TRACKING_IDENTITY_MISMATCH",
      retryable: false,
    });
    expect(mock.execute).not.toHaveBeenCalled();
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).not.toHaveBeenCalled();
  });

  it("cannot be disabled by the retired Shopify fulfillment feature flag", async () => {
    process.env.SHOPIFY_FULFILLMENT_PUSH_ENABLED = "false";
    const mock = makeDb(happyPathRows());
    globalThis.fetch = mockFetchOnceOk({
      shipments: [makeShipmentPayload()],
    }) as any;

    await processTestShipment(mock, makeShipmentPayload());

    expect(mock.fulfillmentAuthority.recordPhysicalPackage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the canonical authority is unavailable", async () => {
    const mock = makeDb(happyPathRows());
    globalThis.fetch = mockFetchOnceOk({
      shipments: [makeShipmentPayload()],
    }) as any;

    await expect(
      createShipStationService(mock.db).processManualShipmentNotification(
        makeShipmentPayload(),
        {
          operator: "test:ship-notify-v2",
          reason: "unit_test",
        },
      ),
    ).rejects.toThrow(/Canonical channel fulfillment authority is not initialized/);
  });
});

// --- V2 error resilience -------------------------------------------------


describe("processShipNotify V2 :: error resilience", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("continues the batch but rejects when any shipment fails", async () => {
    const good = makeShipmentPayload({
      shipmentId: 1001,
      orderId: 1,
      orderKey: "echelon-wms-shp-10",
    });
    const broken = makeShipmentPayload({
      shipmentId: 1002,
      orderId: 2,
      orderKey: "echelon-wms-shp-11",
    });
    const alsoGood = makeShipmentPayload({
      shipmentId: 1003,
      orderId: 3,
      orderKey: "echelon-wms-shp-12",
    });
    const mock = makeDb([]);
    mock.providerLabelObserver.observeShipStationLabel.mockImplementation(
      async (shipment: any) => {
        if (shipment.shipmentId === 1002) {
          throw new Error("simulated label authority failure");
        }
        return {
          shippingProviderLabelId: 60001,
          labelInserted: true,
          eventInserted: true,
        };
      },
    );

    globalThis.fetch = mockFetchOnceOk({
      shipments: [good, broken, alsoGood],
    }) as any;

    const svc = createTestShipStationService(mock);
    await expect(svc.processShipNotify("/foo")).rejects.toMatchObject({
      processed: 2,
      failures: [{ shipmentId: 1002, message: "simulated label authority failure" }],
    });
    expect(mock.providerLabelObserver.observeShipStationLabel).toHaveBeenCalledTimes(3);
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).not.toHaveBeenCalled();
  });
});

// ─── SHIP_NOTIFY idempotency hardening (no shipment creation) ──────

describe("processShipNotify V2 :: SHIP_NOTIFY never creates shipments", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("mismatched SS orderId adopts onto existing active shipment (no INSERT)", async () => {
    // Scenario: pushShipment created SS order 111, but a duplicate push
    // created SS order 222 on the same key. SHIP_NOTIFY arrives with
    // orderId=222 which doesn't match our DB's 111. The handler should
    // UPDATE the existing shipment's mapping, not INSERT a new one.
    const shipmentPayload = makeShipmentPayload({
      orderId: 222, // doesn't match the 111 in our DB
      orderKey: "echelon-wms-shp-501",
    });

    const mock = makeDb([
      // physical shipment (external_fulfillment_id) lookup → not found
      { rows: [] },
      // resolveShipmentByOrderKey: SELECT shipment 501 (the parent)
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            status: "queued",
            shipstation_order_id: 111,
            shipstation_order_key: "echelon-wms-shp-501",
            external_fulfillment_id: null,
          },
        ],
      },
      // UPDATE shipment 501's mapping from 111 → 222 (+ review flag)
      { rows: [] },
      // markShipmentShipped load-current
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            status: "queued",
            tracking_number: null,
            carrier: null,
            tracking_url: null,
          },
        ],
      },
      // UPDATE outbound_shipments (ship)
      { rows: [] },
      // recompute: SELECT wms.orders
      { rows: [{ id: 42, warehouse_status: "ready_to_ship", completed_at: null }] },
      // recompute: SELECT shipment statuses
      { rows: [{ status: "shipped" }] },
      // recompute: UPDATE wms.orders
      { rows: [] },
      // resolve OMS id
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
      // finality guard
      { rows: [{ status: "confirmed", financial_status: "paid" }] },
      // OMS line status derivation
      { rows: [] },
      // delayed tracking provider guard
      { rows: [{ provider: "shopify" }] },
      // Shopify fulfillment provider guard
      { rows: [{ provider: "shopify" }] },
    ]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const processed = await processTestShipment(mock, shipmentPayload);

    expect(processed).toBe(1);

    const allSql = mock.calls.map((c) => c.sqlText).join("\n");
    // Must NOT contain an INSERT INTO wms.outbound_shipments
    expect(allSql).not.toMatch(/INSERT INTO wms\.outbound_shipments/);
    // Must contain the mapping adoption UPDATE
    expect(allSql).toMatch(/shipstation_order_id/);
  });

  it("cancelled parent with no active sibling → returns null, no INSERT", async () => {
    // Scenario: parent shipment is cancelled, no siblings. SHIP_NOTIFY
    // should flag for review, NOT create a replacement shipment.
    const shipmentPayload = makeShipmentPayload({
      orderId: 333,
      orderKey: "echelon-wms-shp-501",
    });

    const mock = makeDb([
      // physical shipment (external_fulfillment_id) lookup → not found
      { rows: [] },
      // resolveShipmentByOrderKey: SELECT shipment 501 (cancelled)
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            status: "cancelled",
            shipstation_order_id: 111,
            shipstation_order_key: "echelon-wms-shp-501",
            external_fulfillment_id: null,
          },
        ],
      },
      // Sibling search → none found
      { rows: [] },
      // INSERT into oms_order_events (audit log for unresolved)
      { rows: [] },
    ]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const processed = await processTestShipment(mock, shipmentPayload);

    // Should not have processed — no WMS shipment to operate on.
    expect(processed).toBe(0);

    const allSql = mock.calls.map((c) => c.sqlText).join("\n");
    // Absolutely no INSERT INTO outbound_shipments
    expect(allSql).not.toMatch(/INSERT INTO wms\.outbound_shipments/);
    // The oms_order_events audit INSERT did fire
    expect(allSql).toMatch(/ship_notify_unresolved/);
  });

  it("quarantines a distinct package after terminal fulfillment without mutating WMS", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 7002,
      orderId: 555002,
      orderKey: "echelon-wms-shp-501",
      trackingNumber: "1Z-REPLACEMENT",
      shipmentItems: [
        { lineItemKey: null, sku: "SKU-A", quantity: 1 },
      ],
    });
    const inventoryCore = {
      recordShipment: vi.fn(async () => undefined),
    };
    const mock = makeDb([
      // The incoming physical shipment has not been mapped before.
      { rows: [] },
      // Its orderKey points at a different, already-shipped package.
      {
        rows: [{
          id: 501,
          order_id: 42,
          channel_id: 7,
          source: "oms",
          status: "shipped",
          shipstation_order_id: 555001,
          shipstation_order_key: "echelon-wms-shp-501",
          external_fulfillment_id: "shipstation_shipment:7001",
          tracking_number: "1Z-ORIGINAL",
          requires_review: false,
          review_reason: null,
        }],
      },
      // Durable, specific reconciliation exception.
      { rows: [] },
    ]);

    globalThis.fetch = mockFetchOnceOk({ shipments: [shipmentPayload] }) as any;

    const processed = await processTestShipment(mock, shipmentPayload, inventoryCore);

    expect(processed).toBe(0);
    expect(inventoryCore.recordShipment).not.toHaveBeenCalled();
    const executeSql = mock.calls
      .filter((call) => call.tag === "execute")
      .map((call) => call.sqlText);
    expect(executeSql.filter((text) => text.includes("INSERT INTO wms.reconciliation_exceptions"))).toHaveLength(1);
    expect(executeSql.join("\n")).not.toMatch(/INSERT INTO wms\.outbound_shipments/);
    expect(executeSql.join("\n")).not.toMatch(/UPDATE wms\.outbound_shipments/);
    expect(executeSql.join("\n")).not.toMatch(/UPDATE wms\.order_items/);
  });

  it.each(["returned", "lost"])(
    "does not reopen an exact physical replay after the shipment is %s",
    async (status) => {
      const shipmentPayload = makeShipmentPayload({
        shipmentId: 7003,
        trackingNumber: "1Z-TERMINAL",
      });
      const inventoryCore = { recordShipment: vi.fn(async () => undefined) };
      const mock = makeDb([{
        rows: [{
          id: 9003,
          order_id: 42,
          source: "oms",
          status,
          external_fulfillment_id: "shipstation_shipment:7003",
          tracking_number: "1Z-TERMINAL",
          requires_review: false,
          review_reason: null,
        }],
      }]);

      globalThis.fetch = mockFetchOnceOk({ shipments: [shipmentPayload] }) as any;

      const processed = await processTestShipment(mock, shipmentPayload, inventoryCore);

      expect(processed).toBe(0);
      expect(inventoryCore.recordShipment).not.toHaveBeenCalled();
      const sqlText = mock.calls.map((call) => call.sqlText).join("\n");
      expect(sqlText).not.toMatch(/INSERT INTO wms\.reconciliation_exceptions/);
      expect(sqlText).not.toMatch(/UPDATE wms\.outbound_shipments/);
      expect(sqlText).not.toMatch(/UPDATE wms\.order_items/);
    },
  );

  it("shipment creation is unreachable for terminal or unknown parents (source invariants)", async () => {
    const src = readFileSync(
      resolve(__dirname, "../../shipstation.service.ts"),
      "utf-8",
    );
    const fnStart = src.indexOf("async function resolveShipmentByOrderKey(");
    const fnBlock = src.slice(fnStart, src.indexOf("async function syncShipmentItemsFromShipStation("));

    // The terminal-parent branch (sibling → review-flag + audit event →
    // null) must appear BEFORE the split INSERT — terminal/unknown parents
    // can never reach creation (order 59301 class).
    const terminalGuardPos = fnBlock.indexOf("ship_notify_unresolved");
    const fulfilledTerminalGuardPos = fnBlock.indexOf(
      "distinct_physical_shipment_after_terminal_fulfillment",
    );
    const splitInsertPos = fnBlock.indexOf("INSERT INTO wms.outbound_shipments");
    expect(terminalGuardPos).toBeGreaterThan(-1);
    expect(fulfilledTerminalGuardPos).toBeGreaterThan(terminalGuardPos);
    expect(splitInsertPos).toBeGreaterThan(terminalGuardPos);
    expect(splitInsertPos).toBeGreaterThan(fulfilledTerminalGuardPos);

    // Full/duplicate packages REPAIR the parent mapping instead of creating
    // a second row.
    expect(fnBlock).toContain("shipstation_duplicate_order_key_repaired");

    // The split mutation is transactional, deduped, and preserves source IDs
    // on the parent so later physical packages can still reference them.
    expect(fnBlock).toContain("pg_advisory_xact_lock(918406");
    expect(fnBlock).toContain("external_fulfillment_id = ${externalFulfillmentId}");
    expect(fnBlock).toContain("SET qty = qty - ${item.qty}");
    expect(fnBlock).toContain("shipment_item_purpose, product_variant_id, ${item.qty}");
    expect(fnBlock).toContain("db.transaction(createSplit)");
  });

  it("routes legacy ShipStation order-id matches through package parity resolution", () => {
    const src = readFileSync(
      resolve(__dirname, "../../shipstation.service.ts"),
      "utf-8",
    );
    const fnStart = src.indexOf(
      "async function resolveWmsShipmentForShipNotify(",
    );
    const fnBlock = src.slice(
      fnStart,
      src.indexOf("async function resolveShipmentByOrderKey(", fnStart),
    );
    const orderIdLookupPos = fnBlock.indexOf(
      "WHERE shipstation_order_id = ${ssOrderId}",
    );
    const resolverMatch = /resolveShipmentByOrderKey\(\s*Number\(existing\.id\),/.exec(
      fnBlock.slice(orderIdLookupPos),
    );
    const resolverPos = resolverMatch
      ? orderIdLookupPos + (resolverMatch.index ?? 0)
      : -1;

    expect(orderIdLookupPos).toBeGreaterThan(-1);
    expect(resolverPos).toBeGreaterThan(orderIdLookupPos);
    expect(fnBlock.slice(orderIdLookupPos)).not.toContain("row: existing,");
  });

  it("repairs a terminal same-tracking replay before split-package logic can run", () => {
    const src = readFileSync(
      resolve(__dirname, "../../shipstation.service.ts"),
      "utf-8",
    );
    const fnStart = src.indexOf("async function resolveShipmentByOrderKey(");
    const fnBlock = src.slice(
      fnStart,
      src.indexOf(
        "async function syncShipmentItemsFromShipStation(",
        fnStart,
      ),
    );
    const repairGuardPos = fnBlock.indexOf(
      "if (safeLegacyTrackingRepair)",
    );
    const repairUpdatePos = fnBlock.indexOf(
      "SET external_fulfillment_id = COALESCE(",
      repairGuardPos,
    );
    const repairReturnPos = fnBlock.indexOf(
      "handled: false,",
      repairUpdatePos,
    );
    const itemParityPos = fnBlock.indexOf(
      "const parsedShipStationItems",
    );
    const splitInsertPos = fnBlock.indexOf(
      "INSERT INTO wms.outbound_shipments",
    );

    expect(repairGuardPos).toBeGreaterThan(-1);
    expect(repairUpdatePos).toBeGreaterThan(repairGuardPos);
    expect(repairReturnPos).toBeGreaterThan(repairUpdatePos);
    expect(itemParityPos).toBeGreaterThan(repairReturnPos);
    expect(splitInsertPos).toBeGreaterThan(itemParityPos);
  });
});

// ─── Combined / merged (ShipStation "Combine Orders") shipment recovery ──
//     When ShipStation merges two of our orders into one label, the SHIP_NOTIFY
//     can key to a shipment we already cancelled (merge orphaned it). A shipped
//     notify must NOT be dropped: it recovers by mapping the notify's shipment
//     items back to the owning WMS order(s) and shipping each, so tracking +
//     the marketplace fulfillment push still flow to every merged order.
describe("processShipNotify V2 :: combined/merged shipment recovery (source invariants)", () => {
  const readSrc = () =>
    readFileSync(resolve(__dirname, "../../shipstation.service.ts"), "utf-8");

  it("recovers a shipped notify whose keyed shipment is dead by fanning out over shipment items", () => {
    const src = readSrc();
    const fnStart = src.indexOf("async function processShipNotifyV2(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBlock = src.slice(
      fnStart,
      src.indexOf("async function applyShipNotifyV2EventToResolvedShipment("),
    );

    // When the primary resolves to no live shipment, a *shipped* notify must
    // attempt item-based recovery BEFORE giving up (the legacy fallback).
    const recoveryPos = fnBlock.indexOf(
      "resolveCombinedShipmentGroupsFromShipStationItems(null",
    );
    const giveUpPos = fnBlock.indexOf("fallback: resolved.fallback");
    expect(recoveryPos).toBeGreaterThan(-1);
    expect(giveUpPos).toBeGreaterThan(-1);
    expect(recoveryPos).toBeLessThan(giveUpPos);

    // Recovery is gated to shipped notifies on the orderKey path (fallback ===
    // false); genuine pre-cutover misses still use the legacy fallback.
    expect(fnBlock).toMatch(/event\.kind === "shipped" && !resolved\.fallback/);
    expect(fnBlock).toContain("!resolved.handled");
    // Each recovered order-shipment gets the shared tracking applied.
    expect(fnBlock).toContain("applyShipNotifyV2EventToResolvedShipment(");
  });

  it("fan-out lands on a LIVE shipment per order and tolerates a null anchor", () => {
    const src = readSrc();
    const fnStart = src.indexOf(
      "async function resolveCombinedShipmentGroupsFromShipStationItems(",
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fnBlock = src.slice(
      fnStart,
      src.indexOf("async function loadValidatedInventoryShipmentItems("),
    );

    // Per-order selection skips terminal shipments so a cancelled/voided row
    // can't absorb the shipped event — the create-child path handles it.
    expect(fnBlock).toMatch(/status NOT IN \('cancelled', 'voided'\)/);

    // The single-order shortcut is gated on having an anchor row; the recovery
    // path (null anchor) falls through to per-order resolve/create.
    expect(fnBlock).toContain(
      "resolvedShipmentRow && sourceIdsByOrder.size <= 1",
    );

    // Null-anchor safety: the tie-break deref is guarded so a null anchor
    // never throws (recovery calls this with resolvedShipmentRow = null).
    expect(fnBlock).toContain("resolvedShipmentRow?.id ?? 0");
  });
});

// ─── Duplicate orderKey repair (merged from main; adoption is now the
//     read-only resolveShipmentByOrderKey path — no INSERT fallback) ──

describe("processShipNotify V2 :: active combined package", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("resolves an active parent package spanning multiple WMS orders before single-order splitting", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 448879362,
      orderId: 768275615,
      orderKey: "echelon-wms-shp-501",
      orderNumber: "#60943",
      trackingNumber: "1Z16D13WYW18265554",
      shipmentItems: [
        {
          lineItemKey: "wms-item-601",
          sku: "SHLZ-MAG-35PT-SLV-B25",
          quantity: 2,
        },
        {
          lineItemKey: "wms-item-602",
          sku: "GLV-MAG-35PT-P50",
          quantity: 2,
        },
      ],
    });
    const mock = makeDb([
      // No prior WMS row is linked to this provider physical shipment.
      { rows: [] },
      // The provider orderKey points at the surviving active parent.
      {
        rows: [{
          id: 501,
          order_id: 42,
          channel_id: 36,
          source: "echelon_sync",
          status: "queued",
          shipstation_order_id: 768275615,
          shipstation_order_key: "echelon-wms-shp-501",
          external_fulfillment_id: null,
          tracking_number: null,
          shipment_purpose: "customer_fulfillment",
        }],
      },
      // The package contains the parent's item plus a foreign WMS item key.
      { rows: [{ id: 601, qty: 2 }] },
      // Strict provider-line ownership preflight.
      {
        rows: [
          { source_shipment_item_id: 601, wms_order_id: 42 },
          { source_shipment_item_id: 602, wms_order_id: 43 },
        ],
      },
      // Resolve one live WMS shipment for each owning order.
      {
        rows: [{
          id: 501,
          order_id: 42,
          source: "echelon_sync",
          status: "queued",
          shipstation_order_id: 768275615,
          external_fulfillment_id: null,
          tracking_number: null,
          shipment_purpose: "customer_fulfillment",
        }],
      },
      {
        rows: [{
          id: 502,
          order_id: 43,
          source: "echelon_sync",
          status: "queued",
          shipstation_order_id: 768298375,
          external_fulfillment_id: null,
          tracking_number: null,
          shipment_purpose: "customer_fulfillment",
        }],
      },
      // Apply the package's first provider line to WMS shipment 501.
      {
        rows: [{
          id: 601,
          order_item_id: 1001,
          replacement_for_order_item_id: null,
          sku: "SHLZ-MAG-35PT-SLV-B25",
          qty: 2,
          shipment_purpose: "customer_fulfillment",
          provider_membership_state: "authoritative",
        }],
      },
      {
        rows: [{
          id: 601,
          order_item_id: 1001,
          product_variant_id: 2001,
          from_location_id: 3001,
          box_id: null,
          weight_oz: 4,
        }],
      },
      { rows: [] },
      {
        rows: [{
          id: 501,
          order_id: 42,
          status: "queued",
          tracking_number: null,
          carrier: null,
          tracking_url: null,
          service_code: null,
          carrier_cost_cents: null,
          carrier_cost_source: null,
          carrier_cost_recorded_at: null,
        }],
      },
      { rows: [] },
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
      { rows: [{ status: "confirmed", financial_status: "paid" }] },
      // Apply the package's second provider line to WMS shipment 502.
      {
        rows: [{
          id: 602,
          order_item_id: 1002,
          replacement_for_order_item_id: null,
          sku: "GLV-MAG-35PT-P50",
          qty: 2,
          shipment_purpose: "customer_fulfillment",
          provider_membership_state: "authoritative",
        }],
      },
      {
        rows: [{
          id: 602,
          order_item_id: 1002,
          product_variant_id: 2002,
          from_location_id: 3002,
          box_id: null,
          weight_oz: 5,
        }],
      },
      { rows: [] },
      {
        rows: [{
          id: 502,
          order_id: 43,
          status: "queued",
          tracking_number: null,
          carrier: null,
          tracking_url: null,
          service_code: null,
          carrier_cost_cents: null,
          carrier_cost_source: null,
          carrier_cost_recorded_at: null,
        }],
      },
      { rows: [] },
      { rows: [{ oms_fulfillment_order_id: "10000" }] },
      { rows: [{ status: "confirmed", financial_status: "paid" }] },
    ]);

    const processed = await processTestShipment(mock, shipmentPayload);

    expect(processed).toBe(1);
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).toHaveBeenCalledTimes(1);
    expect(mock.fulfillmentAuthority.recordPhysicalPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyWmsShipmentIds: [501, 502],
        shippingProvider: "shipstation",
        providerPhysicalShipmentId: "448879362",
        providerOrderId: "768275615",
        trackingNumber: "1Z16D13WYW18265554",
        legacyHeaderPolicy: "aggregate_projection",
      }),
      { executeImmediately: false },
    );

    const executeSqls = mock.calls
      .filter((call) => call.tag === "execute")
      .map((call) => call.sqlText);
    expect(
      executeSqls.some((text) => text.includes("source_shipment_item_id")),
    ).toBe(true);
    expect(
      executeSqls.some((text) =>
        text.includes("INSERT INTO wms.outbound_shipments")
      ),
    ).toBe(false);
    expect(
      executeSqls.some((text) =>
        text.includes("WHERE shipstation_order_id")
      ),
    ).toBe(false);
  });
});

describe("processShipNotify V2 :: duplicate orderKey repair", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
    process.env.SHOPIFY_FULFILLMENT_PUSH_ENABLED = "false";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.SHOPIFY_FULFILLMENT_PUSH_ENABLED;
    vi.restoreAllMocks();
  });

  it("repairs a duplicate ShipStation orderKey mapping instead of creating a fake split shipment", async () => {
    const shipmentPayload = makeShipmentPayload({
      shipmentId: 7003,
      orderId: 555099,
      orderKey: "echelon-wms-shp-501",
      shipmentItems: [
        { lineItemKey: "wms-item-10001", sku: "SKU-A", quantity: 1 },
      ],
    });
    const inventoryCore = {
      recordShipment: vi.fn(async () => undefined),
    };

    const mock = makeDb([
      // Physical ShipStation shipment id lookup → not found.
      { rows: [] },
      // Parent shipment parsed from echelon-wms-shp-501.
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            status: "queued",
            shipstation_order_id: 555000,
            shipstation_order_key: "echelon-wms-shp-501",
            external_fulfillment_id: null,
          },
        ],
      },
      // Parent item set matches the physical package exactly → repair, not split.
      { rows: [{ id: 10001, qty: 1 }] },
      // Adopt/repair UPDATE (drift 555000 → 555099, review flagged).
      { rows: [] },
      // Combined-shipment source item order grouping.
      { rows: [{ source_shipment_item_id: 10001, wms_order_id: 42 }] },
      // Existing target shipment item row belongs to the original shipment.
      { rows: [{ id: 10001, order_item_id: 30001, sku: "SKU-A", qty: 1 }] },
      // Source item copied from the original shipment row.
      {
        rows: [
          {
            id: 10001,
            order_item_id: 30001,
            product_variant_id: 40001,
            from_location_id: 50001,
            box_id: null,
            weight_oz: 4,
          },
        ],
      },
      // UPDATE wms.outbound_shipment_items.
      { rows: [] },
      // loadValidatedInventoryShipmentItems.
      {
        rows: [
          {
            id: 10001,
            order_item_id: 30001,
            product_variant_id: 40001,
            qty: 1,
            pick_location_id: 50001,
          },
        ],
      },
      // self-heal: clear inventory_deduction_missing_item_data flag.
      { rows: [] },
      // markShipmentShipped load-current.
      {
        rows: [
          {
            id: 501,
            order_id: 42,
            status: "queued",
            tracking_number: null,
            carrier: null,
            tracking_url: null,
          },
        ],
      },
      // UPDATE outbound_shipments.
      { rows: [] },
      // resolve OMS id.
      { rows: [{ oms_fulfillment_order_id: "9999" }] },
      // finality guard.
      { rows: [{ status: "confirmed", financial_status: "paid" }] },
    ]);

    globalThis.fetch = mockFetchOnceOk({
      shipments: [shipmentPayload],
    }) as any;

    const processed = await processTestShipment(mock, shipmentPayload, inventoryCore);

    expect(processed).toBe(1);
    expect(inventoryCore.recordShipment).toHaveBeenCalledWith(expect.objectContaining({
      orderItemId: 30001,
      qty: 1,
      shipmentId: "501",
    }));
    const sqlText = mock.calls.map((c) => c.sqlText).join("\n");
    expect(sqlText).toMatch(/shipstation_duplicate_order_key_repaired/);
    expect(sqlText).toMatch(/UPDATE wms\.outbound_shipments/);
    expect(sqlText).not.toMatch(/shipstation_split/);
  });
});
