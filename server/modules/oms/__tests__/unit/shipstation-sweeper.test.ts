import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mockDb = vi.hoisted(() => ({
  execute: vi.fn(),
}));

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
