/**
 * Unit tests for syncWmsOrderShipStationShipToAddress (2026-07 #58725).
 *
 * Invariants protected:
 *   1. NON-CLOBBERING — the SS update must send back ShipStation's OWN copy
 *      of the order (items, orderKey, advancedOptions, phone) with ONLY
 *      shipTo replaced. Never a WMS-rebuilt payload.
 *   2. PRE-LABEL ONLY — SS orders that are already shipped/cancelled are
 *      skipped; a printed label is a human decision.
 *   3. Never blank an address — no WMS shipping_address ⇒ no-op.
 *   4. Review-flag hygiene — success clears ONLY the
 *      'address_changed_after_push' reason (guard is in the UPDATE's WHERE).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createShipStationService } from "../../shipstation.service";

// Order-scripted db mock (same pattern as push-shipment.test.ts): each
// execute() shifts the next scripted response; select is unused here.
function makeDb(scripted: Array<any>) {
  const remaining = [...scripted];
  const executeCalls: any[] = [];
  const execute = vi.fn(async (query: any) => {
    executeCalls.push(query);
    if (remaining.length === 0) return { rows: [] };
    return remaining.shift();
  });
  const chainable: any = {
    from: () => chainable, innerJoin: () => chainable, where: () => chainable,
    limit: () => chainable, orderBy: () => chainable,
    then: (resolve: any) => resolve([]),
  };
  const db: any = { execute, select: vi.fn(() => chainable) };
  db.transaction = async (cb: any) => cb(db);
  return { db, execute, executeCalls };
}

function sqlTextOf(query: any): string {
  const chunks: unknown[] = query?.queryChunks ?? [];
  return chunks.map((c) => {
    if (typeof c === "string") return c;
    if (c && typeof c === "object" && Array.isArray((c as any).value)) {
      return (c as any).value.join("");
    }
    return "";
  }).join("");
}

function mockFetchQueue(responses: any[]) {
  const remaining = [...responses];
  return vi.fn(async (_url: string, _init: any) => {
    if (remaining.length === 0) throw new Error("Unexpected fetch call");
    const json = remaining.shift();
    return {
      ok: true, status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
      headers: new Map<string, string>() as any,
    };
  });
}

const WMS_ORDER_ROW = {
  shipping_name: "James Kealalio",
  shipping_company: null,
  shipping_address: "5821 Ahakea Street",
  shipping_address2: null,
  shipping_city: "KAPAA",
  shipping_state: "HI",
  shipping_postal_code: "96746",
  shipping_country: "US",
  customer_name: "James Kealalio",
};

const SS_ORDER = {
  orderId: 744000001,
  orderKey: "echelon-wms-shp-3254",
  orderNumber: "58725",
  orderStatus: "awaiting_shipment",
  items: [{ lineItemKey: "wms-item-1", sku: "ABC-1", quantity: 2, unitPrice: 25 }],
  advancedOptions: { storeId: 123, customField2: "keep-me" },
  shipTo: {
    name: "James Kealalio", street1: "5821 Ahakea Street",
    city: "Lihue", state: "HI", postalCode: "96766", country: "US",
    phone: "808-555-1234",
  },
};

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.SHIPSTATION_API_KEY = "test-key";
  process.env.SHIPSTATION_API_SECRET = "test-secret";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("syncWmsOrderShipStationShipToAddress :: happy path", () => {
  it("swaps ONLY shipTo on ShipStation's own copy and clears the address review flag", async () => {
    const mock = makeDb([
      { rows: [WMS_ORDER_ROW] },                                                  // wms.orders
      { rows: [{ id: 3254, status: "queued", shipstation_order_id: 744000001 }] }, // shipments
      { rows: [] },                                                                // review-flag clear UPDATE
    ]);
    const fetchMock = mockFetchQueue([
      SS_ORDER,            // GET /orders/744000001
      { orderId: 744000001 }, // POST /orders/createorder
    ]);
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db);
    const result = await svc.syncWmsOrderShipStationShipToAddress(42);

    expect(result).toEqual({ updated: 1, skipped: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [postUrl, postInit] = fetchMock.mock.calls[1] as any;
    expect(String(postUrl)).toContain("/orders/createorder");
    const body = JSON.parse(postInit.body);

    // shipTo replaced with the corrected WMS address…
    expect(body.shipTo.city).toBe("KAPAA");
    expect(body.shipTo.postalCode).toBe("96746");
    // …the phone ShipStation had is preserved (WMS carries none)…
    expect(body.shipTo.phone).toBe("808-555-1234");
    // …and EVERYTHING ELSE is ShipStation's own copy, untouched (invariant 1).
    expect(body.orderId).toBe(744000001);
    expect(body.orderKey).toBe("echelon-wms-shp-3254");
    expect(body.items).toEqual(SS_ORDER.items);
    expect(body.advancedOptions).toEqual(SS_ORDER.advancedOptions);

    // Review-flag clear targets ONLY the address reason (invariant 4).
    const updateSql = sqlTextOf(mock.executeCalls[2]);
    expect(updateSql).toContain("requires_review = false");
    expect(updateSql).toContain("review_reason = 'address_changed_after_push'");
  });
});

describe("syncWmsOrderShipStationShipToAddress :: guards", () => {
  it("skips a ShipStation order that is already shipped (invariant 2)", async () => {
    const mock = makeDb([
      { rows: [WMS_ORDER_ROW] },
      { rows: [{ id: 3254, status: "queued", shipstation_order_id: 744000001 }] },
    ]);
    const fetchMock = mockFetchQueue([{ ...SS_ORDER, orderStatus: "shipped" }]);
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db);
    const result = await svc.syncWmsOrderShipStationShipToAddress(42);

    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // GET only — no createorder
  });

  it("no-ops when WMS has no shipping address (invariant 3)", async () => {
    const mock = makeDb([
      { rows: [{ ...WMS_ORDER_ROW, shipping_address: null }] },
    ]);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db);
    const result = await svc.syncWmsOrderShipStationShipToAddress(42);

    expect(result).toEqual({ updated: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts an unfetchable ShipStation order as skipped, not updated", async () => {
    const mock = makeDb([
      { rows: [WMS_ORDER_ROW] },
      { rows: [{ id: 3254, status: "queued", shipstation_order_id: 744000001 }] },
    ]);
    // getOrderById swallows fetch errors and returns null
    const fetchMock = vi.fn(async () => { throw new Error("network down"); });
    globalThis.fetch = fetchMock as any;

    const svc = createShipStationService(mock.db);
    const result = await svc.syncWmsOrderShipStationShipToAddress(42);

    expect(result).toEqual({ updated: 0, skipped: 1 });
  });

  it("only pre-label WMS statuses are even queried (planned/queued/on_hold)", async () => {
    const mock = makeDb([
      { rows: [WMS_ORDER_ROW] },
      { rows: [] }, // shipments query returns nothing
    ]);
    globalThis.fetch = vi.fn() as any;

    const svc = createShipStationService(mock.db);
    await svc.syncWmsOrderShipStationShipToAddress(42);

    const shipmentsSql = sqlTextOf(mock.executeCalls[1]);
    expect(shipmentsSql).toContain("status IN ('planned', 'queued', 'on_hold')");
    expect(shipmentsSql).toContain("shipstation_order_id IS NOT NULL");
  });

  it("returns zeros when ShipStation is not configured", async () => {
    delete process.env.SHIPSTATION_API_KEY;
    delete process.env.SHIPSTATION_API_SECRET;
    const mock = makeDb([]);
    const svc = createShipStationService(mock.db);
    expect(await svc.syncWmsOrderShipStationShipToAddress(42)).toEqual({ updated: 0, skipped: 0 });
    expect(mock.execute).not.toHaveBeenCalled();
  });
});

describe("oms-webhooks wiring", () => {
  it("handleWmsAddressChange calls the ship-to sync for requires_review shipments", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("server/modules/oms/oms-webhooks.ts", "utf8");
    const fnStart = src.indexOf("async function handleWmsAddressChange");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSrc = src.slice(fnStart, fnStart + 4000);
    expect(fnSrc).toContain("anyRequiresReview");
    expect(fnSrc).toContain("syncWmsOrderShipStationShipToAddress");
  });
});
