/**
 * Unit tests for pushShipment + validateShipmentForPush (§6 Commit 11).
 *
 * Scope: validator is a pure function (no mocks). pushShipment uses a
 * small hand-rolled db mock + global fetch mock — no network, no real
 * DB. The whole point of these tests is to protect the two invariants
 * that motivated the refactor:
 *
 *   1. No silent bad-data push (audit B1 / issue #56430).
 *      validateShipmentForPush rejects negative/float line unit_price_cents
 *      (0 is allowed — free items), negative amount_paid_cents, negative
 *      total_cents, and a missing shipping address. (The old line-sum vs
 *      total reconciliation was removed in #58276 — see that test.)
 *
 *   2. No re-push of already-terminal shipments.
 *      pushShipment throws on status NOT IN ('planned','queued','voided').
 *
 * Structural assertions match coding-standards Rule #9 (happy path +
 * explicit edge cases) and Rule #15 (test coverage explanation in the
 * completion report).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createShipStationService,
  validateShipmentForPush,
  normalizeCountryToIso2,
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
    oms_fulfillment_order_id: null,
    sort_rank: "0000000100",
    external_order_id: "EXT-1001",
    customer_name: "Jane Customer",
    customer_email: "jane@example.com",
    shipping_name: "Jane Customer",
    shipping_company: null,
    shipping_address: "123 Main St",
    shipping_address2: null,
    shipping_city: "Springfield",
    shipping_state: "IL",
    shipping_postal_code: "62701",
    shipping_country: "US",
    amount_paid_cents: 5913,
    tax_cents: 413,
    shipping_cents: 500,
    discount_cents: 0,
    total_cents: 5913, // 5000 + 413 + 500 = 5913
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

  it("accepts mixed physical and non-shipping order totals", () => {
    expect(() =>
      validateShipmentForPush(
        okShipment(),
        okOrder({
          total_cents: 3343,
          shipping_cents: 799,
          tax_cents: 0,
          non_shipping_total_cents: 100,
        }),
        [
          okItem({ id: 1, unit_price_cents: 998, qty: 1 }),
          okItem({ id: 2, unit_price_cents: 723, qty: 2 }),
        ],
      ),
    ).not.toThrow();
  });

  it("accepts partial shipments whose lines do not equal the full order total", () => {
    expect(() =>
      validateShipmentForPush(
        okShipment(),
        okOrder({
          total_cents: 4600,
          shipping_cents: 799,
          tax_cents: 0,
          is_partial_shipment: true,
        }),
        [
          okItem({ id: 1, unit_price_cents: 279, qty: 2 }),
        ],
      ),
    ).not.toThrow();
  });

  it("accepts per-unit rounding deltas on multi-quantity lines", () => {
    expect(() =>
      validateShipmentForPush(
        okShipment(),
        okOrder({
          total_cents: 47378,
          shipping_cents: 0,
          tax_cents: 0,
          non_shipping_total_cents: 78,
        }),
        [
          okItem({ id: 1, unit_price_cents: 7883, qty: 6 }),
        ],
      ),
    ).not.toThrow();
  });

  it("accepts non-shipping totals returned as strings from SQL aggregates", () => {
    expect(() =>
      validateShipmentForPush(
        okShipment(),
        okOrder({
          total_cents: 47378,
          shipping_cents: 0,
          tax_cents: 0,
          non_shipping_total_cents: "78" as any,
        }),
        [
          okItem({ id: 1, unit_price_cents: 7883, qty: 6 }),
        ],
      ),
    ).not.toThrow();
  });

  it("accepts #57215 after donation discount allocations are corrected", () => {
    expect(() =>
      validateShipmentForPush(
        okShipment({ id: 734 }),
        okOrder({
          total_cents: 47378,
          shipping_cents: 0,
          tax_cents: 0,
          non_shipping_total_cents: 100,
        }),
        [
          okItem({ id: 304098, unit_price_cents: 7880, qty: 6 }),
        ],
      ),
    ).not.toThrow();
  });

  it("accepts multiple valid lines with sum matching total_cents", () => {
    expect(() =>
      validateShipmentForPush(
        okShipment(),
        okOrder({ total_cents: 10913 }), // 10000 + 413 + 500 = 10913
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
        okOrder({ total_cents: 10915 }), // 10000 + 413 + 500 + 2 = 10915
        [
          okItem({ id: 1, unit_price_cents: 2500, qty: 2 }),
          okItem({ id: 2, unit_price_cents: 2500, qty: 2 }),
        ],
      ),
    ).not.toThrow();
  });
});

describe("validateShipmentForPush :: line-level pricing violations", () => {


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
      validateShipmentForPush(okShipment(), okOrder({ total_cents: 10913 }), [
        okItem({ id: 1, unit_price_cents: 2500, qty: 2 }),
        okItem({ id: 2, unit_price_cents: -100, qty: 2 }),
      ]);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err?.context.field).toBe("items[1].unit_price_cents");
  });
});

describe("validateShipmentForPush :: header-level violations", () => {
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

  it("does not reconcile line totals — proceeds on any totals", () => {
    // The line-sum vs total_cents reconciliation was removed (#58276): it was
    // warn-only and structurally wrong. A totals mismatch must neither throw
    // nor warn now — ShipStation accepts whatever totals we send.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      validateShipmentForPush(
        okShipment(),
        okOrder({ total_cents: 5924 }),
        [okItem({ unit_price_cents: 2500, qty: 2 })],
      ),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("total_cents mismatch"),
    );
    warn.mockRestore();
  });

  it("does not throw on a free / 100%-discount order (regression #58276)", () => {
    // Free items via a 100% discount: line prices are $0 and the discount
    // ($32.97) exceeds the line sum, so the old reconciliation computed a
    // NEGATIVE total (-2552) and ensureCents() hard-threw, stranding the
    // order — it never reached ShipStation. With the check removed it
    // validates cleanly (customer still paid $7.45 shipping+tax).
    expect(() =>
      validateShipmentForPush(
        okShipment(),
        okOrder({
          amount_paid_cents: 745,
          tax_cents: 46,
          shipping_cents: 699,
          discount_cents: 3297,
          total_cents: 745,
        }),
        [
          okItem({ id: 1, unit_price_cents: 0, qty: 1 }),
          okItem({ id: 2, unit_price_cents: 0, qty: 1 }),
          okItem({ id: 3, unit_price_cents: 0, qty: 1 }),
        ],
      ),
    ).not.toThrow();
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

  it("accepts missing customer_email because ShipStation can still ship with a valid address", () => {
    expect(() =>
      validateShipmentForPush(
        okShipment(),
        okOrder({ customer_email: null }),
        [okItem()],
      ),
    ).not.toThrow();
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

// ─── Country normalization (ShipStation requires ISO 3166-1 alpha-2) ──
// Motivated by the live 'shipstation_shipment_push' dead-letter loop: orders
// stored with the full country name "United States" 400'd on every push
// ("Please use a 2 character country code"), dead-lettered, and were
// re-enqueued by the reconciler indefinitely.

describe("normalizeCountryToIso2", () => {
  it("passes through real ISO2 codes, uppercased", () => {
    expect(normalizeCountryToIso2("US")).toBe("US");
    expect(normalizeCountryToIso2("us")).toBe("US");
    expect(normalizeCountryToIso2("ca")).toBe("CA");
    expect(normalizeCountryToIso2("  GB  ")).toBe("GB");
  });

  it("maps full English country names to ISO2 (the bug class)", () => {
    expect(normalizeCountryToIso2("United States")).toBe("US");
    expect(normalizeCountryToIso2("united states of america")).toBe("US");
    expect(normalizeCountryToIso2("USA")).toBe("US");
    expect(normalizeCountryToIso2("Canada")).toBe("CA");
    expect(normalizeCountryToIso2("United Kingdom")).toBe("GB");
    expect(normalizeCountryToIso2("United Arab Emirates")).toBe("AE");
    expect(normalizeCountryToIso2("Netherlands")).toBe("NL");
    expect(normalizeCountryToIso2("Japan")).toBe("JP");
    expect(normalizeCountryToIso2("Puerto Rico")).toBe("PR");
    expect(normalizeCountryToIso2("Turkey")).toBe("TR");
  });

  it("corrects the common non-ISO alias 'UK' to 'GB'", () => {
    expect(normalizeCountryToIso2("UK")).toBe("GB");
    expect(normalizeCountryToIso2("uk")).toBe("GB");
  });

  it("strips diacritics so localized names still map", () => {
    expect(normalizeCountryToIso2("México")).toBe("MX");
    expect(normalizeCountryToIso2("Türkiye")).toBe("TR");
  });

  it("rejects bogus 2-letter codes instead of forwarding them to ShipStation", () => {
    // The old permissive regex let any 2-letter string through, so "XX" was
    // POSTed verbatim and 400-looped. It must now be rejected (null → the
    // validator throws a precise permanent error before the network call).
    expect(normalizeCountryToIso2("XX")).toBeNull();
    expect(normalizeCountryToIso2("ZZ")).toBeNull();
    expect(normalizeCountryToIso2("EN")).toBeNull();
  });

  it("returns null for empty/nullish/unmappable input", () => {
    expect(normalizeCountryToIso2(null)).toBeNull();
    expect(normalizeCountryToIso2(undefined)).toBeNull();
    expect(normalizeCountryToIso2("")).toBeNull();
    expect(normalizeCountryToIso2("   ")).toBeNull();
    expect(normalizeCountryToIso2("Freedonia")).toBeNull();
    expect(normalizeCountryToIso2("Not A Country")).toBeNull();
  });
});

describe("validateShipmentForPush :: shipping country", () => {
  it("accepts a full country name that maps to ISO2 (normalized downstream)", () => {
    expect(() =>
      validateShipmentForPush(okShipment(), okOrder({ shipping_country: "United States" }), [okItem()]),
    ).not.toThrow();
  });

  it("accepts an empty country (defaults to US at push time)", () => {
    expect(() =>
      validateShipmentForPush(okShipment(), okOrder({ shipping_country: "" }), [okItem()]),
    ).not.toThrow();
  });

  it("throws a permanent SS_PUSH_INVALID_SHIPMENT for a non-empty unmappable country", () => {
    let err: ShipStationPushError | undefined;
    try {
      validateShipmentForPush(okShipment(), okOrder({ shipping_country: "Freedonia" }), [okItem()]);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.code).toBe(SS_PUSH_INVALID_SHIPMENT);
    expect(err?.context.field).toBe("order.shipping_country");
    expect(err?.context.value).toBe("Freedonia");
  });
});

// ─── pushShipment (mocked db + fetch) ────────────────────────────────

// Minimal db mock supporting db.execute(sql`...`) with a scripted response
// queue. Each call shifts the next entry off `responses`. Tests push
// responses in the order the code reads them:
//   1. shipment header
//   2. order row
//   3. non-shipping total aggregate
//   4. items list
//   5. UPDATE wms.outbound_shipments (not awaited for rows, returns empty)

interface DbCall {
  kind: "execute";
  // We don't introspect SQL here; order-based scripting is enough for
  // this unit test and keeps the mock trivial.
}

function makeDb(scripted: Array<any>) {
  const calls: DbCall[] = [];
  const remaining = [...scripted];

  const getNextRows = () => {
    calls.push({ kind: "execute" });
    if (remaining.length === 0) return [];
    const next = remaining.shift();
    return next.rows || [];
  };

  const chainable: any = {
    from: () => chainable,
    innerJoin: () => chainable,
    where: () => chainable,
    limit: () => chainable,
    orderBy: () => chainable,
    then: (resolve: any) => resolve(getNextRows()),
  };

  const select = vi.fn(() => chainable);

  const execute = vi.fn(async (query: any) => {
    // pushShipment serializes per-shipment with pg_advisory_lock/unlock.
    // Those are infrastructure, not data — don't consume a scripted response
    // for them, so the order-based scripts below stay unchanged.
    let text = "";
    try {
      const chunks = (query as any)?.queryChunks;
      text = Array.isArray(chunks)
        ? chunks.map((c: any) => (typeof c === "string" ? c : c?.value?.join?.("") ?? "")).join("")
        : String(query);
    } catch {
      text = "";
    }
    if (/advisory_(lock|unlock)/i.test(text)) {
      return { rows: [] };
    }
    calls.push({ kind: "execute" });
    if (remaining.length === 0) {
      return { rows: [] };
    }
    const next = remaining.shift();
    return next;
  });
  return { db: { execute, select }, execute, getCallCount: () => calls.length };
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

function mockFetchQueue(responses: any[]) {
  const remaining = [...responses];
  return vi.fn(async (_url: string, _init: any) => {
    if (remaining.length === 0) {
      throw new Error("Unexpected fetch call");
    }
    const json = remaining.shift();
    return {
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
      headers: new Map<string, string>() as any,
    };
  });
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
      { rows: [{ non_shipping_total_cents: 0 }] }, // 3. non-shipping aggregate
      { rows: items }, // 4. items
      { rows: [] }, // 5. UPDATE
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

    // 9 db calls: shipment, order, non-shipping aggregate, items,
    // shippable shipment-scope aggregate, channel config, UPDATE,
    // then shipment-rollup order + shipment status reads.
    expect(mock.getCallCount()).toBe(10);

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
      `oms_order_id:${orderRow.oms_fulfillment_order_id ?? ""}`,
    );
    expect(payload.shipTo.street1).toBe(orderRow.shipping_address);
    expect(payload.shipTo.street2).toBe("");
    expect(payload.shipTo.company).toBe("");
    expect(payload.customerEmail).toBe(orderRow.customer_email);
  });

  it("uses a stable placeholder email when WMS has no customer email", async () => {
    const shipmentRow = okShipment();
    const orderRow = okOrder({ customer_email: null });
    const items = [okItem()];

    const mock = makeDb([
      { rows: [shipmentRow] },
      { rows: [orderRow] },
      { rows: [{ non_shipping_total_cents: 0 }] },
      { rows: items },
      { rows: [] },
    ]);

    const fetchMock = mockFetchOnceOk({
      orderId: 555001,
      orderNumber: shipmentRow.id,
      orderKey: `echelon-wms-shp-${shipmentRow.id}`,
      orderStatus: "awaiting_shipment",
    });
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db);
    await svc.pushShipment(shipmentRow.id);

    const createOrderCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/orders/createorder"),
    );
    expect(createOrderCall).toBeDefined();
    const [, init] = createOrderCall as any;
    const payload = JSON.parse(init.body);
    expect(payload.customerEmail).toBe(`no-email+wms-${orderRow.id}@cardshellz.local`);
    expect(payload.shipTo.street1).toBe(orderRow.shipping_address);
  });

  it("sends address line 2 and company name to ShipStation", async () => {
    const shipmentRow = okShipment();
    const orderRow = okOrder({
      shipping_company: "Acme Card Shop",
      shipping_address: "123 Main St",
      shipping_address2: "Suite 400",
    });
    const mock = makeDb([
      { rows: [shipmentRow] },
      { rows: [orderRow] },
      { rows: [{ non_shipping_total_cents: 0 }] },
      { rows: [okItem()] },
      { rows: [] },
      { rows: [] },
    ]);
    const fetchMock = mockFetchOnceOk({
      orderId: 555000,
      orderNumber: shipmentRow.id,
      orderKey: `echelon-wms-shp-${shipmentRow.id}`,
      orderStatus: "awaiting_shipment",
    });
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db);
    await svc.pushShipment(shipmentRow.id);

    const createOrderCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/orders/createorder"),
    );
    expect(createOrderCall).toBeDefined();
    const [, init] = createOrderCall as any;
    const payload = JSON.parse(init.body);
    expect(payload.shipTo.company).toBe("Acme Card Shop");
    expect(payload.shipTo.street1).toBe("123 Main St");
    expect(payload.shipTo.street2).toBe("Suite 400");
  });

  it("re-pushes a previously-voided shipment and clears void columns on transition to queued", async () => {
    // §6 Commit 18 re-label flow. The shipment comes back from a voided
    // state; pushShipment must accept it and the UPDATE must NULL out
    // voided_at + voided_reason so the freshly re-queued shipment has
    // no stale void metadata for operators or reconcile to trip over.
    const shipmentRow = okShipment({ status: "voided" });
    const orderRow = okOrder();
    const items = [okItem()];

    const mock = makeDb([
      { rows: [shipmentRow] }, // 1. shipment (status=voided)
      { rows: [orderRow] },     // 2. order
      { rows: [{ non_shipping_total_cents: 0 }] }, // 3. non-shipping aggregate
      { rows: items },          // 4. items
      { rows: [] },             // 5. UPDATE
    ]);

    const fetchMock = mockFetchOnceOk({
      // SS upserts on orderKey so the same orderId comes back.
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
    // Same 4-call sequence as a fresh push — voided re-push doesn't
    // add any reads/writes; the single UPDATE simply also NULLs the
    // void columns.
    expect(mock.getCallCount()).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Inspect the UPDATE's SQL text: must set status='queued' and must
    // also clear voided_at + voided_reason so stale void state cannot
    // survive a successful re-label push. Find the UPDATE call by content
    // (robust to the per-shipment advisory lock/unlock execute calls that
    // wrap the push) rather than a hardcoded index.
    const sqlTextOf = (q: any): string =>
      ((q?.queryChunks ?? []) as unknown[])
        .map((c) => {
          if (typeof c === "string") return c;
          if (c && typeof c === "object" && Array.isArray((c as any).value)) {
            return (c as any).value.join("");
          }
          return "";
        })
        .join("");
    const updateCall = mock.execute.mock.calls.find((call) =>
      sqlTextOf(call[0]).includes("UPDATE wms.outbound_shipments"),
    );
    const sqlText = sqlTextOf(updateCall?.[0]);
    expect(sqlText).toContain("UPDATE wms.outbound_shipments");
    expect(sqlText).toContain("status = 'queued'");
    expect(sqlText).toMatch(/voided_at\s*=\s*NULL/);
    expect(sqlText).toMatch(/voided_reason\s*=\s*NULL/);
  });

  it("includes existing SS orderId in payload when re-pushing a queued shipment (idempotent update)", async () => {
    const shipmentRow = okShipment({
      status: "queued",
      shipstation_order_id: 555000,
      shipstation_order_key: "echelon-wms-shp-9001",
    });
    const orderRow = okOrder();
    const items = [okItem()];

    const mock = makeDb([
      { rows: [shipmentRow] },
      { rows: [orderRow] },
      { rows: [{ non_shipping_total_cents: 0 }] },
      { rows: items },
      { rows: [] },
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

    const createOrderCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/orders/createorder"),
    );
    expect(createOrderCall).toBeDefined();
    const [, init] = createOrderCall as any;
    const payload = JSON.parse(init.body);
    expect(payload.orderId).toBe(555000);
    expect(payload.orderKey).toBe(`echelon-wms-shp-${shipmentRow.id}`);
  });

  it("does NOT include orderId in payload for a fresh planned shipment", async () => {
    const shipmentRow = okShipment({ status: "planned" });
    const orderRow = okOrder();
    const items = [okItem()];

    const mock = makeDb([
      { rows: [shipmentRow] },
      { rows: [orderRow] },
      { rows: [{ non_shipping_total_cents: 0 }] },
      { rows: items },
      { rows: [] },
    ]);

    const fetchMock = mockFetchOnceOk({
      orderId: 555001,
      orderNumber: shipmentRow.id,
      orderKey: `echelon-wms-shp-${shipmentRow.id}`,
      orderStatus: "awaiting_shipment",
    });
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db);
    await svc.pushShipment(shipmentRow.id);

    const [, init] = fetchMock.mock.calls[0] as any;
    const payload = JSON.parse(init.body);
    expect(payload.orderId).toBeUndefined();
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
      { rows: [{ non_shipping_total_cents: 0 }] },
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

// ─── SS-order-level dedup across sibling shipments ─────────────────────
// A duplicate full shipment for the same WMS order must NOT create a second
// ShipStation order. pushShipment adopts the sibling shipment's SS order id
// + orderKey so one WMS order maps to exactly one ShipStation order.
describe("pushShipment :: sibling-shipment dedup", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  // SQL-aware mock: select() is counter-based (shipment, order, items);
  // execute() branches on SQL text so we can return a sibling row for the
  // dedup probe specifically.
  function sqlTextOf(query: any): string {
    const chunks: unknown[] = query?.queryChunks ?? [];
    return chunks
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && Array.isArray((c as any).value)) {
          return (c as any).value.join("");
        }
        return "";
      })
      .join("");
  }

  function makeSqlAwareDb(opts: {
    shipment: WmsShipmentRow;
    order: WmsOrderRow;
    items: WmsShipmentItemRow[];
    sibling: {
      id: number;
      shipstation_order_id: number;
      shipstation_order_key: string;
    } | null;
    // full shipment by default (not partial)
    orderShippableQty?: number;
    shipmentShippableQty?: number;
  }) {
    let selectCount = 0;
    const select = vi.fn(() => {
      const chainable: any = {
        from: () => chainable,
        innerJoin: () => chainable,
        where: () => chainable,
        limit: () => chainable,
        orderBy: () => chainable,
        then: (resolve: any) => {
          selectCount += 1;
          if (selectCount === 1) return resolve([opts.shipment]);
          if (selectCount === 2) return resolve([opts.order]);
          return resolve(opts.items);
        },
      };
      return chainable;
    });

    const execute = vi.fn(async (query: any) => {
      const text = sqlTextOf(query);
      if (text.includes("non_shipping_total_cents")) {
        return { rows: [{ non_shipping_total_cents: 0 }] };
      }
      if (text.includes("order_shippable_qty")) {
        return {
          rows: [
            {
              order_shippable_qty: opts.orderShippableQty ?? 2,
              shipment_shippable_qty: opts.shipmentShippableQty ?? 2,
            },
          ],
        };
      }
      // The dedup probe — identified by the is_self computed column.
      if (text.includes("is_self")) {
        return { rows: opts.sibling ? [{ ...opts.sibling, is_self: false }] : [] };
      }
      // routing lookups, UPDATE, recompute reads → empty
      return { rows: [] };
    });

    return { db: { execute, select }, execute, select };
  }

  it("adopts a sibling shipment's SS order id + key instead of creating a second SS order", async () => {
    // Two shipment rows for WMS order 42 (a sync race that slipped past the
    // upstream guards). Sibling shipment 8000 already created SS order 777.
    const shipmentRow = okShipment({ id: 9001, order_id: 42, status: "planned" });
    const orderRow = okOrder({ id: 42, oms_fulfillment_order_id: null });
    const items = [okItem()];

    const mock = makeSqlAwareDb({
      shipment: shipmentRow,
      order: orderRow,
      items,
      sibling: {
        id: 8000,
        shipstation_order_id: 777,
        shipstation_order_key: "echelon-wms-shp-8000",
      },
    });

    const fetchMock = mockFetchOnceOk({
      orderId: 777,
      orderNumber: orderRow.order_number,
      orderKey: "echelon-wms-shp-8000",
      orderStatus: "awaiting_shipment",
    });
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db as any);
    const result = await svc.pushShipment(shipmentRow.id);

    // SS push must carry the sibling's orderId (an UPDATE, not a CREATE)
    // and the sibling's stable orderKey.
    const [, init] = fetchMock.mock.calls[0] as any;
    const payload = JSON.parse(init.body);
    expect(payload.orderId).toBe(777);
    expect(payload.orderKey).toBe("echelon-wms-shp-8000");
    expect(result.shipstationOrderId).toBe(777);
    expect(result.orderKey).toBe("echelon-wms-shp-8000");
  });

  it("creates a new SS order when no sibling exists (no false dedup)", async () => {
    const shipmentRow = okShipment({ id: 9002, order_id: 43, status: "planned" });
    const orderRow = okOrder({ id: 43, oms_fulfillment_order_id: null });
    const items = [okItem()];

    const mock = makeSqlAwareDb({
      shipment: shipmentRow,
      order: orderRow,
      items,
      sibling: null,
    });

    const fetchMock = mockFetchOnceOk({
      orderId: 888,
      orderNumber: orderRow.order_number,
      orderKey: `echelon-wms-shp-${shipmentRow.id}`,
      orderStatus: "awaiting_shipment",
    });
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db as any);
    const result = await svc.pushShipment(shipmentRow.id);

    const [, init] = fetchMock.mock.calls[0] as any;
    const payload = JSON.parse(init.body);
    // No sibling → CREATE: no orderId, own per-shipment key.
    expect(payload.orderId).toBeUndefined();
    expect(payload.orderKey).toBe(`echelon-wms-shp-${shipmentRow.id}`);
    expect(result.orderKey).toBe(`echelon-wms-shp-${shipmentRow.id}`);
  });

  it("does NOT collapse a genuine PARTIAL shipment onto a sibling SS order", async () => {
    // Partial shipment: shipment covers fewer pieces than the order, so it
    // legitimately gets its OWN ShipStation order even though a sibling
    // already pushed.
    const shipmentRow = okShipment({ id: 9003, order_id: 44, status: "planned" });
    const orderRow = okOrder({ id: 44, oms_fulfillment_order_id: null });
    const items = [okItem()];

    const mock = makeSqlAwareDb({
      shipment: shipmentRow,
      order: orderRow,
      items,
      sibling: {
        id: 8100,
        shipstation_order_id: 999,
        shipstation_order_key: "echelon-wms-shp-8100",
      },
      orderShippableQty: 5, // order needs 5
      shipmentShippableQty: 2, // this box only ships 2 → partial
    });

    const fetchMock = mockFetchOnceOk({
      orderId: 1010,
      orderNumber: orderRow.order_number,
      orderKey: `echelon-wms-shp-${shipmentRow.id}`,
      orderStatus: "awaiting_shipment",
    });
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db as any);
    const result = await svc.pushShipment(shipmentRow.id);

    const [, init] = fetchMock.mock.calls[0] as any;
    const payload = JSON.parse(init.body);
    // Partial → must NOT adopt sibling 999; keeps its own key, creates new.
    expect(payload.orderId).toBeUndefined();
    expect(payload.orderKey).toBe(`echelon-wms-shp-${shipmentRow.id}`);
    expect(result.orderKey).toBe(`echelon-wms-shp-${shipmentRow.id}`);
  });
});

describe("ShipStation WMS hold/sort sync", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("holds active WMS shipment ShipStation orders and refreshes customField1", async () => {
    const sortRank = "0-0-0150-000000-8220412154";
    const mock = makeDb([
      {
        rows: [
          { id: 1719, shipstation_order_id: 741033983 },
          { id: 1720, shipstation_order_id: 741033984 },
        ],
      },
      { rows: [{ sort_rank: sortRank }] },
    ]);
    const fetchMock = mockFetchQueue([
      {},
      {},
      { orderId: 741033983, orderKey: "echelon-wms-shp-1719", advancedOptions: { customField2: "keep" } },
      { orderId: 741033983 },
      { orderId: 741033984, orderKey: "echelon-wms-shp-1720", advancedOptions: { customField2: "keep" } },
      { orderId: 741033984 },
    ]);
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db);
    await expect(
      svc.syncWmsOrderShipStationHoldState(202542, "hold"),
    ).resolves.toEqual({ touched: 2 });

    expect(mock.getCallCount()).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    const holdBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/orders/holduntil"))
      .map(([, init]) => JSON.parse((init as any).body));
    expect(holdBodies).toEqual([
      { orderId: 741033983, holdUntilDate: "2099-12-31" },
      { orderId: 741033984, holdUntilDate: "2099-12-31" },
    ]);

    const upsertBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/orders/createorder"))
      .map(([, init]) => JSON.parse((init as any).body));
    expect(upsertBodies).toHaveLength(2);
    expect(upsertBodies[0].orderId).toBe(741033983);
    expect(upsertBodies[0].customField1).toBe(sortRank);
    expect(upsertBodies[0].advancedOptions).toMatchObject({
      customField1: sortRank,
      customField2: "keep",
    });
    expect(upsertBodies[1].orderId).toBe(741033984);
    expect(upsertBodies[1].advancedOptions.customField1).toBe(sortRank);
  });

  it("releases active WMS shipment ShipStation orders instead of reading OMS header ids", async () => {
    const mock = makeDb([
      { rows: [{ id: 1719, shipstation_order_id: 741033983 }] },
      { rows: [{ sort_rank: "1-0-0150-000000-8220412154" }] },
    ]);
    const fetchMock = mockFetchQueue([
      {},
      { orderId: 741033983, orderKey: "echelon-wms-shp-1719" },
      { orderId: 741033983 },
    ]);
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db);
    await expect(
      svc.syncWmsOrderShipStationHoldState(202542, "release"),
    ).resolves.toEqual({ touched: 1 });

    const releaseCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/orders/restorefromhold"),
    );
    expect(releaseCall).toBeTruthy();
    expect(JSON.parse((releaseCall![1] as any).body)).toEqual({
      orderId: 741033983,
    });
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

  it("throws when shipment requires review even if it is otherwise pushable", async () => {
    const mock = makeDb([
      {
        rows: [
          okShipment({
            status: "queued",
            requires_review: true,
            review_reason: "shipstation_queue_review",
          }),
        ],
      },
    ]);
    const svc = createShipStationService(mock.db);
    let err: ShipStationPushError | undefined;
    try {
      await svc.pushShipment(okShipment().id);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("shipment.requires_review");
    expect(err?.context.value).toBe("shipstation_queue_review");
  });

  it("throws when shipment is held (line-item hold — a held shipment is never pushed)", async () => {
    const mock = makeDb([
      { rows: [okShipment({ status: "queued", held: true })] },
    ]);
    const svc = createShipStationService(mock.db);
    let err: ShipStationPushError | undefined;
    try {
      await svc.pushShipment(okShipment().id);
    } catch (e) {
      err = e as ShipStationPushError;
    }
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("shipment.held");
    expect(err?.context.value).toBe(true);
  });

  it("throws when the owning WMS order is cancelled/refunded", async () => {
    const shipmentRow = okShipment({ status: "queued" });
    const mock = makeDb([
      { rows: [shipmentRow] },
      {
        rows: [
          okOrder({
            warehouse_status: "cancelled",
            financial_status: "refunded",
            cancelled_at: new Date("2026-05-22T12:00:00Z"),
          }),
        ],
      },
    ]);
    const svc = createShipStationService(mock.db);
    const err = await svc
      .pushShipment(shipmentRow.id)
      .catch((e: any) => e);
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("order.warehouse_status");
  });

  it("warns but pushes when the owning WMS order is already shipped (multi-shipment)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shipmentRow = okShipment({ status: "queued" });
    const mock = makeDb([
      { rows: [shipmentRow] },
      {
        rows: [
          okOrder({
            warehouse_status: "shipped",
            financial_status: "paid",
          }),
        ],
      },
      { rows: [{ non_shipping_total_cents: 0 }] },
      { rows: [okItem()] },
      { rows: [] }, // UPDATE
    ]);
    globalThis.fetch = mockFetchOnceOk({
      orderId: 42,
      orderStatus: "awaiting_shipment",
    }) as any;
    const svc = createShipStationService(mock.db);
    await expect(svc.pushShipment(shipmentRow.id)).resolves.toMatchObject({
      shipstationOrderId: 42,
    });
    warn.mockRestore();
  });

  it("throws when linked OMS is already shipped and fulfilled", async () => {
    const shipmentRow = okShipment({ status: "queued" });
    const mock = makeDb([
      { rows: [shipmentRow] },
      {
        rows: [
          okOrder({
            warehouse_status: "ready",
            financial_status: "paid",
            oms_fulfillment_order_id: "183763",
          }),
        ],
      },
      { rows: [{ status: "shipped", fulfillment_status: "fulfilled", financial_status: "paid" }] },
    ]);
    const svc = createShipStationService(mock.db);
    const err = await svc
      .pushShipment(shipmentRow.id)
      .catch((e: any) => e);
    expect(err).toBeInstanceOf(ShipStationPushError);
    expect(err?.context.field).toBe("oms.status");
    expect(err?.context.value).toBe("oms_fully_shipped");
  });

  it("allows a voided shipment to be pushed again for the re-label path", async () => {
    // Sibling to the two terminal-state rejection cases above: `voided`
    // is the ONE non-{planned,queued} status that pushShipment must
    // accept, because a voided label is re-pushable. Validate we get
    // past the status gate by providing the full scripted response
    // chain a real push walks through — if voided were still rejected,
    // execute would only be called once (the shipment SELECT).
    const shipmentRow = okShipment({ status: "voided" });
    const mock = makeDb([
      { rows: [shipmentRow] },
      { rows: [okOrder()] },
      { rows: [{ non_shipping_total_cents: 0 }] },
      { rows: [okItem()] },
      { rows: [] }, // UPDATE
    ]);
    globalThis.fetch = mockFetchOnceOk({
      orderId: 42,
      orderNumber: shipmentRow.id,
      orderKey: `echelon-wms-shp-${shipmentRow.id}`,
      orderStatus: "awaiting_shipment",
    }) as any;
    const svc = createShipStationService(mock.db);
    await expect(svc.pushShipment(shipmentRow.id)).resolves.toMatchObject({
      shipstationOrderId: 42,
    });
    // Nine calls fired: we went past the status gate and rollup reads.
    expect(mock.getCallCount()).toBe(10);
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
      { rows: [{ non_shipping_total_cents: 0 }] },
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
      { rows: [{ non_shipping_total_cents: 0 }] },
      { rows: [okItem()] },
    ]);
    globalThis.fetch = mockFetchOnce500() as any;

    const svc = createShipStationService(mock.db);
    await expect(svc.pushShipment(okShipment().id)).rejects.toThrow(
      /ShipStation API POST/,
    );

    // UPDATE must NOT be called on API failure.
    // Assert exactly 4 database calls occurred (shipment, order, items, channel config).
    expect(mock.getCallCount()).toBe(7);
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


});

// ─── Source invariant: never push a refund-zeroed line to ShipStation ─
// A partial refund can reduce one line of a multi-line queued shipment to
// qty=0 while the shipment still ships its other lines (Phase 1c re-push).
// The items query MUST filter qty > 0 so ShipStation never receives a
// quantity:0 line. The hand-rolled db mock stubs `.where()`, so this is a
// source-regression guard (same pattern as the refund idempotency guard).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("pushShipment :: never sends a zeroed line to ShipStation", () => {
  it("restricts the shipment-items query to shippable AND qty > 0", () => {
    const src = readFileSync(
      resolve(__dirname, "../../shipstation.service.ts"),
      "utf-8",
    );
    expect(src).toMatch(/COALESCE\(\$\{wmsOrderItems\.requiresShipping\}, 1\) = 1/);
    expect(src).toMatch(/\$\{outboundShipmentItems\.qty\}\s*>\s*0/);
  });
});
