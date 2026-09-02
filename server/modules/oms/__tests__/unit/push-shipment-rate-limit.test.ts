/**
 * pushShipment under a ShipStation 429 (the #62452 double-push class).
 *
 * Proves, end to end through the service:
 *   - a keyed CREATE that is rate limited is sent exactly once, surfaces a
 *     transient error (never the permanent SS_PUSH_INVALID_SHIPMENT code the
 *     retry worker dead-letters on), and writes no provider linkage;
 *   - the read-only pre-create lookup still replays after a 429;
 *   - the whole push runs under the per-shipment session lock runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createShipStationService,
  ShipStationRateLimitError,
  SS_PUSH_INVALID_SHIPMENT,
  SS_RATE_LIMITED,
} from "../../shipstation.service";

const SHIPMENT_ID = 9001;
const WMS_ORDER_ID = 42;

function shipmentHeaderRow() {
  return {
    id: SHIPMENT_ID,
    order_id: WMS_ORDER_ID,
    channel_id: 7,
    status: "planned",
    held: false,
    requires_review: false,
    review_reason: null,
    shipstation_order_id: null,
    shipstation_order_key: null,
    shipment_purpose: "customer_fulfillment",
    replaces_shipment_id: null,
    replacement_reason: null,
  };
}

function orderRow() {
  return {
    id: WMS_ORDER_ID,
    order_number: "62452",
    channel_id: 7,
    oms_fulfillment_order_id: null,
    sort_rank: "0000000100",
    external_order_id: "EXT-62452",
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
    total_cents: 5913,
    currency: "USD",
    order_placed_at: new Date("2026-08-30T12:00:00Z"),
    is_partial_shipment: false,
  };
}

function itemRow() {
  return {
    id: 111,
    order_item_id: 500,
    sku: "ABC-1",
    name: "Widget",
    qty: 2,
    unit_price_cents: 2500,
  };
}

/**
 * Minimal db double: `select()` chains resolve the scripted rows in order
 * (shipment header, order, items); `execute()` is routed by SQL text and
 * defaults to an empty result so aggregate/dedup probes see "nothing".
 */
function makeDb(selects: any[][]) {
  const remainingSelects = [...selects];
  const executed: string[] = [];
  const chainable: any = {
    from: () => chainable,
    innerJoin: () => chainable,
    where: () => chainable,
    limit: () => chainable,
    orderBy: () => chainable,
    then: (resolve: any) => resolve(remainingSelects.shift() ?? []),
  };
  const execute = vi.fn(async (query: any) => {
    const chunks = query?.queryChunks;
    const text = Array.isArray(chunks)
      ? chunks.map((c: any) => (typeof c === "string" ? c : c?.value?.join?.("") ?? "")).join("")
      : String(query);
    executed.push(text);
    return { rows: [] };
  });
  const transaction = vi.fn(async (operation: (tx: any) => Promise<any>) => operation(db));
  const db: any = { select: vi.fn(() => chainable), execute, transaction };
  return { db, execute, transaction, executed };
}

type ScriptedResponse = { status: 429; reset: string } | { status: 200; json: unknown };

function makeFetch(script: ScriptedResponse[]) {
  const remaining = [...script];
  return vi.fn(async (_url: string, _init: any) => {
    const next = remaining.shift();
    if (!next) throw new Error("Unexpected fetch call");
    const headers = new Map<string, string>();
    if (next.status === 429) headers.set("x-rate-limit-reset", next.reset);
    return {
      ok: next.status === 200,
      status: next.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: async () => ("json" in next ? next.json : undefined),
      text: async () => "",
    };
  });
}

function makeSessionLock() {
  const calls: Array<{ lock: any; settled: "resolved" | "rejected" | null }> = [];
  const runner = async <T>(lock: any, fn: () => Promise<T>): Promise<T> => {
    const entry = { lock, settled: null as "resolved" | "rejected" | null };
    calls.push(entry);
    try {
      const result = await fn();
      entry.settled = "resolved";
      return result;
    } catch (error) {
      entry.settled = "rejected";
      throw error;
    }
  };
  return { runner, calls };
}

const ORIGINAL_FETCH = globalThis.fetch;

describe("pushShipment :: ShipStation 429 on a keyed create", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
    delete process.env.SHIPPING_PACK_INSTRUCTION_ENABLED;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("sends the create exactly once, raises a transient error, and writes no linkage", async () => {
    const mock = makeDb([[shipmentHeaderRow()], [orderRow()], [itemRow()]]);
    const fetchMock = makeFetch([
      { status: 200, json: { orders: [] } }, // getOrderByKey pre-check: nothing landed yet
      { status: 429, reset: "34" }, // the create is rate limited
      { status: 200, json: { orderId: 999 } }, // must never be reached
    ]);
    globalThis.fetch = fetchMock as any;
    const sessionLock = makeSessionLock();
    const sleep = vi.fn(async () => {});

    const svc = createShipStationService(mock.db, undefined, {
      sessionLock: sessionLock.runner,
      sleep,
    });
    const error = await svc.pushShipment(SHIPMENT_ID).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ShipStationRateLimitError);
    expect((error as ShipStationRateLimitError).context).toMatchObject({
      code: SS_RATE_LIMITED,
      method: "POST",
      path: "/orders/createorder",
      replaySafe: false,
      retryAfterSeconds: 34,
    });
    expect((error as any).context.code).not.toBe(SS_PUSH_INVALID_SHIPMENT);
    expect((error as ShipStationRateLimitError).classification).toBe("transient");

    // One GET (pre-check) + exactly one POST. No replay, no sleep.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const methods = fetchMock.mock.calls.map(([, init]: any) => init.method);
    expect(methods).toEqual(["GET", "POST"]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).orderId).toBeUndefined();
    expect(sleep).not.toHaveBeenCalled();

    // No provider linkage was persisted for a create with an unknown outcome.
    expect(mock.transaction).not.toHaveBeenCalled();
    expect(mock.executed.some((text) => /UPDATE wms\.outbound_shipments/i.test(text))).toBe(false);

    // The whole attempt ran under the per-shipment session lock and released it.
    expect(sessionLock.calls).toHaveLength(1);
    expect(sessionLock.calls[0].lock).toEqual({
      namespace: 918407,
      key: SHIPMENT_ID,
      label: "shipstation.shipment_push",
    });
    expect(sessionLock.calls[0].settled).toBe("rejected");
  });

  it("still replays the read-only pre-create lookup after a 429", async () => {
    const mock = makeDb([[shipmentHeaderRow()], [orderRow()], [itemRow()]]);
    const fetchMock = makeFetch([
      { status: 429, reset: "2" }, // GET pre-check rate limited → replay is safe
      { status: 200, json: { orders: [] } },
      { status: 200, json: { orderId: 782684779, orderKey: `echelon-wms-shp-${SHIPMENT_ID}` } },
    ]);
    globalThis.fetch = fetchMock as any;
    const sessionLock = makeSessionLock();
    const sleep = vi.fn(async () => {});

    const svc = createShipStationService(mock.db, undefined, {
      sessionLock: sessionLock.runner,
      sleep,
    });
    const result = await svc.pushShipment(SHIPMENT_ID);

    expect(result).toEqual({ shipstationOrderId: 782684779, orderKey: `echelon-wms-shp-${SHIPMENT_ID}` });
    expect(fetchMock.mock.calls.map(([, init]: any) => init.method)).toEqual(["GET", "GET", "POST"]);
    expect(sleep).toHaveBeenCalledWith(3_000);
    expect(mock.transaction).toHaveBeenCalledTimes(1);
    expect(mock.executed.some((text) => /UPDATE wms\.outbound_shipments/i.test(text))).toBe(true);
    expect(sessionLock.calls[0].settled).toBe("resolved");
  });
});
