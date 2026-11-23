import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mockDb = vi.hoisted(() => {
  const insertedValues: any[] = [];
  return {
    execute: vi.fn(),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: any) => {
        insertedValues.push(values);
      }),
    })),
    insertedValues,
  };
});

vi.mock("../../../../db", () => ({
  db: mockDb,
}));

import { sweepShipStationQueue } from "../../shipstation-sweeper";

function sqlText(query: any): string {
  const chunks: unknown[] = query?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && Array.isArray((chunk as any).value)) {
        return (chunk as any).value.join("");
      }
      return "";
    })
    .join("");
}

function expectNoShipStationMutation(fetchMock: ReturnType<typeof vi.fn>) {
  for (const [url, init] of fetchMock.mock.calls) {
    expect(String(url)).not.toContain("/orders/createorder");
    expect((init as RequestInit | undefined)?.method).not.toBe("POST");
  }
}

describe("sweepShipStationQueue", () => {
  beforeEach(() => {
    mockDb.execute.mockReset();
    mockDb.insert.mockClear();
    mockDb.insertedValues.splice(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).fetch;
  });

  it("flags stale awaiting ShipStation orders for final WMS shipments without cancelling ShipStation", async () => {
    mockDb.execute
      .mockResolvedValueOnce({
        rows: [{
          shipment_status: "shipped",
          warehouse_status: "shipped",
          shipstation_order_id: 740117299,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          page: 1,
          pages: 1,
          orders: [
            {
              orderId: 740117299,
              orderNumber: "57771",
              orderKey: "echelon-wms-shp-1578",
              orderStatus: "awaiting_shipment",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ page: 1, pages: 1, orders: [] }),
      });
    globalThis.fetch = fetchMock as any;

    await sweepShipStationQueue("api-key", "api-secret");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectNoShipStationMutation(fetchMock);

    expect(mockDb.execute).toHaveBeenCalledTimes(3);
    expect(sqlText(mockDb.execute.mock.calls[1]![0])).toMatch(/UPDATE wms\.outbound_shipments/);
    expect(sqlText(mockDb.execute.mock.calls[1]![0])).toMatch(/requires_review = true/);
    expect(sqlText(mockDb.execute.mock.calls[1]![0])).not.toMatch(/SET status =/);
    expect(sqlText(mockDb.execute.mock.calls[1]![0])).not.toMatch(/cancelled_at/);
    expect(sqlText(mockDb.execute.mock.calls[2]![0])).toMatch(/requires_review = false/);
  });

  it("flags awaiting_payment Echelon WMS orders without rewriting ShipStation order status", async () => {
    mockDb.execute
      .mockResolvedValueOnce({
        rows: [{
          shipment_status: "planned",
          warehouse_status: "ready",
          shipstation_order_id: 740117301,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ page: 1, pages: 1, orders: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          page: 1,
          pages: 1,
          orders: [
            {
              orderId: 740117301,
              orderNumber: "57772",
              orderKey: "echelon-wms-shp-1580",
              orderStatus: "awaiting_payment",
            },
          ],
        }),
      });
    globalThis.fetch = fetchMock as any;

    await sweepShipStationQueue("api-key", "api-secret");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectNoShipStationMutation(fetchMock);

    expect(mockDb.execute).toHaveBeenCalledTimes(3);
    const updateSql = sqlText(mockDb.execute.mock.calls[1]![0]);
    expect(updateSql).toMatch(/UPDATE wms\.outbound_shipments/);
    expect(updateSql).toMatch(/requires_review = true/);
    expect(updateSql).toMatch(/review_reason =/);
  });

  it("flags duplicate OMS-level ShipStation queue copies through an idempotent review event", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          shipment_status: "queued",
          warehouse_status: "processing",
          shipstation_order_id: 740117299,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          page: 1,
          pages: 1,
          orders: [
            {
              orderId: 740117299,
              orderNumber: "57771",
              orderKey: "echelon-wms-shp-1578",
              orderStatus: "awaiting_shipment",
            },
            {
              orderId: 740117298,
              orderNumber: "57771",
              orderKey: "echelon-oms-191861",
              orderStatus: "awaiting_shipment",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ page: 1, pages: 1, orders: [] }),
      });
    globalThis.fetch = fetchMock as any;

    await sweepShipStationQueue("api-key", "api-secret");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectNoShipStationMutation(fetchMock);

    expect(mockDb.execute).toHaveBeenCalledTimes(4);
    const eventSql = sqlText(mockDb.execute.mock.calls[0]![0]);
    expect(eventSql).toMatch(/INSERT INTO oms\.oms_order_events/);
    expect(eventSql).toMatch(/shipstation_queue_review_required/);
    expect(eventSql).toMatch(/WHERE NOT EXISTS/);
  });

  it("queues exact-identity recovery when ShipStation exists but local linkage is missing", async () => {
    mockDb.execute
      .mockResolvedValueOnce({
        rows: [{
          shipment_status: "planned",
          warehouse_status: "ready",
          shipstation_order_id: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          page: 1,
          pages: 1,
          orders: [{
            orderId: 770729188,
            orderNumber: "#61191",
            orderKey: "echelon-wms-shp-14866",
            orderStatus: "awaiting_shipment",
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ page: 1, pages: 1, orders: [] }),
      });
    globalThis.fetch = fetchMock as any;

    await sweepShipStationQueue("api-key", "api-secret");

    expect(mockDb.insertedValues).toContainEqual(
      expect.objectContaining({
        provider: "internal",
        topic: "shipstation_shipment_push",
        payload: { shipmentId: 14866 },
        status: "pending",
      }),
    );
    const allSql = mockDb.execute.mock.calls
      .map(([query]) => sqlText(query))
      .join("\n");
    expect(allSql).not.toMatch(/SET requires_review = true/);
    expectNoShipStationMutation(fetchMock);
  });
  it("does not flag a replacement order that merely reuses the WMS order key", async () => {
    mockDb.execute
      .mockResolvedValueOnce({
        rows: [{
          shipment_status: "shipped",
          warehouse_status: "shipped",
          shipstation_order_id: 759013579,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          page: 1,
          pages: 1,
          orders: [{
            orderId: 763886876,
            orderNumber: "#59834",
            orderKey: "echelon-wms-shp-6584",
            orderStatus: "awaiting_shipment",
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ page: 1, pages: 1, orders: [] }),
      });
    globalThis.fetch = fetchMock as any;

    await sweepShipStationQueue("api-key", "api-secret");

    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    const allSql = mockDb.execute.mock.calls.map(([query]) => sqlText(query)).join("\n");
    expect(allSql).not.toMatch(/SET requires_review = true/);
    expect(allSql).toMatch(/review_reason = 'shipstation_queue_review_required'/);
    expect(allSql).toMatch(/requires_review = false/);
  });
});

// #65805: a fraud cancel landed while the push was in flight, so the shipment
// is cancelled in Echelon with no saved ShipStation id while ShipStation still
// shows the order awaiting shipment under the shipment's own key.
describe("sweepShipStationQueue: open orders of cancelled shipments", () => {
  const orphan = {
    orderId: 818595428,
    orderNumber: "#65805",
    orderKey: "echelon-wms-shp-21186",
    orderStatus: "awaiting_shipment",
  };

  function queueFetch(orders: unknown[]) {
    return vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ page: 1, pages: 1, orders }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ page: 1, pages: 1, orders: [] }) });
  }

  beforeEach(() => {
    mockDb.execute.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).fetch;
  });

  it("cancels the unlinked order through the shipment instead of re-queuing a doomed push", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [{ shipment_status: "cancelled", warehouse_status: "cancelled", shipstation_order_id: null }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValue({ rows: [] });
    globalThis.fetch = queueFetch([orphan]) as any;
    const cancelOrderForShipment = vi.fn(async () => ({ state: "cancelled" }));

    await sweepShipStationQueue("api-key", "api-secret", { cancelOrderForShipment });

    expect(cancelOrderForShipment).toHaveBeenCalledWith(21186);
    const allSql = mockDb.execute.mock.calls.map(([q]) => sqlText(q)).join("\n");
    expect(allSql).not.toMatch(/webhook_retry_queue/);
    expect(allSql).toMatch(/review_reason = 'shipstation_cancel_unverified'/);
    expect(allSql).not.toMatch(/SET requires_review = true/);
  });

  it("also cancels when the cancelled shipment's saved id is this order", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [{ shipment_status: "cancelled", warehouse_status: "cancelled", shipstation_order_id: 818595428 }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValue({ rows: [] });
    globalThis.fetch = queueFetch([orphan]) as any;
    const cancelOrderForShipment = vi.fn(async () => ({ state: "already_cancelled" }));

    await sweepShipStationQueue("api-key", "api-secret", { cancelOrderForShipment });

    expect(cancelOrderForShipment).toHaveBeenCalledWith(21186);
  });

  it("never cancels an order another open shipment shares; flags it instead", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [{ shipment_status: "cancelled", warehouse_status: "ready", shipstation_order_id: 818595428 }] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValue({ rows: [] });
    globalThis.fetch = queueFetch([orphan]) as any;
    const cancelOrderForShipment = vi.fn(async () => ({ state: "cancelled" }));

    await sweepShipStationQueue("api-key", "api-secret", { cancelOrderForShipment });

    expect(cancelOrderForShipment).not.toHaveBeenCalled();
    const flagSql = sqlText(mockDb.execute.mock.calls[2]![0]);
    expect(flagSql).toMatch(/requires_review = true/);
  });

  it("flags for review when ShipStation reports the order already shipped", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [{ shipment_status: "cancelled", warehouse_status: "cancelled", shipstation_order_id: null }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValue({ rows: [] });
    globalThis.fetch = queueFetch([orphan]) as any;

    await sweepShipStationQueue("api-key", "api-secret", {
      cancelOrderForShipment: async () => ({ state: "already_shipped" }),
    });

    const flagSql = sqlText(mockDb.execute.mock.calls[2]![0]);
    expect(flagSql).toMatch(/requires_review = true/);
  });

  it("flags for review when the provider cancel throws, and keeps sweeping", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [{ shipment_status: "cancelled", warehouse_status: "cancelled", shipstation_order_id: null }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValue({ rows: [] });
    const fetchMock = queueFetch([orphan]);
    globalThis.fetch = fetchMock as any;

    await sweepShipStationQueue("api-key", "api-secret", {
      cancelOrderForShipment: async () => {
        throw new Error("ShipStation 503");
      },
    });

    expect(sqlText(mockDb.execute.mock.calls[2]![0])).toMatch(/requires_review = true/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves an extra same-key order alone when a different id is saved (possible operator reship)", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [{ shipment_status: "cancelled", warehouse_status: "cancelled", shipstation_order_id: 700000001 }] })
      .mockResolvedValue({ rows: [] });
    globalThis.fetch = queueFetch([orphan]) as any;
    const cancelOrderForShipment = vi.fn(async () => ({ state: "cancelled" }));

    await sweepShipStationQueue("api-key", "api-secret", { cancelOrderForShipment });

    expect(cancelOrderForShipment).not.toHaveBeenCalled();
  });
});
