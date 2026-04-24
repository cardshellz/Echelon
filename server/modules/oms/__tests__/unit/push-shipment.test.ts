/**
 * Unit tests for pushShipment + validateShipmentForPush (§6 Commit 11).
 *
 * Scope: validator is a pure function (no mocks). pushShipment uses a
 * small hand-rolled db mock + global fetch mock — no network, no real
 * DB. The whole point of these tests is to protect the two invariants
 * that motivated the refactor:
 *
 *   1. No silent $0 push (audit B1 / issue #56430).
 *      validateShipmentForPush rejects any line with unit_price_cents <= 0,
 *      rejects amount_paid_cents <= 0, and rejects line-sum mismatches
 *      beyond the per-line tolerance.
 *
 *   2. No re-push of already-terminal shipments.
 *      pushShipment throws on status NOT IN ('planned','queued').
 *
 * Structural assertions match coding-standards Rule #9 (happy path +
 * explicit edge cases) and Rule #15 (test coverage explanation in the
 * completion report).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createShipStationService,
  validateShipmentForPush,
  ShipStationPushError,
  SS_PUSH_INVALID_SHIPMENT,
  type WmsShipmentRow,
  type WmsOrderRow,
  type WmsShipmentItemRow,
} from "../../shipstation.service";

// ─── Fixtures ────────────────────────────────────────────────────────

function okShipment(
  overrides: Partial<WmsShipmentRow> = {},
): WmsShipmentRow {
  return {
    id: 9001,
    order_id: 42,
    channel_id: 7,
    status: "planned",
    ...overrides,
  };
}

function okOrder(overrides: Partial<WmsOrderRow> = {}): WmsOrderRow {
  return {
    id: 42,
    order_number: "1001",
    channel_id: 7,
    oms_fulfillment_order_id: "42",
    sort_rank: "0000000100",
    external_order_id: "EXT-1001",
    customer_name: "Jane Customer",
    customer_email: "jane@example.com",
    shipping_name: "Jane Customer",
    shipping_address: "123 Main St",
    shipping_city: "Springfield",
    shipping_state: "IL",
    shipping_postal_code: "62701",
    shipping_country: "US",
    amount_paid_cents: 5913,
    tax_cents: 413,
    shipping_cents: 500,
    total_cents: 5000, // lines sum to 5000 by default fixture below
    currency: "USD",
    order_placed_at: new Date("2026-04-24T12:00:00Z"),
    ...overrides,
  };
}

function okItem(
  overrides: Partial<WmsShipmentItemRow> = {},
): WmsShipmentItemRow {
  return {
    id: 111,
    order_item_id: 500,
    sku: "ABC-1",
    name: "Widget",
    qty: 2,
    unit_price_cents: 2500,
    ...overrides,
  };
}

// ─── validateShipmentForPush (pure) ──────────────────────────────────

describe("validateShipmentForPush :: happy path", () => {
  it("accepts a fully-valid shipment/order/items combo", () => {
    expect(() =>
      validateShipmentForPush(okShipment(), okOrder(), [okItem()]),
    ).not.toThrow();
  });

  it("accepts multiple valid lines with sum matching total_cents", () => {
    expect(() =>
      validateShipmentForPush(
        okShipment(),
        okOrder({ total_cents: 10000 }),
        [
          okItem({ id: 1, unit_price_cents: 2500, qty: 2 }), // 5000
          okItem({ id: 2, unit_price_cents: 2500, qty: 2 }), // 5000
        ],
      ),
    ).not.toThrow();
  });

  it("accepts a 1¢ per-line rounding delta on the line sum", () => {
    // 2 lines → tolerance window = 2¢. Sum off by 2¢ is accepted.
    expect(() =>
      validateShipmentForPush(
        okShipment(),
        okOrder({ total_cents: 10002 }), // off by 2¢ vs lines
        [
          okItem({ id: 1, unit_price_cents: 2500, qty: 2 }),
          okItem({ id: 2, unit_price_cents: 2500, qty: 2 }),
        ],
      ),
    ).not.toThrow();
  });
});

describe("validateShipmentForPush :: line-level pricing violations", () => {
  it("throws when a line's unit_price_cents is 0 (the silent-$0 bug)", () => {
    let err: ShipStationPushError | undefined;
    try {
      validateShipmentForPush(okShipment(), okOrder(), [
        okItem({ unit_price_cents: 0 }),
      ]);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.code).toBe(SS_PUSH_INVALID_SHIPMENT);
    expect(err?.context.field).toBe("items[0].unit_price_cents");
    expect(err?.context.value).toBe(0);
    expect(err?.context.shipmentId).toBe(9001);
  });

  it("throws when a line's unit_price_cents is negative", () => {
    let err: ShipStationPushError | undefined;
    try {
      validateShipmentForPush(okShipment(), okOrder(), [
        okItem({ unit_price_cents: -100 }),
      ]);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("items[0].unit_price_cents");
    expect(err?.context.value).toBe(-100);
  });

  it("throws when a line's unit_price_cents is a float (Rule #3: no floats)", () => {
    expect(() =>
      validateShipmentForPush(okShipment(), okOrder(), [
        okItem({ unit_price_cents: 25.5 as any }),
      ]),
    ).toThrow(ShipStationPushError);
  });

  it("points field at the first bad line when multiple lines are present", () => {
    let err: ShipStationPushError | undefined;
    try {
      validateShipmentForPush(okShipment(), okOrder({ total_cents: 10000 }), [
        okItem({ id: 1, unit_price_cents: 2500, qty: 2 }),
        okItem({ id: 2, unit_price_cents: 0, qty: 2 }),
      ]);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err?.context.field).toBe("items[1].unit_price_cents");
  });
});

describe("validateShipmentForPush :: header-level violations", () => {
  it("throws when amount_paid_cents is 0 on a paid order", () => {
    let err: ShipStationPushError | undefined;
    try {
      validateShipmentForPush(
        okShipment(),
        okOrder({ amount_paid_cents: 0 }),
        [okItem()],
      );
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("order.amount_paid_cents");
    expect(err?.context.value).toBe(0);
  });

  it("throws when amount_paid_cents is -1", () => {
    let err: ShipStationPushError | undefined;
    try {
      validateShipmentForPush(
        okShipment(),
        okOrder({ amount_paid_cents: -1 }),
        [okItem()],
      );
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err?.context.field).toBe("order.amount_paid_cents");
    expect(err?.context.value).toBe(-1);
  });

  it("throws on line-sum mismatch beyond 1¢/line tolerance", () => {
    // 1 line, tolerance window = 1¢. Sum off by 10¢ → reject.
    let err: ShipStationPushError | undefined;
    try {
      validateShipmentForPush(
        okShipment(),
        okOrder({ total_cents: 5010 }), // lines sum to 5000
        [okItem({ unit_price_cents: 2500, qty: 2 })],
      );
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("items.sum(unit_price_cents*qty)");
    expect((err?.context.value as any).linesSumCents).toBe(5000);
    expect((err?.context.value as any).totalCents).toBe(5010);
  });

  it("throws when shipping_address is missing", () => {
    let err: ShipStationPushError | undefined;
    try {
      validateShipmentForPush(
        okShipment(),
        okOrder({ shipping_address: null }),
        [okItem()],
      );
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err?.context.field).toBe("order.shipping_address");
  });

  it("throws when shipping_address is whitespace-only", () => {
    let err: ShipStationPushError | undefined;
    try {
      validateShipmentForPush(
        okShipment(),
        okOrder({ shipping_address: "   " }),
        [okItem()],
      );
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err?.context.field).toBe("order.shipping_address");
  });

  it("throws when customer_email is missing", () => {
    let err: ShipStationPushError | undefined;
    try {
      validateShipmentForPush(
        okShipment(),
        okOrder({ customer_email: null }),
        [okItem()],
      );
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err?.context.field).toBe("order.customer_email");
  });
});

describe("validateShipmentForPush :: structural violations", () => {
  it("throws on empty items array", () => {
    let err: ShipStationPushError | undefined;
    try {
      validateShipmentForPush(okShipment(), okOrder(), []);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("items");
    expect(err?.context.value).toBe(0);
  });
});

// ─── pushShipment (mocked db + fetch) ────────────────────────────────

// Minimal db mock supporting db.execute(sql`...`) with a scripted response
// queue. Each call shifts the next entry off `responses`. Tests push
// responses in the order the code reads them:
//   1. shipment header
//   2. order row
//   3. items list
//   4. UPDATE wms.outbound_shipments (not awaited for rows, returns empty)

interface DbCall {
  kind: "execute";
  // We don't introspect SQL here; order-based scripting is enough for
  // this unit test and keeps the mock trivial.
}

function makeDb(scripted: Array<any>) {
  const calls: DbCall[] = [];
  const remaining = [...scripted];
  const execute = vi.fn(async (_query: any) => {
    calls.push({ kind: "execute" });
    if (remaining.length === 0) {
      return { rows: [] };
    }
    const next = remaining.shift();
    return next;
  });
  return { db: { execute }, execute, getCallCount: () => calls.length };
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

function mockFetchOnce500() {
  return vi.fn(async (_url: string, _init: any) => ({
    ok: false,
    status: 500,
    json: async () => ({}),
    text: async () => "boom",
    headers: new Map<string, string>() as any,
  }));
}

const ORIGINAL_FETCH = globalThis.fetch;

describe("pushShipment :: happy path", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("reads WMS, calls SS /createorder, and UPDATEs the shipment to queued", async () => {
    const shipmentRow = okShipment();
    const orderRow = okOrder();
    const items = [okItem()];

    const mock = makeDb([
      { rows: [shipmentRow] }, // 1. shipment
      { rows: [orderRow] }, // 2. order
      { rows: items }, // 3. items
      { rows: [] }, // 4. UPDATE
    ]);

    const fetchMock = mockFetchOnceOk({
      orderId: 555000,
      orderNumber: shipmentRow.id,
      orderKey: `echelon-wms-shp-${shipmentRow.id}`,
      orderStatus: "awaiting_shipment",
    });
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db);
    const result = await svc.pushShipment(shipmentRow.id);

    expect(result.shipstationOrderId).toBe(555000);
    expect(result.orderKey).toBe(`echelon-wms-shp-${shipmentRow.id}`);

    // 4 db.execute calls: shipment, order, items, UPDATE.
    expect(mock.getCallCount()).toBe(4);

    // One fetch call to /orders/createorder.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toContain("/orders/createorder");
    expect(init.method).toBe("POST");

    const payload = JSON.parse(init.body);
    expect(payload.orderKey).toBe(`echelon-wms-shp-${shipmentRow.id}`);
    expect(payload.orderStatus).toBe("awaiting_shipment");
    expect(payload.amountPaid).toBe(orderRow.amount_paid_cents / 100);
    expect(payload.taxAmount).toBe(orderRow.tax_cents / 100);
    expect(payload.shippingAmount).toBe(orderRow.shipping_cents / 100);
    expect(payload.items.length).toBe(1);
    expect(payload.items[0].sku).toBe("ABC-1");
    expect(payload.items[0].quantity).toBe(2);
    expect(payload.items[0].unitPrice).toBe(25);
    expect(payload.items[0].lineItemKey).toBe(`wms-item-${items[0].id}`);
    expect(payload.advancedOptions.customField1).toBe(orderRow.sort_rank);
    expect(payload.advancedOptions.customField2).toBe(
      `wms_order_id:${orderRow.id}|shipment_id:${shipmentRow.id}`,
    );
    expect(payload.advancedOptions.customField3).toBe(
      `oms_order_id:${orderRow.oms_fulfillment_order_id}`,
    );
    expect(payload.shipTo.street1).toBe(orderRow.shipping_address);
    expect(payload.customerEmail).toBe(orderRow.customer_email);
  });

  it("adds the EB- prefix for eBay channel orders", async () => {
    const EBAY_CHANNEL_ID = 67;
    const shipmentRow = okShipment({ channel_id: EBAY_CHANNEL_ID });
    const orderRow = okOrder({
      channel_id: EBAY_CHANNEL_ID,
      order_number: "EBAY-123",
    });
    const items = [okItem()];

    const mock = makeDb([
      { rows: [shipmentRow] },
      { rows: [orderRow] },
      { rows: items },
      { rows: [] },
    ]);
    globalThis.fetch = mockFetchOnceOk({
      orderId: 42,
      orderNumber: "EB-EBAY-123",
      orderKey: `echelon-wms-shp-${shipmentRow.id}`,
      orderStatus: "awaiting_shipment",
    }) as any;

    const svc = createShipStationService(mock.db);
    await svc.pushShipment(shipmentRow.id);

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const payload = JSON.parse(init.body);
    expect(payload.orderNumber).toBe("EB-EBAY-123");
  });
});

describe("pushShipment :: error cases", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("throws ShipStationPushError when shipment is not found", async () => {
    const mock = makeDb([{ rows: [] }]);
    const svc = createShipStationService(mock.db);
    await expect(svc.pushShipment(9999)).rejects.toBeInstanceOf(
      ShipStationPushError,
    );
  });

  it("throws when shipment status is 'shipped' (cannot re-push)", async () => {
    const mock = makeDb([
      { rows: [okShipment({ status: "shipped" })] },
    ]);
    const svc = createShipStationService(mock.db);
    let err: ShipStationPushError | undefined;
    try {
      await svc.pushShipment(okShipment().id);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("shipment.status");
    expect(err?.context.value).toBe("shipped");
  });

  it("throws when shipment status is 'cancelled'", async () => {
    const mock = makeDb([
      { rows: [okShipment({ status: "cancelled" })] },
    ]);
    const svc = createShipStationService(mock.db);
    await expect(svc.pushShipment(okShipment().id)).rejects.toBeInstanceOf(
      ShipStationPushError,
    );
  });

  it("throws when the wms order is not found", async () => {
    const mock = makeDb([
      { rows: [okShipment()] },
      { rows: [] }, // order missing
    ]);
    const svc = createShipStationService(mock.db);
    let err: ShipStationPushError | undefined;
    try {
      await svc.pushShipment(okShipment().id);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("order");
  });

  it("throws when shipment has no items", async () => {
    const mock = makeDb([
      { rows: [okShipment()] },
      { rows: [okOrder()] },
      { rows: [] }, // items missing
    ]);
    const svc = createShipStationService(mock.db);
    let err: ShipStationPushError | undefined;
    try {
      await svc.pushShipment(okShipment().id);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("items");
  });

  it("lets SS API 500 errors bubble (no silent swallow)", async () => {
    const mock = makeDb([
      { rows: [okShipment()] },
      { rows: [okOrder()] },
      { rows: [okItem()] },
    ]);
    globalThis.fetch = mockFetchOnce500() as any;

    const svc = createShipStationService(mock.db);
    await expect(svc.pushShipment(okShipment().id)).rejects.toThrow(
      /ShipStation API POST/,
    );

    // UPDATE must NOT be called on API failure — shipment stays 'planned'
    // so the reconcile loop picks it up. We know this because there were
    // only 3 scripted db responses; a 4th execute would return the default
    // empty object. Assert exactly 3 execute calls occurred.
    expect(mock.getCallCount()).toBe(3);
  });

  it("rejects invalid shipmentId (zero / negative / float) up front", async () => {
    const mock = makeDb([]);
    const svc = createShipStationService(mock.db);
    await expect(svc.pushShipment(0)).rejects.toBeInstanceOf(
      ShipStationPushError,
    );
    await expect(svc.pushShipment(-1)).rejects.toBeInstanceOf(
      ShipStationPushError,
    );
    await expect(svc.pushShipment(1.5 as any)).rejects.toBeInstanceOf(
      ShipStationPushError,
    );
    // No DB access on input-validation failures.
    expect(mock.getCallCount()).toBe(0);
  });

  it("throws ShipStationPushError when a line has $0 unit_price (integration of validator)", async () => {
    const mock = makeDb([
      { rows: [okShipment()] },
      { rows: [okOrder()] },
      { rows: [okItem({ unit_price_cents: 0 })] },
    ]);
    globalThis.fetch = mockFetchOnceOk({}) as any;

    const svc = createShipStationService(mock.db);
    let err: ShipStationPushError | undefined;
    try {
      await svc.pushShipment(okShipment().id);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("items[0].unit_price_cents");

    // Critical: fetch must NOT have been called — validation stops us
    // BEFORE we emit a $0 order to ShipStation. This is the whole point
    // of Commit 11.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
